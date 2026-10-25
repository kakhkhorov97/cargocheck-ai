import { randomBytes, createHash } from "node:crypto";
import { HttpException } from "@nestjs/common";
import { z } from "zod";
import { Store } from "./store";
import type { VerificationMailer } from "./email";

export const normalizeEmail = (email: string) => email.trim().toLowerCase();
export const emailInput = z
  .string()
  .trim()
  .pipe(z.email().max(254))
  .transform(normalizeEmail);
const tokenInput = z.object({ token: z.string().regex(/^[a-f0-9]{64}$/) });
const digest = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export const RESEND_MESSAGE =
  "Request processed. If this email belongs to an unverified account and its cooldown has ended, delivery was attempted. This response does not confirm delivery. If no email arrives, wait 60 seconds and retry or contact support.";

export class EmailVerificationService {
  constructor(
    private db: Store,
    private mailer: VerificationMailer,
  ) {}
  async issue(email: string) {
    this.mailer.assertConfigured();
    const token = randomBytes(32).toString("hex");
    const hash = digest(token);
    const target = await this.db.transaction((s) => {
      const user = s.users.find((u) => normalizeEmail(u.email) === email);
      const time = Date.now();
      if (!user || user.emailVerifiedAt) return null;
      const remaining = 60000 - (time - (user.verificationRequestedAt ?? 0));
      if (remaining > 0) return { cooldown: Math.ceil(remaining / 1000) };
      user.verificationRequestedAt = time;
      // Keep status hashes for one day to distinguish used/expired links, then prune.
      s.emailVerifications = (s.emailVerifications ?? []).filter(
        (t) => t.expiresAt > time - 86400000,
      );
      for (const old of s.emailVerifications)
        if (old.userId === user.id && !old.usedAt) old.invalidatedAt = time;
      s.emailVerifications.push({
        hash,
        userId: user.id,
        expiresAt: time + 30 * 60000,
        accepted: false,
      });
      return { email: user.email };
    });
    if (!target) return { status: "ineligible" as const, retryAfter: 60 };
    if ("cooldown" in target)
      return { status: "cooldown" as const, retryAfter: target.cooldown! };
    try {
      await this.mailer.sendVerification(target.email, token);
    } catch {
      await this.db.transaction((s) => {
        const record = s.emailVerifications?.find((t) => t.hash === hash);
        if (record) record.invalidatedAt = Date.now();
      });
      throw new HttpException(
        {
          code: "EMAIL_DELIVERY_FAILED",
          message:
            "The email service did not confirm acceptance of your verification email. Your account is still unverified. Wait 60 seconds and request another link.",
        },
        503,
      );
    }
    await this.db.transaction((s) => {
      const record = s.emailVerifications?.find((t) => t.hash === hash);
      if (record && !record.invalidatedAt) record.accepted = true;
    });
    return { status: "accepted" as const, retryAfter: 60 };
  }
  async resend(body: unknown) {
    const { email } = z.object({ email: emailInput }).parse(body);
    // Configuration errors apply equally to every address, including unknown ones.
    this.mailer.assertConfigured();
    try {
      await this.issue(email);
    } catch (error) {
      // Public responses must not reveal account existence, even on SMTP failure.
      // Do not claim that delivery succeeded. Registration reports failures directly.
      if (!(error instanceof HttpException) || error.getStatus() !== 503)
        throw error;
    }
    return {
      message: RESEND_MESSAGE,
      retryAfter: 60,
      deliveryConfirmed: false,
    };
  }
  async verify(body: unknown) {
    const { token } = tokenInput.parse(body);
    // Store serializes local writes and uses SELECT ... FOR UPDATE in PostgreSQL.
    return this.db.transaction((s) => {
      const record = s.emailVerifications?.find(
        (t) => t.hash === digest(token),
      );
      if (!record) return { status: "invalid" as const };
      if (record.usedAt) return { status: "already_used" as const };
      if (record.invalidatedAt || !record.accepted)
        return { status: "invalid" as const };
      if (record.expiresAt <= Date.now()) return { status: "expired" as const };
      const user = s.users.find((u) => u.id === record.userId);
      if (!user) return { status: "invalid" as const };
      record.usedAt = Date.now();
      user.emailVerifiedAt = new Date().toISOString();
      // Verification never restores an old session or creates a new one.
      s.sessions = s.sessions.filter((session) => session.userId !== user.id);
      for (const other of s.emailVerifications ?? [])
        if (
          other.userId === user.id &&
          other.hash !== record.hash &&
          !other.usedAt
        )
          other.invalidatedAt = Date.now();
      return { status: "success" as const };
    });
  }
}
