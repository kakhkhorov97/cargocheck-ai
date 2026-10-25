import test from "node:test";
import assert from "node:assert/strict";
import nodemailer from "nodemailer";
import { HttpException } from "@nestjs/common";
import { SmtpVerificationMailer } from "../apps/api/src/email";

function configure(t: import("node:test").TestContext) {
  const keys = [
    "APP_ORIGIN",
    "SMTP_HOST",
    "SMTP_PORT",
    "SMTP_SECURE",
    "SMTP_USER",
    "SMTP_PASSWORD",
    "SMTP_FROM",
    "NODE_ENV",
  ];
  const previous = Object.fromEntries(
    keys.map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, {
    APP_ORIGIN: "https://cargo.example.com",
    SMTP_HOST: "smtp.example.com",
    SMTP_PORT: "587",
    SMTP_SECURE: "false",
    SMTP_USER: "test-user",
    SMTP_PASSWORD: "test-password",
    SMTP_FROM: "verify@example.com",
    NODE_ENV: "production",
  });
  t.after(() => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });
}

test("deferred SMTP module: configuration is mandatory and the trusted frontend origin is validated", (t) => {
  configure(t);
  const mailer = new SmtpVerificationMailer();
  mailer.assertConfigured();
  for (const key of [
    "APP_ORIGIN",
    "SMTP_HOST",
    "SMTP_PORT",
    "SMTP_SECURE",
    "SMTP_USER",
    "SMTP_PASSWORD",
    "SMTP_FROM",
  ]) {
    const previous = process.env[key];
    delete process.env[key];
    assert.throws(
      () => mailer.assertConfigured(),
      (e) =>
        e instanceof HttpException &&
        e.getStatus() === 503 &&
        !JSON.stringify(e.getResponse()).includes("test-password"),
    );
    process.env[key] = previous;
  }
  for (const origin of [
    "http://cargo.example.com",
    "https://cargo.example.com/path",
    "https://cargo.example.com/",
    "https://user:secret@cargo.example.com",
    "not-a-url",
  ]) {
    process.env.APP_ORIGIN = origin;
    assert.throws(
      () => mailer.assertConfigured(),
      (e) => e instanceof HttpException && e.getStatus() === 503,
    );
  }
});

test("deferred SMTP module: TLS, disables debug output, and builds fragment links from APP_ORIGIN", async (t) => {
  configure(t);
  let options: any;
  let message: any;
  let closed = false;
  t.mock.method(nodemailer, "createTransport", (value: any) => {
    options = value;
    return {
      sendMail: async (value: any) => {
        message = value;
        return { accepted: ["reviewer@example.com"] };
      },
      close: () => {
        closed = true;
      },
    } as any;
  });
  const token = "a".repeat(64);
  await new SmtpVerificationMailer().sendVerification(
    "reviewer@example.com",
    token,
  );
  assert.equal(options.requireTLS, true);
  assert.equal(options.secure, false);
  assert.equal(options.logger, false);
  assert.equal(options.debug, false);
  assert.equal(options.disableFileAccess, true);
  assert.match(
    message.text,
    new RegExp(`https://cargo.example.com/\\?verify-email#token=${token}`),
  );
  assert.equal(message.to, "reviewer@example.com");
  assert.equal(closed, true);
  process.env.SMTP_SECURE = "true";
  process.env.SMTP_PORT = "465";
  await new SmtpVerificationMailer().sendVerification(
    "reviewer@example.com",
    token,
  );
  assert.equal(options.secure, true);
});

test("deferred SMTP module: rejection and exceptions fail honestly without exposing provider error content", async (t) => {
  configure(t);
  for (const throws of [false, true]) {
    t.mock.method(
      nodemailer,
      "createTransport",
      () =>
        ({
          sendMail: async () => {
            if (throws) throw new Error("secret credentials and raw token");
            return { accepted: [], rejected: ["reviewer@example.com"] };
          },
          close() {},
        }) as any,
    );
    await assert.rejects(
      new SmtpVerificationMailer().sendVerification(
        "reviewer@example.com",
        "a".repeat(64),
      ),
      (e) => {
        assert.ok(e instanceof HttpException);
        assert.equal(e.getStatus(), 503);
        assert.equal(
          JSON.stringify(e.getResponse()).includes("secret credentials"),
          false,
        );
        assert.equal((e.getResponse() as any).code, "EMAIL_DELIVERY_FAILED");
        return true;
      },
    );
    t.mock.restoreAll();
  }
});
