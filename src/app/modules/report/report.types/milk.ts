import status from "http-status";
import { Types } from "mongoose";
import AppError from "../../../errors/AppError.js";
import { AnimalModel } from "../../animal/animal.model.js";
import { MilkingSessions, MilkQualities } from "../../milkRecord/milkRecord.constants.js";
import { MilkRecordModel } from "../../milkRecord/milkRecord.model.js";
import { ReportFormats, ReportTypes } from "../report.constants.js";
import type {
  TFilterParseContext,
  TReportBuildContext,
  TReportColumn,
  TReportDocument,
  TReportRow,
  TReportTable,
  TReportTypeDef,
} from "../report.interface.js";
import { parseFilterEnum, parseIdList } from "../report.utils.js";

const SESSION_VALUES = Object.values(MilkingSessions);
const QUALITY_VALUES = Object.values(MilkQualities);
const MAX_MILK_ANIMAL_IDS = 500;

const ALLOWED_KEYS = new Set(["animalIds", "session", "quality"]);

const round2 = (n: number) => Math.round(n * 100) / 100;
const isoDay = (d: Date) => new Date(d).toISOString().slice(0, 10);

/** Strict Milk filter allowlist: animalIds, session, quality. Unknown keys are refused. */
const parseFilters = async (
  raw: Record<string, unknown>,
  ctx: TFilterParseContext,
): Promise<Record<string, unknown>> => {
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new AppError(status.BAD_REQUEST, `Unknown Milk filter "${key}". Allowed: animalIds, session, quality.`);
    }
  }
  const out: Record<string, unknown> = {};

  if (raw.animalIds !== undefined) {
    const ids = parseIdList("animalIds", raw.animalIds, MAX_MILK_ANIMAL_IDS);
    if (ids.length) {
      const found = await AnimalModel.find({ farmId: ctx.farmObjectId, _id: { $in: ids } })
        .select("_id")
        .lean();
      if (found.length !== new Set(ids.map(String)).size) {
        throw new AppError(status.NOT_FOUND, "One or more animalIds do not belong to this farm!");
      }
      out.animalIds = ids.map(String);
    }
  }
  if (raw.session !== undefined) out.session = parseFilterEnum("session", raw.session, SESSION_VALUES);
  if (raw.quality !== undefined) out.quality = parseFilterEnum("quality", raw.quality, QUALITY_VALUES);
  return out;
};

const buildQuery = (ctx: TReportBuildContext) => {
  const f = ctx.filters;
  const query: Record<string, unknown> = {
    farmId: ctx.farm._id,
    isVoided: false,
    recordDate: { $gte: ctx.dateRange.from, $lt: ctx.toExclusive },
  };
  if (Array.isArray(f.animalIds) && f.animalIds.length) {
    query.animalId = { $in: (f.animalIds as string[]).map((id) => new Types.ObjectId(id)) };
  }
  if (typeof f.session === "string") query.milkingSession = f.session;
  if (typeof f.quality === "string") query.quality = f.quality;
  return query;
};

const countRows = (ctx: TReportBuildContext): Promise<number> =>
  MilkRecordModel.countDocuments(buildQuery(ctx));

const RECORD_COLUMNS: TReportColumn[] = [
  { key: "date", header: "Date", headerBn: "তারিখ", type: "date", width: 1.1 },
  { key: "animal", header: "Animal", headerBn: "পশু", type: "text", width: 2 },
  { key: "session", header: "Session", headerBn: "দোহন", type: "text", width: 1 },
  { key: "liters", header: "Liters", headerBn: "লিটার", type: "number", width: 0.9 },
  { key: "quality", header: "Quality", headerBn: "মান", type: "text", width: 1 },
  { key: "withdrawal", header: "Withdrawal", headerBn: "প্রত্যাহার", type: "text", width: 1 },
];

const build = async (ctx: TReportBuildContext): Promise<TReportDocument> => {
  const records = await MilkRecordModel.find(buildQuery(ctx))
    .select("animalId recordDate milkingSession quantityInLiters quality withdrawalFlag")
    .sort({ recordDate: 1, milkingSession: 1 })
    .lean();

  const animalIds = [...new Set(records.map((r) => String(r.animalId)))];
  const animals = await AnimalModel.find({ farmId: ctx.farm._id, _id: { $in: animalIds } })
    .select("animalCode name")
    .lean();
  const label = new Map(
    animals.map((a) => [String(a._id), a.name ? `${a.animalCode} (${a.name})` : a.animalCode]),
  );
  const animalName = (id: unknown) => label.get(String(id)) ?? "Unknown";

  const recordRows: TReportRow[] = records.map((r) => ({
    date: r.recordDate,
    animal: animalName(r.animalId),
    session: r.milkingSession,
    liters: round2(r.quantityInLiters),
    quality: r.quality ?? "—",
    withdrawal: r.withdrawalFlag ? "Yes" : "No",
  }));

  // per-day and per-animal rollups (missing sessions are simply absent — never counted as 0)
  const perDay = new Map<string, { liters: number; count: number }>();
  const perAnimal = new Map<string, { liters: number; count: number }>();
  let totalLiters = 0;
  for (const r of records) {
    totalLiters += r.quantityInLiters;
    const dayKey = isoDay(r.recordDate);
    const d = perDay.get(dayKey) ?? { liters: 0, count: 0 };
    d.liters += r.quantityInLiters;
    d.count += 1;
    perDay.set(dayKey, d);
    const aKey = String(r.animalId);
    const a = perAnimal.get(aKey) ?? { liters: 0, count: 0 };
    a.liters += r.quantityInLiters;
    a.count += 1;
    perAnimal.set(aKey, a);
  }

  const perDayTable: TReportTable = {
    name: "Per day",
    nameBn: "দৈনিক",
    columns: [
      { key: "date", header: "Date", headerBn: "তারিখ", type: "date" },
      { key: "liters", header: "Total liters", headerBn: "মোট লিটার", type: "number" },
      { key: "records", header: "Records", headerBn: "রেকর্ড", type: "integer" },
    ],
    rows: [...perDay.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([day, v]) => ({ date: new Date(day), liters: round2(v.liters), records: v.count })),
  };

  const perAnimalTable: TReportTable = {
    name: "Per animal",
    nameBn: "পশু অনুযায়ী",
    columns: [
      { key: "animal", header: "Animal", headerBn: "পশু", type: "text", width: 2 },
      { key: "liters", header: "Total liters", headerBn: "মোট লিটার", type: "number" },
      { key: "records", header: "Records", headerBn: "রেকর্ড", type: "integer" },
    ],
    rows: [...perAnimal.entries()]
      .map(([id, v]) => ({ animal: animalName(id), liters: round2(v.liters), records: v.count }))
      .sort((a, b) => b.liters - a.liters),
  };

  const recordsTable: TReportTable = {
    name: "Milk records",
    nameBn: "দুধের রেকর্ড",
    columns: RECORD_COLUMNS,
    rows: recordRows,
    csvMain: true,
  };

  return {
    title: "Milk Production Report",
    titleBn: "দুধ উৎপাদন রিপোর্ট",
    meta: [],
    summary: [
      { label: "Total milk", labelBn: "মোট দুধ", value: `${round2(totalLiters)} L` },
      { label: "Records", labelBn: "রেকর্ড", value: String(records.length) },
      { label: "Days with production", labelBn: "উৎপাদনের দিন", value: String(perDay.size) },
      { label: "Animals", labelBn: "পশু", value: String(perAnimal.size) },
    ],
    tables: [recordsTable, perDayTable, perAnimalTable],
    notes: [
      "Voided milk records are excluded. Totals are summed over recorded sessions only; sessions with no record are not counted as zero.",
    ],
  };
};

export const milkReportType: TReportTypeDef = {
  type: ReportTypes.MILK,
  formats: [ReportFormats.PDF, ReportFormats.EXCEL, ReportFormats.CSV, ReportFormats.JSON],
  csvFlat: true,
  dateFieldLabel: "Milking day",
  parseFilters,
  countRows,
  build,
};
