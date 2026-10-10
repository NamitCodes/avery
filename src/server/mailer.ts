import nodemailer from 'nodemailer';
import type { Config } from './config.js';

export interface MailAttachment {
  filename: string;
  content: Buffer;
  contentType?: string;
  /** Content-ID for inline images (<img src="cid:...">). */
  cid?: string;
}

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  attachments?: MailAttachment[];
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

/**
 * SMTP when SMTP_URL is set; otherwise (development) messages are only logged
 * — recipient and subject, never the body, which may contain a pass credential.
 */
export function createMailer(config: Config): Mailer {
  if (config.smtpUrl) {
    const transport = nodemailer.createTransport(config.smtpUrl);
    return {
      async send(m) {
        await transport.sendMail({ from: config.mailFrom, ...m });
      },
    };
  }
  if (config.demoMode) return demoOutbox;
  if (config.nodeEnv === 'production') {
    console.warn('SMTP_URL is not set: event emails will NOT be delivered.');
    return {
      async send() {
        throw new Error('Email is not configured (SMTP_URL missing)');
      },
    };
  }
  return {
    async send(m) {
      console.log(`[mail:dev] to=${m.to} subject="${m.subject}" (not sent; set SMTP_URL to deliver)`);
    },
  };
}

export interface OutboxMessage {
  to: string;
  subject: string;
  text: string;
  sent_at: string;
}

/** Demo mode without SMTP: keeps the latest messages in memory so the demo guide can show them. */
class DemoOutbox implements Mailer {
  messages: OutboxMessage[] = [];
  async send(m: MailMessage) {
    console.log(`[mail:demo] to=${m.to} subject="${m.subject}" (kept in demo outbox)`);
    this.messages.unshift({ to: m.to, subject: m.subject, text: m.text, sent_at: new Date().toISOString() });
    this.messages.length = Math.min(this.messages.length, 50);
  }
}
export const demoOutbox = new DemoOutbox();

/** Captures messages in memory. Used by tests. */
export class MemoryMailer implements Mailer {
  sent: MailMessage[] = [];
  failWith: string | null = null;
  async send(m: MailMessage) {
    if (this.failWith) throw new Error(this.failWith);
    this.sent.push(m);
  }
}
