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
4. Before Turn 1 on a later task, any agent queries ramen-forge by `tool_name` / `task_fingerprint` / `domain` and starts with the repair already in context.

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

Required: `exemplar_id` (UUID), `domain` (lowercase slug, e.g. `fintech`), `task_description`, `tool_name`, `failed_arguments` (object), `violation_reason`, `primary_statutory_anchor`, `steering_directive`, `repaired_arguments` (object), `created_at` (ISO 8601 with offset). Optional: `receipt_id`, `task_fingerprint`.

Payloads are rejected with `422` and a list of reasons when they:

- contain unknown top-level keys (raw dumps such as `messages` or `transcript`)
- miss required fields or have blank / oversized text (body ≤ 64 KB, each argument object ≤ 16 KB, nesting ≤ 8 levels)
- include control characters, a `task_fingerprint` that is not `SHA-256(task_description)`, or a future `created_at`
- appear to contain credentials (private keys, AWS keys, GitHub/Slack tokens, JWTs, bearer tokens, `sk-` API keys)

Duplicate `exemplar_id` returns `409`. Everything ingested is stored as `tier = 'community'`.

### `GET /api/v1/exemplars`

Query parameters, all optional and combined with AND: `domain`, `tool_name`, `task_fingerprint`, `limit` (1–50, default 10). Returns `{ "success": true, "count": n, "exemplars": [...] }`, newest first.

### `GET /api/v1/stats`

Totals for the console: exemplar count, active domains, per-domain counts, and `recovery_rate` (share of exemplars anchored to a ramen-ai `receipt_id`). Seed exemplars have no receipt, so a freshly seeded forge reports 0%.

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

Monitoring console: live stats, a stream of recent lessons, and a copyable quickstart.

## Authentication and trust

Write endpoints require `Authorization: Bearer <FORGE_WRITE_TOKEN>`. If the secret is not set, writes return `503` (fail closed). Read endpoints and the console are public.

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
npm run deploy
```

Typecheck with `npx tsc --noEmit`.

## Quickstart from a ramen-foundry agent

```python
import httpx; from ramen_foundry import CorrectionExemplar
lessons = [CorrectionExemplar.from_dict(e) for e in httpx.get("https://<your-forge>/api/v1/exemplars", params={"tool_name": tool_name, "task_fingerprint": fingerprint}).json()["exemplars"]]
```

`fingerprint` is `ramen_foundry.core.memory.fingerprint_task(task)`. Contributing a local exemplar:

```python
record = exemplar.to_dict() | {"domain": "fintech", "task_description": task}
httpx.post("https://<your-forge>/api/v1/exemplars", json=record, headers={"Authorization": f"Bearer {token}"})
```
