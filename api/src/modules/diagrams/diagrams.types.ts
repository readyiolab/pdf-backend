import { z } from 'zod';

export const nodeStyleSchema = z.object({
  fill: z.string().optional(),
  stroke: z.string().optional(),
  strokeWidth: z.number().optional(),
  dashed: z.boolean().optional(),
  fontSize: z.number().optional(),
  fontColor: z.string().optional(),
  fontFamily: z.string().optional(),
  fontStyle: z.number().optional(),
  rounded: z.boolean().optional(),
  shadow: z.boolean().optional(),
  opacity: z.number().optional(),
  align: z.string().optional(),
  verticalAlign: z.string().optional(),
});

export const edgeStyleSchema = z.object({
  stroke: z.string().optional(),
  strokeWidth: z.number().optional(),
  dashed: z.boolean().optional(),
  arrow: z.enum(['classic', 'block', 'open', 'oval', 'diamond', 'none']).optional(),
  startArrow: z.enum(['classic', 'block', 'open', 'oval', 'diamond', 'none']).optional(),
  edgeStyle: z.enum(['orthogonal', 'straight', 'entityRelation', 'elbow']).optional(),
  curved: z.boolean().optional(),
  fontSize: z.number().optional(),
  fontColor: z.string().optional(),
});

export const diagramNodeSchema = z.object({
  id: z.string().min(1),
  label: z.string().default(''),
  shape: z.string().default('rectangle'),
  x: z.number(),
  y: z.number(),
  w: z.number().positive().default(120),
  h: z.number().positive().default(60),
  style: nodeStyleSchema.optional(),
});

export const diagramEdgeSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  target: z.string().min(1),
  label: z.string().optional().default(''),
  style: edgeStyleSchema.optional(),
});

export const diagramPageSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  nodes: z.array(diagramNodeSchema).default([]),
  edges: z.array(diagramEdgeSchema).default([]),
});

export const diagramDocumentSchema = z.object({
  version: z.literal(1).default(1),
  pages: z.array(diagramPageSchema).min(1),
  settings: z
    .object({
      grid: z.boolean().optional(),
      gridSize: z.number().optional(),
      pageView: z.boolean().optional(),
      background: z.string().optional(),
      connectionArrows: z.boolean().optional(),
      connectionPoints: z.boolean().optional(),
      guides: z.boolean().optional(),
      paper: z.enum(['a4-portrait', 'a4-landscape', 'letter', 'custom']).optional(),
      pageWidth: z.number().optional(),
      pageHeight: z.number().optional(),
    })
    .optional(),
});

export type DiagramDocument = z.infer<typeof diagramDocumentSchema>;
export type DiagramPage = z.infer<typeof diagramPageSchema>;

const MAX_JSON_CHARS = 2_000_000;

function contentSizeOk(doc: unknown) {
  return JSON.stringify(doc).length <= MAX_JSON_CHARS;
}

const emptyQuery = z.object({}).optional();
const emptyParams = z.object({}).optional();
const emptyBody = z.object({}).optional();

export const createDiagramSchema = z.object({
  body: z.object({
    title: z.string().min(1).max(255).optional(),
    folderId: z.string().nullable().optional(),
    content: diagramDocumentSchema.optional(),
  }),
  query: emptyQuery,
  params: emptyParams,
});

export const updateDiagramSchema = z.object({
  params: z.object({ id: z.string().min(1) }),
  query: emptyQuery,
  body: z
    .object({
      title: z.string().min(1).max(255).optional(),
      folderId: z.string().nullable().optional(),
      content: diagramDocumentSchema.optional(),
    })
    .refine((b) => b.title !== undefined || b.folderId !== undefined || b.content !== undefined, {
      message: 'Nothing to update',
    })
    .refine((b) => (b.content ? contentSizeOk(b.content) : true), {
      message: 'Diagram content is too large (max ~2MB)',
    }),
});

export const diagramIdSchema = z.object({
  params: z.object({ id: z.string().min(1) }),
  query: emptyQuery,
  body: emptyBody,
});

export const restoreVersionSchema = z.object({
  params: z.object({
    id: z.string().min(1),
    version: z.coerce.number().int().positive(),
  }),
  query: emptyQuery,
  body: emptyBody,
});

export const listDiagramsSchema = z.object({
  query: z.object({
    folderId: z.string().optional(),
  }),
  params: emptyParams,
  body: emptyBody,
});

export const createFolderSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(255),
  }),
  query: emptyQuery,
  params: emptyParams,
});

export const updateFolderSchema = z.object({
  params: z.object({ id: z.string().min(1) }),
  body: z.object({
    name: z.string().min(1).max(255),
  }),
  query: emptyQuery,
});

export const folderIdSchema = z.object({
  params: z.object({ id: z.string().min(1) }),
  query: emptyQuery,
  body: emptyBody,
});

export const createShareSchema = z.object({
  params: z.object({ id: z.string().min(1) }),
  body: z.object({
    role: z.enum(['VIEW', 'EDIT']).default('VIEW'),
    expiresAt: z.string().datetime().nullable().optional(),
  }),
  query: emptyQuery,
});

export const shareIdSchema = z.object({
  params: z.object({ shareId: z.string().min(1) }),
  query: emptyQuery,
  body: emptyBody,
});

export const sharedTokenSchema = z.object({
  params: z.object({ token: z.string().min(1) }),
  query: emptyQuery,
  body: emptyBody,
});

export const sharedUpdateSchema = z.object({
  params: z.object({ token: z.string().min(1) }),
  body: z.object({
    content: diagramDocumentSchema,
    title: z.string().min(1).max(255).optional(),
  }),
  query: emptyQuery,
});

export const aiGenerateSchema = z.object({
  body: z.object({
    prompt: z.string().min(3).max(4000),
  }),
  query: emptyQuery,
  params: emptyParams,
});

export const aiEditSchema = z.object({
  params: z.object({ id: z.string().min(1) }),
  body: z.object({
    instruction: z.string().min(2).max(4000),
    page: diagramPageSchema,
  }),
  query: emptyQuery,
});

export const aiFromImageSchema = z.object({
  body: z.object({
    imageBase64: z.string().min(32).max(7_000_000),
    mimeType: z.enum(['image/png', 'image/jpeg', 'image/jpg', 'image/webp']).default('image/png'),
    prompt: z.string().max(1000).optional(),
  }),
  query: emptyQuery,
  params: emptyParams,
});

export const diagramPatchOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('addNode'), node: diagramNodeSchema }),
  z.object({
    op: z.literal('updateNode'),
    id: z.string(),
    changes: diagramNodeSchema.partial().omit({ id: true }),
  }),
  z.object({ op: z.literal('removeNode'), id: z.string() }),
  z.object({ op: z.literal('addEdge'), edge: diagramEdgeSchema }),
  z.object({
    op: z.literal('updateEdge'),
    id: z.string(),
    changes: diagramEdgeSchema.partial().omit({ id: true }),
  }),
  z.object({ op: z.literal('removeEdge'), id: z.string() }),
  z.object({ op: z.literal('relabel'), id: z.string(), label: z.string() }),
]);

export type DiagramPatchOp = z.infer<typeof diagramPatchOpSchema>;
