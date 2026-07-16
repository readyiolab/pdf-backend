import { Request, Response, NextFunction, RequestHandler } from 'express';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import crypto from 'crypto';
import { env } from '../config/env';
import { heavyQueue, lightQueue, maintenanceQueue, deadQueue } from './queue';

const BASE_PATH = '/admin/queues';

/**
 * Gates the dashboard with HTTP Basic Auth against ADMIN_TOKEN. Basic Auth is
 * used (rather than a header/query token) because the dashboard is a browser UI —
 * the browser natively prompts for credentials. Any username is accepted; the
 * password must equal ADMIN_TOKEN. Comparison is constant-time.
 */
function adminBasicAuth(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization || '';
    const [scheme, encoded] = header.split(' ');

    if (scheme === 'Basic' && encoded) {
      const decoded = Buffer.from(encoded, 'base64').toString('utf8');
      const password = decoded.slice(decoded.indexOf(':') + 1);
      const a = Buffer.from(password);
      const b = Buffer.from(env.ADMIN_TOKEN as string);
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
        return next();
      }
    }

    res.setHeader('WWW-Authenticate', 'Basic realm="Queue Dashboard"');
    res.status(401).send('Authentication required');
  };
}

/**
 * Returns the mount path, auth middleware, and router for the queue dashboard,
 * or null when ADMIN_TOKEN is not configured (dashboard disabled).
 */
export function createDashboard() {
  if (!env.ADMIN_TOKEN) return null;

  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath(BASE_PATH);

  createBullBoard({
    queues: [
      new BullMQAdapter(heavyQueue),
      new BullMQAdapter(lightQueue),
      new BullMQAdapter(maintenanceQueue),
      new BullMQAdapter(deadQueue),
    ],
    serverAdapter,
  });

  return {
    basePath: BASE_PATH,
    auth: adminBasicAuth(),
    router: serverAdapter.getRouter(),
  };
}
