// Deliberate synthetic observations. Never read corpus expectations or a model response.
const observations = {
  'node-build-verify-positive-01': ['build-verify'],
  'node-build-verify-negative-01': [],
  'node-build-verify-near-miss-01': [],
  'node-build-verify-deployment-collision-01': ['build-verify', 'deployment'],
  'maven-build-verify-positive-01': ['build-verify'],
  'maven-build-verify-negative-01': [],
  'maven-build-verify-near-miss-01': [],
  'maven-build-verify-migration-collision-01': ['build-verify', 'database-migration'],
  'database-migration-positive-01': ['database-migration'],
  'database-migration-negative-01': [],
  'database-migration-near-miss-01': [],
  'database-migration-audit-log-collision-01': ['database-migration', 'audit-log'],
  'audit-log-positive-01': ['audit-log'],
  'audit-log-negative-01': [],
  'audit-log-near-miss-01': [],
  'audit-log-migration-collision-01': ['audit-log', 'database-migration'],
  'deployment-positive-01': ['deployment'],
  'deployment-negative-01': [],
  'deployment-near-miss-01': [],
  'deployment-node-build-verify-collision-01': ['deployment', 'build-verify'],
  'redis-no-skill-negative-01': [],
  '03-node-pnpm-build-verify-explicit-01': ['build-verify'],
  '11-maven-multi-module-build-verify-build-verify-explicit-01': ['build-verify'],
  '12-flyway-database-migration-database-migration-explicit-01': ['database-migration'],
  '13-audit-log-audit-log-explicit-01': ['audit-log'],
  '15-deployment-deployment-explicit-01': ['deployment'],
};

export async function syntheticRoutingSession(request) {
  if (request.phase === 'close') return { closed: true };
  const loaded = observations[request.id];
  if (request.phase !== 'routing' || !loaded) return { status: 'missing', evidenceSource: 'test-double' };
  return { status: 'observed', evidenceSource: 'test-double', sessionId: request.sessionId, id: request.id,
    selectionEvidence: { loaded: [...loaded] } };
}
