import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const binPath = fileURLToPath(new URL('../../bin/agent-project-setup.js', import.meta.url));

function run(args) {
  return spawnSync(process.execPath, [binPath, ...args], { encoding: 'utf8' });
}

test('--version is read from package metadata', () => {
  const result = run(['--version']);

  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'agent-project-setup 0.1.0\n');
  assert.equal(result.stderr, '');
});

for (const args of [[], ['wat'], ['install', 'extra']]) {
  test(`usage error for ${args.length === 0 ? 'no command' : args.join(' ')}`, () => {
    const result = run(args);

    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^Usage: agent-project-setup <command>/);
  });
}
