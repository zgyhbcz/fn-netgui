'use strict';

/**
 * 纯函数测试：计划构建 + 输入校验。不接触真实网络。
 * 运行：node tests/plans.test.js
 */

const assert = require('assert');
const v = require('../app/server/lib/validate');
const { buildPlan, renderStep } = require('../app/server/lib/plans');

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    process.stdout.write(`  ok  ${name}\n`);
  } catch (err) {
    failures.push({ name, err });
    process.stdout.write(`FAIL  ${name}\n      ${err.message}\n`);
  }
}

function throwsWith(fn, substring) {
  let thrown = null;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown, 'expected an error to be thrown');
  assert.ok(
    String(thrown.message).includes(substring),
    `expected message to include "${substring}", got "${thrown.message}"`,
  );
}

const ctx = {
  devices: [
    { name: 'enp1s0', type: 'ethernet', virtual: false, connected: true, connection: 'Wired connection 1' },
    { name: 'enp2s0', type: 'ethernet', virtual: false, connected: false, connection: '' },
    { name: 'wlp1s0', type: 'wifi', virtual: false, connected: false, connection: '' },
    { name: 'docker0', type: 'virtual', virtual: true, connected: true, connection: '' },
  ],
  connections: ['Wired connection 1', 'netgui-hotspot-wlp1s0'],
  bridges: ['enp1s0-ovs'],
  bridgePorts: { 'enp1s0-ovs': ['enp1s0'] },
  managedNames: ['netgui-shared-enp2s0', 'netgui-hotspot-wlp1s0'],
  subnets: [{ name: 'Wired connection 1', cidr: '192.168.1.10/24' }],
  hasOvs: true,
};

const ctxWithShared = { ...ctx, connections: [...ctx.connections, 'netgui-shared-enp2s0'] };

/* ---------------- validate ---------------- */

test('CIDR 校验', () => {
  assert.ok(v.isCIDR('10.0.6.1/24'));
  assert.ok(v.isCIDR('0.0.0.0/1'));
  assert.ok(!v.isCIDR('10.0.6.1/33'));
  assert.ok(!v.isCIDR('10.0.6.256/24'));
  assert.ok(!v.isCIDR('10.0.6.1'));
});

test('MAC 归一化', () => {
  assert.strictEqual(v.normalizeMAC('aabbccddeeff'), 'AA:BB:CC:DD:EE:FF');
  assert.strictEqual(v.normalizeMAC('AA-BB-CC-DD-EE-FF'), 'AA:BB:CC:DD:EE:FF');
  assert.ok(v.isMAC('AA:BB:CC:DD:EE:FF'));
  assert.ok(!v.isMAC('AA:BB:CC:DD:EE'));
});

test('子网重叠判断', () => {
  assert.ok(v.subnetsOverlap('10.0.6.1/24', '10.0.6.200/24'));
  assert.ok(v.subnetsOverlap('10.0.0.1/16', '10.0.6.1/24'));
  assert.ok(!v.subnetsOverlap('10.0.6.1/24', '10.0.7.1/24'));
  assert.strictEqual(v.cidrString('10.0.6.129/24'), '10.0.6.0/24');
});

test('网关必须同子网', () => {
  assert.strictEqual(v.reqGateway('192.168.50.1', '192.168.50.10/24'), '192.168.50.1');
  throwsWith(() => v.reqGateway('192.168.60.1', '192.168.50.10/24'), '不在');
  throwsWith(() => v.reqGateway('1.2.3', '192.168.50.10/24'), '格式');
});

/* ---------------- shared ---------------- */

test('NAT 共享：最小参数生成两条命令', () => {
  const plan = buildPlan({ action: 'shared', iface: 'enp2s0', address: '10.0.6.1/24' }, ctx);
  assert.strictEqual(plan.steps.length, 2);
  assert.deepStrictEqual(plan.steps[0].args.slice(0, 8), [
    'connection', 'add', 'type', 'ethernet', 'ifname', 'enp2s0', 'con-name', 'netgui-shared-enp2s0',
  ]);
  assert.ok(plan.steps[0].args.includes('shared'));
  assert.ok(plan.steps[0].args.includes('ipv4.never-default'));
  assert.strictEqual(plan.steps[1].bin, 'nmcli');
  assert.deepStrictEqual(plan.steps[1].args, ['connection', 'up', 'netgui-shared-enp2s0']);
  assert.strictEqual(plan.entry.conName, 'netgui-shared-enp2s0');
});

test('NAT 共享：已存在连接时改为 modify', () => {
  const fresh = buildPlan({ action: 'shared', iface: 'enp2s0', address: '10.0.6.1/24' }, ctx);
  const existing = buildPlan({ action: 'shared', iface: 'enp2s0', address: '10.0.6.1/24' }, ctxWithShared);
  assert.strictEqual(fresh.steps[0].args[1], 'add');
  assert.strictEqual(existing.steps[0].args[1], 'modify');
});

test('NAT 共享：带 MAC 与 DNS', () => {
  const plan = buildPlan(
    { action: 'shared', iface: 'enp2s0', address: '10.0.6.1/24', mac: 'aa-bb-cc-dd-ee-ff', dns: '223.5.5.5, 1.1.1.1' },
    ctx,
  );
  assert.strictEqual(plan.steps.length, 4);
  assert.deepStrictEqual(plan.steps[1].args, [
    'connection', 'modify', 'netgui-shared-enp2s0', '802-3-ethernet.cloned-mac-address', 'AA:BB:CC:DD:EE:FF',
  ]);
  assert.deepStrictEqual(plan.steps[2].args, [
    'connection', 'modify', 'netgui-shared-enp2s0', 'ipv4.dns', '223.5.5.5,1.1.1.1',
  ]);
  assert.strictEqual(plan.entry.mac, 'AA:BB:CC:DD:EE:FF');
});

test('NAT 共享：子网冲突产生告警', () => {
  const plan = buildPlan({ action: 'shared', iface: 'enp2s0', address: '192.168.1.5/24' }, ctx);
  assert.strictEqual(plan.warnings.length, 1);
  assert.ok(plan.warnings[0].includes('192.168.1.0/24'));
});

test('NAT 共享：拒绝非法输入', () => {
  throwsWith(() => buildPlan({ action: 'shared', iface: 'enp2s0', address: '10.0.6.1' }, ctx), '格式');
  throwsWith(() => buildPlan({ action: 'shared', iface: 'enp2s0', address: '10.0.6.1/24', mac: 'ZZ:BB' }, ctx), 'MAC');
  throwsWith(() => buildPlan({ action: 'shared', iface: 'docker0', address: '10.0.6.1/24' }, ctx), '虚拟');
  throwsWith(() => buildPlan({ action: 'shared', iface: 'nope0', address: '10.0.6.1/24' }, ctx), '不存在');
  throwsWith(() => buildPlan({ action: 'shared', iface: 'enp2s0', address: '10.0.6.1/24', dns: '999.1.1.1' }, ctx), 'DNS');
});

test('NAT 共享：命令注入字符被拒绝', () => {
  throwsWith(
    () => buildPlan({ action: 'shared', iface: 'enp2s0;reboot', address: '10.0.6.1/24' }, ctx),
    '不合法',
  );
  throwsWith(() => buildPlan({ action: 'shared', iface: 'enp2s0', address: '10.0.6.1/24; rm -rf /' }, ctx), '格式');
});

/* ---------------- bridge ---------------- */

test('OVS 桥接：生成 ovs-vsctl + ip 两条命令', () => {
  const plan = buildPlan({ action: 'bridge', iface: 'enp2s0', bridge: 'enp1s0-ovs' }, ctx);
  assert.strictEqual(plan.steps.length, 2);
  assert.deepStrictEqual(plan.steps[0].args, ['--may-exist', 'add-port', 'enp1s0-ovs', 'enp2s0']);
  assert.strictEqual(plan.steps[0].bin, 'ovs-vsctl');
  assert.strictEqual(plan.steps[1].bin, 'ip');
  assert.strictEqual(plan.entry.bridge, 'enp1s0-ovs');
});

test('OVS 桥接：网桥不存在时给出可操作提示', () => {
  throwsWith(() => buildPlan({ action: 'bridge', iface: 'enp2s0', bridge: 'eth9-ovs' }, ctx), '启用 OVS');
});

test('OVS 桥接：重复端口 / 自桥接被拒绝', () => {
  throwsWith(() => buildPlan({ action: 'bridge', iface: 'enp1s0', bridge: 'enp1s0-ovs' }, ctx), '已经是');
  throwsWith(() => buildPlan({ action: 'bridge', iface: 'enp2s0', bridge: 'enp2s0' }, ctx), '自身');
});

/* ---------------- hotspot ---------------- */

test('WiFi 热点：默认三步骤', () => {
  const plan = buildPlan(
    { action: 'hotspot', iface: 'wlp1s0', ssid: 'fnOS-Hotspot', password: 'passw0rd!' },
    ctx,
  );
  assert.strictEqual(plan.steps.length, 3);
  assert.deepStrictEqual(plan.steps[0].args.slice(0, 6), ['device', 'wifi', 'hotspot', 'ifname', 'wlp1s0', 'con-name']);
  assert.ok(plan.steps[0].args.includes('fnOS-Hotspot'));
  assert.strictEqual(plan.entry.conName, 'netgui-hotspot-wlp1s0');
});

test('WiFi 热点：SSID / 密码 / 网卡校验', () => {
  throwsWith(() => buildPlan({ action: 'hotspot', iface: 'enp2s0', ssid: 'x', password: '12345678' }, ctx), '不是无线');
  throwsWith(() => buildPlan({ action: 'hotspot', iface: 'wlp1s0', ssid: 'x', password: 'short' }, ctx), '8-63');
  throwsWith(() => buildPlan({ action: 'hotspot', iface: 'wlp1s0', ssid: '', password: '12345678' }, ctx), '1-32');
});

/* ---------------- edit ---------------- */

test('连接编辑：非本应用连接被拒绝', () => {
  throwsWith(
    () => buildPlan({ action: 'edit', conName: 'Wired connection 1', method: 'manual', address: '10.0.9.2/24' }, ctx),
    '只允许编辑',
  );
});

test('连接编辑：静态地址 + MAC', () => {
  const plan = buildPlan(
    {
      action: 'edit',
      conName: 'netgui-shared-enp2s0',
      method: 'manual',
      address: '10.0.9.2/24',
      gateway: '10.0.9.1',
      dns: '223.5.5.5',
      mac: '001122334455',
    },
    ctxWithShared,
  );
  assert.strictEqual(plan.steps.length, 3);
  assert.ok(plan.steps[0].args.includes('manual'));
  assert.ok(plan.steps[0].args.includes('10.0.9.2/24'));
  assert.strictEqual(plan.steps[2].args.join(' '), 'connection up netgui-shared-enp2s0');
});

test('连接编辑：自动获取时清空静态字段', () => {
  const plan = buildPlan({ action: 'edit', conName: 'netgui-shared-enp2s0', method: 'auto' }, ctxWithShared);
  const args = plan.steps[0].args;
  assert.ok(args.includes('auto'));
  assert.deepStrictEqual(args.slice(-6), ['ipv4.addresses', '', 'ipv4.gateway', '', 'ipv4.dns', '']);
});

/* ---------------- revert ---------------- */

test('回滚：NAT 连接', () => {
  const plan = buildPlan(
    { action: 'revert', entry: { id: 'shared:enp2s0', mode: 'shared', conName: 'netgui-shared-enp2s0' } },
    ctxWithShared,
  );
  assert.strictEqual(plan.steps.length, 2);
  assert.deepStrictEqual(plan.steps[1].args, ['connection', 'delete', 'netgui-shared-enp2s0']);
});

test('回滚：桥接端口', () => {
  const plan = buildPlan({ action: 'revert', entry: { mode: 'bridge', bridge: 'enp1s0-ovs', iface: 'enp2s0' } }, ctx);
  assert.deepStrictEqual(plan.steps[0].args, ['--if-exists', 'del-port', 'enp1s0-ovs', 'enp2s0']);
});

test('回滚：拒绝删除系统连接', () => {
  throwsWith(
    () => buildPlan({ action: 'revert', entry: { mode: 'shared', conName: 'Wired connection 1' } }, ctx),
    '只能回滚',
  );
});

/* ---------------- misc ---------------- */

test('未知 action 被拒绝', () => {
  throwsWith(() => buildPlan({ action: 'shell', cmd: 'reboot' }, ctx), '未知操作');
});

test('预览渲染可读且带引号', () => {
  const plan = buildPlan({ action: 'hotspot', iface: 'wlp1s0', ssid: 'My WiFi', password: 'passw0rd!' }, ctx);
  const line = renderStep(plan.steps[0]);
  assert.ok(line.startsWith('nmcli device wifi hotspot'));
  assert.ok(line.includes('"My WiFi"'));
});

/* ---------------- summary ---------------- */

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) process.exit(1);
