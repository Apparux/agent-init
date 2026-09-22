import assert from 'node:assert/strict';
import { lstat, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { renderFailure } from '../../src/cli/output.js';
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

async function createProjectSentinel(repository) {
  for (const relativePath of [
    'AGENTS.md',
    'CLAUDE.md',
    '.agents/skills/local/SKILL.md',
    '.claude/settings.json',
    'docs/agents/architecture.md',
  ]) {
    const destination = path.join(repository, relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, `project:${relativePath}\n`, { mode: 0o640 });
  }
}

test('uninstall removes only verified owned assets and preserves project assets', async (t) => {
  const { disposableRoot, homeDir, runtime, sentinels } =
    await createInstallationFixture(t);
  const installed = await executeLifecycle({ operation: 'install' }, runtime);
  assert.equal(installed.ok, true);
  const repository = path.join(disposableRoot, 'repository');
  await createProjectSentinel(repository);
  const projectBefore = await snapshotTree(repository);

  const result = await executeLifecycle(
    { operation: 'uninstall' },
    { ...runtime, cwd: repository },
  );

  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'uninstalled');
  assert.equal(await exists(path.join(homeDir, '.agent-init')), false);
  for (const entry of HARNESS_REGISTRY) {
    const segments = entry.skillsDir.split('/');
    assert.equal(await exists(path.join(homeDir, ...segments, 'agent-init')), false);
    assert.equal(await exists(path.join(homeDir, ...segments)), true);
  }
  assert.deepEqual(await snapshotTree(repository), projectBefore);
  await assertSentinelsUnchanged(sentinels);
});

test('uninstall preserves a replaced target while removing independent owned assets', async (t) => {
  const { homeDir, runtime, sentinels } = await createInstallationFixture(t);
  const installed = await executeLifecycle({ operation: 'install' }, runtime);
  const codexPath = installed.manifest.targets.codex.path;
  const claudePath = installed.manifest.targets.claude.path;
  await unlink(codexPath);
  await writeFile(codexPath, 'user replacement\n', { mode: 0o600 });

  const result = await executeLifecycle({ operation: 'uninstall' }, runtime);

  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'uninstalled');
  assert.deepEqual(result.preserved, [codexPath]);
  assert.equal(await readFile(codexPath, 'utf8'), 'user replacement\n');
  assert.equal((await lstat(codexPath)).mode & 0o777, 0o600);
  assert.equal(await exists(claudePath), false);
  assert.equal(await exists(path.join(homeDir, '.agent-init')), false);
  await assertSentinelsUnchanged(sentinels);
});

test('partial uninstall reports changed, preserved, and unresolved assets', async (t) => {
  const { homeDir, runtime, sentinels } = await createInstallationFixture(t);
  const installed = await executeLifecycle({ operation: 'install' }, runtime);
  assert.equal(installed.ok, true);
  const operationId = 'f0'.repeat(16);
  runtime.randomBytes = () => Buffer.from(operationId, 'hex');
  const claudeQuarantine = path.join(
    path.dirname(installed.manifest.targets.claude.path),
    `.agent-init-rollback-${operationId}-claude`,
  );
  let injected = false;
  runtime.afterMutation = async (name) => {
    if (!injected && name === 'uninstall:codex-processed') {
      injected = true;
      await mkdir(claudeQuarantine);
    }
  };

  const result = await executeLifecycle({ operation: 'uninstall' }, runtime);

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'INSTALL_CONFLICT');
  assert.equal(await exists(installed.manifest.targets.codex.path), false);
  assert.equal(await exists(installed.manifest.targets.claude.path), true);
  assert.equal(result.error.changed.includes(installed.manifest.targets.codex.path), true);
  assert.equal(result.error.preserved.includes(installed.manifest.targets.claude.path), true);
  assert.equal(result.error.preserved.includes(installed.paths.canonicalRoot), true);
  assert.equal(result.error.preserved.includes(installed.paths.manifest), true);
  assert.equal(result.error.unresolved.includes(claudeQuarantine), true);
  assert.equal(
    result.error.unresolved.some((entry) =>
      entry.endsWith('.agent-init.operation.lock'),
    ),
    true,
  );
  const rendered = renderFailure(result, runtime);
  assert.doesNotMatch(rendered, /Changed: none reported/);
  assert.match(rendered, /Preserved:/);
  assert.match(rendered, /Unresolved:/);
  await assertSentinelsUnchanged(sentinels);
});
