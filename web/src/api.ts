import type { AgentEvent } from '../../server/agent/events';

export type { AgentEvent };

export interface User { userId: string; email: string; businessId: string; role: 'owner' | 'procurement' | 'accountant'; displayName: string }
export interface AppConfig {
  appName: string; agentName: string; demoMode: boolean; allowUnprotected: boolean; model: string;
  armoriqConfigured: boolean; armoriqConsoleUrl: string; approvalWaitSeconds: number; requireAccessCode: boolean;
  voiceEnabled: boolean;
}
export interface PoItem { item_id: string; item_name: string; unit: string; quantity: number; unit_price: number; line_total: number }
export interface PurchaseOrder {
  order_id: string; supplier_name: string; items: PoItem[]; total: number;
  status: 'draft' | 'approved' | 'committed' | 'rejected'; created_by: string; created_by_id: string;
  approved_by: string | null; approval_id: string | null; approval_expires_at: string | null; commit_reference: string | null;
}
export interface ActivityRow {
  id: number; user_name: string | null; source: 'armoriq' | 'domain' | 'app'; action: string;
  decision: 'allowed' | 'held' | 'approved' | 'blocked' | 'failed' | 'completed' | 'info'; reason: string; payload_summary: string; created_at: string;
}

export interface PolicyCheckRow {
  label: string; email: string; identity: string; tool: string;
  expect: 'allowed' | 'held' | 'blocked' | 'error'; decision: 'allowed' | 'held' | 'blocked' | 'error'; reason: string; pass: boolean;
}
export interface PolicyCheck { ok: boolean; error?: string; results: PolicyCheckRow[] }

export interface ChatSummary { chatId: string; title: string; turns: number; startedAt: string; updatedAt: string }
export interface StoredTurn { id: string; message: string; protected: boolean; events: AgentEvent[]; error: string | null; created_at: string }

/** localStorage that never throws (private windows, blocked storage). Used only to remember the open conversation. */
export const store = {
  get(key: string): string | null {
    try { return localStorage.getItem(key); } catch { return null; }
  },
  set(key: string, value: string) {
    try { localStorage.setItem(key, value); } catch { /* ignore */ }
  },
  remove(key: string) {
    try { localStorage.removeItem(key); } catch { /* ignore */ }
  },
};
export const chatKey = (userId: string) => `orq.chat.${userId}`;

export class ApiError extends Error {}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, ...init });
  const body = res.headers.get('content-type')?.includes('application/json') ? await res.json() : null;
  if (!res.ok) throw new ApiError(body?.error ?? `Request failed (${res.status})`);
  return body as T;
}

export const api = {
  config: () => request<AppConfig>('/api/config'),
  me: () => request<{ user: User }>('/api/me'),
  demoUsers: () => request<Array<{ email: string; role: User['role']; display_name: string }>>('/api/demo/users'),
  login: (email: string, code?: string) => request<{ user: User }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, code }) }),
  logout: () => request('/api/auth/logout', { method: 'POST' }),
  overview: () => request<any>('/api/overview'),
  order: (id: string) => request<PurchaseOrder>(`/api/purchase-orders/${encodeURIComponent(id)}`),
  approve: (id: string) => request<{ approval_id: string; order: PurchaseOrder }>(`/api/purchase-orders/${encodeURIComponent(id)}/approve`, { method: 'POST' }),
  reject: (id: string) => request<{ order: PurchaseOrder }>(`/api/purchase-orders/${encodeURIComponent(id)}/reject`, { method: 'POST' }),
  activity: () => request<ActivityRow[]>('/api/activity'),
  chats: () => request<ChatSummary[]>('/api/chats'),
  chat: (chatId: string) => request<{ chatId: string; turns: StoredTurn[] }>(`/api/chats/${encodeURIComponent(chatId)}`),
  reset: () => request('/api/demo/reset', { method: 'POST' }),
  policyCheck: () => request<PolicyCheck>('/api/armoriq/policy-check', { method: 'POST' }),
};

/** POST a chat message and stream AgentEvents (server-sent events over fetch). */
export async function streamChat(
  body: { message: string; chatId: string; unprotected?: boolean },
  onEvent: (e: AgentEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch('/api/chat', {
    method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
  });
  if (!res.ok || !res.body) {
    const err = await res.json().catch(() => null);
    throw new ApiError(err?.error ?? `Chat failed (${res.status})`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of frame.split('\n')) {
        if (line.startsWith('data: ')) {
          try {
            onEvent(JSON.parse(line.slice(6)) as AgentEvent);
          } catch {
            /* ignore malformed frame */
          }
        }
      }
    }
  }
}

/** Random id that also works in browsers without crypto.randomUUID (older Safari/Chrome, insecure contexts). */
export function newId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Speech-to-text through our server (ElevenLabs key never reaches the browser). */
export async function transcribe(audio: Blob): Promise<{ text: string; language: string | null }> {
  const res = await fetch('/api/voice/transcribe', {
    method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': audio.type || 'audio/webm' }, body: audio,
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(body?.error ?? `Transcription failed (${res.status})`);
  return body;
}

/** Text-to-speech through our server. Plays one reply at a time. */
let current: HTMLAudioElement | null = null;
export async function speak(text: string): Promise<HTMLAudioElement> {
  const res = await fetch('/api/voice/speak', {
    method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ApiError(body?.error ?? `Speech failed (${res.status})`);
  }
  const url = URL.createObjectURL(await res.blob());
  current?.pause();
  const audio = new Audio(url);
  audio.addEventListener('ended', () => URL.revokeObjectURL(url));
  current = audio;
  await audio.play();
  return audio;
}
export function stopSpeaking() {
  current?.pause();
  current = null;
}

export const kes = (n: number) => `KSh ${Math.round(n).toLocaleString('en-KE')}`;
