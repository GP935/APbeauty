# Deploy AP Beauty — VPS + Nginx + PM2 + Cloudflare

Runbook para poner la tienda en producción. Redactado por backend, revisado y
adoptado por devops (2026-07-15; sección Mercado Pago 2026-08-10; reescrito a
moneda única + pasarela única 2026-09-05, AB-B2/AP-B5). Los pasos de servidor
(SSH, certbot, PM2) los ejecuta el humano.

Arquitectura: **Cloudflare** (DNS/SSL/CDN) → **Nginx** (VPS) → estático + `/api/` a **Node/PM2** (:3000).

**Pasarela (2026-09-05):** moneda **única PEN** (soles), negocio solo Perú, sin
ruteo geográfico. Interruptor `CHECKOUT_GATEWAY` (`none` | `stripe` |
`mercadopago`, default `none`). Pasarela elegida = **Mercado Pago** Card Payment
Brick, **embebido** en la propia página (sin redirect a mercadopago.com).
Stripe queda en el código pero **dormido**. El frontend lee la pasarela activa
de `GET /api/market` → `{ country, gateway, currency:"PEN" }`.

---

## 0. Requisitos en el VPS
- Node.js ≥ 20.12, `npm`, `git`, `nginx`, `pm2` (`npm i -g pm2`).
- Dominio `apbeauty.com` gestionado en Cloudflare.

## 1. Código en el VPS
```bash
sudo mkdir -p /var/www/apbeauty && sudo chown $USER /var/www/apbeauty
git clone <repo APbeauty> /var/www/apbeauty
cd /var/www/apbeauty/server
npm ci --omit=dev
```

## 2. Variables de entorno (secretos)
```bash
cp server/.env.example server/.env
nano server/.env   # rellenar con valores REALES (ver abajo)
```

`server/.env` del VPS — pasarela viva = Mercado Pago:
```
CHECKOUT_GATEWAY=mercadopago
MP_ACCESS_TOKEN=<Access Token APP_USR-... de PRODUCCIÓN — cópialo del .env local o pídeselo a Paul>
MP_WEBHOOK_SECRET=<lo genera Paul al crear el endpoint de notificaciones — paso 6bis>
PUBLIC_BASE_URL=https://<dominio real>
PORT=3000
```

| Variable | Valor | Notas |
|----------|-------|-------|
| `CHECKOUT_GATEWAY` | `mercadopago` | `none` = checkout apagado (503 limpio); `stripe` = dormido; `mercadopago` = activo. Con `none` el server **no aborta** aunque falten claves Stripe. |
| `MP_ACCESS_TOKEN` | `APP_USR-...` (producción) | Secreto, backend only. NUNCA `APP_USR-TEST-...` (prefijo compuesto inválido). Distinto de `MP_PUBLIC_KEY`. |
| `MP_WEBHOOK_SECRET` | firma del webhook MP | Paso 6bis. Sin él: los pagos `approved` inmediatos se confirman igual (respuesta directa de la API); solo se pierde la reconciliación de `in_process`. |
| `PUBLIC_BASE_URL` | `https://<dominio>` | Sin barra final. |
| `PORT` | `3000` | Nginx hace reverse proxy aquí. |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | **vacías** | Stripe dormido. Solo hacen falta si `CHECKOUT_GATEWAY=stripe`. |

> `server/.env` está en `.gitignore` — nunca se sube al repo (verificado `git check-ignore`).
> `MP_PUBLIC_KEY` de producción va en `main.js` del **frontend** (pública, la pone js — AP-J2), no en este `.env`.

## 3. PM2 (backend)
```bash
cd /var/www/apbeauty
pm2 start ecosystem.config.js --env production
pm2 save
pm2 startup   # sigue las instrucciones que imprime (sobrevive a reinicios)
```
Nota: corre en `instances: 1` (fork) a propósito — la idempotencia del webhook
está en memoria. No pasar a cluster sin migrar el estado a DB/KV.

## 4. Nginx
```bash
sudo cp nginx/apbeauty.conf /etc/nginx/sites-available/apbeauty.conf
sudo ln -s /etc/nginx/sites-available/apbeauty.conf /etc/nginx/sites-enabled/
# Certificado del origen (una opción):
sudo certbot --nginx -d apbeauty.com -d www.apbeauty.com
sudo nginx -t && sudo systemctl reload nginx
```

## 5. Cloudflare
- DNS: `A apbeauty.com → <IP del VPS>` (proxied, nube naranja) + `www` igual.
- SSL/TLS: modo **Full (strict)** (con cert válido en el origen).
- Regla para `/api/*`: **Cache = Bypass** y desactivar "Bot Fight Mode" ahí
  (que no interfiera con el webhook ni con la creación de sesión).

## 6. Webhook de Mercado Pago (producción) — PASARELA ACTIVA
- Dashboard Mercado Pago → **Tus integraciones** → tu aplicación → **Webhooks**
  → configurar notificaciones:
  - URL: `https://<dominio>/api/mp/webhook`
  - Evento: **`payments`**
- Copia la **Firma secreta** → `MP_WEBHOOK_SECRET` en `server/.env`.
- Completar la **dirección en el perfil MP** — hoy `billing.allow:false` code
  `address_pending` (bloquea facturación). Cuenta tipo `personal`, `site_id:MPE`.
- `pm2 reload apbeauty-backend` para recargar el env.
- El endpoint acepta `POST /api/mp/webhook?data.id=...&type=payment`; la firma
  HMAC (`x-signature` + `x-request-id` + `data.id`) la valida Node — Nginx solo
  proxya (sin rate-limit ni auth en `location /api/`, ver `nginx/apbeauty.conf`).
- Sin `MP_WEBHOOK_SECRET`: los pagos `approved` inmediatos **sí** se confirman
  (server→server en `/api/mp/process-payment`); solo se pierde la reconciliación
  de `in_process` vía webhook. → tarea de Paul: **AB-D6**.

## 6bis. CSP del Brick embebido — verificar con clic real
- El Card Payment Brick va **embebido** (sin redirect) → el CSP de
  `nginx/apbeauty.conf` incluye los orígenes de Mercado Pago
  (`sdk.mercadopago.com`, `api.mercadopago.com`, `*.mlstatic.com`,
  `www.mercadopago.com`, `www.mercadolibre.com`).
- ⚠️ **NO verificado con clic real contra este conf.** Cuando js monte el Brick
  de producción (AP-J2, desbloqueado 2026-09-05): abrir consola del navegador
  en `carrito.html` con `CHECKOUT_GATEWAY=mercadopago`, confirmar **0 CSP
  violations**, y ampliar el CSP con cualquier subdominio que falte.

## 6ter. Stripe (dormido — solo si se reactiva)
- Poner `CHECKOUT_GATEWAY=stripe` + Price IDs reales **en PEN** en el `CATALOGO`
  de `server.js` + `STRIPE_SECRET_KEY`.
- Dashboard Stripe → Developers → Webhooks → **Add endpoint**:
  URL `https://<dominio>/api/stripe/webhook`, evento `checkout.session.completed`.
- **Signing secret** (`whsec_...`) → `STRIPE_WEBHOOK_SECRET`. `pm2 reload`.
- Añadir los orígenes `js.stripe.com` / `checkout.stripe.com` / `api.stripe.com`
  al CSP de Nginx (hoy no están).

## 7. Comprobaciones (go-live)
```bash
# Desde el VPS (directo a Node, sin pasar por Nginx/Cloudflare):
curl -s http://127.0.0.1:3000/health
# Desde fuera (Nginx proxya /health a Node — cadena completa):
curl -s https://apbeauty.com/health
```
- `curl -s https://<dominio>/api/market` → `{"country":"PE","gateway":"mercadopago","currency":"PEN"}`.
- Añadir producto → `carrito.html` → aparece el **Card Payment Brick embebido**
  (no redirect). Consola del navegador: **0 CSP violations** (§6bis).
- Pagar con tarjeta real (o de prueba MP en modo test).
- En MP → Webhooks: la entrega marca **200**; en logs PM2
  (`pm2 logs apbeauty-backend`) aparece la confirmación del pago.

## 8. Despliegues siguientes
```bash
cd /var/www/apbeauty && ./scripts/deploy.sh
```

---

## Checklist go-live — Mercado Pago (pasarela activa)

- [ ] `CHECKOUT_GATEWAY=mercadopago` en `server/.env` del VPS
- [ ] `MP_ACCESS_TOKEN` → `APP_USR-...` de **producción** (Paul ya lo entregó;
      verificado contra `GET /users/me` → 200, `site_id:MPE`, `sell.allow:true`)
- [ ] `MP_PUBLIC_KEY` (frontend, `main.js`) → la pública de producción del
      **mismo** par que el access token (nunca mezclar test/prod) — tarea de js
- [ ] `data-priceid` del HTML son inertes con MP (el flujo usa `data-id` +
      `CATALOGO` server-side) — no hay Price IDs que rellenar
- [ ] `CATALOGO` de `server.js` en céntimos de sol, 1:1 con `data-price` del HTML
      (backend AB-B2; sin conversión EUR→PEN)
- [ ] Webhook MP de producción creado → `MP_WEBHOOK_SECRET` real en `.env` (§6) — **AB-D6, Paul**
- [ ] Dirección del perfil MP completada (`address_pending`) — **AB-D6, Paul**
- [ ] CSP de Nginx con orígenes MP verificados sin violations en consola (§6bis) — **js, con el Brick montado**
- [ ] Brick de producción montado en `carrito.html` (AP-J2 — js)
- [ ] `pm2 reload apbeauty-backend` tras cada cambio de `.env`

**Reactivar Stripe (opcional, hoy dormido):** ver §6ter — `CHECKOUT_GATEWAY=stripe`,
Price IDs live **en PEN**, `STRIPE_SECRET_KEY` (recomendado restricted key:
Checkout Sessions=write, Prices=read), webhook `checkout.session.completed`,
orígenes `js.stripe.com`/`checkout.stripe.com`/`api.stripe.com` en el CSP.
