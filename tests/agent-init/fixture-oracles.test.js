import assert from 'node:assert/strict';
import { chmod, cp, link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  digestProposal,
  evaluateRunRecord,
  fingerprintPath,
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
  '11-maven-multi-module-build-verify',
  '12-flyway-database-migration',
  '13-audit-log',
  '14-redis-no-skill',
  '15-deployment',
];

async function loadFixture(name) {
  return JSON.parse(await readFile(path.join(fixturesRoot, name, 'fixture.json'), 'utf8'));
}

function makeCandidate(decision) {
  const { action, ...candidate } = structuredClone(decision);
  return { ...candidate, decision: action };
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
      { type: 'skills', candidates: fixture.expected.skillDecisions.map(makeCandidate) },
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
    await t.test(name, async (t) => {
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

        await t.test('synthetic recorded JSON preserves fixture facts without proving live behavior', async () => {
          const recorded = JSON.parse(JSON.stringify(good));
          const recordedResult = await evaluateRunRecord(fixture, recorded, roots);
          assert.equal(recordedResult.ok, true, recordedResult.errors.join('\n'));
          assert.deepEqual(recordedResult.errors, []);
          assert.equal(recordedResult.claims.localContractValidated, true);
          assert.equal(recordedResult.claims.liveSkillBehaviorProven, false);
          assert.equal(recordedResult.claims.claudeCodeBehaviorProven, false);
          assert.equal(recordedResult.claims.codexBehaviorProven, false);
        });

        if (name === '12-flyway-database-migration') {
          for (const [label, mutation] of [
            ['a changed migration', { value: ['V1__create_orders.sql', 'V3__create_users.sql'] }],
            ['a changed migration order', { value: ['V2__add_order_status.sql', 'V1__create_orders.sql'] }],
            ['a changed migration value type', { value: 'V1__create_orders.sql,V2__add_order_status.sql' }],
            ['a changed fact status', { status: 'unknown' }],
          ]) {
            await t.test(`synthetic recorded JSON rejects ${label}`, async () => {
              const changed = JSON.parse(JSON.stringify(good));
              const fact = changed.events.find((event) => event.type === 'profile')
                .facts.find((item) => item.id === 'fact-published-migrations');
              Object.assign(fact, mutation);
              const rejected = await evaluateRunRecord(fixture, changed, roots);
              assert.equal(rejected.ok, false);
              assert.deepEqual(rejected.errors, ['PROFILE: fact fact-published-migrations does not match the fixture contract']);
              assert.equal(rejected.claims.localContractValidated, false);
              assert.equal(rejected.claims.liveSkillBehaviorProven, false);
              assert.equal(rejected.claims.claudeCodeBehaviorProven, false);
              assert.equal(rejected.claims.codexBehaviorProven, false);
            });
          }
        }

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

async function withSourceBoundRun(name, callback, customize) {
  const fixture = await loadFixture(name);
  let source = path.join(fixturesRoot, fixture.id, fixture.repository);
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'aps-source-bound-'));
  try {
    if (customize) {
      const copy = path.join(temporary, 'original');
      await cp(source, copy, { recursive: true, verbatimSymlinks: true });
      source = copy;
      await customize({ fixture, source, temporary });
    }
    const roots = Object.fromEntries(['initialRoot', 'proposalRoot', 'preWriteRoot', 'finalRoot']
      .map((key) => [key, path.join(temporary, key)]));
    for (const root of Object.values(roots)) await cp(source, root, { recursive: true, verbatimSymlinks: true });
    const original = await lstat(source);
    const binding = {
      repositoryRoot: source, fixtureDigest: digestProposal(fixture), identity: { dev: original.dev, ino: original.ino }, sources: [],
    };
    const run = JSON.parse(JSON.stringify(await makeOracleRun(fixture)));
    const digest = await fingerprintRepository(roots.initialRoot);
    run.events[0].repositoryFingerprintBefore = digest;
    run.events[1].repositoryFingerprintAfter = digest;
    for (const entry of run.evidenceLedger) {
      let stat;
      try { stat = await lstat(path.join(source, entry.sourcePath)); }
      catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
      const type = !stat ? 'missing' : stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : 'unsupported';
      const descriptor = { id: entry.id, type, ...(stat ? { dev: stat.dev, ino: stat.ino, mode: stat.mode & 0o7777 } : {}) };
      entry.fact = 'An independently inspected repository declaration supports this fact.';
      entry.observation = 'I inspected the original evidence without copying the fixture narration.';
      entry.whyItMatters = 'This citation is relevant to the repository-specific decision.';
      if (type !== 'file' || entry.sourceLocation === 'presence' || path.posix.basename(entry.sourcePath).startsWith('.env')) {
        entry.sourceCitation = { kind: 'presence', type };
      } else {
        const bytes = await readFile(path.join(source, entry.sourcePath));
        descriptor.fingerprint = await fingerprintPath(source, entry.sourcePath);
        entry.sourceCitation = { kind: 'bytes', start: 0, end: bytes.length, quote: bytes.toString('utf8') };
      }
      binding.sources.push(descriptor);
    }
    await callback({ fixture, source, run, roots, binding, temporary, options: { ...roots, evidenceMode: 'source-bound', sourceBinding: binding } });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

test('source-bound ledger accepts independent descriptions with original physical citations', async () => {
  await withSourceBoundRun('03-node-pnpm', async ({ fixture, run, roots, options }) => {
    const before = JSON.stringify(run);
    const result = await evaluateRunRecord(fixture, run, options);
    assert.equal(result.ok, true, result.errors.join('\n'));
    assert.equal(result.claims.localContractValidated, true);
    assert.equal(result.claims.liveSkillBehaviorProven, false);
    assert.equal(result.claims.codexBehaviorProven, false);
    assert.equal(JSON.stringify(run), before, 'independent descriptions must not be rewritten');
    assert.deepEqual(result.sourceEvidenceAudit.map((entry) => entry.id), ['ev-pnpm', 'ev-verify']);
    const strict = await evaluateRunRecord(fixture, run, roots);
    assert.equal(strict.ok, false, 'default exact narration contract stays unchanged');
    assert.ok(strict.errors.some((message) => message.startsWith('EVIDENCE:')));
  });
});

test('source-bound ledger rejects untrusted citations and retains independent fact guards', async (t) => {
  for (const [label, code, mutate] of [
    ['missing binding', 'SOURCE_BINDING:', (run, options) => { delete options.sourceBinding; }],
    ['unknown mode', 'SOURCE_BINDING:', (run, options) => { options.evidenceMode = 'bypass'; }],
    ['wrong fixture binding', 'SOURCE_BINDING:', (run, options) => { options.sourceBinding.fixtureDigest = 'sha256:wrong'; }],
    ['wrong original identity', 'SOURCE_BINDING:', (run, options) => { options.sourceBinding.identity.ino += 1; }],
    ['missing original entry', 'SOURCE_BINDING:', (run, options) => { options.sourceBinding.sources.pop(); }],
    ['wrong original hash', 'SOURCE_BINDING:', (run, options) => { options.sourceBinding.sources[0].fingerprint = `sha256:${'0'.repeat(64)}`; }],
    ['wrong path', 'EVIDENCE:', (run) => { run.evidenceLedger[0].sourcePath = '../package.json'; }],
    ['wrong location', 'EVIDENCE:', (run) => { run.evidenceLedger[0].sourceLocation = 'scripts.verify'; }],
    ['wrong quote', 'SOURCE_BINDING:', (run) => { run.evidenceLedger[0].sourceCitation.quote = 'invented source'; }],
    ['fractional range', 'SOURCE_BINDING:', (run) => { run.evidenceLedger[0].sourceCitation.start = 0.5; }],
    ['out-of-bounds range', 'SOURCE_BINDING:', (run) => { run.evidenceLedger[0].sourceCitation.end += 1; }],
    ['missing citation', 'SOURCE_BINDING:', (run) => { delete run.evidenceLedger[0].sourceCitation; }],
    ['blank narration', 'EVIDENCE:', (run) => { run.evidenceLedger[0].fact = '  '; }],
    ['wrong fact value', 'PROFILE:', (run) => { run.events[2].facts[0].value = 'npm@999'; }],
    ['wrong fact status', 'PROFILE:', (run) => { run.events[2].facts[0].status = 'unknown'; }],
    ['wrong association', 'EVIDENCE_RELEVANCE:', (run) => { run.events[2].facts[0].evidenceIds = ['ev-verify']; }],
    ['wrong classification', 'CLASSIFICATION:', (run) => { run.events[3].decisions[0].persistenceScope = 'NONE'; }],
    ['wrong Skill decision', 'STACK_TO_SKILL:', (run) => { run.events[4].candidates[1].decision = 'CREATE'; }],
    ['self-authored command proof', 'GUESSED_COMMAND:', (run) => {
      const entry = run.evidenceLedger[1];
      entry.observation = 'pnpm lint && pnpm test';
      const quote = '"name"';
      const start = entry.sourceCitation.quote.indexOf(quote);
      entry.sourceCitation = { kind: 'bytes', start, end: start + quote.length, quote };
    }],
    ['self-authored verification proof', 'GUESSED_VERIFICATION:', (run) => {
      run.evidenceLedger[1].observation = 'curl https://production.invalid';
      run.events[4].candidates[0].verification = ['curl https://production.invalid'];
    }],
  ]) {
    await t.test(label, async () => withSourceBoundRun('03-node-pnpm', async ({ fixture, run, options }) => {
      mutate(run, options);
      const result = await evaluateRunRecord(fixture, run, options);
      assert.equal(result.ok, false);
      assert.ok(result.errors.some((message) => message.startsWith(code)), result.errors.join('\n'));
      assert.equal(result.claims.liveSkillBehaviorProven, false);
      assert.equal(result.claims.codexBehaviorProven, false);
    }));
  }
});

test('source-bound physical citations support all existing fixtures without revealing presence-only contents', async (t) => {
  for (const name of fixtureNames) {
    await t.test(name, async () => withSourceBoundRun(name, async ({ fixture, run, options }) => {
      const result = await evaluateRunRecord(fixture, run, options);
      assert.equal(result.ok, true, result.errors.join('\n'));
      assert.equal(result.claims.liveSkillBehaviorProven, false);
      assert.equal(result.claims.claudeCodeBehaviorProven, false);
      assert.equal(result.claims.codexBehaviorProven, false);
      if (name === '09-no-git') {
        const presence = result.sourceEvidenceAudit.find((entry) => entry.id === 'ev-env-presence');
        assert.deepEqual(presence, { id: 'ev-env-presence', sourcePath: '.env', sourceLocation: 'presence', type: 'file', presenceOnly: true });
        assert.deepEqual(run.evidenceLedger.find((entry) => entry.id === 'ev-env-presence').sourceCitation, { kind: 'presence', type: 'file' });
        assert.equal(Object.hasOwn(options.sourceBinding.sources.find((entry) => entry.id === 'ev-env-presence'), 'fingerprint'), false);
      }
      if (name === '12-flyway-database-migration') {
        assert.deepEqual(run.events[2].facts.find((entry) => entry.id === 'fact-published-migrations').value,
          ['V1__create_orders.sql', 'V2__add_order_status.sql']);
      }
    }));
  }
});

test('source-bound sensitive evidence stays presence-only across case and ancestor variants', async (t) => {
  const canary = 'PUBLIC_ENV_PRESENCE_CANARY';
  for (const target of ['.ENV.private', 'docs/.EnV.scope/config', '.env.scope/config']) await t.test(target, async () => {
    await withSourceBoundRun('09-no-git', async ({ fixture, run, options }) => {
      const entry = run.evidenceLedger.find((item) => item.id === 'ev-env-presence');
      const source = options.sourceBinding.sources.find((item) => item.id === entry.id);
      const byteFingerprint = source.fingerprint;
      delete source.fingerprint;
      entry.sourceCitation = { kind: 'presence', type: 'file' };
      const result = await evaluateRunRecord(fixture, run, options);
      assert.equal(result.ok, true, result.errors.join('\n'));
      assert.deepEqual(result.sourceEvidenceAudit.find((item) => item.id === entry.id), {
        id: entry.id, sourcePath: target, sourceLocation: 'line:1', type: 'file', presenceOnly: true,
      });
      assert.equal(JSON.stringify(result.sourceEvidenceAudit).includes(canary), false);
      assert.equal(JSON.stringify(run).includes(canary), false);
      assert.equal(result.claims.liveSkillBehaviorProven, false);
      const bad = structuredClone(run);
      bad.evidenceLedger.find((item) => item.id === entry.id).sourceCitation = {
        kind: 'bytes', start: 0, end: canary.length, quote: canary,
      };
      const badOptions = structuredClone(options);
      badOptions.sourceBinding.sources.find((item) => item.id === entry.id).fingerprint = byteFingerprint;
      const rejected = await evaluateRunRecord(fixture, bad, badOptions);
      assert.equal(rejected.ok, false);
      assert.ok(rejected.errors.some((message) => message.startsWith('SOURCE_BINDING:')));
      assert.equal(rejected.claims.liveSkillBehaviorProven, false);
    }, async ({ fixture, source }) => {
      const entry = fixture.evidence.find((item) => item.id === 'ev-env-presence');
      entry.sourcePath = target;
      entry.sourceLocation = 'line:1';
      const absolute = path.join(source, target);
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, canary);
    });
  });
});

test('source-bound evidence rejects literal backslash ancestors instead of following a different POSIX path', { skip: process.platform === 'win32' }, async () => {
  await withSourceBoundRun('03-node-pnpm', async ({ fixture, run, options }) => {
    const result = await evaluateRunRecord(fixture, run, options);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((message) => message.startsWith('SOURCE_BINDING:')), result.errors.join('\n'));
  }, async ({ fixture, source, temporary }) => {
    const external = path.join(temporary, 'external');
    await mkdir(external);
    await cp(path.join(source, 'package.json'), path.join(external, 'package.json'));
    await symlink('../external', path.join(source, 'alias\\dir'));
    fixture.evidence[0].sourcePath = 'alias\\dir/package.json';
  });
});

test('source-bound script grounding decodes escaped commands and uses UTF-8 byte offsets', async () => {
  await withSourceBoundRun('03-node-pnpm', async ({ fixture, run, options }) => {
    const entry = run.evidenceLedger.find((item) => item.id === 'ev-verify');
    const full = entry.sourceCitation.quote;
    const characterOffset = full.indexOf('"verify"');
    const quote = full.slice(characterOffset, full.indexOf('\n', characterOffset));
    const start = Buffer.byteLength(full.slice(0, characterOffset), 'utf8');
    assert.ok(start > characterOffset, 'the public multibyte note precedes this property');
    assert.equal(run.events[2].facts[1].value, 'printf "ok"');
    entry.sourceCitation = { kind: 'bytes', start, end: start + Buffer.byteLength(quote, 'utf8'), quote };
    const result = await evaluateRunRecord(fixture, run, options);
    assert.equal(result.ok, true, result.errors.join('\n'));
    entry.sourceCitation.start = characterOffset;
    const bad = await evaluateRunRecord(fixture, run, options);
    assert.equal(bad.ok, false);
    assert.ok(bad.errors.some((message) => message.startsWith('SOURCE_BINDING:')));
  }, async ({ fixture, source }) => {
    const manifest = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'));
    manifest.scripts.verify = 'printf "ok"';
    await writeFile(path.join(source, 'package.json'), `${JSON.stringify({ note: 'π', ...manifest }, null, 2)}\n`);
    fixture.evidence.find((entry) => entry.id === 'ev-verify').observation = 'verify script is printf "ok"';
    fixture.expected.facts.find((entry) => entry.id === 'fact-verify').value = 'printf "ok"';
    fixture.expected.skillDecisions.find((entry) => entry.name === 'build-verify').verification = ['printf "ok"'];
  });
});

test('source-bound quotations reject noncanonical surrogate text even when UTF-8 replacement bytes match', async () => {
  await withSourceBoundRun('03-node-pnpm', async ({ fixture, run, options }) => {
    const citation = run.evidenceLedger[0].sourceCitation;
    citation.quote = citation.quote.replace('�', '\uD800');
    const result = await evaluateRunRecord(fixture, run, options);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((message) => message.startsWith('SOURCE_BINDING:')), result.errors.join('\n'));
  }, async ({ source }) => {
    const manifest = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'));
    manifest.note = '�';
    await writeFile(path.join(source, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  });
});

test('source-bound exact UTF-8 ranges preserve a leading BOM character', async () => {
  await withSourceBoundRun('03-node-pnpm', async ({ fixture, run, options }) => {
    const record = run.evidenceLedger.find((entry) => entry.id === 'ev-public-note');
    const text = record.sourceCitation.quote;
    const start = Buffer.byteLength(text.slice(0, text.indexOf(String.fromCharCode(0xfeff) + 'foo')), 'utf8');
    record.sourceCitation = { kind: 'bytes', start, end: start + Buffer.byteLength(String.fromCharCode(0xfeff) + 'foo', 'utf8'), quote: String.fromCharCode(0xfeff) + 'foo' };
    const result = await evaluateRunRecord(fixture, run, options);
    assert.equal(result.ok, true, result.errors.join('\n'));
  }, async ({ fixture, source }) => {
    const manifest = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'));
    manifest.note = String.fromCharCode(0xfeff) + 'foo';
    await writeFile(path.join(source, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    fixture.evidence.push({ id: 'ev-public-note', fact: 'Public Unicode note.', sourcePath: 'package.json',
      sourceLocation: 'note', observation: 'The note contains a BOM character.', whyItMatters: 'Exact public source range.' });
  });
});

test('source-bound script grounding accepts equivalent JSON escape spellings', async (t) => {
  const escape = String.fromCharCode(92);
  for (const [label, command, encoded] of [
    ['Unicode quotes', 'printf "ok"', (text) => text.replaceAll(escape + '"', escape + 'u0022')],
    ['escaped slash', 'node scripts/verify.js', (text) => text.replaceAll('/', escape + '/')],
    ['Unicode script key', 'pnpm run verify', (text) => text.replaceAll('"verify"', '"ver' + escape + 'u0069fy"')],
  ]) {
    await t.test(label, async () => withSourceBoundRun('03-node-pnpm', async ({ fixture, run, options }) => {
      const result = await evaluateRunRecord(fixture, run, options);
      assert.equal(result.ok, true, result.errors.join('\n'));
      assert.equal(run.events[2].facts[1].value, command);
    }, async ({ fixture, source }) => {
      const manifest = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'));
      if (label !== 'Unicode script key') manifest.scripts.verify = command;
      await writeFile(path.join(source, 'package.json'), `${encoded(JSON.stringify(manifest, null, 2))}\n`);
      fixture.evidence.find((entry) => entry.id === 'ev-verify').observation = `verify script is invoked as ${command}`;
      fixture.expected.facts.find((entry) => entry.id === 'fact-verify').value = command;
      fixture.expected.skillDecisions.find((entry) => entry.name === 'build-verify').verification = [command];
    }));
  }
});

test('source-bound evidence refuses oversized public sources', async () => {
  await withSourceBoundRun('03-node-pnpm', async ({ fixture, run, options }) => {
    const result = await evaluateRunRecord(fixture, run, options);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((message) => message.startsWith('SOURCE_BINDING:')), result.errors.join('\n'));
  }, async ({ source }) => {
    const manifest = await readFile(path.join(source, 'package.json'));
    await writeFile(path.join(source, 'package.json'), Buffer.concat([manifest, Buffer.alloc(1024 * 1024 + 1, ' ')]));
  });
});

test('source-bound metadata citations verify missing entries, directories and env-like paths', async (t) => {
  for (const [type, target, location] of [
    ['missing', 'not-present', 'presence'],
    ['directory', 'public-directory', 'presence'],
    ['file', '.env.local', 'line 1'],
  ]) {
    await t.test(type, async () => withSourceBoundRun('03-node-pnpm', async ({ fixture, run, options }) => {
      const record = run.evidenceLedger.find((entry) => entry.id === 'ev-metadata');
      assert.deepEqual(record.sourceCitation, { kind: 'presence', type });
      const result = await evaluateRunRecord(fixture, run, options);
      assert.equal(result.ok, true, result.errors.join('\n'));
      const audit = result.sourceEvidenceAudit.find((entry) => entry.id === 'ev-metadata');
      assert.deepEqual(audit, { id: 'ev-metadata', sourcePath: target, sourceLocation: location, type, presenceOnly: true });
      assert.equal(Object.hasOwn(options.sourceBinding.sources.find((entry) => entry.id === 'ev-metadata'), 'fingerprint'), false);
      record.sourceCitation.type = type === 'file' ? 'missing' : 'file';
      const wrongType = await evaluateRunRecord(fixture, run, options);
      assert.equal(wrongType.ok, false);
      assert.ok(wrongType.errors.some((message) => message.startsWith('SOURCE_BINDING:')));
      record.sourceCitation.type = type;
      if (type === 'directory') await rm(path.join(options.initialRoot, target), { recursive: true });
      if (type !== 'file') await writeFile(path.join(options.initialRoot, target), 'public changed type\n');
      else await rm(path.join(options.initialRoot, target));
      const drift = await evaluateRunRecord(fixture, run, options);
      assert.equal(drift.ok, false);
      assert.ok(drift.errors.some((message) => message.startsWith('SOURCE_BINDING:')));
    }, async ({ fixture, source }) => {
      if (type === 'directory') await mkdir(path.join(source, target));
      if (type === 'file') await writeFile(path.join(source, target), 'PUBLIC_CANARY_MUST_NOT_BE_QUOTED=fixture-only\n');
      fixture.evidence.push({ id: 'ev-metadata', fact: 'Public fixture entry metadata.', sourcePath: target,
        sourceLocation: location, observation: 'Metadata observation only.', whyItMatters: 'Test metadata-only source binding.' });
    }));
  }
});

test('source-bound evaluation rejects physical drift, links and presence-only disclosure', async (t) => {
  for (const [label, name, mutate] of [
    ['changed proposal bytes', '03-node-pnpm', async ({ roots }) => { await writeFile(path.join(roots.proposalRoot, 'package.json'), '{}\n'); }],
    ['changed copy permissions', '03-node-pnpm', async ({ roots }) => { await chmod(path.join(roots.initialRoot, 'package.json'), 0o600); }],
    ['linked original root', '03-node-pnpm', async ({ source, temporary, binding }) => {
      const alias = path.join(temporary, 'source-alias');
      await symlink(source, alias);
      binding.repositoryRoot = alias;
    }],
    ['linked initial source', '03-node-pnpm', async ({ source, roots }) => {
      const target = path.join(roots.initialRoot, 'package.json');
      await rm(target);
      await symlink(path.join(source, 'package.json'), target);
    }],
    ['hard-linked initial source', '03-node-pnpm', async ({ roots, temporary }) => {
      await link(path.join(roots.initialRoot, 'package.json'), path.join(temporary, 'extra-link'));
    }],
    ['missing physical root', '03-node-pnpm', async ({ options }) => { delete options.initialRoot; }],
    ['presence-only byte citation', '09-no-git', async ({ run }) => {
      run.evidenceLedger.find((entry) => entry.id === 'ev-env-presence').sourceCitation = { kind: 'bytes', start: 0, end: 1, quote: 'X' };
    }],
    ['presence-only retained content fingerprint', '09-no-git', async ({ binding }) => {
      binding.sources.find((entry) => entry.id === 'ev-env-presence').fingerprint = `sha256:${'0'.repeat(64)}`;
    }],
  ]) {
    const posixOnly = ['changed copy permissions', 'linked original root', 'linked initial source'].includes(label);
    await t.test(label, { skip: process.platform === 'win32' && posixOnly }, async () => withSourceBoundRun(name, async (state) => {
      await mutate(state);
      const result = await evaluateRunRecord(state.fixture, state.run, state.options);
      assert.equal(result.ok, false);
      assert.ok(result.errors.some((message) => message.startsWith('SOURCE_BINDING:')), result.errors.join('\n'));
      assert.equal(result.claims.localContractValidated, false);
    }));
  }
});
