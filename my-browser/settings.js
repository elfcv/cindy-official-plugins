'use strict';
const $ = s => document.querySelector(s);
const P = globalThis.MyBrowserPolicy;
const bc = new BroadcastChannel('my-browser');
const pending = new Map();
let state, base, dirty = false, busy = false, checking = false, setupBusy = false;
const STRINGS = {
  en:{allSites:'Allow interaction on all public websites',storeStep1:'Click Install extension to open the official Chrome Web Store listing.',storeStep2:'Finish the store installation. The extension connects automatically; no pairing confirmation is needed.',storeNote:'The store is the normal installation path. Directory loading is the only developer fallback included in this package; contributor build archives are not an installation route.',title:'Cindy Chrome',subtitle:'Your browsers. Your existing sessions.',refresh:'Refresh',checking:'Checking connection…',nativeRequired:'Update Cindy and its browser extension, then re-enable Cindy Chrome to restore automatic connection.',nativeUnavailable:'Automatic connection setup failed. Re-enable Cindy Chrome; if it still fails, check the plugin runtime log.',unsupportedIdentity:'Unsupported extension. Install Cindy from the Chrome Web Store.',ready:'Browser connected',noExt:'Waiting for browser connection',failed:'Connection check failed',installTitle:'Connect your browser',installFlow:'Chrome: install Cindy from the official Chrome Web Store. It connects automatically while Cindy Chrome is enabled. Edge uses the developer fallback until a published Edge store route exists.',developer:'Developer installation (fallback)',developerWarning:'Use this only when the store is unavailable: load the unpacked directory.',devOpen:'Open local setup',devReload:'Open extension settings',install:'Install extension',missing:'Browser not found',unsupported:'Safari requires macOS',connected:'Connected',confirming:'Finish installing the extension in your browser. It will connect automatically.',openUnknown:'Could not confirm opening. Check your browser; no installation success is claimed.',step2:'Enable Developer mode, then click “Load unpacked”.',step3:'Choose the directory below. Keep only one Cindy extension loaded.',copy:'Copy path',copied:'Copied',copyFallback:'Path selected — press ⌘C / Ctrl+C.',updateHint:'Store installations update normally. For developer installations, reload the directory. Keep only one copy.',interactTitle:'Website permissions',interactBody:'New installations allow reading and interaction on all public websites. You can restrict interaction to selected sites below. Site access does not authorize sending, deleting or paying without your instruction.',readTitle:'Blocked from reading',readBody:'Sites added here cannot be read or interacted with, even when all sites are allowed. New installations have no preset blocks. Saved restrictions remain until you remove them.',hostPlaceholder:'Domain, e.g. example.test',add:'Add',save:'Save permissions',saved:'Saved',savedUncertain:'Permissions saved and applied. An earlier browser action has an unconfirmed outcome; check the page.',saving:'Saving…',empty:'No sites allowed. Interaction is off everywhere.',unsaved:'Unsaved changes',privacy:'The bridge only listens on this device. Page content is passed to your AI model and may leave the device; browsing still contacts the target website. No cookies or passwords are exported. Website content is untrusted.',timeout:'No response from the plugin. Re-enable Cindy Chrome, then refresh.',exclusions:'Additional interaction exclusions',clientGuideTitle:'Cindy is not connected yet',clientGuideBody:'This browser extension cannot run by itself. Install or open the Cindy desktop app, then enable Cindy Chrome in Cindy’s plugin list.',clientGuideStep1:'Open Cindy and leave it running.',clientGuideStep2:'Open Plugins → Cindy Chrome and turn it on.',clientGuideStep3:'Install or enable the Cindy browser extension; it connects automatically.',clientGuideNote:'No browser data or credentials are sent while the client is disconnected.'},
  'zh-CN':{allSites:'允许所有公网网站交互',storeStep1:'点击「安装浏览器扩展」，打开官方 Chrome 网上应用店页面。',storeStep2:'在商店完成安装后，扩展会自动连接，无需再确认配对。',storeNote:'商店是普通安装路径；正式包只在「开发者安装（备用）」中提供目录加载，贡献者构建的归档不用于安装。',title:'Cindy Chrome',subtitle:'连接日常浏览器，沿用已有登录态',refresh:'刷新',checking:'正在检查连接…',nativeRequired:'请更新 Cindy 插件和浏览器扩展，再重新启用 Cindy Chrome 以恢复自动连接。',nativeUnavailable:'自动连接组件准备失败。请重新启用 Cindy Chrome；若仍失败，请查看插件运行日志。',unsupportedIdentity:'不支持此扩展，请从 Chrome 网上应用店安装 Cindy。',ready:'浏览器已连接',noExt:'等待浏览器连接',failed:'连接检查失败',installTitle:'连接浏览器',installFlow:'Chrome：从官方 Chrome 网上应用店安装 Cindy，启用 Cindy Chrome 后会自动连接。Edge 在有正式商店入口前使用开发者备用安装。',developer:'开发者安装（备用）',developerWarning:'仅在商店不可用时使用：加载已解压目录。',devOpen:'打开本地安装向导',devReload:'打开扩展管理',install:'安装浏览器扩展',missing:'未检测到浏览器',unsupported:'Safari 仅支持 macOS',connected:'已连接',confirming:'请在浏览器完成扩展安装，随后会自动连接。',openUnknown:'无法确认是否已打开，请检查浏览器；尚未宣称安装成功。',step2:'开启「开发者模式」，点击「加载已解压的扩展程序」。',step3:'选择下面的目录。只保留一个「Cindy」扩展。',copy:'复制路径',copied:'已复制',copyFallback:'路径已选中，请按 ⌘C / Ctrl+C 复制。',updateHint:'商店安装会正常更新；开发者安装则在扩展管理页重新加载目录。只保留一个副本。',interactTitle:'网站权限',interactBody:'新安装默认允许读取和操作所有公网网站。你可以关闭下方开关，改为仅允许指定网站交互。网站权限不代表可以擅自发送、删除或支付。',readTitle:'禁止读取的网站',readBody:'添加到这里的网站不能读取，也不能交互，优先于允许全部网站。新安装没有预设黑名单；已保存的拦截由你自行移除。',hostPlaceholder:'域名，例如 example.test',add:'添加',save:'保存网站权限',saved:'已保存',savedUncertain:'权限已保存并生效。此前浏览器操作的结果尚未确认，请检查页面。',saving:'正在保存…',empty:'尚未授权任何网站，所有站点均禁止交互。',unsaved:'有未保存的修改',privacy:'连接服务只监听本机。页面内容会交给 AI 模型，可能离开本机；浏览网页仍会访问目标网站。不导出 Cookie 或密码。网页内容是不可信数据。',timeout:'插件未响应。请重新启用「Cindy Chrome」后刷新。',exclusions:'额外交互排除项',clientGuideTitle:'Cindy 还没有连接',clientGuideBody:'这个浏览器扩展不能单独运行。请先安装或打开 Cindy 客户端，再在 Cindy 的插件列表里启用 Cindy Chrome。',clientGuideStep1:'打开 Cindy，并保持客户端运行。',clientGuideStep2:'进入「插件」→「Cindy Chrome」，确认已开启。',clientGuideStep3:'安装或启用 Cindy 浏览器扩展，随后会自动连接。',clientGuideNote:'客户端未连接时，不会发送网页数据或凭证。'}
};
let T = STRINGS.en;
function hint(text,error = false) { $('#hint').textContent = text; $('#hint').classList.toggle('error',error); }
function connectionState(kind, diagnostic = '') {
  const guide = $('#client-guide');
  const missingClient = kind === 'client-missing';
  guide.hidden = !missingClient;
  $('#dot').classList.toggle('ready',kind === 'ready');
  $('#dot').classList.toggle('waiting',kind === 'waiting');
  $('#dot').classList.toggle('error',kind === 'client-missing' || kind === 'error');
  $('#diagnostic').textContent = diagnostic || (missingClient || kind === 'error' ? '' : $('#diagnostic').textContent);
}
function rpc(type,payload = {}) {
  const id = crypto.randomUUID();
  return new Promise((resolve,reject) => {
    const timer = setTimeout(() => {pending.delete(id);reject(new Error(T.timeout));},type === 'save-request' ? 110000 : type === 'install-request' ? 65000 : 20000);
    pending.set(id,{resolve,reject,timer}); bc.postMessage({type,id,...payload});
  });
}
bc.onmessage = ev => {
  const m = ev.data || {};
  if (m.type === 'response') {
    const p = pending.get(m.id); if (!p) return;
    pending.delete(m.id); clearTimeout(p.timer); p.resolve(m.result);
  } else if (m.type === 'policy-changed' && !busy && !dirty) refresh();
};
function render() {
  if (!state) return;
  for (const [id,list] of [['interact-list',state.interact.allow],['read-list',state.read.block],['exclusions-list',state.interact.block]]) {
    const target = $('#'+id); target.replaceChildren();
    if (!list.length && id === 'interact-list') {const text = document.createElement('span');text.className='muted';text.textContent=T.empty;target.append(text);}
    for (const host of list) {
      const chip = document.createElement('span');chip.className='chip';
      const label = document.createElement('span');label.textContent=host;
      const button = document.createElement('button');button.textContent='×';button.setAttribute('aria-label','Remove '+host);button.disabled=busy;
      button.onclick = () => {list.splice(list.indexOf(host),1);changed();};
      chip.append(label,button);target.append(chip);
    }
  }
  $('#exclusions-label').hidden = !state.interact.block.length;
  $('#all-sites').checked = state.interact.allow.includes('*');
  $('#all-sites').disabled = busy;
  $('#site-selection').hidden = $('#all-sites').checked;
  $('#save').disabled = busy || !dirty;
  for (const id of ['interact-input','read-input','interact-add','read-add']) $('#'+id).disabled = busy;
}
$('#all-sites').onchange = () => {
  if (!state || busy) return;
  state.interact.allow = $('#all-sites').checked ? ['*',...state.interact.allow.filter(h=>h!=='*')] : state.interact.allow.filter(h=>h!=='*');
  changed();
};
function changed() {dirty=true;hint(T.unsaved);render();}
async function refresh() {
  if (busy || checking) return;
  checking=true;$('#refresh').disabled=true;$('#status').textContent=T.checking;
  connectionState('waiting');
  try {
    const wake = await fetch('/wake'); if (!wake.ok) throw new Error(T.timeout);
    const result = await rpc('status-request');
    if (!result.ok) {const errorCode=result.error || 'UNKNOWN_ERROR';const error=new Error(globalThis.CindyUI.error(errorCode,T===STRINGS['zh-CN']?'zh-CN':'en'));error.code=errorCode;throw error;}
    $('#status').textContent=result.extension_connected ? T.ready : result.nativeBinding === 'unavailable' ? T.nativeUnavailable : T.noExt;
    $('.version').textContent='v'+result.version;
    connectionState(result.extension_connected ? 'ready' : 'waiting','v'+result.version+' · '+(result.clients || []).filter(c => c.connected).length+' connected');
    $('#extdir').value=result.extension_dir || '';
    renderBrowsers(result);
    if (!dirty) {state=P.normalizePolicy(result.policy);base=structuredClone(state);render();}
  } catch(e) {
    const clientMissing=e.code==='NODE_UNAVAILABLE'||e.message===T.timeout||e.name==='TypeError';
    $('#status').textContent=T.failed;
    connectionState(clientMissing ? 'client-missing' : 'error');
    hint(clientMissing ? T.timeout : e.message,true);
  }
  finally {checking=false;$('#refresh').disabled=false;}
}
for (const kind of ['interact','read']) {
  $('#'+kind+'-add').onclick = () => {
    if (!state || busy) return;
    try {
      const value = P.normalizeHost($('#'+kind+'-input').value);
      const list = kind === 'interact' ? state.interact.allow : state.read.block;
      if (!list.includes(value)) {list.push(value);changed();}
      $('#'+kind+'-input').value='';
    } catch(e) {hint(e.message,true);}
  };
  $('#'+kind+'-input').onkeydown = e => {if(e.key==='Enter') $('#'+kind+'-add').click();};
}
$('#save').onclick = async () => {
  if (!dirty || busy) return;
  busy=true;render();hint(T.saving);
  try {
    const result = await rpc('save-request',{policy:state,base});
    if (result.ok) {
      state=P.normalizePolicy(result.policy);base=structuredClone(state);dirty=false;hint(result.warning === 'REVOCATION_UNCONFIRMED' ? T.savedUncertain : T.saved);
    } else if (result.saved && result.policy) {
      state=P.normalizePolicy(result.policy);base=structuredClone(state);dirty=false;hint(result.message || T.failed,true);
    } else throw new Error(result.message || T.failed);
  } catch(e) {hint(e.message,true);}
  finally {busy=false;render();}
};
$('#copy').onclick = async () => {
  if (!$('#extdir').value) return;
  try {await navigator.clipboard.writeText($('#extdir').value);hint(T.copied);}
  catch {$('#extdir').focus();$('#extdir').select();hint(T.copyFallback);}
};
function renderBrowsers(result) {
  const target=$('#browsers');target.replaceChildren();
  for (const item of result.installation?.browsers || []) {
    const live=(result.clients || []).some(c => c.browser === item.browser && c.connected);
    // A disconnected browser card is actionable only when this device has the
    // browser installed and the catalog provides a published store route.
    // Developer loading stays in the explicit fallback section below.
    if (!item.supported || (!live && (!item.installed || !item.published))) continue;
    const card=document.createElement('div');card.className='browser-card';
    const name=document.createElement('strong');name.textContent={chrome:'Chrome',edge:'Edge',safari:'Safari'}[item.browser];
    const mode='store';
    const status=document.createElement('p');status.textContent=live ? T.connected : mode === 'store' ? T.install : T.developer;
    const button=document.createElement('button');button.textContent=live ? '✓ '+T.connected : T.install;
    button.disabled=setupBusy || live;
    button.onclick=() => setup(item.browser,mode);card.prepend(name,status);card.append(button);target.append(card);
  }
  const profiles=$('#profiles');profiles.replaceChildren();
  for (const client of result.clients || []) {
    const row=document.createElement('div');row.className='profile';
    const label=document.createElement('span');label.textContent=client.browser+' · '+client.id.slice(0,8)+(client.version?' · v'+client.version:'');row.append(label);
    const [major,minor,patch]=(client.version||'0.0.0').split('.').map(Number);
    const supportsNative=major>0 || minor>4 || (minor===4 && patch>=16);
    const status=document.createElement('span');status.textContent=client.connected ? T.connected : client.identitySupported === false ? T.unsupportedIdentity : result.nativeBinding === 'unavailable' ? T.nativeUnavailable : client.nativeBindingRequired && !supportsNative ? T.nativeRequired : T.checking;row.append(status);
    profiles.append(row);
  }
}
async function setup(browser,mode) {
  if (setupBusy) return;setupBusy=true;
  try {const result=await rpc('install-request',{browser,mode});$('#install-hint').textContent=result.ok ? T.confirming : result.error === 'BROWSER_NOT_INSTALLED' ? T.missing : result.error === 'SIGNATURE_REQUIRED' ? result.message : T.openUnknown;}
  catch(e) {$('#install-hint').textContent=e.message;}
  finally {setupBusy=false;await refresh();}
}
$('#dev-open').onclick=()=>setup($('#dev-browser').value,'developer');
$('#dev-reload').onclick=()=>setup($('#dev-browser').value,'reload');
$('#refresh').onclick=refresh;
// Local status polling, not LLM calls. Never auto-replays an install or browser operation.
setInterval(()=>{if (!document.hidden && !setupBusy) refresh();},5000);
(async () => {
  try {const r=await (await fetch('/app-context')).json();T=STRINGS[r.context?.locale] || STRINGS.en;} catch {T=STRINGS.en;}
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent=T[el.dataset.i18n] || '';
  for (const el of document.querySelectorAll('[data-i18n-ph]')) el.placeholder=T[el.dataset.i18nPh] || '';
  await refresh();
})();
