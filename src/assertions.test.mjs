import test from 'node:test';
import assert from 'node:assert/strict';
import {ModelRegistry} from './index.mjs';
import {assertionModelPack} from './models/assertions.mjs';
test('assertion model pack loads into Atomic registry',()=>{
 const registry=new ModelRegistry();registry.load(assertionModelPack);
 assert.equal(registry.get('assertion').attributes.subject.required,true);
});
