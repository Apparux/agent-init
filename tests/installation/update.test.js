import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { executeLifecycle } from '../../src/installation/lifecycle.js';
import {
  assertSentinelsUnchanged,
  createInstallationFixture,
  snapshotTree,
} from './helpers.js';

test('same-version update is a zero-churn no-op and ignores cwd repository', async (t) => {
  const { disposableRoot, homeDir, runtime, sentinels } =
    await createInstallationFixture(t);
  assert.equal((await executeLifecycle({ operation: 'install' }, runtime)).ok, true);
  const repository = path.join(disposableRoot, 'repository');
  await mkdir(repository);
  await writeFile(path.join(repository, 'AGENTS.md'), 'project sentinel\n', { mode: 0o640 });
  const homeBefore = await snapshotTree(homeDir);
  const projectBefore = await snapshotTree(repository);

  const result = await executeLifecycle(
    { operation: 'update' },
    { ...runtime, cwd: repository },
  );

  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'already-up-to-date');
  assert.deepEqual(await snapshotTree(homeDir), homeBefore);
  assert.deepEqual(await snapshotTree(repository), projectBefore);
  await assertSentinelsUnchanged(sentinels);
});

test('same-version different payload is an integrity conflict with zero mutation', async (t) => {
  const { homeDir, packageRoot, runtime, sentinels } =
    await createInstallationFixture(t);
  assert.equal((await executeLifecycle({ operation: 'install' }, runtime)).ok, true);
  await writeFile(
    path.join(packageRoot, 'skills', 'project-setup', 'SKILL.md'),
    '---\nname: project-setup\ndescription: Changed bytes under the same version.\n---\n\n# Changed\n',
  );
  const before = await snapshotTree(homeDir);

  const result = await executeLifecycle({ operation: 'update' }, runtime);

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'INTEGRITY_CONFLICT');
  assert.deepEqual(await snapshotTree(homeDir), before);
  await assertSentinelsUnchanged(sentinels);
});

test('running an older package refuses downgrade with zero mutation', async (t) => {
  const { homeDir, packageRoot, runtime, sentinels } =
    await createInstallationFixture(t, { version: '0.2.0' });
  assert.equal((await executeLifecycle({ operation: 'install' }, runtime)).ok, true);
  await writeFile(
    path.join(packageRoot, 'package.json'),
    `${JSON.stringify({ name: runtime.packageName, version: '0.1.0' }, null, 2)}\n`,
  );
  const olderRuntime = { ...runtime, packageVersion: '0.1.0' };
  const before = await snapshotTree(homeDir);

  const result = await executeLifecycle({ operation: 'update' }, olderRuntime);

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'DOWNGRADE_REFUSED');
  assert.deepEqual(await snapshotTree(homeDir), before);
  await assertSentinelsUnchanged(sentinels);
});

test('newer package upgrades canonical payload and managed targets atomically', async (t) => {
  const { disposableRoot, packageRoot, runtime, sentinels } =
    await createInstallationFixture(t);
  const installed = await executeLifecycle({ operation: 'install' }, runtime);
  const repository = path.join(disposableRoot, 'repository-upgrade');
  await mkdir(repository);
  await writeFile(path.join(repository, 'CLAUDE.md'), 'project stays untouched\n', { mode: 0o640 });
  const projectBefore = await snapshotTree(repository);
  await writeFile(
    path.join(packageRoot, 'package.json'),
    `${JSON.stringify({ name: runtime.packageName, version: '0.2.0' }, null, 2)}\n`,
  );
  await writeFile(
    path.join(packageRoot, 'skills', 'project-setup', 'SKILL.md'),
    '---\nname: project-setup\ndescription: Updated project setup workflow.\n---\n\n# Project Setup 0.2\n',
  );
  const nextRuntime = { ...runtime, packageVersion: '0.2.0', cwd: repository };

  const result = await executeLifecycle({ operation: 'update' }, nextRuntime);

  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'updated');
  assert.equal(result.manifest.version, '0.2.0');
  assert.notEqual(result.manifest.canonical.digest, installed.manifest.canonical.digest);
  assert.match(
    await readFile(path.join(result.manifest.canonical.skillPath, 'SKILL.md'), 'utf8'),
    /Project Setup 0\.2/,
  );
  const doctor = await executeLifecycle({ operation: 'doctor' }, nextRuntime);
  assert.equal(doctor.ok, true);
  assert.deepEqual(await snapshotTree(repository), projectBefore);
  await assertSentinelsUnchanged(sentinels);
});

test('in-process update failure restores the previous healthy installation', async (t) => {
  const { homeDir, packageRoot, runtime, sentinels } =
    await createInstallationFixture(t);
  const installed = await executeLifecycle({ operation: 'install' }, runtime);
  const oldSkill = await readFile(
    path.join(installed.manifest.canonical.skillPath, 'SKILL.md'),
    'utf8',
  );
  await writeFile(
    path.join(packageRoot, 'package.json'),
    `${JSON.stringify({ name: runtime.packageName, version: '0.2.0' }, null, 2)}\n`,
  );
  await writeFile(
    path.join(packageRoot, 'skills', 'project-setup', 'SKILL.md'),
    '---\nname: project-setup\ndescription: Payload that will fail during update.\n---\n\n# Failing update\n',
  );
  const failingRuntime = {
    ...runtime,
    packageVersion: '0.2.0',
    afterMutation(name) {
      if (name === 'update:canonical-promoted') {
        const error = new Error('injected update failure');
        error.code = 'EIO';
        throw error;
      }
    },
  };

  const result = await executeLifecycle({ operation: 'update' }, failingRuntime);

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'UNEXPECTED_ERROR');
  const manifest = JSON.parse(
    await readFile(path.join(homeDir, '.agent-project-setup', 'install.json'), 'utf8'),
  );
  assert.equal(manifest.version, '0.1.0');
  assert.equal(
    await readFile(path.join(manifest.canonical.skillPath, 'SKILL.md'), 'utf8'),
    oldSkill,
  );
  assert.equal(
    (
      await executeLifecycle(
        { operation: 'doctor' },
        { ...failingRuntime, afterMutation: undefined },
      )
    ).ok,
    true,
  );
  assert.equal(
    (await readdir(homeDir)).some((name) => name.includes('.operation-')),
    false,
  );
  await assertSentinelsUnchanged(sentinels);
});

test('validated staging failure cleans only operation-owned staging and keeps old install healthy', async (t) => {
  const { homeDir, packageRoot, runtime, sentinels } =
    await createInstallationFixture(t);
  const installed = await executeLifecycle({ operation: 'install' }, runtime);
  const beforeSkill = await readFile(
    path.join(installed.manifest.canonical.skillPath, 'SKILL.md'),
    'utf8',
  );
  await writeFile(
    path.join(packageRoot, 'package.json'),
    `${JSON.stringify({ name: runtime.packageName, version: '0.2.0' }, null, 2)}\n`,
  );
  await writeFile(
    path.join(packageRoot, 'skills', 'project-setup', 'SKILL.md'),
    '---\nname: project-setup\ndescription: Staging failure payload.\n---\n\n# Version 0.2\n',
  );
  let injected = false;
  const failingRuntime = {
    ...runtime,
    packageVersion: '0.2.0',
    afterMutation(name) {
      if (!injected && name === 'update:canonical-staged') {
        injected = true;
        throw new Error('injected validated staging failure');
      }
    },
  };

  const result = await executeLifecycle({ operation: 'update' }, failingRuntime);

  assert.equal(injected, true);
  assert.equal(result.ok, false);
  assert.equal(
    await readFile(path.join(installed.manifest.canonical.skillPath, 'SKILL.md'), 'utf8'),
    beforeSkill,
  );
  assert.equal(
    (await readdir(path.join(homeDir, '.agent-project-setup'))).some((name) =>
      name.startsWith('.staging-'),
    ),
    false,
  );
  const recoveryRuntime = { ...failingRuntime, afterMutation: undefined };
  assert.equal((await executeLifecycle({ operation: 'doctor' }, recoveryRuntime)).ok, true);
  assert.equal(
    (await readdir(homeDir)).some((name) => name.includes('.operation-')),
    false,
  );
  await assertSentinelsUnchanged(sentinels);
});

test('post-commit cleanup failure remains recoverable and reports committed changes', async (t) => {
  const { homeDir, packageRoot, runtime, sentinels } =
    await createInstallationFixture(t);
  const installed = await executeLifecycle({ operation: 'install' }, runtime);
  await writeFile(
    path.join(packageRoot, 'package.json'),
    `${JSON.stringify({ name: runtime.packageName, version: '0.2.0' }, null, 2)}\n`,
  );
  await writeFile(
    path.join(packageRoot, 'skills', 'project-setup', 'SKILL.md'),
    '---\nname: project-setup\ndescription: Post-commit cleanup payload.\n---\n\n# Version 0.2\n',
  );
  let injected = false;
  const failingRuntime = {
    ...runtime,
    packageVersion: '0.2.0',
    afterMutation(name) {
      if (!injected && name === 'update:journal-committed') {
        injected = true;
        throw new Error('injected post-commit cleanup failure');
      }
    },
  };

  const result = await executeLifecycle({ operation: 'update' }, failingRuntime);

  assert.equal(injected, true);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'RECOVERABLE_OPERATION');
  assert.equal(result.error.changed.includes(installed.paths.canonicalRoot), true);
  assert.equal(result.error.changed.includes(installed.paths.manifest), true);
  assert.equal(
    result.error.unresolved.some((entry) =>
      entry.endsWith('.agent-project-setup.operation.lock'),
    ),
    true,
  );
  assert.equal(
    result.error.unresolved.some(
      (entry) => entry.includes('.rollback-') || entry.includes('.install.json.rollback-'),
    ),
    true,
  );

  const recoveryRuntime = { ...failingRuntime, afterMutation: undefined };
  const beforeDoctor = await snapshotTree(homeDir);
  const doctor = await executeLifecycle({ operation: 'doctor' }, recoveryRuntime);
  assert.equal(doctor.ok, false);
  assert.equal(
    doctor.checks.some(
      (check) => check.id === 'lifecycle-control' && check.code === 'RECOVERABLE_OPERATION',
    ),
    true,
  );
  assert.deepEqual(await snapshotTree(homeDir), beforeDoctor);

  const retried = await executeLifecycle({ operation: 'update' }, recoveryRuntime);

  assert.equal(retried.ok, true);
  assert.equal(retried.outcome, 'already-up-to-date');
  assert.equal((await executeLifecycle({ operation: 'doctor' }, recoveryRuntime)).ok, true);
  assert.equal(
    (await readdir(homeDir)).some((name) => name.includes('.operation-')),
    false,
  );
  assert.deepEqual(
    (await readdir(path.join(homeDir, '.agent-project-setup'))).sort(),
    ['current', 'install.json'],
  );
  await assertSentinelsUnchanged(sentinels);
});
