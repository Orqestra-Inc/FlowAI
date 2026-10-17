import { createMiddleware } from 'langchain';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { classifyModelError, type ModelErrorKind } from '../model-errors.js';

export interface NamedModel {
  name: string;
  model: BaseChatModel;
}

/** How long to skip a model after each kind of failure. Free-tier daily quotas reset once a day. */
const COOLDOWN_MS: Record<ModelErrorKind, number> = {
  daily_quota: 60 * 60_000,
  rate_limit: 60_000,
  overloaded: 30_000,
  auth: 10 * 60_000,
  other: 0,
};

/** Process-wide: a model out of quota for one request is out of quota for all of them. */
const coolingUntil = new Map<string, number>();

export function resetModelCooldowns() {
  coolingUntil.clear();
}

/**
 * Model fallback for the agent loop (each model call independently).
 * Tries the primary model, then each fallback in order. A model that just failed with a quota,
 * rate-limit, overload or key error is skipped for a while, so requests don't keep wasting a call on it.
 * When everything fails, the most meaningful error is rethrown (a quota error rather than whatever
 * odd error the last fallback produced), so the user sees the real reason.
 */
export function modelFallback(primaryName: string, fallbacks: NamedModel[], log: (msg: string) => void = () => {}) {
  return createMiddleware({
    name: 'OrqestraModelFallback',
    wrapModelCall: async (request, handler) => {
      const chain: Array<NamedModel | null> = [null, ...fallbacks]; // null = the request's own (primary) model
      const nameOf = (c: NamedModel | null) => c?.name ?? primaryName;
      const now = Date.now();
      const ready = chain.filter((c) => (coolingUntil.get(nameOf(c)) ?? 0) <= now);
      const order = ready.length ? ready : chain; // everything cooling down: try them all anyway

      let providerError: unknown;
      let lastError: unknown;
      for (const c of order) {
        try {
          const result = await handler(c ? { ...request, model: c.model } : request);
          if (c) log(`answered by fallback model ${c.name}`);
          return result;
        } catch (err) {
          const kind = classifyModelError(err);
          if (COOLDOWN_MS[kind]) coolingUntil.set(nameOf(c), Date.now() + COOLDOWN_MS[kind]);
          log(`${nameOf(c)} failed (${kind})`);
          if (kind !== 'other' && providerError === undefined) providerError = err;
          lastError = err;
        }
      }
      throw providerError ?? lastError;
    },
  });
}
