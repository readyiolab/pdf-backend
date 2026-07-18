import crypto from 'crypto';
import forge from 'node-forge';
import { env } from '../../config/env';
import { logger } from '../../lib/logger';

const SHA256_OID = '2.16.840.1.101.3.4.2.1';

export interface TimestampResult {
  /** The raw RFC 3161 TimeStampResp (DER). Stored as a .tsr; openssl-verifiable. */
  token: Buffer;
  /** The time the TSA asserts, parsed from the token for display. */
  timestamp: Date;
  tsaUrl: string;
}

/**
 * Requests an RFC 3161 trusted timestamp over `data` from the configured TSA.
 *
 * This is what turns "we recorded 09:16 in our database" into "an independent
 * authority cryptographically attests that this exact document existed at
 * 09:16" — a time we cannot forge or backdate, because the token is signed by
 * the TSA's certificate, not ours.
 *
 * Best-effort by design: returns null (never throws) on any failure. A TSA
 * outage must not block a document everyone has already signed; the signature
 * and the recorded completedAt still stand, we simply lack the extra
 * third-party attestation. The caller decides what to do with null.
 */
export async function requestTimestamp(data: Buffer): Promise<TimestampResult | null> {
  if (!env.TSA_ENABLED) return null;

  try {
    const messageHash = crypto.createHash('sha256').update(data).digest();
    const requestDer = buildTimeStampReq(messageHash);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const res = await fetch(env.TSA_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/timestamp-query',
        Accept: 'application/timestamp-reply',
      },
      // Buffer → Uint8Array: undici's fetch types accept a BufferSource, not a
      // Node Buffer directly.
      body: new Uint8Array(requestDer),
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));

    if (!res.ok) {
      logger.warn({ status: res.status, tsa: env.TSA_URL }, 'TSA request failed');
      return null;
    }

    const token = Buffer.from(await res.arrayBuffer());
    const timestamp = extractGenTime(token);

    logger.info({ tsa: env.TSA_URL, timestamp }, 'Obtained trusted timestamp');
    return { token, timestamp: timestamp ?? new Date(), tsaUrl: env.TSA_URL };
  } catch (err) {
    logger.warn({ err, tsa: env.TSA_URL }, 'Could not obtain trusted timestamp (continuing without one)');
    return null;
  }
}

/**
 * Builds an RFC 3161 TimeStampReq (DER) by hand.
 *
 *   TimeStampReq ::= SEQUENCE {
 *     version        INTEGER { v1(1) },
 *     messageImprint SEQUENCE { hashAlgorithm AlgorithmIdentifier, hashedMessage OCTET STRING },
 *     nonce          INTEGER OPTIONAL,
 *     certReq        BOOLEAN DEFAULT FALSE }
 *
 * certReq is TRUE so the response embeds the TSA's certificate, which
 * verification needs. The nonce ties this specific response to this request,
 * defeating replay of a captured token.
 */
function buildTimeStampReq(messageHash: Buffer): Buffer {
  const { asn1 } = forge;
  const bin = (buf: Buffer) => buf.toString('binary');

  const req = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
    // version = 1
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.INTEGER, false, asn1.integerToDer(1).getBytes()),
    // messageImprint
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
      asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
        asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false, asn1.oidToDer(SHA256_OID).getBytes()),
        asn1.create(asn1.Class.UNIVERSAL, asn1.Type.NULL, false, ''),
      ]),
      asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false, bin(messageHash)),
    ]),
    // nonce
    asn1.create(
      asn1.Class.UNIVERSAL,
      asn1.Type.INTEGER,
      false,
      bin(Buffer.concat([Buffer.from([0x00]), crypto.randomBytes(8)]))
    ),
    // certReq = TRUE
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.BOOLEAN, false, String.fromCharCode(0xff)),
  ]);

  return Buffer.from(asn1.toDer(req).getBytes(), 'binary');
}

/**
 * Pulls the TSA's asserted genTime out of the response, for display only.
 *
 * Deliberately forgiving: this is a best-effort read of a nested structure for
 * a human-readable timestamp. If the parse fails we fall back to "now" — the
 * authoritative, verifiable time lives in the stored token regardless of
 * whether we managed to pretty-print it here.
 */
function extractGenTime(responseDer: Buffer): Date | null {
  try {
    // A GeneralizedTime for a TSA genTime looks like 20260718091632Z. Scanning
    // for it is far more robust across TSA quirks than walking the full ASN.1.
    const text = responseDer.toString('latin1');
    const match = text.match(/(\d{14})Z/);
    if (!match) return null;
    const s = match[1];
    return new Date(
      Date.UTC(
        Number(s.slice(0, 4)),
        Number(s.slice(4, 6)) - 1,
        Number(s.slice(6, 8)),
        Number(s.slice(8, 10)),
        Number(s.slice(10, 12)),
        Number(s.slice(12, 14))
      )
    );
  } catch {
    return null;
  }
}
