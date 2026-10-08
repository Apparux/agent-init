import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { invokeClaudeProcess, runClaudeLiveAcceptance } from './claude-live-runner.js';

const posixOnly = { skip: process.platform === 'win32' ? 'owned POSIX process groups are unavailable' : false };
const help = '--bare --restricted --print --output-format --verbose --tools --permission-mode --permission-prompts --max-budget-usd --model --add-dir --session-id --no-session-persistence --strict-mcp-config --mcp-config --prompt-suggestions --json-schema';

function response(request) {
  const record = { evidenceLedger: [{ id: 'connection-pom', fact: 'Maven input', sourcePath: 'pom.xml', sourceLocation: 'project',
    observation: 'Owned fixture contains pom.xml', whyItMatters: 'Readonly connection capture' }], events: [
    { type: 'profile', facts: [{ id: 'connection-build', status: 'confirmed', value: 'Maven', evidenceIds: ['connection-pom'] }], unknowns: [] },
    { type: 'classify', decisions: [{ factId: 'connection-build', persistenceScope: 'GLOBAL', deterministicEnforcementCandidate: false }] },
    { type: 'skills', candidates: [] },
    { type: 'proposal', id: 'connection-cli-double-not-real-model', revision: 1, projectSummary: 'Declared CLI double, no account or model proof',
      unknowns: [], warnings: ['Unverified native discovery and Apply'], nonGoals: ['No actual model calls or writes'],
      validationPlan: ['Inspect bounded readonly capture'], actions: [
        { id: 'connection-agents', action: 'CREATE', kind: 'agents', target: 'AGENTS.md', reason: 'Unapproved fixture instructions',
          evidenceIds: ['connection-pom'], baselineFingerprint: 'missing', proposedContent: '# Connection double\n\nNot an actual model response.\n' },
      ] },
  ] };
  return { status: 0, stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: request.sessionId,
    permission_denials: [], structured_output: { decisionRecordJson: JSON.stringify(record) } }) };
}

async function runWithConnection(env, options = {}, modelResponse = response) {
  const calls = [];
  const result = await runClaudeLiveAcceptance({ live: true, scope: 'setup-proposal', authorizeSetupProposal: true,
    reuseCurrentConnection: true, model: 'declared-current-model', claudeExecutable: process.execPath,
    env: { PATH: process.env.PATH, ...env }, ...options }, { invokeClaude: async (request) => {
      calls.push(request);
      if (request.args.includes('--version')) return { status: 0, stdout: '2.1.285 (Claude Code)\n' };
      if (request.args.includes('--help')) return { status: 0, stdout: help };
      return modelResponse(request);
    } });
  return { result, calls };
}

test('existing API and explicitly supplied OAuth environments use their documented launch paths and environment model', posixOnly, async () => {
  for (const [name, authentication, bare] of [
    ['ANTHROPIC_API_KEY', 'api-key', true], ['CLAUDE_CODE_OAUTH_TOKEN', 'oauth-token', false],
  ]) {
    const credential = `declared-${authentication}-canary`;
    const { result, calls } = await runWithConnection({ [name]: credential, ANTHROPIC_MODEL: 'environment-current-model' }, { model: undefined });
    try {
      assert.equal(result.code, 'APPROVAL_REQUIRED', name);
      assert.equal(calls.length, 3, name);
      for (const request of calls.slice(0, 2)) assert.equal(request.env[name], undefined, name);
      assert.equal(calls[2].env[name], credential, name);
      assert.equal(calls[2].args.includes('--bare'), bare, name);
      assert.equal(calls[2].args[calls[2].args.indexOf('--model') + 1], 'environment-current-model', name);
      assert.equal(result.connection.authentication, authentication, name);
      assert.equal(result.connection.gatewayConfigured, false, name);
      assert.equal(result.connection.modelSource, 'environment', name);
      assert.equal(result.connection.storedLoginReused, false, name);
      assert.deepEqual(result.artifacts, [], name);
      const report = await readFile(path.join(result.disposableRoot, 'evidence/claude-live/report.json'), 'utf8');
      assert.equal(report.includes(credential), false, name);
    } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
  }
});

test('ambiguous, unsupported and unsafe connection profiles stop before assets or any CLI process', posixOnly, async () => {
  const bearer = { ANTHROPIC_AUTH_TOKEN: 'profile-bearer-canary', ANTHROPIC_BASE_URL: 'https://gateway.example.test/anthropic' };
  const cases = [
    [{ ...bearer, ANTHROPIC_API_KEY: 'second-auth-canary' }, {}, 'CONNECTION_AUTH_AMBIGUOUS'],
    [{ ...bearer, ANTHROPIC_AUTH_TOKEN: ' ', ANTHROPIC_API_KEY: 'second-auth-canary' }, {}, 'CONNECTION_AUTH_INVALID'],
    [{ ...bearer, CLAUDE_CODE_USE_BEDROCK: '1' }, {}, 'CONNECTION_PROVIDER_UNSUPPORTED'],
    [{ ...bearer, CLAUDE_CODE_USE_VERTEX: '1' }, {}, 'CONNECTION_PROVIDER_UNSUPPORTED'],
    [{ ...bearer, CLAUDE_CODE_USE_FOUNDRY: '1' }, {}, 'CONNECTION_PROVIDER_UNSUPPORTED'],
    [{ CLAUDE_CODE_OAUTH_TOKEN: 'oauth-canary', ANTHROPIC_BASE_URL: bearer.ANTHROPIC_BASE_URL }, {}, 'CONNECTION_ROUTE_UNVERIFIED'],
    [{ ANTHROPIC_AUTH_TOKEN: bearer.ANTHROPIC_AUTH_TOKEN }, {}, 'CONNECTION_ENDPOINT_REQUIRED'],
    [{ ...bearer, ANTHROPIC_AUTH_TOKEN: 'credential\nheader-injection' }, {}, 'CONNECTION_AUTH_INVALID'],
    [{ ...bearer, ANTHROPIC_AUTH_TOKEN: 'x'.repeat(16385) }, {}, 'CONNECTION_AUTH_INVALID'],
    [{ ...bearer, ANTHROPIC_BASE_URL: 'http://gateway.example.test' }, {}, 'CONNECTION_ENDPOINT_INVALID'],
    [{ ...bearer, ANTHROPIC_BASE_URL: 'https://user:password@gateway.example.test' }, {}, 'CONNECTION_ENDPOINT_INVALID'],
    [{ ...bearer, ANTHROPIC_BASE_URL: 'https://gateway.example.test?credential=private' }, {}, 'CONNECTION_ENDPOINT_INVALID'],
    [{ ...bearer, ANTHROPIC_BASE_URL: 'https://gateway.example.test#private' }, {}, 'CONNECTION_ENDPOINT_INVALID'],
    [{ ...bearer, ANTHROPIC_BASE_URL: '' }, {}, 'CONNECTION_ENDPOINT_INVALID'],
    [{ ...bearer, ANTHROPIC_BASE_URL: ' https://gateway.example.test' }, {}, 'CONNECTION_ENDPOINT_INVALID'],
    [bearer, { model: undefined }, 'CONNECTION_MODEL_REQUIRED'],
    [{ ...bearer, ANTHROPIC_MODEL: 'available-environment-model' }, { model: null }, 'CONNECTION_MODEL_INVALID'],
    [bearer, { model: 'model\n--permission-mode bypassPermissions' }, 'CONNECTION_MODEL_INVALID'],
    [bearer, { model: 'file:///private/model' }, 'CONNECTION_MODEL_INVALID'],
    [bearer, { model: bearer.ANTHROPIC_AUTH_TOKEN }, 'SECRET_CONNECTION'],
    [{ ANTHROPIC_API_KEY: 'legacy-profile-canary' }, { reuseCurrentConnection: false }, 'CONNECTION_OPT_IN_REQUIRED'],
    [{ ANTHROPIC_API_KEY: 'legacy-profile-canary' }, { reuseCurrentConnection: undefined }, 'CONNECTION_OPT_IN_REQUIRED'],
  ];
  for (const [env, options, code] of cases) {
    const { result, calls } = await runWithConnection(env, options);
    try {
      assert.equal(result.status, 'blocked', code);
      assert.equal(result.code, code);
      assert.equal(result.disposableRoot, undefined, code);
      assert.equal(calls.length, 0, code);
      assert.deepEqual(result.artifacts, [], code);
    } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
  }
});

test('CLI connection reuse is explicit, scope-bound and never accepts credential arguments', posixOnly, async () => {
  const entry = fileURLToPath(new URL('./claude-live-runner.js', import.meta.url));
  for (const [args, code] of [
    [['--live', '--scope', 'setup-proposal', '--authorize-setup-proposal', '--reuse-current-connection', '--model', 'declared-current-model'], 'CLAUDE_EXECUTABLE_REQUIRED'],
    [['--simulate', '--reuse-current-connection'], 'CLI_ARGUMENTS'],
    [['--live', '--scope', 'capability-probe', '--model', 'declared-current-model'], 'CLI_ARGUMENTS'],
    [['--live', '--scope', 'capability-probe', '--reuse-current-connection', '--reuse-current-connection'], 'CLI_ARGUMENTS'],
    [['--live', '--scope', 'capability-probe', '--reuse-current-connection', '--model', 'one', '--model', 'two'], 'CLI_ARGUMENTS'],
    [['--live', '--scope', 'capability-probe', '--reuse-current-connection', '--token', 'never-a-credential-input'], 'CLI_ARGUMENTS'],
  ]) {
    const processResult = await invokeClaudeProcess({ command: process.execPath, args: [entry, ...args], cwd: path.dirname(entry),
      env: { PATH: process.env.PATH, ANTHROPIC_AUTH_TOKEN: 'declared-cli-connection-canary', ANTHROPIC_BASE_URL: 'https://gateway.example.test' },
      timeoutMs: 2000 });
    const result = JSON.parse(processResult.stdout);
    try {
      assert.equal(processResult.status, 2, code);
      assert.equal(result.code, code);
      assert.equal(result.disposableRoot, undefined, code);
      assert.equal(processResult.stdout.includes('declared-cli-connection-canary'), false, code);
      assert.deepEqual(result.artifacts, [], code);
    } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
  }
});

test('credential and normalized gateway echoes are rejected before any captured decision is retained', posixOnly, async () => {
  const credential = 'connection-private-echo-canary';
  const endpoint = 'https://GATEWAY.example.test:443/anthropic';
  for (const variant of ['credential', 'escaped-shadowed-credential', 'configured-endpoint', 'normalized-origin']) {
    const { result } = await runWithConnection({ ANTHROPIC_AUTH_TOKEN: credential, ANTHROPIC_BASE_URL: endpoint }, {}, (request) => {
      const processResult = response(request);
      const envelope = JSON.parse(processResult.stdout);
      if (variant === 'credential') envelope.result = credential;
      if (variant === 'configured-endpoint') envelope.result = endpoint;
      if (variant === 'normalized-origin') envelope.result = 'https://gateway.example.test/anthropic/v1/messages';
      if (variant === 'escaped-shadowed-credential') {
        processResult.stdout = processResult.stdout.replace('"structured_output":',
          '"hidden":"\\u0063onnection-private-echo-canary","hidden":"public","structured_output":');
        return processResult;
      }
      processResult.stdout = JSON.stringify(envelope);
      return processResult;
    });
    try {
      assert.equal(result.status, 'error', variant);
      assert.equal(result.code, 'SECRET_TRACE', variant);
      assert.equal(result.setup, undefined, variant);
      assert.deepEqual(result.artifacts, [], variant);
      const persisted = await readFile(path.join(result.disposableRoot, 'evidence/claude-live/report.json'), 'utf8');
      assert.equal(persisted.includes(credential), false, variant);
      assert.equal(persisted.includes('gateway.example.test'), false, variant);
    } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
  }
});

test('current connection reuse keeps capability sessions fresh and selection evidence fail-closed', posixOnly, async () => {
  const { result, calls } = await runWithConnection({ ANTHROPIC_AUTH_TOKEN: 'declared-probe-bearer-canary',
    ANTHROPIC_BASE_URL: 'https://gateway.example.test/anthropic' }, { scope: 'capability-probe', authorizeSetupProposal: undefined }, (request) => {
    const events = [
      { type: 'system', subtype: 'init', session_id: request.sessionId, skills: ['agent-init'], tools: ['Read', 'Glob', 'Grep', 'Skill'] },
      { type: 'result', subtype: 'success', session_id: request.sessionId, is_error: false, permission_denials: [],
        result: 'Declared CLI double, no Skill selection evidence.' },
    ];
    return { status: 0, stdout: `${events.map((event) => JSON.stringify(event)).join('\n')}\n` };
  });
  try {
    assert.equal(result.code, 'SELECTION_PROTOCOL_UNVERIFIED');
    assert.equal(result.probes.length, 2);
    const sessions = calls.filter((request) => request.sessionId);
    assert.equal(sessions.length, 2);
    assert.notEqual(sessions[0].sessionId, sessions[1].sessionId);
    assert.notEqual(sessions[0].cwd, sessions[1].cwd);
    for (const session of sessions) {
      assert.equal(session.env.ANTHROPIC_AUTH_TOKEN, 'declared-probe-bearer-canary');
      assert.equal(session.args.includes('--bare'), false);
      assert.equal(session.args.includes('--resume'), false);
      assert.equal(session.args.includes('--no-session-persistence'), true);
    }
    assert.equal(result.probes.every((probe) => probe.zeroWrites && probe.status === 'blocked'), true);
    assert.equal(result.probes.some((probe) => Object.hasOwn(probe, 'loaded')), false);
    assert.equal(result.connection.parentConnectionIdentityProven, false);
    assert.equal(result.liveSkillBehaviorProven, false);
    assert.deepEqual(result.artifacts, []);
  } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
});

test('one existing capability invocation can be selected without repeating the other authorized probe', posixOnly, async () => {
  const env = { ANTHROPIC_AUTH_TOKEN: 'single-probe-canary', ANTHROPIC_BASE_URL: 'https://gateway.example.test' };
  for (const invocation of ['explicit', 'implicit']) {
    const { result, calls } = await runWithConnection(env, { scope: 'capability-probe', authorizeSetupProposal: undefined, probeInvocation: invocation }, request => ({
      status: 0, stdout: [
        { type: 'system', subtype: 'init', session_id: request.sessionId, tools: ['Read', 'Skill'] },
        { type: 'result', subtype: 'success', session_id: request.sessionId, is_error: false, permission_denials: [] },
      ].map(event => JSON.stringify(event)).join('\n') + '\n',
    }));
    try {
      assert.equal(result.code, 'SELECTION_PROTOCOL_UNVERIFIED');
      assert.equal(result.probes.length, 1);
      assert.equal(result.probes[0].invocation, invocation);
      assert.equal(result.probes[0].id, `mother-${invocation}-probe`);
      const sessions = calls.filter(request => request.sessionId);
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0].args.at(-1), invocation === 'explicit' ? '/agent-init'
        : 'Set up minimal evidence-based Agent instructions and project Skills for this repository. Present the complete Proposal only; do not apply it.');
      assert.equal(result.liveSkillBehaviorProven, false);
      assert.deepEqual(result.artifacts, []);
    } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
  }
  for (const options of [{ probeInvocation: null }, { probeInvocation: 'all' }, { probeInvocation: 'implicit' }]) {
    const { result, calls } = await runWithConnection(env, options);
    assert.equal(result.code, 'PROBE_SCOPE');
    assert.equal(result.disposableRoot, undefined);
    assert.equal(calls.length, 0);
  }
  const entry = fileURLToPath(new URL('./claude-live-runner.js', import.meta.url));
  for (const [args, code] of [
    [['--live', '--scope', 'capability-probe', '--reuse-current-connection', '--model', 'declared-current-model', '--probe-invocation', 'implicit'], 'CLAUDE_EXECUTABLE_REQUIRED'],
    [['--simulate', '--probe-invocation', 'implicit'], 'CLI_ARGUMENTS'],
    [['--live', '--scope', 'setup-proposal', '--probe-invocation', 'implicit'], 'CLI_ARGUMENTS'],
    [['--live', '--scope', 'capability-probe', '--probe-invocation', 'all'], 'CLI_ARGUMENTS'],
    [['--live', '--scope', 'capability-probe', '--probe-invocation', 'implicit', '--probe-invocation', 'explicit'], 'CLI_ARGUMENTS'],
  ]) {
    const processResult = await invokeClaudeProcess({ command: process.execPath, args: [entry, ...args], cwd: path.dirname(entry),
      env: { PATH: process.env.PATH, ...env }, timeoutMs: 2000 });
    assert.equal(processResult.status, 2);
    assert.equal(JSON.parse(processResult.stdout).code, code);
    assert.equal(processResult.stdout.includes(env.ANTHROPIC_AUTH_TOKEN), false);
  }
});

test('existing bearer gateway and declared model reach only the readonly CLI session, never preflight or evidence', posixOnly, async () => {
  const credential = 'declared-connection-bearer-canary';
  const endpoint = 'https://gateway.example.test/anthropic';
  const { result, calls } = await runWithConnection({ ANTHROPIC_AUTH_TOKEN: credential, ANTHROPIC_BASE_URL: endpoint,
    ANTHROPIC_MODEL: 'environment-model-not-selected', UNRELATED_SECRET: 'not-forwarded',
    CLAUDE_CONFIG_DIR: '/not-the-owned-config', HTTPS_PROXY: 'https://unapproved-proxy.example.test' });
  try {
    assert.equal(result.status, 'blocked');
    assert.equal(result.code, 'APPROVAL_REQUIRED');
    assert.equal(calls.length, 3);
    for (const request of calls.slice(0, 2)) {
      assert.equal(request.env.ANTHROPIC_AUTH_TOKEN, undefined);
      assert.equal(request.env.ANTHROPIC_API_KEY, undefined);
      assert.equal(request.env.ANTHROPIC_BASE_URL, undefined);
      assert.equal(request.env.ANTHROPIC_MODEL, undefined);
    }
    const session = calls[2];
    assert.equal(session.env.ANTHROPIC_AUTH_TOKEN, credential);
    assert.equal(session.env.ANTHROPIC_BASE_URL, endpoint);
    assert.equal(session.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(session.env.ANTHROPIC_MODEL, undefined);
    assert.equal(session.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    assert.equal(session.env.UNRELATED_SECRET, undefined);
    assert.equal(session.env.HTTPS_PROXY, undefined);
    assert.equal(session.env.CLAUDE_CONFIG_DIR, path.join(session.env.HOME, '.claude'));
    assert.equal(session.args[session.args.indexOf('--model') + 1], 'declared-current-model');
    assert.equal(session.args.includes('--bare'), false);
    assert.equal(session.args.includes('--restricted'), true);
    assert.equal(session.args[session.args.indexOf('--permission-mode') + 1], 'dontAsk');
    assert.equal(session.args[session.args.indexOf('--tools') + 1], 'Read,Glob,Grep,Skill');
    assert.deepEqual(result.connection, { source: 'existing-environment', authentication: 'bearer-token', gatewayConfigured: true,
      requestedModel: 'declared-current-model', modelSource: 'explicit-option', bare: false,
      storedLoginReused: false, parentConnectionIdentityProven: false, contextIsolationProven: false });
    assert.equal(result.setup.applySupported, false);
    assert.equal(result.setup.provenance.contextIsolationProven, false);
    assert.equal(result.liveSkillBehaviorProven, false);
    assert.deepEqual(result.artifacts, []);
    const report = await readFile(path.join(result.disposableRoot, 'evidence/claude-live/report.json'), 'utf8');
    for (const value of [credential, endpoint, 'not-forwarded', '/not-the-owned-config', 'unapproved-proxy']) assert.equal(report.includes(value), false);
  } finally { if (result.disposableRoot) await rm(result.disposableRoot, { recursive: true, force: true }); }
});
