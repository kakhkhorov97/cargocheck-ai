import { z } from "zod";
import Decimal from "decimal.js";

export const sourceSchema = z
  .object({
    page: z.number().int().min(1).max(100),
    line: z.number().int().min(1),
    text: z.string().max(2000),
  })
  .strict();
export const fieldSchema = z
  .object({
    value: z.string().max(2000).nullable(),
    source: sourceSchema.nullable(),
    confirmed: z.boolean().default(false),
    originalValue: z.string().nullable().optional(),
  })
  .strict();
export const itemSchema = z
  .object({
    code: fieldSchema,
    description: fieldSchema,
    quantity: fieldSchema,
    unit: fieldSchema,
    unitPrice: fieldSchema,
    lineTotal: fieldSchema,
  })
  .strict();
export const extractionSchema = z
  .object({
    shipmentRef: fieldSchema,
    seller: fieldSchema,
    consignee: fieldSchema,
    address: fieldSchema,
    currency: fieldSchema,
    items: z.array(itemSchema).max(200),
  })
  .strict();
export type Field = z.infer<typeof fieldSchema>;
export type Extraction = z.infer<typeof extractionSchema>;
export type DocKind = "invoice" | "packing";
export interface DocumentRecord {
  id: string;
  kind: DocKind;
  filename: string;
  mime: string;
  size: number;
  sha256: string;
  path: string;
  status: "queued" | "processing" | "ready" | "failed";
  attempts: number;
  error?: string;
  provider: string;
  extraction?: Extraction;
  pages: string[];
  uploadedAt: string;
}
export type CheckStatus =
  "passed" | "discrepancy" | "needs_review" | "not_compared";
export interface Decision {
  outcome: "accepted" | "unresolved" | "false_positive";
  note: string;
  at: string;
  by: string;
}
export interface Check {
  id: string;
  title: string;
  status: CheckStatus;
  message: string;
  invoice: string | null;
  packing: string | null;
  invoiceSource?: Field["source"];
  packingSource?: Field["source"];
  decision?: Decision;
}
export interface AuditEvent {
  at: string;
  by: string;
  action: string;
  detail: string;
}
export interface Shipment {
  id: string;
  ownerId: string;
  reference: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  reviewStatus: "in_progress" | "reviewed";
  documents: Partial<Record<DocKind, DocumentRecord>>;
  checks: Check[];
  history: AuditEvent[];
  synthetic: boolean;
}
export interface User {
  id: string;
  email: string;
  name: string;
  password: string;
  emailVerifiedAt?: string | null;
  verificationRequestedAt?: number;
}
export interface EmailVerification {
  hash: string;
  userId: string;
  expiresAt: number;
  accepted: boolean;
  usedAt?: number;
  invalidatedAt?: number;
}
export interface State {
  users: User[];
  sessions: { hash: string; userId: string; expiresAt: number }[];
  shipments: Shipment[];
  emailVerifications?: EmailVerification[];
}
export const emptyField = (): Field => ({
  value: null,
  source: null,
  confirmed: false,
});
export const blankExtraction = (): Extraction => ({
  shipmentRef: emptyField(),
  seller: emptyField(),
  consignee: emptyField(),
  address: emptyField(),
  currency: emptyField(),
  items: [],
});
export function allFields(e: Extraction): Field[] {
  return [
    e.shipmentRef,
    e.seller,
    e.consignee,
    e.address,
    e.currency,
    ...e.items.flatMap((i) => Object.values(i)),
  ];
}
export function isConfirmed(s: Shipment): boolean {
  return (["invoice", "packing"] as const).every((k) => {
    const d = s.documents[k];
    return (
      d?.status === "ready" &&
      d.extraction &&
      allFields(d.extraction).every((f) => f.confirmed)
    );
  });
}
const normalized = (s: string | null) =>
  s?.trim().replace(/\s+/g, " ").toLowerCase() ?? null;
const unit = (s: string | null) =>
  ({
    pcs: "pieces",
    piece: "pieces",
    pieces: "pieces",
    kg: "kg",
    kgs: "kg",
    kilograms: "kg",
    kilogram: "kg",
  })[normalized(s) ?? ""] ?? normalized(s);
function decimal(v: string | null): Decimal | null {
  try {
    if (v === null || !/^\d+(\.\d+)?$/.test(v.trim())) return null;
    const n = new Decimal(v);
    return n.isFinite() && n.gte(0) ? n : null;
  } catch {
    return null;
  }
}

export function validateShipment(s: Shipment): Check[] {
  const a = s.documents.invoice?.extraction,
    b = s.documents.packing?.extraction;
  if (!a || !b) return [];
  const result: Check[] = [];
  const add = (c: Check) => {
    const old = s.checks.find((x) => x.id === c.id);
    if (
      old &&
      old.status === c.status &&
      old.invoice === c.invoice &&
      old.packing === c.packing &&
      old.message === c.message
    )
      c.decision = old.decision;
    result.push(c);
  };
  const pair = (
    id: string,
    title: string,
    x: Field,
    y: Field,
    soft = false,
  ) => {
    const missing = !x.value?.trim() || !y.value?.trim();
    const eq = !missing && normalized(x.value) === normalized(y.value);
    add({
      id,
      title,
      status: missing
        ? "needs_review"
        : eq
          ? "passed"
          : soft
            ? "needs_review"
            : "discrepancy",
      message: missing
        ? "A required value is missing. Confirm against the original documents."
        : eq
          ? "Values match."
          : soft
            ? "Formatting or content differs; a reviewer must decide."
            : "Document values differ.",
      invoice: x.value,
      packing: y.value,
      invoiceSource: x.source,
      packingSource: y.source,
    });
  };
  pair("reference", "Shipment reference", a.shipmentRef, b.shipmentRef);
  pair("seller", "Seller", a.seller, b.seller, true);
  pair("consignee", "Consignee", a.consignee, b.consignee, true);
  pair("address", "Consignee address", a.address, b.address, true);
  if (!a.items.length || !b.items.length)
    add({
      id: "items",
      title: "Line items",
      status: "needs_review",
      message:
        "At least one document has no extracted line items. Add or confirm them before relying on comparisons.",
      invoice: String(a.items.length),
      packing: String(b.items.length),
    });
  const codes = [
    ...new Set(
      [...a.items, ...b.items]
        .map((i) => normalized(i.code.value))
        .filter((c): c is string => !!c),
    ),
  ];
  for (const k of ["invoice", "packing"] as const) {
    const e = k === "invoice" ? a : b;
    e.items.forEach((i, n) => {
      if (!i.code.value?.trim())
        add({
          id: `missing-code-${k}-${n}`,
          title: `Product code · ${k} line ${n + 1}`,
          status: "needs_review",
          message:
            "Missing product code. Product identity must be confirmed manually.",
          invoice: k === "invoice" ? i.description.value : null,
          packing: k === "packing" ? i.description.value : null,
        });
    });
  }
  for (const code of codes) {
    const aa = a.items.filter((i) => normalized(i.code.value) === code),
      bb = b.items.filter((i) => normalized(i.code.value) === code),
      name = aa[0]?.code.value ?? bb[0]?.code.value ?? code;
    if (aa.length !== 1 || bb.length !== 1) {
      add({
        id: `match-${code}`,
        title: `Product match · ${name}`,
        status: "needs_review",
        message:
          aa.length > 1 || bb.length > 1
            ? "Duplicate product codes make this match ambiguous; no quantities were summed."
            : "Product is absent from one document.",
        invoice: String(aa.length) + " matching lines",
        packing: String(bb.length) + " matching lines",
      });
      continue;
    }
    const x = aa[0],
      y = bb[0];
    pair(`code-${code}`, `Product code · ${name}`, x.code, y.code);
    const sameUnit =
      !!unit(x.unit.value) && unit(x.unit.value) === unit(y.unit.value);
    add({
      id: `unit-${code}`,
      title: `Unit compatibility · ${name}`,
      status: sameUnit ? "passed" : "needs_review",
      message: sameUnit
        ? "Units are compatible."
        : "Units differ or are missing. No automatic conversion is applied.",
      invoice: x.unit.value,
      packing: y.unit.value,
      invoiceSource: x.unit.source,
      packingSource: y.unit.source,
    });
    const qx = decimal(x.quantity.value),
      qy = decimal(y.quantity.value);
    const valid = !!qx && !!qy;
    add({
      id: `quantity-${code}`,
      title: `Quantity · ${name}`,
      status: !sameUnit
        ? "not_compared"
        : !valid
          ? "needs_review"
          : qx!.eq(qy!)
            ? "passed"
            : "discrepancy",
      message: !sameUnit
        ? "Cannot compare quantities with incompatible or missing units."
        : !valid
          ? "Quantity must be an explicit, non-negative decimal."
          : qx!.eq(qy!)
            ? "Quantities agree."
            : "Quantities for the same product and compatible unit differ.",
      invoice: x.quantity.value,
      packing: y.quantity.value,
      invoiceSource: x.quantity.source,
      packingSource: y.quantity.source,
    });
  }
  a.items.forEach((i, n) => {
    const q = decimal(i.quantity.value),
      p = decimal(i.unitPrice.value),
      t = decimal(i.lineTotal.value);
    const currency = a.currency.value?.trim();
    const valid = q && p && t;
    add({
      id: `arithmetic-${n}`,
      title: `Invoice arithmetic · ${i.code.value ?? `line ${n + 1}`}`,
      status:
        !valid || !currency
          ? "needs_review"
          : q!.mul(p!).eq(t!)
            ? "passed"
            : "discrepancy",
      message:
        !valid || !currency
          ? "Quantity, price, total and currency are required for an arithmetic check."
          : `${q!.toString()} × ${p!.toString()} = ${q!.mul(p!).toString()} ${currency}; stated ${t!.toString()} ${currency}.`,
      invoice: i.lineTotal.value,
      packing: null,
      invoiceSource: i.lineTotal.source,
    });
  });
  add({
    id: "weight",
    title: "Net weight",
    status: "not_compared",
    message:
      "Net weight extraction and comparison are outside this first release.",
    invoice: null,
    packing: null,
  });
  return result;
}
export function processingStatus(s: Shipment): string {
  const docs = Object.values(s.documents);
  return docs.length < 2
    ? "Awaiting documents"
    : docs.some((d) => d.status === "failed")
      ? "Processing failed"
      : docs.some((d) => d.status === "processing" || d.status === "queued")
        ? "Processing"
        : !isConfirmed(s)
          ? "Needs confirmation"
          : "Complete";
}
