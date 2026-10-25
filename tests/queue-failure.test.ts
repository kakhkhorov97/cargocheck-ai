import { MockVerificationMailer } from "./helpers/verification";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Request, Response } from "express";
import { ApiController } from "../apps/api/src/app";
import { Store } from "../apps/api/src/store";
import { Jobs } from "../apps/api/src/jobs";

test("queue failures leave uploads, retries and samples recoverable", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "cargo-queue-test-"));
  const previousDataDir = process.env.DATA_DIR;
  const previousDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATA_DIR = dir;
  delete process.env.DATABASE_URL;
  const store = new Store();
  const jobs = new Jobs(store);
  const enqueue = t.mock.method(jobs, "enqueue", async () => {
    throw new Error("Redis unavailable");
  });
  const mailer = new MockVerificationMailer();
  const api = new ApiController(store, jobs, mailer);
  const cookies: Record<string, string> = {};
  const res = {
    cookie: (key: string, value: string) => {
      cookies[key] = value;
    },
  } as unknown as Response;
  const req = { cookies } as Request;
  try {
    await store.init();
    await api.register(
      { email: "queue@example.com", password: "test-password-123" },
      res,
    );
    await api.verifyEmail({ token: mailer.messages[0].token });
    await api.login(
      { email: "queue@example.com", password: "test-password-123" },
      res,
    );
    const created = await api.create({ reference: "QUEUE-001" }, req);
    const uploaded = await api.upload(
      created.id,
      "invoice",
      {
        buffer: Buffer.from("%PDF-test"),
        mimetype: "application/pdf",
        originalname: "invoice.pdf",
      } as Express.Multer.File,
      { ...req, body: { version: created.version } } as Request,
    );
    assert.equal(uploaded.documents.invoice!.status, "failed");
    assert.match(
      uploaded.documents.invoice!.error!,
      /Could not queue extraction/,
    );
    assert.equal(uploaded.version, created.version + 2);
    assert.ok(!("path" in uploaded.documents.invoice!));

    await api.retry(uploaded.id, "invoice", { version: uploaded.version }, req);
    const retried = await api.get(uploaded.id, req);
    assert.equal(retried.documents.invoice!.status, "failed");
    assert.notEqual(
      retried.documents.invoice!.id,
      uploaded.documents.invoice!.id,
    );
    assert.equal(retried.version, uploaded.version + 2);
    // Another retry remains possible after Redis rejects the previous attempt.
    await api.retry(retried.id, "invoice", { version: retried.version }, req);

    const sample = await api.sample(req);
    assert.equal(sample.documents.invoice!.status, "failed");
    assert.equal(sample.documents.packing!.status, "failed");
    assert.equal(sample.version, 3);
    assert.equal(enqueue.mock.callCount(), 5);
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  }
});
