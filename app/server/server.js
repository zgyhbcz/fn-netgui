'use strict';

/**
 * fn-netgui — 飞牛 fnOS 网络配置管家
 * 本地 HTTP 服务：提供 GUI 静态资源 + 受控的 nmcli / ovs-vsctl 执行接口。
 *
 * 设计约束：
 *  - 不依赖任何 npm 包（fnOS 上只装 nodejs 运行时即可运行）。
 *  - 所有外部命令都通过 argv 数组执行，绝不拼接 shell 字符串。
 *  - 只有「预览通过」的同一份计划才会被执行；执行结果逐条返回。
 *  - 只允许私有网段地址访问（避免把 root 能力暴露到公网）。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const v = require('./lib/validate');
const nm = require('./lib/nm');
const shell = require('./lib/shell');
const { buildPlan } = require('./lib/plans');

/* ------------------------------------------------------------------ */
/* 配置                                                                */
/* ------------------------------------------------------------------ */

const APP_NAME = process.env.TRIM_APPNAME || 'fn-netgui';
const APP_VERSION = process.env.TRIM_APPVER || '1.0.0';
const PORT = Number(process.env.TRIM_SERVICE_PORT || 38471);
const APP_DIR = process.env.TRIM_APPDEST || path.resolve(__dirname, '..', '..');
const DATA_DIR = process.env.TRIM_PKGVAR || path.join(APP_DIR, 'var');
const UI_DIR = path.join(__dirname, '..', 'ui');
const LOG_FILE = path.join(DATA_DIR, 'netgui.log');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const MAX_BODY = 64 * 1024;
const ALLOW_ANY_PEER = process.env.NETGUI_ALLOW_ANY_PEER === '1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

function ensureDirs() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (e) {
    /* 目录不可写时仍继续，日志会落到 stderr */
  }
}

function log(message) {
  const line = `${new Date().toISOString()} ${message}`;
  try {
    fs.appendFileSync(LOG_FILE, `${line}\n`);
  } catch (e) {
    /* ignore */
  }
  process.stdout.write(`${line}\n`);
}

function readState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.entries)) return { version: 1, entries: [] };
    return parsed;
  } catch (e) {
    return { version: 1, entries: [] };
  }
}

function writeState(state) {
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(tmp, STATE_FILE);
}

function sendJson(res, status, body) {
  const payload = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new v.ValidationError('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve({});
      try {
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return reject(new v.ValidationError('请求体必须是 JSON 对象'));
        }
        resolve(parsed);
      } catch (e) {
        reject(new v.ValidationError('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function isPrivatePeer(remote) {
  if (ALLOW_ANY_PEER) return true;
  const addr = String(remote || '').replace(/^::ffff:/, '');
  if (addr === '::1' || addr === '127.0.0.1') return true;
  if (/^127\./.test(addr)) return true;
  if (/^10\./.test(addr)) return true;
  if (/^192\.168\./.test(addr)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(addr)) return true;
  if (/^169\.254\./.test(addr)) return true;
  if (/^(fc|fd|fe80)/i.test(addr)) return true;
  return false;
}

/* ------------------------------------------------------------------ */
/* 上下文：给 plan 构建器用的只读快照                                    */
/* ------------------------------------------------------------------ */

function buildContext() {
  const tools = nm.detectTools();
  const { devices } = nm.listDevices();
  const { connections } = nm.listConnections();
  const { bridges } = nm.listBridges();
  const state = readState();

  const bridgePorts = {};
  for (const bridge of bridges) {
    const { ports } = nm.listBridgePorts(bridge);
    bridgePorts[bridge] = ports;
  }

  const managedNames = state.entries.map((e) => e.conName).filter(Boolean);
  const subnets = [];
  for (const con of connections) {
    if (con.type !== '802-3-ethernet' && con.type !== '802-11-wireless') continue;
    const detail = nm.getConnectionDetails(con.name);
    for (const addr of detail.addresses || []) {
      if (v.isCIDR(addr)) subnets.push({ name: con.name, cidr: addr });
    }
  }

  return {
    devices,
    connections: connections.map((c) => c.name),
    bridges,
    bridgePorts,
    managedNames,
    subnets,
    hasOvs: Boolean(tools.ovsVsctl),
  };
}

/* ------------------------------------------------------------------ */
/* 执行                                                                */
/* ------------------------------------------------------------------ */

function resolveBin(name) {
  const tools = nm.detectTools();
  if (name === 'nmcli') return tools.nmcli || 'nmcli';
  if (name === 'ovs-vsctl') return tools.ovsVsctl || 'ovs-vsctl';
  if (name === 'ip') return tools.ip || 'ip';
  return name;
}

async function executePlan(plan) {
  const results = [];
  let failed = false;

  for (const item of plan.steps) {
    if (failed) {
      results.push({ title: item.title, command: '', ok: false, skipped: true, code: null, stdout: '', stderr: '' });
      continue;
    }
    const bin = resolveBin(item.bin);
    const started = Date.now();
    const result = await shell.run(bin, item.args, { timeout: 45000 });
    const ms = Date.now() - started;
    const command = [item.bin, ...item.args.map((a) => (/\s/.test(a) ? `"${a}"` : a))].join(' ');
    results.push({
      title: item.title,
      command,
      ok: result.ok,
      code: result.code,
      stdout: result.stdout.trim().slice(0, 4000),
      stderr: result.stderr.trim().slice(0, 4000),
      ms,
    });
    log(`exec [${result.ok ? 'ok' : 'fail'}] ${command}${result.ok ? '' : ` :: ${result.stderr.trim().slice(0, 300)}`}`);
    if (!result.ok) failed = true;
  }

  return { ok: !failed, results };
}

/* ------------------------------------------------------------------ */
/* 状态持久化                                                          */
/* ------------------------------------------------------------------ */

function upsertEntry(entry) {
  if (!entry) return;
  const state = readState();
  const id = `${entry.mode}:${entry.iface}${entry.bridge ? `:${entry.bridge}` : ''}`;
  const next = state.entries.filter((e) => e.id !== id);
  next.push({ ...entry, id, createdAt: new Date().toISOString() });
  writeState({ version: 1, entries: next });
}

function removeEntry(id) {
  const state = readState();
  writeState({ version: 1, entries: state.entries.filter((e) => e.id !== id) });
}

function findEntry(id) {
  return readState().entries.find((e) => e.id === id) || null;
}

/* ------------------------------------------------------------------ */
/* 路由                                                                */
/* ------------------------------------------------------------------ */

function statusPayload() {
  const tools = nm.detectTools(true);
  const state = readState();
  return {
    ok: true,
    app: { name: APP_NAME, version: APP_VERSION, port: PORT },
    host: nm.hostInfo(),
    tools: {
      nmcli: tools.nmcli,
      nmcliVersion: tools.nmcliVersion,
      ip: tools.ip,
      ovsVsctl: tools.ovsVsctl,
      ovsVersion: tools.ovsVersion,
    },
    isRoot: typeof process.getuid === 'function' ? process.getuid() === 0 : false,
    dataDir: DATA_DIR,
    entries: state.entries,
    limits: { maxBody: MAX_BODY, allowAnyPeer: ALLOW_ANY_PEER, port: PORT },
  };
}

function networkPayload() {
  const tools = nm.detectTools();
  const { devices, error: devError } = nm.listDevices();
  const { connections, error: conError } = nm.listConnections();
  const { bridges } = nm.listBridges();
  const state = readState();

  return {
    ok: true,
    devices,
    connections,
    bridges,
    managed: state.entries,
    tools: { nmcli: tools.nmcli, ovsVsctl: tools.ovsVsctl, ip: tools.ip },
    warnings: Array.from(new Set([devError, conError].filter(Boolean))),
  };
}

async function handlePlan(req, res) {
  const payload = await readBody(req);
  const ctx = buildContext();
  const plan = buildPlan(payload, ctx);
  sendJson(res, 200, {
    ok: true,
    action: plan.action,
    title: plan.title,
    preview: plan.preview,
    steps: plan.steps.map((s) => ({ title: s.title, bin: s.bin, args: s.args })),
    notes: plan.notes,
    warnings: plan.warnings,
    isRoot: typeof process.getuid === 'function' ? process.getuid() === 0 : false,
  });
}

let mutationQueue = Promise.resolve();

function serialize(task) {
  const next = mutationQueue.then(task, task);
  mutationQueue = next.catch(() => {});
  return next;
}

async function handleApply(req, res) {
  const payload = await readBody(req);

  const isRoot = typeof process.getuid === 'function' ? process.getuid() === 0 : false;
  if (!isRoot) {
    sendJson(res, 403, {
      ok: false,
      error: '当前服务不是以 root 运行，无法执行 nmcli/ovs-vsctl。请确认 config/privilege 中 run-as=root 后重启应用。',
    });
    return;
  }
  if (!nm.detectTools().nmcli) {
    sendJson(res, 503, { ok: false, error: '未检测到 nmcli（NetworkManager），无法执行。' });
    return;
  }

  const plan = await serialize(async () => {
    const ctx = buildContext();
    const built = buildPlan(payload, ctx);
    log(`apply ${built.action} :: ${built.steps.length} step(s)`);
    const executed = await executePlan(built);
    return { built, executed };
  });

  const { built, executed } = plan;
  let entryId = null;
  if (executed.ok && built.entry) {
    upsertEntry(built.entry);
    entryId = `${built.entry.mode}:${built.entry.iface}${built.entry.bridge ? `:${built.entry.bridge}` : ''}`;
  }
  if (executed.ok && built.action === 'revert') {
    const id = payload.entryId || (payload.entry && payload.entry.id);
    if (id) removeEntry(id);
  }

  sendJson(res, executed.ok ? 200 : 500, {
    ok: executed.ok,
    action: built.action,
    title: built.title,
    notes: built.notes,
    warnings: built.warnings,
    results: executed.results,
    entryId,
    entries: readState().entries,
    error: executed.ok ? '' : '有步骤执行失败，请查看输出。网络可能处于中间状态，可在「本应用创建的配置」中回滚。',
  });
}

async function handleLog(req, res, url) {
  const lines = Math.min(Math.max(Number(url.searchParams.get('lines') || 200), 10), 1000);
  let text = '';
  try {
    const raw = fs.readFileSync(LOG_FILE, 'utf8').split('\n');
    text = raw.slice(Math.max(0, raw.length - lines)).join('\n');
  } catch (e) {
    text = '（暂无日志）';
  }
  sendJson(res, 200, { ok: true, text });
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  if (rel.includes('\0')) {
    res.writeHead(400).end('bad request');
    return;
  }
  const target = path.resolve(UI_DIR, `.${rel}`);
  if (!target.startsWith(path.resolve(UI_DIR) + path.sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  const ext = path.extname(target).toLowerCase();
  if (!MIME[ext]) {
    res.writeHead(404).end('not found');
    return;
  }
  fs.stat(target, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[ext],
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    fs.createReadStream(target).pipe(res);
  });
}

/* ------------------------------------------------------------------ */
/* 主循环                                                              */
/* ------------------------------------------------------------------ */

const server = http.createServer((req, res) => {
  const started = Date.now();
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch (e) {
    sendJson(res, 400, { ok: false, error: '请求地址不合法' });
    return;
  }

  if (!isPrivatePeer(req.socket.remoteAddress)) {
    sendJson(res, 403, { ok: false, error: '只允许局域网 / 本机访问' });
    return;
  }

  const isApi = url.pathname.startsWith('/api/');
  const isWrite = req.method !== 'GET' && req.method !== 'HEAD';

  if (isApi && isWrite) {
    if (req.headers['x-netgui-request'] !== '1') {
      sendJson(res, 403, { ok: false, error: '缺少 X-NetGUI-Request 请求头（防 CSRF）' });
      return;
    }
    const origin = req.headers.origin;
    if (origin) {
      let ok = false;
      try {
        const o = new URL(origin);
        ok = o.port === String(PORT) && (o.hostname === url.hostname || isPrivatePeer(o.hostname));
      } catch (e) {
        ok = false;
      }
      if (!ok) {
        sendJson(res, 403, { ok: false, error: '跨站请求被拒绝' });
        return;
      }
    }
  }

  const finish = () => {
    const ms = Date.now() - started;
    if (ms > 500) log(`slow ${req.method} ${url.pathname} ${ms}ms`);
  };

  res.on('finish', finish);

  (async () => {
    if (req.method === 'GET' && url.pathname === '/api/health') {
      sendJson(res, 200, { ok: true, name: APP_NAME, version: APP_VERSION });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/status') {
      sendJson(res, 200, statusPayload());
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/network') {
      sendJson(res, 200, networkPayload());
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/connection') {
      const name = String(url.searchParams.get('name') || '');
      if (!v.isConnName(name)) {
        sendJson(res, 400, { ok: false, error: '连接名不合法' });
        return;
      }
      sendJson(res, 200, { ok: true, connection: nm.getConnectionDetails(name) });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/log') {
      await handleLog(req, res, url);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/plan') {
      await handlePlan(req, res);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/apply') {
      await handleApply(req, res);
      return;
    }
    if (isApi) {
      sendJson(res, 404, { ok: false, error: `未知接口 ${req.method} ${url.pathname}` });
      return;
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      serveStatic(req, res, url.pathname);
      return;
    }
    sendJson(res, 405, { ok: false, error: 'method not allowed' });
  })().catch((err) => {
    const known = err instanceof v.ValidationError;
    if (!known) log(`error ${req.method} ${url.pathname} :: ${err && err.stack ? err.stack : err}`);
    if (!res.headersSent) {
      sendJson(res, known ? 400 : 500, { ok: false, error: err && err.message ? err.message : '内部错误' });
    } else {
      res.end();
    }
  });
});

ensureDirs();
if (!fs.existsSync(STATE_FILE)) {
  try {
    writeState({ version: 1, entries: [] });
  } catch (e) {
    /* ignore */
  }
}

server.listen(PORT, '0.0.0.0', () => {
  log(`fn-netgui ${APP_VERSION} listening on 0.0.0.0:${PORT} (node ${process.version}, uid ${typeof process.getuid === 'function' ? process.getuid() : 'n/a'})`);
});

server.on('error', (err) => {
  log(`server error: ${err && err.message}`);
});

function shutdown(signal) {
  log(`received ${signal}, shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
