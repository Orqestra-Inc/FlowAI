import { createMiddleware, ToolMessage } from 'langchain';

const stable = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(stable).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v as object).sort().map((k) => `${k}:${stable((v as any)[k])}`).join(',')}}`
  : JSON.stringify(v);

const text = (c: unknown) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p: any) => (typeof p === 'string' ? p : p?.text ?? '')).join('') : String(c ?? ''));
const STOPPED = /armoriq|blocked|block|hold|held|approval|rejected|timed? ?out|no_matching_policy|not-in-plan|fail-closed/i;

/**
 * Once ArmorIQ stops an exact action (same tool, same arguments) in a request, a repeat of it in the same
 * request is refused straight away instead of creating another hold and another wait. Some models retry a
 * refused call despite instructions; without this, each retry is a new 90-second hold until the step limit.
 * This only ever refuses more (fail-closed): calls that do run still go through the ArmorIQ handler.
 */
export function noRetryAfterRefusal() {
  const refused = new Map<string, string>();
  return createMiddleware({
    name: 'OrqestraNoRetryAfterRefusal',
    wrapToolCall: async (request, handler) => {
      const call = request.toolCall;
      const key = `${call.name}:${stable(call.args)}`;
      const earlier = refused.get(key);
      if (earlier) {
        return new ToolMessage({
          content: `Not run: ArmorIQ already refused this exact action earlier in this request (${earlier}). Do not retry it. Tell the user it was refused and why.`,
          tool_call_id: call.id ?? '',
          name: call.name,
          status: 'error',
        });
      }
      try {
        const result = await handler(request);
        if (ToolMessage.isInstance(result) && result.status === 'error' && STOPPED.test(text(result.content))) refused.set(key, text(result.content).slice(0, 160));
        return result;
      } catch (err) {
        // A stopped tool becomes an error result for the model (as the tool node does without this middleware),
        // so the run continues and the refusal is shown, rather than the whole request failing.
        const msg = err instanceof Error ? err.message : String(err);
        if (STOPPED.test(msg)) refused.set(key, msg.slice(0, 160));
        return new ToolMessage({ content: `Error: ${msg}`, tool_call_id: call.id ?? '', name: call.name, status: 'error' });
      }
    },
  });
}
