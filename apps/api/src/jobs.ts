import { Queue, Worker } from "bullmq";
import { Store } from "./store";
import { extractDocument } from "./extraction";
import type { DocKind } from "@cargo/shared";
export class Jobs {
  private queue?: Queue;
  private worker?: Worker;
  private active = new Set<string>();
  constructor(private store: Store) {}
  async init() {
    if (process.env.REDIS_URL) {
      const u = new URL(process.env.REDIS_URL);
      const connection = {
        host: u.hostname,
        port: Number(u.port || 6379),
        username: u.username || undefined,
        password: u.password || undefined,
        tls: u.protocol === "rediss:" ? {} : undefined,
      };
      this.queue = new Queue("cargo-extraction", { connection });
      this.worker = new Worker(
        "cargo-extraction",
        async (job) =>
          this.process(job.data.shipmentId, job.data.kind, job.data.documentId),
        { connection, concurrency: 2 },
      );
      this.worker.on("error", (e) =>
        console.error("Extraction worker:", e.message),
      );
    }
    const pending = await this.store.transaction((s) =>
      s.shipments.flatMap((x) =>
        Object.values(x.documents)
          .filter((d) => d.status === "queued" || d.status === "processing")
          .map((d) => ({ shipmentId: x.id, kind: d.kind, documentId: d.id })),
      ),
    );
    for (const j of pending)
      await this.enqueue(j.shipmentId, j.kind, j.documentId);
  }
  async enqueue(shipmentId: string, kind: DocKind, documentId: string) {
    if (this.queue) {
      await this.queue.add(
        "extract",
        { shipmentId, kind, documentId },
        {
          jobId: documentId,
          attempts: 3,
          backoff: { type: "exponential", delay: 1000 },
          removeOnComplete: 100,
          removeOnFail: 100,
        },
      );
      return;
    }
    if (this.active.has(documentId)) return;
    this.active.add(documentId);
    void (async () => {
      try {
        for (let n = 0; n < 3; n++) {
          try {
            await this.process(shipmentId, kind, documentId);
            break;
          } catch {
            if (n < 2) await new Promise((r) => setTimeout(r, 500 * (n + 1)));
          }
        }
      } finally {
        this.active.delete(documentId);
      }
    })();
  }
  async process(shipmentId: string, kind: DocKind, documentId: string) {
    const doc = await this.store.transaction((s) => {
      const x = s.shipments.find((x) => x.id === shipmentId),
        d = x?.documents[kind];
      if (!x || !d || d.id !== documentId || d.status === "ready") return null;
      d.status = "processing";
      d.attempts++;
      x.version++;
      x.updatedAt = new Date().toISOString();
      return structuredClone(d);
    });
    if (!doc) return;
    try {
      const output = await extractDocument(doc);
      await this.store.transaction((s) => {
        const x = s.shipments.find((x) => x.id === shipmentId),
          d = x?.documents[kind];
        if (!x || !d || d.id !== documentId) return;
        Object.assign(d, output, { status: "ready", error: undefined });
        x.checks = [];
        x.reviewStatus = "in_progress";
        x.version++;
        x.updatedAt = new Date().toISOString();
        x.history.push({
          at: x.updatedAt,
          by: "system",
          action: "extraction_completed",
          detail: `${kind}: ${output.provider}; values require human confirmation.`,
        });
      });
    } catch (e) {
      await this.store.transaction((s) => {
        const x = s.shipments.find((x) => x.id === shipmentId),
          d = x?.documents[kind];
        if (!x || !d || d.id !== documentId) return;
        d.status = "failed";
        d.error = (e as Error).message.slice(0, 500);
        x.version++;
        x.updatedAt = new Date().toISOString();
      });
      throw e;
    }
  }
  async close() {
    await this.worker?.close();
    await this.queue?.close();
  }
}
