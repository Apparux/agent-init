import assert from 'node:assert/strict';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { executeLifecycle } from '../../src/installation/lifecycle.js';
import {
  assertSentinelsUnchanged,
  createInstallationFixture,
  snapshotTree,
} from './helpers.js';

test('healthy doctor is strictly read-only', async (t) => {
  const { homeDir, runtime, sentinels } = await createInstallationFixture(t);
  assert.equal((await executeLifecycle({ operation: 'install' }, runtime)).ok, true);
  const before = await snapshotTree(homeDir);

  const result = await executeLifecycle({ operation: 'doctor' }, runtime);

  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'healthy');
  assert.equal(result.checks.every((check) => check.status === 'ok'), true);
  assert.deepEqual(await snapshotTree(homeDir), before);
  await assertSentinelsUnchanged(sentinels);
});

test('doctor reports a broken managed target without repairing it', async (t) => {
  const { homeDir, runtime, sentinels } = await createInstallationFixture(t);
  const installed = await executeLifecycle({ operation: 'install' }, runtime);
  await unlink(installed.manifest.targets.codex.path);
  const before = await snapshotTree(homeDir);

  const result = await executeLifecycle({ operation: 'doctor' }, runtime);

  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'unhealthy');
  assert.equal(
    result.checks.some(
      (check) => check.id === 'target-codex' && check.code === 'BROKEN_TARGET',
    ),
    true,
  );
  assert.deepEqual(await snapshotTree(homeDir), before);
  await assertSentinelsUnchanged(sentinels);
});

test('doctor reports orphan control files and lifecycle residue without mutation', async (t) => {
  const { homeDir, runtime, sentinels } = await createInstallationFixture(t);
  const installed = await executeLifecycle({ operation: 'install' }, runtime);
  assert.equal(installed.ok, true);
  const operationId = 'ab'.repeat(16);
  const orphanDescriptor = path.join(
    homeDir,
    `.agent-project-setup.operation-${operationId}.owner.json`,
  );
  const rollback = path.join(
    installed.paths.installRoot,
    `.rollback-${operationId}`,
  );
  const manifestTemp = path.join(
    installed.paths.installRoot,
    `.install.json.${operationId}-manifest-update.tmp`,
  );
  const failedStaging = path.join(
    installed.paths.installRoot,
    `.staging-${operationId}.failed`,
  );
  await writeFile(orphanDescriptor, '{"foreign":"orphan"}\n', { mode: 0o600 });
  await mkdir(rollback);
  await writeFile(manifestTemp, 'temporary\n', { mode: 0o600 });
  await mkdir(failedStaging);
  const before = await snapshotTree(homeDir);

  const result = await executeLifecycle({ operation: 'doctor' }, runtime);

  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'unhealthy');
  assert.equal(
    result.checks.some(
      (check) =>
        check.code === 'ORPHAN_CONTROL' && check.path === orphanDescriptor,
    ),
    true,
  );
  for (const residuePath of [rollback, manifestTemp, failedStaging]) {
    assert.equal(
      result.checks.some(
        (check) => check.code === 'LIFECYCLE_RESIDUE' && check.path === residuePath,
      ),
      true,
    );
  }
  assert.deepEqual(await snapshotTree(homeDir), before);

  const uninstall = await executeLifecycle({ operation: 'uninstall' }, runtime);
  assert.equal(uninstall.ok, false);
  assert.equal(uninstall.error.code, 'AMBIGUOUS_OPERATION');
  assert.deepEqual(await snapshotTree(homeDir), before);
  await assertSentinelsUnchanged(sentinels);
});
