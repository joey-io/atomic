import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import coreModelPack from './models/core.mjs';

const clone = value => structuredClone(value);

export class AtomicDefinitionError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'AtomicDefinitionError';
    this.details = details;
  }
}

export class ModelRegistry {
  #models = new Map();
  #sources = new Map();

  constructor({ core = true } = {}) {
    if (core) this.load(coreModelPack, { source: 'core', override: true });
  }

  load(pack, { source = pack?.name ?? 'anonymous', override = true } = {}) {
    validatePack(pack);
    for (const model of pack.models) {
      if (this.#models.has(model.name) && !override) {
        throw new AtomicDefinitionError(`Model "${model.name}" is already loaded`, { source });
      }
      this.#models.set(model.name, Object.freeze(clone(model)));
      this.#sources.set(model.name, source);
    }
    this.#assertInheritance();
    return this;
  }

  get(name, { resolved = true } = {}) {
    const model = this.#models.get(name);
    if (!model) return undefined;
    return resolved ? this.#resolve(name, new Set()) : clone(model);
  }

  has(name) { return this.#models.has(name); }

  list({ resolved = true } = {}) {
    return [...this.#models.keys()].sort().map(name => this.get(name, { resolved }));
  }

  source(name) { return this.#sources.get(name); }

  snapshot() {
    return { atomic: 1, name: 'atomic:resolved', version: '1.0.0', models: this.list() };
  }

  #resolve(name, stack) {
    if (stack.has(name)) throw new AtomicDefinitionError(`Circular model inheritance: ${[...stack, name].join(' -> ')}`);
    const model = this.#models.get(name);
    if (!model) throw new AtomicDefinitionError(`Unknown model "${name}"`);
    if (!model.extends) return clone(model);
    stack.add(name);
    const parent = this.#resolve(model.extends, stack);
    stack.delete(name);
    return mergeModel(parent, model);
  }

  #assertInheritance() {
    for (const name of this.#models.keys()) this.#resolve(name, new Set());
  }
}

export async function loadModelSource(source) {
  if (typeof source === 'object' && source !== null) return source.default ?? source;
  if (typeof source !== 'string') throw new AtomicDefinitionError('Model source must be a pack object or module/path string');
  const specifier = source.startsWith('.') || source.startsWith('/')
    ? pathToFileURL(path.resolve(source)).href
    : source;
  const imported = await import(specifier);
  return imported.default ?? imported.modelPack ?? imported;
}

export async function autoloadModelDirectory(directory, registry, { override = true } = {}) {
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); }
  catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const loaded = [];
  for (const entry of entries.filter(e => e.isFile() && /\.(mjs|js|json)$/i.test(e.name)).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(directory, entry.name);
    const pack = entry.name.endsWith('.json')
      ? JSON.parse(await fs.readFile(file, 'utf8'))
      : await loadModelSource(file);
    registry.load(pack, { source: file, override });
    loaded.push(file);
  }
  return loaded;
}

export async function createAtomic(options = {}) {
  const registry = new ModelRegistry({ core: options.core !== false });
  for (const source of options.models ?? []) {
    registry.load(await loadModelSource(source), { source: typeof source === 'string' ? source : source.name, override: true });
  }
  const modelDirectory = options.modelDirectory === false ? null : path.resolve(options.modelDirectory ?? 'atomic/models');
  const autoloaded = modelDirectory ? await autoloadModelDirectory(modelDirectory, registry, { override: true }) : [];
  const provider = options.provider ?? createHeuristicProvider();
  const sink = options.sink ?? createMemorySink();
  const thresholds = {
    persist: options.thresholds?.persist ?? 0.9,
    review: options.thresholds?.review ?? 0.65
  };

  async function observe(input, observeOptions = {}) {
    const normalized = await normalizeInput(input);
    const request = {
      id: randomUUID(),
      input: normalized,
      models: registry.list(),
      instructions: observeOptions.instructions,
      context: observeOptions.context ?? {},
      thresholds
    };
    const raw = await provider.observe(request);
    return normalizeObservation(raw, request);
  }

  async function parse(input, parseOptions = {}) {
    const observation = await observe(input, parseOptions);
    const accepted = observation.candidates.filter(candidate => {
      if (parseOptions.accept === 'all') return candidate.confidence >= thresholds.review;
      if (typeof parseOptions.accept === 'function') return parseOptions.accept(candidate, observation);
      return candidate.confidence >= thresholds.persist;
    });
    const review = observation.candidates.filter(candidate => candidate.confidence >= thresholds.review && !accepted.includes(candidate));
    const rejected = observation.candidates.filter(candidate => candidate.confidence < thresholds.review);
    const persisted = parseOptions.persist === false ? [] : await sink.persist({ ...observation, candidates: accepted });
    return { ...observation, accepted, review, rejected, persisted };
  }

  async function* parseStream(input, parseOptions = {}) {
    yield { type: 'parse.started' };
    const observation = await observe(input, parseOptions);
    yield { type: 'observation.completed', data: observation };
    for (const candidate of observation.candidates) yield { type: 'candidate.detected', data: candidate };
    const result = await parse(input, parseOptions);
    for (const atom of result.persisted) yield { type: 'atom.persisted', data: atom };
    yield { type: 'parse.completed', data: result };
  }

  return {
    models: registry,
    observe,
    parse,
    parseStream,
    sink,
    provider,
    autoloaded,
    config: { thresholds, modelDirectory }
  };
}

export function defineModelPack(pack) {
  validatePack(pack);
  return Object.freeze(clone(pack));
}

export function createMemorySink() {
  const atoms = new Map();
  return {
    async persist(observation) {
      const persisted = [];
      for (const candidate of observation.candidates) {
        const id = candidate.id ?? `atom://${candidate.model}-${randomUUID()}`;
        const atom = {
          id,
          model: `atom://${candidate.model}`,
          attr: clone(candidate.attributes ?? {}),
          lifecycle: { status: 'active', createdAt: new Date().toISOString() },
          evidence: clone(candidate.evidence ?? []),
          confidence: candidate.confidence
        };
        atoms.set(id, atom);
        persisted.push(clone(atom));
      }
      return persisted;
    },
    get(id) { return atoms.has(id) ? clone(atoms.get(id)) : undefined; },
    list() { return [...atoms.values()].map(clone); }
  };
}

export function createHeuristicProvider() {
  return {
    name: 'atomic:heuristic',
    async observe(request) {
      const text = request.input.text ?? '';
      const candidates = [];
      const evidence = excerpt => [{ source: request.input.name, excerpt }];
      const emails = [...text.matchAll(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi)];
      for (const match of emails) {
        const before = text.slice(Math.max(0, match.index - 80), match.index);
        const name = before.match(/([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})[^A-Za-z]*$/)?.[1];
        candidates.push({ model: 'person', attributes: { name: name ?? match[0], email: match[0] }, confidence: name ? 0.94 : 0.76, evidence: evidence(match[0]) });
      }
      const dates = [...text.matchAll(/\b(20\d{2}-\d{2}-\d{2}|(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},\s+20\d{2})\b/gi)];
      for (const match of dates) {
        const sentence = text.slice(text.lastIndexOf('.', match.index - 1) + 1, text.indexOf('.', match.index) === -1 ? text.length : text.indexOf('.', match.index) + 1).trim();
        if (sentence) candidates.push({ model: 'event', attributes: { name: sentence.slice(0, 160), startsAt: parseDate(match[0]) }, confidence: 0.7, evidence: evidence(sentence) });
      }
      return { candidates, relationships: [], warnings: ['The built-in heuristic provider is deterministic and intentionally conservative. Configure an LLM or domain provider for semantic extraction.'] };
    }
  };
}

function validatePack(pack) {
  if (!pack || typeof pack !== 'object') throw new AtomicDefinitionError('A model pack must be an object');
  if (pack.atomic !== 1) throw new AtomicDefinitionError('Unsupported or missing model-pack format version; expected atomic: 1');
  if (!pack.name || typeof pack.name !== 'string') throw new AtomicDefinitionError('A model pack requires a string name');
  if (!Array.isArray(pack.models)) throw new AtomicDefinitionError('A model pack requires a models array');
  const names = new Set();
  for (const model of pack.models) {
    if (!model?.name || !/^[a-z][a-z0-9-]*$/.test(model.name)) throw new AtomicDefinitionError(`Invalid model name "${model?.name}"`);
    if (names.has(model.name)) throw new AtomicDefinitionError(`Duplicate model "${model.name}" in pack ${pack.name}`);
    names.add(model.name);
    if (!model.description) throw new AtomicDefinitionError(`Model "${model.name}" requires a description`);
    if (model.attributes && typeof model.attributes !== 'object') throw new AtomicDefinitionError(`Model "${model.name}" attributes must be an object`);
  }
  return true;
}

function mergeModel(parent, child) {
  return {
    ...clone(parent),
    ...clone(child),
    attributes: { ...(parent.attributes ?? {}), ...(child.attributes ?? {}) },
    relationships: { ...(parent.relationships ?? {}), ...(child.relationships ?? {}) },
    observe: { ...(parent.observe ?? {}), ...(child.observe ?? {}) },
    presentation: { ...(parent.presentation ?? {}), ...(child.presentation ?? {}) },
    identity: child.identity ?? parent.identity ?? []
  };
}

async function normalizeInput(input) {
  if (typeof input === 'string') return { name: 'inline.txt', contentType: 'text/plain', text: input };
  if (Buffer.isBuffer(input)) return { name: 'buffer.bin', contentType: 'application/octet-stream', bytes: input };
  if (!input || typeof input !== 'object') throw new TypeError('Atomic input must be a string, Buffer, or input object');
  if (input.path) {
    const bytes = await fs.readFile(input.path);
    const contentType = input.contentType ?? contentTypeFor(input.path);
    return { ...input, name: input.name ?? path.basename(input.path), contentType, ...(contentType.startsWith('text/') || contentType === 'application/json' ? { text: bytes.toString('utf8') } : { bytes }) };
  }
  if (typeof input.text === 'string') return { name: input.name ?? 'inline.txt', contentType: input.contentType ?? 'text/plain', ...input };
  if (input.bytes) return { name: input.name ?? 'input.bin', contentType: input.contentType ?? 'application/octet-stream', ...input };
  throw new TypeError('Input object requires text, bytes, or path');
}

function normalizeObservation(raw, request) {
  const candidates = (raw?.candidates ?? []).map((candidate, index) => {
    if (!request.models.some(model => model.name === candidate.model)) throw new AtomicDefinitionError(`Provider emitted unknown model "${candidate.model}"`);
    return {
      id: candidate.id,
      candidateId: candidate.candidateId ?? `${request.id}:${index + 1}`,
      model: candidate.model,
      attributes: candidate.attributes ?? {},
      confidence: Math.max(0, Math.min(1, Number(candidate.confidence ?? 0))),
      evidence: candidate.evidence ?? [],
      rationale: candidate.rationale
    };
  });
  return {
    observationId: request.id,
    input: { name: request.input.name, contentType: request.input.contentType },
    candidates,
    relationships: raw?.relationships ?? [],
    warnings: raw?.warnings ?? [],
    provider: raw?.provider ?? 'unknown',
    createdAt: new Date().toISOString()
  };
}

function contentTypeFor(file) {
  const ext = path.extname(file).toLowerCase();
  return ({ '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json', '.csv': 'text/csv' })[ext] ?? 'application/octet-stream';
}

function parseDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
}

export { coreModelPack } from './models/core.mjs';
