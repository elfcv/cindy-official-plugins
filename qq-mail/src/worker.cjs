'use strict';

const readline = require('node:readline');
const fs = require('node:fs/promises');
const { constants: fsConstants } = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { ImapFlow } = require('imapflow');
const nodemailer = require('nodemailer');
const { simpleParser } = require('mailparser');

const QQ = Object.freeze({
  imapHost: 'imap.qq.com',
  imapPort: 993,
  smtpHost: 'smtp.qq.com',
  smtpPort: 465,
});

const MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024;
const MAX_ATTACHMENTS = 10;
const MAX_BODY_CHARS = 20000;
const MAX_SOURCE_BYTES = 48 * 1024 * 1024;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SECRET_KEY = 'qq_mail_authorization_code';

function normalizeCredentials(value) {
  const input = value && typeof value === 'object' ? value : {};
  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
  const authorizationCode = typeof input.authorizationCode === 'string'
    ? input.authorizationCode.replace(/\s+/g, '').trim()
    : '';
  if (!EMAIL_RE.test(email) || email.length > 254) throw new Error('INVALID_EMAIL');
  if (
    authorizationCode.length < 8
    || authorizationCode.length > 128
    || /[\r\n\0]/.test(authorizationCode)
  ) {
    throw new Error('INVALID_AUTHORIZATION_CODE');
  }
  return { email, authorizationCode };
}

/**
 * 读取宿主为本次 JSON-RPC 请求临时注入的凭证。该字段不来自插件 main.js，
 * 只有 ghost.json 绑定的方法才能收到；取出后立即清掉请求对象中的引用。
 */
function consumeRequestCredentials(request) {
  const params = request.params && typeof request.params === 'object' ? request.params : {};
  const cindy = request.cindy && typeof request.cindy === 'object' ? request.cindy : {};
  const secrets = cindy.secrets && typeof cindy.secrets === 'object' ? cindy.secrets : {};
  const rawCode = secrets[SECRET_KEY];
  secrets[SECRET_KEY] = '';
  return normalizeCredentials({
    email: params.email,
    authorizationCode: rawCode,
  });
}

function normalizeRecipients(value, required) {
  let items = [];
  if (Array.isArray(value)) items = value;
  else if (typeof value === 'string') items = value.split(',');
  const normalized = items.map((entry) => String(entry).trim()).filter(Boolean);
  if (required && normalized.length === 0) throw new Error('RECIPIENT_REQUIRED');
  if (normalized.length > 50 || normalized.some((entry) => !EMAIL_RE.test(entry))) {
    throw new Error('INVALID_RECIPIENT');
  }
  return normalized;
}

function parseSearchDate(value, field) {
  if (value === undefined) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`INVALID_${field.toUpperCase()}`);
  return date;
}

function buildSearchCriteria(action) {
  const criteria = {};
  if (typeof action.from === 'string' && action.from.trim()) criteria.from = action.from.trim();
  if (typeof action.to === 'string' && action.to.trim()) criteria.to = action.to.trim();
  if (typeof action.subject === 'string' && action.subject.trim()) criteria.subject = action.subject.trim();
  if (typeof action.unread === 'boolean') criteria.seen = !action.unread;
  const since = parseSearchDate(action.since, 'since');
  const before = parseSearchDate(action.before, 'before');
  if (since) criteria.since = since;
  if (before) criteria.before = before;
  if (typeof action.text === 'string' && action.text.trim()) {
    const text = action.text.trim();
    criteria.or = [
      { subject: text },
      { from: text },
      { to: text },
      { body: text },
    ];
  }
  if (Object.keys(criteria).length === 0) criteria.all = true;
  return criteria;
}

function addressText(value) {
  if (!Array.isArray(value)) return '';
  return value.map((entry) => {
    const address = entry && entry.address ? String(entry.address) : '';
    const name = entry && entry.name ? String(entry.name) : '';
    return name && address ? `${name} <${address}>` : address || name;
  }).filter(Boolean).join(', ');
}

function flagsArray(flags) {
  return flags && typeof flags[Symbol.iterator] === 'function' ? Array.from(flags) : [];
}

function summaryFromMessage(message, folder) {
  const envelope = message.envelope || {};
  const flags = flagsArray(message.flags);
  return {
    uid: message.uid,
    folder,
    from: addressText(envelope.from),
    to: addressText(envelope.to),
    subject: envelope.subject || '',
    date: (envelope.date || message.internalDate || null)
      ? new Date(envelope.date || message.internalDate).toISOString()
      : null,
    unread: !flags.includes('\\Seen'),
    flagged: flags.includes('\\Flagged'),
    size: Number.isFinite(message.size) ? message.size : null,
  };
}

function imapOptions(credentials) {
  return {
    host: QQ.imapHost,
    port: QQ.imapPort,
    secure: true,
    auth: {
      user: credentials.email,
      pass: credentials.authorizationCode,
    },
    disableAutoIdle: true,
    emitLogs: false,
    logger: false,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
  };
}

function smtpOptions(credentials) {
  return {
    host: QQ.smtpHost,
    port: QQ.smtpPort,
    secure: true,
    pool: false,
    auth: {
      user: credentials.email,
      pass: credentials.authorizationCode,
    },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
    disableFileAccess: true,
    disableUrlAccess: true,
  };
}

function createRuntimeDeps() {
  return {
    createImap(credentials) {
      return new ImapFlow(imapOptions(credentials));
    },
    createSmtp(credentials) {
      return nodemailer.createTransport(smtpOptions(credentials));
    },
    createComposer() {
      return nodemailer.createTransport({
        streamTransport: true,
        buffer: true,
        newline: 'windows',
      });
    },
    parseMessage(source) {
      return simpleParser(source, {
        keepCidLinks: true,
        skipHtmlToText: false,
        skipTextToHtml: true,
        maxHtmlLengthToParse: 2 * 1024 * 1024,
      });
    },
  };
}

async function withImap(credentials, deps, operation) {
  const client = deps.createImap(credentials);
  let connected = false;
  try {
    await client.connect();
    connected = true;
    return await operation(client);
  } finally {
    if (connected) {
      try {
        await client.logout();
      } catch (_error) {
        try {
          client.close();
        } catch (_closeError) {
          // 连接已在关闭，忽略。
        }
      }
    } else {
      try {
        client.close();
      } catch (_error) {
        // 尚未连通，无需额外处理。
      }
    }
  }
}

async function withMailbox(client, folder, operation) {
  let lock;
  try {
    lock = await client.getMailboxLock(folder);
    return await operation();
  } finally {
    if (lock) lock.release();
  }
}

async function listFolders(credentials, deps) {
  return withImap(credentials, deps, async (client) => {
    const folders = await client.list();
    return {
      folders: folders.map((folder) => ({
        path: folder.path,
        name: folder.name || folder.path,
        delimiter: folder.delimiter || null,
        special_use: folder.specialUse || null,
        selectable: !(folder.flags && folder.flags.has && folder.flags.has('\\Noselect')),
      })),
    };
  });
}

async function search(credentials, action, deps) {
  const folder = action.folder || 'INBOX';
  const maxResults = Number.isInteger(action.max_results)
    ? Math.min(20, Math.max(1, action.max_results))
    : 10;
  return withImap(credentials, deps, (client) => withMailbox(client, folder, async () => {
    const uids = await client.search(buildSearchCriteria(action), { uid: true });
    const selected = uids.slice(-maxResults).reverse();
    if (selected.length === 0) return { folder, total: 0, messages: [] };
    const messages = await client.fetchAll(
      selected,
      { uid: true, envelope: true, flags: true, internalDate: true, size: true },
      { uid: true },
    );
    const byUid = new Map(messages.map((message) => [message.uid, message]));
    return {
      folder,
      total: uids.length,
      messages: selected.map((uid) => byUid.get(uid)).filter(Boolean)
        .map((message) => summaryFromMessage(message, folder)),
    };
  }));
}

async function readMessage(credentials, action, deps) {
  const folder = action.folder || 'INBOX';
  return withImap(credentials, deps, (client) => withMailbox(client, folder, async () => {
    const message = await client.fetchOne(
      action.message_uid,
      { uid: true, envelope: true, flags: true, internalDate: true, size: true },
      { uid: true },
    );
    if (!message) throw new Error('MESSAGE_NOT_FOUND');
    if (Number.isFinite(message.size) && message.size > MAX_SOURCE_BYTES) {
      throw new Error('MESSAGE_TOO_LARGE');
    }

    const downloaded = await client.download(
      action.message_uid,
      undefined,
      { uid: true, maxBytes: MAX_SOURCE_BYTES + 1 },
    );
    if (!downloaded || !downloaded.content) throw new Error('MESSAGE_NOT_FOUND');
    if (
      downloaded.meta
      && Number.isFinite(downloaded.meta.expectedSize)
      && downloaded.meta.expectedSize > MAX_SOURCE_BYTES
    ) {
      downloaded.content.destroy();
      throw new Error('MESSAGE_TOO_LARGE');
    }

    const chunks = [];
    let sourceBytes = 0;
    for await (const chunk of downloaded.content) {
      sourceBytes += chunk.length;
      if (sourceBytes > MAX_SOURCE_BYTES) {
        downloaded.content.destroy();
        throw new Error('MESSAGE_TOO_LARGE');
      }
      chunks.push(chunk);
    }
    const parsed = await deps.parseMessage(Buffer.concat(chunks, sourceBytes));
    const text = typeof parsed.text === 'string' && parsed.text.trim()
      ? parsed.text
      : typeof parsed.html === 'string'
        ? parsed.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
        : '';
    return {
      ...summaryFromMessage(message, folder),
      cc: parsed.cc && parsed.cc.text ? parsed.cc.text : '',
      reply_to: parsed.replyTo && parsed.replyTo.text ? parsed.replyTo.text : '',
      message_id: parsed.messageId || '',
      body_text: text.length > MAX_BODY_CHARS
        ? `${text.slice(0, MAX_BODY_CHARS)}\n…（正文过长，已截断）`
        : text,
      attachments: Array.isArray(parsed.attachments)
        ? parsed.attachments.map((attachment) => ({
            filename: attachment.filename || null,
            content_type: attachment.contentType || null,
            size: Number.isFinite(attachment.size) ? attachment.size : null,
            sha256: Buffer.isBuffer(attachment.content)
              ? createHash('sha256').update(attachment.content).digest('hex') : null,
          }))
        : [],
    };
  }));
}

function mailOptions(credentials, action) {
  const to = normalizeRecipients(action.to, true);
  const cc = normalizeRecipients(action.cc, false);
  const bcc = normalizeRecipients(action.bcc, false);
  if (typeof action.subject !== 'string' || /[\r\n\0]/.test(action.subject)) {
    throw new Error('INVALID_SUBJECT');
  }
  if (typeof action.body_text !== 'string') throw new Error('INVALID_BODY');
  if (action.subject.length > 998 || action.body_text.length > 500000) {
    throw new Error('MESSAGE_TOO_LARGE');
  }
  return {
    from: credentials.email,
    to,
    ...(cc.length ? { cc } : {}),
    ...(bcc.length ? { bcc } : {}),
    subject: action.subject,
    text: action.body_text,
    disableFileAccess: true,
    disableUrlAccess: true,
  };
}

// Classify at the filesystem boundary, not by an incomplete errno list or
// provider-oriented message matching (e.g. ELOOP contains "too many").
async function attachmentFileOperation(operation) {
  try {
    return await operation();
  } catch {
    throw new Error('ATTACHMENT_UNREADABLE');
  }
}

// Only the explicitly supplied local paths are read. Attachment bytes never enter
// Agent parameters or RPC; Nodemailer receives bounded buffers, not file/URL access.
async function prepareMailOptions(credentials, action) {
  const options = mailOptions(credentials, action);
  if (action.attachment_paths === undefined) return options;
  const paths = action.attachment_paths;
  if (!Array.isArray(paths) || paths.length > MAX_ATTACHMENTS || paths.some(file =>
    typeof file !== 'string' || !path.isAbsolute(file) || /[\r\n\0]/.test(file))) {
    throw new Error('INVALID_ATTACHMENT_PATHS');
  }
  let total = 0;
  const attachments = [];
  for (const file of paths) {
    let handle;
    try {
      // Nonblocking open lets the subsequent fstat reject FIFOs/devices safely.
      handle = await attachmentFileOperation(() => fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK || 0)));
      const stat = await attachmentFileOperation(() => handle.stat());
      if (!stat.isFile()) throw new Error('ATTACHMENT_NOT_FILE');
      const remaining = MAX_ATTACHMENT_BYTES - total;
      if (stat.size > remaining) throw new Error('ATTACHMENTS_TOO_LARGE');
      // Bound the read even if another process grows the file after fstat.
      const buffer = Buffer.alloc(Math.min(64 * 1024, remaining + 1));
      const chunks = [];
      let length = 0;
      while (true) {
        const { bytesRead } = await attachmentFileOperation(() => handle.read(buffer, 0, Math.min(buffer.length, remaining - length + 1), null));
        if (bytesRead === 0) break;
        length += bytesRead;
        if (length > remaining) throw new Error('ATTACHMENTS_TOO_LARGE');
        chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
      }
      const content = Buffer.concat(chunks, length);
      total += length;
      attachments.push({ filename: path.basename(file), content });
    } finally {
      if (handle) await attachmentFileOperation(() => handle.close());
    }
  }
  if (attachments.length) options.attachments = attachments;
  return options;
}

function attachmentSummary(options) {
  return (options.attachments || []).map(({ filename, content }) => ({
    filename, size: content.length,
    sha256: createHash('sha256').update(content).digest('hex'),
  }));
}

async function sendMessage(credentials, action, deps, execution) {
  const options = await prepareMailOptions(credentials, action);
  const transporter = deps.createSmtp(credentials);
  try {
    execution.state = 'unknown';
    const info = await transporter.sendMail(options);
    execution.state = 'executed';
    return {
      sent: true,
      attachments: attachmentSummary(options),
      message_id: info.messageId || null,
      accepted: Array.isArray(info.accepted) ? info.accepted.map(String) : [],
      rejected: Array.isArray(info.rejected) ? info.rejected.map(String) : [],
    };
  } finally {
    if (transporter && typeof transporter.close === 'function') transporter.close();
  }
}

async function findDraftFolder(client) {
  const folders = await client.list();
  const special = folders.find((folder) => folder.specialUse === '\\Drafts');
  if (special) return special.path;
  const fallback = folders.find((folder) => /(^|[/])drafts?$|草稿箱/i.test(folder.path));
  if (fallback) return fallback.path;
  throw new Error('DRAFT_FOLDER_NOT_FOUND');
}

async function saveDraft(credentials, action, deps, execution) {
  const options = await prepareMailOptions(credentials, action);
  const composer = deps.createComposer();
  try {
    const info = await composer.sendMail(options);
    if (!info || !Buffer.isBuffer(info.message)) throw new Error('DRAFT_BUILD_FAILED');
    return await withImap(credentials, deps, async (client) => {
      const folder = await findDraftFolder(client);
      execution.state = 'unknown';
      const appended = await client.append(folder, info.message, ['\\Draft'], new Date());
      execution.state = 'executed';
      return {
        draft: true,
        attachments: attachmentSummary(options),
        folder,
        uid: appended && appended.uid ? appended.uid : null,
        uid_validity: appended && appended.uidValidity ? String(appended.uidValidity) : null,
      };
    });
  } finally {
    if (composer && typeof composer.close === 'function') composer.close();
  }
}

async function changeFlags(credentials, action, deps, seen, execution) {
  const folder = action.folder || 'INBOX';
  return withImap(credentials, deps, (client) => withMailbox(client, folder, async () => {
    const existing = await client.fetchOne(
      action.message_uid,
      { uid: true, flags: true },
      { uid: true },
    );
    if (!existing) throw new Error('MESSAGE_NOT_FOUND');

    const currentFlags = flagsArray(existing.flags);
    if (currentFlags.includes('\\Seen') !== seen) {
      execution.state = 'unknown';
      const updated = seen
        ? await client.messageFlagsAdd(action.message_uid, ['\\Seen'], { uid: true })
        : await client.messageFlagsRemove(action.message_uid, ['\\Seen'], { uid: true });
      if (!updated) throw new Error('MESSAGE_NOT_FOUND');
      execution.state = 'executed';

      const verified = await client.fetchOne(
        action.message_uid,
        { uid: true, flags: true },
        { uid: true },
      );
      if (!verified) throw new Error('MESSAGE_NOT_FOUND');
      if (flagsArray(verified.flags).includes('\\Seen') !== seen) {
        throw new Error('MESSAGE_UPDATE_FAILED');
      }
    }
    return { updated: true, folder, uid: action.message_uid, unread: !seen };
  }));
}

async function moveMessage(credentials, action, deps, execution) {
  const folder = action.folder || 'INBOX';
  const target = typeof action.target_folder === 'string' ? action.target_folder.trim() : '';
  if (!target) throw new Error('TARGET_FOLDER_REQUIRED');
  if (target === folder) throw new Error('TARGET_FOLDER_SAME');
  return withImap(credentials, deps, (client) => withMailbox(client, folder, async () => {
    const existing = await client.fetchOne(
      action.message_uid,
      { uid: true },
      { uid: true },
    );
    if (!existing) throw new Error('MESSAGE_NOT_FOUND');

    execution.state = 'unknown';
    const moved = await client.messageMove(action.message_uid, target, { uid: true });
    if (!moved) throw new Error('MESSAGE_NOT_FOUND');
    execution.state = 'executed';
    const destinationUid = moved.uidMap && moved.uidMap.get
      ? (moved.uidMap.get(action.message_uid) || null)
      : null;
    if (!destinationUid) throw new Error('MESSAGE_MOVE_UNCONFIRMED');
    return {
      moved: true,
      from_folder: folder,
      to_folder: target,
      uid: action.message_uid,
      destination_uid: destinationUid,
    };
  }));
}

async function testAccount(credentials, deps) {
  await withImap(credentials, deps, async () => undefined);
  const transporter = deps.createSmtp(credentials);
  try {
    await transporter.verify();
  } finally {
    if (transporter && typeof transporter.close === 'function') transporter.close();
  }
  return {
    connected: true,
    email: credentials.email,
    imap: `${QQ.imapHost}:${QQ.imapPort}`,
    smtp: `${QQ.smtpHost}:${QQ.smtpPort}`,
  };
}

async function performAction(credentials, action, deps, execution = { state: 'not_executed' }) {
  switch (action.action) {
    case 'list_folders':
      return listFolders(credentials, deps);
    case 'search':
      return search(credentials, action, deps);
    case 'read':
      return readMessage(credentials, action, deps);
    case 'send':
      return sendMessage(credentials, action, deps, execution);
    case 'draft':
      return saveDraft(credentials, action, deps, execution);
    case 'mark_read':
      return changeFlags(credentials, action, deps, true, execution);
    case 'mark_unread':
      return changeFlags(credentials, action, deps, false, execution);
    case 'move':
      return moveMessage(credentials, action, deps, execution);
    default:
      throw new Error('UNKNOWN_ACTION');
  }
}

function humanizeError(error) {
  const code = error && error.code ? String(error.code) : '';
  const message = error && error.message ? String(error.message) : String(error || '');
  const combined = `${code} ${message}`.toLowerCase();

  if (message === 'INVALID_ATTACHMENT_PATHS') return '附件须使用本机文件绝对路径列表，每封最多 10 个文件';
  if (message === 'ATTACHMENT_UNREADABLE' || message === 'ATTACHMENT_NOT_FILE') return '附件不存在、无法读取或不是普通文件；邮件未发送，请检查文件路径';
  if (message === 'ATTACHMENTS_TOO_LARGE') return '附件总大小超过 32 MiB；邮件未发送，请缩小附件后重试';
  if (message === 'INVALID_EMAIL') return '请输入有效的 QQ 邮箱地址';
  if (message === 'INVALID_AUTHORIZATION_CODE') {
    return '请输入 QQ 邮箱生成的 IMAP/SMTP 授权码，不要输入 QQ 密码';
  }
  if (message === 'NOT_CONFIGURED') {
    return '尚未配置 QQ 邮箱，请到「QQ 邮箱」插件详情页输入邮箱和授权码';
  }
  if (
    code === 'EAUTH'
    || combined.includes('authenticationfailed')
    || combined.includes('authentication failed')
    || combined.includes('invalid credentials')
    || combined.includes('login failed')
  ) {
    return 'QQ 邮箱拒绝登录。请确认已开启 IMAP/SMTP，并使用生成的授权码（不是 QQ 密码）';
  }
  if (
    code === 'ETIMEDOUT'
    || code === 'ECONNREFUSED'
    || code === 'ECONNRESET'
    || code === 'ENETUNREACH'
    || combined.includes('timed out')
  ) {
    return '无法连接 QQ 邮箱服务器，请检查网络后重试';
  }
  if (combined.includes('too many') || combined.includes('rate limit') || combined.includes('频繁')) {
    return 'QQ 邮箱暂时限制了频繁访问，请稍后再试';
  }
  if (message === 'MESSAGE_NOT_FOUND') return '没有在指定文件夹找到这封邮件，请重新搜索';
  if (message === 'MESSAGE_TOO_LARGE') return '邮件内容过大；发送或保存草稿时请将主题缩短至 998 字符以内、正文缩短至 500000 字符以内；读取邮件上限为 48 MiB';
  if (message === 'DRAFT_BUILD_FAILED') return '草稿内容生成失败，请检查邮件内容后再保存';
  if (message === 'DRAFT_FOLDER_NOT_FOUND') {
    return '没有找到 QQ 邮箱草稿箱，请先调用 list_folders 确认服务器文件夹';
  }
  if (message === 'TARGET_FOLDER_REQUIRED') return 'move 需要目标文件夹';
  if (message === 'TARGET_FOLDER_SAME') return '目标文件夹不能与当前文件夹相同';
  if (message === 'MESSAGE_MOVE_UNCONFIRMED') {
    return '无法确认邮件是否已移动，请重新搜索邮箱后再操作';
  }
  if (message === 'RECIPIENT_REQUIRED') return '请至少填写一个收件人';
  if (message === 'INVALID_RECIPIENT') return '收件人、抄送或密送地址格式不正确';
  if (message === 'INVALID_SUBJECT') return '邮件主题格式不正确';
  if (message === 'INVALID_BODY') return '邮件正文格式不正确';
  if (message.startsWith('INVALID_SINCE') || message.startsWith('INVALID_BEFORE')) {
    return '搜索日期格式无效，请使用 ISO 日期或日期时间';
  }
  if (combined.includes('mailbox') || combined.includes('folder')) {
    return 'QQ 邮箱文件夹不存在或不可用，请先调用 list_folders 获取准确名称';
  }
  return 'QQ 邮箱操作失败，请稍后重试';
}

async function handleRequest(request, deps = createRuntimeDeps()) {
  if (!request || typeof request !== 'object') throw new Error('INVALID_REQUEST');
  const params = request.params && typeof request.params === 'object' ? request.params : {};
  let credentials = null;
  const execution = { state: 'not_executed' };
  try {
    if (request.method === 'account/connect') {
      credentials = consumeRequestCredentials(request);
      const tested = await testAccount(credentials, deps);
      return { ...tested, persistence: 'cindy-safe-storage' };
    }
    if (request.method === 'mail/action') {
      credentials = consumeRequestCredentials(request);
      const action = params.action && typeof params.action === 'object' ? params.action : {};
      return await performAction(credentials, action, deps, execution);
    }
    throw new Error('METHOD_NOT_FOUND');
  } catch (error) {
    const action = params.action && params.action.action;
    const mutation = request.method === 'mail/action'
      && ['send', 'draft', 'move', 'mark_read', 'mark_unread'].includes(action);
    // Only crossing a remote write boundary makes a failure ambiguous. Error
    // names cannot establish whether SMTP/IMAP has already changed the mailbox.
    const state = mutation ? execution.state : undefined;
    const failure = new Error(state === 'unknown'
      ? '操作结果不确定，请先核对收件箱、已发送、草稿或目标文件夹的实际状态，避免重复操作'
      : state === 'executed'
        ? '操作已执行，但后续确认或清理失败；请先核对邮箱实际状态，避免重复操作'
        : (state === 'not_executed' ? '操作未执行：' : '') + humanizeError(error));
    failure.executionState = state;
    throw failure;
  } finally {
    if (credentials) credentials.authorizationCode = '';
  }
}

function writeReply(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function startStdio() {
  readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
    let request;
    try {
      request = JSON.parse(line);
    } catch (_error) {
      writeReply({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: '请求格式无效' },
      });
      return;
    }
    void handleRequest(request)
      .then((result) => {
        writeReply({ jsonrpc: '2.0', id: request.id, result });
      })
      .catch((error) => {
        writeReply({
          jsonrpc: '2.0',
          id: request.id,
          error: {
            code: -32000,
            message: error && error.message ? error.message : 'QQ 邮箱操作失败',
            ...(error && error.executionState ? { data: { execution_state: error.executionState } } : {}),
          },
        });
      });
  });
}

if (require.main === module) startStdio();

module.exports = {
  QQ,
  buildSearchCriteria,
  createRuntimeDeps,
  consumeRequestCredentials,
  handleRequest,
  humanizeError,
  normalizeCredentials,
  normalizeRecipients,
  performAction,
  startStdio,
  summaryFromMessage,
};
