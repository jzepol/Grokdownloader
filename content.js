/**
 * content.js — Panel UI + detección DOM + orquestación de descargas freemium
 *
 * Depende de license.js (cargado antes en el manifest → self.GIDLicense).
 * No reescribe la lógica de sniffing de inject.js; solo consume MEDIA_FOUND.
 */
/* global GIDLicense */
(function () {
  "use strict";

  // Evitar doble inyección (popup/background pueden re-inyectar con scripting)
  if (globalThis.__gidContentInstalled) {
    // Ya corrimos: solo re-exponer un ping rápido vía listener ya existente
    return;
  }
  globalThis.__gidContentInstalled = true;

  /** @type {Map<string, {url:string, index:number, selected:boolean, mediaType:'video'|'image', locked:boolean}>} */
  const foundMedia = new Map();
  let panelEl = null;
  let listEl = null;
  let counterEl = null;
  let statusEl = null;
  let progressWrap = null;
  let progressBar = null;
  let licenseMsgEl = null;
  let quotaEl = null;
  /** @type {null | {premium:boolean, usage:object, limits:object, remaining:object, paymentLink:string}} */
  let licenseStatus = null;
  let isDownloading = false;

  // ─── Iconos SVG inline (estilo Lucide, sin CDN) ──────────────────────────
  const ICONS = {
    download:
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>',
    x:
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
    video:
      '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"/><rect x="2" y="6" width="14" height="12" rx="2"/></svg>',
    image:
      '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>',
    sparkles:
      '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/><path d="M4 17v2"/><path d="M5 18H3"/></svg>',
    check:
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
    key:
      '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L19 4"/><path d="m21 2-9.6 9.6"/><circle cx="7.5" cy="15.5" r="5.5"/></svg>',
    zap:
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/></svg>',
  };

  // CDNs de contenido de usuario (no marketing del home /imagine)
  const USER_CONTENT_HOST_RE =
    /(assets\.grokusercontent\.com|imagine-public\.x\.ai|artifacts\.grokusercontent\.com)/i;
  // assets.grok.com mezcla UI + media; solo con paths de share/generated
  const ASSETS_GROK_MEDIA_RE =
    /assets\.grok\.com\/.+(share-images|share-videos|generated|users\/|media\/)/i;
  const UI_NOISE_RE =
    /(\/avatar|\/emoji|\/icon|\/logo|\/favicon|\/sprite|\/static\/media\/|UniversalSans|_next\/static|woff2?|cdn\.grok\.com)/i;
  const SAMPLE_NOISE_RE =
    /(sample|placeholder|marketing|hero|landing|onboarding|demo|tutorial|showcase|promo|banner|welcome|default[-_]?image|explore[-_]?card|featured)/i;

  /**
   * Dónde estamos en Imagine.
   * - post:  /imagine/post/<uuid>  → scrapear media del post
   * - saved: /imagine/saved        → scrapear galería del usuario
   * - home:  /imagine              → NO scrapear (muestras de Grok)
   */
  function getPageContext() {
    const path = location.pathname || "";
    const postMatch = path.match(
      /\/imagine\/post\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i
    );
    if (postMatch) {
      return { mode: "post", postId: postMatch[1], scrapes: true };
    }
    if (/\/imagine\/saved\/?/i.test(path)) {
      return { mode: "saved", postId: null, scrapes: true };
    }
    // Home / explore / feed de marketing
    if (
      /\/imagine\/?$/i.test(path) ||
      /\/imagine\/(explore|feed|home|discover)\/?/i.test(path)
    ) {
      return { mode: "home", postId: null, scrapes: false };
    }
    // Otras rutas under /imagine → scrapear con cuidado
    if (/\/imagine\//i.test(path)) {
      return { mode: "other", postId: null, scrapes: true };
    }
    return { mode: "other", postId: null, scrapes: false };
  }

  // ─── 1) Inyectar inject.js (MAIN world) ─────────────────────────────────
  function injectPageScript() {
    try {
      chrome.runtime.sendMessage({ type: "GID_INJECT_MAIN" }).catch(() => {});
    } catch (_) {
      /* ignore */
    }
    try {
      const s = document.createElement("script");
      s.src = chrome.runtime.getURL("inject.js");
      s.onload = () => s.remove();
      (document.head || document.documentElement).appendChild(s);
    } catch (_) {
      /* ignore */
    }
  }

  // ─── 2) Mensajes desde inject.js ─────────────────────────────────────────
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || !data.__grokImagineDownloader) return;
    // Solo aceptar media si la página actual es saved/post
    if (!getPageContext().scrapes) return;

    if (data.type === "MEDIA_FOUND") {
      addMedia(data.url, data.mediaType === "image" ? "image" : "video");
    }
    if (data.type === "VIDEO_FOUND") {
      addMedia(data.url, "video");
    }
  });

  function normalizeMediaUrl(url) {
    if (!url || typeof url !== "string") return "";
    let u = url.trim();
    try {
      if (u.includes("/_next/image") && u.includes("url=")) {
        const parsed = new URL(u, location.origin);
        const inner = parsed.searchParams.get("url");
        if (inner) u = decodeURIComponent(inner);
      }
    } catch (_) {
      /* keep */
    }
    if (u.startsWith("//")) u = "https:" + u;
    return u;
  }

  function isNoiseUrl(url) {
    return UI_NOISE_RE.test(url) || SAMPLE_NOISE_RE.test(url);
  }

  /** Contenido de usuario (saved/post), no muestras del home */
  function looksLikeUserImage(url) {
    if (!url || isNoiseUrl(url)) return false;
    if (url.startsWith("blob:")) return true;
    if (USER_CONTENT_HOST_RE.test(url)) return true;
    if (ASSETS_GROK_MEDIA_RE.test(url)) return true;
    if (/imagine-public|share-images|share-videos/i.test(url)) return true;
    if (
      /\.(png|jpe?g|webp|gif|avif)(\?|#|$)/i.test(url) &&
      /(grokusercontent|imagine-public|x\.ai)/i.test(url)
    ) {
      return true;
    }
    return false;
  }

  function looksLikeUserVideo(url) {
    if (!url || isNoiseUrl(url)) return false;
    if (url.startsWith("blob:")) return true;
    if (/\.(mp4|webm|mov|m3u8)(\?|#|$)/i.test(url)) {
      // Evitar videos de marketing en cdn.grok.com
      if (/cdn\.grok\.com/i.test(url) && SAMPLE_NOISE_RE.test(url)) return false;
      if (USER_CONTENT_HOST_RE.test(url) || /x\.ai|grokusercontent|share-videos/i.test(url))
        return true;
      // En post/saved aceptar mp4 de hosts xAI/Grok
      if (/(x\.ai|grok)/i.test(url)) return true;
    }
    if (USER_CONTENT_HOST_RE.test(url) && /video|mp4|webm/i.test(url)) return true;
    return false;
  }

  function addMedia(url, mediaType) {
    if (!getPageContext().scrapes) return;
    url = normalizeMediaUrl(url);
    if (!url || foundMedia.has(url)) return;
    if (isNoiseUrl(url) && !url.startsWith("blob:")) return;

    // En post: preferir media del post; aceptar user CDN + grandes
    foundMedia.set(url, {
      url,
      index: foundMedia.size + 1,
      selected: true,
      mediaType: mediaType === "image" ? "image" : "video",
      locked: false,
    });
    applyLockFlags();
    renderList();
    updateQuotaUI();
    updateRouteHint();
  }

  function collectAttrs(el) {
    const urls = [];
    const push = (v) => {
      if (v && typeof v === "string") urls.push(v);
    };
    push(el.currentSrc);
    push(el.src);
    push(el.getAttribute?.("src"));
    push(el.getAttribute?.("data-src"));
    push(el.getAttribute?.("data-original"));
    push(el.getAttribute?.("data-url"));
    push(el.getAttribute?.("data-image"));
    push(el.getAttribute?.("poster"));
    push(el.getAttribute?.("href"));
    const srcset =
      el.getAttribute?.("srcset") || el.getAttribute?.("data-srcset") || "";
    srcset.split(",").forEach((part) => {
      const u = part.trim().split(/\s+/)[0];
      push(u);
    });
    try {
      const bg =
        (el.style && el.style.backgroundImage) ||
        getComputedStyle(el).backgroundImage ||
        "";
      const re = /url\(["']?([^"')]+)["']?\)/gi;
      let m;
      while ((m = re.exec(bg)) !== null) push(m[1]);
    } catch (_) {
      /* ignore */
    }
    return urls;
  }

  function clearMediaList() {
    foundMedia.clear();
    try {
      delete window.__gidPostProbe;
    } catch (_) {
      window.__gidPostProbe = undefined;
    }
    renderList();
    updateQuotaUI();
    updateRouteHint();
  }

  function updateRouteHint() {
    if (!statusEl) return;
    const ctx = getPageContext();
    if (ctx.mode === "home") {
      setStatus(
        "Estás en /imagine (muestras). Andá a Saved o abrí un post tuyo.",
        "error"
      );
      return;
    }
    if (ctx.mode === "saved" && foundMedia.size === 0) {
      setStatus("Saved: buscando tus imágenes… scrolleá si no aparecen.", null);
      return;
    }
    if (ctx.mode === "post" && foundMedia.size === 0) {
      setStatus("Post: buscando media de esta publicación…", null);
      return;
    }
    if (foundMedia.size > 0 && !isDownloading) {
      const n = foundMedia.size;
      setStatus(
        ctx.mode === "post"
          ? `Post: ${n} archivo(s) listo(s) para descargar.`
          : `Saved: ${n} archivo(s) detectado(s).`,
        "success"
      );
    }
  }

  // ─── 3) Escaneo DOM: solo /saved y /post ─────────────────────────────────
  function scanDomForMedia() {
    const ctx = getPageContext();
    if (!ctx.scrapes) {
      if (foundMedia.size > 0) clearMediaList();
      else updateRouteHint();
      return;
    }

    // Mínimo de tamaño: thumbs en saved pueden ser chicos; en post pedimos más
    const minDim = ctx.mode === "saved" ? 80 : 160;

    document.querySelectorAll("video").forEach((v) => {
      collectAttrs(v).forEach((u) => {
        if (looksLikeUserVideo(u) || u.startsWith("blob:")) addMedia(u, "video");
      });
      v.querySelectorAll("source").forEach((s) => {
        collectAttrs(s).forEach((u) => {
          if (looksLikeUserVideo(u) || u.startsWith("blob:"))
            addMedia(u, "video");
        });
      });
    });

    document
      .querySelectorAll('a[href*=".mp4"], a[href*=".webm"], a[href*=".mov"]')
      .forEach((a) => {
        if (looksLikeUserVideo(a.href)) addMedia(a.href, "video");
      });

    // Imágenes visibles en saved / post
    document.querySelectorAll("img, picture source").forEach((img) => {
      // Saltar UI de chrome de la app (nav, avatar lateral)
      try {
        const rect = img.getBoundingClientRect?.() || { width: 0, height: 0 };
        if (
          img.tagName === "IMG" &&
          rect.width > 0 &&
          rect.width < 40 &&
          rect.height < 40
        ) {
          return;
        }
      } catch (_) {
        /* ignore */
      }

      collectAttrs(img).forEach((u) => {
        const n = normalizeMediaUrl(u);
        if (!n) return;
        if (n.startsWith("blob:")) {
          addMedia(n, "image");
          return;
        }
        if (looksLikeUserImage(n)) {
          addMedia(n, "image");
          return;
        }
        // En post/saved: cualquier img de tamaño razonable (contenido renderizado)
        if (img.tagName === "IMG") {
          const w = img.naturalWidth || 0;
          const h = img.naturalHeight || 0;
          const displayW = img.clientWidth || 0;
          const displayH = img.clientHeight || 0;
          const bigEnough =
            (w >= minDim && h >= minDim) ||
            (displayW >= minDim && displayH >= minDim);
          if (
            bigEnough &&
            /^https?:\/\//i.test(n) &&
            !isNoiseUrl(n) &&
            !/cdn\.grok\.com\/_next/i.test(n)
          ) {
            addMedia(n, "image");
          }
        }
      });
    });

    // En post: también fondos / contenedores de media del detalle
    if (ctx.mode === "post") {
      document
        .querySelectorAll(
          "main img, main video, [role='main'] img, [role='dialog'] img, [role='dialog'] video"
        )
        .forEach((el) => {
          collectAttrs(el).forEach((u) => {
            const n = normalizeMediaUrl(u);
            if (looksLikeUserImage(n) || looksLikeUserVideo(n)) {
              addMedia(
                n,
                looksLikeUserVideo(n) ? "video" : "image"
              );
            } else if (
              el.tagName === "IMG" &&
              (el.naturalWidth >= 200 || el.clientWidth >= 200) &&
              !isNoiseUrl(n)
            ) {
              addMedia(n, "image");
            }
          });
        });

      // Probe CDN con el id del post (si el host deja)
      if (ctx.postId && window.__gidPostProbe !== ctx.postId) {
        window.__gidPostProbe = ctx.postId;
        const candidates = [
          `https://imagine-public.x.ai/imagine-public/share-images/${ctx.postId}`,
          `https://assets.grokusercontent.com/share-images/${ctx.postId}`,
        ];
        candidates.forEach((url) => {
          fetch(url, { method: "GET", credentials: "include" })
            .then((r) => {
              if (r.ok) addMedia(url, "image");
            })
            .catch(() => {});
        });
      }
    }

    // En saved: links a posts con thumbnail dentro
    if (ctx.mode === "saved") {
      document
        .querySelectorAll('a[href*="/imagine/post/"] img, a[href*="/imagine/post/"]')
        .forEach((el) => {
          if (el.tagName === "IMG") {
            collectAttrs(el).forEach((u) => {
              const n = normalizeMediaUrl(u);
              if (n && !isNoiseUrl(n)) addMedia(n, "image");
            });
          } else {
            el.querySelectorAll?.("img").forEach((img) => {
              collectAttrs(img).forEach((u) => {
                const n = normalizeMediaUrl(u);
                if (n && !isNoiseUrl(n)) addMedia(n, "image");
              });
            });
          }
        });
    }

    updateRouteHint();
  }

  let scanScheduled = false;
  function scheduleScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    requestAnimationFrame(() => {
      scanScheduled = false;
      scanDomForMedia();
    });
  }

  const observer = new MutationObserver(() => scheduleScan());

  // ─── Licencia / freemium ─────────────────────────────────────────────────
  async function refreshLicenseStatus() {
    try {
      // Preferir API local (content script tiene GIDLicense)
      if (typeof GIDLicense !== "undefined") {
        licenseStatus = await GIDLicense.getStatus();
      } else {
        const res = await chrome.runtime.sendMessage({
          type: "GID_LICENSE_STATUS",
        });
        if (res?.ok) licenseStatus = res.status;
      }
    } catch (e) {
      console.warn("GID license status:", e);
    }
    applyLockFlags();
    updateQuotaUI();
    updateHeaderPro();
    renderList();
  }

  /**
   * Marca como locked los ítems que excederían el cupo free restante.
   * Los primeros `remaining` de cada tipo quedan libres; el resto 🔒.
   */
  function applyLockFlags() {
    const premium = !!licenseStatus?.premium;
    const remVideos = premium
      ? Infinity
      : Number(licenseStatus?.remaining?.videos ?? 5);
    const remImages = premium
      ? Infinity
      : Number(licenseStatus?.remaining?.images ?? 5);

    let freeVideoSlots = remVideos;
    let freeImageSlots = remImages;

    // Orden estable por index de aparición
    const items = [...foundMedia.values()].sort((a, b) => a.index - b.index);
    for (const item of items) {
      if (premium) {
        item.locked = false;
        continue;
      }
      if (item.mediaType === "video") {
        if (freeVideoSlots > 0) {
          item.locked = false;
          freeVideoSlots--;
        } else {
          item.locked = true;
        }
      } else {
        if (freeImageSlots > 0) {
          item.locked = false;
          freeImageSlots--;
        } else {
          item.locked = true;
        }
      }
    }
  }

  function updateQuotaUI() {
    if (!quotaEl || !licenseStatus) return;
    const { premium, usage, limits, remaining } = licenseStatus;
    const vLeft = premium ? "∞" : remaining.videos;
    const iLeft = premium ? "∞" : remaining.images;
    const vClass = !premium && remaining.videos <= 0 ? "is-empty" : premium ? "is-pro" : "";
    const iClass = !premium && remaining.images <= 0 ? "is-empty" : premium ? "is-pro" : "";

    quotaEl.innerHTML = `
      <div class="gid-quota-pill ${vClass}">
        Videos free
        <strong>${premium ? "Ilimitado PRO" : `${usage.videos} / ${limits.videos} · quedan ${vLeft}`}</strong>
      </div>
      <div class="gid-quota-pill ${iClass}">
        Imágenes free
        <strong>${premium ? "Ilimitado PRO" : `${usage.images} / ${limits.images} · quedan ${iLeft}`}</strong>
      </div>
    `;
  }

  function updateHeaderPro() {
    const chip = panelEl?.querySelector(".gid-pro-chip");
    const toggleBadge = counterEl?.querySelector(".gid-badge-pro");
    if (chip) chip.style.display = licenseStatus?.premium ? "inline-block" : "none";
    if (counterEl) {
      const n = foundMedia.size;
      const pro = licenseStatus?.premium
        ? ' <span class="gid-badge-pro">PRO</span>'
        : "";
      counterEl.innerHTML = `${ICONS.download} Media (${n})${pro}`;
    }
  }

  // ─── 4) Panel UI ─────────────────────────────────────────────────────────
  function buildPanel() {
    if (panelEl) return;

    const toggleBtn = document.createElement("button");
    toggleBtn.id = "gid-toggle-btn";
    toggleBtn.type = "button";
    toggleBtn.innerHTML = `${ICONS.download} Media (0)`;
    toggleBtn.addEventListener("click", () => {
      panelEl.classList.toggle("gid-hidden");
    });
    document.body.appendChild(toggleBtn);
    counterEl = toggleBtn;

    panelEl = document.createElement("div");
    panelEl.id = "gid-panel";
    panelEl.className = "gid-hidden";
    panelEl.innerHTML = `
      <div class="gid-header">
        <div class="gid-header-left">
          ${ICONS.zap}
          <span>Grok Imagine</span>
          <span class="gid-pro-chip" style="display:none">PRO</span>
        </div>
        <button type="button" id="gid-close" aria-label="Cerrar">${ICONS.x}</button>
      </div>
      <div class="gid-quota" id="gid-quota"></div>
      <div class="gid-actions">
        <button type="button" id="gid-select-all">Todos</button>
        <button type="button" id="gid-select-none">Ninguno</button>
        <button type="button" id="gid-download" class="gid-primary">${ICONS.download} Descargar seleccionados</button>
      </div>
      <div class="gid-progress-wrap" id="gid-progress-wrap">
        <div class="gid-progress-track"><div class="gid-progress-bar" id="gid-progress-bar"></div></div>
      </div>
      <div id="gid-status"></div>
      <div id="gid-list"></div>
      <div class="gid-license">
        <div class="gid-license-label">${ICONS.key} Ingresar licencia de Lemon Squeezy</div>
        <div class="gid-license-row">
          <input type="text" id="gid-license-input" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" spellcheck="false" autocomplete="off" />
          <button type="button" id="gid-license-redeem">Activar</button>
        </div>
        <div class="gid-license-msg" id="gid-license-msg"></div>
        <button type="button" class="gid-upgrade-link" id="gid-open-checkout">Desbloquear PRO por $5 (pago único) →</button>
      </div>
    `;
    document.body.appendChild(panelEl);

    listEl = panelEl.querySelector("#gid-list");
    statusEl = panelEl.querySelector("#gid-status");
    progressWrap = panelEl.querySelector("#gid-progress-wrap");
    progressBar = panelEl.querySelector("#gid-progress-bar");
    licenseMsgEl = panelEl.querySelector("#gid-license-msg");
    quotaEl = panelEl.querySelector("#gid-quota");

    panelEl.querySelector("#gid-close").addEventListener("click", () => {
      panelEl.classList.add("gid-hidden");
    });
    panelEl.querySelector("#gid-select-all").addEventListener("click", () => {
      foundMedia.forEach((v) => (v.selected = true));
      renderList();
    });
    panelEl.querySelector("#gid-select-none").addEventListener("click", () => {
      foundMedia.forEach((v) => (v.selected = false));
      renderList();
    });
    panelEl
      .querySelector("#gid-download")
      .addEventListener("click", downloadSelected);
    panelEl
      .querySelector("#gid-license-redeem")
      .addEventListener("click", redeemFromUI);
    panelEl
      .querySelector("#gid-open-checkout")
      .addEventListener("click", openCheckout);

    // Enter en el input de licencia
    panelEl
      .querySelector("#gid-license-input")
      .addEventListener("keydown", (e) => {
        if (e.key === "Enter") redeemFromUI();
      });

    buildUpsellModal();
  }

  function renderList() {
    if (!listEl) return;
    updateHeaderPro();
    listEl.innerHTML = "";

    if (foundMedia.size === 0) {
      const ctx = getPageContext();
      let emptyMsg =
        "No hay media todavía. Abrí <strong>Saved</strong> o un <strong>post</strong> tuyo.";
      if (ctx.mode === "home") {
        emptyMsg =
          "En <strong>/imagine</strong> solo hay muestras de Grok (no se listan).<br/>Andá a <strong>/imagine/saved</strong> o abrí un post: <strong>/imagine/post/…</strong>";
      } else if (ctx.mode === "saved") {
        emptyMsg =
          "En <strong>Saved</strong>: scrolleá tu galería. Las miniaturas de tus creaciones deberían aparecer acá.";
      } else if (ctx.mode === "post") {
        emptyMsg =
          "En este <strong>post</strong>: esperá a que cargue la imagen/video. Si no aparece, recargá la página (F5).";
      }
      listEl.innerHTML = `<div class="gid-list-empty">${emptyMsg}</div>`;
      return;
    }

    [...foundMedia.values()]
      .sort((a, b) => a.index - b.index)
      .forEach((item) => {
        const row = document.createElement("label");
        row.className = "gid-row" + (item.locked ? " gid-locked" : "");
        const label =
          item.mediaType === "image"
            ? `Imagen ${item.index}`
            : `Video ${item.index}`;
        const lockHtml = item.locked
          ? '<span class="gid-lock" title="Requiere PRO">🔒</span>'
          : "";
        const isVideo = item.mediaType === "video";
        const thumbHtml = isVideo
          ? `<span class="gid-thumb gid-thumb-video">
              <video src="${escapeAttr(item.url)}" muted playsinline preload="metadata"></video>
              <span class="gid-thumb-badge">${ICONS.video}</span>
            </span>`
          : `<span class="gid-thumb gid-thumb-image">
              <img src="${escapeAttr(item.url)}" alt="" loading="lazy" referrerpolicy="no-referrer" draggable="false" />
            </span>`;

        row.innerHTML = `
          <input type="checkbox" data-url="${encodeURIComponent(item.url)}" ${
          item.selected ? "checked" : ""
        } />
          ${thumbHtml}
          <span class="gid-row-text" title="${escapeAttr(item.url)}">${label}</span>
          <span class="gid-row-meta">${item.mediaType}</span>
          ${lockHtml}
        `;

        // Fallback si la miniatura no carga (CORS / URL rota)
        const thumbImg = row.querySelector(".gid-thumb img");
        if (thumbImg) {
          thumbImg.addEventListener("error", () => {
            const wrap = thumbImg.closest(".gid-thumb");
            if (wrap) {
              wrap.classList.add("gid-thumb-fallback");
              wrap.innerHTML = ICONS.image;
            }
          });
        }
        const thumbVid = row.querySelector(".gid-thumb video");
        if (thumbVid) {
          thumbVid.addEventListener("error", () => {
            const wrap = thumbVid.closest(".gid-thumb");
            if (wrap) {
              wrap.classList.add("gid-thumb-fallback");
              wrap.innerHTML = ICONS.video;
            }
          });
          // Buscar frame ~0.1s para miniatura más visible
          thumbVid.addEventListener(
            "loadeddata",
            () => {
              try {
                if (thumbVid.duration && isFinite(thumbVid.duration)) {
                  thumbVid.currentTime = Math.min(0.15, thumbVid.duration * 0.05);
                }
              } catch (_) {
                /* ignore */
              }
            },
            { once: true }
          );
        }

        row.querySelector("input").addEventListener("change", (e) => {
          item.selected = e.target.checked;
        });
        if (item.locked) {
          row.querySelector(".gid-lock")?.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            showUpsell(
              item.mediaType === "image"
                ? "Alcanzaste el límite free de imágenes"
                : "Alcanzaste el límite free de videos"
            );
          });
        }
        listEl.appendChild(row);
      });
  }

  function setStatus(text, kind) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.classList.remove("gid-error", "gid-success");
    if (kind === "error") statusEl.classList.add("gid-error");
    if (kind === "success") statusEl.classList.add("gid-success");
  }

  function setProgress(done, total) {
    if (!progressWrap || !progressBar) return;
    if (total <= 0) {
      progressWrap.classList.remove("gid-visible");
      progressBar.style.width = "0%";
      return;
    }
    progressWrap.classList.add("gid-visible");
    const pct = Math.round((done / total) * 100);
    progressBar.style.width = pct + "%";
  }

  // ─── Descarga con paywall ────────────────────────────────────────────────
  async function downloadSelected() {
    if (isDownloading) return;
    const selected = [...foundMedia.values()].filter((v) => v.selected);
    if (selected.length === 0) {
      setStatus("No hay ítems seleccionados.", "error");
      return;
    }

    // Refrescar estado por si cambió el cupo
    await refreshLicenseStatus();
    applyLockFlags();

    const freeItems = selected.filter((i) => !i.locked);
    const lockedItems = selected.filter((i) => i.locked);

    // Si TODOS están locked → solo upsell
    if (freeItems.length === 0 && lockedItems.length > 0) {
      showUpsell("Necesitás PRO para descargar estos ítems");
      return;
    }

    // Si hay locked + free → descargar free y avisar upsell al final
    isDownloading = true;
    const btn = panelEl.querySelector("#gid-download");
    if (btn) btn.disabled = true;

    let done = 0;
    let okCount = 0;
    let failCount = 0;
    const total = freeItems.length;
    setProgress(0, total);
    setStatus(`Descargando 0 / ${total}…`);

    for (const item of freeItems) {
      const ext =
        item.mediaType === "image" ? guessImageExt(item.url) : "mp4";
      // Free: marca en el nombre; PRO: nombre limpio
      const premium = !!licenseStatus?.premium;
      const stamp = Date.now();
      const filename = premium
        ? `GrokImagine/grok-imagine-${stamp}-${item.index}.${ext}`
        : `GrokImagine/grok-imagine-free-${stamp}-${item.index}.${ext}`;

      try {
        let downloadUrl = item.url;
        // blob: solo existe en esta pestaña → dataURL
        if (item.url.startsWith("blob:")) {
          const blob = await fetch(item.url).then((r) => r.blob());
          downloadUrl = await blobToDataUrl(blob);
        } else if (item.mediaType === "image") {
          // Algunos CDNs redirigen o requieren navegador: intentar blob local
          try {
            const resp = await fetch(item.url, { credentials: "include" });
            if (resp.ok) {
              const blob = await resp.blob();
              if (blob && blob.size > 500) {
                downloadUrl = await blobToDataUrl(blob);
              }
            }
          } catch (_) {
            // Si falla CORS, chrome.downloads con la URL directa
            downloadUrl = item.url;
          }
        }
        const res = await chrome.runtime.sendMessage({
          type: "GID_DOWNLOAD",
          url: downloadUrl,
          filename,
        });
        if (res && res.ok) {
          okCount++;
          // Contar solo descargas exitosas free
          if (!premium) {
            const mediaTypeKey =
              item.mediaType === "image" ? "images" : "videos";
            if (typeof GIDLicense !== "undefined") {
              await GIDLicense.incrementUsage(mediaTypeKey);
            } else {
              await chrome.runtime.sendMessage({
                type: "GID_INCREMENT_USAGE",
                mediaType: mediaTypeKey,
              });
            }
          }
        } else {
          failCount++;
          console.error("GID download fail:", item.url, res?.error);
        }
      } catch (e) {
        failCount++;
        console.error("Grok Imagine Downloader: error descargando", item.url, e);
        // No detener el lote
      }

      done++;
      setProgress(done, total);
      setStatus(
        `Descargando ${done} / ${total}…` +
          (failCount ? ` (${failCount} error${failCount > 1 ? "es" : ""})` : "")
      );
      await new Promise((r) => setTimeout(r, 300));
    }

    // Refrescar cupos tras incrementos
    await refreshLicenseStatus();

    if (failCount === 0) {
      setStatus(`Listo: ${okCount} / ${total} descargados.`, "success");
    } else {
      setStatus(
        `Completado con errores: ${okCount} ok, ${failCount} fallidos de ${total}.`,
        "error"
      );
    }

    isDownloading = false;
    if (btn) btn.disabled = false;

    // Si había ítems locked seleccionados, mostrar upsell
    if (lockedItems.length > 0) {
      showUpsell(
        `${okCount} descargados. ${lockedItems.length} ítem(s) requieren PRO`
      );
    }
  }

  function guessImageExt(url) {
    const m = String(url).match(/\.(png|jpe?g|webp|gif)/i);
    if (!m) return "png";
    const e = m[1].toLowerCase();
    return e === "jpeg" ? "jpg" : e;
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  // ─── License redeem UI ───────────────────────────────────────────────────
  async function redeemFromUI() {
    const input = panelEl.querySelector("#gid-license-input");
    const key = (input?.value || "").trim();
    if (!key) {
      setLicenseMsg("Pegá tu código de licencia.", "err");
      return;
    }
    setLicenseMsg("Validando…", "");
    try {
      let result;
      if (typeof GIDLicense !== "undefined") {
        result = await GIDLicense.redeemLicenseKey(key);
        // Avisar al SW para badge PRO
        chrome.runtime.sendMessage({ type: "GID_REFRESH_BADGE" }).catch(() => {});
      } else {
        result = await chrome.runtime.sendMessage({
          type: "GID_REDEEM_KEY",
          key,
        });
      }
      if (result?.ok) {
        let msg = result.dev
          ? "✓ PRO activado (modo dev)."
          : `✓ PRO activado${result.email ? " · " + result.email : ""}`;
        if (result.warning) msg += " · " + result.warning;
        setLicenseMsg(msg, "ok");
        await refreshLicenseStatus();
      } else {
        setLicenseMsg(result?.error || "No se pudo activar.", "err");
      }
    } catch (e) {
      setLicenseMsg("Error de red al validar la licencia.", "err");
    }
  }

  function setLicenseMsg(text, kind) {
    if (!licenseMsgEl) return;
    licenseMsgEl.textContent = text;
    licenseMsgEl.classList.remove("ok", "err");
    if (kind === "ok") licenseMsgEl.classList.add("ok");
    if (kind === "err") licenseMsgEl.classList.add("err");
  }

  function openCheckout() {
    const url =
      licenseStatus?.paymentLink ||
      (typeof GIDLicense !== "undefined"
        ? GIDLicense.getPaymentLink()
        : null);
    if (
      !url ||
      url.includes("YOURSTORE") ||
      url.includes("VARIANT_ID") ||
      !url.includes("lemonsqueezy.com")
    ) {
      setLicenseMsg(
        "Configurá LEMONSQUEEZY_CHECKOUT_URL en license.js antes de cobrar.",
        "err"
      );
      showUpsell("Configuración de pago pendiente");
      return;
    }
    chrome.runtime.sendMessage({ type: "GID_OPEN_CHECKOUT", url }).catch(() => {
      window.open(url, "_blank");
    });
  }

  // ─── Modal upsell ────────────────────────────────────────────────────────
  let modalOverlay = null;

  function buildUpsellModal() {
    if (modalOverlay) return;
    modalOverlay = document.createElement("div");
    modalOverlay.id = "gid-modal-overlay";
    modalOverlay.className = "gid-hidden";
    modalOverlay.innerHTML = `
      <div class="gid-modal" role="dialog" aria-modal="true" aria-labelledby="gid-modal-title">
        <button type="button" class="gid-modal-close" id="gid-modal-close" aria-label="Cerrar">${ICONS.x}</button>
        <div class="gid-modal-icon">${ICONS.sparkles}</div>
        <h2 id="gid-modal-title">Desbloqueá PRO</h2>
        <p id="gid-modal-desc">Llegaste al límite free (5 imágenes + 5 videos de por vida).</p>
        <ul class="gid-benefits">
          <li>${ICONS.check} <span><strong>Descargas ilimitadas</strong> de videos e imágenes</span></li>
          <li>${ICONS.check} <span><strong>Sin marca de agua</strong> en el nombre de archivo</span></li>
          <li>${ICONS.check} <span><strong>Soporte prioritario</strong> y actualizaciones</span></li>
        </ul>
        <button type="button" class="gid-modal-cta" id="gid-modal-cta">Desbloquear por $5 (pago único)</button>
        <p class="gid-modal-sub">Pago seguro con Lemon Squeezy · Copiá la license key de la pantalla de gracias y pegala acá</p>
      </div>
    `;
    document.body.appendChild(modalOverlay);

    modalOverlay.addEventListener("click", (e) => {
      if (e.target === modalOverlay) hideUpsell();
    });
    modalOverlay
      .querySelector("#gid-modal-close")
      .addEventListener("click", hideUpsell);
    modalOverlay.querySelector("#gid-modal-cta").addEventListener("click", () => {
      hideUpsell();
      openCheckout();
    });
  }

  function showUpsell(reason) {
    buildUpsellModal();
    const desc = modalOverlay.querySelector("#gid-modal-desc");
    if (desc) {
      desc.textContent =
        reason ||
        "Llegaste al límite free (5 imágenes + 5 videos de por vida).";
    }
    modalOverlay.classList.remove("gid-hidden");
  }

  function hideUpsell() {
    modalOverlay?.classList.add("gid-hidden");
  }

  function escapeAttr(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;");
  }

  // Mensajes del popup / SW (registrados al cargar el script)
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message?.type) return;

    if (message.type === "GID_PING") {
      sendResponse({
        ok: true,
        ready: true,
        path: location.pathname,
        mediaCount: foundMedia.size,
      });
      return false;
    }

    if (message.type === "GID_OPEN_PANEL") {
      try {
        // Asegurar body + panel aunque init aún no corrió
        if (!document.body) {
          sendResponse({ ok: false, error: "document.body no listo" });
          return false;
        }
        if (!panelEl) buildPanel();
        panelEl?.classList.remove("gid-hidden");
        scanDomForMedia();
        updateRouteHint();
        if (counterEl) {
          counterEl.style.transform = "scale(1.08)";
          setTimeout(() => {
            if (counterEl) counterEl.style.transform = "";
          }, 400);
        }
        sendResponse({ ok: true, path: location.pathname, count: foundMedia.size });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
      return false;
    }
  });

  // ─── Init ────────────────────────────────────────────────────────────────
  function init() {
    // El panel necesita <body>; si aún no existe, esperar
    if (!document.body) {
      document.addEventListener("DOMContentLoaded", init, { once: true });
      return;
    }
    injectPageScript();
    buildPanel();
    refreshLicenseStatus();
    scanDomForMedia();
    updateRouteHint();
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
    // Media async en saved/post
    setInterval(scanDomForMedia, 2000);
    // SPA: al cambiar de /imagine → /saved → /post limpiar lista (no arrastrar muestras)
    let lastPath = location.pathname;
    setInterval(() => {
      if (location.pathname !== lastPath) {
        lastPath = location.pathname;
        clearMediaList();
        // Nuevo post id → permitir probe de nuevo
        try {
          delete window.__gidPostProbe;
        } catch (_) {
          window.__gidPostProbe = undefined;
        }
        injectPageScript();
        scanDomForMedia();
        updateRouteHint();
      }
    }, 500);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

/*
 * ═══════════════════════════════════════════════════════════════════════════
 * CUMPLIMIENTO / POLÍTICAS — REVISAR ANTES DE PUBLICAR EN CHROME WEB STORE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 1) PAGOS FUERA DE CHROME WEB STORE (Lemon Squeezy Checkout)
 *    Las extensiones que venden features digitales pueden estar sujetas a la
 *    política de Payments de la CWS. Un checkout externo (Lemon Squeezy) puede
 *    chocar con reglas que exigen el sistema de pagos de Chrome Web Store.
 *    ACCIÓN: leé la política vigente de Payments de la CWS antes de publicar.
 *
 * 2) SCRAPING / INTERCEPCIÓN DE CONTENIDO DE grok.com
 *    - Interceptar fetch/XHR e inyectar scripts puede violar ToS de xAI/Grok.
 *    - Declará en la ficha CWS que el usuario descarga SU propio contenido.
 *
 * 3) PERMISOS Y PRIVACIDAD
 *    - host_permissions incluye api.lemonsqueezy.com (validación de licencia).
 *    - Privacy policy si procesás emails vía Lemon Squeezy.
 *
 * 4) MARCA "GROK"
 *    - Riesgo de trademark de xAI; considerá un nombre genérico.
 *
 * Checklist pre-publicación:
 *  [ ] LEMONSQUEEZY_CHECKOUT_URL real en license.js
 *  [ ] Producto LS con Generate license keys + activation limit ≥ 3
 *  [ ] (Opcional) LEMONSQUEEZY_PRODUCT_ID / STORE_ID para anti-fraude
 *  [ ] Privacy policy URL
 *  [ ] Revisar CWS Payments policy + ToS de xAI/Grok
 * ═══════════════════════════════════════════════════════════════════════════
 */
