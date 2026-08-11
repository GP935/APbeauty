import express from 'express';
import crypto from 'crypto';
import Stripe from 'stripe';

const {
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
  MP_ACCESS_TOKEN,
  MP_WEBHOOK_SECRET,
  PUBLIC_BASE_URL = 'https://apbeauty.com',
  PORT = 3000,
} = process.env;

if (!STRIPE_SECRET_KEY) {
  console.error('Falta STRIPE_SECRET_KEY en el entorno. Abortando.');
  process.exit(1);
}
if (!STRIPE_WEBHOOK_SECRET) {
  // No abortamos: el server puede crear sesiones, pero el webhook rechazará
  // todo hasta configurarlo. Avisamos fuerte en el arranque.
  console.warn('AVISO: STRIPE_WEBHOOK_SECRET no configurado — el webhook rechazará eventos.');
}
if (!MP_ACCESS_TOKEN) {
  console.warn('AVISO: MP_ACCESS_TOKEN no configurado — el checkout LatAm (Mercado Pago) devolverá error.');
}
if (!MP_WEBHOOK_SECRET) {
  console.warn('AVISO: MP_WEBHOOK_SECRET no configurado — el webhook de Mercado Pago rechazará notificaciones.');
}

const stripe = new Stripe(STRIPE_SECRET_KEY);

// ─────────────────────────────────────────────────────────────
// CATÁLOGO — fuente de verdad server-side (invariante 1)
// precio en céntimos de EUR · priceId = Price de Stripe (dashboard)
// Nunca se lee el precio del body del cliente: solo id/priceId + cantidad.
// ─────────────────────────────────────────────────────────────
const CATALOGO = {
  'lip-eclipse':  { title: 'Lip Eclipse',  price: 2490, priceId: 'price_1TqB72RsF6KmY8R7jUG5QSaR' },
  'power-matte':  { title: 'Power Matte',  price: 3990, priceId: 'price_1TqB74RsF6KmY8R7B9IPDLCd' },
  'sculpt-liner': { title: 'Sculpt Liner', price: 1890, priceId: 'price_1TqB75RsF6KmY8R7b6qDipxm' },
  'power-lash':   { title: 'Power Lash',   price: 1990, priceId: 'price_1TqB7ARsF6KmY8R7maXDZ6CQ' },
};

// Índice inverso priceId → SKU, para validar lo que llega del cliente
// contra una allowlist (nunca confiamos en un priceId arbitrario).
const PRICE_ID_INDEX = new Map(
  Object.entries(CATALOGO).map(([id, p]) => [p.priceId, { id, ...p }]),
);

// ─────────────────────────────────────────────────────────────
// CATÁLOGO_MP — Fase 2 (LatAm/Perú, PEN). Mismos SKUs que CATALOGO,
// precio en soles (unidad entera, no céntimos: la API de MP usa
// transaction_amount en la unidad mayor de la moneda).
// PENDIENTE (bloquea producción): conversión EUR→PEN aproximada
// (tasa ~3.90, 2026-08-10) redondeada a dígito final 0/5/7/9 por
// decisión del usuario. Confirmar precios PEN reales antes de lanzar.
// ─────────────────────────────────────────────────────────────
const CATALOGO_MP = {
  'lip-eclipse':  { title: 'Lip Eclipse',  price: 97 },
  'power-matte':  { title: 'Power Matte',  price: 155 },
  'sculpt-liner': { title: 'Sculpt Liner', price: 75 },
  'power-lash':   { title: 'Power Lash',   price: 77 },
};

// ─────────────────────────────────────────────────────────────
// Almacén de pedidos — Map en memoria (idempotencia + verificación importe).
// DEUDA CONOCIDA: en memoria por proceso → con PM2 cluster (varias instancias)
// la idempotencia se rompe. Correr con `instances: 1` (fork) hasta migrar a
// DB/KV compartido (Redis, SQLite, Postgres). Toda la lógica de estado está
// aislada aquí para que ese cambio sea un solo punto.
// ─────────────────────────────────────────────────────────────
const pedidos = new Map();          // sessionId → { amountExpected, estado, items }
const eventosProcesados = new Set(); // event.id ya procesados

// Mismo patrón que `pedidos`/`eventosProcesados` para el flujo Mercado Pago.
// Misma deuda conocida (memoria por proceso, instances:1 hasta DB/KV).
const pedidosMP = new Map();          // orderId → { amountExpected, estado, items, paymentId }
const notificacionesMP = new Set();   // notification.id (webhook) ya procesadas

const app = express();
app.disable('x-powered-by');

// Detrás de Cloudflare → Nginx (loopback en el mismo host). Necesario para que
// req.ip sea la IP real (rate-limit) y para leer cf-ipcountry (Fase 2 geo).
app.set('trust proxy', 1);

// Cabeceras mínimas de API. Nginx/Cloudflare añaden el resto en el borde.
app.use((_req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');
  next();
});

// ─────────────────────────────────────────────────────────────
// Webhook PRIMERO con body RAW: la verificación de firma de Stripe
// necesita el cuerpo sin parsear. Debe ir antes de express.json().
// ─────────────────────────────────────────────────────────────
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  // Invariante 2 — validar firma ANTES de tocar ningún dato del pedido.
  // stripe.webhooks.constructEvent hace HMAC-SHA256 + comparación en
  // tiempo constante internamente (equivalente a timingSafeEqual).
  if (!STRIPE_WEBHOOK_SECRET) {
    console.error('Falta STRIPE_WEBHOOK_SECRET. Rechazando webhook.');
    return res.status(500).send('webhook no configurado');
  }

  let event;
  try {
    const firma = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(req.body, firma, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.warn('Firma de webhook inválida:', err.message);
    return res.status(400).send('firma inválida');
  }

  // Invariante 3 — idempotencia: un event.id repetido no reprocesa.
  if (eventosProcesados.has(event.id)) {
    return res.status(200).json({ received: true, duplicate: true });
  }
  eventosProcesados.add(event.id);

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const pedido = pedidos.get(session.id);

    // Invariante 4 — el importe cobrado debe coincidir con el calculado
    // en servidor. amount_total viene en céntimos enteros (tolerancia 0).
    const esperado = pedido ? pedido.amountExpected : null;
    if (esperado !== null && session.amount_total !== esperado) {
      console.error(
        `IMPORTE NO COINCIDE session=${session.id} ` +
        `esperado=${esperado} cobrado=${session.amount_total}. Pedido NO confirmado.`,
      );
      return res.status(200).json({ received: true, mismatch: true });
    }

    // Invariante 5 — la confirmación del pedido ocurre SOLO aquí (webhook),
    // nunca desde la success_url / redirect.
    if (pedido) {
      pedido.estado = 'pagado';
      pedido.paidAt = new Date().toISOString();
      pedidos.set(session.id, pedido);
    }
    console.log(`Pedido confirmado (pagado): ${session.id}`);
  }

  // Ack rápido para que Stripe no reintente.
  return res.status(200).json({ received: true });
});

// A partir de aquí, JSON normal (con límite de tamaño anti-abuso) para el resto.
app.use(express.json({ limit: '10kb' }));

// ─────────────────────────────────────────────────────────────
// Rate limiter simple — ventana fija en memoria, sin dependencias.
// (Suficiente con instances:1. Cloudflare añade otra capa en el borde.)
// ─────────────────────────────────────────────────────────────
function rateLimit({ windowMs, max }) {
  const hits = new Map(); // ip → { count, reset }
  return (req, res, next) => {
    const now = Date.now();
    const ip = req.ip || 'desconocida';
    const e = hits.get(ip);
    if (!e || now > e.reset) {
      hits.set(ip, { count: 1, reset: now + windowMs });
      return next();
    }
    if (e.count >= max) {
      return res.status(429).json({ error: 'demasiadas peticiones, prueba en un momento' });
    }
    e.count += 1;
    return next();
  };
}
const checkoutLimiter = rateLimit({ windowMs: 60_000, max: 20 });

// Fase 2 (geo-ruteo) — Cloudflare inyecta el país en cf-ipcountry.
// Alcance AP-B5 (decisión usuario 2026-08-10): SOLO Perú → Mercado Pago.
// Cualquier otro país no-UE sigue sin resolver (501) hasta definirse.
function pasarelaPara(pais) {
  if (pais === 'PE') return 'mercadopago';
  return 'stripe';
}

// ─────────────────────────────────────────────────────────────
// POST /api/create-checkout-session
// Body: { items: [{ price, quantity }] }   (price = priceId de Stripe)
// Respuesta: { url }  → el cliente hace window.location = url
// ─────────────────────────────────────────────────────────────
app.post('/api/create-checkout-session', checkoutLimiter, async (req, res) => {
  try {
    const { items } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'carrito vacío o inválido' });
    }

    const pais = req.headers['cf-ipcountry'] || 'XX';
    const pasarela = pasarelaPara(pais); // Fase 2: enrutará a MP para LatAm
    if (pasarela !== 'stripe') {
      return res.status(501).json({ error: 'pasarela no disponible para tu región todavía' });
    }

    const lineItems = [];
    let amountExpected = 0;
    const resumen = [];

    for (const item of items) {
      const cantidad = Number.parseInt(item?.quantity, 10);
      if (!Number.isInteger(cantidad) || cantidad < 1 || cantidad > 99) {
        return res.status(400).json({ error: `cantidad inválida para ${item?.price}` });
      }

      // Solo aceptamos priceIds que estén en nuestro CATÁLOGO (allowlist).
      const producto = PRICE_ID_INDEX.get(item?.price);
      if (!producto) {
        return res.status(400).json({ error: `producto no reconocido: ${item?.price}` });
      }

      // El precio efectivo lo resuelve Stripe desde el Price del dashboard;
      // aquí solo pasamos el priceId validado + la cantidad.
      lineItems.push({ price: producto.priceId, quantity: cantidad });
      amountExpected += producto.price * cantidad; // para verificar en el webhook
      resumen.push({ id: producto.id, cantidad });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: lineItems,
      success_url: `${PUBLIC_BASE_URL}/confirmacion.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${PUBLIC_BASE_URL}/carrito.html`,
    });

    pedidos.set(session.id, { amountExpected, estado: 'pendiente', items: resumen });

    return res.json({ url: session.url });
  } catch (err) {
    console.error('Error creando checkout session:', err.message);
    return res.status(500).json({ error: 'no se pudo iniciar el pago' });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/market — fuente única del router dual-market (evita que
// front duplique la lógica de pasarelaPara en JS de cliente).
// Respuesta: { country, gateway, currency }
// ─────────────────────────────────────────────────────────────
app.get('/api/market', (req, res) => {
  const pais = req.headers['cf-ipcountry'] || 'XX';
  const gateway = pasarelaPara(pais);
  const currency = gateway === 'mercadopago' ? 'PEN' : 'EUR';
  return res.json({ country: pais, gateway, currency });
});

const mpLimiter = rateLimit({ windowMs: 60_000, max: 20 });

// ─────────────────────────────────────────────────────────────
// POST /api/mp/create-order
// Body: { items: [{ id, quantity }] }   (id = SKU de CATALOGO_MP)
// Respuesta: { orderId, amount }  → amount alimenta initialization.amount del Brick
// Invariante 1: el precio SIEMPRE sale de CATALOGO_MP, nunca del cliente.
// ─────────────────────────────────────────────────────────────
app.post('/api/mp/create-order', mpLimiter, (req, res) => {
  const { items } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'carrito vacío o inválido' });
  }

  let amountExpected = 0;
  const resumen = [];

  for (const item of items) {
    const cantidad = Number.parseInt(item?.quantity, 10);
    if (!Number.isInteger(cantidad) || cantidad < 1 || cantidad > 99) {
      return res.status(400).json({ error: `cantidad inválida para ${item?.id}` });
    }

    // Allowlist — solo SKUs que existen en CATALOGO_MP.
    const producto = CATALOGO_MP[item?.id];
    if (!producto) {
      return res.status(400).json({ error: `producto no reconocido: ${item?.id}` });
    }

    amountExpected += producto.price * cantidad;
    resumen.push({ id: item.id, cantidad });
  }

  const orderId = crypto.randomUUID();
  pedidosMP.set(orderId, { amountExpected, estado: 'pendiente', items: resumen, paymentId: null });

  return res.json({ orderId, amount: amountExpected });
});

// ─────────────────────────────────────────────────────────────
// POST /api/mp/process-payment — callback onSubmit del Card Payment Brick.
// Body: { orderId, token, issuer_id, payment_method_id, payer: { email } }
// Respuesta: { status, id }
//
// Invariante 1: transaction_amount SIEMPRE sale de pedidosMP (orderId), nunca
// del cardFormData del cliente — el Brick lo manda pero lo ignoramos.
// Sin cuotas (decisión usuario 2026-08-10): installments fijo a 1, se ignora
// cualquier valor que mande el cliente.
// Nota invariante 5: esta llamada es servidor→servidor contra la API de MP
// (no un redirect/return URL del navegador), así que un status "approved" en
// la respuesta directa SÍ es fuente fiable para marcar el pedido pagado. El
// webhook cubre el caso "in_process" (confirmación bancaria diferida, común
// en Perú) y actúa como red de seguridad/reconciliación.
// ─────────────────────────────────────────────────────────────
app.post('/api/mp/process-payment', mpLimiter, async (req, res) => {
  if (!MP_ACCESS_TOKEN) {
    return res.status(500).json({ error: 'Mercado Pago no configurado' });
  }

  try {
    const { orderId, token, issuer_id, payment_method_id, payer } = req.body || {};
    const pedido = pedidosMP.get(orderId);
    if (!pedido) {
      return res.status(400).json({ error: 'pedido no encontrado o expirado' });
    }
    if (pedido.estado !== 'pendiente') {
      return res.status(409).json({ error: 'pedido ya procesado' });
    }

    const response = await fetch('https://api.mercadopago.com/v1/payments', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
        // Idempotencia propia del orderId: si el cliente reintenta la misma
        // orden (doble click, retry de red), MP no duplica el cobro.
        'X-Idempotency-Key': orderId,
      },
      body: JSON.stringify({
        token,
        issuer_id,
        payment_method_id,
        installments: 1,
        transaction_amount: pedido.amountExpected,
        description: pedido.items.map((i) => `${i.id}x${i.cantidad}`).join(', '),
        external_reference: orderId, // correlación con el webhook
        payer: { email: payer?.email },
      }),
    });

    const payment = await response.json();
    if (!response.ok) {
      console.error('Error de la API de Mercado Pago:', payment);
      return res.status(502).json({ error: 'no se pudo procesar el pago' });
    }

    pedido.paymentId = payment.id;
    if (payment.status === 'approved') {
      pedido.estado = 'pagado';
      pedido.paidAt = new Date().toISOString();
    } else if (payment.status === 'in_process' || payment.status === 'pending') {
      pedido.estado = 'pendiente_confirmacion'; // el webhook resolverá
    } else {
      pedido.estado = 'rechazado';
    }
    pedidosMP.set(orderId, pedido);

    return res.json({ status: payment.status, id: payment.id });
  } catch (err) {
    console.error('Error procesando pago Mercado Pago:', err.message);
    return res.status(500).json({ error: 'no se pudo procesar el pago' });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/mp/webhook — notificación IPN de Mercado Pago.
// Invariante 2: firma x-signature (HMAC-SHA256) validada ANTES de tocar datos.
// Formato MP: header "ts=...,v1=..." + manifest "id:{data.id};request-id:{x-request-id};ts:{ts};"
// ─────────────────────────────────────────────────────────────
function firmaMPValida(req) {
  if (!MP_WEBHOOK_SECRET) return false;

  const firma = req.headers['x-signature'];
  const requestId = req.headers['x-request-id'];
  const dataId = req.query?.['data.id'] || req.body?.data?.id;
  if (!firma || !dataId) return false;

  const partes = Object.fromEntries(
    String(firma).split(',').map((p) => p.trim().split('=').map((s) => s.trim())),
  );
  const { ts, v1 } = partes;
  if (!ts || !v1) return false;

  const manifest = `id:${String(dataId).toLowerCase()};request-id:${requestId || ''};ts:${ts};`;
  const hash = crypto.createHmac('sha256', MP_WEBHOOK_SECRET).update(manifest).digest('hex');

  const a = Buffer.from(hash, 'utf8');
  const b = Buffer.from(v1, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

app.post('/api/mp/webhook', async (req, res) => {
  // Invariante 2 — validar firma ANTES de tocar ningún dato del pedido.
  if (!firmaMPValida(req)) {
    console.warn('Firma de webhook Mercado Pago inválida o ausente.');
    return res.status(400).send('firma inválida');
  }

  // Invariante 3 — idempotencia por id de notificación.
  const notifId = req.body?.id ?? `${req.query?.['data.id']}:${req.body?.action}`;
  if (notificacionesMP.has(notifId)) {
    return res.status(200).json({ received: true, duplicate: true });
  }
  notificacionesMP.add(notifId);

  const dataId = req.query?.['data.id'] || req.body?.data?.id;
  if (req.body?.type !== 'payment' || !dataId || !MP_ACCESS_TOKEN) {
    return res.status(200).json({ received: true, ignored: true });
  }

  try {
    // Nunca confiamos en el cuerpo del webhook para importe/estado: se
    // vuelve a pedir el pago completo a la API de MP con nuestro access token.
    const r = await fetch(`https://api.mercadopago.com/v1/payments/${dataId}`, {
      headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
    });
    const payment = await r.json();
    const orderId = payment.external_reference;
    const pedido = orderId ? pedidosMP.get(orderId) : null;

    if (pedido) {
      // Invariante 4 — importe cobrado vs calculado en servidor (PEN, tolerancia 0.01).
      const diff = Math.abs(payment.transaction_amount - pedido.amountExpected);
      if (diff > 0.01) {
        console.error(
          `IMPORTE NO COINCIDE orderId=${orderId} esperado=${pedido.amountExpected} ` +
          `cobrado=${payment.transaction_amount}. Pedido NO confirmado.`,
        );
        return res.status(200).json({ received: true, mismatch: true });
      }

      pedido.paymentId = payment.id;
      if (payment.status === 'approved') {
        pedido.estado = 'pagado';
        pedido.paidAt = new Date().toISOString();
      } else if (payment.status === 'rejected' || payment.status === 'cancelled') {
        pedido.estado = 'rechazado';
      }
      pedidosMP.set(orderId, pedido);
      console.log(`Webhook MP: pedido ${orderId} → ${pedido.estado} (payment ${payment.id})`);
    }
  } catch (err) {
    console.error('Error consultando pago en webhook MP:', err.message);
  }

  return res.status(200).json({ received: true });
});

app.get('/health', (_req, res) => res.json({ ok: true }));

const server = app.listen(PORT, () => console.log(`AP Beauty backend (Stripe) escuchando en :${PORT}`));

// Apagado limpio para reloads de PM2 sin cortar peticiones en curso.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`${sig} recibido, cerrando servidor...`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
