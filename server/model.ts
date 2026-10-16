import { initChatModel } from 'langchain';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { config } from './config.js';

let modelPromise: Promise<BaseChatModel> | null = null;

/**
 * Any LangChain chat model, chosen by LLM_MODEL ("provider:model"), e.g.
 *   google-genai:gemini-3.8-flash | openai:gpt-4.1-mini | anthropic:claude-haiku-4-5
 * Switching models is a config change. Run `npm run eval` after switching.
 */
export function getModel(): Promise<BaseChatModel> {
  if (!modelPromise) {
    // Gemini 3 models are tuned for their default temperature; lowering it can cause looping.
    const options = /gemini-3/i.test(config.llmModel) ? {} : { temperature: 0 };
    modelPromise = initChatModel(config.llmModel, options).then((m) => m as unknown as BaseChatModel);
    modelPromise.catch(() => {
      modelPromise = null; // allow a retry after fixing config
    });
  }
  return modelPromise;
}
