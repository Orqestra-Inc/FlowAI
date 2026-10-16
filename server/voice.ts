/**
 * ElevenLabs voice: speech-to-text for spoken requests, text-to-speech for Flow's replies.
 * The API key stays on the server; the browser only talks to Orqestra.
 *
 * Docs: POST https://api.elevenlabs.io/v1/speech-to-text      (multipart: file, model_id)
 *       POST https://api.elevenlabs.io/v1/text-to-speech/{voice} (json: text, model_id) → audio/mpeg
 */
export interface VoiceOptions {
  apiKey: string;
  sttModel: string;
  ttsModel: string;
  voiceId: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class VoiceError extends Error {
  constructor(message: string, public readonly status = 502) {
    super(message);
    this.name = 'VoiceError';
  }
}

export const MAX_AUDIO_BYTES = 6 * 1024 * 1024; // ~ several minutes of opus; recordings are capped at 60 s in the UI
export const MAX_SPEAK_CHARS = 1_500;

/** Turn Flow's markdown-ish reply into plain sentences for speech. */
export function speakableText(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#+\s*/gm, '')
    .replace(/^\s*([-*•]|\d+\.)\s+/gm, '')
    .replace(/KSh\s?([\d,]+)/g, '$1 shillings')
    .replace(/\n{2,}/g, '. ')
    .replace(/\n/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, MAX_SPEAK_CHARS);
}

async function describeFailure(res: Response): Promise<string> {
  let detail = '';
  try {
    const body = (await res.json()) as any;
    detail = body?.detail?.message ?? body?.detail?.status ?? (typeof body?.detail === 'string' ? body.detail : '') ?? '';
  } catch {
    /* not json */
  }
  if (res.status === 401) return 'ElevenLabs rejected the API key.';
  if (res.status === 429) return 'ElevenLabs rate limit or quota reached. Try again shortly.';
  return `ElevenLabs error ${res.status}${detail ? `: ${detail}` : ''}`;
}

export function createVoice(opts: VoiceOptions) {
  const base = (opts.baseUrl ?? 'https://api.elevenlabs.io').replace(/\/$/, '');
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 30_000;

  return {
    async transcribe(audio: Buffer, mimeType: string): Promise<{ text: string; language: string | null }> {
      if (!audio.length) throw new VoiceError('No audio received.', 400);
      if (audio.length > MAX_AUDIO_BYTES) throw new VoiceError('Recording is too long.', 413);
      const form = new FormData();
      const ext = mimeType.includes('mp4') ? 'mp4' : mimeType.includes('ogg') ? 'ogg' : mimeType.includes('wav') ? 'wav' : 'webm';
      form.append('file', new Blob([new Uint8Array(audio)], { type: mimeType || 'audio/webm' }), `request.${ext}`);
      form.append('model_id', opts.sttModel);
      const res = await doFetch(`${base}/v1/speech-to-text`, {
        method: 'POST',
        headers: { 'xi-api-key': opts.apiKey },
        body: form,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new VoiceError(await describeFailure(res));
      const body = (await res.json()) as { text?: string; language_code?: string };
      return { text: (body.text ?? '').trim(), language: body.language_code ?? null };
    },

    async speak(text: string): Promise<{ audio: ArrayBuffer; contentType: string }> {
      const clean = speakableText(text);
      if (!clean) throw new VoiceError('Nothing to read aloud.', 400);
      const res = await doFetch(`${base}/v1/text-to-speech/${encodeURIComponent(opts.voiceId)}?output_format=mp3_44100_128`, {
        method: 'POST',
        headers: { 'xi-api-key': opts.apiKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
        body: JSON.stringify({ text: clean, model_id: opts.ttsModel }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new VoiceError(await describeFailure(res));
      return { audio: await res.arrayBuffer(), contentType: res.headers.get('content-type') ?? 'audio/mpeg' };
    },
  };
}

export type Voice = ReturnType<typeof createVoice>;
