import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cp, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { executeLifecycle } from '../../src/installation/lifecycle.js';
import {
  assertSentinelsUnchanged,
  createInstallationFixture,
  snapshotTree,
} from './helpers.js';

const lifecycleUrl = pathToFileURL(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../src/installation/lifecycle.js',
  ),
).href;

function unsupportedSymlink() {
  const error = new Error('directory symlinks are not supported by this filesystem');
  error.code = 'ENOTSUP';
  throw error;
}

function crashLifecycle(runtime, operation, mutationPoint, options = {}) {
  const childSource = `
    import { executeLifecycle } from ${JSON.stringify(lifecycleUrl)};
    const runtime = ${JSON.stringify({
      homeDir: runtime.homeDir,
      packageRoot: runtime.packageRoot,
      packageName: runtime.packageName,
      packageVersion: runtime.packageVersion,
      platform: runtime.platform,
    })};
    runtime.now = () => new Date('2026-01-02T03:04:05.000Z');
    if (${JSON.stringify(options.managedCopies ?? false)}) {
      runtime.createDirectorySymlink = () => {
        const error = new Error('directory symlinks are not supported');
        error.code = 'ENOTSUP';
        throw error;
      };
    }
    runtime.afterMutation = (name) => {
      if (name === ${JSON.stringify(mutationPoint)}) process.exit(77);
    };
    runtime.afterJournalSnapshot = (journal) => {
      if (${JSON.stringify(options.journalPhase ?? null)} === journal.phase) process.exit(79);
    };
    const result = await executeLifecycle({ operation: ${JSON.stringify(operation)} }, runtime);
    process.stderr.write(JSON.stringify(result));
    process.exit(result.ok ? 0 : 1);
  `;
  return spawnSync(process.execPath, ['--input-type=module', '-e', childSource], {
    encoding: 'utf8',
  });
}

function crashUpdate(runtime, mutationPoint, options = {}) {
  return crashLifecycle(runtime, 'update', mutationPoint, options);
}

async function prepareUpgradeFixture(t, options = {}) {
  const fixture = await createInstallationFixture(t);
  if (options.managedCopies) {
    fixture.runtime.createDirectorySymlink = unsupportedSymlink;
  }
  assert.equal(
    (await executeLifecycle({ operation: 'install' }, fixture.runtime)).ok,
    true,
  );
  await writeFile(
    path.join(fixture.packageRoot, 'package.json'),
    `${JSON.stringify({ name: fixture.runtime.packageName, version: '0.2.0' }, null, 2)}\n`,
  );
  await writeFile(
    path.join(fixture.packageRoot, 'skills', 'agent-init', 'SKILL.md'),
    '---\nname: agent-init\ndescription: Crash recovery payload.\n---\n\n# Version 0.2\n',
  );
  return { ...fixture, nextRuntime: { ...fixture.runtime, packageVersion: '0.2.0' } };
}

for (const mutationPoint of [
  'install:canonical-published',
  'install:codex-published',
  'install:manifest-published',
]) {
  test(`retry rolls back a fresh install interrupted at ${mutationPoint}`, async (t) => {
    const { runtime, sentinels } = await createInstallationFixture(t);
    const child = crashLifecycle(runtime, 'install', mutationPoint);

    assert.equal(child.status, 77, child.stderr);
    const interrupted = await executeLifecycle({ operation: 'doctor' }, runtime);
    assert.equal(interrupted.ok, false);
    assert.equal(
      interrupted.checks.some((check) => check.code === 'RECOVERABLE_OPERATION'),
      true,
    );

    const retried = await executeLifecycle({ operation: 'install' }, runtime);

    assert.equal(retried.ok, true);
    assert.equal(retried.outcome, 'installed');
    assert.equal((await executeLifecycle({ operation: 'doctor' }, runtime)).ok, true);
    await assertSentinelsUnchanged(sentinels);
  });
}

test('fresh-install recovery accepts a legacy link completion without linkText', async (t) => {
  const { homeDir, runtime, sentinels } = await createInstallationFixture(t);
  const child = crashLifecycle(runtime, 'install', 'install:codex-published');
  assert.equal(child.status, 77, child.stderr);

  const journalNames = (await readdir(homeDir))
    .filter((name) => name.includes('.journal-') && name.endsWith('.json'))
    .sort();
  const latestJournalPath = path.join(homeDir, journalNames.at(-1));
  const journal = JSON.parse(await readFile(latestJournalPath, 'utf8'));
  const completion = journal.completed.find(
    (record) => record.action === 'create-target-link' && record.name === 'codex',
  );
  assert.ok(completion);
  delete completion.linkText;
  await writeFile(latestJournalPath, `${JSON.stringify(journal, null, 2)}\n`);

  const retried = await executeLifecycle({ operation: 'install' }, runtime);

  assert.equal(retried.ok, true);
  assert.equal(retried.outcome, 'installed');
  assert.equal((await executeLifecycle({ operation: 'doctor' }, runtime)).ok, true);
  await assertSentinelsUnchanged(sentinels);
});

test('fresh-install recovery accepts legacy link completion after manifest publication', async (t) => {
  const { homeDir, runtime, sentinels } = await createInstallationFixture(t);
  const child = crashLifecycle(runtime, 'install', 'install:manifest-published');
  assert.equal(child.status, 77, child.stderr);

  const journalNames = (await readdir(homeDir))
    .filter((name) => name.includes('.journal-') && name.endsWith('.json'))
    .sort();
  const latestJournalPath = path.join(homeDir, journalNames.at(-1));
  const journal = JSON.parse(await readFile(latestJournalPath, 'utf8'));
  for (const completion of journal.completed) {
    if (completion.action === 'create-target-link') delete completion.linkText;
  }
  await writeFile(latestJournalPath, `${JSON.stringify(journal, null, 2)}\n`);

  const retried = await executeLifecycle({ operation: 'install' }, runtime);

  assert.equal(retried.ok, true);
  assert.equal(retried.outcome, 'installed');
  assert.equal((await executeLifecycle({ operation: 'doctor' }, runtime)).ok, true);
  await assertSentinelsUnchanged(sentinels);
});

test('retry removes validated canonical staging after a fresh-install crash', async (t) => {
  const { runtime, sentinels } = await createInstallationFixture(t);
  const child = crashLifecycle(runtime, 'install', 'install:canonical-staged');

  assert.equal(child.status, 77, child.stderr);
  const retried = await executeLifecycle({ operation: 'install' }, runtime);

  assert.equal(retried.ok, true);
  assert.equal(retried.outcome, 'installed');
  await assertSentinelsUnchanged(sentinels);
});

test('retry removes validated managed-copy staging after a fresh-install crash', async (t) => {
  const { runtime, sentinels } = await createInstallationFixture(t);
  runtime.createDirectorySymlink = unsupportedSymlink;
  const child = crashLifecycle(runtime, 'install', 'install:codex-copy-staged', {
    managedCopies: true,
  });

  assert.equal(child.status, 77, child.stderr);
  const retried = await executeLifecycle({ operation: 'install' }, runtime);

  assert.equal(retried.ok, true);
  assert.equal(retried.outcome, 'installed');
  await assertSentinelsUnchanged(sentinels);
});

test('retry rolls back an interrupted fresh install using managed-copy fallback', async (t) => {
  const { runtime, sentinels } = await createInstallationFixture(t);
  runtime.createDirectorySymlink = unsupportedSymlink;
  const child = crashLifecycle(runtime, 'install', 'install:codex-published', {
    managedCopies: true,
  });

  assert.equal(child.status, 77, child.stderr);
  const retried = await executeLifecycle({ operation: 'install' }, runtime);

  assert.equal(retried.ok, true);
  assert.equal(retried.outcome, 'installed');
  assert.equal((await executeLifecycle({ operation: 'doctor' }, runtime)).ok, true);
  await assertSentinelsUnchanged(sentinels);
});

test('retry completes a fresh install interrupted after its commit point', async (t) => {
  const { runtime, sentinels } = await createInstallationFixture(t);
  const child = crashLifecycle(runtime, 'install', 'unused', {
    journalPhase: 'committed',
  });

  assert.equal(child.status, 79, child.stderr);
  const interrupted = await executeLifecycle({ operation: 'doctor' }, runtime);
  assert.equal(interrupted.ok, false);
  assert.equal(
    interrupted.checks.some((check) => check.code === 'RECOVERABLE_OPERATION'),
    true,
  );

  const retried = await executeLifecycle({ operation: 'install' }, runtime);

  assert.equal(retried.ok, true);
  assert.equal(retried.outcome, 'already-installed');
  assert.equal((await executeLifecycle({ operation: 'doctor' }, runtime)).ok, true);
  await assertSentinelsUnchanged(sentinels);
});

for (const mutationPoint of [
  'uninstall:codex-detached',
  'uninstall:codex-quarantine-removed',
  'uninstall:codex-processed',
  'uninstall:canonical-detached',
  'uninstall:canonical-quarantine-removed',
  'uninstall:canonical-processed',
  'uninstall:manifest-unlinked',
  'uninstall:manifest-removed',
  'uninstall:root-rmdir',
  'uninstall:root-removed',
]) {
  test(`retry completes uninstall interrupted at ${mutationPoint}`, async (t) => {
    const { runtime, sentinels } = await createInstallationFixture(t);
    assert.equal((await executeLifecycle({ operation: 'install' }, runtime)).ok, true);
    const child = crashLifecycle(runtime, 'uninstall', mutationPoint);

    assert.equal(child.status, 77, child.stderr);
    const interrupted = await executeLifecycle({ operation: 'doctor' }, runtime);
    assert.equal(interrupted.ok, false);
    assert.equal(
      interrupted.checks.some((check) => check.code === 'RECOVERABLE_OPERATION'),
      true,
    );

    const retried = await executeLifecycle({ operation: 'uninstall' }, runtime);

    assert.equal(retried.ok, true);
    assert.equal(retried.outcome, 'already-uninstalled');
    await assertSentinelsUnchanged(sentinels);
  });
}

test('in-process uninstall failure after detach retains recoverable control evidence', async (t) => {
  const { runtime, sentinels } = await createInstallationFixture(t);
  assert.equal((await executeLifecycle({ operation: 'install' }, runtime)).ok, true);
  let injected = false;
  const failingRuntime = {
    ...runtime,
    afterMutation(name) {
      if (!injected && name === 'uninstall:codex-detached') {
        injected = true;
        throw new Error('injected uninstall detach failure');
      }
    },
  };

  const failed = await executeLifecycle({ operation: 'uninstall' }, failingRuntime);

  assert.equal(injected, true);
  assert.equal(failed.ok, false);
  const recoveryRuntime = { ...failingRuntime, afterMutation: undefined };
  const doctor = await executeLifecycle({ operation: 'doctor' }, recoveryRuntime);
  assert.equal(doctor.ok, false);
  assert.equal(
    doctor.checks.some((check) => check.code === 'RECOVERABLE_OPERATION'),
    true,
  );
  const retried = await executeLifecycle({ operation: 'uninstall' }, recoveryRuntime);
  assert.equal(retried.ok, true);
  assert.equal(retried.outcome, 'already-uninstalled');
  await assertSentinelsUnchanged(sentinels);
});

test('uninstall recovery preserves a target replaced after interruption', async (t) => {
  const { runtime, sentinels } = await createInstallationFixture(t);
  const installed = await executeLifecycle({ operation: 'install' }, runtime);
  assert.equal(installed.ok, true);
  const child = crashLifecycle(runtime, 'uninstall', 'uninstall:codex-processed');
  assert.equal(child.status, 77, child.stderr);

  const claudePath = installed.manifest.targets.claude.path;
  await unlink(claudePath);
  await writeFile(claudePath, 'user replacement after crash\n', { mode: 0o600 });

  const retried = await executeLifecycle({ operation: 'uninstall' }, runtime);

  assert.equal(retried.ok, true);
  assert.equal(retried.outcome, 'already-uninstalled');
  assert.equal(await readFile(claudePath, 'utf8'), 'user replacement after crash\n');
  await assertSentinelsUnchanged(sentinels);
});

test('uninstall recovery validates managed-copy fallback ownership', async (t) => {
  const { runtime, sentinels } = await createInstallationFixture(t);
  runtime.createDirectorySymlink = unsupportedSymlink;
  assert.equal((await executeLifecycle({ operation: 'install' }, runtime)).ok, true);
  const child = crashLifecycle(runtime, 'uninstall', 'uninstall:codex-processed', {
    managedCopies: true,
  });

  assert.equal(child.status, 77, child.stderr);
  const retried = await executeLifecycle({ operation: 'uninstall' }, runtime);

  assert.equal(retried.ok, true);
  assert.equal(retried.outcome, 'already-uninstalled');
  await assertSentinelsUnchanged(sentinels);
});

test('retry completes uninstall interrupted after its commit point', async (t) => {
  const { runtime, sentinels } = await createInstallationFixture(t);
  assert.equal((await executeLifecycle({ operation: 'install' }, runtime)).ok, true);
  const child = crashLifecycle(runtime, 'uninstall', 'unused', {
    journalPhase: 'committed',
  });

  assert.equal(child.status, 79, child.stderr);
  const retried = await executeLifecycle({ operation: 'uninstall' }, runtime);

  assert.equal(retried.ok, true);
  assert.equal(retried.outcome, 'already-uninstalled');
  await assertSentinelsUnchanged(sentinels);
});

test('journal snapshot hard crash remains recoverable before any asset mutation', async (t) => {
  const { nextRuntime, sentinels } = await prepareUpgradeFixture(t);

  const child = crashUpdate(nextRuntime, 'unused', {
    journalPhase: 'swap-canonical-update',
  });

  assert.equal(child.status, 79, child.stderr);
  const interrupted = await executeLifecycle({ operation: 'doctor' }, nextRuntime);
  assert.equal(interrupted.ok, false);
  assert.equal(
    interrupted.checks.some((check) => check.code === 'RECOVERABLE_OPERATION'),
    true,
  );
  const retried = await executeLifecycle({ operation: 'update' }, nextRuntime);
  assert.equal(retried.ok, true);
  assert.equal(retried.outcome, 'updated');
  assert.equal((await executeLifecycle({ operation: 'doctor' }, nextRuntime)).ok, true);
  await assertSentinelsUnchanged(sentinels);
});

test('retry recovers an uncommitted update after hard process termination', async (t) => {
  const { homeDir, nextRuntime, sentinels } = await prepareUpgradeFixture(t);

  const child = crashUpdate(nextRuntime, 'update:canonical-promoted');

  assert.equal(child.status, 77, child.stderr);
  const beforeDoctor = await snapshotTree(homeDir);
  const interrupted = await executeLifecycle({ operation: 'doctor' }, nextRuntime);
  assert.equal(interrupted.ok, false);
  assert.equal(
    interrupted.checks.some(
      (check) => check.code === 'RECOVERABLE_OPERATION',
    ),
    true,
  );
  assert.deepEqual(await snapshotTree(homeDir), beforeDoctor);

  const retried = await executeLifecycle({ operation: 'update' }, nextRuntime);

  assert.equal(retried.ok, true);
  assert.equal(retried.outcome, 'updated');
  assert.equal((await executeLifecycle({ operation: 'doctor' }, nextRuntime)).ok, true);
  await assertSentinelsUnchanged(sentinels);
});

test('retry completes cleanup after a hard crash past the manifest commit', async (t) => {
  const { homeDir, nextRuntime, sentinels } = await prepareUpgradeFixture(t);

  const child = crashUpdate(nextRuntime, 'update:journal-committed');

  assert.equal(child.status, 77, child.stderr);
  const beforeDoctor = await snapshotTree(homeDir);
  const interrupted = await executeLifecycle({ operation: 'doctor' }, nextRuntime);
  assert.equal(interrupted.ok, false);
  assert.equal(
    interrupted.checks.some((check) => check.code === 'RECOVERABLE_OPERATION'),
    true,
  );
  assert.deepEqual(await snapshotTree(homeDir), beforeDoctor);

  const retried = await executeLifecycle({ operation: 'update' }, nextRuntime);

  assert.equal(retried.ok, true);
  assert.equal(retried.outcome, 'already-up-to-date');
  assert.equal((await executeLifecycle({ operation: 'doctor' }, nextRuntime)).ok, true);
  await assertSentinelsUnchanged(sentinels);
});

test('committed recovery rejects a managed-copy rollback path outside HOME', async (t) => {
  const { disposableRoot, homeDir, nextRuntime, sentinels } =
    await prepareUpgradeFixture(t, { managedCopies: true });
  const child = crashUpdate(nextRuntime, 'update:journal-committed');
  assert.equal(child.status, 77, child.stderr);

  const journalNames = (await readdir(homeDir))
    .filter((name) => name.includes('.journal-') && name.endsWith('.json'))
    .sort();
  const latestJournalPath = path.join(homeDir, journalNames.at(-1));
  const journal = JSON.parse(await readFile(latestJournalPath, 'utf8'));
  const codexIntent = [...journal.intents]
    .reverse()
    .find((intent) => intent.action === 'swap-target-update' && intent.name === 'codex');
  assert.ok(codexIntent);

  const outsideRollback = path.join(disposableRoot, 'outside-managed-copy');
  await cp(codexIntent.rollback, outsideRollback, { recursive: true });
  const outsideSkillPath = path.join(outsideRollback, 'SKILL.md');
  const outsideSkill = await readFile(outsideSkillPath, 'utf8');
  codexIntent.rollback = outsideRollback;
  await writeFile(latestJournalPath, `${JSON.stringify(journal, null, 2)}\n`);

  const retried = await executeLifecycle({ operation: 'update' }, nextRuntime);

  assert.equal(retried.ok, false);
  assert.equal(retried.error.code, 'AMBIGUOUS_OPERATION');
  assert.equal(await readFile(outsideSkillPath, 'utf8'), outsideSkill);
  await assertSentinelsUnchanged(sentinels);
});
