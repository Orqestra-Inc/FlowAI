import { ArmorIQClient } from '@armoriq/sdk';
import { ArmorIQLangChain } from '@armoriq/sdk/dist/integrations/langchain';
import { armoriqKeyLooksValid, config } from './config.js';

export interface GuardStatus {
  configured: boolean;
  ok: boolean;
  org?: string;
  agents?: string[];
  mcps?: string[];
  agentRegistered?: boolean;
  mcpRegistered?: boolean;
  error?: string;
}

let client: ArmorIQClient | null = null;
let guard: ArmorIQLangChain | null = null;

/** One ArmorIQ client + LangChain adapter per process. Null when no key is configured (requests then fail closed). */
export function getGuard(): ArmorIQLangChain | null {
  if (!armoriqKeyLooksValid()) return null;
  if (!guard) {
    client = new ArmorIQClient({ apiKey: config.armoriqApiKey, agentId: config.armoriqAgentName });
    guard = new ArmorIQLangChain({
      client,
      mode: 'sdk',
      defaultMcpName: config.armoriqMcpName,
      approvalWaitSeconds: config.approvalWaitSeconds,
      approvalPollInterval: 3,
    });
  }
  return guard;
}

function names(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return list.map((e: any) => String(e?.name ?? e?.mcp_name ?? e?.agent_name ?? '?'));
}

/** Read-only check: key valid, and the agent and MCP names we use are registered (a mismatch fails silently otherwise). */
export async function checkGuard(): Promise<GuardStatus> {
  const g = getGuard();
  if (!g) return { configured: false, ok: false, error: 'ARMORIQ_API_KEY is missing or malformed (expected ak_live_ / ak_test_).' };
  try {
    const account = await g.bootstrap();
    const agents = names(account.agents);
    const mcps = names(account.mcps);
    return {
      configured: true,
      ok: true,
      org: account.org?.name ?? account.organization?.name,
      agents,
      mcps,
      agentRegistered: agents.includes(config.armoriqAgentName),
      mcpRegistered: mcps.includes(config.armoriqMcpName),
    };
  } catch (err) {
    return { configured: true, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
