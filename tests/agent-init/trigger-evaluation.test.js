import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { copyTree } from '../../src/installation/filesystem.js';
import {
  createTriggerArtifact,
  evaluateTriggerArtifact,
  loadTriggerCorpus,
  prepareTriggerCase,
} from './trigger-evaluation.js';

const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
const corpusPath = path.join(projectRoot, 'tests/trigger-corpus/cases.json');
const recordedAt = '2026-09-30T12:00:00.000Z';

function generatedSkill(decision) {
  return `---
name: ${decision.name}
description: ${JSON.stringify(decision.routing.description)}
---

## When to use
${decision.routing.positiveIntents.join('\n')}

## When not to use
${decision.routing.negativeIntents.join('\n')}

## Workflow
${decision.workflowSteps.join('\n')}

## Project-specific rules
${decision.reason}

## Verification
${decision.verification.join('\n')}
`;
}

async function makeCase(t, caseId) {
  const corpus = JSON.parse(await readFile(corpusPath, 'utf8'));
  const triggerCase = corpus.cases.find((entry) => entry.id === caseId);
  assert.ok(triggerCase, `Missing versioned case ${caseId}`);
  const sandbox = await mkdtemp(path.join(projectRoot, '.tmp-trigger-'));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const fixturesDirectory = path.join(sandbox, 'fixtures');
  await mkdir(fixturesDirectory);
  const fixtureIds = [...new Set([triggerCase.fixture, ...Object.values(triggerCase.skillFixtures)])];
  const fixtureRoots = {};
  for (const fixtureId of fixtureIds) {
    fixtureRoots[fixtureId] = path.join(fixturesDirectory, fixtureId);
    await copyTree(path.join(projectRoot, 'tests/fixtures', fixtureId), fixtureRoots[fixtureId]);
  }
  const generatedSkills = {};
  for (const [name, fixtureId] of Object.entries(triggerCase.skillFixtures)) {
    const fixture = JSON.parse(await readFile(path.join(fixtureRoots[fixtureId], 'fixture.json'), 'utf8'));
    const decision = fixture.expected.skillDecisions.find((entry) => entry.name === name && ['CREATE', 'UPDATE'].includes(entry.action));
    assert.ok(decision, `${fixtureId} has no generated ${name} decision`);
    generatedSkills[name] = path.join(sandbox, '.agents/skills', name);
    await mkdir(generatedSkills[name], { recursive: true });
    await writeFile(path.join(generatedSkills[name], 'SKILL.md'), generatedSkill(decision));
  }
  const options = { caseId, corpusPath, fixtureRoots, generatedSkills };
  return { sandbox, triggerCase, options };
}

function record(prepared, loaded, harness = 'claude-code') {
  return createTriggerArtifact(prepared, {
    harness,
    harnessVersion: 'synthetic-test-1',
    selectionEvidence: { loaded },
    recordedAt,
  });
}

function assertFailure(result, code) {
  assert.equal(result.ok, false, `Expected ${code}, received a passing result`);
  assert.ok(result.errors.some((message) => message.startsWith(`${code}:`)), result.errors.join('\n'));
  assert.equal(result.claims.liveSkillBehaviorProven, false);
}

test('a versioned case produces a conforming synthetic artifact and a reproducible result', async (t) => {
  const { options } = await makeCase(t, 'database-migration-positive-01');
  const prepared = await prepareTriggerCase(options.caseId, options);
  const artifact = record(prepared, ['database-migration']);
  assert.equal(artifact.schemaVersion, 1);
  assert.equal(artifact.fixtureId, '12-flyway-database-migration');
  assert.equal(artifact.caseId, 'database-migration-positive-01');
  assert.deepEqual(artifact.expected, {
    mustLoad: ['database-migration'],
    mustNotLoad: ['build-verify', 'audit-log', 'deployment'],
  });
  for (const field of ['motherSkillDigest', 'generatedSkillDigest', 'fixtureDigest', 'triggerCorpusDigest']) {
    assert.match(artifact[field], /^sha256:[a-f0-9]{64}$/);
  }
  const result = await evaluateTriggerArtifact(artifact, options);
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.equal(result.result, 'pass');
  assert.deepEqual(result.claims, {
    localContractValidated: true,
    liveSkillBehaviorProven: false,
    claudeCodeBehaviorProven: false,
    codexBehaviorProven: false,
  });
});

test('every versioned case round-trips a recorded synthetic artifact for both supported harnesses', async (t) => {
  const selections = [
    ['node-build-verify-positive-01', ['build-verify']],
    ['node-build-verify-negative-01', []],
    ['node-build-verify-near-miss-01', []],
    ['node-build-verify-deployment-collision-01', ['build-verify', 'deployment']],
    ['maven-build-verify-positive-01', ['build-verify']],
    ['maven-build-verify-negative-01', []],
    ['maven-build-verify-near-miss-01', []],
    ['maven-build-verify-migration-collision-01', ['build-verify', 'database-migration']],
    ['database-migration-positive-01', ['database-migration']],
    ['database-migration-negative-01', []],
    ['database-migration-near-miss-01', []],
    ['database-migration-audit-log-collision-01', ['database-migration', 'audit-log']],
    ['audit-log-positive-01', ['audit-log']],
    ['audit-log-negative-01', []],
    ['audit-log-near-miss-01', []],
    ['audit-log-migration-collision-01', ['audit-log', 'database-migration']],
    ['deployment-positive-01', ['deployment']],
    ['deployment-negative-01', []],
    ['deployment-near-miss-01', []],
    ['deployment-node-build-verify-collision-01', ['deployment', 'build-verify']],
    ['redis-no-skill-negative-01', []],
  ];
  const corpus = await loadTriggerCorpus();
  assert.deepEqual(corpus.cases.map((entry) => entry.id).sort(), selections.map(([id]) => id).sort());
  for (const [caseId, loaded] of selections) {
    await t.test(caseId, async (t) => {
      const { sandbox, options } = await makeCase(t, caseId);
      const prepared = await prepareTriggerCase(caseId, options);
      for (const harness of ['claude-code', 'codex']) {
        const artifact = createTriggerArtifact(prepared, {
          harness, harnessVersion: 'synthetic-test-1',
          selectionEvidence: JSON.stringify({ loaded }), recordedAt,
        });
        const artifactPath = path.join(sandbox, `${harness}.json`);
        await writeFile(artifactPath, JSON.stringify(artifact, null, 2) + '\n');
        const recorded = JSON.parse(await readFile(artifactPath, 'utf8'));
        assert.deepEqual(recorded, artifact);
        assert.deepEqual(recorded.observed.loaded, loaded);
        const result = await evaluateTriggerArtifact(recorded, options);
        assert.equal(result.ok, true, `${caseId}/${harness}: ${result.errors.join('\n')}`);
        assert.equal(result.result, 'pass');
        assert.equal(result.claims.liveSkillBehaviorProven, false);
        assert.equal(result.claims.claudeCodeBehaviorProven, false);
        assert.equal(result.claims.codexBehaviorProven, false);
      }
    });
  }
});

test('artifacts bind all four current input digests', async (t) => {
  const fields = ['motherSkillDigest', 'generatedSkillDigest', 'fixtureDigest', 'triggerCorpusDigest'];
  const { options } = await makeCase(t, 'database-migration-positive-01');
  const artifact = record(await prepareTriggerCase(options.caseId, options), ['database-migration']);
  for (const field of fields) {
    await t.test(`forged ${field}`, async () => {
      const result = await evaluateTriggerArtifact({ ...artifact, [field]: 'sha256:' + 'a'.repeat(64) }, options);
      assertFailure(result, 'ARTIFACT_DIGEST');
      assert.ok(result.errors.some((message) => message.includes(field)), result.errors.join('\n'));
    });
  }
  for (const field of fields) {
    await t.test(`changed ${field}`, async (t) => {
      const { sandbox, options } = await makeCase(t, 'database-migration-positive-01');
      let inputPath;
      if (field === 'motherSkillDigest') {
        options.motherSkillRoot = path.join(sandbox, 'mother');
        await copyTree(path.join(projectRoot, 'skills/agent-init'), options.motherSkillRoot);
        inputPath = path.join(options.motherSkillRoot, 'SKILL.md');
      } else if (field === 'generatedSkillDigest') {
        inputPath = path.join(options.generatedSkills['database-migration'], 'SKILL.md');
      } else if (field === 'fixtureDigest') {
        inputPath = path.join(options.fixtureRoots['12-flyway-database-migration'], 'repository/docs/database-migrations.md');
      } else {
        options.corpusPath = path.join(sandbox, 'corpus.json');
        await writeFile(options.corpusPath, await readFile(corpusPath));
        inputPath = options.corpusPath;
      }
      const artifact = record(await prepareTriggerCase(options.caseId, options), ['database-migration']);
      await writeFile(inputPath, Buffer.concat([await readFile(inputPath), Buffer.from('\n')]));
      const stale = await evaluateTriggerArtifact(artifact, options);
      assertFailure(stale, 'ARTIFACT_DIGEST');
      assert.ok(stale.errors.some((message) => message.includes(field)), stale.errors.join('\n'));
      const current = record(await prepareTriggerCase(options.caseId, options), ['database-migration']);
      const result = await evaluateTriggerArtifact(current, options);
      assert.equal(result.ok, true, result.errors.join('\n'));
    });
  }
});

test('multi-Skill digests bind every contributing payload independently of input order', async (t) => {
  const { options } = await makeCase(t, 'database-migration-audit-log-collision-01');
  const prepared = await prepareTriggerCase(options.caseId, options);
  assert.deepEqual(prepared.fixtureIds, ['12-flyway-database-migration', '13-audit-log']);
  const reversed = {
    ...options,
    generatedSkills: Object.fromEntries(Object.entries(options.generatedSkills).reverse()),
    fixtureRoots: Object.fromEntries(Object.entries(options.fixtureRoots).reverse()),
  };
  const reordered = await prepareTriggerCase(options.caseId, reversed);
  assert.equal(reordered.digests.generatedSkillDigest, prepared.digests.generatedSkillDigest, 'the same Skill set must have the same digest');
  assert.equal(reordered.digests.fixtureDigest, prepared.digests.fixtureDigest);
  const artifact = record(prepared, ['database-migration', 'audit-log'], 'codex');
  const result = await evaluateTriggerArtifact(artifact, reversed);
  assert.equal(result.ok, true, result.errors.join('\n'));
  for (const [name, root] of Object.entries(options.generatedSkills)) {
    await t.test(`${name} contributes`, async () => {
      const skillPath = path.join(root, 'SKILL.md');
      const original = await readFile(skillPath);
      await writeFile(skillPath, Buffer.concat([original, Buffer.from('\nSynthetic payload mutation.\n')]));
      try {
        const changed = await prepareTriggerCase(options.caseId, options);
        assert.notEqual(changed.digests.generatedSkillDigest, prepared.digests.generatedSkillDigest);
        assert.equal(changed.digests.fixtureDigest, prepared.digests.fixtureDigest);
      } finally {
        await writeFile(skillPath, original);
      }
      const restored = await prepareTriggerCase(options.caseId, options);
      assert.equal(restored.digests.generatedSkillDigest, prepared.digests.generatedSkillDigest);
    });
  }
  const relatedPath = path.join(options.fixtureRoots['13-audit-log'], 'repository/docs/audit-log.md');
  await writeFile(relatedPath, (await readFile(relatedPath, 'utf8')) + '\nSynthetic fixture mutation.\n');
  const changedFixture = await prepareTriggerCase(options.caseId, options);
  assert.notEqual(changedFixture.digests.fixtureDigest, prepared.digests.fixtureDigest, 'the non-primary fixture must also be bound');
});

test('preparation requires the complete declared Skill set and matching physical identities', async (t) => {
  const { options } = await makeCase(t, 'database-migration-audit-log-collision-01');
  for (const [name, generatedSkills] of [
    ['missing all payloads', undefined],
    ['empty payload set', {}],
    ['missing contributor', { 'database-migration': options.generatedSkills['database-migration'] }],
    ['extra contributor', { ...options.generatedSkills, deployment: options.generatedSkills['audit-log'] }],
    ['invalid payload map', []],
    ['wrong directory identity', { ...options.generatedSkills, 'audit-log': options.generatedSkills['database-migration'] }],
  ]) {
    await t.test(name, async () => {
      await assert.rejects(prepareTriggerCase(options.caseId, { ...options, generatedSkills }), { code: 'SKILL_IDENTITY' });
    });
  }
  await t.test('wrong fixture identity', async () => {
    const fixtureRoots = { ...options.fixtureRoots, '12-flyway-database-migration': options.fixtureRoots['13-audit-log'] };
    await assert.rejects(prepareTriggerCase(options.caseId, { ...options, fixtureRoots }), { code: 'FIXTURE_IDENTITY' });
  });
  await t.test('wrong Skill metadata identity', async () => {
    const skillPath = path.join(options.generatedSkills['audit-log'], 'SKILL.md');
    const original = await readFile(skillPath, 'utf8');
    await writeFile(skillPath, original.replace('name: audit-log', 'name: database-migration'));
    try {
      await assert.rejects(prepareTriggerCase(options.caseId, options), { code: 'SKILL_IDENTITY' });
    } finally {
      await writeFile(skillPath, original);
    }
  });
});

test('versioned corpus covers each selected fixture Skill and rejects invalid declarations', async (t) => {
  const corpus = await loadTriggerCorpus();
  const coverage = new Map();
  for (const entry of corpus.cases) {
    for (const [name, fixtureId] of Object.entries(entry.skillFixtures)) {
      const key = `${fixtureId}:${name}`;
      if (!coverage.has(key)) coverage.set(key, new Set());
      coverage.get(key).add(entry.category);
    }
  }
  assert.deepEqual([...coverage.keys()].sort(), [
    '03-node-pnpm:build-verify',
    '11-maven-multi-module-build-verify:build-verify',
    '12-flyway-database-migration:database-migration',
    '13-audit-log:audit-log',
    '15-deployment:deployment',
  ]);
  for (const categories of coverage.values()) {
    assert.deepEqual([...categories].sort(), ['collision', 'near-miss', 'negative', 'positive']);
  }
  const { sandbox } = await makeCase(t, 'database-migration-positive-01');
  const source = JSON.parse(await readFile(corpusPath, 'utf8'));
  const mutations = [
    ['corpus version', 'CORPUS_SCHEMA', (data) => { data.schemaVersion = 2; }],
    ['case version', 'CORPUS_SCHEMA', (data) => { data.cases[0].schemaVersion = 2; }],
    ['duplicate case', 'CORPUS_IDENTITY', (data) => { data.cases.push(structuredClone(data.cases[0])); }],
    ['unknown fixture', 'CORPUS_IDENTITY', (data) => { data.cases[0].fixture = '99-invented'; }],
    ['unknown category', 'CORPUS_CATEGORY', (data) => { data.cases[0].category = 'close-enough'; }],
    ['missing category', 'CORPUS_CATEGORY', (data) => { delete data.cases[0].category; }],
    ['blank prompt', 'CORPUS_SCHEMA', (data) => { data.cases[0].prompt = ' '; }],
    ['unknown Skill', 'CORPUS_SKILL_IDENTITY', (data) => { data.cases[0].skillFixtures.redis = '14-redis-no-skill'; }],
    ['wrong Skill source', 'CORPUS_SKILL_IDENTITY', (data) => { data.cases[0].skillFixtures['build-verify'] = '12-flyway-database-migration'; }],
    ['unknown expected Skill', 'CORPUS_EXPECTATION', (data) => { data.cases[0].expected.mustLoad = ['redis']; }],
    ['contradictory expectation', 'CORPUS_EXPECTATION', (data) => { data.cases[0].expected.mustNotLoad.push('build-verify'); }],
    ['duplicate expectation', 'CORPUS_EXPECTATION', (data) => { data.cases[0].expected.mustLoad.push('build-verify'); }],
    ['unknown expectation field', 'CORPUS_EXPECTATION', (data) => { data.cases[0].expected.allowAny = true; }],
    ['missing expectation list', 'CORPUS_EXPECTATION', (data) => { delete data.cases[0].expected.mustNotLoad; }],
    ['empty positive expectation', 'CORPUS_CATEGORY', (data) => { data.cases[0].expected.mustLoad = []; data.cases[0].expected.mustNotLoad.push('build-verify'); }],
    ['missing category coverage', 'CORPUS_COVERAGE', (data) => { data.cases = data.cases.filter((entry) => entry.id !== 'node-build-verify-near-miss-01'); }],
    ['forbidden Skill is not positive coverage', 'CORPUS_COVERAGE', (data) => {
      data.cases = data.cases.filter((entry) => entry.id !== 'audit-log-positive-01');
      data.cases.find((entry) => entry.id === 'database-migration-positive-01').skillFixtures['audit-log'] = '13-audit-log';
    }],
  ];
  for (const [name, code, mutate] of mutations) {
    await t.test(name, async () => {
      const mutation = structuredClone(source);
      mutate(mutation);
      const mutatedPath = path.join(sandbox, 'mutated-corpus.json');
      await writeFile(mutatedPath, JSON.stringify(mutation));
      await assert.rejects(loadTriggerCorpus({ corpusPath: mutatedPath }), { code });
    });
  }
});

test('artifact identity must match the requested authoritative case and fixture', async (t) => {
  const { options } = await makeCase(t, 'database-migration-positive-01');
  const prepared = await prepareTriggerCase(options.caseId, options);
  const artifact = record(prepared, ['database-migration']);
  for (const [field, value] of [['caseId', 'database-migration-negative-01'], ['fixtureId', '13-audit-log']]) {
    await t.test(field, async () => {
      assertFailure(await evaluateTriggerArtifact({ ...artifact, [field]: value }, options), 'ARTIFACT_IDENTITY');
    });
  }
});

test('artifact expected values cannot replace authoritative corpus expectations', async (t) => {
  const { options } = await makeCase(t, 'database-migration-positive-01');
  const prepared = await prepareTriggerCase(options.caseId, options);
  const artifact = record(prepared, ['database-migration']);
  for (const [name, expected] of [
    ['erased', { mustLoad: [], mustNotLoad: [] }],
    ['forged', { mustLoad: ['audit-log'], mustNotLoad: ['database-migration'] }],
    ['contradictory', { mustLoad: ['database-migration'], mustNotLoad: ['database-migration'] }],
    ['unknown Skill', { mustLoad: ['redis'], mustNotLoad: [] }],
    ['unknown expectation', { ...artifact.expected, allowAny: true }],
  ]) {
    await t.test(name, async () => {
      assertFailure(await evaluateTriggerArtifact({ ...artifact, expected }, options), 'ARTIFACT_EXPECTATION');
    });
  }
  const reordered = { mustLoad: ['database-migration'], mustNotLoad: ['deployment', 'audit-log', 'build-verify'] };
  const result = await evaluateTriggerArtifact({ ...artifact, expected: reordered }, options);
  assert.equal(result.ok, true, result.errors.join('\n'));
});

test('claimed results must agree with authoritative observed selection', async (t) => {
  const { options } = await makeCase(t, 'database-migration-positive-01');
  const prepared = await prepareTriggerCase(options.caseId, options);
  const artifact = record(prepared, ['database-migration']);
  for (const [name, mutation] of [
    ['claimed fail for a passing observation', { ...artifact, result: 'fail' }],
    ['claimed pass with a missing Skill', { ...artifact, observed: { loaded: [] } }],
    ['claimed pass with a forbidden Skill', { ...artifact, observed: { loaded: ['database-migration', 'build-verify'] } }],
  ]) {
    await t.test(name, async () => {
      assertFailure(await evaluateTriggerArtifact(mutation, options), 'ARTIFACT_RESULT');
    });
  }
  const honestFailure = await evaluateTriggerArtifact(record(prepared, []), options);
  assertFailure(honestFailure, 'MISSING_SKILL');
  assert.equal(honestFailure.result, 'fail');
  assert.equal(honestFailure.errors.some((message) => message.startsWith('ARTIFACT_RESULT:')), false);
});

test('selection evidence is explicit and parseable, and valid empty observations remain usable', async (t) => {
  const { options } = await makeCase(t, 'database-migration-negative-01');
  const prepared = await prepareTriggerCase(options.caseId, options);
  const observation = { harness: 'claude-code', harnessVersion: 'synthetic-test-1', recordedAt };
  for (const [name, selectionEvidence] of [
    ['missing', undefined], ['null', null], ['unparseable JSON', '{"loaded":'],
    ['empty text', ''], ['parsed null', 'null'], ['parsed array', '[]'],
    ['missing loaded list', {}], ['string loaded list', { loaded: 'database-migration' }],
    ['null loaded list', { loaded: null }], ['unknown Skill', { loaded: ['redis'] }],
    ['duplicate Skill', { loaded: ['database-migration', 'database-migration'] }],
    ['invalid name', { loaded: ['../database-migration'] }],
  ]) {
    await t.test(name, () => {
      assert.throws(() => createTriggerArtifact(prepared, { ...observation, selectionEvidence }), { code: 'SELECTION_EVIDENCE' });
    });
  }
  for (const selectionEvidence of [{ loaded: [] }, '{"loaded":[]}']) {
    const artifact = createTriggerArtifact(prepared, { ...observation, selectionEvidence });
    assert.deepEqual(artifact.observed, { loaded: [] });
    assert.equal(artifact.result, 'pass');
    const result = await evaluateTriggerArtifact(artifact, options);
    assert.equal(result.ok, true, result.errors.join('\n'));
  }
  const clean = createTriggerArtifact(prepared, {
    ...observation,
    selectionEvidence: { loaded: [], unrelatedConversation: 'Synthetic unrelated text: do not record.' },
  });
  assert.deepEqual(clean.observed, { loaded: [] });
  for (const observed of [undefined, null, [], {}, { loaded: null }, { loaded: 'database-migration' }, { loaded: ['redis'] }, { loaded: ['audit-log', 'audit-log'] }]) {
    assertFailure(await evaluateTriggerArtifact({ ...clean, observed }, options), 'SELECTION_EVIDENCE');
  }
});

test('artifact schema mutations fail for their intended reason', async (t) => {
  const { options } = await makeCase(t, 'database-migration-positive-01');
  const prepared = await prepareTriggerCase(options.caseId, options);
  const artifact = record(prepared, ['database-migration']);
  for (const field of Object.keys(artifact)) {
    await t.test(`missing ${field}`, async () => {
      const mutation = structuredClone(artifact);
      delete mutation[field];
      const result = await evaluateTriggerArtifact(mutation, options);
      assertFailure(result, field === 'observed' ? 'SELECTION_EVIDENCE' : 'ARTIFACT_SCHEMA');
    });
  }
  for (const [field, value] of [
    ['schemaVersion', 2],
    ['harness', 'cursor'],
    ['harnessVersion', '   '],
    ['caseId', 42],
    ['fixtureId', ''],
    ['expected', { mustLoad: 'database-migration', mustNotLoad: [] }],
    ['result', 'qualified'],
    ['recordedAt', 'not-a-timestamp'],
    ['recordedAt', '2026-02-30T12:00:00.000Z'],
    ['motherSkillDigest', 'sha256:not-a-digest'],
    ['generatedSkillDigest', 'tree-sha256:' + 'a'.repeat(64)],
    ['fixtureDigest', null],
    ['triggerCorpusDigest', 42],
  ]) {
    await t.test(`${field}: ${JSON.stringify(value)}`, async () => {
      const mutation = { ...artifact, [field]: value };
      assertFailure(await evaluateTriggerArtifact(mutation, options), 'ARTIFACT_SCHEMA');
    });
  }
});
