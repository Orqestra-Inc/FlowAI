import { describe, expect, it } from 'vitest';
import { createVoice, speakableText, VoiceError } from '../server/voice.js';

function recorder(response: Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return response.clone();
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const opts = { apiKey: 'xi_test_key', sttModel: 'scribe_v2', ttsModel: 'eleven_multilingual_v2', voiceId: 'voice123' };

describe('ElevenLabs voice', () => {
  it('transcribes: multipart with file + model_id, key in xi-api-key header', async () => {
    const r = recorder(new Response(JSON.stringify({ text: ' Which items are low? ', language_code: 'eng' }), { status: 200 }));
    const voice = createVoice({ ...opts, fetchImpl: r.fetchImpl });
    const out = await voice.transcribe(Buffer.alloc(5000, 1), 'audio/webm;codecs=opus');
    expect(out).toEqual({ text: 'Which items are low?', language: 'eng' });
    expect(r.calls[0].url).toBe('https://api.elevenlabs.io/v1/speech-to-text');
    expect((r.calls[0].init.headers as Record<string, string>)['xi-api-key']).toBe('xi_test_key');
    const form = r.calls[0].init.body as FormData;
    expect(form.get('model_id')).toBe('scribe_v2');
    expect((form.get('file') as File).name).toBe('request.webm');
  });

  it('speaks: plain text (no markdown) to the configured voice and model', async () => {
    const r = recorder(new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'audio/mpeg' } }));
    const voice = createVoice({ ...opts, fetchImpl: r.fetchImpl });
    const out = await voice.speak('**Kisumu Wholesale**: KSh 131,200.\n\n- Draft created');
    expect(out.contentType).toBe('audio/mpeg');
    expect(new Uint8Array(out.audio)).toEqual(new Uint8Array([1, 2, 3]));
    expect(r.calls[0].url).toBe('https://api.elevenlabs.io/v1/text-to-speech/voice123?output_format=mp3_44100_128');
    const body = JSON.parse(String(r.calls[0].init.body));
    expect(body).toEqual({ text: 'Kisumu Wholesale: 131,200 shillings. Draft created', model_id: 'eleven_multilingual_v2' });
  });

  it('turns provider failures into clear errors and rejects empty audio', async () => {
    const r = recorder(new Response(JSON.stringify({ detail: { status: 'invalid_api_key' } }), { status: 401 }));
    const voice = createVoice({ ...opts, fetchImpl: r.fetchImpl });
    await expect(voice.transcribe(Buffer.alloc(5000), 'audio/webm')).rejects.toThrow('ElevenLabs rejected the request');
    await expect(voice.transcribe(Buffer.alloc(0), 'audio/webm')).rejects.toBeInstanceOf(VoiceError);
    expect(r.calls).toHaveLength(1); // empty audio never reaches ElevenLabs
  });

  it('caps the text sent for speech', () => {
    expect(speakableText('a'.repeat(5000)).length).toBe(1500);
  });
});
