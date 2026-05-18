import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

const allowedStatuses = new Set(["Implemented/tested", "Implemented/local-safe", "External evidence required"]);

export interface RoadmapComplianceValidationReport {
  schemaVersion: "roadmap-compliance-validation/v1";
  roadmapPath: string;
  matrixPath: string;
  boardPath: string;
  roadmapSprintCount: number;
  matrixSprintCount: number;
  boardSprintCount: number;
  roadmapSprintIds: number[];
  matrixSprintIds: number[];
  boardSprintIds: number[];
  missingMatrixSprintIds: number[];
  extraMatrixSprintIds: number[];
  missingBoardSprintIds: number[];
  extraBoardSprintIds: number[];
  invalidStatuses: Array<{ sprintId: number; status: string }>;
  boardStatusMismatches: Array<{ sprintId: number; matrixStatus: string; boardStatus: string; expectedBoardStatus: string }>;
  blankEvidenceSprintIds: number[];
  selfCheckPresent: boolean;
  passed: boolean;
  failures: string[];
}

export function buildRoadmapComplianceReport(input: { roadmapPath?: string; matrixPath?: string; boardPath?: string } = {}): RoadmapComplianceValidationReport {
  const roadmapPath = input.roadmapPath ?? "docs/roadmap/Telegram Job Search Automation Roadmap v1.0.md";
  const matrixPath = input.matrixPath ?? "docs/verification/ROADMAP_COMPLIANCE_MATRIX.md";
  const boardPath = input.boardPath ?? "docs/delivery/roadmap-board.md";
  const failures: string[] = [];
  const roadmapContents = readExistingFile(roadmapPath, failures);
  const matrixContents = readExistingFile(matrixPath, failures);
  const boardContents = readExistingFile(boardPath, failures);
  const roadmapSprintIds = parseRoadmapSprintIds(roadmapContents);
  const matrixRows = parseComplianceMatrixRows(matrixContents);
  const boardRows = parseComplianceMatrixRows(boardContents);
  const matrixSprintIds = matrixRows.map((row) => row.sprintId);
  const boardSprintIds = boardRows.map((row) => row.sprintId);
  const expectedSprintIds = Array.from({ length: 40 }, (_, index) => index);
  const missingMatrixSprintIds = expectedSprintIds.filter((sprintId) => !matrixSprintIds.includes(sprintId));
  const extraMatrixSprintIds = matrixSprintIds.filter((sprintId) => !expectedSprintIds.includes(sprintId));
  const missingBoardSprintIds = expectedSprintIds.filter((sprintId) => !boardSprintIds.includes(sprintId));
  const extraBoardSprintIds = boardSprintIds.filter((sprintId) => !expectedSprintIds.includes(sprintId));
  const invalidStatuses = matrixRows
    .filter((row) => !allowedStatuses.has(row.status))
    .map((row) => ({ sprintId: row.sprintId, status: row.status }));
  const boardStatusMismatches = matrixRows.flatMap((matrixRow) => {
    const boardRow = boardRows.find((row) => row.sprintId === matrixRow.sprintId);
    if (!boardRow) {
      return [];
    }
    const expectedBoardStatus = expectedBoardStatusFor(matrixRow.status);
    return boardRow.status === expectedBoardStatus
      ? []
      : [
          {
            sprintId: matrixRow.sprintId,
            matrixStatus: matrixRow.status,
            boardStatus: boardRow.status,
            expectedBoardStatus
          }
        ];
  });
  const blankEvidenceSprintIds = matrixRows.filter((row) => row.evidence.trim().length === 0).map((row) => row.sprintId);
  const selfCheckPresent = /## Self-Check/i.test(matrixContents) && /remaining unresolved items/i.test(matrixContents);

  if (!sameNumberSet(roadmapSprintIds, expectedSprintIds)) {
    failures.push(`roadmap_sprint_ids_mismatch:${roadmapSprintIds.join(",")}`);
  }
  if (missingMatrixSprintIds.length > 0) {
    failures.push(`missing_matrix_sprints:${missingMatrixSprintIds.join(",")}`);
  }
  if (extraMatrixSprintIds.length > 0) {
    failures.push(`extra_matrix_sprints:${extraMatrixSprintIds.join(",")}`);
  }
  if (missingBoardSprintIds.length > 0) {
    failures.push(`missing_board_sprints:${missingBoardSprintIds.join(",")}`);
  }
  if (extraBoardSprintIds.length > 0) {
    failures.push(`extra_board_sprints:${extraBoardSprintIds.join(",")}`);
  }
  for (const item of invalidStatuses) {
    failures.push(`invalid_status:${item.sprintId}:${item.status}`);
  }
  for (const item of boardStatusMismatches) {
    failures.push(`board_status_mismatch:${item.sprintId}:${item.boardStatus}->${item.expectedBoardStatus}`);
  }
  if (blankEvidenceSprintIds.length > 0) {
    failures.push(`blank_evidence:${blankEvidenceSprintIds.join(",")}`);
  }
  if (!selfCheckPresent) {
    failures.push("matrix_self_check_missing");
  }

  return {
    schemaVersion: "roadmap-compliance-validation/v1",
    roadmapPath,
    matrixPath,
    boardPath,
    roadmapSprintCount: roadmapSprintIds.length,
    matrixSprintCount: matrixSprintIds.length,
    boardSprintCount: boardSprintIds.length,
    roadmapSprintIds,
    matrixSprintIds,
    boardSprintIds,
    missingMatrixSprintIds,
    extraMatrixSprintIds,
    missingBoardSprintIds,
    extraBoardSprintIds,
    invalidStatuses,
    boardStatusMismatches,
    blankEvidenceSprintIds,
    selfCheckPresent,
    passed: failures.length === 0,
    failures
  };
}

function readExistingFile(path: string, failures: string[]): string {
  if (!existsSync(path)) {
    failures.push(`missing_file:${path}`);
    return "";
  }
  return readFileSync(path, "utf8");
}

function parseRoadmapSprintIds(contents: string): number[] {
  return uniqueSorted([...contents.matchAll(/^## Sprint\s+(\d+):/gm)].map((match) => Number(match[1])));
}

function parseComplianceMatrixRows(contents: string): Array<{ sprintId: number; gate: string; status: string; evidence: string }> {
  const rows: Array<{ sprintId: number; gate: string; status: string; evidence: string }> = [];
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\|\s*(\d+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*(.*?)\s*\|$/);
    if (!match) {
      continue;
    }
    rows.push({
      sprintId: Number(match[1]),
      gate: match[2]!.trim(),
      status: match[3]!.trim(),
      evidence: match[4]!.trim()
    });
  }
  return rows.sort((left, right) => left.sprintId - right.sprintId);
}

function uniqueSorted(values: number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

function sameNumberSet(left: number[], right: number[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((value, index) => value === right[index]);
}

function expectedBoardStatusFor(status: string): string {
  if (status === "Implemented/tested") {
    return "Done";
  }
  if (status === "Implemented/local-safe") {
    return "Done/local-safe";
  }
  return status;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = buildRoadmapComplianceReport({
    ...(process.env.ROADMAP_PATH ? { roadmapPath: process.env.ROADMAP_PATH } : {}),
    ...(process.env.ROADMAP_MATRIX_PATH ? { matrixPath: process.env.ROADMAP_MATRIX_PATH } : {}),
    ...(process.env.ROADMAP_BOARD_PATH ? { boardPath: process.env.ROADMAP_BOARD_PATH } : {})
  });
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (process.env.ROADMAP_COMPLIANCE_OUTPUT_PATH) {
    mkdirSync(dirname(process.env.ROADMAP_COMPLIANCE_OUTPUT_PATH), { recursive: true });
    writeFileSync(process.env.ROADMAP_COMPLIANCE_OUTPUT_PATH, serialized);
  } else {
    process.stdout.write(serialized);
  }
  if (!report.passed) {
    process.exitCode = 1;
  }
}
