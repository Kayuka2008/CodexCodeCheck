'use strict';

// Run with the cached Electron executable, not node --test. All windows remain hidden,
// the profile is isolated, and the host/cursor feed is synthetic. Native hook timing is
// verified separately against real Win32 events by the helper's smoke test.
const { app, BrowserWindow, screen } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'codecheck-runtime-'));
app.setPath('userData', profile);
process.env.CODEX_REVIEW_REPOSITORY = profile;
process.env.CODEX_REVIEW_CLI = path.join(profile, 'unavailable.exe');
fs.writeFileSync(path.join(profile, 'dock-layout.json'), JSON.stringify({
  version: 2, anchor: { edge: 'right', inside: false, offset: 45 }, width: 360, height: 500, autoSize: true,
}));
let updateHost;
const trackerPath = require.resolve('../lib/windows-dock.cjs');
require.cache[trackerPath] = { id: trackerPath, filename: trackerPath, loaded: true,
  exports: { trackCodexWindow(callback) { updateHost = callback; return () => {}; } } };
let visible = false;
let focused = false;
let cursor = { x: 0, y: 0 };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async predicate => {
  for (let i = 0; i < 200; i++) { if (await predicate()) return; await sleep(25); }
  throw new Error('Runtime did not become ready');
};
require('../main.cjs');

app.whenReady().then(async () => {
  screen.getCursorScreenPoint = () => cursor;
  await until(() => updateHost && BrowserWindow.getAllWindows()[0]?.webContents.getURL().startsWith('file:'));
  const win = BrowserWindow.getAllWindows()[0];
  win.showInactive = win.show = () => { visible = true; };
  win.hide = () => { visible = false; };
  win.isVisible = () => visible;
  win.isFocused = () => focused;
  await until(async () => !win.webContents.isLoading() && await win.webContents.executeJavaScript('Boolean(window.desk)'));
  const call = (method, ...args) => win.webContents.executeJavaScript(`window.desk.${method}(...${JSON.stringify(args)})`);
  const area = screen.getPrimaryDisplay().workArea;
  let host = { x: area.x + 40, y: area.y + 35, width: Math.max(500, area.width - 480), height: Math.max(400, area.height - 100) };
  const feed = (extra = {}) => updateHost({ bounds: screen.dipToScreenRect(null, host),
    handle: '1234', processId: 99999, foreground: true, visible: true, ...extra });
  feed();
  await until(() => visible);
  assert.equal(visible, true);
  assert.equal(win.getBounds().x, host.x + host.width);
  assert.equal(win.getBounds().y, host.y);
  assert.equal(win.getBounds().height, host.height);

  const original = { ...host };
  host = { ...area };
  feed();
  assert.equal((await call('initial')).dock.inside, true);
  await call('setSetting', 'autoSize', false);
  await call('setSetting', 'autoSize', true);
  host = original;
  feed();
  assert.equal((await call('initial')).dock.inside, false);

  await call('setCollapsed', true);
  assert.equal(win.getBounds().width, 48);
  const ball = win.getBounds();
  cursor = { x: ball.x + 14, y: ball.y + 24 };
  await call('dragBall', 'start');
  cursor = { x: cursor.x + 12, y: cursor.y + 90 };
  await call('dragBall', 'move');
  await call('dragBall', 'end');
  assert.equal((await call('initial')).dock.ballAttached, true);
  assert.equal(win.getBounds().x, ball.x);
  assert.equal(win.getBounds().y, ball.y + 90);
  const saved = JSON.parse(fs.readFileSync(path.join(profile, 'dock-layout.json')));
  assert.equal(saved.ball.edge, 'right');
  assert.equal(saved.width, 360);
  host = { ...host, x: host.x + 20, width: host.width - 30 };
  feed();
  assert.equal(win.getBounds().x, host.x + host.width);
  await call('setCollapsed', false);
  assert.equal(win.getBounds().x, host.x + host.width);
  assert.equal(win.getBounds().width, 360);

  feed({ foreground: false });
  assert.equal(visible, false);
  assert.equal(win.isAlwaysOnTop(), false);
  feed();
  assert.equal(visible, true);
  feed({ visible: false, foreground: false });
  assert.equal(visible, false);
  feed();
  assert.equal(visible, true);

  await call('setCollapsed', true);
  cursor = { ...win.getBounds() };
  await call('dragBall', 'start');
  cursor = { x: cursor.x - 160, y: cursor.y + 30 };
  await call('dragBall', 'move');
  await call('dragBall', 'end');
  assert.equal((await call('initial')).dock.ballAttached, false);
  const free = win.getBounds();
  host = { ...host, x: host.x + 10 };
  feed();
  assert.deepEqual(win.getBounds(), free);
  await call('setCollapsed', false);
  assert.equal((await call('initial')).dock.attached, false);
  const freePanel = win.getBounds();
  await call('setCollapsed', true);
  await call('setCollapsed', false);
  assert.deepEqual(win.getBounds(), freePanel, 'free panel must not drift on collapse/expand');
  await call('setCollapsed', true);
  cursor = { ...win.getBounds() };
  await call('dragBall', 'start');
  const before = win.getBounds();
  cursor = { x: cursor.x + (host.x + host.width - before.x), y: cursor.y };
  await call('dragBall', 'move');
  await call('dragBall', 'end');
  assert.equal((await call('initial')).dock.ballAttached, true);
  await call('setCollapsed', false);
  assert.equal(win.getBounds().height, host.height);
  console.log(JSON.stringify({ ok: true, follow: true, insideFallback: true, drag: true,
    detachReattach: true, restore: true, minimize: true, focusGroup: true, profile }));
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
setTimeout(() => { console.error('Runtime verification timed out'); app.exit(1); }, 20000).unref();
