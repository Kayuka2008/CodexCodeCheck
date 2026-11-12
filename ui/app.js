'use strict';

const api = window.desk;
const $ = (id) => document.getElementById(id);
const statusNames = { A: '新增', M: '修改', D: '删除', R: '重命名', C: '复制', T: '类型变更', U: '冲突', '?': '未跟踪' };
const state = {
  repo: null,
  snapshot: null,
  selected: null,
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
  patchEpoch: 0,
  reviewEpoch: 0,
};

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

function updateControls() {
  const locked = state.loading || state.choosing || state.reviewing;
  const available = Boolean(state.repo);
  $('repository-picker').disabled = state.choosing || state.reviewing;
  $('scope').disabled = !available || locked;
  $('scope').querySelector('[value="base"]').disabled = !state.repo?.hasHead;
  $('ref').disabled = !available || locked;
  $('ref').hidden = !needsRef();
  $('ref').placeholder = $('scope').value === 'commit' ? '提交 SHA 或引用' : '例如 main';
  $('refresh').disabled = !available || locked || (needsRef() && !$('ref').value.trim());
  $('refresh-text').textContent = state.loading ? '读取中…' : '刷新';
  $('file-filter').disabled = !state.snapshot?.files.length;
  $('review-start').disabled = locked || !state.codexAvailable || !state.snapshot?.files.length;
  $('review-start').hidden = state.reviewing;
  $('review-cancel').hidden = !state.reviewing;
  $('review-cancel').disabled = state.cancelling;
  $('review-copy').hidden = !state.result;
}

function setReviewStatus() {
  let message = state.reviewMessage;
  if (!message) {
    if (!state.repo) message = '选择 Git 仓库后可开始审查。';
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
  $('diff-title').textContent = '代码差异';
  $('diff-title').title = '';
  $('diff-totals').hidden = true;
  const wrapper = element('div', 'empty-diff');
  const content = element('div');
  content.append(element('strong', '', title));
  if (message) content.append(element('p', '', message));
  wrapper.append(content);
  $('diff-body').replaceChildren(wrapper);
}

function showSnapshotPlaceholder() {
  if (!state.repo) {
    emptyDiff('选择 Git 仓库', '打开 Codex 正在处理的仓库或 worktree 文件夹，即可查看改动。');
  } else if (state.loading) {
    emptyDiff('正在读取改动…');
  } else if (state.snapshotError) {
    emptyDiff('无法读取改动', state.snapshotError);
  } else if (!state.snapshot && needsRef()) {
    emptyDiff($('scope').value === 'base' ? '输入对比分支' : '输入提交引用', '输入后按 Enter 或点击刷新。');
  } else if (!state.snapshot?.files.length) {
    emptyDiff('没有改动', '切换范围，或在代码更新后刷新。');
  }
}

function appendStats(container, file) {
  if (Number.isFinite(file.additions)) container.append(element('span', 'added', `+${file.additions}`));
  if (Number.isFinite(file.deletions)) container.append(element('span', 'removed', `−${file.deletions}`));
  container.hidden = !container.childElementCount;
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

function fileHeader(file) {
  $('diff-title').textContent = file.path;
  $('diff-title').title = file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;
  const totals = $('diff-totals');
  totals.replaceChildren();
  appendStats(totals, file);
}

function selectFileRow(fileId) {
  for (const row of $('file-list').querySelectorAll('.file-row')) {
    row.setAttribute('aria-current', String(row.dataset.id === String(fileId)));
  }
}

async function selectFile(file, line) {
  if (state.loading || !state.snapshot || !state.snapshot.files.includes(file)) return;
  if (state.selected === file.id && $('diff-body').querySelector('.diff-table')) {
    if (line) locateLine(line);
    return;
  }
  const request = ++state.patchEpoch;
  state.selected = file.id;
  selectFileRow(file.id);
  emptyDiff('正在读取差异…');
  fileHeader(file);
  try {
    const patch = await api.patch(file.id);
    if (request !== state.patchEpoch) return;
    if (!patch.text) {
      emptyDiff('没有可显示的文本差异', '文件可能只有属性变化，或已在刷新后改变。');
      fileHeader(file);
    } else {
      renderPatch(patch);
    }
    if (line) locateLine(line);
  } catch (error) {
    if (request !== state.patchEpoch) return;
    emptyDiff('无法读取差异', describe(error));
    fileHeader(file);
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

function locateLine(line) {
  const body = $('diff-body');
  body.querySelector('.located')?.classList.remove('located');
  const number = Number(line);
  const row = Number.isSafeInteger(number) && number > 0 ? body.querySelector(`[data-line="${number}"]`) : null;
  if (!row) {
    status(`第 ${line} 行不在当前差异中。`);
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

function clearSnapshot() {
  ++state.patchEpoch;
  state.snapshot = null;
  state.selected = null;
  state.snapshotError = '';
  clearResult();
}

async function refresh() {
  if (!state.repo || state.loading || state.choosing || state.reviewing) return;
  const mode = $('scope').value;
  const ref = needsRef() ? $('ref').value.trim() : '';
  if (needsRef() && !ref) return;
  const epoch = state.repoEpoch;
  const selectedPath = state.snapshot?.files.find((file) => file.id === state.selected)?.path;
  clearSnapshot();
  state.loading = true;
  updateControls();
  renderFiles();
  showSnapshotPlaceholder();
  setReviewStatus();
  status('正在读取 Git 改动…');

  try {
    const snapshot = await api.snapshot(mode, ref);
    if (epoch !== state.repoEpoch) return;
    if (snapshot.repository) {
      state.repo = snapshot.repository;
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
      setReviewStatus();
      const files = state.snapshot?.files ?? [];
      const selected = files.find((file) => file.path === selectedPath) ?? files[0];
      if (selected) void selectFile(selected);
      else showSnapshotPlaceholder();
    }
  }
}

function renderRepository() {
  const repo = state.repo;
  $('repository-name').textContent = repo?.name || '选择仓库';
  $('repository-picker').title = repo?.root || '打开 Git 仓库';
  $('branch-name').textContent = repo?.branch || '分离 HEAD';
  $('branch').title = repo?.branch || '分离 HEAD';
  $('branch').hidden = !repo;
}

async function useRepository(repo) {
  ++state.repoEpoch;
  ++state.reviewEpoch;
  state.repo = repo;
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
  setReviewStatus();
  if (repo) await refresh();
  else {
    showSnapshotPlaceholder();
    status('等待打开 Git 仓库');
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
  if (repo) await useRepository(repo);
}

function scopeChanged() {
  clearSnapshot();
  $('ref').value = '';
  updateControls();
  renderFiles();
  showSnapshotPlaceholder();
  setReviewStatus();
  if (!needsRef()) void refresh();
  else {
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

async function togglePin() {
  const button = $('pin');
  const requested = button.getAttribute('aria-pressed') !== 'true';
  button.disabled = true;
  try {
    button.setAttribute('aria-pressed', String(await api.setAlwaysOnTop(requested)));
  } catch (error) {
    status(describe(error), true);
  } finally {
    button.disabled = false;
  }
}

async function initialize() {
  $('repository-picker').addEventListener('click', () => void chooseRepository());
  $('pin').addEventListener('click', () => void togglePin());
  $('scope').addEventListener('change', scopeChanged);
  $('ref').addEventListener('input', () => {
    if (state.snapshot || state.snapshotError) {
      clearSnapshot();
      renderFiles();
      showSnapshotPlaceholder();
      setReviewStatus();
      status('按 Enter 或点击刷新以读取新的引用。');
    }
    updateControls();
  });
  $('scope-form').addEventListener('submit', (event) => {
    event.preventDefault();
    void refresh();
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
      if (!$('refresh').disabled) void refresh();
    }
  });

  try {
    api.onReviewUpdate((message) => {
      if (state.reviewing && !state.cancelling) {
        state.reviewMessage = message;
        setReviewStatus();
      }
    });
    api.onRepositoryChanged((repo) => void useRepository(repo));
    const initial = await api.initial();
    state.codexAvailable = initial.codexAvailable;
    $('pin').setAttribute('aria-pressed', String(initial.alwaysOnTop));
    $('codex-status').classList.toggle('available', state.codexAvailable);
    $('codex-status-text').textContent = state.codexAvailable ? 'Codex CLI 可用' : '未找到 Codex CLI';
    await useRepository(initial.repository);
    if (initial.error) status(initial.error, true);
  } catch (error) {
    status(describe(error), true);
    emptyDiff('无法初始化审查台', describe(error));
    updateControls();
  }
}

void initialize();
