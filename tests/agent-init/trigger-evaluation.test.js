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
const migrationInvocation = {
  mode: 'explicit',
  skill: 'database-migration',
  prompt: '$database-migration\nAdd the next append-only Flyway migration for the orders schema and run the documented migration validation checks.',
};

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
  const triggerCase = [...corpus.cases, ...(corpus.explicitProbes ?? [])].find((entry) => entry.id === caseId);
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
  assert.equal(result.claims.claudeCodeBehaviorProven, false);
  assert.equal(result.claims.codexBehaviorProven, false);
}

function explicitObservation(invocation, loaded) {
  return {
    harness: 'codex', harnessVersion: 'synthetic-test-1', recordedAt,
    invocation: structuredClone(invocation), selectionEvidence: { loaded },
  };
}

test('Codex explicit probes are enumerated separately from the 21 implicit cases', async () => {
  const corpus = await loadTriggerCorpus();
  assert.equal(corpus.cases.length, 21);
  assert.deepEqual(corpus.explicitProbes?.map((entry) => [entry.id, entry.fixture, entry.invocation.skill]), [
    ['codex-node-build-verify-explicit-01', '03-node-pnpm', 'build-verify'],
    ['codex-maven-build-verify-explicit-01', '11-maven-multi-module-build-verify', 'build-verify'],
    ['codex-database-migration-explicit-01', '12-flyway-database-migration', 'database-migration'],
    ['codex-audit-log-explicit-01', '13-audit-log', 'audit-log'],
    ['codex-deployment-explicit-01', '15-deployment', 'deployment'],
  ]);
});

test('a legacy corpus without explicitProbes still exposes an empty separate collection', async (t) => {
  const { sandbox } = await makeCase(t, 'database-migration-positive-01');
  const legacy = JSON.parse(await readFile(corpusPath, 'utf8'));
  delete legacy.explicitProbes;
  const legacyPath = path.join(sandbox, 'legacy.json');
  await writeFile(legacyPath, JSON.stringify(legacy));
  const corpus = await loadTriggerCorpus({ corpusPath: legacyPath });
  assert.deepEqual(corpus.explicitProbes, []);
  assert.equal(corpus.cases.length, 21);
});

test('a Codex explicit probe round-trips a synthetic request-bound v2 artifact', async (t) => {
  const { sandbox, options } = await makeCase(t, 'codex-database-migration-explicit-01');
  const prepared = await prepareTriggerCase(options.caseId, options);
  const invocation = structuredClone(migrationInvocation);
  const artifact = createTriggerArtifact(prepared, {
    harness: 'codex', harnessVersion: 'synthetic-test-1',
    invocation, selectionEvidence: { loaded: ['database-migration'] }, recordedAt,
  });
  assert.equal(artifact.schemaVersion, 2);
  assert.equal(artifact.caseId, 'codex-database-migration-explicit-01');
  assert.equal(artifact.fixtureId, '12-flyway-database-migration');
  assert.deepEqual(artifact.invocation, migrationInvocation);
  invocation.prompt = 'Changed caller-owned request after recording.';
  assert.deepEqual(artifact.invocation, migrationInvocation);
  const artifactPath = path.join(sandbox, 'synthetic-explicit.json');
  await writeFile(artifactPath, JSON.stringify(artifact));
  const recorded = JSON.parse(await readFile(artifactPath, 'utf8'));
  assert.deepEqual(recorded, artifact);
  const result = await evaluateTriggerArtifact(recorded, options);
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.equal(result.result, 'pass');
  assert.deepEqual(result.claims, {
    localContractValidated: true,
    liveSkillBehaviorProven: false,
    claudeCodeBehaviorProven: false,
    codexBehaviorProven: false,
  });
});

test('an explicitProbes declaration must be an array when present', async (t) => {
  const { sandbox } = await makeCase(t, 'database-migration-positive-01');
  const source = JSON.parse(await readFile(corpusPath, 'utf8'));
  source.explicitProbes = null;
  const mutatedPath = path.join(sandbox, 'invalid-probes.json');
  await writeFile(mutatedPath, JSON.stringify(source));
  await assert.rejects(loadTriggerCorpus({ corpusPath: mutatedPath }), { code: 'CORPUS_SCHEMA' });
});

test('case IDs are unique across implicit cases and explicit probes', async (t) => {
  const { sandbox } = await makeCase(t, 'database-migration-positive-01');
  const source = JSON.parse(await readFile(corpusPath, 'utf8'));
  source.explicitProbes[0].id = source.cases[0].id;
  const mutatedPath = path.join(sandbox, 'duplicate-probe.json');
  await writeFile(mutatedPath, JSON.stringify(source));
  await assert.rejects(loadTriggerCorpus({ corpusPath: mutatedPath }), { code: 'CORPUS_IDENTITY' });
});

test('explicit probes require authoritative Codex invocation metadata', async (t) => {
  const { sandbox } = await makeCase(t, 'database-migration-positive-01');
  const source = JSON.parse(await readFile(corpusPath, 'utf8'));
  source.explicitProbes[0].invocation.mode = 'implicit';
  const mutatedPath = path.join(sandbox, 'invalid-invocation.json');
  await writeFile(mutatedPath, JSON.stringify(source));
  await assert.rejects(loadTriggerCorpus({ corpusPath: mutatedPath }), { code: 'CORPUS_INVOCATION' });
});

test('explicit request mutations fail in both the writer and independent consumer', async (t) => {
  const { options } = await makeCase(t, 'codex-database-migration-explicit-01');
  const prepared = await prepareTriggerCase(options.caseId, options);
  const observation = explicitObservation(migrationInvocation, ['database-migration']);
  const artifact = createTriggerArtifact(prepared, observation);
  const mutations = [
    ['missing invocation', (data) => { delete data.invocation; }],
    ['null invocation', (data) => { data.invocation = null; }],
    ['array invocation', (data) => { data.invocation = []; }],
    ['missing mode', (data) => { delete data.invocation.mode; }],
    ['wrong mode', (data) => { data.invocation.mode = 'implicit'; }],
    ['missing target', (data) => { delete data.invocation.skill; }],
    ['wrong target', (data) => { data.invocation.skill = 'audit-log'; }],
    ['missing prompt', (data) => { delete data.invocation.prompt; }],
    ['unrelated prompt', (data) => { data.invocation.prompt = 'Synthetic unrelated conversation: do not record.'; }],
    ['token without full request', (data) => { data.invocation.prompt = '$database-migration'; }],
    ['extra conversation', (data) => { data.invocation.unrelatedConversation = 'Synthetic unrelated conversation: do not record.'; }],
    ['wrong harness', (data) => { data.harness = 'claude-code'; }],
  ];
  for (const [name, mutate] of mutations) {
    await t.test(name, async () => {
      const changedObservation = structuredClone(observation);
      mutate(changedObservation);
      assert.throws(() => createTriggerArtifact(prepared, changedObservation), {
        code: 'INVOCATION_EVIDENCE',
        message: 'INVOCATION_EVIDENCE: codex-database-migration-explicit-01: invocation must match the authoritative case and harness',
      });
      const changedArtifact = structuredClone(artifact);
      mutate(changedArtifact);
      const result = await evaluateTriggerArtifact(changedArtifact, options);
      assert.deepEqual(result.errors, ['INVOCATION_EVIDENCE: invocation must match the authoritative case and harness']);
      assertFailure(result, 'INVOCATION_EVIDENCE');
    });
  }
  await t.test('explicit v1 downgrade', async () => {
    const result = await evaluateTriggerArtifact({ ...artifact, schemaVersion: 1 }, options);
    assert.deepEqual(result.errors, ['ARTIFACT_SCHEMA: schemaVersion must be 2']);
    assertFailure(result, 'ARTIFACT_SCHEMA');
  });
});

test('explicit requests reject inherited fields paired with extra conversation', async (t) => {
  const { options } = await makeCase(t, 'codex-database-migration-explicit-01');
  const prepared = await prepareTriggerCase(options.caseId, options);
  const inherited = () => Object.assign(Object.create({ mode: 'explicit' }), {
    skill: migrationInvocation.skill, prompt: migrationInvocation.prompt,
    unrelatedConversation: 'Synthetic unrelated conversation: do not record.',
  });
  await t.test('writer rejects instead of recording extra conversation', () => {
    assert.throws(() => createTriggerArtifact(prepared, {
      ...explicitObservation(migrationInvocation, ['database-migration']), invocation: inherited(),
    }), { code: 'INVOCATION_EVIDENCE' });
  });
  await t.test('consumer independently rejects inherited fields', async () => {
    const artifact = createTriggerArtifact(prepared, explicitObservation(migrationInvocation, ['database-migration']));
    assertFailure(await evaluateTriggerArtifact({ ...artifact, invocation: inherited() }, options), 'INVOCATION_EVIDENCE');
  });
});

test('explicit requests reject hidden or symbol fields rather than normalizing an invalid field set', async (t) => {
  const { options } = await makeCase(t, 'codex-database-migration-explicit-01');
  const prepared = await prepareTriggerCase(options.caseId, options);
  const artifact = createTriggerArtifact(prepared, explicitObservation(migrationInvocation, ['database-migration']));
  const variants = [
    ['hidden required field with extra conversation', () => Object.defineProperty({
      skill: migrationInvocation.skill, prompt: migrationInvocation.prompt,
      unrelatedConversation: 'Synthetic unrelated conversation: do not record.',
    }, 'mode', { value: 'explicit' })],
    ['hidden extra field', () => Object.defineProperty(structuredClone(migrationInvocation),
      'unrelatedConversation', { value: 'Synthetic unrelated conversation: do not record.' })],
    ['symbol extra field', () => ({ ...migrationInvocation, [Symbol('unrelatedConversation')]: 'Synthetic unrelated conversation: do not record.' })],
  ];
  for (const [name, invocation] of variants) {
    await t.test(`${name}: writer`, () => {
      assert.throws(() => createTriggerArtifact(prepared, {
        ...explicitObservation(migrationInvocation, ['database-migration']), invocation: invocation(),
      }), { code: 'INVOCATION_EVIDENCE' });
    });
    await t.test(`${name}: consumer`, async () => {
      assertFailure(await evaluateTriggerArtifact({ ...artifact, invocation: invocation() }, options), 'INVOCATION_EVIDENCE');
    });
  }
});

test('the writer validates and stores the same explicit request snapshot', async (t) => {
  const { options } = await makeCase(t, 'codex-database-migration-explicit-01');
  const prepared = await prepareTriggerCase(options.caseId, options);
  let reads = 0;
  const invocation = {
    mode: 'explicit', skill: 'database-migration',
    get prompt() {
      reads += 1;
      return reads === 1 ? migrationInvocation.prompt : 'Synthetic unrelated conversation: do not record.';
    },
  };
  const artifact = createTriggerArtifact(prepared, {
    ...explicitObservation(migrationInvocation, ['database-migration']), invocation,
  });
  assert.deepEqual(artifact.invocation, migrationInvocation);
  assert.equal(reads, 1);
  const result = await evaluateTriggerArtifact(artifact, options);
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.equal(result.claims.codexBehaviorProven, false);
});

test('implicit cases cannot receive explicit request descriptors', async (t) => {
  const { options } = await makeCase(t, 'database-migration-positive-01');
  const prepared = await prepareTriggerCase(options.caseId, options);
  assert.throws(() => createTriggerArtifact(prepared, explicitObservation(migrationInvocation, ['database-migration'])), {
    code: 'INVOCATION_EVIDENCE',
  });
  const artifact = record(prepared, ['database-migration'], 'codex');
  assert.equal(Object.hasOwn(artifact, 'invocation'), false);
  for (const invocation of [migrationInvocation, undefined, null]) {
    assertFailure(await evaluateTriggerArtifact({ ...artifact, invocation }, options), 'INVOCATION_EVIDENCE');
  }
});

test('explicit declarations retain shared identity and expectation guards without supplying implicit coverage', async (t) => {
  const { sandbox } = await makeCase(t, 'database-migration-positive-01');
  const source = JSON.parse(await readFile(corpusPath, 'utf8'));
  const mutations = [
    ['non-array collection', 'CORPUS_SCHEMA', (data) => { data.explicitProbes = {}; }],
    ['null entry', 'CORPUS_SCHEMA', (data) => { data.explicitProbes[0] = null; }],
    ['probe version', 'CORPUS_SCHEMA', (data) => { data.explicitProbes[0].schemaVersion = 2; }],
    ['blank prompt', 'CORPUS_SCHEMA', (data) => { data.explicitProbes[0].prompt = ' '; }],
    ['duplicate probes', 'CORPUS_IDENTITY', (data) => { data.explicitProbes.push(structuredClone(data.explicitProbes[0])); }],
    ['unknown fixture', 'CORPUS_IDENTITY', (data) => { data.explicitProbes[0].fixture = '99-invented'; }],
    ['different primary source', 'CORPUS_IDENTITY', (data) => { data.explicitProbes[0].fixture = '13-audit-log'; }],
    ['wrong Skill source', 'CORPUS_SKILL_IDENTITY', (data) => { data.explicitProbes[0].skillFixtures['build-verify'] = '12-flyway-database-migration'; }],
    ['unknown expected Skill', 'CORPUS_EXPECTATION', (data) => { data.explicitProbes[0].expected.mustLoad = ['redis']; }],
    ['empty positive expectation', 'CORPUS_CATEGORY', (data) => { data.explicitProbes[0].expected.mustLoad = []; data.explicitProbes[0].expected.mustNotLoad.push('build-verify'); }],
    ['missing invocation', 'CORPUS_INVOCATION', (data) => { delete data.explicitProbes[0].invocation; }],
    ['extra invocation field', 'CORPUS_INVOCATION', (data) => { data.explicitProbes[0].invocation.allowAny = true; }],
    ['missing mode', 'CORPUS_INVOCATION', (data) => { delete data.explicitProbes[0].invocation.mode; }],
    ['wrong harness', 'CORPUS_INVOCATION', (data) => { data.explicitProbes[0].invocation.harness = 'claude-code'; }],
    ['missing harness', 'CORPUS_INVOCATION', (data) => { delete data.explicitProbes[0].invocation.harness; }],
    ['missing target', 'CORPUS_INVOCATION', (data) => { delete data.explicitProbes[0].invocation.skill; }],
    ['undeclared target', 'CORPUS_INVOCATION', (data) => { data.explicitProbes[0].invocation.skill = 'audit-log'; }],
    ['unknown target', 'CORPUS_INVOCATION', (data) => { data.explicitProbes[0].invocation.skill = 'redis'; }],
    ['implicit prompt', 'CORPUS_INVOCATION', (data) => { data.explicitProbes[0].prompt = data.cases[0].prompt; }],
    ['wrong token', 'CORPUS_INVOCATION', (data) => { data.explicitProbes[0].prompt = '$audit-log\nValidate the code change.'; }],
    ['hyphenated prefix impostor', 'CORPUS_INVOCATION', (data) => { data.explicitProbes[0].prompt = '$build-verify-extra\nValidate the code change.'; }],
    ['unseparated token', 'CORPUS_INVOCATION', (data) => { data.explicitProbes[0].prompt = '$build-verify_extra\nValidate the code change.'; }],
    ['multiple mustLoad targets', 'CORPUS_INVOCATION', (data) => {
      const probe = data.explicitProbes[0];
      probe.skillFixtures['audit-log'] = '13-audit-log';
      probe.expected.mustLoad.push('audit-log');
      probe.expected.mustNotLoad = probe.expected.mustNotLoad.filter((name) => name !== 'audit-log');
    }],
    ['non-positive probe', 'CORPUS_INVOCATION', (data) => {
      const probe = data.explicitProbes[0];
      probe.category = 'collision';
      probe.skillFixtures['audit-log'] = '13-audit-log';
    }],
    ['explicit probe in cases', 'CORPUS_INVOCATION', (data) => { data.cases.push(data.explicitProbes.pop()); }],
    ['explicit token disguised as implicit', 'CORPUS_INVOCATION', (data) => {
      const probe = data.explicitProbes.pop();
      delete probe.invocation;
      data.cases.push(probe);
    }],
    ['implicit invocation descriptor', 'CORPUS_INVOCATION', (data) => { data.cases[0].invocation = null; }],
    ['explicit does not replace implicit positive', 'CORPUS_COVERAGE', (data) => {
      data.cases = data.cases.filter((entry) => entry.id !== 'node-build-verify-positive-01');
    }],
  ];
  for (const [name, code, mutate] of mutations) {
    await t.test(name, async () => {
      const changed = structuredClone(source);
      mutate(changed);
      const mutatedPath = path.join(sandbox, 'mutated-explicit-corpus.json');
      await writeFile(mutatedPath, JSON.stringify(changed));
      await assert.rejects(loadTriggerCorpus({ corpusPath: mutatedPath }), { code });
    });
  }
});

test('all five Codex variants round-trip independent synthetic requests without merging build-verify identities', async (t) => {
  const samples = [
    ['codex-node-build-verify-explicit-01', '03-node-pnpm', 'build-verify',
      '$build-verify\nValidate this code change using the repository\'s ordered lint and test workflow.'],
    ['codex-maven-build-verify-explicit-01', '11-maven-multi-module-build-verify', 'build-verify',
      '$build-verify\nValidate this change to services/api together with its required upstream modules using the documented Maven verification workflow.'],
    ['codex-database-migration-explicit-01', '12-flyway-database-migration', 'database-migration', migrationInvocation.prompt],
    ['codex-audit-log-explicit-01', '13-audit-log', 'audit-log',
      '$audit-log\nChange an auditable domain operation, preserving actor, action, and resource in its audit event, and verify the audit contract.'],
    ['codex-deployment-explicit-01', '15-deployment', 'deployment',
      '$deployment\nUse the documented staging deployment procedure, including its build step and staging smoke verification.'],
  ];
  const artifacts = new Map();
  for (const [caseId, fixtureId, skill, prompt] of samples) {
    await t.test(caseId, async (t) => {
      const { sandbox, options } = await makeCase(t, caseId);
      const prepared = await prepareTriggerCase(caseId, options);
      assert.deepEqual(prepared.fixtureIds, [fixtureId]);
      const artifact = createTriggerArtifact(prepared, explicitObservation({ mode: 'explicit', skill, prompt }, [skill]));
      assert.equal(artifact.schemaVersion, 2);
      assert.equal(artifact.harness, 'codex');
      assert.equal(artifact.fixtureId, fixtureId);
      assert.deepEqual(artifact.invocation, { mode: 'explicit', skill, prompt });
      const artifactPath = path.join(sandbox, 'synthetic-explicit.json');
      await writeFile(artifactPath, JSON.stringify(artifact));
      const recorded = JSON.parse(await readFile(artifactPath, 'utf8'));
      assert.deepEqual(recorded, artifact);
      const result = await evaluateTriggerArtifact(recorded, options);
      assert.equal(result.ok, true, result.errors.join('\n'));
      assert.deepEqual(result.claims, {
        localContractValidated: true,
        liveSkillBehaviorProven: false,
        claudeCodeBehaviorProven: false,
        codexBehaviorProven: false,
      });
      artifacts.set(caseId, artifact);
    });
  }
  const node = artifacts.get('codex-node-build-verify-explicit-01');
  const maven = artifacts.get('codex-maven-build-verify-explicit-01');
  assert.notEqual(node.generatedSkillDigest, maven.generatedSkillDigest);
  assert.notEqual(node.fixtureDigest, maven.fixtureDigest);
  const { options } = await makeCase(t, 'codex-maven-build-verify-explicit-01');
  assertFailure(await evaluateTriggerArtifact(node, options), 'ARTIFACT_IDENTITY');
  const renamed = { ...node, caseId: maven.caseId, fixtureId: maven.fixtureId, invocation: maven.invocation };
  assertFailure(await evaluateTriggerArtifact(renamed, options), 'ARTIFACT_DIGEST');
});

test('explicit artifacts bind all four digests and detect corpus changes before request mismatch', async (t) => {
  const { sandbox, options } = await makeCase(t, 'codex-database-migration-explicit-01');
  options.corpusPath = path.join(sandbox, 'explicit-corpus.json');
  const bytes = await readFile(corpusPath);
  await writeFile(options.corpusPath, bytes);
  const prepared = await prepareTriggerCase(options.caseId, options);
  const artifact = createTriggerArtifact(prepared, explicitObservation(migrationInvocation, ['database-migration']));
  for (const field of ['motherSkillDigest', 'generatedSkillDigest', 'fixtureDigest', 'triggerCorpusDigest']) {
    await t.test(`forged ${field}`, async () => {
      const result = await evaluateTriggerArtifact({ ...artifact, [field]: 'sha256:' + 'a'.repeat(64) }, options);
      assert.deepEqual(result.errors, [`ARTIFACT_DIGEST: ${field} does not match the current case inputs`]);
      assertFailure(result, 'ARTIFACT_DIGEST');
    });
  }
  for (const [name, changedBytes] of [
    ['raw bytes only', Buffer.concat([bytes, Buffer.from('\n')])],
    ['authoritative prompt', (() => {
      const corpus = JSON.parse(bytes);
      corpus.explicitProbes.find((entry) => entry.id === options.caseId).prompt += '\nKeep the append-only history intact.';
      return Buffer.from(JSON.stringify(corpus));
    })()],
  ]) {
    await t.test(name, async () => {
      await writeFile(options.corpusPath, changedBytes);
      const result = await evaluateTriggerArtifact(artifact, options);
      assert.deepEqual(result.errors, ['ARTIFACT_DIGEST: triggerCorpusDigest does not match the current case inputs']);
      assertFailure(result, 'ARTIFACT_DIGEST');
    });
  }
});

test('explicit preparation still requires every declared generated contributor', async (t) => {
  const { sandbox, options } = await makeCase(t, 'database-migration-audit-log-collision-01');
  const source = JSON.parse(await readFile(corpusPath, 'utf8'));
  source.explicitProbes.find((entry) => entry.id === 'codex-database-migration-explicit-01')
    .skillFixtures['audit-log'] = '13-audit-log';
  options.corpusPath = path.join(sandbox, 'multi-source-explicit.json');
  await writeFile(options.corpusPath, JSON.stringify(source));
  options.caseId = 'codex-database-migration-explicit-01';
  await assert.rejects(prepareTriggerCase(options.caseId, {
    ...options, generatedSkills: { 'database-migration': options.generatedSkills['database-migration'] },
  }), { code: 'SKILL_IDENTITY' });
  const prepared = await prepareTriggerCase(options.caseId, options);
  assert.deepEqual(prepared.fixtureIds, ['12-flyway-database-migration', '13-audit-log']);
  const artifact = createTriggerArtifact(prepared, explicitObservation(migrationInvocation, ['database-migration']));
  const result = await evaluateTriggerArtifact(artifact, options);
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.equal(result.claims.codexBehaviorProven, false);
});

test('explicit request success never substitutes for actual selection or hides a mismatch', async (t) => {
  const { options } = await makeCase(t, 'codex-database-migration-explicit-01');
  const prepared = await prepareTriggerCase(options.caseId, options);
  for (const [name, loaded, code] of [
    ['no Skill loaded', [], 'MISSING_SKILL'],
    ['unexpected Skill also loaded', ['database-migration', 'deployment'], 'FORBIDDEN_SKILL'],
  ]) {
    await t.test(name, async () => {
      const artifact = createTriggerArtifact(prepared, explicitObservation(migrationInvocation, loaded));
      assert.deepEqual(artifact.observed.loaded, loaded);
      assert.equal(artifact.result, 'fail');
      const result = await evaluateTriggerArtifact(artifact, options);
      assertFailure(result, code);
      assert.equal(result.result, 'fail');
      assert.equal(result.errors.some((error) => error.startsWith('ARTIFACT_RESULT:')), false);
      assertFailure(await evaluateTriggerArtifact({ ...artifact, result: 'pass' }, options), 'ARTIFACT_RESULT');
    });
  }
  for (const selectionEvidence of [undefined, '{"loaded":', {}, { loaded: ['redis'] }, { loaded: ['database-migration', 'database-migration'] }]) {
    assert.throws(() => createTriggerArtifact(prepared, {
      ...explicitObservation(migrationInvocation, ['database-migration']), selectionEvidence,
    }), { code: 'SELECTION_EVIDENCE' });
  }
});

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
