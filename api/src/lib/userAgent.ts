import type { Request } from 'express';

export interface RequestContext {
  ipAddress: string | null;
  userAgent: string | null;
  browser: string | null;
  os: string | null;
  device: string | null;
  location: string | null;
}

/**
 * Minimal user-agent parsing for the audit trail.
 *
 * Deliberately dependency-free: this feeds a human-readable audit log, not
 * feature detection or security decisions, so "Chrome 120 / Windows / Desktop"
 * is enough and a full ua-parser database is not worth the weight. Unknown
 * agents degrade to null rather than a wrong guess — order matters below,
 * since several browsers impersonate each other in the UA string.
 */
function parseBrowser(ua: string): string | null {
  // Edge and Opera both include "Chrome"; Chrome includes "Safari". Test the
  // most specific claims first.
  const checks: [RegExp, string][] = [
    [/Edg(?:e|A|iOS)?\/([\d.]+)/, 'Edge'],
    [/OPR\/([\d.]+)/, 'Opera'],
    [/SamsungBrowser\/([\d.]+)/, 'Samsung Internet'],
    [/Firefox\/([\d.]+)/, 'Firefox'],
    [/Chrome\/([\d.]+)/, 'Chrome'],
    [/Version\/([\d.]+).*Safari/, 'Safari'],
  ];
  for (const [re, name] of checks) {
    const m = ua.match(re);
    if (m) return `${name} ${m[1].split('.')[0]}`;
  }
  return null;
}

function parseOs(ua: string): string | null {
  if (/Windows NT 10/.test(ua)) return 'Windows 10/11';
  if (/Windows NT ([\d.]+)/.test(ua)) return 'Windows';
  if (/iPhone OS ([\d_]+)/.test(ua)) {
    return `iOS ${ua.match(/iPhone OS ([\d_]+)/)![1].replace(/_/g, '.')}`;
  }
  if (/iPad.*OS ([\d_]+)/.test(ua)) {
    return `iPadOS ${ua.match(/OS ([\d_]+)/)![1].replace(/_/g, '.')}`;
  }
  if (/Mac OS X ([\d_.]+)/.test(ua)) {
    return `macOS ${ua.match(/Mac OS X ([\d_.]+)/)![1].replace(/_/g, '.')}`;
  }
  if (/Android ([\d.]+)/.test(ua)) return `Android ${ua.match(/Android ([\d.]+)/)![1]}`;
  if (/Linux/.test(ua)) return 'Linux';
  return null;
}

function parseDevice(ua: string): string | null {
  if (/iPad|Tablet/i.test(ua)) return 'Tablet';
  // Android phones say "Mobile"; Android tablets omit it.
  if (/Mobi|iPhone|Android.*Mobile/i.test(ua)) return 'Mobile';
  if (/Android/i.test(ua)) return 'Tablet';
  if (/Windows|Macintosh|Linux|CrOS/i.test(ua)) return 'Desktop';
  return null;
}

/**
 * Extracts audit context from a request. `app.set('trust proxy', 1)` is
 * configured in index.ts, so req.ip already resolves to the real client IP
 * behind the reverse proxy rather than the proxy's own address.
 *
 * `location` is populated from a geo header if the CDN/proxy supplies one
 * (Cloudflare's CF-IPCountry, DO's equivalent). We never call out to a
 * third-party geo-IP service on the request path — that would add latency and
 * leak recipient IPs to a vendor. Null when unavailable, as the spec allows.
 */
export function getRequestContext(req: Request): RequestContext {
  const ua = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null;
  const country =
    (req.headers['cf-ipcountry'] as string | undefined) ||
    (req.headers['x-vercel-ip-country'] as string | undefined) ||
    null;
  const city = (req.headers['cf-ipcity'] as string | undefined) || null;

  return {
    ipAddress: req.ip ?? null,
    // The column is VARCHAR(512); truncate rather than let a long UA fail the insert.
    userAgent: ua ? ua.slice(0, 512) : null,
    browser: ua ? parseBrowser(ua) : null,
    os: ua ? parseOs(ua) : null,
    device: ua ? parseDevice(ua) : null,
    location: city && country ? `${city}, ${country}` : country,
  };
}
