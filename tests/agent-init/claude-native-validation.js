import { createHash } from 'node:crypto';
import path from 'node:path';
import { lstat, readlink, realpath } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { readRegularFileNoFollow } from '../../src/installation/filesystem.js';
import { fingerprintPath, renderExactDiff, validateWriteTargetPhysicalScope } from './evaluation-harness.js';
import { snapshotContext } from './claude-protocol.js';

const digest = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const text = value => typeof value === 'string' && value.trim().length > 0;
const list = value => Array.isArray(value) && value.length > 0 && value.every(text);
const scopes = ['GLOBAL', 'WORKFLOW', 'DISCOVERABLE', 'ARCHITECTURE', 'NONE'];
const writing = action => ['CREATE', 'UPDATE'].includes(action);

function literalLeaves(value, depth = 0) {
  if (depth > 64) return [null];
  if (text(value) || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return [String(value)];
  if (value && typeof value === 'object') {
    const children = Object.values(value);
    return children.length ? children.flatMap(child => literalLeaves(child, depth + 1)) : [null];
  }
  return [null];
}

function approvedContent(action, sources) {
  if (action.action !== 'UPDATE' || action.kind === 'claude-skill-reference') return action.proposedContent;
  const baseline = sources.get(action.target);
  if (typeof baseline?.content !== 'string' || baseline.fingerprint !== action.baselineFingerprint
    || digest(baseline.content) !== action.baselineFingerprint || typeof action.proposedDiff !== 'string') return null;
  const lines = action.proposedDiff.split('\n').slice(3);
  if (lines.at(-1) === '') lines.pop();
  const added = lines.filter(line => line.startsWith('+')).map(line => line.slice(1));
  const after = added.length ? `${added.join('\n')}\n` : '';
  return renderExactDiff(action.target, baseline.content, after) === action.proposedDiff
    && (action.proposedContent === undefined || action.proposedContent === after) ? after : null;
}

const executable = String.raw`(?:\./[\w./-]+|[\w.-]+/[\w./-]+\.(?:sh|bash|py|js)|npm|pnpm|yarn|node|mvn|gradle|python[0-9]?|pip[0-9]?|go|cargo|make|docker|kubectl|bash|sh|git|npx|bun|curl|rm|cp|mv|ln|chmod|mkdir|psql|sqlite3|mongosh|ssh|rsync|terraform)`;

function assertions(content) {
  const input = (content ?? '').replace(/^\s*\d+[.)]\s+/gm, '');
  const numbers = [...input.matchAll(/(?<![\d.])\d+(?:\.\d+)*(?:[-+][a-zA-Z][a-zA-Z0-9.-]*)?(?!\d|\.\d)/g)].map(match => match[0]);
  const commands = [];
  const wholeExecutable = new RegExp(`^${executable}[.;]?$`);
  for (const match of input.matchAll(/`([^`\n]+)`|"([^"\n]+)"|'([^'\n]+)'/g)) {
    const quoted = (match[1] ?? match[2] ?? match[3]).trim();
    if ((match[1] && /\s/.test(quoted)) || new RegExp(`^${executable}(?:[ \\t]|$)`).test(quoted) || wholeExecutable.test(quoted)) commands.push(quoted);
  }
  for (const block of input.matchAll(/```[^\n]*\n([\s\S]*?)\n```/g)) commands.push(...block[1].split('\n').map(line => line.trim()).filter(text));
  for (const match of input.matchAll(new RegExp(String.raw`(?<![\w/.-])${executable}[ \t]+[^\x60\n]+`, 'g'))) commands.push(match[0].replace(/[.,; \t]+$/, ''));
  for (const pattern of [String.raw`\b(?:[Rr]un|[Ee]xecute|[Vv]erification:)[ \t]+(${executable})(?=[.; \t]*(?:\n|$))`,
    String.raw`^[ \t]*(${executable})[.; \t]*$`]) {
    for (const match of input.matchAll(new RegExp(pattern, 'gm'))) commands.push(match[1].replace(/[.;]+$/, ''));
  }
  return { numbers, commands };
}

function groundedAssertions(content, excerpts) {
  const claims = assertions(content);
  const sourceClaims = excerpts.map(assertions);
  const numbers = new Set(sourceClaims.flatMap(source => source.numbers));
  const commands = new Set(sourceClaims.flatMap(source => source.commands));
  return claims.numbers.every(value => numbers.has(value)) && claims.commands.every(command => commands.has(command));
}

function introducedContent(action, content, sources) {
  if (action.action !== 'UPDATE') return content;
  const before = sources.get(action.target)?.content;
  if (typeof before !== 'string' || typeof content !== 'string') return null;
  const oldLines = before.split('\n');
  const newLines = content.split('\n');
  let count = 0;
  while (count < oldLines.length && oldLines[count] === newLines[count]) count++;
  // Only the exact common prefix is unchanged. A moved/duplicated assertion,
  // or one under changed preceding instructions, needs unsupported semantic review.
  const added = newLines.slice(count);
  if (added.some(line => oldLines.includes(line) && (assertions(line).numbers.length || assertions(line).commands.length))) return null;
  return added.join('\n');
}

function scalar(value) {
  try {
    if (value.startsWith('"')) return JSON.parse(value);
    if (/^'(?:[^']|'')*'$/.test(value)) return value.slice(1, -1).replaceAll("''", "'");
    return value;
  } catch { return null; }
}

function skillPayload(content, candidate) {
  const metadata = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(content ?? '');
  const lines = metadata?.[1].split(/\r?\n/) ?? [];
  if (lines.length !== 2 || lines.some(line => !/^(name|description): .+$/.test(line))) return false;
  const entries = lines.map(line => [line.split(':')[0], scalar(line.slice(line.indexOf(':') + 2))]);
  const fields = Object.fromEntries(entries);
  if (new Set(entries.map(([key]) => key)).size !== 2 || fields.name !== candidate?.name || fields.description !== candidate?.routing?.description) return false;
  const body = content.slice(metadata[0].length);
  for (const [heading, values] of [['When to use', candidate.taskTriggers], ['When not to use', candidate.whenNotToUse],
    ['Workflow', candidate.workflowSteps], ['Project-specific rules', []], ['Verification', candidate.verification]]) {
    const section = body.split(`## ${heading}\n`)[1]?.split(/^## /m)[0]?.trim();
    if (!section || (values ?? []).some(value => !section.includes(value))) return false;
  }
  return true;
}

async function exactFinalEffects(cwd, inventory, writes) {
  if (!Array.isArray(inventory) || !inventory.length || new Set(inventory.map(entry => entry.path)).size !== inventory.length) return false;
  const before = new Map(inventory.map(entry => [entry.path, entry]));
  const after = new Map((await snapshotContext(cwd)).map(entry => [entry.path, entry]));
  const targets = new Map(writes.map(action => [action.target, action]));
  const parents = new Set(['.']);
  for (const action of writes) {
    const parts = action.target.split('/');
    for (let count = 1; count < parts.length; count++) parents.add(parts.slice(0, count).join('/'));
  }
  for (const target of new Set([...before.keys(), ...after.keys()])) {
    const prior = before.get(target);
    const current = after.get(target);
    if (targets.has(target)) {
      if (targets.get(target).kind !== 'claude-skill-reference' && current?.mode !== (prior?.mode ?? 0o644)) return false;
    } else if (parents.has(target) && current?.type === 'directory') {
      if (prior ? !isDeepStrictEqual({ ...prior, mtimeMs: 0 }, { ...current, mtimeMs: 0 }) : current.mode !== 0o755) return false;
    } else if (!isDeepStrictEqual(prior, current)) return false;
  }
  return true;
}

// Owned source anchors, not fixture answers or proof of live Skill behavior.
export async function validateClaudeNativeSetup({ captured, cwd, repositoryInput, phase, completed }) {
  const errors = [];
  const citationDigests = [];
  const fail = code => errors.push(code);
  if (captured?.captureStatus !== 'captured' || !['proposal', 'final'].includes(phase)
    || repositoryInput?.source !== 'owned-repository-snapshot' || !Array.isArray(repositoryInput.files)) fail('NATIVE_VALIDATION_INPUT');
  else {
    const sources = new Map();
    const writes = captured.proposal.actions.filter(action => writing(action.action));
    const writtenTargets = new Set(writes.map(action => action.target));
    for (const [index, file] of repositoryInput.files.entries()) {
      if (sources.has(file.path) || !/^sha256:[a-f0-9]{64}$/.test(file.fingerprint ?? '')) fail(`NATIVE_SOURCE_SNAPSHOT[${index}]`);
      sources.set(file.path, file);
      if (typeof file.content === 'string' && digest(file.content) !== file.fingerprint) fail(`NATIVE_SOURCE_DRIFT[${index}]`);
      if (phase === 'final' && writtenTargets.has(file.path)) continue;
      try {
        if ((await validateWriteTargetPhysicalScope(cwd, file.path)).length) { fail(`NATIVE_SOURCE_SCOPE[${index}]`); continue; }
        if (await fingerprintPath(cwd, file.path) !== file.fingerprint
          || typeof file.content === 'string' && !(await readRegularFileNoFollow(path.join(cwd, file.path))).equals(Buffer.from(file.content))) fail(`NATIVE_SOURCE_DRIFT[${index}]`);
      } catch { fail(`NATIVE_SOURCE_SCOPE[${index}]`); }
    }
    for (const [index, evidence] of captured.decisionRecord.evidenceLedger.entries()) {
      const file = sources.get(evidence.sourcePath);
      if (!file || file.presenceOnly || file.binary || !text(file.content) || !text(evidence.sourceExcerpt)
        || !file.content.includes(evidence.sourceExcerpt)) { fail(`NATIVE_SOURCE_EXCERPT[${index}]`); continue; }
      citationDigests.push({ evidenceIndex: index, sourceDigest: file.fingerprint, excerptDigest: digest(evidence.sourceExcerpt) });
    }
    const ledger = new Map(captured.decisionRecord.evidenceLedger.map(evidence => [evidence.id, evidence]));
    const decisions = new Map(captured.decisionRecord.events[1].decisions.map(decision => [decision.factId, decision]));
    for (const [index, fact] of captured.decisionRecord.events[0].facts.entries()) {
      const decision = decisions.get(fact.id);
      if (!decision || !scopes.includes(decision.persistenceScope) || typeof decision.deterministicEnforcementCandidate !== 'boolean'
        || decision.evidenceIds !== undefined && (!list(decision.evidenceIds)
          || [...new Set(decision.evidenceIds)].sort().join('\0') !== [...new Set(fact.evidenceIds ?? [])].sort().join('\0'))
        || (fact.evidenceIds ?? []).some(id => ledger.get(id)?.persistenceScope !== decision.persistenceScope
          || ledger.get(id)?.deterministicEnforcementCandidate !== decision.deterministicEnforcementCandidate)) fail(`NATIVE_CLASSIFY[${index}]`);
      if (fact.status !== 'confirmed') continue;
      const excerpts = (fact.evidenceIds ?? []).map(id => ledger.get(id)?.sourceExcerpt).filter(text);
      if (literalLeaves(fact.value).some(value => !value || !excerpts.some(excerpt => excerpt.includes(value))
        || !groundedAssertions(value, excerpts))) fail(`NATIVE_FACT_LITERAL[${index}]`);
    }
    for (const [index, candidate] of captured.decisionRecord.events[2].candidates.entries()) {
      const ids = candidate.evidenceIds;
      const followup = candidate.targetedFollowUpSearch;
      const assessment = candidate.skillAssessment;
      const dimensions = ['taskSpecificity', 'rediscoveryCost', 'errorCost', 'reuseFrequency'];
      if (!list(ids) || ids.some(id => !ledger.has(id))
        || !assessment || dimensions.some(key => !['low', 'medium', 'high', 'unknown'].includes(assessment[key]))
        || !list(followup?.queries) || !list(followup?.paths) || followup.paths.length > 32 || !text(followup?.result)
        || !list(followup?.evidenceIds) || followup.evidenceIds.some(id => !ids?.includes(id))
        || followup.paths.some(target => !sources.has(target) || !followup.evidenceIds.some(id => ledger.get(id)?.sourcePath === target))) fail(`NATIVE_SKILL_CONTRACT[${index}]`);
      if (candidate.decision === 'SKIP') {
        const basis = candidate.skipBasis;
        if (!list(basis?.dimensions) || basis.dimensions.some(key => !dimensions.includes(key)) || !text(basis?.explanation)
          || !(ids ?? []).some(id => text(ledger.get(id)?.sourceExcerpt) && basis.explanation.includes(ledger.get(id).sourceExcerpt))
          || /(?:model|familiar|well[- ]known|common stack)/i.test(basis.explanation)) fail(`NATIVE_SKIP_BASIS[${index}]`);
      }
      if (writing(candidate.decision)) {
        if (!captured.proposal.actions.some(action => action.kind === 'project-skill' && action.target === `.agents/skills/${candidate.name}/SKILL.md`
          && action.action === candidate.decision && isDeepStrictEqual(action.skillCandidate, candidate))) fail(`NATIVE_SKILL_RELATION[${index}]`);
        if (![candidate.taskTriggers, candidate.whenNotToUse, candidate.workflowSteps, candidate.verification,
          candidate.routing?.positiveIntents, candidate.routing?.negativeIntents].every(list) || !text(candidate.routing?.description)) fail(`NATIVE_SKILL_CONTRACT[${index}]`);
        for (const command of candidate.verification ?? []) {
          if (!(ids ?? []).some(id => ledger.get(id)?.sourceExcerpt?.includes(command))) fail(`NATIVE_VERIFICATION_LITERAL[${index}]`);
        }
        const excerpts = (ids ?? []).map(id => ledger.get(id)?.sourceExcerpt).filter(text);
        const workflowText = [...(candidate.workflowSteps ?? []), ...(candidate.verification ?? [])].join('\n');
        if (!groundedAssertions(workflowText, excerpts)) fail(`NATIVE_CONTENT_LITERAL[${index}]`);
      }
    }
    for (const [index, action] of captured.proposal.actions.entries()) {
      if (!writing(action.action)) continue;
      const permitted = { agents: /^AGENTS\.md$/, 'claude-adapter': /^CLAUDE\.md$/,
        'project-skill': /^\.agents\/skills\/[a-z0-9]+(?:-[a-z0-9]+)*\/(?:SKILL\.md|references\/[^/]+|scripts\/[^/]+)$/,
        'claude-skill-reference': /^\.claude\/skills\/[a-z0-9]+(?:-[a-z0-9]+)*$/, 'agent-doc': /^docs\/agents\/[a-z0-9][a-z0-9.-]*\.md$/ };
      if (!permitted[action.kind]?.test(action.target) || action.kind === 'agent-doc' && action.knowledgeScope !== 'ARCHITECTURE') fail(`NATIVE_WRITE_SCOPE[${index}]`);
      const content = approvedContent(action, sources);
      if (content === null) fail(`NATIVE_APPROVED_DIFF[${index}]`);
      if (action.kind !== 'claude-skill-reference') {
        const introduced = introducedContent(action, content, sources);
        const excerpts = (action.evidenceIds ?? []).map(id => ledger.get(id)?.sourceExcerpt).filter(text);
        if (introduced === null) fail(`NATIVE_UPDATE_CONTEXT_UNSUPPORTED[${index}]`);
        else if (!groundedAssertions(introduced, excerpts)) fail(`NATIVE_CONTENT_LITERAL[${index}]`);
      }
      if (action.kind === 'agents' && /(?:^##? .*\b(?:workflow|inventory)\b|^\s*[│├└]|(?:controller|service|class|method) list|`(?:npm|node|mvn|gradle|docker)\s)/im.test(content)) fail(`NATIVE_GLOBAL_CONTEXT[${index}]`);
      if (action.kind === 'claude-adapter') {
        const extra = (content ?? '').replace(/^@AGENTS\.md(?:\r?\n|$)/, '').trim();
        if (!/^@AGENTS\.md(?:\r?\n|$)/.test(content) || extra && (!list(action.claudeSpecificEvidenceIds)
          || action.claudeSpecificEvidenceIds.some(id => !action.evidenceIds.includes(id) || !ledger.get(id)?.sourceExcerpt?.includes(extra)))) fail(`NATIVE_CLAUDE_ADAPTER[${index}]`);
      }
      const allowedScopes = { agents: ['GLOBAL'], 'claude-adapter': ['GLOBAL'], 'agent-doc': ['ARCHITECTURE'],
        'project-skill': ['WORKFLOW', 'DISCOVERABLE'], 'claude-skill-reference': ['WORKFLOW', 'DISCOVERABLE'] };
      if (!list(action.evidenceIds) || action.evidenceIds.some(id => !allowedScopes[action.kind]?.includes(ledger.get(id)?.persistenceScope))) fail(`NATIVE_WRITE_EVIDENCE[${index}]`);
      if (action.kind === 'claude-skill-reference') {
        const name = action.target.split('/').at(-1);
        const canonical = `.agents/skills/${name}`;
        const link = path.posix.relative(path.posix.dirname(action.target), canonical);
        if (action.canonicalTarget !== canonical || [action.linkText, action.linkTarget, action.proposedContent].some(value => value !== link)) fail(`NATIVE_REFERENCE[${index}]`);
        const candidate = captured.decisionRecord.events[2].candidates.find(item => item.name === name);
        if (!candidate || candidate.decision === 'SKIP' || !captured.proposal.actions.some(item => item.kind === 'project-skill'
          && item.target === `${canonical}/SKILL.md` && writing(item.action)) && !sources.has(`${canonical}/SKILL.md`)) fail(`NATIVE_SKILL_RELATION[${index}]`);
      }
      if (action.kind === 'project-skill') {
        const name = action.target.split('/')[2];
        const candidate = captured.decisionRecord.events[2].candidates.find(item => item.name === name);
        if (!candidate || !writing(candidate.decision) || !isDeepStrictEqual(action.skillCandidate, candidate)) fail(`NATIVE_SKILL_RELATION[${index}]`);
        if (action.target === `.agents/skills/${name}/SKILL.md` && !skillPayload(content, candidate)) fail(`NATIVE_SKILL_PAYLOAD[${index}]`);
      }
    }
    if (phase === 'final') {
      try { if (!await exactFinalEffects(cwd, repositoryInput.inventory, writes)) fail('NATIVE_FINAL_EFFECTS'); }
      catch { fail('NATIVE_FINAL_EFFECTS'); }
      if (!Array.isArray(completed) || completed.length !== writes.length) fail('NATIVE_COMPLETION');
      const calls = new Set();
      for (const [index, action] of writes.entries()) {
        const record = completed?.[index];
        if (record?.actionIndex !== index || ![record?.callDigest, record?.inputDigest].every(value => /^sha256:[a-f0-9]{64}$/.test(value ?? ''))
          || record?.targetDigest !== digest(action.target) || calls.has(record?.callDigest)) fail(`NATIVE_COMPLETION[${index}]`);
        calls.add(record?.callDigest);
        try {
          if (action.kind === 'claude-skill-reference') {
            const canonical = action.canonicalTarget;
            const target = path.join(cwd, action.target);
            if ((await validateWriteTargetPhysicalScope(cwd, path.posix.dirname(action.target))).length
              || (await validateWriteTargetPhysicalScope(cwd, canonical)).length || !(await lstat(target)).isSymbolicLink()
              || await readlink(target) !== action.linkText || !(await lstat(path.join(cwd, canonical))).isDirectory()
              || await realpath(target) !== await realpath(path.join(cwd, canonical))) fail(`NATIVE_FINAL_REFERENCE[${index}]`);
          } else {
            const expected = approvedContent(action, sources);
            if ((await validateWriteTargetPhysicalScope(cwd, action.target)).length || typeof expected !== 'string'
              || !(await readRegularFileNoFollow(path.join(cwd, action.target))).equals(Buffer.from(expected))) fail(`NATIVE_FINAL_BYTES[${index}]`);
          }
          if (await fingerprintPath(cwd, action.target) !== record?.fingerprint) fail(`NATIVE_COMPLETION[${index}]`);
        } catch { fail(`${action.kind === 'claude-skill-reference' ? 'NATIVE_FINAL_REFERENCE' : 'NATIVE_FINAL_BYTES'}[${index}]`); }
      }
    }
  }
  return { ok: errors.length === 0, errors, citationDigests,
    validationScope: 'source-shape-numeric-commands-and-physical-effects-only',
    claims: { localContractValidated: errors.length === 0, semanticOutputQualityProven: false, liveSkillBehaviorProven: false } };
}
