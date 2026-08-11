import { AppError } from '../middleware/errorHandler.middleware';

/**
 * fetch with AbortSignal timeout. Use for all outbound HTTP so hung
 * upstreams cannot stall API/worker threads indefinitely.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = 20_000
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      throw new AppError(`Upstream request timed out after ${timeoutMs}ms`, 504);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
