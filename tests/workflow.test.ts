import { MockVerificationMailer } from "./helpers/verification";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ApiController } from "../apps/api/src/app";
import { Store } from "../apps/api/src/store";
import { Jobs } from "../apps/api/src/jobs";
import type { Request, Response } from "express";
import { HttpException } from "@nestjs/common";
import { PassThrough } from "node:stream";

test("persisted end-to-end sample review: ownership, conflicts, corrections, decisions, completion, export", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cargo-test-"));
  process.env.DATA_DIR = dir;
  delete process.env.DATABASE_URL;
  delete process.env.REDIS_URL;
  process.env.EXTRACTION_PROVIDER = "local";
  const store = new Store();
  await store.init();
  const jobs = new Jobs(store);
  await jobs.init();
  const mailer = new MockVerificationMailer();
  const api = new ApiController(store, jobs, mailer);
  function response() {
    const cookies: Record<string, string> = {};
    return {
      cookies,
      res: {
        cookie: (k: string, v: string) => (cookies[k] = v),
      } as unknown as Response,
    };
  }
  const a = response(),
    b = response();
  await api.register(
    {
      email: "reviewer@example.com",
      password: "correct-horse-123",
      name: "Reviewer",
    },
    a.res,
  );
  await api.register(
    {
      email: "other@example.com",
      password: "another-horse-123",
      name: "Other",
    },
    b.res,
  );
  for (const message of mailer.messages)
    await api.verifyEmail({ token: message.token });
  await api.login(
    { email: "reviewer@example.com", password: "correct-horse-123" },
    a.res,
  );
  await api.login(
    { email: "other@example.com", password: "another-horse-123" },
    b.res,
  );
  const req = { cookies: a.cookies } as Request,
    other = { cookies: b.cookies } as Request;
  try {
    let s = await api.sample(req);
    await assert.rejects(
      () => api.get(s.id, other),
      (e) => e instanceof HttpException && e.getStatus() === 404,
    );
    for (let n = 0; n < 100; n++) {
      s = await api.get(s.id, req);
      if (Object.values(s.documents).every((d) => d.status === "ready")) break;
      await new Promise((r) => setTimeout(r, 30));
    }
    assert.ok(Object.values(s.documents).every((d) => d.status === "ready"));
    assert.equal(
      s.documents.invoice!.extraction!.items[0].quantity.value,
      "100",
    );
    assert.equal(
      s.documents.packing!.extraction!.items[0].quantity.value,
      "90",
    );
    assert.ok(!("path" in s.documents.invoice!));
    await assert.rejects(
      () => api.validate(s.id, { version: 0 }, req),
      (e) => e instanceof HttpException && e.getStatus() === 409,
    );
    s = await api.validate(s.id, { version: s.version }, req);
    await assert.rejects(() => api.complete(s.id, { version: s.version }, req));
    s = await api.confirm(s.id, "invoice", { version: s.version }, req);
    s = await api.confirm(s.id, "packing", { version: s.version }, req);
    assert.equal(
      s.checks.find((c) => c.id === "quantity-book-01")?.status,
      "discrepancy",
    );
    s = await api.decide(
      s.id,
      "quantity-book-01",
      {
        version: s.version,
        outcome: "unresolved",
        note: "Asked seller to confirm 100 invoiced versus 90 packed.",
      },
      req,
    );
    s = await api.complete(s.id, { version: s.version }, req);
    assert.equal(s.reviewStatus, "reviewed");
    const output = new PassThrough() as PassThrough & {
      set: (v: unknown) => void;
    };
    output.set = () => {};
    const chunks: Buffer[] = [];
    output.on("data", (b) => chunks.push(b));
    const done = new Promise<void>((resolve) => output.on("end", resolve));
    await api.export(s.id, req, output as unknown as Response);
    await done;
    assert.equal(Buffer.concat(chunks).subarray(0, 5).toString(), "%PDF-");
    s = await api.update(
      s.id,
      {
        version: s.version,
        kind: "packing",
        path: "items.0.quantity",
        value: "95",
      },
      req,
    );
    assert.equal(s.reviewStatus, "in_progress");
    assert.equal(
      s.documents.packing!.extraction!.items[0].quantity.originalValue,
      "90",
    );
    assert.equal(
      s.checks.find((c) => c.id === "quantity-book-01")?.decision,
      undefined,
    );
    assert.ok(s.history.some((h) => h.action === "field_confirmed"));
    const second = new Store();
    await second.init();
    assert.equal(
      (await second.transaction((state) => state.shipments[0])).documents
        .packing!.extraction!.items[0].quantity.value,
      "95",
    );
    await second.close();
    await assert.rejects(() =>
      api.upload(
        s.id,
        "invoice",
        {
          buffer: Buffer.from("<script>"),
          mimetype: "application/pdf",
          originalname: "fake.pdf",
        } as Express.Multer.File,
        { ...req, body: { version: s.version } } as Request,
      ),
    );
    const state = JSON.parse(
      await readFile(path.join(dir, "state.json"), "utf8"),
    );
    assert.ok(!state.users[0].password.includes("correct-horse"));
    assert.ok(
      state.sessions.every(
        (x: { hash: string }) => x.hash !== a.cookies.cargo_session,
      ),
    );
  } finally {
    await jobs.close();
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
