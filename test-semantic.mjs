import assert from 'node:assert/strict';
import { createAtomic, createSemanticProvider, buildExtractionContract } from './src/index.mjs';

const provider = createSemanticProvider({
  async complete({ contract, request }) {
    assert.equal(contract.models.some(model => model.name === 'person'), true);
    assert.match(request.input.text, /Joey Smith/);
    return {
      candidates: [{
        candidateId: 'person-1',
        model: 'person',
        attributes: { name: 'Joey Smith', email: 'joey@example.com' },
        confidence: 0.98,
        evidence: [{ excerpt: 'Joey Smith <joey@example.com>' }],
        rationale: 'The source explicitly pairs a human name with an email address.'
      }],
      relationships: [],
      warnings: []
    };
  }
});

const atomic = await createAtomic({ provider, modelDirectory: false });
const observation = await atomic.observe('Joey Smith <joey@example.com> wrote the memo.');
assert.equal(observation.provider, 'atomic:semantic');
assert.equal(observation.candidates.length, 1);
assert.equal(observation.candidates[0].model, 'person');
assert.equal(observation.candidates[0].attributes.name, 'Joey Smith');
assert.equal(observation.candidates[0].evidence[0].start, 0);
assert.equal(observation.input.document.sha256.length, 64);

const contract = buildExtractionContract(atomic.models.list(), { modelNames: ['person'] });
assert.deepEqual(contract.models.map(model => model.name), ['person']);

await assert.rejects(
  () => createSemanticProvider({ complete: async () => ({ candidates: [{ model: 'person', attributes: { madeUp: 'x' }, confidence: 1, evidence: [{ excerpt: 'x' }] }] }) }).observe({ input: { name: 'x', text: 'x' }, models: atomic.models.list() }),
  /Unknown attribute/
);

console.log('semantic tests passed');
