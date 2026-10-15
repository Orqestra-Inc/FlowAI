/**
 *   npm run check
 *
 * Read-only. Verifies the three things that otherwise fail SILENTLY:
 *   1. the ArmorIQ key works,
 *   2. the agent and MCP names in .env are the ones registered in ArmorIQ (a mismatch = no policy ever matches),
 *   3. the /mcp discovery endpoint answers with our tools (what ArmorIQ reads when you register it),
 * plus whether the configured model can be loaded.
 */
import { config } from '../server/config.js';
import { checkGuard } from '../server/armoriq.js';
import { getModel } from '../server/model.js';
import { TOOLS } from '../server/tools/registry.js';

const ok = (label: string, msg: string) => console.log(`  ✓ ${label.padEnd(14)} ${msg}`);
const bad = (label: string, msg: string) => {
  console.log(`  ✗ ${label.padEnd(14)} ${msg}`);
  failures += 1;
};
let failures = 0;

async function main() {
  console.log(`\n${config.appName} setup check\n`);

  const g = await checkGuard();
  if (!g.configured) bad('ArmorIQ', g.error ?? 'not configured');
  else if (!g.ok) bad('ArmorIQ', `key rejected or unreachable: ${g.error}`);
  else {
    ok('ArmorIQ', `connected (org ${g.org ?? 'unknown'})`);
    console.log(`    agents: ${g.agents?.join(', ') || 'none registered'}`);
    console.log(`    MCPs:   ${g.mcps?.join(', ') || 'none registered'}`);
    g.agentRegistered ? ok('Agent name', `"${config.armoriqAgentName}" is registered`) : bad('Agent name', `"${config.armoriqAgentName}" is NOT registered. Register it or change ARMORIQ_AGENT_NAME.`);
    g.mcpRegistered ? ok('MCP name', `"${config.armoriqMcpName}" is registered`) : bad('MCP name', `"${config.armoriqMcpName}" is NOT registered. Register ${config.publicBaseUrl}/mcp or change ARMORIQ_MCP_NAME.`);
  }

  const mcpUrl = `${config.publicBaseUrl.replace(/\/$/, '')}/mcp`;
  if (!config.mcpBearerToken) bad('MCP endpoint', 'MCP_BEARER_TOKEN is empty; /mcp refuses every request.');
  else {
    try {
      const res = await fetch(mcpUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${config.mcpBearerToken}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      });
      const body = (await res.json()) as any;
      const n = body?.result?.tools?.length ?? 0;
      n === TOOLS.length ? ok('MCP endpoint', `${n} tools at ${mcpUrl}`) : bad('MCP endpoint', `expected ${TOOLS.length} tools, got ${n} (HTTP ${res.status})`);
    } catch (err) {
      bad('MCP endpoint', `cannot reach ${mcpUrl} (${(err as Error).message}). Is the server running? Is PUBLIC_BASE_URL right?`);
    }
  }

  try {
    await getModel();
    ok('Model', `${config.llmModel} loads`);
  } catch (err) {
    bad('Model', `${config.llmModel} failed to load: ${(err as Error).message}`);
  }

  console.log(failures ? `\n${failures} problem(s). Fix them before running the demo.\n` : '\nAll good.\n');
  process.exit(failures ? 1 : 0);
}

main();
