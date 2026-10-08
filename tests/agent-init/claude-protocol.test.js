import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, lstat, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { invokeClaudeProcess, runClaudeLiveAcceptance, runClaudeSimulation } from './claude-live-runner.js';
import { digestProposal, fingerprintRepository } from './evaluation-harness.js';
import { syntheticSession } from './claude-simulation/session.js';
import { syntheticRoutingSession } from './claude-simulation/observations.js';
import { evaluateTriggerArtifact } from './trigger-evaluation.js';

const posixOnly = { skip: process.platform === 'win32' ? 'owned POSIX package processes unavailable' : false };

test('opaque JSON strings cannot retain secret assignments in a simulated approval report', posixOnly, async () => {
  const result = await runClaudeSimulation({ simulate: true }, {
    approval: async () => ({ type: 'approval', extra: '{"token":"synthetic-private-canary"}' }),
  });
  try {
    assert.equal(result.code, 'SYNTHETIC_INPUT_PRIVATE');
    assert.equal(result.setups[0].approval, undefined);
    assert.equal((await readFile(result.reportPath, 'utf8')).includes('synthetic-private-canary'), false);
    assert.deepEqual(result.setups[0].writeEvents, []);
  } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
});

test('recognizable credentials in synthetic approval property names are rejected before persistence', posixOnly, async () => {
  const canary = 'ghs_SYNTHETICCANARY0123456789';
  const result = await runClaudeSimulation({ simulate: true }, {
    approval: async () => ({ type: 'approval', [canary]: 'public' }),
  });
  try {
    assert.equal(result.code, 'SYNTHETIC_INPUT_PRIVATE');
    assert.equal(result.setups[0].approval, undefined);
    assert.deepEqual(result.setups[0].writeEvents, []);
    assert.equal(JSON.stringify(result).includes(canary), false);
    assert.equal((await readFile(result.reportPath, 'utf8')).includes(canary), false);
    assert.equal(result.executionKind, 'test-double');
    assert.equal(result.liveSkillBehaviorProven, false);
  } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
});

test('Proposal validation and version sequencing precede approval and any writes', posixOnly, async () => {
  for (const [code, mutate] of [
    ['PROPOSAL_SEQUENCE', (response) => response.events.push(structuredClone(response.events.at(-1)))],
    ['PROPOSAL_SEQUENCE', (response) => response.events.unshift({ type: 'approval', decision: 'approve' })],
    ['PROPOSAL_INVALID', (response) => { response.events.at(-1).actions[0].proposedContent = ''; }],
    ['PROPOSAL_INVALID', (response) => { response.events.at(-1).actions[0].target = 'src/unapproved.js'; }],
  ]) {
    let approvals = 0;
    const result = await runClaudeSimulation({ simulate: true }, {
      session: async (request) => { const response = await syntheticSession(request); if (request.phase === 'proposal') mutate(response); return response; },
      approval: async (request) => { approvals += 1; return exactApproval(request); },
    });
    try {
      assert.equal(result.code, code);
      assert.equal(approvals, 0);
      assert.equal(result.setups[0].sessionClosed, true);
      assert.deepEqual(result.setups[0].writeEvents, []);
      assert.equal(await fingerprintRepository(result.setups[0].roots.initialRoot), await fingerprintRepository(result.setups[0].roots.finalRoot));
    } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
  }
});

test('exact synthetic approval drives ordered physical writes and independent four-phase validation', posixOnly, async () => {
  const result = await runClaudeSimulation({ simulate: true }, { approval: exactApproval });
  try {
    assert.equal(result.setups.length, 6, JSON.stringify(result));
    assert.equal(result.setups.every((setup) => setup.status === 'pass'), true, JSON.stringify(result));
    for (const setup of result.setups) {
      assert.equal(setup.validation.ok, true, setup.validation.errors.join('\n'));
      assert.equal(setup.validation.claims.claudeCodeBehaviorProven, false);
      assert.equal(setup.reconcileZeroChurn, true);
      assert.equal(setup.sessionClosed, true);
      assert.deepEqual(setup.writeEvents.map((event) => event.target), setup.proposal.actions
        .filter((action) => action.action === 'CREATE').map((action) => action.target));
      for (const field of ['initialRoot', 'proposalRoot', 'preWriteRoot', 'finalRoot']) assert.equal((await lstat(setup.roots[field])).isDirectory(), true);
      assert.equal(await fingerprintRepository(setup.roots.initialRoot), await fingerprintRepository(setup.roots.proposalRoot));
      assert.equal(await fingerprintRepository(setup.roots.proposalRoot), await fingerprintRepository(setup.roots.preWriteRoot));
    }
    assert.deepEqual(result.setups[0].writeEvents.map((event) => event.target),
      ['AGENTS.md', 'CLAUDE.md', '.agents/skills/build-verify/SKILL.md', '.claude/skills/build-verify']);
    assert.match(await readFile(path.join(result.setups[0].roots.finalRoot, '.agents/skills/build-verify/SKILL.md'), 'utf8'), /pnpm lint && pnpm test/);
    assert.deepEqual(result.artifacts, []);
    assert.equal(result.liveSkillBehaviorProven, false);
  } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
});

test('a failed synthetic write retains partial changes and stops without rollback', posixOnly, async () => {
  const phases = [];
  const result = await runClaudeSimulation({ simulate: true }, { approval: exactApproval,
    session: async (request) => {
      phases.push(request.phase);
      if (request.phase === 'write' && request.action.target === 'CLAUDE.md') throw Object.assign(new Error('Synthetic failure'), { code: 'WRITE_FAILED' });
      return syntheticSession(request);
    },
  });
  try {
    assert.equal(result.code, 'WRITE_FAILED');
    assert.deepEqual(result.setups[0].changedPaths, ['AGENTS.md']);
    assert.deepEqual(result.setups[0].writeEvents.map((event) => event.target), ['AGENTS.md']);
    assert.equal(result.setups[0].unchangedPaths.includes('package.json'), true);
    assert.equal(result.setups[0].unchangedPaths.includes('CLAUDE.md'), true);
    assert.deepEqual(result.setups[0].pendingTargets, ['CLAUDE.md', '.agents/skills/build-verify/SKILL.md', '.claude/skills/build-verify']);
    assert.deepEqual(result.setups[0].failedAction, { phase: 'write', actionId: 'synthetic-action-1', target: 'CLAUDE.md', code: 'WRITE_FAILED' });
    assert.deepEqual(phases, ['proposal', 'write', 'write', 'close']);
    assert.equal((await readFile(path.join(result.setups[0].roots.finalRoot, 'AGENTS.md'), 'utf8')).length > 0, true);
    assert.deepEqual(result.routingSessions, []);
  } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
});

test('setup close cannot mutate a validated repository or permit routing', posixOnly, async () => {
  const result = await runClaudeSimulation({ simulate: true }, { approval: exactApproval,
    session: async (request) => {
      if (request.phase === 'close') await writeFile(path.join(request.cwd, 'package.json'), 'unexpected close write');
      return syntheticSession(request);
    },
  });
  try {
    assert.equal(result.status, 'error');
    assert.equal(result.code, 'SESSION_CLOSE_WRITES');
    assert.deepEqual(result.routingSessions, []);
    assert.equal(result.setups[0].changedPaths.includes('package.json'), true);
  } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
});

test('all synthetic routing cases use fresh sessions after setup closes and round-trip through frozen consumers', posixOnly, async () => {
  const requests = [];
  const { syntheticRoutingSession } = await import('./claude-simulation/observations.js');
  const result = await runClaudeSimulation({ simulate: true }, { approval: exactApproval,
    routingSession: async (request) => { requests.push(request); return syntheticRoutingSession(request); },
  });
  try {
    assert.equal(result.status, 'pass', result.code);
    assert.equal(result.code, 'SIMULATION_VALIDATED');
    assert.equal(result.simulationArtifacts.length, 26);
    assert.equal(result.routingSessions.length, 26);
    assert.equal(result.routingSessions.every((session) => session.sessionClosed && session.zeroWrites), true);
    const ids = [...result.setups, ...result.routingSessions].map((entry) => entry.sessionId);
    assert.equal(new Set(ids).size, 32);
    const runs = requests.filter((request) => request.phase === 'routing');
    assert.equal(runs.length, 26);
    assert.equal(runs.every((request) => request.history.length === 0 && !('expected' in request) && !('mustLoad' in request)), true);
    assert.equal(runs.every((request) => request.setupSessionIds.length === 6), true);
    assert.equal(result.simulationArtifacts.filter((record) => record.kind === 'implicit' && record.validation.ok).length, 21);
    assert.equal(result.simulationArtifacts.filter((record) => record.kind === 'explicit' && record.consumerValidated === false).length, 5);
    const node = result.simulationArtifacts.find((record) => record.id === 'node-build-verify-positive-01');
    const maven = result.simulationArtifacts.find((record) => record.id === 'maven-build-verify-positive-01');
    assert.notEqual(node.artifact.generatedSkillDigest, maven.artifact.generatedSkillDigest);
    assert.deepEqual(node.artifact.observed.loaded, ['build-verify']);
    const collision = runs.find((request) => request.id === 'node-build-verify-deployment-collision-01');
    assert.deepEqual(collision.contributors.map((entry) => entry.fixtureId), ['03-node-pnpm', '15-deployment']);
    assert.deepEqual(result.artifacts, []);
    assert.equal(result.liveSkillBehaviorProven, false);
    assert.equal(JSON.parse(await readFile(result.reportPath, 'utf8')).simulationArtifacts.length, 26);
  } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
});

test('missing, failed, unknown, and duplicate synthetic selections remain errors rather than empty loads', posixOnly, async () => {
  for (const [code, response] of [
    ['SELECTION_UNAVAILABLE', { status: 'missing' }],
    ['SELECTION_UNAVAILABLE', { status: 'error', selectionEvidence: { loaded: [] } }],
    ['SELECTION_EVIDENCE', { status: 'observed', selectionEvidence: {} }],
    ['SELECTION_EVIDENCE', { status: 'observed', selectionEvidence: { loaded: ['unknown-skill'] } }],
    ['SELECTION_EVIDENCE', { status: 'observed', selectionEvidence: { loaded: ['build-verify', 'build-verify'] } }],
  ]) {
    const result = await runClaudeSimulation({ simulate: true }, { approval: exactApproval,
      routingSession: async (request) => request.phase === 'close' ? { closed: true } :
        { evidenceSource: 'test-double', id: request.id, sessionId: request.sessionId, ...response },
    });
    try {
      assert.equal(result.status, 'error');
      assert.equal(result.code, code);
      assert.deepEqual(result.simulationArtifacts, []);
      assert.equal(result.routingSessions.length, 1);
      assert.equal(result.routingSessions[0].observed, undefined);
      assert.equal(result.routingSessions[0].sessionClosed, true);
    } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
  }
});

test('honest synthetic mismatches retain unexpected loads and continue the complete corpus', posixOnly, async () => {
  const result = await runClaudeSimulation({ simulate: true }, { approval: exactApproval,
    routingSession: async (request) => {
      const response = await syntheticRoutingSession(request);
      if (request.phase === 'routing' && request.id === 'node-build-verify-positive-01') response.selectionEvidence.loaded = ['deployment'];
      return response;
    },
  });
  try {
    assert.equal(result.status, 'fail');
    assert.equal(result.code, 'SIMULATION_ROUTING_MISMATCH');
    assert.equal(result.simulationArtifacts.length, 26);
    const record = result.simulationArtifacts[0];
    assert.deepEqual(record.artifact.observed.loaded, ['deployment']);
    assert.equal(record.artifact.result, 'fail');
    assert.equal(record.validation.ok, false);
    assert.equal(record.validation.errors.some((error) => error.startsWith('MISSING_SKILL:')), true);
    assert.equal(record.validation.errors.some((error) => error.startsWith('FORBIDDEN_SKILL:')), true);
  } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
});

test('current physical bytes independently invalidate each synthetic artifact digest', posixOnly, async () => {
  const result = await runClaudeSimulation({ simulate: true }, { approval: exactApproval });
  try {
    const record = result.simulationArtifacts[0];
    const setup = result.setups[0];
    const roots = Object.fromEntries(result.setups.map((entry) => [entry.fixtureId, entry.routingFixtureRoot]));
    const options = { caseId: record.id, fixtureRoots: roots, motherSkillRoot: result.package.motherSkillRoot,
      generatedSkills: { 'build-verify': path.join(setup.roots.finalRoot, '.agents/skills/build-verify') } };
    for (const [field, target] of [
      ['generatedSkillDigest', path.join(options.generatedSkills['build-verify'], 'SKILL.md')],
      ['fixtureDigest', path.join(setup.routingFixtureRoot, 'repository/package.json')],
      ['motherSkillDigest', path.join(options.motherSkillRoot, 'SKILL.md')],
    ]) {
      const bytes = await readFile(target);
      await writeFile(target, Buffer.concat([bytes, Buffer.from('\nsynthetic drift\n')]));
      const stale = await evaluateTriggerArtifact(record.artifact, options);
      assert.equal(stale.ok, false);
      assert.deepEqual(stale.errors, [`ARTIFACT_DIGEST: ${field} does not match the current case inputs`]);
      await writeFile(target, bytes);
    }
    const staleCorpus = await evaluateTriggerArtifact({ ...record.artifact, triggerCorpusDigest: `sha256:${'0'.repeat(64)}` }, options);
    assert.deepEqual(staleCorpus.errors, ['ARTIFACT_DIGEST: triggerCorpusDigest does not match the current case inputs']);
    assert.equal((await evaluateTriggerArtifact(record.artifact, options)).ok, true);
  } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
});

test('an escaping Claude reference is rejected before approval or any Apply mutation', posixOnly, async () => {
  let approvals = 0;
  const result = await runClaudeSimulation({ simulate: true }, {
    session: async (request) => {
      const response = await syntheticSession(request);
      if (request.phase === 'proposal') {
        const action = response.events.at(-1).actions.find((entry) => entry.kind === 'claude-skill-reference');
        action.linkText = '/outside/not-owned';
        action.canonicalTarget = '/outside/not-owned';
      }
      return response;
    },
    approval: async (request) => { approvals += 1; return exactApproval(request); },
  });
  try {
    assert.equal(result.code, 'SYNTHETIC_INPUT_PRIVATE');
    assert.equal(approvals, 0);
    assert.deepEqual(result.setups[0].writeEvents, []);
    assert.deepEqual(result.setups[0].changedPaths, []);
  } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
});

test('the opt-in CLI completes a labeled simulation without authentication or a real Harness fallback', posixOnly, async () => {
  const entry = fileURLToPath(new URL('./claude-live-runner.js', import.meta.url));
  const processResult = await invokeClaudeProcess({ command: process.execPath, args: [entry, '--simulate'],
    cwd: path.dirname(entry), env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: 'never-forward-canary' }, timeoutMs: 20000 });
  const result = JSON.parse(processResult.stdout);
  try {
    assert.equal(processResult.status, 0, result.code);
    assert.equal(result.code, 'SIMULATION_VALIDATED');
    assert.equal(result.executionKind, 'test-double');
    assert.equal(result.qualification, 'unqualified');
    assert.equal(result.harnessVersion, undefined);
    assert.equal(result.simulationArtifacts.length, 26);
    assert.deepEqual(result.artifacts, []);
    assert.equal(processResult.stdout.includes('never-forward-canary'), false);
    for (const record of result.simulationArtifacts) {
      const persisted = JSON.parse(await readFile(record.evidencePath, 'utf8'));
      assert.equal(persisted.executionKind, 'test-double');
      assert.equal(persisted.qualification, 'unqualified');
      assert.equal(persisted.liveSkillBehaviorProven, false);
      assert.equal((await lstat(record.evidencePath)).mode & 0o777, 0o600);
    }
    assert.equal((await readFile(result.reportPath, 'utf8')).includes('never-forward-canary'), false);
  } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
});

test('exact approval rejects stale revisions, payload changes, and unknown or non-write action IDs', posixOnly, async () => {
  for (const [code, change] of [
    ['STALE_APPROVAL', (approval) => { approval.revision = 0; }],
    ['APPROVAL_PAYLOAD', (approval) => { approval.proposalDigest = `sha256:${'0'.repeat(64)}`; }],
    ['APPROVAL_ACTIONS', (approval) => { approval.approvedActionIds.push('unknown-action'); }],
    ['APPROVAL_ACTIONS', (approval) => { approval.approvedActionIds.push('synthetic-action-4'); }],
    ['APPROVAL_ACTIONS', (approval) => { approval.approvedActionIds.push(approval.approvedActionIds[0]); }],
  ]) {
    const result = await runClaudeSimulation({ simulate: true }, { approval: (request) => { const approval = exactApproval(request); change(approval); return approval; } });
    try {
      assert.equal(result.code, code);
      assert.deepEqual(result.setups[0].changedPaths, []);
      assert.deepEqual(result.setups[0].writeEvents, []);
    } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
  }
});

test('a new Proposal revision invalidates the previous exact approval', posixOnly, async () => {
  let oldProposal;
  const result = await runClaudeSimulation({ simulate: true }, {
    session: async (request) => {
      const response = await syntheticSession(request);
      if (request.phase === 'proposal') {
        oldProposal = structuredClone(response.events.at(-1));
        const revision = structuredClone(oldProposal);
        revision.revision = 2;
        revision.warnings.push('Synthetic revised payload');
        response.events.push(revision);
      }
      return response;
    }, approval: () => exactApproval({ proposal: oldProposal }),
  });
  try {
    assert.equal(result.code, 'STALE_APPROVAL');
    assert.equal(result.setups[0].proposal.revision, 2);
    assert.deepEqual(result.setups[0].changedPaths, []);
  } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
});

test('write event omissions and reconcile write proposals cannot manufacture a passing setup', posixOnly, async () => {
  for (const [code, intercept] of [
    ['WRITE_EVENT_INVALID', async (request) => request.phase === 'write' ? syntheticSession({ ...request, emitWrite: () => {} }) : syntheticSession(request)],
    ['RECONCILE_CHANGED', async (request) => request.phase === 'reconcile' ? { type: 'reconcile', mode: 'dry-run', writes: [], proposalActions: [{ action: 'CREATE' }] } : syntheticSession(request)],
  ]) {
    const result = await runClaudeSimulation({ simulate: true }, { approval: exactApproval, session: intercept });
    try {
      assert.equal(result.code, code);
      assert.equal(result.status, 'error');
      assert.deepEqual(result.routingSessions, []);
      assert.equal(result.setups[0].sessionClosed, true);
    } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
  }
});

test('an ancestor replacement during approval stops before following a symlink', posixOnly, async () => {
  let cwd;
  const result = await runClaudeSimulation({ simulate: true }, {
    session: async (request) => { if (request.phase === 'proposal') cwd = request.cwd; return syntheticSession(request); },
    approval: async (request) => {
      await symlink(path.dirname(cwd), path.join(cwd, '.agents'));
      return exactApproval(request);
    },
  });
  try {
    assert.equal(result.code, 'FINGERPRINT_DRIFT');
    assert.deepEqual(result.setups[0].writeEvents, []);
    assert.equal((await lstat(path.join(cwd, '.agents'))).isSymbolicLink(), true);
    await assert.rejects(lstat(path.join(path.dirname(cwd), 'skills')), { code: 'ENOENT' });
  } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
});

test('routing is readonly even for deployment and migration prompts', posixOnly, async () => {
  const result = await runClaudeSimulation({ simulate: true }, { approval: exactApproval,
    routingSession: async (request) => {
      if (request.phase === 'routing' && request.id === 'database-migration-positive-01') {
        await writeFile(path.join(request.contributors[0].cwd, 'unauthorized-migration.sql'), 'synthetic unapproved write');
      }
      return syntheticRoutingSession(request);
    },
  });
  try {
    assert.equal(result.code, 'ROUTING_WRITES');
    assert.equal(result.status, 'error');
    assert.equal(result.simulationArtifacts.length, 8);
    assert.equal(result.routingSessions.at(-1).zeroWrites, false);
    assert.equal(result.routingSessions.at(-1).sessionClosed, true);
    assert.equal(result.simulationArtifacts.some((record) => record.id === 'database-migration-positive-01'), false);
    assert.deepEqual(result.artifacts, []);
  } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
});

test('synthetic Proposal and approval privacy failures persist only a non-secret status', posixOnly, async () => {
  for (const source of ['approval', 'proposal', 'write', 'reconcile']) {
    const boundaries = source === 'approval' ? {
      approval: async () => ({ type: 'approval', token: 'synthetic-private-canary', userPath: '/outside/private/home' }),
    } : {
      session: async (request) => {
        if (source === 'write' && request.phase === 'write') {
          return syntheticSession({ ...request, emitWrite: (event) => request.emitWrite({ ...event, token: 'synthetic-private-canary' }) });
        }
        const response = await syntheticSession(request);
        if (source === 'proposal' && request.phase === 'proposal') response.events.at(-1).warnings.push('token=synthetic-private-canary /outside/private/home');
        if (source === 'reconcile' && request.phase === 'reconcile') response.userPath = '/outside/private/home';
        return response;
      },
    };
    const result = await runClaudeSimulation({ simulate: true }, boundaries);
    try {
      assert.equal(result.code, 'SYNTHETIC_INPUT_PRIVATE');
      assert.equal(result.status, 'error');
      assert.equal(result.setups[0].writeEvents.length, source === 'reconcile' ? 4 : 0);
      assert.deepEqual(result.routingSessions, []);
      for (const output of [JSON.stringify(result), await readFile(result.reportPath, 'utf8')]) {
        assert.equal(output.includes('synthetic-private-canary'), false);
        assert.equal(output.includes('/outside/private/home'), false);
      }
    } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
  }
});

test('lexically canonical but physically dangling Claude references cannot pass', posixOnly, async () => {
  let approvals = 0;
  const result = await runClaudeSimulation({ simulate: true }, {
    session: async (request) => {
      const response = await syntheticSession(request);
      if (request.phase === 'proposal') {
        const action = response.events.at(-1).actions.find((entry) => entry.kind === 'claude-skill-reference');
        if (action) action.linkText = `../../never-created/../.agents/skills/${action.target.split('/').at(-1)}`;
      }
      return response;
    }, approval: (request) => { approvals += 1; return exactApproval(request); },
  });
  try {
    assert.equal(result.code, 'PROPOSAL_INVALID');
    assert.equal(approvals, 0);
    assert.deepEqual(result.setups[0].changedPaths, []);
    assert.deepEqual(result.setups[0].writeEvents, []);
  } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
});

test('approved file writes cannot conceal extra directories, permission mutations, or identical-byte churn', posixOnly, async () => {
  for (const [target, mutate] of [
    ['AGENTS.md', (cwd) => mkdir(path.join(cwd, 'unapproved-empty-directory'))],
    ['.claude/skills/build-verify', (cwd) => chmod(path.join(cwd, '.agents'), 0o777)],
    ['AGENTS.md', async (cwd) => { const bytes = await readFile(path.join(cwd, 'package.json')); await writeFile(path.join(cwd, 'package.json'), bytes); }],
  ]) {
    const result = await runClaudeSimulation({ simulate: true }, {
      session: async (request) => {
        const response = await syntheticSession(request);
        if (request.phase === 'write' && request.action.target === target) await mutate(request.cwd);
        return response;
      },
    });
    try {
      assert.equal(result.code, 'WRITE_DELTA_INVALID');
      assert.equal(result.status, 'error');
      assert.equal(result.setups[0].sessionClosed, true);
      assert.deepEqual(result.routingSessions, []);
    } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
  }
});

test('the synthetic Proposal exposes summary-first decisions without moving workflow facts into GLOBAL rules', posixOnly, async () => {
  const result = await runClaudeSimulation({ simulate: true }, { approval: async () => null });
  try {
    const setup = result.setups[0];
    const agents = setup.proposal.actions.find((action) => action.kind === 'agents').proposedContent;
    assert.equal(agents.includes('pnpm@9.0.0'), true);
    assert.equal(agents.includes('pnpm lint && pnpm test'), false);
    assert.equal(agents.includes('build-verify'), true);
    assert.equal(setup.decisionSummary.noWritesBeforeApproval, true);
    assert.equal(setup.decisionSummary.executionKind, 'test-double');
    assert.deepEqual(setup.decisionSummary.decisions.CREATE.map((action) => action.target),
      ['AGENTS.md', 'CLAUDE.md', '.agents/skills/build-verify/SKILL.md', '.claude/skills/build-verify']);
    assert.equal(setup.decisionSummary.decisions.SKIP.length, 1);
    assert.equal(setup.decisionSummary.decisions.RECOMMEND.length, 1);
    assert.deepEqual(setup.decisionSummary.recommendedWriteActionIds, ['synthetic-action-0', 'synthetic-action-1', 'synthetic-action-2', 'synthetic-action-3']);
    assert.deepEqual(setup.decisionSummary.syntheticApprovalTemplate, exactApproval({ proposal: setup.proposal }));
    assert.equal(setup.approval, null);
  } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
});

test('later setup sessions cannot silently replace an earlier validated-and-closed routing context', posixOnly, async () => {
  let firstRoot;
  const result = await runClaudeSimulation({ simulate: true }, {
    session: async (request) => {
      if (request.phase === 'proposal' && request.fixture.id === '03-node-pnpm') firstRoot = request.cwd;
      if (request.phase === 'proposal' && request.fixture.id === '11-maven-multi-module-build-verify') {
        await writeFile(path.join(firstRoot, 'package.json'), 'synthetic later-session drift');
      }
      return syntheticSession(request);
    },
  });
  try {
    assert.equal(result.code, 'SETUP_CONTEXT_STALE');
    assert.equal(result.status, 'error');
    assert.deepEqual(result.routingSessions, []);
    assert.deepEqual(result.simulationArtifacts, []);
    const setup = result.setups[0];
    assert.equal(setup.validation.ok, true);
    assert.notEqual(setup.expectedContextFingerprint, await fingerprintRepository(setup.roots.finalRoot));
    assert.match(setup.expectedContextSeal, /^sha256:/);
  } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
});

test('oversized and cyclic synthetic inputs stop before retention and always close the setup session', posixOnly, async () => {
  for (const shape of ['deep', 'cyclic']) {
    const result = await runClaudeSimulation({ simulate: true }, {
      session: async (request) => {
        if (request.phase !== 'proposal') return syntheticSession(request);
        const response = await syntheticSession(request);
        if (shape === 'cyclic') response.self = response;
        else {
          let nested = {};
          for (let index = 0; index < 100; index += 1) nested = { nested };
          response.extra = nested;
        }
        return response;
      },
    });
    try {
      assert.equal(result.code, 'SYNTHETIC_INPUT_LIMIT');
      assert.equal(result.setups[0].sessionClosed, true);
      assert.equal(result.setups[0].run, undefined);
      assert.deepEqual(result.setups[0].changedPaths, []);
      assert.equal(JSON.parse(await readFile(result.reportPath, 'utf8')).code, 'SYNTHETIC_INPUT_LIMIT');
    } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
  }
});

test('synthetic normalization refuses camelCase credentials and serialization hooks without executing them', posixOnly, async () => {
  for (const shape of ['apiKey', 'toJSON', 'getter']) {
    let hookCalls = 0;
    const result = await runClaudeSimulation({ simulate: true }, {
      approval: async () => {
        if (shape === 'apiKey') return { type: 'approval', apiKey: 'synthetic-camel-canary' };
        const value = { type: 'approval' };
        if (shape === 'toJSON') Object.defineProperty(value, 'toJSON', { value: () => { hookCalls += 1; return { token: 'synthetic-camel-canary' }; } });
        else Object.defineProperty(value, 'extra', { enumerable: true, get: () => { hookCalls += 1; return hookCalls === 1 ? 'harmless' : { token: 'synthetic-camel-canary' }; } });
        return value;
      },
    });
    try {
      assert.equal(result.code, shape === 'apiKey' ? 'SYNTHETIC_INPUT_PRIVATE' : 'SYNTHETIC_INPUT_INVALID');
      assert.equal(hookCalls, 0);
      assert.equal(JSON.stringify(result).includes('synthetic-camel-canary'), false);
      assert.equal((await readFile(result.reportPath, 'utf8')).includes('synthetic-camel-canary'), false);
      assert.equal(result.setups[0].sessionClosed, true);
    } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
  }
});

test('file URIs and punctuation-adjacent absolute paths cannot enter synthetic pause reports', posixOnly, async () => {
  for (const userPath of ['file:///outside/private/home', 'Path:/outside/private/home']) {
    const result = await runClaudeSimulation({ simulate: true }, { approval: async () => ({ type: 'approval', userPath }) });
    try {
      assert.equal(result.code, 'SYNTHETIC_INPUT_PRIVATE');
      assert.equal(JSON.stringify(result).includes('/outside/private/home'), false);
      assert.equal((await readFile(result.reportPath, 'utf8')).includes('/outside/private/home'), false);
      assert.equal(result.setups[0].sessionClosed, true);
    } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
  }
});

function exactApproval({ proposal }) {
  return { type: 'approval', decision: 'approve', scope: 'exact-proposal', proposalId: proposal.id,
    revision: proposal.revision, proposalDigest: digestProposal(proposal),
    approvedActionIds: proposal.actions.filter((action) => ['CREATE', 'UPDATE'].includes(action.action)).map((action) => action.id) };
}

test('reject, vague, and partial synthetic decisions never unlock Apply', posixOnly, async () => {
  for (const [code, decide] of [
    ['PROPOSAL_REJECTED', (request) => ({ ...exactApproval(request), decision: 'reject', approvedActionIds: [] })],
    ['VAGUE_APPROVAL', () => 'looks good'],
    ['PARTIAL_APPROVAL', (request) => ({ ...exactApproval(request), approvedActionIds: ['synthetic-action-0'] })],
  ]) {
    const result = await runClaudeSimulation({ simulate: true }, { approval: decide });
    try {
      assert.equal(result.code, code);
      assert.equal(result.status, 'blocked');
      assert.deepEqual(result.setups[0].writeEvents, []);
      assert.equal(result.setups[0].sessionClosed, true);
      assert.equal(await fingerprintRepository(result.setups[0].roots.initialRoot), await fingerprintRepository(result.setups[0].roots.finalRoot));
      assert.deepEqual(result.routingSessions, []);
      assert.equal(JSON.parse(await readFile(result.reportPath, 'utf8')).code, code);
    } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
  }
});

test('an unapproved synthetic Proposal is persisted without Apply or routing', posixOnly, async () => {
  let approvalCalls = 0;
  let realCalls = 0;
  const result = await runClaudeSimulation({ simulate: true, env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: 'secret-canary-not-for-use' } }, {
    approval: async ({ proposal }) => {
      approvalCalls += 1;
      assert.equal(proposal.type, 'proposal');
      assert.equal(proposal.actions.length, 6);
      return null;
    },
    invokeClaude: async () => { realCalls += 1; throw new Error('no real fallback'); },
  });
  try {
    assert.equal(result.status, 'blocked');
    assert.equal(result.code, 'APPROVAL_REQUIRED');
    assert.equal(result.executionKind, 'test-double');
    assert.equal(result.qualification, 'unqualified');
    assert.equal(result.package.baseSha, 'e5097877fa4172c8b2eb27b394aff374803b42fe');
    assert.match(result.package.motherSkillDigest, /^sha256:/);
    assert.equal(approvalCalls, 1);
    assert.equal(realCalls, 0);
    assert.deepEqual(result.artifacts, []);
    assert.deepEqual(result.simulationArtifacts, []);
    assert.equal(result.setups.length, 1);
    const setup = result.setups[0];
    assert.equal(setup.fixtureId, '03-node-pnpm');
    assert.deepEqual(setup.proposal.actions.filter((action) => action.action === 'CREATE').map((action) => action.target),
      ['AGENTS.md', 'CLAUDE.md', '.agents/skills/build-verify/SKILL.md', '.claude/skills/build-verify']);
    assert.equal(setup.proposalDigest, digestProposal(setup.proposal));
    assert.equal(setup.zeroProposalWrites, true);
    assert.equal(setup.sessionClosed, true);
    assert.deepEqual(setup.writeEvents, []);
    assert.equal(await fingerprintRepository(setup.roots.initialRoot), await fingerprintRepository(setup.roots.finalRoot));
    assert.deepEqual(result.routingSessions, []);
    const stat = await lstat(result.reportPath);
    assert.equal(stat.mode & 0o777, 0o600);
    const report = await readFile(result.reportPath, 'utf8');
    assert.equal(report.includes('secret-canary-not-for-use'), false);
    assert.equal(report.includes(result.disposableRoot), false);
    assert.equal(JSON.parse(report).setups[0].proposalDigest, setup.proposalDigest);
    assert.match(JSON.parse(report).package.motherSkillRoot, /^<owned-disposable-root>\//);
  } finally {
    if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true });
  }
});

test('simulation needs explicit opt-in and cannot unlock live execution', async () => {
  let calls = 0;
  const session = async () => { calls += 1; throw new Error('must not run'); };
  for (const [options, code] of [
    [{}, 'SIMULATION_OPT_IN_REQUIRED'],
    [{ simulate: false }, 'SIMULATION_OPT_IN_REQUIRED'],
    [{ simulate: true, live: true }, 'SIMULATION_LIVE_CONFLICT'],
  ]) {
    const result = await runClaudeSimulation(options, { session });
    assert.equal(result.status, 'blocked');
    assert.equal(result.code, code);
    assert.equal(result.disposableRoot, undefined);
    assert.equal(result.executionKind, 'test-double');
    assert.equal(result.qualification, 'unqualified');
    assert.equal(result.liveSkillBehaviorProven, false);
    assert.deepEqual(result.artifacts, []);
    assert.deepEqual(result.simulationArtifacts, []);
  }
  assert.equal(calls, 0);
});

test('simulation and live remain mutually exclusive at both public entries and CLI', { skip: process.platform === 'win32' }, async () => {
  let calls = 0;
  const result = await runClaudeLiveAcceptance({ simulate: true, live: true, scope: 'capability-probe', env: {} }, {
    invokeClaude: async () => { calls += 1; throw new Error('must not run'); },
  });
  assert.equal(result.code, 'SIMULATION_LIVE_CONFLICT');
  assert.equal(result.disposableRoot, undefined);
  assert.equal(calls, 0);
  const entry = fileURLToPath(new URL('./claude-live-runner.js', import.meta.url));
  for (const [args, code] of [
    [['--simulate', '--live'], 'SIMULATION_LIVE_CONFLICT'],
    [['--simulate', '--simulate'], 'CLI_ARGUMENTS'],
    [['--simulate', '--unexpected'], 'CLI_ARGUMENTS'],
  ]) {
    const processResult = await invokeClaudeProcess({ command: process.execPath, args: [entry, ...args],
      cwd: path.dirname(entry), env: { PATH: process.env.PATH }, timeoutMs: 2000 });
    assert.equal(processResult.status, 2);
    const outcome = JSON.parse(processResult.stdout);
    assert.equal(outcome.code, code);
    assert.equal(outcome.disposableRoot, undefined);
    assert.deepEqual(outcome.artifacts, []);
  }
});
