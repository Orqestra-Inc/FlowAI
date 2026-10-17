import 'dotenv/config';

// Callback handlers must run inline (awaited) so ArmorIQ can stop a tool before
// it executes. Force it before anything from LangChain is loaded.
process.env.LANGCHAIN_CALLBACKS_BACKGROUND = 'false';

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number, got "${raw}"`);
  return value;
}

function flag(name: string): boolean {
  return process.env[name] === '1' || process.env[name] === 'true';
}

const demoMode = flag('DEMO_MODE');

function parseMap(raw: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    const [from, to] = pair.split('=').map((v) => v?.trim().toLowerCase());
    if (from && to) map[from] = to;
  }
  return map;
}

/** The identity ArmorIQ evaluates policy for. Defaults to the user's own email. */
export function armoriqIdentity(email: string): string {
  return config.armoriqIdentityMap[email.toLowerCase()] ?? email;
}

/**
 * Free-tier Gemini quotas are per model, so other current Flash / Flash-Lite models add capacity on the same key.
 * Used only when LLM_FALLBACK_MODELS is unset and the main model is Gemini. Set LLM_FALLBACK_MODELS="" to disable.
 */
const GEMINI_FALLBACKS = ['google-genai:gemini-3.6-flash', 'google-genai:gemini-3.5-flash-lite', 'google-genai:gemini-3.1-flash-lite'];

export function fallbackModels(primary: string, raw: string | undefined): string[] {
  const list = raw === undefined ? (primary.startsWith('google-genai:') ? GEMINI_FALLBACKS : []) : raw.split(',');
  return [...new Set(list.map((m) => m.trim()).filter((m) => m && m !== primary))];
}

export const config = {
  appName: process.env.APP_NAME ?? 'Orqestra',
  /** The business agent's name, as users address it ("Ask Flow"). */
  agentName: process.env.AGENT_NAME ?? 'Flow',
  port: num('PORT', 8787),
  // On Render, RENDER_EXTERNAL_URL is set automatically to the service's public HTTPS URL.
  publicBaseUrl: process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || 'http://localhost:8787',
  sessionSecret: process.env.SESSION_SECRET ?? '',
  databasePath: process.env.DATABASE_PATH ?? './data/orqestra.db',

  llmModel: process.env.LLM_MODEL ?? 'google-genai:gemini-3.8-flash',
  /** Tried in order when the main model is rate-limited, out of quota or overloaded, e.g. "google-genai:gemini-3.5-flash-lite". */
  llmFallbackModels: fallbackModels(process.env.LLM_MODEL ?? 'google-genai:gemini-3.8-flash', process.env.LLM_FALLBACK_MODELS),
  /** Retries for per-minute rate limits and overload, with exponential backoff. 0 disables. */
  llmRetries: num('LLM_RETRIES', 2),

  armoriqApiKey: process.env.ARMORIQ_API_KEY ?? '',
  armoriqAgentName: process.env.ARMORIQ_AGENT_NAME ?? 'orqestra-agent',
  armoriqMcpName: process.env.ARMORIQ_MCP_NAME ?? 'orqestra-erp',
  approvalWaitSeconds: num('APPROVAL_WAIT_SECONDS', 90),
  /**
   * Optional: which identity ArmorIQ sees for each Orqestra user, as "app@email=armoriq@email,...".
   * Use it when Policy Studio member rules only match members of your ArmorIQ organization.
   */
  armoriqIdentityMap: parseMap(process.env.ARMORIQ_IDENTITY_MAP ?? ''),

  mcpBearerToken: process.env.MCP_BEARER_TOKEN ?? '',

  maxToolCalls: num('MAX_TOOL_CALLS', 12),
  maxModelCalls: num('MAX_MODEL_CALLS', 10),
  maxPoAmount: num('MAX_PO_AMOUNT', 300_000),

  /** If set, the demo sign-in screen asks for this code. Share it only with judges and testers. */
  demoAccessCode: process.env.DEMO_ACCESS_CODE ?? '',
  /** Optional hint under the access-code field. Empty by default: share the code (or a ?code= link) privately instead. */
  demoAccessCodeHint: process.env.DEMO_ACCESS_CODE_HINT ?? '',
  /** Protects the model quota on a public demo: chat requests per signed-in browser per hour, and per day overall. */
  chatLimitPerHour: num('CHAT_LIMIT_PER_HOUR', 40),
  chatLimitPerDay: num('CHAT_LIMIT_PER_DAY', 400),

  /** ElevenLabs voice (optional). Without a key, voice controls are hidden. */
  elevenLabsApiKey: process.env.ELEVENLABS_API_KEY ?? '',
  elevenLabsSttModel: process.env.ELEVENLABS_STT_MODEL ?? 'scribe_v2',
  elevenLabsTtsModel: process.env.ELEVENLABS_TTS_MODEL ?? 'eleven_multilingual_v2',
  elevenLabsVoiceId: process.env.ELEVENLABS_VOICE_ID ?? 'JBFqnCBsd6RMkjVDRZzb',
  voiceLimitPerHour: num('VOICE_LIMIT_PER_HOUR', 60),
  voiceLimitPerDay: num('VOICE_LIMIT_PER_DAY', 600),

  demoMode,
  /** Honoured only in demo mode: lets the owner run one request without ArmorIQ. */
  allowUnprotected: demoMode && flag('DEMO_ALLOW_UNPROTECTED'),

  armoriqConsoleUrl: process.env.ARMORIQ_CONSOLE_URL ?? 'https://tools.armoriq.ai',
};

/** True when the ArmorIQ key at least has a valid shape. Real validity is checked at boot. */
export function armoriqKeyLooksValid(): boolean {
  return /^ak_(live|test|claw)_/.test(config.armoriqApiKey);
}
