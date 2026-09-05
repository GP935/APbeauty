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
  // Interruptor único de pasarela (Paul, 2026-09-05). Valores:
  //   'none'        → no hay pago vivo; /api/create-checkout-session responde 503.
  //   'stripe'      → Stripe Checkout hosted (requiere Price IDs REALES en PEN).
  //   'mercadopago' → Card Payment Brick (requiere MP_ACCESS_TOKEN válido).
  // AP Beauty opera solo en Perú y en soles (PEN); no hay ruteo geográfico.
  CHECKOUT_GATEWAY = 'none',
} = process.env;

const GATEWAY = ['none', 'stripe', 'mercadopago'].includes(CHECKOUT_GATEWAY)
  ? CHECKOUT_GATEWAY
  : 'none';

if (!STRIPE_SECRET_KEY) {
  // Stripe está dormido por defecto (CHECKOUT_GATEWAY=none): no abortamos por
  // falta de clave, solo si se pide explícitamente usar Stripe sin configurarlo.
  if (GATEWAY === 'stripe') {
    console.error('CHECKOUT_GATEWAY=stripe pero falta STRIPE_SECRET_KEY. Abortando.');
    process.exit(1);
  }
  console.warn('AVISO: STRIPE_SECRET_KEY no configurado — Stripe dormido.');
}
if (!STRIPE_WEBHOOK_SECRET) {
  // No abortamos: el server puede crear sesiones, pero el webhook rechazará
  // todo hasta configurarlo. Avisamos fuerte en el arranque.
  console.warn('AVISO: STRIPE_WEBHOOK_SECRET no configurado — el webhook rechazará eventos.');
}
console.log(`Pasarela activa (CHECKOUT_GATEWAY): ${GATEWAY}`);
if (!MP_ACCESS_TOKEN) {
  console.warn('AVISO: MP_ACCESS_TOKEN no configurado — el checkout LatAm (Mercado Pago) devolverá error.');
}
if (!MP_WEBHOOK_SECRET) {
  console.warn('AVISO: MP_WEBHOOK_SECRET no configurado — el webhook de Mercado Pago rechazará notificaciones.');
}

// `null` si Stripe está dormido y sin clave — las rutas Stripe lo comprueban.
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

// ─────────────────────────────────────────────────────────────
// CATÁLOGO — fuente de verdad server-side, MONEDA ÚNICA: PEN (Paul, 2026-09-05).
// `price` = céntimos de sol (S/ 35,00 → 3500), coincide 1:1 con el `data-price`
// del frontend (catalogo.html / index.html). La API de Mercado Pago usa la
// unidad mayor → se divide entre 100 al construir transaction_amount.
// `priceId` = Price de Stripe CREADO EN PEN. Stripe está DORMIDO: mientras el
// valor empiece por `TODO_` la ruta de checkout Stripe responde 503.
// Nunca se lee el precio del body del cliente: solo id/priceId + cantidad.
//
// SKUs = líneas de pestañas (único catálogo comprable hoy; AB-F22/AB-F30).
// La talla (S/M/L/única) es metadata y NO cambia el precio → 1 SKU por diseño.
// ─────────────────────────────────────────────────────────────
const CATALOGO = {
  // Línea Individuales — 5 diseños, S/ 25–40
  'individuales-esencial':  { title: 'Individuales · Esencial',  price: 2500, priceId: 'TODO_STRIPE_PRICE_ID_ESENCIAL' },
  'individuales-iconica':   { title: 'Individuales · Icónica',   price: 3500, priceId: 'TODO_STRIPE_PRICE_ID_ICONICA' },
  'individuales-despierta': { title: 'Individuales · Despierta', price: 3000, priceId: 'TODO_STRIPE_PRICE_ID_DESPIERTA' },
  'individuales-suspiro':   { title: 'Individuales · Suspiro',   price: 2500, priceId: 'TODO_STRIPE_PRICE_ID_SUSPIRO' },
  'individuales-anhelada':  { title: 'Individuales · Anhelada',  price: 4000, priceId: 'TODO_STRIPE_PRICE_ID_ANHELADA' },
  // Línea Tiras — 4 diseños, todas S/ 10, todas talla única
  'tiras-destellos': { title: 'Tiras · Destellos', price: 1000, priceId: 'TODO_STRIPE_PRICE_ID_DESTELLOS' },
  'tiras-hechizo':   { title: 'Tiras · Hechizo',   price: 1000, priceId: 'TODO_STRIPE_PRICE_ID_HECHIZO' },
  'tiras-velada':    { title: 'Tiras · Velada',    price: 1000, priceId: 'TODO_STRIPE_PRICE_ID_VELADA' },
  'tiras-vertigo':   { title: 'Tiras · Vértigo',   price: 1000, priceId: 'TODO_STRIPE_PRICE_ID_VERTIGO' },
};

const MONEDA = 'PEN';

// Un priceId sigue sin configurar (placeholder del HTML) mientras empiece así.
const esPlaceholder = (priceId) => !priceId || String(priceId).startsWith('TODO_');

// El frontend manda el id de carrito con la talla al final
// (`individuales-iconica-M`, `tiras-destellos-unica`). El precio es por diseño,
// así que se recorta el sufijo de talla para resolver el SKU del catálogo.
const skuBase = (id) => String(id || '').replace(/-(S|M|L|unica)$/i, '');

// Índice inverso priceId → SKU, para validar lo que llega del cliente
// contra una allowlist (nunca confiamos en un priceId arbitrario).
const PRICE_ID_INDEX = new Map(
  Object.entries(CATALOGO).map(([id, p]) => [p.priceId, { id, ...p }]),
);

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
  if (!STRIPE_WEBHOOK_SECRET || !stripe) {
    console.error('Stripe no configurado (clave o webhook secret). Rechazando webhook.');
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

// ─────────────────────────────────────────────────────────────
// POST /api/create-checkout-session
// Body: { items: [{ price, quantity }] }   (price = priceId de Stripe)
// Respuesta: { url }  → el cliente hace window.location = url
// Stripe DORMIDO por defecto: 503 mientras CHECKOUT_GATEWAY !== 'stripe' o
// cualquier priceId siga siendo placeholder (TODO_...).
// ─────────────────────────────────────────────────────────────
app.post('/api/create-checkout-session', checkoutLimiter, async (req, res) => {
  try {
    if (GATEWAY !== 'stripe' || !stripe) {
      return res.status(503).json({ error: 'checkout no disponible todavía' });
    }

    const { items } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'carrito vacío o inválido' });
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

      // El SKU existe pero su Price de Stripe (PEN) aún no está creado.
      if (esPlaceholder(producto.priceId)) {
        console.warn(`checkout bloqueado: falta Price ID real de Stripe para ${producto.id}`);
        return res.status(503).json({ error: 'checkout no disponible todavía' });
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
// GET /api/market — fuente única de pasarela/moneda para el frontend
// (evita duplicar la lógica en JS de cliente).
// AP Beauty: moneda única PEN, sin ruteo geográfico. `gateway` sale del
// interruptor CHECKOUT_GATEWAY: 'none' (default) → el frontend deja
// #btn-checkout inerte / en "próximamente".
// Respuesta: { country, gateway, currency }
// ─────────────────────────────────────────────────────────────
app.get('/api/market', (req, res) => {
  const pais = req.headers['cf-ipcountry'] || 'XX';
  return res.json({ country: pais, gateway: GATEWAY, currency: MONEDA });
});

const mpLimiter = rateLimit({ windowMs: 60_000, max: 20 });

// ─────────────────────────────────────────────────────────────
// POST /api/mp/create-order
// Body: { items: [{ id, quantity }] }   (id = id de carrito, con talla al final)
// Respuesta: { orderId, amount }  → amount (SOLES) alimenta initialization.amount del Brick
// Invariante 1: el precio SIEMPRE sale de CATALOGO, nunca del cliente.
// CATALOGO.price está en céntimos de sol → /100 para la unidad mayor que usa MP.
// ─────────────────────────────────────────────────────────────
app.post('/api/mp/create-order', mpLimiter, (req, res) => {
  if (GATEWAY !== 'mercadopago') {
    return res.status(503).json({ error: 'checkout no disponible todavía' });
  }

  const { items } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'carrito vacío o inválido' });
  }

  let amountExpected = 0; // en soles (unidad mayor), como espera la API de MP
  const resumen = [];

  for (const item of items) {
    const cantidad = Number.parseInt(item?.quantity, 10);
    if (!Number.isInteger(cantidad) || cantidad < 1 || cantidad > 99) {
      return res.status(400).json({ error: `cantidad inválida para ${item?.id}` });
    }

    // Allowlist — resolver el SKU del catálogo recortando el sufijo de talla.
    const producto = CATALOGO[skuBase(item?.id)];
    if (!producto) {
      return res.status(400).json({ error: `producto no reconocido: ${item?.id}` });
    }

    amountExpected += (producto.price / 100) * cantidad;
    resumen.push({ id: item.id, cantidad });
  }

  amountExpected = Math.round(amountExpected * 100) / 100; // 2 decimales, sin artefactos float

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
  if (GATEWAY !== 'mercadopago' || !MP_ACCESS_TOKEN) {
    return res.status(503).json({ error: 'checkout no disponible todavía' });
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
        payer: {
          email: payer?.email,
          // Perú (MPE): MP suele exigir identificación (DNI) para aprobar.
          // El Brick la recoge; se reenvía si el frontend la manda (no la fabricamos).
          ...(payer?.identification?.number
            ? { identification: { type: payer.identification.type || 'DNI', number: String(payer.identification.number) } }
            : {}),
        },
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

const server = app.listen(PORT, () => console.log(`AP Beauty backend escuchando en :${PORT} · moneda ${MONEDA} · pasarela ${GATEWAY}`));

// Apagado limpio para reloads de PM2 sin cortar peticiones en curso.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`${sig} recibido, cerrando servidor...`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
