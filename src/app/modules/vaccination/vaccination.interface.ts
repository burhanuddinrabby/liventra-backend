import type { Types } from "mongoose";
import type { VaccinationStatuses } from "./vaccination.constants.js";

export type TVaccinationStatus = (typeof VaccinationStatuses)[keyof typeof VaccinationStatuses];

// Vaccination (Model 13) — final DB schema fields.
export type TVaccination = {
  //generated VACLOG-YYYY-NNNNNN, immutable
  vaccinationNo: string;
  farmId: Types.ObjectId;
  //never changes: a dose logged for the wrong animal is reversed and logged again
  animalId: Types.ObjectId;
  vaccineId: Types.ObjectId;
  //Scheduled → planned date; Completed → actual administration date
  vaccinationDate: Date;
  //derived from the Vaccine booster/repeat rules on completion (null = no further dose)
  nextDueDate?: Date | null;
  //FarmMember _id of the person who gave the dose (required for Completed)
  administeredBy?: Types.ObjectId | null;
  //vaccine lot used (required for Completed) — recall traceability
  batchNumber?: string | null;
  status: TVaccinationStatus;
  remarks?: string;
  //FarmMember _id of the person who entered the record
  createdBy: Types.ObjectId;
  createdAt?: Date;
  updatedAt?: Date;
};
