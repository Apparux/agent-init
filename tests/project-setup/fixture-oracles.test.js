import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  digestProposal,
  evaluateRunRecord,
  fingerprintRepository,
} from './evaluation-harness.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesRoot = path.resolve(here, '../fixtures');
const fixtureNames = [
  '01-java-maven-simple',
  '02-java-maven-monorepo',
  '03-node-pnpm',
  '04-python',
  '05-existing-agents',
  '06-existing-claude',
  '07-existing-both',
  '08-existing-skills',
  '09-no-git',
  '10-mixed-monorepo',
];

async function loadFixture(name) {
  return JSON.parse(await readFile(path.join(fixturesRoot, name, 'fixture.json'), 'utf8'));
}

function makeCandidate(decision, fixture) {
  if (!['CREATE', 'UPDATE'].includes(decision.action)) {
    return {
      name: decision.name,
      decision: decision.action,
      reason: decision.reason,
    };
  }
  return {
    name: decision.name,
    decision: decision.action,
    evidenceIds: [fixture.evidence[0].id],
    taskTriggers: ['the named project workflow is requested'],
    whenNotToUse: ['the task does not require that workflow'],
    repeated: true,
    projectSpecific: true,
    proceduralValue: true,
    verification: ['use the fixture-declared verification evidence'],
  };
}

async function makeOracleRun(fixture) {
  const classificationByFact = new Map(
    fixture.expected.classifications.map((classification) => [classification.factId, classification]),
  );
  const evidenceById = new Map(fixture.evidence.map((record) => [record.id, record]));
  const evidenceScopeById = new Map();
  for (const fact of fixture.expected.facts) {
    const classification = classificationByFact.get(fact.id);
    for (const evidenceId of fact.evidenceIds ?? []) {
      evidenceScopeById.set(evidenceId, classification ?? {
        persistenceScope: 'Unknown',
        deterministicEnforcementCandidate: false,
        destination: null,
      });
    }
  }

  const proposal = {
    type: 'proposal',
    id: `oracle-${fixture.id}`,
    revision: 1,
    projectSummary: fixture.purpose,
    unknowns: fixture.expected.unknowns,
    warnings: [],
    nonGoals: fixture.expected.forbiddenPaths,
    validationPlan: ['fixture oracle', 'scope', 'second-run'],
    actions: fixture.expected.allowedActions
      .filter((action) => !['CREATE', 'UPDATE'].includes(action.action))
      .map((action, index) => {
        const evidenceId = fixture.evidence[index % fixture.evidence.length].id;
        const record = {
          id: `oracle-action-${index}`,
          action: action.action,
          kind: action.action === 'RECOMMEND' ? 'guardrail' : 'project-skill',
          target: action.target,
          reason: 'Fixture-declared local decision oracle.',
          evidenceIds: [evidenceId],
          summary: 'No filesystem mutation in this local oracle run.',
          decisionRequired: false,
          validation: ['recorded decision only'],
        };
        if (record.kind === 'guardrail') {
          record.mechanism = 'script or CI check after separate approval';
          record.impact = 'Would deterministically check the evidenced rule.';
          record.falsePositiveRisk = 'Could block intentional migration work.';
        }
        return record;
      }),
  };

  return {
    schemaVersion: 1,
    fixtureId: fixture.id,
    harness: 'recorded-contract',
    evidenceLedger: fixture.evidence.map((record) => {
      const classification = evidenceScopeById.get(record.id) ?? {
        persistenceScope: 'Unknown',
        deterministicEnforcementCandidate: false,
        destination: null,
      };
      return { ...record, ...classification };
    }),
    events: [
      {
        type: 'preflight',
        readOnly: true,
        baselineId: `baseline-${fixture.id}`,
        git: { isRepository: false, staged: [], unstaged: [], untracked: [] },
        existingAgentAssets: fixture.expected.detection.agentConfigPaths,
        repositoryFingerprintBefore: null,
      },
      {
        type: 'explore',
        readOnly: true,
        strategy: ['search', 'read-relevant', 'cross-check'],
        sensitiveFiles: 'presence-only',
        repositoryFingerprintAfter: null,
      },
      {
        type: 'profile',
        facts: fixture.expected.facts,
        unknowns: fixture.expected.unknowns.map((id) => ({ id })),
      },
      { type: 'classify', decisions: fixture.expected.classifications },
      { type: 'skills', candidates: fixture.expected.skillDecisions.map((decision) => makeCandidate(decision, fixture)) },
      proposal,
      {
        type: 'approval',
        decision: 'reject',
        scope: 'exact-proposal',
        proposalId: proposal.id,
        revision: proposal.revision,
        proposalDigest: digestProposal(proposal),
        approvedActionIds: [],
      },
      {
        type: 'validation',
        passed: true,
        changedPaths: [],
        forbiddenPathsChanged: [],
        preservationPassed: true,
        evidencePassed: true,
        singleSourcePassed: true,
        unknownsPreserved: true,
      },
      { type: 'reconcile', mode: 'dry-run', proposalActions: [], writes: [] },
    ],
    externalAcceptance: {
      claudeCode: { status: 'not-run', evidence: null },
      codex: { status: 'not-run', evidence: null },
    },
  };
}

test('each fixture has a conforming local decision oracle and an independent bad artifact', async (t) => {
  for (const name of fixtureNames) {
    await t.test(name, async () => {
      const fixture = await loadFixture(name);
      const temporary = await mkdtemp(path.join(os.tmpdir(), `aps-oracle-${name}-`));
      try {
        const roots = Object.fromEntries(
          ['initialRoot', 'proposalRoot', 'preWriteRoot', 'finalRoot']
            .map((key) => [key, path.join(temporary, key)]),
        );
        const source = path.join(fixturesRoot, name, fixture.repository);
        for (const root of Object.values(roots)) {
          await cp(source, root, { recursive: true, verbatimSymlinks: true });
        }
        const digest = await fingerprintRepository(roots.initialRoot);
        const good = await makeOracleRun(fixture);
        good.events.find((event) => event.type === 'preflight').repositoryFingerprintBefore = digest;
        good.events.find((event) => event.type === 'explore').repositoryFingerprintAfter = digest;

        const result = await evaluateRunRecord(fixture, good, roots);
        assert.equal(result.ok, true, result.errors.join('\n'));
        assert.equal(result.claims.localContractValidated, true);
        assert.equal(result.claims.liveSkillBehaviorProven, false);
        assert.equal(result.claims.claudeCodeBehaviorProven, false);
        assert.equal(result.claims.codexBehaviorProven, false);

        const bad = structuredClone(good);
        let expectedCode;
        if (fixture.expected.unknowns.length > 0) {
          bad.events.find((event) => event.type === 'profile').unknowns.shift();
          expectedCode = 'UNKNOWN:';
        } else if (fixture.expected.classifications.length > 0) {
          bad.events.find((event) => event.type === 'classify').decisions[0].persistenceScope = 'NONE';
          expectedCode = 'CLASSIFICATION:';
        } else {
          bad.events.find((event) => event.type === 'preflight').readOnly = false;
          expectedCode = 'READ_ONLY:';
        }
        const rejected = await evaluateRunRecord(fixture, bad, roots);
        assert.equal(rejected.ok, false);
        assert.ok(rejected.errors.some((message) => message.startsWith(expectedCode)));
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    });
  }
});
