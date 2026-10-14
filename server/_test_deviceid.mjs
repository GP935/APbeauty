// Test de integración — Device ID (X-meli-session-id) en POST /api/mp/process-payment (AB-B9).
// Boot del server real con la API de MP y Resend mockeadas vía globalThis.fetch.
//   node server/_test_deviceid.mjs   (desde la raíz de la landing, o desde server/)
import assert from 'node:assert/strict';

const PORT = 3477;
const BASE = `http://127.0.0.1:${PORT}`;
const realFetch = globalThis.fetch.bind(globalThis);

let lastMPRequest = null;

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith(BASE)) return realFetch(url, opts); // nuestras propias llamadas HTTP
  if (u.includes('api.mercadopago.com/v1/payments')) {
    lastMPRequest = { headers: opts.headers || {}, body: JSON.parse(opts.body || '{}') };
    return new Response(JSON.stringify({
      id: 987654321, status: 'approved', date_approved: new Date().toISOString(),
      payer: { email: 'test@example.com' }, metadata: lastMPRequest.body.metadata || {},
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (u.includes('api.resend.com')) return new Response(JSON.stringify({ id: 'email_fake' }), { status: 200 });
  throw new Error(`fetch no mockeado: ${u}`);
};

process.env.CHECKOUT_GATEWAY = 'mercadopago';
process.env.MP_ACCESS_TOKEN = 'TEST-fake-token';
process.env.MP_WEBHOOK_SECRET = 'whatever';
process.env.PORT = String(PORT);
process.env.PUBLIC_BASE_URL = BASE;

await import(new URL('./server.js', import.meta.url).href);
await new Promise((r) => setTimeout(r, 400));

const SHIPPING = {
  name: 'María Pérez López', phone: '987654321',
  address: {
    street: 'Av. Pardo', number: '123', reference: 'Dpto 4', district: 'Miraflores',
    province: 'Lima', department: 'Lima', zip: '', country: 'PE',
  },
};

async function crearOrden() {
  const r = await fetch(`${BASE}/api/mp/create-order`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ items: [{ id: 'tiras-destellos', quantity: 1 }] }),
  });
  const j = await r.json();
  assert.ok(j.orderId, `create-order sin orderId: ${JSON.stringify(j)}`);
  return j.orderId;
}

async function pagar(extra) {
  const orderId = await crearOrden();
  lastMPRequest = null;
  const r = await fetch(`${BASE}/api/mp/process-payment`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      orderId, token: 'tok', issuer_id: '1', payment_method_id: 'visa',
      payer: { email: 'test@example.com' }, shipping: SHIPPING, ...extra,
    }),
  });
  return { status: r.status, body: await r.json() };
}

const hdr = (h, name) => {
  for (const [k, v] of Object.entries(h)) if (k.toLowerCase() === name.toLowerCase()) return v;
  return undefined;
};

let pass = 0;
const check = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok  ${msg}`); pass++; };

{ // 1 — device_id válido → header presente y exacto
  const DID = 'armor.f1e2d3c4b5a6-0011.2233445566778899aabbccddeeff';
  const res = await pagar({ device_id: DID });
  check(res.body.status === 'approved', 'pago aprobado con device_id');
  check(hdr(lastMPRequest.headers, 'X-meli-session-id') === DID, 'header X-meli-session-id === device_id');
}
{ // 2 — sin device_id → header ausente, el pago sigue
  const res = await pagar({});
  check(res.body.status === 'approved', 'pago sigue funcionando sin device_id');
  check(hdr(lastMPRequest.headers, 'X-meli-session-id') === undefined, 'sin device_id no se manda el header');
}
{ // 3 — device_id inválido (espacios) → header ausente
  const res = await pagar({ device_id: 'no válido con espacios' });
  check(res.body.status === 'approved', 'device_id inválido no rompe el pago');
  check(hdr(lastMPRequest.headers, 'X-meli-session-id') === undefined, 'device_id con espacios se descarta');
}
{ // 4 — device_id demasiado largo (>300) → header ausente
  const res = await pagar({ device_id: 'a'.repeat(400) });
  check(res.body.status === 'approved', 'device_id larguísimo no rompe el pago');
  check(hdr(lastMPRequest.headers, 'X-meli-session-id') === undefined, 'device_id >300 chars se descarta');
}
{ // 5 — invariante 1: el importe sigue saliendo del servidor
  await pagar({ device_id: 'armor.abc' });
  check(lastMPRequest.body.transaction_amount > 0, `transaction_amount server-side = ${lastMPRequest.body.transaction_amount}`);
}

console.log(`\n${pass}/${pass} PASS`);
process.kill(process.pid, 'SIGTERM'); // apagado limpio del server
