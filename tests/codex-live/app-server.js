import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readRegularFileNoFollow } from '../../src/installation/filesystem.js';
import { assertCodexDirectory } from './owned-runtime.js';
import { ownedGroupAbsent as groupAbsent, signalOwnedGroup } from './process-ownership.js';

export const CODEX_SOURCE_REF = 'ff6aec96948b70d94983af2641a6b67c94faeff5';
export const SYNTHETIC_PROGRAM = fileURLToPath(new URL('./support/synthetic-app-server.mjs', import.meta.url));

const environmentKeys = new Set([
  'HOME', 'USERPROFILE', 'CODEX_HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'PATH',
  'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME',
  'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM',
  'GIT_OPTIONAL_LOCKS', 'GIT_CEILING_DIRECTORIES',
  'npm_config_userconfig', 'npm_config_globalconfig', 'npm_config_cache',
  'npm_config_offline', 'npm_config_audit', 'npm_config_fund', 'npm_config_update_notifier',
  'NO_COLOR',
]);
const ownedEnvironmentKeys = new Set([
  'HOME', 'USERPROFILE', 'CODEX_HOME', 'TMPDIR',
  'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME',
  'npm_config_userconfig', 'npm_config_globalconfig', 'npm_config_cache',
]);
// Source: protocol/common.rs server requests and protocol/v2 responses at CODEX_SOURCE_REF.
const requestRefusals = new Map([
  ['item/commandExecution/requestApproval', { decision: 'decline' }],
  ['item/fileChange/requestApproval', { decision: 'decline' }],
  ['item/permissions/requestApproval', { permissions: {}, scope: 'turn' }],
  ['mcpServer/elicitation/request', { action: 'decline', content: null, _meta: null }],
  ['item/tool/call', { contentItems: [{ type: 'inputText', text: 'Rejected by client' }], success: false }],
]);

function failure(code, message) {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

function budget(value, fallback, name, maximum = fallback) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0 || result > maximum) {
    throw failure('CODEX_BUDGET', `${name} must be a positive integer no greater than ${maximum}`);
  }
  return result;
}

async function inspectOwnedPath(root, candidate) {
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) {
    throw failure('CODEX_SCOPE', 'owned paths must be absolute');
  }
  const relative = path.relative(root, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw failure('CODEX_SCOPE', 'child path escapes its owned root');
  }
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let entry;
    try {
      entry = await lstat(current);
    } catch (cause) {
      if (cause.code === 'ENOENT') return;
      throw cause;
    }
    if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) {
      throw failure('CODEX_SCOPE', 'owned child paths must not follow links or special entries');
    }
  }
}

// Protocol source: app-server-transport/src/transport/stdio.rs at CODEX_SOURCE_REF.
// Native activation is separate from this adapter's tested stdio implementation.
export async function openCodexProcess(options) {
  if (options?.mode !== 'synthetic') {
    throw failure('NATIVE_EXECUTION_DEFERRED', 'native launch requires separately verified containment, authorization and network-budget integration');
  }
  const root = path.resolve(options.ownedRoot);
  const rootEntry = await assertCodexDirectory(root);
  if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) {
    throw failure('CODEX_SCOPE', 'owned root must be a regular directory');
  }
  let syntheticProgram = SYNTHETIC_PROGRAM;
  if (options.syntheticPeer) {
    // Explicit controller-only specimen, never an actor-selected tool or native launcher.
    syntheticProgram = options.syntheticPeer.path;
    await inspectOwnedPath(root, syntheticProgram);
    const entry = await lstat(syntheticProgram);
    if (!entry.isFile() || entry.nlink !== 1 || entry.size > 64 * 1024) {
      throw failure('SYNTHETIC_LAUNCH', 'owned stdio specimen must be a bounded regular unlinked file');
    }
    const bytes = await readRegularFileNoFollow(syntheticProgram);
    if (`sha256:${createHash('sha256').update(bytes).digest('hex')}` !== options.syntheticPeer.digest) {
      throw failure('SYNTHETIC_LAUNCH', 'owned stdio specimen does not match its controller digest');
    }
  }
  const launch = options.launch;
  if (!launch || await realpath(launch.command) !== await realpath(process.execPath)
    || !Array.isArray(launch.args) || launch.args[0] !== syntheticProgram) {
    throw failure('SYNTHETIC_LAUNCH', 'synthetic mode only runs the checked Node test program or controller-bound owned specimen');
  }
  const cwd = path.resolve(options.cwd);
  await inspectOwnedPath(root, cwd);
  if (!(await lstat(cwd)).isDirectory()) throw failure('CODEX_SCOPE', 'child cwd must be a directory');
  const env = {};
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (!environmentKeys.has(key) || typeof value !== 'string') {
      throw failure('CODEX_ENVIRONMENT', `unapproved child environment key ${key}`);
    }
    if (ownedEnvironmentKeys.has(key)) await inspectOwnedPath(root, value);
    env[key] = value;
  }
  if (!env.HOME || !env.CODEX_HOME) throw failure('CODEX_ENVIRONMENT', 'owned HOME and CODEX_HOME are required');
  const timeoutMs = budget(options.timeoutMs, 30_000, 'timeoutMs');
  const approvalTimeoutMs = budget(options.approvalTimeoutMs, 30_000, 'approvalTimeoutMs', 600_000);
  const closeTimeoutMs = budget(options.closeTimeoutMs, 10_000, 'closeTimeoutMs');
  const maxLineBytes = budget(options.maxLineBytes, 256 * 1024, 'maxLineBytes');
  const maxCaptureBytes = budget(options.maxCaptureBytes, 4 * 1024 * 1024, 'maxCaptureBytes');
  const maxStderrBytes = budget(options.maxStderrBytes, 256 * 1024, 'maxStderrBytes');
  const maxSendBytes = budget(options.maxSendBytes, 4 * 1024 * 1024, 'maxSendBytes');
  const child = spawn(launch.command, launch.args, {
    cwd, env, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
  });
  const sent = [];
  const received = [];
  const pending = new Map();
  const turnWaiters = new Set();
  const turnIds = new Set();
  const measurementTools = options.measurementTools;
  const toolReplies = new Set();
  const approvalReplies = new Set();
  let measurementThreadId = null;
  let measurementTurn = null;
  let turnActive = false;
  let nextId = 1;
  let buffer = Buffer.alloc(0);
  let capturedBytes = 0;
  let sentBytes = 0;
  let stderrBytes = 0;
  let firstError = null;
  let closing = null;
  let approvalWaiter = null;
  let approvalCancellation = null;
  let approvalStarted = false;
  const stdoutHash = createHash('sha256');
  const stderrHash = createHash('sha256');
  let exitCode = null;
  let exitSignal = null;
  const exited = new Promise((resolve) => {
    child.once('close', (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      if (buffer.length && !firstError) fail(failure('CODEX_TRUNCATED', 'stdout ended with an incomplete JSON line'));
      if ((code !== 0 || signal) && !firstError) fail(failure('CODEX_EXIT', `child exited unsuccessfully (${code ?? signal})`));
      if (approvalWaiter && !firstError) fail(failure('CODEX_EXIT', 'child exited while exact approval was pending'));
      for (const { reject } of pending.values()) reject(firstError ?? failure('CODEX_EXIT', 'child exited before its response'));
      pending.clear();
      for (const waiter of turnWaiters) waiter.reject(firstError ?? failure('CODEX_EXIT', 'child exited before turn completion'));
      turnWaiters.clear();
      resolve();
    });
  });
  let actorDeadline = performance.now() + timeoutMs;
  let timer = setTimeout(() => fail(failure('CODEX_TIMEOUT', 'session exceeded its active execution deadline')), timeoutMs);

  function fail(error) {
    if (firstError) return;
    firstError = error;
    approvalCancellation?.abort(error);
    approvalWaiter?.reject(error);
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
    for (const waiter of turnWaiters) waiter.reject(error);
    turnWaiters.clear();
    close().catch(() => {});
  }

  child.on('error', (cause) => fail(failure('CODEX_SPAWN', cause.message)));
  child.stdin.on('error', (cause) => fail(failure('CODEX_STDIN', cause.message)));
  child.stderr.on('data', (chunk) => {
    stderrBytes += chunk.length;
    capturedBytes += chunk.length;
    stderrHash.update(chunk);
    if (stderrBytes > maxStderrBytes || capturedBytes > maxCaptureBytes) {
      fail(failure('CODEX_CAPTURE_LIMIT', 'stderr or total capture exceeded its bound'));
    }
  });
  child.stdout.on('data', (chunk) => {
    capturedBytes += chunk.length;
    stdoutHash.update(chunk);
    if (capturedBytes > maxCaptureBytes) {
      fail(failure('CODEX_CAPTURE_LIMIT', 'total capture exceeded its bound'));
      return;
    }
    buffer = Buffer.concat([buffer, chunk]);
    while (!firstError) {
      const newline = buffer.indexOf(10);
      if (newline === -1) break;
      if (newline > maxLineBytes) {
        fail(failure('CODEX_CAPTURE_LIMIT', 'JSON line exceeded its bound'));
        return;
      }
      const line = buffer.subarray(0, newline);
      buffer = buffer.subarray(newline + 1);
      try {
        const message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line));
        if (!message || typeof message !== 'object' || Array.isArray(message)) {
          throw failure('CODEX_PROTOCOL', 'stdout message must be an object');
        }
        received.push(message);
        if (message.method === 'turn/completed' && measurementTurn
          && message.params?.threadId === measurementTurn.threadId && message.params?.turn?.id === measurementTurn.turnId) {
          measurementTools.finishTurn();
          measurementTurn = null;
        }
        for (const waiter of turnWaiters) waiter.check();
        if (Object.hasOwn(message, 'method') && Object.hasOwn(message, 'id')) {
          const refusal = requestRefusals.get(message.method);
          if (!refusal) throw failure('CODEX_SERVER_REQUEST', 'unsupported server request is not authorized');
          if (message.method === 'item/tool/call' && measurementTools) {
            const reply = measurementTools.handleToolCall(message.params).then((result) => {
              if (!closing && !firstError) write({ id: message.id, result });
            }).catch(fail);
            toolReplies.add(reply);
            reply.finally(() => toolReplies.delete(reply));
          } else write({ id: message.id, result: refusal });
        } else if (!Object.hasOwn(message, 'method')) {
          const response = pending.get(message.id);
          if (!response) throw failure('CODEX_RESPONSE_ID', 'response has no corresponding request');
          if (Object.hasOwn(message, 'error')) response.reject(failure('CODEX_RPC', 'app-server returned an error'));
          else if (Object.hasOwn(message, 'result')) {
            if (measurementTools && response.method === 'thread/start') {
              const threadId = message.result?.thread?.id;
              if (typeof threadId !== 'string' || !threadId || measurementThreadId) {
                throw failure('CODEX_TURN', 'measurement session requires one actual fresh thread ID');
              }
              measurementThreadId = threadId;
            }
            if (measurementTools && response.method === 'turn/start') {
              const turnId = message.result?.turn?.id;
              measurementTurn = { threadId: response.threadId, turnId };
              measurementTools.activateTurn(measurementTurn);
              // Early terminal notifications must not reopen authority when the response arrives later.
              if (received.some((event) => event.method === 'turn/completed'
                && event.params?.threadId === measurementTurn.threadId && event.params?.turn?.id === turnId)) {
                measurementTools.finishTurn();
                measurementTurn = null;
              }
            }
            response.resolve(message.result);
          }
          else throw failure('CODEX_PROTOCOL', 'response has no result or error');
          pending.delete(message.id);
        }
      } catch (cause) {
        fail(cause.code ? cause : failure('CODEX_PROTOCOL', 'stdout is not a complete UTF-8 JSON-line message'));
      }
    }
    if (buffer.length > maxLineBytes) fail(failure('CODEX_CAPTURE_LIMIT', 'pending JSON line exceeded its bound'));
  });

  function write(message) {
    if (firstError) throw firstError;
    if (approvalWaiter) throw failure('CODEX_APPROVAL_WAIT', 'actor requests are disabled during exact approval review');
    if (closing || !child.stdin.writable) throw failure('CODEX_CLOSED', 'cannot write to a closed session');
    const frame = `${JSON.stringify(message)}\n`;
    const bytes = Buffer.byteLength(frame);
    if (bytes > maxLineBytes || sentBytes + bytes > maxSendBytes) {
      const error = failure('CODEX_SEND_LIMIT', 'outbound line or session request history exceeded its bound');
      fail(error);
      throw error;
    }
    sentBytes += bytes;
    sent.push(JSON.parse(frame));
    child.stdin.write(frame);
  }

  function request(method, params) {
    if (firstError) return Promise.reject(firstError);
    if (measurementTools && method === 'turn/start' && !turnActive) {
      return Promise.reject(failure('CODEX_TURN', 'measurement turns must use the controller runTurn lifecycle'));
    }
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, method, threadId: params?.threadId });
      try {
        write({ id, method, params });
      } catch (cause) {
        pending.delete(id);
        reject(cause);
      }
    });
  }

  async function runTurn(params) {
    if (turnActive) throw failure('CODEX_TURN', 'only one active turn is allowed per session');
    if (typeof params?.threadId !== 'string' || !params.threadId
      || (measurementTools && params.threadId !== measurementThreadId)) {
      throw failure('CODEX_TURN', 'turn requires a thread ID');
    }
    turnActive = true;
    const receivedStart = received.length;
    const sentStart = sent.length;
    try {
      const result = await request('turn/start', params);
      const submitted = structuredClone(sent[sentStart]);
      const threadId = submitted.params.threadId;
      const turnId = result?.turn?.id;
      if (typeof turnId !== 'string' || !turnId || turnIds.has(turnId)) {
        throw failure('CODEX_TURN', 'turn/start returned a missing or reused turn ID');
      }
      turnIds.add(turnId);
      const belongs = (message) => message.params?.threadId === threadId
        && (message.params.turnId === turnId || message.params.turn?.id === turnId);
      await new Promise((resolve, reject) => {
        const waiter = {
          reject,
          check() {
            if (received.slice(receivedStart).some((message) => belongs(message)
              && message.method === 'turn/completed'
              && ['completed', 'failed', 'interrupted'].includes(message.params.turn.status))) {
              turnWaiters.delete(waiter);
              resolve();
            }
          },
        };
        if (firstError) return reject(firstError);
        if (exitCode !== null || exitSignal !== null) return reject(failure('CODEX_EXIT', 'child exited before turn completion'));
        turnWaiters.add(waiter);
        waiter.check();
      });
      return { threadId, turnId, request: submitted, events: structuredClone(received.slice(receivedStart).filter((message) => Object.hasOwn(message, 'method') && !Object.hasOwn(message, 'id'))) };
    } finally {
      measurementTools?.finishTurn();
      measurementTurn = null;
      turnActive = false;
    }
  }

  async function waitForApproval(decide) {
    if (firstError) throw firstError;
    if (closing || exitCode !== null || exitSignal !== null) throw failure('CODEX_CLOSED', 'cannot review approval for a closed session');
    if (typeof decide !== 'function' || approvalStarted || turnActive || pending.size || toolReplies.size) {
      throw failure('CODEX_APPROVAL_WAIT', 'exact approval requires an idle session and one single-use controller decision callback');
    }
    const remaining = actorDeadline - performance.now();
    if (remaining <= 0) {
      const error = failure('CODEX_TIMEOUT', 'active execution budget expired before exact approval review');
      fail(error);
      throw error;
    }
    // Human review has its own bound and grants no actor request or tool authority.
    approvalStarted = true;
    clearTimeout(timer);
    const cancellation = new AbortController();
    approvalCancellation = cancellation;
    let deadline;
    try {
      const decision = await new Promise((resolve, reject) => {
        approvalWaiter = { reject };
        deadline = setTimeout(() => fail(failure('APPROVAL_TIMEOUT', 'exact human approval exceeded its separate deadline')), approvalTimeoutMs);
        const reply = Promise.resolve().then(() => {
          if (firstError) throw firstError;
          if (closing || cancellation.signal.aborted || !approvalWaiter) {
            throw failure('CODEX_CLOSED', 'exact approval was cancelled before callback dispatch');
          }
          return decide({ signal: cancellation.signal });
        });
        approvalReplies.add(reply);
        reply.then((decision) => {
          approvalReplies.delete(reply);
          if (!cancellation.signal.aborted) resolve(decision);
        }, (cause) => {
          approvalReplies.delete(reply);
          reject(cause);
        });
      });
      if (firstError) throw firstError;
      if (closing) throw failure('CODEX_CLOSED', 'session closed before exact approval was accepted');
      return decision;
    } finally {
      clearTimeout(deadline);
      approvalWaiter = null;
      if (approvalCancellation === cancellation) approvalCancellation = null;
      if (!firstError && !closing && exitCode === null && exitSignal === null) {
        actorDeadline = performance.now() + remaining;
        timer = setTimeout(() => fail(failure('CODEX_TIMEOUT', 'session exceeded its active execution deadline')), remaining);
      }
    }
  }

  function close() {
    if (closing) return closing;
    // Publish the shared close promise before cancellation invokes controller callbacks.
    const finalized = Promise.resolve().then(async () => {
      clearTimeout(timer);
      const cancelledApproval = failure('CODEX_CLOSED', 'session closed during exact approval review');
      approvalCancellation?.abort(cancelledApproval);
      approvalWaiter?.reject(cancelledApproval);
      measurementTools?.finishTurn();
      measurementTurn = null;
      child.stdin.end();
      if (firstError) signalOwnedGroup(child, 'SIGTERM');
      let grace;
      await Promise.race([exited, new Promise((resolve) => { grace = setTimeout(resolve, 1000); })]);
      clearTimeout(grace);
      if (!groupAbsent(child)) {
        signalOwnedGroup(child, 'SIGTERM');
        await new Promise((resolve) => setTimeout(resolve, 1000));
        if (!groupAbsent(child)) signalOwnedGroup(child, 'SIGKILL');
      }
      await exited;
      await Promise.all([...toolReplies, ...approvalReplies]);
      if (!groupAbsent(child)) throw failure('CODEX_CLEANUP', 'owned child process group remains alive');
      return {
        exitCode, signal: exitSignal, processGroupAbsent: true, capturedBytes, stderrBytes,
        stdoutDigest: `sha256:${stdoutHash.digest('hex')}`,
        stderrDigest: `sha256:${stderrHash.digest('hex')}`,
        failure: firstError ? { code: firstError.code, message: firstError.message } : null,
      };
    });
    let deadline;
    closing = Promise.race([finalized, new Promise((resolve, reject) => {
      deadline = setTimeout(() => {
        const error = Object.assign(failure('CODEX_CLEANUP', 'session finalization exceeded its separate deadline'), {
          processCleanupUnconfirmed: true, processGroupAbsent: false,
        });
        try {
          error.processGroupAbsent = groupAbsent(child);
          if (!error.processGroupAbsent) signalOwnedGroup(child, 'SIGKILL');
        } catch (cause) {
          error.cause = cause;
        }
        fail(error);
        reject(error);
      }, closeTimeoutMs);
    })]).finally(() => clearTimeout(deadline));
    return closing;
  }

  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  return {
    request,
    runTurn,
    waitForApproval,
    notify: (method, params) => write({ method, ...(params === undefined ? {} : { params }) }),
    close,
    get sent() { return structuredClone(sent); },
    get received() { return structuredClone(received); },
    get failure() { return firstError; },
  };
}
