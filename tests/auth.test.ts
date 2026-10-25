import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, scryptSync } from "node:crypto";
import type { Request, Response } from "express";
import { HttpException } from "@nestjs/common";
import { PATH_METADATA } from "@nestjs/common/constants";
import { ApiController, AppModule } from "../apps/api/src/app";
import { Store } from "../apps/api/src/store";
import { Jobs } from "../apps/api/src/jobs";
import { SmtpVerificationMailer } from "../apps/api/src/email";

const password = "correct-horse-123";
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const status = (expected: number) => (e: unknown) =>
  e instanceof HttpException && e.getStatus() === expected;

async function fixture(t: import("node:test").TestContext) {
  const dir = await mkdtemp(path.join(tmpdir(), "cargo-password-auth-test-"));
  const keys = [
    "DATA_DIR",
    "DATABASE_URL",
    "SMTP_HOST",
    "SMTP_PORT",
    "SMTP_SECURE",
    "SMTP_USER",
    "SMTP_PASSWORD",
    "SMTP_FROM",
    "COOKIE_SECURE",
  ];
  const env = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.DATA_DIR = dir;
  for (const key of keys.filter((key) => key !== "DATA_DIR"))
    delete process.env[key];
  const store = new Store();
  await store.init();
  const api = new ApiController(store, new Jobs(store));
  const cookies: Record<string, string> = {};
  let cookieOptions: any;
  const res = {
    cookie(key: string, value: string, options: unknown) {
      cookies[key] = value;
      cookieOptions = options;
    },
    clearCookie(key: string) {
      delete cookies[key];
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
  return {
    dir,
    store,
    api,
    cookies,
    res,
    req,
    register,
    cookieOptions: () => cookieOptions,
  };
}

test("registration signs in without SMTP, hashes credentials, and leaves ownership unverified", async (t) => {
  const f = await fixture(t);
  const config = t.mock.method(
    SmtpVerificationMailer.prototype,
    "assertConfigured",
    () => {
      throw new Error("Email must stay disconnected");
    },
  );
  const send = t.mock.method(
    SmtpVerificationMailer.prototype,
    "sendVerification",
    async () => {
      throw new Error("Email must never be sent");
    },
  );
  const user = await f.register(" Reviewer@Example.com ");
  assert.equal(user.email, "reviewer@example.com");
  assert.deepEqual(Object.keys(user).sort(), ["email", "id", "name"]);
  assert.equal((await f.api.me(f.req)).id, user.id);
  assert.deepEqual(await f.api.list(f.req), []);
  const state = await f.store.transaction((s) => s);
  assert.equal(state.users[0].emailVerifiedAt, null);
  const [salt, digest] = state.users[0].password.split(":");
  assert.equal(digest, scryptSync(password, salt, 64).toString("hex"));
  assert.notEqual(state.users[0].password, password);
  assert.equal(state.sessions[0].hash, hash(f.cookies.cargo_session));
  assert.equal((state.emailVerifications ?? []).length, 0);
  await f.api.login({ email: "reviewer@example.com", password }, f.res);
  assert.equal(config.mock.callCount(), 0);
  assert.equal(send.mock.callCount(), 0);
  const raw = await readFile(path.join(f.dir, "state.json"), "utf8");
  assert.equal(raw.includes(password), false);
  assert.equal(raw.includes(f.cookies.cargo_session), false);
});

test("normalized email uniqueness is atomic across concurrent registrations", async (t) => {
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
  assert.equal((await f.store.transaction((s) => s.users)).length, 1);
});

test("registration and login retain email and password validation", async (t) => {
  const f = await fixture(t);
  for (const body of [
    { email: "not an email", password },
    { email: "reviewer@example.com", password: "short" },
    { email: "reviewer@example.com", password: "a".repeat(129) },
    { password },
  ]) {
    await assert.rejects(f.api.register(body, f.res), { name: "ZodError" });
    await assert.rejects(f.api.login(body, f.res), { name: "ZodError" });
  }
  assert.equal((await f.store.transaction((s) => s.users)).length, 0);
});

test("unverified users can log in and access their data without changing ownership status", async (t) => {
  const f = await fixture(t);
  const first = await f.register();
  const shipment = await f.api.create({ reference: "PRESERVED-001" }, f.req);
  await f.api.logout(f.req, f.res);
  const loggedIn = await f.api.login(
    { email: " REVIEWER@example.com ", password },
    f.res,
  );
  assert.equal(loggedIn.id, first.id);
  assert.equal(
    (await f.api.get(shipment.id, f.req)).reference,
    "PRESERVED-001",
  );
  assert.equal(
    (await f.store.transaction((s) => s.users[0])).emailVerifiedAt,
    null,
  );
});

test("wrong passwords and unknown emails do not create sessions", async (t) => {
  const f = await fixture(t);
  await f.register();
  await f.api.logout(f.req, f.res);
  for (const body of [
    { email: "reviewer@example.com", password: "incorrect-password" },
    { email: "unknown@example.com", password },
  ])
    await assert.rejects(f.api.login(body, f.res), status(401));
  assert.equal((await f.store.transaction((s) => s.sessions)).length, 0);
  await assert.rejects(f.api.list(f.req), status(401));
});

test("sessions retain cookie security, expiry checks, and logout revocation", async (t) => {
  const f = await fixture(t);
  process.env.COOKIE_SECURE = "true";
  await f.register();
  assert.deepEqual(f.cookieOptions(), {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    maxAge: 7 * 86400000,
    path: "/",
  });
  await f.store.transaction((s) => {
    s.sessions[0].expiresAt = Date.now() - 1;
  });
  await assert.rejects(f.api.me(f.req), status(401));
  await f.api.login({ email: "reviewer@example.com", password }, f.res);
  const token = f.cookies.cargo_session;
  await f.api.logout(f.req, f.res);
  await assert.rejects(
    f.api.me({ cookies: { cargo_session: token } } as Request),
    status(401),
  );
});

test("unverified accounts cannot access another user's shipments", async (t) => {
  const f = await fixture(t);
  await f.register();
  const shipment = await f.api.create({ reference: "PRIVATE" }, f.req);
  await f.register("other@example.com");
  assert.deepEqual(await f.api.list(f.req), []);
  await assert.rejects(f.api.get(shipment.id, f.req), status(404));
  await assert.rejects(
    f.api.validate(shipment.id, { version: shipment.version }, f.req),
    status(404),
  );
});

test("legacy loading preserves users, data, valid unverified sessions, and existing verification timestamps", async (t) => {
  const f = await fixture(t);
  const salt = "legacy-test-salt";
  const timestamp = "2026-10-01T00:00:00.000Z";
  const legacy = {
    users: [
      {
        id: "legacy",
        email: "Legacy@Example.com ",
        name: "Legacy",
        password: `${salt}:${scryptSync(password, salt, 64).toString("hex")}`,
      },
      {
        id: "verified",
        email: "verified@example.com",
        name: "Verified",
        password: "preserved",
        emailVerifiedAt: timestamp,
      },
    ],
    sessions: [
      {
        userId: "legacy",
        hash: hash("legacy-session"),
        expiresAt: Date.now() + 60000,
      },
    ],
    shipments: [
      {
        id: "preserved",
        ownerId: "legacy",
        reference: "KEPT",
        documents: {},
        checks: [],
        history: [],
        version: 1,
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-01T00:00:00.000Z",
        reviewStatus: "in_progress",
        synthetic: false,
      },
    ],
    emailVerifications: [
      {
        hash: hash("old-verification-token"),
        userId: "legacy",
        accepted: true,
        expiresAt: Date.now() + 60000,
      },
    ],
  };
  await writeFile(path.join(f.dir, "state.json"), JSON.stringify(legacy));
  const reopened = new Store();
  await reopened.init();
  t.after(() => reopened.close());
  const api = new ApiController(reopened, new Jobs(reopened));
  const state = await reopened.transaction((s) => s);
  assert.deepEqual(state.shipments, legacy.shipments);
  assert.deepEqual(state.sessions, legacy.sessions);
  assert.deepEqual(state.emailVerifications, legacy.emailVerifications);
  assert.equal(state.users[0].emailVerifiedAt, null);
  assert.equal(state.users[1].emailVerifiedAt, timestamp);
  assert.equal(
    (await api.me({ cookies: { cargo_session: "legacy-session" } } as Request))
      .id,
    "legacy",
  );
  await api.login({ email: " LEGACY@example.com ", password }, f.res);
  assert.equal((await api.get("preserved", f.req)).reference, "KEPT");
  assert.equal(
    (await reopened.transaction((s) => s.users[0])).emailVerifiedAt,
    null,
  );
});

test("normalization collisions stop loading without deleting or rewriting records", async (t) => {
  const f = await fixture(t);
  const users = ["Reviewer@example.com", " reviewer@EXAMPLE.COM "].map(
    (email, i) => ({
      id: `user-${i}`,
      email,
      name: "Reviewer",
      password: "preserved",
    }),
  );
  const raw = JSON.stringify({ users, sessions: [], shipments: [] });
  await writeFile(path.join(f.dir, "state.json"), raw);
  const reopened = new Store();
  await assert.rejects(reopened.init(), /duplicate normalized emails/);
  await reopened.close();
  assert.equal(await readFile(path.join(f.dir, "state.json"), "utf8"), raw);
});

test("the active API exposes no verification routes or mailer provider", () => {
  const paths = Object.getOwnPropertyNames(ApiController.prototype).map((key) =>
    Reflect.getMetadata(PATH_METADATA, (ApiController.prototype as any)[key]),
  );
  assert.equal(paths.includes("auth/verify-email"), false);
  assert.equal(paths.includes("auth/resend-verification"), false);
  const providers = Reflect.getMetadata("providers", AppModule);
  assert.equal(
    providers.some((p: any) => p.provide === "MAILER"),
    false,
  );
});
