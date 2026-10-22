import test from "node:test";
import assert from "node:assert/strict";
import { api } from "../apps/web/src/api";

test("connection failures explain how to recover", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new TypeError("Failed to fetch");
  });
  await assert.rejects(api("/shipments"), {
    message: "Could not reach the server. Check your connection and try again.",
  });
});

test("API failures always include a readable message", async (t) => {
  const fallback = "Request failed (400). Please try again.";
  const cases = [
    {
      body: { message: "Reference is required." },
      expected: "Reference is required.",
    },
    {
      body: {
        message: ["Reference is required.", "Use at most 80 characters."],
      },
      expected: "Reference is required. Use at most 80 characters.",
    },
    { body: {}, expected: fallback },
    { body: null, expected: fallback },
    { body: { message: "  " }, expected: fallback },
    { body: { message: [] }, expected: fallback },
    { body: { message: [null, "", 42] }, expected: fallback },
    { body: { message: { detail: "internal" } }, expected: fallback },
  ];
  for (const { body, expected } of cases) {
    t.mock.method(globalThis, "fetch", async () =>
      Response.json(body, { status: 400 }),
    );
    await assert.rejects(api("/shipments"), { message: expected });
    t.mock.restoreAll();
  }
});

test("non-JSON API failures retain the status fallback", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response("Bad gateway", { status: 502 }),
  );
  await assert.rejects(api("/shipments"), {
    message: "Request failed (502). Please try again.",
  });
});
