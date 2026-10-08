import assert from 'node:assert/strict';
import test from 'node:test';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { digestTree } from '../../src/installation/filesystem.js';

import { copyTree } from '../../src/installation/filesystem.js';
import { invokeClaudeProcess, prepareClaudeRoutingInputs, runClaudeLiveAcceptance } from './claude-live-runner.js';

const posixOnly = { skip: process.platform === 'win32' ? 'owned POSIX process groups are unavailable' : false };

test('live execution requires explicit opt-in and separate capability-probe scope', async () => {
  let calls = 0;
  const invokeClaude = async () => { calls += 1; throw new Error('must not run'); };
  for (const [options, code] of [
    [{}, 'LIVE_OPT_IN_REQUIRED'],
    [{ live: true }, 'LIVE_SCOPE_REQUIRED'],
    [{ live: true, scope: 'full-corpus' }, 'LIVE_SCOPE_REQUIRED'],
    [{ live: true, scope: 'capability-probe', env: {} }, process.platform === 'win32' ? 'PROCESS_TREE_UNSUPPORTED' : 'AUTHENTICATION_UNAVAILABLE'],
  ]) {
    const result = await runClaudeLiveAcceptance(options, { invokeClaude });
    assert.equal(result.status, 'blocked');
    assert.equal(result.code, code);
    assert.deepEqual(result.artifacts, []);
    assert.equal(result.disposableRoot, undefined);
  }
  assert.equal(calls, 0);
});

test('unsupported platforms keep the default suite offline (Node platform double)', posixOnly, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'claude-platform-double-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = `Object.defineProperty(process,'platform',{value:'win32'});import(${JSON.stringify(import.meta.url)})`;
  const result = await invokeClaudeProcess({ command: process.execPath, args: ['-e', script], cwd: root,
    env: { PATH: process.env.PATH, TEMP: root }, timeoutMs: 10000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /(?:# skip|ℹ skipped) 15\b/);
  assert.equal(result.stdout.includes('PROCESS_TREE_UNSUPPORTED'), false);
});

test('process boundary preserves failures, kills bounded work and never evaluates shell syntax', posixOnly, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'claude-process-double-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const request = { command: process.execPath, cwd: root, env: { PATH: process.env.PATH }, timeoutMs: 2000 };
  const argument = 'literal; touch should-not-exist';
  const literal = await invokeClaudeProcess({ ...request, args: ['-e', 'process.stdout.write(process.argv[1])', '--', argument] });
  assert.equal(literal.stdout, argument);
  await assert.rejects(lstat(path.join(root, 'should-not-exist')), { code: 'ENOENT' });
  const unavailable = await invokeClaudeProcess({ ...request, command: path.join(root, 'missing'), args: [] });
  assert.equal(unavailable.status, null);
  assert.ok(unavailable.spawnError);
  const failed = await invokeClaudeProcess({ ...request, args: ['-e', 'process.exit(7)'] });
  assert.equal(failed.status, 7);
  const timeout = await invokeClaudeProcess({ ...request, args: ['-e', 'setInterval(() => {}, 100)'], timeoutMs: 50 });
  assert.equal(timeout.timedOut, true);
  const truncated = await invokeClaudeProcess({ ...request, args: ['-e', 'process.stdout.write("x".repeat(2048));setInterval(() => {}, 100)'], maxOutputBytes: 64 });
  assert.equal(truncated.truncated, true);
  const retry = await invokeClaudeProcess({ ...request, args: ['-e', 'process.stdout.write(JSON.stringify({type:"system",subtype:"api_retry"})+"\\n");setInterval(() => {}, 100)'], stopOnRetry: true });
  assert.equal(retry.stopReason, 'API_RETRY');
  const malformed = await invokeClaudeProcess({ ...request, args: ['-e', 'process.stdout.write("bad-json\\n");setInterval(() => {}, 100)'], stopOnRetry: true });
  assert.equal(malformed.stopReason, 'TRACE_MALFORMED');
  const unownedRead = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'read-call', name: 'Read', input: { opaque: '/unowned/read' } }] } });
  const outside = await invokeClaudeProcess({ ...request, args: ['-e', `process.stdout.write(${JSON.stringify(unownedRead)}+"\\n");setInterval(()=>{},100)`],
    stopOnRetry: true, readRoots: [root] });
  assert.equal(outside.stopReason, 'READ_SCOPE_UNVERIFIED');
  const failedTool = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', is_error: true }] } });
  const toolFailure = await invokeClaudeProcess({ ...request, args: ['-e', `process.stdout.write(${JSON.stringify(failedTool)}+"\\n");setInterval(()=>{},100)`], stopOnRetry: true });
  assert.equal(toolFailure.stopReason, 'TOOL_FAILED');
  const synchronousFailure = await invokeClaudeProcess({ ...request, command: null, args: [] });
  assert.ok(synchronousFailure.spawnError);
});

test('timeout stops the owned process group even when a descendant holds output pipes', posixOnly, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'claude-descendant-double-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = 'const {spawn}=require("node:child_process");spawn(process.execPath,["-e","setTimeout(()=>process.stdout.write(\\"late descendant\\"),1800)"],{stdio:["ignore",process.stdout,process.stderr]});setInterval(()=>{},100)';
  const started = Date.now();
  const result = await invokeClaudeProcess({ command: process.execPath, args: ['-e', script], cwd: root,
    env: { PATH: process.env.PATH }, timeoutMs: 200 });
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 1500, 'a descendant must not extend the process deadline');
  assert.equal(result.stdout.includes('late descendant'), false);
});

test('an early failed parent cannot leave an owned descendant running', posixOnly, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'claude-early-exit-double-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = 'const {spawn}=require("node:child_process");const child=spawn(process.execPath,["-e","setTimeout(()=>{},1200)"],{stdio:"ignore"});process.stdout.write(String(child.pid));process.exit(7)';
  const result = await invokeClaudeProcess({ command: process.execPath, args: ['-e', script], cwd: root,
    env: { PATH: process.env.PATH }, timeoutMs: 200 });
  assert.equal(result.status, 7, JSON.stringify({ status: result.status, signal: result.signal,
    spawnError: result.spawnError?.code, timedOut: result.timedOut, stopReason: result.stopReason }));
  const descendant = Number(result.stdout);
  assert.ok(Number.isSafeInteger(descendant) && descendant > 0);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.throws(() => process.kill(descendant, 0), { code: 'ESRCH' });
});

test('process cleanup errors preserve the actual exit code and remain separate non-pass facts', posixOnly, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'claude-cleanup-error-double-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const originalKill = process.kill;
  t.mock.method(process, 'kill', (pid, signal) => {
    if (pid < 0) throw Object.assign(new Error('synthetic group cleanup refusal'), { code: 'EPERM' });
    return originalKill(pid, signal);
  });
  // This child has no descendants; the OS-boundary double cannot leak work.
  const result = await invokeClaudeProcess({ command: process.execPath, args: ['-e', 'process.exit(7)'], cwd: root,
    env: { PATH: process.env.PATH }, timeoutMs: 2000 });
  assert.equal(result.status, 7);
  assert.equal(result.spawnError, undefined);
  assert.deepEqual(result.cleanupError, { code: 'EPERM', signal: 'SIGKILL' });
});

test('deep trace input stops the owned process instead of overflowing the monitor', posixOnly, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'claude-deep-trace-double-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const envelope = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'deep-call', name: 'Read', input: 'deep-placeholder' }] } });
  const script = `const input='{"nested":'.repeat(12000)+'null'+'}'.repeat(12000);process.stdout.write(${JSON.stringify(envelope)}.replace('"deep-placeholder"',input)+'\\n');setTimeout(()=>{},1200)`;
  const result = await invokeClaudeProcess({ command: process.execPath, args: ['-e', script], cwd: root,
    env: { PATH: process.env.PATH }, stopOnRetry: true, readRoots: [root], timeoutMs: 2000 });
  assert.equal(result.stopReason, 'TRACE_COMPLEXITY_LIMIT');
  assert.equal(result.timedOut, false);
  assert.notEqual(result.status, 0);
});

test('unexpected monitor errors stop the child and remain an explicit failure', posixOnly, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'claude-monitor-error-double-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const event = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'read-call', name: 'Read', input: { opaque: '/unowned' } }] } });
  const result = await invokeClaudeProcess({ command: process.execPath,
    args: ['-e', `process.stdout.write(${JSON.stringify(event)}+'\\n');setTimeout(()=>{},1200)`], cwd: root,
    env: { PATH: process.env.PATH }, stopOnRetry: true, readRoots: [null], timeoutMs: 2000 });
  assert.equal(result.stopReason, 'TRACE_MONITOR_FAILED');
  assert.equal(result.timedOut, false);
  assert.notEqual(result.status, 0);
});

test('malformed generic tool calls stop immediately without guessing Skill input fields', posixOnly, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'claude-tool-shape-double-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const block of [
    { type: 'tool_use', name: 'Skill', input: {} },
    { type: 'tool_use', id: '', name: 'Skill', input: {} },
    { type: 'tool_use', id: 'call-1', name: 'Skill' },
    { type: 'tool_use', id: 'call-1', name: 'Skill', input: null },
    { type: 'tool_use', id: 'call-1', name: 'Skill', input: [] },
    { type: 'tool_use', id: 'call-1', name: 'Skill', input: 42 },
  ]) {
    const event = JSON.stringify({ type: 'assistant', message: { content: [block] } });
    const result = await invokeClaudeProcess({ command: process.execPath,
      args: ['-e', `process.stdout.write(${JSON.stringify(event)}+'\\n');setTimeout(()=>{},1200)`], cwd: root,
      env: { PATH: process.env.PATH }, stopOnRetry: true, timeoutMs: 2000 });
    assert.equal(result.stopReason, 'TOOL_CALL_MALFORMED');
    assert.equal(result.timedOut, false);
    assert.notEqual(result.status, 0);
  }
});

test('read monitoring accepts owned canonical aliases but stops relative symlink escapes', posixOnly, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'claude-read-scope-double-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const owned = path.join(root, 'owned');
  const outside = path.join(root, 'outside');
  const alias = path.join(root, 'alias');
  await Promise.all([mkdir(owned), mkdir(outside)]);
  await writeFile(path.join(owned, 'fixture.txt'), 'synthetic owned fixture');
  await writeFile(path.join(outside, 'private.txt'), 'synthetic unowned data');
  await writeFile(path.join(root, 'fixture.txt'), 'synthetic unowned parent');
  await symlink(owned, alias);
  await symlink(outside, path.join(owned, 'external-link'));
  const invokeRead = (reference) => {
    const event = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'read-call', name: 'Read', input: { opaque: reference } }] } });
    return invokeClaudeProcess({ command: process.execPath, args: ['-e', `process.stdout.write(${JSON.stringify(event)}+'\\n');setTimeout(()=>{},300)`],
      cwd: alias, env: { PATH: process.env.PATH }, readRoots: [alias], stopOnRetry: true, timeoutMs: 2000 });
  };
  const canonicalOwned = await invokeRead(await realpath(path.join(alias, 'fixture.txt')));
  assert.equal(canonicalOwned.status, 0);
  assert.equal(canonicalOwned.stopReason, undefined);
  const escape = await invokeRead('external-link/private.txt');
  assert.equal(escape.stopReason, 'READ_SCOPE_UNVERIFIED');
  assert.notEqual(escape.status, 0);
  // The OS resolves the symlink before '..'; lexical normalization is not proof.
  assert.equal(await readFile(`${owned}/external-link/../fixture.txt`, 'utf8'), 'synthetic unowned parent');
  const parentEscape = await invokeRead('external-link/../fixture.txt');
  assert.equal(parentEscape.stopReason, 'READ_SCOPE_UNVERIFIED');
  assert.notEqual(parentEscape.status, 0);
});

test('an envelope without a valid type stops realtime monitoring as malformed', posixOnly, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'claude-envelope-double-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const event of [{}, { type: null }, { type: '' }, { type: ' ' }, { type: 7 }]) {
    const result = await invokeClaudeProcess({ command: process.execPath,
      args: ['-e', `process.stdout.write(${JSON.stringify(JSON.stringify(event))}+'\\n');setTimeout(()=>{},1200)`], cwd: root,
      env: { PATH: process.env.PATH }, stopOnRetry: true, timeoutMs: 2000 });
    assert.equal(result.stopReason, 'TRACE_MALFORMED');
    assert.notEqual(result.status, 0);
  }
});

test('the executable entrypoint stays offline by default and rejects unknown live scopes', posixOnly, async () => {
  const command = fileURLToPath(new URL('./claude-live-runner.js', import.meta.url));
  for (const args of [[], ['--live', '--scope', 'full-corpus'], ['--live', '--unexpected']]) {
    const result = await invokeClaudeProcess({ command: process.execPath, args: [command, ...args],
      cwd: path.dirname(command), env: { PATH: process.env.PATH }, timeoutMs: 2000 });
    assert.notEqual(result.status, 0);
    const outcome = JSON.parse(result.stdout);
    assert.equal(outcome.status, 'blocked');
    assert.deepEqual(outcome.artifacts, []);
    assert.equal(outcome.disposableRoot, undefined);
  }
});

const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
const baseSha = 'e5097877fa4172c8b2eb27b394aff374803b42fe';
const syntheticKey = 'test-only-not-a-real-api-key';
const supportedHelp = '--bare --restricted --print --output-format --verbose --tools --permission-mode --permission-prompts --max-budget-usd --model --add-dir --session-id --no-session-persistence --strict-mcp-config --mcp-config --prompt-suggestions';

function syntheticClaude(request) {
  if (request.args.includes('--version')) return { status: 0, stdout: '2.1.285 (Claude Code)\n' };
  if (request.args.includes('--help')) return { status: 0, stdout: supportedHelp };
  const id = request.args[request.args.indexOf('--session-id') + 1];
  const events = [
    { type: 'system', subtype: 'init', session_id: id, skills: ['agent-init'], tools: ['Read', 'Glob', 'Grep', 'Skill'] },
    { type: 'result', subtype: 'success', session_id: id, is_error: false, permission_denials: [], total_cost_usd: 0.01, result: 'Synthetic unapproved Proposal; not live evidence.' },
  ];
  return { status: 0, signal: null, stdout: `${events.map((event) => JSON.stringify(event)).join('\n')}\n` };
}

test('routing preparation binds full contributor sets and separates explicit variant probes (synthetic assets)', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'claude-inputs-double-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixtureIds = ['03-node-pnpm', '11-maven-multi-module-build-verify', '12-flyway-database-migration', '13-audit-log', '14-redis-no-skill', '15-deployment'];
  const names = ['build-verify', 'build-verify', 'database-migration', 'audit-log', null, 'deployment'];
  const fixtureRoots = {};
  const generatedSkillsByFixture = {};
  const motherSkillRoot = path.join(root, 'mother');
  await copyTree(path.join(projectRoot, 'skills/agent-init'), motherSkillRoot);
  for (const [index, id] of fixtureIds.entries()) {
    fixtureRoots[id] = path.join(root, id);
    await copyTree(path.join(projectRoot, 'tests/fixtures', id), fixtureRoots[id]);
    generatedSkillsByFixture[id] = {};
    const name = names[index];
    if (!name) continue;
    const skill = path.join(fixtureRoots[id], 'repository/.agents/skills', name);
    await mkdir(skill, { recursive: true });
    // A deliberately minimal synthetic payload: never evidence of approved live generation.
    await writeFile(path.join(skill, 'SKILL.md'), `---\nname: ${name}\ndescription: synthetic ${id} only\n---\n`);
    generatedSkillsByFixture[id][name] = skill;
  }
  const options = { fixtureRoots, generatedSkillsByFixture, motherSkillRoot };
  const result = await prepareClaudeRoutingInputs(options);
  assert.equal(result.liveSkillBehaviorProven, false);
  assert.equal(result.cases.length, 21);
  const nodeNegative = result.cases.find((entry) => entry.prepared.case.id === 'node-build-verify-negative-01');
  assert.deepEqual(Object.keys(nodeNegative.inputs.generatedSkills), ['build-verify']);
  const collision = result.cases.find((entry) => entry.prepared.case.id === 'node-build-verify-deployment-collision-01');
  assert.deepEqual(Object.keys(collision.inputs.generatedSkills).sort(), ['build-verify', 'deployment']);
  assert.equal(collision.discoveryDirectories.length, 2);
  const maven = result.cases.find((entry) => entry.prepared.case.id === 'maven-build-verify-positive-01');
  assert.notEqual(nodeNegative.prepared.digests.generatedSkillDigest, maven.prepared.digests.generatedSkillDigest);
  assert.equal(result.explicitProbes.length, 5);
  assert.equal(new Set(result.explicitProbes.map((probe) => probe.id)).size, 5);
  for (const probe of result.explicitProbes) {
    assert.equal(probe.kind, 'explicit-invocation');
    assert.equal(probe.consumerValidated, false);
    assert.equal(result.cases.some((entry) => entry.prepared.case.id === probe.id), false);
    assert.equal(probe.prompt, `/${probe.skill}`);
  }
  const changedSkill = generatedSkillsByFixture['15-deployment'].deployment;
  await writeFile(path.join(changedSkill, 'extra.txt'), 'changed actual payload');
  const changed = await prepareClaudeRoutingInputs(options);
  const changedCollision = changed.cases.find((entry) => entry.prepared.case.id === collision.prepared.case.id);
  assert.notEqual(collision.prepared.digests.generatedSkillDigest, changedCollision.prepared.digests.generatedSkillDigest);
  assert.notEqual(collision.prepared.digests.fixtureDigest, changedCollision.prepared.digests.fixtureDigest);
  await assert.rejects(prepareClaudeRoutingInputs({ ...options, fixtureRoots: { ...fixtureRoots, '15-deployment': path.join(fixtureRoots['15-deployment'], 'repository') } }));
});

test('capability probes stop on process failure or any unapproved fixture delta (Claude doubles)', posixOnly, async (t) => {
  for (const mutation of [false, true]) {
    let sessions = 0;
    const result = await runClaudeLiveAcceptance({ live: true, scope: 'capability-probe', packageRoot: projectRoot,
      claudeExecutable: process.execPath, env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: syntheticKey } }, {
      invokeClaude: async (request) => {
        if (!request.args.includes('--print')) return syntheticClaude(request);
        sessions += 1;
        if (mutation) await writeFile(path.join(request.cwd, 'unapproved.txt'), 'synthetic unapproved write');
        return mutation ? syntheticClaude(request) : { status: 7, stdout: '', stderr: syntheticKey };
      },
    });
    assert.ok(result.disposableRoot);
    t.after(() => rm(result.disposableRoot, { recursive: true, force: true }));
    assert.equal(result.status, 'error');
    assert.equal(result.code, mutation ? 'UNAPPROVED_WRITES' : 'PROCESS_FAILED');
    assert.equal(sessions, 1);
    assert.deepEqual(result.artifacts, []);
    assert.equal(JSON.stringify(result).includes(syntheticKey), false);
  }
});

test('unavailable or unsupported installed Harness is rejected before package preparation', posixOnly, async (t) => {
  for (const mode of ['unavailable', 'unsupported']) {
    let calls = 0;
    const result = await runClaudeLiveAcceptance({ live: true, scope: 'capability-probe',
      claudeExecutable: process.execPath, env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: syntheticKey } }, {
      invokeClaude: async (request) => {
        calls += 1;
        return mode === 'unsupported' ? { status: 0, stdout: 'unexpected-version\n' } : { status: null, spawnError: new Error('synthetic unavailable') };
      },
    });
    t.after(() => rm(result.disposableRoot, { recursive: true, force: true }));
    assert.equal(result.status, 'error');
    assert.equal(result.code, 'HARNESS_VERSION_UNAVAILABLE');
    assert.equal(calls, 1);
    assert.equal(result.package, undefined);
    assert.deepEqual(result.probes, []);
  }
});

test('Harness preflight cleanup failure stops before package preparation (Claude doubles)', posixOnly, async (t) => {
  for (const flag of ['--version', '--help']) {
    const result = await runClaudeLiveAcceptance({ live: true, scope: 'capability-probe',
      claudeExecutable: process.execPath, env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: syntheticKey } }, {
      invokeClaude: async (request) => ({ ...syntheticClaude(request),
        ...(request.args.includes(flag) ? { cleanupError: { code: 'EPERM', signal: 'SIGKILL' } } : {}) }),
    });
    t.after(() => rm(result.disposableRoot, { recursive: true, force: true }));
    assert.equal(result.status, 'error');
    assert.equal(result.code, 'PROCESS_CLEANUP_FAILED');
    assert.equal(result.package, undefined);
    assert.deepEqual(result.probes, []);
  }
});

test('real offline baseline package install precedes two isolated read-only probe sessions (Claude double)', posixOnly, async (t) => {
  const requests = [];
  const result = await runClaudeLiveAcceptance({
    live: true, scope: 'capability-probe', packageRoot: projectRoot, baseSha,
    claudeExecutable: process.execPath,
    gitExecutable: process.platform === 'darwin' ? '/usr/bin/git' : 'git',
    env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: syntheticKey, ANTHROPIC_AUTH_TOKEN: 'must-not-inherit', CLAUDE_CONFIG_DIR: '/must-not-use' },
  }, { invokeClaude: async (request) => { requests.push(request); return syntheticClaude(request); } });
  assert.ok(result.disposableRoot);
  t.after(() => rm(result.disposableRoot, { recursive: true, force: true }));
  assert.equal(result.executionKind, 'test-double');
  assert.equal(result.status, 'blocked', `${result.code}: ${result.testDoubleDiagnostic ?? result.errorType ?? ''}`);
  assert.equal(result.code, 'SELECTION_PROTOCOL_UNVERIFIED');
  assert.deepEqual(result.artifacts, []);
  assert.equal(result.package.baseSha, baseSha);
  assert.match(result.package.tarballDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(result.package.motherSkillDigest, await digestTree(path.join(projectRoot, 'skills/agent-init')));
  assert.ok((await realpath(result.package.motherSkillRoot)).startsWith(await realpath(result.disposableRoot)));
  assert.equal(await readFile(path.join(result.package.motherSkillRoot, 'SKILL.md'), 'utf8'), await readFile(path.join(projectRoot, 'skills/agent-init/SKILL.md'), 'utf8'));
  const sessions = requests.filter((request) => request.args.includes('--print'));
  assert.equal(sessions.length, 2);
  assert.notEqual(sessions[0].cwd, sessions[1].cwd);
  assert.notEqual(sessions[0].args[sessions[0].args.indexOf('--session-id') + 1], sessions[1].args[sessions[1].args.indexOf('--session-id') + 1]);
  assert.equal(sessions[0].args.at(-1), '/agent-init');
  for (const request of sessions) {
    assert.equal(request.args.includes('--resume'), false);
    assert.equal(request.args.includes('--continue'), false);
    assert.equal(request.args.includes('--bare'), true);
    assert.equal(request.args.includes('--restricted'), true);
    assert.equal(request.args.includes('--no-session-persistence'), true);
    assert.equal(request.args[request.args.indexOf('--tools') + 1], 'Read,Glob,Grep,Skill');
    assert.equal(request.env.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(request.env.ANTHROPIC_API_KEY, syntheticKey);
    assert.equal(request.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');
    assert.equal(request.env.CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL, '1');
    assert.equal(request.sessionId, request.args[request.args.indexOf('--session-id') + 1]);
    assert.ok(request.env.HOME.startsWith(result.disposableRoot));
    assert.equal(request.env.CLAUDE_CONFIG_DIR, path.join(request.env.HOME, '.claude'));
  }
  assert.ok(result.probes.every((probe) => probe.zeroWrites && probe.status === 'blocked'));
  const evidence = await readFile(path.join(result.disposableRoot, 'evidence/claude-live/report.json'), 'utf8');
  assert.equal(evidence.includes(syntheticKey), false);
  assert.equal(evidence.includes('must-not-inherit'), false);
  assert.equal((await lstat(path.join(result.disposableRoot, 'evidence/claude-live/report.json'))).isFile(), true);
});
