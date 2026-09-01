import { AppError } from '../../middleware/errorHandler.middleware';

/** Map provider/SDK failures to actionable API errors (never leak secrets). */
export function toAiAppError(err: unknown, fallback = 'The AI service is temporarily unavailable. Please try again.'): AppError {
  if (err instanceof AppError) return err;

  const anyErr = err as { status?: number; code?: string; message?: string; error?: { message?: string } };
  const status = anyErr?.status;
  const code = String(anyErr?.code || '');
  const message = String(anyErr?.error?.message || anyErr?.message || err || '');

  if (status === 401 || /incorrect api key|invalid api key/i.test(message)) {
    return new AppError('AI is misconfigured: the OpenAI API key on the server is invalid.', 503);
  }
  if (status === 429 || code === 'rate_limit_exceeded' || /rate limit/i.test(message)) {
    return new AppError('AI rate limit reached. Please wait a moment and try again.', 429);
  }
  if (
    status === 402 ||
    /insufficient_quota|exceeded your current quota|billing/i.test(message)
  ) {
    return new AppError('AI quota exceeded. Check OpenAI billing for this server.', 503);
  }
  if (code === 'ETIMEDOUT' || /timeout|timed out/i.test(message)) {
    return new AppError('AI request timed out. Try a shorter or simpler prompt.', 504);
  }
  if (status === 400 && message) {
    return new AppError(`AI request was rejected: ${message.slice(0, 180)}`, 400);
  }

  return new AppError(fallback, 503);
}
