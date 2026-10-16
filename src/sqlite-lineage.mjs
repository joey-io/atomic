// Durable SQLite lineage: source -> derived edges with bounded transitive invalidation.
// Node >=22.5. This does not execute recomputation; it identifies affected IDs.
import {DatabaseSync} from 'node:sqlite';
export function createSqliteLineage(path=':memory:') {
 const db=new DatabaseSync(path);
 db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000');
 db.exec('CREATE TABLE IF NOT EXISTS lineage (source TEXT NOT NULL, derived TEXT NOT NULL, PRIMARY KEY(source,derived))');
 db.exec('CREATE INDEX IF NOT EXISTS lineage_derived ON lineage(derived)');
 const insert=db.prepare('INSERT OR IGNORE INTO lineage(source,derived) VALUES (?,?)');
 const children=db.prepare('SELECT derived FROM lineage WHERE source=?');
 const parents=db.prepare('SELECT source FROM lineage WHERE derived=?');
 const del=db.prepare('DELETE FROM lineage WHERE source=? AND derived=?');
 return {
  link(derived,source){if(!derived||!source||derived===source)throw new TypeError('Distinct IDs required');insert.run(source,derived);},
  unlink(derived,source){del.run(source,derived);},
  dependencies(id){return parents.all(id).map(r=>r.source);},
  dependents(id,{maxNodes=10000}={}){
   if(!Number.isInteger(maxNodes)||maxNodes<1)throw new RangeError('Invalid budget');
   const seen=new Set(),queue=[id];
   for(let i=0;i<queue.length;i++)for(const r of children.all(queue[i])){
    if(r.derived===id||seen.has(r.derived))continue;
    if(seen.size>=maxNodes)throw new Error('Lineage traversal budget exceeded');
    seen.add(r.derived);queue.push(r.derived);
   }
   return [...seen];
  },
  close(){db.close();}
 };
}
