import assert from 'node:assert/strict';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { executeLifecycle } from '../../src/installation/lifecycle.js';
import {
  assertSentinelsUnchanged,
  createInstallationFixture,
  snapshotTree,
} from './helpers.js';

test('invalid package payload causes zero HOME mutation', async (t) => {
  const { disposableRoot, homeDir, packageRoot, runtime, sentinels } =
    await createInstallationFixture(t);
  await writeFile(
    path.join(packageRoot, 'skills', 'project-setup', 'SKILL.md'),
    '---\nname: wrong-name\ndescription: Wrong.\n---\n',
  );
  const before = await snapshotTree(disposableRoot);

  const result = await executeLifecycle({ operation: 'install' }, runtime);

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'INVALID_PACKAGE_PAYLOAD');
  assert.deepEqual(await snapshotTree(disposableRoot), before);
  await assertSentinelsUnchanged(sentinels);
  assert.equal(homeDir.startsWith(disposableRoot), true);
});

test('foreign discovery target stops install before any control-set mutation', async (t) => {
  const { disposableRoot, homeDir, runtime, sentinels } =
    await createInstallationFixture(t);
  const target = path.join(homeDir, '.agents', 'skills', 'project-setup');
  await mkdir(target);
  await writeFile(path.join(target, 'SKILL.md'), 'foreign skill\n', { mode: 0o600 });
  const before = await snapshotTree(disposableRoot);

  const result = await executeLifecycle({ operation: 'install' }, runtime);

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'INSTALL_CONFLICT');
  assert.equal(result.error.path, target);
  assert.deepEqual(await snapshotTree(disposableRoot), before);
  await assertSentinelsUnchanged(sentinels);
});

test('unknown asset inside canonical root blocks doctor health and uninstall deletion', async (t) => {
  const { homeDir, runtime, sentinels } = await createInstallationFixture(t);
  const installed = await executeLifecycle({ operation: 'install' }, runtime);
  const unknown = path.join(installed.manifest.canonical.root, 'user-note.txt');
  await writeFile(unknown, 'user-owned canonical sibling\n', { mode: 0o600 });
  const before = await snapshotTree(homeDir);

  const doctor = await executeLifecycle({ operation: 'doctor' }, runtime);
  assert.equal(doctor.ok, false);
  assert.equal(
    doctor.checks.some(
      (check) => check.id === 'canonical' && check.code === 'OWNERSHIP_MISMATCH',
    ),
    true,
  );
  assert.deepEqual(await snapshotTree(homeDir), before);

  const uninstall = await executeLifecycle({ operation: 'uninstall' }, runtime);
  assert.equal(uninstall.ok, false);
  assert.equal(uninstall.error.code, 'OWNERSHIP_MISMATCH');
  assert.deepEqual(await snapshotTree(homeDir), before);
  await assertSentinelsUnchanged(sentinels);
});

test('symlinked discovery parent is rejected without following it', async (t) => {
  const { disposableRoot, homeDir, runtime, sentinels } =
    await createInstallationFixture(t);
  const outside = path.join(disposableRoot, 'outside-agents');
  await mkdir(outside);
  const outsideSentinel = path.join(outside, 'outside.txt');
  await writeFile(outsideSentinel, 'outside foreign\n', { mode: 0o600 });
  await rm(path.join(homeDir, '.agents'), { recursive: true });
  await symlink(outside, path.join(homeDir, '.agents'), 'dir');
  const before = await snapshotTree(disposableRoot);

  const result = await executeLifecycle({ operation: 'install' }, runtime);

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'PHYSICAL_PATH_ESCAPE');
  assert.deepEqual(await snapshotTree(disposableRoot), before);
  assert.equal(await (await import('node:fs/promises')).readFile(outsideSentinel, 'utf8'), 'outside foreign\n');
  for (const [name, sentinel] of Object.entries(sentinels)) {
    if (!sentinel.includes(`${path.sep}.agents${path.sep}`)) {
      const content = await (await import('node:fs/promises')).readFile(sentinel, 'utf8');
      assert.equal(content, `foreign:${name}\n`);
    }
  }
});
