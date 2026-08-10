/**
 * Unit tests for AI model JSON extraction used by letter drafts.
 * Run: npx tsx --test src/modules/letters/letterAi.parseJson.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseModelJson } from './parseModelJson';

describe('parseModelJson', () => {
  it('parses clean TipTap JSON', () => {
    const doc = { type: 'doc', content: [{ type: 'paragraph' }] };
    assert.deepEqual(parseModelJson(JSON.stringify(doc)), doc);
  });

  it('strips markdown fences', () => {
    const doc = { type: 'doc', content: [] };
    assert.deepEqual(parseModelJson('```json\n' + JSON.stringify(doc) + '\n```'), doc);
  });

  it('extracts first object when trailing prose exists', () => {
    const doc = { type: 'doc', content: [{ type: 'paragraph', content: [] }] };
    const raw = JSON.stringify(doc) + '\nThanks!';
    assert.deepEqual(parseModelJson(raw), doc);
  });

  it('throws on empty garbage', () => {
    assert.throws(() => parseModelJson('not json at all'), /No JSON object/);
  });
});
