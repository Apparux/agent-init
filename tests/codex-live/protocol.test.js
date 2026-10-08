import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { openCodexProcess } from './app-server.js';
import { parseCodexTurn } from './parser.js';
import { createCodexMeasurementTools } from './measurement-tools.js';

const syntheticProgram = fileURLToPath(new URL('./support/synthetic-app-server.mjs', import.meta.url));
const fixtureSessions = new WeakMap();

async function openFixtureProcess(options) {
  const client = await openCodexProcess(options);
  fixtureSessions.get(options).add(client);
  return client;
}

async function protocolFixture(t, cleanupConfirmed = () => true) {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'ai-codex-protocol-'));
  const before = await lstat(root);
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'repository');
  const sessions = new Set();
  await mkdir(home);
  await mkdir(cwd);
  t.after(async () => {
    if (!sessions.size) return;
    for (const client of sessions) {
      let receipt;
      try { receipt = await client.close(); }
      catch { return; } // Unconfirmed finalization retains the exact owned root.
      if (receipt.processGroupAbsent !== true) return;
    }
    if (!cleanupConfirmed()) return;
    const current = await lstat(root);
    assert.equal(current.isSymbolicLink(), false);
    assert.equal(current.dev, before.dev);
    assert.equal(current.ino, before.ino);
    await rm(root, { recursive: true });
  });
  const options = {
    mode: 'synthetic',
    ownedRoot: root,
    cwd,
    env: {
      HOME: home,
      USERPROFILE: home,
      CODEX_HOME: path.join(home, '.codex'),
      TMPDIR: root,
      LANG: 'C',
      LC_ALL: 'C',
    },
    launch: { command: process.execPath, args: [syntheticProgram, '--split'] },
  };
  fixtureSessions.set(options, sessions);
  return options;
}

test('synthetic Codex stdio correlates a fragmented initialize response with its request', async (t) => {
  const options = await protocolFixture(t);
  const client = await openFixtureProcess(options);
  t.after(() => client.close());
  const params = {
    clientInfo: { name: 'ticket08-tests', version: 'synthetic' },
    capabilities: { experimentalApi: true },
  };
  const initialized = await client.request('initialize', params);
  assert.equal(initialized.userAgent, 'synthetic-codex/0.0.0-synthetic');
  assert.equal(initialized.codexHome, options.env.CODEX_HOME);
  assert.equal(initialized.platformFamily, 'synthetic');
  assert.deepEqual(client.sent[0], { id: 1, method: 'initialize', params });
  assert.equal(client.received[0].id, 1);
  const closed = await client.close();
  assert.equal(closed.exitCode, 0);
  assert.equal(closed.signal, null);
  assert.equal(closed.processGroupAbsent, true);
});

test('synthetic Codex server command approvals are declined using the original request ID', async (t) => {
  const options = await protocolFixture(t);
  options.launch.args.push('--approval');
  options.timeoutMs = 1000;
  const client = await openFixtureProcess(options);
  try {
    await client.request('initialize', { clientInfo: { name: 'ticket08-tests', version: 'synthetic' } });
    const reply = client.sent.find((message) => message.id === 'server-approval-1');
    assert.deepEqual(reply, { id: 'server-approval-1', result: { decision: 'decline' } });
  } finally {
    await client.close();
  }
});

test('synthetic Codex refuses file, permission, MCP and dynamic-tool requests without invoking client tools', async (t) => {
  const refusals = [
    ['item/fileChange/requestApproval', { decision: 'decline' }],
    ['item/permissions/requestApproval', { permissions: {}, scope: 'turn' }],
    ['mcpServer/elicitation/request', { action: 'decline', content: null, _meta: null }],
    ['item/tool/call', { contentItems: [{ type: 'inputText', text: 'Rejected by client' }], success: false }],
  ];
  for (const [method, expected] of refusals) {
    await t.test(method, async (subtest) => {
      const options = await protocolFixture(subtest);
      options.launch.args.push(`--server-request=${method}`);
      options.timeoutMs = 1000;
      const client = await openFixtureProcess(options);
      try {
        await client.request('initialize', { clientInfo: { name: 'ticket08-tests', version: 'synthetic' } });
        assert.deepEqual(client.sent.find((message) => message.id === 'server-approval-1'), {
          id: 'server-approval-1', result: expected,
        });
      } finally {
        await client.close();
      }
    });
  }
});

test('positive measurement wire callback uses actual active protocol IDs and completes only after the correct pure digest reply', async (t) => {
  const options = await protocolFixture(t);
  const tools = await createCodexMeasurementTools({ ownedRoot: options.ownedRoot, ownedIdentity: await lstat(options.ownedRoot),
    repositoryRoot: options.cwd, repositoryIdentity: await lstat(options.cwd) });
  options.measurementTools = tools;
  // Controller-owned stdio specimen, not a native binary, provider or model.
  const source = `
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
let threadId;
let turnId;
input.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') send({ id: request.id, result: { userAgent: 'synthetic-measurement-peer/0.0.0', codexHome: process.env.CODEX_HOME } });
  else if (request.method === 'thread/start') {
    threadId = 'synthetic-peer-thread-' + randomUUID();
    send({ id: request.id, result: { thread: { id: threadId } } });
  } else if (request.method === 'turn/start') {
    if (request.params.threadId !== threadId) throw new Error('Unexpected submitted thread');
    turnId = 'synthetic-peer-turn-' + randomUUID();
    send({ id: request.id, result: { turn: { id: turnId, status: 'inProgress', error: null, items: [], itemsView: 'notLoaded' } } });
    send({ id: 'measurement-request', method: 'item/tool/call', params: { threadId, turnId, callId: 'pure-proposal-call',
      namespace: null, tool: 'digestProposal', arguments: { proposal: { b: 2, a: 1 } } } });
  } else if (request.id === 'measurement-request') {
    const valid = request.result?.success === true
      && JSON.parse(request.result.contentItems[0].text).digest === 'sha256:43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777';
    send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: valid ? 'completed' : 'failed',
      error: null, items: [], itemsView: 'summary' } } });
  }
});
`;
  const program = path.join(options.ownedRoot, 'measurement-peer.mjs');
  await writeFile(program, source, { flag: 'wx', mode: 0o600 });
  options.syntheticPeer = { path: program, digest: `sha256:${createHash('sha256').update(source).digest('hex')}` };
  options.launch.args = [program];
  await assert.rejects(openCodexProcess({ ...options, syntheticPeer: { path: program, digest: `sha256:${'0'.repeat(64)}` } }), { code: 'SYNTHETIC_LAUNCH' });
  await assert.rejects(openCodexProcess({ ...options, mode: 'native' }), { code: 'NATIVE_EXECUTION_DEFERRED' });
  const client = await openFixtureProcess(options);
  try {
    await client.request('initialize', { clientInfo: { name: 'positive-wire-test', version: 'synthetic' } });
    const started = await client.request('thread/start', { cwd: options.cwd, dynamicTools: tools.dynamicTools, sandbox: 'read-only' });
    const capture = await client.runTurn({ threadId: started.thread.id, input: [{ type: 'text', text: 'Synthetic pure measurement only.' }],
      sandboxPolicy: { type: 'readOnly', networkAccess: false } });
    const callback = client.received.find((message) => message.method === 'item/tool/call');
    assert.equal(callback.params.threadId, started.thread.id);
    assert.equal(callback.params.threadId, capture.threadId);
    assert.equal(callback.params.turnId, capture.turnId);
    const reply = client.sent.find((message) => message.id === callback.id);
    assert.equal(reply.result.success, true);
    assert.deepEqual(JSON.parse(reply.result.contentItems[0].text), {
      digest: 'sha256:43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777',
    });
    assert.equal(capture.events.find((event) => event.method === 'turn/completed').params.turn.status, 'completed');
    assert.throws(() => tools.activateTurn({ threadId: capture.threadId, turnId: capture.turnId }), { code: 'MEASUREMENT_TURN' });
    assert.equal((await client.close()).processGroupAbsent, true);
  } finally { await client.close(); }
});

test('measurement tool wire requests reach the bound handler and actual protocol turns close its authority', async (t) => {
  const options = await protocolFixture(t);
  const tools = await createCodexMeasurementTools({ ownedRoot: options.ownedRoot, ownedIdentity: await lstat(options.ownedRoot),
    repositoryRoot: options.cwd, repositoryIdentity: await lstat(options.cwd) });
  options.measurementTools = tools;
  options.launch.args.push('--server-request=item/tool/call');
  const client = await openFixtureProcess(options);
  try {
    await client.request('initialize', { clientInfo: { name: 'measurement-wire-test', version: 'synthetic' } });
    const reply = client.sent.find((message) => message.id === 'server-approval-1');
    assert.equal(reply.result.success, false);
    assert.deepEqual(JSON.parse(reply.result.contentItems[0].text), { status: 'error', code: 'MEASUREMENT_CALL' });
    const started = await client.request('thread/start', { cwd: options.cwd, dynamicTools: tools.dynamicTools, sandbox: 'read-only' });
    const capture = await client.runTurn({ threadId: started.thread.id, input: [{ type: 'text', text: 'Synthetic measurement lifecycle only.' }],
      sandboxPolicy: { type: 'readOnly', networkAccess: false } });
    assert.equal(capture.threadId, started.thread.id);
    assert.match(capture.turnId, /^synthetic-turn-/);
    const late = await tools.handleToolCall({ threadId: capture.threadId, turnId: capture.turnId, callId: 'late-call', namespace: null,
      tool: 'digestProposal', arguments: { proposal: {} } });
    assert.equal(late.success, false);
    // Re-activation of this actual returned ID must be refused: the adapter used it.
    assert.throws(() => tools.activateTurn({ threadId: capture.threadId, turnId: capture.turnId }), { code: 'MEASUREMENT_TURN' });
    await assert.rejects(client.runTurn({ threadId: 'foreign-thread', input: [] }), { code: 'CODEX_TURN' });
    await assert.rejects(client.request('turn/start', { threadId: started.thread.id, input: [] }), { code: 'CODEX_TURN' });
  } finally { await client.close(); }
});

test('synthetic Codex captures a turn even when notifications arrive before the start response', async (t) => {
  const options = await protocolFixture(t);
  options.launch.args.push('--notifications-first');
  const tools = await createCodexMeasurementTools({ ownedRoot: options.ownedRoot, ownedIdentity: await lstat(options.ownedRoot),
    repositoryRoot: options.cwd, repositoryIdentity: await lstat(options.cwd) });
  options.measurementTools = tools;
  const client = await openFixtureProcess(options);
  try {
    await client.request('initialize', { clientInfo: { name: 'ticket08-tests', version: 'synthetic' } });
    client.notify('initialized');
    const started = await client.request('thread/start', { cwd: options.cwd, dynamicTools: tools.dynamicTools, sandbox: 'read-only' });
    const submitted = {
      threadId: started.thread.id,
      input: [{ type: 'text', text: 'Synthetic protocol observation only.' }],
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
      outputSchema: { type: 'object' },
    };
    const capture = await client.runTurn(submitted);
    assert.equal(capture.threadId, started.thread.id);
    assert.throws(() => tools.activateTurn({ threadId: capture.threadId, turnId: capture.turnId }), { code: 'MEASUREMENT_TURN' });
    assert.match(capture.turnId, /^synthetic-turn-/);
    assert.deepEqual(capture.request.params, submitted);
    const completion = capture.events.find((message) => message.method === 'turn/completed');
    assert.equal(completion.params.turn.id, capture.turnId);
    assert.equal(completion.params.turn.status, 'completed');
    assert.equal(completion.params.turn.itemsView, 'summary');
    assert.equal(capture.events.filter((message) => message.method === 'item/agentMessage/delta').length, 2);
    submitted.input[0].text = 'Changed after submission.';
    assert.equal(capture.request.params.input[0].text, 'Synthetic protocol observation only.');
  } finally {
    await client.close();
  }
});

test('turn capture must retain cross-session notifications so parser can reject contamination', async (t) => {
  const options = await protocolFixture(t);
  options.launch.args.push('--foreign-event');
  const client = await openFixtureProcess(options);
  try {
    await client.request('initialize', { clientInfo: { name: 'ticket08-tests', version: 'synthetic' } });
    const capture = await client.runTurn({ threadId: 'synthetic-thread', input: [{ type: 'text', text: 'Synthetic observation.' }] });
    assert.equal(capture.events.some((event) => event.params.threadId === 'foreign-thread'), true);
    assert.throws(() => parseCodexTurn(capture), { code: 'TURN_CONTEXT' });
  } finally { await client.close(); }
});

test('valid initialize followed by nonzero process exit is not a successful session', async (t) => {
  const options = await protocolFixture(t);
  options.launch.args.push('--exit-nonzero');
  const client = await openFixtureProcess(options);
  try {
    await client.request('initialize', { clientInfo: { name: 'ticket08-tests', version: 'synthetic' } });
    const closed = await client.close();
    assert.equal(closed.exitCode, 9);
    assert.equal(closed.failure.code, 'CODEX_EXIT');
    assert.equal(closed.processGroupAbsent, true);
  } finally { await client.close(); }
});

test('idle approval review pauses only the active actor budget and cannot send or overlap requests', async (t) => {
  const options = await protocolFixture(t);
  options.timeoutMs = 2000;
  options.approvalTimeoutMs = 4000;
  const client = await openFixtureProcess(options);
  let releaseReview;
  let review;
  try {
    await client.request('initialize', { clientInfo: { name: 'separate-review-budget', version: 'synthetic' } });
    const decision = { decision: 'reject', scope: 'exact-proposal' };
    review = client.waitForApproval(() => new Promise((resolve) => { releaseReview = () => resolve(decision); }));
    await new Promise((resolve) => setImmediate(resolve));
    const requestsBeforeReview = client.sent.length;
    await assert.rejects(client.request('skills/list', { cwds: [] }), { code: 'CODEX_APPROVAL_WAIT' });
    await assert.rejects(client.waitForApproval(() => decision), { code: 'CODEX_APPROVAL_WAIT' });
    assert.equal(client.sent.length, requestsBeforeReview);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    releaseReview();
    assert.deepEqual(await review, decision);
    await assert.rejects(client.waitForApproval(() => decision), { code: 'CODEX_APPROVAL_WAIT' });
    assert.deepEqual(await client.request('skills/list', { cwds: [] }), { data: [] });
    assert.equal(client.failure, null);
  } finally {
    releaseReview?.();
    if (review) await review.catch(() => {});
    assert.equal((await client.close()).processGroupAbsent, true);
  }
});

test('approval timeout aborts cooperative review and awaits its settlement before confirming finalization', async (t) => {
  const options = await protocolFixture(t);
  options.approvalTimeoutMs = 100;
  const client = await openFixtureProcess(options);
  let aborted = false;
  try {
    await client.request('initialize', { clientInfo: { name: 'cooperative-review-cancellation', version: 'synthetic' } });
    await assert.rejects(client.waitForApproval(({ signal }) => new Promise((resolve) => {
      signal.addEventListener('abort', () => {
        aborted = true;
        resolve({ decision: 'reject' });
      }, { once: true });
    })), { code: 'APPROVAL_TIMEOUT' });
    const closed = await client.close();
    assert.equal(aborted, true);
    assert.equal(closed.processGroupAbsent, true);
    assert.equal(closed.failure.code, 'APPROVAL_TIMEOUT');
  } finally { await client.close(); }
});

test('a synchronous approval abort listener reuses the same close promise and final receipt', async (t) => {
  const options = await protocolFixture(t);
  const client = await openFixtureProcess(options);
  let reentrantClose;
  try {
    await client.request('initialize', { clientInfo: { name: 'reentrant-review-close', version: 'synthetic' } });
    const review = client.waitForApproval(({ signal }) => new Promise((resolve) => {
      signal.addEventListener('abort', () => {
        resolve({ decision: 'reject' });
        reentrantClose = client.close();
        reentrantClose.catch(() => {});
      }, { once: true });
    }));
    const rejected = assert.rejects(review, { code: 'CODEX_CLOSED' });
    await new Promise((resolve) => setImmediate(resolve));
    const closing = client.close();
    const receipt = await closing;
    await rejected;
    assert.equal(reentrantClose, closing);
    assert.deepEqual(await reentrantClose, receipt);
    assert.equal(receipt.processGroupAbsent, true);
  } finally { await client.close(); }
});

test('closing before approval dispatch cancels the queued controller callback without invoking it', async (t) => {
  let invocations = 0;
  const options = await protocolFixture(t, () => invocations === 0);
  const client = await openFixtureProcess(options);
  await client.request('initialize', { clientInfo: { name: 'cancel-before-dispatch', version: 'synthetic' } });
  const review = client.waitForApproval(() => {
    invocations++;
    return new Promise(() => {});
  });
  const rejected = assert.rejects(review, { code: 'CODEX_CLOSED' });
  const closed = await client.close();
  await rejected;
  assert.equal(closed.processGroupAbsent, true);
  assert.equal(invocations, 0);
});

test('closing a completed child with an unsettled tool callback has a separate bounded cleanup failure', async (t) => {
  let retainedRoot;
  await t.test('default fixture teardown retains unconfirmed callback lifetime', async (subtest) => {
    const options = await protocolFixture(subtest);
    retainedRoot = options.ownedRoot;
    options.closeTimeoutMs = 150;
    options.measurementTools = { finishTurn() {}, handleToolCall: () => new Promise(() => {}) };
    const source = `
  import readline from 'node:readline';
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
  input.on('line', (line) => {
    const request = JSON.parse(line);
    if (request.method === 'initialize') {
      send({ id: request.id, result: { userAgent: 'synthetic-stalled-callback', codexHome: process.env.CODEX_HOME } });
      send({ id: 'stalled-callback', method: 'item/tool/call', params: {} });
    }
  });
  `;
    const program = path.join(options.ownedRoot, 'stalled-callback-peer.mjs');
    await writeFile(program, source, { flag: 'wx', mode: 0o600 });
    options.syntheticPeer = { path: program, digest: `sha256:${createHash('sha256').update(source).digest('hex')}` };
    options.launch.args = [program];
    const client = await openFixtureProcess(options);
    await client.request('initialize', { clientInfo: { name: 'bounded-close-test', version: 'synthetic' } });
    let watchdog;
    try {
      const error = await Promise.race([
        client.close().then(() => null, (cause) => cause),
        new Promise((resolve) => { watchdog = setTimeout(() => resolve(null), 1500); }),
      ]);
      assert.equal(error?.code, 'CODEX_CLEANUP');
      assert.equal(error.processCleanupUnconfirmed, true);
      assert.equal(error.processGroupAbsent, true);
      assert.equal(client.failure.code, 'CODEX_CLEANUP');
      assert.equal((await lstat(options.ownedRoot)).isDirectory(), true);
    } finally {
      clearTimeout(watchdog);
    }
  });
  assert.equal((await lstat(retainedRoot)).isDirectory(), true);
});

test('outbound JSON and request history are bounded before being sent to the child', async (t) => {
  const options = await protocolFixture(t);
  options.maxSendBytes = 128;
  const client = await openFixtureProcess(options);
  try {
    await assert.rejects(client.request('initialize', { text: 'x'.repeat(256) }), { code: 'CODEX_SEND_LIMIT' });
    assert.equal(client.sent.length, 0);
    const closed = await client.close();
    assert.equal(closed.processGroupAbsent, true);
    assert.equal(closed.failure.code, 'CODEX_SEND_LIMIT');
  } finally { await client.close(); }
});

test('stdio failure regressions reject truncation, unknown requests, wrong IDs, capture limits and timeouts', async (t) => {
  for (const [fault, code, limits] of [
    ['truncated', 'CODEX_TRUNCATED', {}],
    ['unknown-request', 'CODEX_SERVER_REQUEST', {}],
    ['wrong-id', 'CODEX_RESPONSE_ID', {}],
    ['line-limit', 'CODEX_CAPTURE_LIMIT', { maxLineBytes: 512 }],
    ['stderr-limit', 'CODEX_CAPTURE_LIMIT', { maxStderrBytes: 64 }],
    ['timeout', 'CODEX_TIMEOUT', { timeoutMs: 200 }],
  ]) {
    await t.test(fault, async (subtest) => {
      const options = Object.assign(await protocolFixture(subtest), limits);
      options.launch.args.push(`--fault=${fault}`);
      const client = await openFixtureProcess(options);
      try {
        await assert.rejects(client.request('initialize', { clientInfo: { name: 'ticket08-tests', version: 'synthetic' } }), { code });
        const closed = await client.close();
        assert.equal(closed.failure.code, code);
        assert.equal(closed.processGroupAbsent, true);
      } finally { await client.close(); }
    });
  }
});
