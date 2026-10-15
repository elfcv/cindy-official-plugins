// Publisher/build-time only; users need neither Go nor Node installed.
import {mkdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
const [source,output]=process.argv.slice(2);
if(!source||!output)throw Error('Usage: build-browser-native.mjs <source-dir> <output-dir>');
const go=process.env.CINDY_BUILD_GO||'go';
const version=execFileSync(go,['version'],{encoding:'utf8'});
if(!version.includes('go1.27.2 '))throw Error('Build requires Go 1.27.2');
await mkdir(output,{recursive:true});
for(const platform of ['darwin','linux','win32'])for(const arch of ['x64','arm64']) {
 const out=path.resolve(output,platform+'-'+arch,'cindy-browser-native'+(platform==='win32'?'.exe':''));
 await mkdir(path.dirname(out),{recursive:true});
 execFileSync(go,['build','-trimpath','-buildvcs=false','-ldflags=-s -w','-o',out,'.'],{cwd:source,env:{...process.env,CGO_ENABLED:'0',GOOS:platform==='win32'?'windows':platform,GOARCH:arch==='x64'?'amd64':arch,GOTOOLCHAIN:'local'},stdio:'inherit'});
}
