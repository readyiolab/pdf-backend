/**
 * Retries an async operation on transient failures (e.g. MySQL deadlocks).
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: {
    maxAttempts?: number;
    baseDelay?: number;
    maxDelay?: number;
    context?: string;
    retryIf?: (error: unknown) => boolean;
  } = {}
): Promise<T> {
  const {
    maxAttempts = 3,
    baseDelay = 500,
    maxDelay = 5000,
    context = 'operation',
    retryIf = () => false,
  } = options;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastError = err;
      if (attempt >= maxAttempts || !retryIf(err)) {
        throw err;
      }
      const delay = Math.min(maxDelay, baseDelay * 2 ** (attempt - 1));
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`${context} failed after ${maxAttempts} attempts`);
}
