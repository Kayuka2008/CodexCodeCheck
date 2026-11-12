'use strict';

const { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, screen } = require('electron');
const { execFile } = require('node:child_process');
const { mkdirSync, renameSync, writeFileSync } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { getRepository, getSnapshot, getPatch } = require('./lib/git.cjs');
const { startReview } = require('./lib/review.cjs');
const { listProjectDirectory, readProjectFile, trackProjectFiles } = require('./lib/project-files.cjs');
const { readCodexProject } = require('./lib/codex-context.cjs');
const { trackCodexWindow } = require('./lib/windows-dock.cjs');
const { findDockAnchor, placeDock } = require('./lib/dock-geometry.cjs');

app.setName('Codex Review Desk');
nativeTheme.themeSource = 'dark';
if (process.platform === 'win32') app.setAppUserModelId('CodexReviewDesk.Windows');

const page = path.join(__dirname, 'ui', 'index.html');
const pageUrl = pathToFileURL(page).href;
const modes = new Set(['worktree', 'unstaged', 'staged', 'base', 'commit']);
const defaultDockAnchors = [
  { edge: 'right', inside: false, offset: 0 },
  { edge: 'left', inside: false, offset: 0 },
  { edge: 'right', inside: true, offset: 42 },
  { edge: 'left', inside: true, offset: 42 },
  { edge: 'bottom', inside: true, offset: 0 },
  { edge: 'top', inside: true, offset: 0 },
  { edge: 'bottom', inside: false, offset: 0 },
  { edge: 'top', inside: false, offset: 0 },
];
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
let latestPath = null;
let stopFiles;
let stopWindows;
let contextTimer;
let codexWindow = null;
let dockEnabled = true;
let following = !startPath;
let dockPositioned = false;
let dockAttached = false;
let dockAnchor = null;
let dockSize = null;
let placedAnchor = null;
let dockAdjustment = null;
let windowReady = false;
let lastDockState;
let activeContext = null;
let contextMisses = 0;
let syncing = false;

async function resolveProject(input) {
  const root = await fs.realpath(input);
  if (!(await fs.stat(root)).isDirectory()) throw new Error('请选择一个目录。');
  try {
    return { ...await getRepository(root), isGit: true };
  } catch (error) {
    if (!/请选择 Git 仓库中的目录|找不到 Git/.test(error.message)) throw error;
    return { root, name: path.basename(root) || root, branch: '', hasHead: false, isGit: false };
  }
}

function setProject(selected) {
  stopFiles?.();
  stopFiles = undefined;
  repository = selected;
  latestPath = null;
  currentSnapshot = null;
  snapshotVersion++;
  if (selected) {
    stopFiles = trackProjectFiles(selected, relative => {
      latestPath = relative;
      send('desk:project-activity', { path: relative, root: selected.root });
    });
  }
}

function preferencesPath() {
  return path.join(app.getPath('userData'), 'desk-settings.json');
}

function dockLayoutPath() {
  return path.join(app.getPath('userData'), 'dock-layout.json');
}

async function restoreDockLayout() {
  try {
    const { anchor, width, height } = JSON.parse(await fs.readFile(dockLayoutPath(), 'utf8'));
    if (!['left', 'right', 'top', 'bottom'].includes(anchor?.edge) || typeof anchor.inside !== 'boolean' ||
        !Number.isSafeInteger(anchor.offset) || Math.abs(anchor.offset) > 16384 ||
        !Number.isSafeInteger(width) || width < 360 || width > 16384 ||
        !Number.isSafeInteger(height) || height < 300 || height > 16384) return;
    dockAnchor = { edge: anchor.edge, inside: anchor.inside, offset: anchor.offset };
    if (anchor.edge === 'left' && !anchor.inside && anchor.allowOverhang === true) dockAnchor.allowOverhang = true;
    dockSize = { width, height };
  } catch { /* Use the default placement if a saved layout is unavailable. */ }
}

function rememberDockLayout({ width, height }) {
  dockSize = { width, height };
  if (!dockAnchor) return;
  const file = dockLayoutPath();
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify({ anchor: dockAnchor, width, height }), 'utf8');
    renameSync(`${file}.tmp`, file);
  } catch { /* Keep using the layout for this session if it cannot be saved. */ }
}

async function selectManualProject(input) {
  const selected = await resolveProject(input);
  following = false;
  activeContext = null;
  setProject(selected);
  publishDock();
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

function dockState() {
  const attached = dockEnabled && Boolean(codexWindow) && dockAttached;
  let status = '独立窗口';
  if (dockEnabled) status = codexWindow ? '等待贴边' : '等待 Codex 窗口';
  if (attached) status = `已吸附 · ${placedAnchor.inside ? '内侧' : '外侧'}`;
  if (attached) status += activeContext ? ' · 跟随项目' : following ? ' · 等待项目' : ' · 手动项目';
  return { enabled: dockEnabled, attached, following, status };
}

function publishDock() {
  const state = dockState();
  const signature = JSON.stringify(state);
  if (signature !== lastDockState) {
    lastDockState = signature;
    send('desk:dock-changed', state);
  }
  return state;
}

function dockTarget() {
  const target = screen.screenToDipRect(null, codexWindow.bounds);
  const primary = screen.getDisplayMatching(target);
  const workAreas = [primary.workArea, ...screen.getAllDisplays()
    .filter(display => display.id !== primary.id).map(display => display.workArea)];
  return { target, workAreas };
}

function defaultDockSize(current, target, workAreas) {
  const area = workAreas[0];
  const outsideWidth = Math.min(465, area.width);
  const hasOutsideSpace = workAreas.some(workArea => {
    const onLeft = target.x - outsideWidth >= workArea.x && target.x <= workArea.x + workArea.width;
    const onRight = target.x + target.width >= workArea.x && target.x + target.width + outsideWidth <= workArea.x + workArea.width;
    return (onLeft || onRight) && target.y < workArea.y + workArea.height && target.y + target.height > workArea.y;
  });
  const width = hasOutsideSpace ? outsideWidth : Math.min(outsideWidth, Math.max(380, Math.round(target.width * 0.39)));
  const height = Math.min(area.height, Math.max(300, target.height - (hasOutsideSpace ? 0 : 42)));
  return { ...current, width, height };
}

function updateDockPosition() {
  if (!windowReady || !win || win.isDestroyed() || dockAdjustment) return;
  if (!dockEnabled || !codexWindow) {
    dockAttached = false;
    if (dockEnabled && dockPositioned && !win.isFocused() && !choosing) win.hide();
    publishDock();
    return;
  }

  const { target, workAreas } = dockTarget();
  const current = win.getBounds();
  const panel = dockSize ? { ...current, ...dockSize } : dockPositioned ? current : defaultDockSize(current, target, workAreas);
  const anchors = dockAnchor
    ? [dockAnchor, { ...dockAnchor, inside: !dockAnchor.inside }, ...defaultDockAnchors]
    : defaultDockAnchors;
  let bounds;
  for (const anchor of anchors) {
    bounds = placeDock(panel, target, workAreas, anchor);
    if (!bounds) continue;
    placedAnchor = anchor;
    dockAnchor ??= anchor;
    break;
  }

  dockAttached = Boolean(bounds);
  if (bounds) {
    dockPositioned = true;
    if (Object.keys(bounds).some(key => current[key] !== bounds[key])) win.setBounds(bounds);
  }
  if (!win.isVisible()) win.showInactive();
  publishDock();
}

function finishDockAdjustment(kind) {
  if (dockAdjustment !== kind) return;
  // The Windows move/resize loop must exit before setBounds can apply the snap.
  setImmediate(() => {
    if (dockAdjustment !== kind) return;
    dockAdjustment = null;
    if (win.isDestroyed()) return;
    if (!dockEnabled || !codexWindow) {
      updateDockPosition();
      return;
    }
    const { target, workAreas } = dockTarget();
    const panel = win.getBounds();
    if (kind === 'move') {
      const anchor = findDockAnchor(panel, target, workAreas);
      if (anchor) {
        if (anchor.edge === 'left' && !anchor.inside && dockAnchor?.allowOverhang) anchor.allowOverhang = true;
        dockAnchor = anchor;
        rememberDockLayout(panel);
      }
    } else if (placedAnchor) {
      const verticalEdge = placedAnchor.edge === 'left' || placedAnchor.edge === 'right';
      const offset = verticalEdge ? panel.y - target.y : panel.x - target.x;
      dockAnchor = { ...placedAnchor, offset };
      rememberDockLayout(panel);
    }
    updateDockPosition();
  });
}

async function syncProject() {
  if (!following || syncing || choosing || activeReview) return;
  syncing = true;
  try {
    const context = await readCodexProject();
    if (!following || choosing || activeReview) return;
    if (!context) {
      if (activeContext && ++contextMisses >= 2) {
        activeContext = null;
        setProject(null);
        send('desk:repository-changed', { repository, latestPath });
        publishDock();
      }
      return;
    }
    contextMisses = 0;
    if (activeContext?.key === context.key && activeContext.root === context.root) return;
    const selected = await resolveProject(context.root);
    if (!following || choosing || activeReview) return;
    activeContext = context;
    setProject(selected);
    send('desk:repository-changed', { repository, latestPath });
    publishDock();
  } catch { /* A project may move or disappear between reading state and opening its folder. */ }
  finally { syncing = false; }
}

function setDocked(enabled) {
  if (typeof enabled !== 'boolean') throw new Error('无效的吸附状态。');
  const reattach = enabled && !dockEnabled;
  dockEnabled = enabled;
  following = enabled;
  if (enabled) {
    if (reattach && codexWindow) {
      const { target, workAreas } = dockTarget();
      const panel = win.getBounds();
      dockAnchor = findDockAnchor(panel, target, workAreas) ?? dockAnchor;
      dockSize = { width: panel.width, height: panel.height };
    }
    updateDockPosition();
    if (reattach && dockAttached) rememberDockLayout(win.getBounds());
    void syncProject();
  } else {
    activeContext = null;
    dockAttached = false;
    dockAdjustment = null;
    if (!win.isVisible()) win.showInactive();
  }
  return publishDock();
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
    width: dockSize?.width ?? 540,
    height: dockSize?.height ?? 700,
    minWidth: 360,
    minHeight: 300,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: true,
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

  handle('initial', () => ({ repository, latestPath, dock: dockState(), codexAvailable, error: initialError }));
  handle('choose-repository', async () => {
    if (activeReview || choosing) return null;
    choosing = true;
    try {
      const selected = await dialog.showOpenDialog(win, {
        title: '选择要查看的项目目录',
        defaultPath: repository?.root || app.getPath('documents'),
        properties: ['openDirectory'],
      });
      return selected.canceled ? null : await selectManualProject(selected.filePaths[0]);
    } finally {
      choosing = false;
    }
  });
  handle('snapshot', async (mode, ref = '') => {
    if (!repository?.isGit) throw new Error('当前项目没有可用的 Git 仓库。');
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
      repository = { ...refreshed, isGit: true };
    }
    return { ...snapshot, repository: { ...refreshed, isGit: true } };
  });
  handle('patch', async fileId => {
    if (!repository || !currentSnapshot) throw new Error('请先载入改动列表。');
    const file = currentSnapshot.files.find(item => item.id === fileId);
    if (!file) throw new Error('该文件不在当前改动列表中，请刷新。');
    return getPatch(repository.root, currentSnapshot.target, file);
  });
  handle('tree', relative => {
    if (!repository) return { entries: [], truncated: false };
    return listProjectDirectory(repository, relative);
  });
  handle('read-file', relative => {
    if (!repository) throw new Error('请先打开项目。');
    return readProjectFile(repository, relative);
  });
  handle('dock', setDocked);
  handle('close', () => { setImmediate(() => win.close()); });
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

  win.once('ready-to-show', () => {
    windowReady = true;
    updateDockPosition();
    if (!win.isVisible()) win.showInactive();
  });
  win.on('focus', updateDockPosition);
  win.on('blur', () => setTimeout(updateDockPosition, 250));
  win.on('will-move', () => { if (dockEnabled) dockAdjustment = 'move'; });
  win.on('moved', () => finishDockAdjustment('move'));
  win.on('will-resize', () => { if (dockEnabled) dockAdjustment = 'resize'; });
  win.on('resized', () => finishDockAdjustment('resize'));
  win.loadFile(page).catch(error => {
    dialog.showErrorBox('Codex Review Desk', error.message);
    app.quit();
  });
}

async function start() {
  await restoreDockLayout();
  if (startPath) {
    try { await selectManualProject(startPath); }
    catch (error) { initialError = `无法打开项目：${error.message}`; }
  } else {
    await syncProject();
  }
  if (!repository && !startPath) {
    try {
      const saved = JSON.parse(await fs.readFile(preferencesPath(), 'utf8'));
      if (typeof saved.repository === 'string') setProject(await resolveProject(saved.repository));
    } catch { /* First run or settings unavailable. */ }
  }
  createWindow(await checkCli());
  stopWindows = trackCodexWindow(value => {
    const becameForeground = value?.foreground && (!codexWindow?.foreground || value.handle !== codexWindow.handle);
    codexWindow = value;
    updateDockPosition();
    if (becameForeground && dockEnabled && win && !win.isDestroyed() && win.isVisible()) win.moveTop();
    publishDock();
  });
  for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) {
    screen.on(event, updateDockPosition);
  }
  contextTimer = setInterval(() => void syncProject(), 1500);
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
      if (!win.isVisible()) win.show();
      win.focus();
      if (data?.repository && !activeReview && !choosing) {
        try {
          await selectManualProject(data.repository);
          send('desk:repository-changed', { repository, latestPath });
        }
        catch (error) { dialog.showErrorBox('无法打开仓库', error.message); }
      }
    }).catch(() => {});
  });
  app.on('before-quit', () => {
    activeReview?.cancel();
    stopFiles?.();
    stopWindows?.();
    clearInterval(contextTimer);
  });
  app.on('window-all-closed', () => app.quit());
}
