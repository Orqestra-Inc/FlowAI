import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, seed, type DB } from '../server/db.js';
import * as ops from '../server/domain/operations.js';
import { DomainRefusal, type Actor } from '../server/domain/types.js';
import { executeTool } from '../server/tools/registry.js';

const owner: Actor = { userId: 'usr_owner', email: 'owner@baraka.demo', businessId: 'biz_baraka', role: 'owner', displayName: 'Owner' };
const procurement: Actor = { userId: 'usr_procurement', email: 'procurement@baraka.demo', businessId: 'biz_baraka', role: 'procurement', displayName: 'Procurement' };
const accountant: Actor = { userId: 'usr_accountant', email: 'accountant@baraka.demo', businessId: 'biz_baraka', role: 'accountant', displayName: 'Accountant' };
const otherOwner: Actor = { userId: 'usr_other_owner', email: 'owner@other.demo', businessId: 'biz_other', role: 'owner', displayName: 'Other' };

let db: DB;

/** Every business table, so a refused action can be proven to change nothing. */
function snapshot(d: DB) {
  const tables = ['purchase_orders', 'approvals', 'bills', 'cash_accounts', 'suppliers', 'data_exports'];
  return Object.fromEntries(tables.map((t) => [t, d.prepare(`SELECT * FROM ${t} ORDER BY 1`).all()]));
}

function expectRefusal(fn: () => unknown, code: string) {
  const before = snapshot(db);
  let thrown: unknown;
  try {
    fn();
  } catch (e) {
    thrown = e;
  }
  expect(thrown, `expected refusal ${code}`).toBeInstanceOf(DomainRefusal);
  expect((thrown as DomainRefusal).code).toBe(code);
  expect(snapshot(db)).toEqual(before); // denied actions leave the DB unchanged
}

function draftOil(actor = procurement) {
  return ops.createPurchaseOrderDraft(db, actor, { supplier_id: 'sup_kisumu', items: [{ item_id: 'itm_oil', quantity: 40 }] });
}

beforeEach(() => {
  db = openDb(':memory:');
  seed(db);
  ops.setMaxPoAmount(300_000);
});

describe('reorder recommendation', () => {
  it('rejects the cheapest bulk option because it breaks the reserve, and recommends a feasible one', () => {
    const r = ops.calculateReorderOptions(db, procurement, { item_id: 'itm_oil', minimum_cash_reserve: 80_000 });
    expect(r.quantity_needed).toBe(40);
    const mombasa = r.options.find((o) => o.supplier_id === 'sup_mombasa')!;
    expect(mombasa.quantity).toBe(60);
    expect(mombasa.feasible).toBe(false);
    expect(r.recommended_supplier_id).toBe('sup_kisumu');
    expect(r.options.find((o) => o.supplier_id === 'sup_kisumu')!.total).toBe(131_200);
  });

  it('ignores a user-requested reserve lower than company policy', () => {
    const r = ops.calculateReorderOptions(db, procurement, { item_id: 'itm_oil', minimum_cash_reserve: 1 });
    expect(r.cash.reserve_applied).toBe(80_000);
  });
});

describe('purchase order drafts', () => {
  it('creates a draft priced from the price list', () => {
    const po = draftOil();
    expect(po.status).toBe('draft');
    expect(po.total).toBe(131_200);
    expect(po.items[0].unit_price).toBe(3_280);
  });

  it('ignores any model-supplied price (schema rejects unknown keys)', () => {
    const out = executeTool(db, procurement, 'create_purchase_order_draft', {
      supplier_id: 'sup_kisumu', items: [{ item_id: 'itm_oil', quantity: 40, unit_price: 1 }],
    });
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.code).toBe('invalid_arguments');
  });

  it('refuses an order that would break the cash reserve', () => {
    expectRefusal(() => ops.createPurchaseOrderDraft(db, procurement, { supplier_id: 'sup_mombasa', items: [{ item_id: 'itm_oil', quantity: 60 }] }), 'breaks_cash_reserve');
  });

  it('refuses an order above the max PO amount', () => {
    ops.setMaxPoAmount(100_000);
    expectRefusal(() => draftOil(), 'over_max_po_amount');
  });

  it('is idempotent: the same request twice creates one draft', () => {
    const a = draftOil();
    const b = draftOil();
    expect(b.order_id).toBe(a.order_id);
    expect(db.prepare('SELECT COUNT(*) AS n FROM purchase_orders').get()).toEqual({ n: 1 });
  });

  it('accountants cannot create orders', () => {
    expectRefusal(() => draftOil(accountant), 'role_not_permitted');
  });
});

describe('approval gate', () => {
  it('commit without approval is refused and changes nothing', () => {
    const po = draftOil();
    expectRefusal(() => ops.commitPurchaseOrder(db, owner, { order_id: po.order_id, approval_id: 'APR-FAKE', amount: po.total }), 'not_approved');
  });

  it('the drafter cannot approve their own order', () => {
    const po = draftOil(owner);
    expectRefusal(() => ops.approvePurchaseOrder(db, owner, po.order_id), 'separation_of_duties');
  });

  it('only the owner can approve', () => {
    const po = draftOil();
    expectRefusal(() => ops.approvePurchaseOrder(db, accountant, po.order_id), 'role_not_permitted');
  });

  it('approve then commit works once, deducts cash once, and a replay creates nothing new', () => {
    const po = draftOil();
    const apr = ops.approvePurchaseOrder(db, owner, po.order_id);
    const done = ops.commitPurchaseOrder(db, owner, { order_id: po.order_id, approval_id: apr.approval_id, amount: po.total });
    expect(done.status).toBe('committed');
    expect(done.commit_reference).toMatch(/^SIM-PO-/);
    expect(ops.getCashPosition(db, owner).balance).toBe(280_000 - 131_200);
    const again = ops.commitPurchaseOrder(db, owner, { order_id: po.order_id, approval_id: apr.approval_id, amount: po.total });
    expect((again as { idempotent_replay?: boolean }).idempotent_replay).toBe(true);
    expect(ops.getCashPosition(db, owner).balance).toBe(280_000 - 131_200);
  });

  it('a payload changed after approval invalidates the approval', () => {
    const po = draftOil();
    const apr = ops.approvePurchaseOrder(db, owner, po.order_id);
    db.prepare('UPDATE purchase_orders SET items_json = ? WHERE id = ?').run(
      JSON.stringify([{ ...po.items[0], unit_price: 3_000, line_total: 120_000 }]),
      po.order_id,
    );
    expectRefusal(() => ops.commitPurchaseOrder(db, owner, { order_id: po.order_id, approval_id: apr.approval_id, amount: po.total }), 'payload_changed');
  });

  it('an expired approval is refused', () => {
    const po = draftOil();
    const apr = ops.approvePurchaseOrder(db, owner, po.order_id, new Date(Date.now() - 60 * 60_000));
    expectRefusal(() => ops.commitPurchaseOrder(db, owner, { order_id: po.order_id, approval_id: apr.approval_id, amount: po.total }), 'approval_expired');
  });

  it('the amount must match the approved total', () => {
    const po = draftOil();
    const apr = ops.approvePurchaseOrder(db, owner, po.order_id);
    expectRefusal(() => ops.commitPurchaseOrder(db, owner, { order_id: po.order_id, approval_id: apr.approval_id, amount: 1_000 }), 'amount_mismatch');
  });

  it('an approval for one order cannot be used on another', () => {
    const a = draftOil();
    const aprA = ops.approvePurchaseOrder(db, owner, a.order_id);
    const b = ops.createPurchaseOrderDraft(db, procurement, { supplier_id: 'sup_nakuru', items: [{ item_id: 'itm_rice', quantity: 5 }] });
    ops.approvePurchaseOrder(db, owner, b.order_id);
    expectRefusal(() => ops.commitPurchaseOrder(db, owner, { order_id: b.order_id, approval_id: aprA.approval_id, amount: b.total }), 'invalid_approval');
  });
});

describe('bills and payout fraud', () => {
  it('pays a legitimate bill once (simulated)', () => {
    const r = ops.payBill(db, accountant, { bill_id: 'INV-104', amount: 38_500, method: 'mpesa' });
    expect(r.paid_reference).toMatch(/^SIM-MPESA-/);
    const again = ops.payBill(db, accountant, { bill_id: 'INV-104', amount: 38_500, method: 'mpesa' });
    expect(again.idempotent_replay).toBe(true);
    expect(ops.getCashPosition(db, owner).balance).toBe(280_000 - 38_500);
  });

  it('after payout details change, payment to that supplier is refused even without ArmorIQ', () => {
    ops.updateSupplierPayoutDetails(db, accountant, { supplier_id: 'sup_rvpack', payout_method: 'bank', payout_account: '0110-4482-9917' });
    expectRefusal(() => ops.payBill(db, accountant, { bill_id: 'INV-107', amount: 480_000, method: 'bank' }), 'payout_unverified');
  });

  it('bill notes are labelled as untrusted supplier text', () => {
    const bill = ops.getBill(db, accountant, 'INV-107');
    expect(bill.notes).toHaveProperty('untrusted_supplier_text');
  });

  it('procurement cannot pay bills', () => {
    expectRefusal(() => ops.payBill(db, procurement, { bill_id: 'INV-104', amount: 38_500, method: 'mpesa' }), 'role_not_permitted');
  });
});

describe('role and tenant boundaries', () => {
  it('only the owner can read payroll', () => {
    expect(ops.getPayrollSummary(db, owner).total_gross).toBe(1_184_000);
    expectRefusal(() => ops.getPayrollSummary(db, procurement), 'role_not_permitted');
    expectRefusal(() => ops.getPayrollSummary(db, accountant), 'role_not_permitted');
  });

  it("one business cannot read or act on another business's records", () => {
    expectRefusal(() => ops.getBill(db, otherOwner, 'INV-107'), 'not_found');
    expectRefusal(() => ops.listSuppliers(db, otherOwner, 'itm_oil'), 'not_found');
    const po = draftOil();
    expectRefusal(() => ops.approvePurchaseOrder(db, otherOwner, po.order_id), 'not_found');
    expect(ops.getOpenBills(db, otherOwner).map((b) => b.bill_id)).toEqual(['INV-OTH-1']);
  });
});

describe('audit-safe output', () => {
  it('masks supplier account numbers in reads', () => {
    const s = ops.listSuppliers(db, owner).find((x) => x.supplier_id === 'sup_kisumu')!;
    expect(s.payout_account).toBe('••••2208');
  });
});
