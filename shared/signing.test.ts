import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SIGNING_DOCX_MIME,
  SIGNING_PDF_MIME,
  isSigningAllowedContentType,
  isSigningOfficeUpload,
} from './signing';

describe('signing upload MIME helpers', () => {
  it('accepts PDF and DOCX content types', () => {
    assert.equal(isSigningAllowedContentType(SIGNING_PDF_MIME), true);
    assert.equal(isSigningAllowedContentType(SIGNING_DOCX_MIME), true);
    assert.equal(isSigningAllowedContentType('application/msword'), false);
    assert.equal(isSigningAllowedContentType('text/plain'), false);
  });

  it('detects Word uploads by MIME or .docx extension', () => {
    assert.equal(isSigningOfficeUpload(SIGNING_DOCX_MIME, 'contract.docx'), true);
    assert.equal(isSigningOfficeUpload('application/octet-stream', 'agreement.docx'), true);
    assert.equal(isSigningOfficeUpload(SIGNING_PDF_MIME, 'contract.pdf'), false);
    assert.equal(isSigningOfficeUpload(SIGNING_DOCX_MIME, 'legacy.doc'), false);
  });
});
