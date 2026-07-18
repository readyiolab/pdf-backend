import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import forge from 'node-forge';
import { env } from '../config/env';
import { logger } from './logger';

/**
 * Provides the PKCS#12 (P12) signing certificate used to digitally sign
 * finished documents.
 *
 * Resolution order:
 *   1. SIGNING_P12_BASE64 from the environment (production). This is where a
 *      real, CA-issued certificate goes — swapping it for an AATL-chained cert
 *      is the ONLY change needed to turn the reader's "valid but untrusted"
 *      warning into a green check. No code change.
 *   2. A self-signed cert cached at SIGNING_CERT_PATH, generated once on first
 *      use and reused thereafter.
 *
 * Why persist rather than regenerate each boot: a signature is only verifiable
 * against the certificate that produced it. Regenerating per restart would
 * leave every previously-signed document referencing a key we no longer hold.
 */

interface SigningCert {
  p12: Buffer;
  passphrase: string;
  /** True when this is the throwaway self-signed dev cert, not a real one. */
  selfSigned: boolean;
  /** Human-readable subject, for logging and the certificate page. */
  subject: string;
}

let cached: SigningCert | null = null;

export function getSigningCert(): SigningCert {
  if (cached) return cached;

  if (env.SIGNING_P12_BASE64) {
    cached = {
      p12: Buffer.from(env.SIGNING_P12_BASE64, 'base64'),
      passphrase: env.SIGNING_P12_PASSPHRASE,
      selfSigned: false,
      subject: 'Configured certificate',
    };
    logger.info('Loaded signing certificate from SIGNING_P12_BASE64');
    return cached;
  }

  const certPath = path.resolve(env.SIGNING_CERT_PATH);
  if (fs.existsSync(certPath)) {
    cached = {
      p12: fs.readFileSync(certPath),
      // The generated dev cert uses a fixed, non-secret passphrase — it protects
      // nothing an attacker with filesystem access couldn't already read.
      passphrase: env.SIGNING_P12_PASSPHRASE || 'pdfproduct',
      selfSigned: true,
      subject: 'PDFProduct (self-signed)',
    };
    logger.info({ certPath }, 'Loaded cached self-signed signing certificate');
    return cached;
  }

  cached = generateSelfSigned(certPath);
  return cached;
}

/**
 * Generates a self-signed P12 and writes it to disk.
 *
 * The certificate is marked for digitalSignature + nonRepudiation key usage —
 * the two bits a PDF reader checks before it will treat a signature as a
 * document signature rather than, say, a TLS cert.
 */
function generateSelfSigned(certPath: string): SigningCert {
  logger.warn('No signing certificate configured — generating a SELF-SIGNED cert. Fine for development; use a real CA-issued cert in production (SIGNING_P12_BASE64).');

  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  // Random positive serial. A leading '00' would make it negative in DER.
  cert.serialNumber = '00' + crypto.randomBytes(8).toString('hex');
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 10);

  const attrs = [
    { name: 'commonName', value: 'PDFProduct Document Signing' },
    { name: 'organizationName', value: 'PDFProduct' },
    { name: 'countryName', value: 'IN' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs); // self-signed: subject == issuer
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, nonRepudiation: true },
  ]);

  cert.sign(keys.privateKey, forge.md.sha256.create());

  const passphrase = env.SIGNING_P12_PASSPHRASE || 'pdfproduct';
  const p12Asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], passphrase, {
    algorithm: '3des',
  });
  const p12Der = forge.asn1.toDer(p12Asn1).getBytes();
  const p12 = Buffer.from(p12Der, 'binary');

  try {
    fs.writeFileSync(certPath, p12, { mode: 0o600 });
    logger.info({ certPath }, 'Wrote self-signed signing certificate');
  } catch (err) {
    // Non-fatal: we can still sign this run from the in-memory cert; it just
    // won't persist. Next boot regenerates.
    logger.warn({ err, certPath }, 'Could not persist signing certificate; using in-memory cert for this run');
  }

  return { p12, passphrase, selfSigned: true, subject: 'PDFProduct (self-signed)' };
}
