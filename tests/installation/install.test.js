import assert from 'node:assert/strict';
import {
  lstat,
  mkdir,
  readFile,
  readlink,
  readdir,
  realpath,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
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
    '.agent-init',
    'current',
    'skills',
    'project-setup',
  );
  assert.match(await readFile(path.join(canonicalSkill, 'SKILL.md'), 'utf8'), /name: project-setup/);

  const manifest = JSON.parse(
    await readFile(path.join(homeDir, '.agent-init', 'install.json'), 'utf8'),
  );
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.package, PACKAGE_NAME);
  assert.equal(manifest.version, '0.1.0');
  assert.equal(manifest.installRoot, path.join(homeDir, '.agent-init'));
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

test('absolute junction-style link text is accepted when it resolves to the canonical skill', async (t) => {
  const { runtime, sentinels } = await createInstallationFixture(t);
  runtime.createDirectorySymlink = async (_linkText, targetPath, type) => {
    await symlink(
      path.join(
        runtime.homeDir,
        '.agent-init',
        'current',
        'skills',
        'project-setup',
      ),
      targetPath,
      type,
    );
  };

  const installed = await executeLifecycle({ operation: 'install' }, runtime);

  assert.equal(installed.ok, true);
  assert.equal(installed.outcome, 'installed');
  for (const target of Object.values(installed.manifest.targets)) {
    assert.equal(target.mode, 'symlink');
    assert.equal(
      path.resolve(path.dirname(target.path), await readlink(target.path)),
      installed.manifest.canonical.skillPath,
    );
  }
  assert.equal((await executeLifecycle({ operation: 'doctor' }, runtime)).ok, true);
  await assertSentinelsUnchanged(sentinels);
});

test('rejects a lexically canonical link that physically resolves to a foreign tree', async (t) => {
  const { disposableRoot, runtime, sentinels } = await createInstallationFixture(t);
  const foreignRoot = path.join(disposableRoot, 'foreign');
  const foreignMount = path.join(foreignRoot, 'mounted');
  const foreignSkill = path.join(
    foreignRoot,
    '.agent-init',
    'current',
    'skills',
    'project-setup',
  );
  await mkdir(foreignMount, { recursive: true });
  await mkdir(foreignSkill, { recursive: true });
  const foreignSentinel = path.join(foreignSkill, 'foreign.txt');
  await writeFile(foreignSentinel, 'must survive\n');

  const alias = path.join(runtime.homeDir, 'link-alias-parent');
  await symlink(foreignMount, alias, 'dir');
  const deceptiveLinkText = [
    '..',
    '..',
    'link-alias-parent',
    '..',
    '.agent-init',
    'current',
    'skills',
    'project-setup',
  ].join(path.sep);
  runtime.createDirectorySymlink = async (_linkText, targetPath, type) => {
    await symlink(deceptiveLinkText, targetPath, type);
  };

  const result = await executeLifecycle({ operation: 'install' }, runtime);

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'OWNERSHIP_MISMATCH');
  assert.deepEqual(result.error.unresolved, []);
  await assert.rejects(
    () => lstat(path.join(runtime.homeDir, '.agents', 'skills', 'project-setup')),
    { code: 'ENOENT' },
  );
  assert.equal(await readFile(foreignSentinel, 'utf8'), 'must survive\n');
  await assertSentinelsUnchanged(sentinels);
});

test('rejects a mutable alias even when it currently resolves to the canonical skill', async (t) => {
  const { runtime, sentinels } = await createInstallationFixture(t);
  const canonicalSkill = path.join(
    runtime.homeDir,
    '.agent-init',
    'current',
    'skills',
    'project-setup',
  );
  const aliasPath = path.join(runtime.homeDir, 'mutable-canonical-alias');
  let aliasCreated = false;
  runtime.createDirectorySymlink = async (_linkText, targetPath, type) => {
    if (!aliasCreated) {
      await symlink(canonicalSkill, aliasPath, type);
      aliasCreated = true;
    }
    await symlink(aliasPath, targetPath, type);
  };

  const result = await executeLifecycle({ operation: 'install' }, runtime);

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'OWNERSHIP_MISMATCH');
  await assert.rejects(
    () => lstat(path.join(runtime.homeDir, '.agents', 'skills', 'project-setup')),
    { code: 'ENOENT' },
  );
  assert.equal((await lstat(aliasPath)).isSymbolicLink(), true);
  assert.equal(await readlink(aliasPath), canonicalSkill);
  await assertSentinelsUnchanged(sentinels);
});

test('retains recovery evidence when a published target identity cannot be proven', async (t) => {
  const { homeDir, runtime, sentinels } = await createInstallationFixture(t);
  const targetPath = path.join(homeDir, '.agents', 'skills', 'project-setup');
  runtime.createDirectorySymlink = async (_linkText, targetPath) => {
    await writeFile(targetPath, 'foreign target\n');
  };

  const result = await executeLifecycle({ operation: 'install' }, runtime);

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'ROLLBACK_FAILED');
  assert.deepEqual(result.error.unresolved, [targetPath]);
  assert.equal(await readFile(targetPath, 'utf8'), 'foreign target\n');
  assert.equal(
    (await readdir(homeDir)).some((name) => name.includes('.operation-') && name.endsWith('.owner.json')),
    true,
  );
  await assertSentinelsUnchanged(sentinels);
});

test('schema-1 manifests without linkText remain readable and safely removable', async (t) => {
  const { homeDir, runtime, sentinels } = await createInstallationFixture(t);
  const installed = await executeLifecycle({ operation: 'install' }, runtime);
  assert.equal(installed.ok, true);

  const manifestPath = path.join(homeDir, '.agent-init', 'install.json');
  const legacyManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  for (const target of Object.values(legacyManifest.targets)) delete target.linkText;
  await writeFile(manifestPath, `${JSON.stringify(legacyManifest, null, 2)}\n`);

  const doctor = await executeLifecycle({ operation: 'doctor' }, runtime);
  assert.equal(doctor.ok, true);
  const uninstalled = await executeLifecycle({ operation: 'uninstall' }, runtime);
  assert.equal(uninstalled.ok, true);
  assert.equal(uninstalled.outcome, 'uninstalled');
  assert.deepEqual(uninstalled.preserved, []);
  assert.deepEqual(uninstalled.unresolved, []);
  await assert.rejects(
    () => lstat(path.join(homeDir, '.agent-init')),
    { code: 'ENOENT' },
  );
  for (const name of ['codex', 'claude']) {
    await assert.rejects(
      () => lstat(path.join(homeDir, name === 'codex' ? '.agents' : '.claude', 'skills', 'project-setup')),
      { code: 'ENOENT' },
    );
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
    await readFile(path.join(homeDir, '.agent-init', 'install.json'), 'utf8'),
  );
  assert.notEqual(manifest.targets.codex.entryIdentity, installed.manifest.targets.codex.entryIdentity);
  assert.equal(manifest.targets.claude.entryIdentity, installed.manifest.targets.claude.entryIdentity);
  await assertSentinelsUnchanged(sentinels);
});
