'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const vm = require('node:vm');
const { performAction, buildSearchCriteria } = require('../src/worker.cjs');
const credentials = { email: 'owner@example.test', authorizationCode: 'test-only-not-a-secret' };
const day = { action: 'search', since: '2026-10-23', before: '2026-10-24', max_results: 20 };
function mail(uid, overrides = {}) {
  return { uid, envelope: { date: new Date('2026-10-23T08:00:00+08:00'), subject: '账户通知',
    from: [{ name: '银行客服', address: 'Alerts@Bank.test' }], to: [{ address: 'Owner@Example.test' }] },
    internalDate: new Date('2026-10-23T08:00:00+08:00'), flags: new Set(), size: 400, ...overrides };
}
function fixture(rows, options = {}) {
  const state = { rows, validity: '12345', queries: [], fetches: [], released: 0, logout: 0 };
  const client = { mailbox: { get uidValidity() { return state.validity; } },
    connect: async () => {}, logout: async () => { state.logout++; }, close() {},
    getMailboxLock: async () => ({ release() { state.released++; } }),
    search: async (query, opts) => { state.queries.push(query); assert.deepEqual(opts, { uid: true });
      assert.equal(query.from, undefined); assert.equal(query.to, undefined); assert.equal(query.subject, undefined);
      assert.equal(query.seen === undefined || typeof query.seen === 'boolean', true);
      if (options.serverSeenFilter && typeof query.seen === 'boolean') {
        return state.rows.filter(row => row.flags.has('\\Seen') === query.seen).map(row => row.uid);
      }
      return options.found || state.rows.map(row => row.uid).reverse(); },
    fetchAll: async (uids, query, opts) => { state.fetches.push(uids); assert.deepEqual(opts, { uid: true });
      assert.deepEqual(query, { uid: true, envelope: true, flags: true, internalDate: true, size: true });
      return state.rows.filter(row => uids.includes(row.uid) && row.uid !== options.omitUid); },
  };
  return { state, run: (action = day, creds = credentials) => performAction(creds, action, { createImap: () => client }) };
}
test('36-message day is completely enumerable across 20/16 pages', async () => {
  const f = fixture(Array.from({ length: 36 }, (_, i) => mail(i * 3 + 10)));
  const a = await f.run(); const b = await f.run({ ...day, page_token: a.next_page_token });
  assert.deepEqual([a.total, a.returned, a.has_more, b.total, b.returned, b.has_more], [36, 20, true, 36, 16, false]);
  assert.equal(new Set([...a.messages, ...b.messages].map(m => m.uid)).size, 36);
  assert.equal(b.next_page_token, null); assert.equal(a.coverage_complete, true); assert.equal(b.coverage_complete, true);
  assert.equal(f.state.released, 2); assert.equal(f.state.logout, 2);
});
test('28 unread messages are available across two pages without changing flags', async () => {
  const f = fixture(Array.from({ length: 36 }, (_, i) => mail(i + 1, { flags: new Set(i < 8 ? ['\\Seen'] : []) })));
  const a = await f.run({ ...day, unread: true });
  const b = await f.run({ ...day, unread: true, page_token: a.next_page_token });
  assert.deepEqual([a.total, a.returned, b.returned, b.has_more], [28, 20, 8, false]);
  assert.equal(f.state.rows.filter(row => row.flags.has('\\Seen')).length, 8);
  assert.equal(f.state.queries[0].seen, false);
});
test('undated unread search prefilters flags in a mailbox larger than the scan cap', async () => {
  const f = fixture(Array.from({ length: 10025 }, (_, i) => mail(i + 1,
    { flags: new Set(i < 10000 ? ['\\Seen'] : []) })), { serverSeenFilter: true });
  const query = { action: 'search', unread: true, max_results: 20 };
  const a = await f.run(query); const b = await f.run({ ...query, page_token: a.next_page_token });
  assert.deepEqual([a.total, a.returned, b.returned, b.has_more], [25, 20, 5, false]);
  assert.equal(a.coverage_complete, true); assert.equal(b.coverage_complete, true);
  assert.equal(f.state.queries[0].seen, false);
  assert.equal(f.state.fetches.flat().some(uid => uid <= 10000), false);
  const seen = await f.run({ action: 'search', unread: false, max_results: 20 });
  assert.equal(f.state.queries.at(-1).seen, true); assert.equal(seen.total, 10000);
  assert.equal(f.state.rows.filter(row => row.flags.has('\\Seen')).length, 10000);
});
test('new arrivals do not shift or duplicate the next page', async () => {
  const f = fixture(Array.from({ length: 36 }, (_, i) => mail(i + 1)));
  const a = await f.run(); f.state.rows.push(mail(100));
  const b = await f.run({ ...day, page_token: a.next_page_token });
  assert.equal(b.total, 36); assert.equal(b.messages.some(m => m.uid === 100), false);
  assert.deepEqual(b.messages.map(m => m.uid), Array.from({ length: 16 }, (_, i) => 16 - i));
});
test('cursor survives deletion without offset-related skipped messages', async () => {
  const f = fixture(Array.from({ length: 36 }, (_, i) => mail(i + 1)));
  const a = await f.run(); f.state.rows = f.state.rows.filter(row => row.uid !== 35);
  const b = await f.run({ ...day, page_token: a.next_page_token });
  assert.deepEqual(b.messages.map(m => m.uid), Array.from({ length: 16 }, (_, i) => 16 - i));
});
test('page token is bound to account, folder, filters and UIDVALIDITY', async () => {
  const f = fixture(Array.from({ length: 25 }, (_, i) => mail(i + 1))); const a = await f.run();
  for (const action of [{ ...day, folder: 'Junk' }, { ...day, from: 'Bank' }, { ...day, since: '2026-10-22' }]) {
    await assert.rejects(f.run({ ...action, page_token: a.next_page_token }), /INVALID_PAGE_TOKEN/);
  }
  await assert.rejects(f.run({ ...day, page_token: a.next_page_token }, { ...credentials, email: 'other@example.test' }), /INVALID_PAGE_TOKEN/);
  f.state.validity = '999';
  await assert.rejects(f.run({ ...day, page_token: a.next_page_token }), /PAGE_TOKEN_MAILBOX_CHANGED/);
});
test('invalid cursors fail instead of silently restarting at the first page', async () => {
  const f = fixture([mail(1)]);
  for (const page_token of ['', 'not-json', '!', 'a'.repeat(1025)]) await assert.rejects(f.run({ ...day, page_token }), /INVALID_PAGE_TOKEN/);
});
test('UTC+8 day boundaries include start, exclude end and use received time', async () => {
  const dates = ['2026-10-22T15:59:59.999Z', '2026-10-22T16:00:00.000Z', '2026-10-23T15:59:59.999Z', '2026-10-23T16:00:00.000Z'];
  const f = fixture(dates.map((date, i) => mail(i + 1, { internalDate: new Date(date) })));
  const a = await f.run(); assert.deepEqual(a.messages.map(m => m.uid), [3, 2]);
  assert.equal(a.total, 2); assert.equal(a.date_basis, 'received_at');
  assert.equal(a.messages[1].received_at, dates[1]);
});
test('AM and PM queries are disjoint even if the server returns the whole day', async () => {
  const f = fixture([mail(1), mail(2, { internalDate: new Date('2026-10-23T13:00:00+08:00') })]);
  const am = await f.run({ ...day, before: '2026-10-23T12:00:00+08:00' });
  const pm = await f.run({ ...day, since: '2026-10-23T12:00:00+08:00' });
  assert.deepEqual(am.messages.map(m => m.uid), [1]); assert.deepEqual(pm.messages.map(m => m.uid), [2]);
});
test('case-insensitive decoded header filters are local and counted before pagination', async () => {
  const rows = Array.from({ length: 50 }, (_, i) => mail(i + 1, { envelope: { subject: i < 25 ? '香港管理費' : '广告',
    from: [{ name: '銀行', address: 'ALERTS@BANK.TEST' }], to: [{ address: 'Owner@Example.test' }] } }));
  const f = fixture(rows); const query = { ...day, from: '銀行', to: 'owner@example.test', subject: '管理費' };
  const a = await f.run(query); const b = await f.run({ ...query, page_token: a.next_page_token });
  assert.deepEqual([a.total, a.returned, b.returned], [25, 20, 5]); assert.equal(b.has_more, false);
});
test('metadata keyword search does not download bodies or trust server keyword search', async () => {
  const f = fixture([mail(1)]); const a = await f.run({ ...day, text: '账户', text_scope: 'metadata' });
  assert.equal(a.total, 1); assert.equal(a.coverage_complete, true); assert.equal(f.state.queries[0].or, undefined);
});
test('full text zero matches explicitly remains an unverified server result', async () => {
  const f = fixture([]); const a = await f.run({ ...day, text: 'tax' });
  assert.equal(a.total, 0); assert.equal(a.coverage_complete, false); assert.equal(a.total_is_exact, false);
  assert.match(a.search_warning, /可能漏搜/);
});
test('metadata fetch omissions and absent received dates never look complete', async () => {
  const f = fixture([mail(1), mail(2)], { omitUid: 2 }); const a = await f.run();
  assert.equal(a.coverage_complete, false); assert.equal(a.missing_metadata_count, 1);
  const b = await fixture([mail(1, { internalDate: undefined })]).run();
  assert.equal(b.coverage_complete, false); assert.equal(b.missing_date_count, 1);
});
test('malformed INTERNALDATE leaves the rest of a date-filtered page usable but incomplete', async () => {
  const f = fixture([mail(1), mail(2, { internalDate: 'unparseable INTERNALDATE' }),
    mail(3, { internalDate: new Date(NaN), envelope: { date: 'invalid Date header' } })]);
  const a = await f.run();
  assert.deepEqual(a.messages.map(m => m.uid), [1]);
  assert.equal(a.missing_date_count, 2); assert.equal(a.coverage_complete, false);
  assert.equal(a.total_is_exact, false);
  const latest = await f.run({ action: 'search', max_results: 20 });
  assert.equal(latest.messages.find(m => m.uid === 2).received_at, null);
  assert.equal(latest.messages.find(m => m.uid === 2).date, '2026-10-23T00:00:00.000Z');
  assert.equal(latest.messages.find(m => m.uid === 3).date, null);
});
test('bounded metadata scan refuses excess coverage; latest mail remains cheap', async () => {
  const found = Array.from({ length: 10001 }, (_, i) => i + 1);
  const f = fixture([mail(10001)], { found });
  await assert.rejects(f.run(), /SEARCH_TOO_BROAD/); assert.equal(f.state.fetches.length, 0);
  const a = await f.run({ action: 'search', max_results: 1 });
  assert.equal(a.total, 10001); assert.equal(a.returned, 1); assert.equal(f.state.fetches[0].length, 1);
});
test('invalid dates/ranges are rejected before connecting', () => {
  for (const action of [{ ...day, since: '2026-02-30' }, { ...day, since: '2026-10-23T08:00:00' },
    { ...day, since: '2026-13-01' }, { ...day, since: '2026-02-30T00:00:00+08:00' },
    { ...day, before: '2026-10-22' }, { ...day, text_scope: 'unknown' }]) assert.throws(() => buildSearchCriteria(action));
});
test('real IMAP compiler uses padded date strings instead of relative WITHIN seconds', () => {
  const { searchCompiler } = require('imapflow/lib/search-compiler');
  const query = buildSearchCriteria(day);
  assert.equal(typeof query.since, 'string'); assert.equal(typeof query.before, 'string');
  const compiled = searchCompiler({ capabilities: new Set(['WITHIN']), mailbox: { flags: new Set() } }, query);
  const wire = JSON.stringify(compiled);
  assert.match(wire, /SINCE/); assert.match(wire, /BEFORE/); assert.doesNotMatch(wire, /YOUNGER|OLDER/);
});
test('main forwards pagination and scope through the call-scoped worker path', async () => {
  let handler, request, response;
  const context = { Map, setTimeout, fetch: async url => ({ ok: true, json: async () => url === '/kv'
    ? { email: credentials.email } : [{ key: 'qq_mail_authorization_code', saved: true }] }),
    cindy: { onHostMessage: fn => { handler = fn; }, node: { request: async r => { request = r; return { ok: true }; } }, send: async r => { response = r; } } };
  vm.runInNewContext(await fs.readFile(require.resolve('../main.js'), 'utf8'), context);
  handler({ type: 'tool-call', tool: 'qq_mail', callId: 'search-call', args: { ...day, page_token: 'token', text_scope: 'metadata' } });
  for (let i = 0; i < 30 && !response; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(response.ok, true); assert.equal(request.params.action.page_token, 'token');
  assert.equal(request.params.action.text_scope, 'metadata'); assert.equal(request.callId, 'search-call');
  assert.equal(request.cancelWithCall, true); assert.equal(request.timeoutMs, 120000);
});
