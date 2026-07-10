// Contexto de PÁGINA: hook fetch/XHR + DOM.
// Solo reporta media en /imagine/saved y /imagine/post/* (no en home de muestras).
(function () {
  if (window.__gidInjectInstalled) return;
  window.__gidInjectInstalled = true;

  const VIDEO_EXT_RE = /\.(mp4|webm|mov|m3u8)(\?|#|$)/i;
  const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|avif|bmp)(\?|#|$)/i;

  const USER_CONTENT_HOST_RE =
    /(assets\.grokusercontent\.com|imagine-public\.x\.ai|artifacts\.grokusercontent\.com)/i;
  const ASSETS_GROK_MEDIA_RE =
    /assets\.grok\.com\/.+(share-images|share-videos|generated|users\/|media\/)/i;

  const UI_NOISE_RE =
    /(\/avatar|\/emoji|\/icon|\/logo|\/favicon|\/sprite|\/static\/media\/|fonts\.|woff2?|UniversalSans|_next\/static|cdn\.grok\.com)/i;
  const SAMPLE_NOISE_RE =
    /(sample|placeholder|marketing|hero|landing|onboarding|demo|tutorial|showcase|promo|banner|welcome|featured)/i;

  function pageAllowsScrape() {
    const path = location.pathname || "";
    if (/\/imagine\/post\/[0-9a-f-]{36}/i.test(path)) return true;
    if (/\/imagine\/saved/i.test(path)) return true;
    // Otras subrutas de imagine excepto home puro
    if (/\/imagine\/?$/i.test(path)) return false;
    if (/\/imagine\/(explore|feed|home|discover)/i.test(path)) return false;
    return /\/imagine\//i.test(path);
  }

  function reportMedia(url, mediaType, source) {
    if (!pageAllowsScrape()) return;
    if (!url || typeof url !== "string") return;
    if (url.startsWith("data:")) return;
    if (url.length > 8000) return;
    window.postMessage(
      {
        __grokImagineDownloader: true,
        type: "MEDIA_FOUND",
        url,
        mediaType,
        source,
      },
      "*"
    );
  }

  function cleanUrl(url) {
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

  function isNoise(url) {
    return UI_NOISE_RE.test(url) || SAMPLE_NOISE_RE.test(url);
  }

  function looksLikeUserImage(url) {
    if (!url || isNoise(url)) return false;
    if (url.startsWith("blob:")) return true;
    if (USER_CONTENT_HOST_RE.test(url)) return true;
    if (ASSETS_GROK_MEDIA_RE.test(url)) return true;
    if (/imagine-public|share-images|share-videos/i.test(url)) return true;
    if (IMAGE_EXT_RE.test(url) && /(grokusercontent|imagine-public|x\.ai)/i.test(url))
      return true;
    return false;
  }

  function looksLikeUserVideo(url) {
    if (!url || isNoise(url)) return false;
    if (url.startsWith("blob:")) return true;
    if (VIDEO_EXT_RE.test(url) && /(x\.ai|grokusercontent|grok|share-videos)/i.test(url))
      return true;
    if (USER_CONTENT_HOST_RE.test(url) && /video|mp4|webm/i.test(url)) return true;
    return false;
  }

  function classifyAndReport(url, source) {
    url = cleanUrl(url);
    if (!url) return;
    if (looksLikeUserVideo(url)) {
      reportMedia(url, "video", source);
      return;
    }
    if (looksLikeUserImage(url)) {
      reportMedia(url, "image", source);
    }
  }

  function extractUrlsFromString(str) {
    if (typeof str !== "string" || str.length < 12) return [];
    const out = [];
    const re = /https?:\/\/[^\s"'<>\\]+/gi;
    let m;
    while ((m = re.exec(str)) !== null) {
      out.push(m[0].replace(/[,;)\]}]+$/, ""));
    }
    return out;
  }

  function scanObjectForMediaUrls(obj, depth = 0) {
    if (!pageAllowsScrape()) return;
    if (depth > 8 || obj == null) return;
    if (typeof obj === "string") {
      extractUrlsFromString(obj).forEach((u) => classifyAndReport(u, "json"));
      if (/^https?:\/\//i.test(obj) || obj.startsWith("//")) {
        classifyAndReport(obj.startsWith("//") ? "https:" + obj : obj, "json");
      }
      return;
    }
    if (Array.isArray(obj)) {
      obj.forEach((v) => scanObjectForMediaUrls(v, depth + 1));
      return;
    }
    if (typeof obj === "object") {
      for (const key in obj) {
        try {
          const k = String(key).toLowerCase();
          const v = obj[key];
          if (
            typeof v === "string" &&
            /url|src|image|thumb|poster|cover|asset|media|hd|original|download|file/i.test(
              k
            )
          ) {
            classifyAndReport(v, "json-field:" + key);
          }
          scanObjectForMediaUrls(v, depth + 1);
        } catch (e) {
          /* ignore */
        }
      }
    }
  }

  // ---- Hook fetch ----
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);
    try {
      if (!pageAllowsScrape()) return response;
      const reqUrl =
        typeof args[0] === "string" ? args[0] : args[0]?.url || "";
      const contentType = response.headers.get("content-type") || "";
      const finalUrl = response.url || reqUrl;

      if (contentType.includes("video/") || looksLikeUserVideo(finalUrl)) {
        reportMedia(finalUrl, "video", "fetch-media");
      } else if (
        contentType.includes("image/") ||
        looksLikeUserImage(finalUrl)
      ) {
        reportMedia(finalUrl, "image", "fetch-media");
      } else if (
        contentType.includes("application/json") ||
        contentType.includes("text/plain")
      ) {
        response
          .clone()
          .text()
          .then((text) => {
            try {
              scanObjectForMediaUrls(JSON.parse(text));
            } catch (_) {
              extractUrlsFromString(text).forEach((u) =>
                classifyAndReport(u, "fetch-text")
              );
            }
          })
          .catch(() => {});
      }
    } catch (e) {
      /* no romper fetch */
    }
    return response;
  };

  // ---- Hook XHR ----
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__gidUrl = url;
    return originalOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener("load", function () {
      try {
        if (!pageAllowsScrape()) return;
        const contentType = this.getResponseHeader("content-type") || "";
        const url = this.responseURL || this.__gidUrl || "";

        if (contentType.includes("video/") || looksLikeUserVideo(url)) {
          reportMedia(url, "video", "xhr-media");
        } else if (contentType.includes("image/") || looksLikeUserImage(url)) {
          reportMedia(url, "image", "xhr-media");
        } else if (typeof this.responseText === "string" && this.responseText) {
          try {
            scanObjectForMediaUrls(JSON.parse(this.responseText));
          } catch (_) {
            extractUrlsFromString(this.responseText).forEach((u) =>
              classifyAndReport(u, "xhr-text")
            );
          }
        }
      } catch (e) {
        /* ignore */
      }
    });
    return originalSend.apply(this, args);
  };

  function parseSrcset(srcset) {
    if (!srcset) return [];
    return srcset.split(",").map((part) => part.trim().split(/\s+/)[0]);
  }

  function collectFromElement(el) {
    const urls = new Set();
    [
      "src",
      "currentSrc",
      "data-src",
      "data-original",
      "data-url",
      "data-image",
      "data-full",
      "data-hd",
      "poster",
      "href",
    ].forEach((a) => {
      try {
        const v = el[a] || el.getAttribute?.(a);
        if (v) urls.add(v);
      } catch (_) {
        /* ignore */
      }
    });
    parseSrcset(
      el.getAttribute?.("srcset") || el.getAttribute?.("data-srcset")
    ).forEach((u) => urls.add(u));
    try {
      const bg =
        el.style?.backgroundImage || getComputedStyle(el).backgroundImage || "";
      const bgMatches = bg.match(/url\(["']?([^"')]+)["']?\)/gi) || [];
      bgMatches.forEach((m) => {
        urls.add(m.replace(/^url\(["']?/, "").replace(/["']?\)$/, ""));
      });
    } catch (_) {
      /* ignore */
    }
    return [...urls];
  }

  function scanDom() {
    if (!pageAllowsScrape()) return;

    const isSaved = /\/imagine\/saved/i.test(location.pathname);
    const isPost = /\/imagine\/post\//i.test(location.pathname);
    const minDim = isSaved ? 80 : 160;

    document.querySelectorAll("video").forEach((video) => {
      collectFromElement(video).forEach((u) => {
        if (looksLikeUserVideo(u) || u.startsWith("blob:")) {
          reportMedia(cleanUrl(u), "video", "dom-video");
        }
      });
      video.querySelectorAll("source").forEach((s) => {
        collectFromElement(s).forEach((u) => {
          if (looksLikeUserVideo(u) || u.startsWith("blob:")) {
            reportMedia(cleanUrl(u), "video", "dom-source");
          }
        });
      });
    });

    document.querySelectorAll("img, picture source").forEach((el) => {
      collectFromElement(el).forEach((u) => {
        const cleaned = cleanUrl(u);
        if (!cleaned) return;
        if (cleaned.startsWith("blob:")) {
          reportMedia(cleaned, "image", "dom-img");
          return;
        }
        if (looksLikeUserImage(cleaned)) {
          reportMedia(cleaned, "image", "dom-img");
          return;
        }
        if (el.tagName === "IMG") {
          const w = el.naturalWidth || el.clientWidth || 0;
          const h = el.naturalHeight || el.clientHeight || 0;
          if (
            w >= minDim &&
            h >= minDim &&
            /^https?:\/\//i.test(cleaned) &&
            !isNoise(cleaned)
          ) {
            reportMedia(cleaned, "image", "dom-img-large");
          }
        }
      });
    });

    if (isPost) {
      try {
        const m = location.pathname.match(
          /\/imagine\/post\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i
        );
        if (m) {
          // No forzar URL que dé 403; el content script hace probe con fetch
        }
      } catch (_) {
        /* ignore */
      }
    }

    if (isSaved) {
      document
        .querySelectorAll('a[href*="/imagine/post/"] img')
        .forEach((img) => {
          collectFromElement(img).forEach((u) => {
            const cleaned = cleanUrl(u);
            if (cleaned && !isNoise(cleaned)) {
              reportMedia(cleaned, "image", "dom-saved-thumb");
            }
          });
        });
    }
  }

  setInterval(scanDom, 1500);
  scanDom();

  const _push = history.pushState;
  const _replace = history.replaceState;
  history.pushState = function () {
    const r = _push.apply(this, arguments);
    setTimeout(scanDom, 400);
    return r;
  };
  history.replaceState = function () {
    const r = _replace.apply(this, arguments);
    setTimeout(scanDom, 400);
    return r;
  };
  window.addEventListener("popstate", () => setTimeout(scanDom, 400));
})();
