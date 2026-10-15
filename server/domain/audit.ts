import type { DB } from '../db.js';

export type AuditSource = 'armoriq' | 'domain' | 'app';
export type AuditDecision = 'allowed' | 'held' | 'approved' | 'blocked' | 'failed' | 'completed' | 'info';

export interface AuditInput {
  businessId: string;
  userId?: string;
  sessionId?: string;
  source: AuditSource;
  action: string;
  decision: AuditDecision;
  reason?: string;
  payload?: unknown;
}

/** Mask long digit runs (account numbers, phones) to their last 4 digits. */
export function redact(text: string): string {
  return text.replace(/\d[\d-]{5,}\d/g, (m) => {
    const digits = m.replace(/\D/g, '');
    return `••••${digits.slice(-4)}`;
  });
}

export function summarize(payload: unknown, max = 400): string {
  if (payload === undefined) return '';
  let text: string;
  try {
    text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  } catch {
    text = String(payload);
  }
  text = redact(text);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function audit(db: DB, e: AuditInput): void {
  db.prepare(
    `INSERT INTO audit_events (business_id,user_id,session_id,source,action,decision,reason,payload_summary,created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(
    e.businessId,
    e.userId ?? null,
    e.sessionId ?? null,
    e.source,
    e.action,
    e.decision,
    redact(e.reason ?? ''),
    summarize(e.payload),
    new Date().toISOString(),
  );
}

export interface AuditRow {
  id: number;
  user_id: string | null;
  user_name: string | null;
  session_id: string | null;
  source: AuditSource;
  action: string;
  decision: AuditDecision;
  reason: string;
  payload_summary: string;
  created_at: string;
}

export function listAudit(db: DB, businessId: string, limit = 100): AuditRow[] {
  return db
    .prepare(
      `SELECT a.id, a.user_id, u.display_name AS user_name, a.session_id, a.source, a.action, a.decision,
              a.reason, a.payload_summary, a.created_at
       FROM audit_events a LEFT JOIN users u ON u.id = a.user_id
       WHERE a.business_id = ? ORDER BY a.id DESC LIMIT ?`,
    )
    .all(businessId, limit) as AuditRow[];
}
