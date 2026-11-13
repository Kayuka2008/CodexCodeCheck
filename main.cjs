'use strict';

const { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeTheme, screen } = require('electron');
const { execFile } = require('node:child_process');
const { mkdirSync, renameSync, writeFileSync } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { getRepository, getSnapshot, getPatch } = require('./lib/git.cjs');
const { startReview } = require('./lib/review.cjs');
const { listProjectDirectory, readProjectFile, trackProjectFiles, indexSearchFiles, searchProjectFiles } = require('./lib/project-files.cjs');
const { readCodexProject } = require('./lib/codex-context.cjs');
const { trackCodexWindow } = require('./lib/windows-dock.cjs');
const { findDockAnchor } = require('./lib/dock-geometry.cjs');
const { placePanel, placeTab, findTabAnchor, clampWindow, tabSize } = require('./lib/companion-layout.cjs');
const { startupEnabled, setStartupEnabled, powershell } = require('./lib/codex-startup.cjs');

app.setName('Codex Review Desk');
nativeTheme.themeSource = 'dark';
if (process.platform === 'win32') app.setAppUserModelId('CodexReviewDesk.Windows');

const page = path.join(__dirname, 'ui', 'index.html');
const pageUrl = pathToFileURL(page).href;
const modes = new Set(['worktree', 'unstaged', 'staged', 'base', 'commit']);
const maxReviewBytes = 128 * 1024;
const maxReviewFiles = 80;
const ballSize = tabSize;
const panelMinimumSize = [360, 300];
const peekShortcut = 'Control+Shift+Space';
let executable = process.env.CODEX_REVIEW_CLI || 'codex.exe';
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
let autoSize = true;
let dockMode = 'attached';
let changingSettings = false;
let placedAnchor = null;
let clippedEdge = null;
let clippedWidth = 0;
let dockAdjustment = null;
let windowReady = false;
let collapsed = false;
let expandedBounds = null;
let collapseBallOrigin = null;
let ballPlacement = null;
let ballDrag = null;
let ballEdge = 'right';
let ballInside = false;
let hostSeen = false;
let hostProbeReady = false;
let applyingBounds = false;
let shortcutAvailable = false;
let projectSearchIndex = null;
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
  projectSearchIndex = null;
  latestPath = null;
  currentSnapshot = null;
  snapshotVersion++;
  if (selected) {
    stopFiles = trackProjectFiles(selected, relative => {
      latestPath = relative;
      projectSearchIndex = null;
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
    const { anchor, width, height, autoSize: savedAutoSize, ball, mode } = JSON.parse(await fs.readFile(dockLayoutPath(), 'utf8'));
    autoSize = savedAutoSize === true;
    dockMode = mode === 'free' ? 'free' : 'attached';
    if (ball && ['left', 'right', 'top', 'bottom'].includes(ball.edge) && Number.isSafeInteger(ball.offset)) {
      ballPlacement = { edge: ball.edge, offset: Math.max(12, Math.min(16384, ball.offset)) };
    } else if (ball && [ball.x, ball.y].every(value => Number.isSafeInteger(value) && Math.abs(value) <= 100000)) {
      // Migrate old relative XY coordinates into a real edge anchor.
      ballPlacement = ball.relative
        ? { edge: anchor?.edge ?? 'right', offset: ['top', 'bottom'].includes(anchor?.edge) ? ball.x : ball.y }
        : { x: ball.x, y: ball.y };
    }
    if (!['left', 'right', 'top', 'bottom'].includes(anchor?.edge) || typeof anchor.inside !== 'boolean' ||
        !Number.isSafeInteger(anchor.offset) || Math.abs(anchor.offset) > 16384 ||
        !Number.isSafeInteger(width) || width < 360 || width > 16384 ||
        !Number.isSafeInteger(height) || height < 300 || height > 16384) return;
    dockAnchor = { edge: anchor.edge, inside: anchor.inside, offset: anchor.offset };
    if (['left', 'right'].includes(anchor.edge) && !anchor.inside && anchor.allowOverhang === true) dockAnchor.allowOverhang = true;
    dockSize = { width, height };
  } catch { /* Use the default placement if a saved layout is unavailable. */ }
}

function saveDockLayout() {
  const file = dockLayoutPath();
  const { width, height } = dockSize ?? expandedBounds ?? win.getBounds();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify({ version: 2, anchor: dockAnchor, width, height, autoSize, mode: dockMode, ball: ballPlacement }), 'utf8');
  renameSync(`${file}.tmp`, file);
}

function rememberDockLayout({ width, height }) {
  dockSize = { width, height };
  try {
    saveDockLayout();
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

function probeCli(command) {
  return new Promise(resolve => {
    execFile(command, ['--version'], { timeout: 3500, windowsHide: true }, (error, stdout) => {
      resolve(!error && /^codex-cli\b/m.test(stdout));
    });
  });
}

async function checkCli() {
  if (await probeCli(executable)) return true;
  if (process.env.CODEX_REVIEW_CLI || process.platform !== 'win32') return false;
  const bundled = await new Promise(resolve => {
    const command = '$p = Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1; if ($p) { [Console]::OutputEncoding = [Text.Encoding]::UTF8; Join-Path $p.InstallLocation "app\\resources\\codex.exe" }';
    execFile(powershell, ['-NoProfile', '-NonInteractive', '-Command', command],
      { timeout: 7000, windowsHide: true }, (error, stdout) => resolve(error ? '' : stdout.trim()));
  });
  if (!bundled || !await probeCli(bundled)) return false;
  executable = bundled;
  return true;
}

function send(channel, value) {
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, value);
}

function dockState() {
  const attached = dockEnabled && Boolean(codexWindow) && dockMode === 'attached' && dockAttached;
  let status = '独立窗口';
  if (dockEnabled) status = codexWindow ? '等待贴边' : '等待 Codex 窗口';
  if (attached) {
    const edge = { left: '左', right: '右', top: '上', bottom: '下' }[collapsed ? ballEdge : placedAnchor?.edge];
    status = `已贴合 · ${edge}${(collapsed ? ballInside : placedAnchor?.inside) ? '内侧' : '外侧'}`;
  }
  if (dockEnabled && dockMode === 'free') status = '已脱离 · 拖回边缘可吸附';
  if (attached) status += activeContext ? ' · 跟随项目' : following ? ' · 等待项目' : ' · 手动项目';
  return { enabled: dockEnabled, attached, following, status, collapsed,
    edge: placedAnchor?.edge ?? dockAnchor?.edge ?? 'right', inside: placedAnchor?.inside ?? false,
    ballAttached: attached && collapsed, ballEdge, ballInside,
    clippedEdge: attached ? clippedEdge : null, clippedWidth: attached ? clippedWidth : 0 };
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

function floatingBallBounds(panel, target, workAreas, anchor) {
  if (target && dockMode === 'attached') {
    const preferred = ballPlacement?.edge ? ballPlacement : { edge: anchor?.edge ?? 'right', offset: 72 };
    const placed = placeTab(target, workAreas, preferred);
    ballEdge = placed.edge;
    ballInside = placed.inside;
    return placed.bounds;
  }
  const origin = ballPlacement && Number.isFinite(ballPlacement.x) ? ballPlacement
    : { x: panel.x + panel.width - ballSize, y: panel.y };
  return clampBall({ ...origin, width: ballSize, height: ballSize });
}

function clampBall(bounds) {
  const area = screen.getDisplayMatching(bounds).workArea;
  return clampWindow(bounds, area);
}

function applyBounds(bounds) {
  const current = win.getBounds();
  if (['x', 'y', 'width', 'height'].every(key => current[key] === bounds[key])) return;
  applyingBounds = true;
  try { win.setBounds(bounds); }
  finally { applyingBounds = false; }
}

function syncWindowLayer() {
  if (!windowReady || !win || win.isDestroyed()) return;
  const onTop = dockEnabled && codexWindow?.visible !== false && Boolean(codexWindow) &&
    (codexWindow.foreground || win.isFocused() || choosing);
  if (win.isAlwaysOnTop() !== onTop) win.setAlwaysOnTop(onTop);
}

function updateDockPosition() {
  if (!windowReady || !win || win.isDestroyed()) return;
  if (dockEnabled && !hostProbeReady) return;
  syncWindowLayer();
  if (dockAdjustment || ballDrag) return;
  if (codexWindow) hostSeen = true;
  // Hide the companion as a group when the host minimizes or another app wins focus.
  // Do not steal focus or leave a separate topmost panel over unrelated applications.
  if (dockEnabled && hostSeen && (!codexWindow || codexWindow.visible === false ||
      (!codexWindow.foreground && !win.isFocused() && !choosing))) {
    if (win.isVisible()) win.hide();
    publishDock();
    return;
  }
  if (!dockEnabled || !codexWindow || dockMode === 'free') {
    dockAttached = false;
    if (collapsed) applyBounds(floatingBallBounds(expandedBounds ?? win.getBounds()));
    if (!win.isVisible()) win.showInactive();
    publishDock();
    return;
  }

  const { target, workAreas } = dockTarget();
  const current = win.getBounds();
  const fullWindow = collapsed ? expandedBounds : current;
  const panel = dockSize ? { ...fullWindow, ...dockSize } : dockPositioned ? fullWindow : defaultDockSize(fullWindow, target, workAreas);
  const placement = placePanel(panel, target, workAreas, dockAnchor, autoSize);
  const bounds = placement?.bounds;
  if (placement) {
    placedAnchor = placement.anchor;
    dockAnchor ??= { edge: 'right', inside: false, offset: 0 };
  }
  dockAttached = collapsed || Boolean(bounds);
  clippedEdge = null;
  clippedWidth = 0;
  if (bounds) {
    dockPositioned = true;
    if (placedAnchor.allowOverhang && !placedAnchor.inside && ['left', 'right'].includes(placedAnchor.edge)) {
      const area = screen.getDisplayMatching(bounds).workArea;
      clippedEdge = placedAnchor.edge;
      clippedWidth = Math.max(0, clippedEdge === 'left' ? area.x - bounds.x : bounds.x + bounds.width - area.x - area.width);
    }
  }
  const visibleBounds = collapsed ? floatingBallBounds(bounds ?? panel, target, workAreas, bounds ? placedAnchor : dockAnchor) : bounds;
  if (collapsed && bounds) expandedBounds = bounds;
  if (visibleBounds) applyBounds(visibleBounds);
  if (collapsed && visibleBounds) collapseBallOrigin = { x: visibleBounds.x, y: visibleBounds.y };
  if (!win.isVisible()) win.showInactive();
  publishDock();
}

function setCollapsed(value) {
  if (typeof value !== 'boolean') throw new Error('无效的悬浮球状态。');
  if (value === collapsed) return { collapsed };
  if (choosing) return { collapsed };
  dockAdjustment = null;
  ballDrag = null;
  if (value) {
    expandedBounds = win.getBounds();
    collapsed = true;
    win.setMinimumSize(ballSize, ballSize);
    win.setResizable(false);
    win.setMovable(false);
  } else {
    const ballBounds = win.getBounds();
    collapsed = false;
    win.setResizable(true);
    win.setMovable(true);
    win.setMinimumSize(...panelMinimumSize);
    const panel = { ...expandedBounds, ...(dockSize ?? {}) };
    const origin = collapseBallOrigin ?? ballBounds;
    const restored = dockMode === 'free'
      ? clampWindow({ ...panel, x: panel.x + ballBounds.x - origin.x, y: panel.y + ballBounds.y - origin.y },
        screen.getDisplayMatching(ballBounds).workArea)
      : panel;
    applyBounds(restored);
    expandedBounds = null;
  }
  send('desk:collapsed-changed', { collapsed });
  updateDockPosition();
  if (value) {
    const { x, y } = win.getBounds();
    collapseBallOrigin = { x, y };
  }
  return { collapsed };
}

function dragBall(phase) {
  if (!collapsed) return;
  if (phase === 'start') {
    ballDrag = { bounds: win.getBounds(), cursor: screen.getCursorScreenPoint(), moved: false,
      attached: dockEnabled && dockMode === 'attached' && Boolean(codexWindow), edge: ballEdge, detached: false };
    return;
  }
  const drag = ballDrag;
  if (!drag || (phase !== 'move' && phase !== 'end')) return;
  if (phase === 'move') {
    drag.moved = true;
    const cursor = screen.getCursorScreenPoint();
    const x = cursor.x - drag.cursor.x;
    const y = cursor.y - drag.cursor.y;
    const candidate = clampBall({ ...drag.bounds, x: drag.bounds.x + x, y: drag.bounds.y + y });
    const targetInfo = dockEnabled && codexWindow?.visible !== false && codexWindow ? dockTarget() : null;
    const vertical = ['left', 'right'].includes(drag.edge);
    if (drag.attached && !drag.detached && targetInfo && Math.abs(vertical ? x : y) <= 60) {
      ballPlacement = { edge: drag.edge, offset: candidate[vertical ? 'y' : 'x'] - targetInfo.target[vertical ? 'y' : 'x'] };
      applyBounds(floatingBallBounds(expandedBounds, targetInfo.target, targetInfo.workAreas, dockAnchor));
    } else {
      drag.detached = true;
      dockMode = 'free';
      dockAttached = false;
      applyBounds(candidate);
    }
    publishDock();
  }
  if (phase === 'end') {
    ballDrag = null;
    if (!drag.moved) return;
    const bounds = win.getBounds();
    const targetInfo = dockEnabled && codexWindow ? dockTarget() : null;
    const anchor = targetInfo ? findTabAnchor(bounds, targetInfo.target, targetInfo.workAreas) : null;
    if (anchor) {
      ballPlacement = anchor;
      dockMode = 'attached';
      if (dockAnchor?.edge !== anchor.edge) dockAnchor = { edge: anchor.edge, inside: false, offset: 0 };
    } else {
      ballPlacement = { x: bounds.x, y: bounds.y };
      dockMode = 'free';
    }
    try { saveDockLayout(); } catch { /* Keep the new position in memory. */ }
    updateDockPosition();
  }
}

async function searchFiles(query) {
  if (typeof query !== 'string' || query.length > 320) throw new Error('文件名过长。');
  const project = repository;
  if (!project) return { entries: [], truncated: false };
  if (!projectSearchIndex || projectSearchIndex.root !== project.root || Date.now() >= projectSearchIndex.expires) {
    projectSearchIndex = { root: project.root, expires: Date.now() + 12000, result: indexSearchFiles(project) };
  }
  const index = await projectSearchIndex.result;
  if (repository?.root !== project.root) return { entries: [], truncated: false };
  return searchProjectFiles(project, index, query);
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
        if (['left', 'right'].includes(anchor.edge) && !anchor.inside && dockAnchor?.allowOverhang) anchor.allowOverhang = true;
        dockAnchor = anchor;
        dockMode = 'attached';
        rememberDockLayout(autoSize && dockSize ? dockSize : panel);
      } else {
        dockMode = 'free';
        rememberDockLayout(panel);
      }
    } else if (placedAnchor && dockMode === 'attached') {
      const verticalEdge = placedAnchor.edge === 'left' || placedAnchor.edge === 'right';
      const offset = verticalEdge ? panel.y - target.y : panel.x - target.x;
      // Resizing an inside fallback must not turn it into the saved preference.
      dockAnchor = { ...dockAnchor, offset: autoSize ? 0 : offset };
      const size = autoSize && dockSize
        ? verticalEdge ? { width: panel.width, height: dockSize.height } : { width: dockSize.width, height: panel.height }
        : panel;
      rememberDockLayout(size);
    } else {
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
    dockMode = 'attached';
    if (reattach && codexWindow) {
      const { target, workAreas } = dockTarget();
      const panel = collapsed ? expandedBounds : win.getBounds();
      dockAnchor = findDockAnchor(panel, target, workAreas) ?? dockAnchor;
      dockSize = { width: panel.width, height: panel.height };
    }
    updateDockPosition();
    if (reattach && dockAttached) rememberDockLayout(dockSize ?? win.getBounds());
    void syncProject();
  } else {
    activeContext = null;
    dockAttached = false;
    dockAdjustment = null;
    if (collapsed) {
      const { x, y } = win.getBounds();
      ballPlacement = { x, y };
    }
    syncWindowLayer();
    if (!win.isVisible()) win.showInactive();
  }
  return publishDock();
}

async function readSettings() {
  return { autoSize, launchWithCodex: await startupEnabled(), shortcutAvailable };
}

async function changeSettings(key, value) {
  if (typeof value !== 'boolean' || !['autoSize', 'launchWithCodex'].includes(key)) throw new Error('设置无效。');
  if (changingSettings) throw new Error('正在保存设置，请稍候。');
  changingSettings = true;
  try {
    if (key === 'launchWithCodex') {
      try { await setStartupEnabled(value, process.execPath, app.isPackaged ? undefined : __dirname, codexWindow?.processId); }
      catch { throw new Error('无法更新随 Codex 启动的设置，请重试。'); }
    } else {
      const before = autoSize;
      autoSize = value;
      dockSize ??= expandedBounds ?? win.getBounds();
      try { saveDockLayout(); }
      catch { autoSize = before; throw new Error('无法保存窗口大小设置。'); }
      updateDockPosition();
    }
    return await readSettings();
  } finally {
    changingSettings = false;
  }
}

function setOutsideEdge(edge, inside = false) {
  if (!['left', 'right', 'top'].includes(edge) || typeof inside !== 'boolean') throw new Error('无效的吸附位置。');
  const offset = autoSize ? 0 : dockAnchor?.edge === edge ? dockAnchor.offset : 0;
  const anchor = { edge, inside, offset };
  dockEnabled = true;
  dockMode = 'attached';
  dockAnchor = anchor;
  ballPlacement = { edge, offset: ballPlacement?.offset ?? 72 };
  rememberDockLayout(dockSize ?? expandedBounds ?? win.getBounds());
  updateDockPosition();
  return publishDock();
}

function togglePeek() {
  if (!windowReady || !win || win.isDestroyed() || choosing) return;
  if (dockEnabled && codexWindow?.visible === false) return;
  if (collapsed || !win.isVisible() || win.isMinimized()) {
    if (collapsed) setCollapsed(false);
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  } else {
    setCollapsed(true);
  }
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
    minWidth: panelMinimumSize[0],
    minHeight: panelMinimumSize[1],
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    skipTaskbar: true,
    resizable: true,
    maximizable: false,
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

  handle('initial', () => ({ repository, latestPath, dock: dockState(), collapsed, codexAvailable, error: initialError }));
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
  handle('search-files', searchFiles);
  handle('dock', setDocked);
  handle('collapse', setCollapsed);
  handle('drag-ball', dragBall);
  handle('settings', readSettings);
  handle('set-setting', changeSettings);
  handle('outside-edge', setOutsideEdge);
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
  });
  win.on('focus', updateDockPosition);
  win.on('blur', () => {
    dragBall('end');
    setTimeout(updateDockPosition, 60);
  });
  win.on('will-move', () => { if (dockEnabled && !collapsed && !applyingBounds) dockAdjustment = 'move'; });
  win.on('moved', () => finishDockAdjustment('move'));
  win.on('will-resize', () => { if (dockEnabled && !collapsed && !applyingBounds) dockAdjustment = 'resize'; });
  win.on('resized', () => finishDockAdjustment('resize'));
  if (process.platform === 'win32') {
    win.hookWindowMessage(0x00a3, hit => {
      // WM_NCLBUTTONDBLCLK with HTCAPTION, delivered for the native drag area.
      if (hit.readInt32LE() === 2) setImmediate(() => { if (!win.isDestroyed()) setCollapsed(true); });
    });
  }
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
  shortcutAvailable = globalShortcut.register(peekShortcut, togglePeek);
  stopWindows = trackCodexWindow(value => {
    hostProbeReady = true;
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

if (!app.requestSingleInstanceLock({ repository: startPath, fromCodexStartup: process.argv.includes('--codex-startup') })) {
  app.quit();
} else {
  const ready = app.whenReady().then(start);
  ready.catch(error => { dialog.showErrorBox('Codex Review Desk', error.message); app.quit(); });
  app.on('second-instance', (_, __, ___, data) => {
    if (data?.fromCodexStartup) return;
    ready.then(async () => {
      if (!win || win.isDestroyed()) return;
      if (collapsed) setCollapsed(false);
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
    globalShortcut.unregisterAll();
    activeReview?.cancel();
    stopFiles?.();
    stopWindows?.();
    clearInterval(contextTimer);
  });
  app.on('window-all-closed', () => app.quit());
}
