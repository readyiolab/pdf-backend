export const MAX_PAGE_LIMIT = 100;
export const DEFAULT_PAGE_LIMIT = 50;

export function parsePagination(page?: unknown, limit?: unknown) {
  const p = Math.max(1, Number(page) || 1);
  const l = Math.min(Math.max(1, Number(limit) || DEFAULT_PAGE_LIMIT), MAX_PAGE_LIMIT);
  return { page: p, limit: l, offset: (p - 1) * l };
}

export function paginationMeta(page: number, limit: number, total: number) {
  return {
    page,
    limit,
    total,
    totalPages: total > 0 ? Math.ceil(total / limit) : 0,
  };
}
