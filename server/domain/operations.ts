import crypto from 'node:crypto';
import type { DB } from '../db.js';
import { type Actor, refuse, requireRole } from './types.js';

/** Horizon for "bills that will leave the account soon" when projecting cash. */
export const BILL_HORIZON_DAYS = 7;
export const APPROVAL_TTL_MINUTES = 15;

const DAY = 24 * 60 * 60 * 1000;

function today(now: Date): string {
  return now.toISOString().slice(0, 10);
}
function addDays(now: Date, days: number): string {
  return new Date(now.getTime() + days * DAY).toISOString().slice(0, 10);
}
function ref(prefix: string): string {
  return `${prefix}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}
function sha256(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function kes(amount: number): string {
  return `KSh ${Math.round(amount).toLocaleString('en-KE')}`;
}

// ── Row types ──────────────────────────────────────────────────────────

interface BusinessRow { id: string; name: string; currency: string; minimum_cash_reserve: number }
interface ItemRow { id: string; name: string; unit: string; qty_on_hand: number; reorder_threshold: number; target_stock: number }
interface SupplierRow {
  id: string; name: string; lead_time_days: number; reliability_score: number; contact_label: string;
  payout_method: string; payout_account: string; payout_verified: number;
}
interface BillRow { id: string; supplier_id: string; supplier_name: string; amount: number; due_date: string; status: string; notes: string; paid_reference: string | null }
export interface PoItem { item_id: string; item_name: string; unit: string; quantity: number; unit_price: number; line_total: number }
interface PoRow {
  id: string; business_id: string; supplier_id: string; items_json: string; total: number; status: string; notes: string;
  created_by: string; approved_by: string | null; approval_payload_hash: string | null; idempotency_key: string;
  commit_reference: string | null; created_at: string;
}
interface ApprovalRow { id: string; business_id: string; user_id: string; action_type: string; target_id: string; payload_hash: string; created_at: string; expires_at: string; consumed_at: string | null }

// ── Helpers scoped to the actor's business ────────────────────────────

function business(db: DB, actor: Actor): BusinessRow {
  const row = db.prepare('SELECT * FROM businesses WHERE id = ?').get(actor.businessId) as BusinessRow | undefined;
  if (!row) refuse('not_found', 'Business not found.');
  return row;
}
function cashBalance(db: DB, actor: Actor): number {
  const row = db.prepare('SELECT balance FROM cash_accounts WHERE business_id = ?').get(actor.businessId) as { balance: number } | undefined;
  return row?.balance ?? 0;
}
function supplierOf(db: DB, actor: Actor, supplierId: string): SupplierRow {
  const row = db.prepare('SELECT * FROM suppliers WHERE id = ? AND business_id = ?').get(supplierId, actor.businessId) as SupplierRow | undefined;
  if (!row) refuse('not_found', `Supplier ${supplierId} not found.`);
  return row;
}
function itemOf(db: DB, actor: Actor, itemId: string): ItemRow {
  const row = db.prepare('SELECT * FROM inventory_items WHERE id = ? AND business_id = ?').get(itemId, actor.businessId) as ItemRow | undefined;
  if (!row) refuse('not_found', `Inventory item ${itemId} not found.`);
  return row;
}
function poOf(db: DB, actor: Actor, orderId: string): PoRow {
  const row = db.prepare('SELECT * FROM purchase_orders WHERE id = ? AND business_id = ?').get(orderId, actor.businessId) as PoRow | undefined;
  if (!row) refuse('not_found', `Purchase order ${orderId} not found.`);
  return row;
}
function billsDueWithin(db: DB, actor: Actor, now: Date, days: number): BillRow[] {
  return db
    .prepare(
      `SELECT b.*, s.name AS supplier_name FROM bills b JOIN suppliers s ON s.id = b.supplier_id
       WHERE b.business_id = ? AND b.status = 'unpaid' AND b.due_date <= ? ORDER BY b.due_date`,
    )
    .all(actor.businessId, addDays(now, days)) as BillRow[];
}

function maskAccount(account: string): string {
  const digits = account.replace(/\D/g, '');
  return digits.length > 4 ? `••••${digits.slice(-4)}` : account;
}

// ── Reads ─────────────────────────────────────────────────────────────

export function getCashPosition(db: DB, actor: Actor, now = new Date()) {
  const biz = business(db, actor);
  const balance = cashBalance(db, actor);
  const due = billsDueWithin(db, actor, now, BILL_HORIZON_DAYS);
  const dueTotal = due.reduce((s, b) => s + b.amount, 0);
  return {
    currency: biz.currency,
    balance,
    minimum_cash_reserve: biz.minimum_cash_reserve,
    bills_due_next_7_days: dueTotal,
    projected_balance_after_due_bills: balance - dueTotal,
    available_to_spend_above_reserve: Math.max(0, balance - dueTotal - biz.minimum_cash_reserve),
  };
}

export function getInventory(db: DB, actor: Actor) {
  const rows = db.prepare('SELECT * FROM inventory_items WHERE business_id = ? ORDER BY name').all(actor.businessId) as ItemRow[];
  return rows.map((r) => ({
    item_id: r.id, name: r.name, unit: r.unit, qty_on_hand: r.qty_on_hand,
    reorder_threshold: r.reorder_threshold, target_stock: r.target_stock,
    low_stock: r.qty_on_hand < r.reorder_threshold,
  }));
}

export function listLowStock(db: DB, actor: Actor) {
  return getInventory(db, actor).filter((i) => i.low_stock);
}

export function listSuppliers(db: DB, actor: Actor, itemId?: string) {
  if (itemId) itemOf(db, actor, itemId);
  const rows = (itemId
    ? db.prepare(
        `SELECT s.*, p.unit_price, p.min_order_qty FROM suppliers s JOIN supplier_prices p ON p.supplier_id = s.id
         WHERE s.business_id = ? AND p.item_id = ? ORDER BY p.unit_price`,
      ).all(actor.businessId, itemId)
    : db.prepare('SELECT * FROM suppliers WHERE business_id = ? ORDER BY name').all(actor.businessId)) as Array<
    SupplierRow & { unit_price?: number; min_order_qty?: number }
  >;
  return rows.map((s) => ({
    supplier_id: s.id, name: s.name, lead_time_days: s.lead_time_days, reliability_score: s.reliability_score,
    payout_method: s.payout_method, payout_account: maskAccount(s.payout_account), payout_verified: !!s.payout_verified,
    ...(s.unit_price !== undefined ? { unit_price: s.unit_price, min_order_qty: s.min_order_qty } : {}),
  }));
}

function billView(b: BillRow) {
  return {
    bill_id: b.id, supplier_id: b.supplier_id, supplier_name: b.supplier_name, amount: b.amount, due_date: b.due_date,
    status: b.status, paid_reference: b.paid_reference,
    // Supplier-provided text is untrusted data. It is labelled so the model treats it as data, not instructions.
    notes: b.notes ? { untrusted_supplier_text: b.notes } : null,
  };
}

export function getOpenBills(db: DB, actor: Actor) {
  const rows = db
    .prepare(
      `SELECT b.*, s.name AS supplier_name FROM bills b JOIN suppliers s ON s.id = b.supplier_id
       WHERE b.business_id = ? AND b.status = 'unpaid' ORDER BY b.due_date`,
    )
    .all(actor.businessId) as BillRow[];
  return rows.map(billView);
}

export function getBill(db: DB, actor: Actor, billId: string) {
  const row = db
    .prepare(`SELECT b.*, s.name AS supplier_name FROM bills b JOIN suppliers s ON s.id = b.supplier_id WHERE b.id = ? AND b.business_id = ?`)
    .get(billId, actor.businessId) as BillRow | undefined;
  if (!row) refuse('not_found', `Bill ${billId} not found.`);
  return billView(row);
}

export function getBusinessOverview(db: DB, actor: Actor, now = new Date()) {
  const biz = business(db, actor);
  const openBills = getOpenBills(db, actor);
  const drafts = db.prepare(`SELECT COUNT(*) AS n FROM purchase_orders WHERE business_id = ? AND status IN ('draft','approved')`).get(actor.businessId) as { n: number };
  return {
    business: biz.name,
    currency: biz.currency,
    cash: getCashPosition(db, actor, now),
    low_stock: listLowStock(db, actor).map((i) => ({ item_id: i.item_id, name: i.name, qty_on_hand: i.qty_on_hand, reorder_threshold: i.reorder_threshold })),
    open_bills: { count: openBills.length, total: openBills.reduce((s, b) => s + b.amount, 0) },
    purchase_orders_awaiting_action: drafts.n,
  };
}

// ── Reorder calculation (pure arithmetic in code, never by the model) ──

export function calculateReorderOptions(
  db: DB, actor: Actor,
  args: { item_id: string; quantity?: number; minimum_cash_reserve?: number },
  now = new Date(),
) {
  const item = itemOf(db, actor, args.item_id);
  const biz = business(db, actor);
  const cash = getCashPosition(db, actor, now);
  const needed = args.quantity ?? Math.max(0, item.target_stock - item.qty_on_hand);
  if (needed <= 0) refuse('nothing_to_order', `${item.name} is at or above target stock.`);
  // A user may ask for a HIGHER reserve than policy; a lower one is ignored.
  const reserve = Math.max(biz.minimum_cash_reserve, args.minimum_cash_reserve ?? 0);
  const available = cash.balance - cash.bills_due_next_7_days - reserve;

  const offers = db
    .prepare(
      `SELECT s.id, s.name, s.lead_time_days, s.reliability_score, p.unit_price, p.min_order_qty
       FROM supplier_prices p JOIN suppliers s ON s.id = p.supplier_id
       WHERE p.item_id = ? AND s.business_id = ?`,
    )
    .all(item.id, actor.businessId) as Array<{ id: string; name: string; lead_time_days: number; reliability_score: number; unit_price: number; min_order_qty: number }>;
  if (!offers.length) refuse('no_suppliers', `No supplier prices on file for ${item.name}.`);

  const options = offers.map((o) => {
    const quantity = Math.max(needed, o.min_order_qty);
    const total = quantity * o.unit_price;
    const cashAfter = cash.balance - cash.bills_due_next_7_days - total;
    const checks = {
      keeps_cash_reserve: cashAfter >= reserve,
      within_max_po_amount: total <= MAX_PO(),
    };
    const reasons: string[] = [];
    if (quantity > needed) reasons.push(`minimum order is ${o.min_order_qty} ${item.unit}s`);
    if (!checks.keeps_cash_reserve) reasons.push(`would leave ${kes(cashAfter)}, below the ${kes(reserve)} reserve`);
    if (!checks.within_max_po_amount) reasons.push(`exceeds the ${kes(MAX_PO())} single-order limit`);
    return {
      supplier_id: o.id, supplier_name: o.name, unit_price: o.unit_price, quantity, total,
      lead_time_days: o.lead_time_days, reliability_score: o.reliability_score,
      projected_cash_after: cashAfter, feasible: checks.keeps_cash_reserve && checks.within_max_po_amount,
      checks, notes: reasons,
    };
  });
  options.sort((a, b) => Number(b.feasible) - Number(a.feasible) || a.total - b.total || b.reliability_score - a.reliability_score);
  const recommended = options.find((o) => o.feasible) ?? null;

  return {
    item: { item_id: item.id, name: item.name, unit: item.unit, qty_on_hand: item.qty_on_hand, reorder_threshold: item.reorder_threshold, target_stock: item.target_stock },
    quantity_needed: needed,
    cash: { balance: cash.balance, bills_due_next_7_days: cash.bills_due_next_7_days, reserve_applied: reserve, available_above_reserve: Math.max(0, available) },
    options,
    recommended_supplier_id: recommended?.supplier_id ?? null,
    recommendation: recommended
      ? `${recommended.supplier_name}: ${recommended.quantity} × ${kes(recommended.unit_price)} = ${kes(recommended.total)}, leaves ${kes(recommended.projected_cash_after)} after bills due this week.`
      : 'No supplier option keeps the cash reserve. Order less or wait for receivables.',
  };
}

let maxPoAmount = 300_000;
export function setMaxPoAmount(value: number): void { maxPoAmount = value; }
function MAX_PO(): number { return maxPoAmount; }

// ── Purchase orders ───────────────────────────────────────────────────

function poPayload(po: { id: string; supplier_id: string; items: PoItem[]; total: number }) {
  return {
    order_id: po.id,
    supplier_id: po.supplier_id,
    items: po.items.map((i) => ({ item_id: i.item_id, quantity: i.quantity, unit_price: i.unit_price })),
    total: po.total,
  };
}

export function poView(db: DB, row: PoRow) {
  const supplier = db.prepare('SELECT name FROM suppliers WHERE id = ?').get(row.supplier_id) as { name: string } | undefined;
  const creator = db.prepare('SELECT display_name FROM users WHERE id = ?').get(row.created_by) as { display_name: string } | undefined;
  const approver = row.approved_by ? (db.prepare('SELECT display_name FROM users WHERE id = ?').get(row.approved_by) as { display_name: string } | undefined) : undefined;
  const approval = db
    .prepare(`SELECT id, expires_at, consumed_at FROM approvals WHERE target_id = ? AND action_type = 'commit_purchase_order' ORDER BY created_at DESC LIMIT 1`)
    .get(row.id) as { id: string; expires_at: string; consumed_at: string | null } | undefined;
  return {
    order_id: row.id,
    supplier_id: row.supplier_id,
    supplier_name: supplier?.name ?? row.supplier_id,
    items: JSON.parse(row.items_json) as PoItem[],
    total: row.total,
    status: row.status,
    notes: row.notes,
    created_by: creator?.display_name ?? row.created_by,
    created_by_id: row.created_by,
    approved_by: approver?.display_name ?? null,
    approval_id: row.status === 'approved' ? (approval?.id ?? null) : null,
    approval_expires_at: row.status === 'approved' ? (approval?.expires_at ?? null) : null,
    commit_reference: row.commit_reference,
    simulated: true,
    created_at: row.created_at,
  };
}

export function createPurchaseOrderDraft(
  db: DB, actor: Actor,
  args: { supplier_id: string; items: Array<{ item_id: string; quantity: number }>; notes?: string; idempotency_key?: string },
  now = new Date(),
) {
  requireRole(actor, ['owner', 'procurement'], 'create purchase orders');
  const supplier = supplierOf(db, actor, args.supplier_id);
  if (!args.items.length) refuse('invalid_items', 'A purchase order needs at least one item.');

  // Prices come from the price list, never from the model.
  const items: PoItem[] = args.items.map((line) => {
    const item = itemOf(db, actor, line.item_id);
    const price = db.prepare('SELECT unit_price, min_order_qty FROM supplier_prices WHERE supplier_id = ? AND item_id = ?').get(supplier.id, item.id) as
      | { unit_price: number; min_order_qty: number } | undefined;
    if (!price) refuse('no_price', `${supplier.name} has no price on file for ${item.name}.`);
    if (!Number.isInteger(line.quantity) || line.quantity <= 0) refuse('invalid_quantity', 'Quantities must be positive whole numbers.');
    if (line.quantity < price.min_order_qty) refuse('below_minimum', `${supplier.name} requires at least ${price.min_order_qty} ${item.unit}s of ${item.name}.`);
    return { item_id: item.id, item_name: item.name, unit: item.unit, quantity: line.quantity, unit_price: price.unit_price, line_total: line.quantity * price.unit_price };
  });
  const total = items.reduce((s, i) => s + i.line_total, 0);

  const idempotencyKey = args.idempotency_key ?? sha256({ s: supplier.id, items: items.map((i) => [i.item_id, i.quantity]), u: actor.userId, d: today(now) }).slice(0, 24);
  const existing = db.prepare('SELECT * FROM purchase_orders WHERE business_id = ? AND idempotency_key = ?').get(actor.businessId, idempotencyKey) as PoRow | undefined;
  if (existing) return { ...poView(db, existing), idempotent_replay: true };

  if (total > MAX_PO()) refuse('over_max_po_amount', `Total ${kes(total)} exceeds the ${kes(MAX_PO())} single-order limit.`);
  const cash = getCashPosition(db, actor, now);
  const cashAfter = cash.balance - cash.bills_due_next_7_days - total;
  if (cashAfter < cash.minimum_cash_reserve) {
    refuse('breaks_cash_reserve', `This order (${kes(total)}) would leave ${kes(cashAfter)} after bills due this week, below the ${kes(cash.minimum_cash_reserve)} reserve.`);
  }

  const id = ref('PO');
  db.prepare(
    `INSERT INTO purchase_orders (id,business_id,supplier_id,items_json,total,status,notes,created_by,idempotency_key,created_at)
     VALUES (?,?,?,?,?,'draft',?,?,?,?)`,
  ).run(id, actor.businessId, supplier.id, JSON.stringify(items), total, (args.notes ?? '').slice(0, 500), actor.userId, idempotencyKey, now.toISOString());
  return { ...poView(db, poOf(db, actor, id)), projected_cash_after: cashAfter, next_step: 'A human must approve this draft in the Orqestra app before it can be placed.' };
}

export function getPurchaseOrder(db: DB, actor: Actor, orderId: string) {
  return poView(db, poOf(db, actor, orderId));
}

export function listPurchaseOrders(db: DB, actor: Actor, limit = 20) {
  const rows = db.prepare('SELECT * FROM purchase_orders WHERE business_id = ? ORDER BY created_at DESC LIMIT ?').all(actor.businessId, limit) as PoRow[];
  return rows.map((r) => poView(db, r));
}

/**
 * HUMAN-ONLY. Called from the app's approval endpoint, never exposed as a model tool.
 * The approval binds to the exact payload (supplier, items, unit prices, total), is one-time and expires.
 */
export function approvePurchaseOrder(db: DB, actor: Actor, orderId: string, now = new Date()) {
  requireRole(actor, ['owner'], 'approve purchase orders');
  const po = poOf(db, actor, orderId);
  if (po.status !== 'draft') refuse('not_draft', `Order ${orderId} is ${po.status}, not a draft.`);
  if (po.created_by === actor.userId) refuse('separation_of_duties', 'The person who drafted an order cannot approve it.');
  const items = JSON.parse(po.items_json) as PoItem[];
  const cash = getCashPosition(db, actor, now);
  if (cash.balance - cash.bills_due_next_7_days - po.total < cash.minimum_cash_reserve) {
    refuse('breaks_cash_reserve', 'Cash has changed since this draft; approving it would break the reserve.');
  }
  const hash = sha256(poPayload({ id: po.id, supplier_id: po.supplier_id, items, total: po.total }));
  const approvalId = ref('APR');
  const expires = new Date(now.getTime() + APPROVAL_TTL_MINUTES * 60_000).toISOString();
  db.transaction(() => {
    db.prepare(`INSERT INTO approvals VALUES (?,?,?,?,?,?,?,?,NULL)`).run(
      approvalId, actor.businessId, actor.userId, 'commit_purchase_order', po.id, hash, now.toISOString(), expires,
    );
    db.prepare(`UPDATE purchase_orders SET status='approved', approved_by=?, approval_payload_hash=? WHERE id=?`).run(actor.userId, hash, po.id);
  })();
  return { approval_id: approvalId, order_id: po.id, expires_at: expires };
}

/** HUMAN-ONLY. */
export function rejectPurchaseOrder(db: DB, actor: Actor, orderId: string) {
  requireRole(actor, ['owner'], 'reject purchase orders');
  const po = poOf(db, actor, orderId);
  if (po.status !== 'draft' && po.status !== 'approved') refuse('not_open', `Order ${orderId} is ${po.status}.`);
  db.prepare(`UPDATE purchase_orders SET status='rejected' WHERE id=?`).run(po.id);
  db.prepare(`UPDATE approvals SET consumed_at=? WHERE target_id=? AND consumed_at IS NULL`).run(new Date().toISOString(), po.id);
  return { order_id: po.id, status: 'rejected' };
}

/** SIMULATED placement of an approved order. Requires a valid, unexpired, unconsumed approval for this exact payload. */
export function commitPurchaseOrder(
  db: DB, actor: Actor,
  args: { order_id: string; approval_id: string; amount: number },
  now = new Date(),
) {
  requireRole(actor, ['owner', 'procurement'], 'place purchase orders');
  const po = poOf(db, actor, args.order_id);
  if (po.status === 'committed') {
    return { ...poView(db, po), idempotent_replay: true, message: 'Already placed; no second order was created.' };
  }
  if (po.status !== 'approved') refuse('not_approved', `Order ${po.id} has not been approved by a human (status: ${po.status}).`);
  if (args.amount !== po.total) refuse('amount_mismatch', `Amount ${kes(args.amount)} does not match the approved total ${kes(po.total)}.`);

  const approval = db.prepare('SELECT * FROM approvals WHERE id = ? AND business_id = ?').get(args.approval_id, actor.businessId) as ApprovalRow | undefined;
  if (!approval || approval.target_id !== po.id || approval.action_type !== 'commit_purchase_order') refuse('invalid_approval', 'That approval does not belong to this order.');
  if (approval.consumed_at) refuse('approval_used', 'That approval has already been used.');
  if (approval.expires_at < now.toISOString()) refuse('approval_expired', 'That approval has expired. Ask the owner to approve again.');

  const items = JSON.parse(po.items_json) as PoItem[];
  const currentHash = sha256(poPayload({ id: po.id, supplier_id: po.supplier_id, items, total: po.total }));
  if (currentHash !== approval.payload_hash || currentHash !== po.approval_payload_hash) {
    refuse('payload_changed', 'The order changed after it was approved. The approval is no longer valid.');
  }
  const cash = getCashPosition(db, actor, now);
  if (cash.balance - cash.bills_due_next_7_days - po.total < cash.minimum_cash_reserve) refuse('breaks_cash_reserve', 'Placing this order now would break the cash reserve.');

  const reference = ref('SIM-PO');
  const result = db.transaction(() => {
    // Consume the approval atomically: only one commit can win.
    const consumed = db.prepare('UPDATE approvals SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL').run(now.toISOString(), approval.id);
    if (consumed.changes !== 1) refuse('approval_used', 'That approval has already been used.');
    db.prepare(`UPDATE purchase_orders SET status='committed', commit_reference=? WHERE id=?`).run(reference, po.id);
    db.prepare('UPDATE cash_accounts SET balance = balance - ? WHERE business_id = ?').run(po.total, actor.businessId);
    return poView(db, poOf(db, actor, po.id));
  })();
  return { ...result, simulated: true, message: `SIMULATED: order ${reference} recorded. No real supplier was contacted.` };
}

// ── Bills and payouts ─────────────────────────────────────────────────

export function payBill(db: DB, actor: Actor, args: { bill_id: string; amount: number; method: 'mpesa' | 'bank' }, now = new Date()) {
  requireRole(actor, ['owner', 'accountant'], 'pay bills');
  const bill = db.prepare('SELECT * FROM bills WHERE id = ? AND business_id = ?').get(args.bill_id, actor.businessId) as BillRow | undefined;
  if (!bill) refuse('not_found', `Bill ${args.bill_id} not found.`);
  if (bill.status === 'paid') return { bill_id: bill.id, status: 'paid', paid_reference: bill.paid_reference, idempotent_replay: true };
  if (args.amount !== bill.amount) refuse('amount_mismatch', `Amount ${kes(args.amount)} does not match the bill amount ${kes(bill.amount)}.`);
  const supplier = supplierOf(db, actor, bill.supplier_id);
  if (!supplier.payout_verified) {
    refuse('payout_unverified', `${supplier.name}'s payout details changed recently and have not been verified by phone. Payment refused.`);
  }
  const cash = getCashPosition(db, actor, now);
  if (cash.balance - args.amount < cash.minimum_cash_reserve) {
    refuse('breaks_cash_reserve', `Paying ${kes(args.amount)} would leave ${kes(cash.balance - args.amount)}, below the ${kes(cash.minimum_cash_reserve)} reserve.`);
  }
  const reference = ref(args.method === 'mpesa' ? 'SIM-MPESA' : 'SIM-BANK');
  db.transaction(() => {
    const updated = db.prepare(`UPDATE bills SET status='paid', paid_reference=? WHERE id=? AND status='unpaid'`).run(reference, bill.id);
    if (updated.changes !== 1) refuse('already_paid', 'Bill was paid concurrently.');
    db.prepare('UPDATE cash_accounts SET balance = balance - ? WHERE business_id = ?').run(args.amount, actor.businessId);
  })();
  return {
    bill_id: bill.id, supplier_name: supplier.name, amount: bill.amount, status: 'paid', paid_reference: reference,
    paid_to: `${supplier.payout_method} ${maskAccount(supplier.payout_account)}`, simulated: true,
    message: `SIMULATED payment ${reference}. No real money moved.`,
  };
}

export function updateSupplierPayoutDetails(
  db: DB, actor: Actor,
  args: { supplier_id: string; payout_method: 'mpesa_paybill' | 'bank'; payout_account: string },
) {
  requireRole(actor, ['owner', 'accountant'], 'change supplier payout details');
  const supplier = supplierOf(db, actor, args.supplier_id);
  const account = args.payout_account.trim();
  if (!/^[0-9][0-9-]{4,24}$/.test(account)) refuse('invalid_account', 'Payout account must be digits (and dashes).');
  db.prepare('UPDATE suppliers SET payout_method=?, payout_account=?, payout_verified=0 WHERE id=?').run(args.payout_method, account, supplier.id);
  return {
    supplier_id: supplier.id, supplier_name: supplier.name,
    previous: `${supplier.payout_method} ${maskAccount(supplier.payout_account)}`,
    updated_to: `${args.payout_method} ${maskAccount(account)}`,
    payout_verified: false,
    message: 'Payout details changed. Payments to this supplier stay blocked until verified by phone.',
  };
}

// ── Sensitive and exfiltration-shaped tools (exist to be governed) ─────

export function getPayrollSummary(db: DB, actor: Actor, period?: string) {
  requireRole(actor, ['owner'], 'view payroll');
  const row = (period
    ? db.prepare('SELECT * FROM payroll_summary WHERE business_id = ? AND period = ?').get(actor.businessId, period)
    : db.prepare('SELECT * FROM payroll_summary WHERE business_id = ? ORDER BY period DESC LIMIT 1').get(actor.businessId)) as
    | { period: string; headcount: number; total_gross: number } | undefined;
  if (!row) refuse('not_found', 'No payroll summary for that period.');
  return { period: row.period, headcount: row.headcount, total_gross: row.total_gross, note: 'Aggregate only; no individual records.' };
}

export function exportSupplierList(db: DB, actor: Actor, args: { destination: string }, now = new Date()) {
  const suppliers = db.prepare('SELECT id FROM suppliers WHERE business_id = ?').all(actor.businessId) as Array<{ id: string }>;
  const id = ref('SIM-EXPORT');
  db.prepare('INSERT INTO data_exports VALUES (?,?,?,?,?,?,?)').run(id, actor.businessId, actor.userId, 'suppliers', args.destination.slice(0, 200), suppliers.length, now.toISOString());
  return { export_id: id, records: suppliers.length, destination: args.destination, simulated: true, message: `SIMULATED export of ${suppliers.length} supplier records.` };
}
