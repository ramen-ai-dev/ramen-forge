/**
 * Pre-compiled seed bank for the Level 1 Community Memory Commons.
 *
 * Each record uses a fixed exemplar_id so POST /api/v1/seed is idempotent.
 * Seeds are curated reference repairs, not captured agent runs, so they carry
 * no ramen-ai receipt (receipt_id is null). Fingerprints are derived from
 * task_description at seed time by the same validator used for ingestion.
 */
import type { JsonObject } from "./types";

export interface SeedExemplar {
  exemplar_id: string;
  domain: string;
  task_description: string;
  tool_name: string;
  failed_arguments: JsonObject;
  violation_reason: string;
  primary_statutory_anchor: string;
  steering_directive: string;
  repaired_arguments: JsonObject;
  receipt_id: null;
  created_at: string;
}

const SEEDED_AT = "2026-10-01T00:00:00+00:00";

export const SEED_BANK: readonly SeedExemplar[] = [
  {
    exemplar_id: "5e3d0a10-0001-4f00-8a00-000000000001",
    domain: "fintech",
    task_description:
      "Issue an adverse action notice for a declined small-business credit application.",
    tool_name: "issue_adverse_action_notice",
    failed_arguments: {
      application_id: "APP-SEED-0001",
      decision: "DECLINED",
      principal_reason_code: "POSTAL_CODE_RISK",
      principal_reason_text: "Applicant business postal code is located in a high-risk area.",
    },
    violation_reason:
      "Adverse action reason relies on postal code, a geographic proxy for protected characteristics, instead of a specific creditworthiness reason.",
    primary_statutory_anchor: "ECOA Regulation B, 12 CFR 1002.9(b)(2)",
    steering_directive:
      "Never cite postal code, ZIP, census tract, or other geographic proxies as an adverse action reason. State the specific principal reason supported by the underwriting record, e.g. INSUFFICIENT_LIQUIDITY.",
    repaired_arguments: {
      application_id: "APP-SEED-0001",
      decision: "DECLINED",
      principal_reason_code: "INSUFFICIENT_LIQUIDITY",
      principal_reason_text: "Insufficient liquid assets relative to the requested credit amount.",
    },
    receipt_id: null,
    created_at: SEEDED_AT,
  },
  {
    exemplar_id: "5e3d0a10-0002-4f00-8a00-000000000002",
    domain: "fintech",
    task_description: "Initiate an outbound commercial wire transfer to a vendor beneficiary.",
    tool_name: "initiate_wire_transfer",
    failed_arguments: {
      amount_usd: 25000,
      beneficiary_account_ref: "BENEF-SEED-7781",
      originator_id: "AGENT-TREASURY-01",
      approvals: [],
    },
    violation_reason:
      "Wire of USD 25,000 submitted under single-party authorisation; payment orders of USD 10,000 or more require dual control.",
    primary_statutory_anchor: "UCC Article 4A, Section 4A-202 (commercially reasonable security procedure)",
    steering_directive:
      "For wires of USD 10,000 or more, attach a distinct authorising officer as co_signer by credential reference before dispatch. The originator may never self-approve.",
    repaired_arguments: {
      amount_usd: 25000,
      beneficiary_account_ref: "BENEF-SEED-7781",
      originator_id: "AGENT-TREASURY-01",
      approvals: [
        {
          role: "treasury_officer",
          officer_id: "OFFICER-SEED-02",
          credential_ref: "vault://officers/OFFICER-SEED-02/signing-key",
        },
      ],
      dual_control: true,
    },
    receipt_id: null,
    created_at: SEEDED_AT,
  },
  {
    exemplar_id: "5e3d0a10-0003-4f00-8a00-000000000003",
    domain: "industrial_iot",
    task_description: "Resume the pick-and-place cycle on a collaborative robot cell.",
    tool_name: "set_robot_tcp_speed",
    failed_arguments: {
      cell_id: "CELL-SEED-04",
      tcp_speed_mps: 0.85,
      human_in_collaborative_zone: true,
    },
    violation_reason:
      "Commanded TCP speed of 0.85 m/s while a human is present in the collaborative workspace exceeds the collaborative speed limit.",
    primary_statutory_anchor: "ISO/TS 15066:2016 (collaborative robot operation)",
    steering_directive:
      "When a human is detected in the collaborative workspace, clamp TCP speed to 0.25 m/s or below before issuing motion commands. Restore full speed only after the zone is confirmed clear.",
    repaired_arguments: {
      cell_id: "CELL-SEED-04",
      tcp_speed_mps: 0.25,
      human_in_collaborative_zone: true,
      mode: "collaborative_reduced_speed",
    },
    receipt_id: null,
    created_at: SEEDED_AT,
  },
  {
    exemplar_id: "5e3d0a10-0004-4f00-8a00-000000000004",
    domain: "industrial_iot",
    task_description: "Stage incoming material canisters next to the curing oven line.",
    tool_name: "place_material",
    failed_arguments: {
      item: "solvent_canister",
      flammable: true,
      target_zone: "OVEN-2-BURNER-ADJACENT",
      distance_to_burner_m: 0.4,
    },
    violation_reason:
      "Volatile solvent canister targeted for placement 0.4 m from an active oven burner, exposing flammable vapour to an ignition source.",
    primary_statutory_anchor: "NFPA 86 (Standard for Ovens and Furnaces)",
    steering_directive:
      "Never stage volatile or flammable containers adjacent to burners or combustion zones. Halt the placement and route the item to a designated flammables cabinet.",
    repaired_arguments: {
      item: "solvent_canister",
      flammable: true,
      action: "HALT",
      target_zone: "FLAMMABLES_CABINET_A",
      hold_reason: "volatile_material_near_ignition_source",
    },
    receipt_id: null,
    created_at: SEEDED_AT,
  },
  {
    exemplar_id: "5e3d0a10-0005-4f00-8a00-000000000005",
    domain: "devsecops",
    task_description: "Clean up stale build artefacts in the project workspace.",
    tool_name: "run_bash",
    failed_arguments: {
      command: "rm -rf / --no-preserve-root",
    },
    violation_reason:
      "Destructive recursive delete targets the filesystem root instead of the intended build directory.",
    primary_statutory_anchor: "OWASP Top 10 for LLM Applications 2025, LLM06 Excessive Agency",
    steering_directive:
      "Scope destructive filesystem operations to an explicit project-relative directory. Never target /, ~, or unbounded globs, and never pass --no-preserve-root.",
    repaired_arguments: {
      command: "rm -rf ./build/tmp",
      working_directory: "/workspace/project",
    },
    receipt_id: null,
    created_at: SEEDED_AT,
  },
];
