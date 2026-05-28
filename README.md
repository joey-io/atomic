# Atomic

Everything is a record. One interface. One database engine. One person can hold the whole system in their head.

Atomic is a schema-driven workroom. Every operation is auditable, every mutation is traceable. Models define the data — the API and UI are generated from them.

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
8. Immutable records use corrections, not edits
9. Postgres is the platform — no external services beyond storage and email
10. Scale by adding instances — architecture unchanged
11. Fields are nullable — no migrations, UI renders what exists
12. Data is real-time — changes broadcast, clients subscribe
```

---

## The Atom

Every durable thing is a record:

```json
{
  "id": "rec_123",
  "type": "invoice",
  "meta": {},
  "system": {}
}
```

| Field | Purpose |
|-------|---------|
| `id` | Stable identity. No business meaning embedded. |
| `type` | Model key — `person`, `invoice`, `task`, etc. |
| `meta` | Domain data. Shaped by the model. All fields nullable unless `required`. |
| `system` | Lifecycle — `createdAt`, `updatedAt`, `createdBy`, `updatedBy`, `version`, `status`, `source`. Managed by the interface only. |

Real-world dates (`occurredAt`, `filedAt`, `effectiveAt`) belong in `meta`. `system` tracks the record's life inside Atomic.

### Schema Evolution

Models can add fields at any time. New fields are nullable by default — old records simply don't have them yet. The UI renders what's present and omits what's null. No migrations. No backfills.

### References

A ref is a meta value pointing to another record:

```json
{ "$ref": "rec_person_123" }
```

Models declare which fields are refs and what types they can target. The system resolves ref paths for traversal (e.g., `order.customer.region`).

---

## Models

A model is a record that defines a record type. This is the most important record in the system — everything else derives from it:

```json
{
  "id": "model_invoice",
  "type": "model",
  "meta": {
    "appliesTo": "invoice",
    "label": "Invoice",
    "fields": {
      "issuedAt": { "kind": "datetime", "required": true, "filterable": true, "sortable": true },
      "amountCents": { "kind": "money", "required": true, "measure": true, "aggregations": ["sum", "avg", "min", "max"] },
      "customer": { "kind": "ref", "to": ["person", "organization"], "required": true }
    },
    "display": {
      "row": ["issuedAt", "customer.name.display", "amountCents"],
      "card": { "title": "{{amountCents | money}}", "subtitle": "{{customer.name.display}}" }
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
  "id": "report_invoices_by_quarter",
  "type": "report.pivot",
  "meta": {
    "source": "invoice",
    "where": { "issuedAt": { "between": ["2025-01-01", "2026-12-31"] } },
    "groupBy": ["issuedAt.quarter"],
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
  "id": "plugin_invoicing",
  "type": "plugin",
  "meta": {
    "name": "Invoicing",
    "provides": {
      "models": ["model_invoice", "model_payment"],
      "reports": ["report_invoices_by_quarter", "report_aging"],
      "hooks": ["hook_payment_reconciliation"]
    },
    "requires": ["plugin_base_finance"]
  }
}
```

Activate = its capabilities appear. Deactivate = they disappear. Data stays.

---

## The Interface

Every operation flows through one pipeline:

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

This is the only way data enters or leaves the system. Import, export, file upload, API calls — all pass through the same pipeline with the same hooks, permissions, and logging.

### Surfaces

Generated from models. Not maintained separately.

| Surface | Transport |
|---------|-----------|
| GraphQL API | Single endpoint, schema from models, subscriptions via WebSocket |
| SDK | Typed client generated from models |
| MCP | Tool definitions for AI agents generated from models |
| Web App | Tables, forms, detail pages, filters, charts — all from model `display` config |

Add a model → all surfaces expose it. Change a field → all surfaces reflect it.

### Hooks

Hooks are records that run at defined points in the pipeline:

```json
{
  "id": "hook_validate_payment",
  "type": "hook",
  "meta": {
    "on": "pre:save",
    "match": "payment",
    "action": "validate_payment_amount",
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

Async post-hooks enqueue in the same transaction as the write. They execute via background workers with retry (3× exponential backoff → dead-letter → admin workroom).

---

## Hierarchy

```
System (global catalog database)
  └─ Tenant (organization)
       ├─ Workspace A  → database: atomic_tenant_ws_a
       ├─ Workspace B  → database: atomic_tenant_ws_b
       └─ Config overrides, plugin grants, file storage bucket
```

**Tenant** = the organization. Owns users, billing, config, plugin grants.
**Workspace** = the data boundary. One database. One isolated corpus.

A solo user: one tenant, one workspace. An enterprise: one tenant, many workspaces.

Data never moves between workspaces directly. Cross-workspace migration uses standard import/export templates. Tenant-level aggregate reporting is available in the admin hub, but workspaces remain isolated.

The global catalog database holds: tenant registry, system models, plugin definitions, reference data, user records, and system-level config.

**Provisioning:** Create database → seed schema → add to tenant record → grant plugins → done.

---

## Config

Settings resolve bottom-up. First match wins:

```
workspace config → tenant config → system config
```

A config record specifies scope, key, and value. Plugins declare which config keys they need — the interface resolves through the cascade. Tenants can override system defaults (e.g., their own email provider credentials); workspaces can further override tenant settings.

---

## Auth & Permissions

One flow: request arrives → hash token → lookup hash → load actor → merge roles → check permissions.

A token is a record with a hashed secret, a ref to an actor, and a scope (tenant, workspace, permitted types, permitted operations, expiry).

| Origin | Lifespan | Scope |
|--------|----------|-------|
| Magic link (humans) | Short (1h) | Full user permissions |
| Generated key (machines) | Long (months) | Narrowed to tenant, workspace, types, operations |

No passwords. No OAuth. No JWTs. Revocation = delete the token record. Leaked keys have contained blast radius (scoped to specific types in one workspace).

### Roles

| Role | Access |
|------|--------|
| `super` | Everything — all tenants, global catalog, system config |
| `admin` | Full access within their tenant's workspaces |
| `editor` | Read/write per model permissions within assigned workspaces |
| `viewer` | Read-only per model permissions within assigned workspaces |

Tenant role = ceiling. Workspace role = narrowing. Models further restrict field-level access.

---

## Record Lifecycle

Records have three states:

| Status | Visible | Queryable | Deletable |
|--------|---------|-----------|-----------|
| `active` | Yes | Yes | No (archive first) |
| `archived` | No (unless filtered) | Yes (explicit filter) | Yes |
| `deleted` | No | No | N/A (gone) |

**Archive:** Soft-remove for compliance/audit. Excluded from default queries.
**Delete:** Hard-remove. Record and its log entries purged (CCPA, retention limits).

Models control retention via `behavior.retention` (archive after N days, allow/forbid deletion). Plugins can override — compliance-regulated records may forbid deletion. A scheduled job runs the retention filter.

### Files

Files live in encrypted object storage, isolated per tenant. A file is a record with a `storageKey` and an `attachedTo` ref. Access follows the parent record's permissions. Storage is encrypted at rest, keyed per tenant.

### Logs

Every operation produces an append-only log entry (same transaction): record ID, action, before/after snapshots, actor, timestamp, source.

- **Append-only.** Never updated. Deleted only during hard-delete (retention).
- **Time-partitioned.** Monthly partitions for archival.

### Corrections

Immutable records are never edited. Corrections use reversals:

```
rec_1 → original ($2500, status: reversed)
rec_2 → reversal (-$2500, reverses: rec_1)
rec_3 → correction ($2000, corrects: rec_1)
```

---

## Database

Two tables per workspace: `records` and `logs`.

**Records:** `id`, `type`, `meta` (JSONB), `system` (JSONB), timestamps. Indexed on type and meta (GIN).

**Logs:** `id`, `record_id`, `action`, `before`/`after` (JSONB), `actor`, `occurred_at`, `source`. Partitioned by `occurred_at`. No UPDATE or DELETE grants (hard-delete uses a privileged system role).

No `tenant_id` column. Isolation is physical — each workspace is its own database.

Accelerators added when needed (ref graph, materialized reports, trigram search, generated columns for hot paths). All derived. All rebuildable. Never the source of truth.

---

## Stack

| Layer | Choice | Why |
|-------|--------|-----|
| Database | Postgres | Data, jobs (SKIP LOCKED), events (LISTEN/NOTIFY), search (tsvector + GIN), partitioned logs |
| Application | Node.js + Next.js | API + workroom in one deployment |
| File storage | S3-compatible | Encrypted, tenant-isolated |
| Email | Transactional provider | Magic links, notifications |

Postgres handles job queues, real-time subscriptions, full-text search, and scheduling. No Redis. No Kafka. No external queue.

### Scaling

The architecture scales horizontally without changes to the interface:

- **Vertical:** One process, one Postgres instance handles hundreds of tenants / millions of records.
- **Horizontal:** Stateless processes behind a load balancer; connection pooling; workers in any process.
- **Read replicas:** Reports and reads hit replicas; writes hit primary.
- **Sharding:** Hot workspaces move to dedicated instances. The catalog maps workspace → connection string. Application code unchanged.

---

## Import & Export

Schema-driven. Models define fields → system generates templates.

**Import:** Pick type → download template → fill → upload → preview → validate → each row enters through the interface pipeline.

**Export:** Each row passes through the interface. If a user can't see a field, they can't export it.

Cross-workspace migration uses the same templates.