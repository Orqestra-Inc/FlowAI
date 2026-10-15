# CLAUDE.md — Orqestra

Read `README.md`, then `docs/SPEC.md` (its as-built notes at the top override the rest of the spec). If code and docs disagree, ask.

## Stack
TypeScript, Node 20+. LangGraph agent (`createAgent` from `langchain` v1) + the official ArmorIQ LangChain adapter (`@armoriq/sdk/dist/integrations/langchain`) + typed domain tools + Express (API, SSE, discovery-only `/mcp`) + React/Vite UI + SQLite (better-sqlite3). Model chosen by `LLM_MODEL` (`provider:model`, `initChatModel`) — never hardcode a provider.

## Non-negotiables
- Every model-callable tool runs only with the ArmorIQ handler attached (`callbacks: [handler]` on the agent invocation). No unguarded path. `/mcp` never executes tools. The unprotected toggle works only when `DEMO_MODE=1` and `DEMO_ALLOW_UNPROTECTED=1`, owner only, with a red banner.
- **Enforcement is proven by state, not logs**: a blocked tool's side effect must not exist in the DB (see `tests/enforcement.test.ts`). Keep those tests green.
- Fail closed: no guard, guard init error, or enforcement error → nothing runs.
- Identity comes from the signed session cookie only, never from the request body or tool args. All business queries are scoped to `actor.businessId`.
- The model cannot approve anything. Approvals are human UI actions, bound to a payload hash, single-use, expiring.
- Money = integer whole KES in args named `amount`. Arithmetic in code, never by the model.
- No SQL/shell/fetch/generic CRUD tools. Zod `strictObject` schemas for every tool.
- Business-rule refusals are returned as structured results (`refused_by: 'business_rule'`), not thrown, so the model can explain them.
- Simulated effects are labelled `simulated: true` and shown as SIMULATED.

## SDK hygiene
- Compile against installed typings; read `node_modules/@armoriq/sdk/dist/integrations/langchain.js` before changing enforcement code. Some ArmorIQ doc links are stale.
- `moduleResolution: "bundler"` is required for the adapter's deep import.
- `LANGCHAIN_CALLBACKS_BACKGROUND=false` (set in `server/config.ts`).
- LangGraph's update stream re-emits messages; de-duplicate by message id / `tool_call_id` (see `run.ts`).

## Commands
`npm test` (no keys) · `npm run typecheck` · `npm run build` · `npm start` · `npm run dev` · `npm run check` · `npm run boundary` (live ArmorIQ) · `npm run eval` (live model + ArmorIQ) · `npm run preview` (no keys).

## Workflow
Small commits. Run `npm run typecheck && npm test` before every commit. Never cut enforcement, the approval gate, the injection test, or the README boundary section.
