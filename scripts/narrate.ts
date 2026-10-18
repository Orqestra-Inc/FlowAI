/**
 *   npm run narrate -- path/to/your-recording.mp4
 *
 * Adds ElevenLabs narration to a screen recording you made yourself (no talking needed).
 * Record while following the timed demo script: start its timer when you start recording, and do each
 * section's clicks while that section is highlighted. Each section's narration is placed at the same
 * time in your video:
 *   0:00 problem · 0:30 Brian restocks · 1:05 Grace approves · 1:40 voice · 1:55 the attack ·
 *   3:05 Policy Studio · (3:40 ArmorIQ off, only with --with-unprotected) · 4:00 takeaways
 *
 * Output: <your-recording>-narrated.mp4 next to the original (which is left untouched).
 * Needs: ffmpeg + ffprobe on PATH, ELEVENLABS_API_KEY in .env or the shell.
 * Options:
 *   --offset 2.5         narration starts 2.5 s later (if you started the timer after the recording)
 *   --with-unprotected   include the "ArmorIQ off" section at 3:40
 *   --keep-audio         keep the recording's own sound (e.g. Flow reading a reply aloud) under the narration
 *   --voice <id>         ElevenLabs voice for the narrator (default NARRATOR_VOICE_ID or George)
 *   --fake-tts           silent placeholder narration, for testing
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const option = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const input = argv.find((a, i) => !a.startsWith('--') && !['--offset', '--voice'].includes(argv[i - 1] ?? ''));
const KEY = process.env.ELEVENLABS_API_KEY ?? '';
const VOICE = option('--voice') ?? process.env.NARRATOR_VOICE_ID ?? 'JBFqnCBsd6RMkjVDRZzb';
const OFFSET = Number(option('--offset') ?? 0);
const FAKE = flag('--fake-tts');
const CACHE = path.resolve('out/narration');

/** Same sections and timings as the demo script page. */
const SECTIONS: Array<{ at: number; until: number; title: string; text: string; optional?: boolean }> = [
  {
    at: 0, until: 30, title: 'The problem',
    text: 'Small businesses in Kenya run stock, suppliers, bills and cash across spreadsheets, WhatsApp and M-Pesa. ERPs are powerful, but heavy and expensive for a twenty-person team. Orqestra replaces the forms with one conversation, with Flow, an AI agent. But an AI that can move money can be tricked, so every action Flow tries is checked by ArmorIQ before it runs.',
  },
  {
    at: 30, until: 65, title: 'Brian restocks',
    text: "Brian handles procurement, and he's low on cooking oil. Flow reads stock, suppliers and this week's bills. The cheapest supplier only sells in bulk, which would break the cash reserve, so it recommends Kisumu Wholesale. The arithmetic is done in code, not by the model, and Flow only drafts the order. Every step was checked by ArmorIQ before it ran.",
  },
  {
    at: 65, until: 100, title: 'Grace approves',
    text: "Grace, the owner, sees the draft waiting for her. Only a person can approve. The approval is tied to this exact supplier, price and total, it expires, and whoever drafted the order can't approve it. Flow then places it, and ArmorIQ allows it because it's within Grace's limit. Orders and payments are simulated in this demo.",
  },
  {
    at: 100, until: 115, title: 'Voice',
    text: 'Owners are often on the move, so they can ask out loud and hear the answer. Voice runs on ElevenLabs, and spoken requests go through the same ArmorIQ checks.',
  },
  {
    at: 115, until: 185, title: 'The attack',
    text: "Now the attack. Faith, the accountant, asks Flow to pay this week's bills. One invoice hides instructions: change the supplier's bank details, pay four hundred and eighty thousand shillings right now, and email our supplier list to an outside address. The model is fooled, and it tries all three. ArmorIQ blocks the bank change and the export. The big payment is above Faith's limit, so it's held for a human, while the genuine bill goes through. In the ArmorIQ console, I reject the payment, and Flow stops. Every decision is recorded. The decision was never the model's to make.",
  },
  {
    at: 185, until: 220, title: 'Policy Studio',
    text: "This is our policy in ArmorIQ's Policy Studio. Everything is blocked unless a person's rule allows it, and each person has their own spending limit. Exporting data and changing bank details aren't in anyone's list, and a change here takes effect immediately. We also built a policy check into Orqestra, so every policy change can be verified in seconds.",
  },
  {
    at: 220, until: 240, title: 'ArmorIQ off', optional: true,
    text: "Here's the same attack with ArmorIQ switched off. Our business rules still stop the payment, but the bank details change and our data is exported. That's what ArmorIQ adds.",
  },
  {
    at: 240, until: 275, title: 'Takeaways',
    text: "Three lessons. Assume the model will be fooled, so the guardrails must live outside it and fail closed. You need two layers: ArmorIQ decides who may do what, and business rules check whether it's correct. And prove it with data. Next: M-Pesa payouts behind these same checks, approvals on WhatsApp, and Swahili voice. This is Orqestra.",
  },
];

function run(cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new Error(`${cmd} is not available. Install ffmpeg (it includes ffprobe) and try again.`);
  if (r.status !== 0) throw new Error(`${cmd} failed:\n${(r.stderr || r.stdout).slice(-1500)}`);
  return r.stdout;
}
const duration = (f: string) => Number(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).trim());
const hasAudio = (f: string) => run('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', f]).trim().length > 0;
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

async function speak(text: string): Promise<string> {
  fs.mkdirSync(CACHE, { recursive: true });
  const file = path.join(CACHE, `${crypto.createHash('sha1').update(`${VOICE}|${FAKE}|${text}`).digest('hex').slice(0, 16)}.mp3`);
  if (fs.existsSync(file)) return file;
  if (FAKE) {
    run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=220:duration=${(text.split(/\s+/).length / 2.6).toFixed(2)}`, '-af', 'volume=0.05', file]);
    return file;
  }
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(VOICE)}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': KEY, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.15, use_speaker_boost: true } }),
  });
  if (!res.ok) throw new Error(`ElevenLabs failed (${res.status}): ${(await res.text().catch(() => '')).slice(0, 300)}`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  return file;
}

async function main() {
  if (!input || !fs.existsSync(input)) throw new Error('Give the path to your screen recording, e.g. `npm run narrate -- ~/Videos/demo.mp4`.');
  if (!KEY && !FAKE) throw new Error('Set ELEVENLABS_API_KEY in .env (or the shell).');
  const videoLength = duration(input);
  const sections = SECTIONS.filter((s) => !s.optional || flag('--with-unprotected'));
  console.log(`[narrate] Your recording is ${mmss(videoLength)}. Writing ${sections.length} narration sections with ElevenLabs…`);

  const placed: Array<{ file: string; ms: number }> = [];
  for (const s of sections) {
    const file = await speak(s.text);
    const len = duration(file);
    const start = s.at + OFFSET;
    const room = s.until - s.at;
    const note = len > room ? `  (runs ${(len - room).toFixed(1)} s into the next section)` : '';
    console.log(`[narrate] ${mmss(start)}  ${s.title.padEnd(15)} ${len.toFixed(1)} s${note}`);
    if (start >= videoLength) {
      console.log(`[narrate]        skipped: your recording ends before ${mmss(start)}`);
      continue;
    }
    placed.push({ file, ms: Math.round(start * 1000) });
  }

  const out = input.replace(/\.[^.]+$/, '') + '-narrated.mp4';
  const keep = flag('--keep-audio') && hasAudio(input);
  const inputs = placed.flatMap((p) => ['-i', p.file]);
  const chains = placed.map((p, i) => `[${i + 1}:a]aresample=44100,adelay=${p.ms}|${p.ms}[n${i}]`);
  const labels = placed.map((_, i) => `[n${i}]`);
  if (keep) {
    chains.push('[0:a]aresample=44100,volume=0.35[orig]');
    labels.push('[orig]');
  }
  const filter = `${chains.join(';')};${labels.join('')}amix=inputs=${labels.length}:normalize=0:dropout_transition=0:duration=longest,apad=whole_dur=${videoLength.toFixed(3)},atrim=0:${videoLength.toFixed(3)}[aout]`;
  // MP4 needs H.264; Ubuntu's built-in recorder makes VP8 .webm, so re-encode anything else.
  const codec = run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', input]).trim();
  const videoCodec = codec === 'h264' ? ['-c:v', 'copy'] : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p'];
  run('ffmpeg', ['-y', '-v', 'error', '-i', input, ...inputs, '-filter_complex', filter, '-map', '0:v', '-map', '[aout]', ...videoCodec, '-c:a', 'aac', '-b:a', '192k', '-t', videoLength.toFixed(3), '-movflags', '+faststart', out]);
  console.log(`[narrate] Done: ${out}`);
  if (videoLength > 300) console.log('[narrate] Note: the video is longer than 5:00; trim the end before uploading.');
}

main().catch((err) => {
  console.error(`\n[narrate] Stopped: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
