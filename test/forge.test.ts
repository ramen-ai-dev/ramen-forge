import { afterEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import type { Env, ExemplarRow } from "../src/types";

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
  ...overrides,
});

function createDb(rows: ExemplarRow[]) {
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
          let selected = [...rows];
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
          return null as T | null;
        },
        async run() {
          return { meta: { changes: 0 } };
        },
      };
      return statement;
    },
    async batch() {
      return [{ results: [] }, { results: [{ request_count: 1 }] }];
    },
  };
  return { db: db as unknown as D1Database, queries };
}

function envWith(rows: ExemplarRow[] = [makeRow()]): Env {
  return {
    DB: createDb(rows).db,
    FORGE_WRITE_TOKEN: "test-write-token",
    RAMEN_API_KEY: "test-api-key",
    RAMEN_GATEWAY_URL: "https://gateway.example.test",
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

describe("exemplar routing", () => {
  it("routes auxiliary-key ledger submissions without bearer auth", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", { status: 404 })));
    const response = await app.request(
      "/api/v1/exemplars",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          receipt_id: "33333333-3333-4333-8333-333333333333",
          domain: "fintech",
          client_metadata: { source: "test" },
        }),
      },
      envWith(),
    );
    expect(response.status).toBe(422);
    expect(response.status).not.toBe(401);
    expect(response.headers.get("RateLimit-Limit")).toBe("30");
  });

  it("rejects legacy full payloads without a bearer token", async () => {
    const response = await app.request(
      "/api/v1/exemplars",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ receipt_id: "not-a-ledger-request", tool_name: "dispatch_wire" }),
      },
      envWith(),
    );
    expect(response.status).toBe(401);
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
