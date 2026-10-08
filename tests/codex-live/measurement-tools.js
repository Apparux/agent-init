import { constants } from 'node:fs';
import { lstat, open, readdir, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';

import { digestProposal, fingerprintPath, fingerprintRepository, renderExactDiff } from '../agent-init/evaluation-harness.js';

// DynamicToolSpec at fixed Codex ref ff6aec96948b70d94983af2641a6b67c94faeff5.
const definitions = [
  ['fingerprintPath', 'Measure a repository-relative path in the controller-bound repository.', { target: { type: 'string' } }],
  ['fingerprintRepository', 'Measure the controller-bound repository; sensitive aggregates are refused.', {}],
  ['digestProposal', 'Compute the public canonical digest of submitted JSON only.', { proposal: { type: ['object', 'string'] } }],
  ['renderExactDiff', 'Render an exact diff of submitted UTF-8 strings only; never reads or applies files.', { target: { type: 'string' }, before: { type: 'string' }, after: { type: 'string' } }],
].map(([name, description, properties]) => ({
  type: 'function', name, description,
  inputSchema: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false },
}));

const VALUE_BYTES = 64 * 1024;
const RESPONSE_BYTES = 128 * 1024;

function failure(code, message) {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

function wellFormed(value) {
  for (const character of value) {
    const point = character.codePointAt(0);
    if (point >= 0xd800 && point <= 0xdfff) return false;
  }
  return true;
}

function safeString(value) {
  if (typeof value !== 'string' || !wellFormed(value) || Buffer.byteLength(value) > VALUE_BYTES) {
    throw failure('MEASUREMENT_INPUT', 'strings must be bounded, well-formed UTF-8');
  }
}

function jsonValue(value, ancestors = new Set(), depth = 0) {
  if (depth > 64) throw failure('MEASUREMENT_INPUT', 'JSON nesting exceeds its bound');
  if (typeof value === 'string') return safeString(value);
  if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return;
  if (!value || typeof value !== 'object' || ancestors.has(value)
    || (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))) {
    throw failure('MEASUREMENT_INPUT', 'arguments must contain only acyclic JSON values');
  }
  ancestors.add(value);
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === 'length') continue;
    safeString(key);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) throw failure('MEASUREMENT_INPUT', 'JSON accessors are not allowed');
    jsonValue(descriptor.value, ancestors, depth + 1);
  }
  ancestors.delete(value);
}

function safeTarget(target) {
  safeString(target);
  if (!target || target.includes('\\') || /[\x00-\x1f\x7f:]/u.test(target)
    || target.startsWith('/') || target.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw failure('MEASUREMENT_PATH', 'target must be a normalized repository-relative path');
  }
}

function argumentsFor(tool, args) {
  jsonValue(args);
  if (!args || Array.isArray(args) || typeof args !== 'object') throw failure('MEASUREMENT_INPUT', 'arguments must be an object');
  const keys = definitions.find((spec) => spec.name === tool).inputSchema.required;
  if (Object.keys(args).sort().join(',') !== [...keys].sort().join(',')) throw failure('MEASUREMENT_INPUT', 'unknown or missing argument');
  if (Buffer.byteLength(JSON.stringify(args)) > RESPONSE_BYTES) throw failure('MEASUREMENT_INPUT', 'argument envelope exceeds its bound');
  if (tool === 'digestProposal') {
    if (typeof args.proposal !== 'string' && (!args.proposal || Array.isArray(args.proposal) || typeof args.proposal !== 'object')) {
      throw failure('MEASUREMENT_INPUT', 'proposal must be a JSON object or string');
    }
    const bytes = Buffer.byteLength(typeof args.proposal === 'string' ? args.proposal : JSON.stringify(args.proposal));
    if (bytes > VALUE_BYTES) throw failure('MEASUREMENT_INPUT', 'proposal exceeds 64 KiB');
  } else if (tool === 'fingerprintPath') {
    safeTarget(args.target);
  } else if (tool === 'renderExactDiff') {
    safeTarget(args.target);
    safeString(args.before);
    safeString(args.after);
  }
}

function response(success, payload) {
  const result = { success, contentItems: [{ type: 'inputText', text: JSON.stringify(payload) }] };
  if (Buffer.byteLength(JSON.stringify(result)) > RESPONSE_BYTES) throw failure('MEASUREMENT_RESPONSE', 'response exceeds 128 KiB');
  return result;
}

function signature(stat) {
  return ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs'].map((key) => stat[key]).join(':');
}

async function boundedFile(absolute, expected) {
  if (!expected.isFile() || expected.nlink !== 1 || expected.size > VALUE_BYTES) {
    throw failure('MEASUREMENT_FILE', 'file must be regular, unlinked and at most 64 KiB');
  }
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (signature(await handle.stat()) !== signature(expected)) throw failure('MEASUREMENT_DRIFT', 'file identity changed before read');
    const bytes = Buffer.alloc(VALUE_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length !== expected.size || length > VALUE_BYTES
      || signature(await handle.stat()) !== signature(expected)
      || signature(await lstat(absolute)) !== signature(expected)) {
      throw failure('MEASUREMENT_DRIFT', 'file changed during bounded no-follow read');
    }
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length));
  } finally {
    await handle.close();
  }
}

function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function inspectLink(root, target, stat, mother) {
  const absolute = path.join(root, target);
  const text = await readlink(absolute);
  safeString(text);
  if (!text || path.isAbsolute(text) || text.includes('\\') || /[\x00-\x1f\x7f:]/u.test(text)) {
    throw failure('MEASUREMENT_PATH', 'link must have a safe relative destination');
  }
  const destination = path.resolve(path.dirname(absolute), text);
  if (!within(root, destination)) {
    if (!mother || !['.agents/skills/agent-init', '.claude/skills/agent-init'].includes(target)
      || destination !== mother.root) throw failure('MEASUREMENT_PATH', 'link escapes its bound repository');
    await directoryIdentity(mother.root, mother.identity);
  } else {
    let current = root;
    const parts = path.relative(root, destination).split(path.sep).filter(Boolean);
    for (const [index, part] of parts.entries()) {
      current = path.join(current, part);
      const entry = await lstat(current);
      if (entry.isSymbolicLink() || (index < parts.length - 1 && !entry.isDirectory())
        || (!entry.isDirectory() && (!entry.isFile() || entry.nlink !== 1))) {
        throw failure('MEASUREMENT_PATH', 'link destination must not follow links or hardlinks');
      }
    }
  }
  if (signature(await lstat(absolute)) !== signature(stat) || await readlink(absolute) !== text) {
    throw failure('MEASUREMENT_DRIFT', 'link changed during inspection');
  }
  return [target, signature(stat), text];
}

async function inspectTree(root, target = '', mother) {
  const records = [];
  let totalBytes = 0;
  async function visit(relative, depth) {
    if (depth > 64 || records.length >= 1024) throw failure('MEASUREMENT_LIMIT', 'repository measurement exceeds its entry or depth bound');
    if (relative && relative.split('/').some((part) => part.toLowerCase().startsWith('.env'))) {
      throw failure('MEASUREMENT_SENSITIVE', 'public tree fingerprints cannot omit sensitive contents; aggregate refused');
    }
    const absolute = relative ? path.join(root, relative) : root;
    const stat = await lstat(absolute);
    records.push([relative, signature(stat)]);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      if (await realpath(absolute) !== absolute) throw failure('MEASUREMENT_PATH', 'directory must not have linked ancestors');
      const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
      try {
        if (signature(await handle.stat()) !== signature(stat)) throw failure('MEASUREMENT_DRIFT', 'directory identity changed');
        const names = (await readdir(absolute)).sort();
        if (names.length + records.length > 1024) throw failure('MEASUREMENT_LIMIT', 'too many repository entries');
        for (const name of names) {
          const child = relative ? `${relative}/${name}` : name;
          safeTarget(child);
          await visit(child, depth + 1);
        }
        if (signature(await handle.stat()) !== signature(stat) || signature(await lstat(absolute)) !== signature(stat)) {
          throw failure('MEASUREMENT_DRIFT', 'directory changed during inspection');
        }
      } finally {
        await handle.close();
      }
    } else if (stat.isSymbolicLink()) {
      records.push(await inspectLink(root, relative, stat, mother));
    } else {
      totalBytes += stat.size;
      if (totalBytes > 1024 * 1024) throw failure('MEASUREMENT_LIMIT', 'repository bytes exceed 1 MiB');
      await boundedFile(absolute, stat);
    }
  }
  await visit(target, 0);
  return records;
}

async function inspectTarget(root, target, mother) {
  let absolute = root;
  const records = [];
  const parts = target.split('/');
  const sensitive = parts.some((part) => part.toLowerCase().startsWith('.env'));
  let type = 'missing';
  for (const [index, part] of parts.entries()) {
    absolute = path.join(absolute, part);
    let stat;
    try { stat = await lstat(absolute); }
    catch (cause) {
      if (cause.code !== 'ENOENT') throw cause;
      records.push(['missing', parts.slice(0, index + 1).join('/')]);
      return { records, sensitive, type: 'missing' };
    }
    records.push([parts.slice(0, index + 1).join('/'), signature(stat)]);
    if (index < parts.length - 1 && (!stat.isDirectory() || stat.isSymbolicLink())) {
      throw failure('MEASUREMENT_PATH', 'linked or non-directory path component');
    }
    if (index === parts.length - 1 && stat.isSymbolicLink()) {
      records.push(await inspectLink(root, target, stat, mother));
      return { records, sensitive, type: 'symlink' };
    }
    if (index === parts.length - 1) {
      type = stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : 'unsupported';
      if (type === 'unsupported' || (stat.isFile() && stat.nlink !== 1)) throw failure('MEASUREMENT_FILE', 'unsupported or hardlinked entry');
      if (!sensitive) {
        if (type === 'directory') records.push(...await inspectTree(root, target, mother));
        else await boundedFile(absolute, stat);
      }
    }
  }
  return { records, sensitive, type };
}

async function directoryIdentity(root, expected) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || path.resolve(root) !== root
    || !Number.isSafeInteger(expected?.dev) || !Number.isSafeInteger(expected?.ino)) {
    throw failure('MEASUREMENT_SCOPE', 'controller must bind a canonical directory and identity');
  }
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== expected.dev || stat.ino !== expected.ino
    || await realpath(root) !== root) throw failure('MEASUREMENT_SCOPE', 'bound directory identity or physical root changed');
}

// Controller-only factory. Import and construction do not launch any Codex process.
// Public fingerprint helpers reopen pathnames. These bounded no-follow pre/post guards
// detect drift; they do not establish race-free read containment. Native use still
// requires separately verified read-only ownership for the entire measurement.
export async function createCodexMeasurementTools({ ownedRoot, ownedIdentity, repositoryRoot, repositoryIdentity, motherSkillRoot, motherSkillIdentity }) {
  const owned = { dev: ownedIdentity?.dev, ino: ownedIdentity?.ino };
  const repository = { dev: repositoryIdentity?.dev, ino: repositoryIdentity?.ino };
  const relative = typeof ownedRoot === 'string' && typeof repositoryRoot === 'string' ? path.relative(ownedRoot, repositoryRoot) : '..';
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw failure('MEASUREMENT_SCOPE', 'repository must be a strict owned descendant, not a user-selected root');
  }
  let mother = null;
  if (motherSkillRoot !== undefined || motherSkillIdentity !== undefined) {
    if (motherSkillRoot !== path.join(ownedRoot, 'home', '.agent-init', 'current', 'skills', 'agent-init')) {
      throw failure('MEASUREMENT_SCOPE', 'only the owned canonical installed mother alias is supported');
    }
    mother = { root: motherSkillRoot, identity: { dev: motherSkillIdentity?.dev, ino: motherSkillIdentity?.ino } };
  }
  async function assertBinding() {
    await directoryIdentity(ownedRoot, owned);
    await directoryIdentity(repositoryRoot, repository);
    if (mother) await directoryIdentity(mother.root, mother.identity);
  }
  await assertBinding();
  let active = null;
  const callIds = new Set();
  const turnIds = new Set();
  return {
    get dynamicTools() { return structuredClone(definitions); },
    activateTurn(identity) {
      if (active || turnIds.size >= 1024 || !identity || Object.keys(identity).sort().join(',') !== 'threadId,turnId'
        || ['threadId', 'turnId'].some((key) => typeof identity[key] !== 'string' || !identity[key]
          || !wellFormed(identity[key]) || Buffer.byteLength(identity[key]) > 256)
        || turnIds.has(identity.turnId)) throw failure('MEASUREMENT_TURN', 'controller must activate a fresh single turn');
      active = { threadId: identity.threadId, turnId: identity.turnId };
      turnIds.add(active.turnId);
    },
    finishTurn() { active = null; },
    async handleToolCall(params) {
      if (!active || !params || typeof params !== 'object' || Array.isArray(params)
        || Object.keys(params).sort().join(',') !== 'arguments,callId,namespace,threadId,tool,turnId'
        || params.threadId !== active.threadId || params.turnId !== active.turnId
        || typeof params.callId !== 'string' || !params.callId || callIds.has(params.callId)
        || params.namespace !== null || !definitions.some((spec) => spec.name === params.tool)) {
        return { success: false, contentItems: [{ type: 'inputText', text: JSON.stringify({ status: 'error', code: 'MEASUREMENT_CALL' }) }] };
      }
      const turn = active;
      try {
        jsonValue(params);
        params = structuredClone(params);
        if (callIds.size >= 1024 || Buffer.byteLength(params.callId) > 256) throw failure('MEASUREMENT_LIMIT', 'callback history exceeds its bound');
        callIds.add(params.callId);
        const args = params.arguments;
        argumentsFor(params.tool, args);
        await assertBinding();
        let result;
        if (params.tool === 'fingerprintRepository') {
          const before = await inspectTree(repositoryRoot, '', mother);
          result = { fingerprint: await fingerprintRepository(repositoryRoot) };
          if (JSON.stringify(before) !== JSON.stringify(await inspectTree(repositoryRoot, '', mother))) {
            throw failure('MEASUREMENT_DRIFT', 'repository changed during public measurement');
          }
        } else if (params.tool === 'fingerprintPath') {
          const before = await inspectTarget(repositoryRoot, args.target, mother);
          result = before.sensitive ? { presence: before.type !== 'missing', type: before.type }
            : { fingerprint: await fingerprintPath(repositoryRoot, args.target) };
          if (JSON.stringify(before) !== JSON.stringify(await inspectTarget(repositoryRoot, args.target, mother))) {
            throw failure('MEASUREMENT_DRIFT', 'path changed during public measurement');
          }
        } else {
          result = params.tool === 'digestProposal' ? { digest: digestProposal(args.proposal) }
            : { diff: renderExactDiff(args.target, args.before, args.after) };
        }
        await assertBinding();
        if (active !== turn) throw failure('MEASUREMENT_TURN', 'controller turn ended during measurement');
        return response(true, result);
      } catch (cause) {
        return response(false, { status: 'error', operation: params.tool, code: cause.code ?? 'MEASUREMENT_ERROR', message: 'Submitted measurement could not be computed safely.' });
      }
    },
  };
}
