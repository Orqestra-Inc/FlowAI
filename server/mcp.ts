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

function bearerOk(req: Request): boolean {
  if (!config.mcpBearerToken) return false;
  const header = req.header('authorization') ?? '';
  const expected = `Bearer ${config.mcpBearerToken}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function mcpRouter(): Router {
  const router = express.Router();
  router.use(express.json({ limit: '256kb' }));

  router.all('/', async (req: Request, res: Response) => {
    if (!bearerOk(req)) {
      res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null });
      return;
    }
    if (req.method !== 'POST') {
      res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
      return;
    }
    // Stateless: a fresh server + transport per request.
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  return router;
}
