/** Events streamed to the browser over SSE for one agent run. Shared with the web app (type-only). */
export type GuardSource = 'armoriq' | 'domain' | 'app' | 'unguarded';

export type AgentEvent =
  | { type: 'start'; runId: string; protected: boolean; model: string; user: string }
  /** The model chose these tool calls; with ArmorIQ on, they become the signed intent plan for this turn. */
  | { type: 'plan'; calls: Array<{ id?: string; tool: string; args: unknown }>; protected: boolean }
  /** ArmorIQ lifecycle (from the adapter's onEvent): hold | approved | rejected | timeout | block | error. */
  | { type: 'guard'; kind: 'hold' | 'approved' | 'rejected' | 'timeout' | 'block' | 'error'; tool: string; reason?: string; delegationId?: string }
  /** A tool actually ran. `outcome` is the tool's own result (business rules may still refuse). */
  | { type: 'tool_result'; tool: string; callId?: string; source: GuardSource; status: 'completed' | 'refused'; outcome: unknown }
  /** A tool did not run (stopped by ArmorIQ, or failed). */
  | { type: 'tool_stopped'; tool: string; callId?: string; source: GuardSource; reason: string }
  | { type: 'final'; text: string }
  | { type: 'error'; message: string }
  | { type: 'done'; toolCalls: number; stopped: number };
