import type { Clock } from './clock.js';
import type { Config } from './config.js';
import type { Database } from './db.js';
import type { Mailer } from './mailer.js';

/** Dependencies shared by routes and services. */
export interface AppContext {
  db: Database;
  config: Config;
  clock: Clock;
  mailer: Mailer;
}
