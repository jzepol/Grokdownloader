# Worker OPCIONAL (Lemon Squeezy)

**No hace falta este Worker** para el flujo freemium normal.

La extensión llama directo a:

- `POST https://api.lemonsqueezy.com/v1/licenses/activate`
- `POST https://api.lemonsqueezy.com/v1/licenses/validate`

Esos endpoints son públicos (sin API key) y Chrome con `host_permissions`
evita CORS. Lemon Squeezy genera y muestra la license key en el checkout.

## ¿Cuándo sí desplegarlo?

| Caso | Endpoint |
|------|----------|
| Guardar emails / órdenes en KV | `POST /webhook` |
| Proxy si algún día no pudieras pegarle a LS desde la extensión | `/proxy/activate`, `/proxy/validate` |

## Deploy (solo si lo necesitás)

```bash
cd worker
npm install
npx wrangler login
# opcional: KV
npx wrangler kv namespace create LICENSES
# pegá el id en wrangler.toml

npx wrangler secret put LEMONSQUEEZY_WEBHOOK_SECRET
npx wrangler deploy
```

En Lemon Squeezy → Settings → Webhooks:

- URL: `https://TU-WORKER.workers.dev/webhook`
- Secret: el mismo que pusiste en `LEMONSQUEEZY_WEBHOOK_SECRET`
- Eventos sugeridos: `order_created`, `license_key_created`

## Firma

Lemon Squeezy envía `X-Signature` = HMAC-SHA256 hex del raw body con tu secret.
