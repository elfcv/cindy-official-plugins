'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const nodemailer = require('nodemailer');
const { simpleParser } = require('mailparser');
const { createHash } = require('node:crypto');
const { performAction, createRuntimeDeps } = require('../src/worker.cjs');
const credentials = { email: 'test@example.com', authorizationCode: 'test-only-not-a-secret' };
const base = { action: 'send', to: 'test@example.com', subject: '附件测试', body_text: '测试正文' };
const hash = b => createHash('sha256').update(b).digest('hex');
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-mail-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
function smtpCapture() {
  let source, calls = 0;
  const composer = nodemailer.createTransport({ streamTransport: true, buffer: true });
  return {
    get source() { return source; }, get calls() { return calls; },
    deps: { createSmtp: () => ({ sendMail: async options => {
      calls++; source = (await composer.sendMail(options)).message;
      return { messageId: 'test', accepted: ['test@example.com'], rejected: [] };
    }, close() {} }) },
  };
}
test('send round-trips Unicode names, empty files and >256 KiB binary through real MIME', async t => {
  const dir = await fixture(t);
  const files = [['中文附件.txt', Buffer.from('中文内容\n')], ['binary.bin', Buffer.alloc(300*1024, 0xa5)], ['empty.txt', Buffer.alloc(0)]];
  for (const [name, bytes] of files) await fs.writeFile(path.join(dir, name), bytes);
  const capture = smtpCapture();
  const result = await performAction(credentials, { ...base, attachment_paths: files.map(([name]) => path.join(dir, name)) }, capture.deps);
  const parsed = await simpleParser(capture.source);
  assert.equal(parsed.attachments.length, files.length);
  parsed.attachments.forEach((a, i) => { assert.equal(a.filename, files[i][0]); assert.deepEqual(a.content, files[i][1]); });
  assert.deepEqual(result.attachments.map(a => a.sha256), files.map(([,b])=>hash(b)));
  assert.ok(!JSON.stringify(result).includes(dir));
});
test('plain mail stays plain without attachments', async () => {
  const capture = smtpCapture();
  await performAction(credentials, base, capture.deps);
  assert.equal((await simpleParser(capture.source)).attachments.length, 0);
});
test('invalid, missing, directory and oversized attachments fail before SMTP sending', async t => {
  const dir = await fixture(t);
  const large = path.join(dir, 'large.bin');
  await fs.writeFile(large, Buffer.alloc(32*1024*1024+1));
  for (const paths of [['relative.txt'], ['https://example.com/file'], [path.join(dir,'missing')], [dir], [large], Array(11).fill(large), 'not-an-array']) {
    const capture = smtpCapture();
    await assert.rejects(performAction(credentials, { ...base, attachment_paths: paths }, capture.deps));
    assert.equal(capture.calls,0);
  }
});
test('total size limit is enforced across multiple files', async t => {
  const dir = await fixture(t);
  const file = path.join(dir,'seventeen.bin'); await fs.writeFile(file,Buffer.alloc(17*1024*1024));
  const capture=smtpCapture();
  await assert.rejects(performAction(credentials,{...base,attachment_paths:[file,file]},capture.deps));
  assert.equal(capture.calls,0);
});
test('draft uses the same MIME attachment path', async t => {
  const dir = await fixture(t), file = path.join(dir,'draft.txt'); await fs.writeFile(file,'draft');
  let appended;
  const client = { connect:async()=>{}, logout:async()=>{}, list:async()=>[{path:'Drafts',specialUse:'\\Drafts'}], append:async(folder,bytes)=>{appended=bytes;return {uid:7};} };
  const result = await performAction(credentials,{...base,action:'draft',attachment_paths:[file]}, { ...createRuntimeDeps(),createImap:()=>client });
  assert.equal(result.draft,true);
  assert.equal((await simpleParser(appended)).attachments[0].content.toString(),'draft');
});
test('main passes paths and current callId to worker without passing attachment bytes', async () => {
  let handler, request, response;
  const context = { Map, setTimeout, fetch: async url=>({ok:true,json:async()=>url==='/kv'?{email:'test@example.com'}:[{key:'qq_mail_authorization_code',saved:true}]}), cindy: {
    onHostMessage: fn=>{handler=fn;},node:{request:async r=>{request=r;return {ok:true,result:{sent:true}};}},send: async r=>{response=r;},
  }};
  vm.runInNewContext(await fs.readFile(path.join(__dirname,'../main.js'),'utf8'),context);
  handler({type:'tool-call',tool:'qq_mail',callId:'current-call',args:{...base,attachment_paths:['/tmp/test.txt']}});
  for(let i=0;i<20&&!response;i++) await new Promise(r=>setImmediate(r));
  assert.equal(response.ok,true);
  assert.deepEqual(Array.from(request.params.action.attachment_paths),['/tmp/test.txt']);
  assert.equal(request.callId,'current-call'); assert.equal(request.cancelWithCall,true);
});
test('connect verifies saved secret before persisting email, and keeps configuration on failure', async () => {
  for (const success of [true,false]) {
    let handler, response, request, written;
    const context={Map,setTimeout,fetch:async(url,options)=>{
      if(options?.method==='PUT'){written=JSON.parse(options.body);return {ok:true};}
      return {ok:true,json:async()=>({untouched:'keep'})};
    },cindy:{onHostMessage:fn=>{handler=fn;},node:{request:async r=>{request=r;return success?{ok:true,result:{connected:true,email:'test@example.com'}}:{ok:false,message:'connection failed'};}},send:async r=>{response=r;}}};
    vm.runInNewContext(await fs.readFile(path.join(__dirname,'../main.js'),'utf8'),context);
    handler({type:'tool-call',tool:'qq_mail_connect',callId:'connect-call',args:{email:'test@example.com'}});
    for(let i=0;i<20&&!response;i++)await new Promise(r=>setImmediate(r));
    assert.equal(response.ok,success);
    assert.equal(request?.method,'account/connect');
    assert.equal(request?.callId,'connect-call');
    assert.deepEqual(JSON.parse(JSON.stringify(request.params)),{email:'test@example.com'});
    assert.deepEqual(written,success?{untouched:'keep',email:'test@example.com'}:undefined);
  }
});
test('32 MiB boundary survives MIME encoding and plugin readback', async t => {
  const { Readable } = require('node:stream');
  const dir=await fixture(t), file=path.join(dir,'large-32MiB.bin');
  const bytes=Buffer.alloc(32*1024*1024,0xa7);
  await fs.writeFile(file,bytes);
  const capture=smtpCapture();
  const sent=await performAction(credentials,{...base,attachment_paths:[file]},capture.deps);
  assert.equal(sent.attachments[0].size,bytes.length);
  assert.ok(capture.source.length>12*1024*1024);
  assert.ok(capture.source.length<48*1024*1024);
  const client={connect:async()=>{},logout:async()=>{},getMailboxLock:async()=>({release(){}}),
    fetchOne:async()=>({uid:1,size:capture.source.length}),
    download:async()=>({meta:{expectedSize:capture.source.length},content:Readable.from([capture.source])})};
  const read=await performAction(credentials,{action:'read',folder:'INBOX',message_uid:1},
    {...createRuntimeDeps(),createImap:()=>client});
  assert.equal(read.attachments[0].sha256,hash(bytes));
  assert.equal(read.attachments[0].size,bytes.length);
});

test('worker distinguishes rejected attachment input from ambiguous SMTP failure', async () => {
  const { handleRequest } = require('../src/worker.cjs');
  const request = action => ({ method: 'mail/action', params: { email: credentials.email, action }, cindy: { secrets: { qq_mail_authorization_code: 'dummy-test-code' } } });
  await assert.rejects(handleRequest(request({ ...base, attachment_paths: ['relative.txt'] }), {}), error => error.executionState === 'not_executed');
  await assert.rejects(handleRequest(request(base), { createSmtp: () => ({ sendMail: async () => { throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }); }, close() {} }) }), error => {
    assert.equal(error.executionState, 'unknown');
    assert.match(error.message, /核对/);
    assert.doesNotMatch(error.message, /后重试|稍后重试/);
    return true;
  });
});

test('host timeouts on send are unknown and never invite blind retries', async () => {
  let handler, response;
  const context = { Map, setTimeout, fetch: async url => ({ ok: true, json: async () => url === '/kv' ? { email: credentials.email } : [{ key: 'qq_mail_authorization_code', saved: true }] }), cindy: {
    onHostMessage: fn => { handler = fn; }, node: { request: async () => ({ ok: false, errorCode: 'TIMEOUT', message: '请求超时，请重试' }) }, send: async r => { response = r; },
  } };
  vm.runInNewContext(await fs.readFile(path.join(__dirname, '../main.js'), 'utf8'), context);
  handler({ type: 'tool-call', tool: 'qq_mail', callId: 'timeout-call', args: base });
  for (let i = 0; i < 20 && !response; i++) await new Promise(r => setImmediate(r));
  assert.equal(response.ok, false);
  assert.match(response.message, /结果不确定/);
  assert.doesNotMatch(response.message, /请重试/);
});
