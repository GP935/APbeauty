// Test de integración — stock en vivo / "Agotado" (AB-B10).
// Server real con MP y Resend mockeados vía globalThis.fetch; logs y stock en un tmp aislado.
//   node server/_test_stock.mjs
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = await mkdtemp(join(tmpdir(), 'apb-stock-'));
const STOCK = join(tmp, 'stock.json');
await writeFile(STOCK, JSON.stringify({
  base: null,
  stock_inicial: {
    'tiras-vertigo': 1, 'tiras-velada': 2, 'tiras-hechizo': 20, 'tiras-destellos': 1, 'individuales-anhelada': 3,
  },
}));
// Compra de prueba ANTERIOR a la base: no debe descontar.
await writeFile(join(tmp, 'purchases.jsonl'), `${JSON.stringify({
  ts: '2020-01-01T00:00:00.000Z', order_id: 'viejo', payment_id: 'old-1',
  items: [{ sku: 'tiras-velada', quantity: 5 }],
})}\n`);

process.env.CHECKOUT_GATEWAY = 'mercadopago';
process.env.MP_ACCESS_TOKEN = 'TEST-fake-token';
process.env.MP_WEBHOOK_SECRET = 'x';
process.env.RESEND_API_KEY = 're_fake';
process.env.RESEND_FROM = 'AP <a@b.c>';
process.env.VENTAS_EMAIL_INTERNO = 'ventas@b.c';
process.env.MP_RATE_LIMIT = '1000';
process.env.LOGS_DIR = tmp;
process.env.STOCK_FILE = STOCK;

const realFetch = globalThis.fetch.bind(globalThis);
let mpCalls = 0;
let nextId = 1000;
let forceId = null;
let mpStatus = 'approved';
let mpDelay = 0;
const correos = [];

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith('http://127.0.0.1')) return realFetch(url, opts);
  if (u.includes('api.mercadopago.com/v1/payments')) {
    mpCalls += 1;
    if (mpDelay) await new Promise((r) => setTimeout(r, mpDelay));
    return new Response(JSON.stringify({
      id: forceId ?? nextId++, status: mpStatus, date_approved: new Date().toISOString(),
      payer: { email: 't@e.com' },
    }), { status: 200 });
  }
  if (u.includes('api.resend.com')) { correos.push(JSON.parse(opts.body)); return new Response('{"id":"e"}', { status: 200 }); }
  throw new Error(`fetch no mockeado: ${u}`);
};

let n = 0;
async function arrancar(port) {
  process.env.PORT = String(port);
  await import(`./server.js?inst=${port}`);
  await new Promise((r) => setTimeout(r, 400));
  return `http://127.0.0.1:${port}`;
}
let BASE = await arrancar(3481);

const post = async (path, body) => {
  const r = await realFetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const getStock = async () => {
  const r = await realFetch(`${BASE}/api/stock`);
  return { status: r.status, cache: r.headers.get('cache-control'), body: await r.json() };
};
const orden = (id, quantity) => post('/api/mp/create-order', { items: [{ id, quantity }] });
const pagar = (orderId) => post('/api/mp/process-payment', { orderId, token: 't', issuer_id: '1', payment_method_id: 'visa', payer: { email: 't@e.com' } });
const esperar = (ms = 150) => new Promise((r) => setTimeout(r, ms));
const check = (nombre, fn) => { fn(); n += 1; console.log(`  ok ${n} — ${nombre}`); };

const cfg0 = JSON.parse(await readFile(STOCK, 'utf8'));
check('base nula se estampa y persiste en stock.json', () => assert.ok(Date.parse(cfg0.base) > 0));

let s = await getStock();
check('GET /api/stock: no-store', () => assert.match(s.cache, /no-store/));
check('la compra anterior a la base se ignora (velada=2)', () => assert.deepEqual(s.body['tiras-velada'], { disponible: 2, agotado: false }));
check('vértigo=1 disponible', () => assert.deepEqual(s.body['tiras-vertigo'], { disponible: 1, agotado: false }));

for (const q of [0, -1, 1.5, '2.5', 'abc', null]) {
  const r0 = await orden('tiras-hechizo', q);
  check(`cantidad inválida ${JSON.stringify(q)} → 400`, () => assert.equal(r0.status, 400));
}
let r = await orden('tiras-velada', 3);
check('cantidad > stock → 409 con mensaje y stock', () => {
  assert.equal(r.status, 409);
  assert.match(r.body.error, /solo quedan 2/);
  assert.equal(r.body.stock[0].disponible, 2);
});

// última unidad
r = await orden('tiras-vertigo', 1);
const ordUltima = r.body.orderId;
mpCalls = 0;
r = await pagar(ordUltima);
check('compra de la última unidad se aprueba', () => { assert.equal(r.body.status, 'approved'); assert.equal(mpCalls, 1); });
await esperar();
s = await getStock();
check('vértigo queda agotado', () => assert.deepEqual(s.body['tiras-vertigo'], { disponible: 0, agotado: true }));
r = await orden('tiras-vertigo', 1);
check('create-order de producto agotado → 409', () => { assert.equal(r.status, 409); assert.match(r.body.error, /agotado/); });

// segunda compra: orden creada ANTES de agotarse, pagada DESPUÉS → 409 sin llamar a MP
const a = await orden('tiras-velada', 2);
const b = await orden('tiras-velada', 2);
await pagar(a.body.orderId);
await esperar();
mpCalls = 0;
r = await pagar(b.body.orderId);
check('segunda compra de lo agotado → 409 SIN llamar a MP', () => { assert.equal(r.status, 409); assert.equal(mpCalls, 0); });

// mismo payment_id repetido (concurrente)
forceId = 555;
const h1 = await orden('tiras-hechizo', 1);
const h2 = await orden('tiras-hechizo', 1);
await Promise.all([pagar(h1.body.orderId), pagar(h2.body.orderId)]);
await esperar(300);
forceId = null;
s = await getStock();
check('mismo payment_id (concurrente) descuenta UNA vez (hechizo=19)', () => assert.equal(s.body['tiras-hechizo'].disponible, 19));
const lineas = (await readFile(join(tmp, 'purchases.jsonl'), 'utf8')).trim().split('\n').filter((l) => l.includes('"555"'));
check('y se registra UNA sola línea de compra', () => assert.equal(lineas.length, 1));

// in_process no descuenta
mpStatus = 'in_process';
r = await orden('individuales-anhelada-M', 2);
const rp = await pagar(r.body.orderId);
mpStatus = 'approved';
await esperar();
s = await getStock();
check('in_process no descuenta (anhelada=3)', () => {
  assert.equal(rp.body.status, 'in_process');
  assert.equal(s.body['individuales-anhelada'].disponible, 3);
});
r = await orden('individuales-anhelada-S', 2);
await pagar(r.body.orderId);
await esperar();
s = await getStock();
check('tallas del mismo diseño comparten stock (3-2=1)', () => assert.equal(s.body['individuales-anhelada'].disponible, 1));

// sobreventa: dos pagos concurrentes por la última unidad
mpDelay = 80;
correos.length = 0;
const o1 = await orden('tiras-destellos', 1);
const o2 = await orden('tiras-destellos', 1);
const [p1, p2] = await Promise.all([pagar(o1.body.orderId), pagar(o2.body.orderId)]);
await esperar(400);
mpDelay = 0;
check('sobreventa: ambos pagos se aprueban (no se bloquea el registro)', () => {
  assert.equal(p1.body.status, 'approved');
  assert.equal(p2.body.status, 'approved');
});
check('correo interno "SOBREVENTA - revisar/reembolsar"', () => assert.ok(correos.some((c) => c.subject === 'SOBREVENTA - revisar/reembolsar')));
s = await getStock();
check('destellos se muestra agotado (0, nunca negativo)', () => assert.deepEqual(s.body['tiras-destellos'], { disponible: 0, agotado: true }));

// reload: nueva instancia sobre los mismos archivos
const antes = (await getStock()).body;
BASE = await arrancar(3482);
const despues = (await getStock()).body;
check('tras reload el stock se conserva', () => assert.deepEqual(despues, antes));
forceId = 555;
r = await orden('tiras-hechizo', 1);
await pagar(r.body.orderId);
await esperar(300);
forceId = null;
s = await getStock();
check('tras reload, pago repetido (id 555) no vuelve a descontar (hechizo=19)', () => assert.equal(s.body['tiras-hechizo'].disponible, 19));

console.log(`\n${n}/${n} PASS`);
process.exit(0);
