import { initChatModel } from 'langchain';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { config } from './config.js';

let modelPromise: Promise<BaseChatModel> | null = null;

/**
 * Any LangChain chat model, chosen by LLM_MODEL ("provider:model"), e.g.
 *   google-genai:gemini-3.8-flash | openai:gpt-4.1-mini | anthropic:claude-haiku-4-5
 * Switching models is a config change. Run `npm run eval` after switching.
 */
function load(name: string): Promise<BaseChatModel> {
  // Gemini 3 models are tuned for their default temperature; lowering it can cause looping.
  const options = /gemini-3/i.test(name) ? {} : { temperature: 0 };
  return initChatModel(name, options).then((m) => m as unknown as BaseChatModel);
}

export function getModel(): Promise<BaseChatModel> {
  if (!modelPromise) {
    modelPromise = load(config.llmModel);
    modelPromise.catch(() => {
      modelPromise = null; // allow a retry after fixing config
    });
  }
  return modelPromise;
}

let fallbackPromise: Promise<BaseChatModel[]> | null = null;

/** Fallback models from LLM_FALLBACK_MODELS. One that fails to load is skipped (logged), never fatal. */
export function getFallbackModels(): Promise<BaseChatModel[]> {
  if (!fallbackPromise) {
    fallbackPromise = Promise.all(
      config.llmFallbackModels.map((name) =>
        load(name).catch((err) => {
          console.warn(`[orqestra] fallback model "${name}" could not be loaded: ${(err as Error).message}`);
          return null;
        }),
      ),
    ).then((models) => models.filter((m): m is BaseChatModel => m !== null));
  }
  return fallbackPromise;
}
