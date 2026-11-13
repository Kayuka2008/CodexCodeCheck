'use strict';

const api = window.desk;
const $ = (id) => document.getElementById(id);
const sourceReader = new window.SourceReader($('diff-body'));
const statusNames = { A: '新增', M: '修改', D: '删除', R: '重命名', C: '复制', T: '类型变更', U: '冲突', '?': '未跟踪' };
const state = {
  repo: null,
  snapshot: null,
  selected: null,
  selectedPath: null,
  view: null,
  tree: new Map(),
  expanded: new Set(),
  explorer: 'tree',
  dock: null,
  pendingContext: null,
  pendingActivity: null,
  latestActivity: null,
  filePinned: false,
  result: null,
  loading: false,
  choosing: false,
  reviewing: false,
  cancelling: false,
  codexAvailable: false,
  snapshotError: '',
  reviewMessage: '',
  reviewError: false,
  repoEpoch: 0,
  treeRevealEpoch: 0,
  patchEpoch: 0,
  reviewEpoch: 0,
};

const quickOpen = new window.QuickOpen((path, line) => {
  setExplorer('tree');
  void revealTreePath(path);
  void openSource(path, { line });
  $('diff-body').focus({ preventScroll: true });
});

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function describe(error) {
  return String(error?.message || error || '操作失败')
    .replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
    .trim();
}

function status(message, error = false) {
  const label = $('status-message');
  label.textContent = message;
  label.title = message;
  label.classList.toggle('error', error);
}

function needsRef() {
  return $('scope').value === 'base' || $('scope').value === 'commit';
}

function hasGit() {
  return Boolean(state.repo && state.repo.isGit !== false);
}

function updateControls() {
  const locked = state.loading || state.choosing || state.reviewing;
  const available = Boolean(state.repo);
  $('repository-picker').disabled = state.choosing || state.reviewing;
  $('scope').disabled = !hasGit() || locked;
  $('scope').hidden = available && !hasGit();
  document.querySelector('.scope-label').hidden = $('scope').hidden;
  $('scope').querySelector('[value="base"]').disabled = !state.repo?.hasHead;
  $('ref').disabled = !available || locked;
  $('ref').hidden = !needsRef();
  $('ref').placeholder = $('scope').value === 'commit' ? '提交 SHA 或引用' : '例如 main';
  $('refresh').disabled = !available || locked || (needsRef() && !$('ref').value.trim());
  $('refresh-text').textContent = state.loading ? '读取中…' : '刷新';
  $('changes-tab').disabled = !hasGit();
  $('quick-open').disabled = !available || state.choosing;
  $('file-filter').disabled = !state.snapshot?.files.length;
  $('review-start').disabled = locked || !state.codexAvailable || !state.snapshot?.files.length;
  $('review-start').hidden = state.reviewing;
  $('review-cancel').hidden = !state.reviewing;
  $('review-cancel').disabled = state.cancelling;
  $('review-copy').hidden = !state.result;
  updateFollowControls();
}

function updateFollowControls() {
  const pin = $('pin-file');
  const message = state.filePinned ? '恢复跟随修改' : '固定当前文件';
  pin.title = message;
  pin.setAttribute('aria-label', message);
  pin.setAttribute('aria-pressed', String(state.filePinned));
  const jump = $('latest-jump');
  const latest = state.latestActivity;
  jump.hidden = !latest || (!state.pendingActivity && normalizedPath(latest) === normalizedPath(state.selectedPath || ''));
  jump.disabled = state.reviewing || state.loading || state.choosing;
  jump.title = latest ? `跳到最新修改并继续跟随：${latest}` : '';
}

function setFilePinned(pinned) {
  state.filePinned = pinned;
  updateFollowControls();
  if (pinned) status('已固定当前文件');
  else {
    status('已恢复跟随修改');
    flushActivity();
  }
}

function setReviewStatus() {
  let message = state.reviewMessage;
  if (!message) {
    if (!hasGit()) message = '打开 Git 仓库后可审查改动。';
    else if (!state.codexAvailable) message = '未找到 Codex CLI。安装 Codex 后重新打开审查台。';
    else if (!state.snapshot) message = '读取改动后可开始审查。';
    else if (!state.snapshot.files.length) message = '这个范围没有需要审查的改动。';
    else message = '运行后，审查发现会显示在这里，并可跳到差异中的对应行。';
  }
  const node = $('review-status');
  node.textContent = message;
  node.classList.toggle('running', state.reviewing);
  node.classList.toggle('error', state.reviewError);
}

function emptyDiff(title, message) {
  sourceReader.clear();
  $('diff-title').textContent = '代码';
  $('diff-title').title = '';
  $('diff-totals').hidden = true;
  $('source-toggle').hidden = true;
  $('pin-file').hidden = true;
  const wrapper = element('div', 'empty-diff');
  const content = element('div');
  content.append(element('strong', '', title));
  if (message) content.append(element('p', '', message));
  wrapper.append(content);
  $('diff-body').replaceChildren(wrapper);
}

function showSnapshotPlaceholder() {
  if (!state.repo) {
    emptyDiff('等待 Codex 项目', '打开 Codex 会话，或手动选择文件夹。');
  } else if (state.loading) {
    emptyDiff('正在读取改动…');
  } else if (state.snapshotError) {
    emptyDiff('无法读取改动', state.snapshotError);
  } else if (!state.snapshot && needsRef()) {
    emptyDiff($('scope').value === 'base' ? '输入对比分支' : '输入提交引用', '输入后按 Enter 或点击刷新。');
  } else if (state.explorer === 'changes' && !state.snapshot?.files.length) {
    emptyDiff('没有改动');
  } else {
    emptyDiff('选择文件');
  }
}

function appendStats(container, file) {
  if (Number.isFinite(file.additions)) container.append(element('span', 'added', `+${file.additions}`));
  if (Number.isFinite(file.deletions)) container.append(element('span', 'removed', `−${file.deletions}`));
  container.hidden = !container.childElementCount;
}

function setExplorer(view) {
  state.explorer = view;
  const tree = view === 'tree';
  $('tree-tab').setAttribute('aria-pressed', String(tree));
  $('changes-tab').setAttribute('aria-pressed', String(!tree));
  $('tree-list').hidden = !tree;
  $('file-list').hidden = tree;
  $('file-search').hidden = tree;
  if (tree) renderTree();
}

function renderTree() {
  if (state.explorer !== 'tree') return;
  const list = $('tree-list');
  const focused = list.contains(document.activeElement) ? document.activeElement.dataset.path : null;
  const scrollTop = list.scrollTop;
  const changed = new Map((state.snapshot?.files ?? []).map((file) => [normalizedPath(file.path), file]));
  const selected = state.selectedPath ? normalizedPath(state.selectedPath) : null;

  function directoryContent(directory) {
    const fragment = document.createDocumentFragment();
    const data = state.tree.get(directory);
    if (!data?.entries) {
      fragment.append(element('p', 'tree-message', data?.error || '正在读取…'));
      return fragment;
    }
    if (!data.entries.length) fragment.append(element('p', 'tree-message', '空文件夹'));
    for (const entry of data.entries) {
      const isDirectory = entry.type === 'directory';
      const open = isDirectory && state.expanded.has(entry.path);
      const branch = element('div', 'tree-branch');
      const button = element('button', 'tree-row');
      button.type = 'button';
      button.dataset.path = entry.path;
      button.dataset.type = entry.type;
      button.title = entry.path;
      const toggle = element('span', 'tree-toggle', isDirectory ? (open ? '▾' : '▸') : '');
      toggle.setAttribute('aria-hidden', 'true');
      const icon = element('span', `tree-icon ${isDirectory ? 'tree-folder' : 'tree-file'}`);
      icon.setAttribute('aria-hidden', 'true');
      button.append(toggle, icon, element('span', 'tree-name', entry.name));
      if (isDirectory) {
        button.setAttribute('aria-expanded', String(open));
      } else {
        button.setAttribute('aria-current', String(normalizedPath(entry.path) === selected));
        const file = changed.get(normalizedPath(entry.path));
        if (file) {
          const badge = element('span', 'tree-status', file.status);
          badge.dataset.status = file.status;
          badge.title = statusNames[file.status] || file.status;
          button.append(badge);
        }
      }
      branch.append(button);
      if (open) {
        const children = element('div', 'tree-children');
        children.append(directoryContent(entry.path));
        branch.append(children);
      }
      fragment.append(branch);
    }
    if (data.truncated) fragment.append(element('p', 'tree-message', '仅显示部分文件'));
    return fragment;
  }

  list.replaceChildren(state.repo ? directoryContent('') : element('p', 'tree-message', '等待打开项目'));
  list.scrollTop = scrollTop;
  if (focused) treeRow(focused)?.focus({ preventScroll: true });
}

function treeRow(path) {
  const key = normalizedPath(path);
  return [...$('tree-list').querySelectorAll('.tree-row')].find((row) => normalizedPath(row.dataset.path) === key);
}

function loadDirectory(directory, reload = false) {
  if (!state.repo) return Promise.resolve();
  const tree = state.tree;
  const cached = tree.get(directory);
  if (cached?.pending) return cached.pending;
  if (cached?.entries && !reload) return Promise.resolve();
  const entry = { entries: cached?.entries };
  tree.set(directory, entry);
  entry.pending = Promise.resolve().then(async () => {
    try {
      if (tree !== state.tree) return;
      const data = await api.tree(directory);
      entry.entries = data.entries;
      entry.truncated = data.truncated;
    } catch (error) {
      entry.error = describe(error);
      entry.entries = null;
    } finally {
      entry.pending = null;
      if (tree === state.tree) renderTree();
    }
  });
  return entry.pending;
}

function toggleDirectory(path, open = !state.expanded.has(path)) {
  if (open) {
    state.expanded.add(path);
    void loadDirectory(path);
  } else {
    state.expanded.delete(path);
  }
  renderTree();
}

async function revealTreePath(path, reload = false) {
  const tree = state.tree;
  const reveal = ++state.treeRevealEpoch;
  const components = path.split('/');
  let directory = '';
  await loadDirectory('', reload);
  for (const component of components.slice(0, -1)) {
    if (tree !== state.tree || reveal !== state.treeRevealEpoch) return;
    const found = tree.get(directory)?.entries?.find((entry) => entry.type === 'directory' &&
      normalizedPath(entry.name) === normalizedPath(component));
    if (!found) break;
    directory = found.path;
    state.expanded.add(directory);
    await loadDirectory(directory, reload);
  }
  if (tree === state.tree && reveal === state.treeRevealEpoch) {
    renderTree();
    treeRow(path)?.scrollIntoView({ block: 'nearest' });
  }
}

function renderFiles() {
  const files = state.snapshot?.files ?? [];
  const filter = $('file-filter').value.trim().toLowerCase();
  const visible = filter
    ? files.filter((file) => file.path.toLowerCase().includes(filter) || file.oldPath?.toLowerCase().includes(filter))
    : files;
  $('file-count').textContent = filter && files.length ? `${visible.length}/${files.length}` : String(files.length);
  const list = $('file-list');
  const fragment = document.createDocumentFragment();

  for (const file of visible) {
    const row = element('button', 'file-row');
    row.type = 'button';
    row.dataset.id = file.id;
    row.title = file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;
    row.setAttribute('aria-current', String(state.selected === file.id));
    const badge = element('span', 'file-status', file.status);
    badge.dataset.status = file.status;
    badge.title = statusNames[file.status] ?? file.status;
    badge.setAttribute('aria-label', badge.title);
    const lastSlash = file.path.lastIndexOf('/');
    const names = element('span');
    names.append(element('span', 'file-name', file.path.slice(lastSlash + 1)));
    if (lastSlash !== -1) names.append(element('span', 'file-directory', file.path.slice(0, lastSlash)));
    const stats = element('span', 'file-stats');
    appendStats(stats, file);
    row.append(badge, names, stats);
    row.addEventListener('click', () => void selectFile(file));
    fragment.append(row);
  }

  if (!visible.length) {
    let message = '尚未打开仓库';
    if (state.loading) message = '正在读取…';
    else if (state.snapshotError) message = '读取失败';
    else if (files.length) message = '没有匹配的路径';
    else if (state.snapshot) message = '当前范围没有改动';
    else if (state.repo) message = '等待选择范围';
    fragment.append(element('p', 'file-list-message', message));
  }
  list.replaceChildren(fragment);
}

function fileHeader(path, file) {
  $('diff-title').textContent = path;
  $('diff-title').title = file?.oldPath ? `${file.oldPath} → ${path}` : path;
  const totals = $('diff-totals');
  totals.replaceChildren();
  if (file) appendStats(totals, file);
  else totals.hidden = true;
  $('source-toggle').hidden = !file || file.status === 'D';
  $('source-toggle').textContent = state.view === 'source' ? '差异' : '源码';
  $('pin-file').hidden = false;
  updateFollowControls();
}

function markSelection() {
  for (const row of $('file-list').querySelectorAll('.file-row')) {
    row.setAttribute('aria-current', String(row.dataset.id === String(state.selected)));
  }
  for (const row of $('tree-list').querySelectorAll('.tree-row[data-type="file"]')) {
    row.setAttribute('aria-current', String(normalizedPath(row.dataset.path) === normalizedPath(state.selectedPath || '')));
  }
}

function selectPath(path, { source = false, locateChange = false } = {}) {
  const file = findChangedFile(path);
  return file && (!source || file.status === 'D') ? selectFile(file) : openSource(path, { locateChange });
}

async function openSource(path, { line, locateChange = false } = {}) {
  if (!state.repo) return;
  const request = ++state.patchEpoch;
  const file = findChangedFile(path);
  state.selected = file?.id ?? null;
  state.selectedPath = path;
  state.view = 'source';
  markSelection();
  emptyDiff('正在读取源码…');
  fileHeader(path, file);
  try {
    const [source, patch] = await Promise.all([
      api.readFile(path),
      locateChange && file ? api.patch(file.id).catch(() => null) : null,
    ]);
    if (request !== state.patchEpoch) return;
    if (source.binary || !source.text) {
      emptyDiff(source.binary ? '二进制文件' : '空文件');
      fileHeader(path, file);
      return;
    }
    sourceReader.render(source, path);
    if (!line && patch?.text) line = lastChangedLine(patch.text);
    if (line) locateLine(line);
  } catch (error) {
    if (request !== state.patchEpoch) return;
    emptyDiff('无法读取源码', describe(error));
    fileHeader(path, file);
  }
}

async function selectFile(file, line) {
  if (state.loading || !state.snapshot || !state.snapshot.files.includes(file)) return;
  if (state.view === 'diff' && state.selected === file.id && $('diff-body').querySelector('.diff-table')) {
    if (line) locateLine(line);
    return;
  }
  const request = ++state.patchEpoch;
  state.selected = file.id;
  state.selectedPath = file.path;
  state.view = 'diff';
  markSelection();
  emptyDiff('正在读取差异…');
  fileHeader(file.path, file);
  try {
    const patch = await api.patch(file.id);
    if (request !== state.patchEpoch) return;
    if (!patch.text) {
      if (file.status !== 'D') {
        await openSource(file.path, { line });
        return;
      }
      emptyDiff('没有可显示的文本差异');
      fileHeader(file.path, file);
    } else {
      renderPatch(patch);
    }
    if (line) locateLine(line);
  } catch (error) {
    if (request !== state.patchEpoch) return;
    emptyDiff('无法读取差异', describe(error));
    fileHeader(file.path, file);
  }
}

function specialLine(kind, text) {
  const row = element('div', `diff-row ${kind}`);
  row.append(element('span', 'line-number'), element('span', 'line-code', text));
  return row;
}

function contentLine(kind, oldLine, newLine, sign, code) {
  const row = element('div', `diff-row ${kind}`);
  if (newLine !== '') row.dataset.line = newLine;
  row.append(
    element('span', 'line-number', oldLine),
    element('span', 'line-number', newLine),
    element('span', 'line-sign', sign),
    element('span', 'line-code', code),
  );
  return row;
}

function renderPatch(patch) {
  const table = element('div', 'diff-table');
  const lines = patch.text.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  const maxRows = 5000;
  let cropped = patch.truncated || lines.length > maxRows;
  let oldLine = 0;
  let newLine = 0;
  let oldLeft = 0;
  let newLeft = 0;

  for (const raw of lines.slice(0, maxRows)) {
    const longLine = raw.length > 5000;
    const line = longLine ? `${raw.slice(0, 5000)}…` : raw;
    cropped ||= longLine;
    const hunk = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      oldLeft = Number(hunk[2] ?? 1);
      newLine = Number(hunk[3]);
      newLeft = Number(hunk[4] ?? 1);
      table.append(specialLine('hunk', line));
      continue;
    }

    const sign = line[0];
    if (newLeft > 0 && sign === '+') {
      table.append(contentLine('add', '', newLine++, '+', line.slice(1)));
      newLeft--;
    } else if (oldLeft > 0 && sign === '-') {
      table.append(contentLine('remove', oldLine++, '', '−', line.slice(1)));
      oldLeft--;
    } else if (oldLeft > 0 && newLeft > 0 && sign === ' ') {
      table.append(contentLine('context-line', oldLine++, newLine++, ' ', line.slice(1)));
      oldLeft--;
      newLeft--;
    } else {
      table.append(specialLine('meta', line));
    }
  }

  const body = $('diff-body');
  body.replaceChildren(table);
  if (cropped) body.append(element('p', 'diff-notice', '差异过长，已截断预览。'));
  body.scrollTop = 0;
  body.scrollLeft = 0;
}

function lastChangedLine(patch) {
  let line = 0;
  let oldLeft = 0;
  let newLeft = 0;
  let changed;
  for (const text of patch.split('\n')) {
    const hunk = text.match(/^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunk) {
      oldLeft = Number(hunk[1] ?? 1);
      line = Number(hunk[2]);
      newLeft = Number(hunk[3] ?? 1);
    } else if (oldLeft > 0 && text.startsWith('-')) {
      oldLeft--;
      changed = Math.max(1, newLeft > 0 ? line : line - 1);
    } else if (newLeft > 0 && text.startsWith('+')) {
      newLeft--;
      changed = line++;
    } else if (oldLeft > 0 && newLeft > 0 && text.startsWith(' ')) {
      oldLeft--;
      newLeft--;
      line++;
    }
  }
  return changed;
}

function locateLine(line) {
  const body = $('diff-body');
  body.querySelector('.located')?.classList.remove('located');
  const number = Number(line);
  const row = Number.isSafeInteger(number) && number > 0 ? body.querySelector(`[data-line="${number}"]`) : null;
  if (!row) {
    status(`第 ${line} 行不在当前${state.view === 'source' ? '预览' : '差异'}中。`);
    return;
  }
  row.classList.add('located');
  row.scrollIntoView({ block: 'center', inline: 'nearest' });
  status(`已定位到第 ${line} 行`);
}

function clearResult() {
  state.result = null;
  state.reviewMessage = '';
  state.reviewError = false;
  $('review-results').hidden = true;
  $('review-results').replaceChildren();
}

function clearSnapshot(keepResult = false) {
  ++state.patchEpoch;
  state.snapshot = null;
  state.selected = null;
  state.snapshotError = '';
  if (!keepResult) clearResult();
}

async function refresh({ targetPath, activity = false } = {}) {
  if (!hasGit() || state.loading || state.choosing || state.reviewing) return;
  const mode = $('scope').value;
  const ref = needsRef() ? $('ref').value.trim() : '';
  if (needsRef() && !ref) return;
  const epoch = state.repoEpoch;
  clearSnapshot(activity);
  const selection = state.patchEpoch;
  state.loading = true;
  updateControls();
  renderFiles();
  if (!state.selectedPath) showSnapshotPlaceholder();
  setReviewStatus();
  status('正在读取 Git 改动…');

  try {
    const snapshot = await api.snapshot(mode, ref);
    if (epoch !== state.repoEpoch) return;
    if (snapshot.repository) {
      state.repo = { ...state.repo, ...snapshot.repository };
      renderRepository();
    }
    state.snapshot = snapshot;
    status(`${snapshot.files.length} 个改动文件`);
  } catch (error) {
    if (epoch !== state.repoEpoch) return;
    state.snapshotError = describe(error);
    status(state.snapshotError, true);
  } finally {
    if (epoch === state.repoEpoch) {
      state.loading = false;
      updateControls();
      renderFiles();
      renderTree();
      if (activity && state.result) {
        state.reviewMessage = '代码已更新，以下是上次审查结果。';
        renderResult();
      }
      setReviewStatus();
      if (selection !== state.patchEpoch && state.selectedPath) {
        const current = findChangedFile(state.selectedPath);
        state.selected = current?.id ?? null;
        markSelection();
        fileHeader(state.selectedPath, current);
      } else if (!(activity && state.filePinned)) {
        const selectedPath = targetPath || state.selectedPath;
        const file = selectedPath && findChangedFile(selectedPath);
        if (selectedPath && (mode === 'worktree' || file)) {
          const source = mode === 'worktree' && (Boolean(targetPath) || state.view === 'source');
          void selectPath(selectedPath, { source, locateChange: Boolean(targetPath) });
        } else if (state.snapshot?.files.length) {
          const first = state.snapshot.files[0];
          if (state.explorer === 'tree' && mode === 'worktree') {
            void revealTreePath(first.path);
            void selectPath(first.path, { source: true, locateChange: true });
          } else void selectFile(first);
        } else {
          state.view = null;
          showSnapshotPlaceholder();
        }
      } else if (!state.pendingActivity) {
        state.pendingActivity = targetPath;
        updateFollowControls();
      }
      flushActivity();
    }
  }
}

function refreshView() {
  if (!state.repo) return;
  if (state.selectedPath) void revealTreePath(state.selectedPath, true);
  else void loadDirectory('', true);
  if (hasGit()) void refresh();
  else if (state.selectedPath) void openSource(state.selectedPath);
}

function renderRepository() {
  const repo = state.repo;
  $('repository-name').textContent = repo?.name || '选择项目';
  $('repository-picker').title = repo?.root || '手动选择项目文件夹';
  $('branch-name').textContent = repo?.branch || '分离 HEAD';
  $('branch').title = repo?.branch || '分离 HEAD';
  $('branch').hidden = !hasGit();
}

async function useRepository(repo, latestPath) {
  quickOpen.close();
  ++state.repoEpoch;
  ++state.reviewEpoch;
  state.repo = repo;
  state.tree = new Map();
  state.expanded = new Set();
  state.selectedPath = null;
  state.view = null;
  state.pendingActivity = null;
  state.latestActivity = relativeActivityPath(latestPath);
  state.filePinned = false;
  state.loading = false;
  state.reviewing = false;
  state.cancelling = false;
  clearSnapshot();
  $('file-filter').value = '';
  $('scope').value = 'worktree';
  $('ref').value = '';
  renderRepository();
  updateControls();
  renderFiles();
  setExplorer('tree');
  setReviewStatus();
  showSnapshotPlaceholder();
  if (!repo) {
    status('等待当前会话项目');
    return;
  }
  status('已打开项目');
  const path = relativeActivityPath(latestPath);
  if (path) void revealTreePath(path);
  else void loadDirectory('');
  if (hasGit()) await refresh({ targetPath: path });
  else if (path) await openSource(path);
}

function updateProject(payload) {
  const context = payload && Object.hasOwn(payload, 'repository') ? payload : { repository: payload };
  if (state.reviewing || state.choosing || document.body.classList.contains('ball-collapsed')) {
    state.pendingContext = context;
    return;
  }
  state.pendingContext = null;
  void useRepository(context.repository, context.latestPath);
}

function relativeActivityPath(path) {
  return typeof path === 'string' && path ? path.replace(/\\/g, '/') : null;
}

function projectActivity(activity) {
  const path = relativeActivityPath(activity?.path);
  if (!path) return;
  if (state.pendingContext && activity.root && state.pendingContext.repository &&
      normalizedPath(activity.root) === normalizedPath(state.pendingContext.repository.root)) {
    state.pendingContext.latestPath = path;
    return;
  }
  if (!state.repo || (activity.root && normalizedPath(activity.root) !== normalizedPath(state.repo.root))) return;
  state.latestActivity = path;
  state.pendingActivity = path;
  updateFollowControls();
  flushActivity();
}

function flushActivity() {
  if (!state.repo || state.filePinned || state.reviewing || state.loading || state.choosing || $('scope').value !== 'worktree' ||
      $('quick-open-dialog').open ||
      document.body.classList.contains('ball-collapsed')) return;
  const path = state.pendingActivity;
  if (!path) return;
  state.pendingActivity = null;
  updateFollowControls();
  void revealTreePath(path, true);
  if (hasGit()) void refresh({ targetPath: path, activity: true });
  else void openSource(path);
}

function jumpToLatest() {
  if ($('latest-jump').disabled || !state.latestActivity) return;
  state.filePinned = false;
  state.pendingActivity = state.latestActivity;
  if ($('scope').value !== 'worktree') {
    $('scope').value = 'worktree';
    scopeChanged();
  } else {
    updateFollowControls();
    flushActivity();
  }
}

async function chooseRepository() {
  if (state.choosing || state.reviewing) return;
  state.choosing = true;
  updateControls();
  let repo;
  try {
    repo = await api.chooseRepository();
  } catch (error) {
    status(describe(error), true);
  } finally {
    state.choosing = false;
    updateControls();
  }
  if (repo) {
    const returned = Object.hasOwn(repo, 'repository') ? repo.repository : repo;
    const queued = state.pendingContext?.repository;
    updateProject(queued && returned && normalizedPath(queued.root) === normalizedPath(returned.root)
      ? state.pendingContext : repo);
  }
  else if (state.pendingContext) updateProject(state.pendingContext);
  else flushActivity();
}

function scopeChanged() {
  clearSnapshot();
  $('ref').value = '';
  updateControls();
  renderFiles();
  renderTree();
  showSnapshotPlaceholder();
  setReviewStatus();
  if (!needsRef()) {
    if ($('scope').value === 'worktree' && state.pendingActivity && !state.filePinned) flushActivity();
    else void refresh();
  } else {
    status('输入分支或提交引用');
    $('ref').focus();
  }
}

function setReviewPanel(visible, moveFocus = false) {
  $('review-panel').hidden = !visible;
  $('workbench').classList.toggle('review-hidden', !visible);
  $('review-toggle').setAttribute('aria-expanded', String(visible));
  if (moveFocus) $('review-toggle').focus();
}

function normalizedPath(path) {
  return String(path).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '').toLowerCase();
}

function findChangedFile(path) {
  const absolute = normalizedPath(path);
  const root = normalizedPath(state.repo?.root || '');
  const relative = root && absolute.startsWith(`${root}/`) ? absolute.slice(root.length + 1) : absolute;
  return state.snapshot?.files.find((file) => normalizedPath(file.path) === relative ||
    (file.oldPath && normalizedPath(file.oldPath) === relative));
}

async function copy(text, message) {
  try {
    await api.copy(text);
    status(message);
  } catch (error) {
    status(describe(error), true);
  }
}

function renderFinding(finding) {
  const card = element('article', 'finding-card');
  const title = element('h3', 'finding-title');
  if (finding.priority) title.append(element('span', 'finding-priority', finding.priority));
  title.append(document.createTextNode(finding.title));
  const location = `${finding.path}:${finding.line}`;
  const path = element('div', 'finding-path', location);
  const actions = element('div', 'finding-actions');
  const file = findChangedFile(finding.path);
  if (file) {
    const jump = element('button', 'button subtle', '跳到差异');
    jump.type = 'button';
    jump.addEventListener('click', () => {
      $('file-filter').value = '';
      renderFiles();
      if (window.matchMedia('(max-width: 640px)').matches) setReviewPanel(false);
      void revealTreePath(file.path);
      void selectFile(file, finding.line);
    });
    actions.append(jump);
  }
  const copyFinding = element('button', 'button subtle', '复制');
  copyFinding.type = 'button';
  copyFinding.addEventListener('click', () => {
    const heading = `${finding.priority ? `[${finding.priority}] ` : ''}${finding.title}`;
    const text = [heading, location, finding.detail].filter(Boolean).join('\n');
    void copy(text, '已复制审查发现');
  });
  actions.append(copyFinding);
  card.append(title, path);
  if (finding.detail) card.append(element('p', 'finding-detail', finding.detail));
  card.append(actions);
  return card;
}

function renderResult() {
  const result = state.result;
  const target = $('review-results');
  target.replaceChildren();
  target.hidden = !result;
  if (!result) return;
  for (const finding of result.findings) target.append(renderFinding(finding));
  if (result.text) {
    if (result.findings.length) {
      const details = element('details', 'review-details');
      details.append(element('summary', '', '查看完整审查结果'), element('p', 'review-text', result.text));
      target.append(details);
    } else {
      target.append(element('p', 'review-text', result.text));
    }
  }
}

async function runReview() {
  if ($('review-start').disabled || state.reviewing) return;
  const epoch = ++state.reviewEpoch;
  clearResult();
  state.reviewing = true;
  state.reviewMessage = '正在启动 Codex…';
  updateControls();
  setReviewStatus();
  try {
    const result = await api.startReview();
    if (epoch !== state.reviewEpoch) return;
    state.result = result;
    state.reviewMessage = result.findings.length ? `审查完成，发现 ${result.findings.length} 个可定位的问题。` : '审查完成。';
    renderResult();
  } catch (error) {
    if (epoch !== state.reviewEpoch) return;
    state.reviewError = !state.cancelling;
    state.reviewMessage = state.cancelling ? '审查已取消。' : describe(error);
  } finally {
    if (epoch === state.reviewEpoch) {
      state.reviewing = false;
      state.cancelling = false;
      updateControls();
      setReviewStatus();
      if (state.pendingContext) updateProject(state.pendingContext);
      else flushActivity();
    }
  }
}

async function cancelReview() {
  if (!state.reviewing || state.cancelling) return;
  state.cancelling = true;
  state.reviewMessage = '正在取消…';
  updateControls();
  setReviewStatus();
  try {
    await api.cancelReview();
  } catch (error) {
    state.cancelling = false;
    state.reviewMessage = describe(error);
    setReviewStatus();
    updateControls();
  }
}

function renderDock(dock) {
  if (!dock) return;
  state.dock = dock;
  Object.assign(document.body.dataset, {
    dockAttached: String(Boolean(dock.attached)),
    dockEdge: dock.edge || '',
    dockInside: String(Boolean(dock.inside)),
    ballAttached: String(Boolean(dock.ballAttached)),
    ballEdge: dock.ballEdge || dock.edge || 'right',
    ballInside: String(Boolean(dock.ballInside)),
  });
  window.dispatchEvent(new CustomEvent('desk-dock-state', { detail: dock }));
  const clipped = Number.isFinite(dock.clippedWidth) ? Math.max(0, Math.min(72, dock.clippedWidth)) : 0;
  document.body.style.setProperty('--clipped-left', `${dock.clippedEdge === 'left' ? clipped : 0}px`);
  document.body.style.setProperty('--clipped-right', `${dock.clippedEdge === 'right' ? clipped : 0}px`);
  const button = $('dock');
  const paused = dock.following === false && dock.enabled;
  button.setAttribute('aria-pressed', String(dock.enabled && !paused));
  button.title = paused ? '恢复跟随 Codex 会话项目' : dock.enabled ? '解除吸附。拖动标题栏可换到 Codex 的内侧或外侧边缘。' : '吸附到 Codex 窗口';
  $('dock-label').textContent = paused ? '跟随' : '吸附';
  const label = dock.status || (dock.attached ? '已吸附' : dock.enabled ? '等待 Codex' : '未吸附');
  $('dock-status-text').textContent = label;
  $('dock-status').title = label;
  $('dock-status').classList.toggle('available', dock.attached);
}

async function toggleDock() {
  const button = $('dock');
  const requested = !state.dock?.enabled || state.dock.following === false;
  button.disabled = true;
  try {
    renderDock(await api.setDocked(requested));
  } catch (error) {
    status(describe(error), true);
  } finally {
    button.disabled = false;
  }
}

function treeKeydown(event) {
  if (!event.target.matches('.tree-row')) return;
  const row = event.target;
  const path = row.dataset.path;
  const isDirectory = row.dataset.type === 'directory';
  if (event.key === 'ArrowRight' && isDirectory) {
    event.preventDefault();
    if (!state.expanded.has(path)) toggleDirectory(path, true);
    else row.parentElement.querySelector('.tree-children .tree-row')?.focus();
  } else if (event.key === 'ArrowLeft') {
    event.preventDefault();
    if (isDirectory && state.expanded.has(path)) toggleDirectory(path, false);
    else treeRow(path.slice(0, path.lastIndexOf('/')))?.focus();
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
    event.preventDefault();
    const rows = [...$('tree-list').querySelectorAll('.tree-row')];
    const index = rows.indexOf(row);
    if (event.key === 'Home') rows[0]?.focus();
    else if (event.key === 'End') rows.at(-1)?.focus();
    else rows[index + (event.key === 'ArrowDown' ? 1 : -1)]?.focus();
  }
}

async function initialize() {
  $('repository-picker').addEventListener('click', () => void chooseRepository());
  $('dock').addEventListener('click', () => void toggleDock());
  $('window-close').addEventListener('click', () => void api.closeWindow().catch((error) => status(describe(error), true)));
  $('tree-tab').addEventListener('click', () => setExplorer('tree'));
  $('changes-tab').addEventListener('click', () => setExplorer('changes'));
  $('tree-list').addEventListener('click', (event) => {
    const row = event.target.closest('.tree-row');
    if (!row) return;
    if (row.dataset.type === 'directory') toggleDirectory(row.dataset.path);
    else void selectPath(row.dataset.path, { source: true });
  });
  $('tree-list').addEventListener('keydown', treeKeydown);
  $('source-toggle').addEventListener('click', () => {
    if (state.selectedPath) void selectPath(state.selectedPath, { source: state.view === 'diff' });
  });
  $('pin-file').addEventListener('click', () => setFilePinned(!state.filePinned));
  $('latest-jump').addEventListener('click', jumpToLatest);
  $('quick-open-dialog').addEventListener('close', () => {
    const dialog = $('quick-open-dialog');
    if (!dialog.open && dialog.returnValue !== 'selected') flushActivity();
  });
  $('scope').addEventListener('change', scopeChanged);
  $('ref').addEventListener('input', () => {
    if (state.snapshot || state.snapshotError) {
      clearSnapshot();
      renderFiles();
      renderTree();
      showSnapshotPlaceholder();
      setReviewStatus();
      status('按 Enter 或点击刷新以读取新的引用。');
    }
    updateControls();
  });
  $('scope-form').addEventListener('submit', (event) => {
    event.preventDefault();
    refreshView();
  });
  $('file-filter').addEventListener('input', renderFiles);
  $('file-list').addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    if (!event.target.matches('.file-row')) return;
    event.preventDefault();
    const neighbor = event.key === 'ArrowUp' ? event.target.previousElementSibling : event.target.nextElementSibling;
    neighbor?.focus();
  });
  $('review-toggle').addEventListener('click', () => setReviewPanel($('review-panel').hidden));
  $('review-close').addEventListener('click', () => setReviewPanel(false, true));
  $('review-start').addEventListener('click', () => void runReview());
  $('review-cancel').addEventListener('click', () => void cancelReview());
  $('review-copy').addEventListener('click', () => {
    if (state.result) void copy(state.result.text, '已复制完整审查结果');
  });
  document.addEventListener('keydown', (event) => {
    if (event.ctrlKey && !event.altKey && event.key.toLowerCase() === 'r') {
      event.preventDefault();
      if (!$('refresh').disabled) refreshView();
    }
  });

  try {
    api.onReviewUpdate((message) => {
      if (state.reviewing && !state.cancelling) {
        state.reviewMessage = message;
        setReviewStatus();
      }
    });
    api.onRepositoryChanged(updateProject);
    api.onProjectActivity(projectActivity);
    api.onDockChanged(renderDock);
    api.onCollapsedChanged?.(({ collapsed }) => {
      if (collapsed) {
        quickOpen.close();
        return;
      }
      requestAnimationFrame(() => {
        if (state.pendingContext) updateProject(state.pendingContext);
        else flushActivity();
      });
    });
    const initial = await api.initial();
    state.codexAvailable = initial.codexAvailable;
    if (!state.dock) renderDock(initial.dock);
    if (!state.repoEpoch) await useRepository(initial.repository, initial.latestPath);
    else {
      updateControls();
      setReviewStatus();
    }
    if (initial.error && !state.repo) status(initial.error, true);
  } catch (error) {
    status(describe(error), true);
    emptyDiff('无法初始化审查台', describe(error));
    updateControls();
  }
}

void initialize();
