import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import type { State } from "@cargo/shared";
import { validateProductionDatabase } from "./production-config";

const empty = (): State => ({ users: [], sessions: [], shipments: [] });
// Explicit, idempotent migration: legacy accounts must prove email ownership.
// Keep users and shipments; revoke sessions that predate verification.
function migrate(state: State) {
  state.emailVerifications ??= [];
  const emails = new Set<string>();
  for (const user of state.users) {
    user.email = user.email.trim().toLowerCase();
    if (emails.has(user.email))
      throw new Error(
        "Account migration blocked: duplicate normalized emails require administrator resolution. No accounts were deleted.",
      );
    emails.add(user.email);
    user.emailVerifiedAt ??= null;
  }
  state.sessions = state.sessions.filter((session) =>
    state.users.some(
      (user) => user.id === session.userId && user.emailVerifiedAt,
    ),
  );
}
export class Store {
  private tail: Promise<unknown> = Promise.resolve();
  private pool?: Pool;
  readonly root = path.resolve(process.env.DATA_DIR ?? "../../data");
  async init() {
    validateProductionDatabase();
    await mkdir(path.join(this.root, "files"), {
      recursive: true,
      mode: 0o700,
    });
    if (process.env.DATABASE_URL) {
      this.pool = new Pool({ connectionString: process.env.DATABASE_URL });
      await this.pool.query(
        "CREATE TABLE IF NOT EXISTS cargo_state (id INTEGER PRIMARY KEY, data JSONB NOT NULL)",
      );
      await this.pool.query(
        "INSERT INTO cargo_state(id,data) VALUES(1,$1) ON CONFLICT DO NOTHING",
        [JSON.stringify(empty())],
      );
    }
    await this.transaction(() => {});
  }
  async transaction<T>(fn: (s: State) => T | Promise<T>): Promise<T> {
    const run = this.tail.then(async () => {
      if (this.pool) {
        const c = await this.pool.connect();
        try {
          await c.query("BEGIN");
          const { rows } = await c.query(
            "SELECT data FROM cargo_state WHERE id=1 FOR UPDATE",
          );
          const state = rows[0].data as State;
          migrate(state);
          const result = await fn(state);
          const detached = structuredClone(result);
          await c.query("UPDATE cargo_state SET data=$1 WHERE id=1", [
            JSON.stringify(state),
          ]);
          await c.query("COMMIT");
          return detached;
        } catch (e) {
          await c.query("ROLLBACK");
          throw e;
        } finally {
          c.release();
        }
      }
      const file = path.join(this.root, "state.json");
      let s: State;
      try {
        s = JSON.parse(await readFile(file, "utf8"));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        s = empty();
      }
      migrate(s);
      const result = await fn(s);
      const tmp = file + ".tmp";
      await writeFile(tmp, JSON.stringify(s), { mode: 0o600 });
      await rename(tmp, file);
      return structuredClone(result);
    });
    this.tail = run.catch(() => {});
    return run;
  }
  async close() {
    await this.tail;
    await this.pool?.end();
  }
}
