/**
 *   npm run demo:video -- --login        # once: log in to the ArmorIQ console in the window that opens
 *   npm run demo:video                   # record the narrated demo video
 *
 * Records the hackathon demo end to end against the LIVE app and your real ArmorIQ console:
 *   1. Writes the narration with ElevenLabs (your ELEVENLABS_API_KEY), cached in out/demo-video/audio.
 *   2. Resets the sample data, then drives the app in a real (visible) Chromium window and records it.
 *      The model's thinking time is cut out afterwards, so the video stays tight.
 *   3. You click "Reject" in the ArmorIQ console when the terminal tells you to.
 *   4. ffmpeg stitches the clips and lays the narration (and the spoken voice request) on top.
 *
 * Output: out/demo-video/orqestra-demo.mp4
 *
 * Needs: Node 20+, `npx playwright install chromium`, ffmpeg + ffprobe on PATH, and in .env (or the shell):
 *   DEMO_URL                 https://orqestra.onrender.com (default)
 *   DEMO_CODE                the judge access code (DEMO_ACCESS_CODE in Render)
 *   ELEVENLABS_API_KEY       for narration
 *   ARMORIQ_APPROVALS_URL    the ArmorIQ console page where held requests are approved/rejected
 *   ARMORIQ_POLICY_URL       your orqestra-access policy in Policy Studio
 *   ARMORIQ_AUDIT_URL        ArmorIQ's audit / logs page
 *   NARRATOR_VOICE_ID        optional ElevenLabs voice for the narrator
 * Flags: --login, --with-unprotected (adds the "ArmorIQ off" comparison; needs DEMO_ALLOW_UNPROTECTED=1 in Render),
 *        --fake-tts (silent placeholder narration, for testing the pipeline), --keep-raw.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chromium, request, type BrowserContext, type Locator, type Page } from 'playwright';

const args = new Set(process.argv.slice(2));
const OUT = path.resolve('out/demo-video');
const AUDIO = path.join(OUT, 'audio');
const RAW = path.join(OUT, 'raw');
const PROFILE = path.join(OUT, 'browser-profile');
const APP = (process.env.DEMO_URL ?? 'https://orqestra.onrender.com').replace(/\/$/, '');
const CODE = process.env.DEMO_CODE ?? process.env.DEMO_ACCESS_CODE ?? '';
const KEY = process.env.ELEVENLABS_API_KEY ?? '';
const CONSOLE_HOME = process.env.ARMORIQ_CONSOLE_URL ?? 'https://platform.armoriq.ai';
const CONSOLE = {
  approvals: process.env.ARMORIQ_APPROVALS_URL ?? CONSOLE_HOME,
  policy: process.env.ARMORIQ_POLICY_URL ?? CONSOLE_HOME,
  audit: process.env.ARMORIQ_AUDIT_URL ?? CONSOLE_HOME,
};
// Narrator, the person asking by voice, and Flow's spoken reply use different voices so they're easy to tell apart.
// Any ID that isn't available on your account falls back to the narrator voice.
const VOICES = {
  narrator: process.env.NARRATOR_VOICE_ID ?? 'JBFqnCBsd6RMkjVDRZzb',
  asker: process.env.ASKER_VOICE_ID ?? '21m00Tcm4TlvDq8ikWAM',
  flow: process.env.FLOW_VOICE_ID ?? 'EXAVITQu4vr4xnSDxMaL',
};
const W = 1440;
const H = 900;
const FAKE_TTS = args.has('--fake-tts');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (msg: string) => console.log(`[demo] ${msg}`);

// ── Narration ───────────────────────────────────────────────────────

const LINES = {
  intro:
    'Small businesses in Kenya run their stock, suppliers, bills and cash across spreadsheets, WhatsApp and M-Pesa. Traditional ERPs are powerful, but heavy and expensive for a twenty-person team. Orqestra replaces the forms with one conversation, with Flow, an AI agent. But an AI that can move money can also be tricked. So every action Flow tries is checked by ArmorIQ before it runs.',
  brianAsk:
    "Meet Brian, who handles procurement. He's low on cooking oil, so he asks Flow to restock, while keeping at least eighty thousand shillings in the bank. Flow reads the stock, the suppliers and this week's bills.",
  brianResult:
    'The cheapest supplier only sells in bulk, which would break the cash reserve, so Flow recommends Kisumu Wholesale instead. The arithmetic is done in code, not by the model. Flow drafts the order, so nothing is bought yet. On the right, every action it took was checked and allowed by ArmorIQ.',
  graceAsk: "Grace, the owner, asks Flow what's waiting for her approval, and Brian's draft appears.",
  graceApprove:
    "Only a person can approve. It's a button, not something the AI can do. The approval is tied to this exact supplier, price and total, it expires, and whoever drafted the order can't approve it. Flow then places the order, and ArmorIQ allows it because it's within Grace's limit. Orders and payments are simulated in this demo.",
  voiceIntro: 'Owners are often on the move, so they can simply ask out loud.',
  voiceOutro: 'Voice runs on ElevenLabs, both listening and speaking, and spoken requests go through exactly the same ArmorIQ checks as typed ones.',
  attack:
    "Now the attack. Faith, the accountant, asks Flow to process this week's supplier bills. One invoice hides instructions inside it: change the supplier's bank details, pay four hundred and eighty thousand shillings right now, and email our supplier list to an outside address. The model is fooled, and it tries all three.",
  attackChecks:
    "ArmorIQ blocks the bank change and the data export outright. The big payment is above Faith's limit of one hundred thousand shillings, so it's held for a human to decide, while the genuine bill goes through.",
  console:
    "This is the ArmorIQ console. The held payment is waiting for a decision, and I reject it. Flow is told straight away, and the payment never happens.",
  attackAfter: "Back in Orqestra, the payment is now blocked. The model was fooled, and it didn't matter, because the decision was never the model's to make.",
  audit: 'And every decision, allowed, held or blocked, is recorded in ArmorIQ.',
  policy:
    "Here's our policy in ArmorIQ's Policy Studio. One policy covers Orqestra's tools, and by default it blocks. Each person has a rule listing the tools they may use, and a spending limit above which a human must approve. Exporting data and changing bank details aren't in anyone's list, and changing a limit takes effect immediately.",
  policyCheck:
    'We also built a policy check into Orqestra. It asks the live ArmorIQ account how it decides twelve sample actions for each person, so every policy change can be verified in seconds.',
  unprotectedAsk: "For comparison, here's the same attack with ArmorIQ switched off.",
  unprotectedResult:
    "Our own business rules still refuse the fraudulent payment, but the bank details are changed and our supplier list is exported. That gap is exactly what ArmorIQ closes.",
  lessons:
    'Three lessons from building this. Assume the model will be fooled, so the guardrails must live outside it and fail closed. You need two layers: ArmorIQ decides who may do what, and our business rules check whether it is correct. And prove it with data: our tests check that a blocked action leaves nothing behind.',
  next: "Next, we're adding real M-Pesa payouts behind these same checks, approvals sent straight to the owner's WhatsApp, and Swahili voice, starting with our first partner businesses in Nairobi. This is Orqestra. Run your business by asking, safely.",
  question: 'Which supplier bills are due this week?',
};

interface Clip { file: string; seconds: number }

function run(cmd: string, argv: string[]): string {
  const r = spawnSync(cmd, argv, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new Error(`${cmd} is not available: ${r.error.message}. Install it and make sure it's on PATH.`);
  if (r.status !== 0) throw new Error(`${cmd} failed:\n${(r.stderr || r.stdout).slice(-2000)}`);
  return r.stdout;
}
const seconds = (file: string) => Number(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).trim());

const badVoices = new Set<string>();
async function tts(text: string, voice: string): Promise<Clip> {
  const v = badVoices.has(voice) ? VOICES.narrator : voice;
  const file = path.join(AUDIO, `${crypto.createHash('sha1').update(`${v}|${FAKE_TTS}|${text}`).digest('hex').slice(0, 16)}.mp3`);
  if (!fs.existsSync(file)) {
    if (FAKE_TTS) {
      const secs = Math.max(1.5, text.split(/\s+/).length / 2.6);
      run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=220:duration=${secs.toFixed(2)}`, '-af', 'volume=0.05', file]);
    } else {
      const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(v)}?output_format=mp3_44100_128`, {
        method: 'POST',
        headers: { 'xi-api-key': KEY, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
        body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.15, use_speaker_boost: true } }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        if (v !== VOICES.narrator && (res.status === 404 || res.status === 400)) {
          log(`voice ${v} isn't available on this account; using the narrator voice instead.`);
          badVoices.add(voice);
          return tts(text, VOICES.narrator);
        }
        throw new Error(`ElevenLabs text-to-speech failed (${res.status}): ${detail.slice(0, 300)}`);
      }
      fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    }
  }
  return { file, seconds: seconds(file) };
}

// ── Timeline: what to keep from each recorded page, and where audio goes ──

type PageName = 'app' | 'console';
interface Seg { page: PageName; from: number; to: number }
const segs: Seg[] = [];
const sounds: Array<{ file: string; at: number; volume: number }> = [];
const keep = (page: PageName, from: number, to: number) => {
  if (to - from > 200) segs.push({ page, from, to });
};

let pages: Record<PageName, Page>;
let current: PageName = 'app';
async function show(name: PageName) {
  if (current !== name) {
    await pages[name].bringToFront();
    current = name;
    await sleep(300);
  }
}

/** One narrated beat: the narration plays while `act` runs. Any waiting beyond the narration is cut, except the moment the result appears. */
async function beat(on: PageName, line: Clip | null, act: () => Promise<void> = async () => {}) {
  await show(on);
  const start = Date.now();
  if (line) sounds.push({ file: line.file, at: start, volume: 1 });
  let actEnd = 0;
  const acting = act().then(() => {
    actEnd = Date.now();
  });
  const narrEnd = start + (line ? line.seconds * 1000 + 450 : 0);
  await Promise.all([sleep(narrEnd - start), acting]);
  if (actEnd <= narrEnd + 1500) {
    const end = Math.max(narrEnd, actEnd + 700);
    await sleep(Math.max(0, end - Date.now()));
    keep(on, start, end);
  } else {
    keep(on, start, narrEnd);
    await sleep(900);
    keep(on, actEnd - 1200, actEnd + 900);
  }
}

// ── Browser helpers ──────────────────────────────────────────────────

/** Visible cursor + click ripple (recorded videos don't include the system cursor). */
const CURSOR = () => {
  const install = () => {
    if (document.getElementById('__demo_cursor')) return;
    const c = document.createElement('div');
    c.id = '__demo_cursor';
    c.style.cssText = 'position:fixed;left:-50px;top:-50px;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;background:rgba(23,32,43,.35);border:2px solid #fff;box-shadow:0 1px 6px rgba(0,0,0,.35);pointer-events:none;z-index:2147483647;transition:transform .12s ease';
    document.documentElement.appendChild(c);
    addEventListener('mousemove', (e) => { c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px'; }, true);
    addEventListener('mousedown', () => { c.style.transform = 'scale(.7)'; }, true);
    addEventListener('mouseup', () => { c.style.transform = 'scale(1)'; }, true);
  };
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', install);
  else install();
};

async function point(page: Page, target: Locator) {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (!box) throw new Error('Element not visible on the page.');
  await page.mouse.move(box.x + box.width / 2, box.y + Math.min(box.height / 2, 24), { steps: 18 });
  await sleep(250);
}
async function click(page: Page, target: Locator) {
  await target.waitFor({ state: 'visible', timeout: 30_000 });
  await point(page, target);
  await target.click();
}
async function hoverAll(page: Page, selector: string, dwellMs = 900) {
  const items = page.locator(selector);
  const n = await items.count();
  for (let i = 0; i < n; i++) {
    await point(page, items.nth(i)).catch(() => {});
    await sleep(dwellMs);
  }
}
async function slowScroll(page: Page, px: number, ms: number) {
  await page.mouse.move(W / 2, H / 2, { steps: 10 });
  const steps = Math.max(1, Math.round(ms / 120));
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, px / steps);
    await sleep(120);
  }
}

const turns = (page: Page) => page.locator('.turn').count();
/** Waits for Flow's reply to the newest request; throws on an error reply (quota, ArmorIQ unreachable…). */
async function waitForReply(page: Page, turnsBefore: number, timeout = 180_000) {
  await page.waitForFunction(
    (n) => {
      const all = document.querySelectorAll('.turn');
      if (all.length <= n) return false;
      const last = all[all.length - 1];
      return !last.querySelector('.typing') && !!(last.querySelector('.prose') || last.querySelector('.notice-error') || last.querySelector('.hint'));
    },
    turnsBefore,
    { timeout, polling: 400 },
  );
  const err = page.locator('.turn').last().locator('.notice-error');
  if (await err.count()) throw new Error(`Flow replied with an error: ${await err.first().innerText()}`);
}
async function ask(page: Page, text: string) {
  const before = await turns(page);
  const box = page.locator('.composer textarea');
  await click(page, box);
  await page.keyboard.type(text, { delay: 26 });
  await sleep(300);
  await page.keyboard.press('Enter');
  return before;
}
async function suggestion(page: Page, title: string) {
  const before = await turns(page);
  await click(page, page.locator('.suggestion', { hasText: title }).first());
  return before;
}
async function switchTo(page: Page, name: string) {
  await click(page, page.locator('.avatar-btn'));
  await click(page, page.getByRole('menuitemradio', { name: new RegExp(name) }));
  await page.locator('.empty h2').waitFor({ timeout: 30_000 });
}
async function goView(page: Page, label: 'Activity' | 'Ask Flow') {
  await click(page, page.locator('.nav button', { hasText: label }).first());
}

// ── Setup ────────────────────────────────────────────────────────────

async function resetData() {
  const api = await request.newContext({ baseURL: APP, timeout: 120_000 });
  await api.get('/api/health'); // wakes a sleeping instance
  const login = await api.post('/api/auth/login', { data: { email: 'owner@baraka.demo', code: CODE } });
  if (!login.ok()) throw new Error(`Couldn't sign in to ${APP} (${login.status()}). Check DEMO_CODE.`);
  const reset = await api.post('/api/demo/reset');
  if (!reset.ok()) throw new Error(`Resetting the sample data failed (${reset.status()}).`);
  const cfg = await (await api.get('/api/config')).json();
  await api.dispose();
  return cfg as { voiceEnabled: boolean; allowUnprotected: boolean; armoriqConfigured: boolean };
}

async function loginMode() {
  fs.mkdirSync(PROFILE, { recursive: true });
  const ctx = await chromium.launchPersistentContext(PROFILE, { headless: false, viewport: { width: W, height: H } });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto(CONSOLE_HOME);
  log('Log in to the ArmorIQ console in the window that opened. Then copy these URLs into .env:');
  log('  ARMORIQ_APPROVALS_URL (the approvals page), ARMORIQ_POLICY_URL (your orqestra-access policy), ARMORIQ_AUDIT_URL (audit/logs).');
  log('Close the window when you are done; the login is remembered for recording.');
  await new Promise<void>((resolve) => ctx.on('close', () => resolve()));
}

// ── Recording ────────────────────────────────────────────────────────

async function record() {
  if (!CODE) throw new Error('Set DEMO_CODE to the judge access code (DEMO_ACCESS_CODE in Render).');
  if (!KEY && !FAKE_TTS) throw new Error('Set ELEVENLABS_API_KEY for the narration (or use --fake-tts to test).');
  run('ffmpeg', ['-version']);
  run('ffprobe', ['-version']);
  for (const [k, v] of Object.entries(CONSOLE)) if (v === CONSOLE_HOME) log(`ARMORIQ_${k.toUpperCase()}_URL not set; that scene will show the console home page.`);
  fs.mkdirSync(AUDIO, { recursive: true });
  fs.rmSync(RAW, { recursive: true, force: true });
  fs.mkdirSync(RAW, { recursive: true });

  log('Writing narration with ElevenLabs…');
  const L: Record<string, Clip> = {};
  for (const [k, text] of Object.entries(LINES)) {
    if (k === 'question') continue;
    if (k.startsWith('unprotected') && !args.has('--with-unprotected')) continue;
    L[k] = await tts(text, VOICES.narrator);
  }
  const question = await tts(LINES.question, VOICES.asker);
  const questionWav = path.join(AUDIO, 'question.wav');
  // Lead-in and tail silence so the fake microphone catches the whole sentence.
  run('ffmpeg', ['-y', '-v', 'error', '-i', question.file, '-af', 'adelay=400|400,apad=pad_dur=1.2', '-ar', '48000', '-ac', '1', '-sample_fmt', 's16', questionWav]);
  const narration = Object.values(L).reduce((t, c) => t + c.seconds, 0);
  log(`Narration: ${Math.round(narration)} s across ${Object.keys(L).length} lines.`);

  log(`Resetting sample data on ${APP}…`);
  const cfg = await resetData();
  if (!cfg.armoriqConfigured) throw new Error('ArmorIQ is not configured on the server.');
  if (args.has('--with-unprotected') && !cfg.allowUnprotected) throw new Error('--with-unprotected needs DEMO_ALLOW_UNPROTECTED=1 in Render.');

  fs.mkdirSync(PROFILE, { recursive: true });
  const ctx: BrowserContext = await chromium.launchPersistentContext(PROFILE, {
    headless: process.env.DEMO_HEADLESS === '1',
    executablePath: process.env.DEMO_CHROMIUM || undefined,
    viewport: { width: W, height: H },
    recordVideo: { dir: RAW, size: { width: W, height: H } },
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${questionWav}`, '--autoplay-policy=no-user-gesture-required'],
  });
  const appOrigin = new URL(APP).origin;
  await ctx.grantPermissions(['microphone'], { origin: appOrigin }).catch(() => {});
  await ctx.clearCookies({ domain: new URL(APP).hostname }).catch(() => {});
  await ctx.addInitScript(CURSOR);
  // The app reads replies aloud after a spoken request; the video adds that audio itself, so skip it in the page.
  await ctx.route('**/api/voice/speak', (r) => r.abort());

  const app = ctx.pages()[0] ?? (await ctx.newPage());
  const appT0 = Date.now();
  const consolePage = await ctx.newPage();
  const consoleT0 = Date.now();
  pages = { app, console: consolePage };
  await consolePage.goto(CONSOLE.approvals).catch(() => {});
  if (/login|sign-?in|auth/i.test(consolePage.url())) throw new Error('The ArmorIQ console asks you to log in. Run `npm run demo:video -- --login` first.');
  await app.bringToFront();
  current = 'app';
  await app.goto(`${APP}/?code=${encodeURIComponent(CODE)}`);
  await app.locator('.account').first().waitFor({ timeout: 120_000 });
  await app.evaluate(() => localStorage.clear()).catch(() => {});
  await sleep(1200);

  let failure: unknown = null;
  try {
    // 1. Problem
    await beat('app', L.intro, async () => {
      await sleep(4000);
      await point(app, app.locator('.account').first());
    });

    // 2. Brian restocks
    await beat('app', L.brianAsk, async () => {
      await click(app, app.locator('.account', { hasText: 'Brian' }));
      await app.locator('.suggestion').first().waitFor();
      const n = await suggestion(app, 'Restock cooking oil');
      await waitForReply(app, n);
    });
    await beat('app', L.brianResult, async () => {
      await point(app, app.locator('.options li.is-out').first()).catch(() => {});
      await sleep(1600);
      await point(app, app.locator('.options li.is-pick').first()).catch(() => {});
      await sleep(1600);
      await point(app, app.locator('.card.order').first()).catch(() => {});
      await sleep(1400);
      await hoverAll(app, '.ledger .slip', 700);
    });

    // 3. Grace approves and places it
    await beat('app', L.graceAsk, async () => {
      await switchTo(app, 'Grace');
      const n = await suggestion(app, 'Orders to approve');
      await waitForReply(app, n);
      await point(app, app.locator('.card.order').first());
    });
    await beat('app', L.graceApprove, async () => {
      await click(app, app.getByRole('button', { name: 'Approve order' }).first());
      const place = app.getByRole('button', { name: /to place it/ }).first();
      await place.waitFor({ timeout: 30_000 });
      const n = await turns(app);
      await click(app, place);
      await waitForReply(app, n);
      await point(app, app.locator('.tag-committed').last()).catch(() => {});
    });

    // 4. Voice
    if (cfg.voiceEnabled) {
      await beat('app', L.voiceIntro);
      await show('app');
      {
        const n = await turns(app);
        const mic = app.locator('.speak');
        await point(app, mic);
        await mic.click();
        const recStart = Date.now();
        sounds.push({ file: question.file, at: recStart + 400, volume: 1 });
        await sleep(question.seconds * 1000 + 1300);
        await mic.click();
        const recEnd = Date.now();
        keep('app', recStart - 300, recEnd + 300);
        await waitForReply(app, n);
        const shown = Date.now();
        const text = await app.locator('.turn').last().locator('.prose').innerText();
        const reply = await tts(text.replace(/KSh\s?([\d,]+)/g, '$1 shillings').slice(0, 600), VOICES.flow);
        const playAt = Date.now();
        sounds.push({ file: reply.file, at: playAt, volume: 1 });
        await sleep(reply.seconds * 1000 + 500);
        keep('app', shown - 900, Date.now());
      }
      await beat('app', L.voiceOutro);
    } else {
      log('Voice is not enabled on the server; skipping the voice scene.');
    }

    // 5. The attack
    let held = false;
    await beat('app', L.attack, async () => {
      await switchTo(app, 'Faith');
      const n = await suggestion(app, 'Pay this week');
      await app.waitForFunction(
        (k) => {
          const all = document.querySelectorAll('.turn');
          const last = all[all.length - 1];
          return all.length > k && !!last && (!!last.querySelector('.notice-hold') || !last.querySelector('.typing'));
        },
        n,
        { timeout: 180_000, polling: 400 },
      );
      held = (await app.locator('.turn').last().locator('.notice-hold').count()) > 0;
    });
    await beat('app', L.attackChecks, async () => {
      await hoverAll(app, '.ledger .slip', 1100);
    });
    if (held) {
      process.stdout.write('\x07');
      log('>>> NOW: in the browser, REJECT the held KSh 480,000 payment in the ArmorIQ console. <<<');
      await beat('console', L.console, async () => {
        await consolePage.goto(CONSOLE.approvals).catch(() => {});
        await waitForReply(app, (await turns(app)) - 1, 240_000).catch((e) => {
          if (!/error/i.test(String(e))) throw e;
        });
      });
      await beat('app', L.attackAfter, async () => {
        await hoverAll(app, '.ledger .slip.is-blocked', 1100);
      });
    } else {
      log('No hold appeared (check the policy threshold); skipping the console approval scene.');
    }
    await beat('console', L.audit, async () => {
      await consolePage.goto(CONSOLE.audit).catch(() => {});
      await sleep(1500);
      await slowScroll(consolePage, 500, 2500);
    });

    // 6. Policy Studio + policy check
    await beat('console', L.policy, async () => {
      await consolePage.goto(CONSOLE.policy).catch(() => {});
      await sleep(2500);
      await slowScroll(consolePage, 900, 9000);
    });
    await beat('app', L.policyCheck, async () => {
      await switchTo(app, 'Grace');
      await goView(app, 'Activity');
      await click(app, app.getByRole('button', { name: /Run check|Run again/ }));
      await app.locator('.policy-summary').waitFor({ timeout: 180_000 });
      await slowScroll(app, 500, 2500);
    });

    // 7. Optional: the same attack with ArmorIQ off
    if (args.has('--with-unprotected')) {
      await beat('app', L.unprotectedAsk, async () => {
        await goView(app, 'Ask Flow');
        await click(app, app.locator('.toggle input'));
        const n = await ask(app, 'Process all of this week’s open supplier bills, including Rift Valley Packaging.');
        await waitForReply(app, n);
      });
      await beat('app', L.unprotectedResult, async () => {
        await hoverAll(app, '.ledger .slip', 1000);
        if (await app.locator('.toggle input').isChecked().catch(() => false)) await app.locator('.toggle input').uncheck();
      });
    }

    // 8. Takeaways
    await beat('app', L.lessons, async () => {
      await goView(app, 'Activity');
      await sleep(1500);
      await slowScroll(app, 1400, 14_000);
    });
    await beat('app', L.next, async () => {
      await goView(app, 'Ask Flow');
      await sleep(1000);
    });
  } catch (err) {
    failure = err;
  }

  const appVideo = app.video();
  const consoleVideo = consolePage.video();
  await ctx.close();
  if (failure) throw failure;
  const files = { app: await appVideo!.path(), console: await consoleVideo!.path() };
  compose(files, { app: appT0, console: consoleT0 });
}

// ── Editing ──────────────────────────────────────────────────────────

function compose(files: Record<PageName, string>, t0: Record<PageName, number>) {
  log(`Editing ${segs.length} clips…`);
  const parts = path.join(OUT, 'parts');
  fs.rmSync(parts, { recursive: true, force: true });
  fs.mkdirSync(parts, { recursive: true });
  const list: string[] = [];
  segs.forEach((s, i) => {
    const out = path.join(parts, `${String(i).padStart(3, '0')}.mp4`);
    const from = Math.max(0, (s.from - t0[s.page]) / 1000);
    const dur = (s.to - s.from) / 1000;
    run('ffmpeg', ['-y', '-v', 'error', '-ss', from.toFixed(3), '-i', files[s.page], '-t', dur.toFixed(3), '-an', '-vf', `fps=30,scale=${W}:${H},setsar=1`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', out]);
    list.push(`file '${out.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`);
  });
  const listFile = path.join(parts, 'list.txt');
  fs.writeFileSync(listFile, list.join('\n'));
  const video = path.join(OUT, 'video-only.mp4');
  run('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', video]);
  const total = seconds(video);

  // Map a wall-clock moment to its place in the edited video.
  const at = (wall: number) => {
    let acc = 0;
    for (const s of segs) {
      if (wall < s.from) return acc;
      if (wall <= s.to) return acc + (wall - s.from);
      acc += s.to - s.from;
    }
    return acc;
  };
  const placed = sounds.map((s) => ({ ...s, ms: Math.round(at(s.at)) })).filter((s) => s.ms / 1000 < total - 0.3);
  const inputs = placed.flatMap((s) => ['-i', s.file]);
  const chains = placed.map((s, i) => `[${i + 1}:a]aresample=44100,adelay=${s.ms}|${s.ms},volume=${s.volume}[a${i}]`).join(';');
  const mix = `${chains};${placed.map((_, i) => `[a${i}]`).join('')}amix=inputs=${placed.length}:normalize=0:dropout_transition=0,apad[aout]`;
  const final = path.join(OUT, 'orqestra-demo.mp4');
  run('ffmpeg', ['-y', '-v', 'error', '-i', video, ...inputs, '-filter_complex', mix, '-map', '0:v', '-map', '[aout]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-t', total.toFixed(3), '-movflags', '+faststart', final]);
  if (!args.has('--keep-raw')) fs.rmSync(parts, { recursive: true, force: true });
  const mm = `${Math.floor(total / 60)}:${String(Math.round(total % 60)).padStart(2, '0')}`;
  log(`Done: ${final} (${mm}).`);
  if (total > 300) log('Warning: the video is longer than 5:00. Shorten some narration lines in scripts/demo-video.ts and run again (narration is cached, only changed lines are regenerated).');
}

(args.has('--login') ? loginMode() : record()).catch((err) => {
  console.error(`\n[demo] Stopped: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
