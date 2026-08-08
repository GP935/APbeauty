# Deploy AP Beauty — VPS + Nginx + PM2 + Cloudflare

Runbook para poner la tienda en producción. Redactado por backend, revisado y
adoptado por devops (2026-07-15). Los pasos de servidor (SSH, certbot, PM2)
los ejecuta el humano.

Arquitectura: **Cloudflare** (DNS/SSL/CDN) → **Nginx** (VPS) → estático + `/api/` a **Node/PM2** (:3000).

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
- `STRIPE_SECRET_KEY` — `sk_live_...` (o `sk_test_...` para probar).
- `STRIPE_WEBHOOK_SECRET` — el del endpoint de producción (paso 5).
- `PUBLIC_BASE_URL=https://apbeauty.com`
- `PORT=3000`
> `server/.env` está en `.gitignore` — nunca se sube al repo.

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

## 6. Webhook de Stripe (producción)
- Dashboard Stripe → Developers → Webhooks → **Add endpoint**:
  - URL: `https://apbeauty.com/api/stripe/webhook`
  - Evento: `checkout.session.completed`
- Copia el **Signing secret** (`whsec_...`) → `STRIPE_WEBHOOK_SECRET` en `server/.env`.
- `pm2 reload apbeauty-backend` para recargar el env.

## 7. Comprobaciones (go-live)
```bash
# Desde el VPS (directo a Node, sin pasar por Nginx/Cloudflare):
curl -s http://127.0.0.1:3000/health
# Desde fuera (Nginx proxya /health a Node — cadena completa):
curl -s https://apbeauty.com/health
```
- Añadir producto → carrito → **Finalizar compra** → redirige a Stripe.
- Pagar con tarjeta real (o test `4242 4242 4242 4242` en modo test).
- En Stripe → Webhooks: la entrega marca **200**; en logs PM2
  (`pm2 logs apbeauty-backend`) aparece `Pedido confirmado (pagado): cs_...`.

## 8. Despliegues siguientes
```bash
cd /var/www/apbeauty && ./scripts/deploy.sh
```

---

## Cambiar de TEST a REAL — checklist
- [ ] `STRIPE_SECRET_KEY` → `sk_live_...`
- [ ] `priceId` del `CATALOGO` (server.js) = Prices **live** (los actuales son de test)
- [ ] `data-priceid` del frontend = los mismos Prices live
- [ ] Webhook de producción creado → `STRIPE_WEBHOOK_SECRET` live en `.env`
- [ ] (Recomendado) usar **restricted key** en vez de la secret completa
      (scope: Checkout Sessions=write, Prices=read)
- [ ] `pm2 reload` tras cada cambio de `.env`
