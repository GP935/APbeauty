// AP Beauty — main.js (module, defer)
// Reskin de la plantilla comodex-home: mismas mecánicas, mismo contrato de IDs/clases.
// La home NO procesa pagos: los botones de comercio son enlaces a las landings de producto.

// Buscador desplegable — open/close reutilizables (los usa el header y el link del menú)
function openSearch() {
  const panel = document.getElementById('search-panel');
  const input = document.getElementById('search-input');
  const btn = document.getElementById('btn-search');
  if (!panel) return;
  panel.removeAttribute('hidden');
  if (btn) btn.setAttribute('aria-expanded', 'true');
  if (input) input.focus();
}

function closeSearch() {
  const panel = document.getElementById('search-panel');
  const btn = document.getElementById('btn-search');
  if (!panel) return;
  panel.setAttribute('hidden', '');
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

function initSearch() {
  const btn = document.getElementById('btn-search');
  const panel = document.getElementById('search-panel');
  const input = document.getElementById('search-input');
  if (!btn || !panel || !input) return;

  btn.addEventListener('click', () => {
    if (panel.hasAttribute('hidden')) openSearch();
    else closeSearch();
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && input.value.trim()) {
      window.location.href = '/tienda?q=' + encodeURIComponent(input.value.trim());
    }
  });
}

// 1 · Menú móvil — panel deslizante + backdrop (rework AB-J4)
function initMobileMenu() {
  const btnMenu = document.getElementById('btn-menu');
  const panel = document.getElementById('menu-panel');
  const backdrop = document.getElementById('menu-backdrop');
  const btnClose = document.getElementById('btn-menu-close');
  if (!btnMenu || !panel || !backdrop) return;

  function open() {
    backdrop.removeAttribute('hidden');
    panel.classList.add('is-open');
    backdrop.classList.add('is-open');
    btnMenu.setAttribute('aria-expanded', 'true');
    panel.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    if (btnClose) btnClose.focus();
  }

  function close() {
    if (!panel.classList.contains('is-open')) return;
    panel.classList.remove('is-open');
    backdrop.classList.remove('is-open');
    btnMenu.setAttribute('aria-expanded', 'false');
    panel.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
    btnMenu.focus();

    // Devolver `hidden` al backdrop tras la transición (con fallback si no se dispara)
    let restored = false;
    const restore = () => {
      if (restored || backdrop.classList.contains('is-open')) return;
      restored = true;
      backdrop.setAttribute('hidden', '');
    };
    backdrop.addEventListener('transitionend', restore, { once: true });
    setTimeout(restore, 400);
  }

  btnMenu.addEventListener('click', open);
  if (btnClose) btnClose.addEventListener('click', close);
  backdrop.addEventListener('click', close);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && panel.classList.contains('is-open')) close();
  });

  // Cerrar al pulsar un enlace de navegación del panel
  panel.querySelectorAll('a:not([data-open-search])').forEach((link) => {
    link.addEventListener('click', close);
  });

  // Link "Buscar" del panel → cierra el menú y abre el buscador
  const searchLink = document.getElementById('menu-search-link');
  if (searchLink) {
    searchLink.addEventListener('click', (e) => {
      e.preventDefault();
      close();
      openSearch();
    });
  }
}

// 2 · Flechas de carrusel — reutilizable, scroll por ancho de card+gap + disable en extremos
function bindRail(trackId, prevId, nextId, cardSelector, perPage = 1) {
  const track = document.getElementById(trackId);
  const prev = document.getElementById(prevId);
  const next = document.getElementById(nextId);
  if (!track || !prev || !next) return;

  // Paso = (ancho de una card + gap) × cards por página (medido, no fijo)
  function getStep() {
    const card = track.querySelector(cardSelector);
    const gap = parseFloat(getComputedStyle(track).columnGap || getComputedStyle(track).gap) || 0;
    return (card ? card.offsetWidth + gap : track.clientWidth * 0.8) * perPage;
  }

  function updateArrows() {
    const max = track.scrollWidth - track.clientWidth;
    prev.disabled = track.scrollLeft <= 1;
    next.disabled = track.scrollLeft >= max - 1;
  }

  prev.addEventListener('click', () => track.scrollBy({ left: -getStep(), behavior: 'smooth' }));
  next.addEventListener('click', () => track.scrollBy({ left: getStep(), behavior: 'smooth' }));
  track.addEventListener('scroll', updateArrows, { passive: true });
  window.addEventListener('resize', updateArrows, { passive: true });
  updateArrows();
}

// 3 · Carrito — modelo persistente en localStorage `ap_cart` (AB-J6)
// Forma: { items: [ { id, name, price, priceId, qty, image } ] }
// `price` SIEMPRE en céntimos enteros (S/ 24,90 → 2490); se formatea a soles solo para mostrar.
// Moneda visible de AP Beauty: soles peruanos (S/) — alineado con el catálogo (AB-F21/AB-F22).
const CART_KEY = 'ap_cart';

// Mercado Pago (AP-B5 / AP-J2). Clave PÚBLICA de PRODUCCIÓN — cuenta Perú (MPE)
// de Paul, credenciales `APP_USR-` válidas verificadas por backend contra
// `GET /users/me` 2026-09-05 (el fallo de agosto era el prefijo compuesto
// `APP_USR-TEST-...`, que no es un formato real de MP). Va expuesta en el cliente
// a propósito; el Access Token secreto vive solo en `server/.env` del backend.
// El backend enruta con `CHECKOUT_GATEWAY=mercadopago` (env, no geo-IP).
const MP_PUBLIC_KEY = 'APP_USR-61ebb75a-2d17-45e0-a1ae-8d2edf6cdd6c';

function readCart() {
  try {
    const data = JSON.parse(localStorage.getItem(CART_KEY));
    if (data && Array.isArray(data.items)) return data;
  } catch (_) { /* JSON corrupto → carrito vacío */ }
  return { items: [] };
}

function writeCart(cart) {
  localStorage.setItem(CART_KEY, JSON.stringify(cart));
}

// céntimos → "S/ 24,90"  (mismo formato numérico que el catálogo: coma decimal, punto de millar)
function formatPEN(cents) {
  return 'S/ ' + (cents / 100).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const cartQty = (cart) => cart.items.reduce((n, i) => n + i.qty, 0);
const cartSubtotal = (cart) => cart.items.reduce((n, i) => n + i.price * i.qty, 0);

// Construye una línea clonando #cart-line-tpl (sin hardcodear markup)
function buildLine(item) {
  const tpl = document.getElementById('cart-line-tpl');
  if (!tpl) return null;
  const li = tpl.content.firstElementChild.cloneNode(true);
  li.dataset.id = item.id;
  const img = li.querySelector('.cart-line__img');
  if (img) { img.src = item.image || ''; img.alt = item.name || ''; }
  const name = li.querySelector('.cart-line__name');
  if (name) name.textContent = item.name || '';
  const price = li.querySelector('.cart-line__price');
  if (price) price.textContent = formatPEN(item.price);
  const qval = li.querySelector('.cart-line__qval');
  if (qval) qval.textContent = item.qty;
  return li;
}

function renderList(ul, cart) {
  ul.textContent = '';
  cart.items.forEach((item) => {
    const li = buildLine(item);
    if (li) ul.appendChild(li);
  });
}

// Render único: badge (todas las páginas) + drawer + carrito.html. Cada bloque con guarda de presencia.
function renderCart() {
  const cart = readCart();
  const subtotal = cartSubtotal(cart);
  const hasItems = cart.items.length > 0;

  const badge = document.getElementById('cart-count');
  if (badge) badge.textContent = cartQty(cart);

  const items = document.getElementById('cart-items');
  if (items) {
    renderList(items, cart);
    const empty = document.getElementById('cart-empty');
    const foot = document.getElementById('cart-foot');
    const sub = document.getElementById('cart-subtotal');
    if (empty) empty.hidden = hasItems;
    if (foot) foot.hidden = !hasItems;
    if (sub) sub.textContent = formatPEN(subtotal);
  }

  const pageItems = document.getElementById('cart-page-items');
  if (pageItems) {
    renderList(pageItems, cart);
    const pageEmpty = document.getElementById('cart-page-empty');
    const pageLayout = document.getElementById('cart-page-layout');
    const pageSub = document.getElementById('cart-page-subtotal');
    if (pageEmpty) pageEmpty.hidden = hasItems;
    if (pageLayout) pageLayout.hidden = !hasItems;
    if (pageSub) pageSub.textContent = formatPEN(subtotal);
  }
}

function addToCart(data) {
  const cart = readCart();
  const existing = cart.items.find((i) => i.id === data.id);
  if (existing) {
    existing.qty += 1;
  } else {
    cart.items.push({
      id: data.id,
      name: data.name,
      price: parseInt(data.price, 10) || 0,
      priceId: data.priceid || '',
      qty: 1,
      image: data.image || '',
    });
  }
  writeCart(cart);
  renderCart();
}

function changeQty(id, delta) {
  const cart = readCart();
  const item = cart.items.find((i) => i.id === id);
  if (!item) return;
  item.qty += delta;
  if (item.qty <= 0) cart.items = cart.items.filter((i) => i.id !== id);
  writeCart(cart);
  renderCart();
}

function removeItem(id) {
  const cart = readCart();
  cart.items = cart.items.filter((i) => i.id !== id);
  writeCart(cart);
  renderCart();
}

function clearCart() {
  writeCart({ items: [] });
  renderCart();
}

// Drawer deslizante (misma mecánica que el menú móvil: .is-open en drawer+backdrop, X/Esc/click fuera)
function initCartDrawer() {
  const btnCart = document.getElementById('btn-cart');
  const drawer = document.getElementById('cart-drawer');
  const backdrop = document.getElementById('cart-backdrop');
  const btnClose = document.getElementById('btn-cart-close');
  if (!drawer || !backdrop) return null;

  function open() {
    backdrop.removeAttribute('hidden');
    drawer.classList.add('is-open');
    backdrop.classList.add('is-open');
    if (btnCart) btnCart.setAttribute('aria-expanded', 'true');
    drawer.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    if (btnClose) btnClose.focus();
  }

  function close() {
    if (!drawer.classList.contains('is-open')) return;
    drawer.classList.remove('is-open');
    backdrop.classList.remove('is-open');
    drawer.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
    if (btnCart) { btnCart.setAttribute('aria-expanded', 'false'); btnCart.focus(); }

    let restored = false;
    const restore = () => {
      if (restored || backdrop.classList.contains('is-open')) return;
      restored = true;
      backdrop.setAttribute('hidden', '');
    };
    backdrop.addEventListener('transitionend', restore, { once: true });
    setTimeout(restore, 400);
  }

  if (btnCart) btnCart.addEventListener('click', open);
  if (btnClose) btnClose.addEventListener('click', close);
  backdrop.addEventListener('click', close);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && drawer.classList.contains('is-open')) close();
  });

  return { open, close };
}

function initCart() {
  const drawer = initCartDrawer();

  // Delegación global: añadir / cambiar cantidad / eliminar (convive con páginas sin esos elementos)
  document.addEventListener('click', (e) => {
    const addBtn = e.target.closest('.add-to-cart');
    if (addBtn) {
      e.preventDefault();
      // Producto agotado / no disponible → no se añade. Front marca el botón con
      // `disabled`/`aria-disabled="true"` o el artículo con `[data-estado="agotado"]`
      // (o `.cat-item--soon`, "Próximamente"). Guarda defensiva: un `<button disabled>`
      // nativo ni dispara click, pero esto cubre `<a>`/div estilados y el caso del
      // artículo marcado sin tocar el botón.
      if (addBtn.disabled
        || addBtn.getAttribute('aria-disabled') === 'true'
        || addBtn.closest('[data-estado="agotado"], .cat-item--soon')) {
        return;
      }
      addToCart(addBtn.dataset);
      if (drawer) drawer.open();
      return;
    }
    const actionBtn = e.target.closest('[data-action]');
    if (!actionBtn) return;
    const line = actionBtn.closest('.cart-line[data-id]');
    if (!line) return;
    const id = line.dataset.id;
    const action = actionBtn.dataset.action;
    if (action === 'inc') changeQty(id, 1);
    else if (action === 'dec') changeQty(id, -1);
    else if (action === 'remove') removeItem(id);
  });

  // Checkout real — Stripe Checkout hosted vía backend (AP-J1)
  // POST /api/create-checkout-session { items:[{price,quantity}] } → { url } (mismo origen; en prod Nginx enruta /api → :3000)
  const btnCheckout = document.getElementById('btn-checkout');
  if (btnCheckout) {
    btnCheckout.addEventListener('click', async () => {
      // Solo priceId + cantidad; el importe lo resuelve el servidor (nunca mandar precio desde el cliente)
      const items = readCart().items
        .filter((i) => i.priceId && i.qty > 0)
        .map((i) => ({ price: i.priceId, quantity: i.qty }));
      if (items.length === 0) return; // carrito vacío → no hacer nada

      const textoOriginal = btnCheckout.textContent;
      btnCheckout.disabled = true;
      btnCheckout.textContent = 'Redirigiendo…';

      try {
        const res = await fetch('/api/create-checkout-session', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ items }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.url) {
          window.location.href = data.url; // → Stripe Checkout hosted (no marcar "pagado" aquí: lo confirma el webhook)
          return;
        }
        throw new Error(data.error || 'checkout_failed');
      } catch (err) {
        // Feedback dentro de mi dominio (sin clase CSS nueva): aviso en el propio botón y reactivar
        btnCheckout.disabled = false;
        btnCheckout.textContent = 'Error, inténtalo de nuevo';
        setTimeout(() => { btnCheckout.textContent = textoOriginal; }, 3000);
      }
    });
  }

  // confirmacion.html (éxito) → vaciar carrito al cargar
  if (location.pathname.endsWith('confirmacion.html')) clearCart();

  renderCart();

  // Fase 2 — router dual-market (AP-B5). No bloquea el flujo Stripe: si falla
  // o el mercado sigue siendo 'stripe', #btn-checkout queda tal cual ya lo
  // dejó el bloque de arriba.
  initPaymentGateway();
}

// Carga perezosa del SDK de Mercado Pago (solo si el mercado lo requiere).
// Reutiliza el <script> si ya se insertó (evita duplicarlo en re-renders).
function loadMercadoPagoSdk() {
  if (window.MercadoPago) return Promise.resolve();
  const existing = document.getElementById('mp-sdk');
  if (existing) {
    return new Promise((resolve, reject) => {
      existing.addEventListener('load', resolve, { once: true });
      existing.addEventListener('error', reject, { once: true });
    });
  }
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.id = 'mp-sdk';
    script.src = 'https://sdk.mercadopago.com/js/v2';
    script.addEventListener('load', resolve, { once: true });
    script.addEventListener('error', reject, { once: true });
    document.head.appendChild(script);
  });
}

// Mensaje de error inline junto al Brick — mismo criterio que el error de
// #btn-checkout (Stripe): feedback dentro de mi dominio, sin clase CSS nueva
// pedida a css para esto (estilo mínimo heredado de párrafo simple).
function showMpError(el, msg) {
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
}

// Formulario de dirección de envío — va JUNTO al Brick (hermano, no dentro):
// el Brick de MP no expone campos de envío y su `onSubmit` sólo trae datos de
// tarjeta + email. Construido por JS (mismo criterio que el contenedor del
// Brick y `#cart-line-tpl` — carrito.html no trae markup de checkout).
// Campos de dirección estándar Perú; el email lo recoge el propio Brick, no
// se duplica aquí. Contrato de clases para css: `.mp-shipping*`.
function buildShippingForm() {
  const form = document.createElement('form');
  form.id = 'mp-shipping';
  form.className = 'mp-shipping';
  form.setAttribute('aria-label', 'Datos de envío');
  form.autocomplete = 'on';
  // El Brick es quien envía el pago; este <form> nunca hace submit propio
  // (Enter en un campo no debe recargar la página).
  form.addEventListener('submit', (e) => e.preventDefault());
  form.innerHTML = [
    '<h3 class="mp-shipping__title">Datos de envío</h3>',
    '<div class="mp-shipping__grid">',
    '  <label class="mp-shipping__field mp-shipping__field--wide">',
    '    <span>Nombre y apellidos</span>',
    '    <input name="nombre" type="text" autocomplete="name" required maxlength="120">',
    '  </label>',
    '  <label class="mp-shipping__field">',
    '    <span>Teléfono / celular</span>',
    '    <input name="telefono" type="tel" inputmode="tel" autocomplete="tel" required maxlength="20">',
    '  </label>',
    '  <label class="mp-shipping__field">',
    '    <span>Departamento</span>',
    '    <input name="departamento" type="text" autocomplete="address-level1" required maxlength="60">',
    '  </label>',
    '  <label class="mp-shipping__field">',
    '    <span>Provincia</span>',
    '    <input name="provincia" type="text" autocomplete="address-level2" required maxlength="60">',
    '  </label>',
    '  <label class="mp-shipping__field">',
    '    <span>Distrito</span>',
    '    <input name="distrito" type="text" autocomplete="address-level3" required maxlength="60">',
    '  </label>',
    '  <label class="mp-shipping__field mp-shipping__field--wide">',
    '    <span>Calle, avenida o jirón</span>',
    '    <input name="calle" type="text" autocomplete="address-line1" required maxlength="140">',
    '  </label>',
    '  <label class="mp-shipping__field">',
    '    <span>Número de casa / edificio</span>',
    '    <input name="numero" type="text" autocomplete="address-line2" required maxlength="20">',
    '  </label>',
    '  <label class="mp-shipping__field mp-shipping__field--wide">',
    '    <span>Referencia, dpto./interior <em>(opcional)</em></span>',
    '    <input name="referencia" type="text" maxlength="160">',
    '  </label>',
    '  <label class="mp-shipping__field">',
    '    <span>Código postal <em>(opcional)</em></span>',
    '    <input name="codigoPostal" type="text" inputmode="numeric" autocomplete="postal-code" maxlength="12">',
    '  </label>',
    '</div>',
  ].join('\n');
  return form;
}

// Lee el formulario a la forma que consume el backend (POST /api/mp/process-payment).
// El backend valida/sanea de nuevo y decide qué reenvía a MP (`additional_info`)
// y a n8n — aquí sólo se recogen y normalizan strings.
function readShippingForm(form) {
  const val = (n) => (form.elements[n]?.value || '').trim();
  return {
    name: val('nombre'),
    phone: val('telefono'),
    address: {
      street: val('calle'),
      number: val('numero'),
      reference: val('referencia'),
      district: val('distrito'),
      province: val('provincia'),
      department: val('departamento'),
      zip: val('codigoPostal'),
      country: 'PE',
    },
  };
}

// Monta el Card Payment Brick dentro de `container` (ya insertado en el DOM
// por initPaymentGateway). `orderId`/`amount` vienen de POST /api/mp/create-order
// — el Brick nunca decide el importe, solo lo muestra (initialization.amount).
async function mountMercadoPagoBrick(container, errorEl, orderId, amount, shippingForm) {
  await loadMercadoPagoSdk();
  const mp = new window.MercadoPago(MP_PUBLIC_KEY, { locale: 'es-PE' });
  const bricksBuilder = mp.bricks();

  await bricksBuilder.create('cardPayment', container.id, {
    initialization: { amount },
    customization: {
      visual: {
        style: {
          theme: 'default',
          // Paleta "tinta" del proyecto — el briefing deja abierto si el Brick
          // soporta paridad 1:1 con el Payment Element de Stripe; sin credenciales
          // válidas no pude verificar el render final con clic real, solo que
          // customVariables se acepta sin error de la SDK.
          customVariables: {
            textPrimaryColor: '#0A0A0A',
            formBackgroundColor: '#F7F7F5',
            baseColor: '#6B2737',
          },
        },
      },
    },
    callbacks: {
      onReady: () => {},
      // El argumento de onSubmit varía entre ejemplos/versiones de la SDK de MP:
      // el briefing lo muestra plano (`cardFormData`), otras referencias lo
      // envuelven en `{ formData }`. Soporto ambas formas sin asumir cuál aplica.
      onSubmit: (brickData) => new Promise((resolve, reject) => {
        const formData = (brickData && brickData.formData) || brickData || {};

        // Gate de envío: el Brick sólo valida SUS campos antes de disparar
        // onSubmit; los de dirección los validamos aquí. `reportValidity()`
        // muestra los mensajes nativos y enfoca el primer campo inválido.
        // `reject()` mantiene el Brick activo para reintentar tras completar.
        if (shippingForm && !shippingForm.reportValidity()) {
          reject();
          showMpError(errorEl, 'Completa los datos de envío antes de pagar.');
          return;
        }
        if (errorEl) errorEl.hidden = true; // limpia el aviso del gate si venía de un intento anterior
        const shipping = shippingForm ? readShippingForm(shippingForm) : null;

        // Solo orderId + datos de tarjeta tokenizados + dirección: el importe
        // SIEMPRE lo resuelve el servidor desde el pedido (AP-B5, invariante 1)
        // — nunca se manda transaction_amount/installments del formData del Brick.
        // `payer.identification` (DNI) va incluido: Perú (MPE) suele rechazar el
        // pago sin él; el backend lo reenvía a MP si viene y lo ignora si no.
        // `shipping` va aparte del `payer` de MP: el backend decide qué mapea a
        // `additional_info`/`shipments` de MP y qué manda a n8n (su dominio).
        const payload = {
          orderId,
          token: formData.token,
          issuer_id: formData.issuer_id,
          payment_method_id: formData.payment_method_id,
          payer: {
            email: formData.payer?.email,
            identification: formData.payer?.identification,
          },
          ...(shipping ? { shipping } : {}),
        };
        fetch('/api/mp/process-payment', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        })
          .then((res) => res.json().then((data) => ({ ok: res.ok, data })))
          .then(({ ok, data }) => {
            resolve(); // resuelve siempre: el Brick solo espera que la promesa termine
            if (!ok) { showMpError(errorEl, 'No se pudo procesar el pago. Inténtalo de nuevo.'); return; }
            if (data.status === 'approved') {
              clearCart();
              window.location.href = 'confirmacion.html';
            } else if (data.status === 'in_process' || data.status === 'pending') {
              // Común en bancos peruanos: el pago queda en revisión, el webhook
              // confirma después — no marcar "pagado" aquí (invariante 5).
              clearCart();
              window.location.href = 'confirmacion.html?estado=pendiente';
            } else {
              showMpError(errorEl, 'El pago fue rechazado. Prueba con otra tarjeta.');
            }
          })
          .catch(() => {
            reject();
            showMpError(errorEl, 'No se pudo procesar el pago. Inténtalo de nuevo.');
          });
      }),
      onError: (error) => {
        console.error('Mercado Pago — error del Brick:', error);
        showMpError(errorEl, 'No se pudo cargar el formulario de pago.');
      },
    },
  });
}

// Confirma que el Brick llegó a pintar su iframe. En producción se ha visto que
// si un CSP / adblock / fallo de red impide cargar el código del Brick, la SDK
// de MP **ni rechaza `create()` ni dispara `onError` de forma fiable** — solo
// loguea "Bricks.create: initialization failed" y deja el contenedor vacío. Sin
// esta comprobación el cliente se queda con la página de pago EN BLANCO (sin
// botón — lo ocultamos — y sin formulario). Resuelve `true` en cuanto aparece un
// iframe, o `false` al agotar el tiempo.
function brickRendered(container, timeoutMs) {
  return new Promise((resolve) => {
    if (container.querySelector('iframe')) { resolve(true); return; }
    const done = (val) => { obs.disconnect(); clearTimeout(timer); resolve(val); };
    const obs = new MutationObserver(() => {
      if (container.querySelector('iframe')) done(true);
    });
    obs.observe(container, { childList: true, subtree: true });
    const timer = setTimeout(() => done(!!container.querySelector('iframe')), timeoutMs);
  });
}

// Router dual-market (AP-B5) — GET /api/market es la fuente única (evita
// duplicar `pasarelaPara` en el cliente). Si el mercado es 'stripe' (default,
// incluye cualquier fallo de red) no toca nada: #btn-checkout ya está cableado
// arriba (AP-J1). Si es 'mercadopago', reemplaza ese botón por el Card Payment
// Brick — construye el contenedor por JS (sin depender de markup nuevo en
// carrito.html) siguiendo el mismo criterio que el resto del archivo usa para
// nodos que no existen de antemano (`buildLine` clona `#cart-line-tpl`).
async function initPaymentGateway() {
  const btnCheckout = document.getElementById('btn-checkout');
  if (!btnCheckout) return; // solo aplica en carrito.html

  let market;
  try {
    const res = await fetch('/api/market');
    market = await res.json();
  } catch (_) {
    return;
  }
  if (!market || market.gateway !== 'mercadopago') return;

  if (!btnCheckout.closest('.cart-summary')) return; // guarda: estructura esperada de carrito.html

  const cart = readCart();
  const items = cart.items.filter((i) => i.qty > 0).map((i) => ({ id: i.id, quantity: i.qty }));
  if (items.length === 0) return; // carrito vacío: se resuelve al recargar con items

  // NO uso `.hidden` aquí: `.cart-summary__checkout` ya trae `display:flex`
  // propio en style.css, que gana por especificidad sobre la regla
  // `[hidden]{display:none}` del user-agent (mismo bug documentado en AP Beauty
  // catálogo — `.cat-item[hidden]`/`.accordion-panel[hidden]` existen ahí por
  // esto). Clase `.is-hidden-mp` definida por css.
  // `.cart-summary__secure` ya NO se oculta: front dejó su copy agnóstico de
  // proveedor ("Pago seguro", AB-F20) → sirve igual para Stripe y Mercado Pago.
  btnCheckout.classList.add('is-hidden-mp');

  // Orden en `.cart-summary`: [dirección de envío] → [Brick] → [aviso de error].
  const shippingForm = buildShippingForm();
  btnCheckout.insertAdjacentElement('afterend', shippingForm);

  const container = document.createElement('div');
  container.id = 'cardPaymentBrick_container';
  container.className = 'mp-brick-container';
  shippingForm.insertAdjacentElement('afterend', container);

  const errorEl = document.createElement('p');
  errorEl.className = 'mp-brick-error';
  errorEl.setAttribute('role', 'alert');
  errorEl.hidden = true;
  container.insertAdjacentElement('afterend', errorEl);

  try {
    const orderRes = await fetch('/api/mp/create-order', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items }),
    });
    const order = await orderRes.json().catch(() => ({}));
    if (!orderRes.ok || !order.orderId) throw new Error(order.error || 'order_failed');

    // Sin await bloqueante: si el código del Brick está bloqueado, `create()`
    // puede colgarse sin resolver ni rechazar. Lanzamos el montaje y verificamos
    // aparte que el iframe aparece; si no, mensaje visible en vez de página en blanco.
    mountMercadoPagoBrick(container, errorEl, order.orderId, order.amount, shippingForm)
      .catch((err) => console.error('Mercado Pago — el Brick no montó:', err));

    if (!(await brickRendered(container, 8000))) throw new Error('brick_no_render');
  } catch (err) {
    console.error('Mercado Pago — no se pudo iniciar el checkout:', err);
    showMpError(errorEl, 'No se pudo cargar el formulario de pago. Recarga la página e inténtalo de nuevo.');
  }
}

// confirmacion.html — variante "pago en revisión" (Mercado Pago in_process/
// pending, común en bancos peruanos). El estado "aprobado" reutiliza el texto
// existente tal cual (mismo destino que el success_url de Stripe). Copy propio
// de criterio (no hay brief de front para este caso nuevo) — señalado en el log.
function initConfirmationState() {
  if (!location.pathname.endsWith('confirmacion.html')) return;
  if (new URLSearchParams(location.search).get('estado') !== 'pendiente') return;

  const section = document.querySelector('.confirmation');
  if (!section) return;
  const eyebrow = section.querySelector('.eyebrow');
  const title = section.querySelector('h1');
  const text = section.querySelector('.confirmation__text');
  if (eyebrow) eyebrow.textContent = 'PEDIDO EN REVISIÓN';
  if (title) title.textContent = 'Estamos confirmando tu pago';
  if (text) text.textContent = 'Tu banco está procesando el pago — algunos bancos peruanos tardan unos minutos en confirmar. Te avisaremos por correo en cuanto quede aprobado.';
}

// 4 · "Por qué AP Beauty" — count-up + reveal escalonado de stats
function initWhyStats() {
  const why = document.querySelector('.why');
  if (!why) return;

  const stats = why.querySelectorAll('.why-stat');
  if (!stats.length) return;

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function formatValue(value, decimals, prefix, suffix) {
    const num = decimals > 0
      ? value.toLocaleString('es-ES', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
      : Math.round(value).toLocaleString('es-ES');
    return prefix + num + suffix;
  }

  function animateCount(el) {
    const target = parseFloat(el.dataset.target) || 0;
    const decimals = parseInt(el.dataset.decimals, 10) || 0;
    const prefix = el.dataset.prefix || '';
    const suffix = el.dataset.suffix || '';
    const duration = 1200;
    const start = performance.now();

    function tick(now) {
      const p = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - p, 3); // easeOutCubic
      el.textContent = formatValue(target * eased, decimals, prefix, suffix);
      if (p < 1) requestAnimationFrame(tick);
      else el.textContent = formatValue(target, decimals, prefix, suffix);
    }
    requestAnimationFrame(tick);
  }

  function revealAll() {
    stats.forEach((stat, i) => {
      const num = stat.querySelector('.why-num');
      if (reduced) {
        stat.classList.add('revealed');
        if (num) {
          const decimals = parseInt(num.dataset.decimals, 10) || 0;
          num.textContent = formatValue(parseFloat(num.dataset.target) || 0, decimals, num.dataset.prefix || '', num.dataset.suffix || '');
        }
        return;
      }
      setTimeout(() => {
        stat.classList.add('revealed');
        if (num) animateCount(num);
      }, i * 120);
    });
  }

  const observer = new IntersectionObserver((entries, obs) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        revealAll();
        obs.unobserve(entry.target);
      }
    });
  }, { threshold: 0.4 });
  observer.observe(why);
}

// Año dinámico del footer
function initFooterYear() {
  const el = document.getElementById('footer-year');
  if (el) el.textContent = new Date().getFullYear();
}

// 5 · Catálogo — filtro por categoría (?cat=) sin recargar (AB-J5)
// Contrato CSS: filtra OCULTANDO (hidden), nunca reordena el DOM (la alternancia lado/fondo
// es :nth-child por posición). Pill activa = .is-active. Salida #ver-todo-catalogo solo con filtro.
function initCatalog() {
  const list = document.querySelector('.catalog-list');
  if (!list) return; // solo existe en catalogo.html — guarda para el home

  const items = list.querySelectorAll('.cat-item');
  const pills = Array.from(document.querySelectorAll('.catalog-pills .cat-pill'));
  const verTodo = document.getElementById('ver-todo-catalogo');
  const validCats = new Set(pills.map((p) => p.dataset.cat).filter(Boolean));

  // Aplica una categoría (slug o '' = todos). Slug desconocido → cae a "todos" (sin página vacía).
  function apply(cat) {
    const active = validCats.has(cat) ? cat : '';
    items.forEach((el) => {
      el.hidden = active ? el.dataset.category !== active : false;
    });
    pills.forEach((p) => p.classList.toggle('is-active', (p.dataset.cat || '') === active));
    if (verTodo) verTodo.hidden = !active;
    return active;
  }

  const catFromURL = () => new URLSearchParams(location.search).get('cat') || '';

  // Lleva la vista al primer producto visible del filtro (sin esto, quien llega con ?cat=
  // desde una category-card del home se queda arriba, sobre la cabecera y las pills)
  function scrollToResults(smooth) {
    const firstVisible = list.querySelector('.cat-item:not([hidden])');
    if (firstVisible) firstVisible.scrollIntoView({ block: 'start', behavior: smooth ? 'smooth' : 'auto' });
  }

  const initialCat = apply(catFromURL()); // estado inicial enlazable

  // El scroll nativo del navegador al cargar con #<id> ya corrió sobre el layout previo a
  // ocultar items (apply() se ejecuta después) → si arriba se ocultó contenido, la posición
  // queda desplazada. Forzamos el aterrizaje exacto sobre el <id> si quedó visible.
  const hashTarget = location.hash && document.getElementById(location.hash.slice(1));
  if (hashTarget && !hashTarget.hidden) {
    hashTarget.scrollIntoView({ block: 'start' });
  } else if (initialCat && !location.hash) {
    scrollToResults(false);
  }

  pills.forEach((pill) => {
    pill.addEventListener('click', (e) => {
      e.preventDefault();
      const cat = apply(pill.dataset.cat || '');
      history.pushState({ cat }, '', cat ? `catalogo.html?cat=${cat}` : 'catalogo.html');
      if (cat) scrollToResults(true);
    });
  });

  if (verTodo) {
    verTodo.addEventListener('click', (e) => {
      e.preventDefault();
      apply('');
      history.pushState({ cat: '' }, '', 'catalogo.html');
    });
  }

  // Back/forward del navegador reaplica el estado de la URL
  window.addEventListener('popstate', () => apply(catFromURL()));
}

// 5b · Catálogo — Pestañas: selector de diseño (+ talla en la línea que la tenga) (AB-J9 · AB-J11)
// Cada <article class="cat-item--lash"> es un producto con N diseños (.lash-swatch):
//   #individuales → 5 diseños con talla (S/M/L, Despierta = única)
//   #tiras        → 4 diseños, todos talla única (sin #lash-sizes)
// Mantiene los data-* del botón .add-to-cart sincronizados con la selección activa (initCart
// lee btn.dataset en el clic). Contratos completos en los comentarios <!-- CONTRATO JS --> de
// catalogo.html. Prefijo de id, nombre de carrito y frase del alt se derivan de article.id.
const LASH_LINES = {
  individuales: { cartPrefix: 'Individuales', altNoun: 'Pestañas individuales' },
  tiras: { cartPrefix: 'Tiras', altNoun: 'Pestañas de tira' },
};

function initLashPicker() {
  document.querySelectorAll('.cat-item--lash').forEach(setupLashArticle);
}

function setupLashArticle(article) {
  const line = LASH_LINES[article.id];
  if (!line) return;

  const swatches = Array.from(article.querySelectorAll('.lash-swatch'));
  const panels = Array.from(article.querySelectorAll('.lash-panel'));
  const sizeWrap = article.querySelector('#lash-sizes');
  const sizeButtons = Array.from(article.querySelectorAll('#lash-sizes .lash-size'));
  const sizeUnica = article.querySelector('#lash-size-unica');
  const media = article.querySelector('.cat-item__media img[data-lash-media]');
  const addBtn = article.querySelector('.add-to-cart');
  if (!swatches.length || !addBtn) return;

  const activeSwatch = () => swatches.find((s) => s.classList.contains('is-active')) || swatches[0];
  const activeSizeBtn = () => sizeButtons.find((b) => b.classList.contains('is-active')) || sizeButtons[0];

  function recomposeButton() {
    const swatch = activeSwatch();
    const btn = activeSizeBtn();
    const unica = swatch.dataset.tallas === 'unica' || !btn;
    const size = unica ? 'unica' : btn.dataset.size;
    const sizeLabel = unica ? 'Talla única' : 'Talla ' + size;

    addBtn.dataset.id = article.id + '-' + swatch.dataset.slug + '-' + size;
    addBtn.dataset.name = line.cartPrefix + ' · ' + swatch.dataset.cartName + ' · ' + sizeLabel;
    addBtn.dataset.price = swatch.dataset.price;
    addBtn.dataset.priceid = swatch.dataset.priceid;
    addBtn.dataset.image = swatch.dataset.image;
  }

  function selectSize(btn) {
    sizeButtons.forEach((b) => {
      const on = b === btn;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    recomposeButton();
  }

  function selectSwatch(swatch) {
    swatches.forEach((s) => {
      const on = s === swatch;
      s.classList.toggle('is-active', on);
      s.setAttribute('aria-pressed', on ? 'true' : 'false');
    });

    const panelId = swatch.getAttribute('aria-controls');
    panels.forEach((p) => { p.hidden = p.id !== panelId; });

    if (media) {
      media.src = swatch.dataset.image;
      media.alt = line.altNoun + ' ' + swatch.dataset.cartName + ' de AP Beauty en su estuche';
    }

    const unica = swatch.dataset.tallas === 'unica';
    if (sizeWrap) sizeWrap.hidden = unica;
    if (sizeUnica) sizeUnica.hidden = !unica;

    // Al volver de un diseño de talla única, garantizar una talla S/M/L activa
    if (!unica && sizeButtons.length && !sizeButtons.some((b) => b.classList.contains('is-active'))) {
      sizeButtons[0].classList.add('is-active');
      sizeButtons[0].setAttribute('aria-pressed', 'true');
    }

    recomposeButton();
  }

  swatches.forEach((s) => s.addEventListener('click', () => selectSwatch(s)));
  sizeButtons.forEach((b) => b.addEventListener('click', () => selectSize(b)));

  // Alinear el botón con el estado inicial servido por front (#individuales: Icónica/M · #tiras: Destellos)
  recomposeButton();
}

// 6 · Políticas — acordeón exclusivo (AB-P3): un solo panel abierto a la vez
function openPanel(panel) {
  panel.hidden = false;
  requestAnimationFrame(() => panel.classList.add('is-open'));
}

function closePanel(panel) {
  panel.classList.remove('is-open');
  panel.addEventListener('transitionend', () => { panel.hidden = true; }, { once: true });
}

function initPoliciesAccordion() {
  const accordion = document.querySelector('[data-accordion]');
  if (!accordion) return; // no existe fuera de politicas.html

  const triggers = Array.from(accordion.querySelectorAll('.accordion-trigger'));

  triggers.forEach((trigger) => {
    trigger.addEventListener('click', () => {
      const panel = document.getElementById(trigger.getAttribute('aria-controls'));
      const isOpen = trigger.getAttribute('aria-expanded') === 'true';

      triggers.forEach((t) => { // exclusivo: cierra todos primero
        t.setAttribute('aria-expanded', 'false');
        closePanel(document.getElementById(t.getAttribute('aria-controls')));
      });

      if (!isOpen) { // si estaba cerrado, ábrelo (toggle)
        trigger.setAttribute('aria-expanded', 'true');
        openPanel(panel);
      }
    });
  });

  // Abrir por hash del footer (politicas.html#privacidad, etc.)
  const slug = location.hash.replace('#', '');
  const hashTrigger = slug && document.getElementById('acc-trigger-' + slug);
  if (hashTrigger) {
    hashTrigger.setAttribute('aria-expanded', 'true');
    openPanel(document.getElementById(hashTrigger.getAttribute('aria-controls')));
    hashTrigger.scrollIntoView({ block: 'start' });
  }
}

// 7 · Consentimiento de cookies (AB-L4)
// ---------------------------------------------------------------------------
// Marco: Perú — Ley 29733 + Código de Protección al Consumidor (NO RGPD).
// Categorías idénticas a politicas.html §cookies: `necessary` (técnicas, siempre
// activas, no se piden), `analytics` (GA4) y `marketing` (Meta Pixel). Hoy el
// sitio NO carga ningún script de tracking — esta pieza deja el consentimiento
// listo para cuando Paul active alguno (AB-D8).
//
// Elección persistida en localStorage `ap_cookie_consent` (convención `ap_` del
// proyecto, igual que `ap_cart`) — NO es una cookie pese al nombre del apartado
// legal. Aviso cruzado a seo para alinear la tabla de politicas.html.
//   Forma: { v: 1, analytics: bool, marketing: bool, ts: ISOString }
//
// NOMBRES DOM neutros a propósito (`ap-privacy-*`, no `cookie-*`/`consent-*`):
// verificado con clic real que una extensión bloqueadora de banners en el Chrome
// de pruebas ocultaba `.cookie-consent` vía filtro cosmético (`display:none` que
// gana a cualquier CSS del sitio). Los usuarios con ese tipo de extensión no
// verán el aviso — el fallo es seguro (por defecto todo denegado, sin tracking).
//
// GATE de UI: el banner solo se pinta cuando css publique AB-L3 y añada el
// centinela `:root { --ap-privacy-ui: ready }`. Sin ese CSS un banner sin
// estilar sobre producción es peor que no mostrarlo. La API pública y el gating
// de scripts funcionan siempre; el disparador "Configurar cookies" también
// (construye la UI on-demand al primer clic aunque falte el centinela).
const CONSENT_KEY = 'ap_cookie_consent';
const CONSENT_VERSION = 1;
const CONSENT_CATEGORIES = ['analytics', 'marketing'];

function readConsent() {
  try {
    const data = JSON.parse(localStorage.getItem(CONSENT_KEY));
    if (data && data.v === CONSENT_VERSION) {
      return { analytics: !!data.analytics, marketing: !!data.marketing };
    }
  } catch (_) { /* corrupto / no disponible → sin decidir */ }
  return null;
}

function writeConsent(choice) {
  const record = {
    v: CONSENT_VERSION,
    analytics: !!choice.analytics,
    marketing: !!choice.marketing,
    ts: new Date().toISOString(),
  };
  try {
    localStorage.setItem(CONSENT_KEY, JSON.stringify(record));
  } catch (_) { /* almacenamiento no disponible: la elección solo vale esta carga */ }
  applyConsent(record);
}

// Activa un <script type="text/plain" data-ap-cat="..."> convirtiéndolo en un
// <script> real (inline o por `data-src`). Así GA4/Pixel entran más adelante
// como bloques inertes en el HTML, sin tocar este archivo.
function activateGatedScript(placeholder) {
  if (placeholder.dataset.apActivated) return;
  const real = document.createElement('script');
  for (const attr of Array.from(placeholder.attributes)) {
    if (attr.name === 'type' || attr.name === 'data-ap-cat' || attr.name === 'data-src') continue;
    real.setAttribute(attr.name, attr.value);
  }
  if (placeholder.dataset.src) real.src = placeholder.dataset.src;
  real.textContent = placeholder.textContent;
  placeholder.dataset.apActivated = 'true';
  placeholder.replaceWith(real);
}

// Propaga la elección: activa los scripts de cada categoría concedida, avisa a
// Google Consent Mode si `gtag` está presente, y emite `ap:privacy-change` en
// document para cualquier integración futura.
function applyConsent(choice) {
  CONSENT_CATEGORIES.forEach((cat) => {
    if (!choice[cat]) return;
    document.querySelectorAll(
      'script[type="text/plain"][data-ap-cat="' + cat + '"]'
    ).forEach(activateGatedScript);
  });

  if (typeof window.gtag === 'function') {
    window.gtag('consent', 'update', {
      analytics_storage: choice.analytics ? 'granted' : 'denied',
      ad_storage: choice.marketing ? 'granted' : 'denied',
      ad_user_data: choice.marketing ? 'granted' : 'denied',
      ad_personalization: choice.marketing ? 'granted' : 'denied',
    });
  }

  document.dispatchEvent(new CustomEvent('ap:privacy-change', {
    detail: { analytics: !!choice.analytics, marketing: !!choice.marketing },
  }));
}

const apPrivacy = {
  get: () => readConsent(),
  allowed: (cat) => cat === 'necessary' || !!(readConsent() || {})[cat],
  openPreferences: () => {}, // la reasigna initCookieConsent cuando la UI existe
  reset: () => { try { localStorage.removeItem(CONSENT_KEY); } catch (_) { /* noop */ } },
};
window.apPrivacy = apPrivacy;

// Contrato DOM para css (AB-L3) / front. Clases: `.ap-privacy-bar*` (aviso) y
// `.ap-privacy-panel*` (modal de preferencias), botones `.ap-privacy-btn`.
// Estados: `[hidden]` en `#ap-privacy-bar` y `#ap-privacy-panel`; `.is-open` en
// el modal para la transición. Si css define `display` propio en esas clases
// debe reponer `[hidden]{display:none}` (gotcha `.cat-item[hidden]` ya conocido).
function buildConsentUI() {
  const wrap = document.createElement('div');
  wrap.id = 'ap-privacy-root';
  wrap.innerHTML = [
    '<section id="ap-privacy-bar" class="ap-privacy-bar" role="dialog" aria-modal="false"',
    '  aria-labelledby="ap-privacy-bar-title" aria-describedby="ap-privacy-bar-text" hidden>',
    '  <div class="ap-privacy-bar__inner">',
    '    <h2 id="ap-privacy-bar-title" class="ap-privacy-bar__title">Cookies en AP Beauty</h2>',
    '    <p id="ap-privacy-bar-text" class="ap-privacy-bar__text">',
    '      Usamos cookies técnicas necesarias para que la tienda funcione. Con tu permiso,',
    '      también usaríamos cookies de analítica y de marketing. Consulta la',
    '      <a href="politicas.html#cookies">Política de Cookies</a>.',
    '    </p>',
    '    <div class="ap-privacy-bar__actions">',
    '      <button type="button" class="ap-privacy-btn ap-privacy-btn--accept" data-ap-privacy-act="accept">Aceptar todas</button>',
    '      <button type="button" class="ap-privacy-btn ap-privacy-btn--reject" data-ap-privacy-act="reject">Rechazar no esenciales</button>',
    '      <button type="button" class="ap-privacy-btn ap-privacy-btn--config" data-ap-privacy>Configurar</button>',
    '    </div>',
    '  </div>',
    '</section>',
    '<div id="ap-privacy-panel" class="ap-privacy-panel" hidden>',
    '  <div class="ap-privacy-panel__backdrop" data-ap-privacy-act="close"></div>',
    '  <div class="ap-privacy-panel__dialog" role="dialog" aria-modal="true" aria-labelledby="ap-privacy-panel-title">',
    '    <button type="button" class="ap-privacy-panel__close" data-ap-privacy-act="close" aria-label="Cerrar">×</button>',
    '    <h2 id="ap-privacy-panel-title" class="ap-privacy-panel__title">Preferencias de cookies</h2>',
    '    <p class="ap-privacy-panel__intro">Elige qué categorías permites. Puedes cambiarlo cuando quieras desde el pie de página.</p>',
    '    <ul class="ap-privacy-panel__list">',
    '      <li class="ap-privacy-panel__row">',
    '        <label class="ap-privacy-panel__label"><input type="checkbox" class="ap-privacy-panel__toggle" checked disabled>',
    '          <span class="ap-privacy-panel__name">Técnicas (necesarias)</span></label>',
    '        <p class="ap-privacy-panel__desc">Imprescindibles para navegar y usar el carrito. Siempre activas.</p>',
    '      </li>',
    '      <li class="ap-privacy-panel__row">',
    '        <label class="ap-privacy-panel__label"><input type="checkbox" class="ap-privacy-panel__toggle" data-ap-privacy-cat="analytics">',
    '          <span class="ap-privacy-panel__name">Analíticas</span></label>',
    '        <p class="ap-privacy-panel__desc">Medición agregada del uso del sitio para mejorarlo (Google Analytics).</p>',
    '      </li>',
    '      <li class="ap-privacy-panel__row">',
    '        <label class="ap-privacy-panel__label"><input type="checkbox" class="ap-privacy-panel__toggle" data-ap-privacy-cat="marketing">',
    '          <span class="ap-privacy-panel__name">Marketing</span></label>',
    '        <p class="ap-privacy-panel__desc">Publicidad y medición de campañas en Meta (Instagram/Facebook).</p>',
    '      </li>',
    '    </ul>',
    '    <div class="ap-privacy-panel__actions">',
    '      <button type="button" class="ap-privacy-btn ap-privacy-btn--save" data-ap-privacy-act="save">Guardar preferencias</button>',
    '      <button type="button" class="ap-privacy-btn ap-privacy-btn--accept" data-ap-privacy-act="accept">Aceptar todas</button>',
    '      <button type="button" class="ap-privacy-btn ap-privacy-btn--reject" data-ap-privacy-act="reject">Rechazar todas</button>',
    '    </div>',
    '  </div>',
    '</div>',
  ].join('\n');
  document.body.appendChild(wrap);
  return wrap;
}

function initCookieConsent() {
  const decided = readConsent();
  if (decided) applyConsent(decided);

  const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';
  let built = false;
  let lastFocus = null;

  const bar = () => document.getElementById('ap-privacy-bar');
  const panel = () => document.getElementById('ap-privacy-panel');

  function hideBar() { const el = bar(); if (el) el.hidden = true; }
  function showBar() { const el = bar(); if (el) el.hidden = false; }

  function syncToggles() {
    const current = readConsent() || {};
    document.querySelectorAll('#ap-privacy-panel .ap-privacy-panel__toggle[data-ap-privacy-cat]').forEach((cb) => {
      cb.checked = !!current[cb.dataset.apPrivacyCat];
    });
  }

  function openPreferences() {
    build();
    const p = panel();
    if (!p) return;
    lastFocus = document.activeElement;
    syncToggles();
    p.hidden = false;
    requestAnimationFrame(() => p.classList.add('is-open'));
    const first = p.querySelector('.ap-privacy-panel__dialog ' + FOCUSABLE);
    if (first) first.focus();
  }

  function closePreferences() {
    const p = panel();
    if (!p || p.hidden) return;
    p.classList.remove('is-open');
    p.hidden = true;
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
  }

  function save(choice) {
    writeConsent(choice);
    hideBar();
    closePreferences();
  }

  function build() {
    if (built) return;
    if (!bar()) buildConsentUI();
    built = true;

    document.addEventListener('keydown', (e) => {
      const p = panel();
      if (!p || p.hidden) return;
      if (e.key === 'Escape') { closePreferences(); return; }
      // Trampa de foco dentro del modal (el aviso NO atrapa foco a propósito)
      if (e.key !== 'Tab') return;
      const f = Array.from(p.querySelectorAll('.ap-privacy-panel__dialog ' + FOCUSABLE));
      if (!f.length) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
  }

  apPrivacy.openPreferences = openPreferences;

  // Delegación única para todos los disparadores (aviso, modal, pie de página,
  // enlace de politicas.html). Funciona aunque el centinela de css no esté.
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-ap-privacy]')) {
      e.preventDefault();
      openPreferences();
      return;
    }
    const act = e.target.closest('[data-ap-privacy-act]');
    if (!act) return;
    const kind = act.dataset.apPrivacyAct;
    if (kind === 'accept') save({ analytics: true, marketing: true });
    else if (kind === 'reject') save({ analytics: false, marketing: false });
    else if (kind === 'close') closePreferences();
    else if (kind === 'save') {
      const choice = {};
      document.querySelectorAll('#ap-privacy-panel .ap-privacy-panel__toggle[data-ap-privacy-cat]').forEach((cb) => {
        choice[cb.dataset.apPrivacyCat] = cb.checked;
      });
      save(choice);
    }
  });

  // Pinta el aviso solo si css ya publicó AB-L3.
  const cssReady = getComputedStyle(document.documentElement)
    .getPropertyValue('--ap-privacy-ui').trim() === 'ready';
  if (cssReady) {
    build();
    if (!decided) showBar();
  }
}

initMobileMenu();
initSearch();
bindRail('cat-track', 'cat-prev', 'cat-next', '.category-card', 2);
initWhyStats();
initCart();
initFooterYear();
initCatalog();
initLashPicker();
initPoliciesAccordion();
initConfirmationState();
initCookieConsent();
