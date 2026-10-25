import nodemailer from "nodemailer";
import { HttpException } from "@nestjs/common";
import { z } from "zod";

export interface VerificationMailer {
  assertConfigured(): void;
  sendVerification(email: string, token: string): Promise<void>;
}

export class SmtpVerificationMailer implements VerificationMailer {
  private config() {
    try {
      const origin = new URL(process.env.APP_ORIGIN ?? "");
      if (
        origin.origin !== process.env.APP_ORIGIN ||
        origin.username ||
        origin.password ||
        (origin.protocol !== "https:" &&
          !(
            process.env.NODE_ENV !== "production" &&
            origin.protocol === "http:" &&
            ["localhost", "127.0.0.1"].includes(origin.hostname)
          ))
      )
        throw new Error();
      const host = z.string().trim().min(1).parse(process.env.SMTP_HOST);
      const port = z.coerce
        .number()
        .int()
        .min(1)
        .max(65535)
        .parse(process.env.SMTP_PORT);
      const secure = z.enum(["true", "false"]).parse(process.env.SMTP_SECURE);
      const user = z.string().min(1).parse(process.env.SMTP_USER);
      const pass = z.string().min(1).parse(process.env.SMTP_PASSWORD);
      const from = z.email().parse(process.env.SMTP_FROM);
      return {
        origin: origin.origin,
        host,
        port,
        secure: secure === "true",
        user,
        pass,
        from,
      };
    } catch {
      throw new HttpException(
        {
          code: "EMAIL_CONFIGURATION_ERROR",
          message:
            "Email verification is unavailable. Configure APP_ORIGIN and SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASSWORD, SMTP_FROM on the server.",
        },
        503,
      );
    }
  }
  assertConfigured() {
    this.config();
  }
  async sendVerification(email: string, token: string) {
    const c = this.config();
    // The fragment keeps tokens out of HTTP access logs and Referer headers.
    const link = `${c.origin}/?verify-email#token=${token}`;
    const transport = nodemailer.createTransport({
      host: c.host,
      port: c.port,
      secure: c.secure,
      requireTLS: !c.secure,
      auth: { user: c.user, pass: c.pass },
      logger: false,
      debug: false,
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 20000,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    try {
      const result = await transport.sendMail({
        from: c.from,
        to: email,
        subject: "Verify your CargoCheck AI email",
        text: `Verify your email to use CargoCheck AI:\n\n${link}\n\nThis link expires in 30 minutes and can be used once. If you did not request it, ignore this email.`,
      });
      if (
        !result.accepted.some(
          (address) => String(address).toLowerCase() === email.toLowerCase(),
        )
      )
        throw new Error();
    } catch {
      // SMTP errors can contain credentials or message content. Never propagate them.
      throw new HttpException(
        {
          code: "EMAIL_DELIVERY_FAILED",
          message:
            "The email service did not confirm acceptance of your verification email. Your account is still unverified. Wait 60 seconds and request another link.",
        },
        503,
      );
    } finally {
      transport.close();
    }
  }
}
