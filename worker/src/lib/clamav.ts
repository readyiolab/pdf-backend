import net from 'net';
import fs from 'fs';
import { env } from '../config/env';
import { logger } from './logger';

export interface ScanResult {
  clean: boolean;
  skipped: boolean;
  signature?: string;
}

/**
 * Streams a file to a clamd daemon using the INSTREAM protocol and reports
 * whether it is clean. Implemented with a raw TCP socket so no extra dependency
 * is required. When CLAMAV_ENABLED is false this is a no-op (skipped: true),
 * so it adds zero overhead unless a daemon is actually configured.
 */
export function scanFile(filePath: string): Promise<ScanResult> {
  if (!env.CLAMAV_ENABLED) {
    return Promise.resolve({ clean: true, skipped: true });
  }

  return new Promise((resolve, reject) => {
    const socket = net.createConnection(env.CLAMAV_PORT, env.CLAMAV_HOST);
    let response = '';
    let settled = false;

    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      fn();
    };

    socket.setTimeout(30000);
    socket.on('timeout', () => done(() => reject(new Error('ClamAV scan timed out'))));
    socket.on('error', (err) => done(() => reject(err)));
    socket.on('data', (chunk) => {
      response += chunk.toString('utf8');
    });
    socket.on('end', () => {
      done(() => {
        const text = response.trim();
        if (text.includes('FOUND')) {
          const signature = text.replace(/^stream:\s*/, '').replace(/\s*FOUND$/, '');
          resolve({ clean: false, skipped: false, signature });
        } else if (text.includes('OK')) {
          resolve({ clean: true, skipped: false });
        } else {
          reject(new Error(`Unexpected ClamAV response: ${text}`));
        }
      });
    });

    socket.on('connect', () => {
      socket.write('zINSTREAM\0');
      const fileStream = fs.createReadStream(filePath, { highWaterMark: 64 * 1024 });

      fileStream.on('data', (data: string | Buffer) => {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        const size = Buffer.alloc(4);
        size.writeUInt32BE(buf.length, 0);
        socket.write(size);
        socket.write(buf);
      });
      fileStream.on('end', () => {
        // Zero-length chunk signals end of stream to clamd.
        const terminator = Buffer.alloc(4);
        terminator.writeUInt32BE(0, 0);
        socket.write(terminator);
      });
      fileStream.on('error', (err) => done(() => reject(err)));
    });
  }).catch((err) => {
    logger.error({ err: (err as Error).message }, 'ClamAV scan failed');
    throw err;
  }) as Promise<ScanResult>;
}
