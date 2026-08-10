import { env } from '../../config/env';
import { openAiProvider } from './openai';

/** A single turn in a conversation with the model. */
export interface AiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface VisionPart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string };
}

export type VisionMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string | VisionPart[];
};

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface AiCompletion {
  text: string;
  usage: AiUsage;
}

/**
 * The AI backend contract.
 *
 * Deliberately minimal and provider-neutral — text in, text out — so the AI
 * service never imports a vendor SDK directly. OpenAI is the active
 * implementation; a Claude implementation would satisfy the same interface and
 * plug in via the factory below, with no change to the service or routes.
 *
 * completeVision is optional — used by Diagram image-to-diagram.
 */
export interface AiProvider {
  readonly name: string;
  isConfigured(): boolean;
  complete(messages: AiMessage[], opts?: { maxTokens?: number }): Promise<AiCompletion>;
  /** Streams the answer as text deltas; the final delta may be empty. */
  streamText(messages: AiMessage[], opts?: { maxTokens?: number }): AsyncIterable<string>;
  completeVision?(
    messages: VisionMessage[],
    opts?: { maxTokens?: number; model?: string }
  ): Promise<AiCompletion>;
}

/** Returns the configured provider. Add cases here to support more vendors. */
export function getAiProvider(): AiProvider {
  switch (env.AI_PROVIDER) {
    case 'openai':
    default:
      return openAiProvider;
  }
}

export function isAiConfigured(): boolean {
  return getAiProvider().isConfigured();
}
