import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, lstat, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { validateFixtureManifest } from './evaluation-harness.js';

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '../..');
const fixturesRoot = path.join(projectRoot, 'tests', 'fixtures');
const detectorPath = path.join(projectRoot, 'skills', 'project-setup', 'scripts', 'detect-project.js');
const fixtureNames = [
  '01-java-maven-simple',
  '02-java-maven-monorepo',
  '03-node-pnpm',
  '04-python',
  '05-existing-agents',
  '06-existing-claude',
  '07-existing-both',
  '08-existing-skills',
  '09-no-git',
  '10-mixed-monorepo',
];
const requiredCoverage = new Set([
  'architecture-defer',
  'cross-agent-preservation',
  'deterministic-recommendation-only',
  'existing-agents-preservation',
  'existing-claude-preservation',
  'existing-skill-preservation',
  'mixed-evidence-unknowns',
  'no-git-baseline',
  'project-workflow-skill',
  'stack-is-not-skill',
]);

async function loadFixture(name) {
  const directory = path.join(fixturesRoot, name);
  const manifest = JSON.parse(await readFile(path.join(directory, 'fixture.json'), 'utf8'));
  return { directory, manifest, repository: path.join(directory, manifest.repository) };
}

async function runDetector(repository) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'aps-fixture-copy-'));
  const isolatedRepository = path.join(temporary, 'repository');
  try {
    await cp(repository, isolatedRepository, { recursive: true, verbatimSymlinks: true });
    const { stdout } = await execFileAsync(process.execPath, [detectorPath, isolatedRepository], {
      encoding: 'utf8',
      timeout: 5_000,
      maxBuffer: 1_000_000,
    });
    return JSON.parse(stdout);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

test('the ten minimal fixture repositories expose distinct behavior evidence', async () => {
  const actual = (await readdir(fixturesRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(actual, fixtureNames);

  const observedCoverage = new Set();
  for (const name of fixtureNames) {
    const { manifest, repository } = await loadFixture(name);
    assert.equal(manifest.id, name);
    assert.deepEqual(validateFixtureManifest(manifest), []);
    assert.ok(Array.isArray(manifest.coverage) && manifest.coverage.length > 0);
    for (const contract of manifest.coverage) observedCoverage.add(contract);

    assert.ok(Array.isArray(manifest.expected.allowedActions));
    assert.ok(Array.isArray(manifest.expected.forbiddenPaths));
    assert.ok(manifest.expected.forbiddenPaths.length > 0);
    assert.deepEqual(manifest.externalAcceptance, {
      claudeCode: { status: 'not-run', evidence: null },
      codex: { status: 'not-run', evidence: null },
    });

    const physicalRoot = await realpath(repository);
    for (const evidence of manifest.evidence) {
      const source = path.resolve(physicalRoot, evidence.sourcePath);
      const relative = path.relative(physicalRoot, source);
      assert.ok(relative !== '..' && !relative.startsWith(`..${path.sep}`));
      const stat = await lstat(source);
      assert.ok(stat.isFile(), `${name}: evidence source is not a file: ${evidence.sourcePath}`);
      if (evidence.sensitivity === 'presence-only') {
        assert.equal(evidence.sourceLocation, 'presence');
        assert.match(evidence.observation, /exists|present/i);
      }
    }
  }

  for (const contract of requiredCoverage) {
    assert.ok(observedCoverage.has(contract), `missing behavior evidence: ${contract}`);
  }
});

test('fixture detector expectations are executable and remain interpretation-free', async () => {
  for (const name of fixtureNames) {
    const { manifest, repository } = await loadFixture(name);
    const detected = await runDetector(repository);
    const expected = manifest.expected.detection;

    assert.equal(detected.git.isRepository, expected.gitRepository, `${name}: Git state`);
    assert.deepEqual(detected.buildFiles, expected.buildFiles, `${name}: build files`);
    assert.deepEqual(detected.lockFiles, expected.lockFiles, `${name}: lock files`);
    assert.deepEqual(detected.agentConfigPaths, expected.agentConfigPaths, `${name}: Agent config`);
    assert.deepEqual(detected.skillDirectories, expected.skillDirectories, `${name}: Skills`);
    assert.equal('classifications' in detected, false);
    assert.equal('recommendations' in detected, false);
    assert.equal('architecture' in detected, false);
  }
});
