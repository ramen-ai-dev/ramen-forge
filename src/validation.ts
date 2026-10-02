/**
 * Structural invariants for contributed CorrectionExemplar records.
 *
 * The forge only accepts normalised, sanitised exemplars. Anything that looks
 * like a raw agent dump (unknown top-level keys such as transcripts or
 * messages, oversized or deeply nested argument blobs, control characters,
 * embedded credentials) is rejected with a list of reasons instead of being
 * stored and later injected into other agents' context windows.
 */
import { sha256Hex } from "@ramen-ai/node-core";
import type { CalibrateRequest, CorrectionExemplarInput, JsonObject, JsonValue } from "./types";

export const MAX_BODY_BYTES = 64 * 1024;
const MAX_ARGUMENTS_BYTES = 16 * 1024;
const MAX_ARGUMENTS_DEPTH = 8;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const DOMAIN_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const TOOL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/;
const RECEIPT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
export const RECEIPT_REQUIRED_MESSAGE = "Every exemplar must carry a verified ramen ai receipt_id.";
// ISO 8601 date-time with mandatory UTC offset, matching foundry's tz-aware requirement.
const ISO_WITH_OFFSET_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
// Control characters other than tab, newline, and carriage return.
const CONTROL_CHAR_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/** Credential shapes that must never enter the community commons. */
const SECRET_PATTERNS: ReadonlyArray<[string, RegExp]> = [
  ["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["AWS access key id", /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["GitHub token", /\b(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ["API secret key", /\bsk-(live|proj|ant)?[-_]?[A-Za-z0-9_-]{20,}\b/],
  ["JSON Web Token", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
  ["bearer credential", /\bbearer\s+[A-Za-z0-9._~+/=-]{20,}/i],
];

const TEXT_FIELDS = {
  task_description: 2000,
  violation_reason: 1000,
  primary_statutory_anchor: 256,
  steering_directive: 2000,
} as const;

const ALLOWED_KEYS = new Set<string>([
  "exemplar_id",
  "domain",
  "task_description",
  "task_fingerprint",
  "tool_name",
  "failed_arguments",
  "violation_reason",
  "primary_statutory_anchor",
  "steering_directive",
  "repaired_arguments",
  "receipt_id",
  "created_at",
]);

const REQUIRED_KEYS = [
  "exemplar_id",
  "domain",
  "task_description",
  "tool_name",
  "violation_reason",
  "primary_statutory_anchor",
  "steering_directive",
  "repaired_arguments",
  "created_at",
] as const;

export type ValidationResult =
  | { ok: true; value: CorrectionExemplarInput }
  | { ok: false; errors: string[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkText(value: unknown, name: string, maxLength: number, errors: string[]): string | null {
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(`${name} must be a non-blank string`);
    return null;
  }
  if (value.length > maxLength) {
    errors.push(`${name} must be at most ${maxLength} characters`);
    return null;
  }
  if (CONTROL_CHAR_RE.test(value)) {
    errors.push(`${name} must not contain control characters`);
    return null;
  }
  return value;
}

/** Walk a JSON value, enforcing depth and collecting every string for secret scanning. */
function walkJson(value: unknown, depth: number, strings: string[]): string | null {
  if (depth > MAX_ARGUMENTS_DEPTH) return `nesting exceeds ${MAX_ARGUMENTS_DEPTH} levels`;
  if (value === null || typeof value === "boolean") return null;
  if (typeof value === "number") return Number.isFinite(value) ? null : "contains a non-finite number";
  if (typeof value === "string") {
    if (CONTROL_CHAR_RE.test(value)) return "contains control characters";
    strings.push(value);
    return null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const problem = walkJson(item, depth + 1, strings);
      if (problem) return problem;
    }
    return null;
  }
  if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      strings.push(key);
      const problem = walkJson(item, depth + 1, strings);
      if (problem) return problem;
    }
    return null;
  }
  return "contains a non-JSON value";
}

function checkArguments(value: unknown, name: string, errors: string[], strings: string[]): JsonObject | null {
  if (!isPlainObject(value)) {
    errors.push(`${name} must be a JSON object`);
    return null;
  }
  const encodedBytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  if (encodedBytes > MAX_ARGUMENTS_BYTES) {
    errors.push(`${name} must serialise to at most ${MAX_ARGUMENTS_BYTES} bytes`);
    return null;
  }
  const problem = walkJson(value, 1, strings);
  if (problem) {
    errors.push(`${name} ${problem}`);
    return null;
  }
  return value as JsonObject;
}

/**
 * Validate an untrusted payload against the CorrectionExemplar invariants.
 * `task_fingerprint` is optional on input; when present it must equal
 * SHA-256(task_description), the same digest foundry's `fingerprint_task` uses.
 */
export async function validateExemplar(payload: unknown, now: Date = new Date()): Promise<ValidationResult> {
  const errors: string[] = [];
  if (!isPlainObject(payload)) {
    return { ok: false, errors: ["payload must be a JSON object"] };
  }

  const unknownKeys = Object.keys(payload).filter((key) => !ALLOWED_KEYS.has(key));
  if (unknownKeys.length > 0) {
    errors.push(
      `unknown fields rejected (submit a normalised CorrectionExemplar, not a raw dump): ${unknownKeys
        .slice(0, 10)
        .join(", ")}`,
    );
  }
  const missing = REQUIRED_KEYS.filter((key) => !(key in payload));
  if (missing.length > 0) {
    errors.push(`missing required fields: ${missing.join(", ")}`);
  }
  if (errors.length > 0) return { ok: false, errors };

  const strings: string[] = [];

  const exemplarId = payload.exemplar_id;
  if (typeof exemplarId !== "string" || !UUID_RE.test(exemplarId)) {
    errors.push("exemplar_id must be a UUID string");
  }

  const domain = payload.domain;
  if (typeof domain !== "string" || !DOMAIN_RE.test(domain)) {
    errors.push("domain must be a lowercase slug (a-z, 0-9, '_' or '-', 2-64 characters)");
  }

  const toolName = payload.tool_name;
  if (typeof toolName !== "string" || !TOOL_NAME_RE.test(toolName)) {
    errors.push("tool_name must be 1-128 characters of [A-Za-z0-9_.:/-]");
  }

  const text: Partial<Record<keyof typeof TEXT_FIELDS, string>> = {};
  for (const [name, maxLength] of Object.entries(TEXT_FIELDS) as [keyof typeof TEXT_FIELDS, number][]) {
    const value = checkText(payload[name], name, maxLength, errors);
    if (value !== null) {
      text[name] = value;
      strings.push(value);
    }
  }

  // Optional: lessons can be contributed without the original failing call.
  // Omitted (or null) is stored as {} so records still rehydrate as foundry CorrectionExemplars.
  const failedArguments =
    payload.failed_arguments === undefined || payload.failed_arguments === null
      ? {}
      : checkArguments(payload.failed_arguments, "failed_arguments", errors, strings);
  const repairedArguments = checkArguments(payload.repaired_arguments, "repaired_arguments", errors, strings);

  // Every exemplar must come from a live ramen-ai evaluation. This checks the
  // receipt_id is present and well-formed; it does not verify the receipt itself.
  const receiptId = payload.receipt_id;
  if (receiptId === undefined || receiptId === null || (typeof receiptId === "string" && receiptId.trim() === "")) {
    errors.push(RECEIPT_REQUIRED_MESSAGE);
  } else if (typeof receiptId !== "string" || !RECEIPT_ID_RE.test(receiptId)) {
    errors.push("receipt_id must be 1-128 characters of [A-Za-z0-9_.:-]");
  }

  const createdAt = payload.created_at;
  if (typeof createdAt !== "string" || !ISO_WITH_OFFSET_RE.test(createdAt) || Number.isNaN(Date.parse(createdAt))) {
    errors.push("created_at must be an ISO 8601 timestamp with a UTC offset");
  } else if (Date.parse(createdAt) - now.getTime() > MAX_FUTURE_SKEW_MS) {
    errors.push("created_at must not be in the future");
  }

  let taskFingerprint: string | null = null;
  if (text.task_description !== undefined) {
    taskFingerprint = await sha256Hex(text.task_description);
    const supplied = payload.task_fingerprint;
    if (supplied !== undefined) {
      if (typeof supplied !== "string" || !SHA256_HEX_RE.test(supplied)) {
        errors.push("task_fingerprint must be a lowercase SHA-256 hex digest");
      } else if (supplied !== taskFingerprint) {
        errors.push("task_fingerprint does not match SHA-256(task_description)");
      }
    }
  }

  for (const value of strings) {
    const hit = SECRET_PATTERNS.find(([, pattern]) => pattern.test(value));
    if (hit) {
      errors.push(`payload appears to contain a credential (${hit[0]}); sanitise before contributing`);
      break;
    }
  }

  if (errors.length > 0 || failedArguments === null || repairedArguments === null || taskFingerprint === null) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      exemplar_id: (exemplarId as string).toLowerCase(),
      domain: domain as string,
      task_description: text.task_description as string,
      task_fingerprint: taskFingerprint,
      tool_name: toolName as string,
      failed_arguments: failedArguments,
      violation_reason: text.violation_reason as string,
      primary_statutory_anchor: text.primary_statutory_anchor as string,
      steering_directive: text.steering_directive as string,
      repaired_arguments: repairedArguments,
      receipt_id: receiptId as string,
      created_at: createdAt as string,
    },
  };
}

/** Narrow a JSON value back to an object after a D1 round trip. */
export function parseStoredObject(raw: string): JsonObject {
  const parsed: JsonValue = JSON.parse(raw);
  return isPlainObject(parsed) ? (parsed as JsonObject) : {};
}

export const QUERY_PATTERNS = { DOMAIN_RE, TOOL_NAME_RE, SHA256_HEX_RE };

export const MAX_QUERY_LENGTH = 100;

/** Validate a free-text search term. Returns the trimmed term or an error message. */
export function checkSearchTerm(raw: string): { ok: true; term: string } | { ok: false; error: string } {
  const term = raw.trim();
  if (term === "") return { ok: false, error: "q must not be blank" };
  if (term.length > MAX_QUERY_LENGTH) return { ok: false, error: `q must be at most ${MAX_QUERY_LENGTH} characters` };
  if (CONTROL_CHAR_RE.test(term)) return { ok: false, error: "q must not contain control characters" };
  return { ok: true, term };
}

/** Build a `%term%` LIKE pattern with `%`, `_` and `\` escaped (use with ESCAPE '\'). */
export function toLikePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, "\\$&")}%`;
}

export const MAX_CALIBRATE_BODY_BYTES = MAX_ARGUMENTS_BYTES + 1024;
const CALIBRATE_KEYS = new Set(["domain", "tool", "arguments"]);

/** Validate the untrusted body of POST /api/v1/calibrate. Domain-to-bundle mapping is the caller's job. */
export function validateCalibrateRequest(
  payload: unknown,
): { ok: true; value: CalibrateRequest } | { ok: false; errors: string[] } {
  if (!isPlainObject(payload)) return { ok: false, errors: ["payload must be a JSON object"] };
  const errors: string[] = [];
  const unknownKeys = Object.keys(payload).filter((key) => !CALIBRATE_KEYS.has(key));
  if (unknownKeys.length > 0) errors.push(`unknown fields rejected: ${unknownKeys.slice(0, 10).join(", ")}`);

  const { domain, tool } = payload;
  if (typeof domain !== "string" || !DOMAIN_RE.test(domain)) {
    errors.push("domain must be a lowercase slug (a-z, 0-9, '_' or '-', 2-64 characters)");
  }
  if (typeof tool !== "string" || !TOOL_NAME_RE.test(tool)) {
    errors.push("tool must be 1-128 characters of [A-Za-z0-9_.:/-]");
  }
  const args = checkArguments(payload.arguments, "arguments", errors, []);

  if (errors.length > 0 || args === null) return { ok: false, errors };
  return { ok: true, value: { domain: domain as string, tool: tool as string, arguments: args } };
}
