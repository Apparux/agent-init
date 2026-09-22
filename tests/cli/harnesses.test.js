import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runCli } from '../../src/cli/run.js';
import { HARNESS_REGISTRY } from '../../src/installation/harnesses.js';
import { createInstallationFixture } from '../installation/helpers.js';

function stringOutput(stream) {
  const chunks = [];
  return {
    write(chunk) {
      chunks.push(chunk);
    },
    toString() {
      return chunks.join('');
    },
  };
}

async function createCliFixture(t) {
  const fixture = await createInstallationFixture(t);
  const stdout = stringOutput();
  const stderr = stringOutput();
  const runtime = {
    ...fixture.runtime,
    stdout,
    stderr,
  };
  return { ...fixture, runtime, stdout, stderr };
}

test('harnesses lists every registry entry when nothing is installed', async (t) => {
  const { runtime } = await createCliFixture(t);
  const code = await runCli(['harnesses'], runtime);
  const out = runtime.stdout.toString();

  assert.equal(code, 0);
  assert.match(out, /Not installed/);
  for (const entry of HARNESS_REGISTRY) {
    assert.match(out, new RegExp(`${entry.label} \\(${entry.key}\\)`));
    assert.match(out, new RegExp(`verification: ${entry.verification}`));
  }
});

test('harnesses reports installed mode and status after install', async (t) => {
  const fixture = await createInstallationFixture(t);
  const { executeLifecycle } = await import(
    '../../src/installation/lifecycle.js'
  );
  assert.equal(
    (await executeLifecycle({ operation: 'install' }, fixture.runtime)).ok,
    true,
  );

  const stdout = stringOutput();
  const code = await runCli(['harnesses'], {
    ...fixture.runtime,
    stdout,
    stderr: stringOutput(),
  });
  const out = stdout.toString();

  assert.equal(code, 0);
  assert.match(out, new RegExp(`Installed: ${fixture.runtime.packageVersion}`));
  for (const entry of HARNESS_REGISTRY) {
    assert.match(
      out,
      new RegExp(`${entry.label} \\(${entry.key}\\)[\\s\\S]*?✓ symlink`),
    );
  }
});

test('harnesses usage appears in help and unknown commands list it', async (t) => {
  const fixture = await createCliFixture(t);
  const helpCode = await runCli(['--help'], fixture.runtime);
  assert.equal(helpCode, 0);
  assert.match(fixture.runtime.stdout.toString(), /harnesses/);

  fixture.runtime.stderr = stringOutput();
  const badCode = await runCli(['nonsense'], fixture.runtime);
  assert.equal(badCode, 2);
  assert.match(fixture.runtime.stderr.toString(), /harnesses/);
});

test('custom harnesses from ~/.config/agent-init/harnesses.json install and uninstall cleanly', async (t) => {
  const { homeDir, runtime } = await createInstallationFixture(t);
  await mkdir(path.join(homeDir, '.config', 'agent-init'), { recursive: true });
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
          {
            id: 'warp',
            label: 'Warp',
            skillsDir: '.agents/skills',
          },
        ],
      },
      null,
      2,
    )}\n`,
  );

  const { executeLifecycle } = await import(
    '../../src/installation/lifecycle.js'
  );
  const installed = await executeLifecycle(
    { operation: 'install' },
    runtime,
  );
  assert.equal(installed.ok, true);
  assert.equal(installed.manifest.targets.myagent !== undefined, true);
  assert.equal(
    installed.manifest.targets.warp === undefined,
    true,
    'aliased custom harness must not create a separate target',
  );

  const stdout = stringOutput();
  await runCli(['harnesses'], { ...runtime, stdout, stderr: stringOutput() });
  const out = stdout.toString();
  assert.match(out, /My Agent \(myagent\)/);
  assert.match(out, /Warp \(warp\)/);
  assert.match(
    out,
    /Warp \(warp\)[\s\S]*?✓ symlink/,
    'aliased harness reports the shared target state',
  );

  const uninstalled = await executeLifecycle(
    { operation: 'uninstall' },
    runtime,
  );
  assert.equal(uninstalled.ok, true);
  assert.equal(uninstalled.preserved.length, 0);
});

test('invalid harnesses config fails install fast with INVALID_HARNESSES_CONFIG', async (t) => {
  const { homeDir, runtime } = await createInstallationFixture(t);
  await mkdir(path.join(homeDir, '.config', 'agent-init'), { recursive: true });
  await writeFile(
    path.join(homeDir, '.config', 'agent-init', 'harnesses.json'),
    JSON.stringify({
      schemaVersion: 1,
      harnesses: [{ id: 'Bad', skillsDir: '.bad/skills' }],
    }),
  );

  const { executeLifecycle } = await import(
    '../../src/installation/lifecycle.js'
  );
  const result = await executeLifecycle({ operation: 'install' }, runtime);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'INVALID_HARNESSES_CONFIG');
});
