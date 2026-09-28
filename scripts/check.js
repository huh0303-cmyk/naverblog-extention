const fs=require('node:fs');const path=require('node:path');const vm=require('node:vm');const assert=require('node:assert/strict');
let count=0;
function check(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isDirectory())check(file);else if(/\.(js|cjs)$/.test(file)){new vm.Script(fs.readFileSync(file,'utf8'),{filename:file});count++;}}}
for(const dir of ['src','extension','scripts','tests','packages'])check(dir);
const manifest=JSON.parse(fs.readFileSync('extension/manifest.json','utf8'));
assert.equal(manifest.manifest_version,3);
for(const file of [manifest.background.service_worker,'editor.js','connect.html','connect.js'])assert.ok(fs.existsSync(path.join('extension',file)));
console.log(`Syntax and extension manifest checked (${count} scripts). Run npm test for behavioral checks.`);
