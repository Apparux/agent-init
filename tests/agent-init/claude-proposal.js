import { createHash } from 'node:crypto';
import path from 'node:path';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { privateClaudeReference, sensitiveClaudeField, sensitiveClaudeText } from './claude-input-policy.js';
import { digestProposal, fingerprintPath, renderExactDiff, validateWriteTargetPhysicalScope } from './evaluation-harness.js';

function stop(code) {
  throw Object.assign(new Error(code), { code });
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function decodeJson(input, code, secrets, limit, privateDecision = false) {
  if (!text(input)) stop(code);
  if (Buffer.byteLength(input) > limit) stop('PROPOSAL_INPUT_LIMIT');
  // Inspect even shadowed JSON members before JSON.parse discards them.
  let literals = 0;
  for (const match of input.matchAll(/"(?:[^"\\]|\\.)*"/g)) {
    if (++literals > 10000) stop('PROPOSAL_INPUT_LIMIT');
    let value;
    try { value = JSON.parse(match[0]); }
    catch (cause) { if (cause instanceof SyntaxError) stop(code); throw cause; }
    if (secrets.some((secret) => secret && value.includes(secret))) stop('SECRET_TRACE');
    if (privateDecision) {
      const isKey = /^\s*:/.test(input.slice(match.index + match[0].length));
      if ((isKey && sensitiveClaudeField(value)) || sensitiveClaudeText(value) || privateClaudeReference(value)) stop('PROPOSAL_PRIVATE');
    }
  }
  let decoded;
  try { decoded = JSON.parse(input); }
  catch (cause) { if (cause instanceof SyntaxError) stop(code); throw cause; }
  const pending = [{ value: decoded, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const { value, depth } = pending.pop();
    if (++nodes > 10000 || depth > 64) stop('PROPOSAL_INPUT_LIMIT');
    if (typeof value === 'string' && secrets.some((secret) => secret && value.includes(secret))) stop('SECRET_TRACE');
    if (typeof value === 'number' && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) stop(code);
    if (value && typeof value === 'object') {
      const entries = Object.entries(value);
      if (nodes + pending.length + entries.length > 10000) stop('PROPOSAL_INPUT_LIMIT');
      for (const [key, child] of entries) pending.push({ value: key, depth: depth + 1 }, { value: child, depth: depth + 1 });
    }
  }
  return decoded;
}

function contentFromExactDiff(target, before, diff) {
  if (!text(diff)) stop('PROPOSAL_DIFF');
  const lines = diff.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines[0] !== `--- a/${target}` || lines[1] !== `+++ b/${target}`
    || !/^@@ -1,[0-9]+ \+1,[0-9]+ @@$/.test(lines[2] ?? '')
    || lines.slice(3).some((line) => !line.startsWith('-') && !line.startsWith('+'))) stop('PROPOSAL_DIFF');
  const added = lines.slice(3).filter((line) => line.startsWith('+')).map((line) => line.slice(1));
  const after = added.length ? `${added.join('\n')}\n` : '';
  if (renderExactDiff(target, before, after) !== diff) stop('PROPOSAL_DIFF');
  return after;
}

const writableTargets = {
  agents: /^AGENTS\.md$/,
  'claude-adapter': /^CLAUDE\.md$/,
  'project-skill': /^\.agents\/skills\/[a-z0-9]+(?:-[a-z0-9]+)*\/(?:SKILL\.md|references\/[^/]+|scripts\/[^/]+)$/,
  'claude-skill-reference': /^\.claude\/skills\/[a-z0-9]+(?:-[a-z0-9]+)*$/,
  'agent-doc': /^docs\/agents\/[a-z0-9][a-z0-9.-]*\.md$/,
};

// JSON response data is not a selected-Skill observation or an execution log.
export async function captureClaudeProposal(processResult, context) {
  if (processResult.spawnError) stop('PROCESS_UNAVAILABLE');
  if (processResult.cleanupError) stop('PROCESS_CLEANUP_FAILED');
  if (processResult.timedOut) stop('PROCESS_TIMEOUT');
  if (processResult.truncated) stop('TRACE_TRUNCATED');
  if (processResult.stopReason) stop('PROCESS_STOPPED');
  if (processResult.signal) stop('PROCESS_INTERRUPTED');
  if (processResult.status !== 0) stop('PROCESS_FAILED');
  const secrets = context.secrets ?? [];
  const envelope = decodeJson(processResult.stdout, 'PROPOSAL_ENVELOPE', secrets, 8 * 1024 * 1024);
  if (!object(envelope) || envelope.type !== 'result') stop('PROPOSAL_ENVELOPE');
  if (envelope.session_id !== context.sessionId) stop('SESSION_MISMATCH');
  if (envelope.subtype !== 'success' || envelope.is_error !== false) stop('SESSION_FAILED');
  if (!Array.isArray(envelope.permission_denials)) stop('PROPOSAL_ENVELOPE');
  if (envelope.permission_denials.length) stop('PERMISSION_DENIED');
  const output = context.decisionFormat === 'json-result'
    ? decodeJson(envelope.result, 'PROPOSAL_RESULT', secrets, 2 * 1024 * 1024)
    : envelope.structured_output;
  if (!object(output) || Object.keys(output).length !== 1 || !text(output.decisionRecordJson)) stop('PROPOSAL_MISSING');
  const decisionRecord = decodeJson(output.decisionRecordJson, 'PROPOSAL_MALFORMED', secrets, 1024 * 1024, true);
  if (!object(decisionRecord) || Object.keys(decisionRecord).some((key) => !['events', 'evidenceLedger'].includes(key))
    || !Array.isArray(decisionRecord.evidenceLedger) || !Array.isArray(decisionRecord.events)
    || decisionRecord.events.length !== 4
    || decisionRecord.events.some((event, index) => event?.type !== ['profile', 'classify', 'skills', 'proposal'][index])) stop('PROPOSAL_SEQUENCE');
  const [profile, classify, skills, proposal] = decisionRecord.events;
  if (!Array.isArray(profile.facts) || !Array.isArray(profile.unknowns) || !Array.isArray(classify.decisions)
    || !Array.isArray(skills.candidates) || !text(proposal.id) || !Number.isSafeInteger(proposal.revision) || proposal.revision < 1
    || !text(proposal.projectSummary) || !['unknowns', 'warnings', 'nonGoals', 'validationPlan', 'actions'].every((key) => Array.isArray(proposal[key]))) stop('PROPOSAL_INCOMPLETE');
  const ledgerIds = new Set();
  for (const record of decisionRecord.evidenceLedger) {
    if (!object(record) || !['id', 'fact', 'sourcePath', 'sourceLocation', 'observation', 'whyItMatters'].every((key) => text(record[key]))
      || ledgerIds.has(record.id)) stop('PROPOSAL_EVIDENCE');
    ledgerIds.add(record.id);
    if ((await validateWriteTargetPhysicalScope(context.cwd, record.sourcePath)).length) stop('PROPOSAL_PATH_SCOPE');
  }
  const factIds = new Set();
  for (const fact of profile.facts) {
    if (!object(fact) || !text(fact.id) || factIds.has(fact.id) || !['confirmed', 'unknown', 'conflicting'].includes(fact.status)
      || (fact.status === 'confirmed' && (!Array.isArray(fact.evidenceIds) || !fact.evidenceIds.length))
      || (fact.evidenceIds !== undefined && (!Array.isArray(fact.evidenceIds) || fact.evidenceIds.some((id) => !ledgerIds.has(id))))) stop('PROPOSAL_INCOMPLETE');
    factIds.add(fact.id);
  }
  if ([...profile.unknowns, ...proposal.unknowns].some((unknown) => !text(unknown) && (!object(unknown) || !text(unknown.id)))
    || [...proposal.warnings, ...proposal.nonGoals, ...proposal.validationPlan].some((value) => !text(value))) stop('PROPOSAL_INCOMPLETE');
  const classifiedIds = new Set();
  for (const decision of classify.decisions) {
    if (!object(decision) || !factIds.has(decision.factId) || classifiedIds.has(decision.factId)
      || !['GLOBAL', 'WORKFLOW', 'DISCOVERABLE', 'ARCHITECTURE', 'NONE'].includes(decision.persistenceScope)
      || typeof decision.deterministicEnforcementCandidate !== 'boolean') stop('PROPOSAL_INCOMPLETE');
    classifiedIds.add(decision.factId);
  }
  const candidateNames = new Set();
  for (const candidate of skills.candidates) {
    if (!object(candidate) || typeof candidate.name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(candidate.name)
      || candidateNames.has(candidate.name) || !['CREATE', 'UPDATE', 'KEEP', 'SKIP'].includes(candidate.decision)) stop('PROPOSAL_INCOMPLETE');
    candidateNames.add(candidate.name);
    if (['CREATE', 'UPDATE'].includes(candidate.decision)
      && ['taskTriggers', 'workflowSteps', 'verification', 'evidenceIds'].some((key) => !Array.isArray(candidate[key]) || !candidate[key].length)) stop('PROPOSAL_INCOMPLETE');
    for (const key of ['taskTriggers', 'workflowSteps', 'verification', 'evidenceIds']) {
      if (candidate[key] !== undefined && (!Array.isArray(candidate[key]) || candidate[key].some((value) => !text(value)
        || (key === 'evidenceIds' && !ledgerIds.has(value))))) stop('PROPOSAL_INCOMPLETE');
    }
  }
  const actionIds = new Set();
  for (const action of proposal.actions) {
    if (!object(action) || !['id', 'target', 'kind', 'reason'].every((key) => text(action[key])) || actionIds.has(action.id)
      || !['CREATE', 'UPDATE', 'KEEP', 'SKIP', 'RECOMMEND'].includes(action.action)
      || !Array.isArray(action.evidenceIds) || !action.evidenceIds.length || action.evidenceIds.some((id) => !ledgerIds.has(id))) stop('PROPOSAL_INCOMPLETE');
    actionIds.add(action.id);
    if (['CREATE', 'UPDATE'].includes(action.action)) {
      if ((await validateWriteTargetPhysicalScope(context.cwd, action.target)).length) stop('PROPOSAL_PATH_SCOPE');
      if (!Object.hasOwn(writableTargets, action.kind) || !writableTargets[action.kind].test(action.target)
        || (action.kind === 'agent-doc' && action.knowledgeScope !== 'ARCHITECTURE')) stop('PROPOSAL_WRITE_SCOPE');
      const baseline = await fingerprintPath(context.cwd, action.target);
      if (action.baselineFingerprint !== baseline || (action.action === 'CREATE') !== (baseline === 'missing')) stop('PROPOSAL_BASELINE');
      if (action.kind === 'claude-skill-reference') {
        const name = action.target.split('/').at(-1);
        const canonical = `.agents/skills/${name}`;
        if ((await validateWriteTargetPhysicalScope(context.cwd, canonical)).length) stop('PROPOSAL_REFERENCE');
        const link = path.posix.relative(path.posix.dirname(action.target), canonical);
        if (action.linkTarget !== link || (action.proposedContent !== undefined && action.proposedContent !== link)) stop('PROPOSAL_REFERENCE');
      } else if (action.action === 'UPDATE') {
        if (action.linkTarget !== undefined) stop('PROPOSAL_REFERENCE');
        const before = await readFile(path.join(context.cwd, action.target), 'utf8');
        const after = contentFromExactDiff(action.target, before, action.proposedDiff);
        if (action.proposedContent !== undefined && action.proposedContent !== after) stop('PROPOSAL_DIFF');
      } else if (!text(action.proposedContent) || action.linkTarget !== undefined) stop('PROPOSAL_INCOMPLETE');
    } else {
      if (action.proposedContent !== undefined || action.proposedDiff !== undefined || action.linkTarget !== undefined) stop('PROPOSAL_NON_WRITE_PAYLOAD');
      if (!text(action.summary)) stop('PROPOSAL_INCOMPLETE');
      try {
        // fingerprintPath checks lexical paths and ancestors without rejecting a
        // non-writing terminal symlink. Check its physical destination separately.
        const baseline = await fingerprintPath(context.cwd, action.target);
        if (action.action === 'KEEP' && baseline === 'missing') stop('PROPOSAL_BASELINE');
        if (baseline !== 'missing' && (await lstat(path.join(context.cwd, action.target))).isSymbolicLink()) {
          const relative = path.relative(await realpath(context.cwd), await realpath(path.join(context.cwd, action.target)));
          if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) stop('PROPOSAL_PATH_SCOPE');
        }
      } catch { stop('PROPOSAL_PATH_SCOPE'); }
    }
  }
  return { captureStatus: 'captured', decisionRecord, proposal, proposalDigest: digestProposal(proposal),
    applySupported: false, consumerValidated: false, validationScope: 'decision-shape-write-policy-baselines-and-physical-paths-only',
    provenance: { source: context.decisionFormat === 'json-result' ? 'cli-json-result-decision-data' : 'cli-json-structured-output',
      sessionId: context.sessionId, harnessVersion: context.harnessVersion,
      responseDigest: `sha256:${createHash('sha256').update(processResult.stdout).digest('hex')}`,
      responseBytes: Buffer.byteLength(processResult.stdout), selectionProtocolVerified: false, phaseExecutionProven: false,
      readObservationAvailable: false, retryMonitoringAvailable: false, writeObservationAvailable: false,
      contextIsolationProven: false, skillDiscoveryProven: false } };
}

// Caller-defined decision data, not a native Claude event or Skill protocol.
// The documented JSON CLI envelope exposes this under structured_output.
export const claudeProposalSchema = {
  type: 'object',
  properties: { decisionRecordJson: { type: 'string', description: 'JSON-encoded evidence ledger and Profile/Classify/Skills/Proposal decisions; no approval or execution claims.' } },
  required: ['decisionRecordJson'],
  additionalProperties: false,
};

export const claudeProposalPrompt = `/agent-init
Present the complete unapproved Proposal only. Do not apply, write files, run commands, deploy, migrate, access staging, or request approval through tools.
Use only this disposable repository and the installed mother Skill. Do not read parent directories or authentication/configuration files.
Return decisionRecordJson containing a JSON object with evidenceLedger and events. This is caller-defined normalized decision data, not native Harness events or proof of phase execution.
Events must be exactly Profile, Classify, Skills and one complete Proposal, using type values profile, classify, skills, proposal in that order.
Profile includes facts and unknowns; Classify includes decisions; Skills includes candidates. The Proposal includes id, revision, projectSummary, unknowns, warnings, nonGoals, validationPlan, and actions.
Each action includes id, action (CREATE/UPDATE/KEEP/SKIP/RECOMMEND), target, kind, reason and evidenceIds. CREATE includes complete proposedContent, or a relative linkTarget for a Claude Skill reference. UPDATE requires exact proposedDiff: headers --- a/target, +++ b/target, one @@ -1,old-count +1,new-count @@ hunk, all removed lines prefixed -, then all added lines prefixed +. Do not substitute an UPDATE content summary. KEEP/SKIP/RECOMMEND includes summary and no write payload.
Use repository-relative paths only, including in content and evidence. Each evidence-ledger entry includes id, fact, sourcePath, sourceLocation, sourceExcerpt, observation, whyItMatters, persistenceScope, and the independent Boolean deterministicEnforcementCandidate. sourceExcerpt must be an exact nonempty substring of the cited repository source content, never a paraphrase or a presence-only file. Each confirmed Profile fact has value and evidenceIds; every scalar or nested leaf of value must be literally supported by its cited excerpts. Keep unsupported versions, commands and other facts unknown rather than inventing them.
Each Skill candidate includes evidenceIds, skillAssessment (qualitative taskSpecificity, rediscoveryCost, errorCost, reuseFrequency), and targetedFollowUpSearch (bounded queries, paths, result, evidenceIds). CREATE/UPDATE candidates also include taskTriggers, workflowSteps, verification, whenNotToUse and routing (description, positiveIntents, negativeIntents); each verification command must occur literally in cited excerpts. A project-skill write includes skillCandidate equal to its complete candidate. New writable numeric/version assertions must match complete tokens in that action's cited excerpts, not substrings, labels or unrelated evidence; executable assertions must quote the actual source command (prefer backticks). Preserve existing UPDATE prose in its original order and context. Moving/duplicating a legacy numeric or executable assertion, or retaining one under changed preceding instructions, is unsupported by this bounded validator: report that limitation rather than silently treating it as unchanged. SKIP includes skipBasis with dimensions and explanation quoting relevant sourceExcerpt; a stack label alone is not a workflow. CLAUDE.md is only the thin @AGENTS.md adapter, not a second source of instructions.
For a Claude Skill reference include canonicalTarget (.agents/skills/name), linkText and linkTarget (the same relative ../../.agents/skills/name text), with that link text as proposedContent. Include parentDirectories: the exact necessary missing parents in order (.claude, then .claude/skills), excluding existing directories or parents created by earlier approved actions; use [] if none. These displayed effects authorize only single mkdir operations with mode 0755 followed by the relative symlink, never force, overwrite, chaining or arbitrary Bash. Do not include credentials, private configuration, absolute paths, approval, write, validation or reconcile events.
The decision data cannot establish Skill selection or human approval. Do not claim either.`;
