import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const skillDirectory = path.resolve(here, '../../skills/project-setup');

async function read(relativePath) {
  return readFile(path.join(skillDirectory, relativePath), 'utf8');
}

const references = {
  detection: 'references/detection-guidelines.md',
  classification: 'references/classification.md',
  proposal: 'references/proposal-guidelines.md',
  agents: 'references/agents-guidelines.md',
  skills: 'references/skills-guidelines.md',
  reconciliation: 'references/reconciliation-guidelines.md',
  evaluation: 'references/evaluation-guidelines.md',
};

test('mother Skill is a concise ordered phase orchestrator with conditional references', async () => {
  const markdown = await read('SKILL.md');
  assert.ok(markdown.length < 7_500, 'SKILL.md should orchestrate, not duplicate all reference rules');

  const phases = [
    '**Preflight.**',
    '**Explore.**',
    '**Project Profile.**',
    '**Classify Knowledge.**',
    '**Detect Project Skills.**',
    '**Proposal.**',
    '**Apply.**',
    '**Validate.**',
  ];
  let prior = -1;
  for (const phase of phases) {
    const index = markdown.indexOf(phase);
    assert.ok(index > prior, `${phase} must appear in workflow order`);
    prior = index;
  }

  for (const reference of Object.values(references)) {
    assert.ok(markdown.includes(`Read \`${reference}\` when`));
  }
  assert.match(markdown, /Preflight and Explore are strictly read-only/i);
  assert.match(markdown, /explicitly approves.*Proposal ID.*revision.*action IDs/is);
  assert.match(markdown, /CREATE.*UPDATE.*KEEP.*SKIP.*RECOMMEND/s);
  assert.match(markdown, /CLAUDE\.md.*@AGENTS\.md/s);
  assert.match(markdown, /external acceptance/i);
  assert.match(markdown, /no file writes/i);
  assert.match(markdown, /targeted follow-up search/i);
  assert.match(markdown, /Task Specificity.*Rediscovery Cost.*Error Cost.*Reuse Frequency/is);
});

test('Proposal presents a plain-language decision summary before audit details', async () => {
  const [skill, proposal, evaluation] = await Promise.all([
    read('SKILL.md'),
    read(references.proposal),
    read(references.evaluation),
  ]);

  assert.match(skill, /plain-language decision summary.*before.*audit details/is);
  assert.match(skill, /user's language/i);

  const summaryIndex = proposal.indexOf('## Decision summary');
  const auditIndex = proposal.indexOf('## Audit details');
  assert.ok(summaryIndex >= 0, 'Proposal reference must define a decision summary');
  assert.ok(auditIndex > summaryIndex, 'audit details must follow the decision summary');
  assert.match(proposal, /no files have been written/i);
  assert.match(proposal, /CREATE.*UPDATE.*write actions/is);
  assert.match(proposal, /KEEP.*SKIP.*RECOMMEND.*non-writing/is);
  assert.match(proposal, /copy-ready.*Proposal ID.*revision.*action IDs/is);
  assert.match(proposal, /summary.*derived presentation.*does not authorize Apply/is);
  assert.match(proposal, /audit details.*full proposed content.*exact proposed diff.*fingerprint/is);

  assert.match(evaluation, /decision summary.*complete Proposal.*audit/is);
});

test('progressive references each own one detailed operating contract', async () => {
  const [detection, classification, proposal, agents, skills, reconciliation, evaluation] = await Promise.all(
    Object.values(references).map(read),
  );

  for (const [name, markdown] of Object.entries({ detection, classification, proposal, agents, skills, reconciliation, evaluation })) {
    assert.ok(markdown.length > 300, `${name} reference must contain an actionable contract`);
    assert.ok(markdown.length < 12_000, `${name} reference should remain focused`);
  }

  for (const term of [
    'Search → Read relevant → Cross-check',
    'presence-only',
    'Evidence Ledger',
    'repository-relative',
    'conflicting',
    'Unknown',
    'targeted follow-up search',
  ]) assert.match(detection, new RegExp(term, 'i'));
  assert.match(detection, /queries.*paths.*result.*evidence IDs/is);
  assert.match(detection, /indicator.*search seed/is);

  for (const scope of ['GLOBAL', 'WORKFLOW', 'DISCOVERABLE', 'ARCHITECTURE', 'NONE']) {
    assert.match(classification, new RegExp(`\\b${scope}\\b`));
  }
  assert.match(classification, /deterministicEnforcementCandidate/);
  assert.match(classification, /technology stack/i);
  assert.match(classification, /context load/i);
  assert.match(classification, /AGENTS\.md.*SKILL\.md.*references\/.*docs\/agents.*runtime/is);
  assert.match(classification, /DISCOVERABLE.*does not.*Skill decision/is);
  assert.match(classification, /model familiarity.*repository evidence/is);
  assert.match(classification, /combined Skill assessment.*no single assessment dimension.*hard gate/is);
  assert.doesNotMatch(classification, /Task-specific \+ repeated/i);

  for (const action of ['CREATE', 'UPDATE', 'KEEP', 'SKIP', 'RECOMMEND']) {
    assert.match(proposal, new RegExp(`\\b${action}\\b`));
  }
  assert.match(proposal, /full proposed content/i);
  assert.match(proposal, /exact proposed diff/i);
  assert.match(proposal, /baseline fingerprint/i);
  assert.match(proposal, /revision.*invalidates.*approval/is);
  assert.match(proposal, /SHA-256/i);
  assert.match(proposal, /tree digest/i);
  assert.match(proposal, /link text/i);

  assert.match(agents, /AGENTS\.md.*source of truth/is);
  assert.match(agents, /@AGENTS\.md/);
  assert.match(agents, /conservative/i);
  assert.match(agents, /delete-and-regenerate/i);
  assert.match(agents, /Claude-specific evidence/i);

  assert.match(skills, /\.agents\/skills\/<skill>\/SKILL\.md/);
  assert.match(skills, /\.claude\/skills\/<skill>/);
  assert.match(skills, /relative symlink/i);
  assert.match(skills, /managed copy/i);
  assert.match(skills, /When to use/i);
  assert.match(skills, /When not to use/i);
  assert.match(skills, /technology stack/i);
  for (const dimension of ['Task Specificity', 'Rediscovery Cost', 'Error Cost', 'Reuse Frequency']) {
    assert.match(skills, new RegExp(dimension, 'i'));
  }
  assert.match(skills, /targetedFollowUpSearch/);
  assert.match(skills, /queries.*paths.*result/is);
  assert.match(skills, /evidence floor/i);
  assert.match(skills, /one.*dimension.*SKIP/is);
  assert.match(skills, /combined assessment.*durable guidance/is);
  assert.doesNotMatch(skills, /Skill persists a repeated/i);
  assert.match(skills, /SKIP.*skipBasis.*dimensions.*explanation/is);
  assert.match(skills, /model familiarity.*discoverable.*sole.*SKIP/is);
  assert.match(skills, /workflow intent.*existing Skill/is);
  assert.match(skills, /completion criteria.*Verification/is);
  assert.doesNotMatch(skills, /If any gate is missing, issue `SKIP`/i);

  assert.match(reconciliation, /no-follow/i);
  assert.match(reconciliation, /physical/i);
  assert.match(reconciliation, /fingerprint drift/i);
  assert.match(reconciliation, /AGENTS.*CLAUDE.*canonical project Skills.*Claude Skill.*docs\/agents/is);
  assert.match(reconciliation, /second.*zero.*write/is);
  assert.match(reconciliation, /Hook.*CI.*recommendation-only/is);
  assert.match(reconciliation, /production.*refactor/i);
  assert.match(reconciliation, /EVALUATED \/ DEFER/);

  assert.match(evaluation, /fresh Claude Code/i);
  assert.match(evaluation, /fresh Codex/i);
  assert.match(evaluation, /no-approval/i);
  assert.match(evaluation, /Proposal.*zero writes/is);
  assert.match(evaluation, /named evidence/i);
  assert.match(evaluation, /target.*existence.*does not prove/is);
});
