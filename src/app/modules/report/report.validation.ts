import { z } from "zod";

// Light gatekeeping only. validateRequest discards the parsed result, so the report
// service re-parses and strictly validates reportType, format, range and the per-type
// filter allowlist. These schemas just reject obviously malformed request bodies.

const dateRange = z.object({
  from: z.union([z.string(), z.date()]),
  to: z.union([z.string(), z.date()]),
});

const generationBody = z.object({
  reportType: z.string(),
  reportFormat: z.string(),
  reportName: z.string(),
  dateRange,
  //a plain object; the service enforces the per-type allowlist and refuses "$"/dotted keys
  filters: z.record(z.string(), z.unknown()).optional(),
});

const createValidation = z.object({
  body: generationBody,
});

const previewValidation = z.object({
  body: generationBody,
});

export const reportValidations = {
  createValidation,
  previewValidation,
};
