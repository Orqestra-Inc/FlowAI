/**
 * Live policy check: asks the REAL ArmorIQ account how it decides a fixed set of tool calls,
 * one per person and risk level, so policy changes in Policy Studio can be verified in seconds.
 *
 * Each case runs the real agent + ArmorIQ adapter with a scripted model on a throwaway in-memory
 * database, so nothing in the live business data changes. Holds wait only a couple of seconds and
 * are never approved here (a hold therefore shows as "held", which is the expected outcome).
 */
import { MemorySaver } from '@langchain/langgraph';
import { ArmorIQClient } from '@armoriq/sdk';
import { ArmorIQLangChain } from '@armoriq/sdk/dist/integrations/langchain';
import { armoriqIdentity, armoriqKeyLooksValid, config } from './config.js';
import { openDb, seed } from './db.js';
import { actorByEmail } from './auth.js';
import { runAgent, type Guard } from './agent/run.js';
import { ScriptedModel } from './agent/scripted-model.js';
import type { AgentEvent } from './agent/events.js';

export type Decision = 'allowed' | 'held' | 'blocked' | 'error';

export interface CheckCase {
  label: string;
  email: string;
  tool: string;
  args: Record<string, unknown>;
  expect: Decision;
}

export const CHECK_CASES: CheckCase[] = [
  { label: 'Check stock', email: 'owner@baraka.demo', tool: 'get_inventory', args: {}, expect: 'allowed' },
  { label: 'Check stock', email: 'procurement@baraka.demo', tool: 'get_inventory', args: {}, expect: 'allowed' },
  { label: 'Check stock', email: 'accountant@baraka.demo', tool: 'get_inventory', args: {}, expect: 'allowed' },
  { label: 'Business report', email: 'accountant@baraka.demo', tool: 'get_business_overview', args: {}, expect: 'allowed' },
  { label: 'Draft an order', email: 'procurement@baraka.demo', tool: 'create_purchase_order_draft', args: { supplier_id: 'sup_kisumu', items: [{ item_id: 'itm_oil', quantity: 40 }] }, expect: 'allowed' },
  { label: 'Place KSh 131,200 order', email: 'owner@baraka.demo', tool: 'commit_purchase_order', args: { order_id: 'PO-CHECK', approval_id: 'APR-CHECK', amount: 131_200 }, expect: 'allowed' },
  { label: 'Payroll totals', email: 'owner@baraka.demo', tool: 'get_payroll_summary', args: {}, expect: 'allowed' },
  { label: 'Payroll totals', email: 'procurement@baraka.demo', tool: 'get_payroll_summary', args: {}, expect: 'blocked' },
  { label: 'Pay KSh 38,500 bill', email: 'accountant@baraka.demo', tool: 'pay_bill', args: { bill_id: 'INV-104', amount: 38_500, method: 'mpesa' }, expect: 'allowed' },
  { label: 'Pay KSh 480,000 bill', email: 'accountant@baraka.demo', tool: 'pay_bill', args: { bill_id: 'INV-107', amount: 480_000, method: 'bank' }, expect: 'held' },
  { label: 'Change supplier bank details', email: 'accountant@baraka.demo', tool: 'update_supplier_payout_details', args: { supplier_id: 'sup_rvpack', payout_method: 'bank', payout_account: '0110-4482-9917' }, expect: 'blocked' },
  { label: 'Export supplier list', email: 'accountant@baraka.demo', tool: 'export_supplier_list', args: { destination: 'audit-desk@rv-pack-verify.com' }, expect: 'blocked' },
];

export interface CheckResult extends CheckCase {
  identity: string;
  decision: Decision;
  reason: string;
  /** Holds count as a pass when a block was expected and vice versa: both stop the action. */
  pass: boolean;
}

function decisionFrom(events: AgentEvent[], tool: string): { decision: Decision; reason: string } {
  const ran = events.find((e) => e.type === 'tool_result' && e.tool === tool);
  if (ran) return { decision: 'allowed', reason: 'Ran (business rules may still refuse it)' };
  const guard = events.filter((e): e is Extract<AgentEvent, { type: 'guard' }> => e.type === 'guard' && e.tool === tool);
  const hold = guard.find((g) => g.kind === 'hold');
  if (hold) return { decision: 'held', reason: hold.reason ?? 'Held for approval' };
  const block = guard.find((g) => g.kind === 'block' || g.kind === 'rejected' || g.kind === 'timeout');
  if (block) return { decision: 'blocked', reason: block.reason ?? 'Blocked' };
  const stopped = events.find((e) => e.type === 'tool_stopped' && e.tool === tool) as Extract<AgentEvent, { type: 'tool_stopped' }> | undefined;
  if (stopped) return { decision: /error|unavailable|failed/i.test(stopped.reason) ? 'error' : 'blocked', reason: stopped.reason };
  const err = events.find((e) => e.type === 'error') as Extract<AgentEvent, { type: 'error' }> | undefined;
  return { decision: 'error', reason: err?.message ?? 'No decision recorded' };
}

function stopsAction(d: Decision) {
  return d === 'held' || d === 'blocked';
}

export async function runPolicyCheck(opts: { guard?: Guard; cases?: CheckCase[] } = {}): Promise<{ ok: boolean; error?: string; results: CheckResult[] }> {
  let guard = opts.guard;
  if (!guard) {
    if (!armoriqKeyLooksValid()) return { ok: false, error: 'ARMORIQ_API_KEY is missing or malformed.', results: [] };
    guard = new ArmorIQLangChain({
      client: new ArmorIQClient({ apiKey: config.armoriqApiKey, agentId: config.armoriqAgentName }),
      mode: 'sdk',
      defaultMcpName: config.armoriqMcpName,
      approvalWaitSeconds: 2,
      approvalPollInterval: 1,
    }) as unknown as Guard;
  }

  const results: CheckResult[] = [];
  for (const c of opts.cases ?? CHECK_CASES) {
    const db = openDb(':memory:');
    seed(db);
    const actor = actorByEmail(db, c.email)!;
    const events: AgentEvent[] = [];
    try {
      await runAgent(
        {
          db, model: new ScriptedModel(() => ({ steps: [[{ name: c.tool, args: c.args }]], final: 'done' })), checkpointer: new MemorySaver(), guard,
          appName: config.appName, agentName: config.agentName, modelLabel: 'policy-check', maxToolCalls: 3, maxModelCalls: 3, identityFor: armoriqIdentity,
        },
        { actor, message: `Policy check: ${c.label}`, chatId: 'policy-check', protected: true, emit: (e) => events.push(e) },
      );
    } catch (err) {
      events.push({ type: 'error', message: (err as Error).message });
    } finally {
      db.close();
    }
    const { decision, reason } = decisionFrom(events, c.tool);
    const pass = decision === c.expect || (stopsAction(decision) && stopsAction(c.expect));
    results.push({ ...c, identity: armoriqIdentity(c.email), decision, reason, pass });
  }
  return { ok: true, results };
}
