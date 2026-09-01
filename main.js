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

// Mercado Pago (Fase 2, LatAm/Perú — AP-B5). Clave PÚBLICA de prueba, formato
// corregido por Paul 2026-08-10 (el briefing original traía el prefijo inválido
// `APP_USR-TEST-...` — `APP_USR-` es producción y `TEST-` es test, combinarlos
// no es un formato real de Mercado Pago; probable causa raíz del Brick mudo).
// A diferencia de MP_ACCESS_TOKEN (backend, secreta), esta va expuesta en el
// cliente a propósito. PENDIENTE: swap a la clave pública real de producción
// (APP_USR-..., no TEST-...) antes de lanzar.
const MP_PUBLIC_KEY = 'TEST-547dad31-b803-4d01-bc8a-0ada2b986f62';

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

// Monta el Card Payment Brick dentro de `container` (ya insertado en el DOM
// por initPaymentGateway). `orderId`/`amount` vienen de POST /api/mp/create-order
// — el Brick nunca decide el importe, solo lo muestra (initialization.amount).
async function mountMercadoPagoBrick(container, errorEl, orderId, amount) {
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
      onSubmit: (payload) => new Promise((resolve, reject) => {
        const formData = (payload && payload.formData) || payload || {};
        // Solo orderId + datos de tarjeta tokenizados: el importe SIEMPRE lo
        // resuelve el servidor desde el pedido (AP-B5, invariante 1) — nunca
        // se manda transaction_amount/installments del formData del Brick.
        const payload = {
          orderId,
          token: formData.token,
          issuer_id: formData.issuer_id,
          payment_method_id: formData.payment_method_id,
          payer: { email: formData.payer?.email },
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

  const summary = btnCheckout.closest('.cart-summary');
  if (!summary) return;

  const cart = readCart();
  const items = cart.items.filter((i) => i.qty > 0).map((i) => ({ id: i.id, quantity: i.qty }));
  if (items.length === 0) return; // carrito vacío: se resuelve al recargar con items

  // NO uso `.hidden` aquí: `.cart-summary__checkout`/`.cart-summary__secure` ya
  // traen `display:flex` propio en style.css, que gana por especificidad sobre
  // la regla `[hidden]{display:none}` del user-agent (mismo bug documentado en
  // AP Beauty catálogo — `.cat-item[hidden]`/`.accordion-panel[hidden]` existen
  // ahí por esto). Clase `.is-hidden-mp` a definir por css (pedido en su inbox).
  btnCheckout.classList.add('is-hidden-mp');
  // Copy "Pago seguro gestionado por Stripe" no aplica a este mercado — la
  // oculto en vez de reescribirla (el texto es dominio de front/copy, no mío).
  // Solicitud dejada en inbox/front.md: versión de este texto agnóstica de proveedor.
  const secure = summary.querySelector('.cart-summary__secure');
  if (secure) secure.classList.add('is-hidden-mp');

  const container = document.createElement('div');
  container.id = 'cardPaymentBrick_container';
  container.className = 'mp-brick-container';
  btnCheckout.insertAdjacentElement('afterend', container);

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

    await mountMercadoPagoBrick(container, errorEl, order.orderId, order.amount);
  } catch (err) {
    console.error('Mercado Pago — no se pudo iniciar el checkout:', err);
    showMpError(errorEl, 'No se pudo cargar el pago. Recarga la página o inténtalo más tarde.');
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

// 5b · Catálogo — Línea de Individuales (pestañas): selector de diseño + talla (AB-J9)
// Un producto (#individuales), 5 diseños (.lash-swatch), tallas por diseño. Mantiene los data-*
// del botón .add-to-cart sincronizados con la selección activa en todo momento (initCart lee
// btn.dataset en el clic). Contrato completo en el comentario <!-- CONTRATO JS --> de catalogo.html.
function initLashPicker() {
  const article = document.getElementById('individuales');
  if (!article) return; // solo existe en catalogo.html

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
    const unica = swatch.dataset.tallas === 'unica';
    const btn = activeSizeBtn();
    const size = unica || !btn ? 'unica' : btn.dataset.size;
    const sizeLabel = unica ? 'Talla única' : 'Talla ' + size;

    addBtn.dataset.id = 'individuales-' + swatch.dataset.slug + '-' + size;
    addBtn.dataset.name = 'Individuales · ' + swatch.dataset.cartName + ' · ' + sizeLabel;
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
      media.alt = 'Pestañas individuales ' + swatch.dataset.cartName + ' de AP Beauty en su estuche';
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

  // Alinear el botón con el estado inicial servido por front (Icónica / M)
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
