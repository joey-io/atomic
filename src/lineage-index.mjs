// Minimal lineage index for incremental invalidation.
// Dependency edges are explicit and are not treated as independent corroboration.
export function createLineageIndex() {
 const forward=new Map(),reverse=new Map();
 const add=(map,k,v)=>{if(!map.has(k))map.set(k,new Set());map.get(k).add(v);};
 return {
  link(derivedId,sourceId) {
   if (!derivedId || !sourceId || derivedId===sourceId) throw new TypeError('Distinct ids required');
   add(forward,derivedId,sourceId);add(reverse,sourceId,derivedId);
  },
  dependencies(id){return [...(forward.get(id)??[])];},
  dependents(id,{maxNodes=10000}={}) {
   if (!Number.isInteger(maxNodes)||maxNodes<1)throw new RangeError('Invalid budget');
   const seen=new Set(),queue=[id];
   for(let i=0;i<queue.length;i++){
    for(const dependent of reverse.get(queue[i])??[]) {
     if(dependent===id||seen.has(dependent))continue;
     if(seen.size>=maxNodes)throw new Error('Lineage traversal budget exceeded');
     seen.add(dependent);queue.push(dependent);
    }
   }
   return [...seen];
  }
 };
}
