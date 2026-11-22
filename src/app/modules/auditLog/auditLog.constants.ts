// AuditLog enums (Model 24). Values are display strings stored as-is.
// Only a few modules write audit rows today; the full finalized lists are kept so
// later modules can log without a schema change.
// FeedIngredient / Breed / Vaccine / Disease / Medicine are master-data entities added on top of the Model 24 list.
export const AuditEntityTypes = {
  ANIMAL: "Animal",
  BREED: "Breed",
  FEED_INGREDIENT: "FeedIngredient",
  VACCINE: "Vaccine",
  DISEASE: "Disease",
  MEDICINE: "Medicine",
  FEED_FORMULA: "FeedFormula",
  FEED_RECOMMENDATION: "FeedRecommendation",
  FEED_RECORD: "FeedRecord",
  WEIGHT_RECORD: "WeightRecord",
  MILK_RECORD: "MilkRecord",
  VACCINATION: "Vaccination",
  TREATMENT: "Treatment",
  INVENTORY: "Inventory",
  INVENTORY_TRANSACTION: "InventoryTransaction",
  EXPENSE: "Expense",
  INCOME: "Income",
  NOTIFICATION: "Notification",
  FARM: "Farm",
  USER: "User",
} as const;

export const AuditActions = {
  CREATE: "Create",
  UPDATE: "Update",
  DELETE: "Delete",
  ARCHIVE: "Archive",
  LOGIN: "Login",
  LOGOUT: "Logout",
  EXPORT: "Export",
  IMPORT: "Import",
  APPROVE: "Approve",
  REJECT: "Reject",
} as const;

export const AuditModules = {
  ANIMAL: "Animal",
  FEED: "Feed",
  HEALTH: "Health",
  INVENTORY: "Inventory",
  FINANCE: "Finance",
  FARM: "Farm",
  AUTHENTICATION: "Authentication",
  ADMINISTRATION: "Administration",
} as const;

export const AuditStatuses = {
  SUCCESS: "Success",
  FAILED: "Failed",
  ROLLED_BACK: "Rolled Back",
} as const;

export const AuditDeviceTypes = {
  DESKTOP: "Desktop",
  MOBILE: "Mobile",
  TABLET: "Tablet",
  API: "API",
} as const;

export const AUDIT_LOG_NO_PREFIX = "LOG";
