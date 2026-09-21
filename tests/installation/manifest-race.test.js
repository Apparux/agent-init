import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { executeLifecycle } from '../../src/installation/lifecycle.js';
import { createInstallationFixture } from './helpers.js';

test('fresh manifest publication never overwrites a concurrent replacement', async (t) => {
  const { homeDir, runtime, sentinels } = await createInstallationFixture(t);
  const manifestPath = path.join(homeDir, '.agent-init', 'install.json');
  let injected = false;
  const racingRuntime = {
    ...runtime,
    async beforeMutation(name) {
      if (!injected && name === 'manifest:install-before-publish') {
        injected = true;
        await writeFile(manifestPath, 'foreign concurrent manifest\n', {
          flag: 'wx',
          mode: 0o600,
        });
      }
    },
  };

  const result = await executeLifecycle({ operation: 'install' }, racingRuntime);

  assert.equal(injected, true);
  assert.equal(result.ok, false);
  assert.equal(await readFile(manifestPath, 'utf8'), 'foreign concurrent manifest\n');
  for (const sentinelPath of Object.values(sentinels)) {
    assert.equal((await readFile(sentinelPath, 'utf8')).startsWith('foreign:'), true);
  }
});

test('update manifest CAS preserves a concurrent replacement and old rollback evidence', async (t) => {
  const { homeDir, packageRoot, runtime } = await createInstallationFixture(t);
  assert.equal((await executeLifecycle({ operation: 'install' }, runtime)).ok, true);
  await writeFile(
    path.join(packageRoot, 'package.json'),
    `${JSON.stringify({ name: runtime.packageName, version: '0.2.0' }, null, 2)}\n`,
  );
  await writeFile(
    path.join(packageRoot, 'skills', 'project-setup', 'SKILL.md'),
    '---\nname: project-setup\ndescription: Manifest CAS race payload.\n---\n\n# 0.2\n',
  );
  const manifestPath = path.join(homeDir, '.agent-init', 'install.json');
  let injected = false;
  const racingRuntime = {
    ...runtime,
    packageVersion: '0.2.0',
    async beforeMutation(name) {
      if (!injected && name === 'manifest:update-before-detach') {
        injected = true;
        await rm(manifestPath);
        await writeFile(manifestPath, 'foreign update replacement\n', { mode: 0o600 });
      }
    },
  };

  const result = await executeLifecycle({ operation: 'update' }, racingRuntime);

  assert.equal(injected, true);
  assert.equal(result.ok, false);
  assert.equal(await readFile(manifestPath, 'utf8'), 'foreign update replacement\n');
  assert.equal(
    result.error.code === 'ROLLBACK_FAILED' || result.error.code === 'OWNERSHIP_MISMATCH',
    true,
  );
  assert.equal(
    result.error.unresolved.some((entry) => entry.includes('install.json.rollback')),
    true,
  );
});
