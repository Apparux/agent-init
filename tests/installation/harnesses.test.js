import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  HARNESS_REGISTRY,
  loadHarnessRegistry,
} from '../../src/installation/harnesses.js';
import { InstallationError } from '../../src/installation/paths.js';

test('built-in registry shape: unique keys, unique dirs, accepted for codex/claude', () => {
  const keys = HARNESS_REGISTRY.map((entry) => entry.key);
  assert.deepEqual(keys, ['codex', 'claude', 'cursor', 'opencode', 'pi', 'grok']);
  const dirs = HARNESS_REGISTRY.map((entry) => entry.skillsDir);
  assert.equal(new Set(dirs).size, dirs.length, 'skillsDir values must be unique');
  for (const entry of HARNESS_REGISTRY) {
    assert.match(entry.key, /^[a-z][a-z0-9-]*$/);
    assert.equal(typeof entry.label, 'string');
    assert.ok(entry.label.length > 0);
    assert.ok(!path.isAbsolute(entry.skillsDir));
    assert.ok(['accepted', 'unverified'].includes(entry.verification));
  }
  assert.equal(
    HARNESS_REGISTRY.filter((entry) => entry.verification === 'accepted').length,
    2,
  );
});

test('loadHarnessRegistry without config returns the built-in registry', async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), 'aps-harness-'));
  const { entries, aliases } = await loadHarnessRegistry(homeDir);
  assert.deepEqual(
    entries.map((entry) => entry.key),
    ['codex', 'claude', 'cursor', 'opencode', 'pi', 'grok'],
  );
  assert.equal(aliases.size, 0);
});

test('loadHarnessRegistry appends custom harnesses from harnesses.json', async (t) => {
  const homeDir = await mkdtemp(path.join(tmpdir(), 'aps-harness-'));
  await mkdirp(path.join(homeDir, '.config', 'agent-init'));
  await writeFile(
    path.join(homeDir, '.config', 'agent-init', 'harnesses.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        harnesses: [
          {
            id: 'myagent',
            label: 'My Agent',
            skillsDir: '.myagent/skills',
            invocation: '$myagent',
          },
        ],
      },
      null,
      2,
    )}\n`,
  );

  const { entries, aliases } = await loadHarnessRegistry(homeDir);
  assert.equal(entries.length, 7);
  const custom = entries.at(-1);
  assert.equal(custom.key, 'myagent');
  assert.equal(custom.label, 'My Agent');
  assert.equal(custom.skillsDir, '.myagent/skills');
  assert.equal(custom.invocation, '$myagent');
  assert.equal(custom.verification, 'unverified');
  assert.equal(aliases.size, 0);
});

test('loadHarnessRegistry aliases a custom harness onto an existing skillsDir', async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), 'aps-harness-'));
  await mkdirp(path.join(homeDir, '.config', 'agent-init'));
  await writeFile(
    path.join(homeDir, '.config', 'agent-init', 'harnesses.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        harnesses: [
          { id: 'warp', label: 'Warp', skillsDir: '.agents/skills' },
          { id: 'zed', label: 'Zed', skillsDir: '.agents/skills' },
        ],
      },
      null,
      2,
    )}\n`,
  );

  const { entries, aliases } = await loadHarnessRegistry(homeDir);
  assert.equal(entries.length, 6, 'aliased custom harnesses add no target');
  assert.equal(aliases.get('warp').skillsDir, '.agents/skills');
  assert.equal(aliases.get('warp').label, 'Warp');
  assert.equal(aliases.get('zed').skillsDir, '.agents/skills');
});

test('loadHarnessRegistry rejects invalid configs', async () => {
  const cases = [
    {
      config: { schemaVersion: 2, harnesses: [] },
      message: /schemaVersion/,
    },
    { config: { schemaVersion: 1 }, message: /"harnesses" must be an array/ },
    {
      config: {
        schemaVersion: 1,
        harnesses: [{ id: 'Bad_Upper', skillsDir: '.x/skills' }],
      },
      message: /id must match/,
    },
    {
      config: {
        schemaVersion: 1,
        harnesses: [{ id: 'codex', skillsDir: '.x/skills' }],
      },
      message: /conflicts with an existing harness/,
    },
    {
      config: {
        schemaVersion: 1,
        harnesses: [{ id: 'dup', skillsDir: '.a/s' }, { id: 'dup', skillsDir: '.b/s' }],
      },
      message: /conflicts with an existing harness/,
    },
    {
      config: {
        schemaVersion: 1,
        harnesses: [{ id: 'abs', skillsDir: '/etc/skills' }],
      },
      message: /relative to HOME/,
    },
    {
      config: {
        schemaVersion: 1,
        harnesses: [{ id: 'esc', skillsDir: '../outside/skills' }],
      },
      message: /stay inside HOME/,
    },
    {
      config: {
        schemaVersion: 1,
        harnesses: [{ id: 'home', skillsDir: '~/.thing/skills' }],
      },
      message: /relative to HOME/,
    },
  ];

  for (const { config, message } of cases) {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'aps-harness-'));
    await mkdirp(path.join(homeDir, '.config', 'agent-init'));
    await writeFile(
      path.join(homeDir, '.config', 'agent-init', 'harnesses.json'),
      JSON.stringify(config),
    );
    await assert.rejects(
      () => loadHarnessRegistry(homeDir),
      (error) =>
        error instanceof InstallationError &&
        error.code === 'INVALID_HARNESSES_CONFIG' &&
        message.test(error.message),
    );
  }
});

test('loadHarnessRegistry rejects unreadable or non-JSON config', async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), 'aps-harness-'));
  await mkdirp(path.join(homeDir, '.config', 'agent-init'));
  await writeFile(
    path.join(homeDir, '.config', 'agent-init', 'harnesses.json'),
    '{not json',
  );
  await assert.rejects(
    () => loadHarnessRegistry(homeDir),
    (error) => error.code === 'INVALID_HARNESSES_CONFIG',
  );
});

async function mkdirp(dir) {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(dir, { recursive: true });
}
