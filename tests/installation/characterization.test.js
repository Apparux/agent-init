import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { executeLifecycle } from '../../src/installation/lifecycle.js';
import {
  assertSentinelsUnchanged,
  createInstallationFixture,
} from './helpers.js';

// The characterization target set. This is the only line that changes when
// the harness registry changes; every assertion below is derived from the
// observed installation so the structural laws stay frozen across the
// registry refactor.
const EXPECTED_TARGET_KEYS = ['codex', 'claude', 'cursor', 'opencode', 'pi', 'grok'];

function unsupportedSymlink() {
  const error = new Error('directory symlinks are not supported by this filesystem');
  error.code = 'ENOTSUP';
  throw error;
}

function relativize(paths, homeDir) {
  return paths.map((value) => value.replace(homeDir, '~'));
}

test('characterization: symlink install emits the canonical hook and array laws', async (t) => {
  const { homeDir, runtime, sentinels } = await createInstallationFixture(t);
  const hooks = [];
  const result = await executeLifecycle(
    { operation: 'install' },
    { ...runtime, afterMutation: (name) => hooks.push(name) },
  );

  // Manifest keys are serialized sorted; execution order comes from the registry.
  assert.deepEqual(Object.keys(result.manifest.targets).sort(), [...EXPECTED_TARGET_KEYS].sort());
  const targetKeys = EXPECTED_TARGET_KEYS;

  const expectedHooks = [
    'install:canonical-staged',
    'install:canonical-published',
    ...targetKeys.map((name) => `install:${name}-published`),
    'install:manifest-published',
  ];
  assert.deepEqual(hooks, expectedHooks);

  assert.deepEqual(relativize(result.changed, homeDir), [
    '~/.agent-init/current',
    ...targetKeys.map((name) => result.manifest.targets[name].path.replace(homeDir, '~')),
    '~/.agent-init/install.json',
  ]);

  const manifest = JSON.parse(await readFile(result.paths.manifest, 'utf8'));
  assert.deepEqual(Object.keys(manifest).sort(), [
    'canonical',
    'installId',
    'installRoot',
    'installedAt',
    'package',
    'schemaVersion',
    'targets',
    'updatedAt',
    'version',
  ]);
  assert.equal(manifest.schemaVersion, 1);
  for (const record of Object.values(manifest.targets)) {
    assert.deepEqual(Object.keys(record).sort(), [
      'digest',
      'entryIdentity',
      'linkText',
      'mode',
      'path',
      'source',
      'targetId',
    ]);
    assert.equal(record.mode, 'symlink');
    assert.equal(record.source, manifest.canonical.skillPath);
    assert.equal(record.digest, null);
  }

  await assertSentinelsUnchanged(sentinels);
});

test('characterization: managed-copy install stages and promotes per target', async (t) => {
  const { homeDir, runtime } = await createInstallationFixture(t);
  const hooks = [];
  const result = await executeLifecycle(
    { operation: 'install' },
    {
      ...runtime,
      createDirectorySymlink: unsupportedSymlink,
      afterMutation: (name) => hooks.push(name),
    },
  );

  // Manifest keys are serialized sorted; execution order comes from the registry.
  assert.deepEqual(Object.keys(result.manifest.targets).sort(), [...EXPECTED_TARGET_KEYS].sort());
  const targetKeys = EXPECTED_TARGET_KEYS;

  const expectedHooks = [
    'install:canonical-staged',
    'install:canonical-published',
    ...targetKeys.flatMap((name) => [
      `install:${name}-copy-staged`,
      `install:${name}-copy-promoted`,
      `install:${name}-published`,
    ]),
    'install:manifest-published',
  ];
  assert.deepEqual(hooks, expectedHooks);

  assert.deepEqual(relativize(result.changed, homeDir), [
    '~/.agent-init/current',
    ...targetKeys.map((name) => result.manifest.targets[name].path.replace(homeDir, '~')),
    '~/.agent-init/install.json',
  ]);
  for (const record of Object.values(result.manifest.targets)) {
    assert.equal(record.mode, 'copy');
    assert.equal(record.entryIdentity, null);
    assert.match(record.digest, /^sha256:[0-9a-f]{64}$/);
  }
});

test('characterization: doctor lists per-target checks after the fixed prefix', async (t) => {
  const { runtime } = await createInstallationFixture(t);
  const installed = await executeLifecycle({ operation: 'install' }, runtime);
  assert.deepEqual(Object.keys(installed.manifest.targets).sort(), [...EXPECTED_TARGET_KEYS].sort());
  const targetKeys = EXPECTED_TARGET_KEYS;

  const doctor = await executeLifecycle({ operation: 'doctor' }, runtime);
  assert.equal(doctor.ok, true);
  assert.deepEqual(doctor.checks.map((check) => check.id), [
    'lifecycle-control',
    'manifest',
    'version',
    'canonical',
    'package-payload',
    ...targetKeys.map((name) => `target-${name}`),
  ]);
});

test('characterization: symlink update touches canonical and manifest only', async (t) => {
  const { homeDir, packageRoot, runtime } = await createInstallationFixture(t);
  await executeLifecycle({ operation: 'install' }, runtime);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(
    path.join(packageRoot, 'package.json'),
    `${JSON.stringify({ name: runtime.packageName, version: '0.2.0' }, null, 2)}\n`,
  );
  await writeFile(
    path.join(packageRoot, 'skills', 'agent-init', 'SKILL.md'),
    '---\nname: agent-init\ndescription: Characterization v2.\n---\n\n# v2\n',
  );

  const hooks = [];
  const result = await executeLifecycle(
    { operation: 'update' },
    { ...runtime, packageVersion: '0.2.0', afterMutation: (name) => hooks.push(name) },
  );

  // Manifest keys are serialized sorted; execution order comes from the registry.
  assert.deepEqual(Object.keys(result.manifest.targets).sort(), [...EXPECTED_TARGET_KEYS].sort());
  const targetKeys = EXPECTED_TARGET_KEYS;
  assert.deepEqual(hooks, [
    'update:canonical-staged',
    'update:canonical-detached',
    'update:canonical-promoted',
    'update:manifest-written',
    'update:journal-committed',
  ]);
  assert.deepEqual(relativize(result.changed, homeDir), [
    '~/.agent-init/current',
    '~/.agent-init/install.json',
  ]);
});

test('characterization: managed-copy update swaps each copy target in order', async (t) => {
  const { homeDir, packageRoot, runtime } = await createInstallationFixture(t);
  await executeLifecycle(
    { operation: 'install' },
    { ...runtime, createDirectorySymlink: unsupportedSymlink },
  );
  const { writeFile } = await import('node:fs/promises');
  await writeFile(
    path.join(packageRoot, 'package.json'),
    `${JSON.stringify({ name: runtime.packageName, version: '0.2.0' }, null, 2)}\n`,
  );
  await writeFile(
    path.join(packageRoot, 'skills', 'agent-init', 'SKILL.md'),
    '---\nname: agent-init\ndescription: Characterization v2.\n---\n\n# v2\n',
  );

  const hooks = [];
  const result = await executeLifecycle(
    { operation: 'update' },
    {
      ...runtime,
      packageVersion: '0.2.0',
      createDirectorySymlink: unsupportedSymlink,
      afterMutation: (name) => hooks.push(name),
    },
  );

  const copyKeys = EXPECTED_TARGET_KEYS;
  assert.deepEqual(
    Object.entries(result.manifest.targets)
      .filter(([, record]) => record.mode === 'copy')
      .map(([name]) => name)
      .sort(),
    [...copyKeys].sort(),
  );
  assert.deepEqual(hooks, [
    'update:canonical-staged',
    'update:canonical-detached',
    'update:canonical-promoted',
    ...copyKeys.flatMap((name) => [
      `update:${name}-detached`,
      `update:${name}-promoted`,
    ]),
    'update:manifest-written',
    'update:journal-committed',
  ]);
  assert.deepEqual(relativize(result.changed, homeDir), [
    '~/.agent-init/current',
    ...copyKeys.map((name) => result.manifest.targets[name].path.replace(homeDir, '~')),
    '~/.agent-init/install.json',
  ]);
});

test('characterization: uninstall processes targets then canonical then root', async (t) => {
  const { homeDir, runtime, sentinels } = await createInstallationFixture(t);
  const installed = await executeLifecycle({ operation: 'install' }, runtime);
  assert.deepEqual(Object.keys(installed.manifest.targets).sort(), [...EXPECTED_TARGET_KEYS].sort());
  const targetKeys = EXPECTED_TARGET_KEYS;

  const hooks = [];
  const result = await executeLifecycle(
    { operation: 'uninstall' },
    { ...runtime, afterMutation: (name) => hooks.push(name) },
  );

  assert.deepEqual(hooks, [
    ...targetKeys.flatMap((name) => [
      `uninstall:${name}-detached`,
      `uninstall:${name}-quarantine-removed`,
      `uninstall:${name}-processed`,
    ]),
    'uninstall:canonical-detached',
    'uninstall:canonical-quarantine-removed',
    'uninstall:canonical-processed',
    'uninstall:manifest-unlinked',
    'uninstall:manifest-removed',
    'uninstall:root-rmdir',
    'uninstall:root-removed',
  ]);
  assert.deepEqual(relativize(result.changed, homeDir), [
    ...targetKeys.map((name) => installed.manifest.targets[name].path.replace(homeDir, '~')),
    '~/.agent-init/current',
    '~/.agent-init/install.json',
    '~/.agent-init',
  ]);
  assert.deepEqual(result.preserved, []);
  await assertSentinelsUnchanged(sentinels);
});
