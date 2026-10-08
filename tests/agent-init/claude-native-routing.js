import { randomUUID, createHash } from 'node:crypto';
import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual, types } from 'node:util';

import { digestTree, readRegularFileNoFollow } from '../../src/installation/filesystem.js';
import { validateWriteTargetPhysicalScope } from './evaluation-harness.js';
import { sensitiveClaudeText } from './claude-input-policy.js';
import { assertClaudeContextsFresh, snapshotContext } from './claude-protocol.js';
import { createTriggerArtifact, evaluateTriggerArtifact, loadTriggerCorpus, prepareTriggerCase } from './trigger-evaluation.js';

const requiredProofFields = ['selectionProtocolVerified', 'sourceAttributionProven', 'exhaustiveCoverageProven', 'hookCoverageProven'];
const proofFields = [...requiredProofFields, 'permissionFloorProven'];
const profile = Object.freeze({ readOnly: true, mutationEnabled: false, bashEnabled: false,
  businessCommandsEnabled: false, deploymentEnabled: false, databaseEnabled: false, stagingEnabled: false,
  allowedTools: Object.freeze(['Read', 'Glob', 'Grep', 'Skill', 'EndConversation']),
  instruction: 'Only observe native Skill routing. Do not execute workflows, business commands, validation commands, deployment, database or staging operations. Do not modify files or Agent assets.',
});
const sha256 = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const safeCode = (value, fallback) => typeof value === 'string' && /^[A-Z_]{1,80}$/.test(value) ? value : fallback;
const safeVersion = (value) => typeof value === 'string' && /^[0-9A-Za-z][0-9A-Za-z._()+ -]{0,127}$/.test(value) && !sensitiveClaudeText(value);

function immutable(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}

// External parser outputs are bounded passive data, not getter/toJSON programs.
function observationData(value) {
  const pending = [{ value, depth: 0 }];
  let nodes = 0;
  let bytes = 0;
  while (pending.length) {
    const entry = pending.pop();
    if (++nodes > 10000 || entry.depth > 64 || bytes > 1024 * 1024) throw failure('SELECTION_MALFORMED');
    if (typeof entry.value === 'string') bytes += Buffer.byteLength(entry.value);
    else if (entry.value && typeof entry.value === 'object') {
      if (types.isProxy(entry.value)) throw failure('SELECTION_MALFORMED');
      const array = Array.isArray(entry.value);
      if (!array && Object.getPrototypeOf(entry.value) !== Object.prototype) throw failure('SELECTION_MALFORMED');
      const descriptors = Object.getOwnPropertyDescriptors(entry.value);
      if (array && descriptors.length.value > 10000) throw failure('SELECTION_MALFORMED');
      for (const key of Reflect.ownKeys(descriptors)) {
        if (array && key === 'length') continue;
        const descriptor = descriptors[key];
        if (typeof key !== 'string' || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')
          || (array && !/^(?:0|[1-9][0-9]*)$/.test(key))) throw failure('SELECTION_MALFORMED');
        bytes += Buffer.byteLength(key);
        pending.push({ value: descriptor.value, depth: entry.depth + 1 });
      }
    } else if (entry.value !== null && !['undefined', 'boolean', 'number'].includes(typeof entry.value)) throw failure('SELECTION_MALFORMED');
    else if (typeof entry.value === 'number' && !Number.isFinite(entry.value)) throw failure('SELECTION_MALFORMED');
  }
  if (bytes > 1024 * 1024) throw failure('SELECTION_MALFORMED');
  return structuredClone(value);
}

function healthyProcess(value) {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string' || !Object.hasOwn(descriptors[key], 'value'))) return false;
  return descriptors.status?.value === 0 && ['signal', 'spawnError', 'cleanupError', 'timedOut', 'truncated', 'stopReason']
    .every((field) => !descriptors[field]?.value);
}

function safeProvenance(observed) {
  const source = observed?.provenance;
  const trace = source?.trace;
  const result = { evidenceSource: source?.evidenceSource === 'native-parser' ? 'native-parser' : 'unverified',
    ...Object.fromEntries(proofFields.map((field) => [field, source?.[field] === true])) };
  if (trace) result.trace = {
    ...(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(trace.sessionId ?? '') ? { sessionId: trace.sessionId } : {}),
    ...(safeVersion(trace.harnessVersion) ? { harnessVersion: trace.harnessVersion } : {}),
    ...(/^sha256:[a-f0-9]{64}$/.test(trace.traceDigest ?? '') ? { traceDigest: trace.traceDigest } : {}),
    ...(Number.isSafeInteger(trace.traceBytes) && trace.traceBytes > 0 ? { traceBytes: trace.traceBytes } : {}) };
  return result;
}

function failure(code) { return Object.assign(new Error(code), { code }); }

async function verifyContextBindings(preparation, setups, corpus) {
  const fixtureRoots = Object.fromEntries(setups.map((setup) => [setup.fixtureId, setup.routingFixtureRoot]));
  const sessionIds = setups.map((setup) => setup.sessionId);
  if (new Set(sessionIds).size !== sessionIds.length || sessionIds.some((id) => typeof id !== 'string'
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id))) throw failure('SETUP_IDENTITY');
  for (const setup of setups) {
    const manifest = corpus.fixtures.get(setup.fixtureId).fixture;
    if (!path.isAbsolute(setup.fixtureRoot) || !path.isAbsolute(setup.routingFixtureRoot)
      || setup.roots.finalRoot !== path.join(setup.fixtureRoot, manifest.repository)
      || (await validateWriteTargetPhysicalScope(setup.fixtureRoot, manifest.repository)).length
      || JSON.parse(await readRegularFileNoFollow(path.join(setup.fixtureRoot, 'fixture.json'), 'utf8')).id !== setup.fixtureId
      || await digestTree(setup.routingFixtureRoot) !== await digestTree(corpus.fixtures.get(setup.fixtureId).directory)) throw failure('ROUTING_CONTEXT_BINDING');
  }
  for (const entry of preparation.cases) {
    if (!isDeepStrictEqual(entry.inputs.fixtureRoots, fixtureRoots)) throw failure('ROUTING_CONTEXT_BINDING');
    for (const [name, fixtureId] of Object.entries(entry.prepared.case.skillFixtures)) {
      const setup = setups.find((candidate) => candidate.fixtureId === fixtureId);
      const target = `.agents/skills/${name}`;
      if (!setup || entry.inputs.generatedSkills[name] !== path.join(setup.roots.finalRoot, target)
        || (await validateWriteTargetPhysicalScope(setup.roots.finalRoot, target)).length) throw failure('ROUTING_CONTEXT_BINDING');
    }
  }
}

async function verifyPreparation(preparation, motherSkillRoot) {
  const corpus = await loadTriggerCorpus();
  if (!Array.isArray(preparation?.cases) || preparation.cases.length !== 21 || corpus.cases.length !== 21) throw new Error('preparation');
  const explicit = new Map();
  for (const [index, triggerCase] of corpus.cases.entries()) {
    const entry = preparation.cases[index];
    const inputs = { fixtureRoots: entry.inputs.fixtureRoots, generatedSkills: entry.inputs.generatedSkills, motherSkillRoot };
    const fresh = await prepareTriggerCase(triggerCase.id, inputs);
    if (!isDeepStrictEqual(entry.inputs, inputs) || !isDeepStrictEqual(entry.prepared, fresh)
      || !isDeepStrictEqual(entry.discoveryDirectories, [...new Set([triggerCase.fixture, ...Object.values(triggerCase.skillFixtures)])]
        .map((id) => path.join(inputs.fixtureRoots[id], 'repository')))) throw new Error('preparation');
    if (triggerCase.category === 'positive') for (const [skill, fixture] of Object.entries(triggerCase.skillFixtures)) {
      const id = `${fixture}-${skill}-explicit-01`;
      const prompt = `/${skill}`;
      explicit.set(id, { id, kind: 'explicit-invocation', fixture, skill, prompt, promptDigest: sha256(prompt),
        digests: fresh.digests, consumerValidated: false, liveSkillBehaviorProven: false });
    }
  }
  if (explicit.size !== 5 || !isDeepStrictEqual(preparation.explicitProbes, [...explicit.values()])) throw new Error('explicit preparation');
}

// No CLI, authentication, environment, model choice or fallback is owned here.
// invokeSession(request) runs/closes the runner-owned native process. Its close
// acknowledgement is {closed:true,sessionId,id}. observeSession(processResult,
// request) returns native parser status/loaded/provenance, never model text.
export async function runClaudeNativeRouting(options = {}) {
  const result = { status: 'blocked', code: 'ROUTING_NOT_RUN', executionKind: options.executionKind ?? 'test-double',
    qualification: 'unqualified', thresholdQualified: false, liveSkillBehaviorProven: false,
    routingSessions: [], artifacts: [], explicitResults: [] };
  const { invokeSession, observeSession, motherSkillRoot, evidenceRoot, harnessVersion } = options;
  if (!['test-double', 'real-cli'].includes(options.executionKind) || !safeVersion(harnessVersion)) {
    return { ...result, executionKind: 'unverified', code: 'NATIVE_METADATA_REQUIRED' };
  }
  let setups;
  try { setups = observationData(options.setups); }
  catch { return { ...result, status: 'error', code: 'SETUP_DESCRIPTOR_INVALID' }; }
  if (!Array.isArray(setups) || !setups.length || setups.some((setup) => setup.status !== 'pass' || setup.sessionClosed !== true)) {
    return { ...result, code: 'SETUP_NOT_CLOSED' };
  }
  const corpus = await loadTriggerCorpus();
  const requiredFixtureIds = [...new Set(corpus.cases.flatMap((entry) => [entry.fixture, ...Object.values(entry.skillFixtures)]))].sort();
  if (!isDeepStrictEqual(setups.map((setup) => setup.fixtureId).sort(), requiredFixtureIds)) {
    return { ...result, code: 'FIXTURE_CONTEXT_REQUIRED' };
  }
  try { await assertClaudeContextsFresh(setups); }
  catch { return { ...result, status: 'error', code: 'SETUP_CONTEXT_STALE' }; }
  if (typeof invokeSession !== 'function' || typeof observeSession !== 'function') return { ...result, code: 'NATIVE_BOUNDARIES_REQUIRED' };
  let preparation;
  try {
    preparation = observationData(options.preparation);
    await verifyPreparation(preparation, motherSkillRoot);
    await verifyContextBindings(preparation, setups, corpus);
  } catch (cause) { return { ...result, status: 'error', code: safeCode(cause.code, 'ROUTING_PREPARATION_STALE') }; }
  const requests = [
    ...preparation.cases.map((entry) => ({ id: entry.prepared.case.id, kind: 'implicit', prompt: entry.prepared.case.prompt, entry })),
    ...preparation.explicitProbes.map((probe) => ({ id: probe.id, kind: 'explicit', prompt: probe.prompt, probe })),
  ];
  const roots = [...new Set([...setups.flatMap((setup) => [setup.fixtureRoot, setup.routingFixtureRoot]), motherSkillRoot])];
  const snapshot = () => Promise.all(roots.map((root) => snapshotContext(root)));
  try {
    if (typeof evidenceRoot !== 'string' || !path.isAbsolute(evidenceRoot)) throw failure('EVIDENCE_SCOPE');
    const evidenceStat = await lstat(evidenceRoot);
    const physicalEvidence = await realpath(evidenceRoot);
    if (!evidenceStat.isDirectory() || evidenceStat.isSymbolicLink()) throw failure('EVIDENCE_SCOPE');
    for (const root of roots) {
      const relative = path.relative(await realpath(root), physicalEvidence);
      if (relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) throw failure('EVIDENCE_SCOPE');
    }
  } catch { return { ...result, status: 'error', code: 'EVIDENCE_SCOPE' }; }
  const baseline = await snapshot();
  let persistenceRoot;
  try {
    persistenceRoot = path.join(evidenceRoot, `claude-native-routing-${randomUUID()}`);
    await mkdir(persistenceRoot, { mode: 0o700 });
    await mkdir(path.join(persistenceRoot, 'implicit'), { mode: 0o700 });
    await mkdir(path.join(persistenceRoot, 'claude-explicit'), { mode: 0o700 });
  } catch { return { ...result, status: 'error', code: 'ROUTING_PERSISTENCE_FAILED' }; }
  const persistenceStat = await lstat(persistenceRoot);
  const persistencePhysical = await realpath(persistenceRoot);
  async function persist(file, value) {
    const stat = await lstat(persistenceRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== persistenceStat.dev || stat.ino !== persistenceStat.ino
      || await realpath(persistenceRoot) !== persistencePhysical
      || (await validateWriteTargetPhysicalScope(persistenceRoot, path.relative(persistenceRoot, file).split(path.sep).join('/'))).length) throw failure('EVIDENCE_SCOPE');
    await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  }
  async function guardedCall(call, cleanup = false) {
    let code;
    try {
      await assertClaudeContextsFresh(setups);
      if (!isDeepStrictEqual(baseline, await snapshot())) code = 'ROUTING_WRITES';
    } catch { code = 'SETUP_CONTEXT_STALE'; }
    if (code && !cleanup) return { code, zeroWrites: false };
    let value;
    try { value = await call(); }
    catch (cause) { code ??= safeCode(cause.code, 'NATIVE_BOUNDARY_FAILED'); }
    try {
      if (!isDeepStrictEqual(baseline, await snapshot())) code = 'ROUTING_WRITES';
      await assertClaudeContextsFresh(setups);
    } catch { code = 'ROUTING_WRITES'; }
    return { value, code, zeroWrites: !['ROUTING_WRITES', 'SETUP_CONTEXT_STALE'].includes(code) };
  }
  for (const item of requests) {
    const sessionId = randomUUID();
    const fixtureIds = item.entry?.prepared.fixtureIds ?? [item.probe.fixture];
    const contributors = fixtureIds.map((id) => ({ fixtureId: id, cwd: setups.find((setup) => setup.fixtureId === id).roots.finalRoot }));
    const request = immutable({ phase: 'routing', id: item.id, kind: item.kind, sessionId, prompt: item.prompt,
      cwd: contributors.find((entry) => entry.fixtureId === (item.entry?.prepared.case.fixture ?? item.probe.fixture)).cwd,
      contributors, discoveryDirectories: contributors.map((entry) => entry.cwd), motherSkillRoot,
      history: [], resume: false, profile });
    const record = { id: item.id, kind: item.kind, sessionId, executionKind: result.executionKind,
      qualification: 'unqualified', sessionClosed: false, zeroWrites: true, liveSkillBehaviorProven: false };
    result.routingSessions.push(record);
    let observed;
    try {
      const invoked = await guardedCall(() => invokeSession(request));
      record.zeroWrites &&= invoked.zeroWrites;
      if (invoked.code) record.code = invoked.code;
      else if (!healthyProcess(invoked.value)) record.code = 'NATIVE_PROCESS_FAILED';
      else {
        const observation = await guardedCall(() => observeSession(invoked.value, request));
        record.zeroWrites &&= observation.zeroWrites;
        if (observation.code) record.code = observation.code;
        else observed = observationData(observation.value);
      }
      if (!record.code) {
        record.nativeProvenance = safeProvenance(observed);
        if (observed?.status !== 'observed') {
          record.code = safeCode(observed?.code, 'SELECTION_UNAVAILABLE');
          record.status = observed?.status === 'blocked' ? 'blocked' : 'error';
        } else if (observed.provenance?.trace?.sessionId !== sessionId
          || observed.provenance.trace.harnessVersion !== harnessVersion) record.code = 'SELECTION_CORRELATION';
        else {
          const loaded = observed.loaded;
          if (record.nativeProvenance.evidenceSource !== 'native-parser'
            || !record.nativeProvenance.trace?.traceDigest || !record.nativeProvenance.trace?.traceBytes
            || requiredProofFields.some((field) => !record.nativeProvenance[field])) {
            record.code = 'NATIVE_SELECTION_UNVERIFIED';
            record.status = 'blocked';
          } else if (!Array.isArray(loaded) || loaded.length > 64 || loaded.some((name) => typeof name !== 'string'
            || name.length > 128 || sensitiveClaudeText(name) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))) record.code = 'SELECTION_EVIDENCE';
          else {
            record.observed = { loaded: [...loaded] };
            if (new Set(loaded).size !== loaded.length || loaded.some((name) => !preparation.cases[0].prepared.knownSkills.includes(name))) record.code = 'SELECTION_EVIDENCE';
          }
        }
      }
    } catch { record.code = 'SELECTION_MALFORMED'; }
    finally {
      const closed = await guardedCall(() => invokeSession(immutable({ ...request, phase: 'close' })), true);
      record.zeroWrites &&= closed.zeroWrites;
      let acknowledgement;
      try { acknowledgement = observationData(closed.value); } catch { /* Malformed acknowledgements are not closure proof. */ }
      const correlated = acknowledgement?.sessionId === sessionId && acknowledgement.id === item.id;
      const notStarted = correlated && record.code === 'MODEL_PROCESS_BUDGET_EXHAUSTED'
        && acknowledgement.closed === false && acknowledgement.processStarted === false && acknowledgement.controlClosed === true
        && Object.keys(acknowledgement).sort().join(',') === 'closed,controlClosed,id,processStarted,sessionId';
      record.sessionClosed = correlated && acknowledgement.closed === true && acknowledgement.processStarted !== false;
      // Control-only admission failure is not native process closure. Establish
      // the distinction before persisting this record, never patch reports later.
      if (notStarted) Object.assign(record, { processStarted: false, controlClosed: true });
      if (!record.zeroWrites) Object.assign(record, { code: 'ROUTING_WRITES', status: 'error' });
      else if (!record.sessionClosed && !notStarted) Object.assign(record, { code: 'SESSION_CLOSE_FAILED', status: 'error' });
      else if (closed.code) Object.assign(record, { code: closed.code, status: 'error' });
    }
    if (record.code) {
      result.status = record.status ?? 'error';
      result.code = record.code;
      break;
    }
    const provenance = { id: item.id, sessionId, executionKind: result.executionKind, qualification: 'unqualified',
      request: { kind: item.kind, promptDigest: sha256(item.prompt), historyEmpty: true, resume: false, readOnly: true },
      contexts: fixtureIds.map((id) => {
        const setup = setups.find((entry) => entry.fixtureId === id);
        return { fixtureId: id, contextFingerprint: setup.expectedContextFingerprint, contextSeal: setup.expectedContextSeal,
          archivedBaselineFixtureDigest: setup.archivedBaselineFixtureDigest };
      }), native: record.nativeProvenance, zeroWrites: record.zeroWrites, sessionClosed: record.sessionClosed,
      contextConsumerValidated: false, liveSkillBehaviorProven: false };
    try {
      if (item.kind === 'implicit') {
      const artifact = createTriggerArtifact(item.entry.prepared, { harness: 'claude-code', harnessVersion,
        selectionEvidence: record.observed, recordedAt: new Date().toISOString() });
      const validation = await evaluateTriggerArtifact(artifact, { ...item.entry.inputs, caseId: item.id });
      const artifactPath = path.join(persistenceRoot, 'implicit', `${item.id}.json`);
      const provenancePath = path.join(persistenceRoot, 'implicit', `${item.id}.provenance.json`);
      await persist(artifactPath, artifact);
      await persist(provenancePath, provenance);
      result.artifacts.push({ id: item.id, artifact, validation, provenance, artifactPath, provenancePath });
      if (!validation.ok) Object.assign(result, { status: 'fail', code: 'ROUTING_MISMATCH' });
    } else {
      const artifactPath = path.join(persistenceRoot, 'claude-explicit', `${item.id}.json`);
      const exact = isDeepStrictEqual(record.observed.loaded, [item.probe.skill]);
      const explicit = { schemaVersion: 1, artifactType: 'claude-native-explicit-v1',
        id: item.id, kind: 'explicit-invocation', fixture: item.probe.fixture, harness: 'claude-code', harnessVersion,
        digests: structuredClone(item.probe.digests), recordedAt: new Date().toISOString(),
        invocation: { mode: 'explicit', skill: item.probe.skill, prompt: item.prompt }, promptDigest: sha256(item.prompt),
        observed: record.observed, result: exact ? 'pass' : 'fail', consumerValidated: false, thresholdQualified: false,
        executionKind: result.executionKind, qualification: 'unqualified', liveSkillBehaviorProven: false, provenance };
      await persist(artifactPath, explicit);
      result.explicitResults.push({ ...explicit, artifactPath });
      if (!exact) Object.assign(result, { status: 'fail', code: 'ROUTING_MISMATCH' });
      }
    } catch (cause) {
      Object.assign(result, { status: 'error', code: safeCode(cause.code, 'ROUTING_PERSISTENCE_FAILED') });
      break;
    }
  }
  result.protocolExecuted = result.routingSessions.length === requests.length
    && result.routingSessions.every((entry) => entry.sessionClosed && entry.zeroWrites && !entry.code);
  result.implicitConsumerValidated = result.artifacts.length === preparation.cases.length
    && result.artifacts.every((entry) => entry.validation.ok && entry.validation.result === 'pass');
  result.privateExplicitValidated = result.explicitResults.length === preparation.explicitProbes.length
    && result.explicitResults.every((entry) => entry.result === 'pass');
  if (result.code === 'ROUTING_NOT_RUN') Object.assign(result, { status: 'pass', code: 'ROUTING_PROTOCOL_VALIDATED' });
  result.reportPath = path.join(persistenceRoot, 'report.json');
  try {
    await persist(result.reportPath, { ...result,
      artifacts: result.artifacts.map(({ artifactPath, provenancePath, ...record }) => ({ ...record,
        artifactPath: path.relative(persistenceRoot, artifactPath), provenancePath: path.relative(persistenceRoot, provenancePath) })),
      explicitResults: result.explicitResults.map(({ artifactPath, ...record }) => ({ ...record, artifactPath: path.relative(persistenceRoot, artifactPath) })),
      reportPath: 'report.json',
    });
  } catch (cause) {
    delete result.reportPath;
    Object.assign(result, { status: 'error', code: safeCode(cause.code, 'ROUTING_PERSISTENCE_FAILED') });
  }
  return result;
}
