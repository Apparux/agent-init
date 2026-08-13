import assert from 'node:assert/strict';
import { lstat, readFile, readlink, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { executeLifecycle } from '../../src/installation/lifecycle.js';
import {
  assertSentinelsUnchanged,
  createInstallationFixture,
  PACKAGE_NAME,
  snapshotTree,
} from './helpers.js';

test('fresh install materializes one canonical skill and two managed targets', async (t) => {
  const { homeDir, runtime, sentinels } = await createInstallationFixture(t);

  const result = await executeLifecycle({ operation: 'install' }, runtime);

  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'installed');
  const canonicalSkill = path.join(
    homeDir,
    '.agent-project-setup',
    'current',
    'skills',
    'project-setup',
  );
  assert.match(await readFile(path.join(canonicalSkill, 'SKILL.md'), 'utf8'), /name: project-setup/);

  const manifest = JSON.parse(
    await readFile(path.join(homeDir, '.agent-project-setup', 'install.json'), 'utf8'),
  );
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.package, PACKAGE_NAME);
  assert.equal(manifest.version, '0.1.0');
  assert.equal(manifest.installRoot, path.join(homeDir, '.agent-project-setup'));
  assert.equal(manifest.canonical.skillPath, canonicalSkill);
  assert.match(manifest.canonical.digest, /^sha256:[a-f0-9]{64}$/);
  assert.match(manifest.installId, /^[a-f0-9]{32}$/);

  for (const target of Object.values(manifest.targets)) {
    assert.equal(target.source, canonicalSkill);
    assert.match(target.targetId, /^[a-f0-9]{32}$/);
    assert.equal(target.mode, 'symlink');
    assert.equal((await lstat(target.path)).isSymbolicLink(), true);
    assert.equal(await realpath(target.path), await realpath(canonicalSkill));
    assert.equal(path.resolve(path.dirname(target.path), await readlink(target.path)), canonicalSkill);
  }

  await assertSentinelsUnchanged(sentinels);
});

test('repeat install of a healthy same-version payload is a zero-churn no-op', async (t) => {
  const { homeDir, runtime, sentinels } = await createInstallationFixture(t);
  assert.equal((await executeLifecycle({ operation: 'install' }, runtime)).ok, true);
  const before = await snapshotTree(homeDir);

  const result = await executeLifecycle({ operation: 'install' }, runtime);

  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'already-installed');
  assert.deepEqual(await snapshotTree(homeDir), before);
  await assertSentinelsUnchanged(sentinels);
});

test('repeat install repairs only a missing owned target', async (t) => {
  const { homeDir, runtime, sentinels } = await createInstallationFixture(t);
  const installed = await executeLifecycle({ operation: 'install' }, runtime);
  const codexPath = installed.manifest.targets.codex.path;
  const claudePath = installed.manifest.targets.claude.path;
  const canonicalPath = installed.manifest.canonical.root;
  const claudeBefore = await lstat(claudePath);
  const canonicalBefore = await lstat(canonicalPath);
  await unlink(codexPath);

  const result = await executeLifecycle({ operation: 'install' }, runtime);

  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'repaired');
  assert.deepEqual(result.changed, [codexPath, installed.paths.manifest]);
  assert.equal((await lstat(claudePath)).ino, claudeBefore.ino);
  assert.equal((await lstat(canonicalPath)).ino, canonicalBefore.ino);
  assert.equal(
    await realpath(codexPath),
    await realpath(installed.manifest.canonical.skillPath),
  );
  const manifest = JSON.parse(
    await readFile(path.join(homeDir, '.agent-project-setup', 'install.json'), 'utf8'),
  );
  assert.notEqual(manifest.targets.codex.entryIdentity, installed.manifest.targets.codex.entryIdentity);
  assert.equal(manifest.targets.claude.entryIdentity, installed.manifest.targets.claude.entryIdentity);
  await assertSentinelsUnchanged(sentinels);
});
