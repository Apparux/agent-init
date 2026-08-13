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
  ]) assert.match(detection, new RegExp(term, 'i'));

  for (const scope of ['GLOBAL', 'WORKFLOW', 'DISCOVERABLE', 'ARCHITECTURE', 'NONE']) {
    assert.match(classification, new RegExp(`\\b${scope}\\b`));
  }
  assert.match(classification, /deterministicEnforcementCandidate/);
  assert.match(classification, /technology stack/i);

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
