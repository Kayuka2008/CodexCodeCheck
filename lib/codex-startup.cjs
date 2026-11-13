'use strict';

const { execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');

const run = promisify(execFile);
const runKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const runValue = 'CodexCodeCheck';
const system32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const registry = path.join(system32, 'reg.exe');
const powershell = path.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');

async function startupEnabled() {
  if (process.platform !== 'win32') return false;
  try {
    await run(registry, ['query', runKey, '/v', runValue], { windowsHide: true, timeout: 5000 });
    return true;
  } catch { return false; }
}

async function setStartupEnabled(enabled, executable, sourceDirectory, currentCodexPid) {
  if (!enabled) {
    if (await startupEnabled()) {
      await run(registry, ['delete', runKey, '/v', runValue, '/f'], { windowsHide: true, timeout: 5000 });
    }
    return false;
  }
  const directory = path.join(process.env.LOCALAPPDATA, 'CodexCodeCheck');
  const script = path.join(directory, 'watch.ps1');
  await fs.mkdir(directory, { recursive: true });
  await fs.copyFile(path.join(__dirname, 'windows-dock.ps1'), script);
  const config = path.join(directory, 'startup.json');
  const generation = randomUUID();
  await fs.writeFile(`${config}.tmp`, JSON.stringify({ executable, sourceDirectory, generation }), 'utf8');
  await fs.rename(`${config}.tmp`, config);
  const watchFlags = ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File'];
  const command = `powershell.exe ${watchFlags.join(' ')} "%LOCALAPPDATA%\\CodexCodeCheck\\watch.ps1" -WatchCodex`;
  await run(registry, ['add', runKey, '/v', runValue, '/t', 'REG_EXPAND_SZ', '/d', command, '/f'], { windowsHide: true, timeout: 5000 });
  try {
    const launch = [
      '$flags = \'-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File\'',
      '$argsText = $flags + \' "\' + $env:CODEXCHECK_WATCH_SCRIPT + \'" -WatchCodex -Generation \' + $env:CODEXCHECK_WATCH_GENERATION',
      'if ($env:CODEXCHECK_SKIP_PID) { $argsText += \' -SkipProcessId \' + $env:CODEXCHECK_SKIP_PID }',
      'Start-Process -FilePath (Join-Path $PSHOME \'powershell.exe\') -WindowStyle Hidden -ArgumentList $argsText -ErrorAction Stop',
    ].join('; ');
    await run(powershell, ['-NoProfile', '-NonInteractive', '-Command', launch], {
      windowsHide: true,
      timeout: 5000,
      env: { ...process.env, CODEXCHECK_WATCH_SCRIPT: script, CODEXCHECK_WATCH_GENERATION: generation,
        CODEXCHECK_SKIP_PID: Number.isSafeInteger(currentCodexPid) ? String(currentCodexPid) : '' },
    });
  } catch (error) {
    await setStartupEnabled(false).catch(() => {});
    throw error;
  }
  return true;
}

module.exports = { startupEnabled, setStartupEnabled, powershell };
