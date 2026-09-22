import assert from 'node:assert/strict';
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { executeLifecycle } from '../../src/installation/lifecycle.js';
import { HARNESS_REGISTRY } from '../../src/installation/harnesses.js';
import {
  assertSentinelsUnchanged,
  createInstallationFixture,
  snapshotTree,
} from './helpers.js';

async function exists(entryPath) {
  try {
    await lstat(entryPath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

// Builds a HOME holding a legacy-style manifest: only codex+claude claimed,
// only codex+claude targets materialized, at the given version. This is the
// shape an 0.1.x installation had before the registry refactor.
async function createLegacyInstallationFixture(t, options = {}) {
  const fixture = await createInstallationFixture(t, { version: options.version ?? '0.1.0' });
  const { homeDir, runtime } = fixture;

  // Simulate the legacy installation: install, then strip the manifest back
  // to the two legacy targets and delete the four newer targets from disk.
  const installed = await executeLifecycle({ operation: 'install' }, runtime);
  assert.equal(installed.ok, true);

  const legacyKeys = ['codex', 'claude'];
  const manifest = JSON.parse(await readFile(installed.paths.manifest, 'utf8'));
  const legacyTargets = {};
  for (const name of legacyKeys) legacyTargets[name] = manifest.targets[name];
  manifest.targets = legacyTargets;
  manifest.updatedAt = manifest.installedAt;
  await writeFile(installed.paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`);

  for (const entry of HARNESS_REGISTRY) {
    if (legacyKeys.includes(entry.key)) continue;
    await rm(path.join(homeDir, ...entry.skillsDir.split('/'), 'agent-init'), {
      recursive: true,
      force: true,
    });
  }
  return { ...fixture, installed, manifest, legacyKeys };
}

test('same-version update reconciles registry targets missing from a legacy manifest', async (t) => {
  const { homeDir, runtime, manifest, sentinels } = await createLegacyInstallationFixture(t);
  assert.equal(manifest.version, runtime.packageVersion);
  const hooks = [];
  const observedRuntime = { ...runtime, afterMutation: (name) => hooks.push(name) };

  const result = await executeLifecycle({ operation: 'update' }, observedRuntime);

  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'updated');
  for (const entry of HARNESS_REGISTRY) {
    assert.equal(
      await exists(result.manifest.targets[entry.key].path),
      true,
      `reconciled target must exist: ${entry.key}`,
    );
    assert.equal(
      await exists(path.join(homeDir, ...entry.skillsDir.split('/'), 'agent-init')),
      true,
    );
  }
  assert.deepEqual(
    Object.keys(result.manifest.targets).sort(),
    HARNESS_REGISTRY.map((entry) => entry.key).sort(),
  );
  // Reconcile runs at the installed version; payload bytes do not change.
  assert.equal(result.manifest.version, manifest.version);
  assert.ok(hooks.includes('reconcile:journal-committed'));
  const doctor = await executeLifecycle({ operation: 'doctor' }, observedRuntime);
  assert.equal(doctor.ok, true);
  await assertSentinelsUnchanged(sentinels);
});

test('cross-version update reconciles legacy manifests at the installed version, then upgrades', async (t) => {
  const { homeDir, packageRoot, runtime, sentinels } =
    await createLegacyInstallationFixture(t);
  await writeFile(
    path.join(packageRoot, 'package.json'),
    `${JSON.stringify({ name: runtime.packageName, version: '0.2.0' }, null, 2)}\n`,
  );
  await writeFile(
    path.join(packageRoot, 'skills', 'agent-init', 'SKILL.md'),
    '---\nname: agent-init\ndescription: Legacy upgrade workflow.\n---\n\n# v2\n',
  );
  const nextRuntime = { ...runtime, packageVersion: '0.2.0' };

  const result = await executeLifecycle({ operation: 'update' }, nextRuntime);

  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'updated');
  assert.equal(result.manifest.version, '0.2.0');
  // Every registry target was reconciled and upgraded to the new payload.
  for (const entry of HARNESS_REGISTRY) {
    const record = result.manifest.targets[entry.key];
    assert.equal(await exists(record.path), true);
    assert.match(
      await readFile(path.join(record.path, 'SKILL.md'), 'utf8'),
      /v2/,
    );
  }
  const doctor = await executeLifecycle({ operation: 'doctor' }, nextRuntime);
  assert.equal(doctor.ok, true);
  await assertSentinelsUnchanged(sentinels);
});

test('uninstall removes targets whose harness config has been removed (orphans)', async (t) => {
  const { disposableRoot, homeDir, runtime, sentinels } = await createInstallationFixture(t);
  // Custom harness with its own directory, installed, then de-configured.
  const configDir = path.join(homeDir, '.config', 'agent-init');
  await mkdir(configDir, { recursive: true });
  await writeFile(
    path.join(configDir, 'harnesses.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      harnesses: [
        { id: 'myagent', label: 'My Agent', skillsDir: '.myagent/skills', invocation: '$myagent' },
      ],
    }, null, 2)}\n`,
  );
  const installed = await executeLifecycle({ operation: 'install' }, runtime);
  assert.equal(installed.ok, true);
  assert.notEqual(installed.manifest.targets.myagent, undefined);
  const orphanPath = installed.manifest.targets.myagent.path;
  assert.equal(await exists(orphanPath), true);

  // Remove the config: the manifest record becomes an unregistered orphan.
  await rm(path.join(configDir, 'harnesses.json'));

  const doctor = await executeLifecycle({ operation: 'doctor' }, runtime);
  assert.equal(doctor.ok, true, 'orphan is owned-valid, so doctor stays healthy');
  assert.equal(
    doctor.checks.some(
      (check) => check.code === 'UNREGISTERED_TARGET' && check.status === 'warning',
    ),
    true,
  );

  const h = await executeLifecycle({ operation: 'harnesses' }, runtime);
  assert.equal(h.ok, true);
  const orphanRow = h.harnesses.find((row) => row.key === 'myagent');
  assert.notEqual(orphanRow, undefined);
  assert.equal(orphanRow.installed, true, 'orphan row must report live state, not missing');
  assert.equal(orphanRow.verification, 'unregistered');

  const uninstalled = await executeLifecycle({ operation: 'uninstall' }, runtime);
  assert.equal(uninstalled.ok, true);
  assert.equal(await exists(orphanPath), false, 'orphan target must be removed');
  assert.equal(uninstalled.removed.includes(orphanPath), true);
  // The uninstall wiped the whole installation, so no manifest remains.
  assert.equal(await exists(installed.paths.manifest), false);
  await assertSentinelsUnchanged(sentinels);
});

test('doctor reports unclaimed registry targets as TARGET_MISSING warnings', async (t) => {
  const { runtime } = await createLegacyInstallationFixture(t);

  const doctor = await executeLifecycle({ operation: 'doctor' }, runtime);

  assert.equal(doctor.ok, true, 'unclaimed-missing registry keys are warnings, not errors');
  for (const entry of HARNESS_REGISTRY) {
    if (entry.key === 'codex' || entry.key === 'claude') continue;
    const check = doctor.checks.find((item) => item.id === `target-${entry.key}`);
    assert.notEqual(check, undefined);
    assert.equal(check.code, 'TARGET_MISSING');
    assert.equal(check.status, 'warning');
  }
  const update = await executeLifecycle({ operation: 'update' }, runtime);
  assert.equal(update.ok, true);
});

test('validateManifest rejects unregistered target records pointing outside HOME', async (t) => {
  const { installed, runtime } = await createLegacyInstallationFixture(t);
  const manifest = JSON.parse(await readFile(installed.paths.manifest, 'utf8'));
  manifest.targets.evil = {
    ...manifest.targets.codex,
    path: path.join(path.dirname(runtime.homeDir), 'elsewhere', 'agent-init'),
  };
  await writeFile(installed.paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`);

  const doctor = await executeLifecycle({ operation: 'doctor' }, runtime);

  assert.equal(doctor.ok, false);
  assert.equal(
    doctor.checks.some((check) => check.code === 'CORRUPT_MANIFEST'),
    true,
  );
});

test('reconcile failure before manifest swap rolls back created targets', async (t) => {
  const { runtime } = await createLegacyInstallationFixture(t);
  const failingRuntime = {
    ...runtime,
    afterMutation(name) {
      if (name === 'reconcile:opencode-published') {
        const error = new Error('injected reconcile failure');
        error.code = 'EIO';
        throw error;
      }
    },
  };

  const result = await executeLifecycle({ operation: 'update' }, failingRuntime);

  assert.equal(result.ok, false);
  // The registry order places opencode after cursor: cursor may have been
  // created before the injected failure; it must be rolled back.
  for (const key of ['cursor', 'opencode', 'pi', 'grok']) {
    const entry = HARNESS_REGISTRY.find((item) => item.key === key);
    assert.equal(
      await exists(path.join(runtime.homeDir, ...entry.skillsDir.split('/'), 'agent-init')),
      false,
      `rolled-back target must not remain: ${key}`,
    );
  }
  const healthy = await executeLifecycle(
    { operation: 'update' },
    { ...failingRuntime, afterMutation: undefined },
  );
  assert.equal(healthy.ok, true);
});

test('legacy two-target manifest stays valid for install idempotence', async (t) => {
  const { runtime } = await createLegacyInstallationFixture(t);
  const install = await executeLifecycle({ operation: 'install' }, runtime);
  assert.equal(install.ok, true);
  assert.equal(install.outcome, 'already-installed');
});
