import { cp, lstat, readFile, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual, types } from 'node:util';

import { snapshotTree } from '../installation/helpers.js';
import { privateClaudeReference, sensitiveClaudeField, sensitiveClaudeText } from './claude-input-policy.js';
import { digestTree } from '../../src/installation/filesystem.js';
import { digestProposal, evaluateRunRecord, fingerprintPath, fingerprintRepository, validateWriteTargetPhysicalScope } from './evaluation-harness.js';

function stop(code) {
  throw Object.assign(new Error(code), { code });
}

function fixtureText(fixture) {
  const strings = new Set();
  const pending = [fixture];
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === 'string') strings.add(value);
    else if (value && typeof value === 'object') pending.push(...Object.values(value));
  }
  return strings;
}

function checkedSyntheticInput(value, allowedText = new Set()) {
  const holder = {};
  const pending = [{ value, depth: 0, target: holder, key: 'value' }];
  let nodes = 0;
  let bytes = 0;
  while (pending.length) {
    const entry = pending.pop();
    nodes += 1;
    if (nodes > 10000 || entry.depth > 64 || bytes > 1024 * 1024) stop('SYNTHETIC_INPUT_LIMIT');
    let normalized = entry.value;
    if (typeof entry.value === 'string') {
      bytes += Buffer.byteLength(entry.value);
      if (sensitiveClaudeText(entry.value)
        || (!allowedText.has(entry.value) && privateClaudeReference(entry.value))) stop('SYNTHETIC_INPUT_PRIVATE');
    } else if (entry.value && typeof entry.value === 'object') {
      if (types.isProxy(entry.value)) stop('SYNTHETIC_INPUT_INVALID');
      const array = Array.isArray(entry.value);
      if (!array && Object.getPrototypeOf(entry.value) !== Object.prototype) stop('SYNTHETIC_INPUT_INVALID');
      const descriptors = Object.getOwnPropertyDescriptors(entry.value);
      const keys = Reflect.ownKeys(descriptors);
      if (nodes + pending.length + keys.length > 10000 || (array && descriptors.length.value > 10000)) stop('SYNTHETIC_INPUT_LIMIT');
      normalized = array ? new Array(descriptors.length.value) : {};
      for (const key of keys) {
        if (array && key === 'length') continue;
        const descriptor = descriptors[key];
        if (typeof key !== 'string' || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')
          || (array && !/^(?:0|[1-9][0-9]*)$/.test(key))) stop('SYNTHETIC_INPUT_INVALID');
        if (sensitiveClaudeField(key) || sensitiveClaudeText(key)) stop('SYNTHETIC_INPUT_PRIVATE');
        bytes += Buffer.byteLength(key);
        pending.push({ value: descriptor.value, depth: entry.depth + 1, target: normalized, key });
      }
    } else if (entry.value !== null && !['number', 'boolean', 'undefined'].includes(typeof entry.value)) stop('SYNTHETIC_INPUT_INVALID');
    else if (typeof entry.value === 'number' && !Number.isFinite(entry.value)) stop('SYNTHETIC_INPUT_INVALID');
    // Define data properties, never invoke getters/toJSON or mutate through __proto__.
    Object.defineProperty(entry.target, entry.key, { value: normalized, enumerable: true, writable: true, configurable: true });
  }
  if (bytes > 1024 * 1024) stop('SYNTHETIC_INPUT_LIMIT');
  return holder.value;
}

export async function snapshotContext(root) {
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) stop('PATH_SCOPE');
  return [{ path: '.', type: 'directory', mode: stat.mode & 0o777, mtimeMs: stat.mtimeMs, identity: `${stat.dev}:${stat.ino}` },
    ...await snapshotTree(root)];
}

function exactWriteDelta(before, after, target) {
  const left = new Map(before.map((entry) => [entry.path, entry]));
  const right = new Map(after.map((entry) => [entry.path, entry]));
  for (const name of new Set([...left.keys(), ...right.keys()])) {
    if (name === target) continue;
    const prior = left.get(name);
    const current = right.get(name);
    const ancestor = name === '.' || target.startsWith(`${name}/`);
    if (prior?.type === 'directory' && current?.type === 'directory') {
      if (!isDeepStrictEqual({ ...prior, mtimeMs: 0 }, { ...current, mtimeMs: 0 })
        || (!ancestor && prior.mtimeMs !== current.mtimeMs)) return false;
    } else if (!prior && current?.type === 'directory') {
      if (!ancestor || current.mode !== (0o777 & ~process.umask())) return false;
    } else if (!isDeepStrictEqual(prior, current)) return false;
  }
  return !isDeepStrictEqual(left.get(target), right.get(target));
}

function changedLeaves(before, after) {
  const leaves = (tree) => new Map(tree.filter((entry) => entry.type !== 'directory').map((entry) => [entry.path, entry]));
  const left = leaves(before);
  const right = leaves(after);
  return [...new Set([...left.keys(), ...right.keys()])].filter((target) => !isDeepStrictEqual(left.get(target), right.get(target))).sort();
}

const writeOrder = ['agents', 'claude-adapter', 'project-skill', 'claude-skill-reference', 'agent-doc'];

function proposalSequence(events) {
  if (!Array.isArray(events) || events.length < 4
    || events.slice(0, 3).some((event, index) => event.type !== ['profile', 'classify', 'skills'][index])) return false;
  let prior;
  for (const proposal of events.slice(3)) {
    if (proposal.type !== 'proposal' || typeof proposal.id !== 'string' || !proposal.id
      || !Number.isSafeInteger(proposal.revision) || proposal.revision < 1) return false;
    if (prior && (proposal.id !== prior.id || proposal.revision <= prior.revision)) return false;
    prior = proposal;
  }
  return true;
}

function validationEvent(changedPaths) {
  return { type: 'validation', passed: true, changedPaths, forbiddenPathsChanged: [],
    preservationPassed: true, evidencePassed: true, singleSourcePassed: true, unknownsPreserved: true };
}
import { syntheticApproval, syntheticSession } from './claude-simulation/session.js';
import { syntheticRoutingSession } from './claude-simulation/observations.js';
import { createTriggerArtifact, evaluateTriggerArtifact } from './trigger-evaluation.js';

function approvalCode(proposal, approval) {
  if (approval == null) return 'APPROVAL_REQUIRED';
  if (approval.type !== 'approval' || !['approve', 'reject'].includes(approval.decision)
    || approval.scope !== 'exact-proposal' || !Array.isArray(approval.approvedActionIds)) return 'VAGUE_APPROVAL';
  if (approval.proposalId !== proposal.id || approval.revision !== proposal.revision) return 'STALE_APPROVAL';
  if (approval.proposalDigest !== digestProposal(proposal)) return 'APPROVAL_PAYLOAD';
  const writable = proposal.actions.filter((action) => ['CREATE', 'UPDATE'].includes(action.action)).map((action) => action.id);
  const ids = approval.approvedActionIds;
  if (new Set(ids).size !== ids.length || ids.some((id) => !writable.includes(id))) return 'APPROVAL_ACTIONS';
  if (approval.decision === 'reject') return ids.length ? 'APPROVAL_ACTIONS' : 'PROPOSAL_REJECTED';
  if (ids.length !== writable.length) return 'PARTIAL_APPROVAL';
  return null;
}

export async function assertClaudeContextsFresh(setups) {
  for (const setup of setups) {
    try {
      const snapshot = await snapshotContext(setup.roots.finalRoot);
      await snapshotContext(setup.routingFixtureRoot);
      if (setup.status !== 'pass' || !setup.sessionClosed || !setup.expectedContextFingerprint || !setup.expectedContextSeal
        || setup.expectedContextFingerprint !== await fingerprintRepository(setup.roots.finalRoot)
        || setup.expectedContextSeal !== digestProposal({ type: 'claude-context-seal-v1', snapshot })
        || setup.archivedBaselineFixtureDigest !== await digestTree(setup.routingFixtureRoot)) stop('SETUP_CONTEXT_STALE');
    } catch { stop('SETUP_CONTEXT_STALE'); }
  }
}

export async function simulateClaudeRouting(preparation, setups, motherSkillRoot, boundaries) {
  const result = { status: 'pass', code: 'SIMULATION_VALIDATED', simulationArtifacts: [], routingSessions: [] };
  if (setups.some((setup) => setup.status !== 'pass' || !setup.sessionClosed)) return { ...result, status: 'error', code: 'SETUP_NOT_CLOSED' };
  const session = boundaries.routingSession ?? syntheticRoutingSession;
  const requests = [
    ...preparation.cases.map((entry) => ({ id: entry.prepared.case.id, kind: 'implicit', prompt: entry.prepared.case.prompt, entry })),
    ...preparation.explicitProbes.map((probe) => ({ id: probe.id, kind: 'explicit', prompt: probe.prompt, probe })),
  ];
  for (const item of requests) {
    try { await assertClaudeContextsFresh(setups); }
    catch { return { ...result, status: 'error', code: 'SETUP_CONTEXT_STALE' }; }
    const sessionId = randomUUID();
    const fixtureIds = item.entry?.prepared.fixtureIds ?? [item.probe.fixture];
    const contributors = fixtureIds.map((id) => ({ fixtureId: id, cwd: setups.find((setup) => setup.fixtureId === id).roots.finalRoot }));
    const record = { id: item.id, kind: item.kind, sessionId, contributors, executionKind: 'test-double', qualification: 'unqualified',
      evidenceSource: 'test-double', sessionClosed: false, zeroWrites: false, liveSkillBehaviorProven: false };
    result.routingSessions.push(record);
    const roots = [...setups.flatMap((setup) => [setup.fixtureRoot, setup.routingFixtureRoot]), motherSkillRoot];
    const before = await Promise.all(roots.map((root) => snapshotContext(root)));
    let observation;
    try {
      observation = await session({ phase: 'routing', id: item.id, kind: item.kind, sessionId, prompt: item.prompt,
        history: [], contributors: structuredClone(contributors), motherSkillRoot, setupSessionIds: setups.map((setup) => setup.sessionId) });
      if (observation?.status !== 'observed') stop('SELECTION_UNAVAILABLE');
      if (observation.evidenceSource !== 'test-double' || observation.sessionId !== sessionId || observation.id !== item.id) stop('SELECTION_PROVENANCE');
      const loaded = observation.selectionEvidence?.loaded;
      if (!Array.isArray(loaded) || new Set(loaded).size !== loaded.length
        || loaded.some((name) => !preparation.cases[0].prepared.knownSkills.includes(name))) stop('SELECTION_EVIDENCE');
      record.observed = { loaded: [...loaded] };
    } catch (cause) {
      record.code = /^[A-Z_]+$/.test(cause.code ?? '') ? cause.code : 'SELECTION_SESSION_FAILED';
    } finally {
      try { record.sessionClosed = (await session({ phase: 'close', sessionId, id: item.id, contributors: structuredClone(contributors) }))?.closed === true; }
      catch { record.sessionClosed = false; }
      record.zeroWrites = isDeepStrictEqual(before, await Promise.all(roots.map((root) => snapshotContext(root))));
    }
    if (!record.sessionClosed || !record.zeroWrites || record.code) {
      return { ...result, status: 'error', code: !record.zeroWrites ? 'ROUTING_WRITES' : !record.sessionClosed ? 'SESSION_CLOSE_FAILED' : record.code };
    }
    const provenance = { executionKind: 'test-double', qualification: 'unqualified', evidenceSource: 'synthetic-observation-table',
      id: item.id, sessionId, request: { prompt: item.prompt, contributors },
      contextConsumerValidated: false,
      contexts: contributors.map(({ fixtureId }) => {
        const setup = setups.find((entry) => entry.fixtureId === fixtureId);
        return { fixtureId, archivedBaselineFixtureDigest: setup.archivedBaselineFixtureDigest,
          actualContextFingerprint: setup.expectedContextFingerprint, actualContextSeal: setup.expectedContextSeal };
      }), observed: record.observed, zeroWrites: record.zeroWrites,
      sessionClosed: record.sessionClosed, liveSkillBehaviorProven: false };
    if (item.kind === 'implicit') {
      const artifact = createTriggerArtifact(item.entry.prepared, { harness: 'claude-code', harnessVersion: 'test-double/synthetic-v1',
        selectionEvidence: record.observed, recordedAt: new Date().toISOString() });
      const validation = await evaluateTriggerArtifact(artifact, { ...item.entry.inputs, caseId: item.id });
      result.simulationArtifacts.push({ id: item.id, kind: item.kind, artifact, validation, provenance, executionKind: 'test-double',
        qualification: 'unqualified', liveSkillBehaviorProven: false });
      if (!validation.ok) Object.assign(result, { status: 'fail', code: 'SIMULATION_ROUTING_MISMATCH' });
    } else {
      const passed = isDeepStrictEqual(record.observed.loaded, [item.probe.skill]);
      result.simulationArtifacts.push({ ...item.probe, id: item.id, kind: item.kind, executionKind: 'test-double', qualification: 'unqualified',
        invocation: { mode: 'explicit', skill: item.probe.skill, prompt: item.prompt }, observed: record.observed,
        result: passed ? 'pass' : 'fail', provenance, consumerValidated: false, liveSkillBehaviorProven: false });
      if (!passed) Object.assign(result, { status: 'fail', code: 'SIMULATION_ROUTING_MISMATCH' });
    }
  }
  return result;
}

// Private Claude-only controller. All writable roots are created by the runner.
export async function simulateClaudeSetup({ root, source, fixtureId }, boundaries) {
  const fixtureRoot = path.join(root, 'setups', fixtureId);
  await cp(path.join(source, 'tests/fixtures', fixtureId), fixtureRoot, { recursive: true, verbatimSymlinks: true });
  const fixture = JSON.parse(await readFile(path.join(fixtureRoot, 'fixture.json'), 'utf8'));
  const allowedText = fixtureText(fixture);
  const cwd = path.join(fixtureRoot, fixture.repository);
  const roots = { finalRoot: cwd };
  roots.initialRoot = path.join(root, 'snapshots', fixtureId, 'initial');
  await cp(cwd, roots.initialRoot, { recursive: true, verbatimSymlinks: true });
  const before = await snapshotContext(cwd);
  const sessionId = randomUUID();
  const session = boundaries.session ?? syntheticSession;
  const setup = { fixtureId, fixtureRoot, routingFixtureRoot: path.join(source, 'tests/fixtures', fixtureId), sessionId, roots,
    executionKind: 'test-double', qualification: 'unqualified',
    writeEvents: [], sessionClosed: false, liveSkillBehaviorProven: false };
  let currentAction;
  let activePhase = 'proposal';
  try {
    const response = await session({ phase: 'proposal', sessionId, fixture: structuredClone(fixture), cwd, history: [] });
    const normalized = checkedSyntheticInput(response, allowedText);
    if (!proposalSequence(normalized.events)) return Object.assign(setup, { status: 'error', code: 'PROPOSAL_SEQUENCE' });
    setup.run = { schemaVersion: 1, fixtureId, harness: 'recorded-contract', evidenceLedger: normalized.evidenceLedger,
      events: [
        { type: 'preflight', readOnly: true, baselineId: `synthetic-baseline-${fixtureId}`,
          repositoryFingerprintBefore: await fingerprintRepository(roots.initialRoot),
          git: { isRepository: false, staged: [], unstaged: [], untracked: [] }, existingAgentAssets: fixture.expected.detection.agentConfigPaths },
        { type: 'explore', readOnly: true, repositoryFingerprintAfter: await fingerprintRepository(cwd),
          strategy: ['search', 'read-relevant', 'cross-check'], sensitiveFiles: 'presence-only' },
        ...normalized.events,
      ], externalAcceptance: { claudeCode: { status: 'not-run', evidence: null }, codex: { status: 'not-run', evidence: null } } };
    setup.proposal = normalized.events.findLast((event) => event.type === 'proposal');
    setup.proposalDigest = digestProposal(setup.proposal);
    setup.decisionSummary = { executionKind: 'test-double', qualification: 'unqualified', noWritesBeforeApproval: true,
      projectSummary: setup.proposal.projectSummary,
      decisions: Object.fromEntries(['CREATE', 'UPDATE', 'KEEP', 'SKIP', 'RECOMMEND'].map((decision) => [decision,
        setup.proposal.actions.filter((action) => action.action === decision).map(({ id, target, reason, evidenceIds }) => ({ id, target, reason, evidenceIds }))])),
      recommendedWriteActionIds: setup.proposal.actions.filter((action) => ['CREATE', 'UPDATE'].includes(action.action)).map((action) => action.id),
      syntheticApprovalTemplate: await syntheticApproval({ proposal: setup.proposal }), liveSkillBehaviorProven: false };
    setup.zeroProposalWrites = isDeepStrictEqual(before, await snapshotContext(cwd));
    roots.proposalRoot = path.join(root, 'snapshots', fixtureId, 'proposal');
    await cp(cwd, roots.proposalRoot, { recursive: true, verbatimSymlinks: true });
    if (!setup.zeroProposalWrites) return Object.assign(setup, { status: 'error', code: 'UNAPPROVED_WRITES' });
    roots.preWriteRoot = path.join(root, 'snapshots', fixtureId, 'pre-write');
    await cp(cwd, roots.preWriteRoot, { recursive: true, verbatimSymlinks: true });
    // A separate reject-only validation input checks payload/scope, not authority.
    const gateInput = structuredClone(setup.run);
    gateInput.events.push({ type: 'approval', decision: 'reject', scope: 'exact-proposal', proposalId: setup.proposal.id,
      revision: setup.proposal.revision, proposalDigest: setup.proposalDigest, approvedActionIds: [] },
    validationEvent([]), { type: 'reconcile', mode: 'dry-run', proposalActions: [], writes: [] });
    setup.proposalValidation = await evaluateRunRecord(fixture, gateInput, roots);
    for (const proposal of normalized.events.filter((event) => event.type === 'proposal')) {
      for (const action of proposal.actions.filter((entry) => entry.kind === 'claude-skill-reference' && ['CREATE', 'UPDATE'].includes(entry.action))) {
        const canonical = `.agents/skills/${path.posix.basename(action.target)}`;
        if (action.canonicalTarget !== canonical || action.linkText !== path.posix.relative(path.posix.dirname(action.target), canonical)
          || (await validateWriteTargetPhysicalScope(cwd, canonical)).length) {
          setup.proposalValidation.errors.push('SINGLE_SOURCE: reference must be a contained relative canonical Skill link');
          setup.proposalValidation.ok = false;
        }
      }
    }
    if (!setup.proposalValidation.ok) return Object.assign(setup, { status: 'error', code: 'PROPOSAL_INVALID' });
    activePhase = 'approval';
    const approval = checkedSyntheticInput(await (boundaries.approval ?? syntheticApproval)({ proposal: structuredClone(setup.proposal),
      proposalDigest: setup.proposalDigest, fixtureId, sessionId }));
    setup.approvalSource = 'test-double';
    setup.approval = approval;
    const blockedCode = approvalCode(setup.proposal, approval);
    if (blockedCode) return Object.assign(setup, { status: 'blocked', code: blockedCode });
    if (!isDeepStrictEqual(before, await snapshotContext(cwd))) stop('FINGERPRINT_DRIFT');
    setup.run.events.push(structuredClone(approval));
    const actions = setup.proposal.actions.filter((action) => ['CREATE', 'UPDATE'].includes(action.action))
      .sort((left, right) => writeOrder.indexOf(left.kind) - writeOrder.indexOf(right.kind));
    activePhase = 'write';
    for (const action of actions) {
      currentAction = action;
      if (digestProposal(setup.proposal) !== setup.proposalDigest) stop('APPROVAL_PAYLOAD');
      if ((await validateWriteTargetPhysicalScope(cwd, action.target)).length) stop('PATH_SCOPE');
      const fingerprint = await fingerprintPath(cwd, action.target);
      if (fingerprint !== action.baselineFingerprint) stop('FINGERPRINT_DRIFT');
      const prior = await snapshotContext(cwd);
      const observed = [];
      const response = await session({ phase: 'write', sessionId, cwd, action: structuredClone(action),
        proposal: structuredClone(setup.proposal), emitWrite: (event) => {
          const recorded = checkedSyntheticInput(event);
          observed.push(recorded);
          setup.writeEvents.push(recorded);
          setup.run.events.push(recorded);
        } });
      if (observed.length !== 1 || !isDeepStrictEqual(observed[0], { type: 'write', proposalId: setup.proposal.id,
        revision: setup.proposal.revision, actionId: action.id, target: action.target, observedBeforeFingerprint: fingerprint })) stop('WRITE_EVENT_INVALID');
      if (response?.completed !== true) stop('WRITE_FAILED');
      if (action.kind === 'claude-skill-reference') {
        if ((await validateWriteTargetPhysicalScope(cwd, action.canonicalTarget)).length) stop('PATH_SCOPE');
        if (await realpath(path.join(cwd, action.target)) !== await realpath(path.join(cwd, action.canonicalTarget))) stop('REFERENCE_UNRESOLVED');
      }
      if (!exactWriteDelta(prior, await snapshotContext(cwd), action.target)) stop('WRITE_DELTA_INVALID');
    }
    currentAction = undefined;
    activePhase = 'reconcile';
    setup.run.events.push(validationEvent(changedLeaves(before, await snapshotContext(cwd))));
    const beforeReconcile = await snapshotContext(cwd);
    const reconcile = checkedSyntheticInput(await session({ phase: 'reconcile', sessionId, cwd, proposal: structuredClone(setup.proposal) }));
    setup.reconcileZeroChurn = isDeepStrictEqual(beforeReconcile, await snapshotContext(cwd));
    if (!setup.reconcileZeroChurn || reconcile?.type !== 'reconcile' || reconcile.mode !== 'dry-run'
      || !Array.isArray(reconcile.writes) || reconcile.writes.length || !Array.isArray(reconcile.proposalActions)
      || reconcile.proposalActions.some((action) => ['CREATE', 'UPDATE'].includes(action.action))) stop('RECONCILE_CHANGED');
    setup.run.events.push(JSON.parse(JSON.stringify(reconcile)));
    setup.validation = await evaluateRunRecord(fixture, setup.run, roots);
    if (!setup.validation.ok) stop('SETUP_VALIDATION_FAILED');
    return Object.assign(setup, { status: 'pass', code: 'SYNTHETIC_SETUP_VALIDATED' });
  } catch (cause) {
    const code = /^[A-Z_]+$/.test(cause.code ?? '') ? cause.code : 'SIMULATION_SESSION_FAILED';
    setup.failedAction = { phase: activePhase, ...(currentAction ? { actionId: currentAction.id, target: currentAction.target } : {}), code };
    return Object.assign(setup, { status: 'error', code });
  } finally {
    const beforeClose = await snapshotContext(cwd);
    try {
      const closed = await session({ phase: 'close', sessionId, cwd });
      setup.sessionClosed = closed?.closed === true;
    } catch { setup.sessionClosed = false; }
    const final = await snapshotContext(cwd);
    if (!setup.sessionClosed) Object.assign(setup, { status: 'error', code: 'SESSION_CLOSE_FAILED' });
    else if (!isDeepStrictEqual(beforeClose, final)) Object.assign(setup, { status: 'error', code: 'SESSION_CLOSE_WRITES' });
    setup.changedPaths = changedLeaves(before, final);
    if (setup.status === 'pass') {
      setup.expectedContextFingerprint = await fingerprintRepository(cwd);
      setup.expectedContextSeal = digestProposal({ type: 'claude-context-seal-v1', snapshot: final });
      setup.archivedBaselineFixtureDigest = await digestTree(setup.routingFixtureRoot);
    }
    const writeTargets = setup.proposal?.actions.filter((action) => ['CREATE', 'UPDATE'].includes(action.action)).map((action) => action.target) ?? [];
    setup.pendingTargets = writeTargets.filter((target) => !setup.writeEvents.some((event) => event.target === target));
    setup.unchangedPaths = [...new Set([...before.filter((entry) => entry.type !== 'directory').map((entry) => entry.path), ...writeTargets])]
      .filter((target) => !setup.changedPaths.includes(target)).sort();
    const priorDirectories = new Map(before.filter((entry) => entry.type === 'directory').map((entry) => [entry.path, entry]));
    const finalDirectories = new Map(final.filter((entry) => entry.type === 'directory').map((entry) => [entry.path, entry]));
    setup.directoryChanges = [...new Set([...priorDirectories.keys(), ...finalDirectories.keys()])].filter((target) =>
      !isDeepStrictEqual(priorDirectories.get(target), finalDirectories.get(target))).sort();
  }
}
