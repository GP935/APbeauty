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
// `price` SIEMPRE en céntimos enteros (24,90€ → 2490); se formatea a € solo para mostrar.
const CART_KEY = 'ap_cart';

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

// céntimos → "24,90€"
function formatEuros(cents) {
  return (cents / 100).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '€';
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
  if (price) price.textContent = formatEuros(item.price);
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
    if (sub) sub.textContent = formatEuros(subtotal);
  }

  const pageItems = document.getElementById('cart-page-items');
  if (pageItems) {
    renderList(pageItems, cart);
    const pageEmpty = document.getElementById('cart-page-empty');
    const pageLayout = document.getElementById('cart-page-layout');
    const pageSub = document.getElementById('cart-page-subtotal');
    if (pageEmpty) pageEmpty.hidden = hasItems;
    if (pageLayout) pageLayout.hidden = !hasItems;
    if (pageSub) pageSub.textContent = formatEuros(subtotal);
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

  // STUB de checkout — NO cobra en esta pasada (sin Worker / sin Stripe live)
  const btnCheckout = document.getElementById('btn-checkout');
  if (btnCheckout) {
    btnCheckout.addEventListener('click', () => {
      // TODO (fase backend): POST /api/create-checkout-session
      //   body: { items: readCart().items.map((i) => ({ price: i.priceId, quantity: i.qty })) }
      //   → { url } → window.location = url
      window.location.href = 'confirmacion.html';
    });
  }

  // confirmacion.html (éxito) → vaciar carrito al cargar
  if (location.pathname.endsWith('confirmacion.html')) clearCart();

  renderCart();
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

  apply(catFromURL()); // estado inicial enlazable

  pills.forEach((pill) => {
    pill.addEventListener('click', (e) => {
      e.preventDefault();
      const cat = apply(pill.dataset.cat || '');
      history.pushState({ cat }, '', cat ? `catalogo.html?cat=${cat}` : 'catalogo.html');
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

initMobileMenu();
initSearch();
bindRail('cat-track', 'cat-prev', 'cat-next', '.category-card', 2);
initWhyStats();
initCart();
initFooterYear();
initCatalog();
