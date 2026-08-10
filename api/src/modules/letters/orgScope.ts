import { db } from '../../lib/mysql';
import { AppError } from '../../middleware/errorHandler.middleware';
import type { OrgContext } from '../../middleware/org.middleware';

/**
 * Shared query helpers that always inject organizationId.
 * Controllers/services must use these (or an explicit orgId param) —
 * never query letter tables without an org scope.
 */
export const orgScope = {
  require(ctx: OrgContext | undefined): OrgContext {
    if (!ctx?.organizationId) {
      throw new AppError('Organization context is required', 400);
    }
    return ctx;
  },

  async selectOne(
    organizationId: string,
    table: string,
    columns: string,
    where: string,
    params: unknown[] = []
  ) {
    const scopedWhere = where
      ? `organizationId = ? AND (${where})`
      : 'organizationId = ?';
    return db.select(table, columns, scopedWhere, [organizationId, ...params]);
  },

  async selectAll(
    organizationId: string,
    table: string,
    columns: string,
    where: string = '',
    params: unknown[] = [],
    orderby: string = ''
  ) {
    const scopedWhere = where
      ? `organizationId = ? AND (${where})`
      : 'organizationId = ?';
    return db.selectAll(table, columns, scopedWhere, [organizationId, ...params], orderby);
  },

  async count(
    organizationId: string,
    table: string,
    where: string = '',
    params: unknown[] = []
  ): Promise<number> {
    const scopedWhere = where
      ? `organizationId = ? AND (${where})`
      : 'organizationId = ?';
    return db.count(table, scopedWhere, [organizationId, ...params]);
  },

  async update(
    organizationId: string,
    table: string,
    data: Record<string, unknown>,
    where: string,
    params: unknown[] = []
  ) {
    const scopedWhere = where
      ? `organizationId = ? AND (${where})`
      : 'organizationId = ?';
    return db.update(table, data, scopedWhere, [organizationId, ...params]);
  },

  async delete(
    organizationId: string,
    table: string,
    where: string,
    params: unknown[] = []
  ) {
    const scopedWhere = where
      ? `organizationId = ? AND (${where})`
      : 'organizationId = ?';
    return db.delete(table, scopedWhere, [organizationId, ...params]);
  },
};
