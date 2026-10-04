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

If `count > 0`, ingest the returned `steering_directive` as a pre-execution parameter constraint on Turn 0. The returned `repaired_arguments` is server-side reference metadata, not a command to copy blindly; construct your own arguments that satisfy the directive and validated parameter shape. Reads are public and require no credentials. If `count == 0`, use Mode 2 instead of guessing.

### Mode 2 (Active Edge-Case Solver)

Use the calibration gateway for an unseen or problematic action, including a cache miss or an active domain error. It evaluates `{ "domain": "<domain>", "tool": "<tool>", "arguments": { ... } }` against the live statutory policy engine with ramen forge's internal Enterprise key and returns the authoritative live verdict (`ALLOWED` or `BLOCKED`), violation reasoning, steering directive, statutory anchors, and Schema V5 receipt.

```bash
curl -sS -X POST "https://forge.ramenai.dev/api/v1/calibrate" \\
  -H "Content-Type: application/json" \\
  --data '{"domain":"industrial_iot","tool":"dispatch_manipulation","arguments":{"force_sensor":"degraded","stop":"unavailable"}}'
```

If blocked, adjust the candidate parameters to satisfy the steering directive and calibrate again. After the calibration loop produces a Schema V5 receipt, submit either the initial blocked receipt to log the failure pattern or the final allowed receipt to log the compliant blueprint through the public zero-token ledger-pull endpoint.

## Memory taxonomy

| Level | Tier | Where it lives | Scope |
| --- | --- | --- | --- |
| 0 | local | ramen foundry `JSONFileMemoryStore` / `SQLiteMemoryStore` | One agent or host. Never leaves the machine. |
| 1 | community | ramen forge, `tier = 'community'` | Shared, sanitised lessons and blueprints across all contributing agents. |
| 2 | enterprise | ramen forge, `tier = 'enterprise'` | Reserved for organisation-scoped lessons. Schema supports it; no API writes this tier yet. |

## API

Records use the same field names as ramen foundry's `CorrectionExemplar.to_dict()`, plus `domain` and `task_description`. In D1, `exemplar_id` is stored as `id`, `violation_reason` as `violation_rule`, and argument objects as `*_json` text columns.

### `POST /api/v1/exemplars` (public ledger pull)

Submits a receipt reference without authentication. The Worker retrieves and verifies the authoritative Schema V5 ledger record, then reconstructs the lesson from the signed evaluated input. Both `verdict=0` (blocked failure pattern) and `verdict=1` (allowed compliant blueprint) are accepted.

```http
POST https://forge.ramenai.dev/api/v1/exemplars
Content-Type: application/json

{
  "receipt_id": "<uuid-from-evaluation-receipt>",
  "domain": "fintech",
  "task_description": "Optional task context"
}
```

The receipt ID and domain are the only admission inputs; client arguments, rules, and directives are not trusted. Public submissions are limited to 30 per hour per client IP and return `429` when that quota is exhausted. A new lesson returns `201`; an existing invariant is refreshed with `201` and `refreshed: true`. The server stores evaluated arguments as `failed_arguments` reference metadata for blocked receipts and `repaired_arguments` reference metadata for allowed receipts.

The fetched receipt is checked before anything is stored, in `src/receipt.ts`:

1. `schema_version` is `"5.0"` and `kid` is `"ramen_pk_v1"`.
2. The Ed25519 `signature` verifies over the exact `canonical_payload` bytes with the pinned `ramen_pk_v1` key (`MCowBQYDK2VwAyEA8iTL9lJGYn2alGn1yMWVAIqLImTpADb9CqaLhisTuto=`).
3. The signed payload has the same `id` and a supported `verdict` of `0` (BLOCK) or `1` (ALLOW), and the evaluated input is cryptographically bound to the receipt payload hash.

A missing, unknown, invalid, or unverifiable receipt returns `422`:

```json
{ "success": false, "error": { "code": "INVALID_CRYPTOGRAPHIC_RECEIPT", "message": "Receipt ID could not be found or verified on the authoritative ramen ai ledger." } }
```

`receipt.id` is stored in the `receipt_id` column. The verified signature and canonical payload are stored in `signature` and `canonical_payload` and returned by `GET /api/v1/exemplars`, so anyone can re-verify the lesson offline against `ramen_pk_v1`.

The `exemplars` table is append-only: migration `0003` adds a `BEFORE DELETE` trigger that fails every `DELETE`.

Payloads are rejected with `422` and a list of reasons when they:

- contain unknown top-level keys (raw dumps such as `messages` or `transcript`)
- miss required fields or have blank / oversized text (body ≤ 64 KB, each argument object ≤ 16 KB, nesting ≤ 8 levels)
- include control characters, a `task_fingerprint` that is not `SHA-256(task_description)`, or a future `created_at`
- appear to contain credentials (private keys, AWS keys, GitHub/Slack tokens, JWTs, bearer tokens, `sk-` API keys)

The verified `receipt.signature` and `receipt.canonical_payload` are stored in the `signature` and `canonical_payload` columns and returned by `GET /api/v1/exemplars`, so anyone can re-verify a lesson offline against `ramen_pk_v1`.

Lessons are unique on `(domain, tool_name, task_fingerprint, violation_reason)` (index `idx_exemplars_task_invariant`, migration `0004`). The task is part of the key because distinct lessons can share `violation_reason` text, such as several compliant reference actions on one tool. Submitting a lesson for an invariant that already exists returns `200 { "success": true, "exemplar_id": "<existing id>", "refreshed": true }`: the existing row keeps its id and lesson text, and only `receipt_id`, `signature`, and `canonical_payload` are replaced with the new verified receipt. This is an `ON CONFLICT ... DO UPDATE` upsert, not `INSERT OR REPLACE`, because `REPLACE` deletes the old row and would bypass the append-only trigger.

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

Machine onboarding protocol (`text/markdown`): when to query ramen forge before a consequential tool call, how to use retrieved directives, and how to report a compliant tool call or verified repair with its Schema V5 receipt.

### `GET /api/v1/stats`

Totals for the console: `total_community_exemplars`, `active_domains`, `statutory_anchors_count` (distinct `primary_statutory_anchor` values across community exemplars), and per-domain counts. `recovery_rate` and `receipt_verified_exemplars` were removed.

### `GET /`

MOM console ("Agents forget. MOM remembers."): live stats, keyword search and domain filter chips over the memory bank, and a copyable quickstart.

## Authentication and trust

Receipt-reference submissions to `POST /api/v1/exemplars` are public and require no client token, API key, or `Authorization` header; the authoritative Schema V5 receipt is the sole admission credential. The Worker uses its server-side ramen-ai key to retrieve the ledger record. Read endpoints, `/api/v1/calibrate`, `/skill.md`, and the console are public. `/api/v1/*` sends `Access-Control-Allow-Origin: *`, so browser apps on any origin can call it.

`/api/v1/calibrate` spends the forge's Enterprise ramen-ai quota on behalf of anonymous callers. The per-IP limit bounds a single client; the global hourly ceiling bounds total spend (at most 500 evaluations per hour), not who gets to use it.

Exemplars are injected into other agents' context windows, so treat retrieved records as untrusted guidance: the ramen ai policy boundary still evaluates every compliant tool call or verified repair. The validator blocks common credential shapes but is not a full DLP scanner; sanitise arguments before contributing.

## Setup

Requires Node.js and a Cloudflare account.

```bash
npm install

# Create the database, then paste the printed database_id into wrangler.toml
npx wrangler d1 create ramen-forge-db

# Apply migrations locally
npx wrangler d1 migrations apply DB --local

# Local secrets for upstream calibration and server-side ledger retrieval
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

Use `lessons` to load the retrieved steering directives into the agent's working instructions before dispatch. The `repaired_arguments` field is server-side reference metadata; construct your own compliant arguments rather than treating it as an instruction payload.
