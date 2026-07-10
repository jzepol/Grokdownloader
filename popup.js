/**
 * Popup del icono de la extensión.
 * Si el content script no está (tab abierta antes de recargar la ext), lo re-inyecta.
 */
(async function () {
  const pageStatus = document.getElementById("page-status");
  const statusCard = document.getElementById("status-card");
  const planLabel = document.getElementById("plan-label");
  const btnOpen = document.getElementById("btn-open-imagine");
  const btnToggle = document.getElementById("btn-toggle-panel");

  function setWarn(msg) {
    pageStatus.textContent = msg;
    statusCard.classList.remove("ok");
    statusCard.classList.add("warn");
  }

  function setOk(msg) {
    pageStatus.textContent = msg;
    statusCard.classList.remove("warn");
    statusCard.classList.add("ok");
  }

  // Estado freemium / PRO
  try {
    const res = await chrome.runtime.sendMessage({ type: "GID_LICENSE_STATUS" });
    if (res?.ok && res.status) {
      planLabel.textContent = res.status.premium
        ? "Plan PRO activo"
        : `Free · ${res.status.usage?.images ?? 0}/${res.status.limits?.images ?? 5} img · ${res.status.usage?.videos ?? 0}/${res.status.limits?.videos ?? 5} vid`;
    } else {
      planLabel.textContent = "Listo para usar";
    }
  } catch (_) {
    planLabel.textContent = "Listo para usar";
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url || "";
  const onGrok = /^https:\/\/([^/]*\.)?grok\.com\//i.test(url);

  if (!tab?.id) {
    setWarn("No hay pestaña activa.");
    btnToggle.disabled = true;
    return;
  }

  if (!onGrok) {
    setWarn(
      "No estás en grok.com. Abrí un post o Saved y volvé a probar."
    );
    btnToggle.disabled = true;
  } else {
    const path = (() => {
      try {
        return new URL(url).pathname;
      } catch {
        return "";
      }
    })();
    setOk(
      path.includes("/imagine/post/")
        ? "Post de Imagine detectado. Tocá “Mostrar panel” o buscá el botón Media."
        : path.includes("/imagine/saved")
          ? "Estás en Saved. Tocá “Mostrar panel” o el botón Media."
          : "Estás en Grok. Para descargar usá /imagine/saved o un /imagine/post/…"
    );
    btnToggle.disabled = false;

    // Pre-calentar content script (si la pestaña se abrió antes de recargar la ext)
    chrome.runtime
      .sendMessage({ type: "GID_ENSURE_CONTENT", tabId: tab.id })
      .then((r) => {
        if (r && !r.ok) {
          setWarn(
            "No pude inyectar el panel todavía: " +
              (r.error || "error") +
              ". Probá F5 en la pestaña de Grok."
          );
        }
      })
      .catch(() => {});
  }

  btnOpen.addEventListener("click", () => {
    chrome.tabs.create({ url: "https://grok.com/imagine/saved" });
    window.close();
  });

  btnToggle.addEventListener("click", async () => {
    if (!tab?.id) return;
    btnToggle.disabled = true;
    pageStatus.textContent = "Conectando con la página…";

    try {
      const res = await chrome.runtime.sendMessage({
        type: "GID_OPEN_PANEL_IN_TAB",
        tabId: tab.id,
      });

      if (res?.ok) {
        window.close();
        return;
      }

      setWarn(
        "No se pudo abrir el panel: " +
          (res?.error || "desconocido") +
          ". Recargá esta pestaña de Grok (F5) y probá otra vez."
      );
    } catch (e) {
      setWarn(
        "Error: " +
          (e?.message || e) +
          ". Recargá la pestaña del post (F5) y reintentá."
      );
    } finally {
      btnToggle.disabled = false;
    }
  });
})();
