import express from 'express';
import Stripe from 'stripe';

const {
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
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
// Almacén de pedidos — Map en memoria (idempotencia + verificación importe).
// DEUDA CONOCIDA: en memoria por proceso → con PM2 cluster (varias instancias)
// la idempotencia se rompe. Correr con `instances: 1` (fork) hasta migrar a
// DB/KV compartido (Redis, SQLite, Postgres). Toda la lógica de estado está
// aislada aquí para que ese cambio sea un solo punto.
// ─────────────────────────────────────────────────────────────
const pedidos = new Map();          // sessionId → { amountExpected, estado, items }
const eventosProcesados = new Set(); // event.id ya procesados

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
// Hoy todo va a Stripe (España/UE, EUR). LatAm → Mercado Pago pendiente (AP-B5).
function pasarelaPara(_pais) {
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
