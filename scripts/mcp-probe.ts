/**
 *   npx tsx scripts/mcp-probe.ts <url> <token>
 * Connects to /mcp with the official MCP client (initialize → tools/list → tools/call) using each
 * common auth style, to debug registration problems with a host like ArmorIQ.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const [url, token] = process.argv.slice(2);
if (!url || !token) {
  console.error('usage: tsx scripts/mcp-probe.ts <url> <token>');
  process.exit(2);
}

const styles: Record<string, Record<string, string>> = {
  'Authorization: Bearer <token>': { Authorization: `Bearer ${token}` },
  'Authorization: <token>': { Authorization: token },
  'X-API-Key: <token>': { 'X-API-Key': token },
  'no credentials (should fail)': {},
};

for (const [label, headers] of Object.entries(styles)) {
  const client = new Client({ name: 'orqestra-probe', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
    const { tools } = await client.listTools();
    const call = await client.callTool({ name: 'export_supplier_list', arguments: { destination: 'x@example.com' } });
    console.log(`OK    ${label}: ${tools.length} tools; direct tools/call refused=${call.isError === true}`);
  } catch (err) {
    console.log(`FAIL  ${label}: ${(err as Error).message.slice(0, 120)}`);
  } finally {
    await client.close().catch(() => {});
  }
}
