import { createHash } from 'node:crypto';
import { IANAZone } from 'luxon';

export interface Config {
  nodeEnv: string;
  port: number;
  databaseUrl: string | undefined;
  /** Directory for the embedded PGlite database (used only when databaseUrl is unset). */
  pgliteDataDir: string | undefined;
  jwtSecret: string;
  publicBaseUrl: string;
  forceHttps: boolean;
  trustProxy: number;
  defaultTimezone: string;
  checkinOpensBeforeMinutes: number;
  checkinClosesAfterMinutes: number;
  reopenExtensionMinutes: number;
  autoCloseSessions: boolean;
  schedulerIntervalSeconds: number;
  sessionTtlHours: number;
  /** Disable rate limiting (tests only). */
  rateLimitEnabled: boolean;
  /** SMTP connection URL for pass/verification emails, e.g. smtps://user:pass@smtp.example.org:465 */
  smtpUrl: string | undefined;
  mailFrom: string;
  /** 32-byte key used to encrypt event pass tokens at rest (so passes can be reprinted). */
  credentialKey: Buffer;
  /** Run the email delivery worker in the background (disabled in tests). */
  runJobsInBackground: boolean;
  /** Maximum participant import file size, in bytes. */
  importMaxBytes: number;
  /** Demo mode: exposes the demo guide, sample passes and an email outbox. Never in production. */
  demoMode: boolean;
}

function int(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) throw new Error(`Expected an integer, got "${value}"`);
  return n;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const nodeEnv = env.NODE_ENV ?? 'development';
  const production = nodeEnv === 'production';
  // Render sets RENDER=true and RENDER_EXTERNAL_URL (https://<service>.onrender.com).
  const onRender = Boolean(env.RENDER);

  const config: Config = {
    nodeEnv,
    port: int(env.PORT, 3000),
    databaseUrl: env.DATABASE_URL || undefined,
    pgliteDataDir: env.DATABASE_URL ? undefined : (env.PGLITE_DATA_DIR ?? '.data/pglite'),
    jwtSecret: env.JWT_SECRET ?? (production ? '' : 'dev-only-insecure-secret-change-me-please!'),
    publicBaseUrl: (env.PUBLIC_BASE_URL || env.RENDER_EXTERNAL_URL || 'http://localhost:5173').replace(/\/+$/, ''),
    forceHttps: bool(env.FORCE_HTTPS, false),
    trustProxy: int(env.TRUST_PROXY, onRender ? 1 : 0),
    defaultTimezone: env.DEFAULT_TIMEZONE ?? 'Asia/Singapore',
    checkinOpensBeforeMinutes: int(env.CHECKIN_OPENS_BEFORE_MINUTES, 15),
    checkinClosesAfterMinutes: int(env.CHECKIN_CLOSES_AFTER_MINUTES, 60),
    reopenExtensionMinutes: int(env.REOPEN_EXTENSION_MINUTES, 60),
    autoCloseSessions: bool(env.AUTO_CLOSE_SESSIONS, true),
    schedulerIntervalSeconds: int(env.SCHEDULER_INTERVAL_SECONDS, 30),
    sessionTtlHours: int(env.SESSION_TTL_HOURS, 720),
    rateLimitEnabled: true,
    smtpUrl: env.SMTP_URL || undefined,
    mailFrom: env.MAIL_FROM ?? 'Event Access <no-reply@localhost>',
    credentialKey: Buffer.alloc(0),
    runJobsInBackground: true,
    importMaxBytes: int(env.IMPORT_MAX_BYTES, 5 * 1024 * 1024),
    demoMode: bool(env.DEMO_MODE, false),
  };
  // A public demo deployment must opt in explicitly: demo mode publishes demo
  // passwords and pass links on the /demo page.
  const publicDemo = config.demoMode && production;
  if (publicDemo && !bool(env.ALLOW_DEMO_IN_PRODUCTION, false)) {
    throw new Error('DEMO_MODE exposes demo credentials and passes; set ALLOW_DEMO_IN_PRODUCTION=true only for a demo-only deployment');
  }

  if (env.CREDENTIAL_ENCRYPTION_KEY) {
    const raw = env.CREDENTIAL_ENCRYPTION_KEY;
    const decoded = Buffer.from(raw, 'base64');
    if (decoded.length === 32) config.credentialKey = decoded;
    // Accept any long random secret (e.g. a platform-generated value) by hashing it to 32 bytes.
    else if (raw.length >= 32) config.credentialKey = createHash('sha256').update(raw).digest();
    else throw new Error('CREDENTIAL_ENCRYPTION_KEY must be 32 bytes base64-encoded, or a random string of at least 32 characters');
  } else if (production) {
    throw new Error('CREDENTIAL_ENCRYPTION_KEY is required in production');
  } else {
    config.credentialKey = createHash('sha256').update(`${config.jwtSecret}:credential-key`).digest();
  }

  if (production) {
    // A demo-only deployment may use the embedded database (data resets on every restart).
    if (!config.databaseUrl && !publicDemo) throw new Error('DATABASE_URL is required in production');
    if (config.jwtSecret.length < 32) throw new Error('JWT_SECRET must be at least 32 characters in production');
    if (!config.publicBaseUrl.startsWith('https://')) {
      throw new Error('PUBLIC_BASE_URL must be an https:// URL in production');
    }
  }
  if (!IANAZone.isValidZone(config.defaultTimezone)) {
    throw new Error(`DEFAULT_TIMEZONE "${config.defaultTimezone}" is not a valid IANA time zone`);
  }
  return config;
}
