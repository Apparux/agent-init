import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { runClaudeLiveAcceptance } from './claude-live-runner.js';
import { fingerprintPath } from './evaluation-harness.js';

const posixOnly = { skip: process.platform === 'win32' ? 'owned POSIX processes are unavailable' : false };
const flags = '--bare --restricted --print --output-format --verbose --tools --permission-mode --permission-prompts --max-budget-usd --model --add-dir --session-id --no-session-persistence --strict-mcp-config --mcp-config --prompt-suggestions --settings --setting-sources --resume';

function decisions() {
  return { evidenceLedger: [{ id: 'pom-source', fact: 'Maven repository', sourcePath: 'pom.xml', sourceLocation: 'project',
    observation: 'The owned repository snapshot includes a Maven project declaration.', whyItMatters: 'Preserve the existing build definition.' }], events: [
    { type: 'profile', facts: [{ id: 'maven', status: 'confirmed', evidenceIds: ['pom-source'] }], unknowns: ['Remote environment is unknown.'] },
    { type: 'classify', decisions: [{ factId: 'maven', persistenceScope: 'GLOBAL', deterministicEnforcementCandidate: false }] },
    { type: 'skills', candidates: [] },
    { type: 'proposal', id: 'native-setup-model-decision', revision: 1, projectSummary: 'Use the observed Maven repository.',
      unknowns: ['Remote environment is unknown.'], warnings: [], nonGoals: ['No remote operations.'], validationPlan: ['Inspect the written instruction file.'],
      actions: [{ id: 'agents-create', action: 'CREATE', target: 'AGENTS.md', kind: 'agents', reason: 'Link repository context.',
        evidenceIds: ['pom-source'], baselineFingerprint: 'missing', proposedContent: '# Project\n\nPreserve the Maven build.\n' }] },
  ] };
}

function simpleJavaDecisions() {
  const evidenceIds = ['ev-java-release'];
  return { evidenceLedger: [{ id: 'ev-java-release', fact: 'The Maven build declares Java 17 release compatibility.',
    sourcePath: 'pom.xml', sourceLocation: 'project.properties.maven.compiler.release', observation: 'maven.compiler.release is 17',
    sourceExcerpt: '<maven.compiler.release>17</maven.compiler.release>',
    whyItMatters: 'The declared Java release is a pre-action repository constraint.',
    persistenceScope: 'GLOBAL', deterministicEnforcementCandidate: true }], events: [
    { type: 'profile', facts: [{ id: 'fact-java-release', value: '17', status: 'confirmed', evidenceIds }],
      unknowns: ['verification-command', 'deployment-command', 'module-seams'] },
    { type: 'classify', decisions: [{ factId: 'fact-java-release', persistenceScope: 'GLOBAL',
      deterministicEnforcementCandidate: true, destination: 'AGENTS.md' }] },
    { type: 'skills', candidates: [{ name: 'java-backend', decision: 'SKIP', reason: 'A stack is not a workflow.', evidenceIds,
      skillAssessment: { taskSpecificity: 'low', rediscoveryCost: 'low', errorCost: 'unknown', reuseFrequency: 'low' },
      targetedFollowUpSearch: { queries: ['Java verification workflow'], paths: ['pom.xml'],
        result: 'Only a Java release is declared; no named workflow or verification command.', evidenceIds },
      skipBasis: { dimensions: ['taskSpecificity', 'rediscoveryCost', 'errorCost', 'reuseFrequency'],
        explanation: 'The observed <maven.compiler.release>17</maven.compiler.release> declares a runtime constraint, not task-specific operational steps or a verification command.' } }] },
    { type: 'proposal', id: 'simple-java-native-model-double', revision: 1, projectSummary: 'Preserve the Java 17 constraint.',
      unknowns: ['verification-command', 'deployment-command', 'module-seams'], warnings: [], nonGoals: ['No stack-label Skill.'],
      validationPlan: ['Inspect exact instructions and readonly reconcile.'], actions: [
        { id: 'agents-create', action: 'CREATE', target: 'AGENTS.md', kind: 'agents', reason: 'Preserve the runtime constraint.',
          evidenceIds, baselineFingerprint: 'missing', proposedContent: '# Project\n\nUse Java 17.\n' },
        { id: 'claude-create', action: 'CREATE', target: 'CLAUDE.md', kind: 'claude-adapter', reason: 'Import shared instructions.',
          evidenceIds, baselineFingerprint: 'missing', proposedContent: '@AGENTS.md\n' },
        { id: 'skip-java', action: 'SKIP', target: '.agents/skills/java-backend/SKILL.md', kind: 'project-skill',
          reason: 'A stack label is not a workflow.', evidenceIds, summary: 'No Java stack-label Skill.' },
      ] },
  ] };
}

function nativeHook(settings, request, event) {
  const transcript = path.join(request.env.HOME, '.claude/projects/setup-model-double', `${request.sessionId}.jsonl`);
  if (event.hook_event_name === 'SessionStart') mkdirSync(path.dirname(transcript), { recursive: true });
  if (event.hook_event_name === 'UserPromptExpansion') {
    // External CLI journal double. The installed mother has the independently
    // fixed five-line metadata prefix, not a call to the producer's renderer.
    const alias = path.join(request.env.HOME, '.claude/skills/agent-init');
    const lines = readFileSync(path.join(alias, 'SKILL.md'), 'utf8').split('\n');
    assert.equal(lines[0], '---');
    assert.equal(lines[1], 'name: agent-init');
    assert.equal(lines[3], '---');
    assert.equal(lines[4], '');
    assert.equal(lines[5], '# Agent Init');
    const args = event.command_args;
    assert.equal(typeof args, 'string');
    assert.doesNotMatch(args, /`!|!`|(?:^|\s)!/);
    const caller = randomUUID();
    const body = `Base directory for this skill: ${alias}\n\n${lines.slice(5).join('\n')}${args ? `\n\nARGUMENTS: ${args}` : ''}`;
    const common = { sessionId: request.sessionId, cwd: request.cwd, version: '2.1.285' };
    writeFileSync(transcript, [
      { ...common, type: 'user', uuid: caller, parentUuid: null, message: { role: 'user',
        content: `<command-message>agent-init</command-message>\n<command-name>/agent-init</command-name>\n<command-args>${args}</command-args>` } },
      { ...common, type: 'user', uuid: randomUUID(), parentUuid: caller, isMeta: true, turnCompanion: true,
        message: { role: 'user', content: [{ type: 'text', text: body }] } },
    ].map(JSON.stringify).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
  }
  const command = settings.hooks[event.hook_event_name][0].hooks[0].command;
  const child = spawnSync('/bin/sh', ['-c', command], { cwd: request.cwd, env: request.env,
    input: JSON.stringify({ session_id: request.sessionId, cwd: request.cwd, transcript_path: transcript, ...event }), encoding: 'utf8', timeout: 2000, maxBuffer: 65536 });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, '');
  return JSON.parse(child.stdout);
}

test('native setup requires independent authorization before authentication or assets', posixOnly, async () => {
  let calls = 0;
  const boundaries = { invokeClaude: async () => { calls += 1; throw new Error('Not authorized'); } };
  for (const [options, code] of [
    [{ live: true, scope: 'native-setup' }, 'NATIVE_SETUP_AUTHORIZATION_REQUIRED'],
    [{ live: true, scope: 'native-discovery', authorizeNativeSetup: true, authorizeNativeDiscovery: true }, 'NATIVE_SETUP_SCOPE'],
    [{ live: true, scope: 'native-setup', authorizeNativeSetup: 'yes' }, 'NATIVE_SETUP_SCOPE'],
  ]) {
    const result = await runClaudeLiveAcceptance(options, boundaries);
    assert.equal(result.code, code);
    assert.equal(result.disposableRoot, undefined);
  }
  assert.equal(calls, 0);
});

test('native corpus requires its own opt-in before authentication, assets or model processes', posixOnly, async () => {
  let calls = 0;
  const boundaries = { invokeClaude: async () => { calls++; throw new Error('Not authorized'); } };
  for (const [options, code] of [
    [{ live: true, scope: 'native-corpus' }, 'NATIVE_CORPUS_AUTHORIZATION_REQUIRED'],
    [{ live: true, scope: 'native-setup', authorizeNativeSetup: true, authorizeNativeCorpus: true }, 'NATIVE_CORPUS_SCOPE'],
    [{ live: true, scope: 'native-corpus', authorizeNativeCorpus: 'yes' }, 'NATIVE_CORPUS_SCOPE'],
    [{ live: true, scope: 'native-corpus', authorizeNativeCorpus: true }, 'MODEL_BUDGET_SCOPE'],
    [{ live: true, scope: 'native-corpus', authorizeNativeCorpus: true, maxModelProcesses: 39 }, 'MODEL_BUDGET_SCOPE'],
    [{ live: true, scope: 'native-corpus', authorizeNativeCorpus: true, maxModelProcesses: 39, totalModelBudgetUsd: 116 }, 'MODEL_BUDGET_SCOPE'],
  ]) {
    const result = await runClaudeLiveAcceptance(options, boundaries);
    assert.equal(result.code, code);
    assert.equal(result.disposableRoot, undefined);
  }
  assert.equal(calls, 0);
});

test('a mocked approval boundary cannot relabel a real native process to bypass the permission floor', posixOnly, async () => {
  for (const boundaries of [{ requestApproval: async () => 'unused' }, { approvalTerminal: { input: { isTTY: true }, output: { isTTY: true } } }]) {
    const result = await runClaudeLiveAcceptance({ live: true, scope: 'native-setup', authorizeNativeSetup: true,
      requestProposalApproval: true, claudeExecutable: process.execPath, env: {} }, boundaries);
    assert.equal(result.code, 'NATIVE_APPROVAL_AUTHORITY');
    assert.equal(result.disposableRoot, undefined);
    assert.deepEqual(result.artifacts, []);
  }
});

async function captureNativeSetup(response, approval = {}) {
  const calls = [];
  let boundaryError;
  const result = await runClaudeLiveAcceptance({ live: true, scope: 'native-setup', authorizeNativeSetup: true,
    claudeExecutable: process.execPath, env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: 'native-setup-test-only' }, ...approval.options }, {
    ...approval.boundaries,
    invokeClaude: async (request) => {
      if (request.args.includes('--version')) return { status: 0, stdout: '2.1.285 (Claude Code)\n' };
      if (request.args.includes('--help')) return { status: 0, stdout: flags };
      calls.push(request);
      try { return await response(request); }
      catch (cause) { boundaryError ??= cause; throw cause; }
    },
  });
  return { result, calls, boundaryError };
}

test('native setup CLI cannot reuse discovery consent or imported approval', posixOnly, async () => {
  const entry = path.resolve('tests/agent-init/claude-live-runner.js');
  const { invokeClaudeProcess } = await import('./claude-live-runner.js');
  for (const [args, code] of [
    [['--live', '--scope', 'native-setup'], 'NATIVE_SETUP_AUTHORIZATION_REQUIRED'],
    [['--live', '--scope', 'native-setup', '--authorize-native-setup'], 'AUTHENTICATION_UNAVAILABLE'],
    [['--live', '--scope', 'native-discovery', '--authorize-native-setup'], 'CLI_ARGUMENTS'],
    [['--live', '--scope', 'native-corpus'], 'NATIVE_CORPUS_AUTHORIZATION_REQUIRED'],
    [['--live', '--scope', 'native-corpus', '--authorize-native-corpus'], 'MODEL_BUDGET_SCOPE'],
    [['--live', '--scope', 'native-setup', '--authorize-native-corpus'], 'CLI_ARGUMENTS'],
    [['--live', '--scope', 'native-corpus', '--authorize-native-corpus', '--authorize-native-corpus'], 'CLI_ARGUMENTS'],
    [['--live', '--scope', 'native-setup', '--authorize-native-setup', '--authorize-native-setup'], 'CLI_ARGUMENTS'],
    [['--live', '--scope', 'native-setup', '--authorize-native-setup', '--approval-file', 'approval.json'], 'CLI_ARGUMENTS'],
  ]) {
    const result = await invokeClaudeProcess({ command: process.execPath, args: [entry, ...args], cwd: path.dirname(entry),
      env: { PATH: process.env.PATH }, timeoutMs: 2000 });
    assert.equal(result.status, 2);
    assert.equal(JSON.parse(result.stdout).code, code);
    assert.equal(JSON.parse(result.stdout).disposableRoot, undefined);
  }
});

test('native setup cannot request approval without actual native lifecycle and mother expansion (CLI double)', posixOnly, async () => {
  const { result } = await captureNativeSetup(async (request) => ({ status: 0, stdout: JSON.stringify({ type: 'result',
    subtype: 'success', is_error: false, session_id: request.sessionId, permission_denials: [],
    result: JSON.stringify({ decisionRecordJson: JSON.stringify(decisions()) }) }) }));
  try {
    assert.equal(result.code, 'NATIVE_EVENTS_MISSING');
    assert.equal(result.setup, undefined);
    assert.deepEqual(result.artifacts, []);
  } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
});

test('native setup presents the complete captured Proposal to exact approval intake, never expanding partial consent (CLI double)', posixOnly, async () => {
  let presented;
  const { result, calls } = await captureNativeSetup(async request => {
    const settings = JSON.parse(await readFile(request.args[request.args.indexOf('--settings') + 1], 'utf8'));
    nativeHook(settings, request, { hook_event_name: 'SessionStart', source: 'startup' });
    nativeHook(settings, request, { hook_event_name: 'UserPromptExpansion', expansion_type: 'slash_command',
      command_name: 'agent-init', command_args: '', command_source: 'userSettings', prompt: 'opaque body' });
    nativeHook(settings, request, { hook_event_name: 'Stop', stop_hook_active: false });
    return { status: 0, stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false,
      session_id: request.sessionId, permission_denials: [], result: JSON.stringify({ decisionRecordJson: JSON.stringify(simpleJavaDecisions()) }) }) };
  }, { options: { fixtureId: '01-java-maven-simple', requestProposalApproval: true }, boundaries: { requestApproval: async request => {
    presented = request;
    assert.doesNotMatch(request.presentation, /批准后也不会写入/);
    assert.match(request.presentation, /额外模型调用/);
    return JSON.stringify({ type: 'approval', decision: 'approve', scope: 'exact-proposal', proposalId: request.audit.proposal.id,
      revision: request.audit.proposal.revision, proposalDigest: request.proposalDigest, approvedActionIds: [] });
  } } });
  try {
    assert.ok(presented.presentation.includes('# Project'));
    assert.equal(result.code, 'PARTIAL_APPROVAL');
    assert.equal(result.setup.approval.humanApprovalProven, false);
    assert.equal(result.setup.zeroApprovalWrites, true);
    assert.equal(calls.length, 1);
    await assert.rejects(readFile(path.join(calls[0].cwd, 'AGENTS.md')), { code: 'ENOENT' });
  } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
});

test('native setup accepts source-grounded decisions without fixture-oracle IDs or prose (CLI double)', posixOnly, async () => {
  const record = simpleJavaDecisions();
  record.evidenceLedger[0].id = 'observed-release-property';
  record.evidenceLedger[0].whyItMatters = 'Retain the repository runtime boundary without inventing build commands.';
  record.events[0].facts[0].id = 'observed-java-compatibility';
  record.events[0].facts[0].evidenceIds = ['observed-release-property'];
  record.events[1].decisions[0].factId = 'observed-java-compatibility';
  const candidate = record.events[2].candidates[0];
  candidate.evidenceIds = ['observed-release-property'];
  candidate.targetedFollowUpSearch.evidenceIds = ['observed-release-property'];
  record.events[3].id = 'independent-source-backed-proposal';
  for (const action of record.events[3].actions) action.evidenceIds = ['observed-release-property'];
  let presented;
  const { result, calls } = await captureNativeSetup(async request => {
    const settings = JSON.parse(await readFile(request.args[request.args.indexOf('--settings') + 1], 'utf8'));
    nativeHook(settings, request, { hook_event_name: 'SessionStart', source: 'startup' });
    nativeHook(settings, request, { hook_event_name: 'UserPromptExpansion', expansion_type: 'slash_command',
      command_name: 'agent-init', command_args: '', command_source: 'userSettings', prompt: 'opaque body' });
    nativeHook(settings, request, { hook_event_name: 'Stop', stop_hook_active: false });
    return { status: 0, stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false,
      session_id: request.sessionId, permission_denials: [], result: JSON.stringify({ decisionRecordJson: JSON.stringify(record) }) }) };
  }, { options: { fixtureId: '01-java-maven-simple', requestProposalApproval: true }, boundaries: { requestApproval: async request => {
    presented = request;
    return JSON.stringify({ type: 'approval', decision: 'reject', scope: 'exact-proposal', proposalId: request.audit.proposal.id,
      revision: request.audit.proposal.revision, proposalDigest: request.proposalDigest, approvedActionIds: [] });
  } } });
  try {
    assert.equal(result.code, 'PROPOSAL_REJECTED', result.setup?.proposalValidation?.errors.join('\n') ?? result.code);
    assert.equal(result.setup.proposalValidation.ok, true);
    assert.equal(result.setup.proposalValidation.claims.liveSkillBehaviorProven, false);
    assert.deepEqual(result.setup.decisionRecord, record);
    assert.deepEqual(presented.audit.proposal, record.events[3]);
    assert.equal(result.setup.proposalDigest, presented.proposalDigest);
    assert.equal(result.setup.consumerValidated, false);
    assert.equal(calls.length, 1);
    assert.deepEqual(result.artifacts, []);
    await assert.rejects(readFile(path.join(calls[0].cwd, 'AGENTS.md')), { code: 'ENOENT' });
  } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
});

test('native setup rejects invalid JSON decision payloads before presenting approval (CLI double)', posixOnly, async t => {
  for (const scenario of ['markdown', 'shadowed-secret', 'stale-baseline']) await t.test(scenario, async () => {
    let approvalCalls = 0;
    const { result } = await captureNativeSetup(async request => {
      const settings = JSON.parse(await readFile(request.args[request.args.indexOf('--settings') + 1], 'utf8'));
      nativeHook(settings, request, { hook_event_name: 'SessionStart', source: 'startup' });
      nativeHook(settings, request, { hook_event_name: 'UserPromptExpansion', expansion_type: 'slash_command',
        command_name: 'agent-init', command_args: '', command_source: 'userSettings', prompt: 'opaque body' });
      nativeHook(settings, request, { hook_event_name: 'Stop', stop_hook_active: false });
      const record = decisions();
      if (scenario === 'stale-baseline') record.events.at(-1).actions[0].baselineFingerprint = 'sha256:incorrect';
      let decision = JSON.stringify({ decisionRecordJson: JSON.stringify(record) });
      if (scenario === 'markdown') decision = '```json\n' + decision + '\n```';
      if (scenario === 'shadowed-secret') decision = '{"extra":"native-setup-test-only","extra":"public","decisionRecordJson":' + JSON.stringify(JSON.stringify(record)) + '}';
      return { status: 0, stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false,
        session_id: request.sessionId, permission_denials: [], result: decision }) };
    }, { options: { requestProposalApproval: true }, boundaries: { requestApproval: async () => { approvalCalls++; return ''; } } });
    try {
      assert.equal(result.code, { markdown: 'PROPOSAL_RESULT', 'shadowed-secret': 'SECRET_TRACE', 'stale-baseline': 'PROPOSAL_BASELINE' }[scenario]);
      assert.equal(approvalCalls, 0);
      assert.equal(result.setup, undefined);
      assert.deepEqual(result.artifacts, []);
    } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
  });
});

test('native setup validates before deferred Writes, preserves partial failures and performs readonly reconcile (CLI/tool doubles)', posixOnly, async t => {
  for (const scenario of ['complete', 'budget-after-first-write', 'wrong-second-write']) await t.test(scenario, async () => {
  const record = simpleJavaDecisions();
  const actions = record.events.at(-1).actions.filter(action => action.action === 'CREATE');
  let modelCalls = 0;
  let pending;
  let next = 0;
  let setupSessionId;
  const { result, calls } = await captureNativeSetup(async request => {
    modelCalls++;
    const settings = JSON.parse(await readFile(request.args[request.args.indexOf('--settings') + 1], 'utf8'));
    if (modelCalls === 1) {
      setupSessionId = request.sessionId;
      nativeHook(settings, request, { hook_event_name: 'SessionStart', source: 'startup' });
      nativeHook(settings, request, { hook_event_name: 'UserPromptExpansion', expansion_type: 'slash_command',
        command_name: 'agent-init', command_args: '', command_source: 'userSettings', prompt: 'opaque body' });
      nativeHook(settings, request, { hook_event_name: 'Stop', stop_hook_active: false });
      return { status: 0, stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false,
        session_id: request.sessionId, permission_denials: [], result: JSON.stringify({ decisionRecordJson: JSON.stringify(record) }) }) };
    }
    if (modelCalls === 5) {
      assert.equal(request.args[request.args.indexOf('--tools') + 1], '');
      assert.equal(request.args.includes('--restricted'), true);
      return { status: 0, stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false,
        session_id: request.sessionId, permission_denials: [], result: JSON.stringify({ type: 'reconcile', mode: 'dry-run', proposalActions: [], writes: [] }) }) };
    }
    assert.equal(request.args[request.args.indexOf('--tools') + 1], 'Write,Edit');
    assert.equal(request.args[request.args.indexOf('--permission-mode') + 1], 'dontAsk');
    assert.equal(request.args.includes('--restricted'), true);
    assert.equal(request.args[request.args.indexOf('--resume') + 1], setupSessionId);
    if (pending) {
      const pre = nativeHook(settings, request, { hook_event_name: 'PreToolUse', tool_use_id: pending.id,
        tool_name: pending.name, tool_input: pending.input });
      assert.equal(pre.hookSpecificOutput.permissionDecision, 'allow');
      const wrongBytes = scenario === 'wrong-second-write' && next === 1;
      await writeFile(pending.input.file_path, wrongBytes ? 'Wrong second native bytes\n' : pending.input.content, { mode: 0o644, flag: 'wx' });
      const post = nativeHook(settings, request, { hook_event_name: 'PostToolUse', tool_use_id: pending.id,
        tool_name: pending.name, tool_input: pending.input, tool_response: { success: true } });
      if (wrongBytes) assert.equal(post.stopReason, 'NATIVE_PAYLOAD_MISMATCH');
      else assert.deepEqual(post, {});
      pending = null;
      next++;
    }
    if (next < actions.length) {
      pending = { id: `native_write_${next}`, name: 'Write', input: { file_path: path.join(request.cwd, actions[next].target),
        content: actions[next].proposedContent } };
      const pre = nativeHook(settings, request, { hook_event_name: 'PreToolUse', tool_use_id: pending.id,
        tool_name: pending.name, tool_input: pending.input });
      assert.equal(pre.hookSpecificOutput.permissionDecision, 'defer');
      return { status: 0, stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false,
        session_id: request.sessionId, permission_denials: [], stop_reason: 'tool_deferred', deferred_tool_use: pending }) };
    }
    return { status: 0, stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false,
      session_id: request.sessionId, permission_denials: [] }) };
  }, { options: { fixtureId: '01-java-maven-simple', requestProposalApproval: true,
    maxModelProcesses: scenario === 'budget-after-first-write' ? 3 : 5, totalModelBudgetUsd: scenario === 'budget-after-first-write' ? 9 : 15 },
    boundaries: { requestApproval: async request => JSON.stringify({ type: 'approval', decision: 'approve', scope: 'exact-proposal',
      proposalId: request.audit.proposal.id, revision: request.audit.proposal.revision, proposalDigest: request.proposalDigest,
      approvedActionIds: request.requestedWriteActionIds }) } });
  try {
    if (scenario !== 'complete') {
      assert.equal(result.code, scenario === 'budget-after-first-write' ? 'MODEL_PROCESS_BUDGET_EXHAUSTED' : 'NATIVE_PAYLOAD_MISMATCH');
      assert.equal(modelCalls, scenario === 'budget-after-first-write' ? 3 : 4);
      assert.equal(result.setup.applyFailure.completed.length, 1);
      assert.equal(result.setup.applyFailure.failedActionIndex, 1);
      assert.deepEqual(result.setup.applyFailure.pendingActionIndexes, [1]);
      assert.equal(result.setup.applyFailure.rollbackPerformed, false);
      assert.equal(result.setup.run.events.filter(event => event.type === 'write').length, 1);
      assert.equal(await readFile(path.join(calls[0].cwd, 'AGENTS.md'), 'utf8'), '# Project\n\nUse Java 17.\n');
      if (scenario === 'budget-after-first-write') await assert.rejects(readFile(path.join(calls[0].cwd, 'CLAUDE.md')), { code: 'ENOENT' });
      else assert.equal(await readFile(path.join(calls[0].cwd, 'CLAUDE.md'), 'utf8'), 'Wrong second native bytes\n');
      assert.deepEqual(result.artifacts, []);
      return;
    }
    assert.equal(result.code, 'NATIVE_SETUP_VALIDATED', result.setup?.proposalValidation?.errors.join('\n') ?? result.code);
    assert.equal(modelCalls, 5);
    assert.equal(result.setup.proposalValidation.ok, true);
    assert.equal(result.setup.reconcileZeroChurn, true);
    assert.equal(result.setup.sessionClosed, true);
    assert.equal(result.setup.validation.claims.liveSkillBehaviorProven, false);
    assert.equal(result.setup.validation.ok, true, result.setup.validation.errors.join('\n'));
    assert.equal(result.setup.apply.status, 'completed');
    assert.equal(result.setup.apply.permissionFloorProven, false);
    assert.equal(result.setup.approval.humanApprovalProven, false);
    assert.equal(result.setup.apply.completed.length, 2);
    assert.equal(result.runtimeLimits.modelProcessAttempts, 5);
    assert.equal(result.runtimeLimits.maxModelProcessAttempts, 5);
    assert.equal(result.runtimeLimits.configuredTotalBudgetUsd, 15);
    assert.equal(await readFile(path.join(calls[0].cwd, 'AGENTS.md'), 'utf8'), '# Project\n\nUse Java 17.\n');
    assert.equal(await readFile(path.join(calls[0].cwd, 'CLAUDE.md'), 'utf8'), '@AGENTS.md\n');
    assert.equal(result.executionKind, 'test-double');
    assert.deepEqual(result.artifacts, []);
  } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
  });
});

test('native UPDATE transport exposes only the exact approved preread before same-call Edit (CLI/tool doubles)', posixOnly, async () => {
  const before = '# Existing Repository Rules\n\nKeep this user-authored deployment safety rule.\n';
  const after = `${before}\nPreserve the deployment safety rule.\n`;
  const evidenceIds = ['observed-user-safety'];
  let modelCalls = 0;
  let edit;
  const { result, calls } = await captureNativeSetup(async request => {
    modelCalls++;
    const settings = JSON.parse(await readFile(request.args[request.args.indexOf('--settings') + 1], 'utf8'));
    const target = path.join(request.cwd, 'AGENTS.md');
    if (modelCalls === 1) {
      assert.equal(await readFile(target, 'utf8'), before);
      nativeHook(settings, request, { hook_event_name: 'SessionStart', source: 'startup' });
      nativeHook(settings, request, { hook_event_name: 'UserPromptExpansion', expansion_type: 'slash_command',
        command_name: 'agent-init', command_args: '', command_source: 'userSettings', prompt: 'opaque body' });
      nativeHook(settings, request, { hook_event_name: 'Stop', stop_hook_active: false });
      const record = { evidenceLedger: [{ id: evidenceIds[0], fact: 'Preserve existing deployment safety.', sourcePath: 'AGENTS.md',
        sourceLocation: 'safety paragraph', sourceExcerpt: 'Keep this user-authored deployment safety rule.',
        observation: 'Existing deployment safety rule.', whyItMatters: 'Do not replace existing user intent.',
        persistenceScope: 'GLOBAL', deterministicEnforcementCandidate: false }], events: [
        { type: 'profile', facts: [{ id: 'observed-safety', value: 'deployment safety rule', status: 'confirmed', evidenceIds }], unknowns: [] },
        { type: 'classify', decisions: [{ factId: 'observed-safety', persistenceScope: 'GLOBAL', deterministicEnforcementCandidate: false }] },
        { type: 'skills', candidates: [] },
        { type: 'proposal', id: 'native-update-source-backed', revision: 1, projectSummary: 'Preserve existing safety rules.',
          unknowns: [], warnings: [], nonGoals: ['No remote actions.'], validationPlan: ['Inspect unchanged safety paragraph and added reminder.'],
          actions: [{ id: 'preserve-safety', action: 'UPDATE', target: 'AGENTS.md', kind: 'agents', reason: 'Preserve existing intent.', evidenceIds,
            baselineFingerprint: await fingerprintPath(request.cwd, 'AGENTS.md'),
            proposedDiff: '--- a/AGENTS.md\n+++ b/AGENTS.md\n@@ -1,3 +1,5 @@\n-# Existing Repository Rules\n-\n-Keep this user-authored deployment safety rule.\n+# Existing Repository Rules\n+\n+Keep this user-authored deployment safety rule.\n+\n+Preserve the deployment safety rule.\n' }] },
      ] };
      return { status: 0, stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false,
        session_id: request.sessionId, permission_denials: [], result: JSON.stringify({ decisionRecordJson: JSON.stringify(record) }) }) };
    }
    if (modelCalls === 4) {
      assert.equal(request.args[request.args.indexOf('--tools') + 1], '');
      return { status: 0, stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false,
        session_id: request.sessionId, permission_denials: [], result: JSON.stringify({ type: 'reconcile', mode: 'dry-run', proposalActions: [], writes: [] }) }) };
    }
    assert.equal(request.args[request.args.indexOf('--tools') + 1], 'Read,Write,Edit');
    assert.match(request.args.at(-1), /Read.*UPDATE/);
    if (modelCalls === 2) {
      const read = { id: 'native_update_read', name: 'Read', input: { file_path: target } };
      assert.equal(nativeHook(settings, request, { hook_event_name: 'PreToolUse', tool_use_id: read.id,
        tool_name: read.name, tool_input: read.input }).hookSpecificOutput.permissionDecision, 'allow');
      const readBytes = await readFile(target, 'utf8');
      assert.deepEqual(nativeHook(settings, request, { hook_event_name: 'PostToolUse', tool_use_id: read.id,
        tool_name: read.name, tool_input: read.input, tool_response: { type: 'text', file: {
          filePath: target, content: readBytes, startLine: 1, numLines: 4, totalLines: 4 } } }), {});
      edit = { id: 'native_update_edit', name: 'Edit', input: { file_path: target,
        old_string: 'Keep this user-authored deployment safety rule.\n',
        new_string: 'Keep this user-authored deployment safety rule.\n\nPreserve the deployment safety rule.\n', replace_all: false } };
      assert.equal(nativeHook(settings, request, { hook_event_name: 'PreToolUse', tool_use_id: edit.id,
        tool_name: edit.name, tool_input: edit.input }).hookSpecificOutput.permissionDecision, 'defer');
      return { status: 0, stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false,
        session_id: request.sessionId, permission_denials: [], stop_reason: 'tool_deferred', deferred_tool_use: edit }) };
    }
    assert.equal(nativeHook(settings, request, { hook_event_name: 'PreToolUse', tool_use_id: edit.id,
      tool_name: edit.name, tool_input: edit.input }).hookSpecificOutput.permissionDecision, 'allow');
    await writeFile(target, after);
    assert.deepEqual(nativeHook(settings, request, { hook_event_name: 'PostToolUse', tool_use_id: edit.id,
      tool_name: edit.name, tool_input: edit.input, tool_response: { success: true } }), {});
    return { status: 0, stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false,
      session_id: request.sessionId, permission_denials: [] }) };
  }, { options: { fixtureId: '05-existing-agents', requestProposalApproval: true, maxModelProcesses: 4, totalModelBudgetUsd: 12 },
    boundaries: { requestApproval: async request => JSON.stringify({ type: 'approval', decision: 'approve', scope: 'exact-proposal',
      proposalId: request.audit.proposal.id, revision: request.audit.proposal.revision, proposalDigest: request.proposalDigest,
      approvedActionIds: request.requestedWriteActionIds }) } });
  try {
    assert.equal(result.code, 'NATIVE_SETUP_VALIDATED', result.setup?.proposalValidation?.errors.join('\n') ?? result.code);
    assert.equal(result.setup.validation.ok, true);
    assert.equal(result.setup.apply.completed.length, 1);
    assert.equal(result.setup.apply.permissionFloorProven, false);
    assert.equal(result.setup.reconcileZeroChurn, true);
    assert.equal(modelCalls, 4);
    assert.equal(await readFile(path.join(calls[0].cwd, 'AGENTS.md'), 'utf8'), after);
  } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
});

test('exact file approval cannot spend beyond the separately configured one-process quota (CLI double)', posixOnly, async () => {
  const { result, calls } = await captureNativeSetup(async request => {
    const settings = JSON.parse(await readFile(request.args[request.args.indexOf('--settings') + 1], 'utf8'));
    nativeHook(settings, request, { hook_event_name: 'SessionStart', source: 'startup' });
    nativeHook(settings, request, { hook_event_name: 'UserPromptExpansion', expansion_type: 'slash_command',
      command_name: 'agent-init', command_args: '', command_source: 'userSettings', prompt: 'opaque body' });
    nativeHook(settings, request, { hook_event_name: 'Stop', stop_hook_active: false });
    return { status: 0, stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false,
      session_id: request.sessionId, permission_denials: [], result: JSON.stringify({ decisionRecordJson: JSON.stringify(simpleJavaDecisions()) }) }) };
  }, { options: { fixtureId: '01-java-maven-simple', requestProposalApproval: true }, boundaries: { requestApproval: async request => JSON.stringify({
    type: 'approval', decision: 'approve', scope: 'exact-proposal', proposalId: request.audit.proposal.id,
    revision: request.audit.proposal.revision, proposalDigest: request.proposalDigest, approvedActionIds: request.requestedWriteActionIds,
  }) } });
  try {
    assert.equal(result.code, 'MODEL_PROCESS_BUDGET_EXHAUSTED');
    assert.equal(calls.length, 1);
    assert.equal(result.runtimeLimits.modelProcessAttempts, 1);
    assert.equal(result.runtimeLimits.configuredTotalBudgetUsd, 3);
    assert.equal(result.setup.approval.status, 'exact');
    assert.equal(result.setup.apply, undefined);
    await assert.rejects(readFile(path.join(calls[0].cwd, 'AGENTS.md')), { code: 'ENOENT' });
  } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
});

test('a structurally complete but source-unanchored Proposal is rejected before approval and native writes (CLI double)', posixOnly, async () => {
  let approvalCalls = 0;
  const { result, calls } = await captureNativeSetup(async request => {
    const settings = JSON.parse(await readFile(request.args[request.args.indexOf('--settings') + 1], 'utf8'));
    nativeHook(settings, request, { hook_event_name: 'SessionStart', source: 'startup' });
    nativeHook(settings, request, { hook_event_name: 'UserPromptExpansion', expansion_type: 'slash_command',
      command_name: 'agent-init', command_args: '', command_source: 'userSettings', prompt: 'opaque body' });
    nativeHook(settings, request, { hook_event_name: 'Stop', stop_hook_active: false });
    return { status: 0, stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false,
      session_id: request.sessionId, permission_denials: [], result: JSON.stringify({ decisionRecordJson: JSON.stringify(decisions()) }) }) };
  }, { options: { requestProposalApproval: true }, boundaries: { requestApproval: async () => { approvalCalls++; return ''; } } });
  try {
    assert.equal(result.code, 'PROPOSAL_INVALID');
    assert.equal(result.setup.proposalValidation.ok, false);
    assert.equal(approvalCalls, 0);
    assert.equal(calls.length, 1);
    assert.equal(result.setup.apply, undefined);
    await assert.rejects(readFile(path.join(calls[0].cwd, 'AGENTS.md')), { code: 'ENOENT' });
  } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
});

test('new instruction payloads cannot invent versions or executable commands beyond their cited source (CLI double)', posixOnly, async t => {
  for (const content of ['# Project\n\nUse Java 99.\n', '# Project\n\nRun npm publish --access public for verification.\n']) await t.test(content.includes('99') ? 'invented-runtime' : 'invented-command', async () => {
    const record = simpleJavaDecisions();
    record.events[3].actions[0].proposedContent = content;
    let approvalCalls = 0;
    const { result, calls } = await captureNativeSetup(async request => {
      const settings = JSON.parse(await readFile(request.args[request.args.indexOf('--settings') + 1], 'utf8'));
      nativeHook(settings, request, { hook_event_name: 'SessionStart', source: 'startup' });
      nativeHook(settings, request, { hook_event_name: 'UserPromptExpansion', expansion_type: 'slash_command',
        command_name: 'agent-init', command_args: '', command_source: 'userSettings', prompt: 'opaque body' });
      nativeHook(settings, request, { hook_event_name: 'Stop', stop_hook_active: false });
      return { status: 0, stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false,
        session_id: request.sessionId, permission_denials: [], result: JSON.stringify({ decisionRecordJson: JSON.stringify(record) }) }) };
    }, { options: { fixtureId: '01-java-maven-simple', requestProposalApproval: true }, boundaries: { requestApproval: async () => { approvalCalls++; return ''; } } });
    try {
      assert.equal(result.code, 'PROPOSAL_INVALID');
      assert.ok(result.setup.proposalValidation.errors.some(error => error.startsWith('NATIVE_CONTENT_LITERAL')));
      assert.equal(approvalCalls, 0);
      assert.equal(calls.length, 1);
      assert.deepEqual(result.setup.proposal, record.events[3]);
      await assert.rejects(readFile(path.join(calls[0].cwd, 'AGENTS.md')), { code: 'ENOENT' });
    } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
  });
});

test('native setup never forwards configured secrets found in owned repository input (CLI double)', posixOnly, async () => {
  const secret = '<maven.compiler.release>17</maven.compiler.release>';
  let inspected = false;
  const { result } = await captureNativeSetup(async request => {
    const input = JSON.parse(request.args.at(-1).split('Repository evidence input: ')[1]);
    const pom = input.files.find(file => file.path === 'pom.xml');
    assert.equal(pom.content, undefined);
    assert.equal(pom.presenceOnly, true);
    assert.equal(request.args.at(-1).includes(secret), false);
    inspected = true;
    return { status: 1, stdout: '' };
  }, { options: { fixtureId: '01-java-maven-simple', env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: secret } } });
  try {
    assert.equal(inspected, true);
    assert.equal(result.code, 'NATIVE_PROCESS_FAILED');
    const report = await readFile(path.join(result.disposableRoot, 'evidence/claude-live/report.json'), 'utf8');
    assert.equal(report.includes(secret), false);
  } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
});

test('native setup captures a complete tool-free Proposal from supplied actual repository evidence, but does not self-approve (CLI double)', posixOnly, async () => {
  const decisionRecord = simpleJavaDecisions();
  const { result, calls } = await captureNativeSetup(async (request) => {
    const arg = flag => request.args[request.args.indexOf(flag) + 1];
    assert.equal(arg('--tools'), '');
    assert.equal(arg('--setting-sources'), 'user');
    assert.equal(arg('--output-format'), 'json');
    assert.equal(request.args.includes('--restricted'), false);
    assert.equal(request.args.includes('--bare'), false);
    assert.equal(request.args.includes('--json-schema'), false);
    const pom = await readFile(path.join(request.cwd, 'pom.xml'), 'utf8');
    const repositoryInput = JSON.parse(request.args.at(-1).split('Repository evidence input: ')[1]);
    assert.equal(repositoryInput.files.find(file => file.path === 'pom.xml').content, pom);
    assert.equal(repositoryInput.source, 'owned-repository-snapshot');
    assert.match(request.args.at(-1), /sourceExcerpt/);
    assert.match(request.args.at(-1), /positiveIntents/);
    const settings = JSON.parse(await readFile(arg('--settings'), 'utf8'));
    nativeHook(settings, request, { hook_event_name: 'SessionStart', source: 'startup' });
    nativeHook(settings, request, { hook_event_name: 'UserPromptExpansion', expansion_type: 'slash_command',
      command_name: 'agent-init', command_args: '', command_source: 'userSettings', prompt: 'opaque Skill body' });
    nativeHook(settings, request, { hook_event_name: 'Stop', stop_hook_active: false });
    return { status: 0, stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false,
      session_id: request.sessionId, permission_denials: [], result: JSON.stringify({ decisionRecordJson: JSON.stringify(decisionRecord) }) }) };
  }, { options: { fixtureId: '01-java-maven-simple' } });
  try {
    assert.equal(calls.length, 1);
    assert.equal(result.code, 'APPROVAL_REQUIRED');
    assert.equal(result.setup.captureStatus, 'captured');
    assert.deepEqual(result.setup.proposal, decisionRecord.events.at(-1));
    assert.equal(result.setup.provenance.source, 'cli-json-result-decision-data');
    assert.equal(result.setup.inputEvidence.source, 'owned-repository-snapshot');
    assert.equal(result.setup.nativeObservation.exactSourceMaterializationMatched, true);
    assert.equal(result.setup.nativeObservation.sourceMaterializations.length, 1);
    assert.equal(result.setup.nativeObservation.sourceMaterializations[0].namespace, 'user');
    assert.equal(result.setup.nativeObservation.sourceMaterializations[0].sourceTreeDigest, result.package.motherSkillDigest);
    assert.equal(result.setup.nativeObservation.sourceVerified, false);
    assert.equal(result.setup.nativeObservation.hookCoverageProven, false);
    assert.equal(result.setup.nativeObservation.permissionFloorProven, false);
    assert.equal(result.setup.nativeObservation.loaded, undefined);
    assert.equal(result.setup.zeroProposalWrites, true);
    assert.equal(result.setup.approval, undefined);
    assert.equal(result.setup.sessionClosed, false);
    assert.equal(result.executionKind, 'test-double');
    await assert.rejects(readFile(path.join(calls[0].cwd, 'AGENTS.md')), { code: 'ENOENT' });
    assert.deepEqual(result.artifacts, []);
  } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
});

test('native Proposal input exposes existing reference parents and exact relative links without physical inventory (CLI double)', posixOnly, async () => {
  let inspected = false;
  const { result } = await captureNativeSetup(async request => {
    const input = JSON.parse(request.args.at(-1).split('Repository evidence input: ')[1]);
    assert.deepEqual(input.agentAssets.map(asset => [asset.path, asset.type]), [
      ['.claude', 'directory'], ['.claude/skills', 'directory'], ['.claude/skills/release', 'symlink'],
    ]);
    const reference = input.agentAssets[2];
    assert.equal(reference.linkText, '../../.agents/skills/release');
    assert.equal(reference.fingerprint, await fingerprintPath(request.cwd, '.claude/skills/release'));
    assert.equal(input.inventory, undefined);
    assert.equal(input.agentAssets.some(asset => Object.hasOwn(asset, 'identity') || Object.hasOwn(asset, 'mtimeMs')), false);
    inspected = true;
    return { status: 1, stdout: '' };
  }, { options: { fixtureId: '08-existing-skills' } });
  try {
    assert.equal(inspected, true);
    assert.equal(result.code, 'NATIVE_PROCESS_FAILED');
    assert.deepEqual(result.artifacts, []);
  } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
});

async function corpusDecision(request, input) {
  const id = path.basename(path.dirname(request.cwd));
  const definitions = {
    '03-node-pnpm': ['build-verify', 'package.json', 'pnpm lint && pnpm test'],
    '11-maven-multi-module-build-verify': ['build-verify', '.github/workflows/verify.yml', 'mvn -pl services/api -am verify'],
    '12-flyway-database-migration': ['database-migration', 'docs/database-migrations.md', 'mvn -Pdatabase-migration flyway:migrate && mvn -Pdatabase-migration flyway:validate'],
    '13-audit-log': ['audit-log', 'docs/audit-log.md', 'mvn -Dtest=AuditLogContractTest test'],
    '15-deployment': ['deployment', 'docs/deployment.md', 'npm run build && npm run deploy:staging && npm run smoke:staging'],
  };
  const definition = definitions[id];
  const sourcePath = definition?.[1] ?? 'pom.xml';
  const source = input.files.find(file => file.path === sourcePath);
  assert.equal(source.content, await readFile(path.join(request.cwd, sourcePath), 'utf8'));
  const value = definition?.[2] ?? 'cache-service';
  const sourceExcerpt = definition?.[2] ?? '<artifactId>cache-service</artifactId>';
  assert.ok(source.content.includes(sourceExcerpt));
  const evidenceIds = [`source-${id}`];
  const scope = definition ? 'WORKFLOW' : 'GLOBAL';
  const evidenceLedger = [{ id: evidenceIds[0], fact: 'Preserve the observed repository source.', sourcePath,
    sourceLocation: 'literal repository source', sourceExcerpt, observation: 'The supplied owned source contains this literal.',
    whyItMatters: 'Preserve existing repository behavior without executing it.', persistenceScope: scope, deterministicEnforcementCandidate: false }];
  const profile = { type: 'profile', facts: [{ id: `fact-${id}`, status: 'confirmed', value, evidenceIds }], unknowns: ['External systems are unknown.'] };
  const classify = { type: 'classify', decisions: [{ factId: `fact-${id}`, persistenceScope: scope, deterministicEnforcementCandidate: false }] };
  const candidates = [];
  let actions;
  if (definition) {
    const name = definition[0];
    const candidate = { name, decision: 'CREATE', evidenceIds, taskTriggers: [`Preparing ${name} work`], whenNotToUse: ['Unrelated work'],
      workflowSteps: [`Inspect ${sourcePath} and preserve its documented sequence.`], verification: [value],
      routing: { description: `Prepare the documented ${name} workflow.`, positiveIntents: [`Prepare ${name}`], negativeIntents: ['Unrelated work'] },
      skillAssessment: { taskSpecificity: 'high', rediscoveryCost: 'medium', errorCost: 'high', reuseFrequency: 'high' },
      targetedFollowUpSearch: { queries: [`documented ${name} sequence`], paths: [sourcePath], result: 'Found the literal verification sequence.', evidenceIds } };
    candidates.push(candidate);
    const content = `---\nname: ${name}\ndescription: Prepare the documented ${name} workflow.\n---\n\n`
      + `## When to use\nPreparing ${name} work\n\n## When not to use\nUnrelated work\n\n`
      + `## Workflow\nInspect ${sourcePath} and preserve its documented sequence.\n\n`
      + `## Project-specific rules\nUse the repository source; do not invent external authority.\n\n## Verification\n\`${value}\`\n`;
    actions = [
      { id: `canonical-${id}`, action: 'CREATE', kind: 'project-skill', target: `.agents/skills/${name}/SKILL.md`,
        reason: 'Preserve the observed workflow.', evidenceIds, baselineFingerprint: 'missing', proposedContent: content, skillCandidate: candidate },
      { id: `reference-${id}`, action: 'CREATE', kind: 'claude-skill-reference', target: `.claude/skills/${name}`,
        reason: 'Share the canonical bytes.', evidenceIds, baselineFingerprint: 'missing', canonicalTarget: `.agents/skills/${name}`,
        linkTarget: `../../.agents/skills/${name}`, linkText: `../../.agents/skills/${name}`, proposedContent: `../../.agents/skills/${name}`,
        parentDirectories: ['.claude', '.claude/skills'] },
    ];
  } else {
    assert.equal(id, '14-redis-no-skill');
    const cachePath = 'src/main/resources/application.yml';
    const cacheSource = input.files.find(file => file.path === cachePath);
    assert.ok(cacheSource.content.includes('redis:'));
    evidenceLedger.push({ id: 'cache-configuration', fact: 'Redis configuration is present.', sourcePath: cachePath,
      sourceLocation: 'spring.data.redis', sourceExcerpt: 'redis:', observation: 'A cache configuration exists.',
      whyItMatters: 'A technology indicator alone is not a task workflow.', persistenceScope: 'DISCOVERABLE', deterministicEnforcementCandidate: false });
    profile.facts.push({ id: 'cache-technology', status: 'confirmed', value: 'redis', evidenceIds: ['cache-configuration'] });
    classify.decisions.push({ factId: 'cache-technology', persistenceScope: 'DISCOVERABLE', deterministicEnforcementCandidate: false });
    candidates.push({ name: 'cache-workflow', decision: 'SKIP', evidenceIds: ['cache-configuration'],
      skillAssessment: { taskSpecificity: 'low', rediscoveryCost: 'low', errorCost: 'unknown', reuseFrequency: 'low' },
      targetedFollowUpSearch: { queries: ['documented cache workflow'], paths: [cachePath], result: 'Configuration does not document a task sequence.', evidenceIds: ['cache-configuration'] },
      skipBasis: { dimensions: ['taskSpecificity', 'rediscoveryCost', 'errorCost', 'reuseFrequency'],
        explanation: 'The source "redis:" identifies configuration, not a documented task sequence or verification command.' } });
    actions = [{ id: `instructions-${id}`, action: 'CREATE', kind: 'agents', target: 'AGENTS.md',
      reason: 'Preserve the project identity.', evidenceIds, baselineFingerprint: 'missing', proposedContent: '# Repository\n\nPreserve the cache-service project identity.\n' }];
  }
  return { evidenceLedger, events: [profile, classify, { type: 'skills', candidates },
    { type: 'proposal', id: `source-corpus-${id}`, revision: 1, projectSummary: 'Preserve the supplied repository source.',
      unknowns: ['External systems are unknown.'], warnings: [], nonGoals: ['Do not execute business, build, migration or deployment commands.'],
      validationPlan: ['Verify exact approved bytes and readonly reconcile.'], actions }] };
}

async function captureNativeCorpus(options = {}, boundaries = {}) {
  const setups = new Map();
  const approved = [];
  const closed = [];
  let routingCalls = 0;
  let allCalls = 0;
  const { result, calls, boundaryError } = await captureNativeSetup(async request => {
    allCalls++;
    await boundaries.beforeInvoke?.(request);
    const tools = request.args[request.args.indexOf('--tools') + 1];
    const settings = JSON.parse(await readFile(request.args[request.args.indexOf('--settings') + 1], 'utf8'));
    const envelope = fields => ({ status: 0, stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false,
      session_id: request.sessionId, permission_denials: [], ...fields }) });
    if (tools === 'Skill') {
      routingCalls++;
      assert.equal(closed.length, 6);
      assert.equal(approved.length, 6);
      assert.equal(request.args.includes('--resume'), false);
      assert.equal(setups.has(request.sessionId), false);
      nativeHook(settings, request, { hook_event_name: 'SessionStart' });
      const { readdir } = await import('node:fs/promises');
      const name = (await readdir(path.join(request.cwd, '.agents/skills')))[0];
      const skill = await readFile(path.join(request.cwd, '.agents/skills', name, 'SKILL.md'), 'utf8');
      const skillLines = skill.split('\n');
      assert.equal(skillLines[0], '---');
      assert.equal(skillLines[3], '---');
      assert.equal(skillLines[4], '');
      const alias = path.join(request.cwd, '.claude/skills', name);
      const call = { id: 'routing_skill_call', name: 'Skill', input: { skill: name } };
      nativeHook(settings, request, { hook_event_name: 'PreToolUse', tool_use_id: call.id, tool_name: call.name, tool_input: call.input });
      nativeHook(settings, request, { hook_event_name: 'PostToolUse', tool_use_id: call.id, tool_name: call.name,
        tool_input: call.input, tool_response: { success: true, commandName: name, status: 'inline' } });
      const caller = randomUUID();
      const frame = randomUUID();
      const common = { sessionId: request.sessionId, cwd: request.cwd, version: '2.1.285' };
      const message = { role: 'user', content: [{ type: 'text', text: `Base directory for this skill: ${alias}\n\n${skillLines.slice(5).join('\n')}` }] };
      await writeFile(path.join(request.env.HOME, '.claude/projects/setup-model-double', `${request.sessionId}.jsonl`), [
        { ...common, type: 'assistant', uuid: caller, parentUuid: null, message: { role: 'assistant', content: [{ type: 'tool_use', ...call }] } },
        { ...common, type: 'user', uuid: frame, parentUuid: caller, isMeta: true, turnCompanion: true, sourceToolUseID: call.id, message },
      ].map(JSON.stringify).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
      nativeHook(settings, request, { hook_event_name: 'Stop' });
      return { status: 0, stdout: [
        { type: 'system', subtype: 'init', session_id: request.sessionId, tools: ['Skill'] },
        { type: 'assistant', session_id: request.sessionId, message: { content: [{ type: 'tool_use', ...call }] } },
        { type: 'user', session_id: request.sessionId, message: { content: [{ type: 'tool_result', tool_use_id: call.id, content: `Launching skill: ${name}`, is_error: false }] } },
        { type: 'user', session_id: request.sessionId, uuid: frame, isSynthetic: true, message },
        { type: 'result', subtype: 'success', is_error: false, session_id: request.sessionId, permission_denials: [] },
      ].map(JSON.stringify).join('\n') + '\n' };
    }
    let setup = setups.get(request.sessionId);
    if (!setup) {
      assert.equal(request.args.includes('--resume'), false);
      const input = JSON.parse(request.args.at(-1).split('Repository evidence input: ')[1]);
      assert.equal(input.files.some(file => file.path.includes('fixture.json')), false);
      const record = await corpusDecision(request, input);
      await boundaries.proposal?.(request, record);
      const actions = record.events.at(-1).actions;
      const steps = actions.flatMap(action => action.kind === 'claude-skill-reference' ? [
        ...action.parentDirectories.map(parent => ({ name: 'Bash', input: { command: `/bin/mkdir -m 0755 -- '${parent}'` }, executable: '/bin/mkdir', args: ['-m', '0755', '--', parent] })),
        { name: 'Bash', input: { command: `/bin/ln -s -- '${action.linkTarget}' '${action.target}'` }, executable: '/bin/ln', args: ['-s', '--', action.linkTarget, action.target] },
      ] : [{ name: 'Write', input: { file_path: path.join(request.cwd, action.target), content: action.proposedContent } }]);
      setup = { record, cwd: request.cwd, next: 0, pending: null, steps };
      setups.set(request.sessionId, setup);
      nativeHook(settings, request, { hook_event_name: 'SessionStart' });
      nativeHook(settings, request, { hook_event_name: 'UserPromptExpansion', expansion_type: 'slash_command',
        command_name: 'agent-init', command_args: '', command_source: 'userSettings', prompt: 'opaque body' });
      nativeHook(settings, request, { hook_event_name: 'Stop' });
      return envelope({ result: JSON.stringify({ decisionRecordJson: JSON.stringify(record) }) });
    }
    assert.equal(request.args[request.args.indexOf('--resume') + 1], request.sessionId);
    if (tools === '') {
      assert.equal(setup.next, setup.steps.length);
      if (boundaries.reconcile) return envelope({ result: JSON.stringify(await boundaries.reconcile(request)) });
      closed.push(request.sessionId);
      return envelope({ result: JSON.stringify({ type: 'reconcile', mode: 'dry-run', proposalActions: [], writes: [] }) });
    }
    if (setup.pending) {
      const call = setup.pending;
      assert.equal(nativeHook(settings, request, { hook_event_name: 'PreToolUse', tool_use_id: call.id,
        tool_name: call.name, tool_input: call.input }).hookSpecificOutput.permissionDecision, 'allow');
      if (call.name === 'Write') {
        const { mkdir } = await import('node:fs/promises');
        await mkdir(path.dirname(call.input.file_path), { recursive: true, mode: 0o755 });
        await writeFile(call.input.file_path, call.input.content, { flag: 'wx', mode: 0o644 });
      } else {
        const step = setup.steps[setup.next];
        const tool = spawnSync(step.executable, step.args, { cwd: request.cwd, env: {}, encoding: 'utf8', timeout: 2000 });
        assert.equal(tool.status, 0, tool.stderr);
      }
      assert.deepEqual(nativeHook(settings, request, { hook_event_name: 'PostToolUse', tool_use_id: call.id,
        tool_name: call.name, tool_input: call.input, tool_response: call.name === 'Bash'
          ? { stdout: '', stderr: '', interrupted: false, isImage: false, noOutputExpected: false }
          : { success: true } }), {});
      setup.next++;
      setup.pending = null;
    }
    if (setup.next < setup.steps.length) {
      const step = setup.steps[setup.next];
      setup.pending = { id: `setup_${setup.next}`, name: step.name, input: step.input };
      assert.equal(nativeHook(settings, request, { hook_event_name: 'PreToolUse', tool_use_id: setup.pending.id,
        tool_name: step.name, tool_input: step.input }).hookSpecificOutput.permissionDecision, 'defer');
      return envelope({ stop_reason: 'tool_deferred', deferred_tool_use: setup.pending });
    }
    return envelope({});
  }, { options: { scope: 'native-corpus', authorizeNativeSetup: undefined, authorizeNativeCorpus: true,
    requestProposalApproval: true, maxModelProcesses: 40, totalModelBudgetUsd: 120, ...options },
    boundaries: { requestApproval: boundaries.requestApproval ?? (async request => {
      approved.push(request.audit.proposal.id);
      return JSON.stringify({ type: 'approval', decision: 'approve', scope: 'exact-proposal', proposalId: request.audit.proposal.id,
        revision: request.audit.proposal.revision, proposalDigest: request.proposalDigest, approvedActionIds: request.requestedWriteActionIds });
    }) } });
  return { result, calls, boundaryError, approved, closed, routingCalls, allCalls };
}

test('native corpus closes six independently approved source setups before fresh routing under one installation and quota (CLI/tool doubles)', posixOnly, async () => {
  const { result, calls, boundaryError, approved, closed, routingCalls, allCalls } = await captureNativeCorpus();
  try {
    if (boundaryError) throw boundaryError;
    assert.equal(result.code, 'NATIVE_SELECTION_UNVERIFIED');
    assert.equal(result.setups.length, 6);
    assert.equal(result.setups.every(setup => setup.sessionClosed && setup.validation.ok && setup.apply.status === 'completed'), true);
    assert.equal(new Set(result.setups.map(setup => setup.sessionId)).size, 6);
    assert.equal(new Set(calls.map(call => call.env.HOME)).size, 1);
    assert.equal(approved.length, 6);
    assert.equal(closed.length, 6);
    assert.equal(routingCalls, 1);
    assert.equal(allCalls, 40);
    assert.equal(result.runtimeLimits.modelProcessAttempts, 40);
    assert.equal(result.nativeRouting.routingSessions.length, 1);
    assert.equal(result.nativeRouting.routingSessions[0].sessionClosed, true);
    assert.equal(result.nativeRoutingObservations.length, 1);
    assert.equal(result.nativeRoutingObservations[0].observation.status, 'blocked');
    assert.equal(result.nativeRoutingObservations[0].observation.provenance.exactSourceMaterializationMatched, true);
    assert.equal(result.nativeRoutingObservations[0].observation.loaded, undefined);
    assert.deepEqual(result.artifacts, []);
    assert.equal(result.liveSkillBehaviorProven, false);
    assert.equal(result.qualification, 'unqualified');
  } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
});

test('native corpus binds routing to canonical SKILL.md after separately approved reference assets (CLI/tool doubles)', posixOnly, async () => {
  const { result, calls, boundaryError, approved, closed, routingCalls } = await captureNativeCorpus({ maxModelProcesses: 41, totalModelBudgetUsd: 123 }, {
    proposal: async (request, record) => {
      if (path.basename(path.dirname(request.cwd)) !== '03-node-pnpm') return;
      const canonical = record.events.at(-1).actions[0];
      record.events.at(-1).actions.push({ ...canonical, id: 'documented-build-sequence',
        target: '.agents/skills/build-verify/references/sequence.md', proposedContent: 'Review the repository-defined sequence.\n' });
    },
  });
  try {
    if (boundaryError) throw boundaryError;
    assert.equal(result.code, 'NATIVE_SELECTION_UNVERIFIED');
    assert.equal(result.setups.length, 6);
    assert.equal(result.setups.every(setup => setup.sessionClosed && setup.validation.ok && setup.apply.status === 'completed'), true);
    assert.equal(approved.length, 6);
    assert.equal(closed.length, 6);
    assert.equal(routingCalls, 1);
    assert.equal(calls.length, 41);
    assert.equal(result.runtimeLimits.modelProcessAttempts, 41);
    const setup = result.setups.find(setup => setup.fixtureId === '03-node-pnpm');
    assert.equal(setup.apply.completed.length, 3);
    assert.equal(await readFile(path.join(setup.cwd, '.agents/skills/build-verify/references/sequence.md'), 'utf8'), 'Review the repository-defined sequence.\n');
    assert.equal(result.nativeRoutingObservations[0].observation.provenance.sourceMaterializations[0].sourceRootRef.endsWith('/.agents/skills/build-verify'), true);
    assert.equal(result.nativeRouting.routingSessions[0].sessionClosed, true);
    assert.deepEqual(result.artifacts, []);
    assert.equal(result.liveSkillBehaviorProven, false);
  } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
});

test('native corpus stops at the first rejected Proposal without Apply, later setups or routing (CLI/tool doubles)', posixOnly, async () => {
  let approvalRequests = 0;
  const { result, calls, boundaryError, closed, routingCalls } = await captureNativeCorpus({}, {
    requestApproval: async request => {
      approvalRequests++;
      return JSON.stringify({ type: 'approval', decision: 'reject', scope: 'exact-proposal', proposalId: request.audit.proposal.id,
        revision: request.audit.proposal.revision, proposalDigest: request.proposalDigest, approvedActionIds: [] });
    },
  });
  try {
    if (boundaryError) throw boundaryError;
    assert.equal(result.code, 'PROPOSAL_REJECTED');
    assert.equal(approvalRequests, 1);
    assert.equal(calls.length, 1);
    assert.equal(result.setups.length, 1);
    assert.equal(result.setups[0].approval.status, 'rejected');
    assert.equal(result.setups[0].apply, undefined);
    assert.equal(result.setups[0].sessionClosed, false);
    assert.equal(closed.length, 0);
    assert.equal(routingCalls, 0);
    assert.equal(result.runtimeLimits.modelProcessAttempts, 1);
    await assert.rejects(readFile(path.join(calls[0].cwd, '.agents/skills/build-verify/SKILL.md')), { code: 'ENOENT' });
    await assert.rejects(readFile(path.join(calls[0].cwd, '.claude/skills/build-verify')), { code: 'ENOENT' });
    assert.deepEqual(result.artifacts, []);
    assert.equal(result.liveSkillBehaviorProven, false);
  } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
});

test('native corpus rejects drift in a previously closed setup across later process and approval boundaries (CLI/tool doubles)', posixOnly, async t => {
  for (const stage of ['process', 'approval']) await t.test(stage, async () => {
    let firstCwd;
    let original;
    let approvalRequests = 0;
    const mutateClosedSource = async () => {
      const target = path.join(firstCwd, '.agents/skills/build-verify/SKILL.md');
      original = await readFile(target, 'utf8');
      await writeFile(target, `${original}\nContext drift double.\n`);
    };
    const { result, calls, boundaryError, closed, routingCalls } = await captureNativeCorpus({}, {
      beforeInvoke: async request => {
        firstCwd ??= request.cwd;
        if (stage === 'process' && request.cwd !== firstCwd && !request.args.includes('--resume')) await mutateClosedSource();
      },
      requestApproval: async request => {
        approvalRequests++;
        if (stage === 'approval' && approvalRequests === 2) await mutateClosedSource();
        return JSON.stringify({ type: 'approval', decision: 'approve', scope: 'exact-proposal', proposalId: request.audit.proposal.id,
          revision: request.audit.proposal.revision, proposalDigest: request.proposalDigest, approvedActionIds: request.requestedWriteActionIds });
      },
    });
    try {
      if (boundaryError) throw boundaryError;
      assert.equal(result.code, 'SETUP_CONTEXT_STALE');
      assert.equal(calls.length, 8);
      assert.equal(result.setups.length, stage === 'process' ? 1 : 2);
      assert.equal(result.setups[0].sessionClosed, true);
      assert.equal(result.setups[0].apply.status, 'completed');
      assert.equal(result.setups.at(-1).approval?.status, stage === 'process' ? 'exact' : undefined);
      assert.equal(approvalRequests, stage === 'process' ? 1 : 2);
      assert.equal(closed.length, 1);
      assert.equal(routingCalls, 0);
      assert.equal(result.runtimeLimits.modelProcessAttempts, 8);
      assert.equal(await readFile(path.join(firstCwd, '.agents/skills/build-verify/SKILL.md'), 'utf8'), `${original}\nContext drift double.\n`);
      assert.deepEqual(result.artifacts, []);
      assert.equal(result.liveSkillBehaviorProven, false);
    } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
  });
});

test('native corpus refuses later contributors and routing after nonempty readonly reconcile (CLI/tool doubles)', posixOnly, async () => {
  const { result, calls, boundaryError, closed, routingCalls } = await captureNativeCorpus({}, {
    reconcile: async () => ({ type: 'reconcile', mode: 'dry-run', proposalActions: [{ action: 'UPDATE', target: 'AGENTS.md' }], writes: [] }),
  });
  try {
    if (boundaryError) throw boundaryError;
    assert.equal(result.code, 'RECONCILE_CHANGED');
    assert.equal(calls.length, 7);
    assert.equal(result.setups.length, 1);
    assert.equal(result.setups[0].apply.status, 'completed');
    assert.equal(result.setups[0].apply.completed.length, 2);
    assert.equal(result.setups[0].reconcileZeroChurn, true);
    assert.equal(result.setups[0].sessionClosed, false);
    assert.equal(result.setups[0].status, undefined);
    assert.equal(closed.length, 0);
    assert.equal(routingCalls, 0);
    assert.equal(result.runtimeLimits.modelProcessAttempts, 7);
    assert.deepEqual(result.artifacts, []);
    assert.equal(result.liveSkillBehaviorProven, false);
  } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
});

test('native corpus preserves the completed canonical write when its shared quota stops the next reference (CLI/tool doubles)', posixOnly, async () => {
  const { result, calls, boundaryError, closed, routingCalls } = await captureNativeCorpus({ maxModelProcesses: 3, totalModelBudgetUsd: 9 });
  try {
    if (boundaryError) throw boundaryError;
    assert.equal(result.code, 'MODEL_PROCESS_BUDGET_EXHAUSTED');
    assert.equal(calls.length, 3);
    assert.equal(result.setups.length, 1);
    const setup = result.setups[0];
    assert.equal(setup.applyFailure.completed.length, 1);
    assert.equal(setup.applyFailure.failedActionIndex, 1);
    assert.deepEqual(setup.applyFailure.pendingActionIndexes, [1]);
    assert.equal(setup.applyFailure.rollbackPerformed, false);
    assert.equal(setup.run.events.filter(event => event.type === 'write').length, 1);
    assert.equal(await readFile(path.join(setup.cwd, '.agents/skills/build-verify/SKILL.md'), 'utf8'), setup.proposal.actions[0].proposedContent);
    await assert.rejects(readFile(path.join(setup.cwd, '.claude/skills/build-verify')), { code: 'ENOENT' });
    assert.equal(setup.sessionClosed, false);
    assert.equal(closed.length, 0);
    assert.equal(routingCalls, 0);
    assert.equal(result.runtimeLimits.modelProcessAttempts, 3);
    assert.deepEqual(result.artifacts, []);
    assert.equal(result.liveSkillBehaviorProven, false);
  } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
});

test('native corpus preserves a shared quota failure before routing without inventing a started session (CLI/tool doubles)', posixOnly, async () => {
  const { result, calls, boundaryError, approved, closed, routingCalls, allCalls } = await captureNativeCorpus({
    maxModelProcesses: 39, totalModelBudgetUsd: 117,
  });
  try {
    if (boundaryError) throw boundaryError;
    assert.equal(result.code, 'MODEL_PROCESS_BUDGET_EXHAUSTED');
    assert.equal(result.setups.length, 6);
    assert.equal(result.setups.every(setup => setup.sessionClosed && setup.validation.ok && setup.apply.status === 'completed'), true);
    assert.equal(approved.length, 6);
    assert.equal(closed.length, 6);
    assert.equal(routingCalls, 0);
    assert.equal(allCalls, 39);
    assert.equal(calls.length, 39);
    assert.equal(result.runtimeLimits.modelProcessAttempts, 39);
    assert.equal(result.nativeRouting.routingSessions.length, 1);
    assert.equal(result.nativeRouting.routingSessions[0].processStarted, false);
    assert.equal(result.nativeRouting.routingSessions[0].controlClosed, true);
    assert.equal(result.nativeRouting.routingSessions[0].sessionClosed, false);
    const persisted = JSON.parse(await readFile(result.nativeRouting.reportPath, 'utf8'));
    assert.equal(persisted.code, 'MODEL_PROCESS_BUDGET_EXHAUSTED');
    assert.equal(persisted.routingSessions[0].sessionClosed, false);
    assert.equal(persisted.routingSessions[0].processStarted, false);
    assert.equal(persisted.routingSessions[0].controlClosed, true);
    assert.deepEqual(persisted.routingSessions, result.nativeRouting.routingSessions);
    assert.deepEqual(result.nativeRoutingObservations, []);
    assert.deepEqual(result.artifacts, []);
    assert.equal(result.liveSkillBehaviorProven, false);
    assert.equal(result.qualification, 'unqualified');
  } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
});

test('native corpus cannot reuse a no-start acknowledgement for an admitted routing process failure (CLI/tool doubles)', posixOnly, async () => {
  const externalFailure = Object.assign(new Error('External process double lost its completion'), { code: 'NATIVE_TEST_PROCESS_LOST' });
  const { result, calls, boundaryError, closed } = await captureNativeCorpus({}, {
    beforeInvoke: async request => {
      if (request.args[request.args.indexOf('--tools') + 1] === 'Skill') throw externalFailure;
    },
  });
  try {
    assert.equal(boundaryError, externalFailure);
    assert.equal(result.code, 'SESSION_CLOSE_FAILED');
    assert.equal(result.setups.length, 6);
    assert.equal(closed.length, 6);
    assert.equal(calls.length, 40);
    assert.equal(calls.filter(call => call.args[call.args.indexOf('--tools') + 1] === 'Skill').length, 1);
    assert.equal(result.runtimeLimits.modelProcessAttempts, 40);
    assert.equal(result.nativeRouting.routingSessions.length, 1);
    assert.equal(result.nativeRouting.routingSessions[0].sessionClosed, false);
    assert.notEqual(result.nativeRouting.routingSessions[0].processStarted, false);
    assert.notEqual(result.nativeRouting.routingSessions[0].controlClosed, true);
    assert.deepEqual(result.nativeRoutingObservations, []);
    assert.deepEqual(result.artifacts, []);
    assert.equal(result.liveSkillBehaviorProven, false);
  } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
});

test('native reference transport budgets every displayed parent and relative link before readonly reconcile (CLI/tool doubles)', posixOnly, async () => {
  const evidenceIds = ['documented-staging-sequence'];
  const verification = 'npm run build && npm run deploy:staging && npm run smoke:staging';
  const candidate = { name: 'deployment', decision: 'CREATE', evidenceIds, taskTriggers: ['Preparing a staging deployment'],
    whenNotToUse: ['Production operations'], workflowSteps: ['Review docs/deployment.md and the documented staging sequence.'],
    verification: [verification], routing: { description: 'Prepare the documented staging deployment sequence.',
      positiveIntents: ['Prepare a staging deployment'], negativeIntents: ['Operate production'] },
    skillAssessment: { taskSpecificity: 'high', rediscoveryCost: 'medium', errorCost: 'high', reuseFrequency: 'high' },
    targetedFollowUpSearch: { queries: ['documented staging sequence'], paths: ['docs/deployment.md'],
      result: 'Found the staging sequence and its smoke-check completion condition.', evidenceIds } };
  const skillContent = '---\nname: deployment\ndescription: Prepare the documented staging deployment sequence.\n---\n\n'
    + '## When to use\nPreparing a staging deployment\n\n## When not to use\nProduction operations\n\n'
    + '## Workflow\nReview docs/deployment.md and the documented staging sequence.\n\n'
    + '## Project-specific rules\nNo production credentials or rollback authority.\n\n'
    + '## Verification\n`npm run build && npm run deploy:staging && npm run smoke:staging`\n';
  const commands = [
    null,
    { command: "/bin/mkdir -m 0755 -- '.claude'", executable: '/bin/mkdir', args: ['-m', '0755', '--', '.claude'] },
    { command: "/bin/mkdir -m 0755 -- '.claude/skills'", executable: '/bin/mkdir', args: ['-m', '0755', '--', '.claude/skills'] },
    { command: "/bin/ln -s -- '../../.agents/skills/deployment' '.claude/skills/deployment'", executable: '/bin/ln',
      args: ['-s', '--', '../../.agents/skills/deployment', '.claude/skills/deployment'] },
  ];
  let modelCalls = 0;
  let next = 0;
  let pending;
  let original;
  const { result, calls } = await captureNativeSetup(async request => {
    modelCalls++;
    const settings = JSON.parse(await readFile(request.args[request.args.indexOf('--settings') + 1], 'utf8'));
    if (modelCalls === 1) {
      original = await readFile(path.join(request.cwd, 'docs/deployment.md'), 'utf8');
      assert.ok(original.includes(verification));
      const args = request.args.at(-1).slice('/agent-init\n'.length);
      assert.ok(args.includes('${response.status}'));
      nativeHook(settings, request, { hook_event_name: 'SessionStart', source: 'startup' });
      nativeHook(settings, request, { hook_event_name: 'UserPromptExpansion', expansion_type: 'slash_command',
        command_name: 'agent-init', command_args: args, command_source: 'userSettings', prompt: 'opaque body' });
      nativeHook(settings, request, { hook_event_name: 'Stop', stop_hook_active: false });
      const record = { evidenceLedger: [{ id: evidenceIds[0], fact: 'The staging sequence is documented.',
        sourcePath: 'docs/deployment.md', sourceLocation: 'Staging section',
        sourceExcerpt: '`npm run build && npm run deploy:staging && npm run smoke:staging`', observation: 'A documented staging workflow is present.',
        whyItMatters: 'Preserve the sequence without executing it.', persistenceScope: 'WORKFLOW', deterministicEnforcementCandidate: false }], events: [
        { type: 'profile', facts: [{ id: 'staging-sequence', status: 'confirmed', value: verification, evidenceIds }], unknowns: [] },
        { type: 'classify', decisions: [{ factId: 'staging-sequence', persistenceScope: 'WORKFLOW', deterministicEnforcementCandidate: false }] },
        { type: 'skills', candidates: [candidate] },
        { type: 'proposal', id: 'native-staging-reference', revision: 1, projectSummary: 'Share the documented staging workflow.',
          unknowns: [], warnings: [], nonGoals: ['No build, staging, deployment or network execution.'], validationPlan: ['Check the relative link and exact canonical bytes.'],
          actions: [
            { id: 'write-staging-skill', action: 'CREATE', target: '.agents/skills/deployment/SKILL.md', kind: 'project-skill',
              evidenceIds, baselineFingerprint: 'missing', proposedContent: skillContent, skillCandidate: candidate, reason: 'Preserve the documented workflow.' },
            { id: 'share-staging-skill', action: 'CREATE', target: '.claude/skills/deployment', kind: 'claude-skill-reference',
              canonicalTarget: '.agents/skills/deployment', linkText: '../../.agents/skills/deployment', linkTarget: '../../.agents/skills/deployment',
              proposedContent: '../../.agents/skills/deployment', parentDirectories: ['.claude', '.claude/skills'],
              evidenceIds, baselineFingerprint: 'missing', reason: 'Share the canonical workflow.' },
          ] },
      ] };
      return { status: 0, stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false,
        session_id: request.sessionId, permission_denials: [], result: JSON.stringify({ decisionRecordJson: JSON.stringify(record) }) }) };
    }
    if (modelCalls === 7) {
      assert.equal(request.args[request.args.indexOf('--tools') + 1], '');
      return { status: 0, stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false,
        session_id: request.sessionId, permission_denials: [], result: JSON.stringify({ type: 'reconcile', mode: 'dry-run', proposalActions: [], writes: [] }) }) };
    }
    assert.equal(request.args[request.args.indexOf('--tools') + 1], 'Write,Edit,Bash');
    assert.equal(request.args[request.args.indexOf('--permission-mode') + 1], 'dontAsk');
    assert.equal(request.args[request.args.indexOf('--setting-sources') + 1], '');
    assert.equal(request.args.includes('--restricted'), true);
    assert.match(request.args.at(-1), /single.*mkdir.*ln -s/);
    if (pending) {
      assert.equal(nativeHook(settings, request, { hook_event_name: 'PreToolUse', tool_use_id: pending.id,
        tool_name: pending.name, tool_input: pending.input }).hookSpecificOutput.permissionDecision, 'allow');
      if (next === 0) {
        const { mkdir } = await import('node:fs/promises');
        await mkdir(path.dirname(pending.input.file_path), { recursive: true, mode: 0o755 });
        await writeFile(pending.input.file_path, pending.input.content, { flag: 'wx', mode: 0o644 });
      } else {
        const tool = spawnSync(commands[next].executable, commands[next].args, { cwd: request.cwd, env: {}, encoding: 'utf8', timeout: 2000 });
        assert.equal(tool.status, 0, tool.stderr);
      }
      assert.deepEqual(nativeHook(settings, request, { hook_event_name: 'PostToolUse', tool_use_id: pending.id,
        tool_name: pending.name, tool_input: pending.input, tool_response: pending.name === 'Bash'
          ? { stdout: '', stderr: '', interrupted: false, isImage: false, noOutputExpected: false }
          : { success: true } }), {});
      next++;
      pending = null;
    }
    if (next < commands.length) {
      pending = next === 0
        ? { id: 'canonical_skill_write', name: 'Write', input: { file_path: path.join(request.cwd, '.agents/skills/deployment/SKILL.md'), content: skillContent } }
        : { id: `reference_part_${next}`, name: 'Bash', input: { command: commands[next].command } };
      assert.equal(nativeHook(settings, request, { hook_event_name: 'PreToolUse', tool_use_id: pending.id,
        tool_name: pending.name, tool_input: pending.input }).hookSpecificOutput.permissionDecision, 'defer');
      return { status: 0, stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false,
        session_id: request.sessionId, permission_denials: [], stop_reason: 'tool_deferred', deferred_tool_use: pending }) };
    }
    return { status: 0, stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false,
      session_id: request.sessionId, permission_denials: [] }) };
  }, { options: { fixtureId: '15-deployment', requestProposalApproval: true, maxModelProcesses: 7, totalModelBudgetUsd: 21 },
    boundaries: { requestApproval: async request => {
      assert.deepEqual(request.audit.proposal.actions[1].parentDirectories, ['.claude', '.claude/skills']);
      return JSON.stringify({ type: 'approval', decision: 'approve', scope: 'exact-proposal', proposalId: request.audit.proposal.id,
        revision: request.audit.proposal.revision, proposalDigest: request.proposalDigest, approvedActionIds: request.requestedWriteActionIds });
    } } });
  try {
    assert.equal(result.code, 'NATIVE_SETUP_VALIDATED');
    assert.equal(result.setup.apply.completed.length, 2);
    assert.equal(result.setup.apply.permissionFloorProven, false);
    assert.equal(result.setup.nativeObservation.exactSourceMaterializationMatched, true);
    assert.ok(result.setup.nativeObservation.sourceMaterializations[0].argsBytes > 1024);
    assert.equal(result.setup.nativeObservation.loaded, undefined);
    assert.equal(result.setup.validation.ok, true, result.setup.validation.errors.join('\n'));
    assert.equal(result.setup.sessionClosed, true);
    assert.equal(result.setup.reconcileZeroChurn, true);
    assert.equal(modelCalls, 7);
    const { readlink, realpath } = await import('node:fs/promises');
    assert.equal(await readlink(path.join(calls[0].cwd, '.claude/skills/deployment')), '../../.agents/skills/deployment');
    assert.equal(await realpath(path.join(calls[0].cwd, '.claude/skills/deployment')), await realpath(path.join(calls[0].cwd, '.agents/skills/deployment')));
    assert.equal(await readFile(path.join(calls[0].cwd, '.agents/skills/deployment/SKILL.md'), 'utf8'), skillContent);
    assert.equal(await readFile(path.join(calls[0].cwd, 'docs/deployment.md'), 'utf8'), original);
    assert.deepEqual(result.artifacts, []);
    assert.equal(result.liveSkillBehaviorProven, false);
  } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
});
