import OpenAI from 'openai';
import { env } from '../../config/env';
import type { AiMessage, AiProvider } from './provider';

/**
 * OpenAI implementation of the AiProvider contract.
 *
 * Created lazily so the API boots without a key (isConfigured() gates every
 * call). Uses the chat completions API with text messages — we extract PDF text
 * upstream, so there's no dependency on OpenAI's file-input surface, which keeps
 * this portable across the whole gpt-4o / gpt-4.1 family.
 */
let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (client) return client;
  if (!env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not configured');
  client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  return client;
}

export const openAiProvider: AiProvider = {
  name: 'openai',

  isConfigured() {
    return Boolean(env.OPENAI_API_KEY);
  },

  async complete(messages: AiMessage[], opts = {}) {
    const res = await getClient().chat.completions.create({
      model: env.AI_MODEL,
      max_tokens: opts.maxTokens ?? 1024,
      messages,
    });

    const choice = res.choices[0];
    // A content filter can leave content null; surface it as empty so the
    // caller decides, rather than throwing on a null access.
    const text = (choice?.message?.content ?? '').trim();

    return {
      text,
      usage: {
        inputTokens: res.usage?.prompt_tokens ?? 0,
        outputTokens: res.usage?.completion_tokens ?? 0,
      },
    };
  },

  async *streamText(messages: AiMessage[], opts = {}) {
    const stream = await getClient().chat.completions.create({
      model: env.AI_MODEL,
      max_tokens: opts.maxTokens ?? 1024,
      messages,
      stream: true,
    });

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) yield delta;
    }
  },
};
