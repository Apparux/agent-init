import assert from 'node:assert/strict';
import { readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { executeLifecycle } from '../../src/installation/lifecycle.js';
import { createInstallationFixture, snapshotTree } from './helpers.js';

function unsupportedSymlink() {
  const error = new Error('symlink unsupported');
  error.code = 'ENOTSUP';
  throw error;
}

async function replaceWithMatchingSymlink(entryPath, outsidePath) {
  const content = await readFile(entryPath);
  await writeFile(outsidePath, content, { mode: 0o600 });
  await rm(entryPath);
  await symlink(outsidePath, entryPath);
}

test('symlinked install manifest is never followed for ownership', async (t) => {
  const { disposableRoot, homeDir, runtime } = await createInstallationFixture(t);
  const installed = await executeLifecycle({ operation: 'install' }, runtime);
  const outside = path.join(disposableRoot, 'outside-manifest.json');
  await replaceWithMatchingSymlink(installed.paths.manifest, outside);
  const before = await snapshotTree(disposableRoot);

  const doctor = await executeLifecycle({ operation: 'doctor' }, runtime);

  assert.equal(doctor.ok, false);
  assert.equal(
    doctor.checks.some((check) => check.code === 'CORRUPT_MANIFEST'),
    true,
  );
  assert.deepEqual(await snapshotTree(disposableRoot), before);
  const uninstall = await executeLifecycle({ operation: 'uninstall' }, runtime);
  assert.equal(uninstall.ok, false);
  assert.equal(uninstall.error.code, 'CORRUPT_MANIFEST');
  assert.equal((await snapshotTree(homeDir)).some((entry) => entry.path.includes('current')), true);
});

test('symlinked canonical marker is never followed for ownership', async (t) => {
  const { disposableRoot, homeDir, runtime } = await createInstallationFixture(t);
  const installed = await executeLifecycle({ operation: 'install' }, runtime);
  const marker = path.join(installed.manifest.canonical.root, '.agent-project-setup-owner.json');
  await replaceWithMatchingSymlink(marker, path.join(disposableRoot, 'outside-owner.json'));
  const before = await snapshotTree(homeDir);

  const doctor = await executeLifecycle({ operation: 'doctor' }, runtime);
  assert.equal(doctor.ok, false);
  assert.deepEqual(await snapshotTree(homeDir), before);
  const uninstall = await executeLifecycle({ operation: 'uninstall' }, runtime);
  assert.equal(uninstall.ok, false);
  assert.equal(uninstall.error.code, 'OWNERSHIP_MISMATCH');
  assert.deepEqual(await snapshotTree(homeDir), before);
});

test('symlinked managed-copy marker is drifted and preserved', async (t) => {
  const { disposableRoot, homeDir, runtime } = await createInstallationFixture(t);
  const copyRuntime = { ...runtime, createDirectorySymlink: unsupportedSymlink };
  const installed = await executeLifecycle({ operation: 'install' }, copyRuntime);
  const codexPath = installed.manifest.targets.codex.path;
  const marker = path.join(codexPath, '.agent-project-setup-owner.json');
  await replaceWithMatchingSymlink(marker, path.join(disposableRoot, 'outside-copy-owner.json'));
  const beforeDoctor = await snapshotTree(homeDir);

  const doctor = await executeLifecycle({ operation: 'doctor' }, copyRuntime);
  assert.equal(doctor.ok, false);
  assert.deepEqual(await snapshotTree(homeDir), beforeDoctor);
  const uninstall = await executeLifecycle({ operation: 'uninstall' }, copyRuntime);
  assert.equal(uninstall.ok, true);
  assert.deepEqual(uninstall.preserved, [codexPath]);
});
