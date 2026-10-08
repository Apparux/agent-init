import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, readlink, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import { fingerprintPath, validateWriteTargetPhysicalScope } from './evaluation-harness.js';
import { readRegularFileNoFollow } from '../../src/installation/filesystem.js';

import { claudeJsonSecretFailure, sensitiveClaudeField, sensitiveClaudeText } from './claude-input-policy.js';
import { claudeEventFailure, parseClaudeTrace } from './claude-selection.js';
import { snapshotContext } from './claude-protocol.js';
import { decideClaudeNativeApply } from './claude-native-apply.js';

const helper = fileURLToPath(import.meta.url);
const events = ['SessionStart', 'PreToolUse', 'PostToolUse', 'UserPromptExpansion', 'Stop'];
const journalEvents = [...events, 'HookFailure'];
const readonlyTools = ['Read', 'Glob', 'Grep', 'Skill', 'EndConversation'];
const maxInputBytes = 2 * 1024 * 1024;
const maxJournalBytes = 8 * 1024 * 1024;
const sourceNamespaces = new Map([['userSettings', 'user'], ['user', 'user'], ['projectSettings', 'project'],
  ['project', 'project'], ['policySettings', 'managed'], ['managed', 'managed']]);
const nativeUuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const safeCommand = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const sha256 = /^sha256:[a-f0-9]{64}$/;
const pinnedHarnessVersion = '2.1.285';
// Only preparation can establish source authority; no caller-visible profile is
// accepted as a replacement for this before-invocation capture.
const heldMaterializationProfiles = new WeakMap();

function digest(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function failure(code) {
  return Object.assign(new Error(code), { code });
}

function quote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function bounded(value) {
  const pending = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const entry = pending.pop();
    if (++nodes > 10000 || entry.depth > 64) return false;
    if (typeof entry.value === 'number' && (!Number.isFinite(entry.value)
      || (Number.isInteger(entry.value) && !Number.isSafeInteger(entry.value)))) return false;
    if (!entry.value || typeof entry.value !== 'object') continue;
    const children = Object.values(entry.value);
    if (nodes + pending.length + children.length > 10000) return false;
    for (const child of children) pending.push({ value: child, depth: entry.depth + 1 });
  }
  return true;
}

async function privateFile(file, maxBytes) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes || (stat.mode & 0o777) !== 0o600) throw failure('NATIVE_CONTROL_INVALID');
    return await handle.readFile('utf8');
  } finally { await handle.close(); }
}

// This stage never authorizes mutations. Hook health is not a permission floor.
export async function prepareClaudeNativeObservation({ root, home, cwd, sessionId, motherSkillRoot, secrets = [], deferCanary = false, toolFree = false, skillOnly = false, inventory,
  materializationSources, harnessVersion = pinnedHarnessVersion }) {
  const held = materializationSources === undefined ? null : await captureMaterializationProfile({ root, home, cwd, sessionId,
    materializationSources, harnessVersion, secrets });
  const control = path.join(root, 'native-control', sessionId);
  await mkdir(control, { recursive: true, mode: 0o700 });
  const canary = deferCanary ? { file_path: path.join(cwd, 'AGENTS.md'), content: 'native-defer-boundary-canary\n' } : null;
  if (canary) {
    if (await fingerprintPath(cwd, 'AGENTS.md') !== 'missing') throw failure('NATIVE_CANARY_TARGET_EXISTS');
    await validateWriteTargetPhysicalScope(cwd, 'AGENTS.md');
  }
  const policy = { schemaVersion: 1, stage: toolFree ? 'tool-free' : skillOnly ? 'skill-only' : deferCanary ? 'defer-canary' : 'observe', sessionId,
    cwdAliases: [...new Set([cwd, await realpath(cwd)])],
    readRoots: [home, cwd], inventory: held ? held.inventory.map(entry => ({ name: entry.name, root: entry.canonicalRoot }))
      : inventory ?? [{ name: 'agent-init', root: motherSkillRoot }],
    ...(held ? { materializationBinding: { ownedRoot: held.ownedRoot, home: held.home, homeAliases: held.homeAliases, strictScope: true } } : {}),
    secretFingerprints: secrets.filter((value) => typeof value === 'string' && value.length)
      .map((value) => ({ length: value.length, digest: digest(value) })), ...(canary ? { canary } : {}) };
  await writeFile(path.join(control, 'policy.json'), JSON.stringify(policy), { flag: 'wx', mode: 0o600 });
  await writeFile(path.join(control, 'events.jsonl'), '', { flag: 'wx', mode: 0o600 });
  // Hooks run on the host. Clear inherited auth before executing this trusted helper.
  const command = ['/usr/bin/env', '-i', process.execPath, helper, '--control', control].map(quote).join(' ');
  const settings = { sandbox: { autoAllowBashIfSandboxed: false }, hooks: Object.fromEntries(events.map((event) => [event,
    [{ ...(event.includes('ToolUse') ? { matcher: '*' } : {}), hooks: [{ type: 'command', command, timeout: 5 }] }]])) };
  const settingsFile = path.join(control, 'settings.json');
  await writeFile(settingsFile, JSON.stringify(settings), { flag: 'wx', mode: 0o600 });
  const session = { control, settingsFile, sessionId, ...(canary ? { canary } : {}) };
  if (held) heldMaterializationProfiles.set(session, held);
  return session;
}

function summary(input, policy, raw) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !bounded(input)) throw failure('NATIVE_INPUT_INVALID');
  if (!events.includes(input.hook_event_name)) throw failure('NATIVE_EVENT_UNKNOWN');
  if (input.session_id !== policy.sessionId) throw failure('NATIVE_SESSION_MISMATCH');
  if (!policy.cwdAliases.includes(input.cwd)) throw failure('NATIVE_CWD_MISMATCH');
  const event = { event: input.hook_event_name, sessionId: policy.sessionId, inputDigest: digest(raw) };
  if (['PreToolUse', 'PostToolUse'].includes(event.event)) {
    if (typeof input.tool_use_id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.tool_use_id)
      || sensitiveClaudeText(input.tool_use_id)) throw failure('NATIVE_CALL_INVALID');
    event.callId = input.tool_use_id;
    if (policy.stage === 'tool-free' || (policy.stage === 'skill-only' && input.tool_name !== 'Skill')) {
      event.tool = 'unrecognized';
      event.code = policy.stage === 'tool-free' ? 'NATIVE_DISCOVERY_TOOL_DENIED' : 'NATIVE_ROUTING_TOOL_DENIED';
      return event;
    }
    if (policy.stage !== 'observe' && input.tool_name === 'Write' && event.event === 'PreToolUse') {
      event.tool = 'Write';
      if (!isDeepStrictEqual(input.tool_input, policy.canary)) {
        event.code = 'NATIVE_CANARY_INPUT_MISMATCH';
        return event;
      }
      event.toolInputDigest = digest(JSON.stringify(input.tool_input));
      event.decision = policy.stage === 'defer-canary' ? 'defer' : 'deny';
      if (event.decision === 'deny') event.code = 'NATIVE_CANARY_RESUME_DENIED';
      return event;
    }
    if (!readonlyTools.includes(input.tool_name)) {
      event.tool = 'unrecognized';
      event.code = 'NATIVE_MUTATION_DENIED';
      return event;
    }
    event.tool = input.tool_name;
    if (!input.tool_input || typeof input.tool_input !== 'object' || Array.isArray(input.tool_input)) throw failure('NATIVE_INPUT_INVALID');
    event.toolInputDigest = digest(JSON.stringify(input.tool_input));
    if (event.event === 'PreToolUse' && ['Read', 'Glob', 'Grep'].includes(event.tool)) {
      const code = claudeEventFailure({ type: 'assistant', session_id: policy.sessionId,
        message: { content: [{ type: 'tool_use', id: event.callId, name: event.tool, input: input.tool_input }] } },
      { sessionId: policy.sessionId, readRoots: policy.readRoots, cwd: input.cwd });
      if (code) event.code = 'NATIVE_READ_SCOPE_UNVERIFIED';
    }
    if (event.tool === 'Skill') {
      const candidate = policy.inventory.find((entry) => entry.name === input.tool_input.skill);
      if (candidate) event.command = candidate.name;
      else event.code = 'NATIVE_SKILL_SOURCE_UNVERIFIED';
      if (input.tool_input.args === undefined || typeof input.tool_input.args === 'string') {
        event.argsDigest = digest(input.tool_input.args ?? '');
        event.argsBytes = Buffer.byteLength(input.tool_input.args ?? '');
      }
    }
    if (event.event === 'PostToolUse') {
      if (!Object.hasOwn(input, 'tool_response')) throw failure('NATIVE_RESPONSE_MISSING');
      event.responseDigest = digest(JSON.stringify(input.tool_response));
      event.completionObserved = true;
      if (event.tool === 'Skill') {
        const response = input.tool_response;
        event.skillSuccess = false;
        event.skillBranch = 'unrecognized';
        if (response && typeof response === 'object' && !Array.isArray(response)) {
          if (response.success === true && safeCommand.test(response.commandName ?? '')
            && !sensitiveClaudeField(response.commandName) && !sensitiveClaudeText(response.commandName)
            && response.commandName === event.command && (response.status === undefined || response.status === 'inline')) {
            event.skillSuccess = true;
            event.skillBranch = 'inline';
          } else event.code = 'NATIVE_SKILL_POST_UNVERIFIED';
        }
      }
    }
  } else if (event.event === 'UserPromptExpansion') {
    const candidate = policy.inventory.find((entry) => [entry.name, `/${entry.name}`].includes(input.command_name));
    event.expansionKind = input.expansion_type === 'slash_command' ? 'slash_command' : 'unrecognized';
    if (candidate) event.command = candidate.name;
    // Only the native namespace enum crosses the privacy boundary, never a path
    // or an arbitrary technical-looking declaration. This is not source proof.
    if (sourceNamespaces.has(input.command_source)) event.sourceSample = sourceNamespaces.get(input.command_source);
    else event.sourceOmitted = true;
    if (typeof input.command_args === 'string') {
      event.argsDigest = digest(input.command_args);
      event.argsBytes = Buffer.byteLength(input.command_args);
    }
    event.sourceVerified = false;
  }
  return event;
}

async function appendEvent(control, event) {
  const handle = await open(path.join(control, 'events.jsonl'), constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    const line = `${JSON.stringify(event)}\n`;
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size + Buffer.byteLength(line) > maxJournalBytes) throw failure('NATIVE_JOURNAL_LIMIT');
    await handle.writeFile(line);
  } finally { await handle.close(); }
}

function checkRetainedSecrets(event, fingerprints) {
  const pending = [event];
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === 'string') {
      if (sensitiveClaudeText(value)) throw failure('SECRET_TRACE');
      for (const fingerprint of fingerprints) {
        for (let start = 0; start + fingerprint.length <= value.length; start += 1) {
          if (digest(value.slice(start, start + fingerprint.length)) === fingerprint.digest) throw failure('SECRET_TRACE');
        }
      }
    } else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) pending.push(key, child);
    }
  }
}

async function runHook(control, raw) {
  let event;
  let policy;
  try {
    const directory = await lstat(control);
    if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o777) !== 0o700) throw failure('NATIVE_CONTROL_INVALID');
    policy = JSON.parse(await privateFile(path.join(control, 'policy.json'), 65536));
    if (policy.schemaVersion !== 1 || !['observe', 'tool-free', 'skill-only', 'apply', 'defer-canary', 'deny-canary'].includes(policy.stage)
      || !Array.isArray(policy.secretFingerprints) || policy.secretFingerprints.length > 16
      || policy.secretFingerprints.some((entry) => !Number.isSafeInteger(entry.length) || entry.length < 1
        || !/^sha256:[a-f0-9]{64}$/.test(entry.digest))) throw failure('NATIVE_CONTROL_INVALID');
    const input = JSON.parse(raw);
    if (policy.stage === 'apply' && ['PreToolUse', 'PostToolUse'].includes(input.hook_event_name)) {
      const decision = await decideClaudeNativeApply({ control: await realpath(control), input });
      return decision.hookSpecificOutput ? { hookSpecificOutput: decision.hookSpecificOutput }
        : decision.continue === false ? { continue: false, stopReason: decision.stopReason } : {};
    }
    event = summary(input, policy, raw);
    if (policy.materializationBinding && ['SessionStart', 'Stop'].includes(event.event)) {
      event.transcriptRef = await nativeTranscriptReference(input, policy.materializationBinding);
    }
    checkRetainedSecrets(event, policy.secretFingerprints);
    await appendEvent(control, event);
  } catch (cause) {
    // Static output only: never echo malformed stdin, file contents or exception messages.
    const code = /^[A-Z_]+$/.test(cause.code ?? '') ? cause.code : 'NATIVE_HOOK_INVALID';
    if (policy?.sessionId && policy.schemaVersion === 1) {
      try { await appendEvent(control, { event: 'HookFailure', sessionId: policy.sessionId, code }); }
      catch { /* A broken journal cannot become positive coverage. */ }
    }
    return { continue: false, stopReason: code };
  }
  if (event.event === 'PreToolUse' && (event.code || event.decision)) return { hookSpecificOutput: { hookEventName: 'PreToolUse',
    permissionDecision: event.decision ?? 'deny', permissionDecisionReason: event.code ?? 'NATIVE_CANARY_DEFER' } };
  if (event.code) return { continue: false, stopReason: event.code };
  return {};
}

function nativeEnvelope(processResult, context) {
  if (processResult.cleanupError) throw failure('PROCESS_CLEANUP_FAILED');
  if (processResult.spawnError) throw failure('PROCESS_UNAVAILABLE');
  if (processResult.timedOut) throw failure('PROCESS_TIMEOUT');
  if (processResult.truncated) throw failure('TRACE_TRUNCATED');
  if (processResult.signal || processResult.status !== 0 || processResult.stopReason) throw failure('NATIVE_PROCESS_FAILED');
  const raw = processResult.stdout;
  if (typeof raw !== 'string' || !raw.trim() || Buffer.byteLength(raw) > maxJournalBytes) throw failure('NATIVE_RESULT_INVALID');
  const secrets = (context.secrets ?? []).filter((entry) => typeof entry === 'string' && entry.length);
  const secretFailure = claudeJsonSecretFailure(raw, secrets);
  if (secretFailure) throw failure(secretFailure === 'SECRET_TRACE' ? secretFailure : 'NATIVE_RESULT_INVALID');
  let result;
  try { result = JSON.parse(raw); } catch { throw failure('NATIVE_RESULT_INVALID'); }
  if (!bounded(result)) throw failure('NATIVE_RESULT_INVALID');
  const pending = [result];
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === 'string' && secrets.some((secret) => value.includes(secret))) throw failure('SECRET_TRACE');
    if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) pending.push(key, child);
  }
  if (result?.type !== 'result' || result.session_id !== context.sessionId || result.subtype !== 'success'
    || result.is_error !== false || !Array.isArray(result.permission_denials)) throw failure('NATIVE_RESULT_INVALID');
  return result;
}

async function canaryEvents(session) {
  const raw = await privateFile(path.join(session.control, 'events.jsonl'), maxJournalBytes);
  if (!raw || !raw.endsWith('\n')) throw failure('NATIVE_EVENTS_MISSING');
  let records;
  try { records = raw.trim().split('\n').map((line) => JSON.parse(line)); } catch { throw failure('NATIVE_JOURNAL_INVALID'); }
  if (records.some((event) => !bounded(event) || event.sessionId !== session.sessionId || !journalEvents.includes(event.event))) throw failure('NATIVE_JOURNAL_INVALID');
  return records;
}

// A diagnostic canary is not a dynamic Proposal or authority for any Apply.
export async function captureClaudeNativeDeferred(session, processResult, context) {
  const result = nativeEnvelope(processResult, context);
  if (result.stop_reason !== 'tool_deferred' || result.permission_denials.length) throw failure('NATIVE_DEFER_NOT_OBSERVED');
  const call = result.deferred_tool_use;
  if (!call || typeof call !== 'object' || Array.isArray(call) || Object.keys(call).sort().join(',') !== 'id,input,name'
    || typeof call.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(call.id) || sensitiveClaudeText(call.id)
    || call.name !== 'Write' || !isDeepStrictEqual(call.input, session.canary)) throw failure('NATIVE_DEFER_MISMATCH');
  const records = await canaryEvents(session);
  const pre = records.filter((event) => event.event === 'PreToolUse');
  if (records[0].event !== 'SessionStart' || records.some((event) => event.code || event.event === 'PostToolUse')
    || pre.length !== 1 || pre[0].callId !== call.id || pre[0].tool !== call.name || pre[0].decision !== 'defer'
    || pre[0].toolInputDigest !== digest(JSON.stringify(call.input))) throw failure('NATIVE_DEFER_MISMATCH');
  const policyFile = path.join(session.control, 'policy.json');
  const policy = JSON.parse(await privateFile(policyFile, 65536));
  if (policy.stage !== 'defer-canary' || policy.sessionId !== session.sessionId) throw failure('NATIVE_CONTROL_INVALID');
  policy.stage = 'deny-canary';
  await writeFile(policyFile, JSON.stringify(policy), { mode: 0o600 });
  return { id: call.id, name: call.name, inputDigest: pre[0].toolInputDigest,
    traceDigest: digest(processResult.stdout), traceBytes: Buffer.byteLength(processResult.stdout) };
}

export async function collectClaudeNativeDeniedResume(session, pendingCall, processResult, context) {
  const result = nativeEnvelope(processResult, context);
  if (result.stop_reason === 'tool_deferred' || result.deferred_tool_use) throw failure('NATIVE_RESUME_INCOMPLETE');
  const records = await canaryEvents(session);
  const pre = records.filter((event) => event.event === 'PreToolUse');
  const last = pre.at(-1);
  if (records.filter((event) => event.event === 'SessionStart').length !== 2 || records.some((event) => event.event === 'PostToolUse')
    || pre.length !== 2 || last.callId !== pendingCall.id || last.tool !== pendingCall.name
    || last.toolInputDigest !== pendingCall.inputDigest || last.decision !== 'deny' || last.code !== 'NATIVE_CANARY_RESUME_DENIED') throw failure('NATIVE_RESUME_MISMATCH');
  if (records.some((event) => event.code && event.code !== 'NATIVE_CANARY_RESUME_DENIED')) throw failure('NATIVE_RESUME_MISMATCH');
  return { status: 'blocked', code: 'NATIVE_DEFER_RESUME_DENY_OBSERVED', samePendingCallObserved: true,
    permissionFloorProven: false, applyEnabled: false, loadedEvidenceProven: false,
    pendingCall, processAttempts: 2, journalDigest: digest(JSON.stringify(records)),
    resumeTraceDigest: digest(processResult.stdout), resumeTraceBytes: Buffer.byteLength(processResult.stdout) };
}

export async function enableClaudeNativeApplyHooks(session) {
  const file = path.join(session.control, 'policy.json');
  const policy = JSON.parse(await privateFile(file, 65536));
  if (policy.sessionId !== session.sessionId || policy.stage !== 'tool-free') throw failure('NATIVE_CONTROL_INVALID');
  policy.stage = 'apply';
  await writeFile(file, JSON.stringify(policy), { mode: 0o600 });
}

function ownedRelative(rootAlias, root, target) {
  if (typeof target !== 'string' || !path.isAbsolute(target) || target !== path.normalize(target)) throw failure('NATIVE_MATERIALIZATION_SCOPE');
  for (const base of [rootAlias, root]) {
    const relative = path.relative(base, target);
    if (relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) return relative.split(path.sep).join('/');
  }
  throw failure('NATIVE_MATERIALIZATION_SCOPE');
}

async function ownedPhysicalTarget(profile, root, target, aliasLeaf = false) {
  let relative;
  try { relative = ownedRelative(profile.ownedRoot, root, target); }
  catch (cause) {
    if (profile.strictScope) throw cause;
    if (typeof target !== 'string' || !path.isAbsolute(target) || target !== path.normalize(target)) throw cause;
    // Resolve only a spelling of the owned root, e.g. /var -> /private/var.
    // Every component below that root still goes through the no-follow validator.
    for (let prefix = path.dirname(target); prefix !== path.dirname(prefix); prefix = path.dirname(prefix)) {
      try {
        const stat = await lstat(prefix);
        if (stat.isDirectory() && !stat.isSymbolicLink() && await realpath(prefix) === root) {
          relative = path.relative(prefix, target).split(path.sep).join('/');
          break;
        }
      } catch { /* An absent prefix cannot establish physical ownership. */ }
    }
    if (!relative) throw cause;
  }
  const checked = aliasLeaf ? path.posix.dirname(relative) : relative;
  if ((await validateWriteTargetPhysicalScope(root, checked)).length) throw failure('NATIVE_MATERIALIZATION_SCOPE');
  for (let current = root, index = 0, parts = checked.split('/'); index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    let stat;
    try { stat = await lstat(current); }
    catch (cause) { if (cause.code === 'ENOENT' && index === parts.length - 1) break; throw cause; }
    if (stat.uid !== process.getuid() || (stat.mode & 0o022)) throw failure('NATIVE_MATERIALIZATION_SCOPE');
  }
  return path.join(root, relative);
}

// Native journals can be 0644 inside a private owned root. Refuse writable,
// multiply-linked files and physical ancestor redirects; do not change modes.
async function boundedOwnedFile(file, limit, encoding = 'utf8') {
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.uid !== process.getuid()
    || (before.mode & 0o022) || before.size > limit) throw failure('NATIVE_MATERIALIZATION_FILE_INVALID');
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino) throw failure('NATIVE_MATERIALIZATION_FILE_INVALID');
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, null);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    const after = await handle.stat();
    const linked = await lstat(file);
    if (length > limit || length !== before.size || ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'nlink', 'mode', 'uid']
      .some(key => after[key] !== before[key] || linked[key] !== before[key])) throw failure('NATIVE_MATERIALIZATION_FILE_INVALID');
    const payload = bytes.subarray(0, length);
    if (encoding === null) return payload;
    const value = payload.toString('utf8');
    if (!Buffer.from(value).equals(payload)) throw failure('NATIVE_MATERIALIZATION_FILE_INVALID');
    return value;
  } finally { await handle.close(); }
}

function nativeMetadata(stat) {
  return { identity: `${stat.dev}:${stat.ino}`, mode: stat.mode & 0o777, uid: stat.uid, nlink: stat.nlink,
    size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
}

async function boundedSourceTree(root, captureSeal = false) {
  const entries = [];
  const seal = [];
  let bytes = 0;
  async function visit(directory, relativeDirectory = '', depth = 0) {
    if (depth > 16) throw failure('NATIVE_MATERIALIZATION_SOURCE_INVALID');
    const directoryStat = await lstat(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || directoryStat.uid !== process.getuid()
      || (directoryStat.mode & 0o022)) throw failure('NATIVE_MATERIALIZATION_SOURCE_INVALID');
    seal.push({ path: relativeDirectory || '.', type: 'directory', ...nativeMetadata(directoryStat) });
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entries.length >= 128) throw failure('NATIVE_MATERIALIZATION_SOURCE_INVALID');
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if ((await validateWriteTargetPhysicalScope(root, relativePath)).length) throw failure('NATIVE_MATERIALIZATION_SOURCE_INVALID');
      const target = path.join(root, relativePath);
      const stat = await lstat(target);
      if (stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o022)) throw failure('NATIVE_MATERIALIZATION_SOURCE_INVALID');
      if (stat.isDirectory()) {
        entries.push({ relativePath, type: 'directory' });
        await visit(target, relativePath, depth + 1);
      } else if (stat.isFile() && stat.nlink === 1 && stat.size <= 128 * 1024) {
        bytes += stat.size;
        if (bytes > 1024 * 1024) throw failure('NATIVE_MATERIALIZATION_SOURCE_INVALID');
        const content = await boundedOwnedFile(target, 128 * 1024, null);
        if (!isDeepStrictEqual(nativeMetadata(stat), nativeMetadata(await lstat(target)))) throw failure('NATIVE_MATERIALIZATION_SOURCE_CHANGED');
        entries.push({ relativePath, type: 'file', executable: (stat.mode & 0o111) !== 0, content });
        seal.push({ path: relativePath, type: 'file', ...nativeMetadata(stat), contentDigest: digest(content) });
      } else throw failure('NATIVE_MATERIALIZATION_SOURCE_INVALID');
    }
    if (!isDeepStrictEqual(nativeMetadata(directoryStat), nativeMetadata(await lstat(directory)))) throw failure('NATIVE_MATERIALIZATION_SOURCE_CHANGED');
  }
  await visit(root);
  // Exact existing agent-init-tree-v1 framing; bounded/no-follow reads above
  // avoid broadening the generic filesystem helper for this narrow producer.
  const hash = createHash('sha256');
  const field = value => {
    const payload = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
    hash.update(`${payload.length}:`); hash.update(payload); hash.update(';');
  };
  field('agent-init-tree-v1');
  entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'en'));
  for (const entry of entries) {
    field(entry.type); field(entry.relativePath);
    if (entry.type === 'file') { field(entry.executable ? 'executable' : 'regular'); field(entry.content); }
  }
  const treeDigest = `sha256:${hash.digest('hex')}`;
  seal.sort((left, right) => left.path.localeCompare(right.path, 'en'));
  return captureSeal ? { treeDigest, seal } : treeDigest;
}

async function aliasSnapshot(physicalAlias, nativeSeal = false) {
  const alias = await lstat(physicalAlias);
  if ((!alias.isSymbolicLink() && !alias.isDirectory()) || alias.uid !== process.getuid()
    || (alias.mode & 0o022 && !alias.isSymbolicLink())) throw failure('NATIVE_MATERIALIZATION_SOURCE_INVALID');
  return { ...(nativeSeal ? nativeMetadata(alias) : { identity: `${alias.dev}:${alias.ino}`, mode: alias.mode & 0o777, mtimeMs: alias.mtimeMs }),
    linkText: alias.isSymbolicLink() ? await readlink(physicalAlias) : null };
}

async function sourceSeals(entry, physicalAlias) {
  const aliasSeal = await aliasSnapshot(physicalAlias, entry.nativeSeal === true);
  const seal = entry.nativeSeal ? (await boundedSourceTree(entry.canonicalRoot, true)).seal : await snapshotContext(entry.canonicalRoot);
  if (!isDeepStrictEqual(aliasSeal, entry.aliasSeal) || !isDeepStrictEqual(seal, entry.seal)) throw failure('NATIVE_MATERIALIZATION_SOURCE_CHANGED');
}

async function heldSourceSeals(profile, root) {
  for (const entry of profile.inventory) {
    const physicalAlias = await ownedPhysicalTarget(profile, root, entry.aliasRoot, true);
    await ownedPhysicalTarget(profile, root, entry.canonicalRoot);
    if (await realpath(physicalAlias) !== entry.canonicalRoot) throw failure('NATIVE_MATERIALIZATION_SOURCE_CHANGED');
    await sourceSeals(entry, physicalAlias);
  }
}

function immutable(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}

async function captureMaterializationProfile({ root, home, cwd, sessionId, materializationSources, harnessVersion, secrets }) {
  if (!/^2\.1\.285(?: \(Claude Code\))?$/.test(harnessVersion ?? '') || !nativeUuid.test(sessionId ?? '')
    || !Array.isArray(materializationSources) || materializationSources.length > 128 || !bounded(materializationSources)) {
    throw failure('NATIVE_MATERIALIZATION_PROFILE_UNSUPPORTED');
  }
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.uid !== process.getuid() || (rootStat.mode & 0o077)) {
    throw failure('NATIVE_MATERIALIZATION_SCOPE');
  }
  const ownedRoot = await realpath(root);
  const scope = { ownedRoot: root, strictScope: true };
  const physicalHome = await ownedPhysicalTarget(scope, ownedRoot, home);
  const physicalCwd = await ownedPhysicalTarget(scope, ownedRoot, cwd);
  const configDirectory = await ownedPhysicalTarget(scope, ownedRoot, path.join(home, '.claude'));
  if (!(await lstat(configDirectory)).isDirectory()) throw failure('NATIVE_MATERIALIZATION_SCOPE');
  const inventory = [];
  for (const source of materializationSources) {
    if (!source || !safeCommand.test(source.name ?? '') || sensitiveClaudeField(source.name) || sensitiveClaudeText(source.name)
      || !['user', 'project', 'managed'].includes(source.namespace)) throw failure('NATIVE_MATERIALIZATION_SOURCE_INVALID');
    const sourceContainer = await ownedPhysicalTarget(scope, ownedRoot, source.sourceContainer);
    const canonicalRoot = await ownedPhysicalTarget(scope, ownedRoot, source.canonicalRoot);
    const physicalAlias = await ownedPhysicalTarget(scope, ownedRoot, source.aliasRoot, true);
    const relative = path.relative(sourceContainer, canonicalRoot);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
      || await realpath(physicalAlias) !== canonicalRoot || await realpath(source.canonicalRoot) !== canonicalRoot) {
      throw failure('NATIVE_MATERIALIZATION_SOURCE_UNVERIFIED');
    }
    const aliasSeal = await aliasSnapshot(physicalAlias, true);
    const { treeDigest, seal } = await boundedSourceTree(canonicalRoot, true);
    const original = await boundedOwnedFile(path.join(canonicalRoot, 'SKILL.md'), 128 * 1024);
    // Unsupported source transforms must be rejected before the model boundary,
    // not retrospectively legitimized by a matching-looking transcript.
    exactNativePrompt(original, '', source.aliasRoot, cwd, sessionId);
    const entry = { name: source.name, namespace: source.namespace, aliasRoot: source.aliasRoot, canonicalRoot, sourceContainer,
      fileDigest: digest(original), treeDigest, seal, aliasSeal, nativeSeal: true };
    await sourceSeals(entry, physicalAlias);
    await ownedPhysicalTarget(scope, ownedRoot, source.canonicalRoot);
    await ownedPhysicalTarget(scope, ownedRoot, source.aliasRoot, true);
    checkRetainedSecrets({ command: entry.name, namespace: entry.namespace,
      sourceRootRef: `<owned-root>/${ownedRelative(ownedRoot, ownedRoot, canonicalRoot)}`,
      aliasRootRef: `<owned-root>/${ownedRelative(ownedRoot, ownedRoot, physicalAlias)}` },
    secrets.filter(value => typeof value === 'string' && value.length).map(value => ({ length: value.length, digest: digest(value) })));
    inventory.push(entry);
  }
  if (new Set(inventory.map(entry => entry.aliasRoot)).size !== inventory.length) throw failure('NATIVE_MATERIALIZATION_SOURCE_UNVERIFIED');
  await heldSourceSeals({ ...scope, inventory }, ownedRoot);
  return immutable({ profile: 'claude-2.1.285-file-skill', ownedRoot: root, strictScope: true, home: physicalHome,
    homeAliases: [...new Set([home, physicalHome])], cwd: physicalCwd, harnessVersion,
    sessionId, inventory, secrets: secrets.filter(value => typeof value === 'string' && value.length) });
}

async function nativeTranscriptReference(input, binding) {
  if (!Object.hasOwn(input, 'transcript_path')) throw failure('NATIVE_MATERIALIZATION_TRANSCRIPT_MISSING');
  const target = input.transcript_path;
  if (typeof target !== 'string' || !target || target.length > 4096 || !path.isAbsolute(target) || target !== path.normalize(target)) {
    throw failure('NATIVE_MATERIALIZATION_TRANSCRIPT_INVALID');
  }
  // Reject outside spellings lexically before touching any filesystem path.
  // Root aliases captured at preparation are the only permitted equivalences.
  const relative = (binding.homeAliases ?? [binding.home]).map(home => path.relative(path.join(home, '.claude/projects'), target).split(path.sep))
    .find(parts => parts.length === 2 && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/.test(parts[0]) && parts[1] === `${input.session_id}.jsonl`);
  if (!relative) throw failure('NATIVE_MATERIALIZATION_TRANSCRIPT_SCOPE');
  const rootStat = await lstat(binding.ownedRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.uid !== process.getuid() || (rootStat.mode & 0o077)) {
    throw failure('NATIVE_MATERIALIZATION_TRANSCRIPT_SCOPE');
  }
  const root = await realpath(binding.ownedRoot);
  let physical;
  try { physical = await ownedPhysicalTarget(binding, root, path.join(binding.home, '.claude/projects', ...relative)); }
  catch { throw failure('NATIVE_MATERIALIZATION_TRANSCRIPT_SCOPE'); }
  return `<owned-root>/${ownedRelative(binding.ownedRoot, root, physical)}`;
}

async function heldJournalFile(profile, context, hooks) {
  const starts = hooks.filter(event => event.event === 'SessionStart');
  const stops = hooks.filter(event => event.event === 'Stop');
  const references = [starts[0]?.transcriptRef, stops[0]?.transcriptRef];
  if (references.some(value => value === undefined)) throw failure('NATIVE_MATERIALIZATION_TRANSCRIPT_MISSING');
  if (starts.length !== 1 || stops.length !== 1 || new Set(references).size !== 1) throw failure('NATIVE_MATERIALIZATION_TRANSCRIPT_AMBIGUOUS');
  const reference = references[0];
  if (typeof reference !== 'string' || !reference.startsWith('<owned-root>/')) throw failure('NATIVE_MATERIALIZATION_TRANSCRIPT_INVALID');
  const relative = reference.slice('<owned-root>/'.length);
  const target = path.join(profile.ownedRoot, relative);
  if (await nativeTranscriptReference({ session_id: context.sessionId, transcript_path: target }, profile) !== reference) {
    throw failure('NATIVE_MATERIALIZATION_TRANSCRIPT_INVALID');
  }
  return target;
}

// Deliberately small installed-native FileSkill profile, not a general prompt
// engine. Whitespace/BOM/frontmatter and insertion order must match byte-for-byte.
function exactNativePrompt(original, args, alias, cwd, sessionId) {
  const normalized = original.replace(/^﻿/, '');
  const frontmatter = /^---\s*\n([\s\S]*?)---\s*\n?/.exec(normalized);
  if (frontmatter && /^(?:context|effort|hooks|prompt)\s*:/m.test(frontmatter[1])) throw failure('NATIVE_MATERIALIZATION_FORMAT_UNSUPPORTED');
  let body = frontmatter ? normalized.slice(frontmatter[0].length) : original;
  const unsupported = /[￿￾]|\\\$(?:ARGUMENTS|\{|\d)|\$(?!ARGUMENTS\b|\{CLAUDE_(?:SKILL_DIR|PROJECT_DIR|SESSION_ID)\})[A-Za-z_0-9{]/;
  // Arguments are literal insertion data, not a second source-template pass:
  // JS ${value} and an inserted $ARGUMENTS must not be rejected or re-expanded.
  // Only native reserved transforms that we do not implement remain unsupported.
  const unsupportedArguments = /[￿￾]|\$\{CLAUDE_(?!(?:SKILL_DIR|PROJECT_DIR|SESSION_ID)\})/;
  if (unsupported.test(body) || unsupportedArguments.test(args) || /\$ARGUMENTS(?:\[|\.)/.test(body)) throw failure('NATIVE_MATERIALIZATION_FORMAT_UNSUPPORTED');
  const transformed = args.replace(/`!/g, '` !').replace(/!`/g, '! `').replace(/(^|\s)!/gm, '$1\\!');
  if (/\$ARGUMENTS/.test(body)) body = body.replace(/\$ARGUMENTS/g, () => transformed);
  else if (args) body += `\n\nARGUMENTS: ${transformed}`;
  body = body.replace(/\$\{CLAUDE_SKILL_DIR\}/g, () => alias)
    .replace(/\$\{CLAUDE_PROJECT_DIR\}/g, () => cwd).replace(/\$\{CLAUDE_SESSION_ID\}/g, () => sessionId);
  if (/```!\s*\n?[\s\S]*?\n?```/g.test(body) || /(?<=^|\s)!`[^`]+`/gm.test(body)) throw failure('NATIVE_MATERIALIZATION_FORMAT_UNSUPPORTED');
  return `Base directory for this skill: ${alias}\n\n${body}`;
}

function journalText(record) {
  const content = record.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content) && content.length === 1 && content[0]?.type === 'text' && typeof content[0].text === 'string') return content[0].text;
  return null;
}

function preparedCollectorContext(session, context) {
  const held = heldMaterializationProfiles.get(session);
  return held ? { ...context, harnessVersion: context.harnessVersion ?? held.harnessVersion,
    secrets: [...new Set([...held.secrets, ...(context.secrets ?? [])])] } : context;
}

async function collectNativeMaterialization(session, processResult, context, hooks) {
  const held = heldMaterializationProfiles.get(session);
  const profile = held ?? context.nativeMaterialization;
  if (!profile) return {};
  if (held && held.sessionId !== context.sessionId) throw failure('NATIVE_MATERIALIZATION_PROFILE_UNSUPPORTED');
  if (profile.profile !== 'claude-2.1.285-file-skill' || !/^2\.1\.285(?: \(Claude Code\))?$/.test(context.harnessVersion ?? '')
    || !nativeUuid.test(context.sessionId ?? '') || session.sessionId !== context.sessionId
    || typeof profile.ownedRoot !== 'string' || !path.isAbsolute(profile.ownedRoot)
    || !Array.isArray(profile.inventory) || (!profile.inventory.length && !held) || profile.inventory.length > 128 || !bounded(profile.inventory)) {
    throw failure('NATIVE_MATERIALIZATION_PROFILE_UNSUPPORTED');
  }
  const rootStat = await lstat(profile.ownedRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.uid !== process.getuid() || (rootStat.mode & 0o077)) throw failure('NATIVE_MATERIALIZATION_SCOPE');
  const root = await realpath(profile.ownedRoot);
  const cwd = await ownedPhysicalTarget(profile, root, context.cwd);
  if (held && cwd !== held.cwd) throw failure('NATIVE_MATERIALIZATION_PROFILE_UNSUPPORTED');
  const journalFile = await ownedPhysicalTarget(profile, root, held ? await heldJournalFile(held, context, hooks) : profile.journalFile);
  if (held) await heldSourceSeals(held, root);
  let raw;
  try { raw = await boundedOwnedFile(journalFile, maxJournalBytes); }
  catch (cause) { if (cause.code === 'ENOENT') throw failure('NATIVE_MATERIALIZATION_JOURNAL_MISSING'); throw cause; }
  const secretFailure = raw ? claudeJsonSecretFailure(raw, context.secrets ?? []) : null;
  if (secretFailure) throw failure(secretFailure);
  // Even without captured sources the native location/file must be valid, but
  // no inventory is never exhaustive zero-selection or loaded evidence.
  if (held && !held.inventory.length) return {};
  if (!raw || !raw.endsWith('\n')) throw failure('NATIVE_MATERIALIZATION_JOURNAL_INCOMPLETE');
  const lines = raw.slice(0, -1).split('\n');
  if (lines.length > 4096 || lines.some(line => !line)) throw failure('NATIVE_MATERIALIZATION_JOURNAL_INVALID');
  let records;
  try { records = lines.map(JSON.parse); } catch { throw failure('NATIVE_MATERIALIZATION_JOURNAL_INVALID'); }
  const ancestors = new Map();
  for (const [index, record] of records.entries()) {
    if (!record || typeof record !== 'object' || Array.isArray(record) || !bounded(record)
      || (record.sessionId !== undefined && record.sessionId !== context.sessionId)) throw failure('NATIVE_MATERIALIZATION_JOURNAL_INVALID');
    if (record.uuid === undefined && !['user', 'assistant'].includes(record.type)) continue;
    if (!nativeUuid.test(record.uuid ?? '') || ancestors.has(record.uuid) || record.sessionId !== context.sessionId
      || record.version !== '2.1.285' || ![context.cwd, cwd].includes(record.cwd)
      || (record.parentUuid !== null && !ancestors.has(record.parentUuid)) || record.isVirtual || record.isReplay) {
      throw failure('NATIVE_MATERIALIZATION_CHAIN_INVALID');
    }
    ancestors.set(record.uuid, { record, index });
  }
  const frames = records.map((record, index) => ({ record, index })).filter(({ record }) => record.type === 'user'
    && record.isMeta === true && record.turnCompanion === true && record.message?.role === 'user'
    && Array.isArray(record.message.content) && record.message.content.length === 1 && journalText(record));
  const materializations = [];
  for (const { record: frame, index: frameIndex } of frames) {
    const text = journalText(frame);
    const alias = /^Base directory for this skill: ([^\r\n]+)\n\n/.exec(text)?.[1];
    if (!alias) continue;
    const candidates = profile.inventory.filter(entry => entry.aliasRoot === alias);
    if (candidates.length !== 1) throw failure('NATIVE_MATERIALIZATION_SOURCE_UNVERIFIED');
    const entry = candidates[0];
    if (!safeCommand.test(entry.name ?? '') || sensitiveClaudeField(entry.name) || sensitiveClaudeText(entry.name)
      || !['user', 'project', 'managed'].includes(entry.namespace) || !sha256.test(entry.fileDigest ?? '')
      || !sha256.test(entry.treeDigest ?? '') || !Array.isArray(entry.seal) || !entry.aliasSeal) throw failure('NATIVE_MATERIALIZATION_SOURCE_INVALID');
    const container = await ownedPhysicalTarget(profile, root, entry.sourceContainer);
    const canonical = await ownedPhysicalTarget(profile, root, entry.canonicalRoot);
    const physicalAlias = await ownedPhysicalTarget(profile, root, alias, true);
    const relative = path.relative(container, canonical);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
      || await realpath(physicalAlias) !== canonical || await realpath(entry.canonicalRoot) !== canonical) throw failure('NATIVE_MATERIALIZATION_SOURCE_UNVERIFIED');
    const treeDigest = await boundedSourceTree(canonical);
    await sourceSeals(entry, physicalAlias);
    const file = await ownedPhysicalTarget(profile, root, path.join(canonical, 'SKILL.md'));
    const original = await boundedOwnedFile(file, 128 * 1024);
    if (digest(original) !== entry.fileDigest || treeDigest !== entry.treeDigest) throw failure('NATIVE_MATERIALIZATION_SOURCE_CHANGED');
    let parent = ancestors.get(frame.parentUuid);
    let args;
    let callIdDigest;
    let branch = 'direct-slash';
    if (Object.hasOwn(frame, 'sourceToolUseID')) {
      branch = 'tool-skill';
      const callId = frame.sourceToolUseID;
      if (typeof callId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(callId) || sensitiveClaudeText(callId)) throw failure('NATIVE_MATERIALIZATION_CALL_UNVERIFIED');
      let matchingCalls = [];
      while (parent) {
        const caller = parent.record;
        if (caller.type === 'assistant' && Array.isArray(caller.message?.content)) matchingCalls = caller.message.content
          .filter(block => block.type === 'tool_use' && block.id === callId);
        if (matchingCalls.length) break;
        parent = ancestors.get(caller.parentUuid);
      }
      const call = matchingCalls[0];
      if (matchingCalls.length !== 1 || call.name !== 'Skill' || !call.input || typeof call.input !== 'object' || Array.isArray(call.input)
        || Object.keys(call.input).some(key => !['skill', 'args'].includes(key)) || call.input.skill !== entry.name
        || (call.input.args !== undefined && typeof call.input.args !== 'string')) throw failure('NATIVE_MATERIALIZATION_CALL_UNVERIFIED');
      args = call.input.args ?? '';
      const pre = hooks.filter(event => event.event === 'PreToolUse' && event.tool === 'Skill' && event.callId === callId);
      const post = hooks.filter(event => event.event === 'PostToolUse' && event.tool === 'Skill' && event.callId === callId);
      if (pre.length !== 1 || post.length !== 1 || post[0].skillSuccess !== true || post[0].skillBranch !== 'inline'
        || [pre[0], post[0]].some(event => event.command !== entry.name || event.toolInputDigest !== digest(JSON.stringify(call.input))
          || event.argsDigest !== digest(args) || event.argsBytes !== Buffer.byteLength(args))) throw failure('NATIVE_MATERIALIZATION_CALL_UNVERIFIED');
      callIdDigest = digest(callId);
    } else {
      const caller = parent?.record;
      if (!caller || caller.type !== 'user' || caller.isMeta) throw failure('NATIVE_MATERIALIZATION_CALL_UNVERIFIED');
      const markup = journalText(caller);
      const commands = [...(markup ?? '').matchAll(/<command-name>\/([a-z0-9]+(?:-[a-z0-9]+)*)<\/command-name>/g)];
      const argumentsMatches = [...(markup ?? '').matchAll(/<command-args>([\s\S]*?)<\/command-args>/g)];
      if (commands.length !== 1 || argumentsMatches.length > 1 || commands[0][1] !== entry.name
        || /<\/?command-args/.test((markup ?? '').replace(argumentsMatches[0]?.[0] ?? '', ''))) throw failure('NATIVE_MATERIALIZATION_CALL_UNVERIFIED');
      args = argumentsMatches[0]?.[1] ?? '';
      const expansions = hooks.filter(event => event.event === 'UserPromptExpansion' && event.expansionKind === 'slash_command'
        && event.command === entry.name && event.sourceSample === entry.namespace && event.argsDigest === digest(args)
        && event.argsBytes === Buffer.byteLength(args));
      if (expansions.length !== 1) throw failure('NATIVE_MATERIALIZATION_CALL_UNVERIFIED');
    }
    const expected = exactNativePrompt(original, args, alias, frame.cwd, context.sessionId);
    if (text !== expected) throw failure('NATIVE_MATERIALIZATION_RENDER_MISMATCH');
    let streamFrameMatched = false;
    // Stream synthetic flags alone have no authority. Only the owned journal
    // establishes meta/companion/source, optionally corroborated by UUID+content.
    if (processResult.stdout.trim().split('\n').length > 1) {
      const stream = processResult.stdout.trim().split('\n').map(JSON.parse);
      const matching = stream.filter(event => event.type === 'user' && (event.uuid === frame.uuid
        || journalText(event)?.startsWith(`Base directory for this skill: ${alias}\n\n`)));
      if (matching.length > 1 || (matching.length === 1 && (matching[0].uuid !== frame.uuid
        || !isDeepStrictEqual(matching[0].message?.content, frame.message.content)))) throw failure('NATIVE_MATERIALIZATION_STREAM_MISMATCH');
      streamFrameMatched = matching.length === 1;
    }
    await sourceSeals(entry, physicalAlias);
    materializations.push({ command: entry.name, namespace: entry.namespace, branch, ...(callIdDigest ? { callIdDigest } : {}), scope: 'materialization-only',
      sourceRootRef: `<owned-root>/${ownedRelative(profile.ownedRoot, root, canonical)}`,
      aliasRootRef: `<owned-root>/${ownedRelative(profile.ownedRoot, root, physicalAlias)}`,
      sourceFileDigest: entry.fileDigest, sourceTreeDigest: entry.treeDigest, materializationDigest: digest(text),
      materializationBytes: Buffer.byteLength(text), argsDigest: digest(args), argsBytes: Buffer.byteLength(args),
      journalRef: `<owned-root>/${ownedRelative(profile.ownedRoot, root, journalFile)}`,
      journalDigest: digest(raw), journalBytes: Buffer.byteLength(raw), journalLocation: { callerIndex: parent.index, frameIndex },
      frameUuidDigest: digest(frame.uuid), streamFrameMatched });
  }
  if (!materializations.length) throw failure('NATIVE_MATERIALIZATION_MISSING');
  if (held) await heldSourceSeals(held, root);
  const retained = { scope: 'materialization-only', qualification: 'unqualified', exactSourceMaterializationMatched: true,
    sourceMaterializations: materializations, selectionProtocolVerified: false, hookCoverageProven: false, permissionFloorProven: false };
  checkRetainedSecrets(retained, (context.secrets ?? []).filter(value => typeof value === 'string' && value.length)
    .map(value => ({ length: value.length, digest: digest(value) })));
  return retained;
}

export async function collectClaudeNativeProposalObservation(session, processResult, context) {
  context = preparedCollectorContext(session, context);
  nativeEnvelope(processResult, context);
  const records = await canaryEvents(session);
  checkRetainedSecrets(records, (context.secrets ?? []).filter(value => typeof value === 'string' && value.length)
    .map(value => ({ length: value.length, digest: digest(value) })));
  const failed = records.find(event => event.code);
  if (failed) throw failure(failed.code);
  if (records.some(event => ['PreToolUse', 'PostToolUse'].includes(event.event))) throw failure('NATIVE_SETUP_TOOL_ATTEMPT');
  const starts = records.filter(event => event.event === 'SessionStart');
  const stops = records.filter(event => event.event === 'Stop');
  const expansions = records.filter(event => event.event === 'UserPromptExpansion');
  if (starts.length !== 1 || stops.length !== 1 || records[0].event !== 'SessionStart'
    || records.at(-1).event !== 'Stop') throw failure('NATIVE_LIFECYCLE_INCOMPLETE');
  if (expansions.length !== 1 || expansions[0].command !== 'agent-init'
    || expansions[0].expansionKind !== 'slash_command') throw failure('NATIVE_SKILL_OBSERVATION_MISSING');
  return { nativeExpansionObserved: true, directExpansions: expansions,
    traceDigest: digest(processResult.stdout), traceBytes: Buffer.byteLength(processResult.stdout),
    sourceVerified: false, hookCoverageProven: false, permissionFloorProven: false, selectionProtocolVerified: false,
    ...await collectNativeMaterialization(session, processResult, context, records) };
}

export async function collectClaudeNativeObservation(session, processResult, context) {
  context = preparedCollectorContext(session, context);
  const trace = parseClaudeTrace(processResult, context);
  const provenance = { trace: trace.provenance, hookCoverageProven: false, permissionFloorProven: false,
    selectionProtocolVerified: false, directExpansions: [], toolCompletions: [] };
  const error = (code) => ({ status: 'error', code, provenance });
  if (trace.status === 'error') return error(trace.code);
  if (context.toolFree && trace.provenance.catalog.tools.length) return error('NATIVE_DISCOVERY_TOOLS_PRESENT');
  let records;
  try {
    const raw = await privateFile(path.join(session.control, 'events.jsonl'), maxJournalBytes);
    if (!raw || !raw.endsWith('\n')) return error('NATIVE_EVENTS_MISSING');
    records = raw.trim().split('\n').map((line) => JSON.parse(line));
  } catch { return error('NATIVE_JOURNAL_INVALID'); }
  if (records.some((event) => !bounded(event) || event.sessionId !== session.sessionId || !journalEvents.includes(event.event))) return error('NATIVE_JOURNAL_INVALID');
  try { checkRetainedSecrets(records, (context.secrets ?? []).filter(value => typeof value === 'string' && value.length)
    .map(value => ({ length: value.length, digest: digest(value) }))); }
  catch { return error('SECRET_TRACE'); }
  const starts = records.filter((event) => event.event === 'SessionStart');
  const stops = records.filter((event) => event.event === 'Stop');
  provenance.lifecycleObserved = { starts: starts.length, stops: stops.length };
  provenance.directExpansions = records.filter((event) => event.event === 'UserPromptExpansion');
  const calls = new Map();
  for (const event of records) {
    if (event.code) return error(event.code);
    if (event.event === 'PreToolUse') {
      if (calls.has(event.callId)) return error('NATIVE_CALL_REPLAY');
      calls.set(event.callId, event);
    } else if (event.event === 'PostToolUse') {
      const pre = calls.get(event.callId);
      if (!pre || pre.completed || pre.tool !== event.tool || pre.toolInputDigest !== event.toolInputDigest) return error('NATIVE_POST_UNMATCHED');
      pre.completed = true;
      provenance.toolCompletions.push(event);
    }
  }
  if ([...calls.values()].some((event) => !event.completed)) return error('NATIVE_POST_MISSING');
  const tracedCalls = trace.provenance.toolCalls;
  if (tracedCalls.length !== calls.size || tracedCalls.some((call) => {
    const observed = calls.get(call.id);
    return !observed || observed.tool !== call.name || observed.toolInputDigest !== call.inputDigest;
  })) return error('NATIVE_TRACE_MISMATCH');
  if (starts.length !== 1 || stops.length !== 1 || records[0].event !== 'SessionStart' || records.at(-1).event !== 'Stop') return error('NATIVE_LIFECYCLE_INCOMPLETE');
  if (context.requireSkillObservation && !provenance.directExpansions.some((event) => event.command && event.expansionKind === 'slash_command')
    && !provenance.toolCompletions.some((event) => event.tool === 'Skill' && event.command)) return error('NATIVE_SKILL_OBSERVATION_MISSING');
  try { Object.assign(provenance, await collectNativeMaterialization(session, processResult, context, records)); }
  catch (cause) { return error(/^NATIVE_MATERIALIZATION_[A-Z_]+$|^SECRET_TRACE$|^TRACE_[A-Z_]+$/.test(cause.code ?? '') ? cause.code : 'NATIVE_MATERIALIZATION_INVALID'); }
  // An exact materialization sample still cannot prove exhaustive native coverage
  // or a fail-closed permission floor; it never publishes loaded evidence.
  return { status: 'blocked', code: 'NATIVE_SELECTION_UNVERIFIED', provenance };
}

export async function invokeClaudeNativeRoutingSession({ root, home, request, command, model, env, secrets = [], executionKind, invoke }) {
  if (!['real-cli', 'test-double'].includes(executionKind) || typeof invoke !== 'function'
    || !request || request.phase !== 'routing' || request.resume !== false || !Array.isArray(request.history) || request.history.length
    || request.profile?.readOnly !== true || !['implicit', 'explicit'].includes(request.kind)
    || typeof request.prompt !== 'string' || !request.prompt.trim() || Buffer.byteLength(request.prompt) > 65536
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(request.sessionId ?? '')
    || typeof request.harnessVersion !== 'string' || !/^[0-9A-Za-z][0-9A-Za-z._()+ -]{0,127}$/.test(request.harnessVersion)
    || sensitiveClaudeText(request.harnessVersion) || !Array.isArray(request.discoveryDirectories) || !request.discoveryDirectories.length
    || request.discoveryDirectories.length > 6 || new Set(request.discoveryDirectories).size !== request.discoveryDirectories.length
    || !request.discoveryDirectories.includes(request.cwd) || !Array.isArray(request.contributors)
    || !isDeepStrictEqual(request.discoveryDirectories, request.contributors.map(entry => entry.cwd))) throw failure('NATIVE_ROUTING_SCOPE');
  const ownedRoot = await realpath(root);
  for (const directory of [home, ...request.discoveryDirectories]) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw failure('NATIVE_ROUTING_SCOPE');
    const relative = path.relative(ownedRoot, await realpath(directory));
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw failure('NATIVE_ROUTING_SCOPE');
  }
  if (request.discoveryDirectories.some(directory => path.relative(directory, home) === ''
    || !path.relative(directory, home).startsWith(`..${path.sep}`))) throw failure('NATIVE_ROUTING_SCOPE');
  const motherRelative = path.relative(await realpath(home), await realpath(request.motherSkillRoot));
  if (!motherRelative || motherRelative === '..' || motherRelative.startsWith(`..${path.sep}`) || path.isAbsolute(motherRelative)
    || (await validateWriteTargetPhysicalScope(home, motherRelative.split(path.sep).join('/'))).length) throw failure('NATIVE_ROUTING_SCOPE');
  const materializationSources = [];
  for (const cwd of request.discoveryDirectories) {
    for (let parent = await realpath(cwd); ; parent = path.dirname(parent)) {
      for (const file of ['.claude/settings.json', '.claude/settings.local.json']) {
        try { await lstat(path.join(parent, file)); }
        catch (cause) { if (cause.code === 'ENOENT') continue; throw failure('NATIVE_PROJECT_CONFIG_UNSUPPORTED'); }
        throw failure('NATIVE_PROJECT_CONFIG_UNSUPPORTED');
      }
      if (parent === ownedRoot) break;
    }
    if ((await validateWriteTargetPhysicalScope(cwd, '.claude/skills')).length) throw failure('NATIVE_SKILL_INVENTORY_INVALID');
    const directory = path.join(cwd, '.claude/skills');
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (cause) { if (cause.code === 'ENOENT') continue; throw failure('NATIVE_SKILL_INVENTORY_INVALID'); }
    for (const entry of entries) {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.name)) throw failure('NATIVE_SKILL_INVENTORY_INVALID');
      const canonicalRelative = `.agents/skills/${entry.name}`;
      const canonical = path.join(cwd, canonicalRelative);
      if ((await validateWriteTargetPhysicalScope(cwd, `${canonicalRelative}/SKILL.md`)).length
        || !(await lstat(path.join(directory, entry.name))).isSymbolicLink()
        || await readlink(path.join(directory, entry.name)) !== `../../.agents/skills/${entry.name}`
        || await realpath(path.join(directory, entry.name)) !== await realpath(canonical)) throw failure('NATIVE_SKILL_INVENTORY_INVALID');
      const skillStat = await lstat(path.join(canonical, 'SKILL.md'));
      if (!skillStat.isFile() || skillStat.size > 128 * 1024) throw failure('NATIVE_SKILL_INVENTORY_INVALID');
      const skill = await readRegularFileNoFollow(path.join(canonical, 'SKILL.md'), 'utf8');
      const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(skill)?.[1]?.split(/\r?\n/);
      if (!header || header.length !== 2 || header.some(line => !/^(?:name|description):[ \t]+[^\r\n]+$/.test(line))
        || header.filter(line => /^name:/.test(line)).length !== 1 || header.filter(line => /^description:/.test(line)).length !== 1
        || ![entry.name, JSON.stringify(entry.name), `'${entry.name}'`].includes(header.find(line => /^name:/.test(line)).slice(5).trim())) {
        throw failure('NATIVE_SKILL_INVENTORY_INVALID');
      }
      materializationSources.push({ name: entry.name, namespace: 'project', aliasRoot: path.join(directory, entry.name),
        canonicalRoot: canonical, sourceContainer: cwd });
    }
  }
  if (new Set(materializationSources.map(entry => entry.name)).size !== materializationSources.length) throw failure('NATIVE_SKILL_SOURCE_AMBIGUOUS');
  const roots = [...new Set([...request.discoveryDirectories, request.motherSkillRoot])];
  const before = await Promise.all(roots.map(snapshotContext));
  if (env?.HOME !== home || env?.CLAUDE_CONFIG_DIR !== path.join(home, '.claude')) throw failure('NATIVE_ROUTING_SCOPE');
  const session = await prepareClaudeNativeObservation({ root, home, cwd: request.cwd, sessionId: request.sessionId,
    motherSkillRoot: request.motherSkillRoot, secrets, skillOnly: true, materializationSources, harnessVersion: request.harnessVersion });
  const routingInstruction = 'This is selection-only acceptance in disposable fixtures. Do not execute deployment, migration, build, database, staging, shell, network or file-write actions. Only invoke a relevant Skill if appropriate.';
  const args = ['--print', '--output-format', 'stream-json', '--verbose', '--tools', 'Skill', '--permission-mode', 'dontAsk',
    '--permission-prompts', 'none', '--max-budget-usd', '3', '--model', model, '--settings', session.settingsFile,
    '--setting-sources', 'project', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--prompt-suggestions', 'false',
    '--add-dir', ...request.discoveryDirectories, '--session-id', request.sessionId,
    '--append-system-prompt', routingInstruction, request.prompt];
  let processResult;
  try { processResult = await invoke({ command, args, cwd: request.cwd, sessionId: request.sessionId, env,
    timeoutMs: 180000, maxOutputBytes: 8 * 1024 * 1024, readRoots: request.discoveryDirectories }); }
  finally { if (!isDeepStrictEqual(before, await Promise.all(roots.map(snapshotContext)))) throw failure('ROUTING_WRITES'); }
  const observation = await collectClaudeNativeObservation(session, processResult, { sessionId: request.sessionId,
    secrets, captureSkillEvidence: false, requireSkillObservation: request.kind === 'explicit',
    harnessVersion: request.harnessVersion, readRoots: request.discoveryDirectories,
    evidenceRoots: [root, await realpath(root)], cwd: request.cwd });
  return { session, processResult, observation, closed: !processResult.cleanupError && !processResult.spawnError
    && !processResult.timedOut && !processResult.truncated && !processResult.signal,
    invocation: { promptDigest: digest(request.prompt), systemInstructionDigest: digest(routingInstruction), corpusPromptUnchanged: true },
    executionKind, qualification: 'unqualified', liveSkillBehaviorProven: false };
}

if (process.argv[1] && path.resolve(process.argv[1]) === helper) {
  let bytes = 0;
  let raw = '';
  let invalid = false;
  let finished = false;
  const timer = setTimeout(() => {
    finished = true;
    process.stdout.write('{"continue":false,"stopReason":"NATIVE_HOOK_INPUT_TIMEOUT"}\n');
    process.exitCode = 0;
    process.stdin.destroy();
  }, 4000);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > maxInputBytes) { invalid = true; raw = ''; process.stdin.destroy(); }
    else if (!invalid) raw += chunk;
  });
  process.stdin.on('error', () => { invalid = true; });
  process.stdin.on('close', async () => {
    clearTimeout(timer);
    if (finished || process.stdout.destroyed) return;
    finished = true;
    const args = process.argv.slice(2);
    const output = invalid || args.length !== 2 || args[0] !== '--control' || !path.isAbsolute(args[1] ?? '')
      ? { continue: false, stopReason: 'NATIVE_HOOK_INPUT_INVALID' } : await runHook(args[1], raw);
    process.stdout.write(`${JSON.stringify(output)}\n`);
  });
}
