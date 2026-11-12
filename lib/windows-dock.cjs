'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');

const script = path.join(__dirname, 'windows-dock.ps1');
const retryDelay = 2500;

/**
 * Watch the visible Codex desktop window. Bounds are in physical screen pixels.
 * `null` means no usable window. `handle` is the decimal HWND string and
 * `processId` is the owning Windows PID. Returns a function that stops tracking.
 */
function trackCodexWindow(onUpdate) {
  if (process.platform !== 'win32') {
    let stopped = false;
    queueMicrotask(() => { if (!stopped) onUpdate(null); });
    return () => { stopped = true; };
  }

  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  let helper;
  let retry;
  let lastLine;
  let stopped = false;

  function publish(line) {
    if (stopped || line === lastLine) return;
    let value;
    try { value = JSON.parse(line); }
    catch { return; }
    if (value !== null && (!value?.bounds || typeof value.handle !== 'string')) return;
    lastLine = line;
    onUpdate(value);
  }

  function start() {
    helper = spawn(powershell, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', script, '-ParentProcessId', String(process.pid),
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    createInterface({ input: helper.stdout, crlfDelay: Infinity }).on('line', publish);
    helper.on('error', () => {});
    helper.once('close', () => {
      helper = undefined;
      if (stopped) return;
      publish('null');
      retry = setTimeout(start, retryDelay);
      retry.unref();
    });
  }

  start();
  return () => {
    stopped = true;
    clearTimeout(retry);
    helper?.kill();
  };
}

module.exports = { trackCodexWindow };
