'use strict';

/**
 * Thin, no-dependency wrapper around child_process.
 * Never uses a shell: every command is an argv array.
 */

const { execFile, execFileSync } = require('child_process');

const DEFAULT_TIMEOUT = 20000;

function run(bin, args, { timeout = DEFAULT_TIMEOUT } = {}) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err && typeof err.code === 'number' ? err.code : err ? -1 : 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || (err && err.message) || ''),
        argv: [bin, ...args],
      });
    });
  });
}

function runSync(bin, args, { timeout = 5000 } = {}) {
  try {
    const stdout = execFileSync(bin, args, {
      timeout,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, code: 0, stdout: String(stdout), stderr: '' };
  } catch (err) {
    return {
      ok: false,
      code: typeof err.status === 'number' ? err.status : -1,
      stdout: String(err.stdout || ''),
      stderr: String(err.stderr || err.message || ''),
    };
  }
}

function which(bin) {
  const candidates = [
    `/usr/bin/${bin}`,
    `/bin/${bin}`,
    `/usr/sbin/${bin}`,
    `/sbin/${bin}`,
    `/usr/local/bin/${bin}`,
    `/usr/local/sbin/${bin}`,
  ];
  for (const candidate of candidates) {
    const probe = runSync('test', ['-x', candidate], { timeout: 2000 });
    if (probe.ok) return candidate;
  }
  return '';
}

module.exports = { run, runSync, which };
