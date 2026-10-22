import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Response } from "express";
import { HttpException } from "@nestjs/common";
import { ApiController } from "../apps/api/src/app";
import { Store } from "../apps/api/src/store";
import { Jobs } from "../apps/api/src/jobs";

test("authentication trims email whitespace and prevents duplicate accounts", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cargo-auth-test-"));
  const previousDataDir = process.env.DATA_DIR;
  const previousDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATA_DIR = dir;
  delete process.env.DATABASE_URL;
  const store = new Store();
  const api = new ApiController(store, new Jobs(store));
  const response = { cookie() {} } as unknown as Response;
  const password = "correct-horse-123";
  try {
    await store.init();
    const user = await api.register(
      { email: "  Reviewer@example.com  ", password, name: "Reviewer" },
      response,
    );
    assert.equal(user.email, "reviewer@example.com");
    const signedIn = await api.login(
      { email: " reviewer@example.com ", password },
      response,
    );
    assert.equal(signedIn.id, user.id);
    await assert.rejects(
      api.register({ email: " REVIEWER@example.com ", password }, response),
      (error) => error instanceof HttpException && error.getStatus() === 409,
    );
    await assert.rejects(
      api.register({ email: "not an email", password }, response),
      { name: "ZodError" },
    );
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  }
});
