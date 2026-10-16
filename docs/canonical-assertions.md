# Canonical assertion model (experimental)

`src/models/assertions.mjs` defines an optional `atom://assertion` model
for integration with Atomic Reason's read-only bridge. Load the pack explicitly
in Atomic's model registry. This is a data schema, **not** an acceptance or
review policy: untrusted agents must not be allowed to write accepted assertions.
Atomic Reason's legacy writer still treats direct reads as accepted; it is not
safe for unsupervised truth claims.

Canonical source of truth remains the transactional Atomic store. The bridge
reads an authorized in-process snapshot and does not yet provide an integrated
HTTP client, write transactions, evidence validation, or durable audit workflow.
