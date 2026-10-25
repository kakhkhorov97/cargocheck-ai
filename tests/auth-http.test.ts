import test from "node:test";
import assert from "node:assert/strict";
import { HttpException } from "@nestjs/common";
import type { ArgumentsHost } from "@nestjs/common";
import { verificationRateLimit, Errors } from "../apps/api/src/auth-http";
import { z } from "zod";

function response() {
  let body: any;
  let status: number;
  const res: any = {
    status(value: number) {
      status = value;
      return res;
    },
    json(value: any) {
      body = value;
      return res;
    },
  };
  return {
    res,
    host: { switchToHttp: () => ({ getResponse: () => res }) } as ArgumentsHost,
    result: () => ({ body, status }),
  };
}

test("HTTP exception filter preserves safe verification error codes", () => {
  const f = response();
  new Errors().catch(
    new HttpException(
      { code: "EMAIL_NOT_VERIFIED", message: "Verify your email." },
      403,
    ),
    f.host,
  );
  assert.deepEqual(f.result(), {
    status: 403,
    body: { code: "EMAIL_NOT_VERIFIED", message: "Verify your email." },
  });
});

test("validation errors omit raw tokens and unexpected errors are redacted in logs", (t) => {
  const f = response();
  const parse = z
    .object({ token: z.string().regex(/^[a-f0-9]{64}$/) })
    .safeParse({ token: "RAW_SECRET" });
  assert.equal(parse.success, false);
  if (!parse.success) new Errors().catch(parse.error, f.host);
  assert.equal(f.result().status, 400);
  assert.equal(JSON.stringify(f.result().body).includes("RAW_SECRET"), false);
  const logs: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => logs.push(args));
  new Errors().catch(new Error("RAW_SECRET SMTP_PASSWORD"), f.host);
  assert.equal(f.result().status, 500);
  assert.equal(JSON.stringify(logs).includes("RAW_SECRET"), false);
  assert.equal(
    JSON.stringify(f.result().body).includes("SMTP_PASSWORD"),
    false,
  );
});

test("verification limiter blocks the sixteenth request from the same IP", async () => {
  // Exercise the actual Express middleware without opening a network port.
  const limiter = verificationRateLimit();
  let limited: any;
  for (let i = 0; i < 16; i++) {
    let nextCalled = false;
    const req: any = {
      method: "POST",
      ip: "127.0.0.1",
      headers: {},
      socket: { remoteAddress: "127.0.0.1" },
      app: { get: () => false },
    };
    const res: any = {
      statusCode: 200,
      headersSent: false,
      writableEnded: false,
      setHeader() {},
      getHeader() {},
      append() {},
      on() {},
      status(value: number) {
        this.statusCode = value;
        return this;
      },
      send(value: any) {
        limited = { status: this.statusCode, body: value };
        return this;
      },
    };
    await limiter(req, res, (error?: unknown) => {
      if (error) throw error;
      nextCalled = true;
    });
    assert.equal(nextCalled, i < 15);
  }
  assert.equal(limited.status, 429);
  assert.match(limited.body.message, /Too many verification requests/);
});
