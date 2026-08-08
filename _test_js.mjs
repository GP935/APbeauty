import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage();
const logs = [];
page.on('console', (msg) => logs.push(`[console] ${msg.type()}: ${msg.text()}`));
page.on('pageerror', (err) => logs.push(`[pageerror] ${err.message}`));

async function report(label, fn) {
  try {
    const r = await fn();
    console.log(`OK  ${label} ->`, JSON.stringify(r));
  } catch (e) {
    console.log(`FAIL ${label} ->`, e.message);
  }
}

// --- 1. Desktop dropdown SERVICIOS en index.html ---
await page.setViewportSize({ width: 1280, height: 900 });
await page.goto('http://localhost:8123/index.html');

await report('dropdown cerrado inicialmente', async () => {
  const hidden = await page.locator('#servicios-menu').isHidden();
  const expanded = await page.locator('#btn-servicios').getAttribute('aria-expanded');
  return { hidden, expanded };
});

await page.locator('#btn-servicios').click();
await report('dropdown abre al click', async () => {
  const hidden = await page.locator('#servicios-menu').isHidden();
  const expanded = await page.locator('#btn-servicios').getAttribute('aria-expanded');
  return { hidden, expanded };
});

// click fuera cierra
await page.mouse.click(10, 10);
await report('dropdown cierra al click fuera', async () => {
  const hidden = await page.locator('#servicios-menu').isHidden();
  const expanded = await page.locator('#btn-servicios').getAttribute('aria-expanded');
  return { hidden, expanded };
});

// abre y cierra con Esc
await page.locator('#btn-servicios').click();
await page.keyboard.press('Escape');
await report('dropdown cierra con Esc', async () => {
  const hidden = await page.locator('#servicios-menu').isHidden();
  const expanded = await page.locator('#btn-servicios').getAttribute('aria-expanded');
  const focused = await page.evaluate(() => document.activeElement.id);
  return { hidden, expanded, focused };
});

// --- 2. Grupo móvil SERVICIOS ---
await page.setViewportSize({ width: 400, height: 800 });
await page.reload();
await page.locator('#btn-menu').click();
await report('menu móvil abierto', async () => page.locator('#menu-panel').isVisible());

await report('grupo servicios cerrado inicialmente', async () => {
  const hidden = await page.locator('#menu-servicios-panel').isHidden();
  const expanded = await page.locator('#btn-menu-servicios').getAttribute('aria-expanded');
  return { hidden, expanded };
});

await page.locator('#btn-menu-servicios').click();
await report('grupo servicios abre', async () => {
  const hidden = await page.locator('#menu-servicios-panel').isHidden();
  const expanded = await page.locator('#btn-menu-servicios').getAttribute('aria-expanded');
  const visible = await page.locator('#menu-servicios-panel a', { hasText: 'Novias' }).isVisible();
  return { hidden, expanded, visible };
});

await page.locator('#btn-menu-servicios').click();
await report('grupo servicios cierra tras 2º click (bug transitionend)', async () => {
  await page.waitForTimeout(600); // más que el timeout de transición típico, por si acaso
  const hidden = await page.locator('#menu-servicios-panel').isHidden();
  const expanded = await page.locator('#btn-menu-servicios').getAttribute('aria-expanded');
  return { hidden, expanded };
});

// re-abrir para confirmar que no quedó "roto"
await page.locator('#btn-menu-servicios').click();
await report('grupo servicios reabre tras cerrar', async () => {
  const hidden = await page.locator('#menu-servicios-panel').isHidden();
  return { hidden };
});

// --- 3. Catálogo: aterrizaje exacto con ?cat=&#id ---
await page.setViewportSize({ width: 1280, height: 900 });
await page.goto('http://localhost:8123/catalogo.html?cat=ojos#power-lash');
await page.waitForTimeout(300);
await report('catalogo: aterrizaje en #power-lash', async () => {
  const target = page.locator('#power-lash');
  const box = await target.boundingBox();
  const scrollY = await page.evaluate(() => window.scrollY);
  const hidden = await target.isHidden();
  return { hidden, scrollY, boxTop: box ? Math.round(box.y) : null };
});

console.log('---console/page logs---');
logs.forEach((l) => console.log(l));

await browser.close();
