import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import { ReportFormats } from "./report.constants.js";
import type {
  TReportCell,
  TReportColumn,
  TReportDocument,
  TReportFormat,
  TReportTable,
} from "./report.interface.js";

/* ------------------------------ cell helpers ------------------------------ */

const FONT_DIR = path.join(process.cwd(), "assets", "fonts");
// Hind Siliguri covers BOTH Latin (letters, digits, punctuation) and Bengali in one face.
// pdfkit has no per-glyph font fallback, so a Bengali-only face (e.g. Noto Sans Bengali)
// would draw every English word and number as an empty box.
const FONT_REGULAR = path.join(FONT_DIR, "HindSiliguri-Regular.ttf");
const FONT_BOLD = path.join(FONT_DIR, "HindSiliguri-Bold.ttf");

const isoDay = (date: Date): string => new Date(date).toISOString().slice(0, 10);

/** Text form of a cell for PDF / CSV (date → YYYY-MM-DD, number → plain string). */
const cellText = (cell: TReportCell): string => {
  if (cell === null || cell === undefined) return "";
  if (cell instanceof Date) return isoDay(cell);
  return String(cell);
};

/**
 * Formula-injection guard: a TEXT cell that begins with = + - @, a tab or a carriage
 * return gets a leading apostrophe so a spreadsheet never executes it. Numbers and dates
 * are written as typed values and stay as they are.
 */
const guardText = (value: string): string =>
  /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;

const pdfColumns = (columns: TReportColumn[]): TReportColumn[] => columns.filter((c) => c.pdf !== false);

/* --------------------------------- PDF ------------------------------------ */

const renderPdf = (doc: TReportDocument, outPath: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const pdf = new PDFDocument({ size: "A4", margin: 40, bufferPages: true });
    const stream = fs.createWriteStream(outPath);
    stream.on("error", reject);
    pdf.on("error", reject);
    stream.on("finish", () => resolve());
    pdf.pipe(stream);

    pdf.registerFont("body", FONT_REGULAR);
    pdf.registerFont("bold", FONT_BOLD);

    const left = pdf.page.margins.left;
    const right = pdf.page.width - pdf.page.margins.right;
    const bottom = pdf.page.height - pdf.page.margins.bottom;
    const contentWidth = right - left;

    const ensureSpace = (needed: number) => {
      if (pdf.y + needed > bottom) pdf.addPage();
    };

    // header
    pdf.font("bold").fontSize(16).text(doc.title, { width: contentWidth });
    pdf.moveDown(0.3);
    pdf.font("body").fontSize(9);
    for (const row of doc.meta) {
      pdf.text(`${row.label}: ${row.value}`, { width: contentWidth });
    }
    pdf.moveDown(0.5);

    if (doc.summary.length) {
      pdf.font("bold").fontSize(11).text("Summary");
      pdf.moveDown(0.2);
      pdf.font("body").fontSize(9);
      for (const row of doc.summary) pdf.text(`${row.label}: ${row.value}`, { width: contentWidth });
      pdf.moveDown(0.5);
    }

    const drawTable = (table: TReportTable) => {
      const columns = pdfColumns(table.columns);
      if (!columns.length) return;
      const weights = columns.map((c) => c.width ?? 1);
      const totalWeight = weights.reduce((a, b) => a + b, 0);
      const widths = weights.map((w) => (w / totalWeight) * contentWidth);

      const drawRow = (values: string[], font: "body" | "bold") => {
        pdf.font(font).fontSize(8);
        const heights = values.map((value, i) =>
          pdf.heightOfString(value, { width: (widths[i] ?? 0) - 4 }),
        );
        const rowHeight = Math.max(12, ...heights) + 4;
        ensureSpace(rowHeight);
        const y = pdf.y;
        let x = left;
        values.forEach((value, i) => {
          pdf.text(value, x + 2, y + 2, { width: (widths[i] ?? 0) - 4 });
          x += widths[i] ?? 0;
        });
        pdf.moveTo(left, y + rowHeight).lineTo(right, y + rowHeight).strokeColor("#dddddd").lineWidth(0.5).stroke();
        pdf.y = y + rowHeight;
      };

      ensureSpace(30);
      pdf.font("bold").fontSize(11).text(table.name);
      pdf.moveDown(0.2);
      drawRow(columns.map((c) => c.header), "bold");
      for (const row of table.rows) {
        drawRow(columns.map((c) => cellText(row[c.key] ?? null)), "body");
      }
      pdf.moveDown(0.6);
    };

    for (const table of doc.tables) drawTable(table);

    for (const note of doc.notes) {
      ensureSpace(20);
      pdf.font("body").fontSize(8).fillColor("#555555").text(note, { width: contentWidth });
      pdf.fillColor("black");
    }

    // page x / y footer across all buffered pages
    const range = pdf.bufferedPageRange();
    for (let i = 0; i < range.count; i += 1) {
      pdf.switchToPage(range.start + i);
      pdf.font("body").fontSize(8).fillColor("#777777");
      const label = `Page ${i + 1} / ${range.count}`;
      pdf.text(label, left, bottom + 10, { width: contentWidth, align: "center", lineBreak: false });
      pdf.fillColor("black");
    }

    pdf.end();
  });

/* -------------------------------- Excel ----------------------------------- */

const excelValue = (cell: TReportCell, type: TReportColumn["type"]): ExcelJS.CellValue => {
  if (cell === null || cell === undefined) return null;
  if (type === "date") return cell instanceof Date ? cell : new Date(String(cell));
  if (type === "number" || type === "integer") return typeof cell === "number" ? cell : Number(cell);
  //text: guard against spreadsheet formula injection
  return guardText(String(cell));
};

const excelNumFmt = (type: TReportColumn["type"]): string | undefined => {
  if (type === "date") return "yyyy-mm-dd";
  if (type === "integer") return "#,##0";
  if (type === "number") return "#,##0.00";
  return undefined;
};

const renderExcel = async (doc: TReportDocument, outPath: string): Promise<void> => {
  const wb = new ExcelJS.Workbook();
  wb.created = new Date();

  const summary = wb.addWorksheet("Summary");
  summary.addRow([doc.title]);
  summary.getRow(1).font = { bold: true, size: 14 };
  summary.addRow([]);
  for (const row of doc.meta) summary.addRow([row.label, row.value]);
  if (doc.summary.length) {
    summary.addRow([]);
    summary.addRow(["Summary"]).font = { bold: true };
    for (const row of doc.summary) summary.addRow([row.label, row.value]);
  }
  summary.getColumn(1).width = 28;
  summary.getColumn(2).width = 48;

  const used = new Set<string>(["Summary"]);
  for (const table of doc.tables) {
    //worksheet names: <= 31 chars, unique, no illegal chars
    const base = (table.name || "Table").replace(/[\\/?*[\]:]/g, " ").slice(0, 28).trim() || "Table";
    let name = base;
    let n = 2;
    while (used.has(name)) name = `${base.slice(0, 26)} ${n++}`;
    used.add(name);

    const ws = wb.addWorksheet(name);
    ws.columns = table.columns.map((c) => {
      const numFmt = excelNumFmt(c.type);
      return {
        header: c.header,
        key: c.key,
        width: Math.max(10, (c.width ?? 1) * 14),
        ...(numFmt ? { style: { numFmt } } : {}),
      };
    });
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: "frozen", ySplit: 1 }];
    for (const row of table.rows) {
      const added = ws.addRow(
        Object.fromEntries(table.columns.map((c) => [c.key, excelValue(row[c.key] ?? null, c.type)])),
      );
      //keep guarded text as plain text so '= is not re-parsed
      table.columns.forEach((c, i) => {
        if (c.type === "text") added.getCell(i + 1).numFmt = "@";
      });
    }
  }

  await wb.xlsx.writeFile(outPath);
};

/* --------------------------------- CSV ------------------------------------ */

const csvField = (cell: TReportCell, type: TReportColumn["type"]): string => {
  let value: string;
  if (cell === null || cell === undefined) value = "";
  else if (type === "date") value = cell instanceof Date ? isoDay(cell) : isoDay(new Date(String(cell)));
  else if (type === "number" || type === "integer") value = String(typeof cell === "number" ? cell : Number(cell));
  else value = guardText(String(cell));

  if (/[",\r\n]/.test(value) || /^\s|\s$/.test(value)) return `"${value.replaceAll('"', '""')}"`;
  return value;
};

const renderCsv = async (doc: TReportDocument, outPath: string): Promise<void> => {
  const table = doc.tables.find((t) => t.csvMain) ?? doc.tables[0];
  if (!table) throw new Error("This report has no table to export as CSV.");
  const lines: string[] = [];
  lines.push(table.columns.map((c) => csvField(c.header, "text")).join(","));
  for (const row of table.rows) {
    lines.push(table.columns.map((c) => csvField(row[c.key] ?? null, c.type)).join(","));
  }
  //UTF-8 BOM so Excel reads Bangla correctly
  await fs.promises.writeFile(outPath, "﻿" + lines.join("\r\n") + "\r\n", "utf8");
};

/* --------------------------------- JSON ----------------------------------- */

const jsonCell = (cell: TReportCell, type: TReportColumn["type"]): unknown => {
  if (cell === null || cell === undefined) return null;
  if (type === "date") return cell instanceof Date ? isoDay(cell) : isoDay(new Date(String(cell)));
  if (type === "number" || type === "integer") return typeof cell === "number" ? cell : Number(cell);
  return String(cell);
};

const renderJson = async (doc: TReportDocument, outPath: string): Promise<void> => {
  const payload = {
    title: doc.title,
    meta: doc.meta,
    summary: doc.summary,
    tables: doc.tables.map((table) => ({
      name: table.name,
      columns: table.columns.map((c) => ({ key: c.key, header: c.header, type: c.type })),
      rows: table.rows.map((row) =>
        Object.fromEntries(table.columns.map((c) => [c.key, jsonCell(row[c.key] ?? null, c.type)])),
      ),
    })),
    notes: doc.notes,
  };
  await fs.promises.writeFile(outPath, JSON.stringify(payload, null, 2), "utf8");
};

/* ------------------------------- dispatch --------------------------------- */

export const renderReport = (
  format: TReportFormat,
  doc: TReportDocument,
  outPath: string,
): Promise<void> => {
  switch (format) {
    case ReportFormats.PDF:
      return renderPdf(doc, outPath);
    case ReportFormats.EXCEL:
      return renderExcel(doc, outPath);
    case ReportFormats.CSV:
      return renderCsv(doc, outPath);
    case ReportFormats.JSON:
      return renderJson(doc, outPath);
    default:
      return Promise.reject(new Error(`Unsupported report format: ${String(format)}`));
  }
};
