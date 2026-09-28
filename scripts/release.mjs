import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';

const run=promisify(execFile);
const out=resolve('artifacts/release');
await mkdir(out,{recursive:true});
const npm=process.platform==='win32'?'npm.cmd':'npm';
const {stdout}=await run(npm,['pack','--json','--ignore-scripts','--pack-destination',out],{timeout:60000,maxBuffer:2*1024*1024});
const [pack]=JSON.parse(stdout);
for(const file of pack.files) {
  const allowed=/^(?:bin\/|src\/|node_modules\/@nesjs\/core\/|README\.md$|LICENSE$|LICENSES-glyphs\.txt$|THIRD_PARTY_NOTICES\.md$|package\.json$)/.test(file.path);
  if(!allowed || /(?:^|\/)\.\.(?:\/|$)|\.(?:nes|pem|key)$/i.test(file.path)) throw new Error(`Unexpected package entry: ${file.path}`);
}
if(!pack.bundled.includes('@nesjs/core'))throw new Error('Missing bundled emulation core');
if(!pack.files.some(f=>f.path==='node_modules/@nesjs/core/LICENSE.md'))throw new Error('Missing core license');
const bytes=await readFile(join(out,pack.filename));
const sha256=createHash('sha256').update(bytes).digest('hex');
await writeFile(join(out,'SHA256SUMS'),`${sha256}  ${pack.filename}\n`);
await writeFile(join(out,'manifest.json'),JSON.stringify({version:pack.version,file:pack.filename,bytes:bytes.length,sha256,entries:pack.files.length,bundled:pack.bundled},null,2)+'\n');
console.log(JSON.stringify({directory:out,file:pack.filename,bytes:bytes.length,sha256,bundled:pack.bundled}));
