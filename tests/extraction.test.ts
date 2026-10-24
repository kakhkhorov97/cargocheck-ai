import test from "node:test";
import assert from "node:assert/strict";
import {
  buildGeminiExtractionSchema,
  parseText,
} from "../apps/api/src/extraction";
import {
  blankExtraction,
  extractionSchema,
  itemSchema,
  validateShipment,
} from "@cargo/shared";
import { z } from "zod";
import type { Shipment, DocumentRecord } from "@cargo/shared";

test("local extraction preserves negative quantities for validation", () => {
  const invoice = parseText(["BOOK-01 | Book | -2.5 | pieces | 2 | -5"]);
  const packing = parseText(["BOOK-01 | Book | 2.5 | pieces"]);
  assert.equal(invoice.items[0].quantity.value, "-2.5");
  assert.equal(invoice.items[0].quantity.confirmed, false);
  assert.equal(invoice.items[0].quantity.source?.line, 1);

  const document = (extraction: typeof invoice): DocumentRecord => ({
    id: "doc",
    kind: "invoice",
    filename: "test.pdf",
    mime: "application/pdf",
    size: 1,
    sha256: "hash",
    path: "private",
    status: "ready",
    attempts: 1,
    provider: "local",
    pages: [],
    uploadedAt: "",
    extraction,
  });
  const shipment: Shipment = {
    id: "shipment",
    ownerId: "user",
    reference: "SH-001",
    createdAt: "",
    updatedAt: "",
    version: 1,
    reviewStatus: "in_progress",
    documents: {
      invoice: document(invoice),
      packing: { ...document(packing), kind: "packing" },
    },
    checks: [],
    history: [],
    synthetic: true,
  };
  assert.equal(
    validateShipment(shipment).find((c) => c.id === "quantity-book-01")?.status,
    "needs_review",
  );
});

test("local extraction still ignores table headers and nonnumeric rows", () => {
  const extraction = parseText([
    "Code | Description | Quantity | Unit\nBOOK-01 | Book | unknown | pieces",
  ]);
  assert.equal(extraction.items.length, 0);
});

test("Gemini schema omits only the provider-rejected item limit; application still enforces it", () => {
  const expected = z.toJSONSchema(extractionSchema);
  delete expected.$schema;
  delete expected.properties!.items.maxItems;
  assert.deepEqual(buildGeminiExtractionSchema(), expected);

  const extraction = blankExtraction();
  const item = itemSchema.parse({
    code: extraction.shipmentRef,
    description: extraction.shipmentRef,
    quantity: extraction.shipmentRef,
    unit: extraction.shipmentRef,
    unitPrice: extraction.shipmentRef,
    lineTotal: extraction.shipmentRef,
  });
  extraction.items = Array.from({ length: 200 }, () => structuredClone(item));
  assert.equal(extractionSchema.safeParse(extraction).success, true);
  extraction.items.push(structuredClone(item));
  assert.equal(extractionSchema.safeParse(extraction).success, false);
});
