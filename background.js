/**
 * background.js — Service worker (Manifest V3)
 *
 * Responsabilidades:
 * - Descargar archivos vía chrome.downloads
 * - Coordinar licencias Lemon Squeezy (revalidación semanal, badge PRO)
 * - Mensajes desde content scripts
 * - Abrir checkout Lemon Squeezy en pestaña nueva
 *
 * Carga license.js con importScripts (mismo objeto GIDLicense).
 * La validación de keys la hace license.js contra api.lemonsqueezy.com
 * (no hay backend propio en el camino crítico).
 */
/* global GIDLicense */
importScripts("license.js");

// ─── Badge PRO en el icono de la extensión ─────────────────────────────────

async function refreshActionBadge() {
  try {
    const premium = await GIDLicense.isPremium();
    if (premium) {
      await chrome.action.setBadgeText({ text: "PRO" });
      await chrome.action.setBadgeBackgroundColor({ color: "#7c3aed" });
      await chrome.action.setTitle({
        title: "Grok Imagine Downloader — PRO",
      });
    } else {
      await chrome.action.setBadgeText({ text: "" });
      await chrome.action.setTitle({
        title: "Grok Imagine Downloader",
      });
    }
  } catch (e) {
    console.warn("GID badge:", e);
  }
}

// Al instalar / arrancar el SW: revalidar licencia (máx 1/semana) y badge
chrome.runtime.onInstalled.addListener(() => {
  GIDLicense.ensurePremiumFresh().finally(refreshActionBadge);
});

chrome.runtime.onStartup?.addListener?.(() => {
  GIDLicense.ensurePremiumFresh().finally(refreshActionBadge);
});

// Primera carga del SW
GIDLicense.ensurePremiumFresh().finally(refreshActionBadge);

function isGrokUrl(url) {
  return /^https:\/\/([^/]*\.)?grok\.com\//i.test(url || "");
}

/**
 * Inyecta inject.js en el MAIN world (contexto de la página).
 * chrome.scripting + world:MAIN no lo bloquea el CSP nonce de grok.com.
 */
async function injectMainWorld(tabId) {
  if (!tabId || !chrome.scripting?.executeScript) return { ok: false };
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["inject.js"],
      world: "MAIN",
      injectImmediately: true,
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

/**
 * Asegura content scripts (license + content + CSS) en la pestaña.
 * Necesario si la pestaña se abrió antes de instalar/recargar la extensión,
 * o si la inyección declarativa falló.
 */
async function ensureContentScripts(tabId) {
  if (!tabId || !chrome.scripting?.executeScript) {
    return { ok: false, error: "scripting no disponible" };
  }

  // ¿Ya está vivo el content script?
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { type: "GID_PING" });
    if (pong?.ok) {
      await injectMainWorld(tabId);
      return { ok: true, already: true };
    }
  } catch (_) {
    // no hay receptor → inyectar
  }

  try {
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ["panel.css"],
    });
  } catch (e) {
    // CSS puede fallar si ya está; seguir
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["license.js", "content.js"],
    });
  } catch (e) {
    return { ok: false, error: "inject content: " + (e?.message || e) };
  }

  await injectMainWorld(tabId);

  // Confirmar
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { type: "GID_PING" });
    return { ok: !!pong?.ok, path: pong?.path };
  } catch (e) {
    return { ok: false, error: "ping post-inject: " + (e?.message || e) };
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = tab?.url || "";
  if (!isGrokUrl(url)) return;
  if (changeInfo.status === "complete") {
    // Reinyectar al terminar de cargar (post, saved, etc.)
    ensureContentScripts(tabId).catch(() => {});
  } else if (changeInfo.status === "loading") {
    injectMainWorld(tabId);
  }
});

// ─── Mensajes ──────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return;

  if (message.type === "GID_INJECT_MAIN") {
    const tabId = sender.tab?.id;
    injectMainWorld(tabId)
      .then((r) => sendResponse(r || { ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  // Popup: asegurar content script en la pestaña activa
  if (message.type === "GID_ENSURE_CONTENT") {
    const tabId = message.tabId;
    ensureContentScripts(tabId)
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  // Popup: abrir panel (con re-inyección si hace falta)
  if (message.type === "GID_OPEN_PANEL_IN_TAB") {
    const tabId = message.tabId;
    (async () => {
      const ensured = await ensureContentScripts(tabId);
      if (!ensured.ok) {
        sendResponse(ensured);
        return;
      }
      try {
        const res = await chrome.tabs.sendMessage(tabId, {
          type: "GID_OPEN_PANEL",
        });
        sendResponse(res || { ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
    })();
    return true;
  }

  // Descarga real
  if (message.type === "GID_DOWNLOAD") {
    chrome.downloads.download(
      {
        url: message.url,
        filename: message.filename,
        saveAs: false,
        conflictAction: "uniquify",
      },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          console.error(
            "Grok Imagine Downloader:",
            chrome.runtime.lastError.message
          );
          sendResponse({
            ok: false,
            error: chrome.runtime.lastError.message,
          });
        } else {
          sendResponse({ ok: true, downloadId });
        }
      }
    );
    return true; // async
  }

  // Estado freemium / premium para el panel
  if (message.type === "GID_LICENSE_STATUS") {
    GIDLicense.getStatus()
      .then((status) => sendResponse({ ok: true, status }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  // Canjear license key
  if (message.type === "GID_REDEEM_KEY") {
    GIDLicense.redeemLicenseKey(message.key)
      .then(async (result) => {
        await refreshActionBadge();
        sendResponse(result);
      })
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  // ¿Puede descargar este tipo?
  if (message.type === "GID_CAN_DOWNLOAD") {
    GIDLicense.canDownload(message.mediaType)
      .then((allowed) => sendResponse({ ok: true, allowed }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  // Incrementar uso tras descarga exitosa
  if (message.type === "GID_INCREMENT_USAGE") {
    GIDLicense.incrementUsage(message.mediaType)
      .then(async (usage) => {
        const status = await GIDLicense.getStatus();
        sendResponse({ ok: true, usage, status });
      })
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  // Abrir Lemon Squeezy Checkout en pestaña nueva
  if (message.type === "GID_OPEN_CHECKOUT") {
    const url = message.url || GIDLicense.getPaymentLink();
    chrome.tabs.create({ url });
    sendResponse({ ok: true });
    return false;
  }

  // Forzar refresh del badge (tras redeem desde content)
  if (message.type === "GID_REFRESH_BADGE") {
    refreshActionBadge()
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
});
