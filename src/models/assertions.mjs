// Optional model pack for canonical assertions shared with Atomic Reason.
// Import and load through createAtomic({models:[assertionModelPack]}).
export const assertionModelPack = {
 atomic:1,name:'@atomic/models-assertions',version:'0.1.0',
 models:[{
  name:'assertion',description:'A source-attributed proposition; acceptance requires external review policy.',
  attributes:{
   subject:{kind:'text',required:true},
   predicate:{kind:'text',required:true},
   object:{kind:'map',description:'Structured proposition value. Use {value:...} for scalar answers.',required:true},
   evidence:{kind:'list',items:{kind:'map'},description:'Source identifiers and excerpts'},
   method:{kind:'text',required:true},
   status:{kind:'text',required:true},
   confidence:{kind:'number'},
   source:{kind:'text'},
   reviewedBy:{kind:'text'},
   validFrom:{kind:'datetime'},
   validUntil:{kind:'datetime'}
  },
  identity:[{fields:['subject','predicate','source'],strength:'weak'}],
  presentation:{label:'Assertion',title:'predicate',subtitle:'status'}
 }]
};
export default assertionModelPack;
