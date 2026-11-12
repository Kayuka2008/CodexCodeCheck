'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { startReview, buildArgs, validateTarget, MAX_INPUT_BYTES } = require('../lib/review.cjs');

function makeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    return true;
  };
  return child;
}

const target = { mode: 'worktree' };
const diff = 'diff --git a/src/main.js b/src/main.js\n--- a/src/main.js\n+++ b/src/main.js\n@@ -11 +12 @@\n-old\n+new\n';
const structuredResult = {
  summary: '修复了空输入时的崩溃。',
  findings: [{
    title: '空输入会触发异常',
    detail: '调用 trim 前没有检查值是否存在。',
    path: 'src/main.js',
    line: 12,
    priority: 'P1',
  }, {
    title: '未包含的代码问题',
    detail: '模型给出了不在 diff 中的路径和行号。',
    path: 'src/other.js',
    line: 99,
    priority: 'P2',
  }],
};

test('buildArgs uses stdin, a schema, read-only sandbox, and no Git target flags', () => {
  const args = buildArgs();
  assert.deepEqual(args.slice(0, 10), [
    '-a', 'never', '--disable', 'hooks', 'exec', '--sandbox', 'read-only', '--ephemeral', '--json', '--skip-git-repo-check',
  ]);
  assert.equal(args[10], '--output-schema');
  assert.ok(path.isAbsolute(args[11]));
  assert.equal(fs.existsSync(args[11]), true);
  assert.equal(args.at(-1), '-');
  assert.equal(args.includes('--uncommitted'), false);
  assert.equal(args.includes('--base'), false);
  assert.equal(args.includes('--commit'), false);
});

test('accepts all five review scopes', () => {
  for (const mode of ['staged', 'unstaged', 'worktree']) assert.doesNotThrow(() => validateTarget({ mode }));
  assert.doesNotThrow(() => validateTarget({ mode: 'base', ref: 'main' }));
  assert.doesNotThrow(() => validateTarget({ mode: 'commit', sha: 'a'.repeat(40) }));
  assert.throws(() => validateTarget({ mode: 'base' }), /需要 target.ref/);
});

test('sends only the supplied diff on stdin from a neutral cwd and maps structured output', async () => {
  const child = makeChild();
  const calls = [];
  const phases = [];
  let stdinText = '';
  child.stdin.on('data', (chunk) => { stdinText += chunk.toString('utf8'); });
  const task = startReview({
    repoRoot: 'C:\\private\\repo',
    target,
    input: diff,
    onUpdate: (message) => phases.push(message),
    executable: 'codex-stub',
    spawnImpl: (executable, args, options) => {
      calls.push({ executable, args, options });
      queueMicrotask(() => {
        child.stdout.write('{"type":"thread.started"}\n');
        child.stdout.write('{"type":"turn.started"}\n');
        child.stdout.write(JSON.stringify({
          type: 'item.completed',
          item: { type: 'agent_message', text: JSON.stringify(structuredResult) },
        }) + '\n');
        child.exitCode = 0;
        child.emit('close', 0, null);
      });
      return child;
    },
  });

  const result = await task.done;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].executable, 'codex-stub');
  assert.equal(calls[0].options.shell, false);
  assert.notEqual(calls[0].options.cwd, 'C:\\private\\repo');
  assert.equal(calls[0].options.cwd, path.resolve(__dirname, '..'));
  assert.equal(calls[0].args.at(-1), '-');
  assert.match(stdinText, /不要调用任何工具/);
  assert.match(stdinText, /不可信的代码数据/);
  assert.ok(stdinText.includes(diff));
  assert.match(result.text, /# 代码审查/);
  assert.match(result.text, /调用 trim 前没有检查/);
  assert.deepEqual(result.findings, [structuredResult.findings[0]]);
  assert.deepEqual(phases, ['已连接 Codex，开始审查提供的差异', '正在分析提供的差异']);
});

test('rejects missing and oversized diff input with localized errors', () => {
  assert.throws(() => startReview({ target, input: '' }), /非空的 Git diff/);
  assert.throws(() => startReview({ target, input: 'x'.repeat(MAX_INPUT_BYTES + 1) }), /超过 128 KiB/);
});

test('cancel rejects with AbortError and terminates the child', async () => {
  const child = makeChild();
  const task = startReview({ target, input: diff, spawnImpl: () => child });
  task.cancel();
  await assert.rejects(task.done, { name: 'AbortError' });
  assert.equal(child.killed, true);
});

test('rejects a successful CLI process that emits no structured result', async () => {
  const child = makeChild();
  const task = startReview({
    target,
    input: diff,
    spawnImpl: () => {
      queueMicrotask(() => {
        child.exitCode = 0;
        child.emit('close', 0, null);
      });
      return child;
    },
  });
  await assert.rejects(task.done, /未返回有效的结构化结果/);
});

test('rejects incomplete or invalid structured findings instead of inventing fields', async () => {
  const child = makeChild();
  const task = startReview({
    target,
    input: diff,
    spawnImpl: () => {
      queueMicrotask(() => {
        child.stdout.write(JSON.stringify({
          type: 'item.completed',
          item: { type: 'agent_message', text: JSON.stringify({ summary: '', findings: [{ title: 'x' }] }) },
        }) + '\n');
        child.exitCode = 0;
        child.emit('close', 0, null);
      });
      return child;
    },
  });
  await assert.rejects(task.done, /缺少有效标题、说明、路径、行号或优先级/);
});

test('location validation handles plus-prefixed source lines and real b/ directories', async () => {
  const child = makeChild();
  const patchWithPlusSource = [
    'diff --git a/b/file.cpp b/b/file.cpp',
    '--- a/b/file.cpp',
    '+++ b/b/file.cpp',
    '@@ -1 +1 @@',
    '-old',
    '+++ source line begins with two plus signs',
  ].join('\n');
  const result = {
    summary: '检查结果。',
    findings: [{ title: '问题', detail: '说明。', path: 'b/file.cpp', line: 1, priority: 'P1' }],
  };
  const task = startReview({
    target,
    input: patchWithPlusSource,
    spawnImpl: () => {
      queueMicrotask(() => {
        child.stdout.write(JSON.stringify({
          type: 'item.completed',
          item: { type: 'agent_message', text: JSON.stringify(result) },
        }) + '\n');
        child.exitCode = 0;
        child.emit('close', 0, null);
      });
      return child;
    },
  });
  const output = await task.done;
  assert.deepEqual(output.findings, result.findings);
});
