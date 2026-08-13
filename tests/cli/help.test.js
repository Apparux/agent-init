import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const binPath = fileURLToPath(new URL('../../bin/agent-project-setup.js', import.meta.url));

test('--help prints usage through the package bin', () => {
  const result = spawnSync(process.execPath, [binPath, '--help'], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /^Usage: agent-project-setup <command>/m);
  assert.match(result.stdout, /install \| update \| doctor \| uninstall/);
});
