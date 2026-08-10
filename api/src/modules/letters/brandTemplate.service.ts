import crypto from 'crypto';
import { db } from '../../lib/mysql';
import { AppError } from '../../middleware/errorHandler.middleware';
import { writeLetterAudit } from '../orgs/orgs.service';
import { orgScope } from './orgScope';
import { STARTER_TEMPLATES, extractFieldTokens, type LetterType } from './letterFields';

function newId() {
  return crypto.randomUUID();
}

function parseJsonField<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === 'object') return value as T;
  try {
    return JSON.parse(String(value)) as T;
  } catch {
    return fallback;
  }
}

export const brandService = {
  async list(organizationId: string) {
    return orgScope.selectAll(organizationId, 'tbl_letter_brand_profile', '*', '', [], 'ORDER BY createdAt DESC');
  },

  async get(organizationId: string, id: string) {
    const row = await orgScope.selectOne(organizationId, 'tbl_letter_brand_profile', '*', 'id = ?', [id]);
    if (!row) throw new AppError('Brand profile not found', 404);
    return row;
  },

  async create(
    organizationId: string,
    userId: string,
    input: {
      name: string;
      logoKey?: string | null;
      letterheadKey?: string | null;
      footerText?: string | null;
      signatoryName?: string | null;
      signatoryDesignation?: string | null;
      defaultFont?: string;
    }
  ) {
    const id = newId();
    await db.insert('tbl_letter_brand_profile', {
      id,
      organizationId,
      name: input.name,
      logoKey: input.logoKey ?? null,
      letterheadKey: input.letterheadKey ?? null,
      footerText: input.footerText ?? null,
      signatoryName: input.signatoryName ?? null,
      signatoryDesignation: input.signatoryDesignation ?? null,
      defaultFont: input.defaultFont || 'Inter',
    });
    await writeLetterAudit(organizationId, userId, 'BRAND_CREATED', 'brand_profile', id, {
      name: input.name,
    });
    return this.get(organizationId, id);
  },

  async update(
    organizationId: string,
    userId: string,
    id: string,
    input: Partial<{
      name: string;
      logoKey: string | null;
      letterheadKey: string | null;
      footerText: string | null;
      signatoryName: string | null;
      signatoryDesignation: string | null;
      defaultFont: string;
    }>
  ) {
    await this.get(organizationId, id);
    const data: Record<string, unknown> = {};
    for (const key of [
      'name',
      'logoKey',
      'letterheadKey',
      'footerText',
      'signatoryName',
      'signatoryDesignation',
      'defaultFont',
    ] as const) {
      if (input[key] !== undefined) data[key] = input[key];
    }
    if (Object.keys(data).length === 0) return this.get(organizationId, id);
    await orgScope.update(organizationId, 'tbl_letter_brand_profile', data, 'id = ?', [id]);
    await writeLetterAudit(organizationId, userId, 'BRAND_UPDATED', 'brand_profile', id, data);
    return this.get(organizationId, id);
  },

  async remove(organizationId: string, userId: string, id: string) {
    await this.get(organizationId, id);
    await orgScope.delete(organizationId, 'tbl_letter_brand_profile', 'id = ?', [id]);
    await writeLetterAudit(organizationId, userId, 'BRAND_DELETED', 'brand_profile', id);
    return { deleted: true };
  },
};

export const templateService = {
  async list(organizationId: string) {
    const rows = await orgScope.selectAll(
      organizationId,
      'tbl_letter_template',
      '*',
      '',
      [],
      'ORDER BY updatedAt DESC'
    );
    return rows.map(publicTemplate);
  },

  async get(organizationId: string, id: string) {
    const row = await orgScope.selectOne(organizationId, 'tbl_letter_template', '*', 'id = ?', [id]);
    if (!row) throw new AppError('Template not found', 404);
    return publicTemplate(row);
  },

  async create(
    organizationId: string,
    userId: string,
    input: { name: string; type: LetterType; contentJson: unknown; fieldTokens?: string[] }
  ) {
    const id = newId();
    const tokens = input.fieldTokens?.length
      ? input.fieldTokens
      : extractFieldTokens(input.contentJson);
    await db.insert('tbl_letter_template', {
      id,
      organizationId,
      name: input.name,
      type: input.type,
      contentJson: JSON.stringify(input.contentJson),
      fieldTokens: JSON.stringify(tokens),
      version: 1,
      createdBy: userId,
    });
    await writeLetterAudit(organizationId, userId, 'TEMPLATE_CREATED', 'letter_template', id, {
      name: input.name,
      type: input.type,
    });
    return this.get(organizationId, id);
  },

  async update(
    organizationId: string,
    userId: string,
    id: string,
    input: {
      name?: string;
      contentJson?: unknown;
      fieldTokens?: string[];
      bumpVersion?: boolean;
    }
  ) {
    const existing = await orgScope.selectOne(
      organizationId,
      'tbl_letter_template',
      '*',
      'id = ?',
      [id]
    );
    if (!existing) throw new AppError('Template not found', 404);

    const data: Record<string, unknown> = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.contentJson !== undefined) {
      data.contentJson = JSON.stringify(input.contentJson);
      data.fieldTokens = JSON.stringify(
        input.fieldTokens?.length ? input.fieldTokens : extractFieldTokens(input.contentJson)
      );
    } else if (input.fieldTokens) {
      data.fieldTokens = JSON.stringify(input.fieldTokens);
    }
    if (input.bumpVersion !== false && (input.contentJson !== undefined || input.name !== undefined)) {
      data.version = Number(existing.version || 1) + 1;
    }

    await orgScope.update(organizationId, 'tbl_letter_template', data, 'id = ?', [id]);
    await writeLetterAudit(organizationId, userId, 'TEMPLATE_UPDATED', 'letter_template', id, {
      version: data.version ?? existing.version,
    });
    return this.get(organizationId, id);
  },

  async remove(organizationId: string, userId: string, id: string) {
    await this.get(organizationId, id);
    await orgScope.delete(organizationId, 'tbl_letter_template', 'id = ?', [id]);
    await writeLetterAudit(organizationId, userId, 'TEMPLATE_DELETED', 'letter_template', id);
    return { deleted: true };
  },

  /** Seeds starter templates once per org if none exist. */
  async ensureStarters(organizationId: string, userId: string) {
    const count = await orgScope.count(organizationId, 'tbl_letter_template');
    if (count > 0) {
      return { seeded: 0, templates: await this.list(organizationId) };
    }

    let seeded = 0;
    for (const starter of STARTER_TEMPLATES) {
      await this.create(organizationId, userId, {
        name: starter.name,
        type: starter.type,
        contentJson: starter.contentJson,
        fieldTokens: starter.fieldTokens,
      });
      seeded += 1;
    }
    return { seeded, templates: await this.list(organizationId) };
  },
};

function publicTemplate(row: any) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    type: row.type,
    contentJson: parseJsonField(row.contentJson, { type: 'doc', content: [] }),
    fieldTokens: parseJsonField<string[]>(row.fieldTokens, []),
    version: row.version,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
