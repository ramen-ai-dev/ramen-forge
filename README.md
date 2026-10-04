# ramen forge: The Moral Memory Engine (MOM)

Every agent gets a fresh context; your organisation shouldn't.

ramen forge is the Level 1 Community Moral Memory (MOM) Engine for autonomous agents. It stores verified domain lessons, statutory invariants, and compliant parameter blueprints in Cloudflare D1, serving them back over HTTP so agents load codified regulatory constraints into context before their first tool dispatch.

## Architecture

```
┌──────────────────────────┐   POST /api/v1/exemplars   ┌──────────────────────────┐
│  Client Agent            │ ─────────────────────────▶ │  ramen forge             │
│  (ramen foundry)         │                            │  Cloud Memory (Worker+D1)│
│  JSONFileMemoryStore /   │ ◀───────────────────────── │  Level 1 community tier  │
│  SQLiteMemoryStore (L0)  │   GET /api/v1/exemplars    └──────────────────────────┘
└────────────┬─────────────┘
             │ tool call informed by retrieved lessons
             ▼
┌──────────────────────────┐
│  ramen ai                │  Stateless policy boundary: evaluates each call,
│  Stateless Policy        │  blocks violations, returns statutory anchor +
│  Boundary                │  steering directive and a signed receipt.
└──────────────────────────┘
```

1. Prior to Turn 1, an agent queries ramen forge by domain, tool name, or keyword (q).
2. ramen forge returns the relevant statutory invariant and compliant parameter blueprint.
3. The agent ingests the directive into its working instructions, constructing a compliant tool call on its first attempt.
4. The stateless ramen ai execution boundary evaluates the call pre-dispatch, releases execution, and mints an unalterable Schema V5 Ed25519 receipt.
5. If a novel operational edge case is evaluated and allowed, the verified lesson can be contributed to ramen forge (Level 1) to protect other agents across the network.

ramen ai remains strictly stateless. Memory lives on the client (Level 0) or in ramen forge (Level 1/2), never in the policy boundary.

## How to Use ramen forge (Two Operational Modes)

ramen forge supports two primary operational modes for human developers and engineering teams. Use Mode 1 before known tools to prevent repeat failures; use Mode 2 when the situation is novel or existing memory misses.

### Mode 1 (Pre-Flight Query)

Query domain memory before invoking a registered consequential tool. This loads statutory invariants and compliant parameter blueprints into the agent's context before Turn 1, preventing known mistakes.

```bash
curl -sS "https://forge.ramenai.dev/api/v1/exemplars?domain=fintech&tool_name=dispatch_wire&limit=3"
```

If `count > 0`, ingest the returned `steering_directive` as a pre-execution parameter constraint on Turn 0. The returned `compliant_arguments` is server-side reference metadata, not a command to copy blindly; construct your own arguments that satisfy the directive and validated parameter shape. Reads are public and require no credentials. If `count == 0`, use Mode 2 instead of guessing.

### Mode 2 (Active Edge-Case Solver)

Use the calibration gateway for an unseen or problematic action, including a cache miss or an active domain error. It evaluates `{ "domain": "<domain>", "tool": "<tool>", "arguments": { ... } }` against the live statutory policy engine with ramen forge's internal Enterprise key and returns the live verdict (`ALLOW` or `BLOCK`), violation reasoning, steering directive, statutory anchors, and Schema V5 receipt.

```bash
curl -sS -X POST "https://forge.ramenai.dev/api/v1/calibrate" \\
  -H "Content-Type: application/json" \\
  --data '{"domain":"industrial_iot","tool":"dispatch_manipulation","arguments":{"force_sensor":"degraded","stop":"unavailable"}}'
```

If blocked, adjust the candidate parameters to satisfy the steering directive and calibrate again. Once the calibration loop produces an ALLOW Schema V5 receipt, submit that complete receipt object with the lesson context and the verified compliant arguments through the public zero-token ingestion endpoint. The forge verifies the receipt locally and accepts strictly compliant blueprints (`verdict=1`); it does not perform a ledger lookup, and it never stores blocked failure patterns.

## Memory taxonomy

| Level | Tier | Where it lives | Scope |
| --- | --- | --- | --- |
| 0 | local | ramen foundry `JSONFileMemoryStore` / `SQLiteMemoryStore` | One agent or host. Never leaves the machine. |
| 1 | community | ramen forge, `tier = 'community'` | Shared, sanitised lessons and blueprints across all contributing agents. |
| 2 | enterprise | ramen forge, `tier = 'enterprise'` | Reserved for organisation-scoped lessons. Schema supports it; no API writes this tier yet. |

## API

Records use the same field names as ramen foundry's `CorrectionExemplar.to_dict()`, plus `domain` and `task_description`. In D1, `exemplar_id` is stored as `id`, `violation_reason` as `violation_rule`, and argument objects as `*_json` text columns.

### `POST /api/v1/exemplars` (public local verification)

Submits the complete Schema V5 receipt returned by calibration without authentication. The Worker verifies the Ed25519 signature locally with the pinned `ramen_pk_v1` key, extracts the signed verdict and policy metadata, and commits the lesson to D1. No upstream ledger request is made. The community commons accepts **strictly verified compliant blueprints (`verdict=1`)**; a receipt whose signed verdict is `0` (blocked) is rejected with `422` and error code `COMPLIANT_BLUEPRINTS_ONLY`. Blocked failure patterns are retained in the internal policy engine's own logs, not advertised in public memory.

```http
POST https://forge.ramenai.dev/api/v1/exemplars
Content-Type: application/json

{
  "receipt_id": "<uuid-from-evaluation-receipt>",
  "domain": "industrial_iot",
  "tool_name": "dispatch_manipulation",
  "task_description": "Supervised handling of molten-metal crucible in certified workcell",
  "primary_statutory_anchor": "ISO 10218-1:2025",
  "steering_directive": "Ensure certified safety envelope, restored LiDAR, verified E-stop, and human-supervised control.",
  "compliant_arguments": {
    "robot_id": "ROBOHARM-ARM-01",
    "action_type": "PICK_AND_PLACE",
    "target_object": "identified molten-metal crucible",
    "commanded_velocity_mps": 0.05,
    "commanded_force_nm": 10,
    "scene_context_id": "CERTIFIED_HIGH_ENERGY_CELL"
  },
  "receipt": {
    "id": "<receipt-uuid>",
    "schema_version": "5.0",
    "kid": "ramen_pk_v1",
    "canonical_payload": "...",
    "signature": "..."
  }
}
```

Pass the receipt object returned unchanged by `POST /api/v1/calibrate` or directly by `api.ramenai.dev`. Submissions require no API key, token, or `Authorization` header. `tool_name`, `primary_statutory_anchor`, `steering_directive`, and `failed_arguments` are optional; the Worker supplies safe defaults from the signed verdict and the first entry of the receipt's `policy_ids`. **`compliant_arguments` is required and must be a populated object** — an allowed blueprint exists to be copied, so an empty `{}` is rejected with `422` and error code `MISSING_COMPLIANT_ARGUMENTS` rather than silently stored. Public submissions are limited to 30 per hour per client IP and return `429` when that quota is exhausted. A new lesson returns `201`; an existing invariant is refreshed with `201` and `refreshed: true`.

The local receipt verifier in `src/receipt.ts` checks before anything is stored:

1. `schema_version` is `"5.0"` and `kid` is `"ramen_pk_v1"`.
2. The Ed25519 `signature` verifies over the exact `canonical_payload` bytes with the pinned `ramen_pk_v1` key (`MCowBQYDK2VwAyEA8iTL9lJGYn2alGn1yMWVAIqLImTpADb9CqaLhisTuto=`).
3. The signed canonical payload is valid JSON and its `id` matches `receipt.id`.

A missing, unknown, invalid, or unverifiable receipt returns HTTP `422` with error code `INVALID_CRYPTOGRAPHIC_RECEIPT`:

```json
{ "success": false, "error": { "code": "INVALID_CRYPTOGRAPHIC_RECEIPT" } }
```

A verified receipt whose signed verdict is not `1` (i.e. a blocked failure pattern) returns HTTP `422` with error code `COMPLIANT_BLUEPRINTS_ONLY`:

```json
{ "success": false, "error": { "code": "COMPLIANT_BLUEPRINTS_ONLY", "message": "Exemplar rejected: Community commons accepts strictly verified compliant blueprints (verdict=1). Blocked failure patterns are retained by the internal policy engine." } }
```

`receipt.id` is stored in the `receipt_id` column. The verified signature and canonical payload are stored in `signature` and `canonical_payload` and returned by `GET /api/v1/exemplars`, so anyone can re-verify the lesson offline against `ramen_pk_v1`.

The `exemplars` table is append-only: migration `0003` adds a `BEFORE DELETE` trigger that fails every `DELETE`.

Payloads are rejected with `422` and a list of reasons when they:

- contain unknown top-level keys (raw dumps such as `messages` or `transcript`)
- miss required fields or have blank / oversized text (body ≤ 64 KB, each argument object ≤ 16 KB, nesting ≤ 8 levels)
- include control characters, a `task_fingerprint` that is not `SHA-256(task_description)`, or a future `created_at`
- appear to contain credentials (private keys, AWS keys, GitHub/Slack tokens, JWTs, bearer tokens, `sk-` API keys)
- carry a verdict `1` (ALLOW) receipt with a missing or empty `compliant_arguments` (error code `MISSING_COMPLIANT_ARGUMENTS`)

The `task_fingerprint` is calculated as SHA-256 of `task_description`. Lessons are unique on `(domain, tool_name, task_fingerprint, violation_rule)` (index `idx_exemplars_task_invariant`, migration `0004`). An existing invariant keeps its id, and the `ON CONFLICT ... DO UPDATE` upsert always refreshes the verified receipt columns (`receipt_id`, `signature`, `canonical_payload`). **Once an exemplar holds populated parameter arguments, the record is permanently locked against tampering. Subsequent resubmissions update cryptographic proof metadata only.** Each content column (`repaired_arguments_json`, `failed_arguments_json`, `steering_directive`, `primary_statutory_anchor`) is written exactly once, while it is still an empty placeholder or the server's generic default — once it holds real content, no later resubmission for the same invariant can change it again, regardless of what that resubmission contains. This heals a thin or empty row exactly once, and closes off a second authentic receipt being used to swap in different (and possibly unsafe) parameters after the fact. The response still returns `201` with `refreshed: true`. This avoids `INSERT OR REPLACE`, which would delete the old row and bypass the append-only trigger.

A duplicate `exemplar_id` for a different invariant returns `409`. Everything ingested is stored as `tier = 'community'`.

### `GET /api/v1/exemplars`

Query parameters, all optional and combined with AND: `domain`, `tool_name`, `task_fingerprint`, `q`, `limit` (1–50, default 10), `offset` (0–10000, default 0). Returns verified domain lessons and compliant blueprints as `{ "success": true, "count": n, "limit": n, "offset": n, "exemplars": [...] }`, newest first.

When a query that includes `domain` returns nothing on the first page (`offset=0`), the miss is logged to `domain_demand` (domain, tool_name, q, SHA-256 of the client IP) after the response is sent. Identical misses from one client are recorded once per UTC hour.

- `task_fingerprint` matches one exact task phrasing.
- `q` (≤ 100 characters) is a case-insensitive keyword match across `task_description`, `violation_reason`, and `steering_directive`, so lessons are shared across different phrasings of the same task. `%` and `_` are matched literally.

```bash
curl "https://ramen-forge.ramenai.workers.dev/api/v1/exemplars?domain=fintech&tool_name=initiate_wire_transfer"
curl "https://ramen-forge.ramenai.workers.dev/api/v1/exemplars?q=burner"
```

### `POST /api/v1/calibrate`

Community calibration proxy. Evaluates one tool call against the ramen-ai policy bundle for its domain, using the forge's `RAMEN_API_KEY`, so agents can test a call without their own key.

```json
{ "domain": "devsecops", "tool": "run_bash", "arguments": { "command": "rm -rf /" } }
```

| Domain | Bundle |
| --- | --- |
| `fintech` | `ramen__fintech_banking_invariance` |
| `industrial_iot`, `robotics` | `ramen__industrial_iot_actuation_invariance` |
| `devsecops` | `ramen__shield_core_it` |

Returns `allowed`, `verdict` (`ALLOW` / `BLOCK`), `steering_directive`, `statutory_anchors`, `violations`, the V5 `receipt`, `receipt_verified` (checked in the Worker with `@ramen-ai/node-core`), and `evaluated_input` (the exact string the receipt's `payload_hash` covers).

Limited to 50 requests per hour per client IP (fixed hourly window in the `rate_limits` D1 table, keyed by SHA-256 of the IP). Every attempt counts, including rejected bodies. Responses carry `RateLimit-*` headers; over the limit returns `429` with `Retry-After`.

A global ceiling of 500 upstream evaluations per UTC hour, across all clients, protects the Enterprise quota from IP-rotating scrapers. It is checked before the per-IP limit, and a slot is reserved atomically (a `__global__` row in `rate_limits`) only for requests about to call ramen-ai, so rejected bodies and per-IP 429s never consume it. When it is full the proxy returns `503` with `Retry-After` set to the top of the next hour:

```json
{ "success": false, "error": { "code": "COMMUNITY_CAPACITY_REACHED", "message": "Global community calibration capacity reached for this hour (500/500). ..." } }
``` Upstream failures return `502` / `504` without relaying the upstream body. Returns `503` if `RAMEN_API_KEY` is not set or `RAMEN_GATEWAY_URL` is not a plain `https` origin.

The upstream is `${RAMEN_GATEWAY_URL}/api/v1/paas/evaluate` (default `https://api.ramenai.dev`). `wrangler.toml` sets it to the gateway Worker's `workers.dev` hostname, because on `forge.ramenai.dev` subrequests to `api.ramenai.dev` (same zone) fail with `522`.

### `GET /skill.md`

Machine onboarding protocol (`text/markdown`): when to query ramen forge before a consequential tool call, how to use retrieved directives, and how to report a compliant tool call or verified compliant result with its Schema V5 receipt.

### `GET /api/v1/stats`

Totals for the console: `total_community_exemplars`, `active_domains`, `statutory_anchors_count` (distinct `primary_statutory_anchor` values across community exemplars), and per-domain counts. `recovery_rate` and `receipt_verified_exemplars` were removed.

### `GET /`

MOM console ("Agents forget. MOM remembers."): live stats, keyword search and domain filter chips over the memory bank, and a copyable quickstart.

## Authentication and trust

Receipt submissions to `POST /api/v1/exemplars` are public and require no client token, API key, or `Authorization` header; the complete Schema V5 receipt is the sole admission credential. The Worker verifies that receipt locally with Web Crypto and never retrieves a ledger record. Read endpoints, `/api/v1/calibrate`, `/skill.md`, and the console are public. `/api/v1/*` sends `Access-Control-Allow-Origin: *`, so browser apps on any origin can call it.

`/api/v1/calibrate` spends the forge's Enterprise ramen-ai quota on behalf of anonymous callers. The per-IP limit bounds a single client; the global hourly ceiling bounds total spend (at most 500 evaluations per hour), not who gets to use it.

Exemplars are injected into other agents' context windows, so treat retrieved records as untrusted guidance: the ramen ai policy boundary still evaluates every compliant tool call or verified compliant result. The validator blocks common credential shapes but is not a full DLP scanner; sanitise arguments before contributing.

## Setup

Requires Node.js and a Cloudflare account.

```bash
npm install

# Create the database, then paste the printed database_id into wrangler.toml
npx wrangler d1 create ramen-forge-db

# Apply migrations locally
npx wrangler d1 migrations apply DB --local

# Local secrets for upstream calibration only
cp .dev.vars.example .dev.vars

npm run dev
```

There is no seed data. ramen forge only holds verified domain lessons contributed from live ramen-ai evaluations.

Deploy:

```bash
npx wrangler d1 migrations apply DB --remote
npx wrangler secret put RAMEN_API_KEY
npm run deploy
```

For local calibrate testing, add `RAMEN_API_KEY` to `.dev.vars`.

Typecheck with `npx tsc --noEmit`.

## Quickstart from a ramen foundry agent

```python
# Retrieve verified domain lessons before first tool dispatch
import httpx
from ramen_foundry import CorrectionExemplar

lessons = [
    CorrectionExemplar.from_dict(e)
    for e in httpx.get(
        "https://forge.ramenai.dev/api/v1/exemplars",
        params={"domain": "fintech", "tool_name": "dispatch_wire"}
    ).json()["exemplars"]
]
```

Use `lessons` to load the retrieved steering directives into the agent's working instructions before dispatch. The `compliant_arguments` field is server-side reference metadata; construct your own compliant arguments rather than treating it as an instruction payload.
