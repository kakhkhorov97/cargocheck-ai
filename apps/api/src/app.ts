import "reflect-metadata";
import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Req,
  Res,
  Inject,
  UseInterceptors,
  UploadedFile,
  HttpException,
  Module,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Request, Response } from "express";
import {
  randomBytes,
  randomUUID,
  createHash,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import PDFDocument from "pdfkit";
import { z } from "zod";
import {
  blankExtraction,
  emptyField,
  allFields,
  isConfirmed,
  validateShipment,
  processingStatus,
} from "@cargo/shared";
import type {
  State,
  Shipment,
  DocKind,
  Field,
  DocumentRecord,
  User,
} from "@cargo/shared";
import { Store } from "./store";
import { Jobs } from "./jobs";
import { emailInput, normalizeEmail } from "./auth-input";

export const store = new Store();
export const jobs = new Jobs(store);
const fail = (message: string, code = 400): never => {
  throw new HttpException(message, code);
};
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
const now = () => new Date().toISOString();
const credentials = z.object({
  email: emailInput,
  password: z.string().min(10).max(128),
  name: z.string().trim().min(1).max(80).optional(),
});
const safeDoc = (d: DocumentRecord) => {
  const { path: _, ...rest } = d;
  return rest;
};
function safeShipment(s: Shipment) {
  return {
    ...s,
    documents: Object.fromEntries(
      Object.entries(s.documents).map(([k, d]) => [k, safeDoc(d)]),
    ),
  };
}
function owner(s: State, req: Request): User {
  const session = s.sessions.find(
    (x) =>
      x.hash === hash(req.cookies?.cargo_session ?? "") &&
      x.expiresAt > Date.now(),
  );
  if (!session) fail("Please sign in.", 401);
  const user =
    s.users.find((x) => x.id === session!.userId) ??
    fail("Please sign in.", 401);
  return user;
}
function shipment(s: State, req: Request, id: string): Shipment {
  const u = owner(s, req);
  return (
    s.shipments.find((x) => x.id === id && x.ownerId === u.id) ??
    fail("Shipment not found.", 404)
  );
}
function changed(s: Shipment, req: Request, action: string, detail: string) {
  s.version++;
  s.updatedAt = now();
  s.reviewStatus = "in_progress";
  s.history.push({ at: s.updatedAt, by: "reviewer", action, detail });
}
function version(s: Shipment, v: unknown) {
  if (v !== s.version) fail("This review changed. Refresh and try again.", 409);
}
function kindOf(k: string): DocKind {
  if (k !== "invoice" && k !== "packing") fail("Unknown document type.");
  return k as DocKind;
}
function fieldAt(d: DocumentRecord, key: string): Field {
  const e = d.extraction ?? fail("Extraction is not ready.");
  const match = key.match(
    /^items\.(\d+)\.(code|description|quantity|unit|unitPrice|lineTotal)$/,
  );
  if (match) {
    const i = e.items[Number(match[1])];
    if (!i) fail("Line item not found.");
    return i[match[2] as keyof typeof i];
  }
  if (
    ["shipmentRef", "seller", "consignee", "address", "currency"].includes(key)
  )
    return e[key as "shipmentRef"];
  return fail("Unknown field.");
}

@Controller("api")
export class ApiController {
  constructor(
    @Inject("STORE") private db: Store,
    @Inject("JOBS") private work: Jobs,
  ) {}
  private async enqueueExtraction(
    id: string,
    kind: DocKind,
    documentId: string,
  ) {
    try {
      await this.work.enqueue(id, kind, documentId);
    } catch {
      await this.db.transaction((s) => {
        const x = s.shipments.find((x) => x.id === id);
        const d = x?.documents[kind];
        if (!x || !d || d.id !== documentId || d.status !== "queued") return;
        d.status = "failed";
        d.error = "Could not queue extraction. Check Redis and retry.";
        x.version++;
        x.updatedAt = now();
      });
    }
  }
  @Get("health") health() {
    return {
      ok: true,
      version: "0.1.0",
      extraction:
        process.env.EXTRACTION_PROVIDER === "gemini" ? "gemini" : "local",
      storage: process.env.DATABASE_URL ? "postgresql" : "local-file",
      queue: process.env.REDIS_URL ? "redis" : "in-process",
      cloudConfigured: !!(
        process.env.GEMINI_API_KEY && process.env.GEMINI_MODEL
      ),
    };
  }
  @Get("auth/me") me(@Req() req: Request) {
    return this.db.transaction((s) => {
      const { id, email, name } = owner(s, req);
      return { id, email, name };
    });
  }
  @Post("auth/register") register(
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.auth(body, res, true);
  }
  @Post("auth/login") login(
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.auth(body, res, false);
  }
  private async auth(body: unknown, res: Response, register: boolean) {
    const c = credentials.parse(body);
    const token = randomBytes(32).toString("hex");
    const user = await this.db.transaction((s) => {
      let u = s.users.find((x) => normalizeEmail(x.email) === c.email);
      if (register) {
        if (u)
          return fail(
            "An account already exists for this email. Sign in instead.",
            409,
          );
        const salt = randomBytes(16).toString("hex");
        u = {
          id: randomUUID(),
          email: c.email,
          name: c.name ?? c.email.split("@")[0],
          password:
            salt + ":" + scryptSync(c.password, salt, 64).toString("hex"),
          // Password authentication does not establish email ownership.
          emailVerifiedAt: null,
        };
        s.users.push(u);
      } else {
        const [salt, h] = u?.password.split(":") ?? [
          "missing",
          "00".repeat(64),
        ];
        if (
          !timingSafeEqual(
            scryptSync(c.password, salt, 64),
            Buffer.from(h, "hex"),
          ) ||
          !u
        )
          return fail("Email or password is incorrect.", 401);
      }
      s.sessions = s.sessions.filter((x) => x.expiresAt > Date.now());
      s.sessions.push({
        hash: hash(token),
        userId: u.id,
        expiresAt: Date.now() + 7 * 86400000,
      });
      return { id: u.id, name: u.name, email: u.email };
    });
    res.cookie("cargo_session", token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.COOKIE_SECURE === "true",
      maxAge: 7 * 86400000,
      path: "/",
    });
    return user;
  }
  @Post("auth/logout") async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.db.transaction((s) => {
      s.sessions = s.sessions.filter(
        (x) => x.hash !== hash(req.cookies?.cargo_session ?? ""),
      );
    });
    res.clearCookie("cargo_session", { path: "/" });
    return { ok: true };
  }
  @Get("shipments") list(@Req() req: Request) {
    return this.db.transaction((s) => {
      const u = owner(s, req);
      return s.shipments
        .filter((x) => x.ownerId === u.id)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map(safeShipment);
    });
  }
  @Get("samples/:kind") async sampleFile(
    @Param("kind") k: string,
    @Res() res: Response,
    @Req() req: Request,
  ) {
    await this.db.transaction((s) => owner(s, req));
    const kind = kindOf(k);
    res
      .type("application/pdf")
      .attachment(`sample-${kind}.pdf`)
      .send(
        await readFile(
          path.resolve(
            import.meta.dirname,
            `../../..`,
            "samples",
            `${kind}.pdf`,
          ),
        ),
      );
  }
  @Post("sample") async sample(@Req() req: Request) {
    const x = await this.db.transaction(async (s) => {
      const u = owner(s, req);
      const x: Shipment = {
        id: randomUUID(),
        ownerId: u.id,
        reference: "SH-001",
        createdAt: now(),
        updatedAt: now(),
        version: 1,
        reviewStatus: "in_progress",
        documents: {},
        checks: [],
        history: [
          {
            at: now(),
            by: "system",
            action: "sample_created",
            detail:
              "Synthetic sample PDFs sent through the real extraction pipeline.",
          },
        ],
        synthetic: true,
      };
      for (const kind of ["invoice", "packing"] as const) {
        const b = await readFile(
          path.resolve(
            import.meta.dirname,
            "../../..",
            "samples",
            `${kind}.pdf`,
          ),
        );
        const documentId = randomUUID(),
          target = path.join(this.db.root, "files", documentId);
        await writeFile(target, b, { mode: 0o600 });
        x.documents[kind] = {
          id: documentId,
          kind,
          filename: `sample-${kind}.pdf`,
          mime: "application/pdf",
          size: b.length,
          sha256: createHash("sha256").update(b).digest("hex"),
          path: target,
          status: "queued",
          attempts: 0,
          provider: "pending",
          pages: [],
          uploadedAt: now(),
        };
      }
      s.shipments.push(x);
      return x;
    });
    for (const d of Object.values(x.documents))
      await this.enqueueExtraction(x.id, d.kind, d.id);
    return this.get(x.id, req);
  }
  @Post("shipments") create(@Body() body: unknown, @Req() req: Request) {
    const { reference } = z
      .object({ reference: z.string().trim().min(1).max(80) })
      .parse(body);
    return this.db.transaction((s) => {
      const u = owner(s, req);
      const x: Shipment = {
        id: randomUUID(),
        ownerId: u.id,
        reference,
        createdAt: now(),
        updatedAt: now(),
        version: 1,
        reviewStatus: "in_progress",
        documents: {},
        checks: [],
        history: [
          {
            at: now(),
            by: "reviewer",
            action: "created",
            detail: "Shipment review created.",
          },
        ],
        synthetic: false,
      };
      s.shipments.push(x);
      return safeShipment(x);
    });
  }
  @Get("shipments/:id") get(@Param("id") id: string, @Req() req: Request) {
    return this.db.transaction((s) => safeShipment(shipment(s, req, id)));
  }
  @Post("shipments/:id/documents/:kind")
  @UseInterceptors(
    FileInterceptor("file", {
      limits: { fileSize: 10 * 1024 * 1024, files: 1 },
    }),
  )
  async upload(
    @Param("id") id: string,
    @Param("kind") k: string,
    @UploadedFile() file: Express.Multer.File,
    @Req() req: Request,
  ) {
    const kind = kindOf(k);
    if (!file) fail("Choose a document.");
    const b = file.buffer;
    const mime =
      b.subarray(0, 5).toString() === "%PDF-"
        ? "application/pdf"
        : b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff
          ? "image/jpeg"
          : b
                .subarray(0, 8)
                .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
            ? "image/png"
            : null;
    if (
      !mime ||
      !["application/pdf", "image/jpeg", "image/png"].includes(file.mimetype)
    )
      fail(
        "Only PDF, JPG and PNG documents with valid signatures are accepted.",
      );
    const documentId = randomUUID();
    const filename =
      path
        .basename(file.originalname)
        .replace(/[\r\n\x00-\x1f]/g, "")
        .slice(0, 180) || "document";
    const target = path.join(this.db.root, "files", documentId);
    await this.db.transaction(async (s) => {
      const x = shipment(s, req, id);
      version(x, Number(req.body.version));
      if (
        x.documents[kind]?.status === "queued" ||
        x.documents[kind]?.status === "processing"
      )
        fail(
          "Wait for this extraction to finish before replacing the document.",
          409,
        );
      await writeFile(target, b, { mode: 0o600, flag: "wx" });
      x.documents[kind] = {
        id: documentId,
        kind,
        filename,
        mime: mime!,
        size: b.length,
        sha256: createHash("sha256").update(b).digest("hex"),
        path: target,
        status: "queued",
        attempts: 0,
        provider:
          process.env.EXTRACTION_PROVIDER === "gemini"
            ? "Gemini"
            : "Local OCR + labelled-template parser",
        pages: [],
        uploadedAt: now(),
      };
      x.checks = [];
      changed(x, req, "uploaded", `${kind}: ${filename}`);
      return safeShipment(x);
    });
    await this.enqueueExtraction(id, kind, documentId);
    return this.get(id, req);
  }
  @Get("shipments/:id/documents/:kind/file") async file(
    @Param("id") id: string,
    @Param("kind") k: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const doc = await this.db.transaction(
      (s) =>
        shipment(s, req, id).documents[kindOf(k)] ??
        fail("Document not found.", 404),
    );
    res.set({
      "Content-Type": doc.mime,
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(doc.filename)}`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.send(await readFile(doc.path));
  }
  @Post("shipments/:id/documents/:kind/retry") async retry(
    @Param("id") id: string,
    @Param("kind") k: string,
    @Body() body: { version: number },
    @Req() req: Request,
  ) {
    const kind = kindOf(k);
    const doc = await this.db.transaction((s) => {
      const x = shipment(s, req, id);
      version(x, body.version);
      const d = x.documents[kind] ?? fail("Document not found.", 404);
      if (d.status !== "failed") fail("Only failed extraction can be retried.");
      const previous = d.id;
      d.id = randomUUID();
      d.status = "queued";
      d.attempts = 0;
      d.error = undefined;
      changed(x, req, "retry", `${kind}; previous extraction ${previous}`);
      return d;
    });
    await this.enqueueExtraction(id, kind, doc.id);
    return { ok: true };
  }
  @Patch("shipments/:id/fields") update(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const c = z
      .object({
        version: z.number().int(),
        kind: z.enum(["invoice", "packing"]),
        path: z.string().max(100),
        value: z.string().max(2000).nullable(),
      })
      .parse(body);
    return this.db.transaction((s) => {
      const x = shipment(s, req, id);
      version(x, c.version);
      const d = x.documents[c.kind] ?? fail("Document not found.");
      if (d.status !== "ready") fail("Extraction is not ready.");
      const f = fieldAt(d, c.path);
      const old = f.value;
      if (f.originalValue === undefined) f.originalValue = old;
      f.value = c.value?.trim() || null;
      f.confirmed = true;
      changed(
        x,
        req,
        "field_confirmed",
        `${c.kind}.${c.path}: ${old ?? "Not stated"} → ${f.value ?? "Not stated"}`,
      );
      x.checks = validateShipment(x);
      return safeShipment(x);
    });
  }
  @Post("shipments/:id/documents/:kind/confirm") confirm(
    @Param("id") id: string,
    @Param("kind") k: string,
    @Body() body: { version: number },
    @Req() req: Request,
  ) {
    return this.db.transaction((s) => {
      const x = shipment(s, req, id);
      version(x, body.version);
      const d = x.documents[kindOf(k)] ?? fail("Document not found.");
      if (d.status !== "ready" || !d.extraction)
        fail("Extraction is not ready.");
      allFields(d.extraction!).forEach((f) => (f.confirmed = true));
      changed(
        x,
        req,
        "document_confirmed",
        `${k}: reviewer confirmed extracted values, including missing fields.`,
      );
      x.checks = validateShipment(x);
      return safeShipment(x);
    });
  }
  @Post("shipments/:id/documents/:kind/items") item(
    @Param("id") id: string,
    @Param("kind") k: string,
    @Body() body: { version: number },
    @Req() req: Request,
  ) {
    return this.db.transaction((s) => {
      const x = shipment(s, req, id);
      version(x, body.version);
      const d = x.documents[kindOf(k)] ?? fail("Document not found.");
      if (d.status !== "ready") fail("Extraction is not ready.");
      d.extraction ??= blankExtraction();
      if (d.extraction.items.length >= 200) fail("Maximum 200 lines.");
      d.extraction.items.push({
        code: emptyField(),
        description: emptyField(),
        quantity: emptyField(),
        unit: emptyField(),
        unitPrice: emptyField(),
        lineTotal: emptyField(),
      });
      changed(
        x,
        req,
        "item_added",
        `${k}: manual line added without source location.`,
      );
      x.checks = validateShipment(x);
      return safeShipment(x);
    });
  }
  @Post("shipments/:id/validate") validate(
    @Param("id") id: string,
    @Body() body: { version: number },
    @Req() req: Request,
  ) {
    return this.db.transaction((s) => {
      const x = shipment(s, req, id);
      version(x, body.version);
      if (
        Object.values(x.documents).length !== 2 ||
        Object.values(x.documents).some((d) => d.status !== "ready")
      )
        fail("Both documents must finish processing.");
      x.checks = validateShipment(x);
      changed(
        x,
        req,
        "checks_run",
        "Validation rules v0.1 ran. Unconfirmed values are provisional.",
      );
      return safeShipment(x);
    });
  }
  @Post("shipments/:id/decisions/:checkId") decide(
    @Param("id") id: string,
    @Param("checkId") checkId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const c = z
      .object({
        version: z.number().int(),
        outcome: z.enum(["accepted", "unresolved", "false_positive"]),
        note: z.string().trim().min(5).max(2000),
      })
      .parse(body);
    return this.db.transaction((s) => {
      const x = shipment(s, req, id);
      version(x, c.version);
      const check =
        x.checks.find((c) => c.id === checkId) ?? fail("Check not found.", 404);
      if (check.status === "passed" || check.status === "not_compared")
        fail("This check does not need a decision.");
      check.decision = {
        outcome: c.outcome,
        note: c.note,
        at: now(),
        by: owner(s, req).name,
      };
      changed(
        x,
        req,
        "decision_recorded",
        `${check.title}: ${c.outcome}. ${c.note}`,
      );
      return safeShipment(x);
    });
  }
  @Post("shipments/:id/complete") complete(
    @Param("id") id: string,
    @Body() body: { version: number },
    @Req() req: Request,
  ) {
    return this.db.transaction((s) => {
      const x = shipment(s, req, id);
      version(x, body.version);
      if (!isConfirmed(x))
        fail("Confirm both documents before completing the review.");
      x.checks = validateShipment(x);
      if (
        !x.checks.length ||
        x.checks.some(
          (c) =>
            (c.status === "discrepancy" || c.status === "needs_review") &&
            !c.decision,
        )
      )
        fail("Record a decision for each discrepancy and review item.");
      changed(
        x,
        req,
        "review_completed",
        "All flagged items have recorded decisions; this does not certify shipment approval.",
      );
      x.reviewStatus = "reviewed";
      return safeShipment(x);
    });
  }
  @Get("shipments/:id/export") async export(
    @Param("id") id: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const x = await this.db.transaction((s) => shipment(s, req, id));
    const pdf = new PDFDocument({ size: "A4", margin: 45 });
    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": 'attachment; filename="CargoCheck-review.pdf"',
      "Cache-Control": "no-store",
    });
    pdf.pipe(res);
    pdf.fontSize(23).fillColor("#13284a").text("CargoCheck AI");
    pdf.fontSize(15).text("Shipment review report").moveDown();
    pdf
      .fontSize(10)
      .fillColor("#333333")
      .text(`Shipment: ${x.reference}`)
      .text(`Exported: ${now()}`)
      .text(
        `Processing: ${processingStatus(x)} | Human review: ${x.reviewStatus}`,
      )
      .text(
        `Data: ${x.synthetic ? "Synthetic sample" : "User-uploaded documents"}`,
      )
      .moveDown();
    pdf
      .text(
        "Review evidence only. Reviewed may include unresolved discrepancies. This report is not customs certification or shipment approval.",
      )
      .moveDown();
    if (!x.checks.length) pdf.text("No checks have run yet.");
    for (const c of x.checks) {
      if (pdf.y > 650) pdf.addPage();
      pdf.fontSize(12).fillColor("#13284a").text(`${c.title} [${c.status}]`);
      pdf
        .fontSize(10)
        .fillColor("#333333")
        .text(c.message)
        .text(
          `Invoice: ${c.invoice ?? "Not stated"} | Packing list: ${c.packing ?? "Not stated"}`,
        );
      for (const [kind, source] of [
        ["Invoice", c.invoiceSource],
        ["Packing list", c.packingSource],
      ] as const)
        if (source)
          pdf.text(
            `${kind} source: page ${source.page}, extracted text line ${source.line}; ${source.text}`,
          );
      if (c.decision)
        pdf
          .text(`Decision: ${c.decision.outcome}. ${c.decision.note}`)
          .text(`Reviewer: ${c.decision.by} | ${c.decision.at}`);
      pdf.moveDown();
    }
    pdf.end();
  }
}
@Module({
  controllers: [ApiController],
  providers: [
    { provide: "STORE", useValue: store },
    { provide: "JOBS", useValue: jobs },
  ],
})
export class AppModule {}
