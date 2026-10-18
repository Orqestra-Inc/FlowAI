import { describe, expect, it } from 'vitest';
import { MemorySaver } from '@langchain/langgraph';
import { ArmorIQLangChain } from '@armoriq/sdk/dist/integrations/langchain';
import { runAgent } from '../server/agent/run.js';
import { ScriptedModel } from '../server/agent/scripted-model.js';
import { openDb, seed } from '../server/db.js';
import { actorByEmail } from '../server/auth.js';
import type { AgentEvent } from '../server/agent/events.js';

process.env.LANGCHAIN_CALLBACKS_BACKGROUND = 'false';

describe('a model that keeps retrying a refused action', () => {
  it('gets one ArmorIQ hold, not a new hold per retry, and the run ends cleanly', async () => {
    const checks: string[] = [];
    const client = {
      bootstrap: async () => ({ toolMap: {} }),
      invalidateUser: () => {},
      forUser: () => ({
        startSession: () => ({
          startPlan: async () => {},
          check: async (tool: string, args: any) => {
            checks.push(`${tool}:${args?.amount ?? ''}`);
            return Number(args?.amount) > 100_000 ? { allowed: false, action: 'hold', reason: 'above limit', delegationId: 'd1' } : { allowed: true, action: 'allow' };
          },
          awaitApproval: async () => 'timeout',
          report: async () => {},
          close: async () => {},
        }),
      }),
    };
    const guard = new ArmorIQLangChain({ client: client as any, mode: 'sdk', approvalWaitSeconds: 1, approvalPollInterval: 1 }) as any;
    const big = { name: 'pay_bill', args: { bill_id: 'INV-107', amount: 480_000, method: 'bank' } };
    const small = { name: 'pay_bill', args: { bill_id: 'INV-104', amount: 38_500, method: 'mpesa' } };
    // The model retries the refused payment five times, then pays a different, legitimate bill.
    const model = new ScriptedModel(() => ({ steps: [[big], [big], [big], [big], [big], [small]], final: 'done' }));

    const db = openDb(':memory:');
    seed(db);
    const events: AgentEvent[] = [];
    await runAgent(
      { db, model, checkpointer: new MemorySaver(), guard, appName: 'Orqestra', agentName: 'Flow', modelLabel: 't', maxToolCalls: 12, maxModelCalls: 10 },
      { actor: actorByEmail(db, 'accountant@baraka.demo')!, message: 'pay the bills', chatId: 'c', protected: true, emit: (e) => events.push(e) },
    );

    expect(checks.filter((c) => c === 'pay_bill:480000')).toHaveLength(1); // one hold only
    expect(checks).toContain('pay_bill:38500'); // a different payment is still checked and allowed
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect((db.prepare("SELECT status FROM bills WHERE id='INV-107'").get() as any).status).toBe('unpaid');
    expect((db.prepare("SELECT status FROM bills WHERE id='INV-104'").get() as any).status).toBe('paid');
  });
});
