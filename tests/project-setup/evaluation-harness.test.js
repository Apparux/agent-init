import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  EVALUATION_BOUNDARIES,
  digestProposal,
  evaluateRunRecord,
  fingerprintPath,
  fingerprintRepository,
  renderExactDiff,
  validateFixtureManifest,
  validateWriteTargetPhysicalScope,
} from './evaluation-harness.js';

const fixture = {
  schemaVersion: 1,
  id: 'inline-safe-project',
  repository: 'repository',
  purpose: 'Exercise the recorded-run invariant evaluator.',
  evidence: [
    {
      id: 'ev-package-manager',
      fact: 'The repository declares pnpm as its package manager.',
      sourcePath: 'package.json',
      sourceLocation: 'packageManager',
      observation: 'packageManager is pnpm@9.0.0',
      whyItMatters: 'The package manager is a repository-wide pre-action constraint.',
    },
    {
      id: 'ev-workflow',
      fact: 'The repository defines a project-specific verification workflow.',
      sourcePath: 'package.json',
      sourceLocation: 'scripts.verify',
      observation: 'verify script is pnpm lint && pnpm test',
      whyItMatters: 'Repeated changes need the repository-defined validation sequence.',
    },
  ],
  expected: {
    facts: [
      {
        id: 'fact-package-manager',
        value: 'pnpm@9.0.0',
        status: 'confirmed',
        evidenceIds: ['ev-package-manager'],
      },
      {
        id: 'fact-verify',
        value: 'pnpm lint && pnpm test',
        status: 'confirmed',
        evidenceIds: ['ev-workflow'],
      },
    ],
    unknowns: ['deployment-command'],
    classifications: [
      {
        factId: 'fact-package-manager',
        persistenceScope: 'GLOBAL',
        deterministicEnforcementCandidate: true,
        destination: 'AGENTS.md',
      },
      {
        factId: 'fact-verify',
        persistenceScope: 'WORKFLOW',
        deterministicEnforcementCandidate: false,
        destination: '.agents/skills/build-verify/SKILL.md',
      },
    ],
    skillDecisions: [
      {
        name: 'build-verify',
        action: 'CREATE',
        evidenceIds: ['ev-workflow'],
        skillAssessment: {
          taskSpecificity: 'high',
          rediscoveryCost: 'medium',
          errorCost: 'high',
          reuseFrequency: 'high',
        },
        targetedFollowUpSearch: {
          queries: ['repository verification workflow'],
          paths: ['package.json'],
          result: 'Found the exact scripts.verify workflow.',
          evidenceIds: ['ev-workflow'],
        },
        taskTriggers: ['validating a code change'],
        whenNotToUse: ['read-only analysis'],
        workflowSteps: ['Run the repository-declared verify workflow.'],
        verification: ['pnpm lint && pnpm test'],
      },
      {
        name: 'node-backend',
        action: 'SKIP',
        reason: 'A technology label alone is not a project-specific workflow.',
        evidenceIds: ['ev-package-manager'],
        skillAssessment: {
          taskSpecificity: 'low',
          rediscoveryCost: 'low',
          errorCost: 'low',
          reuseFrequency: 'low',
        },
        targetedFollowUpSearch: {
          queries: ['Node-specific project workflow'],
          paths: ['package.json'],
          result: 'Found a package-manager declaration but no Node-specific procedure.',
          evidenceIds: ['ev-package-manager'],
        },
        skipBasis: {
          dimensions: ['taskSpecificity', 'rediscoveryCost', 'reuseFrequency'],
          explanation: 'Repository evidence contains a technology label but no repeated task workflow or verification procedure.',
        },
      },
    ],
    allowedActions: [
      { action: 'UPDATE', target: 'AGENTS.md' },
      { action: 'CREATE', target: 'CLAUDE.md' },
      { action: 'CREATE', target: '.agents/skills/build-verify/SKILL.md' },
      { action: 'CREATE', target: '.claude/skills/build-verify' },
      { action: 'SKIP', target: '.agents/skills/node-backend/SKILL.md' },
      { action: 'RECOMMEND', target: 'package-manager enforcement' },
    ],
    forbiddenPaths: ['package.json', '.claude/settings.json', '.github/', 'src/'],
    preservation: [
      { path: '.claude/settings.json', mode: 'exact' },
      { path: 'AGENTS.md', mode: 'contains', requiredText: ['Keep this user-authored rule.'] },
    ],
    secondRun: 'NO_WRITE_ACTIONS',
  },
};

async function goodRun() {
  const agentsBefore = '# Existing\n\nKeep this user-authored rule.\n';
  const agentsContent = '# Existing\n\n## Environment\n\n- Use pnpm@9.0.0.\n\nKeep this user-authored rule.\n';
  const claudeContent = '@AGENTS.md\n';
  const skillContent = `---
name: build-verify
description: Verify this repository with its declared lint and test workflow when validating code changes.
---

# Build Verify

## When to use

Use for code changes that need repository validation.

## When not to use

Skip for read-only analysis.

## Workflow

Run the repository-declared checks in order.

## Project-specific rules

Use only commands supported by package.json.

## Verification

Run \`pnpm lint && pnpm test\`.
`;

  const agentsFingerprint = `sha256:${createHash('sha256').update(agentsBefore).digest('hex')}`;
  const settingsContent = '{"hooks":{}}\n';

  const run = {
    schemaVersion: 1,
    fixtureId: fixture.id,
    harness: 'recorded-contract',
    evidenceLedger: fixture.evidence.map((record) => ({
      ...record,
      persistenceScope: record.id === 'ev-package-manager' ? 'GLOBAL' : 'WORKFLOW',
      deterministicEnforcementCandidate: record.id === 'ev-package-manager',
      destination: record.id === 'ev-package-manager'
        ? 'AGENTS.md'
        : '.agents/skills/build-verify/SKILL.md',
    })),
    events: [
      {
        type: 'preflight',
        readOnly: true,
        cwd: '.',
        repositoryRoot: '.',
        baselineId: 'baseline-1',
        git: { isRepository: false, staged: [], unstaged: [], untracked: [] },
        existingAgentAssets: ['AGENTS.md', '.claude/settings.json'],
      },
      {
        type: 'explore',
        readOnly: true,
        strategy: ['search', 'read-relevant', 'cross-check'],
        sensitiveFiles: 'presence-only',
      },
      {
        type: 'profile',
        facts: structuredClone(fixture.expected.facts),
        unknowns: [{ id: 'deployment-command', label: 'Deployment command' }],
      },
      {
        type: 'classify',
        decisions: structuredClone(fixture.expected.classifications),
      },
      {
        type: 'skills',
        candidates: [
          {
            name: 'build-verify',
            decision: 'CREATE',
            evidenceIds: ['ev-workflow'],
            skillAssessment: {
              taskSpecificity: 'high',
              rediscoveryCost: 'medium',
              errorCost: 'high',
              reuseFrequency: 'high',
            },
            targetedFollowUpSearch: {
              queries: ['repository verification workflow'],
              paths: ['package.json'],
              result: 'Found the exact scripts.verify workflow.',
              evidenceIds: ['ev-workflow'],
            },
            taskTriggers: ['validating a code change'],
            whenNotToUse: ['read-only analysis'],
            workflowSteps: ['Run the repository-declared verify workflow.'],
            repeated: true,
            projectSpecific: true,
            proceduralValue: true,
            verification: ['pnpm lint && pnpm test'],
          },
          {
            name: 'node-backend',
            decision: 'SKIP',
            evidenceIds: ['ev-package-manager'],
            skillAssessment: {
              taskSpecificity: 'low',
              rediscoveryCost: 'low',
              errorCost: 'low',
              reuseFrequency: 'low',
            },
            targetedFollowUpSearch: {
              queries: ['Node-specific project workflow'],
              paths: ['package.json'],
              result: 'Found a package-manager declaration but no Node-specific procedure.',
              evidenceIds: ['ev-package-manager'],
            },
            skipBasis: {
              dimensions: ['taskSpecificity', 'rediscoveryCost', 'reuseFrequency'],
              explanation: 'Repository evidence contains a technology label but no repeated task workflow or verification procedure.',
            },
            reason: 'A technology label alone is not a project-specific workflow.',
          },
        ],
      },
      {
        type: 'proposal',
        id: 'proposal-1',
        revision: 1,
        projectSummary: 'Node repository using pnpm.',
        unknowns: ['deployment-command'],
        warnings: [],
        nonGoals: ['business source', 'CI', 'Hooks', 'architecture refactoring'],
        validationPlan: ['scope', 'preservation', 'single-source', 'second-run'],
        actions: [
          {
            id: 'update-agents',
            action: 'UPDATE',
            kind: 'agents',
            target: 'AGENTS.md',
            reason: 'Record the evidenced package-manager constraint while preserving existing prose.',
            evidenceIds: ['ev-package-manager'],
            proposedDiff: renderExactDiff('AGENTS.md', agentsBefore, agentsContent),
            baselineFingerprint: agentsFingerprint,
            validation: ['existing prose remains'],
          },
          {
            id: 'create-claude',
            action: 'CREATE',
            kind: 'claude-adapter',
            target: 'CLAUDE.md',
            reason: 'Give Claude Code the shared AGENTS.md source of truth.',
            evidenceIds: ['ev-package-manager'],
            proposedContent: claudeContent,
            baselineFingerprint: 'missing',
            validation: ['contains @AGENTS.md'],
          },
          {
            id: 'create-skill',
            action: 'CREATE',
            kind: 'project-skill',
            target: '.agents/skills/build-verify/SKILL.md',
            skillName: 'build-verify',
            reason: 'The repository has a repeated project-specific validation workflow.',
            evidenceIds: ['ev-workflow'],
            proposedContent: skillContent,
            baselineFingerprint: 'missing',
            validation: ['metadata', 'workflow evidence'],
          },
          {
            id: 'link-skill',
            action: 'CREATE',
            kind: 'claude-skill-reference',
            target: '.claude/skills/build-verify',
            canonicalTarget: '.agents/skills/build-verify',
            linkText: '../../.agents/skills/build-verify',
            reason: 'Expose the canonical project Skill to Claude Code without duplicating it.',
            evidenceIds: ['ev-workflow'],
            proposedContent: 'relative symlink -> ../../.agents/skills/build-verify',
            baselineFingerprint: 'missing',
            validation: ['resolves to canonical Skill'],
          },
          {
            id: 'skip-node-skill',
            action: 'SKIP',
            kind: 'project-skill',
            target: '.agents/skills/node-backend/SKILL.md',
            reason: 'Node alone is not a project-specific workflow.',
            evidenceIds: ['ev-package-manager'],
            summary: 'Do not create a stack-label Skill.',
            decisionRequired: false,
          },
          {
            id: 'recommend-pnpm-guard',
            action: 'RECOMMEND',
            kind: 'guardrail',
            target: 'package-manager enforcement',
            reason: 'The package manager can be checked deterministically.',
            evidenceIds: ['ev-package-manager'],
            summary: 'Consider a script or CI check after separate approval.',
            decisionRequired: false,
            mechanism: 'script or CI check',
            impact: 'Rejects commands using another package manager.',
            falsePositiveRisk: 'May block intentional migration work.',
            validation: ['observe recommendation only; no Hook or CI write'],
          },
        ],
      },
      {
        type: 'approval',
        decision: 'approve',
        scope: 'exact-proposal',
        proposalId: 'proposal-1',
        revision: 1,
        approvedActionIds: ['update-agents', 'create-claude', 'create-skill', 'link-skill'],
      },
      {
        type: 'write',
        proposalId: 'proposal-1',
        revision: 1,
        actionId: 'update-agents',
        target: 'AGENTS.md',
        observedBeforeFingerprint: agentsFingerprint,
      },
      {
        type: 'write',
        proposalId: 'proposal-1',
        revision: 1,
        actionId: 'create-claude',
        target: 'CLAUDE.md',
        observedBeforeFingerprint: 'missing',
      },
      {
        type: 'write',
        proposalId: 'proposal-1',
        revision: 1,
        actionId: 'create-skill',
        target: '.agents/skills/build-verify/SKILL.md',
        observedBeforeFingerprint: 'missing',
      },
      {
        type: 'write',
        proposalId: 'proposal-1',
        revision: 1,
        actionId: 'link-skill',
        target: '.claude/skills/build-verify',
        observedBeforeFingerprint: 'missing',
        entryType: 'symlink',
        linkText: '../../.agents/skills/build-verify',
      },
      {
        type: 'validation',
        proposalId: 'proposal-1',
        revision: 1,
        passed: true,
        changedPaths: [
          '.agents/skills/build-verify/SKILL.md',
          '.claude/skills/build-verify',
          'AGENTS.md',
          'CLAUDE.md',
        ],
        forbiddenPathsChanged: [],
        preservationPassed: true,
        evidencePassed: true,
        singleSourcePassed: true,
        unknownsPreserved: true,
      },
      {
        type: 'reconcile',
        mode: 'dry-run',
        proposalActions: [
          { action: 'KEEP', target: 'AGENTS.md' },
          { action: 'KEEP', target: 'CLAUDE.md' },
          { action: 'KEEP', target: '.agents/skills/build-verify/SKILL.md' },
        ],
        writes: [],
      },
    ],
    externalAcceptance: {
      claudeCode: { status: 'not-run', evidence: null },
      codex: { status: 'not-run', evidence: null },
    },
  };
  const proposal = run.events.find((event) => event.type === 'proposal');
  run.events.find((event) => event.type === 'approval').proposalDigest = digestProposal(proposal);
  run.fixtureBytes = {
    baseline: {
      'package.json': '{"packageManager":"pnpm@9.0.0","scripts":{"verify":"pnpm lint && pnpm test"}}\n',
      'AGENTS.md': agentsBefore,
      '.claude/settings.json': settingsContent,
    },
    final: {
      'package.json': '{"packageManager":"pnpm@9.0.0","scripts":{"verify":"pnpm lint && pnpm test"}}\n',
      'AGENTS.md': agentsContent,
      '.claude/settings.json': settingsContent,
      'CLAUDE.md': claudeContent,
      '.agents/skills/build-verify/SKILL.md': skillContent,
    },
    symlinks: {
      '.claude/skills/build-verify': '../../.agents/skills/build-verify',
    },
  };
  return run;
}

async function materializeRun(run) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'aps-recorded-run-'));
  const roots = Object.fromEntries(
    ['initialRoot', 'proposalRoot', 'preWriteRoot', 'finalRoot']
      .map((name) => [name, path.join(temporary, name)]),
  );
  for (const root of Object.values(roots)) await mkdir(root, { recursive: true });

  async function materialize(root, files, symlinks = {}) {
    for (const [relative, content] of Object.entries(files)) {
      const absolute = path.join(root, relative);
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, content);
    }
    for (const [relative, linkText] of Object.entries(symlinks)) {
      const absolute = path.join(root, relative);
      await mkdir(path.dirname(absolute), { recursive: true });
      await symlink(linkText, absolute);
    }
  }

  for (const root of [roots.initialRoot, roots.proposalRoot, roots.preWriteRoot]) {
    await materialize(root, run.fixtureBytes.baseline);
  }
  await materialize(roots.finalRoot, run.fixtureBytes.final, run.fixtureBytes.symlinks);
  const beforeDigest = await fingerprintRepository(roots.initialRoot);
  run.events.find((event) => event.type === 'preflight').repositoryFingerprintBefore = beforeDigest;
  run.events.find((event) => event.type === 'explore').repositoryFingerprintAfter = beforeDigest;
  delete run.fixtureBytes;
  return { roots, cleanup: () => rm(temporary, { recursive: true, force: true }) };
}

async function evaluateRecordedRun(run, fixtureContract = fixture) {
  const subject = await materializeRun(run);
  try {
    return await evaluateRunRecord(fixtureContract, run, subject.roots);
  } finally {
    await subject.cleanup();
  }
}

test('fixture schema and a conforming recorded run pass local invariant evaluation', async () => {
  assert.deepEqual(validateFixtureManifest(fixture), []);

  const result = await evaluateRecordedRun(await goodRun());
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.deepEqual(result.errors, []);
  assert.equal(result.claims.recordedArtifactValidated, true);
  assert.equal(result.claims.claudeCodeBehaviorProven, false);
  assert.equal(result.claims.codexBehaviorProven, false);
});

test('evaluation boundary names external acceptance that local tests cannot claim', () => {
  assert.equal(EVALUATION_BOUNDARIES.local.staticSkillContract, 'automated');
  assert.equal(EVALUATION_BOUNDARIES.local.recordedRunInvariants, 'automated');
  assert.equal(EVALUATION_BOUNDARIES.external.claudeCodeDiscoveryAndInvocation, 'external-acceptance');
  assert.equal(EVALUATION_BOUNDARIES.external.codexDiscoveryAndInvocation, 'external-acceptance');
  assert.equal(EVALUATION_BOUNDARIES.external.approvalBehaviorInFreshSessions, 'external-acceptance');
});

test('recorded writes require a prior Proposal and exact approval', async (t) => {
  await t.test('write before Proposal is rejected', async () => {
    const run = await goodRun();
    const write = run.events.splice(run.events.findIndex((event) => event.type === 'write'), 1)[0];
    run.events.unshift(write);

    const result = await evaluateRecordedRun(run);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((message) => message.startsWith('PROPOSAL_GATE:')));
  });

  await t.test('vague acknowledgment is rejected', async () => {
    const run = await goodRun();
    const approval = run.events.find((event) => event.type === 'approval');
    approval.decision = 'looks-good';
    approval.scope = 'acknowledgment';

    const result = await evaluateRecordedRun(run);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((message) => message.startsWith('VAGUE_APPROVAL:')));
  });

  await t.test('a revised Proposal invalidates earlier approval', async () => {
    const run = await goodRun();
    const approvalIndex = run.events.findIndex((event) => event.type === 'approval');
    const revised = structuredClone(run.events.find((event) => event.type === 'proposal'));
    revised.revision = 2;
    revised.projectSummary = 'Revised project summary.';
    run.events.splice(approvalIndex + 1, 0, revised);

    const result = await evaluateRecordedRun(run);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((message) => message.startsWith('STALE_APPROVAL:')));
  });

  await t.test('target fingerprint drift stops Apply', async () => {
    const run = await goodRun();
    const write = run.events.find((event) => event.type === 'write' && event.target === 'AGENTS.md');
    write.observedBeforeFingerprint = 'sha256:changed-after-proposal';

    const result = await evaluateRecordedRun(run);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((message) => message.startsWith('FINGERPRINT_DRIFT:')));
  });
});

test('Apply binds every changed path to one approved write action', async (t) => {
  await t.test('an allowed-tree write without an exact approved target is rejected', async () => {
    const run = await goodRun();
    const write = run.events.find((event) => event.type === 'write' && event.target === 'AGENTS.md');
    write.target = '.agents/unapproved.md';

    const result = await evaluateRecordedRun(run);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((message) => message.startsWith('BLANKET_SCOPE:')));
  });

  await t.test('KEEP, SKIP, and RECOMMEND cannot become writes', async () => {
    for (const actionId of ['skip-node-skill', 'recommend-pnpm-guard']) {
      const run = await goodRun();
      const approval = run.events.find((event) => event.type === 'approval');
      approval.approvedActionIds.push(actionId);
      const validationIndex = run.events.findIndex((event) => event.type === 'validation');
      const proposal = run.events.find((event) => event.type === 'proposal');
      const action = proposal.actions.find((item) => item.id === actionId);
      run.events.splice(validationIndex, 0, {
        type: 'write',
        proposalId: proposal.id,
        revision: proposal.revision,
        actionId,
        target: action.target,
        observedBeforeFingerprint: 'missing',
      });

      const result = await evaluateRecordedRun(run);
      assert.equal(result.ok, false);
      assert.ok(result.errors.some((message) => message.startsWith('NON_WRITE_ACTION:')));
    }
  });

  await t.test('unapproved reformat or overwrite of existing configuration is rejected', async () => {
    const run = await goodRun();
    run.fixtureBytes.final['.claude/settings.json'] = '{\n  "hooks": {}\n}\n';

    const result = await evaluateRecordedRun(run);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((message) => (
      message.startsWith('CONFIG_OVERWRITE:') || message.startsWith('UNAPPROVED_REFORMAT:')
    )));
  });
});

test('physical write scope rejects symlink ancestors instead of following them', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aps-physical-scope-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'aps-physical-outside-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  await mkdir(path.join(root, '.agents'));
  await symlink(outside, path.join(root, '.agents', 'skills'));

  assert.deepEqual(await validateWriteTargetPhysicalScope(root, 'AGENTS.md'), []);
  const errors = await validateWriteTargetPhysicalScope(
    root,
    '.agents/skills/build-verify/SKILL.md',
  );
  assert.ok(errors.some((message) => message.startsWith('PATH_SCOPE:')));
});

test('evidence and Unknown boundaries reject unsupported generated knowledge', async (t) => {
  await t.test('confirmed facts require direct ledger evidence', async () => {
    const run = await goodRun();
    const fact = run.events.find((event) => event.type === 'profile').facts[0];
    fact.evidenceIds = [];

    const result = await evaluateRecordedRun(run);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((message) => message.startsWith('EVIDENCE:')));
  });

  await t.test('expected Unknowns cannot silently disappear', async () => {
    const run = await goodRun();
    run.events.find((event) => event.type === 'profile').unknowns = [];

    const result = await evaluateRecordedRun(run);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((message) => message.startsWith('UNKNOWN:')));
  });

  await t.test('a stack label cannot qualify as a generated Skill', async () => {
    const run = await goodRun();
    const candidate = run.events.find((event) => event.type === 'skills')
      .candidates.find((item) => item.name === 'node-backend');
    candidate.decision = 'CREATE';

    const result = await evaluateRecordedRun(run);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((message) => message.startsWith('STACK_TO_SKILL:')));
  });

  await t.test('commands not quoted by evidence are rejected as guesses', async () => {
    const run = await goodRun();
    const fact = run.events.find((event) => event.type === 'profile')
      .facts.find((item) => item.id === 'fact-verify');
    fact.value = 'pnpm deploy';

    const result = await evaluateRecordedRun(run);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((message) => message.startsWith('GUESSED_COMMAND:')));
  });
});

test('Skill candidates require evidence-backed qualitative assessment and search', async (t) => {
  await t.test('missing qualitative assessment is rejected', async () => {
    const run = await goodRun();
    const candidate = run.events.find((event) => event.type === 'skills')
      .candidates.find((item) => item.name === 'build-verify');
    delete candidate.skillAssessment;

    const result = await evaluateRecordedRun(run);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((message) => message.startsWith('SKILL_ASSESSMENT:')));
  });

  await t.test('missing targeted follow-up search is rejected', async () => {
    const run = await goodRun();
    const candidate = run.events.find((event) => event.type === 'skills')
      .candidates.find((item) => item.name === 'build-verify');
    delete candidate.targetedFollowUpSearch;

    const result = await evaluateRecordedRun(run);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((message) => message.startsWith('TARGETED_SEARCH:')));
  });

  await t.test('verification not quoted by candidate evidence is rejected', async () => {
    const run = await goodRun();
    const candidate = run.events.find((event) => event.type === 'skills')
      .candidates.find((item) => item.name === 'build-verify');
    candidate.verification = ['pnpm deploy'];

    const result = await evaluateRecordedRun(run);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((message) => message.startsWith('GUESSED_VERIFICATION:')));
  });

  await t.test('one low assessment dimension does not veto an evidenced workflow', async () => {
    const run = await goodRun();
    const candidate = run.events.find((event) => event.type === 'skills')
      .candidates.find((item) => item.name === 'build-verify');
    candidate.skillAssessment.rediscoveryCost = 'low';
    delete candidate.repeated;
    delete candidate.projectSpecific;
    delete candidate.proceduralValue;

    const result = await evaluateRecordedRun(run);
    assert.equal(result.ok, true, result.errors.join('\n'));
  });

  await t.test('discoverability or model familiarity alone is an ungrounded SKIP', async () => {
    for (const explanation of [
      'The model already knows this workflow, so skip it.',
      'The model already knows this repository task, so skip it.',
      'This procedure is discoverable, so skip it.',
    ]) {
      const run = await goodRun();
      const candidate = run.events.find((event) => event.type === 'skills')
        .candidates.find((item) => item.name === 'node-backend');
      candidate.reason = explanation;
      candidate.skipBasis = {
        dimensions: ['taskSpecificity'],
        explanation,
      };

      const result = await evaluateRecordedRun(run);
      assert.equal(result.ok, false);
      assert.ok(result.errors.some((message) => message.startsWith('UNGROUNDED_SKIP:')));
    }
  });

  await t.test('model familiarity in the top-level SKIP reason is rejected', async () => {
    const run = await goodRun();
    const candidate = run.events.find((event) => event.type === 'skills')
      .candidates.find((item) => item.name === 'node-backend');
    candidate.reason = 'The model already knows Redis, so skip it.';

    const result = await evaluateRecordedRun(run);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((message) => message.startsWith('UNGROUNDED_SKIP:')));
  });

  await t.test('an undeclared technology candidate is rejected', async () => {
    const run = await goodRun();
    const candidates = run.events.find((event) => event.type === 'skills').candidates;
    const unexpected = structuredClone(candidates.find((item) => item.name === 'node-backend'));
    unexpected.name = 'redis';
    candidates.push(unexpected);

    const result = await evaluateRecordedRun(run);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((message) => message.startsWith('UNEXPECTED_SKILL:')));
  });

  await t.test('duplicate candidate names are rejected', async () => {
    const run = await goodRun();
    const candidates = run.events.find((event) => event.type === 'skills').candidates;
    candidates.push(structuredClone(candidates.find((item) => item.name === 'node-backend')));

    const result = await evaluateRecordedRun(run);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((message) => message.startsWith('DUPLICATE_SKILL:')));
  });

  await t.test('creating over an expected existing Skill is rejected', async () => {
    const fixtureContract = structuredClone(fixture);
    const existingSkillEvidence = {
      id: 'ev-existing-release-skill',
      fact: 'A canonical release Skill already exists.',
      sourcePath: '.agents/skills/release/SKILL.md',
      sourceLocation: 'frontmatter and body',
      observation: 'existing release Skill is present and user-authored',
      whyItMatters: 'Existing workflow intent must be preserved instead of duplicated.',
    };
    fixtureContract.evidence.push(existingSkillEvidence);
    fixtureContract.expected.skillDecisions.push({
      name: 'release',
      action: 'KEEP',
      evidenceIds: ['ev-existing-release-skill'],
      skillAssessment: {
        taskSpecificity: 'high',
        rediscoveryCost: 'high',
        errorCost: 'high',
        reuseFrequency: 'medium',
      },
      targetedFollowUpSearch: {
        queries: ['existing release workflow'],
        paths: ['.agents/skills/release/SKILL.md'],
        result: 'Found a compatible existing release Skill.',
        evidenceIds: ['ev-existing-release-skill'],
      },
      reuseExisting: {
        path: '.agents/skills/release/SKILL.md',
        compatibility: 'compatible',
      },
    });
    const run = await goodRun();
    run.evidenceLedger.push({
      ...existingSkillEvidence,
      persistenceScope: 'WORKFLOW',
      deterministicEnforcementCandidate: false,
      destination: '.agents/skills/release/SKILL.md',
    });
    const source = run.events.find((event) => event.type === 'skills')
      .candidates.find((item) => item.name === 'build-verify');
    run.events.find((event) => event.type === 'skills').candidates.push({
      ...structuredClone(source),
      name: 'release',
      decision: 'CREATE',
    });

    const result = await evaluateRecordedRun(run, fixtureContract);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((message) => message.startsWith('DUPLICATE_SKILL:')));
  });

  await t.test('KEEP reuse path must be backed by matching evidence', async () => {
    const fixtureContract = structuredClone(fixture);
    fixtureContract.expected.skillDecisions.push({
      name: 'missing-reuse',
      action: 'KEEP',
      evidenceIds: ['ev-workflow'],
      skillAssessment: {
        taskSpecificity: 'high',
        rediscoveryCost: 'high',
        errorCost: 'high',
        reuseFrequency: 'medium',
      },
      targetedFollowUpSearch: {
        queries: ['existing missing workflow'],
        paths: ['.agents/skills/missing/SKILL.md'],
        result: 'Found a claimed existing workflow path.',
        evidenceIds: ['ev-workflow'],
      },
      reuseExisting: {
        path: '.agents/skills/missing/SKILL.md',
        compatibility: 'compatible',
      },
    });

    const errors = validateFixtureManifest(fixtureContract);
    assert.ok(errors.some((message) => message.startsWith('DUPLICATE_SKILL:')));
  });
});

test('generated assets and recommendations preserve v0.1 boundaries', async (t) => {
  await t.test('canonical Skill requires observable Verification content', async () => {
    const run = await goodRun();
    const proposal = run.events.find((event) => event.type === 'proposal');
    const action = proposal.actions.find((item) => item.id === 'create-skill');
    const emptyVerification = action.proposedContent.replace(/## Verification[\s\S]*$/, '## Verification\n');
    action.proposedContent = emptyVerification;
    run.fixtureBytes.final['.agents/skills/build-verify/SKILL.md'] = emptyVerification;
    run.events.find((event) => event.type === 'approval').proposalDigest = digestProposal(proposal);

    const result = await evaluateRecordedRun(run);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((message) => message.startsWith('PROJECT_SKILL:')));
  });

  await t.test('CLAUDE.md cannot duplicate a shared AGENTS.md rule', async () => {
    const run = await goodRun();
    const duplicated = '- Use pnpm@9.0.0.';
    const content = `@AGENTS.md\n\n## Shared rules\n\n${duplicated}\n`;
    run.fixtureBytes.final['CLAUDE.md'] = content;
    const proposal = run.events.find((event) => event.type === 'proposal');
    proposal.actions.find((action) => action.id === 'create-claude').proposedContent = content;
    run.events.find((event) => event.type === 'approval').proposalDigest = digestProposal(proposal);

    const result = await evaluateRecordedRun(run);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((message) => message.startsWith('DUPLICATED_RULES:')));
  });

  await t.test('Hook and CI actions remain recommendation-only', async () => {
    for (const forbidden of [
      { kind: 'hook', target: '.claude/settings.json' },
      { kind: 'ci', target: '.github/workflows/verify.yml' },
    ]) {
      const run = await goodRun();
      const proposal = run.events.find((event) => event.type === 'proposal');
      proposal.actions.push({
        id: `write-${forbidden.kind}`,
        action: 'UPDATE',
        kind: forbidden.kind,
        target: forbidden.target,
        reason: 'Automate an evidenced recommendation.',
        evidenceIds: ['ev-package-manager'],
        proposedDiff: '@@ automation',
        baselineFingerprint: 'sha256:before',
        validation: ['automation enabled'],
      });

      const result = await evaluateRecordedRun(run);
      assert.equal(result.ok, false);
      assert.ok(result.errors.some((message) => message.startsWith('FORBIDDEN_BEHAVIOR:')));
    }
  });

  await t.test('architecture analysis cannot propose a production refactor', async () => {
    const run = await goodRun();
    run.events.find((event) => event.type === 'proposal').actions.push({
      id: 'move-production-class',
      action: 'RECOMMEND',
      kind: 'move-class-refactor',
      target: 'src/domain/OrderService.java',
      reason: 'Move a class based on an architecture observation.',
      evidenceIds: ['ev-workflow'],
      summary: 'Move the class into a new business module.',
      validation: ['production rewritten'],
    });

    const result = await evaluateRecordedRun(run);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((message) => message.startsWith('ARCHITECTURE_REFACTOR:')));
  });

  await t.test('an unchanged second run accepts non-writing decisions with zero writes', async () => {
    const run = await goodRun();
    const reconcile = run.events.find((event) => event.type === 'reconcile');
    reconcile.proposalActions.push(
      { action: 'SKIP', target: '.agents/skills/node-backend/SKILL.md' },
      { action: 'RECOMMEND', target: 'package-manager enforcement' },
    );

    const result = await evaluateRecordedRun(run);
    assert.equal(result.ok, true, result.errors.join('\n'));
  });

  await t.test('an unchanged second run cannot contain write actions', async () => {
    const run = await goodRun();
    const reconcile = run.events.find((event) => event.type === 'reconcile');
    reconcile.proposalActions.push({ action: 'UPDATE', target: 'AGENTS.md' });
    reconcile.writes.push('AGENTS.md');

    const result = await evaluateRecordedRun(run);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((message) => message.startsWith('IDEMPOTENCY:')));
  });
});

export { fixture, goodRun };
