import assert from 'node:assert/strict';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { executeLifecycle } from '../../src/installation/lifecycle.js';
import { createInstallationFixture, snapshotTree } from './helpers.js';

test('target parent replacement race never follows a newly inserted symlink', async (t) => {
  const { disposableRoot, homeDir, runtime } = await createInstallationFixture(t);
  await rm(path.join(homeDir, '.agents'), { recursive: true });
  const outside = path.join(disposableRoot, 'outside');
  await mkdir(outside);
  const sentinel = path.join(outside, 'sentinel.txt');
  await writeFile(sentinel, 'outside stays foreign\n', { mode: 0o600 });
  let injected = false;
  const racingRuntime = {
    ...runtime,
    async beforeMutation(name) {
      if (!injected && name === 'parent:create:.agents') {
        injected = true;
        await symlink(outside, path.join(homeDir, '.agents'), 'dir');
      }
    },
  };
  const outsideBefore = await snapshotTree(outside);

  const result = await executeLifecycle({ operation: 'install' }, racingRuntime);

  assert.equal(injected, true);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'PHYSICAL_PATH_ESCAPE');
  assert.deepEqual(await snapshotTree(outside), outsideBefore);
  assert.equal(await readFile(sentinel, 'utf8'), 'outside stays foreign\n');
});

test('missing discovery parents are created incrementally and retained after install', async (t) => {
  const { homeDir, runtime } = await createInstallationFixture(t);
  await rm(path.join(homeDir, '.agents'), { recursive: true });
  await rm(path.join(homeDir, '.claude'), { recursive: true });

  const result = await executeLifecycle({ operation: 'install' }, runtime);

  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'installed');
  assert.equal(
    (await (await import('node:fs/promises')).lstat(path.join(homeDir, '.agents', 'skills'))).isDirectory(),
    true,
  );
  assert.equal(
    (await (await import('node:fs/promises')).lstat(path.join(homeDir, '.claude', 'skills'))).isDirectory(),
    true,
  );
});
