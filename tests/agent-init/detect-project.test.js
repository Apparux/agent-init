import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, '../..');
const scriptPath = path.join(repositoryRoot, 'skills', 'agent-init', 'scripts', 'detect-project.js');

async function snapshotTree(root, relative = '.') {
  const absolute = path.resolve(root, relative);
  const entries = [];

  async function visit(current, rel) {
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) {
      entries.push({ path: rel, type: 'symlink', link: await readlink(current) });
      return;
    }
    if (stat.isDirectory()) {
      entries.push({ path: rel, type: 'directory', mode: stat.mode & 0o777 });
      for (const name of (await readdir(current)).sort()) {
        await visit(path.join(current, name), rel === '.' ? name : `${rel}/${name}`);
      }
      return;
    }
    entries.push({
      path: rel,
      type: 'file',
      mode: stat.mode & 0o777,
      content: await readFile(current, 'base64'),
    });
  }

  await visit(absolute, '.');
  return entries;
}

async function createRepository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aps-detect-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'aps-outside-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  await mkdir(path.join(root, '.github', 'workflows'), { recursive: true });
  await mkdir(path.join(root, '.agents', 'skills', 'release'), { recursive: true });
  await mkdir(path.join(root, '.claude'), { recursive: true });
  await mkdir(path.join(root, 'packages', 'app'), { recursive: true });
  await mkdir(path.join(root, 'deep', 'one', 'two'), { recursive: true });

  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: 'fixture',
    packageManager: 'pnpm@9.0.0',
    engines: { node: '>=20' },
    scripts: { test: 'node --test', build: 'node build.js' },
  }));
  await writeFile(path.join(root, 'packages', 'app', 'package.json'), JSON.stringify({
    name: 'app',
    scripts: { lint: 'eslint .' },
  }));
  await writeFile(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  await writeFile(path.join(root, 'pyproject.toml'), '[project]\nname = "mixed"\n');
  await writeFile(path.join(root, '.github', 'workflows', 'verify.yml'), 'name: verify\n');
  await writeFile(path.join(root, 'AGENTS.md'), '# Existing\n');
  await writeFile(path.join(root, '.claude', 'settings.json'), '{"hooks": {}}\n');
  await writeFile(path.join(root, '.agents', 'skills', 'release', 'SKILL.md'), '---\nname: release\ndescription: Release this fixture.\n---\n');
  await writeFile(path.join(root, '.env'), 'TOKEN=must-not-be-read\n');
  await writeFile(path.join(root, 'deep', 'one', 'two', 'package.json'), '{"scripts":{"secret":"TOKEN"}}\n');
  await writeFile(path.join(outside, 'package.json'), '{"scripts":{"leaked-external-value":"TOP-SECRET"}}\n');
  await symlink(outside, path.join(root, 'packages', 'linked-outside'));

  return root;
}

async function runDetector(root) {
  const result = await execFileAsync(process.execPath, [scriptPath, root], {
    encoding: 'utf8',
    timeout: 5_000,
    maxBuffer: 1_000_000,
  });
  return { ...result, json: JSON.parse(result.stdout) };
}

test('deterministic detector collects only bounded facts and never mutates the repository', async (t) => {
  const root = await createRepository(t);
  const before = await snapshotTree(root);

  const first = await runDetector(root);
  const second = await runDetector(root);
  const after = await snapshotTree(root);

  assert.equal(first.stdout, second.stdout);
  assert.deepEqual(after, before);
  assert.equal(first.json.schemaVersion, 1);
  assert.equal(first.json.root, await import('node:fs/promises').then(({ realpath }) => realpath(root)));
  assert.equal(first.json.git.isRepository, false);
  assert.deepEqual(first.json.buildFiles, ['package.json', 'packages/app/package.json', 'pyproject.toml']);
  assert.deepEqual(first.json.lockFiles, ['pnpm-lock.yaml']);
  assert.deepEqual(first.json.ciPaths, ['.github/workflows/verify.yml']);
  assert.deepEqual(first.json.agentConfigPaths, ['.agents', '.claude', '.claude/settings.json', 'AGENTS.md']);
  assert.deepEqual(first.json.skillDirectories, ['.agents/skills/release']);
  assert.deepEqual(first.json.packageManifests, [
    {
      path: 'package.json',
      packageManager: 'pnpm@9.0.0',
      engines: { node: '>=20' },
      scripts: ['build', 'test'],
    },
    {
      path: 'packages/app/package.json',
      packageManager: null,
      engines: {},
      scripts: ['lint'],
    },
  ]);
  assert.ok(first.json.indicators.includes('pyproject.toml'));
  assert.equal(first.stdout.includes('must-not-be-read'), false);
  assert.equal(first.stdout.includes('leaked-external-value'), false);
  assert.equal(first.stdout.includes('TOP-SECRET'), false);
  assert.equal(first.stdout.includes('secret'), false);
  assert.equal('classifications' in first.json, false);
  assert.equal('recommendations' in first.json, false);
  assert.equal('architecture' in first.json, false);
  assert.equal(first.json.limits.maxDepth, 2);
  assert.ok(first.json.errors.some((error) => error.code === 'SYMLINK_SKIPPED'));
});

test('detector never follows symlinked known ancestors', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aps-detect-ancestor-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'aps-detect-ancestor-outside-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  await mkdir(path.join(outside, 'workflows'), { recursive: true });
  await mkdir(path.join(outside, 'skills', 'external'), { recursive: true });
  await writeFile(path.join(outside, 'workflows', 'leak.yml'), 'name: leaked-ci\n');
  await writeFile(path.join(outside, 'skills', 'external', 'SKILL.md'), 'TOP-SECRET\n');
  await symlink(outside, path.join(root, '.github'));
  await symlink(outside, path.join(root, '.agents'));

  const { stdout, json } = await runDetector(root);
  assert.deepEqual(json.ciPaths, []);
  assert.deepEqual(json.skillDirectories, []);
  assert.equal(stdout.includes('leaked-ci'), false);
  assert.equal(stdout.includes('TOP-SECRET'), false);
  assert.ok(json.errors.some((error) => error.code === 'SYMLINK_ANCESTOR_SKIPPED'));
});

test('detector caps candidate container entries', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aps-detect-limit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'packages'));

  for (let index = 0; index < 70; index += 1) {
    const directory = path.join(root, 'packages', String(index).padStart(2, '0'));
    await mkdir(directory);
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: `p-${index}` }));
  }

  const { json } = await runDetector(root);
  const nestedPackages = json.packageManifests.filter((entry) => entry.path.startsWith('packages/'));
  assert.equal(nestedPackages.length, json.limits.maxEntriesPerDirectory);
  assert.ok(json.errors.some((error) => error.code === 'ENTRY_LIMIT'));
});

test('detector rejects an unreadable or invalid root with contextual diagnostics', async () => {
  const missing = path.join(os.tmpdir(), `aps-missing-${process.pid}-${Date.now()}`);

  await assert.rejects(
    execFileAsync(process.execPath, [scriptPath, missing], {
      encoding: 'utf8',
      timeout: 5_000,
    }),
    (error) => {
      assert.notEqual(error.code, 0);
      assert.match(error.stderr, /repository root/i);
      assert.match(error.stderr, new RegExp(missing.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      return true;
    },
  );
});
