# What If — Atomic without atoms

> A thought experiment. Not a roadmap, not a deprecation notice. A second look at the
> central bet, asking whether the substrate we invented was already sitting in the page.

Atomic's thesis is that there is one kind of record — the atom, `{ id, model, manifest,
attr, lifecycle }` — and that every surface (schema, data, identity, permissions, queries,
UI) is made of it. The README already takes a strong second position alongside that:
**structure carries meaning.** The stylesheet has no classes and no ids; every rule
targets a semantic element; a data grid *is* a `<table>` inside a scrolling `<figure>`; a
repeater *is* a `<fieldset>`. We render atoms *into* semantic HTML because the HTML is
where the meaning becomes legible.

So here is the question this document exists to ask:

**What if the atom and the semantic element are the same thing — and we built one layer too many?**

---

## The collapse

Line up an atom against the element we already render it into.

| Atom field   | What it is                          | The HTML that already carries it          |
|--------------|-------------------------------------|-------------------------------------------|
| `id`         | opaque, immutable identity          | `id` attribute → `atom://id` is `#id`     |
| `model`      | the type pointer ("what is this")   | the **tag name** / `is=` custom element   |
| `manifest`   | free-text, full-text indexed        | the element's text content                |
| `attr`       | the values; refs are edges          | attributes; `href`/`itemref` are edges    |
| `lifecycle`  | status, version, actor, parent      | `hidden`, `data-*`, DOM containment        |

The mapping is not strained. It is nearly an identity. An atom is a record with a type, a
stable id, a human-readable label, a bag of typed values, and a parent. A semantic element
is a record with a type (its tag), a stable id, human-readable text, a bag of typed
attributes, and a parent node. We invented `attr` and then rendered it back out as
attributes. We invented `lifecycle.parent` for tenancy and then rendered it back out as
containment. We invented `manifest` for a label and then rendered it as text content.

The atom, in this reading, is a **serialization format for a DOM we were going to build
anyway.** What if the DOM *is* the store?

```html
<contact id="7b8f-2f0c"
         data-company="#northwind"
         data-email="jane@northwind.com">
  Jane Roe, VP Eng at Northwind
</contact>
```

That fragment has a type (`contact`), an id, a label, two typed attributes, one of which
(`#northwind`) is an edge. It is the atom from the README — minus the atom.

### Refinement: the element *type* is the model

The table above is slightly too loose on one row. `model` isn't the tag name — the tag
name is just the *pointer*. The model is the thing the pointer points at: **the registered
custom-element definition.** Separate the three and it snaps into place:

- `<contact id="7b8f">` in the document — an **occurrence** — is the **atom** (an instance).
- `contact`, the tag name, is the `model` **pointer** ("what type is this").
- `customElements.define('contact', …)` — the definition behind that name — **is the model.**

And the moment you say *the element type is the model*, the Custom Elements API turns out to
be Atomic's model-and-hook layer, already shipped in every browser:

| Atomic                                         | Custom Elements                              |
|------------------------------------------------|----------------------------------------------|
| model's `fields` — which attrs are typed/watched | `static observedAttributes`                |
| update hook (+ optimistic `version`: old → new)  | `attributeChangedCallback(name, old, new)` |
| create hook                                      | `connectedCallback()`                      |
| delete / retire hook                             | `disconnectedCallback()`                   |
| validation on write (`required`, kind, `unique`) | the property setter / attribute reflector  |

So the model is not a record bolted *beside* the markup — it **is** the element type, and
the lifecycle callbacks **are** the hooks. That matters for the next section: two of the
four things I'm about to claim "must stay an atom" already have an HTML home.

---

## Where the value actually lived

If HTML can be the substrate, then Atomic was never really *about* the atom. Strip the
record format away and ask what the kernel does that the browser does not. Three things
survive, and they are the whole product:

1. **The index.** The browser has no stored queries, no constraints, no inverse edges, no
   full-text search across documents, no "every `contact` whose `company` is `#northwind`."
   `querySelectorAll` is a read over one in-memory tree with no persistence, no joins
   across documents, and no enforcement. Atomic's indexes are the thing HTML lacks.

2. **Permissions.** HTML has no notion of *who may read this element, who may write this
   attribute.* It renders everything to everyone. Atomic's grants — `read` / `create` /
   `update` / `delete` / `write` / `all`, roles as reusable bundles, redaction per
   attribute — are the thing HTML lacks. A `<contact>` that hides `data-email` from an
   anonymous viewer is not something markup can express. It is the kernel's whole reason to
   exist.

3. **Logic and lifecycle.** Validation on write, hooks-as-capabilities running under their
   own grants, append-only logs, optimistic concurrency, soft-delete. HTML is inert; it
   does not validate, react, or remember. Atomic's lifecycle is the thing HTML lacks.

Index, permission, logic. **That is the kernel.** The atom was the part we could have
borrowed.

---

## The minimal kernel: a daemon beside any document

So the more radical framing. Today `atomic.mjs` owns the record format *and* the index
*and* the permissions *and* the rendering — and because it owns the format, it can only
govern data that was born as an atom. But the three things that survive (index, permission,
logic) don't depend on the format at all. They depend only on there being **elements with
ids, types, attributes, and parents** to point at.

What if the kernel stops owning the data and starts owning only the **index over it**?

- The data is semantic HTML — any well-formed document, anywhere. The business's existing
  site. A CMS export. A hand-written page. A fragment streamed from another service.
- The kernel is a small daemon that sits *beside* that document. It crawls or is handed the
  elements, builds its indexes keyed by `id` + tag, attaches grants to (element, attribute)
  pairs, runs validation and hooks on change, and keeps the append-only log.
- Reads go through the kernel, which **redacts before serving**: same one read seam
  (`getStore(actor)`) we already have, but the rows it filters are elements, not atoms. An
  anonymous viewer gets the `<contact>` with `data-email` stripped; `atom://joey` gets it
  whole.
- Writes go through the kernel, which validates the attributes against the type's model
  (the model is still an atom — see below), enforces the grant, bumps the version, fires
  hooks, appends the log — then patches the element.

The kernel never *contains* the contact. It **governs** it. It is an access-and-index
layer that can be pointed at any HTML the way a database index is pointed at a table, or
the way a search engine is pointed at a site — except it also enforces *who may see what*
and *what is allowed to change*, which neither a database index nor a search engine does.

```
              ┌─────────────────────────────────────────┐
  any HTML →  │  kernel (beside the document, not over)  │  → redacted view per actor
  document    │   • index: stored queries, edges, FTS    │
  (the store) │   • permits: grants per (element, attr)  │  ← validated writes
              │   • logic: validate, hooks, log, version │
              └─────────────────────────────────────────┘
```

---

## What still has to be an atom (and why the kernel doesn't fully disappear)

The honest part of the experiment: not everything collapses cleanly into markup. But once
the element type *is* the model (the refinement above), the irreducible set is smaller than
it first looks. Walk the four governance records and two of them turn out to have a home:

- **The model — *mostly answered.*** The custom-element definition is the model, and
  `observedAttributes` + the lifecycle callbacks give you fields and hooks for free. What
  HTML still can't express is the model *as queryable, versioned data* — Atomic's
  self-describing trick where a model is itself an atom you can read, diff, and migrate. A
  `customElements.define` is imperative code, not a record. So the kernel keeps a thin
  model-of-the-model: enough to validate, version, and migrate; not the whole schema.
- **The hook — *answered.*** `connectedCallback` / `attributeChangedCallback` /
  `disconnectedCallback` *are* the create/update/delete hooks. The one thing they don't do
  is run *under their own grants while the caller holds none* — but that's an authorization
  property, which belongs to the grant below, not to the hook itself.
- **The grant — *irreducible.*** `{ actor, scope, permits }`. There is no `permit=""`
  attribute and there must not be — putting permissions in the document means anyone holding
  the document holds the keys. Grants live in the kernel, keyed to elements, never in the
  markup. This is the hard center.
- **The log — *irreducible.*** Append-only history. The document shows the present; the
  kernel remembers the past. Markup has no past tense.

So the irreducible kernel isn't four records — it's **two: grants and the log**, plus a
thin sliver of model-metadata for versioning. Everything else the page and its element
types already carry. The kernel doesn't vanish; it **shrinks to the two things HTML
genuinely cannot hold — *who may see what*, and *what was true before*** — and stops needing
the world reborn as atoms before it can govern it. It meets HTML where HTML already is.

---

## What this buys, if it's true

- **Zero-migration adoption.** You don't import your data into Atomic. You point Atomic at
  your data. Any semantic page becomes a governed, indexed, permissioned store without
  being rewritten — the same way you don't rewrite a site to put a search index on it.
- **One substrate, already universal.** HTML is the most widely produced structured format
  on earth. Every CMS, every framework, every hand-edited page emits it. "Everything is an
  atom" becomes "everything already is one — it's been called an element this whole time."
- **The UI problem dissolves.** Today the kernel *generates* HTML from atoms. If the store
  *is* HTML, there is nothing to generate; the store renders itself. The kernel's job
  shrinks from "produce the surface" to "decide what of the surface you may see." API and
  UI were already one in Atomic; here they're one because they're the same bytes.
- **The stylesheet was right all along.** "No classes, no ids, every rule targets a
  semantic element" stops being a house style and becomes the **architecture**. The CSS was
  already betting that structure carries meaning. This is that bet, taken all the way down.

---

## Where it strains (the case against)

A thought experiment owes its own rebuttal.

- **Validation needs a schema HTML won't give you.** A tag name is not a type. You still
  need the model atom, and you still need the kernel to refuse invalid writes — so you have
  not escaped having a kernel, only narrowed it. Fine, that was the point; but it means
  "just use HTML" is never the whole story.
- **Edges are weaker than `ref`.** `href="#id"` and `itemref` are intra-document. Atomic's
  refs cross the whole store with typed inverse edges and a path budget. To keep that, the
  kernel must maintain its own edge index *over* the documents — the markup alone can't
  express a graph that spans pages.
- **Trust boundary.** The instant governance leaves the document, the document can lie. If
  the HTML is the store and the grants are beside it, you must guarantee no one reads the
  raw file around the kernel. Atomic-as-format had one door; Atomic-beside-HTML has two, and
  must lock the back one. (This is also why grants must *never* be markup.)
- **Mutable DOM vs. append-only truth.** A document is a mutable present. Atomic's log is an
  immutable past. Reconciling "patch the element" with "never lose a version" is real work
  the format change does not do for you.
- **`lifecycle` is genuinely extra.** Versions, actors, soft-delete status — there is no
  honest HTML home for these. `data-*` is a junk drawer, not a contract. Some operational
  metadata simply has to live in the kernel's side-record, which means the element is never
  quite the *whole* atom.

None of these kill the idea. They locate it: **HTML can be the data plane; the kernel stays
the control plane.** The experiment isn't "delete the kernel." It's "the kernel was never
the record format — it was always the index, the permits, and the logic, and those don't
need us to own the data."

---

## The one-line version

> Atomic bet that everything is an atom. The page next to us was already made of them.
> What if we stopped serializing a DOM we were going to render anyway, kept only the three
> things the browser can't do — **index, permission, logic** — and pointed that tiny kernel
> at whatever HTML the world already wrote?

That is the whole "what if." Not *atoms or HTML*. **Atoms were HTML with the governance
folded in — so fold the governance back out, and let the kernel be the minimal thing that
lives beside the document instead of the large thing that has to become it.**

---

# What If, part two — just a UI on SQLite

The first experiment pushed *outward*: HTML is the most universal structured format, so
borrow it. This one pushes the other way — *downward, toward the most proven engine* — and
asks a blunter question:

**What if Atomic is just a thin UI over SQLite, and the kernel is mostly reinventing a
database that already exists?**

Because look at what `atomic.mjs` actually hand-rolls. Then look at the column on the right.

| Atomic concept                          | SQLite already ships it                                  |
|-----------------------------------------|---------------------------------------------------------|
| Model = a type's fields                 | `CREATE TABLE` — columns *are* fields                   |
| Validation (kind, `required`, `unique`) | `CHECK`, `NOT NULL`, `UNIQUE` constraints               |
| `attr` (open value bag)                 | the `JSON1` extension — `json_extract`, `->>`           |
| Index (stored query / constraint)       | `CREATE INDEX`, `CREATE VIEW`                            |
| `manifest` full-text search             | `FTS5` — a full-text engine, not a `LIKE` scan          |
| `ref` / typed edges                     | `FOREIGN KEY` + a join table for inverse edges          |
| Hooks on create/update/delete           | `TRIGGER` — fires on exactly those, in the engine       |
| Optimistic concurrency (`version`)      | a `version` column + `WHERE version = ?`                |
| Append-only log                         | an insert-only table, or the WAL itself                 |
| Durable persistence, replayed on boot   | **the file.** WAL, crash recovery, fsync — decades-hard |
| Path traversal with a budget            | recursive CTEs (`WITH RECURSIVE`)                        |

Atomic's persistence is per-tenant NDJSON replayed into memory on boot. That is a write-
ahead log and a recovery routine — the two hardest, most bug-prone things in a storage
engine — rebuilt by hand. SQLite has spent twenty-five years and a famously exhaustive test
suite getting exactly that right. The NDJSON store is, in this light, a worse SQLite.

So the same move as before: subtract everything SQLite already does, and see what's left.

## What SQLite cannot do — and that's the whole kernel again

Run the subtraction and the *identical three survivors* fall out — which is the tell that
they were always the real product:

1. **Permissions.** SQLite has none. It is a file; whoever can `open()` it has every row and
   every column. There is no actor, no grant, no per-attribute redaction, no
   `getStore(actor)` that hides `email` from anonymous and shows it to `atom://joey`. Row-
   and column-level access scoped to a token is **exactly** what a raw database lacks, and
   exactly what Atomic's `permits` model is.

2. **The generated surface.** SQLite gives you SQL, not a screen. Atomic reads the schema
   and *renders* it — sortable tables, model-driven create forms (embed → nested table,
   list → repeater, ref → autocomplete), backlink maps, a nav built from models and
   indexes. "API and UI are one, both from the schema" is not a database feature. It's the
   layer above.

3. **Capabilities.** A SQLite `TRIGGER` runs with the connection's authority; it cannot run
   *under its own grants while the caller holds none*. Atomic's hook-as-capability — the
   census geocoder that writes a district atom the caller could never write directly — is an
   authorization model, not a storage one. SQLite has nowhere to put it.

Permission, surface, capability. **Same kernel.** The HTML experiment and the SQLite
experiment, coming from opposite ends, converge on the identical conclusion: *the value was
never the place the bytes sit.* It was the governance and the generated face over them.

## The shape this takes

```
            ┌───────────────────────────────────────────┐
            │  kernel: control plane (the actual product)│
   actor →  │   • permits → row/column redaction per tok │  → governed view
   request  │   • schema → generated UI + API surface    │
            │   • hooks  → capabilities under own grants  │  ← validated writes
            └───────────────────┬───────────────────────┘
                                │  plain SQL
                        ┌───────▼────────┐
                        │  SQLite (data) │  tables · CHECK · FK · FTS5
                        │  WAL · recovery│  triggers · JSON1 · CTEs
                        └────────────────┘
```

The atom doesn't even have to disappear from the *interface* — `{ id, model, manifest,
attr, lifecycle }` can stay the conceptual record the UI and API speak in. It just stops
being a thing the kernel *persists by hand* and becomes a **row**: `id` is the primary key,
`model` a foreign key to the models table, `manifest` an `FTS5`-indexed column, `attr` a
`JSON` column, `lifecycle` a handful of managed columns. Same vocabulary, none of the
hand-rolled engine underneath it.

## Where it strains (the case against)

- **You inherit SQL's shape.** Atomic's flat, uniform "everything is one record type"
  buys a real thing — the schema is itself data, models are atoms, you can query the
  type system with the same tools you query the data. On SQLite, models-as-rows is a
  convention you maintain *against* the grain of `CREATE TABLE`, not something the engine
  blesses. The self-describing property gets harder, not easier.
- **`attr` as a JSON column is a soft schema.** You get JSON1, but `CHECK` constraints over
  `json_extract` are clumsy, and you lose per-field typing unless the kernel re-validates on
  the way in — so the validation layer doesn't actually leave, it just moves above SQLite.
- **Permissions still aren't in the engine.** SQLite won't enforce a single grant. *Every*
  read and write must funnel through the kernel's one seam; the instant anything opens the
  file directly, the whole permission model is void — the same two-door trust problem the
  HTML version had, in a different file.
- **Concurrency model.** One writer at a time (WAL helps, doesn't erase it). For a single-
  box, single-operator substrate that's a non-issue; it's worth naming before anyone assumes
  it scales horizontally for free.
- **You trade a dependency for a foundation.** Atomic's headline virtue is *dependency-
  free, single file, Node ≥ 18, nothing to install*. Adopting SQLite spends that. The
  honest question is whether "zero dependencies" was a principle or a constraint — whether
  it's worth hand-maintaining a storage engine to keep the install story pristine.

## The one-line version

> The HTML experiment said *the data plane already exists as markup.* This one says *the
> data plane already exists as a database* — and both land in the same place: subtract what
> the substrate already does and what remains is **permissions, a generated surface, and
> capabilities.** That residue is Atomic. The store underneath it — NDJSON, a `.sqlite`
> file, or a semantic document — was always swappable. **The kernel was never the
> storage. It was the governance and the face. Pick whichever floor is most proven and put
> the same small kernel on top.**

---

# What If, part three — storage is a port, not the product

Parts one and two each picked a substrate and asked "could this replace the kernel?" Both
answers came back the same: no, because subtracting what the substrate already does leaves
the *identical* residue — **permissions, a generated surface, capabilities.** Part three is
the conclusion that residue forces:

**Stop asking which store to be. The store is a port behind the kernel. The kernel is the
product.**

## The question that settles it: does the substrate have grants?

Run the one test that actually discriminates. Not "can it persist," not "can it index" —
*can it say who may read this, and who may write that.*

| Substrate          | Stores data | Indexes | **Has grants?**                                   |
|--------------------|:-----------:|:-------:|---------------------------------------------------|
| NDJSON log (today) |     yes     |  hand-rolled | **no** — a file; whoever reads it has all of it  |
| The DOM / HTML     |     yes     |  `querySelector` | **no** — renders everything to everyone     |
| SQLite             |     yes     |  excellent | **no** — no `GRANT`, no roles, no row/col security |
| Postgres           |     yes     |  excellent | *partial* — roles + RLS, but not per-actor redaction of arbitrary fields the way `permits` does |

Every floor has storage. Every floor has *some* answer for indexing. **Not one of them has
actor-scoped, per-attribute grants.** SQLite is the sharpest case: it isn't even a server,
so there's no principal to grant *to* — whoever can `open()` the file holds every row and
every column, and the only access control is the OS permission bits on the file. Its
authorizer callback is the closest thing, and all it gives you is *a place to bolt your own
policy* — i.e., a place to put the kernel. The substrate hands you the interception point;
**you** still have to be the grant model.

That's the whole finding. The thing no substrate provides is the thing Atomic *is*.

## So: storage is a port

If the differentiator lives entirely above the store, then the store should be a **port** —
one narrow seam the kernel talks through, with interchangeable backends underneath. Atomic
already has the seam: every read funnels through `getStore(actor)` and every write through
the validate→permit→hook→log path. Nothing above that seam knows or cares where bytes land.

```
        kernel (the product — never changes)
        ┌──────────────────────────────────────────┐
        │  permits · generated surface · hooks · log │
        └───────────────────┬──────────────────────┘
                            │  Store port:
                            │    read(query, actor) → atoms
                            │    write(atom, actor) → atom
                            │    watch(model, cb)
              ┌─────────────┼─────────────┐
              ▼             ▼             ▼
        NDJSON log     SQLite log     DOM / docs
        (today)        (Fork A)       (part one)
```

A backend only has to do the dumb part: put an atom somewhere durable, get atoms back by
query, notify on change. It never sees a grant. **Grants and the log stay above the port,
in the kernel, always** — because, per the table, the port can't be trusted to hold them.

## The two forks, named once and for all

When the day comes to move off NDJSON, there are exactly two ways to use SQLite, and only
one is allowed:

- **Fork A — SQLite as a dumb atom log.** One table: `id, model, manifest, attr (JSON),
  lifecycle (JSON)`, plus an FTS5 index on `manifest`. Atoms stay uniform; schema stays
  data; the kernel doesn't change a line. You gain crash-safe durability and you stop being
  RAM-bound and rebuild-on-boot. You spend one thing: the "zero dependencies, single file"
  badge. **This is the sanctioned escape hatch.** It is a `Store` backend, nothing more.

- **Fork B — SQLite as relational tables, one per model.** Now a model is a `CREATE TABLE`,
  schema changes are migrations, and models can no longer be atoms. The self-describing
  thesis is dead, and what you've built is Supabase / PostgREST / Django-admin — mature
  tools that already exist, entered without the one thing that made you different.
  **Forbidden.** Not because it doesn't work, but because it trades the moat for a crowded
  field.

The tell that separates them: in Fork A the substrate never learns what a `contact` *is* —
it stores opaque rows and the kernel holds all meaning. In Fork B the substrate learns the
schema, and the moment it does, the kernel has handed away the thing it was for.

## The standing decision

1. **Keep the kernel as the product.** Permissions, generated surface, capabilities, the
   self-describing atom. None of it moves, ever, regardless of substrate.
2. **Treat storage as a port behind `getStore` / the write path.** No backend sees a grant.
3. **Stay on the NDJSON log while it's honest** — dependency-free, data fits in RAM, boot
   replay is fast. That's genuinely the right default *today*.
4. **The day it stops being honest** (replay slow, or data past memory), swap in **Fork A**.
   One new backend behind the existing port. The kernel never notices.
5. **Never Fork B.** The instant the store knows your schema, you've stopped being Atomic.

## The one-line version

> The substrate question has one discriminating test — *does it have grants?* — and every
> candidate fails it the same way. That failure is the proof: storage is a commodity port,
> grants-plus-log is the irreducible kernel, and the kernel is the whole product. So the
> answer to "should we just be a UI on SQLite" is **no — we should be the grant-and-surface
> kernel that can sit on SQLite, or NDJSON, or the DOM, and outlive whichever one we pick.**
