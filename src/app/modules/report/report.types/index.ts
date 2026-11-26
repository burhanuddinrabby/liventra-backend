// Registry of implemented report types. Plan 8 is the engine; plan 9 fills in the rest.
// Only the Milk type is built now (first in plan 9's build order) as the real type that
// proves the engine end to end. A type absent from this registry is simply not offered.
import type { TReportType, TReportTypeDef } from "../report.interface.js";
import { milkReportType } from "./milk.js";

const DEFS: TReportTypeDef[] = [milkReportType];

export const REPORT_TYPE_DEFS: Partial<Record<TReportType, TReportTypeDef>> = Object.fromEntries(
  DEFS.map((def) => [def.type, def]),
);

export const getReportTypeDef = (type: TReportType): TReportTypeDef | undefined => REPORT_TYPE_DEFS[type];

export const IMPLEMENTED_REPORT_TYPES: TReportType[] = DEFS.map((def) => def.type);
