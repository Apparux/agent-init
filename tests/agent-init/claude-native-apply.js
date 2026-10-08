import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, readlink, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { digestProposal, fingerprintPath, renderExactDiff, validateWriteTargetPhysicalScope } from './evaluation-harness.js';
import { sensitiveClaudeText } from './claude-input-policy.js';

const maxBytes = 8 * 1024 * 1024;
const policyName = 'apply-policy.json';
const stateName = 'apply-state.json';
const journalName = 'apply-events.jsonl';

function failure(code) {
  return Object.assign(new Error(code), { code });
}
function requireThat(condition, code) {
  if (!condition) throw failure(code);
}
function digest(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

// Data-property clone: never execute model/approval getters or serialization hooks.
function data(value) {
  let nodes = 0;
  function clone(entry, depth) {
    requireThat(++nodes <= 10000 && depth <= 64, 'NATIVE_INPUT_INVALID');
    if (entry === null || ['string', 'boolean'].includes(typeof entry)) return entry;
    if (typeof entry === 'number') {
      requireThat(Number.isFinite(entry) && (!Number.isInteger(entry) || Number.isSafeInteger(entry)), 'NATIVE_INPUT_INVALID');
      return entry;
    }
    requireThat(entry && typeof entry === 'object' && [Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(entry)), 'NATIVE_INPUT_INVALID');
    const result = Array.isArray(entry) ? [] : {};
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(entry))) {
      if (Array.isArray(entry) && key === 'length') continue;
      requireThat(descriptor.enumerable && Object.hasOwn(descriptor, 'value') && !['__proto__', 'constructor', 'prototype', 'toJSON'].includes(key), 'NATIVE_INPUT_INVALID');
      result[key] = clone(descriptor.value, depth + 1);
    }
    return Object.freeze(result);
  }
  const copied = clone(value, 0);
  requireThat(Buffer.byteLength(JSON.stringify(copied)) <= maxBytes, 'NATIVE_INPUT_LIMIT');
  return copied;
}

function diagnostics(policy, fields) {
  return { executionKind: policy.executionKind, qualification: 'unqualified', permissionFloorProven: false,
    humanApprovalProven: policy.humanApprovalProven, liveSkillBehaviorProven: false, artifacts: [], ...fields };
}

async function controlDirectory(control) {
  requireThat(typeof control === 'string' && path.isAbsolute(control) && path.resolve(control) === control, 'NATIVE_CONTROL_INVALID');
  const stat = await lstat(control);
  requireThat(stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o777) === 0o700
    && await realpath(control) === control, 'NATIVE_CONTROL_INVALID');
}
async function privateRead(control, name) {
  const handle = await open(path.join(control, name), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    requireThat(stat.isFile() && stat.nlink === 1 && (stat.mode & 0o777) === 0o600 && stat.size <= maxBytes, 'NATIVE_CONTROL_INVALID');
    return await handle.readFile('utf8');
  } finally { await handle.close(); }
}
async function privateWrite(control, name, value, create = false) {
  const handle = await open(path.join(control, name), constants.O_WRONLY | constants.O_NOFOLLOW
    | (create ? constants.O_CREAT | constants.O_EXCL : 0), 0o600);
  try {
    const stat = await handle.stat();
    requireThat(stat.isFile() && stat.nlink === 1 && (stat.mode & 0o777) === 0o600, 'NATIVE_CONTROL_INVALID');
    const raw = typeof value === 'string' ? value : JSON.stringify(value);
    requireThat(Buffer.byteLength(raw) <= maxBytes, 'NATIVE_CONTROL_LIMIT');
    await handle.truncate(0);
    await handle.writeFile(raw);
    await handle.sync();
  } finally { await handle.close(); }
}

async function snapshot(cwd) {
  const entries = {};
  let bytes = 0;
  async function visit(absolute, relative) {
    requireThat(Object.keys(entries).length < 10000, 'NATIVE_FILESYSTEM_LIMIT');
    const stat = await lstat(absolute, { bigint: true });
    const entry = { identity: `${stat.dev}:${stat.ino}`, mode: Number(stat.mode & 0o7777n),
      links: String(stat.nlink), mtime: String(stat.mtimeNs), ctime: String(stat.ctimeNs) };
    if (stat.isSymbolicLink()) {
      entry.type = 'symlink';
      entry.digest = digest(await readlink(absolute));
    } else if (stat.isDirectory()) {
      entry.type = 'directory';
      requireThat(await realpath(absolute) === absolute, 'NATIVE_PATH_SCOPE');
    } else if (stat.isFile()) {
      entry.type = 'file';
      bytes += Number(stat.size);
      requireThat(stat.size <= BigInt(maxBytes) && bytes <= 64 * 1024 * 1024, 'NATIVE_FILESYSTEM_LIMIT');
      const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = await handle.stat({ bigint: true });
        requireThat(opened.dev === stat.dev && opened.ino === stat.ino && opened.mtimeNs === stat.mtimeNs
          && opened.ctimeNs === stat.ctimeNs, 'NATIVE_FILESYSTEM_DRIFT');
        entry.digest = digest(await handle.readFile());
      } finally { await handle.close(); }
    } else throw failure('NATIVE_PATH_SCOPE');
    entries[relative] = entry;
    if (entry.type === 'directory') {
      for (const name of (await readdir(absolute)).sort()) await visit(path.join(absolute, name), relative === '.' ? name : `${relative}/${name}`);
    }
    const after = await lstat(absolute, { bigint: true });
    requireThat(after.dev === stat.dev && after.ino === stat.ino && after.mode === stat.mode
      && after.mtimeNs === stat.mtimeNs && after.ctimeNs === stat.ctimeNs, 'NATIVE_FILESYSTEM_DRIFT');
  }
  await visit(cwd, '.');
  return entries;
}

function ancestors(target) {
  const parents = ['.'];
  const parts = target.split('/');
  for (let i = 1; i < parts.length; i += 1) parents.push(parts.slice(0, i).join('/'));
  return parents;
}
async function pathAnchors(absolute) {
  const anchors = [];
  let current = absolute;
  while (true) {
    const stat = await lstat(current);
    requireThat(stat.isDirectory() && !stat.isSymbolicLink() && await realpath(current) === current, 'NATIVE_PATH_SCOPE');
    anchors.push({ path: current, identity: `${stat.dev}:${stat.ino}`, mode: stat.mode & 0o7777 });
    if (path.dirname(current) === current) return anchors;
    current = path.dirname(current);
  }
}
async function physicalTarget(cwd, target) {
  requireThat(typeof target === 'string' && target.split('/').every((part) => part && part !== '.' && part !== '..')
    && !target.includes('\\') && !path.isAbsolute(target), 'NATIVE_PATH_SCOPE');
  requireThat((await validateWriteTargetPhysicalScope(cwd, target)).length === 0, 'NATIVE_PATH_SCOPE');
}

/** Prepare only private controller data, never project files/settings. The parent
 * must keep this canonical 0700 control directory outside all native file roots.
 * Captured Proposal/approval are copied unchanged; no new project Apply API.
 * File CREATE modes are narrowly 0644; necessary missing ancestor modes 0755;
 * UPDATE preserves the existing mode. No chmod or arbitrary mkdir is authorized.
 */
export async function prepareClaudeNativeApply({ control, cwd, sessionId, captured, approval, executionKind, secrets = [], expectedActionIds }) {
  requireThat(approval, 'APPROVAL_REQUIRED');
  const decision = data(approval);
  requireThat(['real-cli', 'test-double'].includes(executionKind), 'NATIVE_AUTHORITY_UNKNOWN');
  requireThat(executionKind === 'real-cli'
    ? decision.source === 'human-terminal' && decision.humanApprovalProven === true
    : decision.source === 'test-double' && decision.humanApprovalProven === false, 'NATIVE_APPROVAL_AUTHORITY');
  requireThat(decision.status === 'exact', 'NATIVE_APPROVAL_NONEXACT');
  const capture = data(captured);
  requireThat(Array.isArray(secrets) && secrets.length <= 16 && secrets.every((secret) => typeof secret === 'string'), 'NATIVE_INPUT_INVALID');
  const pending = [capture, decision, control, cwd, sessionId];
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === 'string') requireThat(!secrets.some((secret) => secret && value.includes(secret)), 'SECRET_TRACE');
    else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) pending.push(key, child);
  }
  const proposal = capture.proposal;
  requireThat(capture.captureStatus === 'captured' && proposal && Array.isArray(proposal.actions)
    && isDeepStrictEqual(proposal, capture.decisionRecord?.events?.at(-1))
    && ['cli-json-structured-output', 'cli-json-result-decision-data'].includes(capture.provenance?.source)
    && capture.provenance.sessionId === sessionId, 'NATIVE_PROPOSAL_INVALID');
  requireThat(capture.proposalDigest === digestProposal(proposal), 'APPROVAL_PAYLOAD');
  const record = decision.record;
  requireThat(record?.type === 'approval' && record.decision === 'approve' && record.scope === 'exact-proposal', 'NATIVE_APPROVAL_NONEXACT');
  requireThat(record.proposalId === proposal.id && record.revision === proposal.revision, 'STALE_APPROVAL');
  requireThat(record.proposalDigest === capture.proposalDigest, 'APPROVAL_PAYLOAD');
  const actions = proposal.actions.filter((action) => ['CREATE', 'UPDATE'].includes(action.action));
  const ids = actions.map((action) => action.id);
  requireThat(ids.length > 0 && new Set(ids).size === ids.length && new Set(actions.map((action) => action.target)).size === ids.length
    && isDeepStrictEqual(record.approvedActionIds, ids) && (!expectedActionIds || isDeepStrictEqual(data(expectedActionIds), ids)), 'APPROVAL_ACTIONS');
  requireThat(typeof cwd === 'string' && path.isAbsolute(cwd) && await realpath(cwd) === cwd, 'NATIVE_CWD_MISMATCH');
  requireThat(typeof sessionId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(sessionId) && !sensitiveClaudeText(sessionId), 'NATIVE_SESSION_MISMATCH');
  requireThat(typeof control === 'string' && path.isAbsolute(control) && path.resolve(control) === control
    && !inside(cwd, control) && !inside(control, cwd), 'NATIVE_CONTROL_INVALID');
  const baseline = await snapshot(cwd);
  const plans = [];
  const plannedParents = new Set(Object.keys(baseline).filter((key) => baseline[key].type === 'directory'));
  for (const action of actions) {
    await physicalTarget(cwd, action.target);
    requireThat(await fingerprintPath(cwd, action.target) === action.baselineFingerprint, 'NATIVE_BASELINE_STALE');
    requireThat((action.action === 'CREATE') === !baseline[action.target], 'NATIVE_BASELINE_STALE');
    if (action.kind === 'claude-skill-reference') {
      requireThat(action.action === 'CREATE' && /^\.claude\/skills\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(action.target)
        && action.linkTarget === `../../.agents/skills/${action.target.split('/').at(-1)}`, 'NATIVE_REFERENCE_INVALID');
      const canonicalTarget = `.agents/skills/${action.target.split('/').at(-1)}`;
      await physicalTarget(cwd, canonicalTarget);
      let steps;
      if (action.parentDirectories !== undefined) {
        const missing = ancestors(action.target).filter((parent) => !plannedParents.has(parent));
        requireThat(isDeepStrictEqual(action.parentDirectories, missing), 'NATIVE_REFERENCE_PARENTS');
        steps = missing.map((target) => ({ target, kind: 'directory',
          command: `/bin/mkdir -m 0755 -- '${target}'` }));
        steps.push({ target: action.target, kind: 'symlink',
          command: `/bin/ln -s -- '${action.linkTarget}' '${action.target}'` });
        for (const parent of missing) plannedParents.add(parent);
      }
      // An older Proposal without displayed parent effects remains unsupported.
      plans.push({ target: action.target, reference: true, canonicalTarget,
        linkTarget: action.linkTarget, ...(steps ? { steps } : {}) });
      continue;
    }
    const permitted = { agents: /^AGENTS\.md$/, 'claude-adapter': /^CLAUDE\.md$/,
      'project-skill': /^\.agents\/skills\/[a-z0-9]+(?:-[a-z0-9]+)*\/(?:SKILL\.md|references\/[^/]+|scripts\/[^/]+)$/,
      'agent-doc': /^docs\/agents\/[a-z0-9][a-z0-9.-]*\.md$/ };
    requireThat(Object.hasOwn(permitted, action.kind) && permitted[action.kind].test(action.target)
      && (action.kind !== 'agent-doc' || action.knowledgeScope === 'ARCHITECTURE'), 'NATIVE_WRITE_SCOPE');
    const old = baseline[action.target];
    requireThat(!old || old.type === 'file' && old.links === '1', 'NATIVE_PATH_SCOPE');
    let expectedContent = action.proposedContent;
    if (action.action === 'UPDATE') {
      const handle = await open(path.join(cwd, action.target), constants.O_RDONLY | constants.O_NOFOLLOW);
      let before;
      try { before = await handle.readFile('utf8'); } finally { await handle.close(); }
      requireThat(typeof action.proposedDiff === 'string', 'NATIVE_APPROVED_DIFF');
      const lines = action.proposedDiff.split('\n').slice(3);
      if (lines.at(-1) === '') lines.pop();
      const added = lines.filter((line) => line.startsWith('+')).map((line) => line.slice(1));
      const after = added.length ? `${added.join('\n')}\n` : '';
      requireThat(renderExactDiff(action.target, before, after) === action.proposedDiff
        && (expectedContent === undefined || expectedContent === after), 'NATIVE_APPROVED_DIFF');
      expectedContent = after;
    }
    requireThat(typeof expectedContent === 'string' && (action.action !== 'CREATE' || expectedContent.length > 0), 'NATIVE_APPROVED_CONTENT');
    plans.push({ target: action.target, expectedContent, expectedFingerprint: digest(expectedContent), mode: old?.mode ?? 0o644 });
    for (const parent of ancestors(action.target)) plannedParents.add(parent);
  }
  requireThat(isDeepStrictEqual(baseline, await snapshot(cwd)), 'NATIVE_FILESYSTEM_DRIFT');
  // A healthy Hook is not fail-closed isolation: absent/crashed Hooks must not
  // authorize writes. No genuinely verified native floor is currently available.
  requireThat(executionKind !== 'real-cli', 'NATIVE_PERMISSION_FLOOR_UNVERIFIED');
  const policy = { schemaVersion: 1, cwd, sessionId, executionKind, humanApprovalProven: decision.humanApprovalProven,
    proposal, proposalDigest: capture.proposalDigest, approval: record, plans,
    cwdAnchors: await pathAnchors(cwd), controlParentAnchors: await pathAnchors(path.dirname(control)),
    secretFingerprints: secrets.filter((secret) => typeof secret === 'string' && secret.length)
      .map((secret) => ({ length: secret.length, digest: digest(secret) })) };
  requireThat(policy.secretFingerprints.length <= 16, 'NATIVE_INPUT_LIMIT');
  requireThat(await realpath(path.dirname(control)) === path.dirname(control), 'NATIVE_CONTROL_INVALID');
  try { await mkdir(control, { mode: 0o700 }); }
  catch (cause) { if (cause.code !== 'EEXIST') throw failure('NATIVE_CONTROL_INVALID'); }
  await controlDirectory(control);
  await privateWrite(control, policyName, policy, true);
  await privateWrite(control, stateName, { schemaVersion: 1, policyDigest: digestProposal(policy), phase: 'idle', next: 0,
    pending: null, usedIds: [], completed: [], completedTools: 0, eventCount: 0, part: 0,
    referenceParts: [], prereads: [], snapshot: baseline }, true);
  await privateWrite(control, journalName, '', true);
  return diagnostics(policy, { status: 'prepared', proposalDigest: policy.proposalDigest, actionCount: ids.length,
    mutationToolCount: plans.reduce((count, plan) => count + (plan.reference ? plan.steps?.length ?? 1 : 1), 0) });
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function failureContext(policy, state) {
  return { completed: state.completed, failedActionIndex: state.next,
    ...(policy.plans[state.next] ? { failedTargetDigest: digest(policy.plans[state.next].target) } : {}),
    pendingActionIndexes: policy.plans.map((_, index) => index).slice(state.next),
    verifiedReferenceParts: state.referenceParts, rollbackPerformed: false };
}

async function transaction(control, operation) {
  await controlDirectory(control);
  let lock;
  try { lock = await open(path.join(control, 'apply-lock'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch { throw failure('NATIVE_CONTROL_BUSY'); }
  try {
    const policy = data(JSON.parse(await privateRead(control, policyName)));
    const state = JSON.parse(await privateRead(control, stateName));
    requireThat(policy.schemaVersion === 1 && state.schemaVersion === 1 && state.policyDigest === digestProposal(policy), 'NATIVE_CONTROL_INVALID');
    requireThat(policy.executionKind !== 'real-cli', 'NATIVE_PERMISSION_FLOOR_UNVERIFIED');
    if (state.error || state.phase === 'completed') throw Object.assign(failure(state.error ?? 'NATIVE_APPLY_COMPLETED'),
      { failureContext: failureContext(policy, state) });
    try {
      requireThat(isDeepStrictEqual(await pathAnchors(policy.cwd), policy.cwdAnchors)
        && isDeepStrictEqual(await pathAnchors(path.dirname(control)), policy.controlParentAnchors), 'NATIVE_ANCESTOR_DRIFT');
      return await operation(policy, state);
    } catch (cause) {
      state.error = /^NATIVE_[A-Z_]+$|^(?:APPROVAL|STALE|PROCESS|TRACE|SECRET)_[A-Z_]+$/.test(cause.code ?? '') ? cause.code : 'NATIVE_APPLY_FAILED';
      state.phase = 'failed';
      await privateWrite(control, stateName, state);
      throw Object.assign(failure(state.error), { failureContext: failureContext(policy, state) });
    }
  } finally {
    await lock.close();
    await unlink(path.join(control, 'apply-lock'));
  }
}

async function persist(control, policy, state, fields) {
  state.eventCount += 1;
  await privateWrite(control, stateName, state);
  // Only static tags/digests/indexes. No native ID, input, response, path or source.
  const event = { event: fields.event, decision: fields.decision, actionIndex: state.next, partIndex: state.part,
    proposalDigest: policy.proposalDigest, ...(state.pending ? { callDigest: digest(state.pending.id), inputDigest: digestProposal(state.pending.input) } : {}) };
  const handle = await open(path.join(control, journalName), constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    const line = `${JSON.stringify(event)}\n`;
    requireThat(stat.isFile() && stat.nlink === 1 && (stat.mode & 0o777) === 0o600 && stat.size + Buffer.byteLength(line) <= maxBytes, 'NATIVE_CONTROL_INVALID');
    await handle.writeFile(line);
    await handle.sync();
  } finally { await handle.close(); }
}

function nativeDecision(policy, decision, code) {
  return diagnostics(policy, { status: decision, hookSpecificOutput: { hookEventName: 'PreToolUse',
    permissionDecision: decision, permissionDecisionReason: code } });
}
async function unchanged(policy, state) {
  requireThat(isDeepStrictEqual(await snapshot(policy.cwd), state.snapshot), 'NATIVE_FILESYSTEM_DRIFT');
}

// Pinned 2.1.285 optional snapshot diff metadata, never mutation authority.
function validBashEditDiff(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => ['files', 'moreFiles', 'changedFiles', 'unavailable', 'skipped', 'shared'].includes(key))
    && Number.isFinite(value.moreFiles) && Array.isArray(value.files)
    && value.files.every(file => file && typeof file === 'object' && !Array.isArray(file)
      && Object.keys(file).every(key => ['filePath', 'hunks', 'created', 'deleted'].includes(key))
      && typeof file.filePath === 'string' && Array.isArray(file.hunks)
      && ['created', 'deleted'].every(key => !Object.hasOwn(file, key) || file[key] === true)
      && file.hunks.every(hunk => hunk && typeof hunk === 'object' && !Array.isArray(hunk)
        && Object.keys(hunk).every(key => ['oldStart', 'oldLines', 'newStart', 'newLines', 'lines'].includes(key))
        && ['oldStart', 'oldLines', 'newStart', 'newLines'].every(key => Number.isFinite(hunk[key]))
        && Array.isArray(hunk.lines) && hunk.lines.every(line => typeof line === 'string')))
    && (!Object.hasOwn(value, 'changedFiles') || Array.isArray(value.changedFiles) && value.changedFiles.every(file => typeof file === 'string'))
    && ['unavailable', 'skipped', 'shared'].every(key => !Object.hasOwn(value, key) || value[key] === true);
}

/** Documented Hook input: hook_event_name, session_id, cwd, tool_use_id,
 * tool_name, tool_input; Post additionally requires tool_response. A helper
 * forwards ONLY hookSpecificOutput/continue/stopReason to Claude; the remaining
 * fields are private unqualified diagnostics, not invented native controls.
 */
export async function decideClaudeNativeApply({ control, input }) {
  let policy;
  let event;
  const eventName = input && typeof input === 'object' ? Object.getOwnPropertyDescriptor(input, 'hook_event_name')?.value : undefined;
  try {
    return await transaction(control, async (loaded, state) => {
      policy = loaded;
      event = data(input);
      requireThat(['PreToolUse', 'PostToolUse'].includes(event.hook_event_name), 'NATIVE_EVENT_UNKNOWN');
      requireThat(event.session_id === policy.sessionId, 'NATIVE_SESSION_MISMATCH');
      requireThat(event.cwd === policy.cwd, 'NATIVE_CWD_MISMATCH');
      requireThat(typeof event.tool_use_id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(event.tool_use_id)
        && !sensitiveClaudeText(event.tool_use_id), 'NATIVE_CALL_INVALID');
      for (const secret of policy.secretFingerprints) {
        for (let start = 0; start + secret.length <= event.tool_use_id.length; start += 1) {
          requireThat(digest(event.tool_use_id.slice(start, start + secret.length)) !== secret.digest, 'NATIVE_CALL_INVALID');
        }
      }
      const call = { id: event.tool_use_id, name: event.tool_name, input: event.tool_input };
      const plan = policy.plans[state.next];
      requireThat(plan, 'NATIVE_ACTION_ORDER');
      const action = policy.proposal.actions.filter(item => ['CREATE', 'UPDATE'].includes(item.action))[state.next];
      if (call.name === 'Read') {
        requireThat(!plan.reference && action.action === 'UPDATE'
          && Object.keys(call.input ?? {}).join(',') === 'file_path'
          && call.input.file_path === path.join(policy.cwd, plan.target), 'NATIVE_PREREAD_SCOPE');
        await unchanged(policy, state);
        await physicalTarget(policy.cwd, plan.target);
        requireThat(await fingerprintPath(policy.cwd, plan.target) === action.baselineFingerprint, 'NATIVE_BASELINE_STALE');
        if (event.hook_event_name === 'PreToolUse') {
          requireThat(state.phase === 'idle' && !state.usedIds.includes(call.id)
            && !state.prereads.some(read => read.actionIndex === state.next), 'NATIVE_CALL_REPLAY');
          state.usedIds.push(call.id);
          state.pending = call;
          state.phase = 'reading';
          await persist(control, policy, state, { event: 'PreToolUse', decision: 'preread-allow' });
          return nativeDecision(policy, 'allow', 'NATIVE_APPROVED_PREREAD_ONCE');
        }
        requireThat(state.phase === 'reading' && isDeepStrictEqual(call, state.pending), 'NATIVE_POST_UNMATCHED');
        const response = event.tool_response;
        const file = response?.file;
        requireThat(response?.type === 'text' && file?.filePath === call.input.file_path
          && typeof file.content === 'string' && digest(file.content) === action.baselineFingerprint
          && file.startLine === 1 && file.numLines === file.content.split('\n').length
          && file.totalLines === file.numLines, 'NATIVE_PREREAD_UNVERIFIED');
        state.prereads.push({ actionIndex: state.next, callDigest: digest(call.id), inputDigest: digestProposal(call.input),
          responseDigest: digestProposal(response), fingerprint: action.baselineFingerprint });
        await persist(control, policy, state, { event: 'PostToolUse', decision: 'preread-verified' });
        state.phase = 'idle';
        state.pending = null;
        await privateWrite(control, stateName, state);
        return diagnostics(policy, { status: 'preread-verified', actionIndex: state.next });
      }
      if (event.hook_event_name === 'PreToolUse') {
        await unchanged(policy, state);
        if (plan.reference && plan.steps) {
          requireThat(call.name === 'Bash', 'NATIVE_TOOL_DENIED');
          const step = plan.steps[state.part];
          requireThat(step && Object.keys(call.input ?? {}).join(',') === 'command'
            && call.input.command === step.command, 'NATIVE_REFERENCE_CALL_MISMATCH');
          await physicalTarget(policy.cwd, step.target);
          requireThat(!state.snapshot[step.target], 'NATIVE_BASELINE_STALE');
          if (step.kind === 'symlink') {
            await physicalTarget(policy.cwd, plan.canonicalTarget);
            requireThat(state.snapshot[plan.canonicalTarget]?.type === 'directory'
              && await realpath(path.join(policy.cwd, plan.canonicalTarget)) === path.join(policy.cwd, plan.canonicalTarget), 'NATIVE_REFERENCE_INVALID');
          }
        } else {
          requireThat(call.name !== 'Bash', 'NATIVE_REFERENCE_PERMISSION_UNVERIFIED');
          requireThat(['Write', 'Edit'].includes(call.name) && !plan.reference, 'NATIVE_TOOL_DENIED');
          requireThat(action.action !== 'UPDATE' || state.prereads.some(read => read.actionIndex === state.next
            && read.fingerprint === action.baselineFingerprint), 'NATIVE_PREREAD_MISSING');
          await physicalTarget(policy.cwd, plan.target);
          requireThat(call.input?.file_path === path.join(policy.cwd, plan.target), 'NATIVE_ACTION_ORDER');
          requireThat(await fingerprintPath(policy.cwd, plan.target) === policy.proposal.actions
            .filter((action) => ['CREATE', 'UPDATE'].includes(action.action))[state.next].baselineFingerprint, 'NATIVE_BASELINE_STALE');
          if (call.name === 'Write') {
            requireThat(Object.keys(call.input).sort().join(',') === 'content,file_path'
              && call.input.content === plan.expectedContent, 'NATIVE_INPUT_MISMATCH');
          } else {
            const keys = Object.keys(call.input);
            requireThat(keys.every((key) => ['file_path', 'old_string', 'new_string', 'replace_all'].includes(key))
              && typeof call.input.old_string === 'string' && call.input.old_string.length > 0
              && typeof call.input.new_string === 'string'
              && (!Object.hasOwn(call.input, 'replace_all') || typeof call.input.replace_all === 'boolean'), 'NATIVE_INPUT_MISMATCH');
            const handle = await open(call.input.file_path, constants.O_RDONLY | constants.O_NOFOLLOW);
            let before;
            try { before = await handle.readFile('utf8'); } finally { await handle.close(); }
            const pieces = before.split(call.input.old_string);
            requireThat(pieces.length > 1 && (call.input.replace_all === true || pieces.length === 2), 'NATIVE_INPUT_MISMATCH');
            const after = pieces.join(call.input.new_string);
            const action = policy.proposal.actions.filter((item) => ['CREATE', 'UPDATE'].includes(item.action))[state.next];
            requireThat(action.action === 'UPDATE' && after === plan.expectedContent
              && renderExactDiff(plan.target, before, after) === action.proposedDiff, 'NATIVE_INPUT_MISMATCH');
          }
        }
        if (state.phase === 'idle') {
          requireThat(!state.usedIds.includes(call.id), 'NATIVE_CALL_REPLAY');
          state.usedIds.push(call.id);
          state.pending = call;
          state.phase = 'deferred';
          await persist(control, policy, state, { event: 'PreToolUse', decision: 'defer' });
          return nativeDecision(policy, 'defer', 'NATIVE_APPROVED_CALL_DEFERRED');
        }
        requireThat(isDeepStrictEqual(call, state.pending), 'NATIVE_PENDING_MISMATCH');
        requireThat(state.phase === 'armed', 'NATIVE_CALL_REPLAY');
        state.phase = 'running'; // Durably consume under an exclusive lock before allow.
        await persist(control, policy, state, { event: 'PreToolUse', decision: 'allow' });
        return nativeDecision(policy, 'allow', 'NATIVE_APPROVED_CALL_ONCE');
      }
      requireThat(state.phase === 'running' && isDeepStrictEqual(call, state.pending), 'NATIVE_POST_UNMATCHED');
      requireThat(Object.hasOwn(event, 'tool_response'), 'NATIVE_RESPONSE_MISSING');
      if (plan.reference) {
        const step = plan.steps[state.part];
        // Pinned 2.1.285 foreground output for exact /bin/mkdir and /bin/ln calls.
        // Absolute raw tokens do not match Yfr's bare-command no-output predicate.
        const { bashEditDiff, ...foreground } = event.tool_response ?? {};
        requireThat(isDeepStrictEqual(foreground, {
          stdout: '', stderr: '', interrupted: false, isImage: false, noOutputExpected: false,
        }) && (!Object.hasOwn(event.tool_response, 'bashEditDiff') || validBashEditDiff(bashEditDiff)), 'NATIVE_REFERENCE_RESPONSE_UNVERIFIED');
        const after = await snapshot(policy.cwd);
        const target = after[step.target];
        if (step.kind === 'directory') {
          await physicalTarget(policy.cwd, step.target);
          requireThat(target?.type === 'directory' && target.mode === 0o755, 'NATIVE_PAYLOAD_MISMATCH');
        } else {
          await physicalTarget(policy.cwd, plan.canonicalTarget);
          requireThat(target?.type === 'symlink' && target.digest === digest(plan.linkTarget)
            && await realpath(path.join(policy.cwd, plan.target)) === path.join(policy.cwd, plan.canonicalTarget), 'NATIVE_PAYLOAD_MISMATCH');
        }
        for (const key of new Set([...Object.keys(state.snapshot), ...Object.keys(after)])) {
          if (key === step.target) continue;
          const before = state.snapshot[key];
          const current = after[key];
          if (key === path.posix.dirname(step.target)) {
            requireThat(before?.type === 'directory' && current?.type === 'directory'
              && current.identity === before.identity && current.mode === before.mode, 'NATIVE_ANCESTOR_DRIFT');
          } else requireThat(isDeepStrictEqual(before, current), 'NATIVE_EXTRA_MUTATION');
        }
        const verified = { actionIndex: state.next, partIndex: state.part, callDigest: digest(call.id),
          inputDigest: digestProposal(call.input), targetDigest: digest(step.target) };
        const finished = step.kind === 'symlink';
        const fingerprint = finished ? await fingerprintPath(policy.cwd, plan.target) : undefined;
        state.referenceParts.push(verified);
        if (finished) state.completed.push({ ...verified, fingerprint });
        await persist(control, policy, state, { event: 'PostToolUse', decision: 'verified' });
        state.completedTools += 1;
        const actionIndex = state.next;
        if (finished) { state.next += 1; state.part = 0; }
        else state.part += 1;
        state.phase = 'idle';
        state.pending = null;
        state.snapshot = after;
        await privateWrite(control, stateName, state);
        return diagnostics(policy, { status: finished ? 'action-completed' : 'reference-part-completed',
          actionIndex, ...(finished ? { fingerprint } : { partIndex: verified.partIndex }) });
      }
      await physicalTarget(policy.cwd, plan.target);
      const after = await snapshot(policy.cwd);
      const target = after[plan.target];
      requireThat(target?.type === 'file' && target.links === '1' && target.digest === plan.expectedFingerprint
        && target.mode === plan.mode, 'NATIVE_PAYLOAD_MISMATCH');
      const parents = ancestors(plan.target);
      for (const key of new Set([...Object.keys(state.snapshot), ...Object.keys(after)])) {
        if (key === plan.target) continue;
        const before = state.snapshot[key];
        const current = after[key];
        if (parents.includes(key)) {
          requireThat(current?.type === 'directory' && (before
            ? current.identity === before.identity && current.mode === before.mode
            : current.mode === 0o755), 'NATIVE_ANCESTOR_DRIFT');
        } else requireThat(isDeepStrictEqual(before, current), 'NATIVE_EXTRA_MUTATION');
      }
      state.completed.push({ actionIndex: state.next, callDigest: digest(call.id), inputDigest: digestProposal(call.input),
        targetDigest: digest(plan.target), fingerprint: target.digest });
      await persist(control, policy, state, { event: 'PostToolUse', decision: 'verified' });
      state.completedTools += 1;
      state.next += 1;
      state.phase = 'idle';
      state.pending = null;
      state.snapshot = after;
      await privateWrite(control, stateName, state);
      return diagnostics(policy, { status: 'action-completed', actionIndex: state.next - 1, fingerprint: target.digest });
    });
  } catch (cause) {
    const code = /^NATIVE_[A-Z_]+$/.test(cause.code ?? '') ? cause.code : 'NATIVE_APPLY_FAILED';
    const output = eventName === 'PreToolUse'
      ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: code } }
      : { continue: false, stopReason: code };
    return diagnostics(policy ?? { executionKind: 'unknown', humanApprovalProven: false }, { status: 'failed', code,
      ...(cause.failureContext ? { failureContext: cause.failureContext } : {}), ...output });
  }
}

function nativeResult(processResult, policy) {
  requireThat(processResult?.status === 0 && !['cleanupError', 'spawnError', 'timedOut', 'truncated', 'signal', 'stopReason'].some((key) => processResult[key]), 'NATIVE_PROCESS_FAILED');
  requireThat(typeof processResult.stdout === 'string' && Buffer.byteLength(processResult.stdout) <= maxBytes, 'NATIVE_RESULT_INVALID');
  // Inspect escaped AND shadowed literals before JSON.parse discards them.
  // A bounded parent-only scan uses fingerprints; native helpers never get auth.
  let literals = 0;
  let scanned = 0;
  for (const match of processResult.stdout.matchAll(/"(?:\\.|[^"\\])*"/g)) {
    requireThat(++literals <= 10000, 'NATIVE_RESULT_INVALID');
    let value;
    try { value = JSON.parse(match[0]); } catch { throw failure('NATIVE_RESULT_INVALID'); }
    scanned += value.length;
    requireThat(scanned <= 2 * 1024 * 1024, 'NATIVE_RESULT_INVALID');
    requireThat(!sensitiveClaudeText(value), 'SECRET_TRACE');
    for (const secret of policy.secretFingerprints) {
      for (let start = 0; start + secret.length <= value.length; start += 1) {
        requireThat(digest(value.slice(start, start + secret.length)) !== secret.digest, 'SECRET_TRACE');
      }
    }
  }
  let result;
  try { result = data(JSON.parse(processResult.stdout)); }
  catch { throw failure('NATIVE_RESULT_INVALID'); }
  requireThat(result.type === 'result' && result.subtype === 'success' && result.is_error === false
    && result.session_id === policy.sessionId && Array.isArray(result.permission_denials) && result.permission_denials.length === 0, 'NATIVE_RESULT_INVALID');
  return result;
}

/** Parent-only arm: pass the actual native result (stop_reason=tool_deferred,
 * deferred_tool_use={id,name,input}) AND explicitly authorize that same call.
 * No boolean permit, arbitrary call ID, synthetic real-cli authority or new call.
 */
export async function captureClaudeNativeApplyDeferred({ control, processResult, authorizedCall }) {
  return transaction(control, async (policy, state) => {
    const result = nativeResult(processResult, policy);
    requireThat(result.stop_reason === 'tool_deferred' && result.deferred_tool_use, 'NATIVE_DEFER_NOT_OBSERVED');
    requireThat(state.phase === 'deferred' && isDeepStrictEqual(data(result.deferred_tool_use), state.pending)
      && isDeepStrictEqual(data(authorizedCall), state.pending), 'NATIVE_DEFER_MISMATCH');
    const raw = await privateRead(control, journalName);
    let records;
    try { records = raw.trim().split('\n').map((line) => JSON.parse(line)); }
    catch { throw failure('NATIVE_DEFER_RECORD_MISSING'); }
    const pre = records.at(-1);
    requireThat(raw.endsWith('\n') && records.length === state.eventCount && pre?.event === 'PreToolUse'
      && pre.decision === 'defer' && pre.actionIndex === state.next && pre.partIndex === state.part && pre.proposalDigest === policy.proposalDigest
      && pre.callDigest === digest(state.pending.id) && pre.inputDigest === digestProposal(state.pending.input), 'NATIVE_DEFER_RECORD_MISSING');
    await unchanged(policy, state);
    await physicalTarget(policy.cwd, policy.plans[state.next].target);
    state.phase = 'armed';
    await persist(control, policy, state, { event: 'ParentArm', decision: 'armed' });
    return diagnostics(policy, { status: 'armed', callDigest: digest(state.pending.id), inputDigest: digestProposal(state.pending.input) });
  });
}

export async function completeClaudeNativeApply({ control, processResult }) {
  return transaction(control, async (policy, state) => {
    const result = nativeResult(processResult, policy);
    requireThat(!result.deferred_tool_use && result.stop_reason !== 'tool_deferred', 'NATIVE_RESUME_INCOMPLETE');
    requireThat(state.phase === 'idle' && state.next === policy.plans.length && state.completed.length === policy.plans.length, 'NATIVE_POST_MISSING');
    await unchanged(policy, state);
    state.phase = 'completed';
    await persist(control, policy, state, { event: 'Complete', decision: 'completed' });
    return diagnostics(policy, { status: 'completed', proposalDigest: policy.proposalDigest, completed: state.completed,
      repositoryDigest: digestProposal(state.snapshot), hookCoverageProven: false });
  });
}
