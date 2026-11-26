// Report RBAC (plan 8.4). The matrix maps each report type to the farm roles that may
// generate it; Worker on Milk / Feed is limited to PDF / CSV and <= 31 days, and Vet /
// Worker reports never include prices. Checked at request, in the worker and at download.
import { FarmMemberRoles } from "../farmMember/farmMember.constants.js";
import type { TFarmMemberRole } from "../farmMember/farmMember.interface.js";
import { ReportFormats, ReportTypes, WORKER_FORMATS, WORKER_MAX_RANGE_DAYS } from "./report.constants.js";
import type { TReportFormat, TReportType } from "./report.interface.js";

const { OWNER, MANAGER, ACCOUNTANT, VETERINARIAN, WORKER } = FarmMemberRoles;

type TTypeRule = {
  roles: readonly TFarmMemberRole[];
  //roles that see the data without prices
  noPriceRoles?: readonly TFarmMemberRole[];
  //roles that see only the reports they generated themselves
  ownOnlyRoles?: readonly TFarmMemberRole[];
  //roles limited to specific formats
  formatLimit?: { roles: readonly TFarmMemberRole[]; formats: readonly TReportFormat[] };
  //roles limited to a shorter date range
  rangeLimit?: { roles: readonly TFarmMemberRole[]; maxDays: number };
};

const WORKER_LIMITED: TTypeRule = {
  roles: [OWNER, MANAGER, WORKER],
  noPriceRoles: [WORKER],
  ownOnlyRoles: [WORKER],
  formatLimit: { roles: [WORKER], formats: WORKER_FORMATS },
  rangeLimit: { roles: [WORKER], maxDays: WORKER_MAX_RANGE_DAYS },
};

const CLINICAL: TTypeRule = {
  roles: [OWNER, MANAGER, VETERINARIAN],
  noPriceRoles: [VETERINARIAN],
  ownOnlyRoles: [VETERINARIAN],
};

const FINANCIAL: TTypeRule = { roles: [OWNER, MANAGER, ACCOUNTANT] };

export const REPORT_PERMISSIONS: Record<TReportType, TTypeRule> = {
  [ReportTypes.FARM_SUMMARY]: { roles: [OWNER, MANAGER] },
  [ReportTypes.ANIMAL]: CLINICAL,
  [ReportTypes.WEIGHT]: CLINICAL,
  [ReportTypes.MILK]: WORKER_LIMITED,
  [ReportTypes.FEED]: WORKER_LIMITED,
  [ReportTypes.HEALTH]: CLINICAL,
  [ReportTypes.VACCINATION]: CLINICAL,
  [ReportTypes.TREATMENT]: CLINICAL,
  [ReportTypes.INVENTORY]: FINANCIAL,
  [ReportTypes.EXPENSE]: FINANCIAL,
  [ReportTypes.INCOME]: FINANCIAL,
  [ReportTypes.FINANCE]: FINANCIAL,
  [ReportTypes.AUDIT_LOG]: { roles: [OWNER] },
  [ReportTypes.DEVICE]: CLINICAL,
  [ReportTypes.SENSOR]: CLINICAL,
};

const has = (roles: readonly TFarmMemberRole[] | undefined, role: TFarmMemberRole) => !!roles?.includes(role);

export const canGenerateType = (role: TFarmMemberRole, type: TReportType): boolean =>
  REPORT_PERMISSIONS[type].roles.includes(role);

export const typesForRole = (role: TFarmMemberRole): TReportType[] =>
  (Object.keys(REPORT_PERMISSIONS) as TReportType[]).filter((type) => canGenerateType(role, type));

/** Formats this role may pick for this type (a Worker is limited to PDF / CSV). */
export const formatsForRole = (role: TFarmMemberRole, type: TReportType): TReportFormat[] => {
  const rule = REPORT_PERMISSIONS[type];
  const all = Object.values(ReportFormats);
  if (rule.formatLimit && has(rule.formatLimit.roles, role)) return [...rule.formatLimit.formats];
  return all;
};

/** Longest date range this role may request for this type (days). */
export const maxRangeDaysFor = (role: TFarmMemberRole, type: TReportType, baseMaxDays: number): number => {
  const rule = REPORT_PERMISSIONS[type];
  if (rule.rangeLimit && has(rule.rangeLimit.roles, role)) return Math.min(baseMaxDays, rule.rangeLimit.maxDays);
  return baseMaxDays;
};

/** Vet / Worker reports omit price columns. */
export const includesPrices = (role: TFarmMemberRole, type: TReportType): boolean =>
  !has(REPORT_PERMISSIONS[type].noPriceRoles, role);

/** Workers and Vets see only their own reports; the others see all reports of the types they may generate. */
export const seesOwnReportsOnly = (role: TFarmMemberRole, type: TReportType): boolean =>
  has(REPORT_PERMISSIONS[type].ownOnlyRoles, role);

/** True when this role sees only its own reports for ANY type it can generate (list filter). */
export const restrictedToOwnReports = (role: TFarmMemberRole): boolean =>
  role === WORKER || role === VETERINARIAN;
