import express from "express";
import auth from "../../middlewares/auth.js";
import validateRequest from "../../middlewares/validateRequest.js";
import { SystemRoles } from "../auth/auth.constants.js";
import { FarmMemberController } from "./farmMember.controller.js";
import { farmMemberValidations } from "./farmMember.validation.js";

/**
 * FarmMember endpoints — nested under the farm router:
 *
 * POST   /api/v1/farms/:farmId/members                      Farm Owner / Manager  add/invite a registered user with a farm role
 * GET    /api/v1/farms/:farmId/members                      Farm Member           list active members (management may include history)
 * GET    /api/v1/farms/:farmId/members/:memberId            Farm Member           detailed profile of one member
 * PUT    /api/v1/farms/:farmId/members/:memberId            Farm Owner / Manager  update role, salary, nid, joiningDate
 * PATCH  /api/v1/farms/:farmId/members/:memberId/toggle-active  Farm Owner / Manager  activate/deactivate without losing history
 * DELETE /api/v1/farms/:farmId/members/:memberId            Farm Owner            remove a membership (cleanup)
 *
 * Farm-level authorization (active membership + role) lives in the service layer;
 * `auth` only proves the caller is a logged-in platform user.
 */
const farmMemberRouter = express.Router({ mergeParams: true });

const authenticatedRoles = [
  SystemRoles.SUPER_ADMIN,
  SystemRoles.ADMIN,
  SystemRoles.USER,
];

//add/invite an existing user as a farm member
farmMemberRouter.post(
  "/",
  auth(...authenticatedRoles),
  validateRequest(farmMemberValidations.createMemberValidation),
  FarmMemberController.createMember,
);

//member directory
farmMemberRouter.get(
  "/",
  auth(...authenticatedRoles),
  FarmMemberController.getFarmMembers,
);

//single member profile
farmMemberRouter.get(
  "/:memberId",
  auth(...authenticatedRoles),
  FarmMemberController.getMemberById,
);

//update operational details (role / salary / nid / joiningDate)
farmMemberRouter.put(
  "/:memberId",
  auth(...authenticatedRoles),
  validateRequest(farmMemberValidations.updateMemberValidation),
  FarmMemberController.updateMember,
);

//activate or deactivate membership without deleting history
farmMemberRouter.patch(
  "/:memberId/toggle-active",
  auth(...authenticatedRoles),
  FarmMemberController.toggleMemberActive,
);

//remove a membership relationship (accidental invitations / cleanups)
farmMemberRouter.delete(
  "/:memberId",
  auth(...authenticatedRoles),
  FarmMemberController.deleteMember,
);

export { farmMemberRouter };
