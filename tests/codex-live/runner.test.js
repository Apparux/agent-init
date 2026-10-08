import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cp, link, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { SYNTHETIC_PROGRAM } from './app-server.js';
import { digestProposal, fingerprintPath, renderExactDiff } from '../agent-init/evaluation-harness.js';
import { loadTriggerCorpus } from '../agent-init/trigger-evaluation.js';
import { runCodex } from './runner.js';
import { inventoryCodexTree } from './owned-runtime.js';
import { readRegularFileNoFollow } from '../../src/installation/filesystem.js';
import { NODE_SKILL, SYNTHETIC_SELECTIONS, writeSyntheticRouting, writeSyntheticSetup } from './support/synthetic-scenarios.js';

async function writeQuotedSetup(root, cwd, fixture, mutate = () => {}) {
  const citations = new Map();
  for (const entry of fixture.evidence) {
    let stat;
    try { stat = await lstat(path.join(cwd, entry.sourcePath)); }
    catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
    const type = !stat ? 'missing' : stat.isDirectory() ? 'directory' : 'file';
    if (type !== 'file' || entry.sourceLocation === 'presence' || path.posix.basename(entry.sourcePath).startsWith('.env')) {
      citations.set(entry.id, { kind: 'presence', type });
    } else {
      const bytes = await readFile(path.join(cwd, entry.sourcePath));
      citations.set(entry.id, { kind: 'bytes', start: 0, end: bytes.length, quote: bytes.toString('utf8') });
    }
  }
  return writeSyntheticSetup(root, cwd, fixture, (scenario) => {
    for (const entry of scenario.proposal.record.evidenceLedger) {
      entry.fact = 'The inspected repository file supports this project-specific fact.';
      entry.observation = 'I inspected this source without repeating hidden fixture narration.';
      entry.whyItMatters = 'This source informs the project-specific decision.';
      entry.sourceCitation = citations.get(entry.id);
    }
    mutate(scenario);
  });
}

test('Codex runner performs actual owned installation but missing captured machine record cannot approve or write', async () => {
  let approvals = 0;
  let ownedRoot;
  const result = await runCodex({ mode: 'synthetic', fixtureIds: ['03-node-pnpm'], caseIds: [] }, {
    launch: ({ root }) => {
      ownedRoot = root;
      return { command: process.execPath, args: [SYNTHETIC_PROGRAM] };
    },
    approve: () => { approvals++; throw new Error('Must not ask approval for missing Proposal'); },
  });
  assert.equal(result.synthetic, true);
  assert.equal(result.status, 'failed');
  assert.equal(result.phase, 'setup-proposal');
  assert.equal(result.error.code, 'MACHINE_RECORD');
  assert.equal(approvals, 0);
  assert.equal(result.claims.nativeExecution, false);
  assert.equal(result.claims.liveEndToEnd, false);
  assert.equal(result.cleanup.removed, true);
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].processGroupAbsent, true);
  await assert.rejects(lstat(ownedRoot), { code: 'ENOENT' });
});

test('Codex runner captures an exact reject and actually performs a second read-only reconcile without Apply', async () => {
  const corpus = await loadTriggerCorpus();
  const fixture = corpus.fixtures.get('03-node-pnpm').fixture;
  const result = await runCodex({ mode: 'synthetic', fixtureIds: [fixture.id], caseIds: [] }, {
    launch: async ({ root, cwd }) => ({
      command: process.execPath, args: [SYNTHETIC_PROGRAM, `--scenario=${await writeSyntheticSetup(root, cwd, fixture)}`],
    }),
    approve: ({ proposal }) => ({
      decision: 'reject', scope: 'exact-proposal', proposalId: proposal.id, revision: proposal.revision,
      proposalDigest: digestProposal(proposal), approvedActionIds: [],
    }),
  });
  assert.equal(result.status, 'synthetic-pass', JSON.stringify({ error: result.error, phase: result.phase, sessions: result.sessions }));
  assert.equal(result.setups.length, 1);
  assert.equal(result.setups[0].evaluation.ok, true, result.setups[0].evaluation.errors.join('\n'));
  assert.equal(result.setups[0].record.events.filter((event) => event.type === 'write').length, 0);
  assert.equal(result.setups[0].turns.length, 3);
  assert.equal(result.setups[0].record.events.at(-1).type, 'reconcile');
  assert.equal(result.setups[0].reconcileZeroDelta, true);
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].processGroupAbsent, true);
  assert.equal(result.cleanup.removed, true);
  assert.equal(result.claims.liveEndToEnd, false);
});

test('Codex exact subset approval lets the synthetic actor Apply only the approved full Skill payload', async () => {
  const fixture = (await loadTriggerCorpus()).fixtures.get('03-node-pnpm').fixture;
  const result = await runCodex({ mode: 'synthetic', fixtureIds: [fixture.id], caseIds: [] }, {
    launch: async ({ root, cwd }) => ({
      command: process.execPath, args: [SYNTHETIC_PROGRAM, `--scenario=${await writeSyntheticSetup(root, cwd, fixture, (scenario) => {
        const proposal = scenario.proposal.record.events.at(-1);
        proposal.actions.push({
          id: 'synthetic-agents', action: 'CREATE', kind: 'agents', target: 'AGENTS.md',
          reason: 'Synthetic package manager constraint.', evidenceIds: ['ev-pnpm'], baselineFingerprint: 'missing', proposedContent: 'Use pnpm for this repository.\n',
        });
        scenario.proposal.summary.actionIds.push('synthetic-agents');
        scenario.proposal.audit.proposalDigest = digestProposal(proposal);
      })}`],
    }),
    approve: ({ proposal, proposalDigest }) => ({
      decision: 'approve', scope: 'exact-proposal', proposalId: proposal.id, revision: proposal.revision,
      proposalDigest, approvedActionIds: ['synthetic-node-skill'],
    }),
  });
  assert.equal(result.status, 'synthetic-pass', JSON.stringify(result.error));
  assert.equal(result.setups[0].evaluation.ok, true, result.setups[0].evaluation.errors.join('\n'));
  assert.deepEqual(result.setups[0].record.events.filter((event) => event.type === 'write').map((event) => event.actionId), ['synthetic-node-skill']);
  assert.equal(result.setups[0].generatedSkills[0].name, 'build-verify');
  assert.equal(result.setups[0].generatedSkills[0].content, NODE_SKILL);
  assert.equal(result.cleanup.removed, true);
  assert.equal(result.claims.nativeExecution, false);
});

test('actual setup requests define fixture identity and phase schemas without transmitting oracle answers', async () => {
  const fixture = (await loadTriggerCorpus()).fixtures.get('03-node-pnpm').fixture;
  const result = await runCodex({ mode: 'synthetic', fixtureIds: [fixture.id], caseIds: [] }, {
    launch: async ({ root, cwd }) => ({ command: process.execPath, args: [SYNTHETIC_PROGRAM, `--scenario=${await writeSyntheticSetup(root, cwd, fixture)}`] }),
    approve: ({ proposal, proposalDigest }) => ({ decision: 'reject', scope: 'exact-proposal', proposalId: proposal.id, revision: proposal.revision, proposalDigest, approvedActionIds: [] }),
  });
  assert.equal(result.status, 'synthetic-pass', JSON.stringify(result.error));
  const requests = result.setups[0].turns.map((turn) => turn.request.params);
  const task = JSON.parse(requests[0].input.find((input) => input.type === 'text').text);
  assert.equal(task.fixtureId, '03-node-pnpm');
  assert.deepEqual(task.contractLabels.evidenceSlots, [
    { id: 'ev-pnpm', sourcePath: 'package.json', sourceLocation: 'packageManager' },
    { id: 'ev-verify', sourcePath: 'package.json', sourceLocation: 'scripts.verify' },
  ]);
  assert.deepEqual(task.contractLabels.factSlots, [
    { id: 'fact-package-manager', evidenceIds: ['ev-pnpm'] }, { id: 'fact-verify', evidenceIds: ['ev-verify'] },
  ]);
  assert.deepEqual(task.contractLabels.unclassifiedQuestions, ['deployment-command']);
  const text = requests[0].input.find((input) => input.type === 'text').text;
  for (const answer of ['pnpm@9.0.0', 'pnpm lint && pnpm test', 'The repository declares pnpm 9.', '.agents/skills/build-verify/SKILL.md', 'deterministicEnforcementCandidate', 'expected', 'mustLoad']) assert.equal(text.includes(answer), false, answer);
  const schema = requests[0].outputSchema;
  assert.deepEqual(schema.required, ['schemaVersion', 'kind', 'record', 'summary', 'audit']);
  assert.equal(schema.properties.record.properties.fixtureId.const, '03-node-pnpm');
  assert.equal(schema.properties.record.properties.harness.const, 'recorded-contract');
  assert.equal(schema.properties.record.properties.evidenceLedger.items.required.includes('observation'), true);
  const events = schema.properties.record.properties.events.items.anyOf;
  assert.deepEqual(events.map((event) => event.properties.type.const), ['preflight', 'explore', 'profile', 'classify', 'skills', 'proposal']);
  assert.equal(events[2].properties.facts.items.properties.value.type.includes('array'), true);
  assert.deepEqual(events[4].properties.candidates.items.properties.reuseExisting.required, ['path', 'compatibility']);
  assert.equal(events[5].properties.actions.items.anyOf[0].required.includes('proposedContent'), true);
  assert.equal(events[5].properties.actions.items.anyOf[1].required.includes('proposedDiff'), true);
  assert.equal(requests[1].outputSchema.properties.kind.const, 'setup-validation');
  assert.equal(requests[1].outputSchema.properties.events.items.anyOf.at(-1).properties.type.const, 'validation');
  assert.equal(requests[2].outputSchema.properties.kind.const, 'setup-reconcile');
  assert.equal(requests[2].outputSchema.properties.event.properties.writes.type, 'array');
  assert.equal(result.cleanup.removed, true);
});

test('Codex measurement tools are published in fresh routing alongside implicit and explicit artifact inputs', async () => {
  const fixture = (await loadTriggerCorpus()).fixtures.get('03-node-pnpm').fixture;
  const result = await runCodex({ mode: 'synthetic', fixtureIds: [fixture.id], caseIds: ['node-build-verify-positive-01', 'codex-node-build-verify-explicit-01'] }, {
    launch: async ({ root, cwd, role, runId, sessionId, caseId, contributors }) => {
      const scenario = role === 'setup' ? await writeSyntheticSetup(root, cwd, fixture)
        : await writeSyntheticRouting(root, { runId, sessionId, caseId, contributors, loaded: ['build-verify'] });
      return { command: process.execPath, args: [SYNTHETIC_PROGRAM, `--scenario=${scenario}`] };
    },
    approve: ({ proposal, proposalDigest }) => ({ decision: 'approve', scope: 'exact-proposal', proposalId: proposal.id, revision: proposal.revision, proposalDigest, approvedActionIds: ['synthetic-node-skill'] }),
  });
  assert.equal(result.status, 'synthetic-pass', JSON.stringify(result.error));
  assert.equal(result.cases.length, 2);
  assert.equal(result.sessions.length, 3);
  assert.equal(new Set(result.sessions.map((entry) => entry.sessionId)).size, 3);
  assert.equal(new Set(result.sessions.map((entry) => entry.threadId)).size, 3);
  assert.equal(result.sessions[0].role, 'setup');
  assert.equal(result.sessions.slice(1).every((entry) => entry.role === 'trigger' && entry.processGroupAbsent), true);
  assert.equal(result.cases[0].artifact.harness, 'codex');
  assert.equal(Object.hasOwn(result.cases[0].artifact, 'invocation'), false);
  assert.equal(result.cases[1].artifact.schemaVersion, 2);
  assert.equal(result.cases[1].artifact.invocation.skill, 'build-verify');
  assert.equal(result.cases[1].artifact.invocation.prompt, result.cases[1].capture.request.params.input.find((entry) => entry.type === 'text').text);
  assert.equal(result.cases.every((entry) => entry.evaluation.ok && entry.synthetic && entry.contextObserved), true);
  for (const entry of result.cases) {
    const thread = entry.threadRequest.params;
    assert.deepEqual(thread.dynamicTools.map((spec) => spec.name), ['fingerprintPath', 'fingerprintRepository', 'digestProposal', 'renderExactDiff']);
    for (const spec of thread.dynamicTools) {
      assert.deepEqual(Object.keys(spec).sort(), ['description', 'inputSchema', 'name', 'type']);
      assert.equal(spec.type, 'function');
      assert.equal(spec.inputSchema.additionalProperties, false);
    }
    assert.equal(thread.sandbox, 'read-only');
  }
  assert.equal(result.claims.liveEndToEnd, false);
});

test('fresh routing serializes complete physical contributor context without preloading Skill instructions or changing the corpus prompt', async () => {
  const corpus = await loadTriggerCorpus();
  const fixtureIds = ['11-maven-multi-module-build-verify', '12-flyway-database-migration'];
  const caseIds = ['maven-build-verify-migration-collision-01', 'maven-build-verify-positive-01'];
  const result = await runCodex({ mode: 'synthetic', evidenceMode: 'source-bound', fixtureIds, caseIds }, {
    launch: async ({ root, cwd, fixtureId, role, runId, sessionId, caseId, contributors }) => ({
      command: process.execPath, args: [SYNTHETIC_PROGRAM, `--scenario=${role === 'setup'
        ? await writeQuotedSetup(root, cwd, corpus.fixtures.get(fixtureId).fixture)
        : await writeSyntheticRouting(root, { runId, sessionId, caseId, contributors, loaded: SYNTHETIC_SELECTIONS[caseId] })}`],
    }),
    approve: ({ proposal, proposalDigest }) => ({ decision: 'approve', scope: 'exact-proposal', proposalId: proposal.id, revision: proposal.revision,
      proposalDigest, approvedActionIds: proposal.actions.filter((action) => ['CREATE', 'UPDATE'].includes(action.action)).map((action) => action.id) }),
  });
  assert.equal(result.status, 'synthetic-pass', JSON.stringify(result.error));
  const collision = result.cases[0];
  const context = collision.capture.request.params.additionalContext?.['agent-init:contributors'];
  assert.equal(context?.kind, 'untrusted');
  const manifest = JSON.parse(context.value);
  assert.deepEqual(manifest.contributors.map((entry) => entry.fixtureId), fixtureIds);
  assert.deepEqual(collision.threadRequest.params.runtimeWorkspaceRoots, manifest.contributors.map((entry) => entry.repositoryRoot));
  const migration = manifest.contributors.find((entry) => entry.fixtureId === fixtureIds[1]);
  assert.ok(migration.documents.find((entry) => entry.path === 'docs/database-migrations.md').content.includes('mvn -Pdatabase-migration flyway:validate'));
  const maven = manifest.contributors.find((entry) => entry.fixtureId === fixtureIds[0]);
  assert.ok(maven.documents.find((entry) => entry.path === 'pom.xml').content.includes('<module>services/api</module>'));
  assert.deepEqual(manifest.generatedSkills.map((entry) => [entry.name, entry.fixtureId]), [['build-verify', fixtureIds[0]], ['database-migration', fixtureIds[1]]]);
  assert.equal(manifest.contributors.some((entry) => entry.documents.some((document) => document.path.endsWith('/SKILL.md') || document.path.endsWith('fixture.json'))), false);
  for (const entry of result.cases) {
    const request = entry.capture.request.params;
    assert.deepEqual(request.input, [{ type: 'text', text: corpus.cases.find((item) => item.id === entry.caseId).prompt }]);
    assert.equal(entry.contextPreparation.digest, digestProposal(JSON.parse(request.additionalContext['agent-init:contributors'].value)));
    assert.equal(entry.contextPreparation.nativeConsumptionProven, false);
    assert.equal(entry.discovery.data.every((context) => context.cwd.includes('routing-')), true);
  }
  const next = JSON.parse(result.cases[1].capture.request.params.additionalContext['agent-init:contributors'].value);
  assert.notEqual(next.contributors[0].repositoryRoot, maven.repositoryRoot);
  assert.equal(new Set(result.sessions.map((entry) => entry.threadId)).size, 4);
  assert.equal(result.claims.liveEndToEnd, false);
  assert.equal(result.cleanup.removed, true);
});

test('routing context exposes private-file presence without content or content fingerprints', async () => {
  const original = await loadTriggerCorpus();
  const sourceRoot = await mkdtemp(path.join(await realpath(tmpdir()), 'ai-codex-context-fixtures-'));
  const identity = await lstat(sourceRoot);
  const fixtureId = '03-node-pnpm';
  const canary = 'PUBLIC-PRIVATE-FILE-CANARY-DO-NOT-INJECT';
  const privateTargets = ['.env.private', 'docs/.env.canary.md', '.ENV.uppercase',
    'docs/.ENV.upper.md', 'docs/.EnV.scope/README.md'];
  let result;
  try {
    const fixturesDirectory = path.join(sourceRoot, 'fixtures');
    await cp(path.dirname(original.fixtures.get(fixtureId).directory), fixturesDirectory, { recursive: true });
    const repository = path.join(fixturesDirectory, fixtureId, 'repository');
    for (const target of privateTargets) {
      const absolute = path.join(repository, target);
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, canary);
    }
    const corpus = await loadTriggerCorpus({ fixturesDirectory });
    result = await runCodex({ mode: 'synthetic', evidenceMode: 'source-bound', fixturesDirectory, fixtureIds: [fixtureId], caseIds: ['node-build-verify-positive-01'] }, {
      launch: async ({ root, cwd, role, runId, sessionId, caseId, contributors }) => ({
        command: process.execPath, args: [SYNTHETIC_PROGRAM, `--scenario=${role === 'setup'
          ? await writeQuotedSetup(root, cwd, corpus.fixtures.get(fixtureId).fixture)
          : await writeSyntheticRouting(root, { runId, sessionId, caseId, contributors, loaded: ['build-verify'] })}`],
      }),
      approve: ({ proposal, proposalDigest }) => ({ decision: 'approve', scope: 'exact-proposal', proposalId: proposal.id, revision: proposal.revision,
        proposalDigest, approvedActionIds: ['synthetic-node-skill'] }),
    });
    assert.equal(result.status, 'synthetic-pass', JSON.stringify(result.error));
    const context = result.cases[0].capture.request.params.additionalContext['agent-init:contributors'].value;
    assert.equal(context.includes(canary), false);
    const manifest = JSON.parse(context);
    for (const target of privateTargets) {
      const entry = manifest.contributors[0].inventory.find((item) => item.path === target);
      assert.equal(entry.type, 'file');
      assert.equal(Object.hasOwn(entry, 'digest'), false);
      assert.equal(manifest.contributors[0].documents.some((item) => item.path === target), false);
    }
    assert.equal(result.cases[0].contextPreparation.nativeConsumptionProven, false);
    assert.equal(result.cleanup.removed, true);
  } finally {
    assert.equal(result?.cleanup.removed, true, 'runtime cleanup must be confirmed before removing fixture inputs');
    const current = await lstat(sourceRoot);
    assert.equal(current.isDirectory() && !current.isSymbolicLink(), true);
    assert.equal(current.dev, identity.dev);
    assert.equal(current.ino, identity.ino);
    await rm(sourceRoot, { recursive: true });
  }
});

test('routing rejects changed, oversized, linked and hardlinked contributor documents before issuing a turn', async (t) => {
  const fixture = (await loadTriggerCorpus()).fixtures.get('03-node-pnpm').fixture;
  for (const [label, mutate] of [
    ['changed bytes', async (_root, cwd) => { await writeFile(path.join(cwd, 'package.json'), '{"changed":true}\n'); }],
    ['oversized document', async (_root, cwd) => { await writeFile(path.join(cwd, 'package.json'), Buffer.alloc(64 * 1024 + 1, 32)); }],
    ['owned sibling symlink', async (root, cwd) => {
      await unlink(path.join(cwd, 'package.json'));
      await symlink(path.relative(cwd, path.join(root, `work-${fixture.id}`, 'package.json')), path.join(cwd, 'package.json'));
    }],
    ['owned sibling hardlink', async (root, cwd) => {
      await unlink(path.join(cwd, 'package.json'));
      await link(path.join(root, `work-${fixture.id}`, 'package.json'), path.join(cwd, 'package.json'));
    }],
  ]) await t.test(label, { skip: process.platform === 'win32' && label === 'owned sibling symlink' }, async () => {
    const result = await runCodex({ mode: 'synthetic', fixtureIds: [fixture.id], caseIds: ['node-build-verify-positive-01'] }, {
      launch: async ({ root, cwd, role, runId, sessionId, caseId, contributors }) => {
        const scenario = role === 'setup' ? await writeSyntheticSetup(root, cwd, fixture)
          : await writeSyntheticRouting(root, { runId, sessionId, caseId, contributors, loaded: ['build-verify'] });
        if (role === 'trigger') await mutate(root, cwd);
        return { command: process.execPath, args: [SYNTHETIC_PROGRAM, `--scenario=${scenario}`] };
      },
      approve: ({ proposal, proposalDigest }) => ({ decision: 'approve', scope: 'exact-proposal', proposalId: proposal.id, revision: proposal.revision,
        proposalDigest, approvedActionIds: ['synthetic-node-skill'] }),
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.phase, 'routing');
    assert.equal(result.error.code, 'CONTRIBUTOR_CONTEXT');
    assert.equal(result.cases.length, 0, 'no selection or pass artifact exists for an unissued turn');
    assert.equal(result.sessions.length, 2);
    assert.equal(result.sessions.every((entry) => entry.processGroupAbsent), true);
    assert.equal(result.cleanup.removed, true);
    assert.equal(result.claims.liveEndToEnd, false);
  });
});

test('fresh routing refuses contributor drift from the verified setup baseline before launching its case', async () => {
  const corpus = await loadTriggerCorpus();
  const fixtureIds = ['11-maven-multi-module-build-verify', '12-flyway-database-migration'];
  let mavenRoot;
  let routingLaunches = 0;
  const result = await runCodex({ mode: 'synthetic', evidenceMode: 'source-bound', fixtureIds, caseIds: ['maven-build-verify-migration-collision-01'] }, {
    launch: async ({ root, cwd, fixtureId, role, runId, sessionId, caseId, contributors }) => {
      if (role === 'setup' && fixtureId === fixtureIds[0]) mavenRoot = cwd;
      if (role === 'setup' && fixtureId === fixtureIds[1]) {
        const original = await readFile(path.join(mavenRoot, 'pom.xml'), 'utf8');
        await writeFile(path.join(mavenRoot, 'pom.xml'), `${original}\n<!-- unapproved routing drift -->\n`);
      }
      if (role === 'trigger') routingLaunches++;
      return { command: process.execPath, args: [SYNTHETIC_PROGRAM, `--scenario=${role === 'setup'
        ? await writeQuotedSetup(root, cwd, corpus.fixtures.get(fixtureId).fixture)
        : await writeSyntheticRouting(root, { runId, sessionId, caseId, contributors, loaded: SYNTHETIC_SELECTIONS[caseId] })}`] };
    },
    approve: ({ proposal, proposalDigest }) => ({ decision: 'approve', scope: 'exact-proposal', proposalId: proposal.id, revision: proposal.revision,
      proposalDigest, approvedActionIds: proposal.actions.filter((action) => ['CREATE', 'UPDATE'].includes(action.action)).map((action) => action.id) }),
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'CONTRIBUTOR_CONTEXT');
  assert.equal(result.phase, 'routing');
  assert.equal(routingLaunches, 0);
  assert.equal(result.cases.length, 0);
  assert.equal(result.setups.length, 2);
  assert.equal(result.sessions.every((entry) => entry.processGroupAbsent), true);
  assert.equal(result.cleanup.removed, true);
});

test('routing context accounts for JSON escaping and rejects oversized wire context before sending a turn', async () => {
  const original = await loadTriggerCorpus();
  const sourceRoot = await mkdtemp(path.join(await realpath(tmpdir()), 'ai-codex-context-budget-'));
  const identity = await lstat(sourceRoot);
  const fixtureId = '03-node-pnpm';
  let result;
  try {
    const fixturesDirectory = path.join(sourceRoot, 'fixtures');
    await cp(path.dirname(original.fixtures.get(fixtureId).directory), fixturesDirectory, { recursive: true });
    const repository = path.join(fixturesDirectory, fixtureId, 'repository');
    await mkdir(path.join(repository, 'docs'));
    for (const file of ['quoted-one.md', 'quoted-two.md']) {
      await writeFile(path.join(repository, 'docs', file), '"'.repeat(60 * 1024));
    }
    const corpus = await loadTriggerCorpus({ fixturesDirectory });
    result = await runCodex({ mode: 'synthetic', evidenceMode: 'source-bound', fixturesDirectory, fixtureIds: [fixtureId], caseIds: ['node-build-verify-positive-01'] }, {
      launch: async ({ root, cwd, role, runId, sessionId, caseId, contributors }) => ({
        command: process.execPath, args: [SYNTHETIC_PROGRAM, `--scenario=${role === 'setup'
          ? await writeQuotedSetup(root, cwd, corpus.fixtures.get(fixtureId).fixture)
          : await writeSyntheticRouting(root, { runId, sessionId, caseId, contributors, loaded: ['build-verify'] })}`],
      }),
      approve: ({ proposal, proposalDigest }) => ({ decision: 'approve', scope: 'exact-proposal', proposalId: proposal.id, revision: proposal.revision,
        proposalDigest, approvedActionIds: ['synthetic-node-skill'] }),
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.error.code, 'CONTRIBUTOR_CONTEXT');
    assert.match(result.error.message, /serialized.*budget/);
    assert.equal(result.cases.length, 0);
    assert.equal(result.sessions.every((entry) => entry.processGroupAbsent), true);
    assert.equal(result.cleanup.removed, true);
  } finally {
    assert.equal(result?.cleanup.removed, true);
    const current = await lstat(sourceRoot);
    assert.equal(current.isDirectory() && !current.isSymbolicLink(), true);
    assert.equal(current.dev, identity.dev);
    assert.equal(current.ino, identity.ino);
    await rm(sourceRoot, { recursive: true });
  }
});

test('invalid setup identity or evidence preserves the actual capture and cannot reach approval', async (t) => {
  const fixture = (await loadTriggerCorpus()).fixtures.get('03-node-pnpm').fixture;
  for (const [label, code, mutate] of [
    ['wrong fixture', 'MACHINE_RECORD', (scenario) => { scenario.proposal.record.fixtureId = 'wrong-fixture'; }],
    ['changed observation', 'PROPOSAL_CONTRACT', (scenario) => { scenario.proposal.record.evidenceLedger[0].observation = 'independent noncanonical observation'; }],
    ['wrong evidence association', 'PROPOSAL_CONTRACT', (scenario) => { scenario.proposal.record.events[2].facts[0].evidenceIds = ['ev-verify']; }],
  ]) await t.test(label, async () => {
    let approvals = 0;
    const result = await runCodex({ mode: 'synthetic', fixtureIds: [fixture.id], caseIds: [] }, {
      launch: async ({ root, cwd }) => ({ command: process.execPath, args: [SYNTHETIC_PROGRAM, `--scenario=${await writeSyntheticSetup(root, cwd, fixture, mutate)}`] }),
      approve: () => { approvals++; throw new Error('Must not approve an invalid actual record'); },
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.error.code, code);
    assert.equal(approvals, 0);
    assert.equal(result.setupCaptures.length, 1);
    const capture = result.setupCaptures[0].capture;
    assert.equal(result.setupCaptures[0].fixtureId, fixture.id);
    assert.equal(JSON.parse(capture.request.params.input.find((input) => input.type === 'text').text).fixtureId, fixture.id);
    const actual = JSON.parse(capture.events.find((event) => event.method === 'item/completed').params.item.text).record;
    if (label === 'wrong fixture') assert.equal(actual.fixtureId, 'wrong-fixture');
    else if (label === 'changed observation') assert.equal(actual.evidenceLedger[0].observation, 'independent noncanonical observation');
    else assert.deepEqual(actual.events[2].facts[0].evidenceIds, ['ev-verify']);
    assert.equal(actual.events.some((event) => event.type === 'approval' || event.type === 'write'), false);
    assert.equal(result.cleanup.removed, true);
  });
});

test('Codex source-bound setup keeps independent narration and physical citations through approval and reconciliation', async () => {
  const fixture = (await loadTriggerCorpus()).fixtures.get('03-node-pnpm').fixture;
  let approvals = 0;
  const result = await runCodex({ mode: 'synthetic', evidenceMode: 'source-bound', fixtureIds: [fixture.id], caseIds: [] }, {
    launch: async ({ root, cwd }) => {
      const bytes = await readFile(path.join(cwd, 'package.json'));
      const scenario = await writeSyntheticSetup(root, cwd, fixture, (body) => {
        for (const entry of body.proposal.record.evidenceLedger) {
          entry.fact = 'The inspected repository file supports this project-specific fact.';
          entry.observation = 'I read the manifest rather than repeating fixture-authored prose.';
          entry.whyItMatters = 'This source governs the tooling decision.';
          entry.sourceCitation = { kind: 'bytes', start: 0, end: bytes.length, quote: bytes.toString('utf8') };
        }
      });
      return { command: process.execPath, args: [SYNTHETIC_PROGRAM, `--scenario=${scenario}`] };
    },
    approve: ({ proposal, proposalDigest, evidenceLedger, sourceEvidenceAudit }) => {
      approvals++;
      assert.equal(evidenceLedger[0].observation, 'I read the manifest rather than repeating fixture-authored prose.');
      assert.deepEqual(sourceEvidenceAudit.map((entry) => entry.id), ['ev-pnpm', 'ev-verify']);
      return { decision: 'reject', scope: 'exact-proposal', proposalId: proposal.id, revision: proposal.revision, proposalDigest, approvedActionIds: [] };
    },
  });
  assert.equal(result.status, 'synthetic-pass', JSON.stringify(result.error));
  assert.equal(approvals, 1);
  assert.equal(result.setups[0].record.evidenceLedger[0].fact, 'The inspected repository file supports this project-specific fact.');
  assert.deepEqual(result.setups[0].evaluation.sourceEvidenceAudit.map((entry) => entry.id), ['ev-pnpm', 'ev-verify']);
  const request = result.setups[0].turns[0].request.params;
  assert.equal(JSON.parse(request.input.find((entry) => entry.type === 'text').text).evidenceMode, 'source-bound');
  assert.equal(request.outputSchema.properties.record.properties.evidenceLedger.items.required.includes('sourceCitation'), true);
  assert.equal(result.cleanup.removed, true);
  assert.equal(result.claims.liveEndToEnd, false);
});

test('source-bound setup refuses unsupported sensitive byte evidence before any actor or approval', async (t) => {
  const original = await loadTriggerCorpus();
  const fixtureId = '03-node-pnpm';
  for (const target of ['.ENV.guard', 'docs/.EnV.scope/manifest', '.env.scope/package.json']) await t.test(target, async () => {
    const sourceRoot = await mkdtemp(path.join(await realpath(tmpdir()), 'ai-codex-sensitive-evidence-'));
    const identity = await lstat(sourceRoot);
    let result;
    try {
      const fixturesDirectory = path.join(sourceRoot, 'fixtures');
      await cp(path.dirname(original.fixtures.get(fixtureId).directory), fixturesDirectory, { recursive: true });
      const fixtureRoot = path.join(fixturesDirectory, fixtureId);
      const fixture = JSON.parse(await readFile(path.join(fixtureRoot, 'fixture.json'), 'utf8'));
      fixture.evidence[0].sourcePath = target;
      const absolute = path.join(fixtureRoot, 'repository', target);
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, 'PUBLIC_SENSITIVE_EVIDENCE_CANARY');
      await writeFile(path.join(fixtureRoot, 'fixture.json'), JSON.stringify(fixture));
      let launches = 0;
      let approvals = 0;
      result = await runCodex({ mode: 'synthetic', evidenceMode: 'source-bound', fixturesDirectory, fixtureIds: [fixtureId], caseIds: [] }, {
        launch: () => { launches++; throw new Error('Unsupported sensitive byte evidence must not reach an actor'); },
        approve: () => { approvals++; throw new Error('Unsupported sensitive byte evidence must not reach approval'); },
      });
      assert.equal(result.status, 'failed');
      assert.equal(result.error.code, 'SOURCE_BINDING', JSON.stringify(result.error));
      assert.equal(launches, 0);
      assert.equal(approvals, 0);
      assert.equal(result.setupCaptures.length, 0);
      assert.equal(JSON.stringify(result).includes('PUBLIC_SENSITIVE_EVIDENCE_CANARY'), false);
      assert.equal(result.cleanup.removed, true);
    } finally {
      assert.equal(result?.cleanup.removed, true);
      const current = await lstat(sourceRoot);
      assert.equal(current.dev, identity.dev);
      assert.equal(current.ino, identity.ino);
      await rm(sourceRoot, { recursive: true });
    }
  });
});

test('source-bound setup rejects invalid captured proof before approval and retains the original bytes', async (t) => {
  const fixture = (await loadTriggerCorpus()).fixtures.get('03-node-pnpm').fixture;
  for (const [label, mutate] of [
    ['missing citation', (scenario) => { delete scenario.proposal.record.evidenceLedger[0].sourceCitation; }],
    ['wrong quote', (scenario) => { scenario.proposal.record.evidenceLedger[0].sourceCitation.quote = 'invented source'; }],
    ['wrong byte range', (scenario) => { scenario.proposal.record.evidenceLedger[0].sourceCitation.end++; }],
    ['wrong source location', (scenario) => { scenario.proposal.record.evidenceLedger[0].sourceLocation = 'scripts.other'; }],
    ['wrong fact association', (scenario) => { scenario.proposal.record.events[2].facts[0].evidenceIds = ['ev-verify']; }],
    ['actor supplied trust root', (scenario) => {
      scenario.proposal.record.sourceBinding = { repositoryRoot: 'actor-chosen-root', sources: [] };
      scenario.proposal.record.evidenceLedger[0].sourceCitation.quote = 'actor-controlled source';
    }],
  ]) await t.test(label, async () => {
    let approvals = 0;
    const result = await runCodex({ mode: 'synthetic', evidenceMode: 'source-bound', fixtureIds: [fixture.id], caseIds: [] }, {
      launch: async ({ root, cwd }) => ({ command: process.execPath, args: [SYNTHETIC_PROGRAM, `--scenario=${await writeQuotedSetup(root, cwd, fixture, mutate)}`] }),
      approve: () => { approvals++; throw new Error('Invalid source proof cannot be approved'); },
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.error.code, 'PROPOSAL_CONTRACT', JSON.stringify(result.error));
    assert.equal(approvals, 0);
    assert.equal(result.setupCaptures.length, 1);
    const actual = JSON.parse(result.setupCaptures[0].capture.events.find((event) => event.method === 'item/completed').params.item.text).record;
    assert.equal(actual.evidenceLedger[0].observation, 'I inspected this source without repeating hidden fixture narration.');
    if (label === 'wrong quote') assert.equal(actual.evidenceLedger[0].sourceCitation.quote, 'invented source');
    if (label === 'actor supplied trust root') assert.equal(actual.sourceBinding.repositoryRoot, 'actor-chosen-root');
    assert.equal(actual.events.some((event) => ['approval', 'write'].includes(event.type)), false);
    assert.equal(result.cleanup.removed, true);
    assert.equal(result.claims.liveEndToEnd, false);
  });
});

test('approved canonical Skill sharing stays Proposal-visible and creates only an exact relative reference', {
  skip: process.platform === 'win32' ? 'This physical POSIX symlink regression does not claim Windows symlink privileges.' : false,
}, async () => {
  const fixture = (await loadTriggerCorpus()).fixtures.get('03-node-pnpm').fixture;
  const result = await runCodex({ mode: 'synthetic', evidenceMode: 'source-bound', fixtureIds: [fixture.id], caseIds: [] }, {
    launch: async ({ root, cwd }) => ({ command: process.execPath, args: [SYNTHETIC_PROGRAM, `--scenario=${await writeQuotedSetup(root, cwd, fixture, (scenario) => {
      const proposal = scenario.proposal.record.events.at(-1);
      proposal.actions.push({ id: 'synthetic-shared-reference', action: 'CREATE', kind: 'claude-skill-reference',
        target: '.claude/skills/build-verify', reason: 'One canonical payload, exposed by an approved relative reference.', evidenceIds: ['ev-verify'],
        baselineFingerprint: 'missing', canonicalTarget: '.agents/skills/build-verify', linkText: '../../.agents/skills/build-verify',
        proposedContent: 'Create the relative symlink ../../.agents/skills/build-verify; do not copy the Skill body.' });
      scenario.proposal.summary.actionIds = proposal.actions.map((entry) => entry.id);
      scenario.proposal.audit.proposalDigest = digestProposal(proposal);
    })}`] }),
    approve: ({ proposal, proposalDigest }) => ({ decision: 'approve', scope: 'exact-proposal', proposalId: proposal.id, revision: proposal.revision,
      proposalDigest, approvedActionIds: ['synthetic-node-skill', 'synthetic-shared-reference'] }),
  });
  assert.equal(result.status, 'synthetic-pass', JSON.stringify(result.error));
  const setup = result.setups[0];
  const grammar = setup.turns[0].request.params.outputSchema.properties.record.properties.events.items.anyOf.at(-1).properties.actions.items.anyOf[0];
  assert.equal(grammar.properties.canonicalTarget.type, 'string');
  assert.equal(grammar.properties.linkText.type, 'string');
  assert.deepEqual(grammar.properties.fallbackMode.enum, ['managed-copy']);
  assert.equal(setup.evaluation.ok, true);
  assert.equal(setup.generatedSkills.length, 1);
  const reference = setup.finalInventory.find((entry) => entry.path === '.claude/skills/build-verify');
  assert.equal(reference.type, 'symlink');
  assert.equal(reference.linkText, '../../.agents/skills/build-verify');
  assert.deepEqual(setup.record.events.filter((entry) => entry.type === 'write').map((entry) => entry.actionId), ['synthetic-node-skill', 'synthetic-shared-reference']);
  assert.equal(result.cleanup.removed, true);
  assert.equal(result.claims.liveEndToEnd, false);
});

test('controller evidence mode is explicit and unknown values cannot fall back to strict acceptance', async () => {
  let launches = 0;
  for (const evidenceMode of ['unknown', null, false]) {
    await assert.rejects(runCodex({ mode: 'synthetic', evidenceMode }, { launch: () => { launches++; } }), { code: 'SOURCE_BINDING' });
  }
  assert.equal(launches, 0);
});

test('all source-bound fixture setups retain citations through actual synthetic Apply and fresh routing', async () => {
  const corpus = await loadTriggerCorpus();
  const result = await runCodex({ mode: 'synthetic', evidenceMode: 'source-bound' }, {
    launch: async ({ root, cwd, fixtureId, role, runId, sessionId, caseId, contributors }) => {
      const scenario = role === 'setup' ? await writeQuotedSetup(root, cwd, corpus.fixtures.get(fixtureId).fixture)
        : await writeSyntheticRouting(root, { runId, sessionId, caseId, contributors, loaded: SYNTHETIC_SELECTIONS[caseId] });
      return { command: process.execPath, args: [SYNTHETIC_PROGRAM, `--scenario=${scenario}`] };
    },
    approve: ({ proposal, proposalDigest, evidenceLedger, sourceEvidenceAudit }) => {
      assert.equal(evidenceLedger.length, sourceEvidenceAudit.length);
      for (const entry of evidenceLedger) assert.ok(entry.sourceCitation);
      return { decision: 'approve', scope: 'exact-proposal', proposalId: proposal.id, revision: proposal.revision, proposalDigest,
        approvedActionIds: proposal.actions.filter((entry) => ['CREATE', 'UPDATE'].includes(entry.action)).map((entry) => entry.id) };
    },
  });
  assert.equal(result.status, 'synthetic-pass', JSON.stringify(result.error));
  assert.equal(result.setups.length, 15);
  assert.equal(result.cases.length, 26);
  assert.equal(result.sessions.length, 41);
  assert.equal(new Set(result.sessions.map((entry) => entry.threadId)).size, 41);
  const evidence = result.setups.flatMap((setup) => setup.evaluation.sourceEvidenceAudit);
  assert.ok(evidence.some((entry) => entry.presenceOnly));
  for (const entry of evidence.filter((entry) => entry.presenceOnly)) assert.equal(Object.hasOwn(entry, 'fingerprint'), false);
  assert.equal(result.cases.every((entry) => entry.evaluation.ok), true);
  assert.equal(result.cleanup.removed, true);
  assert.equal(result.claims.nativeExecution, false);
  assert.equal(result.claims.liveEndToEnd, false);
});

test('captured setup without facts fails before asking for approval, rather than applying then validating', async () => {
  const fixture = (await loadTriggerCorpus()).fixtures.get('03-node-pnpm').fixture;
  let asked = 0;
  const result = await runCodex({ mode: 'synthetic', fixtureIds: [fixture.id], caseIds: [] }, {
    launch: async ({ root, cwd }) => ({ command: process.execPath, args: [SYNTHETIC_PROGRAM, `--scenario=${await writeSyntheticSetup(root, cwd, fixture, (scenario) => {
      delete scenario.proposal.record.events[2].facts;
    })}`] }),
    approve: ({ proposal, proposalDigest }) => {
      asked++;
      return { decision: 'approve', scope: 'exact-proposal', proposalId: proposal.id, revision: proposal.revision, proposalDigest, approvedActionIds: ['synthetic-node-skill'] };
    },
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'MACHINE_RECORD');
  assert.equal(asked, 0);
  assert.equal(result.cleanup.removed, true);
});

test('Codex synthetic orchestration covers all 15 setups, 21 implicit cases and five explicit probes with full contributors', async () => {
  const corpus = await loadTriggerCorpus();
  const result = await runCodex({ mode: 'synthetic' }, {
    launch: async ({ root, cwd, fixtureId, role, runId, sessionId, caseId, contributors }) => {
      const scenario = role === 'setup' ? await writeSyntheticSetup(root, cwd, corpus.fixtures.get(fixtureId).fixture)
        : await writeSyntheticRouting(root, { runId, sessionId, caseId, contributors, loaded: SYNTHETIC_SELECTIONS[caseId] });
      return { command: process.execPath, args: [SYNTHETIC_PROGRAM, `--scenario=${scenario}`] };
    },
    approve: ({ proposal, proposalDigest }) => ({
      decision: 'approve', scope: 'exact-proposal', proposalId: proposal.id, revision: proposal.revision, proposalDigest,
      approvedActionIds: proposal.actions.filter((entry) => ['CREATE', 'UPDATE'].includes(entry.action)).map((entry) => entry.id),
    }),
  });
  assert.equal(result.status, 'synthetic-pass', JSON.stringify(result.error));
  assert.equal(result.setups.length, 15);
  assert.equal(result.cases.length, 26);
  assert.equal(result.cases.filter((entry) => entry.artifact.schemaVersion === 1).length, 21);
  assert.equal(result.cases.filter((entry) => entry.artifact.schemaVersion === 2).length, 5);
  assert.equal(result.sessions.length, 41);
  assert.equal(new Set(result.sessions.map((entry) => entry.threadId)).size, 41);
  const node = result.setups.find((entry) => entry.fixtureId === '03-node-pnpm').generatedSkills[0];
  const maven = result.setups.find((entry) => entry.fixtureId === '11-maven-multi-module-build-verify').generatedSkills[0];
  assert.equal(node.name, maven.name);
  assert.notEqual(node.digest, maven.digest);
  const collision = result.cases.find((entry) => entry.caseId === 'maven-build-verify-migration-collision-01');
  assert.equal(collision.discovery.data.length, 2);
  assert.deepEqual(collision.artifact.observed.loaded, ['build-verify', 'database-migration']);
  assert.equal(result.cases.every((entry) => entry.evaluation.ok), true);
  assert.equal(result.cleanup.removed, true);
  assert.equal(result.claims.qualification, false);
});

test('approved payload cannot hide an unapproved full-mode change or an empty directory mutation', async () => {
  const fixture = (await loadTriggerCorpus()).fixtures.get('03-node-pnpm').fixture;
  const result = await runCodex({ mode: 'synthetic', fixtureIds: [fixture.id], caseIds: [] }, {
    launch: async ({ root, cwd }) => ({ command: process.execPath, args: [SYNTHETIC_PROGRAM, `--scenario=${await writeSyntheticSetup(root, cwd, fixture, (scenario) => {
      scenario.afterApplyMutation = { modeTarget: 'package.json', mode: 0o600, directory: 'unapproved-empty-directory' };
    })}`] }),
    approve: ({ proposal, proposalDigest }) => ({ decision: 'approve', scope: 'exact-proposal', proposalId: proposal.id, revision: proposal.revision, proposalDigest, approvedActionIds: ['synthetic-node-skill'] }),
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'UNAPPROVED_DELTA');
  assert.equal(result.cleanup.removed, true);
});

test('an unsettled exact-approval callback retains its runtime and a late affirmative decision cannot Apply', async () => {
  const fixture = (await loadTriggerCorpus()).fixtures.get('03-node-pnpm').fixture;
  let ownedRoot;
  let repositoryRoot;
  let identity;
  let releaseApproval;
  let watchdog;
  let stalled;
  const stalledWait = new Promise((resolve) => { stalled = resolve; });
  const run = runCodex({ mode: 'synthetic', fixtureIds: [fixture.id], caseIds: [], approvalTimeoutMs: 100, closeTimeoutMs: 100 }, {
    launch: async ({ root, cwd }) => {
      ownedRoot = root;
      repositoryRoot = cwd;
      identity = await lstat(root);
      return { command: process.execPath, args: [SYNTHETIC_PROGRAM, `--scenario=${await writeSyntheticSetup(root, cwd, fixture)}`] };
    },
    approve: ({ proposal, proposalDigest }) => {
      watchdog = setTimeout(() => stalled(null), 1500);
      return new Promise((resolve) => {
        releaseApproval = () => resolve({ decision: 'approve', scope: 'exact-proposal', proposalId: proposal.id,
          revision: proposal.revision, proposalDigest, approvedActionIds: ['synthetic-node-skill'] });
      });
    },
  });
  try {
    const result = await Promise.race([run, stalledWait]);
    assert.equal(result?.status, 'failed');
    assert.equal(result.phase, 'approval');
    assert.equal(result.error.code, 'APPROVAL_TIMEOUT');
    assert.equal(result.claims.liveEndToEnd, false);
    assert.equal(result.cleanup.removed, false);
    assert.equal(result.cleanupError.code, 'CODEX_CLEANUP');
    assert.equal(result.setupCaptures.length, 1);
    const submitted = result.setupCaptures[0].capture.request.params.input.find((entry) => entry.type === 'text');
    assert.equal(JSON.parse(submitted.text).operation, 'setup-proposal');
    assert.deepEqual(result.setups, []);
  } finally {
    clearTimeout(watchdog);
    releaseApproval?.();
    const result = await run;
    if (result.cleanup.removed === false) {
      await new Promise((resolve) => setImmediate(resolve));
      const retained = await lstat(ownedRoot);
      assert.equal(retained.dev, identity.dev);
      assert.equal(retained.ino, identity.ino);
      assert.equal(await fingerprintPath(repositoryRoot, '.agents/skills/build-verify/SKILL.md'), 'missing');
    }
  }
});

test('default and native modes refuse launch; stale, missing and invalid exact approvals cannot Apply', async (t) => {
  let launches = 0;
  await assert.rejects(runCodex({}, { launch: () => { launches++; } }), { code: 'NATIVE_EXECUTION_DEFERRED' });
  await assert.rejects(runCodex({ mode: 'native', optIn: true }, { launch: () => { launches++; } }), { code: 'NATIVE_EXECUTION_DEFERRED' });
  assert.equal(launches, 0);
  const fixture = (await loadTriggerCorpus()).fixtures.get('03-node-pnpm').fixture;
  for (const [label, change] of [
    ['missing', () => undefined],
    ['stale revision', (approval) => ({ ...approval, revision: approval.revision + 1 })],
    ['wrong digest', (approval) => ({ ...approval, proposalDigest: 'sha256:wrong' })],
    ['duplicate IDs', (approval) => ({ ...approval, approvedActionIds: ['synthetic-node-skill', 'synthetic-node-skill'] })],
    ['unknown ID', (approval) => ({ ...approval, approvedActionIds: ['unknown'] })],
    ['rejected write', (approval) => ({ ...approval, decision: 'reject' })],
  ]) {
    await t.test(label, async () => {
      const result = await runCodex({ mode: 'synthetic', fixtureIds: [fixture.id], caseIds: [] }, {
        launch: async ({ root, cwd }) => ({ command: process.execPath, args: [SYNTHETIC_PROGRAM, `--scenario=${await writeSyntheticSetup(root, cwd, fixture)}`] }),
        approve: ({ proposal, proposalDigest }) => change({ decision: 'approve', scope: 'exact-proposal', proposalId: proposal.id, revision: proposal.revision, proposalDigest, approvedActionIds: ['synthetic-node-skill'] }),
      });
      assert.equal(result.status, 'failed');
      assert.equal(result.phase, 'approval');
      assert.equal(result.error.code, 'EXACT_APPROVAL');
      assert.equal(result.cleanup.removed, true);
    });
  }
});

test('routing mismatches retain actual loaded names, while malformed selection retains capture and has no artifact', async (t) => {
  const fixture = (await loadTriggerCorpus()).fixtures.get('03-node-pnpm').fixture;
  for (const [label, loaded] of [['routing mismatch', ['deployment']], ['unknown name', ['undeclared-skill']], ['duplicate names', ['build-verify', 'build-verify']], ['missing list', undefined]]) {
    await t.test(label, async () => {
      const result = await runCodex({ mode: 'synthetic', fixtureIds: [fixture.id], caseIds: ['node-build-verify-positive-01'] }, {
        launch: async ({ root, cwd, role, runId, sessionId, caseId, contributors }) => ({
          command: process.execPath, args: [SYNTHETIC_PROGRAM, `--scenario=${role === 'setup' ? await writeSyntheticSetup(root, cwd, fixture) : await writeSyntheticRouting(root, { runId, sessionId, caseId, contributors, loaded })}`],
        }),
        approve: ({ proposal, proposalDigest }) => ({ decision: 'approve', scope: 'exact-proposal', proposalId: proposal.id, revision: proposal.revision, proposalDigest, approvedActionIds: ['synthetic-node-skill'] }),
      });
      assert.equal(result.cases.length, 1);
      const entry = result.cases[0];
      if (label === 'routing mismatch') {
        assert.equal(result.status, 'synthetic-fail');
        assert.equal(entry.artifact.result, 'fail');
        assert.deepEqual(entry.artifact.observed.loaded, ['deployment']);
        assert.equal(entry.evaluation.ok, false);
      } else {
        assert.equal(result.status, 'failed');
        assert.equal(result.error.code, 'SELECTION_EVIDENCE');
        assert.equal(entry.artifact, null);
        const receipt = entry.capture.events.find((event) => event.method === 'synthetic/selection.complete');
        assert.deepEqual(receipt.params.loaded, loaded);
      }
      assert.equal(result.cleanup.removed, true);
    });
  }
});

test('a passing selection followed by nonzero process exit cannot retain a pass artifact', async () => {
  const fixture = (await loadTriggerCorpus()).fixtures.get('03-node-pnpm').fixture;
  const result = await runCodex({ mode: 'synthetic', fixtureIds: [fixture.id], caseIds: ['node-build-verify-positive-01'] }, {
    launch: async ({ root, cwd, role, runId, sessionId, caseId, contributors }) => ({
      command: process.execPath, args: [SYNTHETIC_PROGRAM, `--scenario=${role === 'setup' ? await writeSyntheticSetup(root, cwd, fixture) : await writeSyntheticRouting(root, { runId, sessionId, caseId, contributors, loaded: ['build-verify'] })}`, ...(role === 'trigger' ? ['--exit-nonzero'] : [])],
    }),
    approve: ({ proposal, proposalDigest }) => ({ decision: 'approve', scope: 'exact-proposal', proposalId: proposal.id, revision: proposal.revision, proposalDigest, approvedActionIds: ['synthetic-node-skill'] }),
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'CODEX_SESSION_FAILURE');
  assert.equal(result.cases[0].artifact, null);
  assert.equal(result.cases[0].status, 'incomplete');
  assert.equal(Object.hasOwn(result.cases[0], 'evaluation'), false);
  assert.equal(result.sessions.at(-1).exitCode, 9);
  assert.equal(result.sessions.at(-1).processGroupAbsent, true);
  assert.equal(result.cleanup.removed, true);
});

test('owned finalization failure cannot publish a pass candidate, and preserves capture without deleting an unverified root', async () => {
  const fixture = (await loadTriggerCorpus()).fixtures.get('03-node-pnpm').fixture;
  let ownedRoot;
  let identity;
  let marker;
  let result;
  try {
    result = await runCodex({ mode: 'synthetic', fixtureIds: [fixture.id], caseIds: ['node-build-verify-positive-01'] }, {
      launch: async ({ root, cwd, role, runId, sessionId, caseId, contributors }) => {
        if (!ownedRoot) {
          ownedRoot = root;
          identity = await lstat(root);
          marker = await readRegularFileNoFollow(path.join(root, 'ownership.json'));
        }
        const scenario = role === 'setup' ? await writeSyntheticSetup(root, cwd, fixture)
          : await writeSyntheticRouting(root, { runId, sessionId, caseId, contributors, loaded: ['build-verify'] });
        if (role === 'trigger') await writeFile(path.join(root, 'ownership.json'), `${JSON.stringify({ ...JSON.parse(marker), nonce: 'synthetic-drift' })}\n`);
        return { command: process.execPath, args: [SYNTHETIC_PROGRAM, `--scenario=${scenario}`] };
      },
      approve: ({ proposal, proposalDigest }) => ({ decision: 'approve', scope: 'exact-proposal', proposalId: proposal.id, revision: proposal.revision, proposalDigest, approvedActionIds: ['synthetic-node-skill'] }),
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.cleanup.removed, false);
    assert.equal(result.cleanup.error.code, 'OWNED_CLEANUP');
    assert.equal(result.sessions.every((entry) => entry.processGroupAbsent), true);
    assert.equal(result.cases.length, 1);
    const entry = result.cases[0];
    assert.equal(entry.artifact, null);
    assert.equal(entry.status, 'incomplete');
    assert.equal(Object.hasOwn(entry, 'evaluation'), false);
    assert.deepEqual(entry.capture.events.find((event) => event.method === 'synthetic/selection.complete').params.loaded, ['build-verify']);
    assert.equal((await lstat(ownedRoot)).ino, identity.ino);
  } finally {
    if (ownedRoot) {
      assert.equal(result?.sessions.length, 2, 'both test-owned processes must be confirmed closed before test cleanup');
      assert.equal(result.sessions.every((entry) => entry.processGroupAbsent), true);
      const current = await lstat(ownedRoot);
      assert.equal(current.isDirectory() && !current.isSymbolicLink(), true);
      assert.equal(current.dev, identity.dev);
      assert.equal(current.ino, identity.ino);
      assert.deepEqual(JSON.parse(await readRegularFileNoFollow(path.join(ownedRoot, 'ownership.json'))), { ...JSON.parse(marker), nonce: 'synthetic-drift' });
      await inventoryCodexTree(ownedRoot);
      await writeFile(path.join(ownedRoot, 'ownership.json'), marker);
      await rm(ownedRoot, { recursive: true });
      await assert.rejects(lstat(ownedRoot), { code: 'ENOENT' });
    }
  }
});

test('shared Proposal semantics and physical evidence are checked before dynamic approval', async (t) => {
  const fixture = (await loadTriggerCorpus()).fixtures.get('03-node-pnpm').fixture;
  for (const [label, mutate] of [
    ['missing Git summary', (scenario) => { delete scenario.proposal.record.events[0].git; }],
    ['empty ledger', (scenario) => { scenario.proposal.record.evidenceLedger = []; }],
    ['wrong fingerprint', (scenario) => { scenario.proposal.record.events[0].repositoryFingerprintBefore = 'tree-sha256:wrong'; }],
    ['forbidden physical target', (scenario) => {
      const proposal = scenario.proposal.record.events.at(-1);
      Object.assign(proposal.actions[0], { kind: 'agents', target: 'src/unapproved-note.md' });
      scenario.proposal.audit.proposalDigest = digestProposal(proposal);
    }],
  ]) {
    await t.test(label, async () => {
      let asked = 0;
      const result = await runCodex({ mode: 'synthetic', fixtureIds: [fixture.id], caseIds: [] }, {
        launch: async ({ root, cwd }) => ({ command: process.execPath, args: [SYNTHETIC_PROGRAM, `--scenario=${await writeSyntheticSetup(root, cwd, fixture, mutate)}`] }),
        approve: ({ proposal, proposalDigest }) => { asked++; return { decision: 'approve', scope: 'exact-proposal', proposalId: proposal.id, revision: proposal.revision, proposalDigest, approvedActionIds: ['synthetic-node-skill'] }; },
      });
      assert.equal(result.status, 'failed');
      assert.equal(result.error.code, 'PROPOSAL_CONTRACT');
      assert.equal(asked, 0);
      assert.equal(result.cleanup.removed, true);
    });
  }
});

test('exact UPDATE diff preserves existing prose and approval-time drift blocks Apply', async (t) => {
  const fixture = (await loadTriggerCorpus()).fixtures.get('05-existing-agents').fixture;
  for (const drift of [false, true]) {
    await t.test(drift ? 'approval-time physical drift' : 'exact diff Apply', async () => {
      let repositoryRoot;
      const result = await runCodex({ mode: 'synthetic', fixtureIds: [fixture.id], caseIds: [] }, {
        launch: async ({ root, cwd }) => {
          repositoryRoot = cwd;
          const before = await readFile(path.join(cwd, 'AGENTS.md'), 'utf8');
          const after = `${before}\nUse npm for this repository.\n`;
          const baselineFingerprint = await fingerprintPath(cwd, 'AGENTS.md');
          const file = await writeSyntheticSetup(root, cwd, fixture, (scenario) => {
            const proposal = scenario.proposal.record.events.at(-1);
            proposal.actions.push({ id: 'synthetic-update', action: 'UPDATE', kind: 'agents', target: 'AGENTS.md', reason: 'Synthetic conservative merge.', evidenceIds: ['ev-npm'], baselineFingerprint, proposedDiff: renderExactDiff('AGENTS.md', before, after) });
            scenario.proposal.summary.actionIds = ['synthetic-update'];
            scenario.proposal.audit.proposalDigest = digestProposal(proposal);
            scenario.afterContents = { 'synthetic-update': after };
          });
          return { command: process.execPath, args: [SYNTHETIC_PROGRAM, `--scenario=${file}`] };
        },
        approve: async ({ proposal, proposalDigest }) => {
          if (drift) await writeFile(path.join(repositoryRoot, 'AGENTS.md'), 'Synthetic approval-time drift\n');
          return { decision: 'approve', scope: 'exact-proposal', proposalId: proposal.id, revision: proposal.revision, proposalDigest, approvedActionIds: ['synthetic-update'] };
        },
      });
      assert.equal(result.status, drift ? 'failed' : 'synthetic-pass', JSON.stringify(result.error));
      if (drift) assert.equal(result.error.code, 'FINGERPRINT_DRIFT');
      else {
        assert.equal(result.setups[0].evaluation.ok, true);
        assert.equal(result.setups[0].record.events.find((event) => event.type === 'write').actionId, 'synthetic-update');
      }
      assert.equal(result.cleanup.removed, true);
    });
  }
});

test('Codex runner command help is inert and direct invocation refuses native execution', () => {
  const file = fileURLToPath(new URL('./runner.js', import.meta.url));
  const help = spawnSync(process.execPath, [file, '--help'], { env: {}, encoding: 'utf8', timeout: 5000, maxBuffer: 4096 });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /runCodex/);
  assert.match(help.stdout, /native execution is deferred/i);
  const direct = spawnSync(process.execPath, [file, '--live'], { env: {}, encoding: 'utf8', timeout: 5000, maxBuffer: 4096 });
  assert.equal(direct.status, 2);
  assert.match(direct.stderr, /NATIVE_EXECUTION_DEFERRED/);
});
