# Atomic

Atomic is a schema-driven CRM and data workroom built around one simple idea: every thing in the system is a record.

Records describe people, places, organizations, districts, elected officials, voter-file entities, transactions, activities, imports, models, and reports using the same atomic shape. The model layer defines what each record means, and the application generates the UI, API, reports, validation, and analysis surfaces from those models.

The goal is a clean, flexible corpus where data can be viewed, linked, filtered, grouped, pivoted, searched, and reported across any meaningful dimension without hand-building a separate UI and API for every object type.

## The Model

Every record has the same base structure:

```json
{
  "id": "rec_123",
  "type": "person",
  "meta": {},
  "system": {}
}
```

### `id`

The unique identity of the record. The ID should not carry business meaning or duplicate the type. It is simply the stable identifier for the atom.

### `type`

The model key that explains what the record is and how it behaves.

Examples:

```txt
person
organization
district
elected_official
transaction.payment
email.opened
model
report.table
report.pivot
```

### `meta`

The domain data for the record.

For a person:

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

For a payment transaction:

```json
{
  "occurredAt": "2026-05-27T12:00:00Z",
  "amountCents": 25000,
  "currency": "USD",
  "payer": {
    "$ref": "rec_org_789"
  },
  "payee": {
    "$ref": "rec_person_123"
  }
}
```

### `system`

Lifecycle and provenance data about the record inside Atomic.

```json
{
  "createdAt": "2026-05-28T12:00:00Z",
  "createdBy": {
    "$ref": "rec_user_1"
  },
  "updatedAt": "2026-05-28T12:00:00Z",
  "updatedBy": {
    "$ref": "rec_user_1"
  },
  "source": "manual",
  "status": "active",
  "version": 1
}
```

`system.createdAt` is when the record entered Atomic. Domain dates such as `occurredAt`, `registeredAt`, `foundedAt`, `effectiveAt`, or `validFrom` belong in `meta` and are defined by the record's model.

## References

A reference is a meta value that points to another record.

```json
{
  "$ref": "rec_person_123"
}
```

A reference is not a separate user-facing table. It is simply a typed value inside `meta`. The model defines which fields are references and which record types they can point to.

Example model field:

```json
{
  "kind": "ref",
  "label": "Payee",
  "to": ["person", "organization", "committee"],
  "required": true,
  "filterable": true,
  "groupable": true
}
```

This allows Atomic to understand paths like:

```txt
payee.name.last
payee.homeDistrict.representative.election.isUpForReelection
employer.industry
```

The system can follow the reference, validate it, display it, query through it, and use it in reports.

## Models

Models are records that define other record types.

A model defines:

- fields
- field types
- reference targets
- validation rules
- display rules
- query/report behavior
- permissions and write behavior
- default report columns and measures

Example payment model:

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
      "currency": {
        "kind": "string",
        "label": "Currency",
        "default": "USD"
      },
      "payer": {
        "kind": "ref",
        "label": "Payer",
        "to": ["person", "organization"],
        "required": true,
        "filterable": true,
        "groupable": true
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
        "columns": [
          "occurredAt",
          "payer.name.display",
          "payee.name.display",
          "amountCents"
        ]
      }
    },
    "behavior": {
      "mutable": false,
      "correctionMode": "reversal",
      "primaryTimeField": "occurredAt"
    },
    "reports": {
      "defaultMeasures": [
        {
          "field": "amountCents",
          "op": "sum"
        }
      ],
      "defaultDimensions": [
        "payer",
        "payee",
        "occurredAt"
      ]
    }
  }
}
```

Models are configurable. System models provide the base shape. Tenant-specific models and extensions can add custom fields, rename labels, define report behavior, and adjust presentation without requiring separate UI or API code.

## Reports

Reports are records that define derived views over the corpus.

A report can represent a table, pivot, chart, dashboard, map, timeline, search index, export, or materialized analytical view.

Example report:

```json
{
  "id": "report_payments_by_rep_reelection",
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
      },
      {
        "op": "count",
        "as": "transactionCount"
      }
    ],
    "mode": "live"
  }
}
```

Reports can be executed in different modes:

```txt
live          Run directly from source records.
cached        Store the latest result for fast reloads.
materialized  Maintain a generated result set for large or frequently used reports.
```

The report remains the same. The execution strategy can change as usage and data volume grow.

## Data Store

Atomic starts with a deliberately small Postgres schema.

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
```

Core indexes:

```sql
CREATE INDEX records_tenant_type_idx
ON records (tenant_id, type);

CREATE INDEX records_meta_gin_idx
ON records USING GIN (meta);

CREATE INDEX records_system_gin_idx
ON records USING GIN (system);
```

Optional generated infrastructure:

```txt
record_ref_index   Generated from $ref values for faster graph traversal and semantic joins.
report_results     Generated rows for cached or materialized reports.
search_index       Generated search documents for full-text and semantic search.
analytics_facts    Generated fact tables for high-volume reporting.
```

These generated structures are not the canonical corpus. They are rebuildable accelerators.

## Tech Stack

The initial stack should stay boring and reliable.

```txt
TypeScript
Node.js
Postgres
JSONB
GraphQL
React
Next.js
Tailwind CSS
```

### Backend

- **Node.js + TypeScript** for the kernel, API, report compiler, validation, and workers.
- **Postgres** as the canonical record store.
- **JSONB** for flexible `meta` and `system` data.
- **Generated SQL** for reports, semantic paths, joins, filtering, grouping, and aggregation.
- **Background workers** for cached/materialized reports, search documents, and ref indexes.

### API

- **GraphQL** as the primary graph-shaped API surface.
- Generic record APIs for CRUD, model introspection, reference resolution, and report execution.
- Generated GraphQL fields and documentation from models over time.

### Web App

- **Next.js + React** for the schema-driven workroom.
- **Tailwind CSS** for a clean, fast UI system.
- Model-driven pages, forms, tables, field pickers, filters, pivots, and dashboards.

## Schema-Driven APIs

The API is generated from models.

Core routes can remain generic:

```txt
GET    /records/:id
POST   /records
PATCH  /records/:id
GET    /models/:type
POST   /query
POST   /reports/:id/run
```

GraphQL provides the primary query surface:

```graphql
query {
  record(id: "rec_person_123") {
    id
    type
    meta
    system
    ref(path: "homeDistrict") {
      id
      type
      meta
    }
  }
}
```

Reports are also executable through the API:

```graphql
query {
  runReport(
    input: {
      source: "transaction.payment"
      groupBy: ["payee.homeDistrict.representative.election.isUpForReelection"]
      measures: [
        { field: "amountCents", op: SUM, as: "totalAmountCents" }
      ]
    }
  ) {
    columns
    rows
    freshness
  }
}
```

The API does not need to know in advance about every civic, political, financial, or voter-file object. It reads the relevant model and behaves accordingly.

## Schema-Driven Web App

The Atomic workroom is generated from models.

For any record type, the app can generate:

- list views
- detail pages
- create/edit forms
- reference pickers
- field pickers
- filters
- grouped tables
- pivots
- charts
- maps
- dashboards
- exports

A person model can generate a People table. A district model can generate a Districts view. A transaction model can generate financial reports. An elected official model can expose fields like party, chamber, district, committee membership, election cycle, and reelection status.

The app should be generated by default and custom only when necessary.

```txt
Generated by default.
Custom when strategically necessary.
Never duplicate the data model.
```

## Product Principle

Atomic should make the corpus itself the product.

The records hold the data. The models define meaning. The reports derive insight. The UI and API are generated from the same model layer, so the system can grow without maintaining separate interfaces for every new object type.

```txt
Record = atom
Model = meaning
Ref = connection
Report = derived view
```
