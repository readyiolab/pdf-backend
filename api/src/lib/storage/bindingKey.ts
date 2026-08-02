/**
 * Pure helpers for org-prefixed object keys.
 * Kept dependency-free so unit tests don't open Redis/MySQL.
 */

/** Extract organization id from `org-{uuid}/…` keys. Null for platform keys. */
export function organizationIdFromKey(key: string): string | null {
  const m = key.match(
    /^org-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\//i
  );
  return m?.[1] ?? null;
}
