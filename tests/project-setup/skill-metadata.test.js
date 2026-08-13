import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, '../..');
const skillDirectory = path.join(repositoryRoot, 'skills', 'project-setup');
const skillPath = path.join(skillDirectory, 'SKILL.md');

function parseFrontmatter(markdown) {
  const match = markdown.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  assert.ok(match, 'SKILL.md must start with YAML frontmatter');

  const entries = match[1]
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf(':');
      assert.notEqual(separator, -1, `invalid frontmatter line: ${line}`);
      return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
    });

  return Object.fromEntries(entries);
}

test('mother Skill exposes the shared discovery metadata contract', async () => {
  const markdown = await readFile(skillPath, 'utf8');
  const metadata = parseFrontmatter(markdown);

  assert.deepEqual(Object.keys(metadata).sort(), ['description', 'name']);
  assert.equal(metadata.name, 'project-setup');
  assert.match(metadata.description, /repository/i);
  assert.match(metadata.description, /setup|configure|reconcile/i);
  assert.match(metadata.description, /agent/i);
  assert.equal(path.basename(skillDirectory), metadata.name);
});
