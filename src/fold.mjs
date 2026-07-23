import { createHash, randomUUID } from 'node:crypto';

const clone = value => structuredClone(value);
const now = () => new Date().toISOString();

const STRENGTH = Object.freeze({ definitive: 4, strong: 3, medium: 2, weak: 1 });
const DEFAULT_WEIGHTS = Object.freeze({ definitive: 1000, strong: 120, medium: 45, weak: 12 });

export class AtomicFoldError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'AtomicFoldError';
    this.details = details;
  }
}

export function createFoldEngine({ registry, store, normalizers = {}, policy = {} }) {
  if (!registry) throw new AtomicFoldError('Fold engine requires a model registry');
  if (!store) throw new AtomicFoldError('Fold engine requires a fold-capable store');

  const defaults = {
    autoMergeScore: policy.autoMergeScore ?? 120,
    reviewScore: policy.reviewScore ?? 45,
    requireStrongForAutoMerge: policy.requireStrongForAutoMerge ?? true
  };

  async function resolve(candidate, context = {}) {
    const model = registry.get(candidate.model);
    if (!model) throw new AtomicFoldError(`Unknown model "${candidate.model}"`);
    const normalized = normalizeCandidate(candidate, model, normalizers);
    const keys = identityKeys(normalized, model);
    const possible = await store.findByIdentityKeys(candidate.model, keys.map(key => key.hash));
    const matches = possible
      .map(atom => evaluateMatch(normalized, atom, model, keys, normalizers))
      .sort((a, b) => b.score - a.score || String(a.atom.id).localeCompare(String(b.atom.id)));
    const best = matches[0];
    const decision = decide(best, model.resolution ?? {}, defaults);
    return { candidate: normalized, keys, matches, best, decision, context };
  }

  async function fold(candidate, context = {}) {
    const resolution = await resolve(candidate, context);
    const observation = await store.recordObservation({
      observationId: context.observationId,
      candidateId: candidate.candidateId,
      model: candidate.model,
      attributes: clone(candidate.attributes ?? {}),
      normalized: clone(resolution.candidate.attributes),
      evidence: clone(candidate.evidence ?? []),
      confidence: candidate.confidence,
      provider: context.provider,
      input: context.input,
      createdAt: context.createdAt ?? now()
    });

    if (resolution.decision.action === 'merge') {
      const merged = await mergeInto(resolution.best.atom, resolution.candidate, observation, resolution, modelFor(candidate.model));
      return { ...resolution, observation, ...merged };
    }

    if (resolution.decision.action === 'review') {
      const canonical = await createCanonical(resolution.candidate, observation, modelFor(candidate.model));
      const review = await store.recordReview({
        id: `review://${randomUUID()}`,
        candidate: canonical.atom.id,
        possibleMatches: resolution.matches.map(match => ({ atom: match.atom.id, score: match.score, signals: match.signals, contradictions: match.contradictions })),
        reason: resolution.decision.reason,
        status: 'open',
        createdAt: now()
      });
      return { ...resolution, observation, ...canonical, review, action: 'review' };
    }

    const canonical = await createCanonical(resolution.candidate, observation, modelFor(candidate.model));
    return { ...resolution, observation, ...canonical, action: 'create' };
  }

  async function foldObservation(observation) {
    const results = [];
    for (const candidate of observation.candidates ?? []) {
      results.push(await fold(candidate, observation));
    }
    return results;
  }

  async function merge(sourceId, targetId, reason = 'manual') {
    const source = await store.get(sourceId);
    const target = await store.get(targetId);
    if (!source || !target) throw new AtomicFoldError('Manual merge requires existing source and target atoms', { sourceId, targetId });
    if (source.model !== target.model) throw new AtomicFoldError('Cannot merge atoms with different models', { source: source.model, target: target.model });
    const event = await store.recordMerge({
      id: `merge://${randomUUID()}`,
      source: source.id,
      target: target.id,
      reason,
      algorithm: 'atomic-fold@1',
      status: 'active',
      createdAt: now()
    });
    await store.redirect(source.id, target.id, event.id);
    return event;
  }

  async function split(mergeId, reason = 'manual correction') {
    const event = await store.getMerge(mergeId);
    if (!event || event.status !== 'active') throw new AtomicFoldError(`Active merge "${mergeId}" not found`);
    await store.removeRedirect(event.source, mergeId);
    return store.updateMerge(mergeId, { status: 'reversed', reversedAt: now(), reverseReason: reason });
  }

  function modelFor(name) { return registry.get(name); }

  async function createCanonical(candidate, observation, model) {
    const assertions = createAssertions(candidate, observation, model);
    const atom = await store.createCanonical({
      id: candidate.id ?? `atom://${candidate.model}-${randomUUID()}`,
      model: `atom://${candidate.model}`,
      attr: selectCanonical(assertions, model),
      lifecycle: { status: 'active', createdAt: now(), updatedAt: now() },
      identityKeys: identityKeys(candidate, model),
      assertions
    });
    return { atom, assertions, action: 'create' };
  }

  async function mergeInto(atom, candidate, observation, resolution, model) {
    const assertions = createAssertions(candidate, observation, model);
    const allAssertions = [...(atom.assertions ?? []), ...assertions];
    const updated = await store.updateCanonical(atom.id, {
      attr: selectCanonical(allAssertions, model),
      identityKeys: dedupeKeys([...(atom.identityKeys ?? []), ...identityKeys(candidate, model)]),
      assertions: allAssertions,
      lifecycle: { ...atom.lifecycle, updatedAt: now() }
    });
    const event = await store.recordMerge({
      id: `merge://${randomUUID()}`,
      source: observation.id,
      target: atom.id,
      reason: resolution.decision.reason,
      score: resolution.best.score,
      signals: resolution.best.signals,
      contradictions: resolution.best.contradictions,
      algorithm: 'atomic-fold@1',
      status: 'active',
      createdAt: now()
    });
    return { atom: updated, assertions, merge: event, action: 'merge' };
  }

  return { resolve, fold, foldObservation, merge, split, store };
}

export function normalizeCandidate(candidate, model, custom = {}) {
  const attributes = {};
  for (const [field, value] of Object.entries(candidate.attributes ?? {})) {
    const definition = model.attributes?.[field] ?? {};
    const normalizer = custom[field] ?? custom[definition.normalize] ?? builtInNormalizer(definition.normalize ?? definition.kind ?? field);
    attributes[field] = normalizer(value);
  }
  return { ...clone(candidate), attributes };
}

export function identityKeys(candidate, model) {
  const keys = [];
  for (const [index, rule] of (model.identity ?? []).entries()) {
    const fields = rule.fields ?? [];
    const values = fields.map(field => candidate.attributes?.[field]);
    if (!fields.length || values.some(value => isEmpty(value))) continue;
    const canonical = stableStringify(values);
    const name = rule.name ?? fields.join('+');
    keys.push({
      name,
      fields,
      strength: rule.strength ?? 'weak',
      value: canonical,
      hash: sha256(`${model.name}|${name}|${canonical}`),
      rule: index
    });
  }
  return keys;
}

export function evaluateMatch(candidate, atom, model, candidateKeys = identityKeys(candidate, model), custom = {}) {
  const existingCandidate = normalizeCandidate({ model: model.name, attributes: atom.attr ?? {} }, model, custom);
  const existingKeys = atom.identityKeys?.length ? atom.identityKeys : identityKeys(existingCandidate, model);
  const existingByHash = new Map(existingKeys.map(key => [key.hash, key]));
  const signals = [];
  const contradictions = [];
  let score = 0;
  let strongest = 'none';

  for (const key of candidateKeys) {
    const rule = (model.identity ?? [])[key.rule] ?? {};
    if (existingByHash.has(key.hash)) {
      const weight = rule.weight ?? DEFAULT_WEIGHTS[key.strength] ?? 0;
      score += weight;
      signals.push({ type: 'identity-key', key: key.name, strength: key.strength, weight });
      if ((STRENGTH[key.strength] ?? 0) > (STRENGTH[strongest] ?? 0)) strongest = key.strength;
      continue;
    }
    if (rule.exclusive && key.fields.every(field => !isEmpty(existingCandidate.attributes[field]))) {
      const penalty = Math.abs(rule.contradictionWeight ?? (key.strength === 'definitive' ? 10000 : DEFAULT_WEIGHTS[key.strength] * 2));
      score -= penalty;
      contradictions.push({ type: 'exclusive-key-conflict', key: key.name, strength: key.strength, penalty });
    }
  }

  for (const rule of model.resolution?.signals ?? []) {
    const left = candidate.attributes?.[rule.field];
    const right = existingCandidate.attributes?.[rule.field];
    if (isEmpty(left) || isEmpty(right)) continue;
    const matched = compare(left, right, rule.compare ?? 'exact');
    if (matched) {
      score += rule.weight ?? 0;
      signals.push({ type: 'field', field: rule.field, compare: rule.compare ?? 'exact', weight: rule.weight ?? 0 });
    } else if (rule.contradiction) {
      const penalty = Math.abs(rule.contradiction);
      score -= penalty;
      contradictions.push({ type: 'field-conflict', field: rule.field, penalty });
    }
  }

  return {
    atom: clone(atom),
    score,
    strongest,
    signals,
    contradictions,
    definitiveMatch: signals.some(signal => signal.strength === 'definitive'),
    definitiveContradiction: contradictions.some(item => item.strength === 'definitive' || item.penalty >= 1000)
  };
}

export function decide(match, resolution = {}, defaults = {}) {
  if (!match) return { action: 'create', reason: 'no plausible identity match' };
  if (match.definitiveContradiction) return { action: 'review', reason: 'definitive identity contradiction' };
  if (match.definitiveMatch) return { action: 'merge', reason: 'definitive identity key matched' };
  const autoMergeScore = resolution.thresholds?.autoMerge ?? defaults.autoMergeScore ?? 120;
  const reviewScore = resolution.thresholds?.review ?? defaults.reviewScore ?? 45;
  const requireStrong = resolution.requireStrongForAutoMerge ?? defaults.requireStrongForAutoMerge ?? true;
  const hasStrong = (STRENGTH[match.strongest] ?? 0) >= STRENGTH.strong;
  if (match.score >= autoMergeScore && (!requireStrong || hasStrong)) return { action: 'merge', reason: `match score ${match.score} met auto-merge policy` };
  if (match.score >= reviewScore) return { action: 'review', reason: `match score ${match.score} requires review` };
  return { action: 'create', reason: `best match score ${match.score} was below review threshold` };
}

export function createMemoryFoldStore() {
  const atoms = new Map();
  const observations = new Map();
  const reviews = new Map();
  const merges = new Map();
  const redirects = new Map();
  const keyIndex = new Map();

  const indexAtom = atom => {
    for (const key of atom.identityKeys ?? []) {
      if (!keyIndex.has(key.hash)) keyIndex.set(key.hash, new Set());
      keyIndex.get(key.hash).add(atom.id);
    }
  };
  const unindexAtom = atom => {
    for (const key of atom.identityKeys ?? []) keyIndex.get(key.hash)?.delete(atom.id);
  };

  return {
    async findByIdentityKeys(model, hashes) {
      const ids = new Set();
      for (const hash of hashes) for (const id of keyIndex.get(hash) ?? []) ids.add(id);
      return [...ids].map(id => atoms.get(id)).filter(atom => atom?.model === `atom://${model}` && atom.lifecycle?.status === 'active').map(clone);
    },
    async createCanonical(atom) { atoms.set(atom.id, clone(atom)); indexAtom(atom); return clone(atom); },
    async updateCanonical(id, patch) {
      const current = atoms.get(id);
      if (!current) throw new AtomicFoldError(`Atom "${id}" not found`);
      unindexAtom(current);
      const updated = { ...current, ...clone(patch) };
      atoms.set(id, updated);
      indexAtom(updated);
      return clone(updated);
    },
    async recordObservation(observation) {
      const item = { id: `observation://${observation.observationId ?? randomUUID()}/${observation.candidateId ?? randomUUID()}`, ...clone(observation) };
      observations.set(item.id, item);
      return clone(item);
    },
    async recordReview(review) { reviews.set(review.id, clone(review)); return clone(review); },
    async recordMerge(merge) { merges.set(merge.id, clone(merge)); return clone(merge); },
    async getMerge(id) { return merges.has(id) ? clone(merges.get(id)) : undefined; },
    async updateMerge(id, patch) { const next = { ...merges.get(id), ...clone(patch) }; merges.set(id, next); return clone(next); },
    async redirect(source, target, merge) { redirects.set(source, { target, merge }); const atom = atoms.get(source); if (atom) atoms.set(source, { ...atom, lifecycle: { ...atom.lifecycle, status: 'merged' } }); },
    async removeRedirect(source, merge) { const current = redirects.get(source); if (current?.merge === merge) redirects.delete(source); const atom = atoms.get(source); if (atom) atoms.set(source, { ...atom, lifecycle: { ...atom.lifecycle, status: 'active' } }); },
    async get(id) {
      const redirect = redirects.get(id);
      return clone(atoms.get(redirect?.target ?? id));
    },
    list() { return [...atoms.values()].map(clone); },
    listObservations() { return [...observations.values()].map(clone); },
    listReviews() { return [...reviews.values()].map(clone); },
    listMerges() { return [...merges.values()].map(clone); }
  };
}

function createAssertions(candidate, observation, model) {
  return Object.entries(candidate.attributes ?? {}).map(([field, value]) => ({
    id: `assertion://${randomUUID()}`,
    subjectModel: candidate.model,
    field,
    value: clone(value),
    observation: observation.id,
    confidence: candidate.confidence ?? 0,
    sourcePriority: model.attributes?.[field]?.merge?.sourcePriority?.[observation.provider] ?? 0,
    assertedAt: observation.createdAt ?? now()
  }));
}

function selectCanonical(assertions, model) {
  const grouped = new Map();
  for (const assertion of assertions) {
    if (!grouped.has(assertion.field)) grouped.set(assertion.field, []);
    grouped.get(assertion.field).push(assertion);
  }
  const attr = {};
  for (const [field, values] of grouped) {
    const strategy = model.attributes?.[field]?.merge?.strategy ?? 'highest-confidence';
    attr[field] = resolveField(values, strategy);
  }
  return attr;
}

function resolveField(assertions, strategy) {
  if (strategy === 'union') {
    const flattened = assertions.flatMap(item => Array.isArray(item.value) ? item.value : [item.value]);
    return [...new Map(flattened.map(value => [stableStringify(value), value])).values()];
  }
  if (strategy === 'most-recent') return clone([...assertions].sort((a, b) => String(b.assertedAt).localeCompare(String(a.assertedAt)))[0].value);
  if (strategy === 'source-priority') return clone([...assertions].sort((a, b) => b.sourcePriority - a.sourcePriority || b.confidence - a.confidence)[0].value);
  if (strategy === 'never-overwrite') return clone(assertions[0].value);
  return clone([...assertions].sort((a, b) => b.confidence - a.confidence || b.sourcePriority - a.sourcePriority || String(b.assertedAt).localeCompare(String(a.assertedAt)))[0].value);
}

function builtInNormalizer(kind) {
  if (kind === 'email') return value => String(value).trim().toLowerCase();
  if (kind === 'phone') return value => normalizePhone(value);
  if (kind === 'name') return value => normalizeText(value).replace(/\b(jr|sr|ii|iii|iv)\.?$/i, '').trim();
  if (kind === 'datetime') return value => { const date = new Date(value); return Number.isNaN(date.valueOf()) ? value : date.toISOString(); };
  if (kind === 'map') return value => sortObject(value);
  if (kind === 'list') return value => Array.isArray(value) ? value.map(item => typeof item === 'string' ? normalizeText(item) : item) : value;
  if (kind === 'text' || kind === 'longtext' || kind === 'address') return value => normalizeText(value);
  return value => clone(value);
}

function normalizeText(value) { return String(value).normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase(); }
function normalizePhone(value) { const digits = String(value).replace(/\D/g, ''); return digits.length === 10 ? `+1${digits}` : digits.startsWith('00') ? `+${digits.slice(2)}` : digits.startsWith('+') ? digits : `+${digits}`; }
function compare(a, b, mode) {
  if (mode === 'exact') return stableStringify(a) === stableStringify(b);
  if (mode === 'contains') return String(a).includes(String(b)) || String(b).includes(String(a));
  if (mode === 'token-set') return tokenSimilarity(a, b) >= 0.8;
  return false;
}
function tokenSimilarity(a, b) {
  const left = new Set(normalizeText(a).split(/\W+/).filter(Boolean));
  const right = new Set(normalizeText(b).split(/\W+/).filter(Boolean));
  const intersection = [...left].filter(token => right.has(token)).length;
  const union = new Set([...left, ...right]).size;
  return union ? intersection / union : 0;
}
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function sortObject(value) { if (!value || typeof value !== 'object' || Array.isArray(value)) return value; return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sortObject(item)])); }
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function isEmpty(value) { return value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0) || (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0); }
function dedupeKeys(keys) { return [...new Map(keys.map(key => [key.hash, key])).values()]; }
