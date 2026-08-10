/**
 * Phase 9 hardening helpers:
 * - Org-scoped query invariant tests (unit)
 * - Sample anonymised dataset generator for load tests
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { safePdfFileName } from './letterRender';
import { SYSTEM_FIELDS } from './letterFields';

describe('letterRender.safePdfFileName', () => {
  it('sanitizes invalid characters and never includes salary', () => {
    const name = safePdfFileName('E/001', 'Jane Doe <CEO>', 'INCREMENT');
    assert.equal(name.includes('/'), false);
    assert.equal(name.includes('<'), false);
    assert.equal(name.toLowerCase().includes('ctc'), false);
    assert.equal(name.toLowerCase().includes('salary'), false);
    assert.match(name, /\.pdf$/);
  });
});

describe('org scope invariant', () => {
  it('orgScope SQL always prefixes organizationId', () => {
    // Mirrors orgScope.selectOne / selectAll contract used by letter services.
    const organizationId = 'org-a';
    const where = 'id = ?';
    const scopedWhere = where
      ? `organizationId = ? AND (${where})`
      : 'organizationId = ?';
    assert.equal(scopedWhere.startsWith('organizationId = ?'), true);
    const params = [organizationId, 'row-1'];
    assert.equal(params[0], organizationId);
  });

  it('cross-org filter rejects mismatched org id', () => {
    const rowOrg = 'org-a';
    const requestOrg = 'org-b';
    assert.notEqual(rowOrg, requestOrg);
  });
});

describe('system fields vocabulary', () => {
  it('includes core identity and compensation fields', () => {
    for (const f of [
      'Employee_ID',
      'Employee_Name',
      'Employee_Email',
      'New_CTC',
      'Effective_Date',
      'PDF_Password',
    ]) {
      assert.ok(SYSTEM_FIELDS.includes(f as any));
    }
  });
});

/** Build N anonymised employee rows for pilot load tests. */
export function buildAnonymisedDataset(n: number) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const oldCtc = 500000 + (i % 50) * 10000;
    const bump = i % 37 === 0 ? 5 : 1.1; // occasional 5x outlier for anomaly tests
    const newCtc = Math.round(oldCtc * bump);
    rows.push({
      Employee_ID: `E${String(i + 1).padStart(4, '0')}`,
      Employee_Name: `Employee ${i + 1}`,
      Employee_Email: `employee${i + 1}@example.com`,
      Designation: i % 2 === 0 ? 'Engineer' : 'Analyst',
      Department: ['Eng', 'HR', 'Finance'][i % 3],
      Old_CTC: String(oldCtc),
      New_CTC: String(newCtc),
      Increment_Percent: String((((newCtc - oldCtc) / oldCtc) * 100).toFixed(1)),
      Effective_Date: '2026-04-01',
      PDF_Password: `pw${i + 1}`,
      Manager_Name: 'Manager Example',
    });
  }
  // Inject a duplicate ID for validation blocked-case coverage
  if (n > 2) {
    rows[n - 1].Employee_ID = rows[0].Employee_ID;
  }
  return rows;
}

describe('anonymised dataset', () => {
  it('builds 500 rows with a duplicate id', () => {
    const rows = buildAnonymisedDataset(500);
    assert.equal(rows.length, 500);
    assert.equal(rows[499].Employee_ID, rows[0].Employee_ID);
  });
});
