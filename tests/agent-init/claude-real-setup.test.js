import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, lstat, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';

import { invokeClaudeProcess, runClaudeLiveAcceptance } from './claude-live-runner.js';
import { captureClaudeApproval } from './claude-approval.js';
import { fingerprintPath, renderExactDiff } from './evaluation-harness.js';

test('CLI setup authorization is explicit and cannot authorize a different scope', { skip: process.platform === 'win32' }, async () => {
  const entry = fileURLToPath(new URL('./claude-live-runner.js', import.meta.url));
  for (const [args, code] of [
    [['--live', '--scope', 'setup-proposal'], 'SETUP_AUTHORIZATION_REQUIRED'],
    [['--live', '--scope', 'setup-proposal', '--authorize-setup-proposal'], 'AUTHENTICATION_UNAVAILABLE'],
    [['--scope', 'setup-proposal', '--authorize-setup-proposal'], 'CLI_ARGUMENTS'],
    [['--live', '--scope', 'capability-probe', '--authorize-setup-proposal'], 'CLI_ARGUMENTS'],
    [['--simulate', '--authorize-setup-proposal'], 'CLI_ARGUMENTS'],
    [['--live', '--scope', 'setup-proposal', '--authorize-setup-proposal', '--fixture-id', '08-existing-skills'], 'AUTHENTICATION_UNAVAILABLE'],
    [['--live', '--scope', 'capability-probe', '--fixture-id', '08-existing-skills'], 'CLI_ARGUMENTS'],
    [['--live', '--scope', 'setup-proposal', '--authorize-setup-proposal', '--fixture-id', '../private'], 'FIXTURE_SCOPE'],
    [['--simulate', '--fixture-id', '08-existing-skills'], 'CLI_ARGUMENTS'],
  ]) {
    const processResult = await invokeClaudeProcess({ command: process.execPath, args: [entry, ...args],
      cwd: path.dirname(entry), env: { PATH: process.env.PATH }, timeoutMs: 2000 });
    const result = JSON.parse(processResult.stdout);
    try {
      assert.equal(processResult.status, 2);
      assert.equal(result.code, code);
      assert.equal(result.disposableRoot, undefined);
      assert.deepEqual(result.artifacts, []);
    } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
  }
});

const posixOnly = { skip: process.platform === 'win32' ? 'owned POSIX process groups are unavailable' : false };

test('human Proposal approval is opt-in, scope-bound and requires a terminal before any live preparation', posixOnly, async () => {
  let calls = 0;
  const boundaries = { invokeClaude: async () => { calls += 1; throw new Error('No live preflight permitted'); } };
  const scoped = await runClaudeLiveAcceptance({ live: true, scope: 'capability-probe', requestProposalApproval: true }, boundaries);
  assert.equal(scoped.code, 'APPROVAL_SCOPE');
  assert.equal(scoped.disposableRoot, undefined);
  const nonTerminal = await runClaudeLiveAcceptance({ live: true, scope: 'setup-proposal', authorizeSetupProposal: true,
    requestProposalApproval: true }, boundaries);
  assert.equal(nonTerminal.code, 'APPROVAL_TERMINAL_REQUIRED');
  assert.equal(nonTerminal.disposableRoot, undefined);
  assert.equal(calls, 0);
  const entry = fileURLToPath(new URL('./claude-live-runner.js', import.meta.url));
  const processResult = await invokeClaudeProcess({ command: process.execPath,
    args: [entry, '--live', '--scope', 'setup-proposal', '--authorize-setup-proposal', '--request-proposal-approval'],
    cwd: path.dirname(entry), env: { PATH: process.env.PATH }, timeoutMs: 2000 });
  assert.equal(processResult.status, 2);
  assert.equal(JSON.parse(processResult.stdout).code, 'APPROVAL_TERMINAL_REQUIRED');
});

test('setup requires the installed structured-output capability before package preparation', posixOnly, async () => {
  const calls = [];
  const oldFlags = ['--bare', '--restricted', '--print', '--output-format', '--verbose', '--tools', '--permission-mode',
    '--permission-prompts', '--max-budget-usd', '--model', '--add-dir', '--session-id', '--no-session-persistence',
    '--strict-mcp-config', '--mcp-config', '--prompt-suggestions'];
  const result = await runClaudeLiveAcceptance({ live: true, scope: 'setup-proposal', authorizeSetupProposal: true,
    claudeExecutable: process.execPath, env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: 'test-only-unused-auth' } }, {
    invokeClaude: async (request) => {
      calls.push(request);
      assert.equal(request.env.ANTHROPIC_API_KEY, undefined);
      if (request.args.includes('--version')) return { status: 0, stdout: '2.1.285 (Claude Code)\n' };
      if (request.args.includes('--help')) return { status: 0, stdout: oldFlags.join(' ') };
      throw new Error('No model call or fallback');
    },
  });
  try {
    assert.equal(result.code, 'HARNESS_CAPABILITY_UNAVAILABLE');
    assert.equal(result.status, 'error');
    assert.equal(calls.length, 2);
    assert.equal(result.package, undefined);
    assert.equal(result.executionKind, 'test-double');
    assert.equal(result.liveSkillBehaviorProven, false);
    assert.deepEqual(result.artifacts, []);
    await assert.rejects(lstat(path.join(result.disposableRoot, 'source')), { code: 'ENOENT' });
    const report = await readFile(path.join(result.disposableRoot, 'evidence/claude-live/report.json'), 'utf8');
    assert.equal(report.includes('test-only-unused-auth'), false);
  } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
});

test('a timed-out version response cannot advance readonly setup even when its text is correct', posixOnly, async () => {
  let calls = 0;
  const result = await runClaudeLiveAcceptance({ live: true, scope: 'setup-proposal', authorizeSetupProposal: true,
    claudeExecutable: process.execPath, env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: 'test-only-unused-auth' } }, {
    invokeClaude: async () => { calls += 1; return { status: 0, stdout: '2.1.285 (Claude Code)\n', timedOut: true }; },
  });
  try {
    assert.equal(result.code, 'HARNESS_VERSION_UNAVAILABLE');
    assert.equal(result.status, 'error');
    assert.equal(calls, 1);
    assert.equal(result.package, undefined);
    assert.deepEqual(result.artifacts, []);
  } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
});

test('the real setup entry installs the exact package and constructs one readonly structured Proposal request (CLI double)', posixOnly, async () => {
  const calls = [];
  const flags = ['--bare', '--restricted', '--print', '--output-format', '--verbose', '--tools', '--permission-mode',
    '--permission-prompts', '--max-budget-usd', '--model', '--add-dir', '--session-id', '--no-session-persistence',
    '--strict-mcp-config', '--mcp-config', '--prompt-suggestions', '--json-schema'];
  let cwd;
  const result = await runClaudeLiveAcceptance({ live: true, scope: 'setup-proposal', authorizeSetupProposal: true,
    claudeExecutable: process.execPath, env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: 'test-only-forwarded-to-double', ANTHROPIC_AUTH_TOKEN: 'must-not-forward' } }, {
    invokeClaude: async (request) => {
      calls.push(request);
      if (request.args.includes('--version')) return { status: 0, stdout: '2.1.285 (Claude Code)\n' };
      if (request.args.includes('--help')) return { status: 0, stdout: flags.join(' ') };
      cwd = request.cwd;
      assert.equal(request.env.ANTHROPIC_API_KEY, 'test-only-forwarded-to-double');
      assert.equal(request.env.ANTHROPIC_AUTH_TOKEN, undefined);
      const argument = (flag) => request.args[request.args.indexOf(flag) + 1];
      assert.equal(argument('--tools'), 'Read,Glob,Grep,Skill');
      assert.equal(argument('--permission-mode'), 'dontAsk');
      assert.equal(argument('--permission-prompts'), 'none');
      assert.equal(argument('--model'), 'claude-opus-5-5');
      assert.equal(argument('--max-budget-usd'), '3');
      assert.equal(request.args.includes('--no-session-persistence'), true);
      assert.equal(request.args.includes('--resume'), false);
      const schema = JSON.parse(argument('--json-schema'));
      assert.equal(schema.type, 'object');
      assert.equal(schema.additionalProperties, false);
      assert.equal(schema.properties.decisionRecordJson.type, 'string');
      assert.match(request.args.at(-1), /^\/agent-init\n/);
      assert.equal(request.args.at(-1).includes('Do not apply'), true);
      assert.equal(argument('--output-format'), 'json');
      assert.equal(request.args.includes('--verbose'), false);
      assert.equal(request.stopOnRetry, false);
      throw Object.assign(new Error('Intentional stop in external CLI double'), { code: 'SETUP_REQUEST_TEST_STOP' });
    },
  });
  try {
    assert.equal(result.code, 'SETUP_REQUEST_TEST_STOP');
    assert.equal(calls.length, 3);
    assert.equal(result.package.baseSha, 'e5097877fa4172c8b2eb27b394aff374803b42fe');
    assert.match(result.package.motherSkillDigest, /^sha256:/);
    assert.equal((await lstat(path.join(cwd, 'pom.xml'))).isFile(), true);
    await assert.rejects(lstat(path.join(cwd, '.agents')), { code: 'ENOENT' });
    assert.deepEqual(result.artifacts, []);
    assert.equal(result.liveSkillBehaviorProven, false);
    assert.equal(result.executionKind, 'test-double');
    const report = await readFile(path.join(result.disposableRoot, 'evidence/claude-live/report.json'), 'utf8');
    assert.equal(report.includes('test-only-forwarded-to-double'), false);
    assert.equal(report.includes('must-not-forward'), false);
  } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
});

function modelDecision() {
  return { evidenceLedger: [{ id: 'model-pom', fact: 'Maven repository', sourcePath: 'pom.xml', sourceLocation: 'project element',
    observation: 'pom.xml exists', whyItMatters: 'Root project identification', persistenceScope: 'GLOBAL',
    deterministicEnforcementCandidate: false, destination: 'AGENTS.md' }], events: [
    { type: 'profile', facts: [{ id: 'model-build', status: 'confirmed', value: 'Maven', evidenceIds: ['model-pom'] }], unknowns: [] },
    { type: 'classify', decisions: [{ factId: 'model-build', persistenceScope: 'GLOBAL', deterministicEnforcementCandidate: false, destination: 'AGENTS.md' }] },
    { type: 'skills', candidates: [] },
    { type: 'proposal', id: 'cli-double-proposal-not-fixture-oracle', revision: 1, projectSummary: 'Unique CLI-double decision, not a fixture-authored default',
      unknowns: [], warnings: ['This is only a capture test'], nonGoals: ['No writes or real selection proof'], validationPlan: ['Review complete contents'],
      actions: [{ id: 'model-agents', action: 'CREATE', target: 'AGENTS.md', kind: 'agents', reason: 'Model decision for the capture test',
        evidenceIds: ['model-pom'], baselineFingerprint: 'missing', proposedContent: '# Model-authored capture\n\nUnique body from the external CLI double.\n' }] },
  ] };
}

async function captureWithDouble(response, fixtureId, preflight = async () => {}, approval = {}) {
  const calls = [];
  const result = await runClaudeLiveAcceptance({ live: true, scope: 'setup-proposal', authorizeSetupProposal: true, fixtureId,
    ...(approval.requestProposalApproval ? { requestProposalApproval: true } : {}),
    claudeExecutable: process.execPath, env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: 'capture-only-fake-key' } }, {
    ...(approval.requestApproval ? { requestApproval: approval.requestApproval } : {}),
    ...(approval.approvalTerminal ? { approvalTerminal: approval.approvalTerminal } : {}),
    invokeClaude: async (request) => {
      calls.push(request);
      if (request.args.includes('--version')) return { status: 0, stdout: '2.1.285 (Claude Code)\n' };
      if (request.args.includes('--help')) {
        await preflight(request);
        return { status: 0, stdout: '--bare --restricted --print --output-format --verbose --tools --permission-mode --permission-prompts --max-budget-usd --model --add-dir --session-id --no-session-persistence --strict-mcp-config --mcp-config --prompt-suggestions --json-schema' };
      }
      return response(request);
    },
  });
  return { result, calls };
}

function jsonResponse(request, decision = modelDecision()) {
  return { status: 0, stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: request.sessionId,
    permission_denials: [], structured_output: { decisionRecordJson: JSON.stringify(decision) }, result: 'Not selection evidence.' }) };
}

test('a documented JSON structured response captures the exact unapproved decisions without claiming selection or Apply', posixOnly, async () => {
  const decision = modelDecision();
  const { result, calls } = await captureWithDouble((request) => jsonResponse(request, decision));
  try {
    assert.equal(result.status, 'blocked');
    assert.equal(result.code, 'APPROVAL_REQUIRED');
    assert.equal(calls.length, 3);
    assert.deepEqual(result.setup.decisionRecord, decision);
    assert.deepEqual(result.setup.proposal, decision.events.at(-1));
    assert.match(result.setup.proposalDigest, /^sha256:/);
    assert.equal(result.setup.captureStatus, 'captured');
    assert.equal(result.setup.zeroProposalWrites, true);
    assert.equal(result.setup.applySupported, false);
    assert.equal(result.setup.consumerValidated, false);
    assert.equal(result.setup.provenance.selectionProtocolVerified, false);
    assert.equal(result.setup.provenance.phaseExecutionProven, false);
    assert.equal(result.setup.provenance.retryMonitoringAvailable, false);
    assert.equal(result.setup.provenance.readObservationAvailable, false);
    assert.equal(result.setup.provenance.writeObservationAvailable, false);
    assert.equal(result.setup.provenance.contextIsolationProven, false);
    assert.equal(result.setup.provenance.skillDiscoveryProven, false);
    assert.equal(result.qualification, 'unqualified');
    assert.equal(result.scope, 'setup-proposal');
    assert.equal(result.setup.runtimeLimits.maxProcessAttempts, 1);
    assert.equal(result.setup.runtimeLimits.configuredBudgetUsd, 3);
    assert.equal(result.setup.runtimeLimits.billingCapGuaranteed, false);
    assert.match(calls.at(-1).args.at(-1), /Existing target fingerprints/);
    assert.match(calls.at(-1).args.at(-1), /"pom\.xml":"sha256:[a-f0-9]{64}"/);
    assert.equal(calls.at(-1).env.GIT_CEILING_DIRECTORIES, result.disposableRoot);
    assert.deepEqual(result.artifacts, []);
    assert.equal(result.liveSkillBehaviorProven, false);
    const cwd = calls.at(-1).cwd;
    await assert.rejects(lstat(path.join(cwd, 'AGENTS.md')), { code: 'ENOENT' });
    await assert.rejects(lstat(path.join(path.dirname(cwd), 'fixture.json')), { code: 'ENOENT' });
    const persisted = JSON.parse(await readFile(path.join(result.disposableRoot, 'evidence/claude-live/report.json'), 'utf8'));
    assert.deepEqual(persisted.setup.proposal, decision.events.at(-1));
    assert.equal(persisted.setup.provenance.source, 'cli-json-structured-output');
    assert.deepEqual(persisted.artifacts, []);
  } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
});

test('exact terminal-boundary approval records its scope but cannot unlock an unverified Apply protocol', posixOnly, async () => {
  let presented;
  const { result, calls } = await captureWithDouble((request) => jsonResponse(request), undefined, undefined, {
    requestProposalApproval: true,
    requestApproval: async (request) => {
      presented = request;
      assert.equal(request.audit.proposal.id, 'cli-double-proposal-not-fixture-oracle');
      assert.equal(request.audit.proposal.actions[0].proposedContent, '# Model-authored capture\n\nUnique body from the external CLI double.\n');
      assert.match(request.presentation, /^尚未执行项目写入。/);
      assert.ok(request.presentation.indexOf('会改变') < request.presentation.indexOf('完整审计'));
      assert.ok(request.presentation.includes('model-agents'));
      return JSON.stringify({ type: 'approval', decision: 'approve', scope: 'exact-proposal',
        proposalId: 'cli-double-proposal-not-fixture-oracle', revision: 1,
        proposalDigest: request.proposalDigest, approvedActionIds: ['model-agents'] });
    },
  });
  try {
    assert.equal(result.status, 'blocked');
    assert.equal(result.code, 'APPLY_PROTOCOL_UNVERIFIED');
    assert.equal(calls.length, 3);
    assert.equal(result.setup.approval.status, 'exact');
    assert.equal(result.setup.approval.source, 'test-double');
    assert.equal(result.setup.approval.humanApprovalProven, false);
    assert.equal(result.setup.approval.record.proposalDigest, presented.proposalDigest);
    assert.deepEqual(result.setup.approval.record.approvedActionIds, ['model-agents']);
    assert.equal(result.setup.applySupported, false);
    assert.deepEqual(result.artifacts, []);
    assert.equal(result.liveSkillBehaviorProven, false);
    await assert.rejects(lstat(path.join(calls.at(-1).cwd, 'AGENTS.md')), { code: 'ENOENT' });
    const persisted = JSON.parse(await readFile(path.join(result.disposableRoot, 'evidence/claude-live/report.json'), 'utf8'));
    assert.equal(persisted.setup.approval.status, 'exact');
    assert.equal(persisted.setup.approval.source, 'test-double');
    assert.equal(persisted.setup.approval.humanApprovalProven, false);
  } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
});

function terminalDouble(reply) {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (value) => { input.isRaw = value; return input; };
  output.isTTY = true;
  output.columns = 120;
  let transcript = '';
  let answered = false;
  output.on('data', (chunk) => {
    transcript += chunk.toString();
    if (!answered && transcript.includes('> ')) {
      answered = true;
      setImmediate(() => reply({ input, transcript }));
    }
  });
  return { input, output, transcript: () => transcript };
}

test('the production terminal reader is reachable through declared external I/O doubles without human-proof promotion', posixOnly, async () => {
  const terminal = terminalDouble(({ input, transcript }) => {
    const digest = transcript.match(/Proposal digest: (sha256:[a-f0-9]{64})/)[1];
    input.write(`${JSON.stringify({ type: 'approval', decision: 'reject', scope: 'exact-proposal',
      proposalId: 'cli-double-proposal-not-fixture-oracle', revision: 1, proposalDigest: digest, approvedActionIds: [] })}\n`);
  });
  const { result } = await captureWithDouble((request) => jsonResponse(request), undefined, undefined,
    { requestProposalApproval: true, approvalTerminal: terminal });
  try {
    assert.equal(result.code, 'PROPOSAL_REJECTED');
    assert.equal(result.setup.approval.source, 'test-double');
    assert.equal(result.setup.approval.humanApprovalProven, false);
    assert.equal(result.executionKind, 'test-double');
    assert.equal(terminal.input.isRaw, false);
    assert.equal(terminal.input.destroyed, false);
    assert.equal(terminal.output.destroyed, false);
  } finally {
    terminal.input.destroy(); terminal.output.destroy();
    if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true });
  }
});

test('terminal input bytes are capped before newline or echo, including cumulative multibyte chunks', posixOnly, async () => {
  for (const variant of ['single', 'split-multibyte']) {
    let fallback;
    const terminal = terminalDouble(({ input }) => {
      if (variant === 'single') input.write('x'.repeat(65537));
      else { input.write('中'.repeat(1000)); input.write('界'.repeat(20846)); }
      // Makes the old unbounded reader settle, without disguising early intake failure.
      fallback = setTimeout(() => { if (!input.destroyed) input.write('\n'); }, 50);
    });
    terminal.input.isRaw = true;
    const { result } = await captureWithDouble((request) => jsonResponse(request), undefined, undefined,
      { requestProposalApproval: true, approvalTerminal: terminal });
    try {
      assert.equal(result.status, 'error', variant);
      assert.equal(result.code, 'APPROVAL_INPUT_LIMIT', variant);
      assert.equal(result.setup.approval, undefined, variant);
      assert.equal(result.setup.zeroApprovalWrites, true, variant);
      assert.equal(terminal.transcript().includes(variant === 'single' ? 'x'.repeat(1000) : '界'), false, variant);
      assert.equal(terminal.input.isRaw, true, variant);
      assert.equal(terminal.input.destroyed, false, variant);
      assert.equal(terminal.output.destroyed, false, variant);
      assert.equal(terminal.input.listenerCount('data'), 0, variant);
      assert.deepEqual(result.artifacts, [], variant);
    } finally {
      clearTimeout(fallback); terminal.input.destroy(); terminal.output.destroy();
      if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true });
    }
  }
});

test('EOF, input failure and interruption settle pending terminal approval without waiting for timeout', posixOnly, async () => {
  for (const [variant, code] of [['eof', 'APPROVAL_INPUT_CLOSED'], ['failure', 'APPROVAL_INPUT_FAILED'], ['interrupt', 'APPROVAL_INTERRUPTED']]) {
    const terminal = terminalDouble(({ input }) => {
      if (variant === 'eof') input.end('incomplete-without-newline');
      if (variant === 'failure') input.emit('error', new Error('Declared external stream failure'));
      if (variant === 'interrupt') input.write(Buffer.from([3]));
    });
    const { result } = await captureWithDouble((request) => jsonResponse(request), undefined, undefined,
      { requestProposalApproval: true, approvalTerminal: terminal });
    try {
      assert.equal(result.status, 'error', variant);
      assert.equal(result.code, code, variant);
      assert.equal(result.setup.approval, undefined, variant);
      assert.equal(result.setup.zeroApprovalWrites, true, variant);
      assert.equal(terminal.output.destroyed, false, variant);
      assert.equal(terminal.input.isRaw, false, variant);
      for (const event of ['data', 'end', 'close', 'error']) assert.equal(terminal.input.listenerCount(event), 0, `${variant}/${event}`);
      assert.deepEqual(result.artifacts, [], variant);
    } finally {
      terminal.input.destroy(); terminal.output.destroy();
      if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true });
    }
  }
});

test('untrusted terminal controls are visibly escaped without changing the canonical approval payload', posixOnly, async () => {
  const controlCharacters = [0x009b, 0x202e, 0x202c, 0x2066, 0x2069, 0x200f].map((code) => String.fromCodePoint(code));
  const controls = `${controlCharacters[0]}2J${controlCharacters[0]}H${controlCharacters[1]}hidden${controlCharacters[2]}${controlCharacters[3]}isolated${controlCharacters[4]}${controlCharacters[5]}`;
  let audit;
  const { result } = await captureWithDouble((request) => {
    const decision = modelDecision();
    const proposal = decision.events.at(-1);
    proposal.id += controls;
    proposal.actions[0].reason += controls;
    proposal.warnings.push(controls);
    proposal.actions.push({ id: 'model-keep', action: 'KEEP', target: 'pom.xml', kind: 'project-input',
      reason: 'Preserve', evidenceIds: ['model-pom'], summary: `Keep existing metadata ${controls}` });
    decision.evidenceLedger[0].observation += controls;
    return jsonResponse(request, decision);
  }, undefined, undefined, { requestProposalApproval: true, requestApproval: async (request) => {
    audit = request.audit;
    for (const control of controlCharacters) assert.equal(request.presentation.includes(control), false);
    assert.ok(request.presentation.includes('\\u009b2J'));
    assert.ok(request.presentation.includes('\\u202e'));
    const prefix = '完整审计（完整 payload/diff、证据与验证计划）：\n';
    const displayed = request.presentation.slice(request.presentation.indexOf(prefix) + prefix.length, request.presentation.indexOf('\nProposal digest:'));
    assert.deepEqual(JSON.parse(displayed), request.audit);
    return null;
  } });
  try {
    assert.equal(result.code, 'APPROVAL_REQUIRED');
    assert.equal(result.setup.proposal.id, `cli-double-proposal-not-fixture-oracle${controls}`);
    assert.deepEqual(result.setup.proposal, audit.proposal);
    assert.equal(result.setup.approval.humanApprovalProven, false);
    const persisted = await readFile(path.join(result.disposableRoot, 'evidence/claude-live/report.json'), 'utf8');
    for (const control of controlCharacters) assert.equal(persisted.includes(control), false);
    assert.deepEqual(JSON.parse(persisted).setup.proposal, result.setup.proposal);
    assert.deepEqual(result.artifacts, []);
  } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
});

test('approval audit retains evidence cited by warnings, unknowns and validation without dumping unrelated facts', posixOnly, async () => {
  let displayed;
  const { result } = await captureWithDouble((request) => {
    const decision = modelDecision();
    const example = decision.evidenceLedger[0];
    decision.evidenceLedger.push(
      { ...example, id: 'warning-e2', observation: 'Explicit warning and validation evidence', persistenceScope: 'DISCOVERABLE' },
      { ...example, id: 'unknown-e3', observation: 'Evidence supporting an unresolved decision', persistenceScope: 'NONE' },
      { ...example, id: 'unrelated-e4', observation: 'Unrelated dormant discovery', persistenceScope: 'DISCOVERABLE' });
    for (const id of ['warnings', 'validationPlan', 'projectSummary', 'unknowns', 'evidenceIds', 'reason', 'summary']) {
      decision.evidenceLedger.push({ ...example, id, observation: 'Unreferenced property-name collision', persistenceScope: 'NONE' });
    }
    decision.events.at(-1).warnings.push('Warning cites warning-e2.');
    decision.events.at(-1).validationPlan.push('Validate against warning-e2 before any future Apply.');
    decision.events.at(-1).unknowns.push({ id: 'unresolved-choice', evidenceIds: ['unknown-e3'] });
    return jsonResponse(request, decision);
  }, undefined, undefined, { requestProposalApproval: true, requestApproval: async (request) => {
    displayed = request.audit.evidenceLedger.map((entry) => entry.id);
    assert.deepEqual(displayed, ['model-pom', 'warning-e2', 'unknown-e3']);
    assert.equal(request.presentation.includes('Unrelated dormant discovery'), false);
    return null;
  } });
  try {
    assert.equal(result.code, 'APPROVAL_REQUIRED');
    assert.deepEqual(displayed, ['model-pom', 'warning-e2', 'unknown-e3']);
    assert.equal(result.setup.decisionRecord.evidenceLedger.length, 11);
  } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
});

test('the real approval-input parser distinguishes terminal rejection from proof of approval', posixOnly, async () => {
  const { result } = await captureWithDouble((request) => jsonResponse(request), undefined, undefined, {
    requestProposalApproval: true, requestApproval: async (request) => {
      // Declared parser provenance probe, not an actual human or terminal interaction.
      const record = { type: 'approval', decision: 'reject', scope: 'exact-proposal', proposalId: request.audit.proposal.id,
        revision: 1, proposalDigest: request.proposalDigest, approvedActionIds: [] };
      const rejected = captureClaudeApproval(JSON.stringify(record), request, 'human-terminal');
      assert.equal(rejected.code, 'PROPOSAL_REJECTED');
      assert.equal(rejected.humanApprovalProven, false);
      const approved = captureClaudeApproval(JSON.stringify({ ...record, decision: 'approve', approvedActionIds: ['model-agents'] }), request, 'human-terminal');
      assert.equal(approved.code, 'APPLY_PROTOCOL_UNVERIFIED');
      assert.equal(approved.humanApprovalProven, true);
      return JSON.stringify(record);
    },
  });
  try {
    assert.equal(result.code, 'PROPOSAL_REJECTED');
    assert.equal(result.setup.approval.source, 'test-double');
    assert.equal(result.setup.approval.humanApprovalProven, false);
    assert.deepEqual(result.artifacts, []);
  } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
});

test('approval waiting remains readonly even if its external input boundary changes context then throws', posixOnly, async () => {
  for (const variant of ['fixture', 'mother', 'write-then-throw']) {
    let processRequest;
    const { result, calls } = await captureWithDouble((request) => { processRequest = request; return jsonResponse(request); }, undefined, undefined, {
      requestProposalApproval: true,
      requestApproval: async (request) => {
        const target = variant === 'mother' ? path.join(processRequest.env.HOME, '.claude/skills/agent-init/SKILL.md')
          : path.join(processRequest.cwd, 'AGENTS.md');
        await writeFile(target, '# Unapproved mutation during approval input\n');
        if (variant === 'write-then-throw') throw Object.assign(new Error('External boundary failed after mutation'), { code: 'INPUT_DOUBLE_FAILED' });
        return JSON.stringify({ type: 'approval', decision: 'approve', scope: 'exact-proposal',
          proposalId: request.audit.proposal.id, revision: request.audit.proposal.revision,
          proposalDigest: request.proposalDigest, approvedActionIds: ['model-agents'] });
      },
    });
    try {
      assert.equal(result.status, 'error', variant);
      assert.equal(result.code, 'APPROVAL_CONTEXT_DRIFT', variant);
      assert.equal(result.setup.approval, undefined, variant);
      assert.equal(result.setup.zeroApprovalWrites, false, variant);
      assert.equal(calls.length, 3, variant);
      assert.deepEqual(result.artifacts, [], variant);
    } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
  }
});

test('duplicate approval fields and private shadowed input cannot become an exact or persisted approval', posixOnly, async () => {
  for (const [variant, code] of [
    ['duplicate-decision', 'APPROVAL_DUPLICATE_FIELDS'], ['escaped-duplicate', 'APPROVAL_DUPLICATE_FIELDS'],
    ['shadowed-secret', 'SECRET_TRACE'], ['private-extra', 'APPROVAL_PRIVATE'],
  ]) {
    const { result } = await captureWithDouble((request) => jsonResponse(request), undefined, undefined, {
      requestProposalApproval: true,
      requestApproval: async (request) => {
        const text = JSON.stringify({ type: 'approval', decision: 'approve', scope: 'exact-proposal',
          proposalId: request.audit.proposal.id, revision: 1, proposalDigest: request.proposalDigest, approvedActionIds: ['model-agents'] });
        if (variant === 'duplicate-decision') return text.replace('"decision":', '"decision":"reject","decision":');
        if (variant === 'escaped-duplicate') return text.replace('"decision":', '"\\u0064ecision":"reject","decision":');
        if (variant === 'shadowed-secret') return text.replace('"decision":', '"extra":"\\u0063apture-only-fake-key","extra":"public","decision":');
        return text.replace('"decision":', '"extra":"file:///Users/private-approval/PRIVATE_APPROVAL_MARKER","decision":');
      },
    });
    try {
      assert.equal(result.code, code, variant);
      assert.equal(result.setup.approval.record, undefined, variant);
      assert.equal(result.setup.approval.humanApprovalProven, false, variant);
      assert.deepEqual(result.artifacts, [], variant);
      const report = await readFile(path.join(result.disposableRoot, 'evidence/claude-live/report.json'), 'utf8');
      assert.equal(report.includes('capture-only-fake-key'), false, variant);
      assert.equal(report.includes('PRIVATE_APPROVAL_MARKER'), false, variant);
    } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
  }
});

test('missing, vague, stale, rejected and partial human input never grants broader write authority', posixOnly, async () => {
  const variants = [
    ['missing', 'APPROVAL_REQUIRED'], ['vague', 'VAGUE_APPROVAL'], ['malformed', 'VAGUE_APPROVAL'],
    ['missing-digest', 'VAGUE_APPROVAL'], ['stale-revision', 'STALE_APPROVAL'], ['changed-digest', 'APPROVAL_PAYLOAD'],
    ['unknown-id', 'APPROVAL_ACTIONS'], ['nonwrite-id', 'APPROVAL_ACTIONS'], ['duplicate-id', 'APPROVAL_ACTIONS'],
    ['reject', 'PROPOSAL_REJECTED'], ['partial', 'PARTIAL_APPROVAL'], ['claimed-human', 'VAGUE_APPROVAL'],
    ['object-with-getter', 'VAGUE_APPROVAL'], ['oversized', 'APPROVAL_INPUT_LIMIT'],
  ];
  let getterCalls = 0;
  for (const [variant, code] of variants) {
    const { result, calls } = await captureWithDouble((request) => {
      const decision = modelDecision();
      decision.events.at(-1).actions.push(
        { id: 'model-adapter', action: 'CREATE', kind: 'claude-adapter', target: 'CLAUDE.md', reason: 'Canonical instructions pointer',
          evidenceIds: ['model-pom'], baselineFingerprint: 'missing', proposedContent: '@AGENTS.md\n' },
        { id: 'model-recommend', action: 'RECOMMEND', kind: 'agent-doc', target: 'docs/agents/safety.md', reason: 'Nonwriting recommendation',
          evidenceIds: ['model-pom'], summary: 'Do not create this recommendation target' });
      return jsonResponse(request, decision);
    }, undefined, undefined, { requestProposalApproval: true, requestApproval: async (request) => {
      const record = { type: 'approval', decision: 'approve', scope: 'exact-proposal', proposalId: request.audit.proposal.id,
        revision: 1, proposalDigest: request.proposalDigest, approvedActionIds: ['model-agents', 'model-adapter'] };
      if (variant === 'missing') return undefined;
      if (variant === 'vague') return 'approve all';
      if (variant === 'malformed') return '{';
      if (variant === 'missing-digest') delete record.proposalDigest;
      if (variant === 'stale-revision') record.revision = 2;
      if (variant === 'changed-digest') record.proposalDigest = `sha256:${'0'.repeat(64)}`;
      if (variant === 'unknown-id') record.approvedActionIds = ['unknown-action'];
      if (variant === 'nonwrite-id') record.approvedActionIds = ['model-recommend'];
      if (variant === 'duplicate-id') record.approvedActionIds = ['model-agents', 'model-agents'];
      if (variant === 'reject') { record.decision = 'reject'; record.approvedActionIds = []; }
      if (variant === 'partial') record.approvedActionIds = ['model-agents'];
      if (variant === 'claimed-human') record.source = 'human-terminal';
      if (variant === 'object-with-getter') return { get decision() { getterCalls += 1; return 'approve'; } };
      if (variant === 'oversized') return 'x'.repeat(65537);
      return JSON.stringify(record);
    } });
    try {
      assert.equal(result.status, 'blocked', variant);
      assert.equal(result.code, code, variant);
      assert.equal(result.setup.approval.source, 'test-double', variant);
      assert.equal(result.setup.approval.humanApprovalProven, false, variant);
      assert.equal(result.setup.zeroApprovalWrites, true, variant);
      assert.equal(result.setup.applySupported, false, variant);
      assert.equal(calls.length, 3, variant);
      assert.deepEqual(result.artifacts, [], variant);
      if (variant === 'partial') {
        assert.deepEqual(result.setup.approval.record.approvedActionIds, ['model-agents']);
        assert.deepEqual(result.setup.approval.unapprovedActionIds, ['model-adapter']);
      } else if (variant !== 'reject') assert.equal(result.setup.approval.record, undefined, variant);
      for (const target of ['AGENTS.md', 'CLAUDE.md']) await assert.rejects(lstat(path.join(calls.at(-1).cwd, target)), { code: 'ENOENT' });
    } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
  }
  assert.equal(getterCalls, 0);
});

test('an approval callback without opt-in is not called and the presented Proposal cannot be mutated', posixOnly, async () => {
  let approvalCalls = 0;
  const noOptIn = await captureWithDouble((request) => jsonResponse(request), undefined, undefined, {
    requestApproval: async () => { approvalCalls += 1; throw new Error('Not authorized to ask'); },
  });
  try {
    assert.equal(noOptIn.result.code, 'APPROVAL_REQUIRED');
    assert.equal(approvalCalls, 0);
    assert.equal(noOptIn.result.setup.approval, undefined);
  } finally { await rm(noOptIn.result.disposableRoot, { recursive: true, force: true }); }
  const frozen = await captureWithDouble((request) => jsonResponse(request), undefined, undefined, {
    requestProposalApproval: true, requestApproval: async (request) => {
      assert.throws(() => { request.audit.proposal.actions[0].proposedContent = 'Altered payload'; }, TypeError);
      assert.throws(() => { request.requestedWriteActionIds.push('extra-action'); }, TypeError);
      assert.throws(() => { request.proposalDigest = 'invented'; }, TypeError);
      return null;
    },
  });
  try {
    assert.equal(frozen.result.code, 'APPROVAL_REQUIRED');
    assert.equal(frozen.result.setup.proposal.actions[0].proposedContent, '# Model-authored capture\n\nUnique body from the external CLI double.\n');
  } finally { await rm(frozen.result.disposableRoot, { recursive: true, force: true }); }
});

test('private normalized decisions and JSON-escaped shadowed secrets are rejected before retention', posixOnly, async () => {
  const marker = 'PRIVATE_CAPTURE_MARKER_DO_NOT_PERSIST';
  for (const variant of ['credential-key', 'file-uri', 'absolute-content', 'secret-assignment', 'shadowed-inner-secret', 'shadowed-envelope-secret']) {
    const { result } = await captureWithDouble((request) => {
      const decision = modelDecision();
      const proposal = decision.events.at(-1);
      if (variant === 'credential-key') proposal.extra = { apiKey: marker };
      if (variant === 'file-uri') proposal.actions[0].proposedContent += `file:///Users/private-capture/settings.json ${marker}`;
      if (variant === 'absolute-content') proposal.projectSummary = `Source:(/Users/private-capture/file) ${marker}`;
      if (variant === 'secret-assignment') proposal.actions[0].proposedContent += `secret="${marker}"`;
      const response = jsonResponse(request, decision);
      if (variant === 'shadowed-inner-secret') {
        const envelope = JSON.parse(response.stdout);
        envelope.structured_output.decisionRecordJson = envelope.structured_output.decisionRecordJson.replace('"projectSummary":',
          '"shadowed":"\\u0063apture-only-fake-key","shadowed":"public","projectSummary":');
        response.stdout = JSON.stringify(envelope);
      }
      if (variant === 'shadowed-envelope-secret') response.stdout = response.stdout.replace('"result":',
        '"shadowed":"\\u0063apture-only-fake-key","shadowed":"public","result":');
      return response;
    });
    try {
      assert.equal(result.status, 'error', variant);
      assert.equal(result.code, variant.startsWith('shadowed-') ? 'SECRET_TRACE' : 'PROPOSAL_PRIVATE', variant);
      assert.equal(result.setup, undefined, variant);
      assert.deepEqual(result.artifacts, [], variant);
      const report = await readFile(path.join(result.disposableRoot, 'evidence/claude-live/report.json'), 'utf8');
      assert.equal(report.includes(marker), false, variant);
      assert.equal(report.includes('capture-only-fake-key'), false, variant);
      assert.equal(report.includes('/Users/private-capture'), false, variant);
    } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
  }
});

test('readonly capture detects root metadata, mother mutation and writes even when the CLI boundary throws', posixOnly, async () => {
  for (const mutation of ['fixture-root-mode', 'mother', 'write-then-throw']) {
    const { result } = await captureWithDouble(async (request) => {
      if (mutation === 'fixture-root-mode') {
        const stat = await lstat(request.cwd);
        await chmod(request.cwd, (stat.mode & 0o777) ^ 0o020);
      }
      if (mutation === 'mother') await writeFile(path.join(request.env.HOME, '.claude/skills/agent-init/SKILL.md'), '# Unexpected mother mutation\n');
      if (mutation === 'write-then-throw') {
        await writeFile(path.join(request.cwd, 'AGENTS.md'), '# Unapproved write before boundary failure\n');
        throw Object.assign(new Error('Double fails after actual mutation'), { code: 'CLI_DOUBLE_FAILED' });
      }
      return jsonResponse(request);
    });
    try {
      assert.equal(result.status, 'error', mutation);
      assert.equal(result.code, 'UNAPPROVED_WRITES', mutation);
      assert.equal(result.setup, undefined, mutation);
      assert.deepEqual(result.artifacts, [], mutation);
      assert.equal(result.liveSkillBehaviorProven, false, mutation);
    } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
  }
});

test('captured decisions cannot offer production/configuration writes, escaping references or non-write payloads for approval', posixOnly, async () => {
  for (const [variant, code] of [
    ['production', 'PROPOSAL_WRITE_SCOPE'], ['settings', 'PROPOSAL_WRITE_SCOPE'], ['escaping-reference', 'PROPOSAL_REFERENCE'],
    ['keep-with-payload', 'PROPOSAL_NON_WRITE_PAYLOAD'], ['missing-nonwrite-summary', 'PROPOSAL_INCOMPLETE'], ['invented-baseline', 'PROPOSAL_BASELINE'],
  ]) {
    const { result } = await captureWithDouble((request) => {
      const decision = modelDecision();
      const action = decision.events.at(-1).actions[0];
      if (variant === 'production') Object.assign(action, { kind: 'production-rewrite', target: 'pom.xml' });
      if (variant === 'settings') Object.assign(action, { kind: 'settings', target: '.claude/settings.json' });
      if (variant === 'escaping-reference') Object.assign(action, { kind: 'claude-skill-reference', target: '.claude/skills/build-verify', linkTarget: '../../../../unapproved-destination' });
      if (variant === 'keep-with-payload') Object.assign(action, { action: 'KEEP', summary: 'Already configured' });
      if (variant === 'missing-nonwrite-summary') { action.action = 'RECOMMEND'; delete action.proposedContent; }
      if (variant === 'invented-baseline') action.baselineFingerprint = 'sha256:invented';
      return jsonResponse(request, decision);
    });
    try {
      assert.equal(result.status, 'error', variant);
      assert.equal(result.code, code, variant);
      assert.equal(result.setup, undefined, variant);
      assert.deepEqual(result.artifacts, [], variant);
    } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
  }
});

test('missing, failed, malformed and oversized CLI responses never become an empty or successful capture', posixOnly, async () => {
  for (const [variant, code] of [
    ['missing-structured', 'PROPOSAL_MISSING'], ['malformed-envelope', 'PROPOSAL_ENVELOPE'], ['wrong-session', 'SESSION_MISMATCH'],
    ['unknown-failure-subtype', 'SESSION_FAILED'], ['denied', 'PERMISSION_DENIED'], ['missing-denials', 'PROPOSAL_ENVELOPE'],
    ['truncated', 'TRACE_TRUNCATED'], ['timeout', 'PROCESS_TIMEOUT'], ['cleanup', 'PROCESS_CLEANUP_FAILED'], ['exit', 'PROCESS_FAILED'],
    ['malformed-decision', 'PROPOSAL_MALFORMED'], ['approval-event', 'PROPOSAL_SEQUENCE'], ['oversized', 'PROPOSAL_INPUT_LIMIT'], ['deep', 'PROPOSAL_INPUT_LIMIT'],
  ]) {
    const { result, calls } = await captureWithDouble((request) => {
      const response = jsonResponse(request);
      const envelope = JSON.parse(response.stdout);
      if (variant === 'missing-structured') { delete envelope.structured_output; envelope.result = JSON.stringify(modelDecision()); }
      if (variant === 'malformed-envelope') return { status: 0, stdout: 'not-json' };
      if (variant === 'wrong-session') envelope.session_id = 'another-session';
      if (variant === 'unknown-failure-subtype') Object.assign(envelope, { subtype: 'deliberately-unknown-cli-failure', is_error: true });
      if (variant === 'denied') envelope.permission_denials = [{ fakeDeniedTool: 'Write' }];
      if (variant === 'missing-denials') delete envelope.permission_denials;
      if (variant === 'truncated') response.truncated = true;
      if (variant === 'timeout') response.timedOut = true;
      if (variant === 'cleanup') response.cleanupError = { code: 'EPERM', signal: 'SIGKILL' };
      if (variant === 'exit') response.status = 7;
      if (variant === 'malformed-decision') envelope.structured_output.decisionRecordJson = '{';
      if (variant === 'approval-event') {
        const decision = modelDecision(); decision.events.push({ type: 'approval', decision: 'approve' });
        envelope.structured_output.decisionRecordJson = JSON.stringify(decision);
      }
      if (variant === 'oversized') {
        const decision = modelDecision(); decision.events.at(-1).projectSummary = 'x'.repeat(1024 * 1024);
        envelope.structured_output.decisionRecordJson = JSON.stringify(decision);
      }
      if (variant === 'deep') {
        let nested = {}; for (let index = 0; index < 80; index += 1) nested = { nested };
        const decision = modelDecision(); decision.events.at(-1).extra = nested;
        envelope.structured_output.decisionRecordJson = JSON.stringify(decision);
      }
      response.stdout = JSON.stringify(envelope);
      return response;
    });
    try {
      assert.equal(result.status, 'error', variant);
      assert.equal(result.code, code, variant);
      assert.equal(calls.length, 3, variant);
      assert.equal(result.setup, undefined, variant);
      assert.deepEqual(result.artifacts, [], variant);
      assert.equal(result.liveSkillBehaviorProven, false, variant);
    } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
  }
});

test('unrepresentable decision numbers cannot silently change during report serialization', posixOnly, async () => {
  for (const literal of ['1e309', '9007199254740993']) {
    const { result } = await captureWithDouble((request) => {
      const response = jsonResponse(request);
      const envelope = JSON.parse(response.stdout);
      envelope.structured_output.decisionRecordJson = envelope.structured_output.decisionRecordJson.replace('"value":"Maven"', `"value":${literal}`);
      response.stdout = JSON.stringify(envelope);
      return response;
    });
    try {
      assert.equal(result.status, 'error', literal);
      assert.equal(result.code, 'PROPOSAL_MALFORMED', literal);
      assert.equal(result.setup, undefined, literal);
    } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
  }
});

test('readonly capture can select one named baseline fixture without copying its oracle into model context', posixOnly, async () => {
  const { result, calls } = await captureWithDouble((request) => {
    const decision = modelDecision();
    decision.evidenceLedger[0].sourcePath = '.agents/skills/release/SKILL.md';
    decision.events.at(-1).actions = [];
    return jsonResponse(request, decision);
  }, '08-existing-skills');
  try {
    assert.equal(result.code, 'APPROVAL_REQUIRED');
    assert.equal(result.setup.fixtureId, '08-existing-skills');
    assert.equal((await lstat(path.join(calls.at(-1).cwd, '.agents/skills/release/SKILL.md'))).isFile(), true);
    await assert.rejects(lstat(path.join(path.dirname(calls.at(-1).cwd), 'fixture.json')), { code: 'ENOENT' });
    assert.equal(calls.length, 3);
    assert.deepEqual(result.artifacts, []);
  } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
});

test('KEEP preserves an existing physically contained Claude reference instead of treating it as a write', posixOnly, async () => {
  const { result, calls } = await captureWithDouble((request) => {
    const decision = modelDecision();
    decision.evidenceLedger[0].sourcePath = '.agents/skills/release/SKILL.md';
    const action = decision.events.at(-1).actions[0];
    Object.assign(action, { action: 'KEEP', kind: 'claude-skill-reference', target: '.claude/skills/release', summary: 'Preserve the existing reference' });
    delete action.proposedContent;
    delete action.baselineFingerprint;
    return jsonResponse(request, decision);
  }, '08-existing-skills');
  try {
    assert.equal(result.code, 'APPROVAL_REQUIRED');
    assert.equal(result.setup.proposal.actions[0].action, 'KEEP');
    assert.equal((await lstat(path.join(calls.at(-1).cwd, '.claude/skills/release'))).isSymbolicLink(), true);
    assert.equal(result.setup.zeroProposalWrites, true);
    assert.deepEqual(result.artifacts, []);
  } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
});

test('malformed Profile, Classify and Skills entries are rejected before capture retention', posixOnly, async () => {
  for (const [phase, field] of [[0, 'facts'], [1, 'decisions'], [2, 'candidates']]) {
    for (const entry of [null, {}]) {
      const { result } = await captureWithDouble((request) => {
        const decision = modelDecision();
        decision.events[phase][field] = [entry];
        decision.events.at(-1).actions = [];
        return jsonResponse(request, decision);
      });
      try {
        assert.equal(result.code, 'PROPOSAL_INCOMPLETE', field);
        assert.equal(result.setup, undefined, field);
        assert.deepEqual(result.artifacts, [], field);
      } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
    }
  }
});

test('UPDATE retains the exact diff audit representation and rejects content-only or inconsistent diffs', posixOnly, async () => {
  for (const variant of ['exact-diff', 'content-only', 'inconsistent-diff']) {
    let original;
    let proposedDiff;
    const { result, calls } = await captureWithDouble(async (request) => {
      original = await readFile(path.join(request.cwd, 'AGENTS.md'), 'utf8');
      const after = `${original}\nUnique update from the external CLI double.\n`;
      proposedDiff = renderExactDiff('AGENTS.md', original, after);
      const decision = modelDecision();
      decision.evidenceLedger[0].sourcePath = 'AGENTS.md';
      const action = decision.events.at(-1).actions[0];
      Object.assign(action, { action: 'UPDATE', baselineFingerprint: await fingerprintPath(request.cwd, 'AGENTS.md'), proposedDiff });
      delete action.proposedContent;
      if (variant === 'content-only') { delete action.proposedDiff; action.proposedContent = after; }
      if (variant === 'inconsistent-diff') action.proposedDiff = proposedDiff.replace('@@ -1,', '@@ -2,');
      return jsonResponse(request, decision);
    }, '05-existing-agents');
    try {
      assert.equal(result.code, variant === 'exact-diff' ? 'APPROVAL_REQUIRED' : 'PROPOSAL_DIFF', variant);
      if (variant === 'exact-diff') assert.equal(result.setup.proposal.actions[0].proposedDiff, proposedDiff);
      else assert.equal(result.setup, undefined);
      assert.equal(await readFile(path.join(calls.at(-1).cwd, 'AGENTS.md'), 'utf8'), original);
      assert.deepEqual(result.artifacts, []);
    } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
  }
});

test('canonical link spelling cannot hide a physically escaping canonical parent (adversarial preflight double)', posixOnly, async () => {
  const { result } = await captureWithDouble((request) => {
    const decision = modelDecision();
    const action = decision.events.at(-1).actions[0];
    Object.assign(action, { kind: 'claude-skill-reference', target: '.claude/skills/build-verify', linkTarget: '../../.agents/skills/build-verify' });
    delete action.proposedContent;
    return jsonResponse(request, decision);
  }, undefined, async (request) => {
    // Deliberate external-process side effect before context capture. Both the
    // project and escaping destination are inside this invocation's owned root.
    const cwd = path.join(request.cwd, 'setup-proposal/11-maven-multi-module-build-verify/repository');
    const outside = path.join(request.cwd, 'adversarial-canonical-parent');
    await mkdir(cwd, { recursive: true });
    await mkdir(outside);
    await symlink(outside, path.join(cwd, '.agents'));
  });
  try {
    assert.equal(result.code, 'PROPOSAL_REFERENCE');
    assert.equal(result.setup, undefined);
    assert.deepEqual(result.artifacts, []);
  } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
});

test('readonly setup Proposal needs its own execution authorization before authentication or assets', async () => {
  let calls = 0;
  const invokeClaude = async () => { calls += 1; throw new Error('No real fallback'); };
  for (const [options, code] of [
    [{ scope: 'setup-proposal' }, 'LIVE_OPT_IN_REQUIRED'],
    [{ live: true, scope: 'setup-proposal', env: {} }, 'SETUP_AUTHORIZATION_REQUIRED'],
    [{ live: true, scope: 'setup-proposal', authorizeSetupProposal: false, env: {} }, 'SETUP_AUTHORIZATION_REQUIRED'],
    [{ live: true, scope: 'setup-proposal', authorizeSetupProposal: true, env: {} },
      process.platform === 'win32' ? 'PROCESS_TREE_UNSUPPORTED' : 'AUTHENTICATION_UNAVAILABLE'],
  ]) {
    const result = await runClaudeLiveAcceptance(options, { invokeClaude });
    assert.equal(result.status, 'blocked');
    assert.equal(result.code, code);
    assert.equal(result.disposableRoot, undefined);
    assert.deepEqual(result.artifacts, []);
    assert.equal(result.liveSkillBehaviorProven, false);
  }
  assert.equal(calls, 0);
});
