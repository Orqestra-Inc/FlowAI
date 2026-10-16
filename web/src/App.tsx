import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, kes, streamChat, type ActivityRow, type AgentEvent, type AppConfig, type PurchaseOrder, type User } from './api';
import { argSummary, deriveSlips, STAMP_TEXT, TOOL_LABEL, type Slip } from './ledger';

interface Turn {
  id: string;
  message: string;
  protected: boolean;
  events: AgentEvent[];
  running: boolean;
  error?: string;
}

const PROMPTS: Record<User['role'], string[]> = {
  procurement: [
    "We're low on cooking oil. Recommend a supplier and prepare an order, but keep cash above KSh 80,000.",
    'Which items are below their reorder level?',
  ],
  owner: [
    'What needs my attention today?',
    'Show me this month’s payroll totals.',
  ],
  accountant: [
    'Process all of this week’s open supplier bills, including Rift Valley Packaging.',
    'Also show me this month’s payroll totals.',
  ],
};

const ROLE_NOTE: Record<User['role'], string> = {
  owner: 'Approves orders. Can see payroll.',
  procurement: 'Restocks and drafts purchase orders.',
  accountant: 'Pays supplier bills.',
};

export function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [user, setUser] = useState<User | null | undefined>(undefined);

  useEffect(() => {
    api.config().then(setConfig).catch(() => setConfig(null));
    api.me().then((r) => setUser(r.user)).catch(() => setUser(null));
  }, []);

  if (user === undefined || !config) return <div className="boot" aria-busy="true" />;
  if (!user) return <SignIn config={config} onSignedIn={setUser} />;
  return <Desk config={config} user={user} onSignOut={() => api.logout().then(() => setUser(null))} onSwitch={setUser} />;
}

// ── Sign in ──────────────────────────────────────────────────────────

function SignIn({ config, onSignedIn }: { config: AppConfig; onSignedIn: (u: User) => void }) {
  const [accounts, setAccounts] = useState<Array<{ email: string; role: User['role']; display_name: string }>>([]);
  const [error, setError] = useState('');
  const [code, setCode] = useState('');
  useEffect(() => {
    api.demoUsers().then(setAccounts).catch(() => setError('Demo accounts are unavailable.'));
  }, []);
  return (
    <main className="signin">
      <div className="signin-inner">
        <p className="wordmark">{config.appName}</p>
        <h1>Run the business by asking. Nothing risky happens without a check.</h1>
        <p className="lede">
          Baraka Fresh Distributors is a demo wholesaler in Nairobi. Sign in as one of its people to see what each one is allowed to do.
        </p>
        {config.requireAccessCode && (
          <label className="field access">
            <span>Access code</span>
            <input value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" placeholder="From the submission notes" />
          </label>
        )}
        <div className="accounts">
          {accounts.map((a) => (
            <button key={a.email} className="account" onClick={() => api.login(a.email, code).then((r) => onSignedIn(r.user)).catch((e) => setError(e.message))}>
              <span className="account-name">{a.display_name.replace(/ \(.*\)$/, '')}</span>
              <span className="account-role">{a.role}</span>
              <span className="account-note">{ROLE_NOTE[a.role]}</span>
            </button>
          ))}
        </div>
        {error && <p className="error">{error}</p>}
        <p className="fineprint">Demo data. Supplier orders, payments and exports are simulated; no real money or data moves.</p>
      </div>
    </main>
  );
}

// ── Main desk ────────────────────────────────────────────────────────

function Desk({ config, user, onSignOut, onSwitch }: { config: AppConfig; user: User; onSignOut: () => void; onSwitch: (u: User) => void }) {
  const [view, setView] = useState<'chat' | 'activity'>('chat');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [chatId, setChatId] = useState(() => crypto.randomUUID().slice(0, 12));
  const [ledgerOpen, setLedgerOpen] = useState(false);
  const [unprotected, setUnprotected] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  // A new person gets a new conversation.
  useEffect(() => {
    setTurns([]);
    setChatId(crypto.randomUUID().slice(0, 12));
    setUnprotected(false);
  }, [user.userId]);

  const running = turns.some((t) => t.running);
  const current = turns[turns.length - 1];

  const send = useCallback(
    async (message: string) => {
      const id = crypto.randomUUID();
      const turn: Turn = { id, message, protected: !unprotected, events: [], running: true };
      setTurns((ts) => [...ts, turn]);
      const update = (fn: (t: Turn) => Turn) => setTurns((ts) => ts.map((t) => (t.id === id ? fn(t) : t)));
      try {
        await streamChat({ message, chatId, unprotected }, (e) => update((t) => ({ ...t, events: [...t.events, e] })));
      } catch (err) {
        update((t) => ({ ...t, error: (err as Error).message }));
      } finally {
        update((t) => ({ ...t, running: false }));
        setRefreshKey((k) => k + 1);
      }
    },
    [chatId, unprotected],
  );

  const switchTo = async (email: string) => {
    const r = await api.login(email);
    onSwitch(r.user);
  };

  return (
    <div className={`desk ${unprotected ? 'is-unprotected' : ''}`}>
      <aside className="rail">
        <p className="wordmark">{config.appName}</p>
        <p className="rail-business">Baraka Fresh Distributors</p>
        <nav className="rail-nav" aria-label="Views">
          <button aria-current={view === 'chat'} onClick={() => setView('chat')}>Ask {config.agentName}</button>
          <button aria-current={view === 'activity'} onClick={() => setView('activity')}>Activity</button>
        </nav>
        <Overview refreshKey={refreshKey} />
        <div className="rail-foot">
          <label className="field">
            <span>Signed in as</span>
            <select value={user.email} onChange={(e) => switchTo(e.target.value)} disabled={running}>
              <option value="owner@baraka.demo">Grace, owner</option>
              <option value="procurement@baraka.demo">Brian, procurement</option>
              <option value="accountant@baraka.demo">Faith, accountant</option>
            </select>
          </label>
          {config.demoMode && (
            <button className="quiet" disabled={running} onClick={() => api.reset().then(() => { setTurns([]); setRefreshKey((k) => k + 1); })}>
              Reset demo data
            </button>
          )}
          <button className="quiet" onClick={onSignOut}>Sign out</button>
        </div>
      </aside>

      <main className="main">
        <div className="banner" role="note">
          {unprotected
            ? 'ArmorIQ is OFF for your next request. Tools will run unchecked. Demo only.'
            : 'Demo data. Orders, payments and exports are simulated.'}
        </div>
        {view === 'chat' ? (
          <Conversation
            config={config}
            user={user}
            turns={turns}
            running={running}
            unprotected={unprotected}
            setUnprotected={setUnprotected}
            onSend={send}
            onShowLedger={() => setLedgerOpen(true)}
          />
        ) : (
          <Activity refreshKey={refreshKey} agentName={config.agentName} />
        )}
      </main>

      <Ledger turn={current} config={config} open={ledgerOpen} onClose={() => setLedgerOpen(false)} />
    </div>
  );
}

function Overview({ refreshKey }: { refreshKey: number }) {
  const [data, setData] = useState<any>(null);
  useEffect(() => {
    api.overview().then(setData).catch(() => setData(null));
  }, [refreshKey]);
  if (!data) return null;
  return (
    <dl className="figures">
      <div><dt>Cash</dt><dd>{kes(data.cash.balance)}</dd></div>
      <div><dt>Reserve</dt><dd>{kes(data.cash.minimum_cash_reserve)}</dd></div>
      <div><dt>Free to spend</dt><dd>{kes(data.cash.available_to_spend_above_reserve)}</dd></div>
      <div><dt>Open bills</dt><dd>{kes(data.open_bills.total)} across {data.open_bills.count}</dd></div>
      <div><dt>Low stock</dt><dd>{data.low_stock.map((i: any) => i.name).join(', ') || 'None'}</dd></div>
    </dl>
  );
}

// ── Conversation ─────────────────────────────────────────────────────

function Conversation(props: {
  config: AppConfig; user: User; turns: Turn[]; running: boolean; unprotected: boolean;
  setUnprotected: (v: boolean) => void; onSend: (m: string) => void; onShowLedger: () => void;
}) {
  const { config, user, turns, running, unprotected, setUnprotected, onSend, onShowLedger } = props;
  const [draft, setDraft] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }), [turns]);

  const submit = (text: string) => {
    const t = text.trim();
    if (!t || running) return;
    setDraft('');
    onSend(t);
  };

  return (
    <section className="conversation" aria-label="Conversation">
      <div className="thread">
        {turns.length === 0 && (
          <div className="empty">
            <h2>Good to see you, {user.displayName.split(' ')[0]}.</h2>
            <p>Ask {config.agentName} in plain words. Try one of these:</p>
          </div>
        )}
        {turns.map((t) => (
          <TurnView key={t.id} turn={t} user={user} agentName={config.agentName} onSend={submit} onShowLedger={onShowLedger} />
        ))}
        <div ref={endRef} />
      </div>

      <form className="composer" onSubmit={(e) => { e.preventDefault(); submit(draft); }}>
        <div className="chips">
          {PROMPTS[user.role].map((p) => (
            <button type="button" key={p} className="chip" disabled={running} onClick={() => submit(p)}>{p}</button>
          ))}
        </div>
        <div className="composer-row">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(draft); } }}
            placeholder={running ? `${config.agentName} is working…` : `Ask ${config.agentName} about stock, suppliers, bills or cash`}
            rows={2}
            maxLength={2000}
            aria-label="Message"
          />
          <button type="submit" className="send" disabled={running || !draft.trim()}>Send</button>
        </div>
        {config.allowUnprotected && user.role === 'owner' && (
          <label className="toggle">
            <input type="checkbox" checked={unprotected} onChange={(e) => setUnprotected(e.target.checked)} disabled={running} />
            Run without ArmorIQ (demo comparison)
          </label>
        )}
        {!config.armoriqConfigured && !unprotected && (
          <p className="error">ArmorIQ isn’t configured on the server, so requests will be refused. Add ARMORIQ_API_KEY.</p>
        )}
      </form>
    </section>
  );
}

function TurnView({ turn, user, agentName, onSend, onShowLedger }: { turn: Turn; user: User; agentName: string; onSend: (m: string) => void; onShowLedger: () => void }) {
  const slips = useMemo(() => deriveSlips(turn.events), [turn.events]);
  const final = turn.events.find((e) => e.type === 'final') as Extract<AgentEvent, { type: 'final' }> | undefined;
  const error = turn.error ?? (turn.events.find((e) => e.type === 'error') as any)?.message;
  const held = slips.some((s) => s.status === 'held');
  const stopped = slips.filter((s) => s.status === 'blocked' || s.status === 'refused').length;

  // Cards come from tool results; order cards re-read live state from the server.
  const cards: ReactNode[] = [];
  const seenOrders = new Set<string>();
  for (const s of slips) {
    const data = s.outcome?.ok ? s.outcome.data : null;
    if (!data) continue;
    if (s.tool === 'calculate_reorder_options') cards.push(<ReorderCard key={s.key} data={data} />);
    if ((s.tool === 'create_purchase_order_draft' || s.tool === 'commit_purchase_order' || s.tool === 'get_purchase_order') && data.order_id && !seenOrders.has(data.order_id)) {
      seenOrders.add(data.order_id);
      cards.push(<OrderCard key={`${s.key}-po`} orderId={data.order_id} user={user} agentName={agentName} onSend={onSend} />);
    }
  }

  return (
    <article className="turn">
      <p className="ask">{turn.message}</p>
      <div className="reply">
        <button className="ledger-peek" onClick={onShowLedger} disabled={!slips.length}>
          {slips.length ? `${slips.length} action${slips.length === 1 ? '' : 's'} checked${stopped ? `, ${stopped} stopped` : ''}` : turn.running ? 'Thinking…' : 'No actions'}
          {!turn.protected && ', unguarded'}
        </button>
        {held && <p className="waiting">Waiting for approval in the ArmorIQ console. The request continues once someone decides.</p>}
        {cards}
        {final && <Prose text={final.text} />}
        {turn.running && !final && <p className="typing" aria-live="polite">Working</p>}
        {error && <p className="error">{error}</p>}
      </div>
    </article>
  );
}

function ReorderCard({ data }: { data: any }) {
  return (
    <div className="card">
      <p className="card-title">Restocking {data.item.name.toLowerCase()} ({data.quantity_needed} {data.item.unit}s needed)</p>
      <table className="options">
        <thead>
          <tr><th>Supplier</th><th className="num">Qty</th><th className="num">Total</th><th className="num">Cash after bills</th><th>Lead</th></tr>
        </thead>
        <tbody>
          {data.options.map((o: any) => (
            <tr key={o.supplier_id} className={o.supplier_id === data.recommended_supplier_id ? 'is-pick' : o.feasible ? '' : 'is-out'}>
              <td>
                {o.supplier_name}
                {o.notes.length > 0 && <span className="why">{o.notes.join('; ')}</span>}
              </td>
              <td className="num">{o.quantity}</td>
              <td className="num">{kes(o.total)}</td>
              <td className="num">{kes(o.projected_cash_after)}</td>
              <td>{o.lead_time_days}d</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="card-foot">Reserve kept: {kes(data.cash.reserve_applied)}. Calculated in code from the price list and bills due this week.</p>
    </div>
  );
}

function OrderCard({ orderId, user, agentName, onSend }: { orderId: string; user: User; agentName: string; onSend: (m: string) => void }) {
  const [po, setPo] = useState<PurchaseOrder | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api.order(orderId).then(setPo).catch((e) => setError(e.message)), [orderId]);
  useEffect(() => {
    load();
  }, [load]);
  if (!po) return error ? <p className="error">{error}</p> : null;

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const canApprove = user.role === 'owner' && po.status === 'draft';
  return (
    <div className={`card order is-${po.status}`}>
      <div className="order-head">
        <p className="card-title">Purchase order {po.order_id}</p>
        <span className={`tag tag-${po.status}`}>{po.status === 'committed' ? 'Placed (simulated)' : po.status}</span>
      </div>
      <p className="order-supplier">{po.supplier_name}</p>
      <ul className="lines">
        {po.items.map((i) => (
          <li key={i.item_id}><span>{i.quantity} × {i.item_name} ({i.unit}) at {kes(i.unit_price)}</span><span className="num">{kes(i.line_total)}</span></li>
        ))}
        <li className="total"><span>Total</span><span className="num">{kes(po.total)}</span></li>
      </ul>
      <p className="card-foot">
        Drafted by {po.created_by}
        {po.approved_by && `. Approved by ${po.approved_by}`}
        {po.commit_reference && `. Reference ${po.commit_reference}`}.
      </p>
      {canApprove && (
        <div className="actions">
          <button className="primary" disabled={busy} onClick={() => act(() => api.approve(po.order_id))}>Approve order</button>
          <button className="quiet" disabled={busy} onClick={() => act(() => api.reject(po.order_id))}>Reject</button>
        </div>
      )}
      {po.status === 'draft' && user.role !== 'owner' && <p className="hint">Waiting for the owner to approve this draft.</p>}
      {po.status === 'approved' && po.approval_id && (
        <div className="actions">
          <button className="primary" onClick={() => onSend(`Order ${po.order_id} has been approved (approval ${po.approval_id}). Please place it.`)}>
            Ask {agentName} to place it
          </button>
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

/** Minimal, safe rendering of the model's reply: paragraphs, bullets and **bold**. No HTML is injected. */
function Prose({ text }: { text: string }) {
  const blocks = text.split(/\n{2,}/);
  const inline = (s: string) => s.split(/(\*\*[^*]+\*\*)/g).map((part, i) => (part.startsWith('**') && part.endsWith('**') ? <strong key={i}>{part.slice(2, -2)}</strong> : part));
  return (
    <div className="prose">
      {blocks.map((b, i) => {
        const lines = b.split('\n').filter(Boolean);
        if (lines.length && lines.every((l) => /^\s*([-*•]|\d+\.)\s+/.test(l))) {
          return <ul key={i}>{lines.map((l, j) => <li key={j}>{inline(l.replace(/^\s*([-*•]|\d+\.)\s+/, ''))}</li>)}</ul>;
        }
        return <p key={i}>{lines.map((l, j) => <span key={j}>{inline(l.replace(/^#+\s*/, ''))}{j < lines.length - 1 && <br />}</span>)}</p>;
      })}
    </div>
  );
}

// ── Guard ledger ─────────────────────────────────────────────────────

function Ledger({ turn, config, open, onClose }: { turn?: Turn; config: AppConfig; open: boolean; onClose: () => void }) {
  const slips = useMemo(() => (turn ? deriveSlips(turn.events) : []), [turn]);
  return (
    <aside className={`ledger ${open ? 'is-open' : ''}`} aria-label="Action ledger">
      <div className="ledger-head">
        <h2>Action ledger</h2>
        <button className="quiet ledger-close" onClick={onClose}>Close</button>
      </div>
      <p className="ledger-sub">
        {turn
          ? turn.protected
            ? `Every action ${config.agentName} tried, checked by ArmorIQ before it ran.`
            : 'ArmorIQ was off. Nothing checked these actions.'
          : `Each action ${config.agentName} tries will be recorded here with its decision.`}
      </p>
      <ol className="slips">
        {slips.map((s) => (
          <SlipView key={s.key} slip={s} consoleUrl={config.armoriqConsoleUrl} />
        ))}
      </ol>
    </aside>
  );
}

function SlipView({ slip, consoleUrl }: { slip: Slip; consoleUrl: string }) {
  return (
    <li className={`slip is-${slip.status}`}>
      <div className="slip-body">
        <p className="slip-tool">{TOOL_LABEL[slip.tool] ?? slip.tool}</p>
        {argSummary(slip.args) && <p className="slip-args">{argSummary(slip.args)}</p>}
        {slip.reason && <p className="slip-reason">{slip.decidedBy ? `${slip.decidedBy}: ` : ''}{slip.reason}</p>}
        {slip.status === 'held' && (
          <a className="slip-link" href={consoleUrl} target="_blank" rel="noreferrer">Open ArmorIQ approvals</a>
        )}
      </div>
      <span className="stamp" aria-label={`Decision: ${STAMP_TEXT[slip.status]}`}>{STAMP_TEXT[slip.status]}</span>
    </li>
  );
}

// ── Activity ─────────────────────────────────────────────────────────

function stage(r: ActivityRow): string {
  if (r.source === 'armoriq') return 'ArmorIQ';
  if (r.source === 'domain') return r.decision === 'completed' ? 'Execution' : 'Business rule';
  return r.decision === 'approved' || r.action.startsWith('approve') || r.action.startsWith('reject') ? 'Person' : 'App';
}
const ACTION_LABEL: Record<string, string> = {
  plan: 'Intent plan captured', chat_request: 'Request', sign_in: 'Signed in', demo_reset: 'Demo data reset',
  approve_purchase_order: 'Approve purchase order', reject_purchase_order: 'Reject purchase order',
};
const DECISION: Record<ActivityRow['decision'], string> = {
  allowed: 'Allowed', held: 'Held', approved: 'Approved', blocked: 'Blocked', failed: 'Failed', completed: 'Completed', info: '—',
};

function Activity({ refreshKey, agentName }: { refreshKey: number; agentName: string }) {
  const [rows, setRows] = useState<ActivityRow[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    api.activity().then(setRows).catch((e) => setError(e.message));
  }, [refreshKey]);
  return (
    <section className="activity" aria-label="Activity">
      <h2>Activity</h2>
      <p className="lede">Every request, check and outcome, newest first. Account numbers are masked.</p>
      {error && <p className="error">{error}</p>}
      {rows.length === 0 && !error && <p className="hint">Nothing yet. Ask {agentName} something and its actions will appear here.</p>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Time</th><th>Who</th><th>Action</th><th>Stage</th><th>Result</th><th>Reason</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={`row-${r.decision}`}>
                <td className="num">{new Date(r.created_at).toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</td>
                <td>{r.user_name?.replace(/ \(.*\)$/, '') ?? '—'}</td>
                <td>{TOOL_LABEL[r.action] ?? ACTION_LABEL[r.action] ?? r.action.replace(/_/g, ' ')}</td>
                <td>{stage(r)}</td>
                <td><span className={`tag tag-${r.decision}`}>{DECISION[r.decision]}</span></td>
                <td className="reason">{r.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
