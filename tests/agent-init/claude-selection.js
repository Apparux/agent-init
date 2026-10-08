import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';

import { claudeJsonSecretFailure, sensitiveClaudeText } from './claude-input-policy.js';

function digest(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

// Bound traversal and subsequent JSON serialization before examining opaque input.
function withinStructureBudget(value) {
  const pending = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const entry = pending.pop();
    nodes += 1;
    if (nodes > 10000 || entry.depth > 64) return false;
    if (!entry.value || typeof entry.value !== 'object') continue;
    const children = Object.values(entry.value);
    if (nodes + pending.length + children.length > 10000) return false;
    for (const child of children) pending.push({ value: child, depth: entry.depth + 1 });
  }
  return true;
}

function technicalSample(value, roots) {
  let privateSample = false;
  let serialized = JSON.stringify(value, (key, entry) => {
    if (sensitiveClaudeText(key) || /(?:auth|credential|password|secret|key|token|config|setting)/i.test(key)
      || (typeof entry === 'string' && (sensitiveClaudeText(entry)
        || /(?:auth|credential|password|secret|token|config|setting|(?:api|private|access)[_-]?key)/i.test(entry)
        || /\b(?:github_pat_|Bearer\s+)[a-zA-Z0-9_-]+/i.test(entry)))) privateSample = true;
    return entry;
  });
  if (privateSample) return null;
  const owned = roots.filter((entry) => typeof entry === 'string' && path.isAbsolute(entry)).sort((left, right) => right.length - left.length);
  let unowned = false;
  serialized = serialized.replace(/[a-zA-Z]:\\\\[^"\s]+|\/[^"\\\s<>,;)\]}]*/g, (reference) => {
    const root = owned.find((entry) => path.isAbsolute(reference) && contained(entry, path.resolve(reference)));
    if (!root) { unowned = true; return reference; }
    const relative = path.relative(root, path.resolve(reference));
    return `<owned-root>${relative ? `/${relative.split(path.sep).join('/')}` : ''}`;
  });
  return unowned ? null : JSON.parse(serialized);
}

function contained(root, target) {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function existingPhysicalParent(target) {
  for (;;) {
    try { return realpathSync(target); } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) return null;
      const parent = path.dirname(target);
      if (parent === target) return null;
      target = parent;
    }
  }
}

function unverifiedReadReference(value, roots, cwd) {
  const physicalRoots = roots.map((root) => {
    try { return realpathSync(root); } catch (error) {
      if (typeof root !== 'string') throw error;
      return null;
    }
  }).filter(Boolean);
  const pending = [value];
  while (pending.length) {
    const entry = pending.pop();
    if (entry && typeof entry === 'object') {
      for (const child of Object.values(entry)) pending.push(child);
    } else if (typeof entry === 'string') {
      // Lexically folding '..' before resolving symlinks can change the target.
      if (/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(entry)) return true;
      const physical = existingPhysicalParent(path.resolve(cwd, entry));
      if (!physical || !physicalRoots.some((root) => contained(root, physical))) return true;
    }
  }
  return false;
}

function validToolCall(block, messageType) {
  return messageType === 'assistant' && typeof block.id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(block.id)
    && typeof block.name === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(block.name)
    && block.input !== null && typeof block.input === 'object' && !Array.isArray(block.input);
}

// Conservative invocation monitoring, not a guessed Read/Skill input schema.
// An unowned absolute-like reference may be a pattern rather than a path: stop
// as unverified rather than claiming the Harness actually performed that read.
export function claudeEventFailure(event, context = {}) {
  if (!event || typeof event !== 'object' || Array.isArray(event)
    || typeof event.type !== 'string' || !event.type.trim()) return 'TRACE_MALFORMED';
  if (!withinStructureBudget(event)) return 'TRACE_COMPLEXITY_LIMIT';
  if (context.sessionId && event.session_id !== context.sessionId) return 'SESSION_MISMATCH';
  if (event.type === 'system' && event.subtype === 'api_retry') return 'API_RETRY';
  if (event.type === 'system' && event.subtype === 'permission_denied') return 'PERMISSION_DENIED';
  if (event.type === 'result' && (event.is_error || event.subtype !== 'success')) return 'SESSION_FAILED';
  if (event.isReplay) return 'REPLAYED_TRACE';
  if (event.parent_tool_use_id != null) return 'UNEXPECTED_SUBAGENT';
  if (!['assistant', 'user'].includes(event.type)) return null;
  const blocks = event.message?.content;
  if (typeof blocks === 'string') return null;
  if (!Array.isArray(blocks)) return 'TRACE_MALFORMED';
  for (const block of blocks) {
    if (!block || typeof block !== 'object' || Array.isArray(block) || typeof block.type !== 'string') return 'TRACE_MALFORMED';
    if (block.type === 'tool_result') {
      if (Object.hasOwn(block, 'is_error') && typeof block.is_error !== 'boolean') return 'TRACE_MALFORMED';
      if (block.is_error) return 'TOOL_FAILED';
    }
    if (block.type === 'tool_use') {
      if (!validToolCall(block, event.type)) return 'TOOL_CALL_MALFORMED';
      if (!['Read', 'Glob', 'Grep', 'Skill', 'EndConversation'].includes(block.name)) return 'UNEXPECTED_TOOL';
      if (['Read', 'Glob', 'Grep'].includes(block.name)
        && unverifiedReadReference(block.input, context.readRoots ?? [], context.cwd ?? process.cwd())) return 'READ_SCOPE_UNVERIFIED';
    }
  }
  return null;
}

// The CLI envelope is documented. Skill-specific success and inline expansion
// are not yet verified on the installed Harness: never infer a selection from them.
export function parseClaudeTrace(processResult, context) {
  const provenance = { sessionId: context.sessionId, harnessVersion: context.harnessVersion };
  const error = (code, location) => ({ status: 'error', code, provenance, ...(location ? { location } : {}) });
  if (processResult.spawnError) return error('PROCESS_UNAVAILABLE');
  if (processResult.cleanupError) {
    provenance.processCleanup = { code: processResult.cleanupError.code, signal: processResult.cleanupError.signal,
      exitStatus: processResult.status, exitSignal: processResult.signal ?? null };
    return error('PROCESS_CLEANUP_FAILED');
  }
  if (processResult.timedOut) return error('PROCESS_TIMEOUT');
  if (processResult.truncated) return error('TRACE_TRUNCATED');
  if (['API_RETRY', 'PERMISSION_DENIED', 'TRACE_MALFORMED', 'SESSION_MISMATCH', 'SESSION_FAILED',
    'REPLAYED_TRACE', 'UNEXPECTED_SUBAGENT', 'TOOL_FAILED', 'UNEXPECTED_TOOL', 'READ_SCOPE_UNVERIFIED',
    'TRACE_COMPLEXITY_LIMIT', 'TRACE_MONITOR_FAILED', 'TOOL_CALL_MALFORMED'].includes(processResult.stopReason)) return error(processResult.stopReason);
  if (processResult.signal) return error('PROCESS_INTERRUPTED');
  if (processResult.status !== 0) return error('PROCESS_FAILED');
  if (typeof processResult.stdout !== 'string' || !processResult.stdout.trim()) return error('TRACE_MISSING');
  const secretFailure = claudeJsonSecretFailure(processResult.stdout, context.secrets);
  if (secretFailure) return error(secretFailure);
  if (!processResult.stdout.endsWith('\n')) return error('TRACE_TRUNCATED');
  provenance.traceDigest = digest(processResult.stdout);
  provenance.traceBytes = Buffer.byteLength(processResult.stdout);
  let messages;
  try {
    messages = processResult.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
  } catch (cause) {
    if (!(cause instanceof SyntaxError)) throw cause;
    return error('TRACE_MALFORMED');
  }
  if (messages.some((message) => !message || typeof message !== 'object' || Array.isArray(message)
    || typeof message.type !== 'string' || !message.type.trim())) return error('TRACE_MALFORMED');
  if (messages.some((message) => !withinStructureBudget(message))) return error('TRACE_COMPLEXITY_LIMIT');
  const pending = [...messages];
  const secrets = (context.secrets ?? []).filter((value) => typeof value === 'string' && value.length);
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === 'number' && (!Number.isFinite(value)
      || (Number.isInteger(value) && !Number.isSafeInteger(value)))) return error('TRACE_NUMBER_UNREPRESENTABLE');
    if (typeof value === 'string' && secrets.some((secret) => value.includes(secret))) return error('SECRET_TRACE');
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) pending.push(key, child);
    }
  }
  if (messages.some((message) => message.session_id !== context.sessionId)) return error('SESSION_MISMATCH');
  const initial = messages.filter((message) => message.type === 'system' && message.subtype === 'init');
  const terminal = messages.filter((message) => message.type === 'result');
  if (initial.length !== 1 || terminal.length !== 1 || messages.at(-1) !== terminal[0]) return error('TRACE_INCOMPLETE');
  if (messages.slice(0, messages.indexOf(initial[0])).some((message) => ['assistant', 'user'].includes(message.type))) return error('INIT_ORDER');
  if (terminal[0].subtype !== 'success' || terminal[0].is_error !== false) return error('SESSION_FAILED');
  if (!Array.isArray(initial[0].tools)) return error('CATALOG_MISSING');
  if (initial[0].tools.some((name) => !['Read', 'Glob', 'Grep', 'Skill', 'EndConversation'].includes(name))) return error('UNSAFE_TOOLS');
  provenance.catalog = { tools: initial[0].tools };
  // Optional init.skills is not an exhaustive catalog or selection evidence.
  // Omit its contents after whole-trace guards; unknown metadata cannot block tool evidence.
  if (Object.hasOwn(initial[0], 'skills')) {
    provenance.unverifiedInitSkillMetadata = { omitted: true, exhaustiveCatalogProven: false, selectionProtocolVerified: false };
  }
  if (!Array.isArray(terminal[0].permission_denials)) return error('TRACE_MALFORMED');
  if (terminal[0].permission_denials.length) return error('PERMISSION_DENIED');
  const calls = new Map();
  const samples = new Map();
  provenance.toolCalls = [];
  if (context.captureSkillEvidence) provenance.skillSamples = [];
  for (const [messageIndex, message] of messages.entries()) {
    if (message.isReplay) return error('REPLAYED_TRACE');
    if (message.parent_tool_use_id != null) return error('UNEXPECTED_SUBAGENT');
    if (message.type === 'system' && message.subtype === 'api_retry') return error('API_RETRY');
    if (message.type === 'system' && message.subtype === 'permission_denied') return error('PERMISSION_DENIED');
    if (!['assistant', 'user'].includes(message.type)) continue;
    const blocks = message.message?.content;
    if (typeof blocks === 'string') continue;
    if (!Array.isArray(blocks)) return error('TRACE_MALFORMED');
    for (const [blockIndex, block] of blocks.entries()) {
      const location = { messageIndex, blockIndex };
      if (!block || typeof block !== 'object' || Array.isArray(block) || typeof block.type !== 'string' || !block.type) return error('TRACE_MALFORMED', location);
      if (block.type === 'tool_use') {
        if (!validToolCall(block, message.type) || calls.has(block.id)) return error('TOOL_CALL_MALFORMED');
        if (!initial[0].tools.includes(block.name)) return error('UNEXPECTED_TOOL');
        const identifier = technicalSample({ value: block.id }, context.evidenceRoots ?? []);
        if (!identifier) return error('PRIVATE_SKILL_SAMPLE', { ...location, field: 'id' });
        const fields = technicalSample({ value: Object.keys(block.input).sort() }, context.evidenceRoots ?? []);
        if (!fields) return error('PRIVATE_SKILL_SAMPLE', { ...location, field: 'input' });
        let input;
        if (context.captureSkillEvidence && block.name === 'Skill') {
          input = technicalSample(block.input, context.evidenceRoots ?? []);
          if (!input) return error('PRIVATE_SKILL_SAMPLE', { ...location, field: 'input' });
        }
        const call = { id: identifier.value, name: block.name, inputDigest: digest(JSON.stringify(block.input)), inputKeys: fields.value };
        calls.set(block.id, call);
        provenance.toolCalls.push(call);
        if (input) {
          const sample = { id: block.id, name: block.name, input, selectionProtocolVerified: false };
          samples.set(block.id, sample);
          provenance.skillSamples.push(sample);
        }
      } else if (block.type === 'tool_result') {
        if (Object.hasOwn(block, 'is_error') && typeof block.is_error !== 'boolean') return error('TRACE_MALFORMED', location);
        const call = calls.get(block.tool_use_id);
        if (message.type !== 'user' || !call || call.resultDigest) return error('TOOL_REPLY_UNMATCHED');
        call.resultDigest = digest(JSON.stringify(block.content ?? null));
        call.isError = block.is_error === true;
        if (call.isError) return error('TOOL_FAILED');
        const sample = samples.get(block.tool_use_id);
        if (sample) {
          const reply = technicalSample({ content: block.content ?? null, is_error: block.is_error ?? null }, context.evidenceRoots ?? []);
          if (!reply) return error('PRIVATE_SKILL_SAMPLE', { ...location, field: 'content' });
          sample.reply = reply;
        }
      }
    }
  }
  if ([...calls.values()].some((call) => !call.resultDigest)) return error('TOOL_REPLY_MISSING');
  return { status: 'blocked', code: 'SELECTION_PROTOCOL_UNVERIFIED', provenance };
}
