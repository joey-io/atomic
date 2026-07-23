import { AtomicDefinitionError } from './index.mjs';

const clone = value => structuredClone(value);

export function buildExtractionContract(models, { modelNames } = {}) {
  const selected = modelNames?.length ? models.filter(model => modelNames.includes(model.name)) : models;
  return {
    version: 1,
    rules: [
      'Extract only facts supported by the supplied source.',
      'Do not guess missing attributes.',
      'Prefer the most specific matching model.',
      'Return one candidate per distinct entity or event mention.',
      'Every candidate must include evidence copied exactly from the source.',
      'Confidence is a number from 0 to 1 representing evidentiary certainty, not importance.',
      'Relationships must refer to candidateId values returned in the same response.'
    ],
    models: selected.map(model => ({
      name: model.name,
      description: model.description,
      extends: model.extends,
      attributes: Object.fromEntries(Object.entries(model.attributes ?? {}).map(([name, definition]) => [name, attributeContract(definition)])),
      positiveExamples: model.observe?.positive ?? [],
      negativeExamples: model.observe?.negative ?? [],
      instructions: model.observe?.instructions,
      relationships: model.relationships ?? {}
    })),
    output: {
      candidates: [{ candidateId: 'unique string', model: 'declared model name', attributes: 'declared attributes only', confidence: 'number 0..1', evidence: [{ excerpt: 'exact source text', start: 'optional integer', end: 'optional integer', page: 'optional integer' }], rationale: 'brief source-grounded explanation' }],
      relationships: [{ from: 'candidateId', type: 'relationship name', to: 'candidateId', confidence: 'number 0..1', evidence: [{ excerpt: 'exact source text' }] }],
      warnings: ['string']
    }
  };
}

export function createSemanticProvider(options = {}) {
  if (typeof options.complete !== 'function') throw new TypeError('createSemanticProvider requires complete({ system, prompt, contract, request })');
  return {
    name: options.name ?? 'atomic:semantic',
    async observe(request) {
      const contract = buildExtractionContract(request.models, { modelNames: options.modelNames });
      const text = String(request.input.text ?? '').slice(0, options.maxChars ?? 120_000);
      if (!text.trim()) return { provider: options.name ?? 'atomic:semantic', candidates: [], relationships: [], warnings: ['No extractable text was supplied.'] };
      const system = 'You are Atomic’s evidence extraction engine. Follow the contract exactly and return only one JSON object.';
      const prompt = ['EXTRACTION CONTRACT', JSON.stringify(contract, null, 2), request.instructions ? `\nADDITIONAL INSTRUCTIONS\n${request.instructions}` : '', `\nSOURCE NAME\n${request.input.name}`, `\nSOURCE TEXT\n${text}`].join('\n');
      const raw = await options.complete({ system, prompt, contract, request });
      const parsed = parseProviderResult(raw);
      const validated = validateSemanticResult(parsed, request, { strict: options.strict !== false });
      return { ...validated, provider: options.name ?? 'atomic:semantic' };
    }
  };
}

export function createOpenAICompatibleProvider(options = {}) {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required');
  const endpoint = (options.endpoint ?? 'https://api.openai.com/v1').replace(/\/$/, '');
  const model = options.model ?? 'gpt-4.1-mini';
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
  return createSemanticProvider({
    ...options,
    name: options.name ?? 'atomic:openai-compatible',
    async complete({ system, prompt }) {
      const response = await fetchImpl(`${endpoint}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}), ...(options.headers ?? {}) },
        body: JSON.stringify({ model, temperature: options.temperature ?? 0, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }], response_format: options.responseFormat ?? { type: 'json_object' } }),
        signal: options.signal
      });
      if (!response.ok) throw new Error(`Semantic provider request failed (${response.status}): ${await response.text()}`);
      const payload = await response.json();
      return payload?.choices?.[0]?.message?.content ?? payload?.output_text ?? payload;
    }
  });
}

export function validateSemanticResult(result, request, { strict = true } = {}) {
  const models = new Map(request.models.map(model => [model.name, model]));
  const ids = new Set();
  const warnings = [...(Array.isArray(result?.warnings) ? result.warnings.map(String) : [])];
  const candidates = [];
  for (const [index, value] of (Array.isArray(result?.candidates) ? result.candidates : []).entries()) {
    try {
      const model = models.get(value?.model);
      if (!model) throw new AtomicDefinitionError(`Semantic provider emitted unknown model "${value?.model}"`);
      const candidateId = String(value.candidateId ?? `semantic:${index + 1}`);
      if (ids.has(candidateId)) throw new AtomicDefinitionError(`Duplicate semantic candidateId "${candidateId}"`);
      ids.add(candidateId);
      const attributes = validateAttributes(value.attributes ?? {}, model, strict);
      for (const [name, definition] of Object.entries(model.attributes ?? {})) if (definition.required && isEmpty(attributes[name])) throw new AtomicDefinitionError(`Candidate ${candidateId} is missing required attribute "${name}"`);
      const evidence = validateEvidence(value.evidence, request.input.text ?? '', strict);
      if (!evidence.length && strict) throw new AtomicDefinitionError(`Candidate ${candidateId} requires source evidence`);
      candidates.push({ candidateId, model: model.name, attributes, confidence: clamp(value.confidence), evidence, rationale: typeof value.rationale === 'string' ? value.rationale : undefined });
    } catch (error) {
      if (strict) throw error;
      warnings.push(error.message);
    }
  }
  const relationships = [];
  for (const value of Array.isArray(result?.relationships) ? result.relationships : []) {
    if (!ids.has(String(value?.from)) || !ids.has(String(value?.to))) {
      const message = `Relationship references an unknown candidate: ${value?.from} -> ${value?.to}`;
      if (strict) throw new AtomicDefinitionError(message);
      warnings.push(message);
      continue;
    }
    relationships.push({ from: String(value.from), type: String(value.type ?? 'related-to'), to: String(value.to), confidence: clamp(value.confidence), evidence: validateEvidence(value.evidence, request.input.text ?? '', strict) });
  }
  return { candidates, relationships, warnings };
}

function validateAttributes(attributes, model, strict) {
  if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) throw new AtomicDefinitionError(`Attributes for ${model.name} must be an object`);
  const output = {};
  for (const [name, value] of Object.entries(attributes)) {
    const definition = model.attributes?.[name];
    if (!definition) { if (strict) throw new AtomicDefinitionError(`Unknown attribute "${name}" for model "${model.name}"`); continue; }
    output[name] = coerce(value, definition, `${model.name}.${name}`);
  }
  return output;
}

function coerce(value, definition, field) {
  if (value === null || value === undefined) return value;
  switch (definition.kind) {
    case 'text': case 'longtext': case 'email': case 'datetime': return String(value);
    case 'number': { const number = Number(value); if (!Number.isFinite(number)) throw new AtomicDefinitionError(`${field} must be numeric`); return number; }
    case 'integer': { const number = Number(value); if (!Number.isInteger(number)) throw new AtomicDefinitionError(`${field} must be an integer`); return number; }
    case 'boolean': {
      if (typeof value === 'boolean') return value;
      if (value === 'true' || value === 1) return true;
      if (value === 'false' || value === 0) return false;
      throw new AtomicDefinitionError(`${field} must be boolean`);
    }
    case 'list': return (Array.isArray(value) ? value : [value]).map(item => definition.items ? coerce(item, definition.items, field) : clone(item));
    case 'map': if (typeof value === 'object' && !Array.isArray(value)) return clone(value); throw new AtomicDefinitionError(`${field} must be an object`);
    case 'ref': return typeof value === 'string' ? value : clone(value);
    default: return clone(value);
  }
}

function validateEvidence(input, sourceText, strict) {
  const values = Array.isArray(input) ? input : [];
  const evidence = [];
  for (const value of values) {
    if (!value || typeof value.excerpt !== 'string' || !value.excerpt.trim()) continue;
    const excerpt = value.excerpt.trim();
    let start = Number.isInteger(value.start) ? value.start : sourceText.indexOf(excerpt);
    if (start >= 0 && sourceText.slice(start, start + excerpt.length) !== excerpt) start = sourceText.indexOf(excerpt);
    if (start < 0) {
      if (strict) throw new AtomicDefinitionError(`Evidence excerpt was not found verbatim in the source: "${excerpt.slice(0, 80)}"`);
      evidence.push({ excerpt, ...(Number.isInteger(value.page) ? { page: value.page } : {}) });
      continue;
    }
    evidence.push({ excerpt, start, end: start + excerpt.length, ...(Number.isInteger(value.page) ? { page: value.page } : {}) });
  }
  return evidence;
}

function parseProviderResult(raw) {
  if (raw && typeof raw === 'object') return raw;
  const text = String(raw ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(text); } catch (error) { throw new AtomicDefinitionError(`Semantic provider returned invalid JSON: ${error.message}`); }
}

function attributeContract(definition) { return { kind: definition.kind, description: definition.description, required: Boolean(definition.required), ...(definition.to ? { to: definition.to } : {}), ...(definition.items ? { items: attributeContract(definition.items) } : {}) }; }
function clamp(value) { const number = Number(value ?? 0); return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0; }
function isEmpty(value) { return value === undefined || value === null || value === ''; }
