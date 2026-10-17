import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express, { type Request, type Response } from 'express';
import cookieParser from 'cookie-parser';
import { MemorySaver } from '@langchain/langgraph';
import { armoriqIdentity, config } from './config.js';
import { runPolicyCheck } from './policy-check.js';
import { seed, type DB } from './db.js';
import { actorByEmail, requireActor, SESSION_COOKIE } from './auth.js';
import { audit, listAudit } from './domain/audit.js';
import * as ops from './domain/operations.js';
import { DomainRefusal } from './domain/types.js';
import { mcpRouter } from './mcp.js';
import { getGuard, checkGuard } from './armoriq.js';
import { getModel } from './model.js';
import { runAgent } from './agent/run.js';
import { codeMatches, createChatLimiter } from './limits.js';
import { getChat, listChats, saveTurn } from './domain/chats.js';
import { createVoice, MAX_AUDIO_BYTES, MAX_SPEAK_CHARS, VoiceError, type Voice } from './voice.js';
import type { AgentEvent } from './agent/events.js';

export interface AppOverrides {
  /** Tests and local previews only: inject a model and ArmorIQ guard instead of loading them from config. */
  model?: () => Promise<import('@langchain/core/language_models/chat_models').BaseChatModel>;
  guard?: () => import('./agent/run.js').Guard | null;
  voice?: Voice | null;
}

export function createApp(db: DB, overrides: AppOverrides = {}) {
  const loadModel = overrides.model ?? getModel;
  const loadGuard = overrides.guard ?? getGuard;
  ops.setMaxPoAmount(config.maxPoAmount);
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  let secret = config.sessionSecret;
  if (secret.length < 32) {
    if (!config.demoMode) throw new Error('SESSION_SECRET must be at least 32 characters.');
    secret = crypto.randomBytes(32).toString('hex');
    console.warn('[orqestra] SESSION_SECRET not set; using a random one for this process (sessions reset on restart).');
  }

  app.use(cookieParser(secret));
  app.use('/mcp', mcpRouter());
  app.use('/api', express.json({ limit: '64kb' }));

  const auth = requireActor(db);
  const checkpointer = new MemorySaver(); // conversation memory, keyed by `${userId}:${chatId}`
  const running = new Set<string>(); // one run per user at a time
  const limiter = createChatLimiter(config.chatLimitPerHour, config.chatLimitPerDay);
  const voiceLimiter = createChatLimiter(config.voiceLimitPerHour, config.voiceLimitPerDay);
  const voice: Voice | null =
    overrides.voice !== undefined
      ? overrides.voice
      : config.elevenLabsApiKey
        ? createVoice({ apiKey: config.elevenLabsApiKey, sttModel: config.elevenLabsSttModel, ttsModel: config.elevenLabsTtsModel, voiceId: config.elevenLabsVoiceId })
        : null;

  // ── Public ────────────────────────────────────────────────────────
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/api/config', (_req, res) => {
    res.json({
      appName: config.appName,
      agentName: config.agentName,
      demoMode: config.demoMode,
      allowUnprotected: config.allowUnprotected,
      model: config.llmModel,
      armoriqConfigured: loadGuard() !== null,
      armoriqConsoleUrl: config.armoriqConsoleUrl,
      approvalWaitSeconds: config.approvalWaitSeconds,
      requireAccessCode: config.demoAccessCode.length > 0,
      accessCodeHint: config.demoAccessCode.length > 0 ? config.demoAccessCodeHint : '',
      voiceEnabled: voice !== null,
    });
  });

  app.get('/api/demo/users', (_req, res) => {
    if (!config.demoMode) {
      res.status(404).end();
      return;
    }
    res.json(db.prepare(`SELECT email, role, display_name FROM users WHERE business_id = 'biz_baraka' ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'procurement' THEN 1 ELSE 2 END`).all());
  });

  app.post('/api/auth/login', (req, res) => {
    // Demo sign-in: choose a seeded account. A real deployment replaces this with proper authentication.
    if (!config.demoMode) {
      res.status(404).end();
      return;
    }
    // Switching between demo accounts is allowed once signed in; a fresh sign-in needs the access code (if one is set).
    const alreadySignedIn = typeof req.signedCookies?.[SESSION_COOKIE] === 'string';
    if (config.demoAccessCode && !alreadySignedIn && !codeMatches(req.body?.code, config.demoAccessCode)) {
      res.status(401).json({ error: 'That access code is not right.' });
      return;
    }
    const actor = typeof req.body?.email === 'string' ? actorByEmail(db, req.body.email) : null;
    if (!actor) {
      res.status(401).json({ error: 'Unknown demo account.' });
      return;
    }
    res.cookie(SESSION_COOKIE, actor.userId, {
      signed: true, httpOnly: true, sameSite: 'lax', secure: config.publicBaseUrl.startsWith('https://'), maxAge: 12 * 60 * 60 * 1000,
    });
    audit(db, { businessId: actor.businessId, userId: actor.userId, source: 'app', action: 'sign_in', decision: 'info' });
    res.json({ user: actor });
  });

  app.post('/api/auth/logout', (_req, res) => {
    res.clearCookie(SESSION_COOKIE);
    res.json({ ok: true });
  });

  // ── Signed in ────────────────────────────────────────────────────
  app.get('/api/me', auth, (req, res) => {
    res.json({ user: req.actor });
  });

  app.get('/api/overview', auth, (req, res) => {
    res.json(ops.getBusinessOverview(db, req.actor!));
  });

  app.get('/api/purchase-orders', auth, (req, res) => {
    res.json(ops.listPurchaseOrders(db, req.actor!));
  });

  app.get('/api/purchase-orders/:id', auth, (req, res) => {
    handle(res, () => ops.getPurchaseOrder(db, req.actor!, String(req.params.id)));
  });

  // HUMAN-ONLY approval. There is no model tool for this.
  app.post('/api/purchase-orders/:id/approve', auth, (req, res) => {
    const actor = req.actor!;
    const id = String(req.params.id);
    handle(res, () => {
      const result = ops.approvePurchaseOrder(db, actor, id);
      audit(db, { businessId: actor.businessId, userId: actor.userId, source: 'app', action: 'approve_purchase_order', decision: 'approved', reason: `Human approval ${result.approval_id} (expires ${result.expires_at})`, payload: { order_id: id } });
      return { ...result, order: ops.getPurchaseOrder(db, actor, id) };
    }, (reason) => audit(db, { businessId: actor.businessId, userId: actor.userId, source: 'domain', action: 'approve_purchase_order', decision: 'blocked', reason, payload: { order_id: id } }));
  });

  app.post('/api/purchase-orders/:id/reject', auth, (req, res) => {
    const actor = req.actor!;
    const id = String(req.params.id);
    handle(res, () => {
      const result = ops.rejectPurchaseOrder(db, actor, id);
      audit(db, { businessId: actor.businessId, userId: actor.userId, source: 'app', action: 'reject_purchase_order', decision: 'blocked', reason: 'Rejected by a human', payload: { order_id: id } });
      return { ...result, order: ops.getPurchaseOrder(db, actor, id) };
    });
  });

  // ── Voice (ElevenLabs) ───────────────────────────────────────────
  const voiceGate = (req: Request, res: Response): boolean => {
    if (!voice) {
      res.status(404).json({ error: 'Voice is not configured.' });
      return false;
    }
    const limit = voiceLimiter.take(`${req.actor!.userId}:${req.ip}`);
    if (!limit.ok) {
      res.status(429).json({ error: limit.reason });
      return false;
    }
    return true;
  };
  const voiceError = (res: Response, err: unknown) => {
    const status = err instanceof VoiceError ? err.status : 502;
    const message = err instanceof Error && err.name === 'TimeoutError' ? 'ElevenLabs took too long to respond.' : (err as Error).message;
    console.warn('[voice]', message);
    res.status(status).json({ error: message });
  };

  app.post(
    '/api/voice/transcribe',
    auth,
    express.raw({ type: ['audio/*', 'video/webm', 'application/octet-stream'], limit: MAX_AUDIO_BYTES }),
    async (req: Request, res: Response) => {
      if (!voiceGate(req, res)) return;
      try {
        const audio = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        res.json(await voice!.transcribe(audio, String(req.header('content-type') ?? 'audio/webm')));
      } catch (err) {
        voiceError(res, err);
      }
    },
  );

  app.post('/api/voice/speak', auth, async (req: Request, res: Response) => {
    const text = typeof req.body?.text === 'string' ? req.body.text : '';
    if (!text.trim() || text.length > MAX_SPEAK_CHARS * 4) {
      res.status(400).json({ error: 'Nothing to read aloud.' });
      return;
    }
    if (!voiceGate(req, res)) return;
    try {
      const { audio, contentType } = await voice!.speak(text);
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'no-store');
      res.end(Buffer.from(audio));
    } catch (err) {
      voiceError(res, err);
    }
  });

  app.get('/api/chats', auth, (req, res) => {
    res.json(listChats(db, req.actor!));
  });

  app.get('/api/chats/:chatId', auth, (req, res) => {
    const chatId = String(req.params.chatId);
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(chatId)) {
      res.status(400).json({ error: 'Invalid conversation id.' });
      return;
    }
    res.json({ chatId, turns: getChat(db, req.actor!, chatId) });
  });

  app.get('/api/activity', auth, (req, res) => {
    res.json(listAudit(db, req.actor!.businessId, 150));
  });

  app.get('/api/armoriq/status', auth, async (_req, res) => {
    res.json(await checkGuard());
  });

  // Owner-only: run the fixed policy-check cases against live ArmorIQ (throwaway database, nothing real changes).
  let checking = false;
  let lastCheck = 0;
  app.post('/api/armoriq/policy-check', auth, async (req, res) => {
    if (req.actor!.role !== 'owner') {
      res.status(403).json({ error: 'Only the owner can run the policy check.' });
      return;
    }
    if (checking || Date.now() - lastCheck < 10_000) {
      res.status(429).json({ error: 'A policy check just ran. Try again in a few seconds.' });
      return;
    }
    checking = true;
    try {
      const injected = overrides.guard ? overrides.guard() : undefined;
      const result = await runPolicyCheck(injected ? { guard: injected } : {});
      audit(db, { businessId: req.actor!.businessId, userId: req.actor!.userId, source: 'app', action: 'policy_check', decision: 'info', reason: result.ok ? `${result.results.filter((r) => r.pass).length}/${result.results.length} as expected` : result.error });
      res.json(result);
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message, results: [] });
    } finally {
      checking = false;
      lastCheck = Date.now();
    }
  });

  app.post('/api/demo/reset', auth, (req, res) => {
    if (!config.demoMode) {
      res.status(404).end();
      return;
    }
    seed(db);
    audit(db, { businessId: req.actor!.businessId, userId: req.actor!.userId, source: 'app', action: 'demo_reset', decision: 'info' });
    res.json({ ok: true });
  });

  // ── Chat (SSE) ───────────────────────────────────────────────────
  app.post('/api/chat', auth, async (req: Request, res: Response) => {
    const actor = req.actor!;
    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    const chatId = typeof req.body?.chatId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(req.body.chatId) ? req.body.chatId : 'default';
    const wantsUnprotected = req.body?.unprotected === true;

    if (!message || message.length > 2_000) {
      res.status(400).json({ error: 'Message must be 1–2000 characters.' });
      return;
    }
    if (wantsUnprotected && !(config.allowUnprotected && actor.role === 'owner')) {
      res.status(403).json({ error: 'Unprotected runs are disabled.' });
      return;
    }
    const isProtected = !wantsUnprotected;
    const guard = loadGuard();
    if (isProtected && !guard) {
      res.status(503).json({ error: 'ArmorIQ is not configured. Requests are refused until it is (fail-closed).' });
      return;
    }
    const limit = limiter.take(`${actor.userId}:${req.ip}`);
    if (!limit.ok) {
      res.status(429).json({ error: limit.reason });
      return;
    }
    if (running.has(actor.userId)) {
      res.status(429).json({ error: 'A request is already running for you. Wait for it to finish.' });
      return;
    }

    let model;
    try {
      model = await loadModel();
    } catch (err) {
      res.status(500).json({ error: `Model "${config.llmModel}" could not be loaded: ${(err as Error).message}` });
      return;
    }

    running.add(actor.userId);
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const controller = new AbortController();
    let open = true;
    const heartbeat = setInterval(() => open && res.write(': keep-alive\n\n'), 15_000);
    res.on('close', () => {
      open = false;
      controller.abort();
    });
    // Persist the turn (and every event) so the conversation survives refreshes and opens on other devices.
    const turn = { id: crypto.randomUUID(), chatId, message, protected: isProtected, events: [] as AgentEvent[], createdAt: new Date().toISOString() };
    saveTurn(db, actor, turn);
    let lastSave = Date.now();
    const emit = (event: AgentEvent) => {
      turn.events.push(event);
      if (Date.now() - lastSave > 2_000 || event.type === 'guard') {
        saveTurn(db, actor, turn);
        lastSave = Date.now();
      }
      if (open) res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    try {
      await runAgent(
        {
          db, model, checkpointer, guard: isProtected ? guard : null, appName: config.appName, agentName: config.agentName,
          modelLabel: config.llmModel, maxToolCalls: config.maxToolCalls, maxModelCalls: config.maxModelCalls, identityFor: armoriqIdentity,
        },
        { actor, message, chatId: `${chatId}${isProtected ? '' : '-unprotected'}`, protected: isProtected, emit, signal: controller.signal },
      );
    } catch (err) {
      emit({ type: 'error', message: (err as Error).message });
    } finally {
      try {
        saveTurn(db, actor, turn);
      } catch (err) {
        console.warn('[orqestra] could not save chat turn:', (err as Error).message);
      }
      clearInterval(heartbeat);
      running.delete(actor.userId);
      if (open) res.end();
    }
  });

  // ── Static web build ─────────────────────────────────────────────
  const webDist = path.resolve('dist/web');
  if (fs.existsSync(webDist)) {
    app.use(express.static(webDist, { index: false, maxAge: '1h' }));
    app.get(/^(?!\/(api|mcp)\b).*/, (_req, res) => res.sendFile(path.join(webDist, 'index.html')));
  }

  return app;
}

function handle(res: Response, fn: () => unknown, onRefusal?: (reason: string) => void) {
  try {
    res.json(fn());
  } catch (err) {
    if (err instanceof DomainRefusal) {
      onRefusal?.(err.message);
      res.status(err.code === 'not_found' ? 404 : 409).json({ error: err.message, code: err.code });
      return;
    }
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  }
}
