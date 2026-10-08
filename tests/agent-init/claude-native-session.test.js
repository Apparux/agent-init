import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { invokeClaudeProcess, runClaudeLiveAcceptance } from './claude-live-runner.js';
import { collectClaudeNativeObservation, collectClaudeNativeProposalObservation, prepareClaudeNativeObservation } from './claude-native-session.js';
import { snapshotContext } from './claude-protocol.js';
import { digestTree } from '../../src/installation/filesystem.js';

const posixOnly = { skip: process.platform === 'win32' ? 'owned POSIX process groups are unavailable' : false };

function sha(value) { return `sha256:${createHash('sha256').update(value).digest('hex')}`; }

// Only the external native events/process are doubles. Journal, alias, source,
// held seals, physical validators and public collectors are real.
async function materializationFixture(t, { source = '﻿---\nname: agent-init\ndescription: Owned fixture\n---\n\n  PRIVATE_SKILL_BODY\r\n$ARGUMENTS\n${CLAUDE_SKILL_DIR}\n${CLAUDE_PROJECT_DIR}\n${CLAUDE_SESSION_ID}\n  ', args = 'plan !now `!inert!` $&', commandSource = 'userSettings', secrets = [], containerName = 'sources', autoHold = false, beforePrepare } = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'native-materialization-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'project');
  const sourceContainer = path.join(root, containerName);
  const canonicalRoot = path.join(sourceContainer, 'agent-init');
  const aliasRoot = path.join(home, '.claude/skills/agent-init');
  await mkdir(canonicalRoot, { recursive: true });
  await mkdir(path.dirname(aliasRoot), { recursive: true });
  await mkdir(cwd);
  await writeFile(path.join(canonicalRoot, 'SKILL.md'), source);
  await symlink(canonicalRoot, aliasRoot);
  const alias = await lstat(aliasRoot);
  const inventory = [{ name: 'agent-init', namespace: 'user', sourceContainer, aliasRoot, canonicalRoot,
    fileDigest: sha(source), treeDigest: await digestTree(canonicalRoot), seal: await snapshotContext(canonicalRoot),
    aliasSeal: { identity: `${alias.dev}:${alias.ino}`, mode: alias.mode & 0o777, mtimeMs: alias.mtimeMs, linkText: await readlink(aliasRoot) } }];
  const sessionId = randomUUID();
  const journalFile = autoHold ? path.join(home, '.claude/projects/owned-project', `${sessionId}.jsonl`) : path.join(home, 'owned-journal.jsonl');
  if (autoHold) await mkdir(path.dirname(journalFile), { recursive: true });
  const materializationSources = [{ name: 'agent-init', namespace: 'user', sourceContainer, aliasRoot, canonicalRoot }];
  if (beforePrepare) await beforePrepare({ root, home, cwd, canonicalRoot, aliasRoot, materializationSources });
  const session = await prepareClaudeNativeObservation({ root, home, cwd, sessionId, motherSkillRoot: canonicalRoot, secrets,
    ...(autoHold ? { materializationSources } : {}) });
  const settings = JSON.parse(await readFile(session.settingsFile, 'utf8'));
  const request = { cwd, env: { PATH: process.env.PATH } };
  const common = { session_id: sessionId, cwd, ...(autoHold ? { transcript_path: journalFile } : {}) };
  nativeHook(settings, request, { ...common, hook_event_name: 'SessionStart' });
  nativeHook(settings, request, { ...common, hook_event_name: 'UserPromptExpansion', expansion_type: 'slash_command',
    command_name: 'agent-init', command_args: args, command_source: commandSource, prompt: 'PRIVATE_CALLER_BODY' });
  nativeHook(settings, request, { ...common, hook_event_name: 'Stop' });
  const callerId = randomUUID();
  const frameId = randomUUID();
  // Worked native rendering, deliberately literal rather than the producer's renderer.
  const rendered = `Base directory for this skill: ${aliasRoot}\n\nPRIVATE_SKILL_BODY\r\nplan \\!now \` \\!inert! \` $&\n${aliasRoot}\n${cwd}\n${sessionId}\n  `;
  const records = [
    { type: 'user', uuid: callerId, parentUuid: null, sessionId, cwd, version: '2.1.285',
      message: { role: 'user', content: `<command-message>agent-init</command-message>\n<command-name>/agent-init</command-name>\n<command-args>${args}</command-args>` } },
    { type: 'user', uuid: frameId, parentUuid: callerId, sessionId, cwd, version: '2.1.285', isMeta: true, turnCompanion: true,
      message: { role: 'user', content: [{ type: 'text', text: rendered }] } },
  ];
  const saveJournal = async (value = records, suffix = '\n') => writeFile(journalFile, value.map(JSON.stringify).join('\n') + suffix, { mode: 0o600 });
  await saveJournal();
  const context = { sessionId, harnessVersion: '2.1.285 (Claude Code)', cwd, secrets, readRoots: [cwd, home], evidenceRoots: [root],
    ...(!autoHold ? { nativeMaterialization: { profile: 'claude-2.1.285-file-skill', ownedRoot: root, journalFile, inventory } } : {}) };
  const processResult = { status: 0, stdout: [
    { type: 'system', subtype: 'init', session_id: sessionId, tools: [] },
    { type: 'user', session_id: sessionId, uuid: frameId, isSynthetic: true, message: records[1].message },
    { type: 'result', subtype: 'success', is_error: false, session_id: sessionId, permission_denials: [] },
  ].map(JSON.stringify).join('\n') + '\n' };
  const proposalResult = { status: 0, stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false,
    session_id: sessionId, permission_denials: [] }) + '\n' };
  return { root, home, cwd, canonicalRoot, aliasRoot, inventory, materializationSources, source, args, session, settings, request, common,
    records, rendered, journalFile, saveJournal, context, processResult, proposalResult };
}

function assertMaterializationOnly(value) {
  assert.equal(value.exactSourceMaterializationMatched, true);
  assert.equal(value.scope, 'materialization-only');
  assert.equal(value.qualification, 'unqualified');
  for (const key of ['selectionProtocolVerified', 'hookCoverageProven', 'permissionFloorProven']) assert.equal(value[key], false);
  assert.equal(value.loaded, undefined);
}

test('prepared native materialization automatically reaches public collectors with an immutable pre-invoke source profile (external event doubles)', posixOnly, async t => {
  const f = await materializationFixture(t, { autoHold: true });
  assert.equal(f.context.nativeMaterialization, undefined);
  assert.equal(f.session.nativeMaterialization, undefined);
  // Neither changing the caller's descriptors nor supplying a forged profile
  // can replace the genuinely captured source authority.
  f.inventory[0].fileDigest = 'sha256:' + '0'.repeat(64);
  f.materializationSources[0].canonicalRoot = f.cwd;
  f.materializationSources[0].name = 'forged-skill';
  const forgedContext = { ...f.context, nativeMaterialization: { profile: 'caller-forged', qualification: 'qualified', loaded: ['agent-init'] } };
  const observed = await collectClaudeNativeObservation(f.session, f.processResult, forgedContext);
  assert.equal(observed.code, 'NATIVE_SELECTION_UNVERIFIED');
  assertMaterializationOnly(observed.provenance);
  const [source] = observed.provenance.sourceMaterializations;
  assert.equal(source.sourceFileDigest, sha(f.source));
  assert.equal(source.materializationDigest, sha(f.rendered));
  assert.equal(source.journalRef, `<owned-root>/home/.claude/projects/owned-project/${f.context.sessionId}.jsonl`);
  const { harnessVersion, ...defaultVersionContext } = f.context;
  const proposal = await collectClaudeNativeProposalObservation(f.session, f.proposalResult, defaultVersionContext);
  assertMaterializationOnly(proposal);
  assert.equal(proposal.sourceMaterializations[0].journalRef, source.journalRef);
  const retained = JSON.stringify({ observed, proposal });
  for (const privateValue of [f.root, f.source, f.args, 'PRIVATE_CALLER_BODY']) assert.equal(retained.includes(privateValue), false);
});

test('prepared collector fingerprints cannot be erased by caller context, including shadowed private process fields', posixOnly, async t => {
  const secret = 'HELD_FINGERPRINT_CANARY';
  const f = await materializationFixture(t, { autoHold: true, secrets: [secret] });
  const { secrets, ...context } = f.context;
  const escaped = [...secret].map(char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
  const lines = f.processResult.stdout.trim().split('\n');
  lines[0] = lines[0].slice(0, -1) + `,"opaque":"${escaped}","opaque":"public"}`;
  const observed = await collectClaudeNativeObservation(f.session, { ...f.processResult, stdout: lines.join('\n') + '\n' }, context);
  assert.equal(observed.code, 'SECRET_TRACE');
  assert.equal(JSON.stringify(observed).includes(secret), false);
  const raw = f.proposalResult.stdout.trim().slice(0, -1) + `,"opaque":"${escaped}","opaque":"public"}\n`;
  await assert.rejects(collectClaudeNativeProposalObservation(f.session, { status: 0, stdout: raw }, context), { code: 'SECRET_TRACE' });
});

test('prepared materialization rejects invalid pre-invoke sources and never retrofits source or alias seals after native invocation', posixOnly, async t => {
  await t.test('invalid-before-prepare', async subtest => {
    let reachedInvocation = false;
    await assert.rejects(materializationFixture(subtest, { autoHold: true, beforePrepare: async f => {
      await chmod(path.join(f.canonicalRoot, 'SKILL.md'), 0o666);
    } }).then(() => { reachedInvocation = true; }), { code: 'NATIVE_MATERIALIZATION_SOURCE_INVALID' });
    assert.equal(reachedInvocation, false);
  });
  await t.test('unmaterialized-source-metadata-after-invoke', async subtest => {
    let otherRoot;
    const f = await materializationFixture(subtest, { autoHold: true, beforePrepare: async prepared => {
      otherRoot = path.join(path.dirname(prepared.canonicalRoot), 'secondary');
      const otherAlias = path.join(path.dirname(prepared.aliasRoot), 'secondary');
      await mkdir(otherRoot);
      await writeFile(path.join(otherRoot, 'SKILL.md'), 'Independent unmaterialized source.\n');
      await symlink(otherRoot, otherAlias);
      prepared.materializationSources.push({ name: 'secondary', namespace: 'user', canonicalRoot: otherRoot,
        aliasRoot: otherAlias, sourceContainer: path.dirname(otherRoot) });
    } });
    await chmod(path.join(otherRoot, 'SKILL.md'), 0o600);
    const observed = await collectClaudeNativeObservation(f.session, f.processResult, f.context);
    assert.equal(observed.code, 'NATIVE_MATERIALIZATION_SOURCE_CHANGED');
    assert.equal(observed.provenance.sourceMaterializations, undefined);
    await assert.rejects(collectClaudeNativeProposalObservation(f.session, f.proposalResult, f.context), { code: 'NATIVE_MATERIALIZATION_SOURCE_CHANGED' });
  });
  for (const [name, change] of [
    ['source-metadata-after-invoke', f => chmod(path.join(f.canonicalRoot, 'SKILL.md'), 0o600)],
    ['source-bytes-after-invoke', f => writeFile(path.join(f.canonicalRoot, 'SKILL.md'), f.source + 'changed')],
    ['alias-metadata-after-invoke', async f => {
      const linkText = await readlink(f.aliasRoot);
      await rm(f.aliasRoot);
      await symlink(linkText, f.aliasRoot);
    }],
  ]) await t.test(name, async subtest => {
    const f = await materializationFixture(subtest, { autoHold: true });
    await change(f);
    const observed = await collectClaudeNativeObservation(f.session, f.processResult, f.context);
    assert.equal(observed.code, 'NATIVE_MATERIALIZATION_SOURCE_CHANGED');
    assert.equal(observed.status, 'error');
    assert.equal(observed.provenance.sourceMaterializations, undefined);
    assert.equal(observed.provenance.loaded, undefined);
    await assert.rejects(collectClaudeNativeProposalObservation(f.session, f.proposalResult, f.context), { code: 'NATIVE_MATERIALIZATION_SOURCE_CHANGED' });
  });
});

test('prepared materialization binds only the exact native lifecycle transcript and fails closed without fallback searches', posixOnly, async t => {
  const cases = [
    ['missing-location', 'NATIVE_MATERIALIZATION_TRANSCRIPT_MISSING', (f, payload) => { delete payload.transcript_path; }],
    ['outside-location', 'NATIVE_MATERIALIZATION_TRANSCRIPT_SCOPE', (f, payload) => { payload.transcript_path = path.join(f.cwd, 'outside.jsonl'); }],
    ['malformed-location', 'NATIVE_MATERIALIZATION_TRANSCRIPT_INVALID', (f, payload) => { payload.transcript_path = ['not-a-path']; }],
    ['nested-project-location', 'NATIVE_MATERIALIZATION_TRANSCRIPT_SCOPE', (f, payload) => { payload.transcript_path = path.join(f.home, '.claude/projects/owned-project/nested', `${f.context.sessionId}.jsonl`); }],
    ['wrong-session-location', 'NATIVE_MATERIALIZATION_TRANSCRIPT_SCOPE', (f, payload) => { payload.transcript_path = path.join(path.dirname(f.journalFile), `${randomUUID()}.jsonl`); }],
    ['ambiguous-location', 'NATIVE_MATERIALIZATION_TRANSCRIPT_AMBIGUOUS', async (f, payload) => {
      payload.transcript_path = path.join(f.home, '.claude/projects/second-project', `${f.context.sessionId}.jsonl`);
      await mkdir(path.dirname(payload.transcript_path));
    }],
    ['missing-journal', 'NATIVE_MATERIALIZATION_JOURNAL_MISSING', async f => { await rm(f.journalFile); }],
    ['redirected-ancestor', 'NATIVE_MATERIALIZATION_TRANSCRIPT_SCOPE', async f => {
      const parent = path.dirname(f.journalFile);
      const retained = path.join(f.home, '.claude/retained-project');
      await mkdir(retained);
      await writeFile(path.join(retained, `${f.context.sessionId}.jsonl`), f.records.map(JSON.stringify).join('\n') + '\n');
      await rm(parent, { recursive: true });
      await symlink(retained, parent);
    }],
  ];
  for (const [name, code, change] of cases) await t.test(name, async subtest => {
    const f = await materializationFixture(subtest, { autoHold: true });
    if (!['missing-journal', 'redirected-ancestor'].includes(name)) {
      await writeFile(path.join(f.session.control, 'events.jsonl'), '', { mode: 0o600 });
      const common = { ...f.common };
      if (name !== 'ambiguous-location') await change(f, common);
      nativeHook(f.settings, f.request, { ...common, hook_event_name: 'SessionStart' });
      nativeHook(f.settings, f.request, { ...f.common, hook_event_name: 'UserPromptExpansion', expansion_type: 'slash_command',
        command_name: 'agent-init', command_args: f.args, command_source: 'userSettings' });
      if (name === 'ambiguous-location') await change(f, common);
      nativeHook(f.settings, f.request, { ...common, hook_event_name: 'Stop' });
    } else await change(f);
    const observed = await collectClaudeNativeObservation(f.session, f.processResult, f.context);
    assert.equal(observed.status, 'error', name);
    assert.equal(observed.code, code, name);
    assert.equal(observed.provenance.sourceMaterializations, undefined);
    assert.equal(observed.provenance.loaded, undefined);
    assert.equal(JSON.stringify(observed).includes(f.root), false);
    await assert.rejects(collectClaudeNativeProposalObservation(f.session, f.proposalResult, f.context), { code });
  });
});

test('native materialization public collectors bind a direct exact meta frame to held physical source without claiming loaded (external event doubles)', posixOnly, async (t) => {
  const fixture = await materializationFixture(t);
  const observed = await collectClaudeNativeObservation(fixture.session, fixture.processResult, fixture.context);
  assert.equal(observed.status, 'blocked', observed.code);
  assert.equal(observed.code, 'NATIVE_SELECTION_UNVERIFIED');
  assertMaterializationOnly(observed.provenance);
  const [source] = observed.provenance.sourceMaterializations;
  assert.equal(source.command, 'agent-init');
  assert.equal(source.namespace, 'user');
  assert.equal(source.sourceFileDigest, fixture.inventory[0].fileDigest);
  assert.equal(source.sourceTreeDigest, fixture.inventory[0].treeDigest);
  assert.equal(source.materializationDigest, sha(fixture.rendered));
  assert.equal(source.argsDigest, sha(fixture.args));
  assert.equal(source.argsBytes, Buffer.byteLength(fixture.args));
  assert.deepEqual(source.journalLocation, { callerIndex: 0, frameIndex: 1 });
  assert.equal(source.sourceRootRef, '<owned-root>/sources/agent-init');
  assert.equal(source.aliasRootRef, '<owned-root>/home/.claude/skills/agent-init');
  assert.equal(source.streamFrameMatched, true);
  const proposal = await collectClaudeNativeProposalObservation(fixture.session, fixture.proposalResult, fixture.context);
  assertMaterializationOnly(proposal);
  assert.equal(proposal.sourceMaterializations[0].materializationDigest, source.materializationDigest);
  for (const value of [observed, proposal]) {
    const retained = JSON.stringify(value);
    for (const privateValue of [fixture.root, fixture.args, 'PRIVATE_SKILL_BODY', 'PRIVATE_CALLER_BODY']) assert.equal(retained.includes(privateValue), false);
  }
});

test('native direct invocation without arguments accepts the pinned caller with no command-args tag (external event doubles)', posixOnly, async t => {
  const source = '---\nname: agent-init\ndescription: Owned fixture\n---\n\nNo-arguments native body.\n';
  const f = await materializationFixture(t, { source, args: '', autoHold: true });
  f.records[0].message.content = '<command-message>agent-init</command-message>\n<command-name>/agent-init</command-name>';
  f.records[1].message.content = [{ type: 'text', text: `Base directory for this skill: ${f.aliasRoot}\n\nNo-arguments native body.\n` }];
  await f.saveJournal();
  const stream = f.processResult.stdout.trim().split('\n').map(JSON.parse);
  stream[1].message = f.records[1].message;
  f.processResult.stdout = stream.map(JSON.stringify).join('\n') + '\n';
  const observed = await collectClaudeNativeObservation(f.session, f.processResult, f.context);
  assert.equal(observed.code, 'NATIVE_SELECTION_UNVERIFIED');
  assertMaterializationOnly(observed.provenance);
  assert.equal(observed.provenance.sourceMaterializations[0].argsBytes, 0);
  assert.equal(observed.provenance.sourceMaterializations[0].argsDigest, sha(''));
  const proposal = await collectClaudeNativeProposalObservation(f.session, f.proposalResult, f.context);
  assertMaterializationOnly(proposal);
  assert.equal(proposal.sourceMaterializations[0].argsBytes, 0);
  assert.equal(proposal.sourceMaterializations[0].materializationDigest, observed.provenance.sourceMaterializations[0].materializationDigest);
});

test('an omitted native command-args tag cannot conceal malformed markup or nonempty hook arguments (external event doubles)', posixOnly, async t => {
  for (const scenario of ['unclosed-tag', 'truncated-tag', 'self-closing-tag', 'duplicate-tags', 'complete-plus-unclosed-tag', 'complete-plus-truncated-tag', 'nonempty-hook-arguments']) await t.test(scenario, async sub => {
    const source = '---\nname: agent-init\ndescription: Owned fixture\n---\n\nNo-arguments native body.\n';
    const f = await materializationFixture(sub, { source, args: scenario === 'nonempty-hook-arguments' ? 'not-empty' : '', autoHold: true });
    const suffix = {
      'unclosed-tag': '\n<command-args>unclosed',
      'truncated-tag': '\n<command-args',
      'self-closing-tag': '\n<command-args/>',
      'duplicate-tags': '\n<command-args></command-args>\n<command-args></command-args>',
      'complete-plus-unclosed-tag': '\n<command-args></command-args>\n<command-args>unclosed',
      'complete-plus-truncated-tag': '\n<command-args></command-args>\n</command-args',
    }[scenario] ?? '';
    f.records[0].message.content = '<command-message>agent-init</command-message>\n<command-name>/agent-init</command-name>' + suffix;
    f.records[1].message.content = [{ type: 'text', text: `Base directory for this skill: ${f.aliasRoot}\n\nNo-arguments native body.\n` }];
    await f.saveJournal();
    const stream = f.processResult.stdout.trim().split('\n').map(JSON.parse);
    stream[1].message = f.records[1].message;
    f.processResult.stdout = stream.map(JSON.stringify).join('\n') + '\n';
    const observed = await collectClaudeNativeObservation(f.session, f.processResult, f.context);
    assert.equal(observed.status, 'error');
    assert.equal(observed.code, 'NATIVE_MATERIALIZATION_CALL_UNVERIFIED');
    assert.equal(observed.provenance.sourceMaterializations, undefined);
    assert.equal(observed.provenance.loaded, undefined);
    await assert.rejects(collectClaudeNativeProposalObservation(f.session, f.proposalResult, f.context), { code: 'NATIVE_MATERIALIZATION_CALL_UNVERIFIED' });
  });
});

test('native materialization never retains recognizable credential text introduced only by a canonical source path', posixOnly, async t => {
  const marker = 'ghp_SYNTHETIC_CANONICAL_ONLY_MARKER_NOT_A_CREDENTIAL';
  const fixture = await materializationFixture(t, { containerName: marker });
  assert.equal((await readFile(fixture.journalFile, 'utf8')).includes(marker), false);
  assert.equal(fixture.processResult.stdout.includes(marker), false);
  const observed = await collectClaudeNativeObservation(fixture.session, fixture.processResult, fixture.context);
  assert.equal(observed.status, 'error');
  assert.equal(observed.code, 'SECRET_TRACE');
  assert.equal(JSON.stringify(observed).includes(marker), false);
  await assert.rejects(collectClaudeNativeProposalObservation(fixture.session, fixture.proposalResult, fixture.context), { code: 'SECRET_TRACE' });
});

test('native materialization Skill branch requires structured successful same-call post, journal sourceToolUseID and exact stream frame (external event doubles)', posixOnly, async (t) => {
  const fixture = await materializationFixture(t);
  const input = { skill: 'agent-init', args: fixture.args };
  const callId = 'native_skill_1';
  await writeFile(path.join(fixture.session.control, 'events.jsonl'), '', { mode: 0o600 });
  nativeHook(fixture.settings, fixture.request, { ...fixture.common, hook_event_name: 'SessionStart' });
  const tool = { ...fixture.common, tool_use_id: callId, tool_name: 'Skill', tool_input: input };
  nativeHook(fixture.settings, fixture.request, { ...tool, hook_event_name: 'PreToolUse' });
  assert.deepEqual(nativeHook(fixture.settings, fixture.request, { ...tool, hook_event_name: 'PostToolUse',
    tool_response: { success: true, commandName: 'agent-init', privateBody: 'OPAQUE_REPLY_NOT_RETAINED' } }), {});
  nativeHook(fixture.settings, fixture.request, { ...fixture.common, hook_event_name: 'Stop' });
  fixture.records[0] = { ...fixture.records[0], type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: callId, name: 'Skill', input }] } };
  fixture.records[1].sourceToolUseID = callId;
  await fixture.saveJournal();
  const processResult = { status: 0, stdout: [
    { type: 'system', subtype: 'init', session_id: fixture.context.sessionId, tools: ['Skill'] },
    { type: 'assistant', session_id: fixture.context.sessionId, message: fixture.records[0].message },
    { type: 'user', session_id: fixture.context.sessionId, message: { content: [{ type: 'tool_result', tool_use_id: callId, content: 'Launching skill: agent-init' }] } },
    { type: 'user', session_id: fixture.context.sessionId, uuid: fixture.records[1].uuid, isSynthetic: true, message: fixture.records[1].message },
    { type: 'result', subtype: 'success', is_error: false, session_id: fixture.context.sessionId, permission_denials: [] },
  ].map(JSON.stringify).join('\n') + '\n' };
  const observed = await collectClaudeNativeObservation(fixture.session, processResult, fixture.context);
  assert.equal(observed.status, 'blocked', observed.code);
  assertMaterializationOnly(observed.provenance);
  assert.equal(observed.provenance.sourceMaterializations[0].branch, 'tool-skill');
  assert.equal(observed.provenance.sourceMaterializations[0].callIdDigest, sha(callId));
  assert.equal(observed.provenance.toolCompletions[0].skillSuccess, true);
  assert.equal(observed.provenance.toolCompletions[0].skillBranch, 'inline');
  assert.equal(JSON.stringify(observed).includes('OPAQUE_REPLY_NOT_RETAINED'), false);
});

test('native materialization accepts native 0644 journals in a private root and unchanged macOS /var aliases (external event doubles)', posixOnly, async (t) => {
  const fixture = await materializationFixture(t);
  await chmod(fixture.journalFile, 0o644);
  if (fixture.aliasRoot.startsWith('/private/var/')) {
    const actualAlias = fixture.aliasRoot.replace(/^\/private\/var\//, '/var/');
    assert.equal(await realpath(actualAlias), fixture.canonicalRoot);
    fixture.inventory[0].aliasRoot = actualAlias;
    fixture.records[1].message.content[0].text = fixture.rendered.replaceAll(fixture.aliasRoot, actualAlias);
    await fixture.saveJournal();
    const messages = fixture.processResult.stdout.trim().split('\n').map(JSON.parse);
    messages[1].message = fixture.records[1].message;
    fixture.processResult.stdout = messages.map(JSON.stringify).join('\n') + '\n';
  }
  const observed = await collectClaudeNativeObservation(fixture.session, fixture.processResult, fixture.context);
  assert.equal(observed.status, 'blocked', observed.code);
  assertMaterializationOnly(observed.provenance);
  assert.equal((await lstat(fixture.journalFile)).mode & 0o777, 0o644);
});

test('native materialization rejects echo/declaration, changed source, wrong chains and incomplete or redirected journals (external event doubles)', posixOnly, async (t) => {
  const mutations = {
    'assistant-answer': async f => { f.records[1].type = 'assistant'; f.records[1].message.role = 'assistant'; },
    'regular-user-echo': async f => { delete f.records[1].isMeta; delete f.records[1].turnCompanion; },
    'not-turn-companion': async f => { delete f.records[1].turnCompanion; },
    'multiple-text-blocks': async f => { f.records[1].message.content.push({ type: 'text', text: 'extra' }); },
    'body-substring-only': async f => { f.records[1].message.content[0].text += '\nunknown prompt extension rewrite'; },
    'trimmed-render': async f => { f.records[1].message.content[0].text = f.rendered.trim(); },
    'wrong-source-root': async f => { f.inventory[0].canonicalRoot = f.cwd; },
    'wrong-file-digest': async f => { f.inventory[0].fileDigest = 'sha256:' + '0'.repeat(64); },
    'wrong-tree-digest': async f => { f.inventory[0].treeDigest = 'sha256:' + '0'.repeat(64); },
    'changed-source-seal': async f => { await writeFile(path.join(f.canonicalRoot, 'SKILL.md'), f.source + 'changed'); },
    'changed-alias-seal': async f => { f.inventory[0].aliasSeal.identity = '0:0'; },
    'wrong-source-container': async f => { f.inventory[0].sourceContainer = f.home; },
    'wrong-version': async f => { f.records[1].version = '2.1.286'; },
    'wrong-session': async f => { f.records[1].sessionId = randomUUID(); },
    'wrong-parent': async f => { f.records[1].parentUuid = randomUUID(); },
    'repeated-uuid': async f => { f.records[1].uuid = f.records[0].uuid; },
    'caller-text-not-command': async f => { f.records[0].message.content = f.rendered; },
    'caller-args-not-expansion': async f => { f.records[0].message.content = '<command-name>/agent-init</command-name><command-args>different</command-args>'; },
    'stream-uuid-content-mismatch': async f => {
      const messages = f.processResult.stdout.trim().split('\n').map(JSON.parse);
      messages[1].message.content[0].text += 'different';
      f.processResult.stdout = messages.map(JSON.stringify).join('\n') + '\n';
    },
    'stream-wrong-uuid': async f => {
      const messages = f.processResult.stdout.trim().split('\n').map(JSON.parse);
      messages[1].uuid = randomUUID();
      f.processResult.stdout = messages.map(JSON.stringify).join('\n') + '\n';
    },
    'missing-journal': async f => { await rm(f.journalFile); },
    'truncated-journal': async f => { await f.saveJournal(f.records, ''); },
    'symlink-journal': async f => { await symlink(f.journalFile, path.join(f.home, 'journal-link')); f.context.nativeMaterialization.journalFile = path.join(f.home, 'journal-link'); },
    'symlink-journal-ancestor': async f => { await symlink(f.home, path.join(f.root, 'redirect')); f.context.nativeMaterialization.journalFile = path.join(f.root, 'redirect/owned-journal.jsonl'); },
    'hard-linked-journal': async f => { await link(f.journalFile, path.join(f.home, 'second-link')); },
    'world-writable-root': async f => { await chmod(f.root, 0o777); },
    'world-writable-journal': async f => { await chmod(f.journalFile, 0o666); },
    'unknown-profile': async f => { f.context.nativeMaterialization.profile = 'unqualified-native'; },
    'wrong-harness': async f => { f.context.harnessVersion = '2.1.286 (Claude Code)'; },
    'escaped-shadowed-secret-before-parse': async f => {
      const secret = 'SYNTHETIC_JOURNAL_CANARY';
      f.context.secrets = [secret];
      const escaped = [...secret].map(char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
      await writeFile(f.journalFile, f.records.map(JSON.stringify).join('\n') + `\n{"opaque":"${escaped}","opaque":"public"}\n`);
    },
  };
  for (const [name, mutate] of Object.entries(mutations)) await t.test(name, async (subtest) => {
    const f = await materializationFixture(subtest);
    await mutate(f);
    if (!['missing-journal', 'truncated-journal', 'escaped-shadowed-secret-before-parse'].includes(name)) await f.saveJournal();
    const observed = await collectClaudeNativeObservation(f.session, f.processResult, f.context);
    assert.equal(observed.status, 'error', name);
    assert.match(observed.code, /^(?:NATIVE_MATERIALIZATION_|SECRET_TRACE)/, name);
    assert.notEqual(observed.provenance.exactSourceMaterializationMatched, true);
    assert.equal(observed.provenance.sourceMaterializations, undefined);
    for (const claim of ['selectionProtocolVerified', 'hookCoverageProven', 'permissionFloorProven']) assert.equal(observed.provenance[claim], false);
    assert.equal(observed.provenance.loaded, undefined);
    assert.equal(JSON.stringify(observed).includes(f.root), false);
    if (name.startsWith('stream-')) {
      // The proposal collector has no stream: the intact owned journal can still
      // establish materialization-only, never the missing stream channel.
      const proposal = await collectClaudeNativeProposalObservation(f.session, f.proposalResult, f.context);
      assertMaterializationOnly(proposal);
      assert.equal(proposal.sourceMaterializations[0].streamFrameMatched, false);
    } else await assert.rejects(collectClaudeNativeProposalObservation(f.session, f.proposalResult, f.context),
      error => /^(?:NATIVE_MATERIALIZATION_|SECRET_TRACE)/.test(error.code ?? ''), name);
  });
});

test('native materialization does not infer source by a duplicated inventory name and defaults stay blocked', posixOnly, async (t) => {
  const f = await materializationFixture(t);
  f.inventory.unshift({ ...f.inventory[0], aliasRoot: path.join(f.cwd, '.claude/skills/agent-init'), canonicalRoot: f.cwd, namespace: 'project' });
  const observed = await collectClaudeNativeObservation(f.session, f.processResult, f.context);
  assert.equal(observed.status, 'blocked', observed.code);
  assertMaterializationOnly(observed.provenance);
  assert.equal(observed.provenance.sourceMaterializations[0].namespace, 'user');
  const { nativeMaterialization, ...defaultContext } = f.context;
  const defaultObserved = await collectClaudeNativeObservation(f.session, f.processResult, defaultContext);
  assert.equal(defaultObserved.code, 'NATIVE_SELECTION_UNVERIFIED');
  assert.equal(defaultObserved.provenance.exactSourceMaterializationMatched, undefined);
  assert.equal(defaultObserved.provenance.sourceMaterializations, undefined);
  const defaultProposal = await collectClaudeNativeProposalObservation(f.session, f.proposalResult, defaultContext);
  assert.equal(defaultProposal.exactSourceMaterializationMatched, undefined);
  assert.equal(defaultProposal.sourceVerified, false);
});

test('native materialization blocks indexed argument placeholders rather than treating them as whole ARGUMENTS (external event doubles)', posixOnly, async (t) => {
  const f = await materializationFixture(t, { source: '---\nname: agent-init\n---\n$ARGUMENTS[0]' });
  f.records[1].message.content[0].text = `Base directory for this skill: ${f.aliasRoot}\n\nplan \\!now \` \\!inert! \` $&[0]`;
  await f.saveJournal();
  const messages = f.processResult.stdout.trim().split('\n').map(JSON.parse);
  messages[1].message = f.records[1].message;
  f.processResult.stdout = messages.map(JSON.stringify).join('\n') + '\n';
  const observed = await collectClaudeNativeObservation(f.session, f.processResult, f.context);
  assert.equal(observed.status, 'error');
  assert.equal(observed.code, 'NATIVE_MATERIALIZATION_FORMAT_UNSUPPORTED');
});

test('native materialization hook namespace retention is enum-only, args remain digest-only, configured retained secrets fail closed', posixOnly, async (t) => {
  for (const [label, namespace] of [['userSettings', 'user'], ['user', 'user'], ['projectSettings', 'project'], ['project', 'project'],
    ['policySettings', 'managed'], ['managed', 'managed'], ['privateAccountLabel', undefined], ['userSettings.private', undefined],
    ['github_pat_PRIVATE_NATIVE_SOURCE', undefined]]) await t.test(label, async (subtest) => {
    const f = await materializationFixture(subtest, { commandSource: label });
    const { nativeMaterialization, ...context } = f.context;
    const observed = await collectClaudeNativeObservation(f.session, f.processResult, context);
    assert.equal(observed.status, 'blocked', observed.code);
    const event = observed.provenance.directExpansions[0];
    assert.equal(event.sourceSample, namespace);
    assert.equal(event.sourceOmitted, namespace ? undefined : true);
    assert.equal(event.argsDigest, sha(f.args));
    assert.equal(event.argsBytes, Buffer.byteLength(f.args));
    const retained = JSON.stringify(observed);
    assert.equal(retained.includes(f.args), false);
    if (label !== namespace) assert.equal(retained.includes(label), false);
  });
  await t.test('configured-secret-in-retained-enum', async subtest => {
    const f = await materializationFixture(subtest, { commandSource: 'userSettings', secrets: ['user'] });
    const { nativeMaterialization, ...context } = f.context;
    const observed = await collectClaudeNativeObservation(f.session, f.processResult, context);
    assert.equal(observed.status, 'error');
    assert.equal(observed.code, 'SECRET_TRACE');
    assert.deepEqual(observed.provenance.directExpansions, []);
  });
});

test('native materialization structured Skill replies admit absent/inline status but failed/forked/projection replies never succeed', posixOnly, async (t) => {
  for (const [name, response, success, code] of [
    ['absent-status', { success: true, commandName: 'agent-init' }, true, undefined],
    ['inline', { success: true, commandName: 'agent-init', status: 'inline' }, true, undefined],
    ['failed', { success: false, commandName: 'agent-init' }, false, 'NATIVE_SKILL_POST_UNVERIFIED'],
    ['forked', { success: true, commandName: 'agent-init', status: 'forked' }, false, 'NATIVE_SKILL_POST_UNVERIFIED'],
    ['wrong-command', { success: true, commandName: 'another' }, false, 'NATIVE_SKILL_POST_UNVERIFIED'],
    ['launch-projection', 'Launching skill: agent-init', false, undefined],
  ]) await t.test(name, async subtest => {
    const f = await materializationFixture(subtest);
    await writeFile(path.join(f.session.control, 'events.jsonl'), '', { mode: 0o600 });
    nativeHook(f.settings, f.request, { ...f.common, hook_event_name: 'SessionStart' });
    const input = { skill: 'agent-init', args: f.args };
    const callId = 'reply_skill_1';
    const tool = { ...f.common, tool_use_id: callId, tool_name: 'Skill', tool_input: input };
    nativeHook(f.settings, f.request, { ...tool, hook_event_name: 'PreToolUse' });
    nativeHook(f.settings, f.request, { ...tool, hook_event_name: 'PostToolUse', tool_response: response });
    nativeHook(f.settings, f.request, { ...f.common, hook_event_name: 'Stop' });
    const processResult = { status: 0, stdout: [
      { type: 'system', subtype: 'init', session_id: f.context.sessionId, tools: ['Skill'] },
      { type: 'assistant', session_id: f.context.sessionId, message: { content: [{ type: 'tool_use', id: callId, name: 'Skill', input }] } },
      { type: 'user', session_id: f.context.sessionId, message: { content: [{ type: 'tool_result', tool_use_id: callId, content: 'Launching skill: agent-init' }] } },
      { type: 'result', subtype: 'success', is_error: false, session_id: f.context.sessionId, permission_denials: [] },
    ].map(JSON.stringify).join('\n') + '\n' };
    const { nativeMaterialization, ...context } = f.context;
    const observed = await collectClaudeNativeObservation(f.session, processResult, context);
    assert.equal(observed.code, code ?? 'NATIVE_SELECTION_UNVERIFIED');
    assert.equal(observed.provenance.toolCompletions.at(-1)?.skillSuccess ?? false, success);
    assert.equal(observed.provenance.loaded, undefined);
  });
});

test('native materialization exact rendering preserves no-frontmatter BOM and CRLF and only appends arguments when truthy', posixOnly, async (t) => {
  for (const [name, source, args, body] of [
    ['no-frontmatter-bom', '﻿literal\r\n  ', 'plain', '﻿literal\r\n  \n\nARGUMENTS: plain'],
    ['crlf-frontmatter-native-regex', '---\r\nname: agent-init\r\n---\r\n\r\n  body\r\n  ', '', 'body\r\n  '],
    ['empty-args-no-fallback', 'body\n ', '', 'body\n '],
    ['whole-args-literal-dollar', '$ARGUMENTS $ARGUMENTS', '$&', '$& $&'],
  ]) await t.test(name, async subtest => {
    const f = await materializationFixture(subtest, { source, args });
    f.records[1].message.content[0].text = `Base directory for this skill: ${f.aliasRoot}\n\n${body}`;
    await f.saveJournal();
    const messages = f.processResult.stdout.trim().split('\n').map(JSON.parse);
    messages[1].message = f.records[1].message;
    f.processResult.stdout = messages.map(JSON.stringify).join('\n') + '\n';
    const observed = await collectClaudeNativeObservation(f.session, f.processResult, f.context);
    assert.equal(observed.status, 'blocked', observed.code);
    assertMaterializationOnly(observed.provenance);
    assert.equal(observed.provenance.sourceMaterializations[0].materializationDigest, sha(f.records[1].message.content[0].text));
  });
});

test('prepared materialization treats inert JavaScript dollars and whole ARGUMENTS text inside arguments as literal native insertion (external event doubles)', posixOnly, async t => {
  const args = '${response.status} ${endpoint} $ARGUMENTS';
  const f = await materializationFixture(t, { autoHold: true, args, source: '---\nname: agent-init\n---\n$ARGUMENTS\n' });
  const literal = `Base directory for this skill: ${f.aliasRoot}\n\n\${response.status} \${endpoint} $ARGUMENTS\n`;
  f.records[1].message.content[0].text = literal;
  await f.saveJournal();
  const messages = f.processResult.stdout.trim().split('\n').map(JSON.parse);
  messages[1].message = f.records[1].message;
  const observed = await collectClaudeNativeObservation(f.session, { ...f.processResult, stdout: messages.map(JSON.stringify).join('\n') + '\n' }, f.context);
  assert.equal(observed.status, 'blocked', observed.code);
  assertMaterializationOnly(observed.provenance);
  assert.equal(observed.provenance.sourceMaterializations[0].materializationDigest, sha(literal));
  assert.equal(observed.provenance.sourceMaterializations[0].argsDigest, sha(args));
  assertMaterializationOnly(await collectClaudeNativeProposalObservation(f.session, f.proposalResult, f.context));
  assert.equal(JSON.stringify(observed).includes(args), false);
});

test('prepared materialization still rejects reserved unimplemented native transforms and sentinels in arguments', posixOnly, async t => {
  for (const [name, args] of [['dynamic-effort', '${CLAUDE_EFFORT}'], ['unknown-native-transform', '${CLAUDE_UNKNOWN}'],
    ['sentinel-ffff', '￿'], ['sentinel-fffe', '￾']]) await t.test(name, async subtest => {
    const f = await materializationFixture(subtest, { autoHold: true, args, source: '$ARGUMENTS' });
    const observed = await collectClaudeNativeObservation(f.session, f.processResult, f.context);
    assert.equal(observed.code, 'NATIVE_MATERIALIZATION_FORMAT_UNSUPPORTED');
    assert.equal(observed.provenance.sourceMaterializations, undefined);
    assert.equal(observed.provenance.loaded, undefined);
    await assert.rejects(collectClaudeNativeProposalObservation(f.session, f.proposalResult, f.context), { code: 'NATIVE_MATERIALIZATION_FORMAT_UNSUPPORTED' });
  });
});

test('native materialization unsupported dynamic source formats never produce source proof', posixOnly, async (t) => {
  for (const [name, source] of [
    ['indexed', '$ARGUMENTS[1]'], ['positional', '$1'], ['named', '$INPUT'], ['effort', '${CLAUDE_EFFORT}'],
    ['escaped-whole', '\\$ARGUMENTS'], ['escaped-directory', '\\${CLAUDE_SKILL_DIR}'],
    ['sentinel-ffff', '￿'], ['sentinel-fffe', '￾'], ['shell-fence', '```!\nprintf inert\n```'],
    ['shell-inline', ' !`printf inert`'], ['fork-context', '---\ncontext: fork\n---\nbody'],
  ]) await t.test(name, async subtest => {
    const f = await materializationFixture(subtest, { source });
    const observed = await collectClaudeNativeObservation(f.session, f.processResult, f.context);
    assert.equal(observed.status, 'error');
    assert.equal(observed.code, 'NATIVE_MATERIALIZATION_FORMAT_UNSUPPORTED', name);
    assert.equal(observed.provenance.sourceMaterializations, undefined);
  });
});

test('native observation requires its own opt-in before authentication or owned assets', posixOnly, async () => {
  let calls = 0;
  const boundaries = { invokeClaude: async () => { calls += 1; throw new Error('No process authorized'); } };
  const result = await runClaudeLiveAcceptance({ live: true, scope: 'native-observation' }, boundaries);
  assert.equal(result.code, 'NATIVE_AUTHORIZATION_REQUIRED');
  assert.equal(result.disposableRoot, undefined);
  assert.equal(calls, 0);
  const wrongScope = await runClaudeLiveAcceptance({ live: true, scope: 'capability-probe', authorizeNativeObservation: true }, boundaries);
  assert.equal(wrongScope.code, 'NATIVE_SCOPE');
  const entry = fileURLToPath(new URL('./claude-live-runner.js', import.meta.url));
  for (const [args, code] of [
    [['--live', '--scope', 'native-observation'], 'NATIVE_AUTHORIZATION_REQUIRED'],
    [['--live', '--scope', 'native-observation', '--authorize-native-observation'], 'AUTHENTICATION_UNAVAILABLE'],
    [['--live', '--scope', 'capability-probe', '--authorize-native-observation'], 'CLI_ARGUMENTS'],
    [['--simulate', '--authorize-native-observation'], 'CLI_ARGUMENTS'],
  ]) {
    const response = await invokeClaudeProcess({ command: process.execPath, args: [entry, ...args],
      cwd: path.dirname(entry), env: { PATH: process.env.PATH }, timeoutMs: 2000 });
    assert.equal(response.status, 2);
    const report = JSON.parse(response.stdout);
    assert.equal(report.code, code);
    assert.equal(report.disposableRoot, undefined);
  }
});

test('tool-free native discovery requires distinct scope-bound authorization before owned assets', posixOnly, async () => {
  let calls = 0;
  const boundaries = { invokeClaude: async () => { calls += 1; throw new Error('No process authorized'); } };
  for (const [options, code] of [
    [{ live: true, scope: 'native-discovery' }, 'NATIVE_DISCOVERY_AUTHORIZATION_REQUIRED'],
    [{ live: true, scope: 'native-observation', authorizeNativeObservation: true, authorizeNativeDiscovery: true }, 'NATIVE_DISCOVERY_SCOPE'],
    [{ live: true, scope: 'native-defer', authorizeNativeProtocol: true, authorizeNativeDiscovery: true }, 'NATIVE_DISCOVERY_SCOPE'],
    [{ live: true, scope: 'native-discovery', authorizeNativeDiscovery: 'yes' }, 'NATIVE_DISCOVERY_SCOPE'],
  ]) {
    const result = await runClaudeLiveAcceptance(options, boundaries);
    assert.equal(result.code, code);
    assert.equal(result.disposableRoot, undefined);
  }
  assert.equal(calls, 0);
});

test('native discovery CLI authorization is singular and cannot cross into other modes', posixOnly, async () => {
  const entry = fileURLToPath(new URL('./claude-live-runner.js', import.meta.url));
  for (const [args, code] of [
    [['--live', '--scope', 'native-discovery'], 'NATIVE_DISCOVERY_AUTHORIZATION_REQUIRED'],
    [['--live', '--scope', 'native-discovery', '--authorize-native-discovery'], 'AUTHENTICATION_UNAVAILABLE'],
    [['--live', '--scope', 'native-observation', '--authorize-native-discovery'], 'CLI_ARGUMENTS'],
    [['--live', '--scope', 'native-discovery', '--authorize-native-discovery', '--authorize-native-discovery'], 'CLI_ARGUMENTS'],
    [['--simulate', '--authorize-native-discovery'], 'CLI_ARGUMENTS'],
  ]) {
    const response = await invokeClaudeProcess({ command: process.execPath, args: [entry, ...args],
      cwd: path.dirname(entry), env: { PATH: process.env.PATH }, timeoutMs: 2000 });
    assert.equal(response.status, 2);
    const report = JSON.parse(response.stdout);
    assert.equal(report.code, code);
    assert.equal(report.disposableRoot, undefined);
  }
});

test('defer/resume diagnostics require distinct authorization and cannot authorize Apply', posixOnly, async () => {
  let calls = 0;
  const boundaries = { invokeClaude: async () => { calls += 1; throw new Error('No process authorized'); } };
  for (const [options, code] of [
    [{ live: true, scope: 'native-defer' }, 'NATIVE_PROTOCOL_AUTHORIZATION_REQUIRED'],
    [{ live: true, scope: 'native-observation', authorizeNativeProtocol: true, authorizeNativeObservation: true }, 'NATIVE_PROTOCOL_SCOPE'],
    [{ live: true, scope: 'setup-proposal', authorizeNativeProtocol: true, authorizeSetupProposal: true }, 'NATIVE_PROTOCOL_SCOPE'],
  ]) {
    const result = await runClaudeLiveAcceptance(options, boundaries);
    assert.equal(result.code, code);
    assert.equal(result.disposableRoot, undefined);
  }
  assert.equal(calls, 0);
});

test('native defer resumes only the same pending canary with a deny gate, never an Apply permit (session double)', posixOnly, async () => {
  let modelCalls = 0;
  let pending;
  const result = await runClaudeLiveAcceptance({ live: true, scope: 'native-defer', authorizeNativeProtocol: true,
    claudeExecutable: process.execPath, env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: 'test-only-native-credential' } }, {
    invokeClaude: async (request) => {
      if (request.args.includes('--version')) return { status: 0, stdout: '2.1.285 (Claude Code)\n' };
      if (request.args.includes('--help')) return { status: 0, stdout: nativeFlags.join(' ') };
      modelCalls += 1;
      const arg = (flag) => request.args[request.args.indexOf(flag) + 1];
      assert.equal(arg('--tools'), 'Write');
      assert.equal(arg('--permission-mode'), 'dontAsk');
      assert.equal(request.args.includes('--bare'), false);
      assert.equal(request.args.includes('--no-session-persistence'), false);
      const settings = JSON.parse(await readFile(arg('--settings'), 'utf8'));
      const common = { session_id: request.sessionId, cwd: request.cwd };
      nativeHook(settings, request, { ...common, hook_event_name: 'SessionStart', source: modelCalls === 1 ? 'startup' : 'resume' });
      if (modelCalls === 1) {
        assert.equal(request.args.includes('--resume'), false);
        const input = JSON.parse(request.args.at(-1).match(/Canary tool input: (.+)$/)[1]);
        assert.equal(input.content, 'native-defer-boundary-canary\n');
        assert.equal(input.file_path, path.join(request.cwd, 'AGENTS.md'));
        pending = { id: 'pending_native_1', name: 'Write', input };
      } else {
        assert.equal(arg('--resume'), request.sessionId);
        assert.equal(request.args.includes('--session-id'), false);
      }
      const output = nativeHook(settings, request, { ...common, hook_event_name: 'PreToolUse', tool_use_id: pending.id,
        tool_name: pending.name, tool_input: pending.input });
      assert.equal(output.hookSpecificOutput.permissionDecision, modelCalls === 1 ? 'defer' : 'deny');
      if (modelCalls === 2) nativeHook(settings, request, { ...common, hook_event_name: 'Stop', stop_hook_active: false });
      return { status: 0, stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false,
        session_id: request.sessionId, permission_denials: [],
        ...(modelCalls === 1 ? { stop_reason: 'tool_deferred', deferred_tool_use: pending } : {}) }) + '\n' };
    },
  });
  try {
    assert.equal(modelCalls, 2);
    assert.equal(result.code, 'NATIVE_DEFER_RESUME_DENY_OBSERVED');
    assert.equal(result.status, 'blocked');
    assert.equal(result.nativeProtocol.zeroWrites, true);
    assert.equal(result.nativeProtocol.samePendingCallObserved, true);
    assert.equal(result.nativeProtocol.permissionFloorProven, false);
    assert.equal(result.nativeProtocol.applyEnabled, false);
    assert.equal(result.nativeProtocol.loaded, undefined);
    assert.equal(result.executionKind, 'test-double');
    assert.deepEqual(result.artifacts, []);
  } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
});

const nativeFlags = ['--bare', '--restricted', '--print', '--output-format', '--verbose', '--tools', '--permission-mode',
  '--permission-prompts', '--max-budget-usd', '--model', '--add-dir', '--session-id', '--no-session-persistence',
  '--strict-mcp-config', '--mcp-config', '--prompt-suggestions', '--settings', '--setting-sources', '--resume'];

function successTrace(sessionId) {
  return { status: 0, stdout: [
    { type: 'system', subtype: 'init', session_id: sessionId, tools: ['Read', 'Glob', 'Grep', 'Skill'] },
    { type: 'result', subtype: 'success', is_error: false, session_id: sessionId, permission_denials: [] },
  ].map(JSON.stringify).join('\n') + '\n' };
}

function hookCommand(settings, event) {
  return settings.hooks[event][0].hooks[0].command;
}

function nativeHook(settings, request, payload) {
  const response = spawnSync('/bin/sh', ['-c', hookCommand(settings, payload.hook_event_name)], {
    cwd: request.cwd, env: request.env, input: JSON.stringify(payload), encoding: 'utf8', timeout: 2000, maxBuffer: 65536,
  });
  assert.equal(response.error, undefined);
  assert.equal(response.status, 0, response.stderr);
  assert.equal(response.stderr, '');
  return response.stdout ? JSON.parse(response.stdout) : null;
}

async function nativeDiscoveryHook(settings, request, payload) {
  const transcript = path.join(request.env.HOME, '.claude/projects/discovery-model-double', `${request.sessionId}.jsonl`);
  if (payload.hook_event_name === 'SessionStart') await mkdir(path.dirname(transcript), { recursive: true });
  if (payload.hook_event_name === 'UserPromptExpansion') {
    const alias = path.join(request.env.HOME, '.claude/skills/agent-init');
    const lines = (await readFile(path.join(alias, 'SKILL.md'), 'utf8')).split('\n');
    // Independent known installed mother framing, not the producer renderer.
    assert.equal(lines[0], '---');
    assert.equal(lines[1], 'name: agent-init');
    assert.equal(lines[3], '---');
    assert.equal(lines[4], '');
    assert.equal(lines[5], '# Agent Init');
    assert.equal(payload.command_args, '');
    const caller = randomUUID();
    const common = { sessionId: request.sessionId, cwd: request.cwd, version: '2.1.285' };
    await writeFile(transcript, [
      { ...common, type: 'user', uuid: caller, parentUuid: null,
        message: { role: 'user', content: '<command-name>/agent-init</command-name><command-args></command-args>' } },
      { ...common, type: 'user', uuid: randomUUID(), parentUuid: caller, isMeta: true, turnCompanion: true,
        message: { role: 'user', content: [{ type: 'text', text: `Base directory for this skill: ${alias}\n\n${lines.slice(5).join('\n')}` }] } },
    ].map(JSON.stringify).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
  }
  return nativeHook(settings, request, { ...payload, transcript_path: transcript });
}

test('tool-free discovery enables only the owned user Skill source and cannot authorize model tools (session double)', posixOnly, async () => {
  let modelCalls = 0;
  const result = await runClaudeLiveAcceptance({ live: true, scope: 'native-discovery', authorizeNativeDiscovery: true,
    claudeExecutable: process.execPath, env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: 'test-only-native-credential' } }, {
    invokeClaude: async (request) => {
      if (request.args.includes('--version')) return { status: 0, stdout: '2.1.285 (Claude Code)\n' };
      if (request.args.includes('--help')) return { status: 0, stdout: nativeFlags.join(' ') };
      modelCalls += 1;
      const arg = (flag) => request.args[request.args.indexOf(flag) + 1];
      assert.equal(request.args.includes('--restricted'), false);
      assert.equal(request.args.includes('--bare'), false);
      assert.equal(arg('--tools'), '');
      assert.equal(arg('--setting-sources'), 'user');
      assert.equal(arg('--permission-mode'), 'dontAsk');
      assert.equal(arg('--permission-prompts'), 'none');
      assert.equal(arg('--mcp-config'), '{"mcpServers":{}}');
      assert.equal(request.env.CLAUDE_CONFIG_DIR, path.join(request.env.HOME, '.claude'));
      const settings = JSON.parse(await readFile(arg('--settings'), 'utf8'));
      const common = { session_id: request.sessionId, cwd: request.cwd };
      await nativeDiscoveryHook(settings, request, { ...common, hook_event_name: 'SessionStart', source: 'startup' });
      const expansion = await nativeDiscoveryHook(settings, request, { ...common, hook_event_name: 'UserPromptExpansion',
        expansion_type: 'slash_command', command_name: 'agent-init', command_args: '', command_source: 'user',
        prompt: 'private-instruction-body-omitted' });
      assert.deepEqual(expansion, {});
      await nativeDiscoveryHook(settings, request, { ...common, hook_event_name: 'Stop', stop_hook_active: false });
      return { status: 0, stdout: [
        { type: 'system', subtype: 'init', session_id: request.sessionId, tools: [] },
        { type: 'result', subtype: 'success', is_error: false, session_id: request.sessionId, permission_denials: [] },
      ].map(JSON.stringify).join('\n') + '\n' };
    },
  });
  try {
    assert.equal(modelCalls, 1);
    assert.equal(result.code, 'NATIVE_SELECTION_UNVERIFIED');
    assert.equal(result.nativeObservation.toolFree, true);
    assert.equal(result.nativeObservation.zeroWrites, true);
    assert.equal(result.nativeObservation.mutationEnabled, false);
    assert.equal(result.nativeObservation.bashEnabled, false);
    assert.equal(result.nativeObservation.loaded, undefined);
    assert.deepEqual(result.nativeObservation.provenance.trace.catalog.tools, []);
    assert.equal(result.nativeObservation.provenance.directExpansions[0].command, 'agent-init');
    assert.equal(result.nativeObservation.provenance.directExpansions[0].sourceVerified, false);
    assertMaterializationOnly(result.nativeObservation.provenance);
    assert.equal(result.nativeObservation.provenance.sourceMaterializations[0].namespace, 'user');
    assert.equal(result.nativeObservation.provenance.sourceMaterializations[0].branch, 'direct-slash');
    assert.equal(JSON.stringify(result).includes('private-instruction-body-omitted'), false);
    assert.equal(result.executionKind, 'test-double');
    assert.deepEqual(result.artifacts, []);
  } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
});

test('tool-free discovery rejects tool-capable envelopes and any native tool attempt (session double)', posixOnly, async (t) => {
  for (const scenario of ['catalog', 'attempt', 'missing-expansion']) await t.test(scenario, async () => {
    const result = await runClaudeLiveAcceptance({ live: true, scope: 'native-discovery', authorizeNativeDiscovery: true,
      claudeExecutable: process.execPath, env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: 'test-only-native-credential' } }, {
      invokeClaude: async (request) => {
        if (request.args.includes('--version')) return { status: 0, stdout: '2.1.285 (Claude Code)\n' };
        if (request.args.includes('--help')) return { status: 0, stdout: nativeFlags.join(' ') };
        const settings = JSON.parse(await readFile(request.args[request.args.indexOf('--settings') + 1], 'utf8'));
        const common = { session_id: request.sessionId, cwd: request.cwd };
        await nativeDiscoveryHook(settings, request, { ...common, hook_event_name: 'SessionStart', source: 'startup' });
        if (scenario === 'attempt') {
          const denied = await nativeDiscoveryHook(settings, request, { ...common, hook_event_name: 'PreToolUse', tool_use_id: 'forbidden_read_1',
            tool_name: 'Read', tool_input: { file_path: path.join(request.cwd, 'pom.xml') } });
          assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
          assert.equal(denied.hookSpecificOutput.permissionDecisionReason, 'NATIVE_DISCOVERY_TOOL_DENIED');
        }
        if (scenario !== 'missing-expansion') await nativeDiscoveryHook(settings, request, { ...common, hook_event_name: 'UserPromptExpansion',
          expansion_type: 'slash_command', command_name: 'agent-init', command_args: '', command_source: 'user', prompt: 'opaque body' });
        await nativeDiscoveryHook(settings, request, { ...common, hook_event_name: 'Stop', stop_hook_active: false });
        return { status: 0, stdout: [
          { type: 'system', subtype: 'init', session_id: request.sessionId, tools: scenario === 'catalog' ? ['Read'] : [] },
          { type: 'result', subtype: 'success', is_error: false, session_id: request.sessionId, permission_denials: [] },
        ].map(JSON.stringify).join('\n') + '\n' };
      },
    });
    try {
      assert.equal(result.code, { catalog: 'NATIVE_DISCOVERY_TOOLS_PRESENT', attempt: 'NATIVE_DISCOVERY_TOOL_DENIED',
        'missing-expansion': 'NATIVE_SKILL_OBSERVATION_MISSING' }[scenario]);
      assert.equal(result.status, 'error');
      assert.equal(result.nativeObservation.loaded, undefined);
      assert.deepEqual(result.artifacts, []);
    } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
  });
});

test('native observation uses only owned invocation settings and records expansion without claiming loaded (session double)', posixOnly, async () => {
  const calls = [];
  const result = await runClaudeLiveAcceptance({ live: true, scope: 'native-observation', authorizeNativeObservation: true,
    claudeExecutable: process.execPath, env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: 'test-only-native-credential' } }, {
    invokeClaude: async (request) => {
      calls.push(request);
      if (request.args.includes('--version')) return { status: 0, stdout: '2.1.285 (Claude Code)\n' };
      if (request.args.includes('--help')) return { status: 0, stdout: nativeFlags.join(' ') };
      const arg = (flag) => request.args[request.args.indexOf(flag) + 1];
      assert.equal(request.args.includes('--bare'), false);
      assert.equal(request.args.includes('--no-session-persistence'), false);
      assert.equal(arg('--tools'), 'Read,Glob,Grep,Skill');
      assert.equal(arg('--setting-sources'), '');
      assert.equal(arg('--permission-mode'), 'dontAsk');
      assert.equal(arg('--permission-prompts'), 'none');
      assert.equal(arg('--strict-mcp-config'), '--mcp-config');
      assert.equal(arg('--mcp-config'), '{"mcpServers":{}}');
      const settingsFile = arg('--settings');
      assert.equal((await lstat(settingsFile)).mode & 0o777, 0o600);
      const settings = JSON.parse(await readFile(settingsFile, 'utf8'));
      assert.equal(settings.sandbox.autoAllowBashIfSandboxed, false);
      assert.equal(JSON.stringify(settings).includes('test-only-native-credential'), false);
      const common = { session_id: request.sessionId, cwd: request.cwd, transcript_path: path.join(request.env.HOME, 'owned-transcript.jsonl') };
      nativeHook(settings, request, { ...common, hook_event_name: 'SessionStart', source: 'startup' });
      nativeHook(settings, request, { ...common, hook_event_name: 'UserPromptExpansion', expansion_type: 'slash_command',
        command_name: 'agent-init', command_args: '', command_source: 'project', prompt: 'PRIVATE_BODY_NOT_FOR_EVIDENCE' });
      const denied = nativeHook(settings, request, { ...common, hook_event_name: 'PreToolUse', tool_use_id: 'attempt_1', tool_name: 'Write',
        tool_input: { file_path: path.join(request.cwd, 'AGENTS.md'), content: 'PRIVATE_WRITE_NOT_FOR_EVIDENCE' } });
      assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
      nativeHook(settings, request, { ...common, hook_event_name: 'Stop', stop_hook_active: false });
      return successTrace(request.sessionId);
    },
  });
  try {
    assert.equal(calls.length, 3);
    assert.equal(result.code, 'NATIVE_MUTATION_DENIED');
    assert.equal(result.executionKind, 'test-double');
    assert.equal(result.nativeObservation.zeroWrites, true);
    assert.equal(result.nativeObservation.provenance.directExpansions.length, 1);
    assert.equal(result.nativeObservation.provenance.directExpansions[0].command, 'agent-init');
    assert.equal(result.nativeObservation.provenance.directExpansions[0].sourceVerified, false);
    assert.equal(result.nativeObservation.provenance.directExpansions[0].sourceSample, 'project');
    assert.equal(result.nativeObservation.loaded, undefined);
    assert.deepEqual(result.artifacts, []);
    assert.equal(result.liveSkillBehaviorProven, false);
    const report = await readFile(path.join(result.disposableRoot, 'evidence/claude-live/report.json'), 'utf8');
    for (const privateValue of ['PRIVATE_BODY_NOT_FOR_EVIDENCE', 'PRIVATE_WRITE_NOT_FOR_EVIDENCE', 'test-only-native-credential']) {
      assert.equal(report.includes(privateValue), false);
    }
    await assert.rejects(lstat(path.join(calls.at(-1).cwd, 'AGENTS.md')), { code: 'ENOENT' });
  } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
});

test('a stalled native Hook emits one static failure and cannot become empty selection evidence', posixOnly, async () => {
  const result = await runClaudeLiveAcceptance({ live: true, scope: 'native-observation', authorizeNativeObservation: true,
    claudeExecutable: process.execPath, env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: 'test-only-native-credential' } }, {
    invokeClaude: async (request) => {
      if (request.args.includes('--version')) return { status: 0, stdout: '2.1.285 (Claude Code)\n' };
      if (request.args.includes('--help')) return { status: 0, stdout: nativeFlags.join(' ') };
      const settings = JSON.parse(await readFile(request.args[request.args.indexOf('--settings') + 1], 'utf8'));
      const response = await new Promise((resolve, reject) => {
        const child = spawn('/bin/sh', ['-c', hookCommand(settings, 'PreToolUse')], { cwd: request.cwd, env: request.env,
          detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
        let output = '';
        let stderr = '';
        const timer = setTimeout(() => { process.kill(-child.pid, 'SIGKILL'); reject(new Error('Hook test exceeded its bound')); }, 6000);
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk) => { output += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.stdin.on('error', () => {});
        child.on('error', reject);
        child.on('close', (status) => { clearTimeout(timer); resolve({ status, output, stderr }); });
        child.stdin.write('{"privateField":"PRIVATE_BODY_NOT_FOR_EVIDENCE"');
      });
      assert.equal(response.status, 0);
      assert.equal(response.stderr, '');
      assert.deepEqual(response.output.trim().split('\n').map(JSON.parse), [{ continue: false, stopReason: 'NATIVE_HOOK_INPUT_TIMEOUT' }]);
      return successTrace(request.sessionId);
    },
  });
  try {
    assert.equal(result.code, 'NATIVE_EVENTS_MISSING');
    assert.equal(result.nativeObservation.loaded, undefined);
    assert.equal(JSON.stringify(result).includes('PRIVATE_BODY_NOT_FOR_EVIDENCE'), false);
  } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
});

test('configured credential identifiers are rejected before native journal retention, without passing auth to the helper', posixOnly, async () => {
  const credential = 'SYNTHETICCANARY0123456789';
  const result = await runClaudeLiveAcceptance({ live: true, scope: 'native-observation', authorizeNativeObservation: true,
    claudeExecutable: process.execPath, env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: credential } }, {
    invokeClaude: async (request) => {
      if (request.args.includes('--version')) return { status: 0, stdout: '2.1.285 (Claude Code)\n' };
      if (request.args.includes('--help')) return { status: 0, stdout: nativeFlags.join(' ') };
      const settings = JSON.parse(await readFile(request.args[request.args.indexOf('--settings') + 1], 'utf8'));
      const common = { session_id: request.sessionId, cwd: request.cwd };
      nativeHook(settings, request, { ...common, hook_event_name: 'SessionStart', source: 'startup' });
      const output = nativeHook(settings, request, { ...common, hook_event_name: 'PreToolUse', tool_use_id: `call_${credential}_1`,
        tool_name: 'Skill', tool_input: { skill: 'agent-init' } });
      assert.equal(output.continue, false);
      assert.equal(output.stopReason, 'SECRET_TRACE');
      return successTrace(request.sessionId);
    },
  });
  try {
    assert.equal(result.code, 'SECRET_TRACE');
    assert.equal(result.nativeObservation.loaded, undefined);
    assert.equal(JSON.stringify(result).includes(credential), false);
  } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
});

test('recognizable GitHub PAT identifiers never enter native event provenance', posixOnly, async (t) => {
  const credential = 'github_pat_SYNTHETICCANARY0123456789';
  for (const field of ['call-id', 'source-label']) await t.test(field, async () => {
    const result = await runClaudeLiveAcceptance({ live: true, scope: 'native-observation', authorizeNativeObservation: true,
      claudeExecutable: process.execPath, env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: 'unrelated-synthetic-credential' } }, {
      invokeClaude: async (request) => {
        if (request.args.includes('--version')) return { status: 0, stdout: '2.1.285 (Claude Code)\n' };
        if (request.args.includes('--help')) return { status: 0, stdout: nativeFlags.join(' ') };
        const settings = JSON.parse(await readFile(request.args[request.args.indexOf('--settings') + 1], 'utf8'));
        const common = { session_id: request.sessionId, cwd: request.cwd };
        nativeHook(settings, request, { ...common, hook_event_name: 'SessionStart', source: 'startup' });
        const response = nativeHook(settings, request, field === 'call-id'
          ? { ...common, hook_event_name: 'PreToolUse', tool_use_id: credential, tool_name: 'Skill', tool_input: { skill: 'agent-init' } }
          : { ...common, hook_event_name: 'UserPromptExpansion', expansion_type: 'slash_command', command_name: 'agent-init', command_source: credential });
        if (field === 'call-id') {
          assert.equal(response.continue, false);
          assert.equal(response.stopReason, 'NATIVE_CALL_INVALID');
        } else nativeHook(settings, request, { ...common, hook_event_name: 'Stop', stop_hook_active: false });
        const control = path.dirname(request.args[request.args.indexOf('--settings') + 1]);
        assert.equal((await readFile(path.join(control, 'events.jsonl'), 'utf8')).includes(credential), false);
        return successTrace(request.sessionId);
      },
    });
    try {
      assert.equal(result.code, field === 'call-id' ? 'NATIVE_CALL_INVALID' : 'NATIVE_SELECTION_UNVERIFIED');
      assert.equal(JSON.stringify(result).includes(credential), false);
      if (field === 'source-label') assert.equal(result.nativeObservation.provenance.directExpansions[0].sourceOmitted, true);
    } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
  });
});

test('a healthy positive observation with no Skill or direct expansion is an explicit missing-event outcome', posixOnly, async () => {
  const result = await runClaudeLiveAcceptance({ live: true, scope: 'native-observation', authorizeNativeObservation: true,
    claudeExecutable: process.execPath, env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: 'test-only-native-credential' } }, {
    invokeClaude: async (request) => {
      if (request.args.includes('--version')) return { status: 0, stdout: '2.1.285 (Claude Code)\n' };
      if (request.args.includes('--help')) return { status: 0, stdout: nativeFlags.join(' ') };
      const settings = JSON.parse(await readFile(request.args[request.args.indexOf('--settings') + 1], 'utf8'));
      const common = { session_id: request.sessionId, cwd: request.cwd };
      nativeHook(settings, request, { ...common, hook_event_name: 'SessionStart', source: 'startup' });
      nativeHook(settings, request, { ...common, hook_event_name: 'Stop', stop_hook_active: false });
      return successTrace(request.sessionId);
    },
  });
  try {
    assert.equal(result.code, 'NATIVE_SKILL_OBSERVATION_MISSING');
    assert.equal(result.status, 'error');
    assert.equal(result.nativeObservation.loaded, undefined);
    assert.equal(result.nativeObservation.provenance.lifecycleObserved.starts, 1);
    assert.equal(result.nativeObservation.provenance.lifecycleObserved.stops, 1);
    assert.equal(result.liveSkillBehaviorProven, false);
  } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
});

test('opaque Skill response bodies cannot block independent native completion evidence (session double)', posixOnly, async () => {
  const result = await runClaudeLiveAcceptance({ live: true, scope: 'native-observation', authorizeNativeObservation: true,
    claudeExecutable: process.execPath, env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: 'test-only-native-credential' } }, {
    invokeClaude: async (request) => {
      if (request.args.includes('--version')) return { status: 0, stdout: '2.1.285 (Claude Code)\n' };
      if (request.args.includes('--help')) return { status: 0, stdout: nativeFlags.join(' ') };
      const settings = JSON.parse(await readFile(request.args[request.args.indexOf('--settings') + 1], 'utf8'));
      const common = { session_id: request.sessionId, cwd: request.cwd };
      const input = { skill: 'agent-init' };
      const body = 'PRIVATE_BODY_NOT_FOR_EVIDENCE configuration and authentication instructions';
      nativeHook(settings, request, { ...common, hook_event_name: 'SessionStart', source: 'startup' });
      nativeHook(settings, request, { ...common, hook_event_name: 'PreToolUse', tool_use_id: 'call_1', tool_name: 'Skill', tool_input: input });
      nativeHook(settings, request, { ...common, hook_event_name: 'PostToolUse', tool_use_id: 'call_1', tool_name: 'Skill',
        tool_input: input, tool_response: body });
      nativeHook(settings, request, { ...common, hook_event_name: 'Stop', stop_hook_active: false });
      const messages = successTrace(request.sessionId).stdout.trim().split('\n').map(JSON.parse);
      messages.splice(1, 0,
        { type: 'assistant', session_id: request.sessionId, message: { content: [{ type: 'tool_use', id: 'call_1', name: 'Skill', input }] } },
        { type: 'user', session_id: request.sessionId, message: { content: [{ type: 'tool_result', tool_use_id: 'call_1', content: body }] } });
      return { status: 0, stdout: messages.map(JSON.stringify).join('\n') + '\n' };
    },
  });
  try {
    assert.equal(result.code, 'NATIVE_SELECTION_UNVERIFIED');
    assert.equal(result.nativeObservation.provenance.toolCompletions.length, 1);
    assert.equal(result.nativeObservation.provenance.toolCompletions[0].command, 'agent-init');
    assert.equal(result.nativeObservation.loaded, undefined);
    assert.equal(JSON.stringify(result).includes('PRIVATE_BODY_NOT_FOR_EVIDENCE'), false);
  } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
});

test('native completion must match a tool call in the same process trace, not just a Hook pair', posixOnly, async () => {
  const result = await runClaudeLiveAcceptance({ live: true, scope: 'native-observation', authorizeNativeObservation: true,
    claudeExecutable: process.execPath, env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: 'test-only-native-credential' } }, {
    invokeClaude: async (request) => {
      if (request.args.includes('--version')) return { status: 0, stdout: '2.1.285 (Claude Code)\n' };
      if (request.args.includes('--help')) return { status: 0, stdout: nativeFlags.join(' ') };
      const settings = JSON.parse(await readFile(request.args[request.args.indexOf('--settings') + 1], 'utf8'));
      const common = { session_id: request.sessionId, cwd: request.cwd };
      nativeHook(settings, request, { ...common, hook_event_name: 'SessionStart', source: 'startup' });
      const tool = { ...common, tool_use_id: 'call_1', tool_name: 'Skill', tool_input: { skill: 'agent-init' } };
      nativeHook(settings, request, { ...tool, hook_event_name: 'PreToolUse' });
      nativeHook(settings, request, { ...tool, hook_event_name: 'PostToolUse', tool_response: 'Completed native Skill loading' });
      nativeHook(settings, request, { ...common, hook_event_name: 'Stop', stop_hook_active: false });
      return successTrace(request.sessionId);
    },
  });
  try {
    assert.equal(result.code, 'NATIVE_TRACE_MISMATCH');
    assert.equal(result.nativeObservation.loaded, undefined);
    assert.equal(result.liveSkillBehaviorProven, false);
  } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
});

test('native diagnostics keep missing Hooks, invalid deferred calls, parallel calls and real deltas non-pass', posixOnly, async (t) => {
  for (const [scenario, code, expectedCalls] of [
    ['missing-hooks', 'NATIVE_EVENTS_MISSING', 1],
    ['changed-deferred-input', 'NATIVE_DEFER_MISMATCH', 1],
    ['pat-deferred-id', 'NATIVE_DEFER_MISMATCH', 1],
    ['parallel-defer', 'NATIVE_DEFER_MISMATCH', 1],
    ['ignored-defer-wrote-file', 'UNAPPROVED_WRITES', 1],
    ['wrong-resume-id', 'NATIVE_RESUME_MISMATCH', 2],
    ['unsafe-result-number', 'NATIVE_RESULT_INVALID', 1],
    ['escaped-secret-result', 'SECRET_TRACE', 1],
    ['shadowed-secret-result', 'SECRET_TRACE', 1],
  ]) await t.test(scenario, async () => {
    let modelCalls = 0;
    let pending;
    const credential = 'SYNTHETICCANARY0123456789';
    const result = await runClaudeLiveAcceptance({ live: true, scope: 'native-defer', authorizeNativeProtocol: true,
      claudeExecutable: process.execPath, env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: credential } }, {
      invokeClaude: async (request) => {
        if (request.args.includes('--version')) return { status: 0, stdout: '2.1.285 (Claude Code)\n' };
        if (request.args.includes('--help')) return { status: 0, stdout: nativeFlags.join(' ') };
        modelCalls += 1;
        const settings = JSON.parse(await readFile(request.args[request.args.indexOf('--settings') + 1], 'utf8'));
        const common = { session_id: request.sessionId, cwd: request.cwd };
        if (modelCalls === 1) pending = { id: 'pending_1', name: 'Write', input: JSON.parse(request.args.at(-1).match(/Canary tool input: (.+)$/)[1]) };
        if (scenario !== 'missing-hooks') {
          nativeHook(settings, request, { ...common, hook_event_name: 'SessionStart', source: modelCalls === 1 ? 'startup' : 'resume' });
          const callId = scenario === 'wrong-resume-id' && modelCalls === 2 ? 'different_call' : pending.id;
          nativeHook(settings, request, { ...common, hook_event_name: 'PreToolUse', tool_use_id: callId,
            tool_name: pending.name, tool_input: pending.input });
          if (scenario === 'parallel-defer') nativeHook(settings, request, { ...common, hook_event_name: 'PreToolUse',
            tool_use_id: 'parallel_2', tool_name: pending.name, tool_input: pending.input });
        }
        if (scenario === 'ignored-defer-wrote-file') await writeFile(pending.input.file_path, pending.input.content);
        if (scenario === 'pat-deferred-id') pending = { ...pending, id: 'github_pat_OTHER_SYNTHETICCANARY9876543210' };
        let response = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: request.sessionId,
          permission_denials: [], ...(modelCalls === 1 ? { stop_reason: 'tool_deferred', deferred_tool_use:
            scenario === 'changed-deferred-input' ? { ...pending, input: { ...pending.input, content: 'changed bytes' } } : pending } : {}) });
        if (scenario === 'unsafe-result-number') response = response.slice(0, -1) + ',"opaque":1e400}';
        if (['escaped-secret-result', 'shadowed-secret-result'].includes(scenario)) response = response.slice(0, -1) + ',"opaque":"' +
          [...credential].map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).join('') +
          (scenario === 'shadowed-secret-result' ? '","opaque":"public"}' : '"}');
        return { status: 0, stdout: `${response}\n` };
      },
    });
    try {
      assert.equal(modelCalls, expectedCalls);
      assert.equal(result.code, code);
      assert.notEqual(result.status, 'pass');
      assert.equal(result.liveSkillBehaviorProven, false);
      assert.deepEqual(result.artifacts, []);
      assert.equal(result.nativeProtocol?.loaded, undefined);
      assert.equal(JSON.stringify(result).includes(credential), false);
    } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
  });
});

test('native CLI authorization is scoped, singular and cannot import a permit or approve a Proposal', posixOnly, async () => {
  const entry = fileURLToPath(new URL('./claude-live-runner.js', import.meta.url));
  for (const [args, code] of [
    [['--live', '--scope', 'native-defer'], 'NATIVE_PROTOCOL_AUTHORIZATION_REQUIRED'],
    [['--live', '--scope', 'native-defer', '--authorize-native-protocol'], 'AUTHENTICATION_UNAVAILABLE'],
    [['--live', '--scope', 'native-defer', '--authorize-native-protocol', '--authorize-native-protocol'], 'CLI_ARGUMENTS'],
    [['--simulate', '--authorize-native-protocol'], 'CLI_ARGUMENTS'],
    [['--live', '--scope', 'native-observation', '--authorize-native-protocol'], 'CLI_ARGUMENTS'],
    [['--live', '--scope', 'native-defer', '--authorize-native-protocol', '--request-proposal-approval'], 'CLI_ARGUMENTS'],
    [['--live', '--scope', 'native-defer', '--authorize-native-protocol', '--permit', 'fake.json'], 'CLI_ARGUMENTS'],
  ]) {
    const response = await invokeClaudeProcess({ command: process.execPath, args: [entry, ...args],
      cwd: path.dirname(entry), env: { PATH: process.env.PATH }, timeoutMs: 2000 });
    assert.equal(response.status, 2);
    assert.equal(JSON.parse(response.stdout).code, code);
    assert.equal(JSON.parse(response.stdout).disposableRoot, undefined);
  }
});
