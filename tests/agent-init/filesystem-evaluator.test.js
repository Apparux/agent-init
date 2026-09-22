import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  digestProposal,
  evaluateRunRecord,
  fingerprintPath,
  fingerprintRepository,
  renderExactDiff,
  validateWriteTargetPhysicalScope,
} from './evaluation-harness.js';

const fixture = {
  schemaVersion: 1,
  id: 'filesystem-contract',
  repository: 'repository',
  purpose: 'Exercise filesystem-backed evaluation.',
  evidence: [{
    id: 'ev-policy',
    fact: 'The repository requires pnpm.',
    sourcePath: 'package.json',
    sourceLocation: 'packageManager',
    observation: 'packageManager is pnpm@9.0.0',
    whyItMatters: 'The package manager is a pre-action constraint.',
  }],
  expected: {
    facts: [{
      id: 'fact-policy',
      value: 'pnpm@9.0.0',
      status: 'confirmed',
      evidenceIds: ['ev-policy'],
    }],
    unknowns: ['deployment-command'],
    classifications: [{
      factId: 'fact-policy',
      persistenceScope: 'GLOBAL',
      deterministicEnforcementCandidate: true,
      destination: 'AGENTS.md',
    }],
    skillDecisions: [],
    allowedActions: [
      { action: 'UPDATE', target: 'AGENTS.md' },
      { action: 'CREATE', target: 'CLAUDE.md' },
    ],
    forbiddenPaths: ['package.json', 'src/', '.github/'],
    preservation: [{
      path: 'AGENTS.md',
      mode: 'contains',
      requiredText: ['Keep this user-authored rule.'],
    }],
    secondRun: 'NO_WRITE_ACTIONS',
  },
};

async function writeBaseline(root) {
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'package.json'), '{"packageManager":"pnpm@9.0.0"}\n');
  await writeFile(path.join(root, 'AGENTS.md'), '# Existing\n\nKeep this user-authored rule.\n');
}

async function createCase() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'aps-evaluator-'));
  const initialRoot = path.join(temporary, 'initial');
  const proposalRoot = path.join(temporary, 'proposal');
  const preWriteRoot = path.join(temporary, 'pre-write');
  const finalRoot = path.join(temporary, 'final');
  await writeBaseline(initialRoot);
  await cp(initialRoot, proposalRoot, { recursive: true, verbatimSymlinks: true });
  await cp(initialRoot, preWriteRoot, { recursive: true, verbatimSymlinks: true });
  await cp(initialRoot, finalRoot, { recursive: true, verbatimSymlinks: true });

  const beforeAgents = '# Existing\n\nKeep this user-authored rule.\n';
  const afterAgents = '# Existing\n\n- Use pnpm@9.0.0.\n\nKeep this user-authored rule.\n';
  const claudeContent = '@AGENTS.md\n';
  await writeFile(path.join(finalRoot, 'AGENTS.md'), afterAgents);
  await writeFile(path.join(finalRoot, 'CLAUDE.md'), claudeContent);

  const proposal = {
    type: 'proposal',
    id: 'proposal-fs',
    revision: 1,
    projectSummary: 'pnpm repository.',
    unknowns: ['deployment-command'],
    warnings: [],
    nonGoals: ['business source', 'CI', 'Hooks'],
    validationPlan: ['scope', 'preservation', 'second-run'],
    actions: [
      {
        id: 'update-agents',
        action: 'UPDATE',
        kind: 'agents',
        target: 'AGENTS.md',
        reason: 'Persist the evidenced package-manager policy.',
        evidenceIds: ['ev-policy'],
        proposedDiff: renderExactDiff('AGENTS.md', beforeAgents, afterAgents),
        baselineFingerprint: await fingerprintPath(proposalRoot, 'AGENTS.md'),
        validation: ['user prose remains'],
      },
      {
        id: 'create-claude',
        action: 'CREATE',
        kind: 'claude-adapter',
        target: 'CLAUDE.md',
        reason: 'Expose the shared rules to Claude Code.',
        evidenceIds: ['ev-policy'],
        proposedContent: claudeContent,
        baselineFingerprint: await fingerprintPath(proposalRoot, 'CLAUDE.md'),
        validation: ['thin adapter'],
      },
    ],
  };

  const run = {
    schemaVersion: 1,
    fixtureId: fixture.id,
    harness: 'recorded-contract',
    evidenceLedger: fixture.evidence.map((record) => ({
      ...record,
      persistenceScope: 'GLOBAL',
      deterministicEnforcementCandidate: true,
      destination: 'AGENTS.md',
    })),
    events: [
      {
        type: 'preflight',
        readOnly: true,
        baselineId: 'baseline-fs',
        git: { isRepository: false, staged: [], unstaged: [], untracked: [] },
        existingAgentAssets: ['AGENTS.md'],
        repositoryFingerprintBefore: await fingerprintRepository(initialRoot),
      },
      {
        type: 'explore',
        readOnly: true,
        strategy: ['search', 'read-relevant', 'cross-check'],
        sensitiveFiles: 'presence-only',
        repositoryFingerprintAfter: await fingerprintRepository(proposalRoot),
      },
      {
        type: 'profile',
        facts: fixture.expected.facts,
        unknowns: [{ id: 'deployment-command' }],
      },
      { type: 'classify', decisions: fixture.expected.classifications },
      { type: 'skills', candidates: [] },
      proposal,
      {
        type: 'approval',
        decision: 'approve',
        scope: 'exact-proposal',
        proposalId: proposal.id,
        revision: proposal.revision,
        proposalDigest: digestProposal(proposal),
        approvedActionIds: ['update-agents', 'create-claude'],
      },
      {
        type: 'write',
        proposalId: proposal.id,
        revision: proposal.revision,
        actionId: 'update-agents',
        target: 'AGENTS.md',
        observedBeforeFingerprint: await fingerprintPath(preWriteRoot, 'AGENTS.md'),
      },
      {
        type: 'write',
        proposalId: proposal.id,
        revision: proposal.revision,
        actionId: 'create-claude',
        target: 'CLAUDE.md',
        observedBeforeFingerprint: await fingerprintPath(preWriteRoot, 'CLAUDE.md'),
      },
      {
        type: 'validation',
        passed: true,
        changedPaths: ['AGENTS.md', 'CLAUDE.md'],
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
        ],
        writes: [],
      },
    ],
    externalAcceptance: {
      claudeCode: { status: 'not-run', evidence: null },
      codex: { status: 'not-run', evidence: null },
    },
  };

  return {
    run,
    roots: { initialRoot, proposalRoot, preWriteRoot, finalRoot },
    cleanup: () => rm(temporary, { recursive: true, force: true }),
  };
}

async function withCase(callback) {
  const subject = await createCase();
  try {
    return await callback(subject);
  } finally {
    await subject.cleanup();
  }
}

test('fingerprints are computed from physical file, directory, symlink, and missing states', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aps-fingerprint-'));
  try {
    await writeFile(path.join(root, 'file.txt'), 'known bytes');
    await mkdir(path.join(root, 'tree'));
    await writeFile(path.join(root, 'tree', 'a.txt'), 'A');
    await symlink('file.txt', path.join(root, 'link'));

    const expected = createHash('sha256').update('known bytes').digest('hex');
    assert.equal(await fingerprintPath(root, 'file.txt'), `sha256:${expected}`);
    assert.match(await fingerprintPath(root, 'tree'), /^tree-sha256:[a-f0-9]{64}$/);
    assert.match(await fingerprintPath(root, 'link'), /^symlink-sha256:[a-f0-9]{64}$/);
    assert.equal(await fingerprintPath(root, 'missing.txt'), 'missing');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a conforming run is validated against physical before and final repositories', async () => {
  await withCase(async ({ run, roots }) => {
    const result = await evaluateRunRecord(fixture, run, roots);
    assert.equal(result.ok, true, result.errors.join('\n'));
  });
});

test('arbitrary fingerprints and approval digests cannot self-attest', async (t) => {
  await t.test('arbitrary Proposal baseline is rejected', async () => {
    await withCase(async ({ run, roots }) => {
      run.events.find((event) => event.type === 'proposal').actions[0].baselineFingerprint = 'sha256:caller-label';
      const result = await evaluateRunRecord(fixture, run, roots);
      assert.ok(result.errors.some((message) => message.startsWith('FINGERPRINT:')));
    });
  });

  await t.test('approval must bind the exact Proposal payload', async () => {
    await withCase(async ({ run, roots }) => {
      run.events.find((event) => event.type === 'approval').proposalDigest = 'sha256:caller-label';
      const result = await evaluateRunRecord(fixture, run, roots);
      assert.ok(result.errors.some((message) => message.startsWith('APPROVAL_PAYLOAD:')));
    });
  });
});

test('final bytes and write ordering must match every exact approved action', async (t) => {
  await t.test('different final bytes are rejected', async () => {
    await withCase(async ({ run, roots }) => {
      await writeFile(path.join(roots.finalRoot, 'CLAUDE.md'), '@AGENTS.md\n\nUnapproved content.\n');
      const result = await evaluateRunRecord(fixture, run, roots);
      assert.ok(result.errors.some((message) => message.startsWith('PAYLOAD_MISMATCH:')));
    });
  });

  await t.test('an approved action with no write event is rejected', async () => {
    await withCase(async ({ run, roots }) => {
      run.events = run.events.filter((event) => event.actionId !== 'create-claude');
      const result = await evaluateRunRecord(fixture, run, roots);
      assert.ok(result.errors.some((message) => message.startsWith('APPROVED_WRITE_MISSING:')));
    });
  });

  await t.test('approval after a write does not authorize it', async () => {
    await withCase(async ({ run, roots }) => {
      const approvalIndex = run.events.findIndex((event) => event.type === 'approval');
      const [approval] = run.events.splice(approvalIndex, 1);
      const validationIndex = run.events.findIndex((event) => event.type === 'validation');
      run.events.splice(validationIndex, 0, approval);
      const result = await evaluateRunRecord(fixture, run, roots);
      assert.ok(result.errors.some((message) => message.startsWith('APPROVAL_GATE:')));
    });
  });
});

test('physical repository evidence is mandatory and target symlinks fail closed', async (t) => {
  await t.test('writable run without all physical roots is rejected', async () => {
    await withCase(async ({ run, roots }) => {
      const result = await evaluateRunRecord(fixture, run, { finalRoot: roots.finalRoot });
      assert.ok(result.errors.some((message) => message.startsWith('PHYSICAL_EVIDENCE:')));
    });
  });

  await t.test('a symlink at the existing write target is rejected', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aps-target-link-'));
    const outside = await mkdtemp(path.join(os.tmpdir(), 'aps-target-outside-'));
    try {
      await writeFile(path.join(outside, 'AGENTS.md'), 'external');
      await symlink(path.join(outside, 'AGENTS.md'), path.join(root, 'AGENTS.md'));
      const errors = await validateWriteTargetPhysicalScope(root, 'AGENTS.md');
      assert.ok(errors.some((message) => message.startsWith('PATH_SCOPE:')));
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test('external acceptance rejects arbitrary strings and requires structured named artifacts', async () => {
  await withCase(async ({ run, roots }) => {
    run.externalAcceptance.claudeCode = {
      status: 'recorded-external',
      evidence: 'some transcript',
    };
    const result = await evaluateRunRecord(fixture, run, roots);
    assert.ok(result.errors.some((message) => message.startsWith('EXTERNAL_ACCEPTANCE:')));
  });
});
