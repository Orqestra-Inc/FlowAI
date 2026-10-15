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

export const config = {
  appName: process.env.APP_NAME ?? 'Orqestra',
  port: num('PORT', 8787),
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? 'http://localhost:8787',
  sessionSecret: process.env.SESSION_SECRET ?? '',
  databasePath: process.env.DATABASE_PATH ?? './data/orqestra.db',

  llmModel: process.env.LLM_MODEL ?? 'google-genai:gemini-2.5-flash',

  armoriqApiKey: process.env.ARMORIQ_API_KEY ?? '',
  armoriqAgentName: process.env.ARMORIQ_AGENT_NAME ?? 'orqestra-agent',
  armoriqMcpName: process.env.ARMORIQ_MCP_NAME ?? 'orqestra-erp',
  approvalWaitSeconds: num('APPROVAL_WAIT_SECONDS', 90),

  mcpBearerToken: process.env.MCP_BEARER_TOKEN ?? '',

  maxToolCalls: num('MAX_TOOL_CALLS', 12),
  maxModelCalls: num('MAX_MODEL_CALLS', 10),
  maxPoAmount: num('MAX_PO_AMOUNT', 300_000),

  demoMode,
  /** Honoured only in demo mode: lets the owner run one request without ArmorIQ. */
  allowUnprotected: demoMode && flag('DEMO_ALLOW_UNPROTECTED'),

  armoriqConsoleUrl: 'https://platform.armoriq.ai',
};

/** True when the ArmorIQ key at least has a valid shape. Real validity is checked at boot. */
export function armoriqKeyLooksValid(): boolean {
  return /^ak_(live|test|claw)_/.test(config.armoriqApiKey);
}
