import { config } from './config.js';
import { initDb } from './db.js';
import { createApp } from './app.js';
import { checkGuard } from './armoriq.js';

const db = initDb(config.databasePath);
const app = createApp(db);

const server = app.listen(config.port, () => {
  console.log(`[orqestra] ${config.appName} listening on http://localhost:${config.port}`);
  console.log(`[orqestra] model: ${config.llmModel} · demo mode: ${config.demoMode ? 'on' : 'off'}`);
  void checkGuard().then((s) => {
    if (!s.configured) console.warn(`[orqestra] ArmorIQ NOT configured: ${s.error} Protected requests will be refused.`);
    else if (!s.ok) console.warn(`[orqestra] ArmorIQ check failed: ${s.error}`);
    else {
      console.log(`[orqestra] ArmorIQ OK (org ${s.org ?? 'unknown'})`);
      if (!s.agentRegistered) console.warn(`[orqestra] Agent "${config.armoriqAgentName}" is not registered in ArmorIQ — policies will not match.`);
      if (!s.mcpRegistered) console.warn(`[orqestra] MCP "${config.armoriqMcpName}" is not registered in ArmorIQ — policies will not match.`);
    }
  });
});

// Long-lived SSE responses (a held tool can wait for approval).
server.keepAliveTimeout = 65_000;
server.requestTimeout = 0;

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}
