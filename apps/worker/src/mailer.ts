import nodemailer from 'nodemailer';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(msg: MailMessage): Promise<void>;
  verify(): Promise<void>;
}

/** SMTP mailer (Mailpit locally; any SMTP relay or SES in production). */
export function createSmtpMailer(url: string, from: string): Mailer {
  const transport = nodemailer.createTransport(url, { from });
  return {
    async send(msg) {
      await transport.sendMail({ from, ...msg });
    },
    async verify() {
      await transport.verify();
    },
  };
}

/** Captures mail in memory for tests. */
export class MemoryMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  async send(msg: MailMessage) {
    this.sent.push(msg);
  }
  async verify() {}
}
