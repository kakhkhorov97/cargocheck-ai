import PDFDocument from "pdfkit";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "../samples");
await mkdir(root, { recursive: true });
for (const kind of ["invoice", "packing"] as const) {
  const pdf = new PDFDocument({ size: "A4", margin: 48 });
  const file = createWriteStream(path.join(root, `${kind}.pdf`));
  pdf.pipe(file);
  pdf
    .fillColor("#0b6e6d")
    .fontSize(10)
    .text("SYNTHETIC SAMPLE / CARGOCHECK AI")
    .moveDown(2);
  pdf
    .fillColor("#13284a")
    .fontSize(24)
    .text(kind === "invoice" ? "COMMERCIAL INVOICE" : "PACKING LIST")
    .moveDown();
  pdf
    .fillColor("#36465d")
    .fontSize(11)
    .text("Shipment reference: SH-001")
    .moveDown(0.6)
    .text("Seller: Sample Export Co.")
    .text("Consignee: Sample Import Co.")
    .text("Consignee address: 45 Market Street, Sample Town")
    .text("Currency: USD")
    .moveDown(2);
  pdf.fontSize(11).fillColor("#13284a").text("LINE ITEMS").moveDown();
  pdf
    .font("Courier")
    .fontSize(8.5)
    .fillColor("#333333")
    .text("Code | Description | Quantity | Unit | Unit price | Line total")
    .moveDown();
  pdf.text(
    kind === "invoice"
      ? "BOOK-01 | Children's Book | 100 | pieces | 2.50 | 250.00"
      : "BOOK-01 | Children's Book | 90 | pieces | | ",
  );
  if (kind === "packing")
    pdf
      .moveDown(2)
      .font("Helvetica")
      .fontSize(10)
      .text("Packages: 9 cartons")
      .text("Net weight: 45 kg");
  pdf
    .font("Helvetica")
    .fontSize(9)
    .fillColor("#667085")
    .text("Fictional training document. Not a commercial record.", 48, 730);
  pdf.end();
  await new Promise<void>((resolve, reject) => {
    file.on("finish", resolve);
    file.on("error", reject);
  });
  console.log(`Generated samples/${kind}.pdf`);
}
