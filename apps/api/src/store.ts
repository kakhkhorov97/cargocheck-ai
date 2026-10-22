import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import type { State } from "@cargo/shared";
import { validateProductionDatabase } from "./production-config";

const empty = (): State => ({ users: [], sessions: [], shipments: [] });
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
          const result = await fn(state);
          await c.query("UPDATE cargo_state SET data=$1 WHERE id=1", [
            JSON.stringify(state),
          ]);
          await c.query("COMMIT");
          return result;
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
