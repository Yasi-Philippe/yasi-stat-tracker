// Renders the SVG brand marks in build/brand into every PNG size the shells need.
// Usage: node scripts/render-icons.mjs [--android]   (uses Chrome from ~/.cache/puppeteer or CHROME_PATH)
//   --android  only the Android resources
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import puppeteer from 'puppeteer-core';

const root = new URL('..', import.meta.url).pathname;
const brand = (name) => readFileSync(join(root, 'build/brand', name), 'utf8');

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const base = join(homedir(), '.cache/puppeteer/chrome');
  for (const v of existsSync(base) ? readdirSync(base).sort().reverse() : []) {
    const p = join(base, v, 'chrome-linux64/chrome');
    if (existsSync(p)) return p;
  }
  throw new Error('Chrome not found: set CHROME_PATH');
}

const targets = process.argv.includes('--android') ? [] : [
  ...[16, 32, 48, 64, 128, 256, 512].map((s) => ({ svg: 'mark.svg', size: s, out: `build/icons/${s}x${s}.png` })),
  { svg: 'mark.svg', size: 512, out: 'build/icon.png' },
  { svg: 'mark.svg', size: 192, out: 'public/icon-192.png' },
];

// Android resources, when the Android project exists.
const res = join(root, 'android/app/src/main/res');
if (existsSync(res)) {
  const densities = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
  for (const [d, k] of Object.entries(densities)) {
    targets.push({ svg: 'mark.svg', size: 48 * k, out: `android/app/src/main/res/mipmap-${d}/ic_launcher.png` });
    targets.push({ svg: 'mark.svg', size: 48 * k, out: `android/app/src/main/res/mipmap-${d}/ic_launcher_round.png`, round: true });
    targets.push({ svg: 'mark-foreground.svg', size: 108 * k, out: `android/app/src/main/res/mipmap-${d}/ic_launcher_foreground.png` });
    targets.push({ svg: 'mark-mono.svg', size: 108 * k, out: `android/app/src/main/res/mipmap-${d}/ic_launcher_monochrome.png` });
    targets.push({ svg: 'mark-notification.svg', size: 24 * k, out: `android/app/src/main/res/drawable-${d}/ic_stat_trazo.png` });
  }
}

const browser = await puppeteer.launch({ executablePath: findChrome(), headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
for (const t of targets) {
  const svg = brand(t.svg).replace('<svg ', `<svg width="${t.size}" height="${t.size}" `);
  const clip = t.round ? `clip-path:circle(50%);` : '';
  await page.setViewport({ width: t.size, height: t.size, deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent"><div style="width:${t.size}px;height:${t.size}px;${clip}">${svg}</div></body></html>`);
  mkdirSync(dirname(join(root, t.out)), { recursive: true });
  await page.screenshot({ path: join(root, t.out), omitBackground: true });
}
await browser.close();
console.log(`Rendered ${targets.length} icons`);
