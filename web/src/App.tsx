import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, chatKey, kes, newId, speak, stopSpeaking, store, streamChat, transcribe, type ChatSummary, type StoredTurn, type ActivityRow, type AgentEvent, type AppConfig, type PolicyCheck, type PurchaseOrder, type User } from './api';
import { argSummary, deriveSlips, friendlyReason, STAMP_TEXT, TOOL_LABEL, type Slip } from './ledger';

interface Turn {
  id: string;
  message: string;
  protected: boolean;
  events: AgentEvent[];
  running: boolean;
  error?: string;
}

/** Starter questions per role, shown only on an empty conversation. Everyday reads first. */
const PROMPTS: Record<User['role'], Array<{ title: string; text: string }>> = {
  procurement: [
    { title: 'Restock cooking oil', text: "We're low on cooking oil. Recommend a supplier and prepare an order, but keep cash above KSh 80,000." },
    { title: 'What is running low?', text: 'Which items are below their reorder level?' },
    { title: 'Stock count', text: 'How much stock do we have of each item?' },
    { title: 'Compare suppliers', text: 'Compare our suppliers on price and minimum order for cooking oil.' },
  ],
  owner: [
    { title: 'Today’s priorities', text: 'What needs my attention today?' },
    { title: 'Weekly report', text: 'Give me a short report on cash, open bills and low stock this week.' },
    { title: 'Payroll totals', text: 'Show me this month’s payroll totals.' },
    { title: 'Stock count', text: 'How much stock do we have of each item?' },
  ],
  accountant: [
    { title: 'Pay this week’s bills', text: 'Process all of this week’s open supplier bills, including Rift Valley Packaging.' },
    { title: 'Bills due', text: 'Which supplier bills are due this week, and how much in total?' },
    { title: 'Cash position', text: 'What is our cash position after this week’s bills?' },
    { title: 'Payroll totals', text: 'Also show me this month’s payroll totals.' },
  ],
};

const ROLE_NOTE: Record<User['role'], string> = {
  owner: 'Approves orders · sees payroll',
  procurement: 'Restocks · drafts purchase orders',
  accountant: 'Pays supplier bills',
};

const PEOPLE = [
  { email: 'owner@baraka.demo', name: 'Grace', role: 'Owner' },
  { email: 'procurement@baraka.demo', name: 'Brian', role: 'Procurement' },
  { email: 'accountant@baraka.demo', name: 'Faith', role: 'Accountant' },
];

const firstName = (u: { displayName: string }) => u.displayName.replace(/ \(.*\)$/, '').split(' ')[0];
const initials = (name: string) => name.replace(/ \(.*\)$/, '').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();

/** Inline icons (no icon library). Stroke uses currentColor so they follow button colours. */
const svgProps = { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
const MicIcon = () => (
  <svg {...svgProps}><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10a7 7 0 0 0 14 0" /><path d="M12 17v4" /><path d="M8 21h8" /></svg>
);
const StopIcon = () => (
  <svg {...svgProps}><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" /></svg>
);
const SendIcon = () => (
  <svg {...svgProps}><path d="M12 19V5" /><path d="M5 12l7-7 7 7" /></svg>
);
const MenuIcon = () => <svg {...svgProps}><path d="M4 7h16" /><path d="M4 12h16" /><path d="M4 17h16" /></svg>;
const CloseIcon = () => <svg {...svgProps}><path d="M6 6l12 12" /><path d="M18 6L6 18" /></svg>;
const PlusIcon = () => <svg {...svgProps}><path d="M12 5v14" /><path d="M5 12h14" /></svg>;
const ChatIcon = () => <svg {...svgProps}><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" /></svg>;
const ListIcon = () => <svg {...svgProps}><path d="M9 6h11" /><path d="M9 12h11" /><path d="M9 18h11" /><path d="M4 6h.01" /><path d="M4 12h.01" /><path d="M4 18h.01" /></svg>;
const ShieldIcon = () => <svg {...svgProps}><path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z" /><path d="M9 12l2 2 4-4" /></svg>;
const SpeakerIcon = () => <svg {...svgProps}><path d="M11 5L6 9H3v6h3l5 4z" /><path d="M15.5 8.5a5 5 0 0 1 0 7" /><path d="M18.5 5.5a9 9 0 0 1 0 13" /></svg>;
const ChevronIcon = () => <svg {...svgProps} width={16} height={16}><path d="M9 6l6 6-6 6" /></svg>;
const Spinner = () => <span className="spinner" aria-hidden="true" />;

export function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [bootError, setBootError] = useState('');
  const [user, setUser] = useState<User | null | undefined>(undefined);

  useEffect(() => {
    api.config().then(setConfig).catch((e) => setBootError(`Couldn’t reach the server: ${e.message}. Refresh in a minute; a sleeping server takes about a minute to wake.`));
    api.me().then((r) => setUser(r.user)).catch(() => setUser(null));
  }, []);

  if (bootError) return <p className="boot error">{bootError}</p>;
  if (user === undefined || !config) return <div className="boot" aria-busy="true"><Spinner /></div>;
  if (!user) return <SignIn config={config} onSignedIn={setUser} />;
  return <Desk config={config} user={user} onSignOut={() => api.logout().then(() => setUser(null))} onSwitch={setUser} />;
}

// ── Sign in ──────────────────────────────────────────────────────────

function SignIn({ config, onSignedIn }: { config: AppConfig; onSignedIn: (u: User) => void }) {
  const [accounts, setAccounts] = useState<Array<{ email: string; role: User['role']; display_name: string }>>([]);
  const [error, setError] = useState('');
  // A private link like /?code=XXXX fills the code in, then removes it from the address bar.
  const [code, setCode] = useState(() => {
    try {
      const url = new URL(window.location.href);
      const fromLink = url.searchParams.get('code') ?? '';
      if (fromLink) {
        url.searchParams.delete('code');
        window.history.replaceState(null, '', url.pathname + url.search + url.hash);
      }
      return fromLink;
    } catch {
      return '';
    }
  });
  const fromLink = useRef(code.length > 0).current;
  const [signingIn, setSigningIn] = useState('');
  const signIn = (email: string) => {
    setError('');
    setSigningIn(email);
    api
      .login(email, code)
      .then((r) => {
        store.remove(chatKey(r.user.userId)); // a fresh sign-in starts a new conversation
        onSignedIn(r.user);
      })
      .catch((e) => setError(e.message))
      .finally(() => setSigningIn(''));
  };
  useEffect(() => {
    api.demoUsers().then(setAccounts).catch(() => setError('Demo accounts are unavailable.'));
  }, []);
  return (
    <main className="signin">
      <div className="signin-card">
        <div className="brand"><span className="brand-mark" aria-hidden="true" />{config.appName}</div>
        <h1>Sign in</h1>
        <p className="lede">Run stock, suppliers, bills and cash by asking {config.agentName}. Every action is checked by ArmorIQ before it runs.</p>

        {config.requireAccessCode && fromLink && code && !error && (
          <p className="notice notice-ok">Access code applied from your invite link. Choose an account to continue.</p>
        )}
        {config.requireAccessCode && (!(fromLink && code) || !!error) && (
          <label className="field">
            <span>Access code</span>
            <input value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="From your invite" aria-describedby={config.accessCodeHint ? 'code-hint' : undefined} />
            {config.accessCodeHint && (
              <span id="code-hint" className="field-hint">
                Hint: <button type="button" className="hint-code" onClick={() => setCode(config.accessCodeHint)} title="Use this code">{config.accessCodeHint}</button>
              </span>
            )}
          </label>
        )}

        <p className="section-label">Baraka Fresh Distributors · choose an account</p>
        <div className="accounts">
          {accounts.map((a) => (
            <button key={a.email} className="account" disabled={!!signingIn} onClick={() => signIn(a.email)}>
              <span className="avatar" aria-hidden="true">{initials(a.display_name)}</span>
              <span className="account-text">
                <span className="account-name">{a.display_name.replace(/ \(.*\)$/, '')}</span>
                <span className="account-note">{ROLE_NOTE[a.role]}</span>
              </span>
              {signingIn === a.email ? <Spinner /> : <ChevronIcon />}
            </button>
          ))}
        </div>
        {error && <p className="error" role="alert">{error}</p>}
        <p className="fineprint">Sample business data. Orders, payments and exports are simulated.</p>
      </div>
    </main>
  );
}

// ── Main desk ────────────────────────────────────────────────────────

function Desk({ config, user, onSignOut, onSwitch }: { config: AppConfig; user: User; onSignOut: () => void; onSwitch: (u: User) => void }) {
  const [view, setView] = useState<'chat' | 'activity'>('chat');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [chatId, setChatId] = useState(() => newId().slice(0, 12));
  const [ledgerOpen, setLedgerOpen] = useState(false);
  const [ledgerTurn, setLedgerTurn] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [unprotected, setUnprotected] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const openChat = useCallback(
    (id: string) => {
      setChatId(id);
      setTurns([]);
      store.set(chatKey(user.userId), id);
      api.chat(id).then((r) => setTurns(r.turns.map(fromStored))).catch(() => setTurns([]));
    },
    [user.userId],
  );
  const newChat = useCallback(() => {
    store.remove(chatKey(user.userId));
    setChatId(newId().slice(0, 12));
    setTurns([]);
  }, [user.userId]);

  // On load (or a refresh), reopen this person's current conversation; otherwise start a new one.
  useEffect(() => {
    setUnprotected(false);
    const stored = store.get(chatKey(user.userId));
    if (stored) openChat(stored);
    else newChat();
  }, [user.userId, openChat, newChat]);

  // Escape closes whichever overlay is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setDrawerOpen(false);
      setLedgerOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const running = turns.some((t) => t.running);
  const ledgerFor = turns.find((t) => t.id === ledgerTurn) ?? turns[turns.length - 1];

  const send = useCallback(
    async (message: string, opts?: { voice?: boolean }) => {
      const id = newId();
      let finalText = '';
      const turn: Turn = { id, message, protected: !unprotected, events: [], running: true };
      setTurns((ts) => [...ts, turn]);
      setLedgerTurn(null);
      store.set(chatKey(user.userId), chatId);
      const update = (fn: (t: Turn) => Turn) => setTurns((ts) => ts.map((t) => (t.id === id ? fn(t) : t)));
      try {
        await streamChat({ message, chatId, unprotected }, (e) => {
          if (e.type === 'final') finalText = e.text;
          update((t) => ({ ...t, events: [...t.events, e] }));
        });
        // A spoken request gets a spoken reply.
        if (opts?.voice && finalText && config.voiceEnabled) speak(finalText).catch(() => {});
      } catch (err) {
        update((t) => ({ ...t, error: (err as Error).message }));
      } finally {
        update((t) => ({ ...t, running: false }));
        setRefreshKey((k) => k + 1);
      }
    },
    [chatId, unprotected, user.userId, config.voiceEnabled],
  );

  const switchTo = async (email: string) => {
    const r = await api.login(email);
    store.remove(chatKey(r.user.userId));
    onSwitch(r.user);
  };

  const go = (v: 'chat' | 'activity') => {
    setView(v);
    setDrawerOpen(false);
  };

  return (
    <div className={`desk ${unprotected ? 'is-unprotected' : ''} ${drawerOpen ? 'drawer-open' : ''}`}>
      <aside className="sidebar" aria-label="Navigation">
        <div className="sidebar-head">
          <div className="brand"><span className="brand-mark" aria-hidden="true" />{config.appName}</div>
          <button className="icon-btn ghost only-mobile" aria-label="Close menu" onClick={() => setDrawerOpen(false)}><CloseIcon /></button>
        </div>
        <button className="new-chat" disabled={running} onClick={() => { go('chat'); newChat(); }}>
          <PlusIcon /> New conversation
        </button>
        <nav className="nav" aria-label="Views">
          <button aria-current={view === 'chat'} onClick={() => go('chat')}><ChatIcon /> Ask {config.agentName}</button>
          <button aria-current={view === 'activity'} onClick={() => go('activity')}><ListIcon /> Activity</button>
        </nav>
        <RecentChats refreshKey={refreshKey} currentChatId={chatId} disabled={running} onOpen={(id) => { go('chat'); openChat(id); }} />
        <Overview refreshKey={refreshKey} />
        <p className="sidebar-foot">Baraka Fresh Distributors · sample data, simulated payments</p>
      </aside>
      <div className="scrim" aria-hidden="true" onClick={() => { setDrawerOpen(false); setLedgerOpen(false); }} />

      <main className="main">
        <header className="topbar">
          <button className="icon-btn ghost only-mobile" aria-label="Open menu" onClick={() => setDrawerOpen(true)}><MenuIcon /></button>
          <div className="topbar-title">
            <strong>{view === 'chat' ? `Ask ${config.agentName}` : 'Activity'}</strong>
            <span>Baraka Fresh Distributors</span>
          </div>
          {view === 'chat' && turns.length > 0 && (
            <button className="icon-btn ghost only-mobile" aria-label="New conversation" disabled={running} onClick={newChat}><PlusIcon /></button>
          )}
          <AccountMenu
            user={user}
            demoMode={config.demoMode}
            running={running}
            onSwitch={switchTo}
            onReset={() => api.reset().then(() => { newChat(); setRefreshKey((k) => k + 1); })}
            onSignOut={onSignOut}
          />
        </header>
        {unprotected && (
          <div className="banner-danger" role="alert">ArmorIQ is OFF for your next request. Tools will run unchecked. Demo comparison only.</div>
        )}
        {view === 'chat' ? (
          <Conversation
            config={config}
            user={user}
            turns={turns}
            running={running}
            unprotected={unprotected}
            setUnprotected={setUnprotected}
            onSend={send}
            onShowLedger={(id) => { setLedgerTurn(id); setLedgerOpen(true); }}
          />
        ) : (
          <Activity refreshKey={refreshKey} agentName={config.agentName} isOwner={user.role === 'owner'} />
        )}
      </main>

      <Ledger turn={ledgerFor} config={config} open={ledgerOpen} onClose={() => setLedgerOpen(false)} />
    </div>
  );
}

function AccountMenu(props: { user: User; demoMode: boolean; running: boolean; onSwitch: (email: string) => Promise<void>; onReset: () => Promise<unknown>; onSignOut: () => void }) {
  const { user, demoMode, running, onSwitch, onReset, onSignOut } = props;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  const run = async (key: string, fn: () => Promise<unknown> | void) => {
    setBusy(key);
    try {
      await fn();
    } finally {
      setBusy('');
      setOpen(false);
    }
  };
  return (
    <div className="account-menu" ref={ref}>
      <button className="avatar-btn" aria-haspopup="menu" aria-expanded={open} aria-label={`Account: ${user.displayName}`} onClick={() => setOpen((v) => !v)}>
        <span className="avatar">{initials(user.displayName)}</span>
      </button>
      {open && (
        <div className="menu" role="menu">
          <div className="menu-who">
            <strong>{user.displayName.replace(/ \(.*\)$/, '')}</strong>
            <span>{user.email}</span>
          </div>
          {demoMode && (
            <>
              <p className="menu-label">Switch person</p>
              {PEOPLE.map((p) => (
                <button
                  key={p.email}
                  role="menuitemradio"
                  aria-checked={p.email === user.email}
                  className="menu-item"
                  disabled={running || p.email === user.email || !!busy}
                  onClick={() => run(p.email, () => onSwitch(p.email))}
                >
                  <span className="avatar sm" aria-hidden="true">{p.name[0]}</span>
                  <span>{p.name} <span className="muted">· {p.role}</span></span>
                  {busy === p.email && <Spinner />}
                </button>
              ))}
              <div className="menu-sep" />
              <button role="menuitem" className="menu-item" disabled={running || !!busy} onClick={() => run('reset', onReset)}>Reset sample data</button>
            </>
          )}
          <button role="menuitem" className="menu-item" onClick={() => run('out', onSignOut)}>Sign out</button>
        </div>
      )}
    </div>
  );
}

/** Hold-free voice capture: tap to start, tap to stop (auto-stops at 60 s). Audio goes to our server, then ElevenLabs. */
function VoiceButton({ disabled, agentName, onText }: { disabled: boolean; agentName: string; onText: (text: string) => void }) {
  const [state, setState] = useState<'idle' | 'recording' | 'transcribing'>('idle');
  const [error, setError] = useState('');
  const recorder = useRef<MediaRecorder | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const stop = () => {
    window.clearTimeout(timer.current);
    if (recorder.current?.state === 'recording') recorder.current.stop();
  };

  const start = async () => {
    setError('');
    stopSpeaking();
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setError('Microphone access was blocked. Allow it in the browser and try again.');
      return;
    }
    const chunks: Blob[] = [];
    const rec = new MediaRecorder(stream);
    recorder.current = rec;
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
      if (blob.size < 2_000) {
        setState('idle');
        setError('That was too short. Tap the mic, talk, then tap stop.');
        return;
      }
      setState('transcribing');
      try {
        const { text } = await transcribe(blob);
        if (text) onText(text);
        else setError('I couldn’t hear any words. Try again a little closer to the mic.');
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setState('idle');
      }
    };
    rec.start();
    setState('recording');
    timer.current = window.setTimeout(stop, 60_000);
  };

  useEffect(() => () => stop(), []);

  return (
    <>
      <button
        type="button"
        className={`icon-btn speak ${state === 'recording' ? 'is-recording' : ''}`}
        disabled={disabled || state === 'transcribing'}
        onClick={() => (state === 'recording' ? stop() : start())}
        aria-label={state === 'recording' ? 'Stop recording and send' : state === 'transcribing' ? 'Transcribing' : `Ask ${agentName} by voice`}
        title={state === 'recording' ? 'Stop and send' : state === 'transcribing' ? 'Transcribing…' : `Ask ${agentName} by voice`}
      >
        {state === 'recording' ? <StopIcon /> : state === 'transcribing' ? <Spinner /> : <MicIcon />}
      </button>
      {error && <p className="error voice-error">{error}</p>}
    </>
  );
}

function ListenButton({ text }: { text: string }) {
  const [state, setState] = useState<'idle' | 'loading' | 'playing'>('idle');
  const [error, setError] = useState('');
  const play = async () => {
    if (state === 'playing') {
      stopSpeaking();
      setState('idle');
      return;
    }
    setError('');
    setState('loading');
    try {
      const audio = await speak(text);
      setState('playing');
      audio.addEventListener('ended', () => setState('idle'));
      audio.addEventListener('pause', () => setState('idle'));
    } catch (e) {
      setError((e as Error).message);
      setState('idle');
    }
  };
  return (
    <>
      <button
        type="button"
        className={`pill ${state === 'playing' ? 'is-active' : ''}`}
        onClick={play}
        disabled={state === 'loading'}
        aria-label={state === 'playing' ? 'Stop reading aloud' : 'Read this reply aloud'}
      >
        {state === 'loading' ? <Spinner /> : state === 'playing' ? <StopIcon /> : <SpeakerIcon />}
        {state === 'playing' ? 'Stop' : 'Listen'}
      </button>
      {error && <span className="error small">{error}</span>}
    </>
  );
}

function fromStored(t: StoredTurn): Turn {
  return { id: t.id, message: t.message, protected: t.protected, events: t.events, running: false, error: t.error ?? undefined };
}

function RecentChats(props: { refreshKey: number; currentChatId: string; disabled: boolean; onOpen: (id: string) => void }) {
  const { refreshKey, currentChatId, disabled, onOpen } = props;
  const [chats, setChats] = useState<ChatSummary[]>([]);
  useEffect(() => {
    api.chats().then(setChats).catch(() => setChats([]));
  }, [refreshKey, currentChatId]);
  if (!chats.length) return null;
  return (
    <section className="recent" aria-label="Recent conversations">
      <p className="section-label">Recent</p>
      <ul>
        {chats.map((c) => (
          <li key={c.chatId}>
            <button aria-current={c.chatId === currentChatId} disabled={disabled} onClick={() => onOpen(c.chatId)} title={c.title}>
              {c.title}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Overview({ refreshKey }: { refreshKey: number }) {
  const [data, setData] = useState<any>(null);
  useEffect(() => {
    api.overview().then(setData).catch(() => setData(null));
  }, [refreshKey]);
  if (!data) return null;
  return (
    <section aria-label="Today">
      <p className="section-label">Today</p>
      <dl className="figures">
        <div><dt>Cash</dt><dd>{kes(data.cash.balance)}</dd></div>
        <div><dt>Free to spend</dt><dd>{kes(data.cash.available_to_spend_above_reserve)}</dd></div>
        <div><dt>Open bills ({data.open_bills.count})</dt><dd>{kes(data.open_bills.total)}</dd></div>
        <div><dt>Low stock</dt><dd>{data.low_stock.map((i: any) => i.name).join(', ') || 'None'}</dd></div>
      </dl>
    </section>
  );
}

// ── Conversation ─────────────────────────────────────────────────────

function Conversation(props: {
  config: AppConfig; user: User; turns: Turn[]; running: boolean; unprotected: boolean;
  setUnprotected: (v: boolean) => void; onSend: (m: string, opts?: { voice?: boolean }) => void; onShowLedger: (turnId: string) => void;
}) {
  const { config, user, turns, running, unprotected, setUnprotected, onSend, onShowLedger } = props;
  const [draft, setDraft] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Block body on purpose: an effect must return nothing or a cleanup function. Newer browsers make
  // scrollIntoView return a Promise, which React would otherwise try to call as a cleanup and crash.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [turns]);
  // Grow the input with its content, up to a few lines.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [draft]);

  const submit = (text: string, opts?: { voice?: boolean }) => {
    const t = text.trim();
    if (!t || running) return;
    setDraft('');
    onSend(t, opts);
  };
  const voiceSupported = config.voiceEnabled && typeof window !== 'undefined' && 'MediaRecorder' in window && !!navigator.mediaDevices?.getUserMedia;

  return (
    <section className="conversation" aria-label="Conversation">
      <div className="thread">
        {turns.length === 0 ? (
          <div className="empty">
            <h2>Hi {firstName(user)}, what do you need?</h2>
            <p>Ask about stock, suppliers, bills or cash{voiceSupported ? ', or tap the mic and say it' : ''}.</p>
            <div className="suggestions">
              {PROMPTS[user.role].map((p) => (
                <button type="button" key={p.title} className="suggestion" disabled={running} onClick={() => submit(p.text)}>
                  <strong>{p.title}</strong>
                  <span>{p.text}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          turns.map((t) => (
            <TurnView key={t.id} turn={t} user={user} agentName={config.agentName} canListen={config.voiceEnabled} onSend={submit} onShowLedger={() => onShowLedger(t.id)} />
          ))
        )}
        <div ref={endRef} />
      </div>

      <form className="composer" onSubmit={(e) => { e.preventDefault(); submit(draft); }}>
        <div className="composer-box">
          <textarea
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(draft); } }}
            placeholder={running ? `${config.agentName} is working…` : `Message ${config.agentName}`}
            rows={1}
            maxLength={2000}
            aria-label="Message"
            enterKeyHint="send"
          />
          {voiceSupported && <VoiceButton disabled={running} agentName={config.agentName} onText={(t) => submit(t, { voice: true })} />}
          <button type="submit" className="icon-btn send" disabled={running || !draft.trim()} aria-label="Send" title="Send">{running ? <Spinner /> : <SendIcon />}</button>
        </div>
        {config.allowUnprotected && user.role === 'owner' && (
          <label className="toggle">
            <input type="checkbox" checked={unprotected} onChange={(e) => setUnprotected(e.target.checked)} disabled={running} />
            Run without ArmorIQ (demo comparison)
          </label>
        )}
        {!config.armoriqConfigured && !unprotected && (
          <p className="error small">ArmorIQ isn’t configured on the server, so requests will be refused.</p>
        )}
      </form>
    </section>
  );
}

function TurnView({ turn, user, agentName, canListen, onSend, onShowLedger }: { turn: Turn; user: User; agentName: string; canListen: boolean; onSend: (m: string) => void; onShowLedger: () => void }) {
  const slips = useMemo(() => deriveSlips(turn.events), [turn.events]);
  const final = turn.events.find((e) => e.type === 'final') as Extract<AgentEvent, { type: 'final' }> | undefined;
  const error = turn.error ?? (turn.events.find((e) => e.type === 'error') as any)?.message;
  const held = slips.some((s) => s.status === 'held');
  const stopped = slips.filter((s) => s.status === 'blocked' || s.status === 'refused').length;
  const allowed = slips.filter((s) => s.status === 'allowed' || s.status === 'approved').length;

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
        {held && <p className="notice notice-hold">Waiting for approval in the ArmorIQ console. This continues once someone decides.</p>}
        {cards}
        {final && <Prose text={final.text} />}
        {turn.running && !final && (
          <p className="typing" aria-live="polite">
            <span className="dots" aria-hidden="true"><i /><i /><i /></span>
            {slips.length ? `Checking ${slips.length} action${slips.length === 1 ? '' : 's'}` : 'Thinking'}
          </p>
        )}
        {!turn.running && !final && !error && <p className="hint">This request didn’t finish. It may have been interrupted.</p>}
        {error && <p className="notice notice-error">{friendlyReason(error)}</p>}
        {(slips.length > 0 || (final && canListen)) && (
          <div className="reply-meta">
            {slips.length > 0 && (
              <button type="button" className={`pill ${stopped ? 'is-warn' : ''}`} onClick={onShowLedger}>
                <ShieldIcon />
                {allowed} allowed{held ? ' · held' : ''}{stopped ? ` · ${stopped} stopped` : ''}
                {!turn.protected && ' · unguarded'}
              </button>
            )}
            {final && canListen && <ListenButton text={final.text} />}
          </div>
        )}
      </div>
    </article>
  );
}

function ReorderCard({ data }: { data: any }) {
  return (
    <div className="card">
      <p className="card-title">Restocking {data.item.name.toLowerCase()} · {data.quantity_needed} {data.item.unit}s needed</p>
      <ul className="options">
        {data.options.map((o: any) => {
          const pick = o.supplier_id === data.recommended_supplier_id;
          return (
            <li key={o.supplier_id} className={pick ? 'is-pick' : o.feasible ? '' : 'is-out'}>
              <div className="option-top">
                <span className="option-name">{o.supplier_name}</span>
                {pick ? <span className="tag tag-allowed">Recommended</span> : !o.feasible && <span className="tag tag-blocked">Not possible</span>}
              </div>
              <div className="option-figures">
                <span>{o.quantity} × <span className="num">{kes(o.total)}</span></span>
                <span>Cash after bills <span className={`num ${o.feasible ? '' : 'error'}`}>{kes(o.projected_cash_after)}</span></span>
                <span>{o.lead_time_days}-day delivery</span>
              </div>
              {o.notes.length > 0 && <p className="why">{o.notes.join('; ')}</p>}
            </li>
          );
        })}
      </ul>
      <p className="card-foot">Keeps {kes(data.cash.reserve_applied)} in reserve. Calculated in code from the price list and bills due this week.</p>
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

// ── Checks (action ledger) ───────────────────────────────────────────

function Ledger({ turn, config, open, onClose }: { turn?: Turn; config: AppConfig; open: boolean; onClose: () => void }) {
  const slips = useMemo(() => (turn ? deriveSlips(turn.events) : []), [turn]);
  return (
    <aside className={`ledger ${open ? 'is-open' : ''}`} aria-label="Action checks">
      <div className="sheet-handle" aria-hidden="true" />
      <div className="ledger-head">
        <h2>Action checks</h2>
        <button className="icon-btn ghost ledger-close" aria-label="Close" onClick={onClose}><CloseIcon /></button>
      </div>
      <p className="ledger-sub">
        {turn
          ? turn.protected
            ? `Every action ${config.agentName} tried for “${turn.message.slice(0, 60)}${turn.message.length > 60 ? '…' : ''}”, checked by ArmorIQ before it ran.`
            : 'ArmorIQ was off. Nothing checked these actions.'
          : `Each action ${config.agentName} tries appears here with its decision.`}
      </p>
      {slips.length === 0 && <p className="hint">No actions yet.</p>}
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
        {slip.reason && <p className="slip-reason">{slip.decidedBy ? `${slip.decidedBy}: ` : ''}{friendlyReason(slip.reason)}</p>}
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
  plan: 'Intent plan captured', chat_request: 'Request', sign_in: 'Signed in', demo_reset: 'Sample data reset', policy_check: 'Policy check',
  approve_purchase_order: 'Approve purchase order', reject_purchase_order: 'Reject purchase order',
};
const DECISION: Record<ActivityRow['decision'], string> = {
  allowed: 'Allowed', held: 'Held', approved: 'Approved', blocked: 'Blocked', failed: 'Failed', completed: 'Completed', info: 'Info',
};

function Activity({ refreshKey, agentName, isOwner }: { refreshKey: number; agentName: string; isOwner: boolean }) {
  const [rows, setRows] = useState<ActivityRow[]>([]);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  useEffect(() => {
    api.activity().then(setRows).catch((e) => setError(e.message));
  }, [refreshKey, tick]);
  return (
    <section className="activity" aria-label="Activity">
      <div className="activity-inner">
        {isOwner && <PolicyCheckPanel onDone={() => setTick((t) => t + 1)} />}
        <div className="section-head">
          <h2>Activity</h2>
          <p className="muted">Every request, check and outcome, newest first. Account numbers are masked.</p>
        </div>
        {error && <p className="error">{error}</p>}
        {rows.length === 0 && !error && <p className="hint">Nothing yet. Ask {agentName} something and its actions will appear here.</p>}
        <ul className="events">
          {rows.map((r) => (
            <li key={r.id} className={`event row-${r.decision}`}>
              <div className="event-top">
                <span className="event-action">{TOOL_LABEL[r.action] ?? ACTION_LABEL[r.action] ?? r.action.replace(/_/g, ' ')}</span>
                {r.decision !== 'info' && <span className={`tag tag-${r.decision}`}>{DECISION[r.decision]}</span>}
              </div>
              <div className="event-meta">
                {r.user_name?.replace(/ \(.*\)$/, '') ?? 'System'} · {stage(r)} ·{' '}
                {new Date(r.created_at).toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' })}
              </div>
              {r.reason && <p className="event-reason">{friendlyReason(r.reason)}</p>}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

const DECISION_WORD: Record<string, string> = { allowed: 'Allowed', held: 'Held', blocked: 'Blocked', error: 'Error' };

/** Owner-only: ask the live ArmorIQ account how it decides a fixed set of actions. */
function PolicyCheckPanel({ onDone }: { onDone: () => void }) {
  const [result, setResult] = useState<PolicyCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async () => {
    setBusy(true);
    setError('');
    try {
      setResult(await api.policyCheck());
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const passed = result?.results.filter((r) => r.pass).length ?? 0;
  return (
    <div className="card policy-check">
      <div className="policy-check-head">
        <div>
          <p className="card-title">Policy check</p>
          <p className="muted small">Asks ArmorIQ how it decides {result?.results.length || 12} sample actions for each person. Uses a throwaway copy of the data; nothing real changes.</p>
        </div>
        <button className="primary" onClick={run} disabled={busy}>{busy ? <><Spinner /> Checking…</> : result ? 'Run again' : 'Run check'}</button>
      </div>
      {error && <p className="error small">{error}</p>}
      {result && !result.ok && <p className="error small">{result.error}</p>}
      {result?.ok && (
        <>
          <p className={`policy-summary ${passed === result.results.length ? 'is-good' : 'is-bad'}`}>
            {passed === result.results.length ? 'All actions behave as intended.' : `${passed} of ${result.results.length} behave as intended.`}
          </p>
          <ul className="check-rows">
            {result.results.map((r, i) => (
              <li key={i} className={r.pass ? 'is-pass' : 'is-fail'}>
                <div className="check-main">
                  <span>{r.label} <span className="muted">· {PEOPLE.find((p) => p.email === r.email)?.name ?? r.email}</span></span>
                  <span className={`tag tag-${r.decision === 'error' ? 'failed' : r.decision}`}>{DECISION_WORD[r.decision]}</span>
                </div>
                {!r.pass && (
                  <p className="check-why">Expected {DECISION_WORD[r.expect].toLowerCase()}. {friendlyReason(r.reason)}{r.identity !== r.email ? ` (checked as ${r.identity})` : ''}</p>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
