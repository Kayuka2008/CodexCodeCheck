'use strict';

const { spawn } = require('node:child_process');
const { constants } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_PATCH_BYTES = 512 * 1024;
const MAX_PATCH_LINES = 5_000;
const MAX_LIST_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 10_000;
const HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function git(cwd, args, options = {}) {
  const {
    accepted = [0], maxBytes = MAX_LIST_BYTES, preview = false, config = [],
  } = options;
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)));
  Object.assign(env, {
    GIT_LITERAL_PATHSPECS: '1',
    GIT_NO_LAZY_FETCH: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
  });

  return new Promise((resolve, reject) => {
    const child = spawn('git', [
      '-c', 'core.fsmonitor=false',
      '-c', 'core.quotePath=false',
      '-c', 'diff.renameLimit=1000',
      ...config.flatMap((entry) => ['-c', entry]),
      ...args,
    ], { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });

    const chunks = [];
    let size = 0;
    let errorText = '';
    let truncated = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 20_000);

    child.stdin.on('error', () => {});
    child.stdin.end();
    child.stdout.on('data', (chunk) => {
      if (truncated) return;
      const remaining = maxBytes - size;
      if (chunk.length > remaining) {
        chunks.push(chunk.subarray(0, remaining));
        size += remaining;
        truncated = true;
        child.kill();
      } else {
        chunks.push(chunk);
        size += chunk.length;
      }
    });
    child.stderr.on('data', (chunk) => {
      if (errorText.length < 8_192) errorText = (errorText + chunk.toString()).slice(0, 8_192);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error.code === 'ENOENT' ? new Error('找不到 Git。请安装 Git 并确认它在 PATH 中。') : error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error('Git 读取超时，请缩小查看范围后重试。'));
      if (truncated && !preview) return reject(new Error('改动太多，无法列出全部文件。请缩小查看范围。'));
      if (!truncated && !accepted.includes(code)) {
        return reject(new Error(errorText.trim() || `Git 读取失败（退出码 ${code}）。`));
      }
      const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
      const text = decoder.decode(Buffer.concat(chunks, size), { stream: truncated });
      resolve({ text, truncated, code });
    });
  });
}

async function resolveCommit(root, revision) {
  const { text, code } = await git(root, [
    'rev-parse', '--verify', '--quiet', '--end-of-options', `${revision}^{commit}`,
  ], { accepted: [0, 1] });
  return code === 0 && HASH.test(text.trim()) ? text.trim() : null;
}

async function emptyTree(root) {
  const { text } = await git(root, ['hash-object', '-t', 'tree', '--stdin']);
  return text.trim();
}

async function getRepository(inputDir) {
  if (typeof inputDir !== 'string' || !inputDir || inputDir.includes('\0')) {
    throw new Error('请选择 Git 仓库中的目录。');
  }
  let root;
  try {
    const directory = await fs.realpath(inputDir);
    if (!(await fs.stat(directory)).isDirectory()) throw new Error('请选择一个目录。');
    const { text } = await git(directory, ['rev-parse', '--show-toplevel']);
    root = path.normalize(text.replace(/\r?\n$/, ''));
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) throw new Error('所选目录不存在。');
    if (/not a git repository|must be run in a work tree/i.test(error.message)) {
      throw new Error('请选择 Git 仓库中的目录。');
    }
    throw error;
  }
  const [branchResult, head] = await Promise.all([
    git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { accepted: [0, 1] }),
    resolveCommit(root, 'HEAD'),
  ]);
  return { root, name: path.basename(root), branch: branchResult.text.trim() || 'HEAD', hasHead: head !== null };
}

function validateRef(ref) {
  if (typeof ref !== 'string' || !ref.trim() || ref.length > 1024 || /[\0\r\n]/.test(ref)) {
    throw new Error('请输入有效的分支名或提交。');
  }
  return ref.trim();
}

async function getTarget(root, mode, ref) {
  switch (mode) {
    case 'worktree':
    case 'staged':
      return { mode, baseline: await resolveCommit(root, 'HEAD') ?? await emptyTree(root) };
    case 'unstaged':
      return { mode };
    case 'base': {
      ref = validateRef(ref);
      const [sha, head] = await Promise.all([resolveCommit(root, ref), resolveCommit(root, 'HEAD')]);
      if (!sha) throw new Error(`找不到基准分支或提交：${ref}`);
      if (!head) throw new Error('当前仓库还没有提交。');
      const { text, code } = await git(root, ['merge-base', sha, head], { accepted: [0, 1] });
      if (code !== 0) throw new Error('当前分支和基准没有共同祖先。');
      return { mode, ref, sha, head, mergeBase: text.trim() };
    }
    case 'commit': {
      ref = validateRef(ref);
      const sha = await resolveCommit(root, ref);
      if (!sha) throw new Error(`找不到提交：${ref}`);
      return { mode, ref, sha, parent: await resolveCommit(root, `${sha}^1`) ?? await emptyTree(root) };
    }
    default:
      throw new Error('无法识别该查看范围。');
  }
}

function diffArgs(target) {
  switch (target.mode) {
    case 'worktree': return [requireHash(target.baseline)];
    case 'unstaged': return [];
    case 'staged': return ['--cached', requireHash(target.baseline)];
    case 'base': return [requireHash(target.mergeBase), requireHash(target.head)];
    case 'commit': return [requireHash(target.parent), requireHash(target.sha)];
    default: throw new Error('无法识别该查看范围。');
  }
}

function requireHash(value) {
  if (typeof value !== 'string' || !HASH.test(value)) throw new Error('无效的 Git 对象。');
  return value;
}

async function filterOverrides(root, mode) {
  if (mode !== 'worktree' && mode !== 'unstaged') return [];
  // Inspecting a worktree can invoke clean filters defined in Git config.
  const { text } = await git(root, [
    'config', '--null', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|process|required)$',
  ], { accepted: [0, 1] });
  return [...new Set(text.split('\0').filter(Boolean))].map((name) => {
    if (name.includes('=')) throw new Error('仓库的 Git 过滤器名称无法安全处理。');
    return `${name}=${name.endsWith('.required') ? 'false' : ''}`;
  });
}

const DIFF = [
  'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--find-renames',
  '--submodule=short', '--ignore-submodules=none',
];

function parseSummary(text) {
  const parts = text.split('\0');
  const files = [];
  const byPath = new Map();
  let cursor = 0;

  // With --raw and --numstat, Git prints all file records first, then line counts.
  while (parts[cursor]?.startsWith(':')) {
    const status = parts[cursor++].split(' ').at(-1)[0];
    const first = parts[cursor++];
    const renamed = status === 'R' || status === 'C';
    const filename = renamed ? parts[cursor++] : first;
    const file = { path: filename, status };
    if (renamed) file.oldPath = first;
    files.push(file);
    const pair = JSON.stringify([file.oldPath ?? null, filename]);
    if (!byPath.has(pair)) byPath.set(pair, []);
    byPath.get(pair).push(file);
  }

  while (parts[cursor]) {
    const item = parts[cursor++];
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(item);
    if (!match) throw new Error('无法解析 Git 改动统计。');
    const [, additions, deletions, name] = match;
    const oldPath = name ? null : parts[cursor++];
    const filename = name || parts[cursor++];
    const file = byPath.get(JSON.stringify([oldPath, filename]))?.shift();
    if (file && additions !== '-') {
      file.additions = Number(additions);
      file.deletions = Number(deletions);
    }
  }
  return files;
}

async function listUntrackedPaths(root, text) {
  const filenames = text.split('\0').filter(Boolean);
  if (filenames.length > MAX_FILES) throw new Error('未跟踪文件太多，请缩小查看范围。');

  // Git for Windows can list the contents of an NTFS junction as untracked files.
  // Check each ancestor without following links before displaying those paths.
  const directoryCache = new Map([['.', Promise.resolve(true)]]);
  function isRealDirectory(directory) {
    if (!directoryCache.has(directory)) {
      directoryCache.set(directory, (async () => {
        if (!(await isRealDirectory(path.posix.dirname(directory)))) return false;
        try {
          return (await fs.lstat(path.join(root, directory))).isDirectory();
        } catch {
          return false;
        }
      })());
    }
    return directoryCache.get(directory);
  }
  const visible = await Promise.all(filenames.map((filename) => isRealDirectory(path.posix.dirname(filename))));
  return filenames.filter((_, index) => visible[index]);
}

async function getSnapshot(root, mode = 'worktree', ref = '') {
  const target = await getTarget(root, mode, ref);
  const config = await filterOverrides(root, mode);
  const [summary, untracked] = await Promise.all([
    git(root, [...DIFF, '--raw', '--numstat', '-z', ...diffArgs(target), '--'], { config }),
    mode === 'worktree'
      ? git(root, ['ls-files', '--others', '--exclude-standard', '-z', '--'])
      : Promise.resolve({ text: '' }),
  ]);
  const files = parseSummary(summary.text);
  for (const filename of await listUntrackedPaths(root, untracked.text)) {
    files.push({ path: filename, status: '?' });
  }
  if (files.length > MAX_FILES) throw new Error('改动文件太多，请缩小查看范围。');
  files.sort((left, right) => left.path.localeCompare(right.path));
  for (const [index, file] of files.entries()) file.id = String(index);
  return { files, target };
}

function requireRepoPath(filename) {
  if (typeof filename !== 'string' || !filename || filename.includes('\0') ||
    path.isAbsolute(filename) || /^[A-Za-z]:/.test(filename) ||
    (process.platform === 'win32' && filename.includes('\\')) ||
    filename.split('/').some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) {
    throw new Error('无效的仓库内文件路径。');
  }
  return filename;
}

function trimPatch({ text, truncated }) {
  let offset = 0;
  for (let count = 0; count < MAX_PATCH_LINES; count += 1) {
    const newline = text.indexOf('\n', offset);
    if (newline < 0) return { text, truncated };
    offset = newline + 1;
  }
  return offset < text.length ? { text: text.slice(0, offset), truncated: true } : { text, truncated };
}

function untrackedDiff(filename, mode, content, truncated) {
  const quote = (label) => /[\t\r\n"\\]/.test(label) ? JSON.stringify(label) : label;
  const a = quote(`a/${filename}`);
  const b = quote(`b/${filename}`);
  const header = `diff --git ${a} ${b}\nnew file mode ${mode}\n`;
  if (content.includes(0)) return { text: `${header}Binary files /dev/null and ${b} differ\n`, truncated: false };
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
  const contentText = decoder.decode(content, { stream: truncated });
  if (!contentText) return { text: header, truncated };
  const lines = contentText.split('\n');
  const endsWithNewline = lines.at(-1) === '';
  if (endsWithNewline) lines.pop();
  const tooManyLines = lines.length > MAX_PATCH_LINES - 5;
  const visible = lines.slice(0, MAX_PATCH_LINES - 5);
  let text = `${header}--- /dev/null\n+++ ${b}\n@@ -0,0 +1,${visible.length} @@\n`;
  text += visible.map((line) => `+${line}\n`).join('');
  if (!endsWithNewline && !truncated && !tooManyLines) text += '\\ No newline at end of file\n';
  return { text, truncated: truncated || tooManyLines };
}

async function getUntrackedPatch(root, filename) {
  let location = root;
  const parts = filename.split('/');
  for (const part of parts.slice(0, -1)) {
    location = path.join(location, part);
    if (!(await fs.lstat(location)).isDirectory()) throw new Error('无法预览链接目录下的文件。');
  }
  location = path.join(location, parts.at(-1));
  const entry = await fs.lstat(location, { bigint: true });
  if (entry.isSymbolicLink()) {
    const destination = await fs.readlink(location, { encoding: 'buffer' });
    return untrackedDiff(filename, '120000', destination, false);
  }
  if (!entry.isFile()) throw new Error('该路径不是可预览的文件。');
  const handle = await fs.open(location, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.ino !== entry.ino || opened.dev !== entry.dev) {
      throw new Error('文件在读取时已更换，请刷新后重试。');
    }
    const content = Buffer.alloc(MAX_PATCH_BYTES + 1);
    let length = 0;
    while (length < content.length) {
      const { bytesRead } = await handle.read(content, length, content.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    return untrackedDiff(
      filename,
      entry.mode & 0o111n ? '100755' : '100644',
      content.subarray(0, Math.min(length, MAX_PATCH_BYTES)),
      length > MAX_PATCH_BYTES,
    );
  } finally {
    await handle.close();
  }
}

async function getPatch(root, target, file) {
  const filename = requireRepoPath(file.path);
  if (target.mode === 'worktree' && file.status === '?') return getUntrackedPatch(root, filename);
  const paths = file.oldPath ? [requireRepoPath(file.oldPath), filename] : [filename];
  const config = await filterOverrides(root, target.mode);
  const result = await git(root, [
    ...DIFF, '--patch', '--src-prefix=a/', '--dst-prefix=b/', '--unified=3',
    '--output-indicator-new=+', '--output-indicator-old=-', '--output-indicator-context= ',
    ...diffArgs(target), '--', ...paths,
  ], { config, maxBytes: MAX_PATCH_BYTES, preview: true });
  return trimPatch(result);
}

async function listSearchFiles(root) {
  const { text, truncated } = await git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--'], {
    maxBytes: 2 * 1024 * 1024, preview: true,
  });
  return { paths: text.split('\0').slice(0, -1), truncated };
}

module.exports = { getRepository, getSnapshot, getPatch, listSearchFiles };
