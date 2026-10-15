import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const installedVersion=JSON.parse(fs.readFileSync(new URL('../my-browser/extension/manifest.json',import.meta.url),'utf8')).version;
const version='0.4.13'; // Stable signed wire contract, independent of extension releases.
const source=fs.readFileSync(new URL('../my-browser/extension/background.js',import.meta.url),'utf8');
test('discovery continues past mismatched and unpaired bridges without opening tabs',async()=>{
  const ports=[],saved={};
  const noop={addListener(){}};
  const chrome={runtime:{id:'fixture',getManifest:()=>({version:installedVersion}),getURL:()=> 'chrome-extension://fixture/',onStartup:noop,onInstalled:noop,onMessage:noop},
    storage:{local:{get:async()=>({clientId:'fixture'}),set:async()=>{}},session:{get:async()=>({}),set:async v=>Object.assign(saved,v)}},
    tabs:{onRemoved:noop,onActivated:noop},alarms:{create(){},onAlarm:noop},action:{setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{}}};
  const context={chrome,MyBrowserNetwork:{create:()=>({})},MyBrowserPolicy:{},navigator:{userAgent:'Chrome'},URL,AbortController,setTimeout,clearTimeout,crypto:globalThis.crypto,
    fetch:async url=>{const port=Number(new URL(url).port);ports.push(port);return {ok:true,json:async()=>({plugin:'my-browser',protocol:3,extensionId:'fixture',version:port===18810?'0.2.0':version,pairing_required:port===18811,session:'fixture-session'})};}};
  vm.runInNewContext(source.replace(/\nchain\(\);\s*$/,'')+'\nglobalThis.discoverTest=discover;',context);
  const found=await context.discoverTest();assert.equal(found.base,'http://127.0.0.1:18812');assert.deepEqual(ports,Array.from({length:10},(_,i)=>18810+i));assert.equal(saved.connection.connected,true);
});
for(const previousVersion of ['0.3.48','0.4.0','0.4.1','0.4.2','0.4.3','0.4.4','0.4.5','0.4.6','0.4.7','0.4.8','0.4.9','0.4.10','0.4.11','0.4.12'])test('a new extension negotiates plugin '+previousVersion,async()=>{
 const versions=[],noop={addListener(){}},saved={};
 const chrome={runtime:{id:'fixture',getManifest:()=>({version:installedVersion}),getURL:()=> 'chrome-extension://fixture/',onStartup:noop,onInstalled:noop,onMessage:noop},storage:{local:{get:async()=>({clientId:'fixture'}),set:async()=>{}},session:{get:async()=>({}),set:async v=>Object.assign(saved,v)}},tabs:{onRemoved:noop,onActivated:noop},alarms:{create(){},onAlarm:noop},action:{setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{}}};
 const context={chrome,MyBrowserNetwork:{create:()=>({})},MyBrowserPolicy:{},navigator:{userAgent:'Chrome'},URL,AbortController,setTimeout,clearTimeout,crypto:globalThis.crypto,fetch:async(_url,options)=>{versions.push(options.headers['X-My-Browser-Version']);return {ok:true,json:async()=>({plugin:'my-browser',protocol:3,extensionId:'fixture',version:previousVersion,session:'old-session',capabilities:[]})};}};
 vm.runInNewContext(source.replace(/\nchain\(\);\s*$/,'')+'\nglobalThis.discoverTest=discover;',context);
 const found=await context.discoverTest();assert.equal(found.session,'old-session');assert.equal(found.learning,false);assert.equal(versions.filter(v=>v===version).length,10);assert.equal(versions.filter(v=>v===previousVersion).length,10);assert.equal(saved.connection.connected,true);
});

test('an updated extension keeps a paired older bridge connected while negotiating learning',async()=>{
 const noop={addListener(){}},saved={},auth={publicKey:'test-key',sign:async()=>new Uint8Array()};
 const chrome={runtime:{id:'fixture',getManifest:()=>({version:installedVersion}),getURL:()=> 'chrome-extension://fixture/',onStartup:noop,onInstalled:noop,onMessage:noop},storage:{local:{get:async()=>({clientId:'fixture'}),set:async()=>{}},session:{get:async()=>({}),set:async v=>Object.assign(saved,v)}},tabs:{onRemoved:noop,onActivated:noop},alarms:{create(){},onAlarm:noop},action:{setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{}}};
 const calls=[];const context={chrome,MyBrowserNetwork:{create:()=>({})},MyBrowserPolicy:{},navigator:{userAgent:'Chrome'},URL,AbortController,setTimeout,clearTimeout,crypto:globalThis.crypto,TextEncoder,Buffer,btoa:value=>Buffer.from(value,'binary').toString('base64'),__testAuth:auth,
   fetch:async(url,options)=>{const headers=options.headers;calls.push({url,key:headers['X-My-Browser-Key'],proof:headers['X-My-Browser-Proof']});return {ok:true,json:async()=>headers['X-My-Browser-Key']?{plugin:'my-browser',protocol:3,extensionId:'fixture',version:'0.4.12',session:'old-session',capabilities:[]}:{plugin:'my-browser',protocol:3,extensionId:'fixture',version:'0.4.12',session:'old-session',challenge:'old-challenge',auth_required:false}};}};
 context.globalThis=context;
 vm.runInNewContext(source.replace(/\nchain\(\);\s*$/,'').replaceAll('auth=auth||await authReady().catch(()=>null)','auth=auth||globalThis.__testAuth||await authReady().catch(()=>null)')+'\nglobalThis.discoverTest=discover;',context);
 const found=await context.discoverTest();assert.equal(found.session,'old-session');assert.equal(found.learning,false);assert.equal(saved.connection.connected,true);
});

function workerContext(fetch){
  const noop={addListener(){}};
  const chrome={runtime:{id:'fixture',getManifest:()=>({version:installedVersion}),getURL:()=> 'chrome-extension://fixture/',onStartup:noop,onInstalled:noop,onMessage:noop},storage:{local:{get:async()=>({clientId:'fixture'}),set:async()=>{}},session:{get:async()=>({}),set:async()=>{}}},tabs:{onRemoved:noop,onActivated:noop},alarms:{create(){},onAlarm:noop},action:{setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{}}};
 const testAuth={publicKey:'test-key',sign:async()=>new Uint8Array()};
 const context={chrome,MyBrowserNetwork:{create:()=>({})},MyBrowserPolicy:{},navigator:{userAgent:'Chrome'},URL,AbortController,setTimeout,clearTimeout,crypto:globalThis.crypto,TextEncoder,Buffer,btoa:value=>Buffer.from(value,'binary').toString('base64'),__testAuth:testAuth,fetch};
 vm.runInNewContext(source.replace(/\nchain\(\);\s*$/,'').replace('return {base,port,version,session:r.session,learning,auth};','return {base,port,version,session:r.session,learning,auth:globalThis.__testAuth};')+'\nglobalThis.testAPI={discover,learningFetch};',context);return context.testAPI;
}
test('simultaneous callers share one discovery scan',async()=>{
 let scans=0,release;const gate=new Promise(r=>release=r);
 const api=workerContext(async()=>{scans++;await gate;return {ok:true,json:async()=>({plugin:'my-browser',protocol:3,extensionId:'fixture',version,session:'session'})};});
 const a=api.discover(),b=api.discover();await new Promise(r=>setImmediate(r));assert.equal(scans,10);release();
 assert.equal(await a,await b);assert.equal(scans,10);
});
test('lost learning responses retry the original id/session, never cross a changed session',async()=>{
 const calls=[];let changed=false;
 const api=workerContext(async(url,options)=>{calls.push({url,options});if(changed)return {ok:false,json:async()=>({error:'SESSION_CHANGED'})};if(url.endsWith('/learning/challenge'))return {ok:true,json:async()=>({ok:true,challenge:'challenge-'+calls.length})};if(calls.length===2)throw new TypeError('Failed to fetch');return {ok:true,json:async()=>({done:true})};});
 const target={base:'http://127.0.0.1:18810',session:'original',auth:{publicKey:'test-key',sign:async()=>new Uint8Array()}},body={id:crypto.randomUUID()};
 assert.equal((await api.learningFetch(target,'/learning/result',body,async()=>{},Date.now()+10000)).done,true);
 assert.equal(calls.length,4);assert.equal(calls[1].options.body,calls[3].options.body);
 assert.equal(calls[1].options.headers['X-My-Browser-Session'],'original');assert.equal(calls[3].options.headers['X-My-Browser-Session'],'original');
 changed=true;await assert.rejects(api.learningFetch(target,'/learning/start',body,async()=>{},Date.now()+10000),/SESSION_CHANGED/);assert.equal(calls.length,5);
});
test('cancellation stops a safe transport retry before another request is sent',async()=>{
 let calls=0,active=true;
 const api=workerContext(async()=>{calls++;active=false;throw new TypeError('network down');});
 await assert.rejects(api.learningFetch({base:'http://127.0.0.1:18810',session:'session'},'/learning/start',{id:crypto.randomUUID()},async()=>{if(!active)throw Error('REQUEST_CANCELLED');},Date.now()+10000),/REQUEST_CANCELLED/);
 assert.equal(calls,1);
});

test('discovery finds a bridge past the original ten ports and rejects generic HTTP listeners',async()=>{
 const ports=[];const api=workerContext(async url=>{const port=Number(new URL(url).port);ports.push(port);return {ok:true,json:async()=>port===18825?{plugin:'my-browser',protocol:3,extensionId:'fixture',version,session:'fallback-session'}:{ok:true}};});
 const bridge=await api.discover();assert.equal(bridge.base,'http://127.0.0.1:18825');assert.equal(ports.length,20);
});


test('cancel during discovery prevents submission and cannot be forged by another document',async()=>{
 const core=(await import('./../my-browser/extension/learning-core.js')).default||globalThis.CindyLearning;
 const listeners=[],starts=[],noop={addListener(){}};let release;const gate=new Promise(r=>release=r);
 const chrome={runtime:{id:'fixture',getManifest:()=>({version:installedVersion}),getURL:p=>'chrome-extension://fixture/'+p,onStartup:noop,onInstalled:noop,onMessage:{addListener:f=>listeners.push(f)}},storage:{local:{get:async()=>({clientId:crypto.randomUUID()}),set:async()=>{}},session:{get:async()=>({}),set:async()=>{}}},tabs:{onRemoved:noop,onActivated:noop,get:async()=>({id:1,url:'https://example.test/watch',title:'Test'}),sendMessage:async()=>{}},alarms:{create(){},onAlarm:noop},action:{setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{}}};
 const context={chrome,MyBrowserNetwork:{create:()=>({document:async()=> 'doc'})},MyBrowserPolicy:{},CindyLearning:core,navigator:{userAgent:'Chrome'},URL,AbortController,setTimeout,clearTimeout,crypto,TextEncoder,Buffer,btoa:value=>Buffer.from(value,'binary').toString('base64'),
 fetch:async(url,opt)=>{if(url.endsWith('/health')){await gate;return {ok:true,json:async()=>({plugin:'my-browser',protocol:3,extensionId:'fixture',version,session:'session',capabilities:['learning-v1','learning-auth-v2']})};}if(url.endsWith('/learning/challenge'))return {ok:true,json:async()=>({ok:true,challenge:'challenge'})};if(url.endsWith('/learning/start'))starts.push(JSON.parse(opt.body).id);return {ok:true,json:async()=>url.endsWith('/learning/result')?{done:true,result:{ok:true}}:{ok:true}};}};
 context.__testAuth={publicKey:'test-key',sign:async()=>new Uint8Array()};
 vm.runInNewContext(source.replace(/\nchain\(\);\s*$/,'').replace('return {base,port,version,session:r.session,learning,auth};','return {base,port,version,session:r.session,learning,auth:globalThis.__testAuth};').replace('const auth=target.auth||await authReady();','const auth=target.auth||globalThis.__testAuth||await authReady();')+'\nglobalThis.reviewAPI={learningRequest};',context);
 const sender={id:'fixture',documentId:'doc',frameId:0,tab:{id:1},url:'https://example.test/watch'};
 const first=crypto.randomUUID(),second=crypto.randomUUID();
 const request=id=>context.reviewAPI.learningRequest({id,request:{op:'translate',text:'hello',source:{url:sender.url}}},sender).catch(e=>e.message);
 const a=request(first),b=request(second);await new Promise(r=>setImmediate(r));
 for(const fn of listeners){fn({type:'cindy-cancel',id:first},sender,()=>{});fn({type:'cindy-cancel',id:second},{...sender,documentId:'other'},()=>{});}
 release();assert.equal(await a,'REQUEST_CANCELLED');assert.equal((await b).ok,true);assert.deepEqual(starts,[second]);
});
