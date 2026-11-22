'use strict';

/**
 * Read-only queries against NetworkManager / iproute2 / Open vSwitch.
 * All functions degrade gracefully: missing tools yield empty results plus a note,
 * they never throw for a "tool not installed" condition.
 */

const fs = require('fs');
const os = require('os');
const { runSync, which } = require('./shell');

const VIRTUAL_PREFIXES = [
  'lo', 'docker', 'veth', 'br-', 'virbr', 'vnet', 'tap', 'tun', 'wg', 'zt', 'tailscale',
  'ovs-', 'kube', 'macvlan', 'dummy', 'bond-', 'nkVlan',
];

const tools = {
  nmcli: '',
  ip: '',
  ovsVsctl: '',
  ovsVersion: '',
  nmcliVersion: '',
  checkedAt: 0,
};

function detectTools(force = false) {
  const now = Date.now();
  if (!force && tools.checkedAt && now - tools.checkedAt < 30000) return tools;

  tools.nmcli = which('nmcli');
  tools.ip = which('ip');
  tools.ovsVsctl = which('ovs-vsctl');

  if (tools.nmcli) {
    const v = runSync(tools.nmcli, ['--version']);
    tools.nmcliVersion = (v.stdout || v.stderr || '').split('\n')[0].trim();
  } else {
    tools.nmcliVersion = '';
  }
  if (tools.ovsVsctl) {
    const v = runSync(tools.ovsVsctl, ['--version']);
    tools.ovsVersion = (v.stdout || v.stderr || '').split('\n')[0].trim();
  } else {
    tools.ovsVersion = '';
  }
  tools.checkedAt = now;
  return tools;
}

function nmcliAvailable() {
  return Boolean(detectTools().nmcli);
}

/** nmcli -t helpers ------------------------------------------------- */

function nmcliTerse(fields, object, action, extra = []) {
  const t = detectTools();
  if (!t.nmcli) return { ok: false, rows: [], error: 'nmcli 不可用' };
  const res = runSync(t.nmcli, ['-t', '-f', fields, object, action, ...extra]);
  if (!res.ok) {
    return { ok: false, rows: [], error: (res.stderr || res.stdout || '').trim() || `nmcli ${object} ${action} 失败` };
  }
  const rows = res.stdout
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.length > 0)
    .map((line) => splitTerse(line));
  return { ok: true, rows, error: '' };
}

/**
 * nmcli -t joins values with ':' and escapes ':' inside values as '\:'.
 * Split on unescaped colons only.
 */
function splitTerse(line) {
  const out = [];
  let current = '';
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '\\' && line[i + 1] === ':') {
      current += ':';
      i += 1;
      continue;
    }
    if (ch === ':') {
      out.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out;
}

function getValue(name, field) {
  const t = detectTools();
  if (!t.nmcli) return '';
  const res = runSync(t.nmcli, ['-g', field, 'connection', 'show', name]);
  if (!res.ok) return '';
  return res.stdout.trim();
}

/** Devices --------------------------------------------------------- */

function readIpJson(args) {
  const t = detectTools();
  if (!t.ip) return [];
  const res = runSync(t.ip, ['-j', ...args], { timeout: 8000 });
  if (!res.ok) return [];
  try {
    const parsed = JSON.parse(res.stdout || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function isVirtualName(name) {
  return VIRTUAL_PREFIXES.some((prefix) => (prefix.endsWith('-') ? name.startsWith(prefix) : name === prefix || name.startsWith(prefix)));
}

function listDevices() {
  const links = readIpJson(['link', 'show']);
  const addrs = readIpJson(['-4', 'addr', 'show']);
  const nmStatus = nmcliTerse('DEVICE,STATE,CONNECTION', 'device', 'status');

  const nmByDevice = new Map();
  if (nmStatus.ok) {
    for (const row of nmStatus.rows) {
      nmByDevice.set(row[0], { state: row[1] || '', connection: row[2] || '' });
    }
  }

  const addrByDevice = new Map();
  for (const entry of addrs) {
    const list = (entry.addr_info || [])
      .filter((a) => a.family === 'inet')
      .map((a) => ({ address: a.local, prefix: a.prefixlen }));
    addrByDevice.set(entry.ifname, list);
  }

  const devices = [];
  for (const link of links) {
    const name = link.ifname;
    if (!name) continue;
    const sysBase = `/sys/class/net/${name}`;
    const wireless = fs.existsSync(`${sysBase}/wireless`);
    const hasDevice = fs.existsSync(`${sysBase}/device`);
    const virtual = isVirtualName(name) || (!hasDevice && !wireless);
    const nm = nmByDevice.get(name) || { state: '', connection: '' };
    const ipv4 = addrByDevice.get(name) || [];

    let type = 'ethernet';
    if (wireless) type = 'wifi';
    else if (virtual) type = 'virtual';

    devices.push({
      name,
      type,
      mac: String(link.address || '').toUpperCase(),
      operstate: link.operstate || '',
      mtu: link.mtu || null,
      virtual,
      connected: nm.state === 'connected' || ipv4.length > 0,
      nmState: nm.state,
      connection: nm.connection,
      ipv4,
    });
  }

  devices.sort((a, b) => {
    const rank = (d) => (d.virtual ? 2 : d.type === 'wifi' ? 1 : 0);
    return rank(a) - rank(b) || a.name.localeCompare(b.name);
  });

  return { devices, error: nmStatus.error };
}

/** Connections ----------------------------------------------------- */

const DETAIL_FIELDS = {
  type: 'connection.type',
  iface: 'connection.interface-name',
  method: 'ipv4.method',
  addresses: 'ipv4.addresses',
  gateway: 'ipv4.gateway',
  dns: 'ipv4.dns',
  mac: '802-3-ethernet.cloned-mac-address',
  autoconnect: 'connection.autoconnect',
};

function listConnections() {
  const res = nmcliTerse('NAME,UUID,TYPE,DEVICE', 'connection', 'show');
  if (!res.ok) return { connections: [], error: res.error };
  const connections = res.rows.map((row) => ({
    name: row[0] || '',
    uuid: row[1] || '',
    type: row[2] || '',
    device: row[3] || '',
  }));
  return { connections: connections.filter((c) => c.name), error: '' };
}

function getConnectionDetails(name) {
  const details = { name };
  for (const [key, field] of Object.entries(DETAIL_FIELDS)) {
    const raw = getValue(name, field);
    if (key === 'addresses' || key === 'dns') {
      details[key] = raw
        ? raw.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean)
        : [];
    } else {
      details[key] = raw;
    }
  }
  return details;
}

function connectionNames() {
  const { connections } = listConnections();
  return connections.map((c) => c.name);
}

/** OVS ------------------------------------------------------------- */

function listBridges() {
  const t = detectTools();
  if (!t.ovsVsctl) return { bridges: [], error: 'ovs-vsctl 不可用' };
  const res = runSync(t.ovsVsctl, ['list-br']);
  if (!res.ok) return { bridges: [], error: (res.stderr || '').trim() };
  const bridges = res.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  return { bridges, error: '' };
}

function listBridgePorts(bridge) {
  const t = detectTools();
  if (!t.ovsVsctl) return { ports: [], error: 'ovs-vsctl 不可用' };
  const res = runSync(t.ovsVsctl, ['list-ports', bridge]);
  if (!res.ok) return { ports: [], error: (res.stderr || '').trim() };
  const ports = res.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  return { ports, error: '' };
}

/** Host facts ------------------------------------------------------ */

function hostInfo() {
  let fnosVersion = '';
  try {
    const raw = fs.readFileSync('/etc/trim-release', 'utf8');
    fnosVersion = raw.trim();
  } catch (e) {
    fnosVersion = process.env.TRIM_SYS_VERSION || '';
  }
  return {
    hostname: os.hostname(),
    arch: os.arch(),
    platform: os.platform(),
    release: os.release(),
    node: process.version,
    fnosVersion,
    uptime: Math.round(os.uptime()),
  };
}

module.exports = {
  detectTools,
  nmcliAvailable,
  listDevices,
  listConnections,
  getConnectionDetails,
  connectionNames,
  listBridges,
  listBridgePorts,
  hostInfo,
};
