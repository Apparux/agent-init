import assert from 'node:assert/strict';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { captureClaudeApproval, claudeApprovalRequest } from './claude-approval.js';
import { captureClaudeProposal, claudeProposalPrompt } from './claude-proposal.js';
import { digestProposal, fingerprintPath, fingerprintRepository } from './evaluation-harness.js';
import { prepareClaudeNativeApply, captureClaudeNativeApplyDeferred, completeClaudeNativeApply } from './claude-native-apply.js';
import { invokeClaudeProcess } from './claude-live-runner.js';

const helper = new URL('./claude-native-apply.js', import.meta.url);
const posixOnly = { skip: process.platform === 'win32' ? 'owned POSIX native process/permission boundary unavailable' : false };
const nativeTest = (name, body) => test(name, posixOnly, body);
async function hook(context, call, event = 'PreToolUse', extra = {}) {
  const input = { hook_event_name: event, session_id: context.sessionId, cwd: context.cwd,
    tool_use_id: call.id, tool_name: call.name, tool_input: call.input, ...extra };
  const script = `import(${JSON.stringify(helper.href)}).then(async m => process.stdout.write(JSON.stringify(await m.decideClaudeNativeApply({control:process.argv[1],input:JSON.parse(process.argv[2])}))))`;
  const result = await invokeClaudeProcess({ command: process.execPath, args: ['-e', script, context.control, JSON.stringify(input)],
    cwd: context.cwd, env: {}, timeoutMs: 2000 });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function nativeResult(context, fields = {}) {
  return { status: 0, stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false,
    session_id: context.sessionId, permission_denials: [], ...fields }) + '\n' };
}

// External native Write/Edit tool double: only this process mutates project files.
async function executeNativeToolDouble(context, call) {
  const script = `const fs=require('node:fs'),path=require('node:path');const call=JSON.parse(process.argv[1]);
    fs.mkdirSync(path.dirname(call.input.file_path),{recursive:true,mode:0o755});
    const after=call.name==='Write'?call.input.content:fs.readFileSync(call.input.file_path,'utf8').replace(call.input.old_string,call.input.new_string);
    fs.writeFileSync(call.input.file_path,after,{mode:0o644});`;
  const result = await invokeClaudeProcess({ command: process.execPath, args: ['-e', script, JSON.stringify(call)],
    cwd: context.cwd, env: {}, timeoutMs: 2000 });
  assert.equal(result.status, 0, result.stderr);
}

// All native session/tool/approval inputs in this file are explicitly test doubles.
// Proposal capture, approval parsing, helper processes and project files are real.
async function fixture(t, actions = [{ id: 'rules', action: 'CREATE', target: 'AGENTS.md', kind: 'agents',
  proposedContent: 'Use the local verification workflow.\n', baselineFingerprint: 'missing' }], seeds = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'claude-native-apply-double-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'repository');
  await mkdir(cwd);
  await writeFile(path.join(cwd, 'package.json'), '{"scripts":{"test":"node --test"}}\n');
  for (const [target, content] of Object.entries(seeds)) {
    await mkdir(path.dirname(path.join(cwd, target)), { recursive: true });
    await writeFile(path.join(cwd, target), content);
  }
  actions = await Promise.all(actions.map(async (action) => ({
    baselineFingerprint: await fingerprintPath(cwd, action.target), ...action,
  })));
  const sessionId = 'native_apply_test_session';
  const proposal = { type: 'proposal', id: 'proposal-1', revision: 1, projectSummary: 'Local Agent rules',
    unknowns: [], warnings: [], nonGoals: ['No business changes'], validationPlan: ['Inspect exact bytes'],
    actions: actions.map((action) => ({ reason: 'Persist confirmed workflow', evidenceIds: ['e1'], ...action })) };
  const decisionRecord = { evidenceLedger: [{ id: 'e1', fact: 'Local verification exists', sourcePath: 'package.json',
    sourceLocation: 'scripts.test', observation: 'node --test', whyItMatters: 'Verification workflow' }],
  events: [{ type: 'profile', facts: [], unknowns: [] }, { type: 'classify', decisions: [] },
    { type: 'skills', candidates: [] }, proposal] };
  const captured = await captureClaudeProposal({ status: 0, stdout: JSON.stringify({ type: 'result', subtype: 'success',
    is_error: false, permission_denials: [], session_id: sessionId,
    structured_output: { decisionRecordJson: JSON.stringify(decisionRecord) } }) }, { cwd, sessionId, harnessVersion: 'test-double' });
  const request = claudeApprovalRequest(captured);
  const approval = captureClaudeApproval(JSON.stringify({ type: 'approval', decision: 'approve', scope: 'exact-proposal',
    proposalId: 'proposal-1', revision: 1, proposalDigest: captured.proposalDigest,
    approvedActionIds: actions.map((action) => action.id) }), request, 'test-double');
  return { root, cwd, sessionId, control: path.join(root, 'control'), captured, approval, executionKind: 'test-double' };
}

test('missing authority cannot prepare a native permit or write project/control files', async (t) => {
  const context = await fixture(t);
  const before = await fingerprintRepository(context.cwd);
  await assert.rejects(prepareClaudeNativeApply({ ...context, approval: undefined }), { code: 'APPROVAL_REQUIRED' });
  assert.equal(await fingerprintRepository(context.cwd), before);
  assert.equal(await fingerprintPath(context.cwd, 'AGENTS.md'), 'missing');
  await assert.rejects(lstat(context.control), { code: 'ENOENT' });
});

nativeTest('approved Write defers, parent arms the exact native pending call, and only its resumed tool writes (test-double)', async (t) => {
  const context = await fixture(t);
  const gate = await prepareClaudeNativeApply(context);
  assert.equal(gate.qualification, 'unqualified');
  assert.equal(gate.executionKind, 'test-double');
  const call = { id: 'write_call_1', name: 'Write', input: { file_path: path.join(context.cwd, 'AGENTS.md'),
    content: 'Use the local verification workflow.\n' } };
  assert.equal((await hook(context, call)).hookSpecificOutput.permissionDecision, 'defer');
  assert.equal(await fingerprintPath(context.cwd, 'AGENTS.md'), 'missing');
  const arm = await captureClaudeNativeApplyDeferred({ control: context.control, authorizedCall: call,
    processResult: nativeResult(context, { stop_reason: 'tool_deferred', deferred_tool_use: call }) });
  assert.equal(arm.status, 'armed');
  assert.equal(arm.permissionFloorProven, false);
  assert.equal(await fingerprintPath(context.cwd, 'AGENTS.md'), 'missing');
  assert.equal((await hook(context, call)).hookSpecificOutput.permissionDecision, 'allow');
  await executeNativeToolDouble(context, call);
  const post = await hook(context, call, 'PostToolUse', { tool_response: { content: 'Unretained native output' } });
  assert.equal(post.status, 'action-completed');
  assert.equal(post.qualification, 'unqualified');
  assert.equal(await readFile(path.join(context.cwd, 'AGENTS.md'), 'utf8'), 'Use the local verification workflow.\n');
  const complete = await completeClaudeNativeApply({ control: context.control, processResult: nativeResult(context) });
  assert.equal(complete.status, 'completed');
  assert.equal(complete.liveSkillBehaviorProven, false);
  assert.deepEqual(complete.artifacts, []);
  for (const name of ['apply-policy.json', 'apply-state.json', 'apply-events.jsonl']) {
    const file = path.join(context.control, name);
    assert.equal((await lstat(file)).mode & 0o777, 0o600);
  }
  assert.equal((await lstat(context.control)).mode & 0o777, 0o700);
  const journal = await readFile(path.join(context.control, 'apply-events.jsonl'), 'utf8');
  for (const omitted of [context.cwd, 'Use the local verification workflow.', 'Unretained native output', call.id]) {
    assert.equal(journal.includes(omitted), false);
  }
});

nativeTest('native Edit must compute the exact approved UPDATE diff before the external tool can execute (test-double)', async (t) => {
  const context = await fixture(t, [{ id: 'rules-update', action: 'UPDATE', target: 'AGENTS.md', kind: 'agents',
    proposedDiff: '--- a/AGENTS.md\n+++ b/AGENTS.md\n@@ -1,1 +1,1 @@\n-Run the old workflow.\n+Run the new workflow.\n' }],
  { 'AGENTS.md': 'Run the old workflow.\n' });
  await prepareClaudeNativeApply(context);
  const preread = { id: 'read_update_1', name: 'Read', input: { file_path: path.join(context.cwd, 'AGENTS.md') } };
  assert.equal((await hook(context, preread)).hookSpecificOutput.permissionDecision, 'allow');
  assert.equal((await hook(context, preread, 'PostToolUse', { tool_response: { type: 'text', file: {
    filePath: preread.input.file_path, content: 'Run the old workflow.\n', startLine: 1, numLines: 2, totalLines: 2 } } })).status, 'preread-verified');
  const call = { id: 'edit_call_1', name: 'Edit', input: { file_path: path.join(context.cwd, 'AGENTS.md'),
    old_string: 'old', new_string: 'new', replace_all: false } };
  assert.equal((await hook(context, call)).hookSpecificOutput.permissionDecision, 'defer');
  await captureClaudeNativeApplyDeferred({ control: context.control, authorizedCall: call,
    processResult: nativeResult(context, { stop_reason: 'tool_deferred', deferred_tool_use: call }) });
  assert.equal((await hook(context, call)).hookSpecificOutput.permissionDecision, 'allow');
  await executeNativeToolDouble(context, call);
  assert.equal((await hook(context, call, 'PostToolUse', { tool_response: 'Edit tool double completed' })).status, 'action-completed');
  assert.equal(await readFile(path.join(context.cwd, 'AGENTS.md'), 'utf8'), 'Run the new workflow.\n');
  assert.equal((await completeClaudeNativeApply({ control: context.control, processResult: nativeResult(context) })).status, 'completed');
});

nativeTest('UPDATE preread rejects unrelated reads, missing or incomplete results, replay and unobserved mutation', async t => {
  for (const scenario of ['missing', 'wrong-target', 'partial-input', 'wrong-content', 'partial-result', 'false-line-count', 'wrong-response-path', 'replay', 'read-wrote']) await t.test(scenario, async sub => {
    const context = await fixture(sub, [{ id: 'rules-update', action: 'UPDATE', target: 'AGENTS.md', kind: 'agents',
      proposedDiff: '--- a/AGENTS.md\n+++ b/AGENTS.md\n@@ -1,1 +1,1 @@\n-Old rules\n+New rules\n' }], { 'AGENTS.md': 'Old rules\n' });
    await prepareClaudeNativeApply(context);
    const target = path.join(context.cwd, 'AGENTS.md');
    const read = { id: 'exact_preread', name: 'Read', input: { file_path: target } };
    let denied;
    if (scenario === 'missing') denied = await hook(context, { id: 'unread_edit', name: 'Edit', input: {
      file_path: target, old_string: 'Old', new_string: 'New' } });
    else if (scenario === 'wrong-target') denied = await hook(context, { ...read, input: { file_path: path.join(context.cwd, 'package.json') } });
    else if (scenario === 'partial-input') denied = await hook(context, { ...read, input: { file_path: target, limit: 1 } });
    else {
      assert.equal((await hook(context, read)).hookSpecificOutput.permissionDecision, 'allow');
      const response = { type: 'text', file: { filePath: target, content: 'Old rules\n', startLine: 1, numLines: 2, totalLines: 2 } };
      if (scenario === 'wrong-content') response.file.content = 'Model-reported contents\n';
      if (scenario === 'partial-result') response.file.numLines = 1;
      if (scenario === 'false-line-count') response.file.numLines = response.file.totalLines = 99;
      if (scenario === 'wrong-response-path') response.file.filePath = path.join(context.cwd, 'package.json');
      if (scenario === 'read-wrote') await writeFile(path.join(context.cwd, 'foreign.txt'), 'Read side effect\n');
      const post = await hook(context, read, 'PostToolUse', { tool_response: response });
      if (scenario === 'replay') {
        assert.equal(post.status, 'preread-verified');
        denied = await hook(context, { ...read, id: 'second_preread' });
      } else denied = post;
    }
    assert.equal(denied.status, 'failed');
    assert.equal(denied.code, { missing: 'NATIVE_PREREAD_MISSING', 'wrong-target': 'NATIVE_PREREAD_SCOPE',
      'partial-input': 'NATIVE_PREREAD_SCOPE', 'wrong-content': 'NATIVE_PREREAD_UNVERIFIED', 'partial-result': 'NATIVE_PREREAD_UNVERIFIED',
      'false-line-count': 'NATIVE_PREREAD_UNVERIFIED',
      'wrong-response-path': 'NATIVE_PREREAD_UNVERIFIED', replay: 'NATIVE_CALL_REPLAY', 'read-wrote': 'NATIVE_FILESYSTEM_DRIFT' }[scenario]);
    assert.equal(await readFile(target, 'utf8'), 'Old rules\n');
    assert.equal(denied.failureContext.completed.length, 0);
    assert.equal(denied.permissionFloorProven, false);
  });
});

nativeTest('arming requires the recorded native Pre defer, not just a matching deferred envelope', async (t) => {
  const context = await fixture(t);
  await prepareClaudeNativeApply(context);
  const call = { id: 'recorded_call_1', name: 'Write', input: { file_path: path.join(context.cwd, 'AGENTS.md'),
    content: 'Use the local verification workflow.\n' } };
  assert.equal((await hook(context, call)).hookSpecificOutput.permissionDecision, 'defer');
  await writeFile(path.join(context.control, 'apply-events.jsonl'), '');
  await assert.rejects(captureClaudeNativeApplyDeferred({ control: context.control, authorizedCall: call,
    processResult: nativeResult(context, { stop_reason: 'tool_deferred', deferred_tool_use: call }) }), { code: 'NATIVE_DEFER_RECORD_MISSING' });
  assert.equal((await hook(context, call)).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(await fingerprintPath(context.cwd, 'AGENTS.md'), 'missing');
});

nativeTest('malformed resumed Hook is a sticky failure and cannot leave an armed permit usable', async (t) => {
  const context = await fixture(t);
  await prepareClaudeNativeApply(context);
  const call = { id: 'invalid_event_call', name: 'Write', input: { file_path: path.join(context.cwd, 'AGENTS.md'),
    content: 'Use the local verification workflow.\n' } };
  await hook(context, call);
  await captureClaudeNativeApplyDeferred({ control: context.control, authorizedCall: call,
    processResult: nativeResult(context, { stop_reason: 'tool_deferred', deferred_tool_use: call }) });
  const { decideClaudeNativeApply } = await import('./claude-native-apply.js');
  const invalid = await decideClaudeNativeApply({ control: context.control, input: {
    hook_event_name: 'PreToolUse', session_id: context.sessionId, cwd: context.cwd,
    tool_use_id: call.id, tool_name: call.name, tool_input: { ...call.input, extra: Number.NaN },
  } });
  assert.equal(invalid.status, 'failed');
  assert.equal((await hook(context, call)).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(await fingerprintPath(context.cwd, 'AGENTS.md'), 'missing');
});

function writeCall(context, target = 'AGENTS.md', content = 'Use the local verification workflow.\n', id = 'approved_write_1') {
  return { id, name: 'Write', input: { file_path: path.join(context.cwd, target), content } };
}
async function deferAndArm(context, call) {
  assert.equal((await hook(context, call)).hookSpecificOutput.permissionDecision, 'defer');
  return captureClaudeNativeApplyDeferred({ control: context.control, authorizedCall: call,
    processResult: nativeResult(context, { stop_reason: 'tool_deferred', deferred_tool_use: call }) });
}

nativeTest('preparation rejects every nonexact, stale, unbound or unknown approval without any writes', async (t) => {
  for (const [name, change, code] of [
    ['partial', (c) => ({ approval: { ...c.approval, status: 'partial' } }), 'NATIVE_APPROVAL_NONEXACT'],
    ['stale', (c) => ({ approval: { ...c.approval, record: { ...c.approval.record, revision: 2 } } }), 'STALE_APPROVAL'],
    ['digest', (c) => ({ approval: { ...c.approval, record: { ...c.approval.record, proposalDigest: `sha256:${'0'.repeat(64)}` } } }), 'APPROVAL_PAYLOAD'],
    ['unknown action', (c) => ({ approval: { ...c.approval, record: { ...c.approval.record, approvedActionIds: ['unknown'] } } }), 'APPROVAL_ACTIONS'],
    ['duplicate action', (c) => ({ approval: { ...c.approval, record: { ...c.approval.record, approvedActionIds: ['rules', 'rules'] } } }), 'APPROVAL_ACTIONS'],
    ['unknown source', (c) => ({ approval: { ...c.approval, source: 'model-answer' } }), 'NATIVE_APPROVAL_AUTHORITY'],
    ['missing kind', () => ({ executionKind: undefined }), 'NATIVE_AUTHORITY_UNKNOWN'],
    ['test approval cannot authorize real CLI', () => ({ executionKind: 'real-cli' }), 'NATIVE_APPROVAL_AUTHORITY'],
    ['unproved terminal cannot authorize real CLI', (c) => ({ executionKind: 'real-cli', approval: { ...c.approval, source: 'human-terminal' } }), 'NATIVE_APPROVAL_AUTHORITY'],
    ['test kind cannot claim human proof', (c) => ({ approval: { ...c.approval, source: 'human-terminal', humanApprovalProven: true } }), 'NATIVE_APPROVAL_AUTHORITY'],
    ['expected order', () => ({ expectedActionIds: ['different'] }), 'APPROVAL_ACTIONS'],
    ['changed captured payload', (c) => { c.captured.proposal.actions[0].proposedContent = 'Unapproved payload\n'; return {}; }, 'APPROVAL_PAYLOAD'],
  ]) await t.test(name, async (sub) => {
    const context = await fixture(sub);
    const before = await fingerprintRepository(context.cwd);
    await assert.rejects(prepareClaudeNativeApply({ ...context, ...change(context) }), { code });
    assert.equal(await fingerprintRepository(context.cwd), before);
    await assert.rejects(lstat(context.control), { code: 'ENOENT' });
  });
});

nativeTest('native calls fail closed for wrong session, cwd, payload, action order, resumed ID and replay', async (t) => {
  for (const [name, scenario, code] of [
    ['session', 'session', 'NATIVE_SESSION_MISMATCH'], ['cwd', 'cwd', 'NATIVE_CWD_MISMATCH'],
    ['payload', 'payload', 'NATIVE_INPUT_MISMATCH'], ['extra tool field', 'extra-input', 'NATIVE_INPUT_MISMATCH'],
    ['wrong target', 'target', 'NATIVE_ACTION_ORDER'], ['wrong tool', 'tool', 'NATIVE_TOOL_DENIED'],
    ['replay before arm', 'before-arm', 'NATIVE_CALL_REPLAY'], ['changed resumed ID', 'id', 'NATIVE_PENDING_MISMATCH'],
    ['changed resumed input', 'resumed-input', 'NATIVE_INPUT_MISMATCH'], ['one-use replay', 'replay', 'NATIVE_CALL_REPLAY'],
  ]) await t.test(name, async (sub) => {
    const context = await fixture(sub);
    await prepareClaudeNativeApply(context);
    let call = writeCall(context);
    const before = await fingerprintRepository(context.cwd);
    let extra = {};
    if (scenario === 'session') extra = { session_id: 'another_session' };
    if (scenario === 'cwd') extra = { cwd: context.root };
    if (scenario === 'payload') call.input.content = 'Unapproved bytes\n';
    if (scenario === 'extra-input') call.input.other = 'unknown';
    if (scenario === 'target') call.input.file_path = path.join(context.cwd, 'CLAUDE.md');
    if (scenario === 'tool') call.name = 'MultiEdit';
    if (scenario === 'before-arm') await hook(context, call);
    if (['id', 'resumed-input', 'replay'].includes(scenario)) {
      await deferAndArm(context, call);
      if (scenario === 'id') call = { ...call, id: 'different_call' };
      if (scenario === 'resumed-input') call.input.content = 'Different resumed bytes\n';
      if (scenario === 'replay') assert.equal((await hook(context, call)).hookSpecificOutput.permissionDecision, 'allow');
    }
    const denied = await hook(context, call, 'PreToolUse', extra);
    assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(denied.code, code);
    assert.equal(await fingerprintRepository(context.cwd), before);
  });
});

nativeTest('parent arm cannot replace pending native ID/input or omit explicit call authorization', async (t) => {
  for (const scenario of ['missing-authorization', 'id', 'input', 'not-deferred', 'denied-result', 'failed-process']) {
    await t.test(scenario, async (sub) => {
      const context = await fixture(sub);
      await prepareClaudeNativeApply(context);
      const call = writeCall(context);
      await hook(context, call);
      let native = { ...call, input: { ...call.input } };
      if (scenario === 'id') native.id = 'different_id';
      if (scenario === 'input') native.input.content = 'Different native input\n';
      const processResult = nativeResult(context, { stop_reason: 'tool_deferred', deferred_tool_use: native });
      if (scenario === 'not-deferred') processResult.stdout = nativeResult(context).stdout;
      if (scenario === 'denied-result') processResult.stdout = nativeResult(context, { stop_reason: 'tool_deferred',
        deferred_tool_use: native, permission_denials: [{}] }).stdout;
      if (scenario === 'failed-process') processResult.status = 1;
      await assert.rejects(captureClaudeNativeApplyDeferred({ control: context.control, processResult,
        ...(scenario === 'missing-authorization' ? {} : { authorizedCall: call }) }));
      assert.equal((await hook(context, call)).hookSpecificOutput.permissionDecision, 'deny');
      assert.equal(await fingerprintPath(context.cwd, 'AGENTS.md'), 'missing');
    });
  }
});

nativeTest('stale physical baseline or ancestors cannot receive or consume a permit', async (t) => {
  for (const stage of ['prepare', 'defer', 'arm', 'resume']) await t.test(stage, async (sub) => {
    const context = await fixture(sub);
    const call = writeCall(context);
    if (stage !== 'prepare') await prepareClaudeNativeApply(context);
    if (['arm', 'resume'].includes(stage)) await hook(context, call);
    if (stage === 'resume') await captureClaudeNativeApplyDeferred({ control: context.control, authorizedCall: call,
      processResult: nativeResult(context, { stop_reason: 'tool_deferred', deferred_tool_use: call }) });
    await writeFile(path.join(context.cwd, 'AGENTS.md'), 'Foreign current baseline\n');
    if (stage === 'prepare') await assert.rejects(prepareClaudeNativeApply(context), { code: 'NATIVE_BASELINE_STALE' });
    else if (stage === 'arm') await assert.rejects(captureClaudeNativeApplyDeferred({ control: context.control, authorizedCall: call,
      processResult: nativeResult(context, { stop_reason: 'tool_deferred', deferred_tool_use: call }) }), { code: 'NATIVE_FILESYSTEM_DRIFT' });
    else assert.equal((await hook(context, call)).code, 'NATIVE_FILESYSTEM_DRIFT');
    assert.equal(await readFile(path.join(context.cwd, 'AGENTS.md'), 'utf8'), 'Foreign current baseline\n');
  });
});

nativeTest('Post verifies the exact native call and physical delta, preserving every failed target without rollback', async (t) => {
  for (const [scenario, code] of [
    ['wrong-id', 'NATIVE_POST_UNMATCHED'], ['changed-input', 'NATIVE_POST_UNMATCHED'],
    ['missing-response', 'NATIVE_RESPONSE_MISSING'], ['wrong-bytes', 'NATIVE_PAYLOAD_MISMATCH'],
    ['wrong-mode', 'NATIVE_PAYLOAD_MISMATCH'], ['extra-file', 'NATIVE_EXTRA_MUTATION'],
    ['extra-directory', 'NATIVE_EXTRA_MUTATION'], ['unapproved-mode', 'NATIVE_EXTRA_MUTATION'],
    ['symlink-target', 'NATIVE_PATH_SCOPE'],
  ]) await t.test(scenario, async (sub) => {
    const context = await fixture(sub);
    await prepareClaudeNativeApply(context);
    const call = writeCall(context);
    await deferAndArm(context, call);
    assert.equal((await hook(context, call)).hookSpecificOutput.permissionDecision, 'allow');
    await executeNativeToolDouble(context, scenario === 'wrong-bytes'
      ? { ...call, input: { ...call.input, content: 'Wrong native bytes\n' } } : call);
    if (scenario === 'wrong-mode') await chmod(call.input.file_path, 0o600);
    if (scenario === 'extra-file') await writeFile(path.join(context.cwd, 'foreign.txt'), 'Foreign tool effect\n');
    if (scenario === 'extra-directory') await mkdir(path.join(context.cwd, 'foreign-empty-directory'));
    if (scenario === 'unapproved-mode') await chmod(path.join(context.cwd, 'package.json'), 0o600);
    if (scenario === 'symlink-target') {
      await rm(call.input.file_path);
      await writeFile(path.join(context.root, 'outside.txt'), 'Outside owned bytes\n');
      await symlink(path.join(context.root, 'outside.txt'), call.input.file_path);
    }
    let observed = call;
    if (scenario === 'wrong-id') observed = { ...call, id: 'post_other_id' };
    if (scenario === 'changed-input') observed = { ...call, input: { ...call.input, content: 'Changed response input\n' } };
    const result = await hook(context, observed, 'PostToolUse', scenario === 'missing-response' ? {} : { tool_response: 'Completed tool double' });
    assert.equal(result.status, 'failed');
    assert.equal(result.code, code);
    assert.equal(result.continue, false);
    await assert.rejects(completeClaudeNativeApply({ control: context.control, processResult: nativeResult(context) }), { code });
    if (scenario === 'symlink-target') assert.equal((await lstat(call.input.file_path)).isSymbolicLink(), true);
    else assert.equal(await readFile(call.input.file_path, 'utf8'), scenario === 'wrong-bytes'
      ? 'Wrong native bytes\n' : 'Use the local verification workflow.\n');
  });
});

nativeTest('even claimed exact terminal approval and caller proof flags cannot unlock real CLI without a verified floor', async (t) => {
  const context = await fixture(t);
  const before = await fingerprintRepository(context.cwd);
  // Deliberate spoof in a rejection test, never a genuine human approval claim.
  await assert.rejects(prepareClaudeNativeApply({ ...context, executionKind: 'real-cli',
    approval: { ...context.approval, source: 'human-terminal', humanApprovalProven: true },
    permissionFloorProven: true, permissionFloor: { verified: true }, hookCoverageProven: true,
  }), { code: 'NATIVE_PERMISSION_FLOOR_UNVERIFIED' });
  assert.equal(await fingerprintRepository(context.cwd), before);
  await assert.rejects(lstat(context.control), { code: 'ENOENT' });
});

nativeTest('prepare accepts only the two exported native capture provenance tags, not arbitrary authority', async (t) => {
  for (const source of ['cli-json-structured-output', 'cli-json-result-decision-data', 'model-authority']) {
    await t.test(source, async (sub) => {
      const context = await fixture(sub);
      context.captured.provenance.source = source;
      if (source === 'model-authority') {
        await assert.rejects(prepareClaudeNativeApply(context), { code: 'NATIVE_PROPOSAL_INVALID' });
        await assert.rejects(lstat(context.control), { code: 'ENOENT' });
      } else assert.equal((await prepareClaudeNativeApply(context)).status, 'prepared');
      assert.equal(await fingerprintPath(context.cwd, 'AGENTS.md'), 'missing');
    });
  }
});

nativeTest('native Write creates only the necessary approved ancestors and modes (tool double)', async (t) => {
  const context = await fixture(t, [{ id: 'skill', action: 'CREATE', target: '.agents/skills/check/SKILL.md',
    kind: 'project-skill', proposedContent: '# Check workflow\n' }]);
  await prepareClaudeNativeApply(context);
  const call = writeCall(context, '.agents/skills/check/SKILL.md', '# Check workflow\n');
  await deferAndArm(context, call);
  assert.equal((await hook(context, call)).hookSpecificOutput.permissionDecision, 'allow');
  await executeNativeToolDouble(context, call);
  assert.equal((await hook(context, call, 'PostToolUse', { tool_response: 'Native Write double' })).status, 'action-completed');
  assert.equal((await completeClaudeNativeApply({ control: context.control, processResult: nativeResult(context) })).status, 'completed');
  for (const directory of ['.agents', '.agents/skills', '.agents/skills/check']) {
    assert.equal((await lstat(path.join(context.cwd, directory))).mode & 0o777, 0o755);
  }
  assert.equal(await readFile(call.input.file_path, 'utf8'), '# Check workflow\n');
});

nativeTest('wrong ancestor modes and changed physical ancestors remain failures with their native effects preserved', async (t) => {
  for (const scenario of ['new-mode', 'existing-identity', 'ancestor-symlink']) await t.test(scenario, async (sub) => {
    const seeds = scenario === 'existing-identity' ? { 'docs/agents/existing.md': 'Existing docs\n' } : {};
    const context = await fixture(sub, [{ id: 'architecture', action: 'CREATE', target: 'docs/agents/context.md',
      kind: 'agent-doc', knowledgeScope: 'ARCHITECTURE', proposedContent: '# Architecture\n' }], seeds);
    await prepareClaudeNativeApply(context);
    const call = writeCall(context, 'docs/agents/context.md', '# Architecture\n');
    await deferAndArm(context, call);
    assert.equal((await hook(context, call)).hookSpecificOutput.permissionDecision, 'allow');
    if (scenario === 'ancestor-symlink') {
      await mkdir(path.join(context.root, 'outside', 'agents'), { recursive: true });
      await symlink(path.join(context.root, 'outside'), path.join(context.cwd, 'docs'));
    }
    if (scenario === 'existing-identity') {
      await rm(path.join(context.cwd, 'docs', 'agents'), { recursive: true });
      await mkdir(path.join(context.cwd, 'docs', 'agents'));
      await writeFile(path.join(context.cwd, 'docs', 'agents', 'existing.md'), 'Existing docs\n');
    }
    await executeNativeToolDouble(context, call);
    if (scenario === 'new-mode') await chmod(path.join(context.cwd, 'docs', 'agents'), 0o700);
    const result = await hook(context, call, 'PostToolUse', { tool_response: 'Write double with wrong ancestry' });
    assert.equal(result.status, 'failed');
    assert.equal(result.code, scenario === 'ancestor-symlink' ? 'NATIVE_PATH_SCOPE' : 'NATIVE_ANCESTOR_DRIFT');
    assert.equal(await readFile(call.input.file_path, 'utf8'), '# Architecture\n');
  });
});

nativeTest('failed second action preserves completed first action and exposes no rollback path', async (t) => {
  const context = await fixture(t, [{ id: 'rules', action: 'CREATE', target: 'AGENTS.md', kind: 'agents', proposedContent: 'First rules\n' },
    { id: 'adapter', action: 'CREATE', target: 'CLAUDE.md', kind: 'claude-adapter', proposedContent: '@AGENTS.md\n' }]);
  await prepareClaudeNativeApply(context);
  const first = writeCall(context, 'AGENTS.md', 'First rules\n', 'first_call');
  await deferAndArm(context, first);
  await hook(context, first);
  await executeNativeToolDouble(context, first);
  assert.equal((await hook(context, first, 'PostToolUse', { tool_response: 'First completed' })).status, 'action-completed');
  const second = writeCall(context, 'CLAUDE.md', '@AGENTS.md\n', 'second_call');
  await deferAndArm(context, second);
  await hook(context, second);
  await executeNativeToolDouble(context, { ...second, input: { ...second.input, content: 'Wrong second native bytes\n' } });
  const failed = await hook(context, second, 'PostToolUse', { tool_response: 'Second failed' });
  assert.equal(failed.code, 'NATIVE_PAYLOAD_MISMATCH');
  assert.equal(failed.failureContext.completed.length, 1);
  assert.equal(failed.failureContext.failedActionIndex, 1);
  assert.equal(failed.failureContext.failedTargetDigest.startsWith('sha256:'), true);
  await assert.rejects(completeClaudeNativeApply({ control: context.control, processResult: nativeResult(context) }), (cause) => {
    assert.equal(cause.code, 'NATIVE_PAYLOAD_MISMATCH');
    assert.equal(cause.failureContext.completed.length, 1);
    assert.equal(cause.failureContext.failedActionIndex, 1);
    assert.equal(JSON.stringify(cause.failureContext).includes(context.cwd), false);
    return true;
  });
  assert.equal(await readFile(first.input.file_path, 'utf8'), 'First rules\n');
  assert.equal(await readFile(second.input.file_path, 'utf8'), 'Wrong second native bytes\n');
});

nativeTest('missing Post, ignored defer and post-completion drift can never complete', async (t) => {
  for (const scenario of ['missing-post', 'ignored-defer', 'after-post']) await t.test(scenario, async (sub) => {
    const context = await fixture(sub);
    await prepareClaudeNativeApply(context);
    const call = writeCall(context);
    if (scenario === 'ignored-defer') await hook(context, call);
    else { await deferAndArm(context, call); await hook(context, call); }
    await executeNativeToolDouble(context, call);
    if (scenario === 'after-post') {
      await hook(context, call, 'PostToolUse', { tool_response: 'Double completed' });
      await writeFile(path.join(context.cwd, 'foreign.txt'), 'Later effect\n');
    }
    await assert.rejects(completeClaudeNativeApply({ control: context.control, processResult: nativeResult(context) }), {
      code: scenario === 'after-post' ? 'NATIVE_FILESYSTEM_DRIFT' : 'NATIVE_POST_MISSING',
    });
    assert.equal(await readFile(call.input.file_path, 'utf8'), 'Use the local verification workflow.\n');
  });
});

nativeTest('Bash mkdir/reference commands remain disabled without independent real floor proof, including caller booleans', async (t) => {
  for (const command of ["mkdir '.claude'", "mkdir '.claude/skills'", "ln -s '../../.agents/skills/check' '.claude/skills/check'",
    "ln -sf '../../.agents/skills/check' '.claude/skills/check'", "mkdir '.claude'; touch foreign.txt"]) await t.test(command, async (sub) => {
    const context = await fixture(sub, [{ id: 'reference', action: 'CREATE', target: '.claude/skills/check',
      kind: 'claude-skill-reference', linkTarget: '../../.agents/skills/check' }], { '.agents/skills/check/SKILL.md': '# Check\n' });
    await prepareClaudeNativeApply({ ...context, permissionFloorProven: true, permissionFloor: { verified: true } });
    const before = await fingerprintRepository(context.cwd);
    const result = await hook(context, { id: 'reference_call', name: 'Bash', input: { command } });
    assert.equal(result.hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(result.code, 'NATIVE_REFERENCE_PERMISSION_UNVERIFIED');
    assert.equal(result.permissionFloorProven, false);
    assert.equal(result.qualification, 'unqualified');
    assert.equal(await fingerprintRepository(context.cwd), before);
  });
});

nativeTest('literal native foreground Bash reference tracer completes exact mkdir and ln calls (external tool doubles)', async t => {
  const context = await fixture(t, [{ id: 'reference', action: 'CREATE', target: '.claude/skills/check',
    kind: 'claude-skill-reference', linkTarget: '../../.agents/skills/check',
    parentDirectories: ['.claude', '.claude/skills'] }], { '.agents/skills/check/SKILL.md': '# Check\n' });
  const prepared = await prepareClaudeNativeApply(context);
  assert.equal(prepared.status, 'prepared');
  assert.equal(prepared.mutationToolCount, 3);
  const steps = [
    { id: 'literal_parent_0', command: "/bin/mkdir -m 0755 -- '.claude'", executable: '/bin/mkdir', args: ['-m', '0755', '--', '.claude'] },
    { id: 'literal_parent_1', command: "/bin/mkdir -m 0755 -- '.claude/skills'", executable: '/bin/mkdir', args: ['-m', '0755', '--', '.claude/skills'] },
    { id: 'literal_link', command: "/bin/ln -s -- '../../.agents/skills/check' '.claude/skills/check'", executable: '/bin/ln', args: ['-s', '--', '../../.agents/skills/check', '.claude/skills/check'] },
  ];
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index];
    const call = { id: step.id, name: 'Bash', input: { command: step.command } };
    const deferred = await hook(context, call);
    assert.equal(deferred.hookSpecificOutput.permissionDecision, 'defer');
    const armed = await captureClaudeNativeApplyDeferred({ control: context.control, authorizedCall: call,
      processResult: nativeResult(context, { stop_reason: 'tool_deferred', deferred_tool_use: call }) });
    assert.equal(armed.status, 'armed');
    const allowed = await hook(context, call);
    assert.equal(allowed.hookSpecificOutput.permissionDecision, 'allow');
    // External native Bash tool double: exact executables mutate only the owned fixture.
    const externalTool = await invokeClaudeProcess({ command: step.executable, args: step.args,
      cwd: context.cwd, env: {}, timeoutMs: 2000 });
    assert.equal(externalTool.status, 0, externalTool.stderr);
    assert.equal(externalTool.stdout, '');
    assert.equal(externalTool.stderr, '');
    // Literal pinned 2.1.285 foreground output; absolute executables do not match Yfr's bare-token list.
    const post = await hook(context, call, 'PostToolUse', { tool_response: {
      stdout: '', stderr: '', interrupted: false, isImage: false, noOutputExpected: false,
    } });
    assert.equal(post.status, index < 2 ? 'reference-part-completed' : 'action-completed', post.code);
    for (const diagnostic of [prepared, deferred, armed, allowed, post]) {
      assert.equal(diagnostic.executionKind, 'test-double');
      assert.equal(diagnostic.qualification, 'unqualified');
      assert.equal(diagnostic.permissionFloorProven, false);
      assert.equal(diagnostic.liveSkillBehaviorProven, false);
    }
  }
  const collected = await completeClaudeNativeApply({ control: context.control, processResult: nativeResult(context) });
  assert.equal(collected.status, 'completed');
  assert.equal(collected.completed.length, 1);
  assert.equal(collected.completed[0].fingerprint, await fingerprintPath(context.cwd, '.claude/skills/check'));
  assert.equal(await realpath(path.join(context.cwd, '.claude/skills/check')), path.join(context.cwd, '.agents/skills/check'));
  assert.equal(await readFile(path.join(context.cwd, '.claude/skills/check/SKILL.md'), 'utf8'), '# Check\n');
  for (const target of ['.claude', '.claude/skills']) assert.equal((await lstat(path.join(context.cwd, target))).mode & 0o777, 0o755);
  assert.equal(collected.qualification, 'unqualified');
  assert.equal(collected.permissionFloorProven, false);
  assert.equal(collected.liveSkillBehaviorProven, false);
  assert.equal(collected.hookCoverageProven, false);
});

nativeTest('literal validated bashEditDiff metadata does not replace native success or physical delta (external tool doubles)', async t => {
  const responses = [
    ['empty diff', { stdout: '', stderr: '', interrupted: false, isImage: false, noOutputExpected: false,
      bashEditDiff: { files: [], moreFiles: 0 } }],
    ['unavailable shared diff', { stdout: '', stderr: '', interrupted: false, isImage: false, noOutputExpected: false,
      bashEditDiff: { files: [], moreFiles: 0, unavailable: true, shared: true } }],
    ['files and hunks', { stdout: '', stderr: '', interrupted: false, isImage: false, noOutputExpected: false,
      bashEditDiff: { files: [
        { filePath: 'metadata-created.txt', hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ['+metadata only'] }], created: true },
        { filePath: 'metadata-deleted.txt', hunks: [], deleted: true },
      ], moreFiles: 1, changedFiles: ['metadata-created.txt', 'metadata-deleted.txt'] } }],
  ];
  for (const [name, response] of responses) await t.test(name, async sub => {
    const context = await fixture(sub, [{ id: 'reference', action: 'CREATE', target: '.claude/skills/check',
      kind: 'claude-skill-reference', linkTarget: '../../.agents/skills/check', parentDirectories: [] }],
    { '.agents/skills/check/SKILL.md': '# Check\n', '.claude/skills/.keep': '' });
    const prepared = await prepareClaudeNativeApply(context);
    assert.equal(prepared.mutationToolCount, 1);
    const call = { id: 'optional_metadata_link', name: 'Bash', input: {
      command: "/bin/ln -s -- '../../.agents/skills/check' '.claude/skills/check'",
    } };
    const armed = await deferAndArm(context, call);
    assert.equal(armed.status, 'armed');
    assert.equal((await hook(context, call)).hookSpecificOutput.permissionDecision, 'allow');
    // External native Bash tool double mutates the owned filesystem; metadata is only a literal double.
    const externalTool = await invokeClaudeProcess({ command: '/bin/ln', args: ['-s', '--', '../../.agents/skills/check', '.claude/skills/check'],
      cwd: context.cwd, env: {}, timeoutMs: 2000 });
    assert.equal(externalTool.status, 0, externalTool.stderr);
    const post = await hook(context, call, 'PostToolUse', { tool_response: response });
    assert.equal(post.status, 'action-completed', post.code);
    const collected = await completeClaudeNativeApply({ control: context.control, processResult: nativeResult(context) });
    assert.equal(collected.status, 'completed');
    assert.equal(collected.completed[0].fingerprint, await fingerprintPath(context.cwd, '.claude/skills/check'));
    assert.equal(await realpath(path.join(context.cwd, '.claude/skills/check')), path.join(context.cwd, '.agents/skills/check'));
    for (const target of ['metadata-created.txt', 'metadata-deleted.txt']) assert.equal(await fingerprintPath(context.cwd, target), 'missing');
    for (const diagnostic of [prepared, armed, post, collected]) {
      assert.equal(diagnostic.qualification, 'unqualified');
      assert.equal(diagnostic.permissionFloorProven, false);
      assert.equal(diagnostic.liveSkillBehaviorProven, false);
    }
    assert.equal(collected.hookCoverageProven, false);
  });
});

nativeTest('reference Post rejects missing, wrong and synthetic foreground output shapes without rollback (external tool doubles)', async t => {
  const foreground = { stdout: '', stderr: '', interrupted: false, isImage: false, noOutputExpected: false };
  const shapes = [
    ['missing response', undefined], ['null response', null], ['empty response', {}],
    ['string response', 'completed'], ['array response', []],
    ...Object.keys(foreground).map(key => [`missing ${key}`, Object.fromEntries(Object.entries(foreground).filter(([field]) => field !== key))]),
    ['nonempty stdout', { ...foreground, stdout: 'Unexpected output\n' }],
    ['nonempty stderr', { ...foreground, stderr: 'Unexpected error\n' }],
    ['wrong stdout type', { ...foreground, stdout: 0 }], ['wrong stderr type', { ...foreground, stderr: [] }],
    ['interrupted', { ...foreground, interrupted: true }], ['wrong interrupted type', { ...foreground, interrupted: 'false' }],
    ['image', { ...foreground, isImage: true }], ['wrong isImage type', { ...foreground, isImage: 0 }],
    ['bare-token noOutputExpected', { ...foreground, noOutputExpected: true }],
    ['wrong noOutputExpected type', { ...foreground, noOutputExpected: 'false' }],
    ['synthetic success only', { success: true }], ['synthetic code only', { code: 0 }], ['synthetic exitCode only', { exitCode: 0 }],
    ['synthetic success added', { ...foreground, success: true }], ['synthetic code added', { ...foreground, code: 0 }],
    ['synthetic exitCode added', { ...foreground, exitCode: 0 }], ['unknown metadata', { ...foreground, unknown: false }],
    // Verified native optional keys are forbidden by presence, including falsy values.
    ...['rawOutputPath', 'backgroundTaskId', 'backgroundedByUser', 'backgroundedByTurnAbort', 'backgroundedToDeliverMessage',
      'timedOutAfterMs', 'backgroundCwdHint', 'backgroundEndsWithFinalResponse', 'dangerouslyDisableSandbox', 'returnCodeInterpretation',
      'structuredContent', 'persistedOutputPath', 'persistedOutputSize', 'staleReadFileStateHint', 'ghRateLimitHint', 'gitOperation']
      .map(key => [`forbidden ${key}`, { ...foreground, [key]: false }]),
    ['valid diff cannot replace foreground success', { ...foreground, interrupted: true, bashEditDiff: { files: [], moreFiles: 0 } }],
    ...[
      ['null diff', null], ['array diff', []], ['missing files', { moreFiles: 0 }],
      ['wrong moreFiles', { files: [], moreFiles: '0' }], ['wrong changedFiles', { files: [], moreFiles: 0, changedFiles: [0] }],
      ['false optional flag', { files: [], moreFiles: 0, shared: false }], ['unknown diff key', { files: [], moreFiles: 0, unknown: true }],
      ['wrong filePath', { files: [{ filePath: 0, hunks: [] }], moreFiles: 0 }],
      ['false file flag', { files: [{ filePath: 'metadata-only', hunks: [], created: false }], moreFiles: 0 }],
      ['unknown file key', { files: [{ filePath: 'metadata-only', hunks: [], unknown: true }], moreFiles: 0 }],
      ['wrong hunk number', { files: [{ filePath: 'metadata-only', hunks: [{ oldStart: '0', oldLines: 0, newStart: 1, newLines: 1, lines: [] }] }], moreFiles: 0 }],
      ['wrong hunk lines', { files: [{ filePath: 'metadata-only', hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: [0] }] }], moreFiles: 0 }],
      ['unknown hunk key', { files: [{ filePath: 'metadata-only', hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: [], unknown: true }] }], moreFiles: 0 }],
    ].map(([name, bashEditDiff]) => [`malformed ${name}`, { ...foreground, bashEditDiff }]),
  ];
  for (const [name, response] of shapes) await t.test(name, async sub => {
    const context = await fixture(sub, [{ id: 'reference', action: 'CREATE', target: '.claude/skills/check',
      kind: 'claude-skill-reference', linkTarget: '../../.agents/skills/check',
      parentDirectories: ['.claude', '.claude/skills'] }], { '.agents/skills/check/SKILL.md': '# Check\n' });
    await prepareClaudeNativeApply(context);
    const call = { id: 'invalid_shape_parent', name: 'Bash', input: { command: "/bin/mkdir -m 0755 -- '.claude'" } };
    await deferAndArm(context, call);
    assert.equal((await hook(context, call)).hookSpecificOutput.permissionDecision, 'allow');
    // External native Bash tool double supplies a real physical effect, not a model claim.
    const externalTool = await invokeClaudeProcess({ command: '/bin/mkdir', args: ['-m', '0755', '--', '.claude'],
      cwd: context.cwd, env: {}, timeoutMs: 2000 });
    assert.equal(externalTool.status, 0, externalTool.stderr);
    const post = await hook(context, call, 'PostToolUse', response === undefined ? {} : { tool_response: response });
    const code = response === undefined ? 'NATIVE_RESPONSE_MISSING' : 'NATIVE_REFERENCE_RESPONSE_UNVERIFIED';
    assert.equal(post.status, 'failed');
    assert.equal(post.code, code);
    assert.equal(post.continue, false);
    assert.equal(post.qualification, 'unqualified');
    assert.equal(post.permissionFloorProven, false);
    assert.equal(post.liveSkillBehaviorProven, false);
    assert.deepEqual(post.failureContext.completed, []);
    assert.deepEqual(post.failureContext.verifiedReferenceParts, []);
    assert.deepEqual(post.failureContext.pendingActionIndexes, [0]);
    assert.equal(post.failureContext.rollbackPerformed, false);
    await assert.rejects(completeClaudeNativeApply({ control: context.control, processResult: nativeResult(context) }), { code });
    assert.equal((await hook(context, call)).hookSpecificOutput.permissionDecision, 'deny');
    const directory = await lstat(path.join(context.cwd, '.claude'));
    assert.equal(directory.isDirectory(), true);
    assert.equal(directory.mode & 0o777, 0o755);
    assert.equal(await fingerprintPath(context.cwd, '.claude/skills/check'), 'missing');
  });
});

nativeTest('an explicitly displayed relative reference creates only its approved parents and one native symlink (tool doubles)', async t => {
  const context = await fixture(t, [{ id: 'reference', action: 'CREATE', target: '.claude/skills/check',
    kind: 'claude-skill-reference', linkTarget: '../../.agents/skills/check',
    parentDirectories: ['.claude', '.claude/skills'] }], { '.agents/skills/check/SKILL.md': '# Check\n' });
  const request = claudeApprovalRequest(context.captured, { nativeApply: true });
  assert.equal(request.presentation.includes('父目录（0755）'), true);
  assert.match(claudeProposalPrompt, /parentDirectories/);
  assert.deepEqual(request.audit.proposal.actions[0].parentDirectories, ['.claude', '.claude/skills']);
  const prepared = await prepareClaudeNativeApply(context);
  assert.equal(prepared.actionCount, 1);
  assert.equal(prepared.mutationToolCount, 3);
  const calls = [
    { id: 'reference_parent_0', name: 'Bash', input: { command: "/bin/mkdir -m 0755 -- '.claude'" } },
    { id: 'reference_parent_1', name: 'Bash', input: { command: "/bin/mkdir -m 0755 -- '.claude/skills'" } },
    { id: 'reference_link', name: 'Bash', input: { command: "/bin/ln -s -- '../../.agents/skills/check' '.claude/skills/check'" } },
  ];
  for (let index = 0; index < calls.length; index++) {
    const call = calls[index];
    assert.equal((await hook(context, call)).hookSpecificOutput.permissionDecision, 'defer');
    await captureClaudeNativeApplyDeferred({ control: context.control, authorizedCall: call,
      processResult: nativeResult(context, { stop_reason: 'tool_deferred', deferred_tool_use: call }) });
    assert.equal((await hook(context, call)).hookSpecificOutput.permissionDecision, 'allow');
    const script = index < 2
      ? `require('node:fs').mkdirSync(${JSON.stringify(index === 0 ? '.claude' : '.claude/skills')},{mode:0o755});`
      : "require('node:fs').symlinkSync('../../.agents/skills/check','.claude/skills/check');";
    const externalTool = await invokeClaudeProcess({ command: process.execPath, args: ['-e', script], cwd: context.cwd, env: {}, timeoutMs: 2000 });
    assert.equal(externalTool.status, 0);
    const post = await hook(context, call, 'PostToolUse', { tool_response: {
      stdout: '', stderr: '', interrupted: false, isImage: false, noOutputExpected: false,
    } });
    assert.equal(post.status, index < 2 ? 'reference-part-completed' : 'action-completed');
  }
  const result = await completeClaudeNativeApply({ control: context.control, processResult: nativeResult(context) });
  assert.equal(result.status, 'completed');
  assert.equal(result.completed.length, 1);
  assert.equal(result.completed[0].fingerprint, await fingerprintPath(context.cwd, '.claude/skills/check'));
  assert.equal(await realpath(path.join(context.cwd, '.claude/skills/check')), path.join(context.cwd, '.agents/skills/check'));
  assert.equal((await lstat(path.join(context.cwd, '.claude'))).mode & 0o777, 0o755);
  assert.equal(result.permissionFloorProven, false);
  assert.equal(result.liveSkillBehaviorProven, false);
});

nativeTest('displayed reference parent effects must equal the necessary ordered parents, before any permit exists', async t => {
  for (const parentDirectories of [['.claude/skills', '.claude'], ['.claude'], ['.claude', '.claude/skills', 'foreign'],
    ['.claude', '.claude/skills', '.claude/skills'], '.claude', ['../foreign']]) await t.test(JSON.stringify(parentDirectories), async sub => {
    const context = await fixture(sub, [{ id: 'reference', action: 'CREATE', target: '.claude/skills/check',
      kind: 'claude-skill-reference', linkTarget: '../../.agents/skills/check', parentDirectories }],
    { '.agents/skills/check/SKILL.md': '# Check\n' });
    const before = await fingerprintRepository(context.cwd);
    await assert.rejects(prepareClaudeNativeApply(context), { code: 'NATIVE_REFERENCE_PARENTS' });
    assert.equal(await fingerprintRepository(context.cwd), before);
    await assert.rejects(lstat(context.control), { code: 'ENOENT' });
  });
});

nativeTest('reference calls never expand into shell variants, extra fields or out-of-order parts', async t => {
  for (const input of [
    { command: "/bin/mkdir -m 0755 -- '.claude'; touch foreign" },
    { command: "/bin/mkdir -m 0755 -- '.claude' &" },
    { command: "/bin/mkdir -p -m 0755 -- '.claude'" },
    { command: "/bin/ln -sf -- '../../.agents/skills/check' '.claude/skills/check'" },
    { command: "/bin/ln -s -- '../../.agents/skills/check' '.claude/skills/check'" },
    { command: "/bin/mkdir -m 0755 -- '.claude'", timeout: 1000 },
  ]) await t.test(JSON.stringify(input), async sub => {
    const context = await fixture(sub, [{ id: 'reference', action: 'CREATE', target: '.claude/skills/check',
      kind: 'claude-skill-reference', linkTarget: '../../.agents/skills/check', parentDirectories: ['.claude', '.claude/skills'] }],
    { '.agents/skills/check/SKILL.md': '# Check\n' });
    await prepareClaudeNativeApply(context);
    const before = await fingerprintRepository(context.cwd);
    const denied = await hook(context, { id: 'wrong_reference_call', name: 'Bash', input });
    assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(denied.code, 'NATIVE_REFERENCE_CALL_MISMATCH');
    assert.equal(await fingerprintRepository(context.cwd), before);
  });
});

nativeTest('a failed later reference part retains verified directories without completing or rolling back its action', async t => {
  const context = await fixture(t, [{ id: 'reference', action: 'CREATE', target: '.claude/skills/check',
    kind: 'claude-skill-reference', linkTarget: '../../.agents/skills/check', parentDirectories: ['.claude', '.claude/skills'] }],
  { '.agents/skills/check/SKILL.md': '# Check\n' });
  await prepareClaudeNativeApply(context);
  const first = { id: 'parent_first', name: 'Bash', input: { command: "/bin/mkdir -m 0755 -- '.claude'" } };
  await deferAndArm(context, first);
  assert.equal((await hook(context, first)).hookSpecificOutput.permissionDecision, 'allow');
  const native = await invokeClaudeProcess({ command: process.execPath, args: ['-e', "require('node:fs').mkdirSync('.claude',{mode:0o755})"],
    cwd: context.cwd, env: {}, timeoutMs: 2000 });
  assert.equal(native.status, 0);
  assert.equal((await hook(context, first, 'PostToolUse', { tool_response: {
    stdout: '', stderr: '', interrupted: false, isImage: false, noOutputExpected: false,
  } })).status, 'reference-part-completed');
  const denied = await hook(context, { id: 'out_of_order_link', name: 'Bash', input: {
    command: "/bin/ln -s -- '../../.agents/skills/check' '.claude/skills/check'" } });
  assert.equal(denied.code, 'NATIVE_REFERENCE_CALL_MISMATCH');
  assert.equal(denied.failureContext.completed.length, 0);
  assert.equal(denied.failureContext.verifiedReferenceParts.length, 1);
  assert.deepEqual(denied.failureContext.pendingActionIndexes, [0]);
  assert.equal(denied.failureContext.rollbackPerformed, false);
  assert.equal(JSON.stringify(denied).includes(context.cwd), false);
  assert.equal((await lstat(path.join(context.cwd, '.claude'))).isDirectory(), true);
  assert.equal(await fingerprintPath(context.cwd, '.claude/skills/check'), 'missing');
  await assert.rejects(completeClaudeNativeApply({ control: context.control, processResult: nativeResult(context) }),
    { code: 'NATIVE_REFERENCE_CALL_MISMATCH' });
});

nativeTest('reference action kind cannot authorize a target outside the exact Claude reference scope', async (t) => {
  const context = await fixture(t, [{ id: 'reference', action: 'CREATE', target: '.claude/skills/check',
    kind: 'claude-skill-reference', linkTarget: '../../.agents/skills/check' }]);
  context.captured.proposal.actions[0].target = 'docs/agents/check';
  context.captured.proposalDigest = digestProposal(context.captured.proposal);
  context.approval.record.proposalDigest = context.captured.proposalDigest;
  await assert.rejects(prepareClaudeNativeApply(context), { code: 'NATIVE_REFERENCE_INVALID' });
  await assert.rejects(lstat(context.control), { code: 'ENOENT' });
});

nativeTest('configured credential echoes in native IDs cannot enter any retained control event/state', async (t) => {
  const context = await fixture(t);
  const credential = 'private_native_id_marker';
  await prepareClaudeNativeApply({ ...context, secrets: [credential] });
  const call = writeCall(context, 'AGENTS.md', 'Use the local verification workflow.\n', `call_${credential}_1`);
  const result = await hook(context, call);
  assert.equal(result.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(result.code, 'NATIVE_CALL_INVALID');
  for (const name of ['apply-policy.json', 'apply-state.json', 'apply-events.jsonl']) {
    assert.equal((await readFile(path.join(context.control, name), 'utf8')).includes(credential), false);
  }
  assert.equal(JSON.stringify(result).includes(credential), false);
  assert.equal(await fingerprintPath(context.cwd, 'AGENTS.md'), 'missing');
});

nativeTest('escaped configured credential in a shadowed native result member cannot arm the permit', async (t) => {
  const context = await fixture(t);
  const credential = 'shadowed_native_marker';
  await prepareClaudeNativeApply({ ...context, secrets: [credential] });
  const call = writeCall(context);
  await hook(context, call);
  const result = nativeResult(context, { stop_reason: 'tool_deferred', deferred_tool_use: call });
  const encoded = [...credential].map((character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
  result.stdout = result.stdout.replace('{', `{"note":"${encoded}","note":"sanitized",`);
  await assert.rejects(captureClaudeNativeApplyDeferred({ control: context.control, authorizedCall: call, processResult: result }), { code: 'SECRET_TRACE' });
  assert.equal((await hook(context, call)).hookSpecificOutput.permissionDecision, 'deny');
  for (const name of ['apply-policy.json', 'apply-state.json', 'apply-events.jsonl']) {
    assert.equal((await readFile(path.join(context.control, name), 'utf8')).includes(credential), false);
  }
  assert.equal(await fingerprintPath(context.cwd, 'AGENTS.md'), 'missing');
});

nativeTest('known credentials in an otherwise captured payload cannot be persisted in controller policy', async (t) => {
  const credential = 'private_captured_payload_marker';
  const context = await fixture(t, [{ id: 'rules', action: 'CREATE', target: 'AGENTS.md', kind: 'agents',
    proposedContent: `Never retain ${credential}\n` }]);
  await assert.rejects(prepareClaudeNativeApply({ ...context, secrets: [credential] }), { code: 'SECRET_TRACE' });
  await assert.rejects(lstat(context.control), { code: 'ENOENT' });
  assert.equal(await fingerprintPath(context.cwd, 'AGENTS.md'), 'missing');
});

nativeTest('captured Proposal is reused immutably and action order cannot be changed after preparation', async (t) => {
  const context = await fixture(t);
  await prepareClaudeNativeApply(context);
  context.captured.proposal.actions[0].proposedContent = 'Later unapproved payload\n';
  context.approval.record.approvedActionIds = ['later-id'];
  const call = writeCall(context);
  await deferAndArm(context, call);
  assert.equal((await hook(context, call)).hookSpecificOutput.permissionDecision, 'allow');
  await executeNativeToolDouble(context, call);
  assert.equal((await hook(context, call, 'PostToolUse', { tool_response: 'Double completed' })).status, 'action-completed');
  assert.equal((await completeClaudeNativeApply({ control: context.control, processResult: nativeResult(context) })).status, 'completed');
  assert.equal((await hook(context, call)).code, 'NATIVE_APPLY_COMPLETED');
  assert.equal(await readFile(call.input.file_path, 'utf8'), 'Use the local verification workflow.\n');
});

nativeTest('physical ancestors above the repository/control root stay bound to their captured modes', async (t) => {
  const context = await fixture(t);
  await prepareClaudeNativeApply(context);
  await chmod(context.root, 0o755);
  const result = await hook(context, writeCall(context));
  assert.equal(result.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(result.code, 'NATIVE_ANCESTOR_DRIFT');
  assert.equal(await fingerprintPath(context.cwd, 'AGENTS.md'), 'missing');
});

nativeTest('controller symlinks, unowned modes and hardlinked mutation targets cannot become authority', async (t) => {
  for (const scenario of ['control-symlink', 'control-mode', 'policy-symlink', 'hardlinked-target']) await t.test(scenario, async (sub) => {
    const context = await fixture(sub, scenario === 'hardlinked-target' ? [{ id: 'rules', action: 'UPDATE', target: 'AGENTS.md', kind: 'agents',
      proposedDiff: '--- a/AGENTS.md\n+++ b/AGENTS.md\n@@ -1,1 +1,1 @@\n-Old rules\n+New rules\n' }] : undefined,
    scenario === 'hardlinked-target' ? { 'AGENTS.md': 'Old rules\n' } : {});
    if (scenario === 'control-symlink') {
      const actual = path.join(context.root, 'other-control');
      await mkdir(actual, { mode: 0o700 });
      await symlink(actual, context.control);
      await assert.rejects(prepareClaudeNativeApply(context), { code: 'NATIVE_CONTROL_INVALID' });
    } else if (scenario === 'control-mode') {
      await mkdir(context.control, { mode: 0o755 });
      await assert.rejects(prepareClaudeNativeApply(context), { code: 'NATIVE_CONTROL_INVALID' });
    } else if (scenario === 'hardlinked-target') {
      await link(path.join(context.cwd, 'AGENTS.md'), path.join(context.root, 'outside-hardlink'));
      await assert.rejects(prepareClaudeNativeApply(context), { code: 'NATIVE_PATH_SCOPE' });
      assert.equal(await readFile(path.join(context.root, 'outside-hardlink'), 'utf8'), 'Old rules\n');
    } else {
      await prepareClaudeNativeApply(context);
      await rm(path.join(context.control, 'apply-policy.json'));
      const outside = path.join(context.root, 'outside-policy');
      await writeFile(outside, 'Do not follow this file\n');
      await symlink(outside, path.join(context.control, 'apply-policy.json'));
      const denied = await hook(context, writeCall(context));
      assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
      assert.equal(await readFile(outside, 'utf8'), 'Do not follow this file\n');
    }
  });
});
