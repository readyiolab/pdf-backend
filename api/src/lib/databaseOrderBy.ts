/**
 * selectAll callers historically passed either "createdAt DESC" or
 * "ORDER BY createdAt DESC". Always emit a valid SQL fragment.
 */
export function normalizeOrderBy(orderby = ''): string {
  const ob = (orderby || '').trim();
  if (!ob) return '';
  if (/^(ORDER\s+BY|LIMIT)\b/i.test(ob)) return ob;
  return `ORDER BY ${ob}`;
}
