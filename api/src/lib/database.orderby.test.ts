/**
 * Unit tests for selectAll ORDER BY normalization.
 * Run: npx tsx --test src/lib/database.orderby.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOrderBy } from './databaseOrderBy';

describe('normalizeOrderBy', () => {
  it('prepends ORDER BY when callers pass bare column sort', () => {
    assert.equal(normalizeOrderBy('updatedAt DESC'), 'ORDER BY updatedAt DESC');
    assert.equal(normalizeOrderBy('createdAt DESC'), 'ORDER BY createdAt DESC');
  });

  it('keeps existing ORDER BY / LIMIT fragments', () => {
    assert.equal(normalizeOrderBy('ORDER BY updatedAt DESC'), 'ORDER BY updatedAt DESC');
    assert.equal(
      normalizeOrderBy('ORDER BY createdAt DESC LIMIT 10'),
      'ORDER BY createdAt DESC LIMIT 10'
    );
    assert.equal(normalizeOrderBy('LIMIT 10'), 'LIMIT 10');
  });

  it('returns empty for blank input', () => {
    assert.equal(normalizeOrderBy(''), '');
    assert.equal(normalizeOrderBy('   '), '');
  });

  it('builds a valid brands/templates-style SQL fragment', () => {
    const brandsSql = `SELECT * FROM tbl_letter_brand_profile WHERE organizationId = ? ${normalizeOrderBy('createdAt DESC')}`.trim();
    const templatesSql = `SELECT * FROM tbl_letter_template WHERE organizationId = ? ${normalizeOrderBy('updatedAt DESC')}`.trim();
    assert.equal(
      brandsSql,
      'SELECT * FROM tbl_letter_brand_profile WHERE organizationId = ? ORDER BY createdAt DESC'
    );
    assert.equal(
      templatesSql,
      'SELECT * FROM tbl_letter_template WHERE organizationId = ? ORDER BY updatedAt DESC'
    );
    assert.doesNotMatch(brandsSql, /\?\s+createdAt DESC/);
    assert.doesNotMatch(templatesSql, /\?\s+updatedAt DESC/);
  });
});
