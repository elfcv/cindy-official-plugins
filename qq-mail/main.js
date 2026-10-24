/**
 * QQ 邮箱官方插件。
 *
 * 授权码由设置页直接写入 Cindy 的 /secrets 只写通道。浏览器 main.js 只处理
 * 非敏感邮箱地址；宿主仅在 ghost.json 绑定的 Node 方法上，把授权码临时注入
 * 对应 Worker 的 request.cindy.secrets，Agent 参数和插件消息都不携带它。
 */

/* global BroadcastChannel, cindy, fetch, setTimeout */

var SETTINGS_CHANNEL = 'qq-mail-settings';
var SECRET_KEY = 'qq_mail_authorization_code';
var settingsRequests = new Map();

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function fail(message) {
  return { ok: false, message: message };
}

function normalizeEmail(value) {
  var email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    throw new Error('请输入有效的 QQ 邮箱地址');
  }
  return email;
}

async function readJson(path) {
  var response = await fetch(path);
  if (!response.ok) throw new Error('读取 QQ 邮箱配置失败');
  var value = await response.json();
  return value;
}

async function loadAccountState() {
  var values = await Promise.all([readJson('/kv'), readJson('/secrets')]);
  var kv = isObject(values[0]) ? values[0] : {};
  var secretItems = Array.isArray(values[1]) ? values[1] : [];
  var email = typeof kv.email === 'string' ? kv.email.trim().toLowerCase() : '';
  var secretSaved = secretItems.some(function hasSavedSecret(item) {
    return isObject(item) && item.key === SECRET_KEY && item.saved === true;
  });
  return {
    connected: Boolean(email && secretSaved),
    email: email || null,
    persistence: 'cindy-safe-storage',
  };
}

async function requireConfiguredEmail() {
  var state = await loadAccountState();
  if (!state.connected || !state.email) {
    throw new Error('尚未配置 QQ 邮箱，请到「QQ 邮箱」插件详情页完成连接');
  }
  return state.email;
}

async function nodeRequest(method, params, timeoutMs, callId) {
  if (!cindy.node || typeof cindy.node.request !== 'function') {
    var unsupported = new Error('当前 Cindy 不支持此插件的 Node 接口，请升级 Cindy 后使用');
    unsupported.executionState = 'not_executed';
    throw unsupported;
  }
  var response = await cindy.node.request({
    method: method,
    ...(callId ? { callId: callId, cancelWithCall: true } : {}),
    params: params,
    timeoutMs: timeoutMs || 30000,
  });
  if (!response || response.ok !== true) {
    var error = new Error(response && response.message
      ? response.message
      : 'QQ 邮箱 Worker 调用失败');
    error.executionState = response && response.data && response.data.execution_state;
    throw error;
  }
  return response.result;
}

async function handleSettingsRequest(action, payload) {
  if (action !== 'connect') throw new Error('未知设置动作');
  var email = normalizeEmail(payload.email);
  return nodeRequest('account/connect', { email: email }, 45000);
}

var settingsChannel = typeof BroadcastChannel === 'function'
  ? new BroadcastChannel(SETTINGS_CHANNEL)
  : null;

if (settingsChannel) {
  settingsChannel.onmessage = function onSettingsMessage(event) {
    var message = event && event.data;
    if (
      !isObject(message)
      || message.type !== 'settings-request'
      || typeof message.reqId !== 'string'
      || typeof message.action !== 'string'
    ) {
      return;
    }

    var existing = settingsRequests.get(message.reqId);
    if (existing) {
      if (existing.response) settingsChannel.postMessage(existing.response);
      return;
    }

    var entry = { response: null };
    settingsRequests.set(message.reqId, entry);
    var payload = isObject(message.payload) ? message.payload : {};
    void handleSettingsRequest(message.action, payload)
      .then(function success(result) {
        return { type: 'settings-result', reqId: message.reqId, ok: true, result: result };
      })
      .catch(function failure(error) {
        return {
          type: 'settings-result',
          reqId: message.reqId,
          ok: false,
          message: error && error.message ? error.message : 'QQ 邮箱连接失败，请重试',
        };
      })
      .then(function reply(response) {
        entry.response = response;
        settingsChannel.postMessage(response);
        setTimeout(function releaseRequest() {
          if (settingsRequests.get(message.reqId) === entry) settingsRequests.delete(message.reqId);
        }, 5000);
      });
  };
}

function validateUid(value) {
  var uid = Number(value);
  if (!Number.isInteger(uid) || uid <= 0) throw new Error('message_uid 必须是有效的正整数');
  return uid;
}

function sanitizeMailArgs(args) {
  var action = typeof args.action === 'string' ? args.action : '';
  var allowed = {
    list_folders: true,
    search: true,
    read: true,
    send: true,
    draft: true,
    mark_read: true,
    mark_unread: true,
    move: true,
  };
  if (!allowed[action]) throw new Error('未知 action：' + action);

  var output = { action: action };
  var folder = typeof args.folder === 'string' && args.folder.trim()
    ? args.folder.trim()
    : 'INBOX';
  output.folder = folder;

  if (action === 'read' || action === 'mark_read' || action === 'mark_unread' || action === 'move') {
    output.message_uid = validateUid(args.message_uid);
  }
  if (action === 'move') {
    if (typeof args.target_folder !== 'string' || !args.target_folder.trim()) {
      throw new Error('move 需要 target_folder；请先调用 list_folders');
    }
    output.target_folder = args.target_folder.trim();
  }

  if (action === 'search') {
    if (args.page_token !== undefined && (typeof args.page_token !== 'string' || !args.page_token.trim())) {
      throw new Error('page_token必须是上一页返回的非空翻页标记；查第一页时省略');
    }
    ['text', 'from', 'to', 'subject', 'since', 'before', 'page_token', 'text_scope'].forEach(function copyString(key) {
      if (typeof args[key] === 'string' && args[key].trim()) output[key] = args[key].trim();
    });
    if (typeof args.unread === 'boolean') output.unread = args.unread;
    var max = Number(args.max_results);
    output.max_results = Number.isFinite(max) ? Math.min(20, Math.max(1, Math.floor(max))) : 10;
  }

  if (action === 'send' || action === 'draft') {
    if (args.to === undefined || typeof args.subject !== 'string' || typeof args.body_text !== 'string') {
      throw new Error(action + ' 需要 to、subject 和 body_text');
    }
    output.to = args.to;
    if (args.cc !== undefined) output.cc = args.cc;
    if (args.bcc !== undefined) output.bcc = args.bcc;
    output.subject = args.subject;
    output.body_text = args.body_text;
    if (args.attachments !== undefined || args.dir_deposit !== undefined) {
      throw new Error('发送附件请使用 attachment_paths 本机文件绝对路径列表');
    }
    if (args.attachment_paths !== undefined) {
      if (!Array.isArray(args.attachment_paths) || args.attachment_paths.length > 10 || args.attachment_paths.some(function (file) { return typeof file !== 'string' || !file; })) {
        throw new Error('attachment_paths 必须是文件路径列表，每封最多 10 个文件');
      }
      output.attachment_paths = args.attachment_paths.slice();
    }
  }

  return output;
}

async function runMail(args, callId) {
  var action;
  var dispatched = false;
  try {
    action = sanitizeMailArgs(args);
  } catch (error) {
    return fail('操作未执行：' + (error && error.message ? error.message : 'QQ 邮箱参数无效'));
  }

  try {
    var email = await requireConfiguredEmail();
    dispatched = true;
    var result = await nodeRequest('mail/action', {
      email: email,
      action: action,
    }, ['send', 'draft', 'read', 'search'].includes(action.action) ? 120000 : 45000, callId);
    return { ok: true, result: result };
  } catch (error) {
    if (['send', 'draft', 'move', 'mark_read', 'mark_unread'].includes(action.action)) {
      if (error.executionState === 'executed') return fail(error.message);
      if (dispatched && error.executionState !== 'not_executed') {
        return fail('操作结果不确定，请先核对邮箱实际状态，避免重复发送或重复修改');
      }
      return fail(error.executionState === 'not_executed' ? error.message
        : '操作未执行：' + (error && error.message ? error.message : '请检查邮箱配置'));
    }
    return fail(error && error.message ? error.message : 'QQ 邮箱操作失败，请检查网络');
  }
}

async function connectAccount(args, callId) {
  var email = normalizeEmail(args.email);
  var result = await nodeRequest('account/connect', { email: email }, 45000, callId);
  var current = await readJson('/kv');
  var data = isObject(current) ? current : {};
  data.email = email;
  var response = await fetch('/kv', { method: 'PUT', body: JSON.stringify(data) });
  if (!response.ok) throw new Error('连接已验证，但保存邮箱地址失败，请重试连接');
  return { ok: true, result: result };
}

async function statusResult() {
  try {
    return { ok: true, result: await loadAccountState() };
  } catch (error) {
    return fail(error && error.message ? error.message : 'QQ 邮箱连接状态查询失败');
  }
}

cindy.onHostMessage(function onHostMessage(message) {
  if (!message || message.type !== 'tool-call') return;
  void (async function dispatch() {
    var reply;
    try {
      var result = message.tool === 'qq_mail_status'
        ? await statusResult()
        : message.tool === 'qq_mail_connect'
          ? await connectAccount(isObject(message.args) ? message.args : {}, message.callId)
        : message.tool === 'qq_mail'
          ? await runMail(isObject(message.args) ? message.args : {}, message.callId)
          : fail('未知工具：' + message.tool);
      reply = {
        type: 'tool-result',
        callId: message.callId,
        ok: result.ok,
        ...(result.ok ? { result: result.result } : { message: result.message }),
      };
      await cindy.send(reply);
    } catch (error) {
      // A delivery failure does not change the mailbox outcome. Retry only the
      // exact reply, never the operation; retain success data and known failures.
      await cindy.send(reply || {
        type: 'tool-result',
        callId: message.callId,
        ok: false,
        message: message.tool === 'qq_mail' && message.args && ['send', 'draft', 'move', 'mark_read', 'mark_unread'].includes(message.args.action)
          ? '操作结果不确定，请先核对邮箱实际状态，避免重复操作'
          : (error && error.message ? error.message : 'QQ 邮箱工具执行失败'),
      });
    }
  })();
});
