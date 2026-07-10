/**
 * Cloudflare Worker OPCIONAL — Grok Imagine Downloader
 *
 * Por defecto la extensión valida licencias DIRECTO contra Lemon Squeezy
 * (POST /v1/licenses/activate y /validate). No hace falta desplegar este Worker.
 *
 * Úsalo solo si necesitás:
 *   A) Webhook order_created / license_key_created para guardar emails en KV
 *   B) Proxy de la License API (si en el futuro alguna política bloqueara
 *      llamadas directas; hoy las extensiones con host_permissions no tienen
 *      problema de CORS con api.lemonsqueezy.com)
 *
 * Endpoints:
 *   POST /webhook          — Lemon Squeezy webhooks (firma X-Signature)
 *   POST /proxy/activate   — proxy opcional a LS activate
 *   POST /proxy/validate   — proxy opcional a LS validate
 *   GET  /health
 *
 * Secrets:
 *   LEMONSQUEEZY_WEBHOOK_SECRET  — el secret que definís al crear el webhook
 *
 * Binding KV (opcional):
 *   LICENSES
 */

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type, x-signature",
    },
  });
}

/** Lemon Squeezy firma el body con HMAC-SHA256 hex en header X-Signature */
async function verifyLemonSignature(rawBody, signature, secret) {
  if (!signature || !secret) return false;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signed = await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody));
  const expected = [...new Uint8Array(signed)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return diff === 0;
}

async function handleWebhook(request, env) {
  const raw = await request.text();
  const sig = request.headers.get("X-Signature") || "";

  if (env.LEMONSQUEEZY_WEBHOOK_SECRET) {
    const ok = await verifyLemonSignature(
      raw,
      sig,
      env.LEMONSQUEEZY_WEBHOOK_SECRET
    );
    if (!ok) return json({ error: "Invalid signature" }, 400);
  }

  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  // meta.event_name: order_created, license_key_created, etc.
  const eventName = event.meta?.event_name || event.event_name || "unknown";
  const data = event.data || {};
  const attrs = data.attributes || {};

  // Guardar en KV si está configurado (analítica / soporte)
  if (env.LICENSES) {
    const record = {
      eventName,
      id: data.id,
      email: attrs.user_email || attrs.customer_email || null,
      status: attrs.status || null,
      createdAt: new Date().toISOString(),
    };
    const key = `event:${eventName}:${data.id || Date.now()}`;
    await env.LICENSES.put(key, JSON.stringify(record));

    // Si el payload trae license key (license_key_created)
    const licenseKey = attrs.key || attrs.license_key;
    if (licenseKey) {
      await env.LICENSES.put(
        `key:${licenseKey}`,
        JSON.stringify({
          key: licenseKey,
          email: record.email,
          eventName,
          createdAt: record.createdAt,
        })
      );
    }
  }

  console.log(JSON.stringify({ eventName, id: data.id }));
  return json({ received: true, eventName });
}

/** Proxy opcional a License API (la extensión no lo usa por defecto). */
async function proxyLicense(action, request) {
  let fields;
  try {
    const ct = request.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      fields = await request.json();
    } else {
      const text = await request.text();
      fields = Object.fromEntries(new URLSearchParams(text));
    }
  } catch {
    return json({ error: "Invalid body" }, 400);
  }

  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields || {})) {
    if (v != null) body.set(k, String(v));
  }

  const res = await fetch(
    `https://api.lemonsqueezy.com/v1/licenses/${action}`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    }
  );
  const data = await res.json().catch(() => ({}));
  return json(data, res.status);
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "content-type, x-signature",
        },
      });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, "") || "/";

    try {
      if (path === "/health" && request.method === "GET") {
        return json({
          ok: true,
          service: "gid-license-optional",
          note: "Extension uses Lemon Squeezy License API directly by default",
        });
      }
      if (path === "/webhook" && request.method === "POST") {
        return await handleWebhook(request, env);
      }
      if (path === "/proxy/activate" && request.method === "POST") {
        return await proxyLicense("activate", request);
      }
      if (path === "/proxy/validate" && request.method === "POST") {
        return await proxyLicense("validate", request);
      }
      return json(
        {
          error: "Not found",
          endpoints: [
            "/webhook",
            "/proxy/activate",
            "/proxy/validate",
            "/health",
          ],
        },
        404
      );
    } catch (err) {
      console.error(JSON.stringify({ err: String(err), path }));
      return json({ error: "Internal error" }, 500);
    }
  },
};
