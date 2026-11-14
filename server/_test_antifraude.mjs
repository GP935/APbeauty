// Test de integración — payload antifraude en POST /api/mp/process-payment.
// Boot del server real con MP y Resend mockeados vía globalThis.fetch.
//   node server/_test_antifraude.mjs
import assert from 'node:assert/strict';

const PORT = 3478;
const BASE = `http://127.0.0.1:${PORT}`;
const realFetch = globalThis.fetch.bind(globalThis);

let lastMP = null;
let mpStatus = 'approved';
let mpRechazaExtra = false;
const mpCalls = [];
const warns = [];
const origWarn = console.warn;
console.warn = (...a) => { warns.push(a.join(' ')); };

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith(BASE)) return realFetch(url, opts);
  if (u.includes('api.mercadopago.com/v1/payments')) {
    lastMP = { headers: opts.headers || {}, body: JSON.parse(opts.body || '{}') };
    mpCalls.push(lastMP);
    if (mpRechazaExtra && lastMP.body.additional_info) {
      return new Response(JSON.stringify({ message: 'invalid additional_info', error: 'bad_request', status: 400,
        cause: [{ code: 4012, description: 'additional_info.items.category_id invalid' }] }), { status: 400, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      id: 111222333, status: mpStatus, status_detail: mpStatus === 'approved' ? 'accredited' : 'cc_rejected_high_risk',
      date_approved: new Date().toISOString(), payer: { email: 'x@example.com' }, metadata: lastMP.body.metadata || {},
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
process.env.MP_RATE_LIMIT = '1000';

await import(new URL('./server.js', import.meta.url).href);
await new Promise((r) => setTimeout(r, 400));

const SHIPPING = {
  name: 'María Pérez López', phone: '987 654 321',
  address: { line: 'Av. Pardo 123', reference: 'Dpto 4', district: 'Miraflores', province: 'Lima', department: 'Lima', zip: '15074', country: 'PE' },
};

async function pagar({ items, body = {} }) {
  const r0 = await fetch(`${BASE}/api/mp/create-order`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ items }),
  });
  const { orderId } = await r0.json();
  assert.ok(orderId, 'create-order sin orderId');
  lastMP = null;
  const r = await fetch(`${BASE}/api/mp/process-payment`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      orderId, token: 'tok_secreto', issuer_id: '1', payment_method_id: 'visa',
      payer: { email: 'clienta@example.com', identification: { type: 'DNI', number: '12345678' } },
      shipping: SHIPPING, device_id: 'armor.abc', ...body,
    }),
  });
  return { orderId, res: await r.json(), http: r.status };
}

const hdr = (h, n) => Object.entries(h).find(([k]) => k.toLowerCase() === n.toLowerCase())?.[1];
let pass = 0;
const check = (c, m) => { assert.ok(c, m); console.log(`  ok  ${m}`); pass++; };

{ // 1 — payload completo + importes del catálogo
  const { orderId } = await pagar({ items: [{ id: 'individuales-iconica-M', quantity: 2 }, { id: 'tiras-destellos', quantity: 1 }] });
  const b = lastMP.body;
  check(b.external_reference === orderId, 'external_reference = orderId');
  check(b.payer.email === 'clienta@example.com', 'payer.email llega');
  check(b.payer.first_name === 'María' && b.payer.last_name === 'Pérez López', 'payer first/last_name');
  check(b.payer.identification?.number === '12345678', 'payer.identification');
  const it = b.additional_info.items;
  check(it.length === 2, 'additional_info.items: 2 líneas');
  check(it[0].id === 'individuales-iconica' && it[0].title === 'Individuales · Icónica' && it[0].category_id && it[0].description, 'item: id (SKU sin talla), title, description, category_id');
  check(it[0].quantity === 2 && it[0].unit_price === 35, 'item: quantity y unit_price del catálogo (S/ 35)');
  check(it[1].unit_price === 10, 'item tiras: unit_price 10');
  check(b.transaction_amount === 80, `transaction_amount = 80 (obtenido ${b.transaction_amount})`);
  check(it.reduce((s, i) => s + i.quantity * i.unit_price, 0) === b.transaction_amount, 'suma de items = transaction_amount');
  const ap = b.additional_info.payer;
  check(ap.first_name === 'María' && ap.last_name === 'Pérez López' && ap.phone.number === '987654321', 'additional_info.payer: nombre + teléfono');
  const ra = b.additional_info.shipments.receiver_address;
  check(ra.zip_code === '15074' && ra.street_name === 'Av. Pardo' && ra.street_number === '123', 'receiver_address: zip, calle, número');
}
{ // 2 — el cliente no puede fijar precios ni items
  await pagar({
    items: [{ id: 'tiras-destellos', quantity: 1 }],
    body: { transaction_amount: 0.01, items: [{ unit_price: 0.01 }], additional_info: { items: [{ unit_price: 0.01 }] } },
  });
  check(lastMP.body.transaction_amount === 10, 'transaction_amount ignora el body del cliente');
  check(lastMP.body.additional_info.items[0].unit_price === 10, 'unit_price ignora el body del cliente');
}
{ // 3 — validación / recorte de entradas del cliente
  await pagar({
    items: [{ id: 'tiras-destellos', quantity: 1 }],
    body: {
      payer: { email: 'no-es-un-email', identification: { type: 'X', number: '<script>' } },
      shipping: { ...SHIPPING, name: 'A'.repeat(60) + ' ' + 'B'.repeat(400), address: { ...SHIPPING.address, line: 'Calle Sin Numero', zip: '1'.repeat(40) } },
    },
  });
  const b = lastMP.body;
  check(b.payer.email === undefined, 'email inválido no se reenvía');
  check(b.payer.identification === undefined, 'documento inválido no se reenvía');
  check(JSON.stringify(b).length < 4000 && b.additional_info.payer.first_name.length <= 120, 'nombre recortado');
  check(b.additional_info.shipments.receiver_address.zip_code.length <= 12, 'zip recortado');
  check(b.additional_info.shipments.receiver_address.street_number === undefined, 'sin número reconocible no se inventa street_number');
}
{ // 4 — log de rechazo sin token
  mpStatus = 'rejected';
  const { res } = await pagar({ items: [{ id: 'tiras-destellos', quantity: 1 }] });
  const w = warns.find((x) => x.includes('pago rechazado'));
  check(res.status === 'rejected', 'respuesta al cliente = rejected');
  check(res.status_detail === 'cc_rejected_high_risk', 'la respuesta incluye status_detail para el mensaje de rechazo');
  check(w && w.includes('status=rejected') && w.includes('status_detail=cc_rejected_high_risk'), 'log de rechazo con status y status_detail');
  check(!warns.concat().join('\n').includes('tok_secreto'), 'el log no contiene el token');
}

{ // 5 — parseo de direcciones peruanas
  const casos = [
    ['Av. Javier Prado Este 1234', 'Av. Javier Prado Este', '1234'],
    ['Jr. de la Unión 456, Dpto 302', 'Jr. de la Unión', '456'],
    ['Calle 28 de Julio 150', 'Calle 28 de Julio', '150'],
    ['Mz. B Lt. 12 Urb. Los Jardines', 'Mz. B Lt. 12 Urb. Los Jardines', undefined],
    ['Pasaje Los Cedros s/n', 'Pasaje Los Cedros s/n', undefined],
  ];
  for (const [line, calle, num] of casos) {
    mpStatus = 'approved';
    await pagar({ items: [{ id: 'tiras-destellos', quantity: 1 }], body: { shipping: { ...SHIPPING, address: { ...SHIPPING.address, line } } } });
    const ra = lastMP.body.additional_info.shipments.receiver_address;
    check(ra.street_name === calle && ra.street_number === num, `"${line}" → ${ra.street_name} | ${ra.street_number}`);
  }
}
{ // 6 — sin documento: no se envía identification
  await pagar({ items: [{ id: 'tiras-destellos', quantity: 1 }], body: { payer: { email: 'clienta@example.com' } } });
  check(!('identification' in lastMP.body.payer), 'sin documento no se manda identification');
}
{ // 7 — fallback: MP 400 por datos extra → un reintento con payload mínimo
  mpRechazaExtra = true; mpCalls.length = 0; warns.length = 0;
  const { orderId, res } = await pagar({ items: [{ id: 'tiras-destellos', quantity: 1 }] });
  check(mpCalls.length === 2, `exactamente 2 llamadas a MP (${mpCalls.length})`);
  const [primera, segunda] = mpCalls;
  check(primera.body.additional_info && !segunda.body.additional_info, 'el reintento no lleva additional_info');
  check(!('first_name' in segunda.body.payer) && segunda.body.payer.email === 'clienta@example.com', 'reintento: payer solo con email (+ documento)');
  check(segunda.body.token === 'tok_secreto' && segunda.body.transaction_amount === 10 && segunda.body.external_reference === orderId, 'reintento: token, importe y external_reference');
  check(hdr(segunda.headers, 'X-meli-session-id') === 'armor.abc', 'reintento conserva device_id');
  check(res.status === 'approved', 'el cliente recibe el resultado del reintento');
  const w = warns.find((x) => x.includes('MP 400'));
  check(w && w.includes('invalid additional_info') && w.includes('4012'), 'se loguea el motivo del 400');
  check(!warns.join('\n').includes('tok_secreto'), 'el log del 400 no contiene el token');
  mpRechazaExtra = false;
}
{ // 8 — dirección con número duplicado ("Amazonas 836 836")
  mpStatus = 'approved';
  await pagar({ items: [{ id: 'tiras-destellos', quantity: 1 }], body: { shipping: { ...SHIPPING, address: { ...SHIPPING.address, line: 'Amazonas 836 836' } } } });
  const ra = lastMP.body.additional_info.shipments.receiver_address;
  check(ra.street_name === 'Amazonas' && ra.street_number === '836', `"Amazonas 836 836" → ${ra.street_name} | ${ra.street_number}`);
  check(lastMP.body.metadata.ship_line === 'Amazonas 836', 'metadata.ship_line sin número duplicado');
}
{ // 9 — nombre de una sola palabra → 400, MP no se llama, y el mismo pedido se puede reintentar
  mpCalls.length = 0;
  const r0 = await fetch(`${BASE}/api/mp/create-order`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items: [{ id: 'tiras-destellos', quantity: 1 }] }) });
  const { orderId } = await r0.json();
  const enviar = (name) => fetch(`${BASE}/api/mp/process-payment`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ orderId, token: 'tok', issuer_id: '1', payment_method_id: 'visa', payer: { email: 'c@example.com' }, shipping: { ...SHIPPING, name }, device_id: 'armor.abc' }),
  });
  const r1 = await enviar('Andrea');
  const j1 = await r1.json();
  check(r1.status === 400 && j1.field === 'shipping.name' && /apellido/i.test(j1.error), 'nombre de una palabra → 400 con field shipping.name');
  check(mpCalls.length === 0, 'con nombre incompleto no se llama a MP');
  const r2 = await enviar('Andrea Torres');
  check(r2.status === 200 && mpCalls.length === 1, 'el mismo pedido se paga tras corregir el nombre');
}

console.log(`\n${pass}/${pass} PASS`);
console.warn = origWarn;
process.kill(process.pid, 'SIGTERM');
