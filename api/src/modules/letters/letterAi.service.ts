import crypto from 'crypto';
import { db } from '../../lib/mysql';
import { AppError } from '../../middleware/errorHandler.middleware';
import { getAiProvider, isAiConfigured } from '../../lib/ai/provider';
import { env } from '../../config/env';
import { PLAN_LIMITS } from '../../../../shared/constants';
import { writeLetterAudit } from '../orgs/orgs.service';
import { SYSTEM_FIELDS, STARTER_TEMPLATES, extractFieldTokens } from './letterFields';
import { orgScope } from './orgScope';
import { batchService } from './batch.service';
import { parseModelJson } from './parseModelJson';

export { parseModelJson } from './parseModelJson';

function newId() {
  return crypto.randomUUID();
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function embedTexts(texts: string[]): Promise<number[][]> {
  if (!env.OPENAI_API_KEY) throw new AppError('AI is not configured', 503);
  const OpenAI = (await import('openai')).default;
  const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  const res = await client.embeddings.create({
    model: 'text-embedding-3-small',
    input: texts,
  });
  return res.data.map((d) => d.embedding as number[]);
}

async function consumeAiCredit(userId: string, plan: 'FREE' | 'PRO' | 'ENTERPRISE') {
  const user = await db.select('tbl_user', '*', 'id = ?', [userId]);
  if (!user) throw new AppError('User not found', 404);
  const limits = PLAN_LIMITS[plan];
  const resetAt = user.monthlyAiResetAt ? new Date(user.monthlyAiResetAt) : new Date(0);
  let used = Number(user.monthlyAiUsed || 0);
  const monthAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  if (resetAt.getTime() < monthAgo) {
    used = 0;
    await db.update(
      'tbl_user',
      { monthlyAiUsed: 0, monthlyAiResetAt: new Date() },
      'id = ?',
      [userId]
    );
  }
  if (used >= limits.maxMonthlyAiCredits) {
    throw new AppError('Monthly AI credit limit reached. Upgrade your plan for more.', 403);
  }
  await db.update('tbl_user', { monthlyAiUsed: used + 1 }, 'id = ?', [userId]);
}

function repairTokens(contentJson: any, allowed: string[]): { content: any; repaired: string[] } {
  const allowedSet = new Set(allowed);
  const repaired: string[] = [];
  const text = JSON.stringify(contentJson);
  const fixed = text.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (m, token: string) => {
    if (allowedSet.has(token)) return m;
    // Try case-insensitive / underscore match against system fields
    const hit = allowed.find((a) => a.toLowerCase() === token.toLowerCase());
    if (hit) {
      repaired.push(`${token}->${hit}`);
      return `{{${hit}}}`;
    }
    repaired.push(`${token}->removed`);
    return token;
  });
  try {
    return { content: JSON.parse(fixed), repaired };
  } catch {
    return { content: contentJson, repaired };
  }
}

function fallbackDraftDoc(instruction: string): any {
  return {
    type: 'doc',
    content: [
      {
        type: 'heading',
        attrs: { level: 2 },
        content: [{ type: 'text', text: 'Employment Letter' }],
      },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Dear ' },
          { type: 'text', text: '{{Employee_Name}}' },
          { type: 'text', text: ',' },
        ],
      },
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text:
              instruction.slice(0, 400) ||
              'Please find the details of this letter below.',
          },
        ],
      },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Effective date: ' },
          { type: 'text', text: '{{Effective_Date}}' },
          { type: 'text', text: '.' },
        ],
      },
      {
        type: 'paragraph',
        content: [{ type: 'text', text: 'Warm regards,' }],
      },
      {
        type: 'paragraph',
        content: [{ type: 'text', text: '{{Manager_Name}}' }],
      },
    ],
  };
}

/** Plain TypeScript draft → validate → refine loop (no LangGraph). */
export async function draftValidateRefine(opts: {
  instruction: string;
  letterType?: string;
  organizationId: string;
  ragSnippets: string[];
}): Promise<{ contentJson: any; fieldTokens: string[]; repaired: string[]; model: string }> {
  const provider = getAiProvider();
  if (!provider.isConfigured()) throw new AppError('AI is not configured', 503);

  const allowed: string[] = [...SYSTEM_FIELDS];
  const system = `You are an HR letter drafting assistant. Return ONLY valid TipTap JSON
shaped as {"type":"doc","content":[...]} using paragraph/heading/text nodes.
Insert field tokens exactly like {{Employee_Name}} from this allowed list: ${allowed.join(', ')}.
Never invent other tokens. Formal professional tone.`;

  const user = `Letter type: ${opts.letterType || 'INCREMENT'}
Instruction: ${opts.instruction}
${opts.ragSnippets.length ? `Org voice examples:\n${opts.ragSnippets.join('\n---\n')}` : ''}
Return TipTap JSON only.`;

  const first = await provider.complete(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    { maxTokens: 2000 }
  );

  let contentJson: any;
  let usedFallback = false;
  try {
    contentJson = parseModelJson(first.text);
  } catch {
    try {
      const repair = await provider.complete(
        [
          {
            role: 'system',
            content:
              'Fix the following into valid TipTap JSON only. Shape: {"type":"doc","content":[...]}. No markdown.',
          },
          { role: 'user', content: first.text },
        ],
        { maxTokens: 2000 }
      );
      contentJson = parseModelJson(repair.text);
    } catch {
      usedFallback = true;
      contentJson = fallbackDraftDoc(opts.instruction);
    }
  }

  if (!contentJson || contentJson.type !== 'doc' || !Array.isArray(contentJson.content)) {
    usedFallback = true;
    contentJson = fallbackDraftDoc(opts.instruction);
  }

  let { content, repaired } = repairTokens(contentJson, allowed);
  if (usedFallback) repaired = [...repaired, 'used-fallback-doc'];
  const tokens = extractFieldTokens(content);

  // Second pass if unknown tokens remain
  const unknown = tokens.filter((t: string) => !allowed.includes(t));
  if (unknown.length) {
    const refine = await provider.complete(
      [
        {
          role: 'system',
          content: `Rewrite this TipTap JSON so every {{Token}} is from: ${allowed.join(', ')}. Return JSON only.`,
        },
        { role: 'user', content: JSON.stringify(content) },
      ],
      { maxTokens: 2000 }
    );
    try {
      const parsed = parseModelJson(refine.text);
      const second = repairTokens(parsed, allowed);
      content = second.content;
      repaired = [...repaired, ...second.repaired];
    } catch {
      /* keep first repair */
    }
  }

  return {
    contentJson: content,
    fieldTokens: extractFieldTokens(content),
    repaired,
    model: env.AI_MODEL,
  };
}

export const letterAiService = {
  async embedTemplate(organizationId: string, templateId: string, text: string) {
    if (!isAiConfigured()) return;
    const [vector] = await embedTexts([text.slice(0, 8000)]);
    await db.execute(
      `DELETE FROM tbl_letter_embedding WHERE organizationId = ? AND sourceType = ? AND sourceId = ?`,
      [organizationId, 'template', templateId]
    );
    await db.insert('tbl_letter_embedding', {
      id: newId(),
      organizationId,
      sourceType: 'template',
      sourceId: templateId,
      chunkText: text.slice(0, 4000),
      vectorJson: JSON.stringify(vector),
      model: 'text-embedding-3-small',
    });
  },

  async retrieveSimilar(organizationId: string, query: string, limit = 3): Promise<string[]> {
    if (!isAiConfigured()) return [];
    const rows = await orgScope.selectAll(
      organizationId,
      'tbl_letter_embedding',
      '*',
      `sourceType = 'template'`,
      []
    );
    if (!rows.length) return [];
    const [q] = await embedTexts([query]);
    const scored = rows
      .map((r: any) => {
        const vec =
          typeof r.vectorJson === 'string' ? JSON.parse(r.vectorJson) : r.vectorJson;
        return { text: r.chunkText as string, score: cosine(q, vec as number[]) };
      })
      .sort((a: { score: number }, b: { score: number }) => b.score - a.score)
      .slice(0, limit);
    return scored.map((s: { text: string }) => s.text);
  },

  async draft(
    organizationId: string,
    userId: string,
    plan: 'FREE' | 'PRO' | 'ENTERPRISE',
    input: { instruction: string; letterType?: string }
  ) {
    await consumeAiCredit(userId, plan);
    const snippets = await this.retrieveSimilar(
      organizationId,
      `${input.letterType || ''} ${input.instruction}`
    );
    const result = await draftValidateRefine({
      instruction: input.instruction,
      letterType: input.letterType,
      organizationId,
      ragSnippets: snippets,
    });
    // Proposal only — do not auto-save. Audit that a suggestion was generated.
    await writeLetterAudit(
      organizationId,
      userId,
      'AI_DRAFT_SUGGESTED',
      'letter_template',
      null,
      { letterType: input.letterType, model: result.model, repaired: result.repaired },
      true
    );
    return result;
  },

  async applyDraft(
    organizationId: string,
    userId: string,
    templateId: string | null,
    contentJson: unknown,
    name?: string,
    type?: string
  ) {
    // Separate user-initiated write — trust gate
    await writeLetterAudit(
      organizationId,
      userId,
      'AI_DRAFT_APPLIED',
      'letter_template',
      templateId,
      { name, type },
      true
    );
    return { applied: true, contentJson };
  },

  async polish(
    organizationId: string,
    userId: string,
    plan: 'FREE' | 'PRO' | 'ENTERPRISE',
    input: { text: string; mode: 'formal' | 'concise' | 'add-disclaimer' }
  ) {
    await consumeAiCredit(userId, plan);
    const provider = getAiProvider();
    if (!provider.isConfigured()) throw new AppError('AI is not configured', 503);

    const modePrompt =
      input.mode === 'formal'
        ? 'Rewrite more formally for HR correspondence.'
        : input.mode === 'concise'
          ? 'Rewrite more concisely without losing meaning.'
          : 'Rewrite and append a short appropriate legal disclaimer suitable for an employment letter.';

    const res = await provider.complete(
      [
        { role: 'system', content: `${modePrompt} Return only the rewritten paragraph text.` },
        { role: 'user', content: input.text },
      ],
      { maxTokens: 800 }
    );

    await writeLetterAudit(
      organizationId,
      userId,
      'AI_POLISH_SUGGESTED',
      'letter_template',
      null,
      { mode: input.mode, model: env.AI_MODEL },
      true
    );

    return {
      original: input.text,
      suggestion: res.text,
      mode: input.mode,
      model: env.AI_MODEL,
    };
  },

  async suggestMapping(
    organizationId: string,
    userId: string,
    plan: 'FREE' | 'PRO' | 'ENTERPRISE',
    headers: string[]
  ) {
    await consumeAiCredit(userId, plan);
    const fields: string[] = [...SYSTEM_FIELDS];
    const vectors = await embedTexts([...headers, ...fields]);
    const headerVecs = vectors.slice(0, headers.length);
    const fieldVecs = vectors.slice(headers.length);

    const suggestions: Record<
      string,
      { field: string; score: number; aiSuggested: boolean } | null
    > = {};

    const used = new Set<string>();
    for (let i = 0; i < headers.length; i++) {
      let best = { field: '', score: -1 };
      for (let j = 0; j < fields.length; j++) {
        if (used.has(fields[j])) continue;
        const score = cosine(headerVecs[i], fieldVecs[j]);
        if (score > best.score) best = { field: fields[j], score };
      }
      if (best.score >= 0.35) {
        suggestions[headers[i]] = { field: best.field, score: best.score, aiSuggested: true };
        used.add(best.field);
      } else {
        suggestions[headers[i]] = null;
      }
    }

    // LLM fallback for unmapped headers
    const unmapped = headers.filter((h) => !suggestions[h]);
    if (unmapped.length && isAiConfigured()) {
      const provider = getAiProvider();
      const remaining = fields.filter((f) => !used.has(f));
      const res = await provider.complete(
        [
          {
            role: 'system',
            content: `Map Excel headers to system fields. Return JSON object header->field or null. Fields: ${remaining.join(', ')}`,
          },
          { role: 'user', content: JSON.stringify(unmapped) },
        ],
        { maxTokens: 400 }
      );
      try {
        const cleaned = res.text.replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
        const parsed = JSON.parse(cleaned) as Record<string, string | null>;
        for (const [h, f] of Object.entries(parsed)) {
          if (f && remaining.includes(f) && !used.has(f)) {
            suggestions[h] = { field: f, score: 0.3, aiSuggested: true };
            used.add(f);
          }
        }
      } catch {
        /* ignore */
      }
    }

    await writeLetterAudit(
      organizationId,
      userId,
      'AI_MAPPING_SUGGESTED',
      'letter_batch',
      null,
      { headers },
      true
    );

    return { suggestions, systemFields: fields };
  },

  async detectAnomalies(organizationId: string, userId: string, batchId: string) {
    await batchService.get(organizationId, batchId);
    const employees = await db.queryAll<any>(
      `SELECT id, rowIndex, employeeDataJson, validationStatus FROM tbl_letter_batch_employee WHERE batchId = ?`,
      [batchId]
    );

    const rows = employees.map((e: any) => ({
      id: e.id,
      rowIndex: e.rowIndex,
      data:
        typeof e.employeeDataJson === 'string'
          ? JSON.parse(e.employeeDataJson)
          : e.employeeDataJson || {},
      validationStatus: e.validationStatus,
    }));

    const increments: number[] = [];
    for (const r of rows) {
      const oldC = Number(String(r.data.Old_CTC || '').replace(/,/g, ''));
      const newC = Number(String(r.data.New_CTC || '').replace(/,/g, ''));
      if (oldC > 0 && newC > 0) increments.push((newC - oldC) / oldC);
    }
    const avg =
      increments.length > 0 ? increments.reduce((a, b) => a + b, 0) / increments.length : 0;

    const nameCounts = new Map<string, number>();
    for (const r of rows) {
      const n = String(r.data.Employee_Name || '').trim().toLowerCase();
      if (n) nameCounts.set(n, (nameCounts.get(n) || 0) + 1);
    }

    let flagged = 0;
    for (const r of rows) {
      const flags: Array<{ code: string; message: string }> = [];
      const oldC = Number(String(r.data.Old_CTC || '').replace(/,/g, ''));
      const newC = Number(String(r.data.New_CTC || '').replace(/,/g, ''));
      if (oldC > 0 && newC > 0) {
        const jump = (newC - oldC) / oldC;
        if (avg > 0 && jump > avg * 5) {
          flags.push({
            code: 'SALARY_OUTLIER',
            message: `Increment ${(jump * 100).toFixed(1)}% is far above batch average ${(avg * 100).toFixed(1)}%`,
          });
        }
      }
      const n = String(r.data.Employee_Name || '').trim().toLowerCase();
      if (n && (nameCounts.get(n) || 0) > 1) {
        flags.push({
          code: 'DUPLICATE_NAME',
          message: `Name appears ${(nameCounts.get(n) || 0)} times in this batch`,
        });
      }
      const eff = String(r.data.Effective_Date || '').trim();
      if (eff) {
        const d = new Date(eff);
        if (!Number.isNaN(d.getTime())) {
          const year = d.getFullYear();
          if (year < 2000 || year > new Date().getFullYear() + 2) {
            flags.push({
              code: 'DATE_OUT_OF_RANGE',
              message: `Effective_Date ${eff} looks unusual`,
            });
          }
        }
      }

      if (flags.length) {
        flagged += 1;
        // Soft flags only — never change validationStatus
        await db.update(
          'tbl_letter_batch_employee',
          { anomalyFlagsJson: JSON.stringify(flags) },
          'id = ?',
          [r.id]
        );
      } else {
        await db.update(
          'tbl_letter_batch_employee',
          { anomalyFlagsJson: JSON.stringify([]) },
          'id = ?',
          [r.id]
        );
      }
    }

    await writeLetterAudit(
      organizationId,
      userId,
      'AI_ANOMALY_SCAN',
      'letter_batch',
      batchId,
      { flagged, avgIncrement: avg },
      true
    );

    return { flagged, avgIncrementPercent: Number((avg * 100).toFixed(2)) };
  },

  async batchSummary(organizationId: string, userId: string, batchId: string) {
    const batch = await batchService.get(organizationId, batchId);
    // Counts from SQL — model only writes prose
    const stats = {
      total: batch.totalRows,
      ready: batch.readyCount,
      warning: batch.warningCount,
      blocked: batch.blockedCount,
      generated: batch.generatedCount,
      failed: batch.failedCount,
      sent: batch.sentCount,
    };

    let avgIncrement = 0;
    const rows = await db.queryAll<any>(
      `SELECT employeeDataJson FROM tbl_letter_batch_employee WHERE batchId = ? LIMIT 2000`,
      [batchId]
    );
    const incs: number[] = [];
    for (const r of rows) {
      const data = typeof r.employeeDataJson === 'string' ? JSON.parse(r.employeeDataJson) : r.employeeDataJson;
      const pct = Number(String(data?.Increment_Percent || '').replace(/%/g, ''));
      if (Number.isFinite(pct) && pct !== 0) incs.push(pct);
      else {
        const oldC = Number(String(data?.Old_CTC || '').replace(/,/g, ''));
        const newC = Number(String(data?.New_CTC || '').replace(/,/g, ''));
        if (oldC > 0 && newC > 0) incs.push(((newC - oldC) / oldC) * 100);
      }
    }
    if (incs.length) avgIncrement = incs.reduce((a, b) => a + b, 0) / incs.length;

    let summary = `${stats.generated} letters generated, ${stats.blocked} blocked, avg increment ${avgIncrement.toFixed(1)}%.`;
    if (isAiConfigured()) {
      const provider = getAiProvider();
      const res = await provider.complete(
        [
          {
            role: 'system',
            content:
              'Write one plain-language HR batch summary sentence. Use ONLY the provided numbers — do not invent counts.',
          },
          {
            role: 'user',
            content: JSON.stringify({ ...stats, avgIncrementPercent: Number(avgIncrement.toFixed(1)) }),
          },
        ],
        { maxTokens: 200 }
      );
      if (res.text) summary = res.text;
    }

    await orgScope.update(organizationId, 'tbl_letter_batch', { aiSummary: summary }, 'id = ?', [
      batchId,
    ]);
    await writeLetterAudit(
      organizationId,
      userId,
      'AI_BATCH_SUMMARY',
      'letter_batch',
      batchId,
      { stats },
      true
    );
    return { summary, stats, avgIncrementPercent: Number(avgIncrement.toFixed(1)) };
  },

  async naturalLanguageQuery(
    organizationId: string,
    userId: string,
    plan: 'FREE' | 'PRO' | 'ENTERPRISE',
    question: string
  ) {
    await consumeAiCredit(userId, plan);
    const provider = getAiProvider();
    if (!provider.isConfigured()) throw new AppError('AI is not configured', 503);

    const res = await provider.complete(
      [
        {
          role: 'system',
          content: `Convert the HR question into a JSON filter object with optional keys:
sendStatus (PENDING|DRAFT_CREATED|SENT|FAILED|SKIPPED),
validationStatus (READY|WARNING|BLOCKED),
batchStatus, dateFrom (ISO), dateTo (ISO), limit (number).
Return JSON only. Never return SQL.`,
        },
        { role: 'user', content: question },
      ],
      { maxTokens: 300 }
    );

    let filter: Record<string, unknown> = {};
    try {
      const cleaned = res.text.replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
      filter = JSON.parse(cleaned);
    } catch {
      filter = {};
    }

    const where: string[] = ['b.organizationId = ?'];
    const params: unknown[] = [organizationId];
    if (typeof filter.sendStatus === 'string') {
      where.push('e.sendStatus = ?');
      params.push(filter.sendStatus);
    }
    if (typeof filter.validationStatus === 'string') {
      where.push('e.validationStatus = ?');
      params.push(filter.validationStatus);
    }
    if (typeof filter.dateFrom === 'string') {
      where.push('b.createdAt >= ?');
      params.push(new Date(filter.dateFrom));
    }
    if (typeof filter.dateTo === 'string') {
      where.push('b.createdAt <= ?');
      params.push(new Date(filter.dateTo));
    }
    const limit = Math.min(Number(filter.limit) || 50, 200);

    const rows = await db.queryAll<any>(
      `SELECT e.id, e.rowIndex, e.sendStatus, e.validationStatus, e.employeeDataJson,
              b.id AS batchId, b.createdAt AS batchCreatedAt, b.status AS batchStatus
         FROM tbl_letter_batch_employee e
         JOIN tbl_letter_batch b ON b.id = e.batchId
        WHERE ${where.join(' AND ')}
        ORDER BY b.createdAt DESC, e.rowIndex ASC
        LIMIT ${limit}`,
      params
    );

    await writeLetterAudit(
      organizationId,
      userId,
      'AI_NL_QUERY',
      'letter_batch',
      null,
      { question, filter },
      true
    );

    return {
      filter,
      results: rows.map((r: any) => {
        const data =
          typeof r.employeeDataJson === 'string'
            ? JSON.parse(r.employeeDataJson)
            : r.employeeDataJson || {};
        const { PDF_Password: _pw, ...safe } = data;
        return {
          id: r.id,
          batchId: r.batchId,
          rowIndex: r.rowIndex,
          sendStatus: r.sendStatus,
          validationStatus: r.validationStatus,
          employee: safe,
          batchCreatedAt: r.batchCreatedAt,
        };
      }),
    };
  },

  async suggestTemplate(
    organizationId: string,
    userId: string,
    plan: 'FREE' | 'PRO' | 'ENTERPRISE',
    letterType: string
  ) {
    await consumeAiCredit(userId, plan);
    const existing = await orgScope.selectAll(
      organizationId,
      'tbl_letter_template',
      'id, name, type, contentJson',
      '',
      []
    );
    const starter = STARTER_TEMPLATES.find((s) => s.type === (letterType as any));
    const snippets = await this.retrieveSimilar(organizationId, letterType, 2);

    if (snippets.length && isAiConfigured()) {
      const drafted = await draftValidateRefine({
        instruction: `Create a ${letterType} letter matching our organization's voice.`,
        letterType,
        organizationId,
        ragSnippets: snippets,
      });
      await writeLetterAudit(
        organizationId,
        userId,
        'AI_TEMPLATE_SUGGESTED',
        'letter_template',
        null,
        { letterType },
        true
      );
      return {
        suggestion: drafted,
        from: 'rag+llm',
        existingCount: existing.length,
      };
    }

    await writeLetterAudit(
      organizationId,
      userId,
      'AI_TEMPLATE_SUGGESTED',
      'letter_template',
      null,
      { letterType, from: 'starter' },
      true
    );

    return {
      suggestion: starter
        ? {
            contentJson: starter.contentJson,
            fieldTokens: starter.fieldTokens,
            repaired: [],
            model: 'starter-library',
          }
        : null,
      from: 'starter',
      existingCount: existing.length,
    };
  },
};
