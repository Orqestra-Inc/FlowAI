import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { ChatResult } from '@langchain/core/outputs';

export type ScriptCall = { name: string; args: Record<string, unknown> };
export type Script = { steps: ScriptCall[][]; final: string };

let seq = 0;

/**
 * A deterministic stand-in for an LLM: for the latest user message, it returns the scripted
 * tool calls step by step, then a final answer. Used for previews and live boundary tests,
 * so ArmorIQ's decisions can be tested without model randomness.
 */
export class ScriptedModel extends BaseChatModel {
  private readonly script: (userText: string) => Script;
  constructor(script: (userText: string) => Script) {
    super({});
    this.script = script;
  }
  _llmType() {
    return 'scripted';
  }
  bindTools() {
    return this as any;
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    let last = -1;
    messages.forEach((m, i) => {
      if (m.getType() === 'human') last = i;
    });
    const text = String(messages[last]?.content ?? '');
    const step = messages.slice(last + 1).filter((m) => m.getType() === 'ai').length;
    const script = this.script(text);
    const calls = script.steps[step];
    const message = calls
      ? new AIMessage({ content: '', tool_calls: calls.map((c) => ({ ...c, id: `call_${++seq}`, type: 'tool_call' as const })) })
      : new AIMessage({ content: script.final });
    return { generations: [{ text: typeof message.content === 'string' ? message.content : '', message }] };
  }
}
