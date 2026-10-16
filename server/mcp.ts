import crypto from 'node:crypto';
import type { Request, Response, Router } from 'express';
import express from 'express';
import { z } from 'zod';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { config } from './config.js';
import { TOOLS } from './tools/registry.js';

/**
 * MCP DISCOVERY endpoint.
 *
 * Register `${PUBLIC_BASE_URL}/mcp` in the ArmorIQ console (credential = MCP_BEARER_TOKEN) so
 * policies can reference these tools by name.
 *
 * Execution does NOT happen here. The ArmorIQ LangChain adapter checks each call with
 * ArmorIQ and then runs the tool in-process for the signed-in user. A callable public
 * endpoint would be a second, unguarded path to the same tools, so tools/call is refused.
 */
function buildServer(): Server {
  const server = new Server({ name: config.armoriqMcpName, version: '0.1.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: `[${t.tier}] ${t.description}`,
      inputSchema: z.toJSONSchema(t.schema, { target: 'draft-7' }) as { type: 'object'; [k: string]: unknown },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => ({
    isError: true,
    content: [
      {
        type: 'text' as const,
        text: `Direct execution of ${req.params.name} is disabled. Orqestra tools run only through the governed agent, after an ArmorIQ check, for a signed-in user.`,
      },
    ],
  }));

  return server;
}

/** Accept the token however the client sends it: "Authorization: Bearer <t>", "Authorization: <t>" or "X-API-Key: <t>". */
function tokenOk(req: Request): boolean {
  if (!config.mcpBearerToken) return false;
  const auth = (req.header('authorization') ?? '').trim();
  const candidates = [auth.replace(/^bearer\s+/i, ''), (req.header('x-api-key') ?? '').trim()].filter(Boolean);
  const expected = crypto.createHash('sha256').update(config.mcpBearerToken).digest();
  return candidates.some((c) => crypto.timingSafeEqual(crypto.createHash('sha256').update(c).digest(), expected));
}

/** One log line per /mcp request so registration problems are visible in the host logs. Never logs the token. */
function logRequest(req: Request, status: number, authorized: boolean) {
  const rpc = req.body && typeof req.body === 'object' ? (Array.isArray(req.body) ? req.body.map((m: any) => m?.method).join(',') : (req.body as any).method) : undefined;
  const authStyle = req.header('x-api-key') ? 'x-api-key' : /^bearer\s/i.test(req.header('authorization') ?? '') ? 'bearer' : req.header('authorization') ? 'raw-authorization' : 'none';
  console.log(`[mcp] ${req.method} rpc=${rpc ?? '-'} auth=${authStyle} authorized=${authorized} status=${status} ua=${(req.header('user-agent') ?? '-').slice(0, 60)}`);
}

export function mcpRouter(): Router {
  const router = express.Router();
  router.use(express.json({ limit: '256kb' }));

  router.all('/', async (req: Request, res: Response) => {
    const authorized = tokenOk(req);
    if (!authorized) {
      logRequest(req, 401, false);
      res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null });
      return;
    }
    if (req.method !== 'POST') {
      // Stateless server: no server-initiated SSE stream (MCP spec: respond 405 to GET).
      logRequest(req, 405, true);
      res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
      return;
    }
    // Stateless: a fresh server + transport per request.
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      logRequest(req, res.statusCode, true);
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  return router;
}
