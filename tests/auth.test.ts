import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, scryptSync } from "node:crypto";
import type { Request, Response } from "express";
import { HttpException } from "@nestjs/common";
import { ApiController } from "../apps/api/src/app";
import { Store } from "../apps/api/src/store";
import { Jobs } from "../apps/api/src/jobs";
import { MockVerificationMailer } from "./helpers/verification";

const password = "correct-horse-123";
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const status = (expected: number) => (e: unknown) =>
  e instanceof HttpException && e.getStatus() === expected;

async function fixture(t: Parameters<Parameters<typeof test>[1]>[0]) {
  const dir = await mkdtemp(path.join(tmpdir(), "cargo-verification-test-"));
  const env = {
    DATA_DIR: process.env.DATA_DIR,
    DATABASE_URL: process.env.DATABASE_URL,
  };
  process.env.DATA_DIR = dir;
  delete process.env.DATABASE_URL;
  const store = new Store();
  await store.init();
  const mailer = new MockVerificationMailer();
  const api = new ApiController(store, new Jobs(store), mailer);
  const cookies: Record<string, string> = {};
  const res = {
    cookie(key: string, value: string) {
      cookies[key] = value;
    },
  } as unknown as Response;
  const req = { cookies } as Request;
  t.after(async () => {
    await store.close();
    await rm(dir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const register = (email = "reviewer@example.com") =>
    api.register({ email, password, name: "Reviewer" }, res);
  return { dir, store, mailer, api, cookies, res, req, register };
}

test("registration normalizes emails, stores only token hashes, and creates no session", async (t) => {
  const f = await fixture(t);
  const result = await f.register("  Reviewer@Example.com  ");
  assert.equal(result.email, "reviewer@example.com");
  assert.equal(result.verificationRequired, true);
  assert.deepEqual(f.cookies, {});
  const raw = f.mailer.messages[0].token;
  assert.match(raw, /^[a-f0-9]{64}$/);
  const persisted = await readFile(path.join(f.dir, "state.json"), "utf8");
  assert.equal(persisted.includes(raw), false);
  const state = JSON.parse(persisted);
  assert.equal(state.users[0].emailVerifiedAt, null);
  assert.equal(state.emailVerifications[0].hash, hash(raw));
  assert.ok(
    Math.abs(state.emailVerifications[0].expiresAt - Date.now() - 30 * 60000) <
      2000,
  );
  assert.equal(state.sessions.length, 0);
});

test("email uniqueness is normalized and atomic across concurrent registrations", async (t) => {
  const f = await fixture(t);
  const results = await Promise.allSettled([
    f.register(" Reviewer@example.com "),
    f.register("REVIEWER@EXAMPLE.COM"),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const failure = results.find(
    (r) => r.status === "rejected",
  ) as PromiseRejectedResult;
  assert.ok(status(409)(failure.reason));
  await assert.rejects(f.register("not an email"), { name: "ZodError" });
});

test("unverified accounts cannot log in or access protected routes through old sessions", async (t) => {
  const f = await fixture(t);
  await f.register();
  await assert.rejects(
    f.api.login({ email: "reviewer@example.com", password }, f.res),
    status(403),
  );
  await assert.rejects(
    f.api.login(
      { email: "reviewer@example.com", password: "wrong-password" },
      f.res,
    ),
    status(401),
  );
  await f.store.transaction((s) =>
    s.sessions.push({
      hash: hash("old-session"),
      userId: s.users[0].id,
      expiresAt: Date.now() + 60000,
    }),
  );
  f.cookies.cargo_session = "old-session";
  for (const call of [
    () => f.api.me(f.req),
    () => f.api.list(f.req),
    () => f.api.create({ reference: "BLOCKED" }, f.req),
    () => f.api.sample(f.req),
  ])
    await assert.rejects(
      call,
      (e: unknown) => status(401)(e) || status(403)(e),
    );
});

test("verification is atomic and single-use, then requires a fresh sign-in", async (t) => {
  const f = await fixture(t);
  await f.register();
  const token = f.mailer.messages[0].token;
  const results = await Promise.all([
    f.api.verifyEmail({ token }),
    f.api.verifyEmail({ token }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [
    "already_used",
    "success",
  ]);
  await assert.rejects(f.api.me(f.req), status(401));
  const user = await f.api.login(
    { email: " REVIEWER@example.com ", password },
    f.res,
  );
  assert.equal(user.email, "reviewer@example.com");
  assert.equal((await f.api.me(f.req)).id, user.id);
  assert.deepEqual(await f.api.list(f.req), []);
});

test("expired, invalid, and malformed links cannot verify an account", async (t) => {
  const f = await fixture(t);
  await f.register();
  const token = f.mailer.messages[0].token;
  await f.store.transaction((s) => {
    s.emailVerifications![0].expiresAt = Date.now() - 1;
  });
  assert.equal((await f.api.verifyEmail({ token })).status, "expired");
  assert.equal(
    (await f.api.verifyEmail({ token: "a".repeat(64) })).status,
    "invalid",
  );
  await assert.rejects(f.api.verifyEmail({ token: "broken" }), {
    name: "ZodError",
  });
  await assert.rejects(
    f.api.login({ email: "reviewer@example.com", password }, f.res),
    status(403),
  );
});

test("resend enforces a persisted 60-second cooldown and invalidates the previous link", async (t) => {
  const f = await fixture(t);
  await f.register();
  const first = f.mailer.messages[0].token;
  await f.api.resendVerification({ email: " REVIEWER@example.com " });
  assert.equal(f.mailer.messages.length, 1);
  await f.store.transaction((s) => {
    s.users[0].verificationRequestedAt = Date.now() - 60001;
  });
  await Promise.all([
    f.api.resendVerification({ email: "reviewer@example.com" }),
    f.api.resendVerification({ email: "reviewer@example.com" }),
  ]);
  assert.equal(f.mailer.messages.length, 2);
  assert.equal((await f.api.verifyEmail({ token: first })).status, "invalid");
  assert.equal(
    (await f.api.verifyEmail({ token: f.mailer.messages[1].token })).status,
    "success",
  );
});

test("public resend has identical responses for unknown, verified, cooldown and failed delivery", async (t) => {
  const f = await fixture(t);
  await f.register();
  const unknown = await f.api.resendVerification({
    email: "unknown@example.com",
  });
  assert.deepEqual(
    await f.api.resendVerification({ email: "reviewer@example.com" }),
    unknown,
  );
  await f.store.transaction((s) => {
    s.users[0].verificationRequestedAt = 0;
  });
  f.mailer.failure = true;
  assert.deepEqual(
    await f.api.resendVerification({ email: "reviewer@example.com" }),
    unknown,
  );
  assert.equal(unknown.deliveryConfirmed, false);
  f.mailer.failure = false;
  await f.store.transaction((s) => {
    s.users[0].emailVerifiedAt = new Date().toISOString();
  });
  assert.deepEqual(
    await f.api.resendVerification({ email: "reviewer@example.com" }),
    unknown,
  );
  await assert.rejects(f.api.resendVerification({ email: "invalid" }), {
    name: "ZodError",
  });
});

test("delivery rejection retains an unverified account, issues no usable link, and allows later recovery", async (t) => {
  const f = await fixture(t);
  f.mailer.failure = true;
  await assert.rejects(f.register(), status(503));
  let state = await f.store.transaction((s) => s);
  assert.equal(state.users.length, 1);
  assert.equal(state.users[0].emailVerifiedAt, null);
  assert.equal(state.sessions.length, 0);
  assert.equal(state.emailVerifications![0].accepted, false);
  assert.ok(state.emailVerifications![0].invalidatedAt);
  assert.deepEqual(f.cookies, {});
  f.mailer.failure = false;
  await f.store.transaction((s) => {
    s.users[0].verificationRequestedAt = Date.now() - 60001;
  });
  await f.api.resendVerification({ email: "reviewer@example.com" });
  assert.equal(
    (await f.api.verifyEmail({ token: f.mailer.messages[0].token })).status,
    "success",
  );
});

test("a token is unusable before SMTP acceptance is confirmed", async (t) => {
  const f = await fixture(t);
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>((r) => {
    entered = r;
  });
  const waiting = new Promise<void>((r) => {
    release = r;
  });
  let raw = "";
  t.mock.method(
    f.mailer,
    "sendVerification",
    async (_email: string, token: string) => {
      raw = token;
      entered();
      await waiting;
    },
  );
  const registration = f.register();
  await ready;
  assert.equal((await f.api.verifyEmail({ token: raw })).status, "invalid");
  release();
  await registration;
  assert.equal((await f.api.verifyEmail({ token: raw })).status, "success");
});

test("legacy users migrate to unverified without deleting users or shipments and can request verification", async (t) => {
  const f = await fixture(t);
  const salt = "legacy-test-salt";
  const legacy = {
    users: [
      {
        id: "legacy",
        email: "Legacy@Example.com ",
        name: "Legacy",
        password: `${salt}:${scryptSync(password, salt, 64).toString("hex")}`,
      },
    ],
    sessions: [
      {
        userId: "legacy",
        hash: hash("legacy-session"),
        expiresAt: Date.now() + 60000,
      },
    ],
    shipments: [{ id: "preserved", ownerId: "legacy" }],
  };
  await writeFile(path.join(f.dir, "state.json"), JSON.stringify(legacy));
  await f.store.close();
  const reopened = new Store();
  await reopened.init();
  t.after(() => reopened.close());
  const state = await reopened.transaction((s) => s);
  assert.equal(state.users.length, 1);
  assert.equal(state.users[0].emailVerifiedAt, null);
  assert.equal(state.users[0].email, "legacy@example.com");
  assert.deepEqual(state.shipments, legacy.shipments);
  assert.equal(state.sessions.length, 0);
  const api = new ApiController(reopened, new Jobs(reopened), f.mailer);
  await assert.rejects(
    api.login({ email: "legacy@example.com", password }, f.res),
    status(403),
  );
  await api.resendVerification({ email: "legacy@example.com" });
  assert.equal(
    (await api.verifyEmail({ token: f.mailer.messages[0].token })).status,
    "success",
  );
  await api.login({ email: "legacy@example.com", password }, f.res);
});
