# Grok Imagine Downloader

Extensión para Chrome/Edge (Manifest V3) que detecta y descarga videos e imágenes
generados en **grok.com/imagine**. Selección múltiple, descarga en lote, panel
con miniaturas.

**No afiliada a xAI.**

| Plan | Imágenes | Videos | Precio |
|------|----------|--------|--------|
| Free | 5 de por vida | 5 de por vida | $0 |
| PRO  | Ilimitadas | Ilimitados | **$5 pago único** (Lemon Squeezy) |

**Dónde funciona:** `/imagine/saved` y `/imagine/post/…`  
(En el home `/imagine` no lista las muestras de marketing de Grok.)

## Estructura

```
├── manifest.json
├── license.js          # Freemium + Lemon Squeezy activate/validate
├── background.js       # downloads + badge PRO + inyección
├── content.js          # Panel, paywall, upsell, thumbs
├── inject.js           # Hook fetch/XHR (MAIN world)
├── panel.css / popup.*
├── icons/
└── worker/             # OPCIONAL (webhooks) — no requerido
```

## Instalación (desarrollo)

1. `chrome://extensions` → Modo desarrollador.
2. **Cargar descomprimida** → esta carpeta.
3. Abrí `https://grok.com/imagine/saved` o un post y usá el botón **Media**.

Key de prueba (solo si el checkout en `license.js` aún es placeholder):

```
TEST-TEST-TEST-TEST
```

## Lemon Squeezy (PRO)

1. Producto **$5** single payment + **Generate license keys ON**.
2. Activation limit **3–5**.
3. En `license.js`:

```js
const LEMONSQUEEZY_CHECKOUT_URL =
  "https://TU-TIENDA.lemonsqueezy.com/checkout/buy/VARIANT_ID";
// Recomendado en producción:
const LEMONSQUEEZY_PRODUCT_ID = 12345;
const LEMONSQUEEZY_STORE_ID = 67890;
```

Flujo: usuario paga → copia la license key (UUID) → la pega en el panel → Activar.  
La extensión valida con la License API pública de LS (sin API key tuya en el código).

## Compliance

- Checkout externo vs política de Payments de Chrome Web Store.
- Scraping/inject en grok.com vs ToS de xAI.
- Trademark “Grok” en el nombre.
- Privacy policy si procesás datos de compradores.
