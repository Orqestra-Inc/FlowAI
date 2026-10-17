import { describe, expect, it } from 'vitest';
import { ArmorIQLangChain } from '@armoriq/sdk/dist/integrations/langchain';
import { CHECK_CASES, runPolicyCheck } from '../server/policy-check.js';
import { armoriqIdentity, config } from '../server/config.js';

process.env.LANGCHAIN_CALLBACKS_BACKGROUND = 'false';

/** Fake ArmorIQ backend behind the REAL adapter. */
function guardFrom(decide: (tool: string, args: any, email: string) => any) {
  const client = {
    bootstrap: async () => ({ toolMap: {} }),
    invalidateUser: () => {},
    forUser: (email: string) => ({
      startSession: () => ({
        startPlan: async () => {},
        check: async (tool: string, args: any) => decide(tool, args, email),
        awaitApproval: async () => 'timeout',
        report: async () => {},
        close: async () => {},
      }),
    }),
  };
  return new ArmorIQLangChain({ client: client as any, mode: 'sdk', approvalWaitSeconds: 1, approvalPollInterval: 1 }) as any;
}

describe('live policy check', () => {
  it('reports every case as blocked when no policy matches (the fail-closed default)', async () => {
    const r = await runPolicyCheck({ guard: guardFrom(() => ({ allowed: false, action: 'block', reason: 'no_matching_policy' })) });
    expect(r.ok).toBe(true);
    expect(r.results.every((x) => x.decision === 'blocked')).toBe(true);
    expect(r.results.find((x) => x.tool === 'get_inventory')!.pass).toBe(false);
    expect(r.results.find((x) => x.tool === 'export_supplier_list')!.pass).toBe(true);
  });

  it('passes every case under the intended policy', async () => {
    const limits: Record<string, number> = { 'owner@baraka.demo': 500_000, 'procurement@baraka.demo': 50_000, 'accountant@baraka.demo': 100_000 };
    const r = await runPolicyCheck({
      guard: guardFrom((tool, args, email) => {
        if (tool === 'export_supplier_list' || tool === 'update_supplier_payout_details') return { allowed: false, action: 'block', reason: 'not allowed' };
        if (tool === 'get_payroll_summary' && email !== 'owner@baraka.demo') return { allowed: false, action: 'block', reason: 'owner only' };
        if (Number(args?.amount) > limits[email]) return { allowed: false, action: 'hold', reason: 'over limit', delegationId: 'd1' };
        return { allowed: true, action: 'allow' };
      }),
    });
    const failing = r.results.filter((x) => !x.pass).map((x) => `${x.label}/${x.email}: ${x.decision} ${x.reason}`);
    expect(failing).toEqual([]);
    expect(r.results).toHaveLength(CHECK_CASES.length);
  });

  it('maps identities only when configured', () => {
    expect(armoriqIdentity('owner@baraka.demo')).toBe('owner@baraka.demo');
    config.armoriqIdentityMap['owner@baraka.demo'] = 'me@example.com';
    expect(armoriqIdentity('Owner@Baraka.demo')).toBe('me@example.com');
    delete config.armoriqIdentityMap['owner@baraka.demo'];
  });
});
