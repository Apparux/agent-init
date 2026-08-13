import assert from 'node:assert/strict';
import { readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { executeLifecycle } from '../../src/installation/lifecycle.js';
import {
  assertSentinelsUnchanged,
  createInstallationFixture,
  snapshotTree,
} from './helpers.js';

function unsupportedSymlink() {
  const error = new Error('symlink identity/capability unavailable');
  error.code = 'ENOTSUP';
  throw error;
}

test('drifted managed copy is diagnosed and preserved by uninstall', async (t) => {
  const { homeDir, runtime, sentinels } = await createInstallationFixture(t);
  const copyRuntime = { ...runtime, createDirectorySymlink: unsupportedSymlink };
  const installed = await executeLifecycle({ operation: 'install' }, copyRuntime);
  const codexPath = installed.manifest.targets.codex.path;
  await writeFile(path.join(codexPath, 'SKILL.md'), 'user edited managed copy\n');
  const beforeDoctor = await snapshotTree(homeDir);

  const doctor = await executeLifecycle({ operation: 'doctor' }, copyRuntime);

  assert.equal(doctor.ok, false);
  assert.equal(
    doctor.checks.some(
      (check) => check.id === 'target-codex' && check.code === 'OWNERSHIP_MISMATCH',
    ),
    true,
  );
  assert.deepEqual(await snapshotTree(homeDir), beforeDoctor);

  const uninstall = await executeLifecycle({ operation: 'uninstall' }, copyRuntime);

  assert.equal(uninstall.ok, true);
  assert.deepEqual(uninstall.preserved, [codexPath]);
  assert.equal(await readFile(path.join(codexPath, 'SKILL.md'), 'utf8'), 'user edited managed copy\n');
  await assertSentinelsUnchanged(sentinels);
});

test('byte-identical replacement without the ownership marker is never adopted', async (t) => {
  const { runtime, sentinels } = await createInstallationFixture(t);
  const copyRuntime = { ...runtime, createDirectorySymlink: unsupportedSymlink };
  const installed = await executeLifecycle({ operation: 'install' }, copyRuntime);
  const codexPath = installed.manifest.targets.codex.path;
  const skillContent = await readFile(path.join(codexPath, 'SKILL.md'));
  await rm(codexPath, { recursive: true });
  await (await import('node:fs/promises')).mkdir(codexPath);
  await writeFile(path.join(codexPath, 'SKILL.md'), skillContent);

  const uninstall = await executeLifecycle({ operation: 'uninstall' }, copyRuntime);

  assert.equal(uninstall.ok, true);
  assert.deepEqual(uninstall.preserved, [codexPath]);
  assert.deepEqual(await readFile(path.join(codexPath, 'SKILL.md')), skillContent);
  await assertSentinelsUnchanged(sentinels);
});

test('same-destination symlink replacement is drifted because identity changed', async (t) => {
  const { runtime, sentinels } = await createInstallationFixture(t);
  const installed = await executeLifecycle({ operation: 'install' }, runtime);
  const codex = installed.manifest.targets.codex;
  const linkText = await readlink(codex.path);
  await rm(codex.path);
  await symlink(linkText, codex.path, 'dir');

  const doctor = await executeLifecycle({ operation: 'doctor' }, runtime);
  assert.equal(doctor.ok, false);
  assert.equal(
    doctor.checks.some(
      (check) => check.id === 'target-codex' && check.code === 'OWNERSHIP_MISMATCH',
    ),
    true,
  );

  const uninstall = await executeLifecycle({ operation: 'uninstall' }, runtime);

  assert.equal(uninstall.ok, true);
  assert.deepEqual(uninstall.preserved, [codex.path]);
  assert.equal(await readlink(codex.path), linkText);
  await assertSentinelsUnchanged(sentinels);
});
