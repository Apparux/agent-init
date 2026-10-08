// Request grammar only. Observations, decisions and payloads are never filled from an oracle.
const text = { type: 'string' };
const boolean = { type: 'boolean' };
const jsonValue = { type: ['null', 'boolean', 'number', 'string', 'array', 'object'] };
const list = (items = text) => ({ type: 'array', items });
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const scope = { type: 'string', enum: ['GLOBAL', 'WORKFLOW', 'DISCOVERABLE', 'ARCHITECTURE', 'NONE', 'Unknown'] };
const unknown = { anyOf: [text, object({ id: text })] };

const candidate = object({
  name: text, decision: { enum: ['CREATE', 'UPDATE', 'KEEP', 'SKIP'] }, reason: text, evidenceIds: list(),
  skillAssessment: object(Object.fromEntries(['taskSpecificity', 'rediscoveryCost', 'errorCost', 'reuseFrequency'].map((name) => [name, { enum: ['low', 'medium', 'high', 'unknown'] }]))),
  targetedFollowUpSearch: object({ queries: list(), paths: list(), result: text, evidenceIds: list() }),
  routing: object({ description: text, positiveIntents: list(), negativeIntents: list() }),
  taskTriggers: list(), whenNotToUse: list(), workflowSteps: list(), verification: list(),
  skipBasis: object({ dimensions: list(), explanation: text }),
  reuseExisting: object({ path: text, compatibility: text }),
}, ['name', 'decision', 'reason', 'evidenceIds', 'skillAssessment', 'targetedFollowUpSearch']);

const actionFields = { id: text, action: text, kind: text, target: text, reason: text, evidenceIds: list(), skillCandidate: candidate,
  canonicalTarget: text, linkText: text, fallbackMode: { enum: ['managed-copy'] } };
const action = { anyOf: [
  object({ ...actionFields, action: { const: 'CREATE' }, baselineFingerprint: { const: 'missing' }, proposedContent: text },
    ['id', 'action', 'kind', 'target', 'reason', 'evidenceIds', 'baselineFingerprint', 'proposedContent']),
  object({ ...actionFields, action: { const: 'UPDATE' }, baselineFingerprint: text, proposedDiff: text },
    ['id', 'action', 'kind', 'target', 'reason', 'evidenceIds', 'baselineFingerprint', 'proposedDiff']),
  object({ ...actionFields, action: { enum: ['KEEP', 'SKIP', 'RECOMMEND'] }, summary: text, mechanism: text, impact: text, falsePositiveRisk: text },
    ['id', 'action', 'kind', 'target', 'reason', 'evidenceIds', 'summary']),
] };

const proposal = object({
  type: { const: 'proposal' }, id: text, revision: { type: 'integer', minimum: 1 }, projectSummary: text,
  unknowns: list(unknown), warnings: list(), nonGoals: list(), validationPlan: list(), actions: list(action),
});
const validation = object({
  type: { const: 'validation' }, passed: boolean, changedPaths: list(), forbiddenPathsChanged: list(),
  preservationPassed: boolean, evidencePassed: boolean, singleSourcePassed: boolean, unknownsPreserved: boolean,
});
const write = object({
  type: { const: 'write' }, proposalId: text, revision: { type: 'integer' }, actionId: text, target: text, observedBeforeFingerprint: text,
});
const events = [
  object({ type: { const: 'preflight' }, readOnly: { const: true }, baselineId: text,
    git: object({ isRepository: boolean, staged: list(), unstaged: list(), untracked: list() }), existingAgentAssets: list(), repositoryFingerprintBefore: text }),
  object({ type: { const: 'explore' }, readOnly: { const: true }, strategy: list(), sensitiveFiles: { const: 'presence-only' }, repositoryFingerprintAfter: text }),
  object({ type: { const: 'profile' }, facts: list(object({ id: text, value: jsonValue, status: text, evidenceIds: list() })), unknowns: list(unknown) }),
  object({ type: { const: 'classify' }, decisions: list(object({ factId: text, persistenceScope: scope, deterministicEnforcementCandidate: boolean, destination: { type: ['string', 'null'] } })) }),
  object({ type: { const: 'skills' }, candidates: list(candidate) }),
  proposal,
];

export function setupProposalSchema(fixtureId, evidenceMode = 'fixture-exact') {
  const sourceCitation = { anyOf: [
    object({ kind: { const: 'bytes' }, start: { type: 'integer', minimum: 0 }, end: { type: 'integer', minimum: 1 }, quote: { ...text, minLength: 1 } }),
    object({ kind: { const: 'presence' }, type: { enum: ['file', 'directory', 'missing'] } }),
  ] };
  return object({
    schemaVersion: { const: 1 }, kind: { const: 'setup-proposal' },
    record: object({
      schemaVersion: { const: 1 }, fixtureId: { const: fixtureId }, harness: { const: 'recorded-contract' },
      evidenceLedger: list(object({ id: text, fact: text, sourcePath: text, sourceLocation: text, observation: text, whyItMatters: text,
        persistenceScope: scope, deterministicEnforcementCandidate: boolean, destination: { type: ['string', 'null'] },
        ...(evidenceMode === 'source-bound' ? { sourceCitation } : {}) })),
      events: { ...list({ anyOf: events }), minItems: 6, maxItems: 6,
        description: 'Exactly preflight, explore, profile, classify, skills, proposal, in that order. No approval/write/validation/reconcile is observed yet.' },
      externalAcceptance: object({ claudeCode: object({ status: { const: 'not-run' }, evidence: { type: 'null' } }), codex: object({ status: { const: 'not-run' }, evidence: { type: 'null' } }) }),
    }),
    summary: object({ proposalId: text, revision: { type: 'integer' }, actionIds: list() }),
    audit: object({ proposalDigest: text }),
  });
}

export function setupValidationSchema(willApply) {
  return object({ schemaVersion: { const: 1 }, kind: { const: willApply ? 'setup-apply' : 'setup-validation' },
    events: { ...list({ anyOf: willApply ? [write, validation] : [validation] }), minItems: 1,
      description: 'Only actually observed approved writes, followed by one actual validation event; unapproved phases have no write events.' } });
}

export function setupReconcileSchema() {
  return object({ schemaVersion: { const: 1 }, kind: { const: 'setup-reconcile' }, event: object({
    type: { const: 'reconcile' }, mode: { const: 'dry-run' }, proposalActions: list(action), writes: list(write),
  }) });
}

export function setupContractLabels(fixture) {
  return {
    evidenceSlots: fixture.evidence.map(({ id, sourcePath, sourceLocation }) => ({ id, sourcePath, sourceLocation })),
    factSlots: (fixture.expected.facts ?? []).map(({ id, evidenceIds }) => ({ id, evidenceIds: [...evidenceIds] })),
    unclassifiedQuestions: [...(fixture.expected.unknowns ?? [])],
  };
}
