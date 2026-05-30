// Write `val` into `root` at a dotted path, creating an array for a numeric next
// segment and an object otherwise. Powers the form's nested attr (embeds + list
// repeaters): names like `grants.0.path` become { grants: [{ path: … }] }.
export function setPath(root, path, val) {
  var ks = path.split('.'), o = root;
  for (var i = 0; i < ks.length - 1; i++) { var k = ks[i], nn = /^[0-9]+$/.test(ks[i + 1]); if (o[k] === undefined) o[k] = nn ? [] : {}; o = o[k]; }
  o[ks[ks.length - 1]] = val;
}
