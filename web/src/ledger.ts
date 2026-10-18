import type { AgentEvent } from './api';

export type SlipStatus = 'checking' | 'held' | 'approved' | 'allowed' | 'blocked' | 'refused' | 'failed' | 'unguarded';

export interface Slip {
  key: string;
  callId?: string;
  tool: string;
  args: unknown;
  status: SlipStatus;
  reason?: string;
  /** Who decided: ArmorIQ, a business rule, or nobody (unprotected run). */
  decidedBy?: 'ArmorIQ' | 'Business rule' | 'Nobody';
  outcome?: any;
  /** ArmorIQ approval request this hold is waiting on (match it in the console). */
  delegationId?: string;
}

/** Fold the event stream of one run into receipt slips, one per tool call. */
export function deriveSlips(events: AgentEvent[]): Slip[] {
  const slips: Slip[] = [];
  const byCall = new Map<string, Slip>();
  const open = (tool: string, states: SlipStatus[]) => slips.find((s) => s.tool === tool && states.includes(s.status));

  for (const e of events) {
    if (e.type === 'plan') {
      e.calls.forEach((c, i) => {
        const slip: Slip = { key: c.id ?? `${slips.length}-${i}`, callId: c.id, tool: c.tool, args: c.args, status: e.protected ? 'checking' : 'unguarded' };
        slips.push(slip);
        if (c.id) byCall.set(c.id, slip);
      });
    } else if (e.type === 'guard') {
      const slip = open(e.tool, ['checking', 'held', 'approved']);
      if (!slip) continue;
      slip.decidedBy = 'ArmorIQ';
      if (e.delegationId) slip.delegationId = e.delegationId;
      if (e.kind === 'hold') {
        slip.status = 'held';
        slip.reason = e.reason ?? 'Waiting for approval';
      } else if (e.kind === 'approved') {
        slip.status = 'approved';
        slip.reason = 'Approved in the ArmorIQ console';
      } else {
        slip.status = 'blocked';
        slip.reason = e.reason ?? (e.kind === 'timeout' ? 'No approval in time, so the action was refused' : e.kind === 'rejected' ? 'Approval was rejected' : 'Blocked by policy');
      }
    } else if (e.type === 'tool_result') {
      const slip = (e.callId && byCall.get(e.callId)) || open(e.tool, ['checking', 'approved', 'unguarded']);
      if (!slip) continue;
      slip.outcome = e.outcome;
      if (e.status === 'refused') {
        slip.status = 'refused';
        slip.decidedBy = 'Business rule';
        slip.reason = (e.outcome as { reason?: string } | undefined)?.reason;
      } else if (e.source === 'unguarded') {
        slip.status = 'unguarded';
        slip.decidedBy = 'Nobody';
        slip.reason = 'Ran with ArmorIQ switched off';
      } else {
        slip.status = 'allowed';
        slip.decidedBy = 'ArmorIQ';
        if (slip.reason === undefined) slip.reason = 'Within policy for this user';
      }
    } else if (e.type === 'tool_stopped') {
      const slip = (e.callId && byCall.get(e.callId)) || open(e.tool, ['checking', 'held', 'approved', 'blocked']);
      if (!slip) continue;
      if (slip.status !== 'blocked') {
        slip.status = e.source === 'armoriq' ? 'blocked' : 'failed';
        slip.decidedBy = e.source === 'armoriq' ? 'ArmorIQ' : undefined;
        slip.reason = cleanReason(e.reason);
      }
    }
  }
  return slips;
}

function cleanReason(text: string): string {
  return text
    .replace(/^Error:\s*/i, '')
    .replace(/^.*?ArmorIQ (block|hold \w+|enforcement error \(fail-closed\)):\s*/i, '')
    .trim();
}

export const STAMP_TEXT: Record<SlipStatus, string> = {
  checking: 'Checking',
  held: 'Held',
  approved: 'Approved',
  allowed: 'Allowed',
  blocked: 'Blocked',
  refused: 'Refused',
  failed: 'Failed',
  unguarded: 'Unguarded',
};

/** Plain-language names for tools, so the ledger reads like a business record. */
export const TOOL_LABEL: Record<string, string> = {
  get_business_overview: 'Read business overview',
  get_inventory: 'Read inventory',
  list_low_stock: 'List low-stock items',
  list_suppliers: 'List suppliers',
  get_open_bills: 'Read open bills',
  get_bill: 'Read a bill',
  get_cash_position: 'Read cash position',
  calculate_reorder_options: 'Compare reorder options',
  create_purchase_order_draft: 'Draft a purchase order',
  get_purchase_order: 'Read a purchase order',
  list_purchase_orders: 'List purchase orders',
  commit_purchase_order: 'Place a purchase order',
  pay_bill: 'Pay a supplier bill',
  update_supplier_payout_details: 'Change supplier bank details',
  get_payroll_summary: 'Read payroll totals',
  export_supplier_list: 'Export supplier list',
};

export function argSummary(args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    if (v === undefined || v === null) continue;
    if (k === 'amount' && typeof v === 'number') parts.push(`KSh ${v.toLocaleString('en-KE')}`);
    else if (Array.isArray(v)) parts.push(v.map((x) => (typeof x === 'object' ? Object.values(x as object).join(' × ') : String(x))).join(', '));
    else parts.push(String(v));
  }
  return parts.join(', ');
}

/** ArmorIQ's raw reasons, in words a business user understands. The raw code stays visible in parentheses. */
export function friendlyReason(reason?: string | null): string {
  if (!reason) return '';
  if (/no_matching_policy/i.test(reason)) return 'No ArmorIQ policy covers this action for this person yet (no_matching_policy).';
  if (/tool-not-in-plan/i.test(reason)) return 'Not part of the plan the agent declared, so it was refused.';
  if (/enforce-unavailable/i.test(reason)) return 'ArmorIQ could not be reached, so the action was refused (fail-closed).';
  return reason;
}
