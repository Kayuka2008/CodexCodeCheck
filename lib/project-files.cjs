'use strict';

const { spawn } = require('node:child_process');
const { watch } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { getSnapshot } = require('./git.cjs');

const TREE_LIMIT = 320;
const PREVIEW_BYTES = 256 * 1024;
const PREVIEW_LINES = 3500;
const HIDDEN_DIRS = new Set(['.git', 'node_modules', '.next', '.venv', '__pycache__']);

function projectParts(relative, allowRoot = false) {
  if (allowRoot && relative === '') return [];
  if (typeof relative !== 'string' || !relative || relative.length > 4096 || /[\\:\0]/.test(relative)) {
    throw new Error('项目路径无效。');
  }
  const parts = relative.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) {
    throw new Error('项目路径无效。');
  }
  return parts;
}

async function locate(root, relative, allowRoot = false) {
  const parts = projectParts(relative, allowRoot);
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('无法预览链接路径。');
  }
  const resolved = await fs.realpath(current);
  const fromRoot = path.relative(root, resolved);
  if (fromRoot === '..' || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) {
    throw new Error('文件不在当前项目中。');
  }
  return resolved;
}

function ignoreSet(project, files) {
  if (!project.isGit || files.length === 0) return Promise.resolve(new Set());
  return new Promise(resolve => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
    const child = spawn('git', ['-c', 'core.fsmonitor=false', 'check-ignore', '--stdin', '-z'], {
      cwd: project.root,
      env: { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const chunks = [];
    let bytes = 0;
    const timer = setTimeout(() => child.kill(), 2500);
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 512 * 1024) child.kill();
      else chunks.push(chunk);
    });
    child.stdin.on('error', () => {});
    child.once('error', () => { clearTimeout(timer); resolve(new Set()); });
    child.once('close', code => {
      clearTimeout(timer);
      const ignored = code === 0 ? Buffer.concat(chunks).toString('utf8').split('\0').filter(Boolean) : [];
      resolve(new Set(ignored));
    });
    child.stdin.end(files.join('\0') + '\0', 'utf8');
  });
}

async function listProjectDirectory(project, relative = '') {
  const location = await locate(project.root, relative, true);
  const found = [];
  let truncated = false;
  const directory = await fs.opendir(location);
  for await (const entry of directory) {
    const type = entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : null;
    if (!type || HIDDEN_DIRS.has(entry.name.toLowerCase())) continue;
    if (found.length >= TREE_LIMIT * 4) {
      truncated = true;
      break;
    }
    found.push({ name: entry.name, path: relative ? `${relative}/${entry.name}` : entry.name, type });
  }
  const ignored = await ignoreSet(project, found.map(entry => entry.path));
  const entries = found.filter(entry => !ignored.has(entry.path));
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.type === 'directory' ? -1 : 1));
  return { entries: entries.slice(0, TREE_LIMIT), truncated: truncated || entries.length > TREE_LIMIT };
}

async function readProjectFile(project, relative) {
  const location = await locate(project.root, relative);
  const before = await fs.lstat(location);
  if (!before.isFile()) throw new Error('请选择一个文件。');
  const handle = await fs.open(location, 'r');
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || before.ino !== opened.ino || before.dev !== opened.dev) {
      throw new Error('文件已变动，请重新打开。');
    }
    const buffer = Buffer.alloc(PREVIEW_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    const truncatedBytes = size > PREVIEW_BYTES;
    const content = buffer.subarray(0, Math.min(size, PREVIEW_BYTES));
    const utf16 = content.length > 1 && ((content[0] === 0xff && content[1] === 0xfe) || (content[0] === 0xfe && content[1] === 0xff));
    if (!utf16 && content.includes(0)) return { text: '', truncated: false, binary: true };
    const encoding = utf16 ? (content[0] === 0xff ? 'utf-16le' : 'utf-16be') : 'utf-8';
    const text = new TextDecoder(encoding).decode(content, { stream: truncatedBytes });
    const lines = text.split('\n');
    return {
      text: lines.length > PREVIEW_LINES ? lines.slice(0, PREVIEW_LINES).join('\n') : text,
      truncated: truncatedBytes || lines.length > PREVIEW_LINES,
      binary: false,
    };
  } finally {
    await handle.close();
  }
}

async function recentFiles(project, candidates, stopped = () => false) {
  const files = [];
  for (let i = 0; i < candidates.length && !stopped(); i += 24) {
    const group = await Promise.all(candidates.slice(i, i + 24).map(async relative => {
      try {
        const stat = await fs.stat(await locate(project.root, relative));
        return stat.isFile() ? { path: relative, time: stat.mtimeMs } : null;
      } catch { return null; }
    }));
    for (const item of group) if (item) files.push(item);
  }
  return files;
}

async function findRecentProjectFile(project, stopped = () => false) {
  if (project.isGit) {
    try {
      const { files } = await getSnapshot(project.root, 'worktree');
      if (stopped()) return null;
      const changed = await recentFiles(project, [...new Set(files.map(file => file.path))], stopped);
      if (changed.length) return changed.reduce((newest, file) => file.time >= newest.time ? file : newest).path;
      if (files.length && !stopped()) return files.find(file => file.status === 'D')?.path ?? null;
    } catch { /* Tree browsing remains available when Git cannot supply a diff. */ }
  }

  const queue = [''];
  let newest = null;
  let scanned = 0;
  for (let i = 0; i < queue.length && i < 60 && scanned < 1600 && !stopped(); i++) {
    try {
      const { entries } = await listProjectDirectory(project, queue[i]);
      if (stopped()) return null;
      const files = [];
      for (const entry of entries) {
        if (entry.type === 'directory') queue.push(entry.path);
        else files.push(entry.path);
      }
      for (const file of await recentFiles(project, files.slice(0, 1600 - scanned))) {
        if (!newest || file.time >= newest.time) newest = file;
      }
      scanned += files.length;
    } catch { /* A directory can disappear during a checkout. */ }
  }
  return newest?.path ?? null;
}

function trackProjectFiles(project, onUpdate) {
  let stopped = false;
  let published = false;
  let revision = 0;
  let debounce;
  let watcher;
  const pending = new Set();

  async function publish() {
    const paths = [...pending];
    pending.clear();
    const change = ++revision;
    const ignored = await ignoreSet(project, paths);
    const files = await recentFiles(project, paths.filter(relative => !ignored.has(relative)));
    let newest = files.length ? files.reduce((latest, file) => file.time >= latest.time ? file : latest).path : null;
    if (!newest && project.isGit && paths.some(relative => !ignored.has(relative))) {
      const { files: changes } = await getSnapshot(project.root, 'worktree');
      const removed = new Set(changes.filter(file => file.status === 'D').map(file => file.path));
      newest = paths.findLast(relative => removed.has(relative));
    }
    if (!stopped && change === revision && newest) {
      published = true;
      onUpdate(newest);
    }
  }

  try {
    watcher = watch(project.root, { recursive: true }, (_, filename) => {
      const relative = filename?.replaceAll('\\', '/');
      if (!relative || relative.split('/').some(part => HIDDEN_DIRS.has(part.toLowerCase()))) return;
      if (pending.size >= 512) pending.delete(pending.values().next().value);
      pending.delete(relative);
      pending.add(relative);
      clearTimeout(debounce);
      debounce = setTimeout(() => { void publish().catch(() => {}); }, 220);
    });
    watcher.on('error', () => watcher.close());
  } catch { /* The initial view still works on volumes without recursive watch. */ }

  findRecentProjectFile(project, () => stopped || published).then(latest => {
    if (!stopped && !published && latest) onUpdate(latest);
  }).catch(() => {});

  return () => {
    stopped = true;
    watcher?.close();
    clearTimeout(debounce);
    pending.clear();
  };
}

module.exports = { listProjectDirectory, readProjectFile, trackProjectFiles };
