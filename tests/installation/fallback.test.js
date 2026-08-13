import assert from 'node:assert/strict';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { executeLifecycle } from '../../src/installation/lifecycle.js';
import {
  assertSentinelsUnchanged,
  createInstallationFixture,
} from './helpers.js';

function unsupportedSymlink() {
  const error = new Error('directory symlinks are not supported by this filesystem');
  error.code = 'ENOTSUP';
  throw error;
}

function privilegedSymlink() {
  const error = new Error('Windows symlink privilege not held');
  error.code = 'EPERM';
  throw error;
}

async function assertManagedCopyFallback(runtime, sentinels) {
  const installed = await executeLifecycle({ operation: 'install' }, runtime);

  assert.equal(installed.ok, true);
  for (const record of Object.values(installed.manifest.targets)) {
    assert.equal(record.mode, 'copy');
    assert.equal((await lstat(record.path)).isDirectory(), true);
    const marker = JSON.parse(
      await readFile(path.join(record.path, '.agent-project-setup-owner.json'), 'utf8'),
    );
    assert.equal(marker.installId, installed.manifest.installId);
    assert.equal(marker.targetId, record.targetId);
    assert.equal(record.digest, installed.manifest.canonical.digest);
  }

  const doctor = await executeLifecycle({ operation: 'doctor' }, runtime);
  assert.equal(doctor.ok, true);
  assert.equal(doctor.outcome, 'healthy');
  assert.equal(
    doctor.checks
      .filter((check) => check.id.startsWith('target-'))
      .every((check) => check.message.includes('Mode: copy')),
    true,
  );
  await assertSentinelsUnchanged(sentinels);
}

test('an explicit symlink capability limit falls back to owned managed copies', async (t) => {
  const { runtime, sentinels } = await createInstallationFixture(t);
  runtime.createDirectorySymlink = unsupportedSymlink;
  await assertManagedCopyFallback(runtime, sentinels);
});

test('symlink EPERM at the syscall seam falls back to owned managed copies', async (t) => {
  const { runtime, sentinels } = await createInstallationFixture(t);
  runtime.createDirectorySymlink = privilegedSymlink;
  await assertManagedCopyFallback(runtime, sentinels);
});
