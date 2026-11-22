'use strict';

/**
 * Input validation for fn-netgui.
 * Every value that ends up in an argv array must pass through here first.
 */

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

const IFACE_RE = /^[A-Za-z0-9_.:@-]{1,32}$/;
const CONNAME_RE = /^[A-Za-z0-9_.:@ -]{1,64}$/;
const MAC_RE = /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/;

function octets(value) {
  const parts = String(value).split('.');
  if (parts.length !== 4) return null;
  const out = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

function isIPv4(value) {
  return octets(value) !== null;
}

/** "10.0.6.1/24" */
function isCIDR(value) {
  const [ip, prefix, extra] = String(value).split('/');
  if (extra !== undefined) return false;
  if (octets(ip) === null) return false;
  if (!/^\d{1,2}$/.test(prefix || '')) return false;
  const p = Number(prefix);
  return p >= 1 && p <= 32;
}

function ipToInt(ip) {
  const o = octets(ip);
  if (!o) return null;
  return (((o[0] << 24) >>> 0) + (o[1] << 16) + (o[2] << 8) + o[3]) >>> 0;
}

function prefixOf(cidr) {
  return Number(String(cidr).split('/')[1]);
}

function networkOf(cidr) {
  const ip = String(cidr).split('/')[0];
  const prefix = prefixOf(cidr);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipToInt(ip) & mask) >>> 0;
}

function cidrString(cidr) {
  const prefix = prefixOf(cidr);
  const net = networkOf(cidr);
  return `${(net >>> 24) & 255}.${(net >>> 16) & 255}.${(net >>> 8) & 255}.${net & 255}/${prefix}`;
}

/** Both are CIDR strings; true when the two subnets overlap. */
function subnetsOverlap(a, b) {
  if (prefixOf(a) === prefixOf(b)) return networkOf(a) === networkOf(b);
  const shorter = prefixOf(a) < prefixOf(b) ? a : b;
  const longer = shorter === a ? b : a;
  const mask = (0xffffffff << (32 - prefixOf(shorter))) >>> 0;
  return ((ipToInt(String(longer).split('/')[0]) & mask) >>> 0) === networkOf(shorter);
}

function isSameSubnet(cidr, ip) {
  return isCIDR(cidr) && isIPv4(ip) && cidrString(cidr) === cidrString(`${ip}/${prefixOf(cidr)}`);
}

function isMAC(value) {
  return MAC_RE.test(String(value || '').toUpperCase());
}

function normalizeMAC(value) {
  return String(value || '').toUpperCase().replace(/[^0-9A-F]/g, '').replace(/(.{2})(?=.)/g, '$1:');
}

function isIface(value) {
  return IFACE_RE.test(String(value || ''));
}

function isConnName(value) {
  return CONNAME_RE.test(String(value || '').trim());
}

function isSSID(value) {
  const s = String(value || '');
  if (s.length < 1 || s.length > 32) return false;
  // eslint-disable-next-line no-control-regex
  return !/[\u0000-\u001f\u007f]/.test(s);
}

function isWifiPassword(value) {
  const s = String(value || '');
  return s.length >= 8 && s.length <= 63 && !/[\u0000-\u001f\u007f]/.test(s);
}

function parseDnsList(value) {
  if (value === undefined || value === null || value === '') return [];
  const list = Array.isArray(value) ? value : String(value).split(/[,;\s]+/);
  return list.map((s) => String(s).trim()).filter(Boolean);
}

/* ---------------------------------------------------------------- *
 * Require helpers: throw ValidationError with a human readable message
 * ---------------------------------------------------------------- */

function reqIface(value, ctx, { allowVirtual = false } = {}) {
  const name = String(value || '').trim();
  if (!isIface(name)) throw new ValidationError(`网口名称不合法：${name}`);
  if (ctx && Array.isArray(ctx.devices) && ctx.devices.length) {
    const dev = ctx.devices.find((d) => d.name === name);
    if (!dev) throw new ValidationError(`网口不存在：${name}`);
    if (!allowVirtual && dev.virtual) throw new ValidationError(`不能对虚拟网口 ${name} 执行此操作`);
  }
  return name;
}

function reqCIDR(value, label = '地址') {
  const s = String(value || '').trim();
  if (!isCIDR(s)) throw new ValidationError(`${label} 格式应为 IPv4/掩码，例如 10.0.6.1/24（收到：${s || '空'}）`);
  return s;
}

function reqGateway(value, cidr) {
  const s = String(value || '').trim();
  if (!s) return '';
  if (!isIPv4(s)) throw new ValidationError(`网关格式不正确：${s}`);
  if (cidr && !isSameSubnet(cidr, s)) throw new ValidationError(`网关 ${s} 不在 ${cidrString(cidr)} 子网内`);
  return s;
}

function reqDns(value) {
  const list = parseDnsList(value);
  if (list.length > 3) throw new ValidationError('DNS 最多填写 3 个');
  for (const item of list) {
    if (!isIPv4(item)) throw new ValidationError(`DNS 格式不正确：${item}`);
  }
  return list;
}

function reqMAC(value, label = 'MAC 地址') {
  const s = normalizeMAC(value);
  if (!s) return '';
  if (!isMAC(s)) throw new ValidationError(`${label} 格式不正确：${value}`);
  return s;
}

function reqSSID(value) {
  const s = String(value || '').trim();
  if (!isSSID(s)) throw new ValidationError('WiFi 名称长度应为 1-32 个字符，且不能包含控制字符');
  return s;
}

function reqWifiPassword(value) {
  const s = String(value || '');
  if (!isWifiPassword(s)) throw new ValidationError('WiFi 密码长度应为 8-63 个字符');
  return s;
}

module.exports = {
  ValidationError,
  isIPv4,
  isCIDR,
  isMAC,
  isIface,
  isConnName,
  isSSID,
  isWifiPassword,
  isSameSubnet,
  subnetsOverlap,
  cidrString,
  normalizeMAC,
  parseDnsList,
  reqIface,
  reqCIDR,
  reqGateway,
  reqDns,
  reqMAC,
  reqSSID,
  reqWifiPassword,
};
