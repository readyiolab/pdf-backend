import crypto from 'crypto';
import { db } from '../../lib/mysql';
import { env } from '../../config/env';
import { AppError } from '../../middleware/errorHandler.middleware';
import type { DiagramDocument } from './diagrams.types';

const MAX_VERSIONS = 20;

const PAPER_A4 = { w: 794, h: 1123 };

export function emptyDocument(): DiagramDocument {
  return {
    version: 1,
    pages: [{ id: crypto.randomUUID(), name: 'Page-1', nodes: [], edges: [] }],
    settings: {
      grid: true,
      gridSize: 10,
      pageView: true,
      background: '#ffffff',
      connectionArrows: true,
      connectionPoints: true,
      guides: true,
      paper: 'a4-portrait',
      pageWidth: PAPER_A4.w,
      pageHeight: PAPER_A4.h,
    },
  };
}

function newId() {
  return crypto.randomUUID();
}

function parseContent(contentJson: unknown): DiagramDocument {
  if (contentJson == null) return emptyDocument();
  if (typeof contentJson === 'object') return contentJson as DiagramDocument;
  try {
    return JSON.parse(String(contentJson)) as DiagramDocument;
  } catch {
    return emptyDocument();
  }
}

function publicDiagram(row: any, includeContent = false) {
  const base = {
    id: row.id as string,
    organizationId: row.organizationId as string,
    folderId: (row.folderId as string | null) ?? null,
    title: row.title as string,
    currentVersion: Number(row.currentVersion ?? 1),
    createdBy: row.createdBy as string,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    thumbnailPngKey: (row.thumbnailPngKey as string | null) ?? null,
  };
  if (includeContent) {
    return { ...base, content: parseContent(row.contentJson) };
  }
  return base;
}

function shareUrl(token: string) {
  return `${env.APP_URL.replace(/\/$/, '')}/diagrams/shared/${token}`;
}

function publicShare(row: any) {
  return {
    id: row.id as string,
    diagramId: row.diagramId as string,
    token: row.token as string,
    role: row.role as 'VIEW' | 'EDIT',
    expiresAt: row.expiresAt ?? null,
    revokedAt: row.revokedAt ?? null,
    createdAt: row.createdAt,
    url: shareUrl(row.token),
  };
}

async function requireDiagram(organizationId: string, id: string) {
  const row = await db.select(
    'tbl_diagram',
    '*',
    'id = ? AND organizationId = ?',
    [id, organizationId]
  );
  if (!row) throw new AppError('Diagram not found', 404);
  return row;
}

async function insertVersion(
  diagramId: string,
  version: number,
  contentJson: string,
  createdBy: string
) {
  await db.insert('tbl_diagram_version', {
    id: newId(),
    diagramId,
    version,
    contentJson,
    createdBy,
  });
  await pruneVersions(diagramId);
}

async function pruneVersions(diagramId: string) {
  const rows = await db.queryAll<any>(
    `SELECT id, version FROM tbl_diagram_version
      WHERE diagramId = ?
      ORDER BY version DESC`,
    [diagramId]
  );
  if (rows.length <= MAX_VERSIONS) return;
  const toDelete = rows.slice(MAX_VERSIONS).map((r) => r.id);
  if (!toDelete.length) return;
  await db.execute(
    `DELETE FROM tbl_diagram_version WHERE id IN (${toDelete.map(() => '?').join(',')})`,
    toDelete
  );
}

export const diagramsService = {
  emptyDocument,

  async list(organizationId: string, folderId?: string | null) {
    let rows: any[];
    if (folderId === undefined || folderId === null || folderId === '') {
      rows = await db.selectAll(
        'tbl_diagram',
        'id, organizationId, folderId, title, currentVersion, createdBy, createdAt, updatedAt, thumbnailPngKey',
        'organizationId = ?',
        [organizationId],
        'ORDER BY updatedAt DESC'
      );
    } else {
      rows = await db.selectAll(
        'tbl_diagram',
        'id, organizationId, folderId, title, currentVersion, createdBy, createdAt, updatedAt, thumbnailPngKey',
        'organizationId = ? AND folderId = ?',
        [organizationId, folderId],
        'ORDER BY updatedAt DESC'
      );
    }
    return rows.map((r) => publicDiagram(r, false));
  },

  async get(organizationId: string, id: string) {
    const row = await requireDiagram(organizationId, id);
    return publicDiagram(row, true);
  },

  async create(
    organizationId: string,
    userId: string,
    input: { title?: string; folderId?: string | null; content?: DiagramDocument }
  ) {
    const id = newId();
    const content = input.content ?? emptyDocument();
    const contentJson = JSON.stringify(content);
    await db.insert('tbl_diagram', {
      id,
      organizationId,
      folderId: input.folderId ?? null,
      title: input.title?.trim() || 'Untitled Diagram',
      contentJson,
      currentVersion: 1,
      createdBy: userId,
    });
    await insertVersion(id, 1, contentJson, userId);
    return this.get(organizationId, id);
  },

  async update(
    organizationId: string,
    userId: string,
    id: string,
    input: { title?: string; folderId?: string | null; content?: DiagramDocument }
  ) {
    const row = await requireDiagram(organizationId, id);
    const data: Record<string, unknown> = {};

    if (input.title !== undefined) data.title = input.title.trim() || row.title;
    if (input.folderId !== undefined) data.folderId = input.folderId;

    if (input.content !== undefined) {
      const expectedVersion = Number(row.currentVersion || 1);
      const nextVersion = expectedVersion + 1;
      const contentJson = JSON.stringify(input.content);
      data.contentJson = contentJson;
      data.currentVersion = nextVersion;
      const result = await db.update(
        'tbl_diagram',
        data,
        'id = ? AND organizationId = ? AND currentVersion = ?',
        [id, organizationId, expectedVersion]
      );
      if (result.affected_rows === 0) {
        throw new AppError(
          'Diagram was updated elsewhere. Reload and try again.',
          409
        );
      }
      await insertVersion(id, nextVersion, contentJson, userId);
      return this.get(organizationId, id);
    }

    if (Object.keys(data).length === 0) {
      return this.get(organizationId, id);
    }
    await db.update('tbl_diagram', data, 'id = ? AND organizationId = ?', [
      id,
      organizationId,
    ]);
    return this.get(organizationId, id);
  },

  async duplicate(organizationId: string, userId: string, id: string) {
    const row = await requireDiagram(organizationId, id);
    return this.create(organizationId, userId, {
      title: `${row.title} (Copy)`,
      folderId: row.folderId ?? null,
      content: parseContent(row.contentJson),
    });
  },

  async remove(organizationId: string, id: string) {
    await requireDiagram(organizationId, id);
    await db.delete('tbl_diagram', 'id = ? AND organizationId = ?', [id, organizationId]);
    return { ok: true };
  },

  async listVersions(organizationId: string, id: string) {
    await requireDiagram(organizationId, id);
    const rows = await db.queryAll<any>(
      `SELECT id, version, createdBy, createdAt
         FROM tbl_diagram_version
        WHERE diagramId = ?
        ORDER BY version DESC`,
      [id]
    );
    return rows.map((r) => ({
      id: r.id as string,
      version: Number(r.version),
      createdBy: r.createdBy as string,
      createdAt: r.createdAt,
    }));
  },

  async restoreVersion(
    organizationId: string,
    userId: string,
    id: string,
    version: number
  ) {
    await requireDiagram(organizationId, id);
    const snap = await db.select(
      'tbl_diagram_version',
      '*',
      'diagramId = ? AND version = ?',
      [id, version]
    );
    if (!snap) throw new AppError('Version not found', 404);
    const content = parseContent(snap.contentJson);
    return this.update(organizationId, userId, id, { content });
  },

  async listFolders(organizationId: string) {
    return db.selectAll(
      'tbl_diagram_folder',
      '*',
      'organizationId = ?',
      [organizationId],
      'ORDER BY name ASC'
    );
  },

  async createFolder(organizationId: string, userId: string, name: string) {
    const id = newId();
    await db.insert('tbl_diagram_folder', {
      id,
      organizationId,
      name: name.trim(),
      createdBy: userId,
    });
    const row = await db.select(
      'tbl_diagram_folder',
      '*',
      'id = ? AND organizationId = ?',
      [id, organizationId]
    );
    return row;
  },

  async renameFolder(organizationId: string, id: string, name: string) {
    const row = await db.select(
      'tbl_diagram_folder',
      '*',
      'id = ? AND organizationId = ?',
      [id, organizationId]
    );
    if (!row) throw new AppError('Folder not found', 404);
    await db.update(
      'tbl_diagram_folder',
      { name: name.trim() },
      'id = ? AND organizationId = ?',
      [id, organizationId]
    );
    return db.select(
      'tbl_diagram_folder',
      '*',
      'id = ? AND organizationId = ?',
      [id, organizationId]
    );
  },

  async deleteFolder(organizationId: string, id: string) {
    const row = await db.select(
      'tbl_diagram_folder',
      '*',
      'id = ? AND organizationId = ?',
      [id, organizationId]
    );
    if (!row) throw new AppError('Folder not found', 404);
    // FK ON DELETE SET NULL clears diagram.folderId; explicit null for clarity.
    await db.execute(
      `UPDATE tbl_diagram SET folderId = NULL WHERE organizationId = ? AND folderId = ?`,
      [organizationId, id]
    );
    await db.delete('tbl_diagram_folder', 'id = ? AND organizationId = ?', [
      id,
      organizationId,
    ]);
    return { ok: true };
  },

  async createShare(
    organizationId: string,
    userId: string,
    diagramId: string,
    input: { role: 'VIEW' | 'EDIT'; expiresAt?: string | null }
  ) {
    await requireDiagram(organizationId, diagramId);
    const id = newId();
    const token = crypto.randomBytes(32).toString('hex');
    await db.insert('tbl_diagram_share', {
      id,
      diagramId,
      token,
      role: input.role || 'VIEW',
      createdBy: userId,
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      revokedAt: null,
    });
    const row = await db.select('tbl_diagram_share', '*', 'id = ?', [id]);
    return publicShare(row);
  },

  async listShares(organizationId: string, diagramId: string) {
    await requireDiagram(organizationId, diagramId);
    const rows = await db.queryAll<any>(
      `SELECT s.*
         FROM tbl_diagram_share s
         JOIN tbl_diagram d ON d.id = s.diagramId
        WHERE s.diagramId = ? AND d.organizationId = ?
        ORDER BY s.createdAt DESC`,
      [diagramId, organizationId]
    );
    return rows.map(publicShare);
  },

  async revokeShare(organizationId: string, shareId: string) {
    const row = await db.query<any>(
      `SELECT s.*
         FROM tbl_diagram_share s
         JOIN tbl_diagram d ON d.id = s.diagramId
        WHERE s.id = ? AND d.organizationId = ?`,
      [shareId, organizationId]
    );
    if (!row) throw new AppError('Share not found', 404);
    await db.update(
      'tbl_diagram_share',
      { revokedAt: new Date() },
      'id = ?',
      [shareId]
    );
    return { ok: true };
  },

  async getByShareToken(token: string) {
    const row = await db.query<any>(
      `SELECT s.id AS shareId, s.token, s.role, s.expiresAt, s.revokedAt,
              d.id, d.organizationId, d.folderId, d.title, d.contentJson,
              d.currentVersion, d.createdBy, d.createdAt, d.updatedAt, d.thumbnailPngKey
         FROM tbl_diagram_share s
         JOIN tbl_diagram d ON d.id = s.diagramId
        WHERE s.token = ?`,
      [token]
    );
    if (!row) throw new AppError('Shared diagram not found', 404);
    if (row.revokedAt) throw new AppError('This share link has been revoked', 410);
    if (row.expiresAt && new Date(row.expiresAt).getTime() < Date.now()) {
      throw new AppError('This share link has expired', 410);
    }
    return {
      diagram: publicDiagram(row, true),
      share: {
        role: row.role as 'VIEW' | 'EDIT',
        token: row.token as string,
      },
    };
  },

  async updateByShareToken(
    token: string,
    input: { content: DiagramDocument; title?: string }
  ) {
    const row = await db.query<any>(
      `SELECT s.id AS shareId, s.token, s.role, s.expiresAt, s.revokedAt, s.createdBy,
              d.id, d.organizationId, d.currentVersion
         FROM tbl_diagram_share s
         JOIN tbl_diagram d ON d.id = s.diagramId
        WHERE s.token = ?`,
      [token]
    );
    if (!row) throw new AppError('Shared diagram not found', 404);
    if (row.revokedAt) throw new AppError('This share link has been revoked', 410);
    if (row.expiresAt && new Date(row.expiresAt).getTime() < Date.now()) {
      throw new AppError('This share link has expired', 410);
    }
    if (row.role !== 'EDIT') {
      throw new AppError('This share link is view-only', 403);
    }

    const expectedVersion = Number(row.currentVersion || 1);
    const nextVersion = expectedVersion + 1;
    const contentJson = JSON.stringify(input.content);
    const data: Record<string, unknown> = {
      contentJson,
      currentVersion: nextVersion,
    };
    if (input.title !== undefined) data.title = input.title.trim();

    const result = await db.update(
      'tbl_diagram',
      data,
      'id = ? AND currentVersion = ?',
      [row.id, expectedVersion]
    );
    if (result.affected_rows === 0) {
      throw new AppError('Diagram was updated elsewhere. Reload and try again.', 409);
    }
    await insertVersion(row.id, nextVersion, contentJson, row.createdBy);
    return this.get(row.organizationId, row.id);
  },
};
