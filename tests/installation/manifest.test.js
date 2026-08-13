import assert from 'node:assert/strict';
import test from 'node:test';

import { serializeJson } from '../../src/installation/manifest.js';

test('manifest JSON serialization is deterministic across insertion order', () => {
  const first = {
    version: '0.1.0',
    schemaVersion: 1,
    targets: {
      codex: { mode: 'symlink', path: '/home/.agents/skills/project-setup' },
      claude: { path: '/home/.claude/skills/project-setup', mode: 'copy' },
    },
  };
  const second = {
    targets: {
      claude: { mode: 'copy', path: '/home/.claude/skills/project-setup' },
      codex: { path: '/home/.agents/skills/project-setup', mode: 'symlink' },
    },
    schemaVersion: 1,
    version: '0.1.0',
  };

  assert.equal(serializeJson(first), serializeJson(second));
  assert.equal(serializeJson(first).endsWith('\n'), true);
});
