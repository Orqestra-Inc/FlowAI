import type { DB } from '../db.js';
import type { Actor } from './types.js';

/** Chat history, scoped to the signed-in user. Stored so conversations survive refreshes and work across devices. */
export interface StoredTurn {
  id: string;
  message: string;
  protected: boolean;
  events: unknown[];
  error: string | null;
  created_at: string;
}

const MAX_EVENTS_JSON = 200_000;

export function saveTurn(
  db: DB,
  actor: Actor,
  t: { id: string; chatId: string; message: string; protected: boolean; events: unknown[]; error?: string | null; createdAt: string },
): void {
  let events = JSON.stringify(t.events);
  if (events.length > MAX_EVENTS_JSON) events = JSON.stringify(t.events.filter((e: any) => e?.type !== 'tool_result'));
  db.prepare(
    `INSERT INTO chat_turns (id,business_id,user_id,chat_id,message,protected,events_json,error,created_at)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET events_json = excluded.events_json, error = excluded.error`,
  ).run(t.id, actor.businessId, actor.userId, t.chatId, t.message, t.protected ? 1 : 0, events, t.error ?? null, t.createdAt);
}

export function getChat(db: DB, actor: Actor, chatId: string): StoredTurn[] {
  const rows = db
    .prepare(`SELECT id, message, protected, events_json, error, created_at FROM chat_turns WHERE user_id = ? AND chat_id = ? ORDER BY created_at, rowid`)
    .all(actor.userId, chatId) as Array<{ id: string; message: string; protected: number; events_json: string; error: string | null; created_at: string }>;
  return rows.map((r) => ({ id: r.id, message: r.message, protected: !!r.protected, events: JSON.parse(r.events_json), error: r.error, created_at: r.created_at }));
}

export function listChats(db: DB, actor: Actor, limit = 12) {
  return db
    .prepare(
      `SELECT chat_id AS chatId,
              (SELECT message FROM chat_turns f WHERE f.user_id = t.user_id AND f.chat_id = t.chat_id ORDER BY created_at, rowid LIMIT 1) AS title,
              COUNT(*) AS turns, MIN(created_at) AS startedAt, MAX(created_at) AS updatedAt
       FROM chat_turns t WHERE user_id = ? GROUP BY chat_id ORDER BY updatedAt DESC LIMIT ?`,
    )
    .all(actor.userId, limit) as Array<{ chatId: string; title: string; turns: number; startedAt: string; updatedAt: string }>;
}
