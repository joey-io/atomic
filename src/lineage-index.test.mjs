import test from 'node:test';
import assert from 'node:assert/strict';
import {createLineageIndex} from './lineage-index.mjs';
test('correction invalidates transitive descendants without loops',()=>{
 const l=createLineageIndex();
 l.link('claim','source');l.link('report','claim');l.link('claim','report');
 assert.deepEqual(new Set(l.dependents('source')),new Set(['claim','report']));
 assert.deepEqual(l.dependencies('report'),['claim']);
});
test('lineage budget prevents unbounded fan-out',()=>{
 const l=createLineageIndex();l.link('a','s');l.link('b','s');
 assert.throws(()=>l.dependents('s',{maxNodes:1}),/budget/);
});
