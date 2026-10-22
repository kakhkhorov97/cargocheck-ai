import test from "node:test";
import assert from "node:assert/strict";
import { validateProductionDatabase } from "../apps/api/src/production-config";

test("development can still use local-file storage or local PostgreSQL", () => {
  assert.doesNotThrow(() => validateProductionDatabase({}));
  assert.doesNotThrow(() =>
    validateProductionDatabase({
      NODE_ENV: "development",
      DATABASE_URL: "postgresql://localhost/cargo",
    }),
  );
});

test("production requires PostgreSQL without revealing connection credentials", () => {
  const invalid = [
    undefined,
    "",
    "   ",
    "not-a-url",
    "https://user:test-password@db.invalid/cargo",
    "postgresql://user:test-password@localhost/cargo",
    "postgres://user:test-password@127.0.0.1/cargo",
    "postgresql://user:test-password@127.0.0.2/cargo",
    "postgresql://user:test-password@[::1]/cargo",
    "postgresql://user:test-password@0.0.0.0/cargo",
    "postgresql://user:test-password@[::]/cargo",
    "postgresql://user:test-password@localhost./cargo",
    "postgresql://user:test-password@db.localhost/cargo",
  ];
  for (const DATABASE_URL of invalid) {
    assert.throws(
      () => validateProductionDatabase({ NODE_ENV: "production", DATABASE_URL }),
      (error) =>
        error instanceof Error &&
        error.message.startsWith("DATABASE_URL ") &&
        !error.message.includes("test-password"),
    );
  }
});

test("production accepts hosted and private-network PostgreSQL URLs", () => {
  for (const DATABASE_URL of [
    "postgresql://user:test-password@db.invalid/cargo?sslmode=require",
    "postgres://user:test-password@postgres.internal/cargo",
  ]) {
    assert.doesNotThrow(() =>
      validateProductionDatabase({ NODE_ENV: "production", DATABASE_URL }),
    );
  }
});
