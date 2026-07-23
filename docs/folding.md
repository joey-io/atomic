# Folding: deterministic identity resolution

Parsing answers **what appears in this observation?** Folding answers **is it new, or another observation of something already known?**

Atomic treats folding as a first-class stage between extraction and the canonical graph:

```text
input → observe → candidates → normalize → resolve → fold → canonical atoms
                                                   ├─ create
                                                   ├─ merge
                                                   └─ review
```

The engine is generic. Each model defines what identity means in its domain.

## Safety invariants

Atomic's fold process is designed around invariants rather than the fiction of a universally perfect similarity score:

1. **Observations are immutable.** The source claim remains available even when the canonical value changes.
2. **Canonical fields are projections of assertions.** A merge never destroys alternate values.
3. **Strong contradictions block automatic merging.** A definitive conflict cannot be outweighed by many weak similarities.
4. **Contextual similarity alone does not auto-merge by default.** At least one strong identity signal is required.
5. **Decisions are deterministic.** The same normalized inputs and model-pack version produce the same identity hashes and match decision.
6. **Every merge is an event.** The algorithm, score, signals, contradictions, source observation, and target atom are recorded.
7. **Manual atom merges are reversible.** `atomic.split(mergeId)` removes the redirect and marks the merge event reversed.
8. **No quadratic scan is required.** Identity hashes block candidate retrieval before detailed evaluation.

## Public API

```js
import { createAtomic } from 'atomic';

const atomic = await createAtomic({
  models: ['@atomic/models-public-affairs'],
  resolution: {
    autoMergeScore: 120,
    reviewScore: 45,
    requireStrongForAutoMerge: true
  }
});

const preview = await atomic.observe(document);
const match = await atomic.resolve(preview.candidates[0], preview);
const folded = await atomic.fold(preview.candidates[0], preview);
const result = await atomic.parse(document);
```

`parse()` now returns:

```js
{
  candidates,
  accepted,
  review,
  rejected,
  folds: [
    {
      action: 'create' | 'merge' | 'review',
      atom,
      observation,
      assertions,
      decision,
      matches,
      merge?,
      review?
    }
  ],
  persisted // canonical atoms produced by the folds
}
```

Manual identity correction is explicit:

```js
const merge = await atomic.merge('atom://person-a', 'atom://person-b', 'confirmed by analyst');
await atomic.split(merge.id, 'records describe different people');
```

## Three-layer data model

### Observation

An immutable record of what a source/provider emitted:

```json
{
  "id": "observation://document-42/candidate-1",
  "model": "person",
  "attributes": {
    "name": "J. Smith",
    "email": "JANE@EXAMPLE.COM"
  },
  "normalized": {
    "name": "j. smith",
    "email": "jane@example.com"
  },
  "evidence": [{ "source": "document-42", "excerpt": "J. Smith" }],
  "provider": "example-provider",
  "confidence": 0.94
}
```

### Assertion

One field claim made by an observation:

```json
{
  "id": "assertion://...",
  "field": "name",
  "value": "j. smith",
  "observation": "observation://document-42/candidate-1",
  "confidence": 0.94,
  "sourcePriority": 0,
  "assertedAt": "2026-07-23T00:00:00.000Z"
}
```

### Canonical atom

The current projection over all assertions associated with one identity:

```json
{
  "id": "atom://person-...",
  "model": "atom://person",
  "attr": {
    "name": "jane smith",
    "email": "jane@example.com"
  },
  "identityKeys": [],
  "assertions": []
}
```

The flat `attr` surface remains convenient for applications. The assertions explain how it was derived.

## Identity definitions

Identity belongs to the model:

```js
{
  name: 'asset',
  extends: 'thing',
  attributes: {
    name: { kind: 'text', required: true },
    serial: {
      kind: 'text',
      required: true,
      merge: { strategy: 'never-overwrite' }
    },
    site: { kind: 'text' },
    tags: { kind: 'list', merge: { strategy: 'union' } }
  },
  identity: [
    {
      name: 'serial',
      fields: ['serial'],
      strength: 'definitive',
      exclusive: true
    },
    {
      name: 'name-site',
      fields: ['name', 'site'],
      strength: 'medium'
    }
  ]
}
```

For every complete identity rule Atomic creates a deterministic SHA-256 blocking key:

```text
sha256(model | key-name | stable-normalized-values)
```

Only atoms sharing at least one key are evaluated. This provides indexed candidate retrieval rather than comparing every record with every atom.

## Strength classes

- `definitive` — a domain identifier that can directly establish identity, such as a trusted serial number or government identifier.
- `strong` — a reliable identifier such as email or normalized phone.
- `medium` — a composite contextual key.
- `weak` — useful for blocking or review, but insufficient for automatic merging by itself.

Default match weights are:

| Strength | Weight |
|---|---:|
| definitive | 1000 |
| strong | 120 |
| medium | 45 |
| weak | 12 |

A model may override `weight` per key.

## Exclusive keys and contradictions

An exclusive key means that two different complete values are evidence against identity:

```js
{
  name: 'serial',
  fields: ['serial'],
  strength: 'definitive',
  exclusive: true,
  contradictionWeight: 10000
}
```

Suppose two assets share the same name and site but have different serial numbers. The contextual key retrieves the existing atom, but the serial conflict creates a definitive contradiction. The decision is review, never automatic merge.

Contradictions are evaluated separately from positive signals. They are not hidden inside a single opaque similarity number.

## Contextual signals

Models may add field comparisons after identity-key blocking:

```js
resolution: {
  signals: [
    { field: 'name', compare: 'token-set', weight: 20 },
    { field: 'employer', compare: 'exact', weight: 30 },
    { field: 'birthDate', compare: 'exact', weight: 40, contradiction: 500 }
  ],
  thresholds: {
    autoMerge: 150,
    review: 60
  },
  requireStrongForAutoMerge: true
}
```

Supported deterministic comparators are:

- `exact`
- `contains`
- `token-set`

Providers may propose values and relationships, but the final automatic merge decision uses these deterministic model policies.

## Decision policy

The default order is:

1. No possible atom → `create`.
2. Definitive contradiction → `review`.
3. Definitive key match → `merge`.
4. Score reaches auto-merge threshold and strong evidence exists → `merge`.
5. Score reaches review threshold → `review`.
6. Otherwise → `create`.

A review result creates a separate canonical atom and a review record linking the plausible matches. Atomic does not force uncertain records together.

## Normalization

Normalization occurs before keys are generated and before fields are compared. Built-in behavior includes:

- Unicode NFKC normalization
- trimming and whitespace collapse
- case folding for text and email
- deterministic key ordering for maps
- ISO conversion for valid datetimes
- basic phone canonicalization

A field can name a normalizer:

```js
phone: { kind: 'text', normalize: 'phone' }
```

Applications can inject project normalizers:

```js
const atomic = await createAtomic({
  normalizers: {
    congressionalDistrict(value) {
      return String(value).toUpperCase().replace(/\s+/g, '');
    }
  }
});
```

Normalizers must be deterministic. Production stores should record the model-pack and normalizer versions alongside fold events so a graph can be replayed or re-folded after an upgrade.

## Field merge policies

Determining that two records have the same identity does not determine which field value wins. Each field independently chooses a projection strategy:

- `highest-confidence` — default; confidence, source priority, then recency.
- `most-recent`
- `source-priority`
- `union`
- `never-overwrite`

```js
attributes: {
  legalName: {
    kind: 'text',
    merge: {
      strategy: 'source-priority',
      sourcePriority: {
        'government-registry': 100,
        'customer-form': 50,
        'web-scrape': 10
      }
    }
  },
  aliases: {
    kind: 'list',
    merge: { strategy: 'union' }
  }
}
```

The losing values remain assertions. Nothing is discarded.

## Fold store contract

The included memory store is suitable for tests and local development. A durable store implements:

```ts
interface FoldStore {
  findByIdentityKeys(model: string, hashes: string[]): Promise<CanonicalAtom[]>;
  createCanonical(atom: CanonicalAtom): Promise<CanonicalAtom>;
  updateCanonical(id: string, patch: object): Promise<CanonicalAtom>;
  recordObservation(observation: Observation): Promise<Observation>;
  recordReview(review: ResolutionReview): Promise<ResolutionReview>;
  recordMerge(merge: MergeEvent): Promise<MergeEvent>;
  getMerge(id: string): Promise<MergeEvent | undefined>;
  updateMerge(id: string, patch: object): Promise<MergeEvent>;
  redirect(source: string, target: string, merge: string): Promise<void>;
  removeRedirect(source: string, merge: string): Promise<void>;
  get(id: string): Promise<CanonicalAtom | undefined>;
}
```

The next production adapter should implement this contract through the existing Atomic kernel, so observations, assertions, reviews, merges, redirects, and canonical atoms inherit the kernel's permissions, tenancy, evidence ledger, lifecycle, and transaction guarantees.

## What “bulletproof” means here

No entity-resolution system can guarantee perfect identity from incomplete evidence. Atomic instead makes the mechanism safe:

- deterministic where possible
- explicit about uncertainty
- conservative about automatic merging
- contradiction-aware
- provenance-preserving
- explainable
- reversible
- testable with domain fixtures

Model-pack evaluation should measure false-merge rate separately from missed-merge rate. In high-risk domains, the auto-merge threshold should optimize aggressively against false merges, with ambiguous records routed to review.
