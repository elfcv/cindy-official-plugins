'use strict';
// Cindy requires this entry from its utility-process bootstrap; it is NOT require.main.
// Keep entry activation unconditional and the testable implementation in bridge.cjs.
const readline = require('node:readline');
const {createBridge} = require('./bridge.cjs');
const P = require('../extension/policy.js');
const nativeBinding=require('./native-binding.cjs').createNativeBinding();
const bridge = createBridge({nativeToken:nativeBinding.token,notify:(method,params)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',method,params})+'\n')});
const installation = require('./installation.cjs').createInstallation();
const nativeReady=bridge.request('status').then(status=>{if(!status.ok)return {ok:false};const distribution=require('../distribution.json');const {EXT_ID}=require('./bridge.cjs');return nativeBinding.install(status.port,[...new Set([EXT_ID,distribution.chrome.extensionId,distribution.edge.extensionId].filter(Boolean))]);}).catch(()=>({ok:false}));
const input = readline.createInterface({input:process.stdin});
input.on('line',async line => {
  let req;
  try {req=JSON.parse(line);} catch {return;}
  if (!req || req.id == null) return;
  let result;
  try {
    await nativeReady;
    if (req.method === 'installation') result={ok:true,...installation.status()};
    else if (req.method === 'openInstallation') result=await installation.open(req.params?.browser,req.params?.mode);
    else result=await bridge.request(req.method,req.params);
    if(req.method==='status')result.nativeBinding=nativeBinding.status();
  }
  catch(e) {result={ok:false,error:'BRIDGE_ERROR',message:e.message || 'Re-enable Cindy Chrome and check its connection.',execution:req.method==='act' && P.INTERACT.includes(req.params?.action) ? 'unknown' : 'not_executed'};}
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,result})+'\n');
});
input.on('close',()=>{void nativeReady.finally(async()=>{await bridge.close();await nativeBinding.close();});});
