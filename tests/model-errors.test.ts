import { describe, expect, it } from 'vitest';
import { MemorySaver } from '@langchain/langgraph';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { ChatResult } from '@langchain/core/outputs';
import { classifyModelError, friendlyModelError, isRetryableModelError } from '../server/model-errors.js';
import { runAgent } from '../server/agent/run.js';
import { ScriptedModel } from '../server/agent/scripted-model.js';
import { openDb, seed } from '../server/db.js';
import { actorByEmail } from '../server/auth.js';
import type { AgentEvent } from '../server/agent/events.js';
import { resetModelCooldowns } from '../server/agent/fallback.js';
import { fallbackModels } from '../server/config.js';

process.env.LANGCHAIN_CALLBACKS_BACKGROUND = 'false';

const geminiDaily = Object.assign(new Error('[429 Too Many Requests] You exceeded your current quota. Quota exceeded for metric: generate_content_free_tier_requests, limit: 20, quotaId: GenerateRequestsPerDayPerProjectPerModel-FreeTier'), { status: 429 });
const geminiMinute = Object.assign(new Error('[429 Too Many Requests] Resource has been exhausted (e.g. check quota). quotaId: GenerateRequestsPerMinutePerProjectPerModel-FreeTier'), { status: 429 });

/** A model that always fails like an exhausted Gemini key. */
class FailingModel extends BaseChatModel {
  calls = 0;
  constructor(private readonly err: Error) { super({}); }
  _llmType() { return 'failing'; }
  bindTools() { return this as any; }
  async _generate(): Promise<ChatResult> { this.calls += 1; throw this.err; }
}

describe('model errors', () => {
  it('classifies provider failures', () => {
    expect(classifyModelError(geminiDaily)).toBe('daily_quota');
    expect(classifyModelError(geminiMinute)).toBe('rate_limit');
    expect(classifyModelError(Object.assign(new Error('The model is overloaded'), { status: 503 }))).toBe('overloaded');
    expect(classifyModelError(new Error('API key not valid. Please pass a valid API key.'))).toBe('auth');
    expect(classifyModelError(new Error('Something else'))).toBe('other');
    expect(isRetryableModelError(geminiMinute)).toBe(true);
    expect(isRetryableModelError(geminiDaily)).toBe(false);
    expect(friendlyModelError(new Error('Something else'), 'Flow')).toBeNull();
    expect(friendlyModelError(geminiDaily, 'Flow')).toMatch(/today's AI allowance.*Nothing was changed/);
  });

  async function run(model: BaseChatModel, fallbacks?: BaseChatModel[]) {
    resetModelCooldowns();
    const db = openDb(':memory:');
    seed(db);
    const events: AgentEvent[] = [];
    await runAgent(
      { db, model, checkpointer: new MemorySaver(), guard: null, appName: 'Orqestra', agentName: 'Flow', modelLabel: 't', maxToolCalls: 5, maxModelCalls: 5, fallbackModels: fallbacks?.map((m, i) => ({ name: `fallback-${i}`, model: m })), modelRetries: 0 },
      { actor: actorByEmail(db, 'owner@baraka.demo')!, message: 'How much stock do we have?', chatId: 'c', protected: false, emit: (e) => events.push(e) },
    );
    return events;
  }

  it('shows a plain-language message instead of the raw provider error', async () => {
    const events = await run(new FailingModel(geminiDaily));
    const error = events.find((e) => e.type === 'error') as Extract<AgentEvent, { type: 'error' }>;
    expect(error.message).toMatch(/used up today's AI allowance/);
    expect(error.message).not.toMatch(/quotaId|429/);
  });

  it('picks default Gemini fallbacks only when none are configured', () => {
    expect(fallbackModels('google-genai:gemini-3.8-flash', undefined)).toEqual(['google-genai:gemini-3.6-flash', 'google-genai:gemini-3.5-flash-lite', 'google-genai:gemini-3.1-flash-lite']);
    expect(fallbackModels('google-genai:gemini-3.6-flash', undefined)).not.toContain('google-genai:gemini-3.6-flash');
    expect(fallbackModels('openai:gpt-4.1-mini', undefined)).toEqual([]);
    expect(fallbackModels('google-genai:gemini-3.8-flash', '')).toEqual([]);
    expect(fallbackModels('google-genai:gemini-3.8-flash', ' a:b , a:b ,c:d')).toEqual(['a:b', 'c:d']);
  });

  it('reports the quota error, not the last fallback\'s odd error, when every model fails', async () => {
    const events = await run(new FailingModel(geminiDaily), [new FailingModel(new Error('400 Bad Request: something odd'))]);
    expect((events.find((e) => e.type === 'error') as any).message).toMatch(/today's AI allowance/);
  });

  it('skips a model that just ran out of quota on the next request', async () => {
    const primary = new FailingModel(geminiDaily);
    const fallback = () => new ScriptedModel(() => ({ steps: [], final: 'ok' }));
    resetModelCooldowns();
    const db = openDb(':memory:');
    seed(db);
    const deps = { db, model: primary, checkpointer: new MemorySaver(), guard: null, appName: 'Orqestra', agentName: 'Flow', modelLabel: 'primary', maxToolCalls: 5, maxModelCalls: 5, modelRetries: 0 };
    const input = { actor: actorByEmail(db, 'owner@baraka.demo')!, message: 'hi', chatId: 'c1', protected: false, emit: () => {} };
    await runAgent({ ...deps, fallbackModels: [{ name: 'fb', model: fallback() }] }, input);
    const after1 = primary.calls;
    await runAgent({ ...deps, fallbackModels: [{ name: 'fb', model: fallback() }] }, { ...input, chatId: 'c2' });
    expect(after1).toBe(1);
    expect(primary.calls).toBe(1); // not retried while cooling down
  });

  it('falls back to the next model when the main one is out of quota', async () => {
    const primary = new FailingModel(geminiDaily);
    const fallback = new ScriptedModel(() => ({ steps: [[{ name: 'get_inventory', args: {} }]], final: 'You have 6 jerrycans of cooking oil.' }));
    const events = await run(primary, [fallback]);
    expect(primary.calls).toBeGreaterThan(0);
    expect(events.some((e) => e.type === 'tool_result' && e.tool === 'get_inventory')).toBe(true);
    expect((events.find((e) => e.type === 'final') as any)?.text).toMatch(/6 jerrycans/);
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });
});
