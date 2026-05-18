import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { buildGaSignoffChecklist, parseGaSignoffFile, type GaSignoffInput } from "./acceptance-package";

export interface GaSignoffValidationReport {
  schemaVersion: "ga-signoff-validation/v1";
  generatedAt: string;
  path: string | null;
  present: boolean;
  explicitSignoffProvided: boolean;
  signers: number;
  valid: boolean;
  blockers: string[];
  parseError: string | null;
}

export function buildGaSignoffValidationReport(input: {
  path?: string | null;
  signoff?: GaSignoffInput;
  now?: Date;
}): GaSignoffValidationReport {
  const now = input.now ?? new Date();
  try {
    const signoff = input.signoff ?? (input.path && existsSync(input.path) ? parseGaSignoffFile(readFileSync(input.path, "utf8")) : undefined);
    const checklist = buildGaSignoffChecklist({ signoff, now });
    return {
      schemaVersion: "ga-signoff-validation/v1",
      generatedAt: now.toISOString(),
      path: input.path ?? null,
      present: Boolean(signoff),
      explicitSignoffProvided: checklist.explicitSignoffProvided,
      signers: checklist.signers.length,
      valid: checklist.blockers.length === 0,
      blockers: checklist.blockers,
      parseError: null
    };
  } catch (error) {
    return {
      schemaVersion: "ga-signoff-validation/v1",
      generatedAt: now.toISOString(),
      path: input.path ?? null,
      present: Boolean(input.path && existsSync(input.path)),
      explicitSignoffProvided: false,
      signers: 0,
      valid: false,
      blockers: [],
      parseError: error instanceof Error ? error.message : String(error)
    };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const signoffPath = process.env.GA_SIGNOFF_PATH ?? "ga-signoff.json";
  const report = buildGaSignoffValidationReport({ path: signoffPath });
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (process.env.GA_SIGNOFF_VALIDATION_OUTPUT_PATH) {
    mkdirSync(dirname(process.env.GA_SIGNOFF_VALIDATION_OUTPUT_PATH), { recursive: true });
    writeFileSync(process.env.GA_SIGNOFF_VALIDATION_OUTPUT_PATH, serialized);
  } else {
    process.stdout.write(serialized);
  }
  if (!report.valid) {
    process.exitCode = 1;
  }
}
