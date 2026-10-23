import test from "node:test";
import assert from "node:assert/strict";
import type { State } from "@cargo/shared";
import { Store } from "../apps/api/src/store";

test("PostgreSQL transactions detach results from mutable state", async () => {
  const state: State = { users: [], sessions: [], shipments: [] };
  let persisted: State | undefined;
  let released = false;
  const client = {
    async query(sql: string, values?: string[]) {
      if (sql.startsWith("SELECT")) return { rows: [{ data: state }] };
      if (sql.startsWith("UPDATE")) persisted = JSON.parse(values![0]);
      return { rows: [] };
    },
    release() {
      released = true;
    },
  };
  const store = new Store();
  // Exercise the PostgreSQL transaction path without a running database.
  Object.assign(store, { pool: { connect: async () => client } });
  const result = await store.transaction((s) => {
    s.sessions.push({
      hash: "session-hash",
      userId: "reviewer",
      expiresAt: 123,
    });
    return s.sessions;
  });
  assert.deepEqual(result, persisted!.sessions);
  state.sessions[0].expiresAt = 456;
  assert.equal(result[0].expiresAt, 123);
  result[0].hash = "changed-by-caller";
  assert.equal(state.sessions[0].hash, "session-hash");
  assert.equal(released, true);
});
