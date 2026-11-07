// Farm-scoped role enum (Model 03). Values are display strings and are stored as-is,
// exactly like FarmTypes / FarmStatuses. There is intentionally no Role collection.
export const FarmMemberRoles = {
  OWNER: "Owner",
  MANAGER: "Manager",
  WORKER: "Worker",
  VETERINARIAN: "Veterinarian",
  ACCOUNTANT: "Accountant",
} as const;

// Roles that may be handed out through the membership endpoints.
// Owner is excluded: a farm has exactly one owner and it must stay in sync with
// Farm.ownerId, so it only changes through the dedicated transfer-ownership workflow.
export const AssignableFarmMemberRoles = {
  MANAGER: FarmMemberRoles.MANAGER,
  WORKER: FarmMemberRoles.WORKER,
  VETERINARIAN: FarmMemberRoles.VETERINARIAN,
  ACCOUNTANT: FarmMemberRoles.ACCOUNTANT,
} as const;

// Route-level "Farm Owner / Manager" access for member management.
export const FarmMemberManagementRoles = {
  OWNER: FarmMemberRoles.OWNER,
  MANAGER: FarmMemberRoles.MANAGER,
} as const;

// nid + salary are personal/financial data: only Owner/Manager may read or write them.
export const FARM_MEMBER_SENSITIVE_FIELDS = ["nid", "salary"] as const;

// Salary is stored in Bangladeshi Taka (BDT). Not a DB field — kept here so the
// unit is documented next to the model instead of being repeated in services.
export const FARM_MEMBER_SALARY_CURRENCY = "BDT";
