import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';

const ACTIONS = new Set(['CREATE', 'UPDATE', 'KEEP', 'SKIP', 'RECOMMEND']);
const PERSISTENCE_SCOPES = new Set(['GLOBAL', 'WORKFLOW', 'DISCOVERABLE', 'ARCHITECTURE', 'NONE']);
const LEDGER_SCOPES = new Set([...PERSISTENCE_SCOPES, 'Unknown']);
const WRITE_ACTIONS = new Set(['CREATE', 'UPDATE']);
const NON_WRITE_ACTIONS = new Set(['KEEP', 'SKIP', 'RECOMMEND']);
const SKILL_DECISIONS = new Set(['CREATE', 'UPDATE', 'KEEP', 'SKIP']);
const SKILL_ASSESSMENT_DIMENSIONS = [
  'taskSpecificity',
  'rediscoveryCost',
  'errorCost',
  'reuseFrequency',
];
const SKILL_ASSESSMENT_LEVELS = new Set(['low', 'medium', 'high', 'unknown']);
const EVENT_ORDER = ['preflight', 'explore', 'profile', 'classify', 'skills', 'proposal', 'approval', 'write', 'validation', 'reconcile'];

export const EVALUATION_BOUNDARIES = Object.freeze({
  local: Object.freeze({
    staticSkillContract: 'automated',
    deterministicHelper: 'automated',
    fixtureSchema: 'automated',
    recordedRunInvariants: 'automated',
    filesystemScopeChecks: 'automated',
  }),
  external: Object.freeze({
    claudeCodeDiscoveryAndInvocation: 'external-acceptance',
    codexDiscoveryAndInvocation: 'external-acceptance',
    approvalBehaviorInFreshSessions: 'external-acceptance',
    generatedOutputQualityInFreshSessions: 'external-acceptance',
  }),
});

function compareText(left, right) {
  return left.localeCompare(right, 'en');
}

function sorted(values) {
  return [...values].sort(compareText);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeRepositoryPath(value) {
  return value.split(path.sep).join('/');
}

function encodeTreeRecord(record) {
  const header = Buffer.from(`${record.path}\0${record.type}\0${record.mode ?? ''}\0`, 'utf8');
  const payload = record.content ?? Buffer.from(record.linkText ?? '', 'utf8');
  return Buffer.concat([header, payload, Buffer.from('\0')]);
}

async function collectTreeRecords(directory, relative = '.') {
  const names = (await readdir(directory)).sort(compareText);
  const records = [];
  for (const name of names) {
    const absolute = path.join(directory, name);
    const childRelative = relative === '.' ? name : `${relative}/${name}`;
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink()) {
      records.push({
        path: childRelative,
        type: 'symlink',
        linkText: await readlink(absolute),
      });
    } else if (stat.isDirectory()) {
      records.push({ path: childRelative, type: 'directory' });
      records.push(...await collectTreeRecords(absolute, childRelative));
    } else if (stat.isFile()) {
      records.push({
        path: childRelative,
        type: 'file',
        mode: stat.mode & 0o111 ? 'executable' : 'ordinary',
        content: await readFile(absolute),
      });
    } else {
      throw new Error(`unsupported entry type: ${childRelative}`);
    }
  }
  return records;
}

export async function fingerprintPath(repositoryRoot, target) {
  if (!isLexicallySafeRelativePath(target)) {
    throw new Error(`target must be a normalized repository-relative path: ${target}`);
  }
  const physicalRoot = await realpath(repositoryRoot);
  const scopeErrors = await validatePhysicalScope(physicalRoot, target, false);
  if (scopeErrors.length > 0) throw new Error(scopeErrors.join('\n'));
  const absolute = path.resolve(physicalRoot, target);
  let stat;
  try {
    stat = await lstat(absolute);
  } catch (cause) {
    if (cause?.code === 'ENOENT') return 'missing';
    throw cause;
  }
  if (stat.isSymbolicLink()) {
    const linkText = await readlink(absolute);
    const normalizedDestination = normalizeRepositoryPath(
      path.relative(physicalRoot, path.resolve(path.dirname(absolute), linkText)),
    );
    return `symlink-sha256:${sha256(`${linkText}\0${normalizedDestination}`)}`;
  }
  if (stat.isFile()) {
    return `sha256:${sha256(await readFile(absolute))}`;
  }
  if (stat.isDirectory()) {
    const records = await collectTreeRecords(absolute);
    const hash = createHash('sha256');
    for (const record of records) hash.update(encodeTreeRecord(record));
    return `tree-sha256:${hash.digest('hex')}`;
  }
  throw new Error(`unsupported entry type: ${target}`);
}

async function snapshotRepository(repositoryRoot) {
  const physicalRoot = await realpath(repositoryRoot);
  const records = await collectTreeRecords(physicalRoot);
  const snapshot = {};
  for (const record of records) {
    const entry = { type: record.type };
    if (record.type === 'file') {
      entry.fingerprint = `sha256:${sha256(record.content)}`;
      entry.content = record.content.toString('utf8');
      entry.mode = record.mode;
    } else if (record.type === 'symlink') {
      const absolute = path.join(physicalRoot, record.path);
      const normalizedDestination = normalizeRepositoryPath(
        path.relative(physicalRoot, path.resolve(path.dirname(absolute), record.linkText)),
      );
      entry.fingerprint = `symlink-sha256:${sha256(`${record.linkText}\0${normalizedDestination}`)}`;
      entry.linkText = record.linkText;
      entry.normalizedDestination = normalizedDestination;
    } else {
      entry.fingerprint = `directory:${record.path}`;
    }
    snapshot[record.path] = entry;
  }
  return snapshot;
}

export async function fingerprintRepository(repositoryRoot) {
  const physicalRoot = await realpath(repositoryRoot);
  const records = await collectTreeRecords(physicalRoot);
  const hash = createHash('sha256');
  for (const record of records) hash.update(encodeTreeRecord(record));
  return `tree-sha256:${hash.digest('hex')}`;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort(compareText).map((key) => [key, canonicalize(value[key])]),
  );
}

export function digestProposal(proposal) {
  return `sha256:${sha256(Buffer.from(JSON.stringify(canonicalize(proposal)), 'utf8'))}`;
}

function splitLines(content) {
  if (content === '') return [];
  const lines = content.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

export function renderExactDiff(target, before, after) {
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);
  const body = [
    `--- a/${target}`,
    `+++ b/${target}`,
    `@@ -1,${beforeLines.length} +1,${afterLines.length} @@`,
    ...beforeLines.map((line) => `-${line}`),
    ...afterLines.map((line) => `+${line}`),
  ];
  return `${body.join('\n')}\n`;
}

function applyExactDiff(target, before, diff) {
  const lines = diff.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines[0] !== `--- a/${target}` || lines[1] !== `+++ b/${target}`) {
    throw new Error('diff headers do not match the exact target');
  }
  const hunk = /^@@ -1,(\d+) \+1,(\d+) @@$/.exec(lines[2] ?? '');
  if (!hunk) throw new Error('diff must be one full-file hunk');
  const expectedBefore = splitLines(before);
  const beforeCount = Number(hunk[1]);
  const afterCount = Number(hunk[2]);
  const removed = [];
  const added = [];
  for (const line of lines.slice(3)) {
    if (line.startsWith('-')) removed.push(line.slice(1));
    else if (line.startsWith('+')) added.push(line.slice(1));
    else throw new Error('diff hunk may contain only exact removed and added lines');
  }
  if (beforeCount !== expectedBefore.length || removed.length !== beforeCount
    || JSON.stringify(removed) !== JSON.stringify(expectedBefore)) {
    throw new Error('diff removed lines do not exactly match baseline bytes');
  }
  if (added.length !== afterCount) throw new Error('diff added-line count is inconsistent');
  return added.length > 0 ? `${added.join('\n')}\n` : '';
}

function preservesBaselineOrder(before, after, approvedRemovals = []) {
  const removalBudget = new Map();
  for (const line of approvedRemovals) {
    removalBudget.set(line, (removalBudget.get(line) ?? 0) + 1);
  }
  const afterLines = splitLines(after);
  let cursor = 0;
  for (const line of splitLines(before)) {
    let found = -1;
    for (let index = cursor; index < afterLines.length; index += 1) {
      if (afterLines[index] === line) {
        found = index;
        break;
      }
    }
    if (found !== -1) {
      cursor = found + 1;
      continue;
    }
    const remaining = removalBudget.get(line) ?? 0;
    if (remaining === 0) return false;
    removalBudget.set(line, remaining - 1);
  }
  return true;
}

function normalizeTextLine(line) {
  return line
    .replace(/^\s*[-*+]\s+/, '')
    .replace(/[`*_#]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function error(errors, code, message) {
  errors.push(`${code}: ${message}`);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function uniqueIds(records, field, errors, label) {
  const seen = new Set();
  for (const record of records) {
    const id = record?.[field];
    if (typeof id !== 'string' || id.length === 0) {
      error(errors, 'SCHEMA', `${label} has a missing ${field}`);
    } else if (seen.has(id)) {
      error(errors, 'SCHEMA', `${label} repeats ${field} ${id}`);
    } else {
      seen.add(id);
    }
  }
  return seen;
}

function hasNonEmptyStrings(value) {
  return Array.isArray(value)
    && value.length > 0
    && value.every((item) => typeof item === 'string' && item.trim().length > 0);
}

function validateSkillCandidateRecord(record, actionField, evidenceById, errors, label) {
  const knownEvidenceIds = new Set(evidenceById.keys());
  const action = record?.[actionField];
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(record?.name ?? '')) {
    error(errors, 'SKILL_DECISION', `${label} requires a lowercase-hyphen name`);
  }
  if (!SKILL_DECISIONS.has(action)) {
    error(errors, 'SKILL_DECISION', `${label} uses unsupported decision ${action}`);
  }

  const candidateEvidenceIds = Array.isArray(record?.evidenceIds) ? record.evidenceIds : [];
  if (!hasNonEmptyStrings(candidateEvidenceIds)) {
    error(errors, 'EVIDENCE', `${label} requires evidenceIds`);
  }
  for (const evidenceId of candidateEvidenceIds) {
    if (!knownEvidenceIds.has(evidenceId)) {
      error(errors, 'EVIDENCE', `${label} references unknown evidence ${evidenceId}`);
    }
  }

  if (!isObject(record?.skillAssessment)) {
    error(errors, 'SKILL_ASSESSMENT', `${label} requires skillAssessment`);
  } else {
    for (const dimension of SKILL_ASSESSMENT_DIMENSIONS) {
      if (!SKILL_ASSESSMENT_LEVELS.has(record.skillAssessment[dimension])) {
        error(errors, 'SKILL_ASSESSMENT', `${label} has invalid ${dimension}`);
      }
    }
  }

  const search = record?.targetedFollowUpSearch;
  if (!isObject(search)
    || !hasNonEmptyStrings(search.queries)
    || !hasNonEmptyStrings(search.paths)
    || typeof search.result !== 'string'
    || search.result.trim().length === 0
    || !hasNonEmptyStrings(search.evidenceIds)) {
    error(errors, 'TARGETED_SEARCH', `${label} requires queries, paths, result, and evidence IDs`);
  } else {
    for (const inspectedPath of search.paths) {
      if (path.isAbsolute(inspectedPath) || inspectedPath.split(/[\\/]/).includes('..')) {
        error(errors, 'TARGETED_SEARCH', `${label} search path must be repository-relative: ${inspectedPath}`);
      }
    }
    for (const evidenceId of search.evidenceIds) {
      if (!knownEvidenceIds.has(evidenceId) || !candidateEvidenceIds.includes(evidenceId)) {
        error(errors, 'TARGETED_SEARCH', `${label} search evidence ${evidenceId} is not candidate evidence`);
      }
    }
  }

  if (WRITE_ACTIONS.has(action)) {
    const qualified = hasNonEmptyStrings(record.taskTriggers)
      && hasNonEmptyStrings(record.whenNotToUse)
      && hasNonEmptyStrings(record.workflowSteps)
      && hasNonEmptyStrings(record.verification);
    if (!qualified) {
      error(errors, 'STACK_TO_SKILL', `${label} lacks an evidence-backed workflow floor`);
    } else {
      const observations = candidateEvidenceIds
        .map((evidenceId) => evidenceById.get(evidenceId)?.observation ?? '')
        .join('\n');
      for (const verification of record.verification) {
        if (!observations.includes(verification)) {
          error(errors, 'GUESSED_VERIFICATION', `${label} verification is not quoted by its evidence: ${verification}`);
        }
      }
    }
  }

  if (action === 'SKIP') {
    const basis = record?.skipBasis;
    const dimensions = basis?.dimensions;
    const explanation = basis?.explanation;
    const reason = record?.reason;
    const rationale = `${reason ?? ''}\n${explanation ?? ''}`;
    const validDimensions = hasNonEmptyStrings(dimensions)
      && dimensions.every((dimension) => SKILL_ASSESSMENT_DIMENSIONS.includes(dimension))
      && new Set(dimensions).size === dimensions.length
      && dimensions.every((dimension) => ['low', 'unknown'].includes(record?.skillAssessment?.[dimension]));
    const substantive = typeof reason === 'string'
      && reason.trim().length > 0
      && typeof explanation === 'string'
      && explanation.trim().length >= 30;
    const invokesModelFamiliarity = /model\s+(?:already\s+)?knows?|model familiarity|familiar technology/i.test(rationale);
    const invokesDiscoverability = /\bdiscoverable\b/i.test(rationale);
    const grounded = /evidence|search|found|path|command|procedure|verification|trigger|reuse|cost|risk|call[- ]site|bounded|focused/i.test(explanation ?? '');
    const groundedSearchOutcome = /(?:search|evidence|inspection).{0,160}(?:found|showed|established|returned)|(?:found|showed|established).{0,160}(?:procedure|verification|trigger|command|call[- ]site)/i.test(rationale);
    if (!isObject(basis)
      || !validDimensions
      || !substantive
      || invokesModelFamiliarity
      || !grounded
      || (invokesDiscoverability && !groundedSearchOutcome)) {
      error(errors, 'UNGROUNDED_SKIP', `${label} requires low/unknown dimensions and a substantive repository-evidence explanation`);
    }
  }

  if (action === 'KEEP') {
    const reuse = record?.reuseExisting;
    const reusePathIsEvidenced = candidateEvidenceIds.some(
      (evidenceId) => evidenceById.get(evidenceId)?.sourcePath === reuse?.path,
    );
    if (!isObject(reuse)
      || typeof reuse.path !== 'string'
      || reuse.path.length === 0
      || typeof reuse.compatibility !== 'string'
      || reuse.compatibility.length === 0
      || !reusePathIsEvidenced) {
      error(errors, 'DUPLICATE_SKILL', `${label} KEEP requires an evidence-backed reuseExisting path and compatibility`);
    }
  }
}

export function validateFixtureManifest(fixture) {
  const errors = [];
  if (!isObject(fixture)) return ['SCHEMA: fixture must be an object'];
  if (fixture.schemaVersion !== 1) error(errors, 'SCHEMA', 'fixture schemaVersion must be 1');
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(fixture.id ?? '')) {
    error(errors, 'SCHEMA', 'fixture id must use lowercase hyphen format');
  }
  if (typeof fixture.repository !== 'string' || fixture.repository.length === 0) {
    error(errors, 'SCHEMA', 'fixture repository path is required');
  }
  if (typeof fixture.purpose !== 'string' || fixture.purpose.length === 0) {
    error(errors, 'SCHEMA', 'fixture purpose is required');
  }
  if (!Array.isArray(fixture.evidence) || fixture.evidence.length === 0) {
    error(errors, 'SCHEMA', 'fixture evidence must be a non-empty array');
  }
  if (!isObject(fixture.expected)) error(errors, 'SCHEMA', 'fixture expected contract is required');

  const evidence = Array.isArray(fixture.evidence) ? fixture.evidence : [];
  const evidenceIds = uniqueIds(evidence, 'id', errors, 'fixture evidence');
  const evidenceById = new Map(evidence.map((record) => [record?.id, record]));
  for (const record of evidence) {
    for (const field of ['fact', 'sourcePath', 'sourceLocation', 'observation', 'whyItMatters']) {
      if (typeof record?.[field] !== 'string' || record[field].length === 0) {
        error(errors, 'SCHEMA', `evidence ${record?.id ?? '<unknown>'} requires ${field}`);
      }
    }
    const sourcePath = record?.sourcePath ?? '';
    if (path.isAbsolute(sourcePath) || sourcePath.split(/[\\/]/).includes('..')) {
      error(errors, 'SCHEMA', `evidence ${record?.id ?? '<unknown>'} sourcePath must be repository-relative`);
    }
  }

  const expected = isObject(fixture.expected) ? fixture.expected : {};
  for (const key of ['facts', 'unknowns', 'classifications', 'skillDecisions', 'preservation']) {
    if (!Array.isArray(expected[key])) error(errors, 'SCHEMA', `expected.${key} must be an array`);
  }
  if (expected.secondRun !== 'NO_WRITE_ACTIONS') {
    error(errors, 'SCHEMA', 'expected.secondRun must be NO_WRITE_ACTIONS');
  }

  for (const fact of expected.facts ?? []) {
    if (!['confirmed', 'unknown', 'conflicting'].includes(fact?.status)) {
      error(errors, 'SCHEMA', `expected fact ${fact?.id ?? '<unknown>'} has invalid status`);
    }
    if (fact?.status === 'confirmed') {
      if (!Array.isArray(fact.evidenceIds) || fact.evidenceIds.length === 0) {
        error(errors, 'SCHEMA', `confirmed fact ${fact?.id ?? '<unknown>'} requires evidenceIds`);
      }
      for (const id of fact?.evidenceIds ?? []) {
        if (!evidenceIds.has(id)) error(errors, 'SCHEMA', `fact ${fact.id} references unknown evidence ${id}`);
      }
    }
  }

  for (const classification of expected.classifications ?? []) {
    if (!PERSISTENCE_SCOPES.has(classification?.persistenceScope)) {
      error(errors, 'SCHEMA', `classification ${classification?.factId ?? '<unknown>'} has invalid persistenceScope`);
    }
    if (typeof classification?.deterministicEnforcementCandidate !== 'boolean') {
      error(errors, 'SCHEMA', `classification ${classification?.factId ?? '<unknown>'} requires a deterministic flag`);
    }
  }

  const skillDecisions = Array.isArray(expected.skillDecisions) ? expected.skillDecisions : [];
  uniqueIds(skillDecisions, 'name', errors, 'expected Skill decision');
  for (const decision of skillDecisions) {
    validateSkillCandidateRecord(
      decision,
      'action',
      evidenceById,
      errors,
      `expected Skill ${decision?.name ?? '<unknown>'}`,
    );
  }

  return errors;
}

function allowedTargetForAction(action) {
  const target = action.target ?? '';
  switch (action.kind) {
    case 'agents':
      return target === 'AGENTS.md';
    case 'claude-adapter':
      return target === 'CLAUDE.md';
    case 'project-skill':
      return /^\.agents\/skills\/[a-z0-9]+(?:-[a-z0-9]+)*\/(?:SKILL\.md|references\/[^/]+|scripts\/[^/]+)$/.test(target);
    case 'claude-skill-reference':
      return /^\.claude\/skills\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(target);
    case 'agent-doc':
      return /^docs\/agents\/[a-z0-9][a-z0-9.-]*\.md$/.test(target)
        && action.knowledgeScope === 'ARCHITECTURE';
    default:
      return false;
  }
}

function isLexicallySafeRelativePath(target) {
  if (typeof target !== 'string' || target.length === 0 || path.isAbsolute(target)) return false;
  const segments = target.split(/[\\/]/);
  return !segments.some((segment) => segment === '' || segment === '.' || segment === '..');
}

async function validatePhysicalScope(repositoryRoot, target, includeTarget) {
  const errors = [];
  if (!isLexicallySafeRelativePath(target)) {
    return [`PATH_SCOPE: target must be a normalized repository-relative path: ${target}`];
  }

  let physicalRoot;
  try {
    physicalRoot = await realpath(repositoryRoot);
  } catch (cause) {
    return [`PATH_SCOPE: repository root cannot be resolved: ${repositoryRoot} (${cause.message})`];
  }

  const candidate = path.resolve(physicalRoot, target);
  const relative = path.relative(physicalRoot, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return [`PATH_SCOPE: target escapes repository root: ${target}`];
  }

  const segments = target.split(/[\\/]/);
  const inspectedSegments = includeTarget ? segments : segments.slice(0, -1);
  let current = physicalRoot;
  for (const [index, segment] of inspectedSegments.entries()) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = await lstat(current);
    } catch (cause) {
      if (cause?.code === 'ENOENT') break;
      error(errors, 'PATH_SCOPE', `cannot inspect path component ${path.relative(physicalRoot, current)}: ${cause.message}`);
      break;
    }
    const isTarget = includeTarget && index === segments.length - 1;
    if (stat.isSymbolicLink()) {
      error(errors, 'PATH_SCOPE', `${isTarget ? 'write target' : 'write ancestor'} is a symbolic link and must not be followed: ${path.relative(physicalRoot, current)}`);
      break;
    }
    if (!isTarget && !stat.isDirectory()) {
      error(errors, 'PATH_SCOPE', `write ancestor is not a directory: ${path.relative(physicalRoot, current)}`);
      break;
    }
  }
  return errors;
}

export async function validateWriteTargetPhysicalScope(repositoryRoot, target) {
  return validatePhysicalScope(repositoryRoot, target, true);
}

function validateEvidenceLedger(fixture, run, errors) {
  const fixtureEvidenceById = new Map(fixture.evidence.map((record) => [record.id, record]));
  const ledger = Array.isArray(run.evidenceLedger) ? run.evidenceLedger : [];
  const ledgerIds = uniqueIds(ledger, 'id', errors, 'evidence ledger');

  for (const record of ledger) {
    if (!fixtureEvidenceById.has(record.id)) {
      error(errors, 'EVIDENCE', `ledger record ${record.id} is not declared by the fixture`);
      continue;
    }
    for (const field of ['fact', 'sourcePath', 'sourceLocation', 'observation', 'whyItMatters']) {
      if (record[field] !== fixtureEvidenceById.get(record.id)[field]) {
        error(errors, 'EVIDENCE', `ledger record ${record.id} changed fixture ${field}`);
      }
    }
    if (!LEDGER_SCOPES.has(record.persistenceScope)) {
      error(errors, 'CLASSIFICATION', `ledger record ${record.id} has invalid persistence scope`);
    }
    if (typeof record.deterministicEnforcementCandidate !== 'boolean') {
      error(errors, 'CLASSIFICATION', `ledger record ${record.id} lacks an independent deterministic flag`);
    }
  }
  for (const id of fixtureEvidenceById.keys()) {
    if (!ledgerIds.has(id)) error(errors, 'EVIDENCE', `fixture evidence ${id} is absent from the run ledger`);
  }

  return { fixtureEvidenceById, ledgerIds, ledger };
}

function validatePhaseEvents(fixture, run, errors) {
  const events = Array.isArray(run.events) ? run.events : [];
  if (events.length === 0) {
    error(errors, 'PHASE_ORDER', 'run must contain ordered phase events');
    return { events, profile: null, classification: null, skills: null };
  }

  let priorRank = -1;
  for (const [index, eventRecord] of events.entries()) {
    const rank = EVENT_ORDER.indexOf(eventRecord?.type);
    if (rank === -1) {
      error(errors, 'PHASE_ORDER', `event ${index} has unknown type ${eventRecord?.type}`);
      continue;
    }
    if (rank < priorRank && eventRecord.type !== 'proposal' && eventRecord.type !== 'approval') {
      error(errors, 'PHASE_ORDER', `event ${eventRecord.type} occurs after a later phase`);
    }
    priorRank = Math.max(priorRank, rank);
  }

  const firstProposalIndex = events.findIndex((eventRecord) => eventRecord.type === 'proposal');
  const firstApprovalIndex = events.findIndex((eventRecord) => eventRecord.type === 'approval');
  const firstWriteIndex = events.findIndex((eventRecord) => eventRecord.type === 'write');
  if (firstProposalIndex === -1) error(errors, 'PROPOSAL_GATE', 'run has no Proposal');
  if (firstWriteIndex !== -1 && (firstProposalIndex === -1 || firstWriteIndex < firstProposalIndex)) {
    error(errors, 'PROPOSAL_GATE', 'a write occurred before the Proposal');
  }
  if (firstWriteIndex !== -1 && (firstApprovalIndex === -1 || firstWriteIndex < firstApprovalIndex)) {
    error(errors, 'APPROVAL_GATE', 'a write occurred before exact approval');
  }

  const preflight = events.find((eventRecord) => eventRecord.type === 'preflight');
  const explore = events.find((eventRecord) => eventRecord.type === 'explore');
  if (!preflight?.readOnly || !explore?.readOnly) {
    error(errors, 'READ_ONLY', 'Preflight and Explore must be recorded as read-only');
  }
  if (typeof preflight?.repositoryFingerprintBefore !== 'string'
    || typeof explore?.repositoryFingerprintAfter !== 'string') {
    error(errors, 'READ_ONLY', 'Preflight and Explore require physical repository fingerprints');
  } else if (preflight.repositoryFingerprintBefore !== explore.repositoryFingerprintAfter) {
    error(errors, 'READ_ONLY', 'repository changed during Preflight or Explore');
  }
  if (!preflight?.baselineId || !isObject(preflight.git) || !Array.isArray(preflight.existingAgentAssets)) {
    error(errors, 'PREFLIGHT', 'Preflight must record baseline, Git summary, and existing Agent assets');
  }
  if (JSON.stringify(explore?.strategy) !== JSON.stringify(['search', 'read-relevant', 'cross-check'])) {
    error(errors, 'EXPLORE', 'Explore strategy must be search, read relevant files, then cross-check');
  }
  if (explore?.sensitiveFiles !== 'presence-only') {
    error(errors, 'PRIVACY', 'sensitive files must default to presence-only exploration');
  }

  const profile = events.find((eventRecord) => eventRecord.type === 'profile');
  const classification = events.find((eventRecord) => eventRecord.type === 'classify');
  const skills = events.find((eventRecord) => eventRecord.type === 'skills');
  if (!profile || !classification || !skills) {
    error(errors, 'PHASE_ORDER', 'profile, classification, and skills events are required');
  }

  const expectedFacts = new Map((fixture.expected.facts ?? []).map((fact) => [fact.id, fact]));
  const actualFacts = new Map((profile?.facts ?? []).map((fact) => [fact.id, fact]));
  for (const [id, expected] of expectedFacts) {
    const actual = actualFacts.get(id);
    if (!actual) {
      error(errors, 'PROFILE', `expected fact ${id} is missing`);
      continue;
    }
    if (actual.status !== expected.status || actual.value !== expected.value) {
      error(errors, 'PROFILE', `fact ${id} does not match the fixture contract`);
    }
    if (JSON.stringify(sorted(actual.evidenceIds ?? [])) !== JSON.stringify(sorted(expected.evidenceIds ?? []))) {
      error(errors, 'EVIDENCE_RELEVANCE', `fact ${id} does not cite the fixture-declared evidence IDs`);
    }
    if (actual.status === 'confirmed' && (!Array.isArray(actual.evidenceIds) || actual.evidenceIds.length === 0)) {
      error(errors, 'EVIDENCE', `confirmed fact ${id} has no evidence`);
    }
  }
  for (const fact of profile?.facts ?? []) {
    if (!expectedFacts.has(fact.id)) {
      error(errors, 'UNSUPPORTED_FACT', `profile added undeclared fact ${fact.id}`);
    }
    if (fact.status === 'confirmed' && (!Array.isArray(fact.evidenceIds) || fact.evidenceIds.length === 0)) {
      error(errors, 'EVIDENCE', `confirmed fact ${fact.id} has no evidence`);
    }
  }

  const actualUnknowns = new Set((profile?.unknowns ?? []).map((item) => typeof item === 'string' ? item : item.id));
  for (const unknown of fixture.expected.unknowns ?? []) {
    if (!actualUnknowns.has(unknown)) error(errors, 'UNKNOWN', `expected Unknown ${unknown} is missing`);
  }

  const expectedClassifications = new Map(
    (fixture.expected.classifications ?? []).map((item) => [item.factId, item]),
  );
  const actualClassifications = new Map((classification?.decisions ?? []).map((item) => [item.factId, item]));
  for (const [factId, expected] of expectedClassifications) {
    const actual = actualClassifications.get(factId);
    if (!actual) {
      error(errors, 'CLASSIFICATION', `classification for ${factId} is missing`);
      continue;
    }
    for (const field of ['persistenceScope', 'deterministicEnforcementCandidate', 'destination']) {
      if (actual[field] !== expected[field]) {
        error(errors, 'CLASSIFICATION', `${factId} has incorrect ${field}`);
      }
    }
  }

  const expectedSkills = new Map(
    (Array.isArray(fixture.expected.skillDecisions) ? fixture.expected.skillDecisions : [])
      .map((item) => [item.name, item]),
  );
  const candidates = skills?.candidates ?? [];
  const ledgerById = new Map((run.evidenceLedger ?? []).map((record) => [record.id, record]));
  const seenCandidateNames = new Set();
  for (const candidate of candidates) {
    const label = `Skill ${candidate?.name ?? '<unknown>'}`;
    if (seenCandidateNames.has(candidate?.name)) {
      error(errors, 'DUPLICATE_SKILL', `${label} appears more than once`);
    } else {
      seenCandidateNames.add(candidate?.name);
    }

    const expected = expectedSkills.get(candidate?.name);
    if (!expected) {
      error(errors, 'UNEXPECTED_SKILL', `${label} is absent from the fixture decision oracle`);
    } else if (candidate.decision !== expected.action) {
      if (expected.action === 'KEEP' && WRITE_ACTIONS.has(candidate.decision)) {
        error(errors, 'DUPLICATE_SKILL', `${label} would overwrite or duplicate an expected existing Skill`);
      }
      if (expected.action === 'SKIP' && WRITE_ACTIONS.has(candidate.decision)) {
        error(errors, 'STACK_TO_SKILL', `${label} turns a non-workflow indicator into a writable Skill`);
      }
      error(errors, 'SKILL_DECISION', `${label} should be ${expected.action}`);
    }

    validateSkillCandidateRecord(candidate, 'decision', ledgerById, errors, label);
  }
  for (const [name, expected] of expectedSkills) {
    if (!seenCandidateNames.has(name)) {
      error(errors, 'SKILL_DECISION', `Skill ${name} should be ${expected.action}`);
    }
  }

  return { events, profile, classification, skills };
}

function validateFactsAgainstEvidence(profile, ledger, errors) {
  const evidenceById = new Map(ledger.map((record) => [record.id, record]));
  for (const fact of profile?.facts ?? []) {
    if (fact.status !== 'confirmed') continue;
    for (const id of fact.evidenceIds ?? []) {
      const evidence = evidenceById.get(id);
      if (!evidence) {
        error(errors, 'EVIDENCE', `fact ${fact.id} references missing ledger evidence ${id}`);
        continue;
      }
      const literalValue = typeof fact.value === 'string' ? fact.value : JSON.stringify(fact.value);
      if (/command|verify|test|build|deploy|release/i.test(fact.id)
        && literalValue && !evidence.observation.includes(literalValue)) {
        error(errors, 'GUESSED_COMMAND', `command fact ${fact.id} is not quoted by evidence ${id}`);
      }
    }
  }
}

function targetMatchesForbidden(target, forbidden) {
  if (forbidden.endsWith('/')) return target === forbidden.slice(0, -1) || target.startsWith(forbidden);
  return target === forbidden;
}

function validateProposalActions(fixture, proposal, ledgerIds, errors) {
  const actions = Array.isArray(proposal?.actions) ? proposal.actions : [];
  const actionIds = uniqueIds(actions, 'id', errors, 'Proposal action');
  if (!proposal?.projectSummary || !Array.isArray(proposal.unknowns) || !Array.isArray(proposal.warnings)) {
    error(errors, 'PROPOSAL', 'Proposal must show summary, unknowns, and warnings');
  }
  if (!Array.isArray(proposal?.nonGoals) || !Array.isArray(proposal?.validationPlan)) {
    error(errors, 'PROPOSAL', 'Proposal must show non-goals and a validation plan');
  }

  for (const action of actions) {
    if (!ACTIONS.has(action.action)) {
      error(errors, 'ACTION_VOCABULARY', `action ${action.id} uses ${action.action}`);
      continue;
    }
    if (typeof action.target !== 'string' || typeof action.reason !== 'string') {
      error(errors, 'PROPOSAL', `action ${action.id} requires exact target and reason`);
    }
    if (!Array.isArray(action.evidenceIds) || action.evidenceIds.length === 0) {
      error(errors, 'EVIDENCE', `action ${action.id} has no evidence`);
    }
    for (const id of action.evidenceIds ?? []) {
      if (!ledgerIds.has(id)) error(errors, 'EVIDENCE', `action ${action.id} references unknown evidence ${id}`);
    }

    if (action.action === 'CREATE') {
      if (typeof action.proposedContent !== 'string' || action.proposedContent.length === 0) {
        error(errors, 'PROPOSAL', `CREATE ${action.id} must show complete proposedContent`);
      }
      if (action.baselineFingerprint !== 'missing') {
        error(errors, 'FINGERPRINT', `CREATE ${action.id} baseline must be missing`);
      }
    } else if (action.action === 'UPDATE') {
      if (typeof action.proposedDiff !== 'string' || action.proposedDiff.length === 0) {
        error(errors, 'PROPOSAL', `UPDATE ${action.id} must show an exact proposedDiff`);
      }
      if (typeof action.baselineFingerprint !== 'string' || action.baselineFingerprint === 'missing') {
        error(errors, 'FINGERPRINT', `UPDATE ${action.id} requires an existing-target fingerprint`);
      }
    } else if (NON_WRITE_ACTIONS.has(action.action)) {
      if (typeof action.summary !== 'string' || action.summary.length === 0) {
        error(errors, 'PROPOSAL', `${action.action} ${action.id} requires a summary`);
      }
      if (action.proposedContent !== undefined || action.proposedDiff !== undefined) {
        error(errors, 'NON_WRITE_ACTION', `${action.action} ${action.id} must not carry write payload`);
      }
    }

    const expectedAction = (fixture.expected.allowedActions ?? []).find(
      (item) => item.action === action.action && item.target === action.target,
    );
    if (!expectedAction) {
      error(errors, 'FIXTURE_CONTRACT', `action is not allowed by fixture oracle: ${action.action} ${action.target}`);
    }
    if ((fixture.expected.forbiddenPaths ?? []).some((forbidden) => targetMatchesForbidden(action.target, forbidden))
      && WRITE_ACTIONS.has(action.action)) {
      error(errors, 'FORBIDDEN_BEHAVIOR', `fixture forbids writing ${action.target}`);
    }

    if (WRITE_ACTIONS.has(action.action)) {
      if (!allowedTargetForAction(action)) {
        error(errors, 'WRITE_SCOPE', `approved action kind/target is not writable in v0.1: ${action.kind} ${action.target}`);
      }
      if (!isLexicallySafeRelativePath(action.target)) {
        error(errors, 'WRITE_SCOPE', `write target is not a normalized repository-relative path: ${action.target}`);
      }
    }

    if (action.kind === 'guardrail') {
      if (action.action !== 'RECOMMEND') {
        error(errors, 'GUARDRAIL_WRITE', `guardrail ${action.id} must be RECOMMEND`);
      }
      for (const field of ['mechanism', 'impact', 'falsePositiveRisk']) {
        if (typeof action[field] !== 'string' || action[field].length === 0) {
          error(errors, 'GUARDRAIL', `guardrail ${action.id} requires ${field}`);
        }
      }
    }
    if (/hook|settings|permission/i.test(action.kind ?? '') || /(?:^|\/)\.github\//.test(action.target ?? '')) {
      if (WRITE_ACTIONS.has(action.action)) {
        error(errors, 'FORBIDDEN_BEHAVIOR', `Hook, settings, permission, and CI actions are recommendation-only: ${action.target}`);
      }
    }
    if (/refactor|move-class|business-module|production-rewrite/.test(action.kind ?? '')) {
      error(errors, 'ARCHITECTURE_REFACTOR', `architecture observation cannot become production refactoring: ${action.kind}`);
    }
  }
  return { actions, actionIds };
}

function validateApprovalAndWrites(fixture, run, phase, ledgerIds, errors) {
  const proposals = phase.events.filter((eventRecord) => eventRecord.type === 'proposal');
  const approvals = phase.events.filter((eventRecord) => eventRecord.type === 'approval');
  const writes = phase.events.filter((eventRecord) => eventRecord.type === 'write');
  const proposalByVersion = new Map();
  for (const proposal of proposals) {
    proposalByVersion.set(`${proposal.id}:${proposal.revision}`, proposal);
    validateProposalActions(fixture, proposal, ledgerIds, errors);
  }

  const approvalsByVersion = new Map();
  for (const approval of approvals) {
    const key = `${approval.proposalId}:${approval.revision}`;
    const proposal = proposalByVersion.get(key);
    if (!['approve', 'reject'].includes(approval.decision) || approval.scope !== 'exact-proposal') {
      error(errors, 'VAGUE_APPROVAL', 'decision must explicitly approve or reject the exact Proposal version');
    }
    if (!proposal) {
      error(errors, 'STALE_APPROVAL', `decision references missing Proposal version ${key}`);
    } else if (approval.proposalDigest !== digestProposal(proposal)) {
      error(errors, 'APPROVAL_PAYLOAD', `decision does not bind the exact Proposal payload for ${key}`);
    }
    if (!Array.isArray(approval.approvedActionIds)) {
      error(errors, 'APPROVAL_GATE', `decision ${key} must enumerate approved action IDs`);
    }
    if (approval.decision === 'reject' && (approval.approvedActionIds ?? []).length > 0) {
      error(errors, 'APPROVAL_GATE', `rejected Proposal ${key} cannot approve actions`);
    }
    approvalsByVersion.set(key, approval);
  }

  const approvedWriteIds = new Set();
  for (const [key, approval] of approvalsByVersion) {
    const proposal = proposalByVersion.get(key);
    if (!proposal || approval.decision !== 'approve') continue;
    const actions = new Map(proposal.actions.map((action) => [action.id, action]));
    for (const id of approval.approvedActionIds ?? []) {
      const action = actions.get(id);
      if (!action) {
        error(errors, 'APPROVAL_GATE', `approval ${key} names unknown action ${id}`);
      } else if (!WRITE_ACTIONS.has(action.action)) {
        error(errors, 'NON_WRITE_ACTION', `approval must not turn ${action.action} ${id} into a write`);
      } else {
        approvedWriteIds.add(`${key}:${id}`);
      }
    }
  }

  const observedWriteIds = new Set();
  for (const write of writes) {
    const key = `${write.proposalId}:${write.revision}`;
    const proposal = proposalByVersion.get(key);
    const approval = approvalsByVersion.get(key);
    const action = proposal?.actions?.find((item) => item.id === write.actionId);
    const writeIndex = phase.events.indexOf(write);
    const approvalIndex = phase.events.indexOf(approval);
    if (approvalIndex === -1 || approvalIndex >= writeIndex) {
      error(errors, 'APPROVAL_GATE', `write ${write.target} occurred before its exact approval`);
    }
    if (!proposal || !action || !approvedWriteIds.has(`${key}:${write.actionId}`)) {
      error(errors, 'UNAPPROVED_WRITE', `write ${write.target} is not an exact approved CREATE/UPDATE action`);
      continue;
    }
    const writeKey = `${key}:${write.actionId}`;
    if (observedWriteIds.has(writeKey)) {
      error(errors, 'DUPLICATE_WRITE', `approved action ${write.actionId} was written more than once`);
    }
    observedWriteIds.add(writeKey);
    if (write.target !== action.target) {
      error(errors, 'BLANKET_SCOPE', `action ${write.actionId} approved ${action.target}, not ${write.target}`);
    }
    if (write.observedBeforeFingerprint !== action.baselineFingerprint) {
      error(errors, 'FINGERPRINT_DRIFT', `target ${write.target} changed after Proposal approval`);
    }
    const laterProposal = phase.events.slice(approvalIndex + 1, writeIndex)
      .find((eventRecord) => eventRecord.type === 'proposal');
    if (laterProposal) {
      error(errors, 'STALE_APPROVAL', `Proposal revision after approval invalidated write ${write.target}`);
    }
  }

  for (const approvedWriteId of approvedWriteIds) {
    if (!observedWriteIds.has(approvedWriteId)) {
      error(errors, 'APPROVED_WRITE_MISSING', `approved action ${approvedWriteId} has no write event`);
    }
  }

  return {
    proposals,
    approvals,
    writes,
    proposalByVersion,
    approvedWriteIds,
    observedWriteIds,
  };
}

function deriveChangedPaths(fileStates, errors) {
  const baseline = isObject(fileStates?.baseline) ? fileStates.baseline : {};
  const final = isObject(fileStates?.final) ? fileStates.final : {};
  const allPaths = new Set([...Object.keys(baseline), ...Object.keys(final)]);
  const changed = [];
  for (const target of allPaths) {
    if (baseline[target]?.type === 'directory' || final[target]?.type === 'directory') continue;
    const before = baseline[target]?.fingerprint ?? 'missing';
    const after = final[target]?.fingerprint ?? 'missing';
    if (before !== after) changed.push(target);
  }
  if (!isObject(fileStates?.baseline) || !isObject(fileStates?.final)) {
    error(errors, 'FILE_STATES', 'run must include baseline and final file states');
  }
  return sorted(changed);
}

function validateGeneratedAssets(run, approvalState, errors) {
  const baseline = run.fileStates?.baseline ?? {};
  const final = run.fileStates?.final ?? {};
  for (const write of approvalState.writes) {
    const key = `${write.proposalId}:${write.revision}`;
    const action = approvalState.proposalByVersion.get(key)?.actions?.find((item) => item.id === write.actionId);
    if (!action) continue;
    const state = final[write.target];
    if (!state || state.fingerprint === 'missing') {
      error(errors, 'FINAL_STATE', `written target is absent from final state: ${write.target}`);
      continue;
    }

    let approvedContent = null;
    if (action.action === 'CREATE' && action.kind !== 'claude-skill-reference') {
      approvedContent = action.proposedContent;
    } else if (action.action === 'UPDATE') {
      const beforeContent = baseline[write.target]?.content;
      if (typeof beforeContent !== 'string') {
        error(errors, 'PAYLOAD_MISMATCH', `UPDATE ${write.target} requires baseline bytes`);
      } else {
        try {
          approvedContent = applyExactDiff(write.target, beforeContent, action.proposedDiff);
        } catch (cause) {
          error(errors, 'PAYLOAD_MISMATCH', `UPDATE ${write.target} diff is not exact: ${cause.message}`);
        }
      }
    }
    if (approvedContent !== null && state.content !== approvedContent) {
      error(errors, 'PAYLOAD_MISMATCH', `final bytes for ${write.target} do not match the approved payload`);
    }

    if (action.kind === 'agents') {
      const content = state.content ?? '';
      if (/^(?:\s*[│├└]|.*(?:controller|service|class|method) list)/im.test(content)) {
        error(errors, 'GLOBAL_CONTEXT', 'AGENTS.md contains discoverable inventory rather than minimal rules');
      }
    }
    if (action.kind === 'claude-adapter') {
      const content = state.content ?? '';
      if (!/^@AGENTS\.md(?:\n|$)/.test(content)) {
        error(errors, 'CLAUDE_ADAPTER', 'CLAUDE.md must import @AGENTS.md');
      }
      const agentsLines = new Set((final['AGENTS.md']?.content ?? '')
        .split('\n')
        .map(normalizeTextLine)
        .filter((line) => line.length >= 12));
      const duplicate = content
        .split('\n')
        .map(normalizeTextLine)
        .find((line) => line.length >= 12 && agentsLines.has(line));
      if (duplicate) error(errors, 'DUPLICATED_RULES', `CLAUDE.md duplicates a shared AGENTS.md rule: ${duplicate}`);
      const bodyBeyondAdapter = content.replace(/^@AGENTS\.md\s*/, '').trim();
      if (bodyBeyondAdapter.length > 0) {
        const ids = action.claudeSpecificEvidenceIds;
        if (!Array.isArray(ids) || ids.length === 0) {
          error(errors, 'CLAUDE_ADAPTER', 'Claude-specific content requires Claude-specific evidence');
        }
      }
    }
    if (action.kind === 'project-skill') {
      const content = state.content ?? '';
      const directory = action.target.split('/')[2];
      const isCanonicalSkill = action.target === `.agents/skills/${directory}/SKILL.md`;
      if (!isCanonicalSkill) {
        if (!content.trim()) {
          error(errors, 'PROJECT_REFERENCE', `Skill reference or script ${action.target} must contain content`);
        }
      } else {
        if (!new RegExp(`^---\\nname: ${directory}\\n`, 'm').test(content)) {
          error(errors, 'PROJECT_SKILL', `Skill metadata name must match directory ${directory}`);
        }
        for (const heading of ['When to use', 'When not to use', 'Workflow', 'Project-specific rules', 'Verification']) {
          if (!new RegExp(`^## ${heading}$`, 'm').test(content)) {
            error(errors, 'PROJECT_SKILL', `Skill ${directory} lacks ${heading}`);
          }
        }
        const verificationHeading = /^## Verification\s*$/m.exec(content);
        const verificationBody = verificationHeading
          ? content.slice(verificationHeading.index + verificationHeading[0].length)
            .split(/^##\s/m, 1)[0]
            .trim()
          : '';
        if (!verificationBody) {
          error(errors, 'PROJECT_SKILL', `Skill ${directory} requires observable Verification content`);
        }
      }
    }
    if (action.kind === 'claude-skill-reference') {
      const canonical = action.canonicalTarget;
      if (state.type === 'symlink') {
        const parent = path.posix.dirname(action.target);
        const resolved = path.posix.normalize(path.posix.join(parent, state.linkText));
        if (resolved !== canonical || state.linkText !== action.linkText) {
          error(errors, 'SINGLE_SOURCE', `Claude Skill reference does not resolve to ${canonical}`);
        }
      } else if (state.type === 'copy') {
        if (action.fallbackMode !== 'managed-copy' || action.proposedContent !== state.content) {
          error(errors, 'SINGLE_SOURCE', 'Claude managed-copy fallback was not exact and Proposal-visible');
        }
      } else {
        error(errors, 'SINGLE_SOURCE', 'Claude Skill target must be a relative symlink or explicit managed copy');
      }
    }
    if (action.kind === 'agent-doc' && !(state.content ?? '').trim()) {
      error(errors, 'ARCHITECTURE_DOC', `empty agent documentation is not allowed: ${action.target}`);
    }
  }
}

function validatePreservation(fixture, run, approvalState, errors) {
  const baseline = run.fileStates?.baseline ?? {};
  const final = run.fileStates?.final ?? {};
  const writtenTargets = new Set(approvalState.writes.map((write) => write.target));

  for (const item of fixture.expected.preservation ?? []) {
    const before = baseline[item.path];
    const after = final[item.path];
    if (!before || !after) {
      error(errors, 'PRESERVATION', `preserved target ${item.path} must exist in baseline and final state`);
      continue;
    }
    if (item.mode === 'exact' && (before.fingerprint !== after.fingerprint || before.content !== after.content)) {
      error(errors, 'CONFIG_OVERWRITE', `exact-preservation target changed: ${item.path}`);
    }
    if (item.mode === 'contains') {
      for (const text of item.requiredText ?? []) {
        if (!(after.content ?? '').includes(text)) {
          error(errors, 'CONFIG_OVERWRITE', `user content disappeared from ${item.path}: ${text}`);
        }
      }
      if (!preservesBaselineOrder(
        before.content ?? '',
        after.content ?? '',
        item.approvedRemovedLines ?? [],
      )) {
        error(errors, 'CONFIG_OVERWRITE', `existing prose, blank lines, or ordering changed in ${item.path}`);
      }
    }
  }

  for (const [target, before] of Object.entries(baseline)) {
    if (!writtenTargets.has(target) && final[target]
      && (before.fingerprint !== final[target].fingerprint || before.content !== final[target].content)) {
      error(errors, 'UNAPPROVED_REFORMAT', `unapproved existing target changed or was reformatted: ${target}`);
    }
  }
}

function validateFinalDelta(run, approvalState, errors) {
  const changedPaths = deriveChangedPaths(run.fileStates, errors);
  const writtenTargets = sorted(new Set(approvalState.writes.map((write) => write.target)));
  if (JSON.stringify(changedPaths) !== JSON.stringify(writtenTargets)) {
    error(errors, 'BLANKET_SCOPE', `actual changed paths differ from exact writes: ${changedPaths.join(', ')}`);
  }

  const validation = run.events.findLast((eventRecord) => eventRecord.type === 'validation');
  if (!validation?.passed) error(errors, 'VALIDATION', 'run did not record a passing validation');
  if (JSON.stringify(sorted(validation?.changedPaths ?? [])) !== JSON.stringify(changedPaths)) {
    error(errors, 'VALIDATION', 'validation changedPaths do not match recorded filesystem delta');
  }
  for (const field of ['preservationPassed', 'evidencePassed', 'singleSourcePassed', 'unknownsPreserved']) {
    if (validation?.[field] !== true) error(errors, 'VALIDATION', `validation did not prove ${field}`);
  }
  if ((validation?.forbiddenPathsChanged ?? []).length > 0) {
    error(errors, 'FORBIDDEN_BEHAVIOR', 'validation recorded forbidden path changes');
  }

  return changedPaths;
}

function validateReconcile(run, errors) {
  const reconcile = run.events.findLast((eventRecord) => eventRecord.type === 'reconcile');
  if (!reconcile || reconcile.mode !== 'dry-run') {
    error(errors, 'RECONCILE', 'second-run dry-run reconcile evidence is required');
    return;
  }
  if ((reconcile.writes ?? []).length > 0) {
    error(errors, 'IDEMPOTENCY', 'unchanged second run must have no writes');
  }
  const writeActions = (reconcile.proposalActions ?? []).filter((action) => WRITE_ACTIONS.has(action.action));
  if (writeActions.length > 0) {
    error(errors, 'IDEMPOTENCY', 'unchanged second run must have no CREATE or UPDATE actions');
  }
}

function validateExternalAcceptance(run, errors) {
  const requiredArtifactFields = [
    'name',
    'harness',
    'harnessVersion',
    'freshSessionId',
    'discoveryOutput',
    'invocationTranscript',
    'beforeDigest',
    'afterDigest',
    'proposal',
    'exactApproval',
    'validation',
  ];
  for (const harness of ['claudeCode', 'codex']) {
    const record = run.externalAcceptance?.[harness];
    if (!record || !['not-run', 'recorded-external'].includes(record.status)) {
      error(errors, 'EXTERNAL_ACCEPTANCE', `${harness} must be not-run or provide structured external evidence`);
      continue;
    }
    if (record.status === 'not-run') {
      if (record.evidence !== null) {
        error(errors, 'EXTERNAL_ACCEPTANCE', `${harness} not-run status must not claim evidence`);
      }
      continue;
    }
    if (!isObject(record.evidence)) {
      error(errors, 'EXTERNAL_ACCEPTANCE', `${harness} recorded-external evidence must be a structured artifact`);
      continue;
    }
    for (const field of requiredArtifactFields) {
      const value = record.evidence[field];
      if (value === undefined || value === null || value === '') {
        error(errors, 'EXTERNAL_ACCEPTANCE', `${harness} evidence requires ${field}`);
      }
    }
    const expectedHarness = harness === 'claudeCode' ? 'Claude Code' : 'Codex';
    if (record.evidence.harness !== expectedHarness) {
      error(errors, 'EXTERNAL_ACCEPTANCE', `${harness} evidence names the wrong Harness`);
    }
    if (!isObject(record.evidence.proposal) || !isObject(record.evidence.exactApproval)
      || !isObject(record.evidence.validation)) {
      error(errors, 'EXTERNAL_ACCEPTANCE', `${harness} proposal, exact approval, and validation must be structured`);
    }
    if (!/^tree-sha256:[a-f0-9]{64}$/.test(record.evidence.beforeDigest ?? '')
      || !/^tree-sha256:[a-f0-9]{64}$/.test(record.evidence.afterDigest ?? '')) {
      error(errors, 'EXTERNAL_ACCEPTANCE', `${harness} before/after digests must be named SHA-256 tree evidence`);
    }
  }
}

export async function evaluateRunRecord(fixture, run, options = {}) {
  const errors = validateFixtureManifest(fixture);
  if (!isObject(run)) {
    return {
      ok: false,
      errors: [...errors, 'SCHEMA: run record must be an object'],
      claims: {
        localContractValidated: false,
        liveSkillBehaviorProven: false,
        claudeCodeBehaviorProven: false,
        codexBehaviorProven: false,
      },
    };
  }
  if (run.schemaVersion !== 1) error(errors, 'SCHEMA', 'run schemaVersion must be 1');
  if (run.fixtureId !== fixture.id) error(errors, 'SCHEMA', 'run fixtureId does not match fixture');
  if (run.harness !== 'recorded-contract') {
    error(errors, 'CLAIM_BOUNDARY', 'local evaluator accepts only recorded-contract artifacts');
  }

  const evidenceState = validateEvidenceLedger(fixture, run, errors);
  const phase = validatePhaseEvents(fixture, run, errors);
  validateFactsAgainstEvidence(phase.profile, evidenceState.ledger, errors);
  const approvalState = validateApprovalAndWrites(fixture, run, phase, evidenceState.ledgerIds, errors);

  let physicalFileStates = null;
  const hasWrites = approvalState.writes.length > 0 || approvalState.approvedWriteIds.size > 0;
  const requiredRoots = ['initialRoot', 'proposalRoot', 'preWriteRoot', 'finalRoot'];
  if (hasWrites && requiredRoots.some((field) => typeof options[field] !== 'string')) {
    error(errors, 'PHYSICAL_EVIDENCE', `writable run requires ${requiredRoots.join(', ')}`);
  } else if (requiredRoots.every((field) => typeof options[field] === 'string')) {
    try {
      const initialDigest = await fingerprintRepository(options.initialRoot);
      const proposalDigest = await fingerprintRepository(options.proposalRoot);
      if (phase.events.find((eventRecord) => eventRecord.type === 'preflight')?.repositoryFingerprintBefore !== initialDigest
        || phase.events.find((eventRecord) => eventRecord.type === 'explore')?.repositoryFingerprintAfter !== proposalDigest) {
        error(errors, 'READ_ONLY', 'recorded Preflight/Explore fingerprints do not match physical repositories');
      }
      if (initialDigest !== proposalDigest) {
        error(errors, 'READ_ONLY', 'physical repository changed during Preflight or Explore');
      }
      physicalFileStates = {
        baseline: await snapshotRepository(options.proposalRoot),
        preWrite: await snapshotRepository(options.preWriteRoot),
        final: await snapshotRepository(options.finalRoot),
      };
      run = { ...run, fileStates: { baseline: physicalFileStates.baseline, final: physicalFileStates.final } };
    } catch (cause) {
      error(errors, 'PHYSICAL_EVIDENCE', cause.message);
    }
  }

  for (const proposal of approvalState.proposals) {
    for (const action of proposal.actions ?? []) {
      if (!WRITE_ACTIONS.has(action.action) || !physicalFileStates) continue;
      const computed = physicalFileStates.baseline[action.target]?.fingerprint ?? 'missing';
      if (action.baselineFingerprint !== computed) {
        error(errors, 'FINGERPRINT', `Proposal baseline for ${action.target} was not computed from the physical target`);
      }
      errors.push(...await validateWriteTargetPhysicalScope(options.preWriteRoot, action.target));
    }
  }

  for (const write of approvalState.writes) {
    const physicalBeforeFingerprint = physicalFileStates?.preWrite?.[write.target]?.fingerprint ?? 'missing';
    if (physicalBeforeFingerprint !== write.observedBeforeFingerprint) {
      error(errors, 'FINGERPRINT_DRIFT', `write observation for ${write.target} does not match physical pre-write state`);
    }
    const key = `${write.proposalId}:${write.revision}`;
    const action = approvalState.proposalByVersion.get(key)?.actions?.find((item) => item.id === write.actionId);
    if (action && physicalBeforeFingerprint !== action.baselineFingerprint) {
      error(errors, 'FINGERPRINT_DRIFT', `physical target ${write.target} changed after Proposal approval`);
    }
  }

  validateGeneratedAssets(run, approvalState, errors);
  validatePreservation(fixture, run, approvalState, errors);
  validateFinalDelta(run, approvalState, errors);
  validateReconcile(run, errors);
  validateExternalAcceptance(run, errors);

  return {
    ok: errors.length === 0,
    errors,
    claims: {
      localContractValidated: errors.length === 0,
      recordedArtifactValidated: errors.length === 0,
      liveSkillBehaviorProven: false,
      claudeCodeBehaviorProven: false,
      codexBehaviorProven: false,
    },
  };
}
