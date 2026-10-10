import { fileURLToPath } from 'node:url';

/**
 * `--demo` on the command line turns on demo mode with its own embedded
 * database (.data/demo), so demo data never mixes with development data.
 * Explicit environment variables still win.
 */
export function applyDemoFlag(argv = process.argv) {
  if (!argv.includes('--demo')) return;
  process.env.DEMO_MODE ??= 'true';
  if (!process.env.DATABASE_URL) process.env.PGLITE_DATA_DIR ??= '.data/demo';
  // Built server serves the SPA itself; in dev, Vite serves it on :5173.
  const compiled = /[\\/]dist[\\/]server[\\/]/.test(fileURLToPath(import.meta.url));
  process.env.PUBLIC_BASE_URL ??= compiled ? `http://localhost:${process.env.PORT ?? 3000}` : 'http://localhost:5173';
}
