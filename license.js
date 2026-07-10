/**
 * license.js — Freemium + licenciamiento Lemon Squeezy + capas de seguridad
 *
 * ---------------------------------------------------------------------------
 * VERIFICACIÓN (fuente de verdad = Lemon Squeezy)
 * ---------------------------------------------------------------------------
 * POST /v1/licenses/activate  → primera vez
 * POST /v1/licenses/validate  → revalidación semanal
 *
 * ---------------------------------------------------------------------------
 * CAPAS DE SEGURIDAD (cliente; no son irrompibles, suben el listón)
 * ---------------------------------------------------------------------------
 * 1) Sello de integridad (SHA-256) sobre key+instance+timestamps+runtime.id
 *    → poner isPremium:true a mano en storage NO alcanza.
 * 2) Rate-limit de canjes (anti fuerza bruta de keys).
 * 3) Formato estricto UUID de Lemon Squeezy en producción.
 * 4) Binding store/product/variant (si configurás los IDs).
 * 5) Validación de respuesta API (key echo, status, meta).
 * 6) Contadores free monotónicos + sello (no se resetean editando storage).
 * 7) Grace offline acotada (máx. 30 días sin revalidar online).
 * 8) Clock skew: lastVerified no puede estar en el futuro.
 *
 * LIMITACIÓN: cualquier lógica en la extensión es reversible por un atacante
 * avanzado. La defensa real sigue siendo Lemon Squeezy + activation limit.
 * ---------------------------------------------------------------------------
 */
(function (global) {
  "use strict";

  // ─── CONFIGURACIÓN ───────────────────────────────────────────────────────
  const LEMONSQUEEZY_CHECKOUT_URL =
    "https://YOURSTORE.lemonsqueezy.com/checkout/buy/VARIANT_ID";

  /**
   * En producción poné al menos PRODUCT_ID (y idealmente STORE_ID).
   * Los ves en la respuesta de activate o en el dashboard de LS.
   */
  const LEMONSQUEEZY_STORE_ID = null; // ej. 12345
  const LEMONSQUEEZY_PRODUCT_ID = null; // ej. 67890
  const LEMONSQUEEZY_VARIANT_ID = null; // ej. 112233

  const LS_LICENSE_API = "https://api.lemonsqueezy.com/v1/licenses";
  const FREE_LIMITS = { images: 5, videos: 5 };
  const REVALIDATE_MS = 7 * 24 * 60 * 60 * 1000;
  /** Tras esto sin validar online, se revoca el cache premium. */
  const MAX_OFFLINE_GRACE_MS = 30 * 24 * 60 * 60 * 1000;
  /** Intentos de canje fallidos antes de bloquear temporalmente. */
  const REDEEM_MAX_ATTEMPTS = 5;
  const REDEEM_WINDOW_MS = 60 * 60 * 1000; // 1 hora
  /** Material extra del sello (no es secreto real; solo sube costo de edit). */
  const SEAL_PEPPER = "gid-v1-ls-seal-2026";

  const STORAGE_KEYS = {
    usageImages: "gid_usage_images",
    usageVideos: "gid_usage_videos",
    usageSeal: "gid_usage_seal",
    licenseKey: "gid_license_key",
    isPremium: "gid_is_premium",
    lastVerified: "gid_last_verified",
    licenseEmail: "gid_license_email",
    instanceId: "gid_ls_instance_id",
    instanceName: "gid_ls_instance_name",
    premiumSeal: "gid_premium_seal",
    redeemAttempts: "gid_redeem_attempts",
    redeemWindowStart: "gid_redeem_window_start",
  };

  // ─── storage ─────────────────────────────────────────────────────────────

  function storageGet(keys) {
    return new Promise((resolve) => {
      chrome.storage.local.get(keys, (result) => resolve(result || {}));
    });
  }

  function storageSet(obj) {
    return new Promise((resolve) => {
      chrome.storage.local.set(obj, () => resolve());
    });
  }

  function isCheckoutConfigured() {
    const url = LEMONSQUEEZY_CHECKOUT_URL || "";
    return (
      url.includes("lemonsqueezy.com") &&
      !url.includes("YOURSTORE") &&
      !url.includes("VARIANT_ID")
    );
  }

  function extensionId() {
    try {
      return chrome.runtime?.id || "no-ext-id";
    } catch (_) {
      return "no-ext-id";
    }
  }

  // ─── Capa 1: sello de integridad (SHA-256) ───────────────────────────────

  async function sha256Hex(text) {
    const enc = new TextEncoder();
    const buf = await crypto.subtle.digest("SHA-256", enc.encode(text));
    return [...new Uint8Array(buf)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  async function computePremiumSeal(key, instanceId, lastVerified, email) {
    const material = [
      SEAL_PEPPER,
      "premium",
      extensionId(),
      String(key || ""),
      String(instanceId || ""),
      String(lastVerified || 0),
      String(email || ""),
      String(LEMONSQUEEZY_PRODUCT_ID ?? "any"),
      String(LEMONSQUEEZY_STORE_ID ?? "any"),
    ].join("|");
    return sha256Hex(material);
  }

  async function computeUsageSeal(images, videos) {
    const material = [
      SEAL_PEPPER,
      "usage",
      extensionId(),
      String(images | 0),
      String(videos | 0),
    ].join("|");
    return sha256Hex(material);
  }

  function timingSafeEqual(a, b) {
    if (typeof a !== "string" || typeof b !== "string") return false;
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
      diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
  }

  // ─── Capa 2: rate-limit de canjes ────────────────────────────────────────

  async function checkRedeemRateLimit() {
    const data = await storageGet([
      STORAGE_KEYS.redeemAttempts,
      STORAGE_KEYS.redeemWindowStart,
    ]);
    const now = Date.now();
    let windowStart = Number(data[STORAGE_KEYS.redeemWindowStart]) || 0;
    let attempts = Number(data[STORAGE_KEYS.redeemAttempts]) || 0;

    if (!windowStart || now - windowStart > REDEEM_WINDOW_MS) {
      windowStart = now;
      attempts = 0;
      await storageSet({
        [STORAGE_KEYS.redeemWindowStart]: windowStart,
        [STORAGE_KEYS.redeemAttempts]: 0,
      });
    }

    if (attempts >= REDEEM_MAX_ATTEMPTS) {
      const waitMin = Math.ceil(
        (REDEEM_WINDOW_MS - (now - windowStart)) / 60000
      );
      return {
        allowed: false,
        error: `Demasiados intentos. Esperá ~${Math.max(1, waitMin)} min e intentá de nuevo.`,
      };
    }
    return { allowed: true, attempts, windowStart };
  }

  async function recordRedeemAttempt(success) {
    const data = await storageGet([
      STORAGE_KEYS.redeemAttempts,
      STORAGE_KEYS.redeemWindowStart,
    ]);
    const now = Date.now();
    let windowStart = Number(data[STORAGE_KEYS.redeemWindowStart]) || now;
    let attempts = Number(data[STORAGE_KEYS.redeemAttempts]) || 0;
    if (now - windowStart > REDEEM_WINDOW_MS) {
      windowStart = now;
      attempts = 0;
    }
    if (success) {
      attempts = 0;
    } else {
      attempts += 1;
    }
    await storageSet({
      [STORAGE_KEYS.redeemWindowStart]: windowStart,
      [STORAGE_KEYS.redeemAttempts]: attempts,
    });
  }

  // ─── API pública ─────────────────────────────────────────────────────────

  /**
   * Premium solo si flag + sello + key + timestamps son coherentes.
   */
  async function isPremium() {
    const data = await storageGet([
      STORAGE_KEYS.isPremium,
      STORAGE_KEYS.licenseKey,
      STORAGE_KEYS.instanceId,
      STORAGE_KEYS.lastVerified,
      STORAGE_KEYS.licenseEmail,
      STORAGE_KEYS.premiumSeal,
    ]);

    if (data[STORAGE_KEYS.isPremium] !== true) return false;

    const key = data[STORAGE_KEYS.licenseKey];
    const last = Number(data[STORAGE_KEYS.lastVerified]) || 0;
    const seal = data[STORAGE_KEYS.premiumSeal] || "";
    if (!key || !seal || !last) return false;

    // Capa 8: reloj en el futuro → inválido
    if (last > Date.now() + 5 * 60 * 1000) {
      await markNotPremium();
      return false;
    }

    // Capa 7: gracia offline máxima
    if (Date.now() - last > MAX_OFFLINE_GRACE_MS) {
      await markNotPremium();
      return false;
    }

    const expected = await computePremiumSeal(
      key,
      data[STORAGE_KEYS.instanceId] || "",
      last,
      data[STORAGE_KEYS.licenseEmail] || ""
    );
    if (!timingSafeEqual(seal, expected)) {
      // Capa 1: storage manipulado
      await markNotPremium();
      return false;
    }
    return true;
  }

  async function getUsageCount() {
    const data = await storageGet([
      STORAGE_KEYS.usageImages,
      STORAGE_KEYS.usageVideos,
      STORAGE_KEYS.usageSeal,
    ]);
    let images = Math.max(0, Math.min(9999, Number(data[STORAGE_KEYS.usageImages]) || 0));
    let videos = Math.max(0, Math.min(9999, Number(data[STORAGE_KEYS.usageVideos]) || 0));
    const seal = data[STORAGE_KEYS.usageSeal] || "";

    // Capa 6: si no hay sello (primera vez) o es válido, OK.
    // Si hay sello inválido → alguien bajó contadores: forzar al límite free (agotado).
    if (seal) {
      const expected = await computeUsageSeal(images, videos);
      if (!timingSafeEqual(seal, expected)) {
        images = FREE_LIMITS.images;
        videos = FREE_LIMITS.videos;
        await storageSet({
          [STORAGE_KEYS.usageImages]: images,
          [STORAGE_KEYS.usageVideos]: videos,
          [STORAGE_KEYS.usageSeal]: await computeUsageSeal(images, videos),
        });
      }
    } else if (images > 0 || videos > 0) {
      // Migración: sellar contadores existentes
      await storageSet({
        [STORAGE_KEYS.usageSeal]: await computeUsageSeal(images, videos),
      });
    }

    return { images, videos };
  }

  async function getRemaining(type) {
    if (await isPremium()) return Infinity;
    const usage = await getUsageCount();
    const limit = FREE_LIMITS[type] ?? 0;
    const used = usage[type] ?? 0;
    return Math.max(0, limit - used);
  }

  async function canDownload(type) {
    if (await isPremium()) return true;
    return (await getRemaining(type)) > 0;
  }

  async function incrementUsage(type) {
    if (await isPremium()) return await getUsageCount();
    const usage = await getUsageCount();
    if (type === "images") usage.images = Math.min(9999, usage.images + 1);
    else if (type === "videos") usage.videos = Math.min(9999, usage.videos + 1);
    else return usage;

    await storageSet({
      [STORAGE_KEYS.usageImages]: usage.images,
      [STORAGE_KEYS.usageVideos]: usage.videos,
      [STORAGE_KEYS.usageSeal]: await computeUsageSeal(
        usage.images,
        usage.videos
      ),
    });
    return usage;
  }

  /**
   * Capa 3: formato estricto.
   * Producción → solo UUID LS. Dev → también TEST-TEST-TEST-TEST.
   */
  function normalizeKey(key) {
    if (!key || typeof key !== "string") return "";
    const trimmed = key.trim().replace(/\s+/g, "");
    const uuid = trimmed.toLowerCase();
    if (
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        uuid
      )
    ) {
      return uuid;
    }
    return trimmed.toUpperCase();
  }

  function isValidKeyFormat(normalized) {
    if (!normalized) return false;
    if (
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        normalized
      )
    ) {
      return true;
    }
    // Solo en dev (checkout no configurado)
    if (!isCheckoutConfigured() && isDevTestKey(normalized)) return true;
    return false;
  }

  function isDevTestKey(normalized) {
    return (
      normalized === "TEST-TEST-TEST-TEST" ||
      normalized.startsWith("DEV-") ||
      normalized === "00000000-0000-0000-0000-000000000000"
    );
  }

  /** Capa 4: binding a producto */
  function metaMatchesProduct(meta) {
    if (!meta || typeof meta !== "object") {
      // Si configuraste IDs, exigimos meta
      if (
        LEMONSQUEEZY_STORE_ID != null ||
        LEMONSQUEEZY_PRODUCT_ID != null ||
        LEMONSQUEEZY_VARIANT_ID != null
      ) {
        return false;
      }
      return true;
    }
    if (
      LEMONSQUEEZY_STORE_ID != null &&
      Number(meta.store_id) !== Number(LEMONSQUEEZY_STORE_ID)
    ) {
      return false;
    }
    if (
      LEMONSQUEEZY_PRODUCT_ID != null &&
      Number(meta.product_id) !== Number(LEMONSQUEEZY_PRODUCT_ID)
    ) {
      return false;
    }
    if (
      LEMONSQUEEZY_VARIANT_ID != null &&
      Number(meta.variant_id) !== Number(LEMONSQUEEZY_VARIANT_ID)
    ) {
      return false;
    }
    return true;
  }

  function licenseStatusOk(licenseKeyObj) {
    if (!licenseKeyObj || typeof licenseKeyObj !== "object") return false;
    const status = licenseKeyObj.status;
    return status === "active" || status === "inactive";
  }

  /** Capa 5: la key de la respuesta debe coincidir con la enviada */
  function responseKeyMatches(licenseKeyObj, normalized) {
    if (!licenseKeyObj) return false;
    const returned = String(licenseKeyObj.key || "").toLowerCase();
    if (!returned) return true; // algunos payloads no echo'ean la key
    return returned === normalized.toLowerCase();
  }

  async function getOrCreateInstanceName() {
    const data = await storageGet([STORAGE_KEYS.instanceName]);
    if (data[STORAGE_KEYS.instanceName]) {
      return data[STORAGE_KEYS.instanceName];
    }
    let suffix = String(Date.now());
    try {
      if (global.crypto?.randomUUID) {
        suffix = global.crypto.randomUUID().slice(0, 8);
      }
    } catch (_) {
      /* ignore */
    }
    // Incluye runtime id (más estable por instalación de Chrome)
    const name = "GID-" + extensionId().slice(0, 8) + "-" + suffix;
    await storageSet({ [STORAGE_KEYS.instanceName]: name });
    return name;
  }

  async function lsLicenseRequest(action, fields) {
    if (action !== "activate" && action !== "validate" && action !== "deactivate") {
      throw new Error("Acción de licencia no permitida");
    }
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(fields)) {
      if (v != null && v !== "") body.set(k, String(v));
    }
    const res = await fetch(`${LS_LICENSE_API}/${action}`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    let data = null;
    try {
      data = await res.json();
    } catch (_) {
      data = null;
    }
    return { httpOk: res.ok, status: res.status, data };
  }

  async function markPremium(key, email, instanceId) {
    const lastVerified = Date.now();
    const seal = await computePremiumSeal(
      key,
      instanceId || "",
      lastVerified,
      email || ""
    );
    await storageSet({
      [STORAGE_KEYS.licenseKey]: key,
      [STORAGE_KEYS.isPremium]: true,
      [STORAGE_KEYS.lastVerified]: lastVerified,
      [STORAGE_KEYS.licenseEmail]: email || "",
      [STORAGE_KEYS.instanceId]: instanceId || "",
      [STORAGE_KEYS.premiumSeal]: seal,
    });
  }

  async function markNotPremium() {
    await storageSet({
      [STORAGE_KEYS.isPremium]: false,
      [STORAGE_KEYS.premiumSeal]: "",
      [STORAGE_KEYS.lastVerified]: Date.now(),
    });
  }

  async function redeemLicenseKey(key, opts) {
    const options = opts || {};
    const normalized = normalizeKey(key);

    if (!isValidKeyFormat(normalized)) {
      return {
        ok: false,
        error:
          "Formato de licencia inválido. Usá la key UUID que te dio Lemon Squeezy.",
      };
    }

    // Rate-limit solo en canjes manuales (no en revalidate de fondo)
    if (!options.revalidateOnly) {
      const rl = await checkRedeemRateLimit();
      if (!rl.allowed) return { ok: false, error: rl.error };
    }

    // Dev mode
    if (!isCheckoutConfigured()) {
      if (isDevTestKey(normalized)) {
        await markPremium(normalized, "dev@local.test", "dev-instance");
        if (!options.revalidateOnly) await recordRedeemAttempt(true);
        return {
          ok: true,
          premium: true,
          email: "dev@local.test",
          dev: true,
        };
      }
      return {
        ok: false,
        error:
          "Checkout no configurado. Editá LEMONSQUEEZY_CHECKOUT_URL en license.js.",
      };
    }

    // En producción no aceptar keys de dev
    if (isDevTestKey(normalized) && normalized !== "00000000-0000-0000-0000-000000000000") {
      // TEST-TEST-TEST-TEST no es UUID; ya filtrado. Por si acaso:
      return { ok: false, error: "Key de desarrollo no válida en producción." };
    }

    try {
      const stored = await storageGet([
        STORAGE_KEYS.licenseKey,
        STORAGE_KEYS.instanceId,
      ]);
      const storedKey = stored[STORAGE_KEYS.licenseKey] || "";
      const storedInstance = stored[STORAGE_KEYS.instanceId] || "";
      const sameKey = storedKey && storedKey === normalized;

      let result;
      if (
        options.revalidateOnly ||
        (sameKey && storedInstance && storedInstance !== "dev-instance")
      ) {
        result = await validateWithLemonSqueezy(
          normalized,
          sameKey ? storedInstance : null
        );
      } else {
        result = await activateWithLemonSqueezy(normalized);
      }

      if (!options.revalidateOnly) {
        await recordRedeemAttempt(!!result.ok);
      }
      return result;
    } catch (e) {
      if (!options.revalidateOnly) await recordRedeemAttempt(false);
      return {
        ok: false,
        error:
          "No se pudo contactar a Lemon Squeezy. Revisá tu conexión e intentá de nuevo.",
      };
    }
  }

  async function activateWithLemonSqueezy(normalized) {
    const instanceName = await getOrCreateInstanceName();
    const { httpOk, data } = await lsLicenseRequest("activate", {
      license_key: normalized,
      instance_name: instanceName,
    });

    if (!data || typeof data !== "object") {
      return {
        ok: false,
        error: `Respuesta inválida de Lemon Squeezy (${httpOk ? "200" : "error"}).`,
      };
    }

    if (
      data.activated === false &&
      data.error &&
      /activation limit/i.test(String(data.error))
    ) {
      // Fallback controlado: validate sin nueva instancia
      const fallback = await validateWithLemonSqueezy(normalized, null);
      if (fallback.ok) {
        return {
          ...fallback,
          warning:
            "Activaciones al límite; validamos la key. Subí el activation limit en LS si usás varios navegadores.",
        };
      }
      return {
        ok: false,
        error:
          data.error ||
          "Límite de activaciones alcanzado. Liberá una instancia en Lemon Squeezy.",
      };
    }

    if (data.activated !== true) {
      return {
        ok: false,
        error: data.error || "No se pudo activar la licencia.",
      };
    }

    if (!responseKeyMatches(data.license_key, normalized)) {
      await markNotPremium();
      return { ok: false, error: "Respuesta de licencia inconsistente (key)." };
    }
    if (!metaMatchesProduct(data.meta)) {
      await markNotPremium();
      return {
        ok: false,
        error: "Esta licencia no corresponde al producto Grok Imagine Downloader.",
      };
    }
    if (!licenseStatusOk(data.license_key)) {
      await markNotPremium();
      return {
        ok: false,
        error: `Licencia con estado: ${data.license_key?.status || "desconocido"}.`,
      };
    }

    const email = data.meta?.customer_email || "";
    const instanceId = data.instance?.id || "";
    if (!instanceId) {
      // Sin instance_id no podemos revalidar bien
      return {
        ok: false,
        error: "Lemon Squeezy no devolvió instance_id. Reintentá.",
      };
    }

    await markPremium(normalized, email, instanceId);
    return { ok: true, premium: true, email };
  }

  async function validateWithLemonSqueezy(normalized, instanceId) {
    const fields = { license_key: normalized };
    if (instanceId) fields.instance_id = instanceId;

    const { data } = await lsLicenseRequest("validate", fields);

    if (!data || typeof data !== "object") {
      return { ok: false, error: "Respuesta inválida al validar la licencia." };
    }

    if (data.valid !== true) {
      await markNotPremium();
      return {
        ok: false,
        error: data.error || "Licencia no válida o expirada.",
      };
    }

    if (!responseKeyMatches(data.license_key, normalized)) {
      await markNotPremium();
      return { ok: false, error: "Respuesta de licencia inconsistente (key)." };
    }
    if (!metaMatchesProduct(data.meta)) {
      await markNotPremium();
      return {
        ok: false,
        error: "Esta licencia no corresponde al producto Grok Imagine Downloader.",
      };
    }
    if (!licenseStatusOk(data.license_key)) {
      await markNotPremium();
      return {
        ok: false,
        error: `Licencia con estado: ${data.license_key?.status || "desconocido"}.`,
      };
    }

    const email = data.meta?.customer_email || "";
    const newInstanceId = data.instance?.id || instanceId || "";
    await markPremium(normalized, email, newInstanceId);
    return { ok: true, premium: true, email };
  }

  async function ensurePremiumFresh() {
    const data = await storageGet([
      STORAGE_KEYS.isPremium,
      STORAGE_KEYS.licenseKey,
      STORAGE_KEYS.lastVerified,
      STORAGE_KEYS.premiumSeal,
    ]);

    // Primero integridad local (puede revocar si sellaron mal)
    if (!(await isPremium())) return false;

    const last = Number(data[STORAGE_KEYS.lastVerified]) || 0;
    if (Date.now() - last < REVALIDATE_MS) return true;

    try {
      const result = await redeemLicenseKey(data[STORAGE_KEYS.licenseKey], {
        revalidateOnly: true,
      });
      if (result.ok) return true;
      // Revocar solo si LS dijo inválida (no red)
      if (
        result.error &&
        !/conexión|contactar|Lemon Squeezy|Respuesta inválida/i.test(
          result.error
        )
      ) {
        return false;
      }
      // Red caída: mantener si aún dentro de grace (isPremium ya chequeó grace)
      return await isPremium();
    } catch (_) {
      return await isPremium();
    }
  }

  async function getStatus() {
    const [premium, usage] = await Promise.all([isPremium(), getUsageCount()]);
    return {
      premium,
      usage,
      limits: { ...FREE_LIMITS },
      remaining: {
        images: premium
          ? Infinity
          : Math.max(0, FREE_LIMITS.images - usage.images),
        videos: premium
          ? Infinity
          : Math.max(0, FREE_LIMITS.videos - usage.videos),
      },
      paymentLink: LEMONSQUEEZY_CHECKOUT_URL,
      checkoutConfigured: isCheckoutConfigured(),
    };
  }

  function getPaymentLink() {
    return LEMONSQUEEZY_CHECKOUT_URL;
  }

  function getFreeLimits() {
    return { ...FREE_LIMITS };
  }

  const GIDLicense = {
    isPremium,
    getUsageCount,
    getRemaining,
    canDownload,
    incrementUsage,
    redeemLicenseKey,
    ensurePremiumFresh,
    getStatus,
    getPaymentLink,
    getFreeLimits,
    normalizeKey,
    FREE_LIMITS,
    STORAGE_KEYS,
  };

  global.GIDLicense = GIDLicense;
})(typeof self !== "undefined" ? self : globalThis);
