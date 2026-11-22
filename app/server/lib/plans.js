'use strict';

/**
 * Pure plan builders: payload + context -> ordered argv steps.
 *
 * Nothing here touches the system. The HTTP layer turns the plan into a preview
 * (and, on explicit confirmation, executes exactly these argv arrays).
 */

const v = require('./validate');

function step(title, bin, args) {
  return { title, bin, args };
}

function quote(arg) {
  const s = String(arg);
  if (s === '') return '""';
  return /[\s"'$`\\|&;<>()*?!#]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
}

function renderStep(s) {
  return [s.bin, ...s.args.map(quote)].join(' ');
}

function findDevice(ctx, name) {
  return (ctx.devices || []).find((d) => d.name === name) || null;
}

function managedNames(ctx) {
  return new Set(ctx.managedNames || []);
}

function existingSubnets(ctx) {
  return Array.isArray(ctx.subnets) ? ctx.subnets : [];
}

/* ------------------------------------------------------------------ */
/* 1. NAT 共享（ipv4.method shared）                                    */
/* ------------------------------------------------------------------ */

function planShared(p, ctx) {
  const iface = v.reqIface(p.iface, ctx);
  const dev = findDevice(ctx, iface);
  const address = v.reqCIDR(p.address, '共享网段地址');
  const dns = v.reqDns(p.dns);
  const mac = v.reqMAC(p.mac);
  const conName = `netgui-shared-${iface}`;
  const exists = (ctx.connections || []).includes(conName);
  const steps = [];
  const notes = [];
  const warnings = [];

  const baseArgs = ['ipv4.method', 'shared', 'ipv4.addresses', address, 'ipv6.method', 'ignore', 'ipv4.never-default', 'yes'];

  if (exists) {
    steps.push(step('更新共享连接（已存在则复用）', 'nmcli', ['connection', 'modify', conName, ...baseArgs]));
  } else {
    steps.push(
      step('创建共享连接', 'nmcli', [
        'connection', 'add', 'type', 'ethernet', 'ifname', iface, 'con-name', conName, ...baseArgs,
      ]),
    );
  }

  if (mac) {
    steps.push(step(`设置 MAC 地址 ${mac}`, 'nmcli', ['connection', 'modify', conName, '802-3-ethernet.cloned-mac-address', mac]));
  } else if (p.clearMac) {
    steps.push(step('恢复硬件默认 MAC', 'nmcli', ['connection', 'modify', conName, '802-3-ethernet.cloned-mac-address', '']));
  }

  if (dns.length) {
    steps.push(step(`设置 DNS ${dns.join(', ')}`, 'nmcli', ['connection', 'modify', conName, 'ipv4.dns', dns.join(',')]));
  }

  steps.push(step('启用连接', 'nmcli', ['connection', 'up', conName]));

  const host = String(address).split('/')[0];
  notes.push(`NetworkManager 会为 ${iface} 使用 ${address}，并自动启动 DHCP/DNS 与 NAT 转发；下级设备的网关和 DNS 都是 ${host}。`);
  notes.push('本模式是三层 NAT，下级设备处于独立子网，与上级网络互不可见，天然满足「一个 MAC 只能绑定一个 IP」的约束（上级只看到主机自己的 MAC）。');
  if (mac) notes.push(`已在 ${iface} 上克隆 MAC ${mac}：连接下级设备时对外呈现该 MAC。`);
  if (dev && dev.connected && dev.connection) {
    notes.push(`注意：${iface} 目前由连接「${dev.connection}」占用，启用新连接后会接管该网口（原连接配置不会被删除）。`);
  }

  for (const net of existingSubnets(ctx)) {
    if (net.cidr && v.isCIDR(net.cidr) && v.subnetsOverlap(address, net.cidr)) {
      warnings.push(`网段 ${v.cidrString(address)} 与连接「${net.name}」的 ${v.cidrString(net.cidr)} 重叠，可能导致路由冲突，建议换一个子网。`);
    }
  }
  if (mac && /^(00:00:00:00:00:00)$/.test(mac)) {
    warnings.push('全零 MAC 地址无效。');
  }

  return {
    action: 'shared',
    title: 'NAT 共享（推荐）',
    steps,
    notes,
    warnings,
    entry: { mode: 'shared', iface, conName, address, mac: mac || '' },
  };
}

/* ------------------------------------------------------------------ */
/* 2. OVS 桥接（二层交换机）                                            */
/* ------------------------------------------------------------------ */

function planBridge(p, ctx) {
  const iface = v.reqIface(p.iface, ctx);
  const bridge = String(p.bridge || '').trim();
  const bridges = ctx.bridges || [];

  if (!v.isIface(bridge)) throw new v.ValidationError('请选择要桥接到的 OVS 网桥');
  if (bridge === iface) throw new v.ValidationError('网口不能桥接到自身');
  if (!bridges.includes(bridge)) {
    throw new v.ValidationError(`网桥「${bridge}」不存在。请先在「系统设置 → 网络设置」为接入外网的网口启用 OVS，再回来配置。`);
  }
  if ((ctx.bridgePorts && ctx.bridgePorts[bridge] || []).includes(iface)) {
    throw new v.ValidationError(`${iface} 已经是网桥 ${bridge} 的端口`);
  }

  const steps = [
    step(`把 ${iface} 加入网桥 ${bridge}`, 'ovs-vsctl', ['--may-exist', 'add-port', bridge, iface]),
    step(`启用 ${iface}`, 'ip', ['link', 'set', iface, 'up']),
  ];

  const warnings = [];
  if (ctx.hasOvs === false) warnings.push('未检测到 ovs-vsctl，执行可能失败。');
  return {
    action: 'bridge',
    title: 'OVS 桥接（二层）',
    steps,
    notes: [
      `${iface} 会成为 ${bridge} 的一个端口，等于把 NAS 当交换机用：下级设备由上级路由器直接分配 IP。`,
      '二层桥接会让该网口与主网口共用同一 MAC 与同一条 IP 链路；如果你的网络限制「一个 MAC 只能绑定一个 IP」，请改用 NAT 共享模式。',
      'OVS 配置默认持久化，重启后仍生效；需要撤销时在下方「本应用创建的配置」里回滚。',
    ],
    warnings,
    entry: { mode: 'bridge', iface, bridge, conName: '' },
  };
}

/* ------------------------------------------------------------------ */
/* 3. WiFi 热点                                                        */
/* ------------------------------------------------------------------ */

function planHotspot(p, ctx) {
  const iface = v.reqIface(p.iface, ctx);
  const dev = findDevice(ctx, iface);
  if (dev && dev.type !== 'wifi') throw new v.ValidationError(`${iface} 不是无线网卡，无法创建热点`);

  const ssid = v.reqSSID(p.ssid);
  const password = v.reqWifiPassword(p.password);
  const band = p.band === 'a' || p.band === 'bg' ? p.band : '';
  const subnet = p.subnet ? v.reqCIDR(p.subnet, '热点网段') : '10.42.0.1/24';
  const conName = `netgui-hotspot-${iface}`;

  const hotspotArgs = ['device', 'wifi', 'hotspot', 'ifname', iface, 'con-name', conName, 'ssid', ssid, 'password', password];
  if (band) hotspotArgs.push('band', band);

  const steps = [
    step(`创建 / 启用热点「${ssid}」`, 'nmcli', hotspotArgs),
    step('确保热点网段与自动连接', 'nmcli', [
      'connection', 'modify', conName, 'ipv4.method', 'shared', 'ipv4.addresses', subnet, 'connection.autoconnect', 'yes',
    ]),
    step('应用连接', 'nmcli', ['connection', 'up', conName]),
  ];

  const warnings = [];
  if (band === 'a') warnings.push('5GHz 需要网卡与驱动支持 AP 模式（含 DFS 信道限制），若不生效请改用 2.4GHz。');
  return {
    action: 'hotspot',
    title: 'WiFi 热点',
    steps,
    notes: [
      `无线网卡 ${iface} 会作为 AP 广播「${ssid}」，客户端连接到 ${subnet} 子网，经主网口 NAT 上网。`,
      '密码使用 WPA2；长度 8-63 位。',
      '热点默认随系统启动自动开启（autoconnect=yes）。',
    ],
    warnings,
    entry: { mode: 'hotspot', iface, conName, address: subnet },
  };
}

/* ------------------------------------------------------------------ */
/* 4. 连接编辑（静态 IP / 网关 / DNS / MAC）                            */
/* ------------------------------------------------------------------ */

function planEdit(p, ctx) {
  const conName = String(p.conName || '').trim();
  if (!v.isConnName(conName)) throw new v.ValidationError('请选择要编辑的连接');
  if (!(ctx.connections || []).includes(conName)) throw new v.ValidationError(`连接「${conName}」不存在`);
  if (!managedNames(ctx).has(conName)) {
    throw new v.ValidationError(`为保证安全，只允许编辑本应用创建的连接（${conName} 不是）。请先用「共享网络」创建一个连接。`);
  }

  const method = p.method === 'auto' ? 'auto' : 'manual';
  const mac = v.reqMAC(p.mac);
  const steps = [];

  if (method === 'auto') {
    steps.push(step('改为自动获取（DHCP）', 'nmcli', ['connection', 'modify', conName, 'ipv4.method', 'auto', 'ipv4.addresses', '', 'ipv4.gateway', '', 'ipv4.dns', '']));
  } else {
    const address = v.reqCIDR(p.address, '静态地址');
    const gateway = v.reqGateway(p.gateway, address);
    const dns = v.reqDns(p.dns);
    const args = ['connection', 'modify', conName, 'ipv4.method', 'manual', 'ipv4.addresses', address];
    args.push('ipv4.gateway', gateway || '');
    args.push('ipv4.dns', dns.join(','));
    steps.push(step(`设置静态地址 ${address}`, 'nmcli', args));
  }

  if (mac) {
    steps.push(step(`设置 MAC 地址 ${mac}`, 'nmcli', ['connection', 'modify', conName, '802-3-ethernet.cloned-mac-address', mac]));
  } else if (p.clearMac) {
    steps.push(step('恢复硬件默认 MAC', 'nmcli', ['connection', 'modify', conName, '802-3-ethernet.cloned-mac-address', '']));
  }

  steps.push(step('重新启用连接', 'nmcli', ['connection', 'up', conName]));

  const notes = ['修改后连接会被重新激活，正在使用该网络的会话可能短暂中断。'];
  const warnings = [];
  if (method === 'manual' && !String(p.gateway || '').trim()) {
    warnings.push('未填写网关：该连接将只能访问同网段设备，不能出外网。');
  }
  return { action: 'edit', title: '连接编辑', steps, notes, warnings, entry: null };
}

/* ------------------------------------------------------------------ */
/* 5. 回滚                                                             */
/* ------------------------------------------------------------------ */

function planRevert(p, ctx) {
  const entry = p.entry || {};
  const steps = [];
  if (entry.mode === 'bridge' && entry.bridge && entry.iface) {
    if (!v.isIface(entry.bridge) || !v.isIface(entry.iface)) throw new v.ValidationError('回滚参数不合法');
    steps.push(step(`从网桥 ${entry.bridge} 移除 ${entry.iface}`, 'ovs-vsctl', ['--if-exists', 'del-port', entry.bridge, entry.iface]));
  } else if (entry.conName) {
    const conName = String(entry.conName);
    if (!v.isConnName(conName) || !conName.startsWith('netgui-')) throw new v.ValidationError('只能回滚本应用创建的连接');
    if ((ctx.connections || []).includes(conName)) {
      steps.push(step(`停用连接 ${conName}`, 'nmcli', ['connection', 'down', conName]));
      steps.push(step(`删除连接 ${conName}`, 'nmcli', ['connection', 'delete', conName]));
    }
  } else {
    throw new v.ValidationError('没有可回滚的配置');
  }
  return {
    action: 'revert',
    title: '回滚',
    steps,
    notes: ['回滚只删除本应用创建的连接 / 桥接端口，不会改动系统原有配置。'],
    warnings: [],
    entry: null,
  };
}

const BUILDERS = {
  shared: planShared,
  bridge: planBridge,
  hotspot: planHotspot,
  edit: planEdit,
  revert: planRevert,
};

function buildPlan(payload, ctx) {
  const action = String((payload && payload.action) || '');
  const builder = BUILDERS[action];
  if (!builder) throw new v.ValidationError(`未知操作：${action || '空'}`);
  const plan = builder(payload || {}, ctx || {});
  plan.preview = plan.steps.map(renderStep);
  return plan;
}

module.exports = { buildPlan, renderStep, quote, BUILDERS };
