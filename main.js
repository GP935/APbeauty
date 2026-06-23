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

// 3 · Contador de carrito (en memoria, sin localStorage)
let cartItems = 0;
function renderCart() {
  const el = document.getElementById('cart-count');
  if (el) el.textContent = cartItems;
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

initMobileMenu();
initSearch();
bindRail('cat-track', 'cat-prev', 'cat-next', '.category-card', 2);
initWhyStats();
renderCart();
initFooterYear();
