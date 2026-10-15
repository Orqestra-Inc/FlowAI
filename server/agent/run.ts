import crypto from 'node:crypto';
import { AIMessage, createAgent, modelCallLimitMiddleware, tool, toolCallLimitMiddleware, ToolMessage } from 'langchain';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { BaseCheckpointSaver } from '@langchain/langgraph';
import type { DB } from '../db.js';
import { audit } from '../domain/audit.js';
import type { Actor } from '../domain/types.js';
import { executeTool, serializeOutcome, TOOLS, type ToolOutcome } from '../tools/registry.js';
import type { AgentEvent } from './events.js';
import { instructions } from './instructions.js';

/** The shape of ArmorIQLangChain we rely on. Lets tests substitute a deterministic guard. */
export interface Guard {
  forUser(email: string, opts: { goal?: string; onEvent?: (kind: string, payload: Record<string, any>) => void }): Promise<GuardHandler>;
}
export interface GuardHandler {
  close?: (status?: 'ok' | 'error') => Promise<void>;
  [k: string]: any;
}

export interface RunDeps {
  db: DB;
  model: BaseChatModel;
  checkpointer: BaseCheckpointSaver;
  /** ArmorIQ guard. Null only for an explicit, demo-only unprotected run. */
  guard: Guard | null;
  appName: string;
  modelLabel: string;
  maxToolCalls: number;
  maxModelCalls: number;
}

export interface RunInput {
  actor: Actor;
  message: string;
  chatId: string;
  /** Must be true unless the caller has already verified demo-mode unprotected rules. */
  protected: boolean;
  emit: (event: AgentEvent) => void;
  signal?: AbortSignal;
}

const GUARD_KINDS = new Set(['hold', 'approved', 'rejected', 'timeout', 'block', 'error']);
const DECISION_FOR: Record<string, 'held' | 'approved' | 'blocked' | 'failed'> = {
  hold: 'held', approved: 'approved', rejected: 'blocked', timeout: 'blocked', block: 'blocked', error: 'failed',
};

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p === 'string' ? p : p?.type === 'text' ? String(p.text ?? '') : '')).join('');
  }
  return '';
}

function parseOutcome(content: string): ToolOutcome | null {
  try {
    const value = JSON.parse(content);
    return value && typeof value === 'object' && 'ok' in value ? (value as ToolOutcome) : null;
  } catch {
    return null;
  }
}

/** Tools bound to the signed-in actor. The model can never choose whose data a tool touches. */
function buildTools(db: DB, actor: Actor) {
  return TOOLS.map((t) =>
    tool(async (input: unknown) => serializeOutcome(executeTool(db, actor, t.name, input)), {
      name: t.name,
      description: t.description,
      schema: t.schema as any,
    }),
  );
}

export async function runAgent(deps: RunDeps, input: RunInput): Promise<void> {
  const { db, guard } = deps;
  const { actor, emit } = input;
  if (input.protected && !guard) throw new Error('ArmorIQ is not configured; refusing to run a protected request (fail-closed).');

  const runId = crypto.randomUUID();
  const businessName = (db.prepare('SELECT name FROM businesses WHERE id = ?').get(actor.businessId) as { name: string } | undefined)?.name ?? 'the business';
  const base = { businessId: actor.businessId, userId: actor.userId, sessionId: runId };
  const guardSource = input.protected ? 'armoriq' : 'unguarded';

  emit({ type: 'start', runId, protected: input.protected, model: deps.modelLabel, user: actor.displayName });
  audit(db, { ...base, source: 'app', action: 'chat_request', decision: 'info', reason: input.protected ? 'ArmorIQ enforcement on' : 'UNPROTECTED demo run (ArmorIQ off)', payload: input.message });

  let handler: GuardHandler | undefined;
  if (input.protected && guard) {
    try {
      handler = await guard.forUser(actor.email, {
        goal: input.message.slice(0, 500),
        onEvent: (kind, payload) => {
          if (!GUARD_KINDS.has(kind)) return;
          const tool = String(payload.tool ?? '');
          const rawReason = payload.reason ?? payload.error;
          const reason =
            kind === 'rejected' ? `Approval rejected${rawReason ? `: ${rawReason}` : ''}`
            : kind === 'timeout' ? `No approval in time${rawReason ? `: ${rawReason}` : ''}`
            : rawReason;
          emit({ type: 'guard', kind: kind as any, tool, reason: reason ? String(reason) : undefined, delegationId: payload.delegationId });
          audit(db, { ...base, source: 'armoriq', action: tool, decision: DECISION_FOR[kind], reason: reason ? String(reason) : kind, payload: payload.delegationId ? { delegationId: payload.delegationId } : undefined });
        },
      });
    } catch (err) {
      // Fail closed: if ArmorIQ cannot open an enforcement scope, nothing runs.
      const message = `ArmorIQ is unavailable, so nothing was run (fail-closed): ${err instanceof Error ? err.message : String(err)}`;
      emit({ type: 'error', message });
      audit(db, { ...base, source: 'armoriq', action: 'chat_request', decision: 'failed', reason: message });
      emit({ type: 'done', toolCalls: 0, stopped: 0 });
      return;
    }
  }

  const agent = createAgent({
    model: deps.model,
    tools: buildTools(db, actor),
    systemPrompt: instructions(actor, businessName, deps.appName),
    checkpointer: deps.checkpointer,
    middleware: [
      toolCallLimitMiddleware({ runLimit: deps.maxToolCalls, exitBehavior: 'end' }),
      modelCallLimitMiddleware({ runLimit: deps.maxModelCalls, exitBehavior: 'end' }),
    ],
  });

  let toolCalls = 0;
  let stopped = 0;
  let finalText = '';
  const callNames = new Map<string, string>();
  // Middleware nodes can re-emit messages already streamed; handle each message once.
  const seenAi = new Set<unknown>();
  const seenTool = new Set<string>();
  let status: 'ok' | 'error' = 'ok';

  try {
    const stream = await agent.stream(
      { messages: [{ role: 'user', content: input.message }] },
      {
        // The ArmorIQ handler goes on the INVOCATION so it reaches the model (plan capture)
        // and every tool call (enforcement) inside the graph.
        callbacks: handler ? [handler as any] : [],
        configurable: { thread_id: `${actor.userId}:${input.chatId}` },
        recursionLimit: 40,
        streamMode: 'updates',
        signal: input.signal,
      },
    );

    for await (const chunk of stream as AsyncIterable<Record<string, any>>) {
      for (const update of Object.values(chunk ?? {})) {
        const messages: unknown[] = Array.isArray(update?.messages) ? update.messages : [];
        for (const msg of messages) {
          if (AIMessage.isInstance(msg)) {
            const key = msg.id ?? msg;
            if (seenAi.has(key)) continue;
            seenAi.add(key);
            const calls = msg.tool_calls ?? [];
            if (calls.length) {
              toolCalls += calls.length;
              for (const c of calls) if (c.id) callNames.set(c.id, c.name);
              emit({ type: 'plan', protected: input.protected, calls: calls.map((c) => ({ id: c.id, tool: c.name, args: c.args })) });
              audit(db, { ...base, source: input.protected ? 'armoriq' : 'app', action: 'plan', decision: 'info', reason: input.protected ? 'Plan captured for ArmorIQ intent token' : 'Unguarded plan', payload: calls.map((c) => c.name) });
            } else {
              const text = textOf(msg.content).trim();
              if (text) finalText = text;
            }
          } else if (ToolMessage.isInstance(msg)) {
            if (seenTool.has(msg.tool_call_id)) continue;
            seenTool.add(msg.tool_call_id);
            const tool = msg.name ?? callNames.get(msg.tool_call_id) ?? 'tool';
            const content = textOf(msg.content);
            const outcome = msg.status === 'error' ? null : parseOutcome(content);
            if (!outcome) {
              stopped += 1;
              const byArmoriq = /armoriq/i.test(content);
              const reason = content.replace(/\n?\s*Please fix your mistakes\.?/i, '').trim().slice(0, 300);
              emit({ type: 'tool_stopped', tool, callId: msg.tool_call_id, source: byArmoriq ? 'armoriq' : 'app', reason });
              if (!byArmoriq) audit(db, { ...base, source: 'app', action: tool, decision: 'failed', reason });
              continue;
            }
            if (input.protected) audit(db, { ...base, source: 'armoriq', action: tool, decision: 'allowed', reason: 'Allowed by ArmorIQ policy' });
            if (outcome.ok) {
              emit({ type: 'tool_result', tool, callId: msg.tool_call_id, source: guardSource, status: 'completed', outcome });
              audit(db, { ...base, source: 'domain', action: tool, decision: 'completed', reason: input.protected ? '' : 'Ran WITHOUT ArmorIQ', payload: outcome.data });
            } else {
              emit({ type: 'tool_result', tool, callId: msg.tool_call_id, source: 'domain', status: 'refused', outcome });
              audit(db, { ...base, source: 'domain', action: tool, decision: 'blocked', reason: outcome.reason });
            }
          }
        }
      }
    }
    emit({ type: 'final', text: finalText || 'Done.' });
  } catch (err) {
    status = 'error';
    const message = err instanceof Error ? err.message : String(err);
    emit({ type: 'error', message });
    audit(db, { ...base, source: 'app', action: 'chat_request', decision: 'failed', reason: message });
  } finally {
    if (handler?.close) {
      try {
        await handler.close(status);
      } catch (e) {
        console.warn('[orqestra] ArmorIQ handler close failed:', (e as Error).message);
      }
    }
    emit({ type: 'done', toolCalls, stopped });
  }
}
