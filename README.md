# Atomic

Atomic is a semantic CRM workroom built from one idea: **everything is a record**.

The corpus should be so small and obvious that one person can understand the whole system at once. A record has an identity, a type, domain meta, and system meta. Models define what record types mean. Reports are records that derive views from other records. The database, API, and web app all follow from that same model layer.

Atomic should feel less like an application with many separate screens and routes, and more like a living corpus that knows how to describe, validate, display, query, and report on itself.

## Design Goal

Atomic exists to minimize maintenance surface.

The system should have:

```txt
one canonical record shape
one canonical records table
one model system
one report system
one API surface
one schema-driven web workroom
```

No bespoke CRUD surface for every object type. No separate UI model. No separate API model. No separate reporting model. The model is the product contract.

## The Atom

Every durable item in Atomic is a record.

```json
{
  "id": "rec_123",
  "type": "person",
  "meta": {},
  "system": {}
}
```

### `id`

The stable identity of the record. The ID should not duplicate the type or carry business meaning.

### `type`

The model key that explains what the record is.

Examples:

```txt
person
organization
place
district
elected_official
voter_file_person
transaction.payment
email.opened
model
report.table
report.pivot
```

### `meta`

The domain data for the record.

```json
{
  "name": {
    "first": "Joey",
    "last": "Smith",
    "display": "Joey Smith"
  },
  "homeDistrict": {
    "$ref": "rec_district_md08"
  },
  "employer": {
    "$ref": "rec_org_789"
  }
}
```

### `system`

Lifecycle and provenance data about the record inside Atomic.

```json
{
  "createdAt": "2026-05-28T12:00:00Z",
  "createdBy": { "$ref": "rec_user_1" },
  "updatedAt": "2026-05-28T12:00:00Z",
  "updatedBy": { "$ref": "rec_user_1" },
  "source": "manual",
  "status": "active",
  "version": 1
}
```

`system.createdAt` is when the record entered Atomic. Real-world dates such as `occurredAt`, `registeredAt`, `foundedAt`, `effectiveAt`, or `validFrom` belong in `meta` and are defined by the model.

## References

A reference is just a meta value that points to another record.

```json
{
  "$ref": "rec_person_123"
}
```

References are not a separate user-facing concept. They are how records connect.

A transaction can point to a person:

```json
{
  "id": "rec_tx_1",
  "type": "transaction.payment",
  "meta": {
    "occurredAt": "2026-05-27T12:00:00Z",
    "amountCents": 25000,
    "currency": "USD",
    "payee": { "$ref": "rec_person_123" }
  },
  "system": {}
}
```

A report can then ask for:

```txt
payee.name.last
payee.homeDistrict.representative.election.isUpForReelection
payee.employer.industry
```

The system understands those paths because the model says which fields are references and what they can point to.

## Models

A model is a record that defines another record type.

```json
{
  "id": "model_person",
  "type": "model",
  "meta": {
    "appliesTo": "person",
    "label": "Person",
    "pluralLabel": "People",
    "fields": {},
    "display": {},
    "behavior": {},
    "reports": {}
  },
  "system": {}
}
```

A model defines:

```txt
fields
field types
reference targets
validation
presentation
write behavior
report behavior
permissions later
```

Example:

```json
{
  "id": "model_transaction_payment",
  "type": "model",
  "meta": {
    "appliesTo": "transaction.payment",
    "label": "Payment",
    "pluralLabel": "Payments",
    "fields": {
      "occurredAt": {
        "kind": "datetime",
        "label": "Occurred At",
        "required": true,
        "filterable": true,
        "sortable": true
      },
      "amountCents": {
        "kind": "money",
        "label": "Amount",
        "required": true,
        "measure": true,
        "aggregations": ["sum", "avg", "min", "max"]
      },
      "payee": {
        "kind": "ref",
        "label": "Payee",
        "to": ["person", "organization", "committee"],
        "required": true,
        "filterable": true,
        "groupable": true
      }
    },
    "display": {
      "row": {
        "columns": ["occurredAt", "payee.name.display", "amountCents"]
      },
      "card": {
        "title": "{{amountCents | money}}",
        "subtitle": "{{payee.name.display}}"
      }
    },
    "behavior": {
      "mutable": false,
      "correctionMode": "reversal",
      "primaryTimeField": "occurredAt"
    },
    "reports": {
      "defaultMeasures": [
        { "field": "amountCents", "op": "sum" }
      ],
      "defaultDimensions": ["payee", "occurredAt"]
    }
  }
}
```

Models are configurable. System models provide the base vocabulary. Tenant models can add fields, rename labels, change displays, and define report behavior without new UI or API code.

## Reports

A report is also a record.

A report is a saved way to view, filter, group, pivot, search, map, export, or summarize the corpus.

```json
{
  "id": "report_payments_by_reelection",
  "type": "report.pivot",
  "meta": {
    "name": "Payments by Representative Reelection Status",
    "source": "transaction.payment",
    "where": {
      "occurredAt": {
        "between": ["2026-01-01", "2026-12-31"]
      }
    },
    "groupBy": [
      "payee.homeDistrict.representative.election.isUpForReelection"
    ],
    "measures": [
      {
        "field": "amountCents",
        "op": "sum",
        "as": "totalAmountCents"
      }
    ],
    "mode": "live"
  },
  "system": {}
}
```

Reports can run live at first. If a report becomes expensive or important, the same report can later be cached or materialized. That is an execution detail, not a new product concept.

## Database

Start with one canonical table.

```sql
CREATE TABLE records (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  type TEXT NOT NULL,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  system JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX records_tenant_type_idx
ON records (tenant_id, type);

CREATE INDEX records_meta_gin_idx
ON records USING GIN (meta);

CREATE INDEX records_system_gin_idx
ON records USING GIN (system);
```

That is the corpus.

Everything else is an accelerator and should be added only when needed:

```txt
ref index
report result cache
search index
analytics fact table
```

Accelerators are generated from records. They are rebuildable. They are not the source of truth.

## Tech Stack

Keep the stack boring.

```txt
TypeScript
Node.js
Postgres
JSONB
GraphQL
Next.js
React
Tailwind CSS
```

### Backend

The backend is a small TypeScript kernel that does five things:

```txt
save records
load models
validate meta
resolve references
run reports
```

No per-type service layer unless a type truly needs custom behavior.

### API

Atomic should expose one API surface.

```txt
POST /api/graphql
```

GraphQL is the front door to the corpus.

The API should stay generic:

```graphql
query {
  record(id: "rec_person_123") {
    id
    type
    meta
    system
  }
}
```

```graphql
mutation {
  saveRecord(input: {
    id: "rec_person_123"
    type: "person"
    meta: {
      name: { display: "Joey Smith" }
    }
  }) {
    id
    type
  }
}
```

```graphql
query {
  runReport(id: "report_payments_by_reelection") {
    columns
    rows
    freshness
  }
}
```

There should not be separate routes like `/people`, `/transactions`, `/districts`, `/models`, and `/reports`. Those are all records. Their behavior comes from their models.

### Web App

The web app is one schema-driven workroom.

The workroom reads models and generates:

```txt
tables
record detail pages
forms
reference pickers
field pickers
filters
groups
pivots
charts
maps
exports
```

A person screen is not hand-built. A transaction screen is not hand-built. A district screen is not hand-built. The model tells the workroom what fields exist, what can be edited, what can be grouped, what can be searched, and how the record should be displayed.

Custom UI is allowed only when strategically necessary. It should sit on top of the same record/model/report system.

## Operating Principle

Atomic should remain small enough for one person to hold in their head.

```txt
Record = atom
Model = meaning
Ref = connection
Report = view
```

The product is the corpus. The corpus is records. Models make records meaningful. Reports make records useful.
