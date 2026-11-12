'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { getRepository, getSnapshot, getPatch } = require('../lib/git.cjs');

async function fixture(t) {
  const temp = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(temp, 'codex-review-git-'));
  t.after(async () => {
    if (path.dirname(await fs.realpath(root)) === temp) await fs.rm(root, { recursive: true, force: true });
  });
  const git = (...args) => execFileSync('git', [
    '-c', 'user.name=Review Test', '-c', 'user.email=review@example.invalid',
    '-c', 'commit.gpgSign=false', ...args,
  ], { cwd: root, encoding: 'utf-8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (name, content) => fs.writeFile(path.join(root, name), content);
  git('init', '-q', '-b', 'main');
  return { root, git, write };
}

test('read-only snapshots match the Git index, working tree and historical targets', async (t) => {
  const { root, git, write } = await fixture(t);
  const text = '中文 空格 [x].js';
  const similar = '中文 空格 x.js';
  await write(text, 'const value = 1;\n');
  await write(similar, '// Similar path\n');
  await write('old name.js', 'const moved = true;\n');
  git('add', '--', text, similar, 'old name.js');

  assert.equal((await getRepository(root)).hasHead, false);
  const unborn = await getSnapshot(root);
  const unbornFile = unborn.files.find((file) => file.path === text);
  assert.equal(unbornFile.status, 'A');
  assert.equal(unbornFile.additions, 1);
  assert.match((await getPatch(root, unborn.target, unbornFile)).text, /\+const value = 1;/);

  git('commit', '-qm', 'initial');
  const first = git('rev-parse', 'HEAD');
  git('switch', '-qc', 'feature');
  await fs.mkdir(path.join(root, 'folder'));
  const repo = await getRepository(path.join(root, 'folder'));
  assert.equal(repo.root, root);
  assert.equal(repo.branch, 'feature');
  assert.equal(repo.hasHead, true);

  await write(text, 'const value = 2;\n');
  git('add', '--', text);
  await write(text, 'const value = 3;\n');
  await write(similar, '// Similar path also changed\n');
  git('mv', '--', 'old name.js', 'new name.js');
  await write('not added.js', 'newText()');
  await write('binary.dat', Buffer.from([0, 1, 2]));
  await write('long.txt', 'line\n'.repeat(6_000));

  const [staged, unstaged, worktree] = await Promise.all([
    getSnapshot(root, 'staged'), getSnapshot(root, 'unstaged'), getSnapshot(root, 'worktree'),
  ]);
  const find = (snapshot, name) => snapshot.files.find((file) => file.path === name);
  assert.equal(find(staged, 'not added.js'), undefined);
  assert.equal(find(unstaged, 'not added.js'), undefined);
  assert.equal(find(worktree, 'not added.js').status, '?');
  const stagedPatch = await getPatch(root, staged.target, find(staged, text));
  const unstagedPatch = await getPatch(root, unstaged.target, find(unstaged, text));
  const combinedPatch = await getPatch(root, worktree.target, find(worktree, text));
  assert.match(stagedPatch.text, /-const value = 1;\r?\n\+const value = 2;/);
  assert.match(unstagedPatch.text, /-const value = 2;\r?\n\+const value = 3;/);
  assert.match(combinedPatch.text, /-const value = 1;\r?\n\+const value = 3;/);
  assert.doesNotMatch(combinedPatch.text, /Similar path/);
  const rename = find(staged, 'new name.js');
  assert.equal(rename.status, 'R');
  assert.equal(rename.oldPath, 'old name.js');
  assert.match((await getPatch(root, staged.target, rename)).text, /rename from old name\.js/);
  assert.match((await getPatch(root, worktree.target, find(worktree, 'not added.js'))).text, /\+newText\(\)\n\\ No newline/);
  assert.match((await getPatch(root, worktree.target, find(worktree, 'binary.dat'))).text, /Binary files/);
  assert.equal((await getPatch(root, worktree.target, find(worktree, 'long.txt'))).truncated, true);
  await assert.rejects(getPatch(root, worktree.target, { path: '../secrets.txt', status: '?' }), /路径/);

  git('commit', '-qm', 'staged changes');
  const base = await getSnapshot(root, 'base', 'main');
  assert.equal(base.target.mergeBase, first);
  assert.deepEqual(base.files.map((file) => file.path).sort(), ['new name.js', text].sort());
  assert.match((await getPatch(root, base.target, find(base, text))).text, /\+const value = 2;/);
  const historical = await getSnapshot(root, 'commit', first.slice(0, 12));
  assert.equal(historical.target.sha, first);
  assert.equal(historical.files.length, 3);
  assert.match((await getPatch(root, historical.target, find(historical, text))).text, /\+const value = 1;/);
  await assert.rejects(getSnapshot(root, 'commit', '--all'), /找不到提交/);

  const linked = path.join(root, 'linked worktree');
  git('worktree', 'add', '--detach', linked, first);
  const linkedRepo = await getRepository(linked);
  assert.equal(linkedRepo.root, linked);
  assert.equal(linkedRepo.branch, 'HEAD');
  await fs.writeFile(path.join(linked, text), 'const value = 4;\n');
  const linkedSnapshot = await getSnapshot(linked);
  assert.match((await getPatch(linked, linkedSnapshot.target, find(linkedSnapshot, text))).text, /\+const value = 4;/);
});

test('worktree reads avoid custom Git clean filters and external diff commands', async (t) => {
  const { root, git, write } = await fixture(t);
  await write('.gitattributes', '*.txt filter=probe diff=probe\n');
  await write('file.txt', 'before\n');
  git('add', '--', '.gitattributes', 'file.txt');
  git('commit', '-qm', 'initial');
  git('config', 'filter.probe.clean', 'echo FILTER-RAN > clean-ran.txt; cat');
  git('config', 'filter.probe.required', 'true');
  git('config', 'diff.probe.command', 'echo DIFF-RAN > diff-ran.txt');
  await write('file.txt', 'after\n');

  const snapshot = await getSnapshot(root);
  assert.match((await getPatch(root, snapshot.target, snapshot.files[0])).text, /\+after/);
  await assert.rejects(fs.access(path.join(root, 'clean-ran.txt')), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(root, 'diff-ran.txt')), { code: 'ENOENT' });
});

test('a directory link does not expose untracked paths outside the worktree', async (t) => {
  const { root } = await fixture(t);
  const temp = await fs.realpath(os.tmpdir());
  const outside = await fs.mkdtemp(path.join(temp, 'codex-review-git-outside-'));
  t.after(async () => {
    if (path.dirname(await fs.realpath(outside)) === temp) await fs.rm(outside, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(outside, 'outside.txt'), 'This file is outside the worktree.\n');
  await fs.symlink(outside, path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  await fs.mkdir(path.join(root, 'normal'));
  await fs.writeFile(path.join(root, 'normal', 'inside.txt'), 'This file is inside the worktree.\n');

  const snapshot = await getSnapshot(root);
  assert.ok(snapshot.files.some((file) => file.path === 'normal/inside.txt'));
  assert.ok(snapshot.files.every((file) => !file.path.startsWith('link/')));
  await assert.rejects(getPatch(root, snapshot.target, { path: 'link/outside.txt', status: '?' }), /链接目录/);
});
