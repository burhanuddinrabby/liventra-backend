import { FarmMemberRoles } from "./farmMember.constants.js";
import type { TFarmMemberRole } from "./farmMember.interface.js";

const MANAGEMENT_ROLES: TFarmMemberRole[] = [
  FarmMemberRoles.OWNER,
  FarmMemberRoles.MANAGER,
];

/** The farm's primary decision maker (must stay in sync with Farm.ownerId). */
export const isFarmOwner = (role: TFarmMemberRole): boolean =>
  role === FarmMemberRoles.OWNER;

/** Owner and Manager may manage the member directory. */
export const canManageFarmMembers = (role: TFarmMemberRole): boolean =>
  MANAGEMENT_ROLES.includes(role);

/**
 * nid + salary are personal/financial data, so only the management roles may read
 * or write them. Workers, Veterinarians and Accountants see the directory without them.
 */
export const canViewSensitiveMemberData = (role: TFarmMemberRole): boolean =>
  canManageFarmMembers(role);

/**
 * Whether `actorRole` may modify (update / toggle / delete) a member whose current
 * role is `targetRole`.
 *
 * - Owner outranks everyone.
 * - A Manager may only act on non-managerial staff (Worker / Veterinarian / Accountant),
 *   so a Manager can never promote anyone (including themselves) to Owner or touch
 *   another Manager / the Owner.
 */
export const canManageMemberWithRole = (
  actorRole: TFarmMemberRole,
  targetRole: TFarmMemberRole,
): boolean => {
  if (isFarmOwner(actorRole)) return true;
  if (actorRole === FarmMemberRoles.MANAGER) {
    return !MANAGEMENT_ROLES.includes(targetRole);
  }
  return false;
};

/**
 * Owner is never assigned through the generic create/update endpoints — only the
 * ownership-transfer workflow (which also updates Farm.ownerId) may produce it.
 */
export const isAssignableFarmMemberRole = (role: TFarmMemberRole): boolean =>
  !isFarmOwner(role);

/**
 * Masks a NID for views that only need to identify the person, e.g. `********6789`.
 * Full NID is returned only to Owner/Manager.
 */
export const maskNid = (nid?: string): string | undefined => {
  if (!nid) return nid;
  const visible = nid.slice(-4);
  return `${"*".repeat(Math.max(nid.length - 4, 0))}${visible}`;
};
