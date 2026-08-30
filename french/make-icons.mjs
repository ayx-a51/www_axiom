#!/usr/bin/env node
/**
 * Rendert das App-Logo (siehe LOGO in index.html) als PNG-Dateien:
 *   french/apple-touch-icon.png  180×180  (Startbildschirm iOS/Android)
 *   french/favicon.png            64×64   (Browser-Tab)
 *
 * Nutzung:  node french/make-icons.mjs
 * Braucht Playwright (nur zum Rendern, nicht zur Laufzeit der App).
 * Bei einer Logo-Änderung: MARK unten anpassen und neu ausführen.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (e) {
  console.error('Playwright fehlt. Einmalig installieren:  npm install playwright');
  process.exit(1);
}

const DIR = dirname(fileURLToPath(import.meta.url));
const FONT = pathToFileURL(join(DIR, 'manrope.woff2')).href;
const COLOR = '#EE6C4D';     // Grundfarbe des Icons (Themenfarbe «coral»)

// Gleiche Zeichnung wie LOGO in index.html: Sprechblase mit «é»
const MARK = `
  <rect width="100" height="100" rx="24" fill="${COLOR}"/>
  <path d="M22 26h56a10 10 0 0 1 10 10v30a10 10 0 0 1-10 10H50L32 90V76h-10a10 10 0 0 1-10-10V36a10 10 0 0 1 10-10z" fill="#fff"/>
  <text x="50" y="67" font-family="Manrope" font-weight="800" font-size="46" fill="${COLOR}" text-anchor="middle">é</text>`;

const page = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  @font-face { font-family: Manrope; src: url('${FONT}') format('woff2'); font-weight: 200 800; }
  html, body { margin: 0; background: transparent; }
  svg { display: block; }
</style></head><body>
  <svg id="mark" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${MARK}</svg>
</body></html>`;

const browser = await chromium.launch();
for (const [file, size] of [['apple-touch-icon.png', 180], ['favicon.png', 64]]) {
  const p = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  await p.setContent(page);
  await p.evaluate((s) => {
    const el = document.getElementById('mark');
    el.setAttribute('width', s);
    el.setAttribute('height', s);
  }, size);
  await p.waitForTimeout(400);          // Schrift laden
  await p.locator('#mark').screenshot({ path: join(DIR, file), omitBackground: true });
  await p.close();
  console.log(file + '  ' + size + '×' + size);
}
await browser.close();
