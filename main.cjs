'use strict';

const { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme } = require('electron');
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { getRepository, getSnapshot, getPatch } = require('./lib/git.cjs');
const { startReview } = require('./lib/review.cjs');

app.setName('Codex Review Desk');
nativeTheme.themeSource = 'dark';
if (process.platform === 'win32') app.setAppUserModelId('CodexReviewDesk.Windows');

const page = path.join(__dirname, 'ui', 'index.html');
const pageUrl = pathToFileURL(page).href;
const modes = new Set(['worktree', 'unstaged', 'staged', 'base', 'commit']);
const maxReviewBytes = 128 * 1024;
const maxReviewFiles = 80;
const executable = process.env.CODEX_REVIEW_CLI || 'codex.exe';
const startPath = process.env.CODEX_REVIEW_REPOSITORY || '';
let win;
let repository = null;
let currentSnapshot = null;
let snapshotVersion = 0;
let activeReview = null;
let choosing = false;
let initialError;

function preferencesPath() {
  return path.join(app.getPath('userData'), 'desk-settings.json');
}

async function loadRepository(input) {
  const selected = await getRepository(input);
  repository = selected;
  currentSnapshot = null;
  snapshotVersion++;
  try {
    await fs.mkdir(app.getPath('userData'), { recursive: true });
    await fs.writeFile(preferencesPath(), JSON.stringify({ repository: selected.root }), 'utf8');
  } catch {
    // The current repository remains available when settings cannot be saved.
  }
  return selected;
}

function checkCli() {
  return new Promise(resolve => {
    execFile(executable, ['--version'], { timeout: 3500, windowsHide: true }, (error, stdout) => {
      resolve(!error && /^codex-cli\b/m.test(stdout));
    });
  });
}

function send(channel, value) {
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, value);
}

async function collectReviewInput(root, snapshot, signal) {
  const { files, target } = snapshot;
  const tooLarge = '改动太多，无法完整交给 Codex。请缩小范围，例如只审查暂存区或指定提交。';
  if (files.length > maxReviewFiles) throw new Error(tooLarge);
  const parts = [`Git 范围：${target.mode}${target.ref ? ` ${JSON.stringify(target.ref)}` : ''}\n`];
  let bytes = Buffer.byteLength(parts[0]);
  const throwIfCancelled = () => {
    if (signal.aborted) throw new Error('已取消审查。');
  };
  for (let i = 0; i < files.length; i += 4) {
    throwIfCancelled();
    const patches = await Promise.all(files.slice(i, i + 4).map(async file => ({ file, patch: await getPatch(root, target, file) })));
    throwIfCancelled();
    for (const { file, patch } of patches) {
      if (patch.truncated) throw new Error(tooLarge);
      if (!patch.text) continue;
      const chunk = `\n文件：${JSON.stringify(file.path)}\n${patch.text}\n`;
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxReviewBytes) throw new Error(tooLarge);
      parts.push(chunk);
    }
  }
  if (parts.length < 2) throw new Error('所选范围没有可审查的差异，请先刷新。');
  return parts.join('');
}

function createWindow(codexAvailable) {
  win = new BrowserWindow({
    title: 'Codex Review Desk',
    width: 1360,
    height: 850,
    minWidth: 640,
    minHeight: 500,
    backgroundColor: '#10141d',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  Menu.setApplicationMenu(null);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.on('will-attach-webview', event => event.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_, __, callback) => callback(false));
  win.webContents.session.setPermissionCheckHandler(() => false);

  function handle(name, handler) {
    ipcMain.handle(`desk:${name}`, (event, ...args) => {
      if (event.sender !== win.webContents || event.senderFrame?.url !== pageUrl || event.senderFrame.parent) {
        throw new Error('不支持此窗口操作。');
      }
      return handler(...args);
    });
  }

  handle('initial', () => ({ repository, alwaysOnTop: win.isAlwaysOnTop(), codexAvailable, error: initialError }));
  handle('choose-repository', async () => {
    if (activeReview || choosing) return null;
    choosing = true;
    try {
      const selected = await dialog.showOpenDialog(win, {
        title: '选择 Codex 正在使用的 Git 仓库',
        defaultPath: repository?.root || app.getPath('documents'),
        properties: ['openDirectory'],
      });
      return selected.canceled ? null : await loadRepository(selected.filePaths[0]);
    } finally {
      choosing = false;
    }
  });
  handle('snapshot', async (mode, ref = '') => {
    if (!repository) throw new Error('请先选择 Git 仓库。');
    if (!modes.has(mode) || typeof ref !== 'string' || ref.length > 512) throw new Error('无效的审查范围。');
    const source = repository;
    const version = ++snapshotVersion;
    currentSnapshot = null;
    const [snapshot, refreshed] = await Promise.all([
      getSnapshot(source.root, mode, ref.trim()),
      getRepository(source.root),
    ]);
    if (repository === source && version === snapshotVersion) {
      currentSnapshot = snapshot;
      repository = refreshed;
    }
    return { ...snapshot, repository: refreshed };
  });
  handle('patch', async fileId => {
    if (!repository || !currentSnapshot) throw new Error('请先载入改动列表。');
    const file = currentSnapshot.files.find(item => item.id === fileId);
    if (!file) throw new Error('该文件不在当前改动列表中，请刷新。');
    return getPatch(repository.root, currentSnapshot.target, file);
  });
  handle('pin', enabled => {
    if (typeof enabled !== 'boolean') throw new Error('无效的置顶状态。');
    win.setAlwaysOnTop(enabled);
    return win.isAlwaysOnTop();
  });
  handle('start-review', async () => {
    if (!codexAvailable) throw new Error('未找到可用的 Codex CLI。请检查安装后重新启动审查台。');
    if (activeReview) throw new Error('已有一项审查在运行。');
    if (choosing || !repository || !currentSnapshot?.files.length) throw new Error('请先载入有改动的审查范围。');
    const root = repository.root;
    const snapshot = currentSnapshot;
    const controller = new AbortController();
    let running;
    const task = { cancel: () => { controller.abort(); running?.cancel(); } };
    activeReview = task;
    try {
      send('desk:review-update', '正在整理所选范围的 Git 差异…');
      const fresh = await getSnapshot(root, snapshot.target.mode, snapshot.target.ref || '');
      if (controller.signal.aborted) throw new Error('已取消审查。');
      if (JSON.stringify(fresh) !== JSON.stringify(snapshot)) {
        throw new Error('改动列表已变化，请先刷新再审查。');
      }
      const input = await collectReviewInput(root, fresh, controller.signal);
      if (controller.signal.aborted) throw new Error('已取消审查。');
      running = startReview({
        repoRoot: root,
        target: snapshot.target,
        input,
        executable,
        onUpdate: phase => send('desk:review-update', phase),
      });
      return await running.done;
    } finally {
      if (activeReview === task) activeReview = null;
    }
  });
  handle('cancel-review', () => { activeReview?.cancel(); });
  handle('copy', text => {
    if (typeof text !== 'string' || text.length > 4 * 1024 * 1024) throw new Error('要复制的内容过长。');
    clipboard.writeText(text);
  });

  win.once('ready-to-show', () => win.show());
  win.loadFile(page).catch(error => {
    dialog.showErrorBox('Codex Review Desk', error.message);
    app.quit();
  });
}

async function start() {
  let preferred = startPath;
  if (!preferred) {
    try {
      const saved = JSON.parse(await fs.readFile(preferencesPath(), 'utf8'));
      if (typeof saved.repository === 'string') preferred = saved.repository;
    } catch { /* First run or settings unavailable. */ }
  }
  const [codexAvailable] = await Promise.all([checkCli(), (async () => {
    if (!preferred) return;
    try { await loadRepository(preferred); }
    catch (error) { initialError = `无法打开仓库：${error.message}`; }
  })()]);
  createWindow(codexAvailable);
}

if (!app.requestSingleInstanceLock({ repository: startPath })) {
  app.quit();
} else {
  const ready = app.whenReady().then(start);
  ready.catch(error => { dialog.showErrorBox('Codex Review Desk', error.message); app.quit(); });
  app.on('second-instance', (_, __, ___, data) => {
    ready.then(async () => {
      if (!win || win.isDestroyed()) return;
      if (win.isMinimized()) win.restore();
      win.focus();
      if (data?.repository && !activeReview && !choosing) {
        try { send('desk:repository-changed', await loadRepository(data.repository)); }
        catch (error) { dialog.showErrorBox('无法打开仓库', error.message); }
      }
    }).catch(() => {});
  });
  app.on('before-quit', () => { activeReview?.cancel(); });
  app.on('window-all-closed', () => app.quit());
}
