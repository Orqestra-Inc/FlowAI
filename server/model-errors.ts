/**
 * Turn model-provider failures into messages a business user understands, and decide which ones are
 * worth retrying. Raw provider errors (quota names, JSON blobs) are kept for the audit log only.
 */
export type ModelErrorKind = 'rate_limit' | 'daily_quota' | 'overloaded' | 'auth' | 'other';

function text(err: unknown): string {
  if (!err) return '';
  if (err instanceof Error) return `${err.name} ${err.message} ${String((err as any).status ?? (err as any).code ?? '')}`;
  return String(err);
}

export function classifyModelError(err: unknown): ModelErrorKind {
  const t = text(err);
  const status = Number((err as any)?.status ?? (err as any)?.response?.status ?? NaN);
  const quota = status === 429 || /\b429\b|RESOURCE_EXHAUSTED|rate.?limit|quota|too many requests/i.test(t);
  if (quota) return /per.?day|PerDay|daily|RequestsPerDay/i.test(t) ? 'daily_quota' : 'rate_limit';
  if (status === 503 || status === 529 || /\b50[34]\b|overloaded|UNAVAILABLE|temporarily unavailable|DEADLINE_EXCEEDED/i.test(t)) return 'overloaded';
  if (status === 401 || status === 403 || /API key|PERMISSION_DENIED|UNAUTHENTICATED|invalid.*key/i.test(t)) return 'auth';
  return 'other';
}

/** Per-minute limits and overload clear up within seconds; a daily quota or a bad key does not. */
export function isRetryableModelError(err: unknown): boolean {
  const kind = classifyModelError(err);
  return kind === 'rate_limit' || kind === 'overloaded';
}

/** Null when the error isn't a model-provider problem (the caller then shows it as is). */
export function friendlyModelError(err: unknown, agentName: string, stepsRan = false): string | null {
  const msg = message(err, agentName);
  if (!msg) return null;
  return stepsRan ? msg.replace(' Nothing was changed.', ' Some steps had already run; see the action checks.') : msg;
}

function message(err: unknown, agentName: string): string | null {
  switch (classifyModelError(err)) {
    case 'rate_limit':
      return `${agentName} is getting a lot of requests right now and the AI provider asked us to slow down. Please wait a minute and try again. Nothing was changed.`;
    case 'daily_quota':
      return `${agentName} has used up today's AI allowance for this demo. Please try again later. Nothing was changed.`;
    case 'overloaded':
      return `The AI provider is busy right now. Please try again in a moment. Nothing was changed.`;
    case 'auth':
      return `${agentName} can't reach its AI model because the server's model key isn't set up correctly.`;
    default:
      return null;
  }
}
