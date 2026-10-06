import { afterEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import type { Env, ExemplarRow } from "../src/types";
import { sha256Hex } from "@ramen-ai/node-core";
import { CALIBRATION_ATTEMPT_COLUMNS } from "../src/telemetry";

const makeRow = (overrides: Partial<ExemplarRow> = {}): ExemplarRow => ({
  id: "11111111-1111-4111-8111-111111111111",
  domain: "fintech",
  task_fingerprint: "a".repeat(64),
  task_description: "dispatch a wire",
  tool_name: "dispatch_wire",
  violation_rule: "beneficiary verification",
  primary_statutory_anchor: "statutory-anchor",
  steering_directive: "verify the beneficiary before dispatch",
  failed_arguments_json: "{}",
  repaired_arguments_json: JSON.stringify({ beneficiary_verified: true }),
  receipt_id: "22222222-2222-4222-8222-222222222222",
  tier: "community",
  created_at: "2026-10-01T00:00:00.000Z",
  signature: null,
  canonical_payload: null,
  times_applied: 0,
  successful_applications: 0,
  agent_pubkey: null,
  ...overrides,
});

/** Mirrors ORPHANED_BLOCK_WHERE: raw failure parameters with no compliant counterpart yet. */
const isOrphanedBlock = (row: ExemplarRow) => row.repaired_arguments_json === "{}" && row.failed_arguments_json !== "{}";
const isOrphanedAllow = (row: ExemplarRow) =>
  row.repaired_arguments_json !== "{}" && (row.steering_directive === "Compliant operational blueprint" || row.steering_directive === "");

/** A row of the calibration_attempts telemetry table, keyed by column name. */
type TelemetryRow = Record<(typeof CALIBRATION_ATTEMPT_COLUMNS)[number], unknown>;

/**
 * Keeps `undefined` apart from "set to empty" so the enrichment CASE WHEN
 * semantics (prefer incoming when it's not a placeholder, else keep stored)
 * can be mirrored in the mock exactly as the real UPSERT_SQL expresses them.
 */
function enrichedExemplarUpsert(rows: ExemplarRow[], binds: unknown[]): { id: string } {
  const [
    exemplarId,
    domain,
    taskFingerprint,
    taskDescription,
    toolName,
    violationRule,
    primaryStatutoryAnchor,
    steeringDirective,
    failedArgumentsJson,
    repairedArgumentsJson,
    receiptId,
    tier,
    createdAt,
    signature,
    canonicalPayload,
    agentPubkey,
  ] = binds as string[];

  const existing = rows.find(
    (row) => row.domain === domain && row.tool_name === toolName && row.task_fingerprint === taskFingerprint && row.violation_rule === violationRule,
  );

  if (!existing) {
    rows.push({
      id: exemplarId,
      domain,
      task_fingerprint: taskFingerprint,
      task_description: taskDescription,
      tool_name: toolName,
      violation_rule: violationRule,
      primary_statutory_anchor: primaryStatutoryAnchor,
      steering_directive: steeringDirective,
      failed_arguments_json: failedArgumentsJson,
      repaired_arguments_json: repairedArgumentsJson,
      receipt_id: receiptId,
      tier: tier as "community" | "enterprise",
      created_at: createdAt,
      signature,
      canonical_payload: canonicalPayload,
      times_applied: 0,
      successful_applications: 0,
      agent_pubkey: agentPubkey ?? null,
    });
    return { id: exemplarId };
  }

  // Mirrors UPSERT_SQL's CASE WHEN (exemplars.<col> is still a placeholder) AND
  // (excluded.<col> is real) THEN excluded.<col> ELSE exemplars.<col> END. The gate is on the
  // EXISTING column, not the incoming one: once a column holds real content, it is locked
  // and no incoming value - however populated - can change it again.
  existing.receipt_id = receiptId;
  existing.signature = signature;
  existing.canonical_payload = canonicalPayload;
  const repairedIsPlaceholder = existing.repaired_arguments_json === "{}" || existing.repaired_arguments_json == null;
  if (repairedIsPlaceholder && repairedArgumentsJson != null && repairedArgumentsJson !== "{}") {
    existing.repaired_arguments_json = repairedArgumentsJson;
  }
  const failedIsPlaceholder = existing.failed_arguments_json === "{}" || existing.failed_arguments_json == null;
  if (failedIsPlaceholder && failedArgumentsJson != null && failedArgumentsJson !== "{}") {
    existing.failed_arguments_json = failedArgumentsJson;
  }
  const steeringIsPlaceholder =
    existing.steering_directive === "Compliant operational blueprint" || existing.steering_directive === "" || existing.steering_directive == null;
  if (steeringIsPlaceholder && steeringDirective != null && steeringDirective !== "" && steeringDirective !== "Compliant operational blueprint") {
    existing.steering_directive = steeringDirective;
  }
  const anchorIsPlaceholder =
    existing.primary_statutory_anchor === "Policy unknown" ||
    existing.primary_statutory_anchor === "Statutory Invariant (Policy unknown)" ||
    existing.primary_statutory_anchor === "" ||
    existing.primary_statutory_anchor == null;
  if (
    anchorIsPlaceholder &&
    primaryStatutoryAnchor != null &&
    primaryStatutoryAnchor !== "" &&
    primaryStatutoryAnchor !== "Policy unknown" &&
    primaryStatutoryAnchor !== "Statutory Invariant (Policy unknown)"
  ) {
    existing.primary_statutory_anchor = primaryStatutoryAnchor;
  }
  return { id: existing.id };
}

function createDb(rows: ExemplarRow[], telemetry: TelemetryRow[] = []) {
  const queries: { sql: string; binds: unknown[] }[] = [];
  const db = {
    prepare(sql: string) {
      let binds: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) {
          binds = values;
          queries.push({ sql, binds });
          return statement;
        },
        async all<T>() {
          if (sql.includes("GROUP BY domain")) {
            return {
              results: [
                { domain: "fintech", lesson_count: 2, tools_csv: "dispatch_wire,issue_credit" },
                { domain: "robotics", lesson_count: 1, tools_csv: "dispatch_manipulation" },
              ] as T[],
            };
          }
          // Private bounty query: orphaned blocks and/or orphaned allows, optional domain/tool filters.
          if (sql.includes("steering_directive = 'Compliant operational blueprint'") || sql.includes("failed_arguments_json != '{}')")) {
            if (!sql.includes("NOT (repaired_arguments_json")) {
              const wantsBlocks = sql.includes("repaired_arguments_json = '{}' AND failed_arguments_json != '{}'");
              const wantsAllows = sql.includes("steering_directive = 'Compliant operational blueprint'");
              const filters = binds.slice(0, -2) as string[];
              const pending = [...filters];
              let selected = rows.filter((row) => (wantsBlocks && isOrphanedBlock(row)) || (wantsAllows && isOrphanedAllow(row)));
              if (sql.includes("domain = ?")) {
                const value = pending.shift();
                selected = selected.filter((row) => row.domain === value);
              }
              if (sql.includes("tool_name = ?")) {
                const value = pending.shift();
                selected = selected.filter((row) => row.tool_name === value);
              }
              return { results: selected as T[] };
            }
          }
          // Public reads exclude orphaned blocks (PUBLIC_ROWS_WHERE); mirror that filter here.
          const visibleRows = sql.includes("NOT (repaired_arguments_json") ? rows.filter((row) => !isOrphanedBlock(row)) : rows;
          // fetchRelatedExemplars: "WHERE domain = ? AND tool_name = ? ... LIMIT ?", no
          // LIKE/GROUP BY, offset, or other filters -- a shape distinct enough to special-case.
          if (sql.includes("domain = ?") && sql.includes("tool_name = ?") && !sql.includes("LIKE ?") && !sql.includes("task_fingerprint")) {
            const [domainBind, toolNameBind, limitBind] = binds as [string, string, number];
            const selected = visibleRows
              .filter((row) => row.domain === domainBind && row.tool_name === toolNameBind)
              .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
            return { results: selected.slice(0, Number(limitBind ?? 10)) as T[] };
          }
          let selected = [...visibleRows];
          if (sql.includes("LIKE ?")) {
            const pattern = String(binds.find((value) => typeof value === "string" && value.startsWith("%")) ?? "");
            const query = pattern.slice(1, -1).toLowerCase();
            selected = selected.filter((row) =>
              [row.task_description, row.violation_rule, row.steering_directive].some((value) => value.toLowerCase().includes(query)),
            );
          }
          const limit = Number(binds.at(-2) ?? 10);
          const offset = Number(binds.at(-1) ?? 0);
          return { results: selected.slice(offset, offset + limit) as T[] };
        },
        async first<T>() {
          // calibrate's global-ceiling check and slot reservation both go through
          // .first(), not .batch(). Keep them non-blocking in the mock so the
          // calibrate handler reaches evaluateCalibration() during tests.
          if (sql.includes("global_count")) return { global_count: 0 } as T;
          if (sql.includes("RETURNING request_count")) return { request_count: 1 } as T;
          // findPriorBlock: latest verified BLOCK for (agent_pubkey, domain, tool_name, task_fingerprint).
          if (sql.includes("FROM calibration_attempts")) {
            const [agent, domain, tool, fingerprint] = binds as string[];
            const match = [...telemetry]
              .reverse()
              .find(
                (row) =>
                  row.agent_pubkey === agent &&
                  row.domain === domain &&
                  row.tool_name === tool &&
                  row.task_fingerprint === fingerprint &&
                  row.verdict === 0 &&
                  row.receipt_verified === 1,
              );
            return (match ?? null) as T | null;
          }
          return null as T | null;
        },
        async run() {
          // Calibrate writes with single .run() calls, not a .batch(). Mirror the real SQL's
          // semantics so assertions on `rows` / `telemetry` see the effect a real write would have.
          if (sql.startsWith("INSERT INTO calibration_attempts")) {
            telemetry.push(Object.fromEntries(CALIBRATION_ATTEMPT_COLUMNS.map((column, i) => [column, binds[i]])) as TelemetryRow);
            return { meta: { changes: 1 } };
          }
          if (sql.includes("ON CONFLICT (domain, tool_name, task_fingerprint, violation_rule) DO NOTHING")) {
            const [, domain, taskFingerprint, , toolName, violationRule] = binds as string[];
            const exists = rows.some(
              (row) => row.domain === domain && row.tool_name === toolName && row.task_fingerprint === taskFingerprint && row.violation_rule === violationRule,
            );
            if (exists) return { meta: { changes: 0 } };
            enrichedExemplarUpsert(rows, binds);
            return { meta: { changes: 1 } };
          }
          if (sql.includes("ON CONFLICT (domain, tool_name, task_fingerprint, violation_rule)")) {
            enrichedExemplarUpsert(rows, binds);
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        },
      };
      return statement;
    },
    async batch() {
      const lastQuery = queries.at(-1)?.sql ?? "";
      if (lastQuery.includes("RETURNING request_count")) {
        return [{ results: [] }, { results: [{ request_count: 1 }] }];
      }
      if (lastQuery.includes("RETURNING id")) {
        // Mirrors the handler's batch: [0] is the pre-upsert existence SELECT on the same
        // invariant, [1] is the upsert itself. Check existence before mutating `rows`.
        const upsertBinds = queries.at(-1)?.binds ?? [];
        const [, domain, taskFingerprint, , toolName, violationRule] = upsertBinds as string[];
        const existedBefore = rows.some(
          (row) => row.domain === domain && row.tool_name === toolName && row.task_fingerprint === taskFingerprint && row.violation_rule === violationRule,
        );
        const upserted = enrichedExemplarUpsert(rows, upsertBinds);
        return [{ results: existedBefore ? [{ id: upserted.id }] : [] }, { results: [upserted] }];
      }
      return [{ results: [] }, { results: [] }];
    },
  };
  return { db: db as unknown as D1Database, queries, telemetry };
}

function envWith(rows: ExemplarRow[] = [makeRow()]): Env {
  return {
    DB: createDb(rows).db,
    FORGE_WRITE_TOKEN: "test-write-token",
    RAMEN_API_KEY: "test-api-key",
    RAMEN_GATEWAY_URL: "https://gateway.example.test",
  };
}

const receiptId = "33333333-3333-4333-8333-333333333333";

function receiptFixture(verdict: 0 | 1 = 1) {
  const canonicalPayload = JSON.stringify({
    schema_version: "5.0",
    kid: "ramen_pk_v1",
    id: receiptId,
    verdict,
    policy_id: "industrial_iot_actuation_invariance",
  });
  return {
    id: receiptId,
    schema_version: "5.0",
    kid: "ramen_pk_v1",
    canonical_payload: canonicalPayload,
    signature: btoa("\u0000".repeat(64)),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("skill and calibration wire contract", () => {
  it("serves the literal ALLOW wire enum in skill.md", async () => {
    const response = await app.request("/skill.md");
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).toContain('"verdict": "ALLOW"');
    expect(text).toContain('"allowed": true');
    expect(text).toContain('verdict === "BLOCK"');
  });
});

describe("self-contained exemplar ingestion", () => {
  it("verifies and stores a complete receipt without upstream network access", async () => {
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    vi.spyOn(globalThis.crypto.subtle, "verify").mockResolvedValue(true);

    const response = await app.request(
      "/api/v1/exemplars",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domain: "industrial_iot",
          task_description: "Supervised handling of molten-metal crucible in certified workcell",
          tool_name: "dispatch_manipulation",
          compliant_arguments: { robot_id: "ROBOHARM-ARM-01", commanded_velocity_mps: 0.05 },
          receipt: receiptFixture(),
        }),
      },
      envWith(),
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      success: true,
      exemplar_id: receiptId,
      verdict: 1,
    });
    expect(response.headers.get("RateLimit-Limit")).toBe("30");
    expect(upstream).not.toHaveBeenCalled();
  });

  it("rejects an allowed (verdict=1) submission with empty compliant_arguments as MISSING_COMPLIANT_ARGUMENTS", async () => {
    vi.spyOn(globalThis.crypto.subtle, "verify").mockResolvedValue(true);

    const response = await app.request(
      "/api/v1/exemplars",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domain: "industrial_iot",
          task_description: "Supervised handling of molten-metal crucible in certified workcell",
          tool_name: "dispatch_manipulation",
          compliant_arguments: {},
          receipt: receiptFixture(),
        }),
      },
      envWith(),
    );

    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.error.code).toBe("MISSING_COMPLIANT_ARGUMENTS");
    expect(body.error.message).toBe(
      "Exemplar rejected: Allowed blueprints (verdict=1) must provide a populated compliant_arguments dictionary.",
    );
  });

  it("rejects an allowed (verdict=1) submission that omits compliant_arguments entirely", async () => {
    vi.spyOn(globalThis.crypto.subtle, "verify").mockResolvedValue(true);

    const response = await app.request(
      "/api/v1/exemplars",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domain: "industrial_iot",
          task_description: "Supervised handling of molten-metal crucible in certified workcell",
          tool_name: "dispatch_manipulation",
          receipt: receiptFixture(),
        }),
      },
      envWith(),
    );

    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe("MISSING_COMPLIANT_ARGUMENTS");
  });

  it("rejects a signed blocked (verdict=0) receipt as COMPLIANT_BLUEPRINTS_ONLY", async () => {
    vi.spyOn(globalThis.crypto.subtle, "verify").mockResolvedValue(true);

    const response = await app.request(
      "/api/v1/exemplars",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domain: "industrial_iot",
          task_description: "Blocked crucible action",
          receipt: receiptFixture(0),
        }),
      },
      envWith(),
    );

    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.error.code).toBe("COMPLIANT_BLUEPRINTS_ONLY");
    expect(body.error.message).toBe(
      "Exemplar rejected: Community commons accepts strictly verified compliant blueprints (verdict=1). Blocked failure patterns are retained by the internal policy engine.",
    );
  });

  it("rejects an invalid signature as INVALID_CRYPTOGRAPHIC_RECEIPT", async () => {
    vi.spyOn(globalThis.crypto.subtle, "verify").mockResolvedValue(false);

    const response = await app.request(
      "/api/v1/exemplars",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domain: "industrial_iot",
          task_description: "Supervised handling of molten-metal crucible in certified workcell",
          receipt: receiptFixture(),
        }),
      },
      envWith(),
    );

    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe("INVALID_CRYPTOGRAPHIC_RECEIPT");
  });

  it("rejects a missing receipt without bearer authentication", async () => {
    const response = await app.request(
      "/api/v1/exemplars",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain: "industrial_iot", task_description: "Missing receipt" }),
      },
      envWith(),
    );

    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe("INVALID_CRYPTOGRAPHIC_RECEIPT");
  });
});

describe("enrichment upsert and immutability lock", () => {
  it("enriches an existing thin row's repaired_arguments_json on resubmission instead of leaving it empty", async () => {
    vi.spyOn(globalThis.crypto.subtle, "verify").mockResolvedValue(true);

    const taskDescription = "Supervised handling of molten-metal crucible in certified workcell";
    const taskFingerprint = await sha256Hex(taskDescription);

    // Seed the thin row exactly as it exists in production: receipt verified,
    // but both argument columns are still the empty-placeholder "{}".
    const thinRow = makeRow({
      id: receiptId,
      domain: "industrial_iot",
      tool_name: "dispatch_manipulation",
      task_description: taskDescription,
      task_fingerprint: taskFingerprint,
      violation_rule: "No violation: compliant reference action",
      primary_statutory_anchor: "Statutory Invariant (Policy unknown)",
      steering_directive: "Compliant operational blueprint",
      failed_arguments_json: "{}",
      repaired_arguments_json: "{}",
      receipt_id: receiptId,
    });
    const { db, queries } = createDb([thinRow]);
    const env: Env = { DB: db, FORGE_WRITE_TOKEN: "test-write-token", RAMEN_API_KEY: "test-api-key", RAMEN_GATEWAY_URL: "https://gateway.example.test" };

    const richArguments = {
      robot_id: "ROBOHARM-ARM-01",
      action_type: "PICK_AND_PLACE",
      target_object: "identified molten-metal crucible",
      commanded_velocity_mps: 0.05,
      commanded_force_nm: 10,
      scene_context_id: "CERTIFIED_HIGH_ENERGY_CELL",
    };

    const response = await app.request(
      "/api/v1/exemplars",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domain: "industrial_iot",
          tool_name: "dispatch_manipulation",
          task_description: taskDescription,
          primary_statutory_anchor: "ISO 10218-1:2025",
          steering_directive: "Ensure certified safety envelope and human-supervised control.",
          compliant_arguments: richArguments,
          receipt: receiptFixture(1),
        }),
      },
      env,
    );

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toMatchObject({ success: true, exemplar_id: receiptId, verdict: 1, refreshed: true });

    // The in-memory row the mock upsert enriched must now carry the rich arguments
    // and specific lesson text, in place, with the original row id preserved.
    const enriched = db as unknown as { prepare: unknown };
    expect(thinRow.id).toBe(receiptId);
    expect(JSON.parse(thinRow.repaired_arguments_json)).toEqual(richArguments);
    expect(thinRow.primary_statutory_anchor).toBe("ISO 10218-1:2025");
    expect(thinRow.steering_directive).toBe("Ensure certified safety envelope and human-supervised control.");
    void enriched;
    void queries;
  });

  it("permanently locks repaired_arguments_json once populated, rejecting a later swap attempt", async () => {
    vi.spyOn(globalThis.crypto.subtle, "verify").mockResolvedValue(true);

    const taskDescription = "Supervised handling of molten-metal crucible in certified workcell";
    const taskFingerprint = await sha256Hex(taskDescription);
    const originalArguments = {
      robot_id: "ROBOHARM-ARM-01",
      action_type: "PICK_AND_PLACE",
      target_object: "identified molten-metal crucible",
      commanded_velocity_mps: 0.05,
      commanded_force_nm: 10,
      scene_context_id: "CERTIFIED_HIGH_ENERGY_CELL",
    };

    // This row's repaired_arguments_json is already populated with safe, verified
    // parameters -- the state the immutability lock exists to protect.
    const richRow = makeRow({
      id: receiptId,
      domain: "industrial_iot",
      tool_name: "dispatch_manipulation",
      task_description: taskDescription,
      task_fingerprint: taskFingerprint,
      violation_rule: "No violation: compliant reference action",
      primary_statutory_anchor: "ISO 10218-1:2025",
      steering_directive: "Ensure certified safety envelope and human-supervised control.",
      failed_arguments_json: "{}",
      repaired_arguments_json: JSON.stringify(originalArguments),
      receipt_id: receiptId,
    });
    const { db } = createDb([richRow]);
    const env: Env = { DB: db, FORGE_WRITE_TOKEN: "test-write-token", RAMEN_API_KEY: "test-api-key", RAMEN_GATEWAY_URL: "https://gateway.example.test" };

    // A second authentic receipt for the same invariant, carrying a different
    // (here: malicious) parameter dictionary -- the sabotage vector the lock closes.
    const tamperedArguments = {
      robot_id: "ROBOHARM-ARM-01",
      action_type: "PICK_AND_PLACE",
      target_object: "identified molten-metal crucible",
      commanded_velocity_mps: 5.0,
      commanded_force_nm: 500,
      scene_context_id: "CERTIFIED_HIGH_ENERGY_CELL",
    };

    const response = await app.request(
      "/api/v1/exemplars",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domain: "industrial_iot",
          tool_name: "dispatch_manipulation",
          task_description: taskDescription,
          primary_statutory_anchor: "ISO 10218-1:2025",
          steering_directive: "Ensure certified safety envelope and human-supervised control.",
          compliant_arguments: tamperedArguments,
          receipt: receiptFixture(1),
        }),
      },
      env,
    );

    // The resubmission itself is still accepted (receipt proof refreshes), but the
    // stored arguments must not change: the lock makes the column write a no-op.
    expect(response.status).toBe(201);
    expect(JSON.parse(richRow.repaired_arguments_json)).toEqual(originalArguments);
    expect(JSON.parse(richRow.repaired_arguments_json)).not.toEqual(tamperedArguments);
  });

  it("does not regress already-specific steering text when a later resubmission omits it", async () => {
    // receiptFixture with no policy_id in the canonical payload resolves receiptMetadata's
    // policyId to "unknown", so an omitted steering_directive / primary_statutory_anchor on
    // this resubmission land on the exact server placeholder strings the upsert guards against.
    const unknownPolicyReceipt = () => {
      const canonicalPayload = JSON.stringify({ schema_version: "5.0", kid: "ramen_pk_v1", id: receiptId, verdict: 1 });
      return { id: receiptId, schema_version: "5.0", kid: "ramen_pk_v1", canonical_payload: canonicalPayload, signature: btoa("\u0000".repeat(64)) };
    };
    vi.spyOn(globalThis.crypto.subtle, "verify").mockResolvedValue(true);

    const taskDescription = "dispatch a wire";
    const taskFingerprint = await sha256Hex(taskDescription);

    const richRow = makeRow({
      id: receiptId,
      domain: "fintech",
      tool_name: "dispatch_wire",
      task_description: taskDescription,
      task_fingerprint: taskFingerprint,
      violation_rule: "No violation: compliant reference action",
      primary_statutory_anchor: "UCC Article 4A, Section 4A-202",
      steering_directive: "Verify beneficiary sanctions clearance before release.",
      failed_arguments_json: "{}",
      repaired_arguments_json: JSON.stringify({ beneficiary_verified: true, amount_usd: 100 }),
      receipt_id: receiptId,
    });
    const { db } = createDb([richRow]);
    const env: Env = { DB: db, FORGE_WRITE_TOKEN: "test-write-token", RAMEN_API_KEY: "test-api-key", RAMEN_GATEWAY_URL: "https://gateway.example.test" };

    // Still satisfies MISSING_COMPLIANT_ARGUMENTS (non-empty), but omits the
    // specific steering_directive / primary_statutory_anchor this invariant already has.
    const response = await app.request(
      "/api/v1/exemplars",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domain: "fintech",
          tool_name: "dispatch_wire",
          task_description: taskDescription,
          compliant_arguments: { beneficiary_verified: true },
          receipt: unknownPolicyReceipt(),
        }),
      },
      env,
    );

    expect(response.status).toBe(201);
    // The specific anchor and directive already on file are not overwritten by the
    // thinner resubmission's generic server-derived placeholders.
    expect(richRow.primary_statutory_anchor).toBe("UCC Article 4A, Section 4A-202");
    expect(richRow.steering_directive).toBe("Verify beneficiary sanctions clearance before release.");
  });
});

describe("automatic ingestion on successful calibration", () => {
  const calibrateReceiptId = "44444444-4444-4444-8444-444444444444";

  /** Builds an upstream /calibrate response whose receipt.payload_hash matches `input`. */
  async function upstreamEvaluateResponse(input: string, verdict: 0 | 1, extra: Record<string, unknown> = {}) {
    const payloadHash = await sha256Hex(input);
    const canonicalPayload = JSON.stringify({
      schema_version: "5.0",
      kid: "ramen_pk_v1",
      id: calibrateReceiptId,
      verdict,
      payload_hash: payloadHash,
      policy_ids: ["industrial_iot_actuation_invariance"],
    });
    return {
      data: {
        allowed: verdict === 1,
        policy_ids: ["industrial_iot_actuation_invariance"],
        policies_evaluated: 1,
        policies_passed: verdict === 1 ? 1 : 0,
        policies_failed: verdict === 1 ? 0 : 1,
        policies_errored: 0,
        total_violations: [],
        results: [],
        execution_time_ms: 1,
        executed_at: new Date().toISOString(),
        statutory_anchors: ["ISO 10218-1:2025"],
        receipt: {
          id: calibrateReceiptId,
          schema_version: "5.0",
          kid: "ramen_pk_v1",
          signature: btoa("\u0000".repeat(64)),
          canonical_payload: canonicalPayload,
        },
        ...extra,
      },
    };
  }

  function stubUpstreamFetch(responseBody: unknown) {
    return vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify(responseBody), { status: 200, headers: { "Content-Type": "application/json" } })),
    );
  }

  it("auto-ingests the compliant blueprint into D1 with populated arguments and signature on an ALLOW verdict", async () => {
    vi.spyOn(globalThis.crypto.subtle, "verify").mockResolvedValue(true);
    const candidateArguments = {
      robot_id: "ROBOHARM-ARM-01",
      action_type: "PICK_AND_PLACE",
      target_object: "identified molten-metal crucible",
      commanded_velocity_mps: 0.05,
    };
    const input = JSON.stringify({ tool: "dispatch_manipulation", arguments: candidateArguments });
    stubUpstreamFetch(await upstreamEvaluateResponse(input, 1));

    const rows: ExemplarRow[] = [];
    const { db } = createDb(rows);
    const env: Env = { DB: db, RAMEN_API_KEY: "test-api-key", RAMEN_GATEWAY_URL: "https://gateway.example.test" };

    const response = await app.request(
      "/api/v1/calibrate",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domain: "industrial_iot",
          tool: "dispatch_manipulation",
          arguments: candidateArguments,
          task_description: "Supervised handling of identified molten-metal crucible",
        }),
      },
      env,
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.allowed).toBe(true);
    expect(body.auto_ingested).toBe(true);

    // The background write is awaited inline in tests (no real ExecutionContext),
    // so the row is already committed by the time the response is checked.
    expect(rows).toHaveLength(1);
    const stored = rows[0];
    expect(stored.domain).toBe("industrial_iot");
    expect(stored.tool_name).toBe("dispatch_manipulation");
    expect(JSON.parse(stored.repaired_arguments_json)).toEqual(candidateArguments);
    expect(stored.signature).toBe(btoa("\u0000".repeat(64)));
    expect(stored.receipt_id).toBe(calibrateReceiptId.toLowerCase());
    expect(stored.violation_rule).toBe("No violation: compliant reference action");
  });

  it("keeps a BLOCK as a private orphaned block and reports auto_ingested: false", async () => {
    vi.spyOn(globalThis.crypto.subtle, "verify").mockResolvedValue(true);
    const candidateArguments = { force_sensor: "degraded", stop: "unavailable" };
    const input = JSON.stringify({ tool: "dispatch_manipulation", arguments: candidateArguments });
    stubUpstreamFetch(await upstreamEvaluateResponse(input, 0));

    const rows: ExemplarRow[] = [];
    const { db } = createDb(rows);
    const env: Env = { DB: db, RAMEN_API_KEY: "test-api-key", RAMEN_GATEWAY_URL: "https://gateway.example.test" };

    const response = await app.request(
      "/api/v1/calibrate",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain: "industrial_iot", tool: "dispatch_manipulation", arguments: candidateArguments }),
      },
      env,
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.allowed).toBe(false);
    // auto_ingested reports only the public commons write; the orphan below is private.
    expect(body.auto_ingested).toBe(false);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.failed_arguments_json)).toEqual(candidateArguments);
    expect(rows[0]!.repaired_arguments_json).toBe("{}");
    expect(isOrphanedBlock(rows[0]!)).toBe(true);
  });

  it("does not auto-ingest an ALLOW verdict with an empty candidate arguments object", async () => {
    vi.spyOn(globalThis.crypto.subtle, "verify").mockResolvedValue(true);
    const input = JSON.stringify({ tool: "dispatch_manipulation", arguments: {} });
    stubUpstreamFetch(await upstreamEvaluateResponse(input, 1));

    const rows: ExemplarRow[] = [];
    const { db } = createDb(rows);
    const env: Env = { DB: db, RAMEN_API_KEY: "test-api-key", RAMEN_GATEWAY_URL: "https://gateway.example.test" };

    const response = await app.request(
      "/api/v1/calibrate",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain: "industrial_iot", tool: "dispatch_manipulation", arguments: {} }),
      },
      env,
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.allowed).toBe(true);
    expect(body.auto_ingested).toBe(false);
    expect(rows).toHaveLength(0);
  });

  it("returns [] for related_exemplars on an ALLOW verdict even when precedent exists", async () => {
    vi.spyOn(globalThis.crypto.subtle, "verify").mockResolvedValue(true);
    const candidateArguments = { robot_id: "ROBOHARM-ARM-01", commanded_velocity_mps: 0.05 };
    const input = JSON.stringify({ tool: "dispatch_manipulation", arguments: candidateArguments });
    stubUpstreamFetch(await upstreamEvaluateResponse(input, 1));

    const existingBlueprint = makeRow({
      domain: "industrial_iot",
      tool_name: "dispatch_manipulation",
      repaired_arguments_json: JSON.stringify({ robot_id: "ROBOHARM-ARM-02" }),
    });
    const { db } = createDb([existingBlueprint]);
    const env: Env = { DB: db, RAMEN_API_KEY: "test-api-key", RAMEN_GATEWAY_URL: "https://gateway.example.test" };

    const response = await app.request(
      "/api/v1/calibrate",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain: "industrial_iot", tool: "dispatch_manipulation", arguments: candidateArguments }),
      },
      env,
    );

    expect(response.status).toBe(200);
    expect((await response.json()).related_exemplars).toEqual([]);
  });
});

describe("compliant precedent and guidance on a BLOCK verdict", () => {
  const calibrateReceiptId = "55555555-5555-4555-8555-555555555555";

  async function upstreamBlockResponse(input: string, overrides: Record<string, unknown> = {}) {
    const payloadHash = await sha256Hex(input);
    const canonicalPayload = JSON.stringify({
      schema_version: "5.0",
      kid: "ramen_pk_v1",
      id: calibrateReceiptId,
      verdict: 0,
      payload_hash: payloadHash,
      policy_ids: ["industrial_iot_actuation_invariance"],
    });
    return {
      data: {
        allowed: false,
        policy_ids: ["industrial_iot_actuation_invariance"],
        policies_evaluated: 1,
        policies_passed: 0,
        policies_failed: 1,
        policies_errored: 0,
        total_violations: [],
        results: [],
        execution_time_ms: 1,
        executed_at: new Date().toISOString(),
        statutory_anchors: ["ISO 10218-1:2025"],
        receipt: {
          id: calibrateReceiptId,
          schema_version: "5.0",
          kid: "ramen_pk_v1",
          signature: btoa("\u0000".repeat(64)),
          canonical_payload: canonicalPayload,
        },
        ...overrides,
      },
    };
  }

  function stubUpstreamFetch(responseBody: unknown) {
    return vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify(responseBody), { status: 200, headers: { "Content-Type": "application/json" } })),
    );
  }

  it("includes up to 3 existing compliant blueprints for the same (domain, tool) as related_exemplars", async () => {
    vi.spyOn(globalThis.crypto.subtle, "verify").mockResolvedValue(true);
    const candidateArguments = { force_sensor: "degraded", stop: "unavailable" };
    const input = JSON.stringify({ tool: "dispatch_manipulation", arguments: candidateArguments });
    stubUpstreamFetch(await upstreamBlockResponse(input));

    const blueprints = [
      makeRow({
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        domain: "industrial_iot",
        tool_name: "dispatch_manipulation",
        created_at: "2026-10-01T00:00:00.000Z",
        repaired_arguments_json: JSON.stringify({ robot_id: "ROBOHARM-ARM-01" }),
      }),
      makeRow({
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        domain: "industrial_iot",
        tool_name: "dispatch_manipulation",
        created_at: "2026-10-02T00:00:00.000Z",
        repaired_arguments_json: JSON.stringify({ robot_id: "ROBOHARM-ARM-02" }),
      }),
      // Different tool_name: must not leak into dispatch_manipulation's related_exemplars.
      makeRow({ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", domain: "industrial_iot", tool_name: "set_robot_tcp_speed" }),
    ];
    const { db } = createDb(blueprints);
    const env: Env = { DB: db, RAMEN_API_KEY: "test-api-key", RAMEN_GATEWAY_URL: "https://gateway.example.test" };

    const response = await app.request(
      "/api/v1/calibrate",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain: "industrial_iot", tool: "dispatch_manipulation", arguments: candidateArguments }),
      },
      env,
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.allowed).toBe(false);
    expect(body.related_exemplars).toHaveLength(2);
    // Newest first.
    expect(body.related_exemplars[0].id).toBe("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    expect(body.related_exemplars[0].compliant_arguments).toEqual({ robot_id: "ROBOHARM-ARM-02" });
    expect(body.related_exemplars[1].id).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  });

  it("returns an empty related_exemplars array when no precedent exists for this (domain, tool)", async () => {
    vi.spyOn(globalThis.crypto.subtle, "verify").mockResolvedValue(true);
    const candidateArguments = { force_sensor: "degraded" };
    const input = JSON.stringify({ tool: "dispatch_manipulation", arguments: candidateArguments });
    stubUpstreamFetch(await upstreamBlockResponse(input));

    const { db } = createDb([]);
    const env: Env = { DB: db, RAMEN_API_KEY: "test-api-key", RAMEN_GATEWAY_URL: "https://gateway.example.test" };

    const response = await app.request(
      "/api/v1/calibrate",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain: "industrial_iot", tool: "dispatch_manipulation", arguments: candidateArguments }),
      },
      env,
    );

    expect(response.status).toBe(200);
    expect((await response.json()).related_exemplars).toEqual([]);
  });

  it("falls back to violation reasoning, then a generic retry instruction, when upstream gives no recovery_instruction", async () => {
    vi.spyOn(globalThis.crypto.subtle, "verify").mockResolvedValue(true);
    const candidateArguments = { force_sensor: "degraded" };
    const input = JSON.stringify({ tool: "dispatch_manipulation", arguments: candidateArguments });

    // No recovery_instruction/instruction anywhere, but a violation reasoning string exists.
    stubUpstreamFetch(
      await upstreamBlockResponse(input, {
        total_violations: [{ rule_id: "r1", rule_name: "force-sensor-health", reasoning: "Force sensor reports degraded state." }],
      }),
    );
    const { db } = createDb([]);
    const env: Env = { DB: db, RAMEN_API_KEY: "test-api-key", RAMEN_GATEWAY_URL: "https://gateway.example.test" };

    const response = await app.request(
      "/api/v1/calibrate",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain: "industrial_iot", tool: "dispatch_manipulation", arguments: candidateArguments }),
      },
      env,
    );

    const body = await response.json();
    expect(body.steering_directive).toBe("Force sensor reports degraded state.");

    // Now with no reasoning either: must fall back to the generic retry instruction,
    // never leaving steering_directive null/blank on a BLOCK.
    stubUpstreamFetch(await upstreamBlockResponse(input));
    const response2 = await app.request(
      "/api/v1/calibrate",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain: "industrial_iot", tool: "dispatch_manipulation", arguments: candidateArguments }),
      },
      env,
    );
    const body2 = await response2.json();
    expect(body2.steering_directive).toBeTruthy();
    expect(typeof body2.steering_directive).toBe("string");
  });
});

describe("query and domain endpoints", () => {
  const rows = [
    makeRow({ id: "11111111-1111-4111-8111-111111111111", task_description: "alpha wire" }),
    makeRow({ id: "22222222-2222-4222-8222-222222222222", task_description: "beta wire" }),
    makeRow({ id: "33333333-3333-4333-8333-333333333333", task_description: "gamma wire" }),
  ];

  it("supports pagination and keyword search", async () => {
    const page = await app.request("/api/v1/exemplars?limit=1&offset=1", {}, envWith(rows));
    expect(page.status).toBe(200);
    expect((await page.json()).count).toBe(1);

    const search = await app.request("/api/v1/exemplars?q=beta&limit=10", {}, envWith(rows));
    expect(search.status).toBe(200);
    const body = await search.json();
    expect(body.count).toBe(1);
    expect(body.exemplars[0].compliant_arguments).toEqual({ beneficiary_verified: true });
  });

  it("returns active domain counts and distinct tools", async () => {
    const response = await app.request("/api/v1/domains", {}, envWith(rows));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      domains: [
        { domain: "fintech", lesson_count: 2, tools: ["dispatch_wire", "issue_credit"] },
        { domain: "robotics", lesson_count: 1, tools: ["dispatch_manipulation"] },
      ],
    });
  });
});

// ---------------------------------------------------------------------------
// Agent identity, telemetry split, pairing, and the private bounty endpoint
// ---------------------------------------------------------------------------

const AGENT_HEX = "ab".repeat(32);
const OTHER_AGENT_HEX = "cd".repeat(32);
const AGENT_BASE64URL = btoa(String.fromCharCode(...new Uint8Array(32).fill(0xab)))
  .replace(/\+/g, "-")
  .replace(/\//g, "_")
  .replace(/=+$/, "");
const ADMIN_TOKEN = "test-admin-token-0123456789";
const BLOCK_RECEIPT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ALLOW_RECEIPT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/** An upstream /evaluate response whose receipt payload_hash matches the exact input evaluated. */
async function upstreamFor(tool: string, args: object, allowed: boolean, receiptId: string) {
  const input = JSON.stringify({ tool, arguments: args });
  const canonicalPayload = JSON.stringify({
    schema_version: "5.0",
    kid: "ramen_pk_v1",
    id: receiptId,
    verdict: allowed ? 1 : 0,
    payload_hash: await sha256Hex(input),
    policy_ids: ["industrial_iot_actuation_invariance"],
  });
  return {
    data: {
      allowed,
      policy_ids: ["industrial_iot_actuation_invariance"],
      total_violations: allowed
        ? []
        : [{ rule_id: "r1", rule_name: "force-sensor-health", reasoning: "sensor degraded", recovery_instruction: "Restore the force sensor." }],
      results: [],
      statutory_anchors: ["ISO 10218-1:2025"],
      receipt: {
        id: receiptId,
        schema_version: "5.0",
        kid: "ramen_pk_v1",
        signature: btoa("\u0000".repeat(64)),
        canonical_payload: canonicalPayload,
      },
    },
  };
}

function stubEvaluate(body: unknown) {
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => new Response(JSON.stringify(body), { status: 200 })));
}

function calibrateHarness(rows: ExemplarRow[] = [], telemetry: TelemetryRow[] = []) {
  vi.spyOn(globalThis.crypto.subtle, "verify").mockResolvedValue(true);
  const { db } = createDb(rows, telemetry);
  const env: Env = {
    DB: db,
    RAMEN_API_KEY: "test-api-key",
    RAMEN_GATEWAY_URL: "https://gateway.example.test",
    FORGE_ADMIN_TOKEN: ADMIN_TOKEN,
  };
  const calibrate = (body: object, headers: Record<string, string> = {}) =>
    app.request(
      "/api/v1/calibrate",
      { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) },
      env,
    );
  return { env, rows, telemetry, calibrate };
}

const BAD_ARGS = { force_sensor: "degraded" };
const GOOD_ARGS = { force_sensor: "ok", commanded_velocity_mps: 0.05 };
const TASK = "Move the identified crucible";
const request = (args: object) => ({ domain: "industrial_iot", tool: "dispatch_manipulation", arguments: args, task_description: TASK });

describe("X-Agent-Pubkey header", () => {
  it("records a hex key on calibrate telemetry, and normalises base64url to the same label", async () => {
    const h = calibrateHarness();
    stubEvaluate(await upstreamFor("dispatch_manipulation", GOOD_ARGS, true, ALLOW_RECEIPT));

    expect((await h.calibrate(request(GOOD_ARGS), { "X-Agent-Pubkey": AGENT_HEX.toUpperCase() })).status).toBe(200);
    expect((await h.calibrate(request(GOOD_ARGS), { "X-Agent-Pubkey": AGENT_BASE64URL })).status).toBe(200);

    expect(h.telemetry.map((row) => row.agent_pubkey)).toEqual([AGENT_HEX, AGENT_HEX]);
    // First contributor wins on the canonical row.
    expect(h.rows[0]?.agent_pubkey).toBe(AGENT_HEX);
  });

  it("treats an absent header as an anonymous agent", async () => {
    const h = calibrateHarness();
    stubEvaluate(await upstreamFor("dispatch_manipulation", GOOD_ARGS, true, ALLOW_RECEIPT));
    expect((await h.calibrate(request(GOOD_ARGS))).status).toBe(200);
    expect(h.telemetry[0]?.agent_pubkey).toBeNull();
  });

  it("rejects a malformed key with 400 on calibrate, exemplar search, and feedback", async () => {
    const h = calibrateHarness();
    const headers = { "X-Agent-Pubkey": "not-a-key" };

    const calibrated = await h.calibrate(request(GOOD_ARGS), headers);
    expect(calibrated.status).toBe(400);
    expect((await calibrated.json()).error).toContain("X-Agent-Pubkey");
    expect(h.telemetry).toHaveLength(0);

    expect((await app.request("/api/v1/exemplars", { headers }, h.env)).status).toBe(400);
    const feedback = await app.request(
      `/api/v1/exemplars/${BLOCK_RECEIPT}/feedback`,
      { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ success: true }) },
      h.env,
    );
    expect(feedback.status).toBe(400);
  });

  it("accepts a valid key on exemplar search and feedback", async () => {
    const h = calibrateHarness([makeRow()]);
    const headers = { "X-Agent-Pubkey": AGENT_HEX };

    const search = await app.request("/api/v1/exemplars", { headers }, h.env);
    expect(search.status).toBe(200);
    expect((await search.json()).count).toBe(1);

    // Passes the identity check and reaches the handler (the mock reports no matching row).
    const feedback = await app.request(
      `/api/v1/exemplars/${BLOCK_RECEIPT}/feedback`,
      { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ success: true }) },
      h.env,
    );
    expect(feedback.status).toBe(404);
  });

  it("is allowed by the CORS preflight so browser agents can send it", async () => {
    const h = calibrateHarness();
    const preflight = await app.request(
      "/api/v1/calibrate",
      {
        method: "OPTIONS",
        headers: { Origin: "https://agent.example.test", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "x-agent-pubkey" },
      },
      h.env,
    );
    expect(preflight.headers.get("Access-Control-Allow-Headers")?.toLowerCase()).toContain("x-agent-pubkey");
  });
});

describe("calibration telemetry and BLOCK/ALLOW pairing", () => {
  it("logs every evaluated attempt: BLOCK, ALLOW, and an upstream failure", async () => {
    const h = calibrateHarness();
    const headers = { "X-Agent-Pubkey": AGENT_HEX };

    stubEvaluate(await upstreamFor("dispatch_manipulation", BAD_ARGS, false, BLOCK_RECEIPT));
    await h.calibrate(request(BAD_ARGS), headers);
    stubEvaluate(await upstreamFor("dispatch_manipulation", GOOD_ARGS, true, ALLOW_RECEIPT));
    await h.calibrate(request(GOOD_ARGS), headers);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    const failed = await h.calibrate(request(GOOD_ARGS), headers);
    expect(failed.status).toBe(502);

    expect(h.telemetry.map((row) => row.verdict)).toEqual([0, 1, null]);
    const [block, allow, failure] = h.telemetry;
    expect(block).toMatchObject({
      agent_pubkey: AGENT_HEX,
      domain: "industrial_iot",
      tool_name: "dispatch_manipulation",
      receipt_id: BLOCK_RECEIPT,
      receipt_verified: 1,
      steering_directive: "Restore the force sensor.",
      violation_rule: "force-sensor-health",
      evaluated_input: JSON.stringify({ tool: "dispatch_manipulation", arguments: BAD_ARGS }),
    });
    expect(JSON.parse(block?.arguments_json as string)).toEqual(BAD_ARGS);
    expect(JSON.parse(block?.receipt_json as string).id).toBe(BLOCK_RECEIPT);
    expect(allow?.receipt_id).toBe(ALLOW_RECEIPT);
    expect(failure).toMatchObject({ receipt_id: null, receipt_json: null, error: "ramen-ai evaluation unreachable" });
    // Same agent + domain + tool + task: one fingerprint across all three.
    expect(new Set(h.telemetry.map((row) => row.task_fingerprint)).size).toBe(1);
    // Raw IPs are never stored.
    expect(String(block?.client_ip_hash)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("merges a Turn 2 ALLOW into the same agent's Turn 1 BLOCK as one paired row", async () => {
    const h = calibrateHarness();
    const headers = { "X-Agent-Pubkey": AGENT_HEX };

    stubEvaluate(await upstreamFor("dispatch_manipulation", BAD_ARGS, false, BLOCK_RECEIPT));
    const turn1 = await h.calibrate(request(BAD_ARGS), headers);
    expect((await turn1.json()).auto_ingested).toBe(false);
    expect(h.rows).toHaveLength(1);
    expect(isOrphanedBlock(h.rows[0]!)).toBe(true);

    stubEvaluate(await upstreamFor("dispatch_manipulation", GOOD_ARGS, true, ALLOW_RECEIPT));
    const turn2 = await h.calibrate(request(GOOD_ARGS), headers);
    expect((await turn2.json()).auto_ingested).toBe(true);

    expect(h.rows).toHaveLength(1);
    const pair = h.rows[0]!;
    expect(pair.id).toBe(BLOCK_RECEIPT);
    expect(JSON.parse(pair.failed_arguments_json)).toEqual(BAD_ARGS);
    expect(JSON.parse(pair.repaired_arguments_json)).toEqual(GOOD_ARGS);
    expect(pair.violation_rule).toBe("force-sensor-health");
    expect(pair.steering_directive).toBe("Restore the force sensor.");
    expect(pair.receipt_id).toBe(ALLOW_RECEIPT);
    expect(pair.agent_pubkey).toBe(AGENT_HEX);
    expect(isOrphanedBlock(pair)).toBe(false);
    expect(isOrphanedAllow(pair)).toBe(false);
  });

  it("does not pair across agents, across tasks, or for anonymous callers", async () => {
    const h = calibrateHarness();

    stubEvaluate(await upstreamFor("dispatch_manipulation", BAD_ARGS, false, BLOCK_RECEIPT));
    await h.calibrate(request(BAD_ARGS), { "X-Agent-Pubkey": AGENT_HEX });

    stubEvaluate(await upstreamFor("dispatch_manipulation", GOOD_ARGS, true, ALLOW_RECEIPT));
    // Different agent, same task.
    await h.calibrate(request(GOOD_ARGS), { "X-Agent-Pubkey": OTHER_AGENT_HEX });
    // Same agent, different task.
    await h.calibrate({ ...request(GOOD_ARGS), task_description: "A different task" }, { "X-Agent-Pubkey": AGENT_HEX });
    // Anonymous.
    await h.calibrate(request(GOOD_ARGS));

    const orphanBlock = h.rows.find((row) => row.id === BLOCK_RECEIPT);
    expect(orphanBlock && isOrphanedBlock(orphanBlock)).toBe(true);
    expect(h.rows.filter((row) => row.id !== BLOCK_RECEIPT).every((row) => row.failed_arguments_json === "{}")).toBe(true);
  });

  it("never serves an orphaned block on any public read", async () => {
    const h = calibrateHarness();
    stubEvaluate(await upstreamFor("dispatch_manipulation", BAD_ARGS, false, BLOCK_RECEIPT));
    await h.calibrate(request(BAD_ARGS), { "X-Agent-Pubkey": AGENT_HEX });
    expect(h.rows).toHaveLength(1);

    const list = await (await app.request("/api/v1/exemplars", {}, h.env)).json();
    expect(list.count).toBe(0);

    // A later BLOCK's related_exemplars must not surface it either.
    const second = await h.calibrate(request({ force_sensor: "offline" }), { "X-Agent-Pubkey": AGENT_HEX });
    expect((await second.json()).related_exemplars).toEqual([]);
  });

  it("never exposes agent_pubkey on public reads", async () => {
    const h = calibrateHarness([makeRow({ agent_pubkey: AGENT_HEX })]);
    const body = JSON.stringify(await (await app.request("/api/v1/exemplars", {}, h.env)).json());
    expect(body).not.toContain(AGENT_HEX);
  });
});

describe("private bounty endpoint", () => {
  const orphanedBlock = makeRow({
    id: "a1111111-1111-4111-8111-111111111111",
    failed_arguments_json: JSON.stringify(BAD_ARGS),
    repaired_arguments_json: "{}",
    agent_pubkey: AGENT_HEX,
  });
  const orphanedAllow = makeRow({
    id: "a2222222-2222-4222-8222-222222222222",
    repaired_arguments_json: JSON.stringify(GOOD_ARGS),
    steering_directive: "Compliant operational blueprint",
  });
  const complete = makeRow({
    id: "a3333333-3333-4333-8333-333333333333",
    failed_arguments_json: JSON.stringify(BAD_ARGS),
    repaired_arguments_json: JSON.stringify(GOOD_ARGS),
    steering_directive: "Restore the force sensor.",
  });
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  it("rejects a missing Authorization header with 401", async () => {
    const h = calibrateHarness([orphanedBlock]);
    const response = await app.request("/api/v1/exemplars/bounties", {}, h.env);
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toContain("Bearer");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const text = await response.text();
    expect(text).not.toContain("force_sensor");
  });

  it("rejects a wrong token, a non-Bearer scheme, and an empty bearer with 401", async () => {
    const h = calibrateHarness([orphanedBlock]);
    for (const headers of [bearer("wrong-token"), { Authorization: `Basic ${ADMIN_TOKEN}` }, { Authorization: "Bearer " }, bearer(`${ADMIN_TOKEN}x`)]) {
      expect((await app.request("/api/v1/exemplars/bounties", { headers }, h.env)).status).toBe(401);
    }
  });

  it("does not accept the write token, and fails closed when FORGE_ADMIN_TOKEN is unset", async () => {
    const h = calibrateHarness([orphanedBlock]);
    const withWriteToken: Env = { ...h.env, FORGE_WRITE_TOKEN: "test-write-token" };
    expect((await app.request("/api/v1/exemplars/bounties", { headers: bearer("test-write-token") }, withWriteToken)).status).toBe(401);

    const unset: Env = { ...h.env, FORGE_ADMIN_TOKEN: undefined };
    for (const token of ["undefined", "", ADMIN_TOKEN]) {
      expect((await app.request("/api/v1/exemplars/bounties", { headers: bearer(token) }, unset)).status).toBe(401);
    }
  });

  it("returns orphaned blocks and orphaned allows, and omits complete pairs", async () => {
    const h = calibrateHarness([orphanedBlock, orphanedAllow, complete]);
    const response = await app.request("/api/v1/exemplars/bounties", { headers: bearer(ADMIN_TOKEN) }, h.env);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.json();
    expect(body.count).toBe(2);
    const byKind = Object.fromEntries(body.bounties.map((b: { kind: string }) => [b.kind, b]));
    expect(byKind.orphaned_block).toMatchObject({
      id: orphanedBlock.id,
      missing: ["compliant_arguments", "allow_receipt"],
      failed_arguments: BAD_ARGS,
      compliant_arguments: {},
      agent_pubkey: AGENT_HEX,
    });
    expect(byKind.orphaned_allow).toMatchObject({
      id: orphanedAllow.id,
      missing: ["steering_directive"],
      compliant_arguments: GOOD_ARGS,
    });
  });

  it("filters by kind and rejects an unknown kind", async () => {
    const h = calibrateHarness([orphanedBlock, orphanedAllow]);
    const blocks = await (await app.request("/api/v1/exemplars/bounties?kind=orphaned_block", { headers: bearer(ADMIN_TOKEN) }, h.env)).json();
    expect(blocks.bounties.map((b: { kind: string }) => b.kind)).toEqual(["orphaned_block"]);
    const allows = await (await app.request("/api/v1/exemplars/bounties?kind=orphaned_allow", { headers: bearer(ADMIN_TOKEN) }, h.env)).json();
    expect(allows.bounties.map((b: { kind: string }) => b.kind)).toEqual(["orphaned_allow"]);
    const invalid = await app.request("/api/v1/exemplars/bounties?kind=everything", { headers: bearer(ADMIN_TOKEN) }, h.env);
    expect(invalid.status).toBe(400);
  });

  it("is not swallowed by the public GET /exemplars/:id route", async () => {
    const h = calibrateHarness([orphanedBlock]);
    const response = await app.request("/api/v1/exemplars/bounties", { headers: bearer(ADMIN_TOKEN) }, h.env);
    expect((await response.json()).success).toBe(true);
  });
});
