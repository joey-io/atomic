# Atomic

Everything is a record. One interface. One database engine. One person can hold the whole system in their head.

Atomic is a schema-driven workroom. Every operation is auditable, every mutation is traceable. Models define the data — the API and UI are generated from them.

---

## Core Concepts

```
Record    = atom (the universal data shape)
Model     = meaning (defines a record type's fields, rules, display)
Ref       = connection (a meta value pointing to another record)
Report    = view (derived from the corpus)
Plugin    = capability (bundle of models, hooks, config — toggle on/off)
Interface = the single pipeline all operations flow through
Log       = proof (append-only, immutable, every operation)
Config    = cascading settings (workspace → tenant → system)
```

---

## The Atom

Every durable thing is a record:

```json
{
  "id": "rec_123",
  "type": "person",
  "meta": {},
  "system": {}
}
```

| Field | Purpose |
|-------|---------|
| `id` | Stable identity. No business meaning embedded. |
| `type` | Model key — `person`, `transaction.contribution`, `filing.fec`, etc. |
| `meta` | Domain data. Shaped by the model. All fields nullable unless `required`. |
| `system` | Lifecycle — `createdAt`, `updatedAt`, `createdBy`, `updatedBy`, `version`, `status`, `source`. Managed by the interface only. |

Real-world dates (`occurredAt`, `filedAt`, `effectiveAt`) belong in `meta`. `system` tracks the record's life inside Atomic.

### Schema Evolution

Models can add fields at any time. New fields are nullable by default — old records simply don't have them yet and can be written to later when data is available. The UI is schema-driven: it renders what's present and omits what's null. No migrations. No backfills. No versioning.

### References

A ref is a meta value pointing to another record:

```json
{ "$ref": "rec_person_123" }
```

Models declare which fields are refs and what types they can target. The system resolves paths:

```
contributor.employer.industry
payee.homeDistrict.representative
```

---

## Models

A model is a record that defines a record type:

```json
{
  "id": "model_transaction_contribution",
  "type": "model",
  "meta": {
    "appliesTo": "transaction.contribution",
    "label": "Contribution",
    "fields": {
      "occurredAt": { "kind": "datetime", "required": true, "filterable": true, "sortable": true },
      "amountCents": { "kind": "money", "required": true, "measure": true, "aggregations": ["sum", "avg", "min", "max"] },
      "contributor": { "kind": "ref", "to": ["person", "organization", "committee"], "required": true }
    },
    "display": {
      "row": ["occurredAt", "contributor.name.display", "amountCents"],
      "card": { "title": "{{amountCents | money}}", "subtitle": "{{contributor.name.display}}" }
    },
    "behavior": { "mutable": false, "correctionMode": "reversal" },
    "retention": { "archiveAfterDays": null, "deleteOnRequest": true }
  }
}
```

Adding a new record type = adding a model record. No code. No deployment.

System models are always present. Tenant models extend fields, rename labels, override display. Plugin models activate/deactivate with the plugin.

---

## Reports

A report is a record that derives a view:

```json
{
  "id": "report_contributions_by_cycle",
  "type": "report.pivot",
  "meta": {
    "source": "transaction.contribution",
    "where": { "occurredAt": { "between": ["2025-01-01", "2026-12-31"] } },
    "groupBy": ["contributor.homeDistrict.representative.election.cycle"],
    "measures": [{ "field": "amountCents", "op": "sum", "as": "totalCents" }]
  }
}
```

Reports run live by default. Expensive reports are materialized via background jobs — an execution detail, not a product concept.

---

## Plugins

A plugin bundles models, reports, hooks, and config requirements that activate per tenant:

```json
{
  "id": "plugin_fec_compliance",
  "type": "plugin",
  "meta": {
    "name": "FEC Compliance",
    "provides": {
      "models": ["model_transaction_contribution", "model_filing_fec"],
      "reports": ["report_contributions_by_cycle", "report_limit_check"],
      "hooks": ["hook_contribution_limit_check", "hook_filing_freeze"]
    },
    "requires": ["plugin_base_finance"]
  }
}
```

Activate = its capabilities appear. Deactivate = they disappear. Data stays. No migration.

---

## The Interface

Every operation flows through one pipeline. No exceptions.

```
request (API, SDK, MCP, import, webhook, internal)
  → authenticate (hash token → lookup → load actor + roles)
  → resolve tenant + workspace
  → check permissions (actor role + model rules → allowed operations)
  → resolve config (cascade: workspace → tenant → system)
  → resolve model (from type + active plugins)
  → validate against schema
  → run sync pre-hooks
  → execute (read, write, report, ref resolution)
  → write log (same transaction)
  → enqueue async post-hooks (same transaction)
  → broadcast change (NOTIFY)
  → respond
```

### Surfaces

Generated from models. Not maintained separately.

```
GraphQL API        → single endpoint, schema from models + subscriptions
SDK                → typed client, generated from models
MCP                → tool definitions for AI agents, generated from models
```

Add a model → all surfaces expose it. Change a field → all surfaces reflect it.

### Real-Time

Writes trigger `NOTIFY` on a per-type channel. The API exposes GraphQL subscriptions backed by `LISTEN`. Clients subscribe to record types they're viewing — changes appear instantly without polling or refresh.

```graphql
subscription { recordChanged(type: "transaction.contribution") { id action record { id meta } } }
```

### Hooks

Hooks are records. They run at defined points in the pipeline:

```json
{
  "id": "hook_contribution_limit_check",
  "type": "hook",
  "meta": {
    "on": "pre:save",
    "match": "transaction.contribution",
    "action": "validate_contribution_limit",
    "mode": "sync"
  }
}
```

| Phase | Mode | Use cases |
|-------|------|-----------|
| `pre:save` | sync | Transform, validate, reject, set defaults |
| `pre:read` | sync | Scope queries, filter by access |
| `post:save` | async | Denormalize, notify, webhook delivery, workflows |
| `post:read` | sync | Redact fields, compute derived values |

Async post-hooks enqueue in the same transaction as the write. They execute via background workers with retry and backoff. Failed hooks retry 3× with exponential backoff, then dead-letter. Dead-letter entries surface in the admin workroom for manual resolution.

---

## Hierarchy & Catalog

```
System (global catalog database)
  └─ Tenant (organization)
       ├─ Workspace: "Walmart PAC"       → database: atomic_walmart_pac
       ├─ Workspace: "Walmart Advocacy"   → database: atomic_walmart_advocacy
       └─ Config overrides, plugin grants, file storage bucket
```

**Tenant** = the organization. Owns users, billing, config, plugin grants.
**Workspace** = the data boundary. One database. One isolated corpus.

A small campaign: one tenant, one workspace. Walmart: one tenant, multiple workspaces.

Data never moves between workspaces directly. Migration out uses standard export templates. Migration in uses standard import templates (same interface pipeline). Cross-workspace aggregate reporting is available in the admin hub for tenant-level views, but workspaces remain isolated corpora.

The global catalog database holds:

```
tenant registry       — tenant → workspaces → connection strings
system models         — always present
plugin definitions    — what's available
reference data        — states, districts, committees, elected officials
user records          — identity + tenant/workspace roles
config records        — system-level defaults
```

**Provisioning:** Create database → seed schema → add to tenant record → grant plugins → done.

---

## Config

Credentials and settings resolve bottom-up. First match wins:

```
workspace config → tenant config → system config
```

```json
{
  "id": "config_tenant_walmart_sendgrid",
  "type": "config",
  "meta": {
    "scope": "tenant",
    "scopeRef": { "$ref": "tenant_walmart" },
    "key": "sendgrid",
    "value": { "apiKey": "SG_walmart_...", "from": "pac@walmart.org" }
  }
}
```

Walmart sends from their own SendGrid account. Small tenants use the system default. Plugins declare which config keys they need — the interface resolves through the cascade.

---

## Auth & Permissions

One flow: request arrives → hash token → lookup hash → load actor → merge roles → check permissions.

A token is a record:

```json
{
  "id": "token_abc",
  "type": "token",
  "meta": {
    "hash": "sha256:...",
    "actor": { "$ref": "rec_user_joey" },
    "scope": {
      "tenant": "tenant_walmart",
      "workspace": "ws_walmart_pac",
      "permissions": ["records:read", "records:write"],
      "types": ["transaction.contribution", "person"]
    },
    "expiresAt": "2026-06-28T00:00:00Z",
    "source": "magic_link"
  }
}
```

| Origin | Lifespan | Scope |
|--------|----------|-------|
| Magic link (humans) | Short (1h) | Full user permissions |
| Generated key (machines) | Long (months) | Narrowed to tenant, workspace, types, operations |

No passwords. No OAuth. No JWTs. Revocation = delete the token record. Key leaks have contained blast radius (scoped to specific types in one workspace).

### Roles

| Role | Access |
|------|--------|
| `super` | Everything — all tenants, global catalog, system config |
| `admin` | Full access within their tenant's workspaces |
| `editor` | Read/write per model permissions within assigned workspaces |
| `viewer` | Read-only per model permissions within assigned workspaces |

Tenant role = ceiling. Workspace role = narrowing. Models further restrict field-level access.

---

## Retention & Deletion

Records have three lifecycle states:

| Status | Visible | Queryable | Deletable |
|--------|---------|-----------|-----------|
| `active` | Yes | Yes | No (archive first) |
| `archived` | No (unless filtered) | Yes (explicit filter) | Yes |
| `deleted` | No | No | N/A (gone) |

**Archive:** Soft-remove. Record still exists for compliance/audit. Excluded from default queries and UI.

**Delete:** Hard-remove. Record and its log entries are purged. Used for CCPA requests, departed employees, or data past retention limits.

Models control retention via `behavior.retention`:

```json
"retention": { "archiveAfterDays": 365, "deleteOnRequest": true }
```

Plugins can override: financial records may forbid deletion regardless of requests (compliance trumps CCPA in regulated contexts — legal determines which wins). A scheduled job ("garbage day") runs the retention filter: archive records past their threshold, surface deletion candidates for review.

---

## Files

Files live in encrypted object storage (S3), isolated per tenant. A file is a record:

```json
{
  "id": "file_receipt_001",
  "type": "file",
  "meta": {
    "name": "contribution_receipt.pdf",
    "mimeType": "application/pdf",
    "sizeBytes": 84210,
    "storageKey": "tenant_walmart/ws_pac/file_receipt_001",
    "attachedTo": { "$ref": "rec_tx_123" }
  }
}
```

Access follows the same permission model as any record — if you can access the record a file is attached to, you can access the file. Upload and download flow through the interface (permissions, logging). Storage is encrypted at rest, keyed per tenant.

---

## Logs

Every operation produces an append-only log entry in the same transaction:

```json
{
  "id": "log_abc123",
  "record_id": "rec_tx_1",
  "action": "create",
  "before": null,
  "after": { "type": "transaction.contribution", "meta": {} },
  "actor": "rec_user_1",
  "occurred_at": "2026-05-28T12:00:00Z",
  "source": "api:pat_sms_platform"
}
```

1. **Append-only.** Never updated. Deleted only during hard-delete (retention).
2. **Interface-written only.** No user, hook, or surface writes to logs.
3. **Time-partitioned.** Monthly partitions for retention and archival.

Financial corrections use reversals:

```
rec_tx_1 → original ($2500, status: reversed)
rec_tx_2 → reversal (-$2500, reverses: rec_tx_1)
rec_tx_3 → correction ($2000, corrects: rec_tx_1)
```

---

## Database

Each workspace database:

```sql
CREATE TABLE records (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  meta JSONB NOT NULL DEFAULT '{}',
  system JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE logs (
  id TEXT PRIMARY KEY,
  record_id TEXT,
  action TEXT NOT NULL,
  before JSONB,
  after JSONB,
  actor TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source TEXT NOT NULL,
  context JSONB NOT NULL DEFAULT '{}'
) PARTITION BY RANGE (occurred_at);

CREATE INDEX records_type_idx ON records (type);
CREATE INDEX records_meta_gin ON records USING GIN (meta);
CREATE INDEX logs_record_idx ON logs (record_id, occurred_at);
CREATE INDEX logs_actor_idx ON logs (actor, occurred_at);
```

No `tenant_id` column. Isolation is physical. Logs have no UPDATE or DELETE grants (hard-delete uses a privileged system role).

Accelerators added when needed:

```
ref index       → precomputed reference graph
report cache    → materialized report results
search index    → pg_trgm + tsvector across meta
generated cols  → hot meta paths promoted to indexed columns
```

All derived. All rebuildable. Never the source of truth.

---

## Import & Export

Schema-driven. Models define fields → system generates templates.

**Import:** User picks type → downloads template → fills → uploads → preview → validates against model → each row enters through the interface (same hooks, permissions, logging). No bulk backdoor.

**Export:** Each row goes through the interface (permissions, redaction). If a user can't see a field, they can't export it. Every export is logged.

Cross-workspace migration uses the same import/export templates. Standard egress format out, standard ingress template in.

---

## Stack

```
Postgres          — data, jobs, events, search, subscriptions, partitioned logs
Node.js + Next.js — API + workroom in one deployment
S3                — encrypted file storage (tenant-isolated)
SendGrid          — email (magic links, notifications) + SMS
```

### Packages

```
pg                — driver + connection pool
casl              — permission engine (abilities from model records)
dataloader        — batched ref resolution (N+1 prevention)
pothos + yoga     — GraphQL schema builder + server + subscriptions
pg-boss           — job queue (Postgres-native, transactional enqueue)
pino              — structured logging
lru-cache         — in-memory cache (models, permissions, config)
graphql-ws        — WebSocket transport for subscriptions
```

### Postgres as Platform

| Capability | Mechanism |
|-----------|-----------|
| Job queue | pg-boss (SKIP LOCKED, transactional) |
| Real-time | LISTEN / NOTIFY → GraphQL subscriptions |
| Search | tsvector + pg_trgm + GIN |
| Log partitioning | PARTITION BY RANGE (occurred_at) |
| Connection pooling | PgBouncer (transaction mode) |
| Scheduling | pg-boss cron (retention jobs, report materialization) |

No Redis. No Kafka. No external queue.

### Scaling Ladder

```
Phase 1: One process, one Postgres instance
         → hundreds of tenants, millions of records

Phase 2: Multiple stateless processes + load balancer
         → pg-boss workers in any process, PgBouncer manages connections

Phase 3: Read replicas
         → reports/reads hit replica, writes hit primary

Phase 4: Workspace sharding
         → hot workspaces move to dedicated instances
         → global catalog maps workspace → connection string
         → application code unchanged
```

Each phase is operational. The interface never changes.

---

## API

One endpoint. Schema-driven.

```
POST /api/graphql
WS   /api/graphql (subscriptions)
```

```graphql
query { record(id: "rec_123") { id type meta system } }
mutation { saveRecord(input: { type: "person", meta: { ... } }) { id } }
query { records(type: "transaction.contribution", where: { ... }, first: 50, after: "cursor") { edges { node { id meta } } } }
subscription { recordChanged(type: "person") { id action record { id meta } } }
```

Cursor-based pagination. Depth and complexity limits enforced.

---

## Web App

Schema-driven workroom. Models generate:

```
tables, detail pages, forms, reference pickers
filters, groups, pivots, charts, exports
```

Nothing hand-built per type. The model is the UI contract. Null fields are omitted from display — the UI renders what exists.

Real-time: subscriptions push changes to open views. Data appears as it arrives.

---

## Principles

```
1. Everything is a record
2. Everything flows through one interface
3. Everything is logged (same transaction, append-only)
4. Models drive behavior — not code
5. Surfaces are generated — not maintained
6. Plugins bundle capability — toggle on/off
7. Config cascades — workspace → tenant → system
8. Financial records are immutable — corrections only
9. Postgres is the platform — no external services beyond storage and email/SMS
10. Scale by adding instances — architecture unchanged
11. Fields are nullable — no migrations, UI renders what exists
12. Data is real-time — changes broadcast, clients subscribe
```