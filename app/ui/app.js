'use strict';

/* ------------------------------------------------------------------ *
 * 状态与工具
 * ------------------------------------------------------------------ */

const state = {
  status: null,
  network: null,
  tab: 'shared',
  planKey: '',
  lastPlan: null,
  busy: false,
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const el = {
  hostLine: $('#hostLine'),
  rootBadge: $('#rootBadge'),
  nmBadge: $('#nmBadge'),
  alert: $('#alert'),
  devices: $('#devices'),
  tabs: $('#tabs'),
  preview: $('#preview'),
  notes: $('#notes'),
  warnings: $('#warnings'),
  results: $('#results'),
  managed: $('#managed'),
  log: $('#log'),
  btnPlan: $('#btnPlan'),
  btnApply: $('#btnApply'),
  conHint: $('#conHint'),
};

async function apiGet(path) {
  const res = await fetch(path, { headers: { 'X-NetGUI-Request': '1' }, cache: 'no-store' });
  const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function apiPost(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-NetGUI-Request': '1' },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (data.ok === false) {
    const err = new Error(data.error || '请求失败');
    err.data = data;
    throw err;
  }
  return data;
}

function showAlert(message, kind) {
  el.alert.textContent = message;
  el.alert.className = `alert${kind === 'warn' ? ' warn' : ''}`;
}

function hideAlert() {
  el.alert.className = 'alert hidden';
  el.alert.textContent = '';
}

/* ------------------------------------------------------------------ *
 * 输入格式化：MAC 自动补冒号 / IP 自动补点 / DNS 过滤
 * ------------------------------------------------------------------ */

function normalizeDigits(value) {
  return String(value).replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

function formatMac(input) {
  const raw = input.value;
  const atEnd = input.selectionStart === raw.length;
  const digits = raw.replace(/[^0-9a-fA-F]/g, '').toUpperCase().slice(0, 12);
  const out = digits.replace(/(.{2})(?=.)/g, '$1:');
  input.value = out;
  if (atEnd) input.setSelectionRange(out.length, out.length);
  afterEdit();
}

function macBackspace(ev, input) {
  if (ev.key !== 'Backspace') return;
  const { selectionStart: start, selectionEnd: end, value } = input;
  if (start !== end || start === 0) return;
  if (value[start - 1] === ':') {
    ev.preventDefault();
    const cut = Math.max(0, start - 2);
    input.value = value.slice(0, cut) + value.slice(start);
    input.setSelectionRange(cut, cut);
    afterEdit();
  }
}

function formatIp(input, ev) {
  const before = input.value;
  const allowSlash = input.dataset.format === 'ip';
  const atEnd = input.selectionStart === before.length;

  let s = normalizeDigits(before)
    .replace(/[。．]/g, '.')
    .replace(/[／]/g, '/')
    .replace(/[^0-9./]/g, '');

  const slashParts = s.split('/');
  const addrPart = slashParts[0] || '';
  let prefix = slashParts.length > 1 && allowSlash ? slashParts[1].replace(/\D/g, '').slice(0, 2) : null;

  let groups = addrPart.split('.').map((g) => g.replace(/\D/g, '').slice(0, 3));
  if (groups.length > 4) groups = groups.slice(0, 4);
  let out = groups.join('.');
  if (prefix !== null) out += `/${prefix}`;

  if (
    atEnd && prefix === null && ev && ev.inputType === 'insertText' && /^\d$/.test(ev.data || '')
  ) {
    const gs = out.split('.');
    const last = gs[gs.length - 1] || '';
    if (last.length === 3 && gs.length < 4) out += '.';
  }

  if (out !== before) input.value = out;
  if (atEnd) input.setSelectionRange(out.length, out.length);
  afterEdit();
}

function formatDns(input) {
  const atEnd = input.selectionStart === input.value.length;
  let s = normalizeDigits(input.value)
    .replace(/[，、；;]/g, ',')
    .replace(/[。．]/g, '.')
    .replace(/[^0-9.,\s]/g, '')
    .replace(/\s*,\s*/g, ', ');
  if (s !== input.value) input.value = s;
  if (atEnd) input.setSelectionRange(s.length, s.length);
  afterEdit();
}

function installFormatters() {
  $$('input[data-format="mac"]').forEach((input) => {
    input.addEventListener('input', (ev) => formatMac(input, ev));
    input.addEventListener('keydown', (ev) => macBackspace(ev, input));
  });
  $$('input[data-format="ip"], input[data-format="ip4"]').forEach((input) => {
    input.addEventListener('input', (ev) => formatIp(input, ev));
  });
  $$('input[data-format="dns"]').forEach((input) => {
    input.addEventListener('input', () => formatDns(input));
  });
}

/* ------------------------------------------------------------------ *
 * 表单 → 请求体
 * ------------------------------------------------------------------ */

function val(id) {
  const node = document.getElementById(id);
  return node ? String(node.value || '').trim() : '';
}

function checked(id) {
  const node = document.getElementById(id);
  return Boolean(node && node.checked);
}

function activeIfaces(kind) {
  const devices = (state.network && state.network.devices) || [];
  if (kind === 'wifi') return devices.filter((d) => d.type === 'wifi');
  return devices.filter((d) => !d.virtual && d.type === 'ethernet');
}

function collectPayload() {
  if (state.tab === 'shared') {
    return {
      action: 'shared',
      iface: val('shIface'),
      address: val('shAddr'),
      dns: val('shDns'),
      mac: checked('shClearMac') ? '' : val('shMac'),
      clearMac: checked('shClearMac'),
    };
  }
  if (state.tab === 'bridge') {
    return { action: 'bridge', iface: val('bgIface'), bridge: val('bgBridge') };
  }
  if (state.tab === 'hotspot') {
    return {
      action: 'hotspot',
      iface: val('hsIface'),
      ssid: val('hsSsid'),
      password: document.getElementById('hsPass') ? document.getElementById('hsPass').value : '',
      band: val('hsBand'),
      subnet: val('hsSubnet'),
    };
  }
  return {
    action: 'edit',
    conName: val('edCon'),
    method: val('edMethod'),
    address: val('edAddr'),
    gateway: val('edGw'),
    dns: val('edDns'),
    mac: checked('edClearMac') ? '' : val('edMac'),
    clearMac: checked('edClearMac'),
  };
}

function payloadKey(payload) {
  return JSON.stringify(payload);
}

function afterEdit() {
  if (state.planKey && payloadKey(collectPayload()) !== state.planKey) {
    state.planKey = '';
    state.lastPlan = null;
    el.btnApply.disabled = true;
    el.preview.textContent = '配置已修改，请重新「预览命令」。';
    el.notes.innerHTML = '';
    el.warnings.innerHTML = '';
  }
}

/* ------------------------------------------------------------------ *
 * 渲染
 * ------------------------------------------------------------------ */

function renderStatus() {
  const s = state.status;
  if (!s) return;
  const host = s.host || {};
  const parts = [];
  if (host.fnosVersion) parts.push(`fnOS ${host.fnosVersion}`);
  if (host.hostname) parts.push(host.hostname);
  if (host.arch) parts.push(host.arch);
  parts.push(`Node ${host.node || ''}`);
  el.hostLine.textContent = parts.filter(Boolean).join(' · ');

  if (s.isRoot) {
    el.rootBadge.textContent = 'root 运行 · 可执行';
    el.rootBadge.className = 'badge ok';
  } else {
    el.rootBadge.textContent = '非 root · 仅预览';
    el.rootBadge.className = 'badge warn';
  }

  if (s.tools && s.tools.nmcli) {
    const raw = String(s.tools.nmcliVersion || '').trim();
    const version = raw.match(/(\d+\.\d+(?:\.\d+)?)/);
    el.nmBadge.textContent = version ? `nmcli ${version[1]}` : 'nmcli 可用';
    el.nmBadge.title = raw;
    el.nmBadge.className = 'badge ok';
  } else {
    el.nmBadge.textContent = '未找到 nmcli';
    el.nmBadge.className = 'badge err';
  }

  if (!s.isRoot) {
    showAlert('当前服务不是以 root 运行：可以预览命令，但无法执行。请确认 config/privilege 中 run-as=root 后重启应用。', 'warn');
  } else if (!s.tools || !s.tools.nmcli) {
    showAlert('未检测到 nmcli（NetworkManager）。请确认系统网络由 NetworkManager 管理。', 'warn');
  } else {
    hideAlert();
  }
}

function renderDevices() {
  const net = state.network;
  if (!net) return;
  const devices = net.devices || [];
  if (!devices.length) {
    el.devices.innerHTML = '<p class="muted">没有检测到网卡。</p>';
    return;
  }

  el.devices.innerHTML = '';
  for (const d of devices) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'device';
    const ipText = (d.ipv4 || []).map((a) => `${a.address}/${a.prefix}`).join('  ') || '无 IPv4';
    const tags = [];
    if (d.type === 'wifi') tags.push('<span class="tag">无线</span>');
    if (d.virtual) tags.push('<span class="tag grey">虚拟</span>');
    card.innerHTML = `
      <div class="dev-name"><span class="dot ${d.connected ? 'on' : ''}"></span>${escapeHtml(d.name)}${tags.join('')}</div>
      <div class="dev-meta">${escapeHtml(d.mac || '—')} · ${escapeHtml(ipText)}</div>
      <div class="dev-meta">${escapeHtml(d.connection || d.nmState || '未连接')}</div>`;
    card.addEventListener('click', () => selectDevice(d));
    el.devices.appendChild(card);
  }

  const conns = net.connections || [];
  el.conHint.textContent = `${devices.length} 个网卡 · ${conns.length} 个连接`;
}

function selectDevice(device) {
  if (state.tab === 'edit') {
    const entry = (state.network.managed || []).find((e) => e.iface === device.name);
    if (entry && entry.conName) {
      document.getElementById('edCon').value = entry.conName;
      loadConnectionDetail(entry.conName, true);
    }
    return;
  }

  const target = { shared: 'shIface', bridge: 'bgIface', hotspot: 'hsIface' }[state.tab];
  const node = document.getElementById(target);
  if (!node) return;
  const option = Array.from(node.options || []).find((o) => o.value === device.name);
  if (option) {
    node.value = device.name;
    afterEdit();
  }
}

function fillSelect(node, items, placeholder) {
  if (!node) return;
  const previous = node.value;
  node.innerHTML = '';
  if (!items.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = placeholder || '（无可选项）';
    node.appendChild(opt);
    return;
  }
  for (const item of items) {
    const opt = document.createElement('option');
    opt.value = item.value;
    opt.textContent = item.label;
    node.appendChild(opt);
  }
  if (items.some((i) => i.value === previous)) node.value = previous;
}

function renderNetwork() {
  const net = state.network;
  if (!net) return;
  renderDevices();

  const eth = activeIfaces('ethernet');
  const wifi = activeIfaces('wifi');
  const ethItems = eth.map((d) => ({ value: d.name, label: `${d.name}${d.connected ? '' : '（未连接）'} — ${d.mac || ''}` }));
  fillSelect(document.getElementById('shIface'), ethItems, '没有可用的有线网口');
  fillSelect(document.getElementById('bgIface'), ethItems, '没有可用的有线网口');

  const bridgeItems = (net.bridges || []).map((b) => ({ value: b, label: b }));
  fillSelect(document.getElementById('bgBridge'), bridgeItems, '未检测到 OVS 网桥');
  const bgTip = document.getElementById('bgTip');
  if (bgTip) {
    bgTip.textContent = bridgeItems.length
      ? '提示：二层桥接共用主网口 MAC；若网络限制「一 MAC 一 IP」，请改用 NAT 共享。'
      : '未检测到 OVS 网桥：请先在「系统设置 → 网络设置」为主网口启用 OVS，再刷新本页。';
  }

  const wifiItems = wifi.map((d) => ({ value: d.name, label: `${d.name}${d.connected ? '' : '（未连接）'} — ${d.mac || ''}` }));
  fillSelect(document.getElementById('hsIface'), wifiItems, '没有无线网卡');

  const managedConns = (state.status && state.status.entries ? state.status.entries : [])
    .map((e) => e.conName)
    .filter(Boolean);
  const conItems = Array.from(new Set(managedConns)).map((name) => ({ value: name, label: name }));
  fillSelect(document.getElementById('edCon'), conItems, '还没有本应用创建的连接');

  renderManaged();
  afterEdit();
}

function renderManaged() {
  const entries = (state.status && state.status.entries) || [];
  if (!entries.length) {
    el.managed.innerHTML = '<p class="muted">暂无。你在本应用里创建的共享/热点会出现在这里，可一键回滚。</p>';
    return;
  }
  el.managed.innerHTML = '';
  for (const entry of entries) {
    const row = document.createElement('div');
    row.className = 'managed-row';
    const label = { shared: 'NAT 共享', bridge: 'OVS 桥接', hotspot: 'WiFi 热点' }[entry.mode] || entry.mode;
    const detail = [
      entry.iface,
      entry.conName,
      entry.bridge ? `网桥 ${entry.bridge}` : '',
      entry.address || '',
      entry.mac ? `MAC ${entry.mac}` : '',
    ].filter(Boolean).join(' · ');

    const main = document.createElement('div');
    main.className = 'managed-main';
    main.innerHTML = `<strong>${escapeHtml(label)}</strong><span>${escapeHtml(detail)}</span>`;
    row.appendChild(main);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ghost small';
    btn.textContent = '回滚';
    btn.addEventListener('click', () => revertEntry(entry));
    row.appendChild(btn);

    el.managed.appendChild(row);
  }
}

function escapeHtml(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ------------------------------------------------------------------ *
 * 预览 / 执行
 * ------------------------------------------------------------------ */

function renderPlan(plan) {
  state.lastPlan = plan;
  state.planKey = payloadKey(collectPayload());

  const lines = (plan.steps || []).map((s, i) => {
    const args = s.args.map((a) => (/\s/.test(String(a)) ? `"${a}"` : a));
    return `${String(i + 1).padStart(2, ' ')}. ${[s.bin, ...args].join(' ')}`;
  });
  el.preview.textContent = lines.length ? lines.join('\n') : '（无需执行任何命令）';

  el.notes.innerHTML = (plan.notes || []).map((n) => `<p>${escapeHtml(n)}</p>`).join('');
  el.warnings.innerHTML = (plan.warnings || []).map((w) => `<p>${escapeHtml(w)}</p>`).join('');

  const canApply = (plan.steps || []).length > 0 && state.status && state.status.isRoot;
  el.btnApply.disabled = !canApply;
}

async function previewPlan() {
  if (state.busy) return;
  state.busy = true;
  el.btnPlan.disabled = true;
  el.btnPlan.textContent = '预览中…';
  try {
    const data = await apiPost('/api/plan', collectPayload());
    renderPlan(data);
  } catch (err) {
    state.planKey = '';
    el.btnApply.disabled = true;
    el.preview.textContent = `预览失败：${err.message}`;
    el.notes.innerHTML = '';
    el.warnings.innerHTML = '';
  } finally {
    state.busy = false;
    el.btnPlan.disabled = false;
    el.btnPlan.textContent = '预览命令';
  }
}

async function applyPlan() {
  if (state.busy || !state.planKey) return;
  const payload = collectPayload();
  if (payloadKey(payload) !== state.planKey) {
    el.btnApply.disabled = true;
    el.preview.textContent = '配置已修改，请重新「预览命令」。';
    return;
  }
  const count = (state.lastPlan && state.lastPlan.steps ? state.lastPlan.steps.length : 0);
  if (!window.confirm(`即将执行 ${count} 条命令，网络可能短暂中断。\n\n继续执行？`)) return;

  state.busy = true;
  el.btnApply.disabled = true;
  el.btnApply.textContent = '执行中…';
  try {
    const data = await apiPost('/api/apply', payload);
    renderResults(data);
    state.planKey = '';
    await Promise.all([refreshStatus(), refreshNetwork()]);
  } catch (err) {
    if (err.data && err.data.results) {
      renderResults(err.data);
    } else {
      el.results.innerHTML = `<p class="fail">执行失败：${escapeHtml(err.message)}</p>`;
    }
  } finally {
    state.busy = false;
    el.btnApply.textContent = '执行';
    el.btnApply.disabled = true;
    loadLog();
  }
}

function renderResults(data) {
  const results = data.results || [];
  if (!results.length) {
    el.results.innerHTML = '<p class="muted">没有执行任何命令。</p>';
    return;
  }
  const head = data.ok
    ? '<p class="muted">全部步骤执行成功。</p>'
    : `<p class="fail">${escapeHtml(data.error || '有步骤执行失败。')}</p>`;

  el.results.innerHTML = head;
  for (const r of results) {
    const box = document.createElement('div');
    box.className = `result ${r.ok ? 'ok' : r.skipped ? '' : 'fail'}`;
    const pill = r.skipped ? '<span class="pill skip">已跳过</span>' : r.ok ? '<span class="pill ok">成功</span>' : '<span class="pill fail">失败</span>';
    const output = [r.stderr, r.stdout].filter(Boolean).join('\n');
    box.innerHTML = `
      <div class="r-head">${pill}<span>${escapeHtml(r.title || '')}</span></div>
      ${r.command ? `<div class="r-cmd">${escapeHtml(r.command)}</div>` : ''}
      ${output ? `<pre>${escapeHtml(output.slice(0, 1500))}</pre>` : ''}`;
    el.results.appendChild(box);
  }
}

async function revertEntry(entry) {
  if (state.busy) return;
  if (!window.confirm(`回滚「${entry.conName || entry.iface}」？\n\n这会停用并删除本应用创建的连接（或移除桥接端口），不影响系统原有配置。`)) return;
  state.busy = true;
  try {
    const data = await apiPost('/api/apply', { action: 'revert', entry, entryId: entry.id });
    renderResults(data);
    await Promise.all([refreshStatus(), refreshNetwork()]);
  } catch (err) {
    if (err.data && err.data.results) renderResults(err.data);
    else el.results.innerHTML = `<p class="fail">回滚失败：${escapeHtml(err.message)}</p>`;
  } finally {
    state.busy = false;
    loadLog();
  }
}

async function loadConnectionDetail(name, force) {
  if (!name) return;
  try {
    const data = await apiGet(`/api/connection?name=${encodeURIComponent(name)}`);
    const c = data.connection || {};
    const addr = (c.addresses && c.addresses[0]) || '';
    if (force || !val('edAddr')) document.getElementById('edAddr').value = addr;
    if (force || !val('edGw')) document.getElementById('edGw').value = c.gateway || '';
    if (force || !val('edDns')) document.getElementById('edDns').value = (c.dns || []).join(', ');
    if (force || !val('edMac')) document.getElementById('edMac').value = c.mac || '';
    document.getElementById('edMethod').value = c.method === 'manual' ? 'manual' : 'auto';
    toggleEditFields();
    afterEdit();
  } catch (e) {
    /* 详情读取失败不影响主流程 */
  }
}

function toggleEditFields() {
  const method = val('edMethod');
  document.getElementById('edManualFields').classList.toggle('hidden', method !== 'manual');
}

/* ------------------------------------------------------------------ *
 * 数据加载
 * ------------------------------------------------------------------ */

async function refreshStatus() {
  state.status = await apiGet('/api/status');
  renderStatus();
}

async function refreshNetwork() {
  state.network = await apiGet('/api/network');
  renderNetwork();
}

async function loadLog() {
  try {
    const data = await apiGet('/api/log?lines=200');
    el.log.textContent = data.text || '（暂无日志）';
  } catch (e) {
    el.log.textContent = `读取日志失败：${e.message}`;
  }
}

async function refreshAll() {
  try {
    await Promise.all([refreshStatus(), refreshNetwork()]);
  } catch (err) {
    showAlert(`读取系统信息失败：${err.message}`, 'warn');
  }
}

/* ------------------------------------------------------------------ *
 * 事件绑定
 * ------------------------------------------------------------------ */

function switchTab(tab) {
  state.tab = tab;
  $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.panel').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== tab));
  state.planKey = '';
  state.lastPlan = null;
  el.btnApply.disabled = true;
  el.preview.textContent = '点击「预览命令」查看将要执行的确切命令。';
  el.notes.innerHTML = '';
  el.warnings.innerHTML = '';
}

function bind() {
  $$('#tabs button').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  el.btnPlan.addEventListener('click', previewPlan);
  el.btnApply.addEventListener('click', applyPlan);
  $('#btnRefresh').addEventListener('click', refreshAll);
  $('#btnLog').addEventListener('click', loadLog);

  $('#form').addEventListener('input', () => {
    toggleEditFields();
    afterEdit();
  });
  $('#edMethod').addEventListener('change', () => {
    toggleEditFields();
    afterEdit();
  });
  $('#edCon').addEventListener('change', (ev) => loadConnectionDetail(ev.target.value, true));
  $('#hsPass').addEventListener('input', afterEdit);

  installFormatters();
}

async function boot() {
  bind();
  toggleEditFields();
  await refreshAll();
  loadLog();
}

boot();
