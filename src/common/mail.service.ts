import { Global, Injectable, Logger, Module } from '@nestjs/common';

/** Transactional email. */
@Injectable()
export class MailService {
  private readonly log = new Logger('Mail');

  // ponytail: logs instead of sending; swap the body for Resend/SendGrid when a provider is contracted
  send(to: string, subject: string, body: string) {
    this.log.log(`to=${to} subject="${subject}"\n${body}`);
    return Promise.resolve();
  }
}

@Global()
@Module({ providers: [MailService], exports: [MailService] })
export class MailModule {}
