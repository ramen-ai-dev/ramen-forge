# ramen-forge

Cloud memory synchronisation and domain-hardening engine for autonomous agents.

ramen-forge is the **Level 1 Community Memory Commons**. It ingests normalised `CorrectionExemplar` records produced by [ramen-foundry](https://github.com/ramen-ai-dev/ramen-foundry) agents, indexes them by domain, tool, and task fingerprint in Cloudflare D1, and serves them back over HTTP so agents can load known repairs into context before their first tool dispatch.

## Architecture

```
┌──────────────────────────┐   POST /api/v1/exemplars   ┌──────────────────────────┐
│  Client Agent            │ ─────────────────────────▶ │  ramen-forge             │
│  (ramen-foundry)         │                            │  Cloud Memory (Worker+D1)│
│  JSONFileMemoryStore /   │ ◀───────────────────────── │  Level 1 community tier  │
│  SQLiteMemoryStore (L0)  │   GET /api/v1/exemplars    └──────────────────────────┘
└────────────┬─────────────┘
             │ tool call (with recalled exemplars in context)
             ▼
┌──────────────────────────┐
│  ramen ai                │  Stateless policy boundary: evaluates each call,
│  Stateless Policy        │  blocks violations, returns statutory anchor +
│  Boundary                │  steering directive and a signed receipt.
└──────────────────────────┘
```

1. A foundry agent's tool call is blocked by the ramen ai policy boundary.
2. The agent repairs the call using the steering directive, and the repaired call is allowed.
3. Foundry records a `CorrectionExemplar` locally (Level 0) and can contribute it to ramen-forge (Level 1).
4. Before Turn 1 on a later task, any agent queries ramen-forge by `domain` / `tool_name` / keyword (`q`) / `task_fingerprint` and starts with the repair already in context.

ramen ai stays stateless. Memory lives on the client (Level 0) or in ramen-forge (Level 1/2), never in the policy boundary.

## Memory taxonomy

| Level | Tier | Where it lives | Scope |
| --- | --- | --- | --- |
| 0 | local | ramen-foundry `JSONFileMemoryStore` / `SQLiteMemoryStore` | One agent or host. Never leaves the machine. |
| 1 | community | ramen-forge, `tier = 'community'` | Shared, sanitised exemplars across all contributing agents. |
| 2 | enterprise | ramen-forge, `tier = 'enterprise'` | Reserved for organisation-scoped exemplars. Schema supports it; no API writes this tier yet. |

## API

Records use the same field names as foundry's `CorrectionExemplar.to_dict()`, plus `domain` and `task_description`. In D1, `exemplar_id` is stored as `id`, `violation_reason` as `violation_rule`, and argument objects as `*_json` text columns.

### `POST /api/v1/exemplars` (auth required)

Ingests one exemplar. Returns `201 { "success": true, "exemplar_id": "<uuid>" }`.

Required: `exemplar_id` (UUID), `domain` (lowercase slug, e.g. `fintech`), `task_description`, `tool_name`, `violation_reason`, `primary_statutory_anchor`, `steering_directive`, `repaired_arguments` (object), `created_at` (ISO 8601 with offset). Optional: `failed_arguments` (object; stored as `{}` when omitted or null), `receipt_id`, `task_fingerprint`.

Payloads are rejected with `422` and a list of reasons when they:

- contain unknown top-level keys (raw dumps such as `messages` or `transcript`)
- miss required fields or have blank / oversized text (body ≤ 64 KB, each argument object ≤ 16 KB, nesting ≤ 8 levels)
- include control characters, a `task_fingerprint` that is not `SHA-256(task_description)`, or a future `created_at`
- appear to contain credentials (private keys, AWS keys, GitHub/Slack tokens, JWTs, bearer tokens, `sk-` API keys)

Duplicate `exemplar_id` returns `409`. Everything ingested is stored as `tier = 'community'`.

### `GET /api/v1/exemplars`

Query parameters, all optional and combined with AND: `domain`, `tool_name`, `task_fingerprint`, `q`, `limit` (1–50, default 10). Returns `{ "success": true, "count": n, "exemplars": [...] }`, newest first.

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
``` Upstream failures return `502` / `504` without relaying the upstream body. Returns `503` if `RAMEN_API_KEY` is not set.

### `GET /api/v1/stats`

Totals for the console: `total_community_exemplars`, `active_domains`, `statutory_anchors_count` (distinct `primary_statutory_anchor` values across community exemplars), and per-domain counts. `recovery_rate` and `receipt_verified_exemplars` were removed.

### `POST /api/v1/seed` (auth required)

Idempotently loads the curated seed bank (fixed IDs, `INSERT OR IGNORE`). Returns `inserted` / `skipped` counts.

| Domain | Tool | Repair |
| --- | --- | --- |
| fintech | `issue_adverse_action_notice` | ECOA Reg B: postal-code proxy reason replaced with `INSUFFICIENT_LIQUIDITY` |
| fintech | `initiate_wire_transfer` | UCC 4A: officer co-signer attached for wires ≥ USD 10,000 |
| industrial_iot | `set_robot_tcp_speed` | ISO/TS 15066: TCP speed de-rated 0.85 → 0.25 m/s near humans |
| industrial_iot | `place_material` | NFPA 86: volatile canister placement near burner halted and rerouted |
| devsecops | `run_bash` | OWASP LLM06: root wipe replaced with scoped directory target |

### `GET /`

MOM console ("Agents forget. MOM remembers."): live stats, keyword search and domain filter chips over the memory bank, and a copyable quickstart.

## Authentication and trust

Write endpoints require `Authorization: Bearer <FORGE_WRITE_TOKEN>`. If the secret is not set, writes return `503` (fail closed). Read endpoints, `/api/v1/calibrate`, and the console are public.

`/api/v1/calibrate` spends the forge's Enterprise ramen-ai quota on behalf of anonymous callers. The per-IP limit bounds a single client; the global hourly ceiling bounds total spend (at most 500 evaluations per hour), not who gets to use it.

Exemplars are injected into other agents' context windows, so treat retrieved records as untrusted guidance: the ramen ai policy boundary still evaluates every repaired call. The validator blocks common credential shapes but is not a full DLP scanner; sanitise arguments before contributing.

## Setup

Requires Node.js and a Cloudflare account.

```bash
npm install

# Create the database, then paste the printed database_id into wrangler.toml
npx wrangler d1 create ramen-forge-db

# Apply migrations locally
npx wrangler d1 migrations apply DB --local

# Local write token
cp .dev.vars.example .dev.vars   # then edit FORGE_WRITE_TOKEN

npm run dev
curl -X POST -H "Authorization: Bearer $FORGE_WRITE_TOKEN" http://localhost:8787/api/v1/seed
```

Deploy:

```bash
npx wrangler d1 migrations apply DB --remote
npx wrangler secret put FORGE_WRITE_TOKEN
npx wrangler secret put RAMEN_API_KEY
npm run deploy
```

For local calibrate testing, add `RAMEN_API_KEY` to `.dev.vars`.

Typecheck with `npx tsc --noEmit`.

## Quickstart from a ramen-foundry agent

```python
from ramen_foundry import RemoteForgeMemoryStore
memory = RemoteForgeMemoryStore(base_url="https://ramen-forge.ramenai.workers.dev", domain="fintech")
```

Pass it to `RamenSteerNode(memory_store=memory)`. Add `write_token=...` to contribute repairs back to the commons.
