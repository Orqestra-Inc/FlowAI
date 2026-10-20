// Orqestra landing page: hero chat demo, scroll reveals, nav background, pricing toggle, savings calculator.
document.documentElement.classList.add('js');
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------- Nav turns solid after the hero starts scrolling ----------
const nav = document.getElementById('nav');
const onScroll = () => nav.classList.toggle('is-solid', window.scrollY > 40);
onScroll();
window.addEventListener('scroll', onScroll, { passive: true });

// ---------- Reveal sections as they enter the viewport ----------
const revealed = document.querySelectorAll('.reveal');
if ('IntersectionObserver' in window && !reduceMotion) {
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { e.target.classList.add('is-in'); io.unobserve(e.target); }
  }, { rootMargin: '0px 0px -8% 0px' });
  revealed.forEach((el) => io.observe(el));
} else {
  revealed.forEach((el) => el.classList.add('is-in'));
}

// ---------- Hero chat demo ----------
const scenes = [
  [
    { me: "We're low on cooking oil. Order more, but keep KSh 80,000 in the bank." },
    { flow: "Nakuru Traders is cheapest, but their minimum order would take cash below KSh 80,000. Kisumu Wholesale fits:" },
    { card: [['Cooking oil 20L × 40', 'KSh 134,000'], ['Cash after order', 'KSh 96,500']], acts: ['Approve', 'Edit'] },
    { flow: 'Order sent to Grace for approval ✓' },
  ],
  [
    { me: 'Which bills are due this week?' },
    { flow: 'Three bills, KSh 533,500 in total:' },
    { card: [['Kamau Farm Produce', 'KSh 38,500'], ['Nakuru Traders', 'KSh 15,000'], ['Rift Valley Packaging ⚠', 'KSh 480,000']] },
    { flow: "Rift Valley's invoice asks to change their bank details. I've held it until someone calls them to confirm." },
  ],
  [
    { me: 'Pay Kamau Farm for the tomatoes and onions.' },
    { flow: 'INV-104 · KSh 38,500 · due Thursday. Within your limit.' },
    { card: [['Pay Kamau Farm Produce', 'KSh 38,500']], acts: ['Confirm', 'Not now'], tap: true },
    { flow: 'Paid ✓ Cash now KSh 196,000.' },
  ],
];

const chat = document.getElementById('chat');
const status = document.getElementById('flow-status');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text) n.textContent = text;
  return n;
}

function render(step) {
  if (step.me) return el('div', 'msg msg-me', step.me);
  if (step.flow) return el('div', 'msg msg-flow', step.flow);
  const card = el('div', 'msg-card');
  for (const [a, b] of step.card) {
    const r = el('div', 'r');
    r.append(el('span', '', a), el('b', '', b));
    card.append(r);
  }
  if (step.acts) {
    const acts = el('div', 'acts');
    step.acts.forEach((t, i) => acts.append(el('span', i === 0 ? 'go' : '', t)));
    card.append(acts);
  }
  return card;
}

async function play() {
  if (!chat) return;
  if (reduceMotion) { scenes[0].forEach((s) => chat.append(render(s))); return; }
  for (let i = 0; ; i = (i + 1) % scenes.length) {
    chat.replaceChildren();
    for (const step of scenes[i]) {
      if (!step.me) {
        status.textContent = 'typing…';
        const t = el('div', 'typing'); t.append(el('i'), el('i'), el('i'));
        chat.append(t);
        await wait(900);
        t.remove();
        status.textContent = 'online';
      } else {
        await wait(500);
      }
      const node = render(step);
      chat.append(node);
      if (step.tap) { await wait(1100); node.querySelector('.go')?.classList.add('tapped'); }
      await wait(step.card ? 1500 : 1200);
    }
    await wait(2600);
  }
}
play();

// ---------- Pricing toggle ----------
document.querySelectorAll('.toggle-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const period = btn.dataset.period;
    document.querySelectorAll('.toggle-btn').forEach((b) => {
      const on = b === btn;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', String(on));
    });
    document.querySelectorAll('[data-monthly]').forEach((n) => { n.textContent = n.dataset[period]; });
  });
});

// Choosing a plan pre-selects it in the form.
const planSelect = document.getElementById('plan-select');
document.querySelectorAll('[data-plan]').forEach((a) => {
  a.addEventListener('click', () => { if (planSelect) planSelect.value = a.dataset.plan; });
});

// ---------- Savings calculator ----------
const HOURLY_KES = 315; // ~KSh 58,000/month all-in junior admin ÷ ~184 working hours
const people = document.getElementById('c-people');
const hours = document.getElementById('c-hours');
const fmt = new Intl.NumberFormat('en-KE');
function calc() {
  const p = Number(people.value), h = Number(hours.value);
  const monthly = Math.round(p * h * 4.33);
  document.getElementById('o-people').textContent = p;
  document.getElementById('o-hours').textContent = h;
  document.getElementById('r-hours').textContent = `${fmt.format(monthly)} hours`;
  document.getElementById('r-cost').textContent = `KSh ${fmt.format(Math.round((monthly * HOURLY_KES) / 1000) * 1000)}`;
}
if (people && hours) { people.addEventListener('input', calc); hours.addEventListener('input', calc); calc(); }
