import cookieParser from 'cookie-parser';
import express, { type Request, type Response, type NextFunction } from 'express';
import helmet from 'helmet';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { csrfGuard, loadUser, requireAdmin } from './auth.js';
import type { AppContext } from './context.js';
import { AppError, errorHandler } from './errors.js';
import { createRateLimiters } from './rateLimit.js';
import { adminEventRoutes } from './routes/adminEvents.js';
import { adminLocationRoutes } from './routes/adminLocations.js';
import { adminPeopleRoutes } from './routes/adminPeople.js';
import { adminReportRoutes } from './routes/adminReports.js';
import { adminSessionRoutes } from './routes/adminSessions.js';
import { authRoutes } from './routes/auth.js';
import { checkinRoutes } from './routes/checkin.js';
import { demoRoutes } from './routes/demo.js';
import { eventAccessRoutes } from './routes/eventAccess.js';
import { publicEventRoutes } from './routes/publicEvents.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIST = path.resolve(here, '../../dist/web');

export function createApp(ctx: AppContext) {
  const app = express();
  app.disable('x-powered-by');
  if (ctx.config.trustProxy > 0) app.set('trust proxy', ctx.config.trustProxy);

  if (ctx.config.forceHttps) {
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.secure) return next();
      res.redirect(308, `https://${req.get('host')}${req.originalUrl}`);
    });
  }

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          imgSrc: ["'self'", 'data:'],
          // Frappe UI's theme loads the Inter font stylesheet from Google Fonts.
          styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
          fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
          // Local HTTP development must not be upgraded to HTTPS.
          upgradeInsecureRequests: ctx.config.nodeEnv === 'production' ? [] : null,
        },
      },
      hsts: ctx.config.nodeEnv === 'production',
    }),
  );

  const limiters = createRateLimiters(ctx.config);
  const api = express.Router();
  // Participant imports are sent as base64 JSON; everything else is small.
  api.use('/admin/events', express.json({ limit: '12mb' }));
  api.use(express.json({ limit: '100kb' }));
  api.use(cookieParser());
  api.use(loadUser(ctx));
  api.use(limiters.api);
  api.use(csrfGuard);
  api.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  api.get('/health', async (_req, res) => {
    await ctx.db.query('SELECT 1');
    res.json({ ok: true, time: ctx.clock.now() });
  });
  api.use(authRoutes(ctx, limiters.login));
  api.use(checkinRoutes(ctx, limiters.checkin));
  api.use(publicEventRoutes(ctx, limiters.publicApi));
  // Event-access routes carry their own per-route role checks (event managers,
  // desk staff, gate operators), so they are mounted before the ADMIN-only router.
  api.use(eventAccessRoutes(ctx, limiters.scan));
  api.use('/admin', adminEventRoutes(ctx));

  const admin = express.Router();
  admin.use(requireAdmin);
  admin.use(adminLocationRoutes(ctx));
  admin.use(adminSessionRoutes(ctx));
  admin.use(adminPeopleRoutes(ctx));
  admin.use(adminReportRoutes(ctx));
  api.use('/admin', admin);
  if (ctx.config.demoMode) api.use(demoRoutes(ctx));

  api.use((_req, _res, next) => next(new AppError(404, 'NOT_FOUND', 'Not found.')));
  api.use(errorHandler);
  app.use('/api', api);

  // Serve the built SPA (production). In development Vite serves the frontend.
  if (fs.existsSync(path.join(WEB_DIST, 'index.html'))) {
    app.use(express.static(WEB_DIST, { index: false, maxAge: '1h' }));
    app.get('/{*splat}', (_req, res) => {
      res.set('Cache-Control', 'no-cache');
      res.sendFile(path.join(WEB_DIST, 'index.html'));
    });
  }

  return app;
}
