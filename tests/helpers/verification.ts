import type { VerificationMailer } from "../../apps/api/src/email";

/** In-memory test double. Never opens a network connection or sends email. */
export class MockVerificationMailer implements VerificationMailer {
  messages: { email: string; token: string }[] = [];
  failure = false;
  configured = true;
  assertConfigured() {
    if (!this.configured) throw new Error("Test email configuration missing");
  }
  async sendVerification(email: string, token: string) {
    if (this.failure) throw new Error("Simulated SMTP rejection");
    this.messages.push({ email, token });
  }
}
