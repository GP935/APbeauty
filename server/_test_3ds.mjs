// Test de integración — 3DS 2.0 + reintento tras rechazo en /api/mp/process-payment.
// Boot del server real con MP mockeado vía globalThis.fetch. (node server/_test_3ds.mjs)
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 3481;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = 'whsec-test';
const realFetch = globalThis.fetch.bind(globalThis);

const tmp = await mkdtemp(join(tmpdir(), 'apb-3ds-'));
await writeFile(join(tmp, 'stock.json'), JSON.stringify({ base: null, stock_inicial: { 'tiras-destellos': 50 } }));

const mpPosts = [];
let nextPost = () => ({ status: 'approved', status_detail: 'accredited' });
const paymentsById = new Map(); // GET /v1/payments/:id

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith(BASE)) return realFetch(url, opts);
  if (u.includes('api.mercadopago.com/v1/payments') && opts.method === 'POST') {
    const body = JSON.parse(opts.body || '{}');
    mpPosts.push({ headers: opts.headers || {}, body });
    const r = nextPost(mpPosts.length, body);
    const id = 900000 + mpPosts.length;
    const pago = { id, transaction_amount: body.transaction_amount, external_reference: body.external_reference, ...r };
    paymentsById.set(String(id), pago);
    return new Response(JSON.stringify(pago), { status: r.http || 200, headers: { 'content-type': 'application/json' } });
  }
  if (u.includes('api.mercadopago.com/v1/payments/')) {
    const id = u.split('/').pop();
    return new Response(JSON.stringify(paymentsById.get(id) || {}), { status: 200 });
  }
  if (u.includes('api.resend.com')) return new Response(JSON.stringify({ id: 'e' }), { status: 200 });
  throw new Error(`fetch no mockeado: ${u}`);
};

process.env.CHECKOUT_GATEWAY = 'mercadopago';
process.env.MP_ACCESS_TOKEN = 'TEST-fake-token';
process.env.MP_WEBHOOK_SECRET = SECRET;
process.env.PORT = String(PORT);
process.env.PUBLIC_BASE_URL = BASE;
process.env.MP_RATE_LIMIT = '1000';
process.env.LOGS_DIR = tmp;
process.env.STOCK_FILE = join(tmp, 'stock.json');
process.env.THREEDS_ENABLED = '1';

const origLog = console.log; const origInfo = console.info; const origWarn = console.warn; const origErr = console.error;
console.info = () => {}; console.warn = () => {}; console.error = () => {};
await import(new URL('./server.js', import.meta.url).href);
await new Promise((r) => setTimeout(r, 400));
console.log = () => {};

let pass = 0;
const check = (c, m) => { assert.ok(c, m); origLog(`  ok  ${m}`); pass++; };

const SHIPPING = { name: 'María Pérez López', phone: '987654321', address: { line: 'Av. Pardo 123', district: 'Miraflores', province: 'Lima', department: 'Lima', zip: '15074', country: 'PE' } };
const post = (path, body) => realFetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const crear = async () => (await (await post('/api/mp/create-order', { items: [{ id: 'tiras-destellos', quantity: 1 }] })).json()).orderId;
const pagar = async (orderId) => {
  const r = await post('/api/mp/process-payment', { orderId, token: 'tok_secreto', issuer_id: '1', payment_method_id: 'visa', payer: { email: 'c@example.com' }, shipping: SHIPPING, device_id: 'armor.abc' });
  return { http: r.status, body: await r.json() };
};
const estado = async (orderId) => (await (await realFetch(`${BASE}/api/mp/order-status/${orderId}`)).json()).estado;
let notif = 0;
const webhook = (paymentId) => {
  const ts = String(Date.now()); const reqId = `req-${++notif}`;
  const hash = crypto.createHmac('sha256', SECRET).update(`id:${paymentId};request-id:${reqId};ts:${ts};`).digest('hex');
  return realFetch(`${BASE}/api/mp/webhook?data.id=${paymentId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-signature': `ts=${ts},v1=${hash}`, 'x-request-id': reqId },
    body: JSON.stringify({ id: 7000 + notif, type: 'payment', data: { id: String(paymentId) } }),
  });
};

{ // 1 — 3DS: el payload lleva three_d_secure_mode y el desafío llega al frontend
  nextPost = () => ({ status: 'pending', status_detail: 'pending_challenge', three_ds_info: { external_resource_url: 'https://acs.banco.pe/challenge', creq: 'CREQ123' } });
  const orderId = await crear();
  const { body } = await pagar(orderId);
  check(mpPosts[0].body.three_d_secure_mode === 'optional', 'payload con three_d_secure_mode: optional');
  check(!('binary_mode' in mpPosts[0].body), 'sin binary_mode');
  check(body.status === 'pending' && body.status_detail === 'pending_challenge', 'respuesta pending_challenge');
  check(body.three_ds_info?.external_resource_url === 'https://acs.banco.pe/challenge' && body.three_ds_info?.creq === 'CREQ123', 'three_ds_info llega al frontend');
  check(await estado(orderId) === 'pending', 'order-status = pending mientras dura el desafío');

  // el cliente supera el desafío → MP notifica por webhook con el pago aprobado
  const pagoId = String(900000 + mpPosts.length);
  paymentsById.set(pagoId, { ...paymentsById.get(pagoId), status: 'approved', status_detail: 'accredited', date_approved: new Date().toISOString(), payer: { email: 'c@example.com' } });
  const w = await webhook(pagoId);
  check(w.status === 200, 'webhook firmado aceptado');
  check(await estado(orderId) === 'approved', 'order-status = approved tras el webhook');
}
{ // 2 — desafío fallido → rejected y se puede reintentar
  nextPost = () => ({ status: 'pending', status_detail: 'pending_challenge', three_ds_info: { external_resource_url: 'https://acs.banco.pe/c', creq: 'C' } });
  const orderId = await crear();
  await pagar(orderId);
  const pagoId = String(900000 + mpPosts.length);
  paymentsById.set(pagoId, { ...paymentsById.get(pagoId), status: 'rejected', status_detail: 'cc_rejected_3ds_challenge' });
  await webhook(pagoId);
  check(await estado(orderId) === 'rejected', 'desafío fallido → order-status = rejected');
  nextPost = () => ({ status: 'approved', status_detail: 'accredited' });
  const r = await pagar(orderId);
  check(r.http === 200 && r.body.status === 'approved', 'tras el rechazo se puede pagar el mismo pedido con otra tarjeta');
}
{ // 3 — reintento tras rechazo: clave de idempotencia nueva y tope de intentos
  nextPost = () => ({ status: 'rejected', status_detail: 'cc_rejected_high_risk' });
  mpPosts.length = 0;
  const orderId = await crear();
  const r1 = await pagar(orderId); const r2 = await pagar(orderId); const r3 = await pagar(orderId);
  check([r1, r2, r3].every((r) => r.http === 200 && r.body.status === 'rejected'), '3 intentos permitidos tras rechazos');
  const keys = mpPosts.map((p) => Object.entries(p.headers).find(([k]) => k.toLowerCase() === 'x-idempotency-key')[1]);
  check(new Set(keys).size === 3 && keys[0] === orderId, `clave de idempotencia distinta por intento (${keys.length})`);
  const r4 = await pagar(orderId);
  check(r4.http === 409 && mpPosts.length === 3, 'el 4º intento da 409 y no llama a MP');
}
{ // 4 — pagado no se reabre; pedido inexistente → 404
  nextPost = () => ({ status: 'approved', status_detail: 'accredited' });
  const orderId = await crear();
  await pagar(orderId);
  const r = await pagar(orderId);
  check(r.http === 409, 'un pedido pagado no se puede volver a pagar');
  const nf = await realFetch(`${BASE}/api/mp/order-status/no-existe`);
  check(nf.status === 404, 'order-status de pedido inexistente → 404');
}
{ // 5 — el fallback por 400 quita three_d_secure_mode
  mpPosts.length = 0;
  nextPost = (n, body) => (body.additional_info ? { http: 400, message: 'bad', cause: [{ code: 1, description: 'x' }] } : { status: 'approved', status_detail: 'accredited' });
  const orderId = await crear();
  const r = await pagar(orderId);
  check(mpPosts.length === 2 && mpPosts[0].body.three_d_secure_mode === 'optional', 'primer intento con 3DS');
  check(!('three_d_secure_mode' in mpPosts[1].body) && r.body.status === 'approved', 'el payload mínimo no lleva 3DS');
}

console.log = origLog; console.info = origInfo; console.warn = origWarn; console.error = origErr;
console.log(`\n${pass}/${pass} PASS`);
process.kill(process.pid, 'SIGTERM');
