/**
 * Per-org circuit breaker for BYOC storage.
 * After terminal failures / ERROR status, fail fast for a cooldown window
 * instead of burning BullMQ retries and outbound SDK calls.
 */
const OPEN_TTL_MS = 60_000;
const openUntil = new Map<string, number>();

export function tripStorageCircuit(organizationId: string, ttlMs = OPEN_TTL_MS): void {
  openUntil.set(organizationId, Date.now() + ttlMs);
}

export function resetStorageCircuit(organizationId: string): void {
  openUntil.delete(organizationId);
}

export function isStorageCircuitOpen(organizationId: string): boolean {
  const until = openUntil.get(organizationId);
  if (!until) return false;
  if (Date.now() >= until) {
    openUntil.delete(organizationId);
    return false;
  }
  return true;
}
