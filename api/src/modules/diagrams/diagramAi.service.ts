import { AppError } from '../../middleware/errorHandler.middleware';
import { db } from '../../lib/mysql';
import { env } from '../../config/env';
import { logger } from '../../lib/logger';
import { PLAN_LIMITS } from '../../../../shared/constants';
import { asPlan } from '../../lib/storage';
import type { Plan } from '../../../../shared/types';
import { getAiProvider, isAiConfigured } from '../../lib/ai/provider';
import { parseModelJson } from '../letters/parseModelJson';
import {
  diagramDocumentSchema,
  diagramPageSchema,
  diagramPatchOpSchema,
  type DiagramDocument,
  type DiagramPage,
  type DiagramPatchOp,
} from './diagrams.types';
import { emptyDocument } from './diagrams.service';

const AI_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

const GENERATE_SYSTEM = `You are a diagram generation assistant for PDFPRODUCT.
Return ONLY a single JSON object matching this DiagramDocument schema (no markdown, no commentary):
{
  "version": 1,
  "pages": [
    {
      "id": "<uuid>",
      "name": "Page-1",
      "nodes": [
        {
          "id": "<uuid>",
          "label": "string",
          "shape": "rectangle|rounded|ellipse|diamond|hexagon|cylinder|...",
          "x": number, "y": number, "w": number, "h": number,
          "style": { "fill"?, "stroke"?, "fontSize"?, ... }
        }
      ],
      "edges": [
        {
          "id": "<uuid>",
          "source": "<nodeId>",
          "target": "<nodeId>",
          "label"?: "string",
          "style"?: { "arrow"?: "classic|block|open|oval|diamond|none", ... }
        }
      ]
    }
  ],
  "settings": {
    "grid": true,
    "gridSize": 10,
    "pageView": true,
    "background": "#ffffff",
    "connectionArrows": true,
    "connectionPoints": true,
    "guides": true,
    "paper": "a4-portrait",
    "pageWidth": 794,
    "pageHeight": 1123
  }
}
Rules:
- version must be 1
- at least one page with unique node/edge ids
- place nodes with sensible spacing (avoid overlap)
- edges must reference existing node ids
- output JSON only`;

const EDIT_SYSTEM = `You edit a single diagram page. Return ONLY a JSON array of patch operations.
Allowed ops (discriminated by "op"):
- {"op":"addNode","node":{id,label,shape,x,y,w,h,style?}}
- {"op":"updateNode","id":"...","changes":{label?,shape?,x?,y?,w?,h?,style?}}
- {"op":"removeNode","id":"..."}
- {"op":"addEdge","edge":{id,source,target,label?,style?}}
- {"op":"updateEdge","id":"...","changes":{source?,target?,label?,style?}}
- {"op":"removeEdge","id":"..."}
- {"op":"relabel","id":"...","label":"..."}
No markdown, no commentary — JSON array only.`;

const REPAIR_DOC_SYSTEM =
  'Fix the following into valid DiagramDocument JSON only. Shape: {"version":1,"pages":[...],"settings":{...}}. No markdown.';

const REPAIR_PATCH_SYSTEM =
  'Fix the following into a valid JSON array of diagram patch ops only. No markdown.';

/** Atomic monthly-credit reservation — same guarded UPDATE as ai.service. */
async function reserveAiCredit(userId: string, limit: number, plan: Plan): Promise<void> {
  const now = new Date();
  const cutoff = new Date(now.getTime() - AI_WINDOW_MS);
  const reserve = await db.execute(
    `UPDATE tbl_user
        SET monthlyAiUsed    = IF(monthlyAiResetAt < ?, 1, monthlyAiUsed + 1),
            monthlyAiResetAt = IF(monthlyAiResetAt < ?, ?, monthlyAiResetAt)
      WHERE id = ? AND (monthlyAiResetAt < ? OR monthlyAiUsed < ?)`,
    [cutoff, cutoff, now, userId, cutoff, limit]
  );
  if (reserve.affectedRows === 0) {
    throw new AppError(
      plan === 'FREE'
        ? `You've used all ${limit} free AI requests this month. Upgrade to PRO for more.`
        : `You've used all ${limit} AI requests for this month. It resets on a rolling 30-day basis.`,
      403
    );
  }
}

async function refundAiCredit(userId: string): Promise<void> {
  await db.execute(
    'UPDATE tbl_user SET monthlyAiUsed = GREATEST(monthlyAiUsed - 1, 0) WHERE id = ?',
    [userId]
  );
}

function applyPatches(page: DiagramPage, ops: DiagramPatchOp[]): DiagramPage {
  let nodes = [...page.nodes];
  let edges = [...page.edges];

  for (const op of ops) {
    switch (op.op) {
      case 'addNode':
        nodes.push(op.node);
        break;
      case 'updateNode':
        nodes = nodes.map((n) =>
          n.id === op.id ? { ...n, ...op.changes, id: n.id } : n
        );
        break;
      case 'removeNode':
        nodes = nodes.filter((n) => n.id !== op.id);
        edges = edges.filter((e) => e.source !== op.id && e.target !== op.id);
        break;
      case 'addEdge':
        edges.push(op.edge);
        break;
      case 'updateEdge':
        edges = edges.map((e) =>
          e.id === op.id ? { ...e, ...op.changes, id: e.id } : e
        );
        break;
      case 'removeEdge':
        edges = edges.filter((e) => e.id !== op.id);
        break;
      case 'relabel':
        nodes = nodes.map((n) => (n.id === op.id ? { ...n, label: op.label } : n));
        edges = edges.map((e) => (e.id === op.id ? { ...e, label: op.label } : e));
        break;
      default:
        break;
    }
  }

  return { ...page, nodes, edges };
}

function parseAndValidateDocument(raw: string): DiagramDocument {
  const parsed = parseModelJson(raw);
  return diagramDocumentSchema.parse(parsed);
}

function parseAndValidatePatches(raw: string): DiagramPatchOp[] {
  const parsed = parseModelJson(raw);
  if (!Array.isArray(parsed)) {
    throw new AppError('AI returned an invalid patch payload', 422);
  }
  return parsed.map((op, i) => {
    const result = diagramPatchOpSchema.safeParse(op);
    if (!result.success) {
      throw new AppError(`Invalid patch op at index ${i}`, 422);
    }
    return result.data;
  });
}

async function withCredit<T>(userId: string, plan: Plan, fn: () => Promise<T>): Promise<T> {
  const normalized = asPlan(plan);
  await reserveAiCredit(userId, PLAN_LIMITS[normalized].maxMonthlyAiCredits, normalized);
  try {
    return await fn();
  } catch (err) {
    await refundAiCredit(userId).catch(() => undefined);
    throw err;
  }
}

export const diagramAiService = {
  async generate(userId: string, plan: Plan, prompt: string) {
    if (!isAiConfigured()) {
      throw new AppError('Diagram AI is not configured. Set OPENAI_API_KEY.', 503);
    }
    const provider = getAiProvider();

    return withCredit(userId, plan, async () => {
      try {
        const first = await provider.complete(
          [
            { role: 'system', content: GENERATE_SYSTEM },
            { role: 'user', content: prompt },
          ],
          { maxTokens: 4096 }
        );

        let document: DiagramDocument;
        try {
          document = parseAndValidateDocument(first.text);
        } catch {
          const repair = await provider.complete(
            [
              { role: 'system', content: REPAIR_DOC_SYSTEM },
              { role: 'user', content: first.text },
            ],
            { maxTokens: 4096 }
          );
          try {
            document = parseAndValidateDocument(repair.text);
          } catch {
            throw new AppError('AI could not produce a valid diagram document', 422);
          }
        }

        logger.info(
          { userId, model: env.AI_MODEL, ...first.usage },
          'Diagram AI generate'
        );
        return { document };
      } catch (err) {
        if (err instanceof AppError) throw err;
        logger.error({ err, userId }, 'Diagram AI generate failed');
        throw new AppError('The AI service is temporarily unavailable. Please try again.', 503);
      }
    });
  },

  async edit(userId: string, plan: Plan, instruction: string, page: DiagramPage) {
    if (!isAiConfigured()) {
      throw new AppError('Diagram AI is not configured. Set OPENAI_API_KEY.', 503);
    }
    const provider = getAiProvider();
    const validatedPage = diagramPageSchema.parse(page);

    return withCredit(userId, plan, async () => {
      try {
        const first = await provider.complete(
          [
            { role: 'system', content: EDIT_SYSTEM },
            {
              role: 'user',
              content: `Instruction: ${instruction}\n\nCurrent page JSON:\n${JSON.stringify(validatedPage)}`,
            },
          ],
          { maxTokens: 4096 }
        );

        let patch: DiagramPatchOp[];
        try {
          patch = parseAndValidatePatches(first.text);
        } catch {
          const repair = await provider.complete(
            [
              { role: 'system', content: REPAIR_PATCH_SYSTEM },
              { role: 'user', content: first.text },
            ],
            { maxTokens: 4096 }
          );
          try {
            patch = parseAndValidatePatches(repair.text);
          } catch {
            throw new AppError('AI could not produce a valid diagram patch', 422);
          }
        }

        const nextPage = diagramPageSchema.parse(applyPatches(validatedPage, patch));
        logger.info(
          { userId, model: env.AI_MODEL, ops: patch.length },
          'Diagram AI edit'
        );
        return { patch, page: nextPage };
      } catch (err) {
        if (err instanceof AppError) throw err;
        logger.error({ err, userId }, 'Diagram AI edit failed');
        throw new AppError('The AI service is temporarily unavailable. Please try again.', 503);
      }
    });
  },

  async fromImage(
    userId: string,
    plan: Plan,
    imageBase64: string,
    mimeType: string,
    prompt?: string
  ) {
    if (!isAiConfigured()) {
      throw new AppError('Diagram AI is not configured. Set OPENAI_API_KEY.', 503);
    }
    const provider = getAiProvider();
    if (!provider.completeVision) {
      throw new AppError('Vision is not available on the configured AI provider.', 503);
    }

    const cleaned = imageBase64.replace(/^data:[^;]+;base64,/, '');
    const dataUrl = `data:${mimeType};base64,${cleaned}`;
    const userText =
      prompt?.trim() ||
      'Convert this image into a DiagramDocument JSON matching our schema. Infer shapes, labels, and connections.';

    return withCredit(userId, plan, async () => {
      try {
        const first = await provider.completeVision!(
          [
            { role: 'system', content: GENERATE_SYSTEM },
            {
              role: 'user',
              content: [
                { type: 'text', text: userText },
                { type: 'image_url', image_url: { url: dataUrl } },
              ],
            },
          ],
          { maxTokens: 4096 }
        );

        let document: DiagramDocument;
        try {
          document = parseAndValidateDocument(first.text);
        } catch {
          const repair = await provider.complete(
            [
              { role: 'system', content: REPAIR_DOC_SYSTEM },
              { role: 'user', content: first.text || JSON.stringify(emptyDocument()) },
            ],
            { maxTokens: 4096 }
          );
          try {
            document = parseAndValidateDocument(repair.text);
          } catch {
            throw new AppError('AI could not produce a valid diagram from the image', 422);
          }
        }

        logger.info(
          { userId, model: env.AI_MODEL, ...first.usage },
          'Diagram AI fromImage'
        );
        return { document };
      } catch (err) {
        if (err instanceof AppError) throw err;
        logger.error({ err, userId }, 'Diagram AI fromImage failed');
        throw new AppError('The AI service is temporarily unavailable. Please try again.', 503);
      }
    });
  },
};
