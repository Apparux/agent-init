import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { digestTree } from '../../src/installation/filesystem.js';

async function makeTree(root, reverse = false) {
  const entries = [
    ['SKILL.md', 'skill\n'],
    ['references/guide.md', 'guide\n'],
  ];
  if (reverse) entries.reverse();

  for (const [relativePath, content] of entries) {
    const destination = path.join(root, relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, content);
  }
}

test('tree digest ignores creation order, mtime, and absolute path', async (t) => {
  const parent = await mkdtemp(path.join(tmpdir(), 'aps-digest-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const first = path.join(parent, 'first');
  const second = path.join(parent, 'second');
  await mkdir(first);
  await mkdir(second);
  await makeTree(first);
  await makeTree(second, true);
  await utimes(path.join(second, 'SKILL.md'), new Date(1), new Date(2));

  assert.equal(await digestTree(first), await digestTree(second));
});

test('tree digest includes the executable bit', async (t) => {
  const parent = await mkdtemp(path.join(tmpdir(), 'aps-digest-mode-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'tree');
  await mkdir(root);
  await writeFile(path.join(root, 'script.js'), 'process.exit(0);\n', { mode: 0o644 });
  const before = await digestTree(root);

  await chmod(path.join(root, 'script.js'), 0o755);

  assert.notEqual(await digestTree(root), before);
});
