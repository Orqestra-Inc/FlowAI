import { MemorySaver } from '@langchain/langgraph';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { openDb, seed, type DB } from '../../server/db.js';
import { actorByEmail } from '../../server/auth.js';
import { runAgent, type Guard } from '../../server/agent/run.js';
import type { AgentEvent } from '../../server/agent/events.js';

export interface CaseRun {
  db: DB;
  events: AgentEvent[];
  ran: string[];
  stopped: string[];
  guard: string[];
  final: string;
}

/** Run one request on a fresh, seeded in-memory database and summarize what happened. */
export async function runCase(opts: { email: string; message: string; model: BaseChatModel; guard: Guard | null; protectedRun?: boolean; setup?: (db: DB) => void }): Promise<CaseRun> {
  const db = openDb(':memory:');
  seed(db);
  opts.setup?.(db);
  const actor = actorByEmail(db, opts.email);
  if (!actor) throw new Error(`unknown user ${opts.email}`);
  const events: AgentEvent[] = [];
  await runAgent(
    { db, model: opts.model, checkpointer: new MemorySaver(), guard: opts.guard, appName: 'Orqestra', agentName: 'Flow', modelLabel: 'case', maxToolCalls: 12, maxModelCalls: 10 },
    { actor, message: opts.message, chatId: 'case', protected: opts.protectedRun ?? true, emit: (e) => events.push(e) },
  );
  return {
    db,
    events,
    ran: events.filter((e) => e.type === 'tool_result').map((e) => `${(e as any).tool}${(e as any).status === 'refused' ? '(refused by rule)' : ''}`),
    stopped: events.filter((e) => e.type === 'tool_stopped').map((e) => (e as any).tool),
    guard: events.filter((e) => e.type === 'guard').map((e) => `${(e as any).kind}:${(e as any).tool}`),
    final: (events.find((e) => e.type === 'final') as any)?.text ?? (events.find((e) => e.type === 'error') as any)?.message ?? '',
  };
}

export function count(db: DB, sql: string): number {
  return (db.prepare(sql).get() as { n: number }).n;
}
