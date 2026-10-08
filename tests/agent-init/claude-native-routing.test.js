import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { copyTree, digestTree } from '../../src/installation/filesystem.js';
import { digestProposal, fingerprintRepository } from './evaluation-harness.js';
import { prepareClaudeRoutingInputs } from './claude-live-runner.js';
import { snapshotContext } from './claude-protocol.js';
import { evaluateTriggerArtifact } from './trigger-evaluation.js';
import { runClaudeNativeRouting } from './claude-native-routing.js';

const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
const fixtureSkills = {
  '03-node-pnpm': 'build-verify',
  '11-maven-multi-module-build-verify': 'build-verify',
  '12-flyway-database-migration': 'database-migration',
  '13-audit-log': 'audit-log',
  '14-redis-no-skill': null,
  '15-deployment': 'deployment',
};

async function routingInputs(t) {
  const root = await mkdtemp(path.join(projectRoot, '.tmp-claude-native-routing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'baselines'));
  await mkdir(path.join(root, 'contexts'));
  const evidenceRoot = path.join(root, 'evidence');
  await mkdir(evidenceRoot, { mode: 0o700 });
  const motherSkillRoot = path.join(root, 'agent-init');
  await copyTree(path.join(projectRoot, 'skills/agent-init'), motherSkillRoot);
  const setups = [];
  const fixtureRoots = {};
  const generatedSkillsByFixture = {};
  for (const [fixtureId, skill] of Object.entries(fixtureSkills)) {
    const routingFixtureRoot = path.join(root, 'baselines', fixtureId);
    const fixtureRoot = path.join(root, 'contexts', fixtureId);
    await copyTree(path.join(projectRoot, 'tests/fixtures', fixtureId), routingFixtureRoot);
    await copyTree(routingFixtureRoot, fixtureRoot);
    const finalRoot = path.join(fixtureRoot, 'repository');
    fixtureRoots[fixtureId] = routingFixtureRoot;
    generatedSkillsByFixture[fixtureId] = {};
    if (skill) {
      const skillRoot = path.join(finalRoot, '.agents/skills', skill);
      await mkdir(skillRoot, { recursive: true });
      // Physical routing payloads are test setup, not native observation evidence.
      await writeFile(path.join(skillRoot, 'SKILL.md'), `---\nname: ${skill}\ndescription: Route the repository-specific ${skill} workflow.\n---\n\n## When to use\nA task requests this workflow.\n\n## When not to use\nConceptual explanation only.\n\n## Workflow\nInspect the documented project workflow.\n\n## Project-specific rules\nUse the repository evidence.\n\n## Verification\nCheck the workflow contract.\n`);
      await mkdir(path.join(finalRoot, '.claude/skills'), { recursive: true });
      await symlink(`../../.agents/skills/${skill}`, path.join(finalRoot, '.claude/skills', skill));
      generatedSkillsByFixture[fixtureId][skill] = skillRoot;
    }
    setups.push({ fixtureId, fixtureRoot, routingFixtureRoot, roots: { finalRoot },
      sessionId: randomUUID(), sessionClosed: true, status: 'pass',
      expectedContextFingerprint: await fingerprintRepository(finalRoot),
      expectedContextSeal: digestProposal({ type: 'claude-context-seal-v1', snapshot: await snapshotContext(finalRoot) }),
      archivedBaselineFixtureDigest: await digestTree(routingFixtureRoot) });
  }
  const preparation = await prepareClaudeRoutingInputs({ fixtureRoots, generatedSkillsByFixture, motherSkillRoot });
  return { root, evidenceRoot, motherSkillRoot, setups, preparation, executionKind: 'test-double', harnessVersion: 'native-session-double-v1' };
}

function neverInvoke() { assert.fail('Native session must not start before all contexts are closed and fresh'); }

// Independently declared native-parser observations: never read fixture.expected
// or prepared.case.expected to construct loaded evidence.
const declaredLoads = {
  'node-build-verify-positive-01': ['build-verify'],
  'node-build-verify-negative-01': [],
  'node-build-verify-near-miss-01': [],
  'node-build-verify-deployment-collision-01': ['build-verify', 'deployment'],
  'maven-build-verify-positive-01': ['build-verify'],
  'maven-build-verify-negative-01': [],
  'maven-build-verify-near-miss-01': [],
  'maven-build-verify-migration-collision-01': ['build-verify', 'database-migration'],
  'database-migration-positive-01': ['database-migration'],
  'database-migration-negative-01': [],
  'database-migration-near-miss-01': [],
  'database-migration-audit-log-collision-01': ['database-migration', 'audit-log'],
  'audit-log-positive-01': ['audit-log'],
  'audit-log-negative-01': [],
  'audit-log-near-miss-01': [],
  'audit-log-migration-collision-01': ['audit-log', 'database-migration'],
  'deployment-positive-01': ['deployment'],
  'deployment-negative-01': [],
  'deployment-near-miss-01': [],
  'deployment-node-build-verify-collision-01': ['deployment', 'build-verify'],
  'redis-no-skill-negative-01': [],
  '03-node-pnpm-build-verify-explicit-01': ['build-verify'],
  '11-maven-multi-module-build-verify-build-verify-explicit-01': ['build-verify'],
  '12-flyway-database-migration-database-migration-explicit-01': ['database-migration'],
  '13-audit-log-audit-log-explicit-01': ['audit-log'],
  '15-deployment-deployment-explicit-01': ['deployment'],
};

function nativeObservation(request, loaded = declaredLoads[request.id]) {
  return { status: 'observed', loaded: structuredClone(loaded), provenance: {
    evidenceSource: 'native-parser',
    trace: { sessionId: request.sessionId, harnessVersion: 'native-session-double-v1',
      traceDigest: `sha256:${'c'.repeat(64)}`, traceBytes: 400 },
    selectionProtocolVerified: true, sourceAttributionProven: true,
    exhaustiveCoverageProven: true, hookCoverageProven: true, permissionFloorProven: false,
  } };
}

function nativeBoundaries(overrides = {}) {
  return {
    invokeSession: async (request) => request.phase === 'close'
      ? { closed: true, sessionId: request.sessionId, id: request.id }
      : { status: 0 },
    observeSession: async (_processResult, request) => nativeObservation(request),
    ...overrides,
  };
}

test('routing refuses an open setup before any external native invocation', async (t) => {
  const inputs = await routingInputs(t);
  inputs.setups.at(-1).sessionClosed = false;
  const result = await runClaudeNativeRouting({ ...inputs, invokeSession: neverInvoke, observeSession: neverInvoke });
  assert.equal(result.status, 'blocked');
  assert.equal(result.code, 'SETUP_NOT_CLOSED');
  assert.deepEqual(result.routingSessions, []);
  assert.equal(result.qualification, 'unqualified');
});

test('closed setup physical metadata drift is refused before native invocation', async (t) => {
  const inputs = await routingInputs(t);
  await chmod(path.join(inputs.setups[0].roots.finalRoot, 'package.json'), 0o600);
  const result = await runClaudeNativeRouting({ ...inputs, invokeSession: neverInvoke, observeSession: neverInvoke });
  assert.equal(result.status, 'error');
  assert.equal(result.code, 'SETUP_CONTEXT_STALE');
  assert.deepEqual(result.routingSessions, []);
});

test('routing refuses a changed frozen prompt without starting a native session', async (t) => {
  const inputs = await routingInputs(t);
  inputs.preparation.cases[0].prepared.case.prompt = 'Different prompt that is not in the frozen corpus.';
  const result = await runClaudeNativeRouting({ ...inputs, invokeSession: neverInvoke, observeSession: neverInvoke });
  assert.equal(result.status, 'error');
  assert.equal(result.code, 'ROUTING_PREPARATION_STALE');
  assert.deepEqual(result.routingSessions, []);
});

test('every frozen contributor including the no-skill fixture is required before routing starts', async (t) => {
  const inputs = await routingInputs(t);
  inputs.setups = inputs.setups.filter((setup) => setup.fixtureId !== '14-redis-no-skill');
  let calls = 0;
  const boundaries = nativeBoundaries();
  const result = await runClaudeNativeRouting({ ...inputs, ...boundaries,
    invokeSession: async (request) => { calls += 1; return boundaries.invokeSession(request); },
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.code, 'FIXTURE_CONTEXT_REQUIRED');
  assert.equal(calls, 0);
  assert.deepEqual(result.routingSessions, []);
});

test('generated Skill payloads cannot be substituted from outside their closed sealed contributor', async (t) => {
  const inputs = await routingInputs(t);
  const original = path.join(inputs.setups[0].roots.finalRoot, '.agents/skills/build-verify');
  await mkdir(path.join(inputs.root, 'stray'));
  const substitute = path.join(inputs.root, 'stray/build-verify');
  await copyTree(original, substitute);
  for (const entry of inputs.preparation.cases) {
    if (entry.inputs.generatedSkills['build-verify'] === original) entry.inputs.generatedSkills['build-verify'] = substitute;
  }
  let calls = 0;
  const boundaries = nativeBoundaries();
  const result = await runClaudeNativeRouting({ ...inputs, ...boundaries,
    invokeSession: async (request) => { calls += 1; return boundaries.invokeSession(request); },
  });
  assert.equal(result.status, 'error');
  assert.equal(result.code, 'ROUTING_CONTEXT_BINDING');
  assert.equal(calls, 0);
});

test('private malformed correlation metadata never survives persistence', async (t) => {
  const inputs = await routingInputs(t);
  const secret = 'sk-ant-routing-echo-must-not-retain';
  const result = await runClaudeNativeRouting({ ...inputs, ...nativeBoundaries({
    observeSession: async (_processResult, request) => {
      const observation = nativeObservation(request);
      observation.provenance.trace.sessionId = secret;
      return observation;
    },
  }) });
  assert.equal(result.status, 'error');
  assert.equal(result.code, 'SELECTION_CORRELATION');
  assert.equal((await readFile(result.reportPath, 'utf8')).includes(secret), false);
  assert.deepEqual(result.artifacts, []);
  assert.equal(result.routingSessions[0].observed, undefined);
});

test('credential-like loaded evidence is rejected without retaining its raw value', async (t) => {
  const inputs = await routingInputs(t);
  const secret = 'sk-ant-routing-echo-must-not-retain';
  const result = await runClaudeNativeRouting({ ...inputs, ...nativeBoundaries({
    observeSession: async (_processResult, request) => nativeObservation(request, [secret]),
  }) });
  assert.equal(result.status, 'error');
  assert.equal(result.code, 'SELECTION_EVIDENCE');
  assert.equal((await readFile(result.reportPath, 'utf8')).includes(secret), false);
  assert.equal(result.routingSessions[0].observed, undefined);
});

test('a failed native process cannot be converted into observed selection by the observer', async (t) => {
  const inputs = await routingInputs(t);
  let observations = 0;
  let closures = 0;
  const result = await runClaudeNativeRouting({ ...inputs, ...nativeBoundaries({
    invokeSession: async (request) => {
      if (request.phase === 'close') { closures += 1; return { closed: true, sessionId: request.sessionId, id: request.id }; }
      return { status: 7, stdout: 'Do not retain raw model output.' };
    },
    observeSession: async (_processResult, request) => { observations += 1; return nativeObservation(request); },
  }) });
  assert.equal(result.status, 'error');
  assert.equal(result.code, 'NATIVE_PROCESS_FAILED');
  assert.equal(observations, 0);
  assert.equal(closures, 1);
  assert.equal(result.routingSessions[0].observed, undefined);
});

test('readonly delta on closing a blocked observation is an error, not a diagnostic block', async (t) => {
  const inputs = await routingInputs(t);
  const result = await runClaudeNativeRouting({ ...inputs, ...nativeBoundaries({
    observeSession: async (_processResult, request) => ({ status: 'blocked', code: 'NATIVE_SELECTION_UNVERIFIED',
      provenance: { trace: { sessionId: request.sessionId, harnessVersion: inputs.harnessVersion } } }),
    invokeSession: async (request) => {
      if (request.phase !== 'close') return { status: 0 };
      await chmod(path.join(inputs.motherSkillRoot, 'SKILL.md'), 0o600);
      return { closed: true, sessionId: request.sessionId, id: request.id };
    },
  }) });
  assert.equal(result.status, 'error');
  assert.equal(result.code, 'ROUTING_WRITES');
  assert.equal(result.routingSessions[0].zeroWrites, false);
  assert.equal(result.routingSessions[0].sessionClosed, true);
  assert.deepEqual(result.artifacts, []);
});

test('evidence output cannot mutate a sealed contributor repository', async (t) => {
  const inputs = await routingInputs(t);
  inputs.evidenceRoot = inputs.setups[0].roots.finalRoot;
  const before = await snapshotContext(inputs.evidenceRoot);
  let calls = 0;
  const boundaries = nativeBoundaries();
  const result = await runClaudeNativeRouting({ ...inputs, ...boundaries,
    invokeSession: async (request) => { calls += 1; return boundaries.invokeSession(request); },
  });
  assert.equal(result.status, 'error');
  assert.equal(result.code, 'EVIDENCE_SCOPE');
  assert.equal(calls, 0);
  assert.deepEqual(await snapshotContext(inputs.evidenceRoot), before);
});

test('missing, error and unverified native observations are never converted to empty successful selections', async (t) => {
  for (const [name, observation, code, status] of [
    ['absent', () => undefined, 'SELECTION_UNAVAILABLE', 'error'],
    ['parser error with a loaded-looking field', () => ({ status: 'error', code: 'NATIVE_EVENTS_MISSING', loaded: [] }), 'NATIVE_EVENTS_MISSING', 'error'],
    ['current blocked native collector', (request) => ({ status: 'blocked', code: 'NATIVE_SELECTION_UNVERIFIED',
      provenance: { trace: { sessionId: request.sessionId, harnessVersion: 'native-session-double-v1' },
        hookCoverageProven: false, permissionFloorProven: false, selectionProtocolVerified: false } }), 'NATIVE_SELECTION_UNVERIFIED', 'blocked'],
    ['missing loaded field', (request) => { const value = nativeObservation(request); delete value.loaded; return value; }, 'SELECTION_EVIDENCE', 'error'],
    ['null loaded field', (request) => nativeObservation(request, null), 'SELECTION_EVIDENCE', 'error'],
    ['model text instead of a list', (request) => nativeObservation(request, 'I loaded build-verify'), 'SELECTION_EVIDENCE', 'error'],
    ['catalog instead of selection', (request) => { const value = nativeObservation(request); delete value.loaded;
      value.provenance.catalog = { skills: ['build-verify'] }; return value; }, 'SELECTION_EVIDENCE', 'error'],
    ['unknown evidence source', (request) => { const value = nativeObservation(request); value.provenance.evidenceSource = 'model-text'; return value; }, 'NATIVE_SELECTION_UNVERIFIED', 'blocked'],
    ['unproved native source', (request) => { const value = nativeObservation(request); value.provenance.sourceAttributionProven = false; return value; }, 'NATIVE_SELECTION_UNVERIFIED', 'blocked'],
    ['incomplete native coverage', (request) => { const value = nativeObservation(request); value.provenance.exhaustiveCoverageProven = false; return value; }, 'NATIVE_SELECTION_UNVERIFIED', 'blocked'],
    ['unverified native selection', (request) => { const value = nativeObservation(request); value.provenance.selectionProtocolVerified = false; return value; }, 'NATIVE_SELECTION_UNVERIFIED', 'blocked'],
    ['missing trace digest', (request) => { const value = nativeObservation(request); delete value.provenance.trace.traceDigest; return value; }, 'NATIVE_SELECTION_UNVERIFIED', 'blocked'],
    ['another session', (request) => { const value = nativeObservation(request); value.provenance.trace.sessionId = randomUUID(); return value; }, 'SELECTION_CORRELATION', 'error'],
    ['another harness version', (request) => { const value = nativeObservation(request); value.provenance.trace.harnessVersion = 'different-version'; return value; }, 'SELECTION_CORRELATION', 'error'],
  ]) await t.test(name, async (t) => {
    const inputs = await routingInputs(t);
    const result = await runClaudeNativeRouting({ ...inputs, ...nativeBoundaries({
      observeSession: async (_processResult, request) => observation(request),
    }) });
    assert.equal(result.status, status);
    assert.equal(result.code, code);
    assert.equal(result.routingSessions.length, 1);
    assert.equal(result.routingSessions[0].observed, undefined);
    assert.equal(result.routingSessions[0].sessionClosed, true);
    assert.deepEqual(result.artifacts, []);
    assert.deepEqual(result.explicitResults, []);
    assert.equal(result.protocolExecuted, false);
    assert.equal(result.implicitConsumerValidated, false);
    assert.equal(result.privateExplicitValidated, false);
  });
});

test('duplicate and unexpected native loaded lists remain exact nonpass observations rather than being filtered', async (t) => {
  for (const loaded of [['build-verify', 'build-verify'], ['agent-init']]) await t.test(JSON.stringify(loaded), async (t) => {
    const inputs = await routingInputs(t);
    const result = await runClaudeNativeRouting({ ...inputs, ...nativeBoundaries({
      observeSession: async (_processResult, request) => nativeObservation(request, loaded),
    }) });
    assert.equal(result.status, 'error');
    assert.equal(result.code, 'SELECTION_EVIDENCE');
    assert.deepEqual(result.routingSessions[0].observed.loaded, loaded);
    assert.deepEqual(result.artifacts, []);
    const fromDisk = JSON.parse(await readFile(result.reportPath, 'utf8'));
    assert.deepEqual(fromDisk.routingSessions[0].observed.loaded, loaded);
  });
});

test('a native routing mismatch remains a failed frozen artifact with the actual forbidden and missing selections', async (t) => {
  const inputs = await routingInputs(t);
  const result = await runClaudeNativeRouting({ ...inputs, ...nativeBoundaries({
    observeSession: async (_processResult, request) => request.id === 'node-build-verify-positive-01'
      ? nativeObservation(request, ['deployment']) : nativeObservation(request),
  }) });
  assert.equal(result.status, 'fail');
  assert.equal(result.code, 'ROUTING_MISMATCH');
  assert.equal(result.routingSessions.length, 26);
  assert.equal(result.implicitConsumerValidated, false);
  assert.equal(result.privateExplicitValidated, true);
  const record = result.artifacts[0];
  assert.deepEqual(record.artifact.observed.loaded, ['deployment']);
  assert.equal(record.artifact.result, 'fail');
  assert.equal(record.validation.ok, false);
  assert.ok(record.validation.errors.some((value) => value.startsWith('MISSING_SKILL:')));
  assert.ok(record.validation.errors.some((value) => value.startsWith('FORBIDDEN_SKILL:')));
  assert.deepEqual(JSON.parse(await readFile(record.artifactPath, 'utf8')).observed.loaded, ['deployment']);
});

test('a Claude-private explicit mismatch cannot borrow the passing implicit consumer result', async (t) => {
  const inputs = await routingInputs(t);
  const result = await runClaudeNativeRouting({ ...inputs, ...nativeBoundaries({
    observeSession: async (_processResult, request) => request.id === '03-node-pnpm-build-verify-explicit-01'
      ? nativeObservation(request, ['deployment']) : nativeObservation(request),
  }) });
  assert.equal(result.status, 'fail');
  assert.equal(result.code, 'ROUTING_MISMATCH');
  assert.equal(result.artifacts.length, 21);
  assert.equal(result.explicitResults.length, 5);
  assert.equal(result.implicitConsumerValidated, true);
  assert.equal(result.privateExplicitValidated, false);
  const explicit = result.explicitResults[0];
  assert.equal(explicit.consumerValidated, false);
  assert.equal(explicit.result, 'fail');
  assert.deepEqual(explicit.observed.loaded, ['deployment']);
  assert.equal(explicit.thresholdQualified, false);
});

test('readonly seals guard the invocation and observer against writes to any contributor or archived baseline', async (t) => {
  for (const phase of ['routing', 'observe']) await t.test(phase, async (t) => {
    const inputs = await routingInputs(t);
    let observations = 0;
    let closures = 0;
    const mutate = () => chmod(path.join(inputs.setups[5].routingFixtureRoot, 'repository/package.json'), 0o600);
    const result = await runClaudeNativeRouting({ ...inputs, ...nativeBoundaries({
      invokeSession: async (request) => {
        if (request.phase === 'close') { closures += 1; return { closed: true, sessionId: request.sessionId, id: request.id }; }
        if (phase === 'routing') await mutate();
        return { status: 0 };
      },
      observeSession: async (_processResult, request) => { observations += 1; if (phase === 'observe') await mutate(); return nativeObservation(request); },
    }) });
    assert.equal(result.status, 'error');
    assert.equal(result.code, 'ROUTING_WRITES');
    assert.equal(result.routingSessions.length, 1);
    assert.equal(result.routingSessions[0].zeroWrites, false);
    assert.equal(result.routingSessions[0].sessionClosed, true);
    assert.equal(observations, phase === 'observe' ? 1 : 0);
    assert.equal(closures, 1);
    assert.deepEqual(result.artifacts, []);
  });
});

test('close acknowledgements are correlated and an unclosed routing session cannot advance to another prompt', async (t) => {
  for (const closed of [{ closed: true }, { closed: false }, { closed: true, sessionId: randomUUID(), id: 'wrong-probe' }]) await t.test(JSON.stringify(closed), async (t) => {
    const inputs = await routingInputs(t);
    const result = await runClaudeNativeRouting({ ...inputs, ...nativeBoundaries({
      invokeSession: async (request) => request.phase === 'close' ? closed : { status: 0 },
    }) });
    assert.equal(result.status, 'error');
    assert.equal(result.code, 'SESSION_CLOSE_FAILED');
    assert.equal(result.routingSessions.length, 1);
    assert.equal(result.routingSessions[0].sessionClosed, false);
    assert.deepEqual(result.artifacts, []);
  });
});

test('native observer accessors are malformed data and never execute during routing consumption', async (t) => {
  const inputs = await routingInputs(t);
  let getterReads = 0;
  const result = await runClaudeNativeRouting({ ...inputs, ...nativeBoundaries({
    observeSession: async (_processResult, request) => {
      const value = nativeObservation(request);
      Object.defineProperty(value, 'loaded', { enumerable: true, get() { getterReads += 1; return ['build-verify']; } });
      return value;
    },
  }) });
  assert.equal(result.status, 'error');
  assert.equal(result.code, 'SELECTION_MALFORMED');
  assert.equal(getterReads, 0);
  assert.equal(result.routingSessions[0].sessionClosed, true);
  assert.equal(result.routingSessions[0].observed, undefined);
});

test('harness metadata cannot inject recognizable credentials into reports or artifacts', async (t) => {
  const inputs = await routingInputs(t);
  const secret = 'sk-ant-routing-version-must-not-retain';
  inputs.harnessVersion = secret;
  const boundaries = nativeBoundaries({ observeSession: async (_processResult, request) => {
    const value = nativeObservation(request); value.provenance.trace.harnessVersion = secret; return value;
  } });
  let calls = 0;
  const result = await runClaudeNativeRouting({ ...inputs, ...boundaries,
    invokeSession: async (request) => { calls += 1; return boundaries.invokeSession(request); },
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.code, 'NATIVE_METADATA_REQUIRED');
  assert.equal(calls, 0);
  assert.deepEqual(result.artifacts, []);
});

test('unserializable setup descriptors fail closed instead of throwing out of the public runner', async (t) => {
  const inputs = await routingInputs(t);
  inputs.setups[0].accidentalCallback = () => {};
  const result = await runClaudeNativeRouting({ ...inputs, invokeSession: neverInvoke, observeSession: neverInvoke });
  assert.equal(result.status, 'error');
  assert.equal(result.code, 'SETUP_DESCRIPTOR_INVALID');
  assert.deepEqual(result.routingSessions, []);
});

test('close acknowledgement accessors cannot mutate a context after the readonly guard', async (t) => {
  const inputs = await routingInputs(t);
  let getterReads = 0;
  const result = await runClaudeNativeRouting({ ...inputs, ...nativeBoundaries({
    invokeSession: async (request) => {
      if (request.phase !== 'close') return { status: 0 };
      return { sessionId: request.sessionId, id: request.id, get closed() { getterReads += 1; return true; } };
    },
  }) });
  assert.equal(result.status, 'error');
  assert.equal(result.code, 'SESSION_CLOSE_FAILED');
  assert.equal(getterReads, 0);
  assert.equal(result.routingSessions.length, 1);
  assert.deepEqual(result.artifacts, []);
});

test('native process envelopes with executable properties remain failed without reading them', async (t) => {
  const inputs = await routingInputs(t);
  let getterReads = 0;
  let observations = 0;
  const result = await runClaudeNativeRouting({ ...inputs, ...nativeBoundaries({
    invokeSession: async (request) => request.phase === 'close'
      ? { closed: true, sessionId: request.sessionId, id: request.id }
      : { get status() { getterReads += 1; return 0; } },
    observeSession: async (_processResult, request) => { observations += 1; return nativeObservation(request); },
  }) });
  assert.equal(result.status, 'error');
  assert.equal(result.code, 'NATIVE_PROCESS_FAILED');
  assert.equal(getterReads, 0);
  assert.equal(observations, 0);
  assert.equal(result.routingSessions[0].sessionClosed, true);
});

test('native callbacks cannot redirect artifact persistence through a replaced directory', async (t) => {
  const inputs = await routingInputs(t);
  const outside = path.join(inputs.root, 'redirect-target');
  await mkdir(outside);
  const result = await runClaudeNativeRouting({ ...inputs, ...nativeBoundaries({
    invokeSession: async (request) => {
      if (request.phase !== 'close') return { status: 0 };
      const [namespace] = await readdir(inputs.evidenceRoot);
      const output = path.join(inputs.evidenceRoot, namespace, 'implicit');
      await rm(output, { recursive: true });
      await symlink(outside, output);
      return { closed: true, sessionId: request.sessionId, id: request.id };
    },
  }) });
  assert.equal(result.status, 'error');
  assert.equal(result.code, 'EVIDENCE_SCOPE');
  assert.equal(result.routingSessions.length, 1);
  assert.deepEqual(result.artifacts, []);
  assert.deepEqual(await readdir(outside), []);
});

test('26 fresh native sessions round-trip actual declared loads through frozen consumers without qualification', async (t) => {
  const inputs = await routingInputs(t);
  const requests = [];
  const boundaries = nativeBoundaries();
  const result = await runClaudeNativeRouting({ ...inputs, ...boundaries,
    invokeSession: async (request) => { requests.push(request); return boundaries.invokeSession(request); },
  });
  assert.equal(result.status, 'pass');
  assert.equal(result.code, 'ROUTING_PROTOCOL_VALIDATED');
  assert.equal(result.protocolExecuted, true);
  assert.equal(result.implicitConsumerValidated, true);
  assert.equal(result.privateExplicitValidated, true);
  assert.equal(result.qualification, 'unqualified');
  assert.equal(result.liveSkillBehaviorProven, false);
  assert.equal(result.routingSessions.length, 26);
  assert.equal(result.artifacts.length, 21);
  assert.equal(result.explicitResults.length, 5);
  const runs = requests.filter((request) => request.phase === 'routing');
  const ids = [...inputs.setups.map((setup) => setup.sessionId), ...runs.map((request) => request.sessionId)];
  assert.equal(new Set(ids).size, 32);
  assert.equal(runs.length, 26);
  for (const request of runs) {
    assert.match(request.sessionId, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    assert.deepEqual(request.history, []);
    assert.equal(request.resume, false);
    assert.equal(request.profile.readOnly, true);
    assert.equal(request.profile.bashEnabled, false);
    assert.equal(request.profile.mutationEnabled, false);
    assert.deepEqual(request.profile.allowedTools, ['Read', 'Glob', 'Grep', 'Skill', 'EndConversation']);
    assert.equal(request.expected, undefined);
    assert.equal(request.setupSessionIds, undefined);
    assert.equal(Object.isFrozen(request.profile), true);
  }
  const collision = runs.find((request) => request.id === 'node-build-verify-deployment-collision-01');
  assert.deepEqual(collision.contributors, [
    { fixtureId: '03-node-pnpm', cwd: inputs.setups[0].roots.finalRoot },
    { fixtureId: '15-deployment', cwd: inputs.setups[5].roots.finalRoot },
  ]);
  assert.deepEqual(collision.discoveryDirectories, collision.contributors.map((entry) => entry.cwd));
  assert.equal(requests.filter((request) => request.phase === 'close').length, 26);
  assert.equal(result.routingSessions.every((entry) => entry.sessionClosed && entry.zeroWrites), true);
  for (const record of result.artifacts) {
    const entry = inputs.preparation.cases.find((candidate) => candidate.prepared.case.id === record.id);
    const fromDisk = JSON.parse(await readFile(record.artifactPath, 'utf8'));
    assert.deepEqual(fromDisk, record.artifact);
    const evaluation = await evaluateTriggerArtifact(fromDisk, { ...entry.inputs, caseId: record.id });
    assert.equal(evaluation.ok, true, evaluation.errors.join('\n'));
    assert.equal(evaluation.result, 'pass');
    assert.equal(evaluation.claims.liveSkillBehaviorProven, false);
    assert.equal(evaluation.claims.claudeCodeBehaviorProven, false);
    assert.equal(evaluation.claims.codexBehaviorProven, false);
    assert.equal(record.provenance.executionKind, 'test-double');
    assert.equal(record.provenance.qualification, 'unqualified');
    assert.equal(record.artifact.provenance, undefined);
    const sidecar = JSON.parse(await readFile(record.provenancePath, 'utf8'));
    assert.equal(sidecar.sessionId, record.provenance.sessionId);
    assert.equal(sidecar.zeroWrites, true);
  }
  assert.deepEqual(result.explicitResults.map((entry) => [entry.id, entry.invocation.prompt, entry.observed.loaded]), [
    ['03-node-pnpm-build-verify-explicit-01', '/build-verify', ['build-verify']],
    ['11-maven-multi-module-build-verify-build-verify-explicit-01', '/build-verify', ['build-verify']],
    ['12-flyway-database-migration-database-migration-explicit-01', '/database-migration', ['database-migration']],
    ['13-audit-log-audit-log-explicit-01', '/audit-log', ['audit-log']],
    ['15-deployment-deployment-explicit-01', '/deployment', ['deployment']],
  ]);
  for (const entry of result.explicitResults) {
    assert.equal(entry.consumerValidated, false);
    assert.equal(entry.result, 'pass');
    assert.equal(entry.harness, 'claude-code');
    assert.equal(entry.harnessVersion, 'native-session-double-v1');
    assert.match(entry.digests.motherSkillDigest, /^sha256:[a-f0-9]{64}$/);
    assert.match(entry.digests.generatedSkillDigest, /^sha256:[a-f0-9]{64}$/);
    assert.match(entry.digests.fixtureDigest, /^sha256:[a-f0-9]{64}$/);
    assert.match(entry.digests.triggerCorpusDigest, /^sha256:[a-f0-9]{64}$/);
    assert.match(entry.artifactPath, /claude-explicit/);
    assert.equal(entry.thresholdQualified, false);
  }
});
