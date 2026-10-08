import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { digestProposal, fingerprintPath, validateWriteTargetPhysicalScope } from '../evaluation-harness.js';

export async function syntheticApproval({ proposal }) {
  return { type: 'approval', decision: 'approve', scope: 'exact-proposal', proposalId: proposal.id, revision: proposal.revision,
    proposalDigest: digestProposal(proposal),
    approvedActionIds: proposal.actions.filter((action) => ['CREATE', 'UPDATE'].includes(action.action)).map((action) => action.id) };
}

// Fixture-authored normalized inputs, not a Claude CLI protocol or model output.
export async function syntheticSession(request) {
  if (request.phase === 'close') return { closed: true };
  if (request.phase === 'reconcile') return { type: 'reconcile', mode: 'dry-run', proposalActions: [], writes: [] };
  if (request.phase === 'write') {
    const { action, proposal, cwd, emitWrite } = request;
    if (action.action !== 'CREATE') throw Object.assign(new Error('Synthetic fixture has no UPDATE writer'), { code: 'SIMULATION_WRITE_UNSUPPORTED' });
    if ((await validateWriteTargetPhysicalScope(cwd, action.target)).length) throw Object.assign(new Error('Unsafe target'), { code: 'PATH_SCOPE' });
    const observedBeforeFingerprint = await fingerprintPath(cwd, action.target);
    if (observedBeforeFingerprint !== action.baselineFingerprint) throw Object.assign(new Error('Target drift'), { code: 'FINGERPRINT_DRIFT' });
    const target = path.join(cwd, action.target);
    await mkdir(path.dirname(target), { recursive: true });
    if ((await validateWriteTargetPhysicalScope(cwd, action.target)).length) throw Object.assign(new Error('Unsafe target'), { code: 'PATH_SCOPE' });
    if (action.kind === 'claude-skill-reference') await symlink(action.linkText, target);
    else await writeFile(target, action.proposedContent, { flag: 'wx' });
    emitWrite({ type: 'write', proposalId: proposal.id, revision: proposal.revision, actionId: action.id,
      target: action.target, observedBeforeFingerprint });
    return { completed: true };
  }
  if (request.phase !== 'proposal') throw new Error('Unsupported synthetic session phase');
  const { fixture, cwd } = request;
  const candidates = fixture.expected.skillDecisions.map(({ action, ...candidate }) => ({ ...candidate, decision: action }));
  const scopes = new Map();
  for (const fact of fixture.expected.facts) {
    const classification = fixture.expected.classifications.find((entry) => entry.factId === fact.id);
    for (const id of fact.evidenceIds) scopes.set(id, classification);
  }
  const evidenceLedger = fixture.evidence.map((entry) => ({ ...entry, ...(scopes.get(entry.id) ?? {
    persistenceScope: 'Unknown', deterministicEnforcementCandidate: false, destination: null,
  }) }));
  const globalIds = new Set(fixture.expected.classifications.filter((entry) => entry.persistenceScope === 'GLOBAL').map((entry) => entry.factId));
  const globalRules = fixture.expected.facts.filter((fact) => globalIds.has(fact.id)).map((fact) => `- ${fact.id}: ${JSON.stringify(fact.value)}`);
  const pointers = candidates.filter((candidate) => candidate.decision === 'CREATE')
    .map((candidate) => `- For ${candidate.taskTriggers.join(', ')}, use .agents/skills/${candidate.name}/SKILL.md.`);
  const agents = `# Repository rules\n\n${[...globalRules, ...pointers].join('\n')}\n\nUnknowns: ${fixture.expected.unknowns.join(', ')}.\n`;
  const actions = [];
  for (const [index, allowed] of fixture.expected.allowedActions.entries()) {
    const action = { ...allowed, id: `synthetic-action-${index}`, kind: 'project-skill', reason: 'Fixture-authored synthetic decision.',
      evidenceIds: [fixture.evidence[index % fixture.evidence.length].id], validation: ['Exact payload and physical scope'], decisionRequired: false };
    if (allowed.target === 'AGENTS.md') action.kind = 'agents';
    else if (allowed.target === 'CLAUDE.md') action.kind = 'claude-adapter';
    else if (allowed.target.startsWith('.claude/skills/')) action.kind = 'claude-skill-reference';
    else if (allowed.action === 'RECOMMEND') Object.assign(action, { kind: 'guardrail', mechanism: 'Separately approved deterministic check',
      impact: 'Enforce the evidenced rule', falsePositiveRisk: 'May block intentional deviations' });
    if (allowed.action === 'CREATE') {
      action.baselineFingerprint = await fingerprintPath(cwd, allowed.target);
      if (action.kind === 'agents') action.proposedContent = agents;
      else if (action.kind === 'claude-adapter') action.proposedContent = '@AGENTS.md\n';
      else if (action.kind === 'claude-skill-reference') {
        const name = allowed.target.split('/')[2];
        Object.assign(action, { canonicalTarget: `.agents/skills/${name}`, linkText: `../../.agents/skills/${name}`,
          proposedContent: `Relative symlink: ../../.agents/skills/${name}` });
      } else {
        const candidate = candidates.find((entry) => entry.name === allowed.target.split('/')[2]);
        action.skillCandidate = candidate;
        action.proposedContent = `---\nname: ${candidate.name}\ndescription: ${candidate.routing.description}\n---\n\n# ${candidate.name}\n\n## When to use\n${candidate.taskTriggers.join('\n')}\n\n## When not to use\n${candidate.whenNotToUse.join('\n')}\n\n## Workflow\n${candidate.workflowSteps.join('\n')}\n\n## Project-specific rules\nFollow only the fixture-evidenced procedure; unknowns require confirmation.\n\n## Verification\n${candidate.verification.join('\n')}\n`;
      }
    } else action.summary = 'Synthetic non-write decision; no filesystem mutation.';
    actions.push(action);
  }
  return { evidenceLedger, events: [
    { type: 'profile', facts: fixture.expected.facts, unknowns: fixture.expected.unknowns.map((id) => ({ id })) },
    { type: 'classify', decisions: fixture.expected.classifications },
    { type: 'skills', candidates },
    { type: 'proposal', id: `synthetic-${fixture.id}`, revision: 1, projectSummary: fixture.purpose,
      unknowns: fixture.expected.unknowns, warnings: ['Test double only; not a model decision or human approval.'],
      nonGoals: fixture.expected.forbiddenPaths, validationPlan: ['Physical evaluator', 'No-churn reconcile'], actions },
  ] };
}
