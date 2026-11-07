import z from "zod";
import { FarmMemberRoles } from "./farmMember.constants.js";

//Bangladeshi NIDs are 10, 13 or 17 digits; empty string is allowed so a client can clear it
const nidValidation = z
  .string()
  .trim()
  .refine((value) => value === "" || /^(\d{10}|\d{13}|\d{17})$/.test(value), {
    message: "NID must be a 10, 13 or 17 digit number",
  })
  .nullable()
  .optional();

const createMemberValidation = z.object({
  body: z.object({
    //public User.userId (U-YY-NNNN) or a User ObjectId — resolved by the service
    userId: z.string().trim().min(1, { message: "User id is required" }),
    role: z.enum(Object.values(FarmMemberRoles), {
      message:
        "Role must be one of Owner, Manager, Worker, Veterinarian or Accountant",
    }),
    nid: nidValidation,
    joiningDate: z.coerce.date().optional(),
    salary: z.coerce.number().min(0).optional(),
  }),
});

const updateMemberValidation = z.object({
  body: z
    .object({
      role: z.enum(Object.values(FarmMemberRoles), {
        message:
          "Role must be one of Owner, Manager, Worker, Veterinarian or Accountant",
      }),
      nid: nidValidation,
      joiningDate: z.coerce.date().optional(),
      salary: z.coerce.number().min(0).nullable().optional(),
    })
    .partial(),
});

export const farmMemberValidations = {
  createMemberValidation,
  updateMemberValidation,
};
