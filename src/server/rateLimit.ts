import rateLimit from 'express-rate-limit';
import type { RequestHandler } from 'express';
import type { Config } from './config.js';

const passThrough: RequestHandler = (_req, _res, next) => next();

function limiter(
  config: Config,
  opts: { windowMinutes: number; limit: number; failedOnly: boolean; message: string; byIpOnly?: boolean },
) {
  if (!config.rateLimitEnabled) return passThrough;
  return rateLimit({
    windowMs: opts.windowMinutes * 60_000,
    limit: opts.limit,
    skipSuccessfulRequests: opts.failedOnly,
    // Gate scans answer 200 even when rejected; count those as failures.
    requestWasSuccessful: (_req, res) => res.statusCode < 400 && !res.locals.scanRejected,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    // Key by account when signed in so volunteers sharing venue Wi-Fi don't throttle each other.
    keyGenerator: (req) => (req.user && !opts.byIpOnly ? `u:${req.user.id}` : `ip:${req.ip}`),
    handler: (_req, res) => {
      res.status(429).json({ error: { code: 'RATE_LIMITED', message: opts.message } });
    },
  });
}

export function createRateLimiters(config: Config) {
  return {
    /** Failed sign-in attempts. */
    login: limiter(config, {
      windowMinutes: 15,
      limit: 10,
      failedOnly: true,
      message: 'Too many failed sign-in attempts. Please wait a few minutes and try again.',
    }),
    /** Failed venue lookups / check-ins (e.g. guessing venue identifiers). */
    checkin: limiter(config, {
      windowMinutes: 10,
      limit: 30,
      failedOnly: true,
      message: 'Too many unsuccessful attempts. Please wait a few minutes or ask an organiser for help.',
    }),
    /** Rejected gate scans (invalid/unknown passes) per operator. */
    scan: limiter(config, {
      windowMinutes: 5,
      limit: 120,
      failedOnly: true,
      message: 'Too many rejected scans from this station. Pause and contact your supervisor.',
    }),
    /** Unauthenticated registration, verification and pass endpoints. */
    publicApi: limiter(config, {
      windowMinutes: 10,
      limit: 60,
      failedOnly: false,
      byIpOnly: true,
      message: 'Too many requests. Please wait a few minutes and try again.',
    }),
    /** Coarse ceiling for all API traffic. */
    api: limiter(config, {
      windowMinutes: 1,
      limit: 600,
      failedOnly: false,
      message: 'Too many requests. Please slow down.',
    }),
  };
}
