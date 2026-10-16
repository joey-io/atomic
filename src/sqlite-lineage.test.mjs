import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSqliteLineage} from './sqlite-lineage.mjs';
test('lineage survives restart and handles transitive invalidation',()=>{
 const dir=mkdtempSync(join(tmpdir(),'atomic-lineage-'));const path=join(dir,'lineage.db');
 try{
  let l=createSqliteLineage(path);l.link('claim','source');l.link('report','claim');l.close();
  l=createSqliteLineage(path);
  assert.deepEqual(new Set(l.dependents('source')),new Set(['claim','report']));
  assert.deepEqual(l.dependencies('report'),['claim']);l.close();
 }finally{rmSync(dir,{recursive:true,force:true});}
});
