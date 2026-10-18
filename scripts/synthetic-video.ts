/**
 * Records a SILENT demo video from the app's built-in demo mode (scripted model, simulated ArmorIQ decisions),
 * timed to the narration sections in scripts/narrate.ts, so `npm run narrate -- <file>` adds the voice.
 *
 *   npm run build && npm run preview          # in one terminal (demo mode on :8790)
 *   npx tsx scripts/synthetic-video.ts        # writes out/synthetic/orqestra-demo-silent.mp4
 *
 * The video carries a permanent label saying the decisions are simulated. ArmorIQ console scenes show your own
 * screenshots from out/synthetic/shots/: policy.png (your policy in Policy Studio) and console.png (any console page).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromium, type Page } from 'playwright';

const APP = process.env.DEMO_URL ?? 'http://localhost:8790';
const OUT = path.resolve('out/synthetic');
const SHOTS = path.join(OUT, 'shots');
const W = 1440;
const H = 900;
const END = 275; // seconds; matches the end of the last narration section
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (m: string) => console.log(`[synthetic] ${m}`);

function run(cmd: string, args: string[]) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} failed: ${(r.stderr || '').slice(-800)}`);
}

const LABEL = () => {
  const add = () => {
    if (document.getElementById('__demo_label')) return;
    const l = document.createElement('div');
    l.id = '__demo_label';
    l.textContent = 'Recorded in demo mode';
    l.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:2147483646;font:500 11px system-ui,sans-serif;color:#fff;background:rgba(23,32,43,.45);padding:4px 8px;border-radius:999px;pointer-events:none';
    document.documentElement.appendChild(l);
    const c = document.createElement('div');
    c.id = '__demo_cursor';
    c.style.cssText = 'position:fixed;left:-50px;top:-50px;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;background:rgba(23,32,43,.35);border:2px solid #fff;box-shadow:0 1px 6px rgba(0,0,0,.35);pointer-events:none;z-index:2147483647;transition:transform .12s';
    document.documentElement.appendChild(c);
    addEventListener('mousemove', (e) => { c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px'; }, true);
    addEventListener('mousedown', () => { c.style.transform = 'scale(.7)'; }, true);
    addEventListener('mouseup', () => { c.style.transform = 'scale(1)'; }, true);
  };
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', add);
  else add();
};

async function point(page: Page, sel: string, nth = 0) {
  if ((await page.locator(sel).count()) <= nth) return;
  const el = page.locator(sel).nth(nth);
  await el.scrollIntoViewIfNeeded().catch(() => {});
  const b = await el.boundingBox({ timeout: 3000 }).catch(() => null);
  if (b) await page.mouse.move(b.x + b.width / 2, b.y + Math.min(24, b.height / 2), { steps: 20 });
  await sleep(300);
}
async function click(page: Page, sel: string, nth = 0) {
  await page.locator(sel).nth(nth).waitFor({ timeout: 20_000 });
  await point(page, sel, nth);
  await page.locator(sel).nth(nth).click();
}
async function clickText(page: Page, sel: string, text: string | RegExp) {
  const el = page.locator(sel, { hasText: text }).first();
  await el.waitFor({ timeout: 20_000 });
  await el.scrollIntoViewIfNeeded();
  const b = await el.boundingBox();
  if (b) await page.mouse.move(b.x + b.width / 2, b.y + Math.min(24, b.height / 2), { steps: 20 });
  await sleep(300);
  await el.click();
}
async function hoverAll(page: Page, sel: string, ms = 900) {
  const n = await page.locator(sel).count();
  for (let i = 0; i < n; i++) {
    await point(page, sel, i);
    await sleep(ms);
  }
}
const turns = (page: Page) => page.locator('.turn').count();
/** Waits for the reply to a request sent after `before` turns existed. */
async function reply(page: Page, before: number) {
  await page.waitForFunction((n) => {
    const t = document.querySelectorAll('.turn');
    const last = t[t.length - 1];
    return t.length > n && !!last && !last.querySelector('.typing') && !!last.querySelector('.prose');
  }, before, { timeout: 60_000 });
}
async function switchTo(page: Page, name: string) {
  await click(page, '.avatar-btn');
  await page.getByRole('menuitemradio', { name: new RegExp(name) }).click();
  await page.locator('.empty h2').waitFor();
}

/** Full-screen image of one of your own console screenshots, with an honest caption. */
async function showShot(page: Page, file: string, caption: string, seconds: number) {
  const p = path.join(SHOTS, file);
  if (!fs.existsSync(p)) {
    log(`(no ${file} in ${SHOTS}; showing the app instead for this part)`);
    await sleep(seconds * 1000);
    return;
  }
  const data = `data:image/png;base64,${fs.readFileSync(p).toString('base64')}`;
  await page.evaluate(([src, cap, secs]) => {
    const o = document.createElement('div');
    o.id = '__shot';
    o.style.cssText = 'position:fixed;inset:0;z-index:2147483645;background:#0f141c;display:grid;place-items:center;overflow:hidden';
    const img = document.createElement('img');
    img.src = src as string;
    img.style.cssText = `max-width:94%;max-height:86%;box-shadow:0 10px 40px rgba(0,0,0,.5);border-radius:8px;transform:scale(1);transition:transform ${secs}s linear`;
    const c = document.createElement('div');
    c.textContent = cap as string;
    c.style.cssText = 'position:absolute;top:16px;left:50%;transform:translateX(-50%);font:600 14px system-ui,sans-serif;color:#fff;background:rgba(255,255,255,.12);padding:6px 12px;border-radius:999px';
    o.append(img, c);
    document.documentElement.appendChild(o);
    requestAnimationFrame(() => requestAnimationFrame(() => { img.style.transform = 'scale(1.08)'; }));
  }, [data, caption, seconds] as const);
  await sleep(seconds * 1000);
  await page.evaluate(() => document.getElementById('__shot')?.remove());
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const raw = path.join(OUT, 'raw');
  fs.rmSync(raw, { recursive: true, force: true });
  const browser = await chromium.launch({ headless: process.env.HEADED !== '1', executablePath: process.env.DEMO_CHROMIUM || undefined });
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, recordVideo: { dir: raw, size: { width: W, height: H } } });
  await ctx.addInitScript(LABEL);
  await ctx.route('**/api/voice/speak', (r) => r.abort());
  const page = await ctx.newPage();
  const t0 = Date.now();
  const at = async (s: number) => {
    const wait = t0 + s * 1000 - Date.now();
    if (wait > 0) await sleep(wait);
    else if (wait < -3000) log(`running ${(-wait / 1000).toFixed(1)} s behind at ${s}s`);
  };

  await page.goto(APP);
  await page.locator('.account').first().waitFor();
  // Start clean (preview server reseeds on start; this resets mid-session runs too).
  await page.evaluate(async () => {
    await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'owner@baraka.demo' }) });
    await fetch('/api/demo/reset', { method: 'POST' });
    await fetch('/api/auth/logout', { method: 'POST' });
    localStorage.clear();
  });
  await page.reload();
  await page.locator('.account').first().waitFor();

  // 0:00 Problem
  await at(4);
  await hoverAll(page, '.account', 1800);

  // 0:30 Brian restocks
  await at(30);
  await clickText(page, '.account', 'Brian');
  let n = await turns(page);
  await clickText(page, '.suggestion', 'Restock cooking oil');
  await reply(page, n);
  await at(42);
  await point(page, '.options li.is-out');
  await sleep(2500);
  await point(page, '.options li.is-pick');
  await sleep(2500);
  await point(page, '.card.order');
  await sleep(2000);
  await hoverAll(page, '.ledger .slip', 1200);

  // 1:05 Grace approves and places it
  await at(65);
  await switchTo(page, 'Grace');
  n = await turns(page);
  await clickText(page, '.suggestion', 'Orders to approve');
  await reply(page, n);
  await point(page, '.card.order');
  await at(76);
  await page.getByRole('button', { name: 'Approve order' }).first().click();
  await sleep(1500);
  n = await turns(page);
  await page.getByRole('button', { name: /to place it/ }).first().click();
  await reply(page, n);
  await point(page, '.tag-committed');

  // 1:40 Voice: the reply's Listen control
  await at(100);
  await point(page, '.reply-meta .pill', 1);
  await page.locator('.reply-meta .pill').nth(1).click().catch(() => {});
  await sleep(4000);

  // 1:55 The attack
  await at(115);
  await switchTo(page, 'Faith');
  n = await turns(page);
  await clickText(page, '.suggestion', 'Pay this week');
  await page.locator('.notice-hold').first().waitFor({ timeout: 30_000 }).catch(() => {});
  await at(130);
  await hoverAll(page, '.ledger .slip', 1500);
  await reply(page, n);
  await at(150);
  await showShot(page, 'held.png', 'ArmorIQ console · Held Actions (our workspace)', 5);
  await showShot(page, 'plan.png', 'ArmorIQ console · a held plan, waiting for a person', 5);
  await showShot(page, 'audit.png', 'ArmorIQ console · decisions recorded in the Activity log', 5);
  await hoverAll(page, '.ledger .slip.is-blocked', 1500);

  // 3:05 Policy Studio + policy check
  await at(185);
  await showShot(page, 'policy.png', 'Our orqestra-access policy in ArmorIQ Policy Studio', 22);
  await switchTo(page, 'Grace');
  await clickText(page, '.nav button', 'Activity');
  await page.getByRole('button', { name: /Run check|Run again/ }).click();
  await page.locator('.policy-summary').waitFor({ timeout: 60_000 }).catch(() => {});
  await sleep(1500);
  await page.mouse.wheel(0, 400);

  // 4:00 Takeaways
  await at(240);
  for (let i = 0; i < 12; i++) {
    await page.mouse.wheel(0, 180);
    await sleep(1500);
  }
  await at(END);

  const video = page.video();
  await ctx.close();
  await browser.close();
  const webm = await video!.path();
  const out = path.join(OUT, 'orqestra-demo-silent.mp4');
  // Burn in the "simulated" label so it can't be lost (an in-page label can fail to render).
  const font = ['/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', '/usr/share/fonts/TTF/DejaVuSans-Bold.ttf', '/Library/Fonts/Arial Bold.ttf', 'C:/Windows/Fonts/arialbd.ttf'].find((f) => fs.existsSync(f));
  const label = font
    ? `,drawtext=fontfile='${font.replace(/:/g, '\\:')}':text='Recorded in demo mode':fontsize=13:fontcolor=white@0.9:box=1:boxcolor=0x17202b@0.45:boxborderw=6:x=w-tw-16:y=h-th-16`
    : '';
  if (!font) log('No font found for the burned-in label; relying on the in-page label.');
  run('ffmpeg', ['-y', '-v', 'error', '-i', webm, '-t', String(END), '-vf', `fps=30,scale=${W}:${H},setsar=1${label}`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-an', out]);
  log(`Done: ${out}`);
}

main().catch((e) => {
  console.error('[synthetic] Stopped:', e instanceof Error ? e.message : e);
  process.exit(1);
});
