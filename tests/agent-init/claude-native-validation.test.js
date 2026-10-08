import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { captureClaudeProposal } from './claude-proposal.js';
import { fingerprintPath, renderExactDiff } from './evaluation-harness.js';
import { validateClaudeNativeSetup } from './claude-native-validation.js';
import { snapshotContext } from './claude-protocol.js';

const digest = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const source = '# Bird project\nNode.js runtime.\nKeep changes local.\nFor local checks run `node --test bird.test.js`.\n';

async function setup(t) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-native-validation-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(path.join(cwd, 'README.md'), source);
  const repositoryInput = { source: 'owned-repository-snapshot', files: [{ path: 'README.md', content: source,
    fingerprint: await fingerprintPath(cwd, 'README.md') }] };
  const evidenceLedger = [
    { id: 'native-runtime', fact: 'Runtime identified', sourcePath: 'README.md', sourceLocation: 'line 2', sourceExcerpt: 'Node.js runtime.',
      observation: 'The repository uses this runtime.', whyItMatters: 'Useful orientation', persistenceScope: 'DISCOVERABLE', deterministicEnforcementCandidate: false },
    { id: 'native-local-rule', fact: 'Local boundary', sourcePath: 'README.md', sourceLocation: 'line 3', sourceExcerpt: 'Keep changes local.',
      observation: 'Stay within local changes.', whyItMatters: 'Applies across tasks', persistenceScope: 'GLOBAL', deterministicEnforcementCandidate: false },
  ];
  const record = { evidenceLedger, events: [
    { type: 'profile', facts: [
      { id: 'a-different-runtime-id', status: 'confirmed', value: 'Node.js', evidenceIds: ['native-runtime'] },
      { id: 'a-different-rule-id', status: 'confirmed', value: 'Keep changes local.', evidenceIds: ['native-local-rule'] },
    ], unknowns: ['Release process is unknown.'] },
    { type: 'classify', decisions: [
      { factId: 'a-different-runtime-id', persistenceScope: 'DISCOVERABLE', deterministicEnforcementCandidate: false, destination: 'source' },
      { factId: 'a-different-rule-id', persistenceScope: 'GLOBAL', deterministicEnforcementCandidate: false, destination: 'AGENTS.md' },
    ] },
    { type: 'skills', candidates: [] },
    { type: 'proposal', id: 'native-independent-proposal', revision: 1, projectSummary: 'A small local runtime project.',
      unknowns: ['Release process is unknown.'], warnings: [], nonGoals: ['No remote operations'], validationPlan: ['Check approved bytes'],
      actions: [{ id: 'local-instructions', action: 'CREATE', target: 'AGENTS.md', kind: 'agents', reason: 'Keep the local boundary visible.',
        evidenceIds: ['native-local-rule'], baselineFingerprint: 'missing', proposedContent: '# Repository\n\nKeep changes local.\n' }] },
  ] };
  return { cwd, repositoryInput, record };
}

async function capture(context) {
  context.repositoryInput.inventory ??= await snapshotContext(context.cwd);
  return captureClaudeProposal({ status: 0, stdout: JSON.stringify({ type: 'result', session_id: 'local-double', subtype: 'success',
    is_error: false, permission_denials: [], structured_output: { decisionRecordJson: JSON.stringify(context.record) } }) },
  { cwd: context.cwd, sessionId: 'local-double', harnessVersion: 'local-test' });
}

async function validate(context, options = {}) {
  return validateClaudeNativeSetup({ captured: await capture(context), cwd: context.cwd,
    repositoryInput: context.repositoryInput, phase: 'proposal', ...options });
}

async function workflow(context) {
  const content = '# Bird checks\nWhen changing bird behavior, inspect bird.test.js.\nRun `node --test bird.test.js`.\nDo not use for publishing.\n';
  await writeFile(path.join(context.cwd, 'CHECKS.md'), content);
  context.repositoryInput.files.push({ path: 'CHECKS.md', content, fingerprint: await fingerprintPath(context.cwd, 'CHECKS.md') });
  context.record.evidenceLedger.push({ id: 'native-checks', fact: 'Local check procedure', sourcePath: 'CHECKS.md', sourceLocation: 'lines 2-4',
    sourceExcerpt: content, observation: 'An explicit local check workflow exists.', whyItMatters: 'Useful for repeated behavior changes',
    persistenceScope: 'WORKFLOW', deterministicEnforcementCandidate: false });
  context.record.events[0].facts.push({ id: 'local-check-command', status: 'confirmed', value: 'node --test bird.test.js', evidenceIds: ['native-checks'] });
  context.record.events[1].decisions.push({ factId: 'local-check-command', persistenceScope: 'WORKFLOW',
    deterministicEnforcementCandidate: false, destination: '.agents/skills/bird-checks' });
  const candidate = { name: 'bird-checks', decision: 'CREATE', evidenceIds: ['native-checks'],
    taskTriggers: ['Changing bird behavior'], whenNotToUse: ['Publishing the project'], workflowSteps: ['Inspect CHECKS.md and run the documented local check.'],
    verification: ['node --test bird.test.js'], routing: { description: 'Check local bird behavior after behavior changes.',
      positiveIntents: ['Check changed bird behavior'], negativeIntents: ['Publish the project'] },
    skillAssessment: { taskSpecificity: 'high', rediscoveryCost: 'low', errorCost: 'medium', reuseFrequency: 'high' },
    targetedFollowUpSearch: { queries: ['local bird behavior verification'], paths: ['CHECKS.md'], result: 'Found an explicit command and exclusion.', evidenceIds: ['native-checks'] } };
  context.record.events[2].candidates.push(candidate);
  const body = '---\nname: bird-checks\ndescription: Check local bird behavior after behavior changes.\n---\n\n'
    + '## When to use\nChanging bird behavior\n\n## When not to use\nPublishing the project\n\n'
    + '## Workflow\nInspect CHECKS.md and run the documented local check.\n\n## Project-specific rules\nUse CHECKS.md as the source.\n\n'
    + '## Verification\n`node --test bird.test.js`\n';
  const action = { id: 'write-bird-checks', action: 'CREATE', target: '.agents/skills/bird-checks/SKILL.md', kind: 'project-skill',
    reason: 'Preserve a useful procedure.', evidenceIds: ['native-checks'], baselineFingerprint: 'missing', proposedContent: body,
    skillCandidate: structuredClone(candidate) };
  context.record.events[3].actions.push(action);
  return { candidate, action, body };
}

function fails(result, code) {
  assert.equal(result.ok, false);
  assert.equal(result.claims.localContractValidated, false);
  assert.equal(result.claims.liveSkillBehaviorProven, false);
  assert.ok(result.errors.some(error => error.startsWith(code)), JSON.stringify(result.errors));
}

test('native IDs and paraphrased observations pass against independent literal source, without changing decisions', async t => {
  const context = await setup(t);
  const captured = await capture(context);
  const before = JSON.stringify(captured);
  const result = await validateClaudeNativeSetup({ captured, cwd: context.cwd, repositoryInput: context.repositoryInput, phase: 'proposal' });
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
  assert.deepEqual(result.claims, { localContractValidated: true, semanticOutputQualityProven: false, liveSkillBehaviorProven: false });
  assert.equal(result.validationScope, 'source-shape-numeric-commands-and-physical-effects-only');
  assert.equal(JSON.stringify(captured), before);
  assert.equal(await fingerprintPath(context.cwd, 'AGENTS.md'), 'missing');
  assert.equal(result.citationDigests.length, 2);
  assert.ok(!JSON.stringify(result).includes('Keep changes local.'));
});

test('confirmed scalar and nested leaf claims must quote literal values, not invented commands or versions', async t => {
  const context = await setup(t);
  const fact = context.record.events[0].facts[0];
  fact.value = { runtime: 'Node.js', commands: ['npm publish --access public'], release: { version: '99.8.7' } };
  const result = await validate(context);
  fails(result, 'NATIVE_FACT_LITERAL');
  assert.ok(!JSON.stringify(result).includes('npm publish'));
  assert.ok(!JSON.stringify(result).includes('99.8.7'));
  fact.value = { runtime: 'Node.js', detail: ['runtime'] };
  assert.equal((await validate(context)).ok, true);
});

test('confirmed numeric facts cannot gain literal support from a substring of another version', async t => {
  const context = await setup(t);
  const release = '<release>17</release>\n';
  await writeFile(path.join(context.cwd, 'release.xml'), release);
  context.repositoryInput.files.push({ path: 'release.xml', content: release, fingerprint: await fingerprintPath(context.cwd, 'release.xml') });
  context.record.evidenceLedger.push({ id: 'declared-release', fact: 'Release declared', sourcePath: 'release.xml', sourceLocation: 'release',
    sourceExcerpt: '<release>17</release>', observation: 'Release is explicit', whyItMatters: 'Discover compatibility', persistenceScope: 'DISCOVERABLE', deterministicEnforcementCandidate: false });
  context.record.events[0].facts[0].value = '1';
  context.record.events[0].facts[0].evidenceIds = ['declared-release'];
  fails(await validate(context), 'NATIVE_FACT_LITERAL');
  context.record.events[0].facts[0].value = '17';
  assert.equal((await validate(context)).ok, true);
});

test('writable numeric claims require complete tokens from action-cited excerpts, not labels or unrelated evidence', async t => {
  const context = await setup(t);
  const release = '<release>17</release>\n';
  await writeFile(path.join(context.cwd, 'release.xml'), release);
  context.repositoryInput.files.push({ path: 'release.xml', content: release, fingerprint: await fingerprintPath(context.cwd, 'release.xml') });
  context.record.evidenceLedger.push({ id: 'evidence-with-99-in-label', fact: 'Release boundary', sourcePath: 'release.xml', sourceLocation: 'release',
    sourceExcerpt: '<release>17</release>', observation: 'Release declared', whyItMatters: 'Retain compatibility', persistenceScope: 'GLOBAL', deterministicEnforcementCandidate: false });
  const action = context.record.events[3].actions[0];
  action.evidenceIds = ['evidence-with-99-in-label'];
  for (const version of ['1', '7', '99', '17.1']) {
    action.proposedContent = `# Repository\nUse release ${version}.\n`;
    fails(await validate(context), 'NATIVE_CONTENT_LITERAL');
  }
  action.proposedContent = '# Repository\nUse release 17.\n';
  assert.equal((await validate(context)).ok, true);
  action.evidenceIds = ['native-local-rule'];
  fails(await validate(context), 'NATIVE_CONTENT_LITERAL');
});

test('Skill steps, scripts and references cannot introduce unsupported executable or numeric assertions', async t => {
  const context = await setup(t);
  const { candidate, action } = await workflow(context);
  candidate.workflowSteps.push('Run npm publish --access public.');
  action.skillCandidate = structuredClone(candidate);
  fails(await validate(context), 'NATIVE_CONTENT_LITERAL');
  candidate.workflowSteps.pop();
  action.skillCandidate = structuredClone(candidate);
  const extra = { id: 'workflow-extra', action: 'CREATE', target: '.agents/skills/bird-checks/references/checks.md', kind: 'project-skill',
    reason: 'Keep the checks together.', evidenceIds: ['native-checks'], baselineFingerprint: 'missing', skillCandidate: structuredClone(candidate) };
  context.record.events[3].actions.push(extra);
  for (const content of ['Run `npm publish --access public`.\n', '```sh\nnpm publish --access public\n```\n', 'Use runtime 99.\n']) {
    extra.proposedContent = content;
    fails(await validate(context), 'NATIVE_CONTENT_LITERAL');
  }
  extra.target = '.agents/skills/bird-checks/scripts/check.sh';
  extra.proposedContent = '#!/bin/sh\nnpm publish --access public\n';
  fails(await validate(context), 'NATIVE_CONTENT_LITERAL');
  extra.proposedContent = '#!/bin/sh\nnode --test bird.test.js\n';
  assert.equal((await validate(context)).ok, true);
});

test('argument-free executable paths and short commands require complete source-command quotations', async t => {
  const context = await setup(t);
  const action = context.record.events[3].actions[0];
  for (const content of ['Run ./undocumented-publish.sh.', 'Run `./undocumented-publish.sh`.', 'Execute sh.', 'Run go.', 'Execute rm.']) {
    action.proposedContent = '# Repository\n' + content + '\n';
    fails(await validate(context), 'NATIVE_CONTENT_LITERAL');
  }
  const misleading = 'Keep changes local; publishing, ongoing, perform.\n';
  await writeFile(path.join(context.cwd, 'MISLEADING.md'), misleading);
  context.repositoryInput.files.push({ path: 'MISLEADING.md', content: misleading, fingerprint: await fingerprintPath(context.cwd, 'MISLEADING.md') });
  context.record.evidenceLedger.push({ id: 'misleading-prose', fact: 'Local prose', sourcePath: 'MISLEADING.md', sourceLocation: 'line 1',
    sourceExcerpt: misleading, observation: 'Local prose exists', whyItMatters: 'Retain the local context', persistenceScope: 'GLOBAL', deterministicEnforcementCandidate: false });
  action.evidenceIds = ['misleading-prose'];
  for (const command of ['sh', 'go', 'rm']) {
    action.proposedContent = `# Repository\nRun \`${command}\`.\n`;
    fails(await validate(context), 'NATIVE_CONTENT_LITERAL');
  }
  action.evidenceIds = ['native-local-rule'];
  action.proposedContent = '# Repository\nKeep changes local.\n';
  const { candidate } = await workflow(context);
  const script = { id: 'argument-free-script', action: 'CREATE', target: '.agents/skills/bird-checks/scripts/check.sh', kind: 'project-skill',
    reason: 'Preserve the check.', evidenceIds: ['native-checks'], baselineFingerprint: 'missing', proposedContent: '#!/bin/sh\n./undocumented-publish.sh\n', skillCandidate: structuredClone(candidate) };
  context.record.events[3].actions.push(script);
  fails(await validate(context), 'NATIVE_CONTENT_LITERAL');
  const checks = context.repositoryInput.files.find(file => file.path === 'CHECKS.md');
  checks.content += 'Run `./documented-check.sh`.\nRun "sh".\n';
  await writeFile(path.join(context.cwd, 'CHECKS.md'), checks.content);
  checks.fingerprint = await fingerprintPath(context.cwd, 'CHECKS.md');
  context.record.evidenceLedger.find(entry => entry.id === 'native-checks').sourceExcerpt = checks.content;
  script.proposedContent = '#!/bin/sh\n./documented-check.sh\nsh\n';
  assert.equal((await validate(context)).ok, true);
});

test('UPDATE preserves a literal legacy prefix but does not count moved, duplicated or recontextualized assertions as unchanged', async t => {
  const context = await setup(t);
  const before = '# Existing instructions\n## Forbidden commands\nnpm publish --access public\nLegacy runtime 99.\n';
  await writeFile(path.join(context.cwd, 'AGENTS.md'), before);
  context.repositoryInput.files.push({ path: 'AGENTS.md', content: before, fingerprint: await fingerprintPath(context.cwd, 'AGENTS.md') });
  const action = context.record.events[3].actions[0];
  action.action = 'UPDATE';
  action.baselineFingerprint = await fingerprintPath(context.cwd, 'AGENTS.md');
  delete action.proposedContent;
  action.proposedDiff = renderExactDiff('AGENTS.md', before, before + 'Keep changes local.\n');
  assert.equal((await validate(context)).ok, true);
  for (const after of [before + 'Legacy runtime 99.\n', 'Legacy runtime 99.\n' + before, before.replace('Forbidden commands', 'Required verification')]) {
    action.proposedDiff = renderExactDiff('AGENTS.md', before, after);
    fails(await validate(context), 'NATIVE_UPDATE_CONTEXT_UNSUPPORTED');
  }
});

test('the complete source snapshot and each citation are bound to actual initial files, not model assertions', async t => {
  const context = await setup(t);
  await writeFile(path.join(context.cwd, 'release.txt'), 'Current release: 1.2.3\n');
  context.repositoryInput.files.push({ path: 'release.txt', content: 'Current release: 1.2.3\n',
    fingerprint: await fingerprintPath(context.cwd, 'release.txt') });
  const captured = await capture(context);
  const run = () => validateClaudeNativeSetup({ captured, cwd: context.cwd, repositoryInput: context.repositoryInput, phase: 'proposal' });
  await writeFile(path.join(context.cwd, 'release.txt'), 'Current release: 9.9.9\n');
  fails(await run(), 'NATIVE_SOURCE_DRIFT');
  await writeFile(path.join(context.cwd, 'release.txt'), 'Current release: 1.2.3\n');
  const file = context.repositoryInput.files[0];
  file.content = 'Node.js runtime.\nInvented source material\n';
  fails(await run(), 'NATIVE_SOURCE_DRIFT');
  file.content = source;
  for (const change of [{ presenceOnly: true }, { binary: true }, { content: undefined }]) {
    Object.assign(file, change);
    fails(await run(), 'NATIVE_SOURCE_EXCERPT');
    delete file.presenceOnly;
    delete file.binary;
    file.content = source;
  }
  captured.decisionRecord.evidenceLedger[0].sourcePath = 'release.txt';
  fails(await run(), 'NATIVE_SOURCE_EXCERPT');
  captured.decisionRecord.evidenceLedger[0].sourcePath = 'README.md';
  captured.decisionRecord.evidenceLedger[0].sourceExcerpt = '';
  fails(await run(), 'NATIVE_SOURCE_EXCERPT');
  context.repositoryInput.files.push({ path: '../outside', content: 'irrelevant', fingerprint: digest('irrelevant') });
  fails(await run(), 'NATIVE_SOURCE_SCOPE');
});

test('classification flags, scopes, evidence IDs, and write destinations must stay consistent', async t => {
  const context = await setup(t);
  const classify = context.record.events[1].decisions[1];
  classify.deterministicEnforcementCandidate = true;
  fails(await validate(context), 'NATIVE_CLASSIFY');
  classify.deterministicEnforcementCandidate = false;
  classify.evidenceIds = ['native-runtime'];
  fails(await validate(context), 'NATIVE_CLASSIFY');
  classify.evidenceIds = ['native-local-rule'];
  context.record.events[1].decisions.pop();
  fails(await validate(context), 'NATIVE_CLASSIFY');
  context.record.events[1].decisions.push(classify);
  context.record.events[3].actions[0].evidenceIds = ['native-runtime'];
  fails(await validate(context), 'NATIVE_WRITE_EVIDENCE');
});

test('writable workflows require source-quoted verification, qualitative assessment, exclusions, routing and bounded follow-up', async t => {
  const context = await setup(t);
  const { candidate, action } = await workflow(context);
  candidate.verification = ['npm publish'];
  action.skillCandidate = structuredClone(candidate);
  fails(await validate(context), 'NATIVE_VERIFICATION_LITERAL');
  candidate.verification = ['node --test bird.test.js'];
  for (const field of ['whenNotToUse', 'routing', 'skillAssessment', 'targetedFollowUpSearch']) {
    const previous = candidate[field];
    delete candidate[field];
    action.skillCandidate = structuredClone(candidate);
    fails(await validate(context), 'NATIVE_SKILL_CONTRACT');
    candidate[field] = previous;
  }
  candidate.targetedFollowUpSearch.paths = ['not-in-snapshot.md'];
  action.skillCandidate = structuredClone(candidate);
  fails(await validate(context), 'NATIVE_SKILL_CONTRACT');
  candidate.targetedFollowUpSearch.paths = ['CHECKS.md'];
  action.skillCandidate = structuredClone(candidate);
  assert.equal((await validate(context)).ok, true);
});

test('SKIP requires a source-grounded missing-value explanation and qualitative follow-up, not a stack shortcut', async t => {
  const context = await setup(t);
  const candidate = { name: 'runtime-operations', decision: 'SKIP', evidenceIds: ['native-runtime'],
    skillAssessment: { taskSpecificity: 'low', rediscoveryCost: 'unknown', errorCost: 'low', reuseFrequency: 'unknown' },
    targetedFollowUpSearch: { queries: ['runtime operations procedure'], paths: ['README.md'], result: 'Only the runtime indicator was found.', evidenceIds: ['native-runtime'] },
    skipBasis: { dimensions: ['taskSpecificity'], explanation: 'Node.js is a familiar stack, so skip.' } };
  context.record.events[2].candidates.push(candidate);
  fails(await validate(context), 'NATIVE_SKIP_BASIS');
  candidate.skipBasis.explanation = 'Only "Node.js runtime." was found; the bounded source has no runtime-operations procedure.';
  assert.equal((await validate(context)).ok, true);
  delete candidate.skillAssessment;
  fails(await validate(context), 'NATIVE_SKILL_CONTRACT');
});

test('canonical Skill payload must match its candidate, reject hidden metadata, and contain its declared workflow', async t => {
  const context = await setup(t);
  const { action, body } = await workflow(context);
  action.proposedContent = body.replace('description: Check local bird behavior after behavior changes.', 'description: A different intent');
  fails(await validate(context), 'NATIVE_SKILL_PAYLOAD');
  action.proposedContent = body.replace('name: bird-checks', 'name: bird-checks\nallowed-tools: Bash');
  fails(await validate(context), 'NATIVE_SKILL_PAYLOAD');
  action.proposedContent = body.replace('Inspect CHECKS.md and run the documented local check.', 'Do a different undocumented procedure.');
  fails(await validate(context), 'NATIVE_SKILL_PAYLOAD');
  action.proposedContent = body.replace('## Workflow', '## Steps');
  fails(await validate(context), 'NATIVE_SKILL_PAYLOAD');
  action.proposedContent = body;
  action.skillCandidate.routing.description = 'Changed mutable routing';
  fails(await validate(context), 'NATIVE_SKILL_RELATION');
  context.record.events[2].candidates = [];
  fails(await validate(context), 'NATIVE_SKILL_RELATION');
});

test('minimal context rejects workflows in GLOBAL, non-thin ungrounded adapters, and obvious Hook or CI writes', async t => {
  const context = await setup(t);
  const actions = context.record.events[3].actions;
  actions[0].proposedContent = '# Checks\n\n## Workflow\nRun `node --test bird.test.js`.\n';
  fails(await validate(context), 'NATIVE_GLOBAL_CONTEXT');
  actions[0].proposedContent = '# Local\nKeep changes local.\n';
  actions.push({ id: 'adapter', action: 'CREATE', target: 'CLAUDE.md', kind: 'claude-adapter', reason: 'Share instructions.',
    evidenceIds: ['native-local-rule'], baselineFingerprint: 'missing', proposedContent: '@AGENTS.md\n\nExtra ungrounded rule.\n' });
  fails(await validate(context), 'NATIVE_CLAUDE_ADAPTER');
  actions[1].proposedContent = '@AGENTS.md\n';
  assert.equal((await validate(context)).ok, true);
  const captured = await capture(context);
  for (const [target, kind] of [['.github/workflows/extra.yml', 'ci'], ['.claude/hooks/on-stop.js', 'hook'], ['.claude/settings.json', 'permissions']]) {
    captured.proposal.actions.push({ id: 'unsafe-local', action: 'CREATE', target, kind, reason: 'Enable automation.',
      evidenceIds: ['native-local-rule'], baselineFingerprint: 'missing', proposedContent: 'unapproved automation' });
    fails(await validateClaudeNativeSetup({ captured, cwd: context.cwd, repositoryInput: context.repositoryInput, phase: 'proposal' }), 'NATIVE_WRITE_SCOPE');
    captured.proposal.actions.pop();
  }
});

test('Claude references require one exact relative canonical link and writable candidates require canonical actions', async t => {
  const context = await setup(t);
  const { candidate } = await workflow(context);
  const actions = context.record.events[3].actions;
  actions.push({ id: 'share-checks', action: 'CREATE', kind: 'claude-skill-reference', target: '.claude/skills/bird-checks',
    reason: 'Share the canonical procedure.', evidenceIds: ['native-checks'], baselineFingerprint: 'missing',
    canonicalTarget: '.agents/skills/bird-checks', linkText: '../../.agents/skills/bird-checks',
    linkTarget: '../../.agents/skills/bird-checks', proposedContent: '../../.agents/skills/bird-checks' });
  actions[2].canonicalTarget = '.agents/skills/hidden-alternate';
  fails(await validate(context), 'NATIVE_REFERENCE');
  actions[2].canonicalTarget = '.agents/skills/bird-checks';
  actions[2].linkText = '../../.agents/skills/hidden-alternate';
  fails(await validate(context), 'NATIVE_REFERENCE');
  actions[2].linkText = '../../.agents/skills/bird-checks';
  assert.equal((await validate(context)).ok, true);
  actions.splice(1, 1);
  fails(await validate(context), 'NATIVE_SKILL_RELATION');
  candidate.decision = 'SKIP';
  candidate.skipBasis = { dimensions: ['rediscoveryCost'], explanation: `The quoted source "${context.record.evidenceLedger[2].sourceExcerpt}" did not justify a new persistent procedure.` };
  fails(await validate(context), 'NATIVE_SKILL_RELATION');
});

// These records stand in for independently observed native completions, not final-diff events.
function completedFor(actions) {
  return actions.filter(action => ['CREATE', 'UPDATE'].includes(action.action)).map((action, actionIndex) => ({ actionIndex,
    callDigest: digest(`native-call-${actionIndex}`), inputDigest: digest(`observed-native-input-${actionIndex}`),
    targetDigest: digest(action.target), fingerprint: digest(action.proposedContent) }));
}

test('final phase requires every completed native action with matching actual approved bytes', async t => {
  const context = await setup(t);
  const captured = await capture(context);
  const completed = completedFor(captured.proposal.actions);
  const run = records => validateClaudeNativeSetup({ captured, cwd: context.cwd, repositoryInput: context.repositoryInput, phase: 'final', completed: records });
  fails(await run(completed), 'NATIVE_FINAL_BYTES');
  await writeFile(path.join(context.cwd, 'AGENTS.md'), captured.proposal.actions[0].proposedContent);
  fails(await run(undefined), 'NATIVE_COMPLETION');
  fails(await run([]), 'NATIVE_COMPLETION');
  fails(await run([{ ...completed[0], actionIndex: 1 }]), 'NATIVE_COMPLETION');
  fails(await run([{ ...completed[0], callDigest: undefined }]), 'NATIVE_COMPLETION');
  fails(await run([{ ...completed[0], targetDigest: digest('some-other-target') }]), 'NATIVE_COMPLETION');
  assert.equal((await run(completed)).ok, true);
  await writeFile(path.join(context.cwd, 'AGENTS.md'), 'Different final bytes\n');
  fails(await run(completed), 'NATIVE_FINAL_BYTES');
  assert.equal(await readFile(path.join(context.cwd, 'README.md'), 'utf8'), source);
});

test('final validation rejects unapproved files, empty directories and changed metadata against the held physical baseline',
  { skip: process.platform === 'win32' ? 'POSIX file modes are unavailable' : false }, async t => {
  const context = await setup(t);
  await mkdir(path.join(context.cwd, 'kept-empty-directory'));
  const captured = await capture(context);
  const completed = completedFor(captured.proposal.actions);
  await writeFile(path.join(context.cwd, 'AGENTS.md'), captured.proposal.actions[0].proposedContent);
  const run = () => validateClaudeNativeSetup({ captured, cwd: context.cwd, repositoryInput: context.repositoryInput, phase: 'final', completed });
  assert.equal((await run()).ok, true);
  await writeFile(path.join(context.cwd, 'unapproved.md'), 'Not an approved target.\n');
  fails(await run(), 'NATIVE_FINAL_EFFECTS');
  await rm(path.join(context.cwd, 'unapproved.md'));
  await mkdir(path.join(context.cwd, 'unapproved-directory'));
  fails(await run(), 'NATIVE_FINAL_EFFECTS');
  await rm(path.join(context.cwd, 'unapproved-directory'), { recursive: true });
  await chmod(path.join(context.cwd, 'README.md'), 0o600);
  fails(await run(), 'NATIVE_FINAL_EFFECTS');
  const inventory = context.repositoryInput.inventory;
  await chmod(path.join(context.cwd, 'README.md'), inventory.find(entry => entry.path === 'README.md').mode);
  assert.equal((await run()).ok, true);
  delete context.repositoryInput.inventory;
  fails(await run(), 'NATIVE_FINAL_EFFECTS');
});

test('UPDATE final bytes must match the exact approved diff from the actual initial snapshot', async t => {
  const context = await setup(t);
  const before = '# Existing instructions\nKeep custom prose.\n';
  const after = '# Existing instructions\nKeep custom prose.\nKeep changes local.\n';
  await writeFile(path.join(context.cwd, 'AGENTS.md'), before);
  context.repositoryInput.files.push({ path: 'AGENTS.md', content: before, fingerprint: await fingerprintPath(context.cwd, 'AGENTS.md') });
  const action = context.record.events[3].actions[0];
  Object.assign(action, { action: 'UPDATE', baselineFingerprint: await fingerprintPath(context.cwd, 'AGENTS.md'), proposedDiff: renderExactDiff('AGENTS.md', before, after) });
  delete action.proposedContent;
  const captured = await capture(context);
  const completed = [{ actionIndex: 0, callDigest: digest('native-update'), inputDigest: digest('observed-update-input'), targetDigest: digest('AGENTS.md'), fingerprint: digest(after) }];
  const run = phase => validateClaudeNativeSetup({ captured, cwd: context.cwd, repositoryInput: context.repositoryInput, phase, completed });
  assert.equal((await run('proposal')).ok, true);
  await writeFile(path.join(context.cwd, 'AGENTS.md'), after);
  assert.deepEqual((await run('final')).errors, []);
  context.repositoryInput.files[1].content = '# Forged initial instructions\n';
  fails(await run('final'), 'NATIVE_APPROVED_DIFF');
  context.repositoryInput.files[1].content = before;
  await writeFile(path.join(context.cwd, 'AGENTS.md'), '# Incorrect updated bytes\n');
  fails(await run('final'), 'NATIVE_FINAL_BYTES');
});

test('final relative Claude link must physically resolve to its approved regular canonical directory',
  { skip: process.platform === 'win32' ? 'owned POSIX symlink boundary is unavailable' : false }, async t => {
  const context = await setup(t);
  await workflow(context);
  const actions = context.record.events[3].actions;
  actions.push({ id: 'share-checks', action: 'CREATE', kind: 'claude-skill-reference', target: '.claude/skills/bird-checks',
    reason: 'Share the canonical procedure.', evidenceIds: ['native-checks'], baselineFingerprint: 'missing',
    canonicalTarget: '.agents/skills/bird-checks', linkText: '../../.agents/skills/bird-checks',
    linkTarget: '../../.agents/skills/bird-checks', proposedContent: '../../.agents/skills/bird-checks' });
  const captured = await capture(context);
  for (const action of actions.slice(0, 2)) {
    await mkdir(path.dirname(path.join(context.cwd, action.target)), { recursive: true });
    await writeFile(path.join(context.cwd, action.target), action.proposedContent);
  }
  await mkdir(path.join(context.cwd, '.claude/skills'), { recursive: true });
  const target = path.join(context.cwd, actions[2].target);
  await symlink(actions[2].linkTarget, target);
  const completed = completedFor(actions);
  completed[2].fingerprint = await fingerprintPath(context.cwd, actions[2].target);
  const run = () => validateClaudeNativeSetup({ captured, cwd: context.cwd, repositoryInput: context.repositoryInput, phase: 'final', completed });
  assert.deepEqual((await run()).errors, []);
  await rm(target);
  await symlink('../../.agents/skills/not-the-approved-directory', target);
  completed[2].fingerprint = await fingerprintPath(context.cwd, actions[2].target);
  fails(await run(), 'NATIVE_FINAL_REFERENCE');
});
