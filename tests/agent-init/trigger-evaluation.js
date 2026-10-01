import { createHash } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { digestTree, readRegularFileNoFollow } from '../../src/installation/filesystem.js';
import { digestProposal, validateFixtureManifest } from './evaluation-harness.js';

const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
const defaultCorpusPath = path.join(projectRoot, 'tests/trigger-corpus/cases.json');
const defaultFixturesDirectory = path.join(projectRoot, 'tests/fixtures');
const supportedHarnesses = new Set(['claude-code', 'codex']);
const digestFields = ['motherSkillDigest', 'generatedSkillDigest', 'fixtureDigest', 'triggerCorpusDigest'];
const categories = ['positive', 'negative', 'near-miss', 'collision'];
const expectationKeys = ['mustLoad', 'mustNotLoad'];

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  return isObject(value) && Reflect.ownKeys(value).length === keys.length
    && keys.every((key) => Object.prototype.propertyIsEnumerable.call(value, key));
}

function nonEmptyText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function skillList(value) {
  return Array.isArray(value) && value.every((name) => typeof name === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))
    && new Set(value).size === value.length;
}

function validSelectionEvidence(observed, knownSkills) {
  return isObject(observed) && skillList(observed.loaded)
    && observed.loaded.every((name) => knownSkills.includes(name));
}

function validTimestamp(value) {
  const match = typeof value === 'string' && /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const local = new Date(`${match[1]}T${match[2]}${match[3] ?? ''}Z`);
  return local.toISOString().startsWith(`${match[1]}T${match[2]}.`);
}

function validateArtifactSchema(artifact, knownSkills, schemaVersion) {
  if (!isObject(artifact)) return ['ARTIFACT_SCHEMA: artifact must be an object'];
  const errors = [];
  if (artifact.schemaVersion !== schemaVersion) errors.push(`ARTIFACT_SCHEMA: schemaVersion must be ${schemaVersion}`);
  if (!supportedHarnesses.has(artifact.harness)) errors.push('ARTIFACT_SCHEMA: harness must be claude-code or codex');
  for (const field of ['harnessVersion', 'fixtureId', 'caseId']) {
    if (!nonEmptyText(artifact[field])) errors.push(`ARTIFACT_SCHEMA: ${field} requires non-empty text`);
  }
  if (!validTimestamp(artifact.recordedAt)) errors.push('ARTIFACT_SCHEMA: recordedAt requires a valid ISO timestamp');
  if (!['pass', 'fail'].includes(artifact.result)) errors.push('ARTIFACT_SCHEMA: result must be pass or fail');
  for (const field of digestFields) {
    if (typeof artifact[field] !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(artifact[field])) {
      errors.push(`ARTIFACT_SCHEMA: ${field} requires a SHA-256 digest`);
    }
  }
  if (!isObject(artifact.expected) || !skillList(artifact.expected.mustLoad) || !skillList(artifact.expected.mustNotLoad)) {
    errors.push('ARTIFACT_SCHEMA: expected requires unique mustLoad and mustNotLoad Skill lists');
  }
  if (!validSelectionEvidence(artifact.observed, knownSkills)) {
    errors.push('SELECTION_EVIDENCE: observed.loaded requires an explicit list of known Skill names');
  }
  return errors;
}

function evaluationResult(errors, result = null) {
  return {
    ok: errors.length === 0,
    errors,
    result,
    claims: {
      localContractValidated: errors.length === 0,
      liveSkillBehaviorProven: false,
      claudeCodeBehaviorProven: false,
      codexBehaviorProven: false,
    },
  };
}

function failure(code, message) {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

function validateCorpus(corpus, fixtures, knownSkills) {
  if (!isObject(corpus) || corpus.schemaVersion !== 1 || !Array.isArray(corpus.cases) || !corpus.cases.length) {
    throw failure('CORPUS_SCHEMA', 'corpus requires schemaVersion 1 and non-empty cases');
  }
  if (Object.hasOwn(corpus, 'explicitProbes') && !Array.isArray(corpus.explicitProbes)) {
    throw failure('CORPUS_SCHEMA', 'explicitProbes must be an array when present');
  }
  const ids = new Set();
  const coverage = new Map();
  const explicitProbes = corpus.explicitProbes ?? [];
  for (const entry of [...corpus.cases, ...explicitProbes]) {
    const explicit = explicitProbes.includes(entry);
    if (!isObject(entry) || entry.schemaVersion !== 1 || !nonEmptyText(entry.prompt)) {
      throw failure('CORPUS_SCHEMA', 'each case requires schemaVersion 1 and a prompt');
    }
    if (typeof entry.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.id) || ids.has(entry.id) || !fixtures.has(entry.fixture)) {
      throw failure('CORPUS_IDENTITY', `case ${entry.id} requires a unique stable ID and an existing fixture`);
    }
    ids.add(entry.id);
    if (!categories.includes(entry.category)) throw failure('CORPUS_CATEGORY', `${entry.id} requires an explicit supported category`);
    if (!isObject(entry.skillFixtures)) throw failure('CORPUS_SKILL_IDENTITY', `${entry.id} requires explicit Skill fixture sources`);
    for (const [name, fixtureId] of Object.entries(entry.skillFixtures)) {
      const decision = fixtures.get(fixtureId)?.fixture.expected.skillDecisions.find((candidate) => candidate.name === name && ['CREATE', 'UPDATE'].includes(candidate.action));
      if (!decision || !knownSkills.has(name)) throw failure('CORPUS_SKILL_IDENTITY', `${entry.id}: ${fixtureId} does not generate ${name}`);
    }
    const names = Object.keys(entry.skillFixtures);
    if (names.length && !Object.values(entry.skillFixtures).includes(entry.fixture)) {
      throw failure('CORPUS_IDENTITY', `${entry.id}: primary fixture must be one of the declared Skill sources`);
    }
    const expected = entry.expected;
    if (!isObject(expected) || Object.keys(expected).length !== expectationKeys.length
      || Object.keys(expected).some((key) => !expectationKeys.includes(key))
      || expectationKeys.some((key) => !skillList(expected[key]) || expected[key].some((name) => !knownSkills.has(name)))
      || expected.mustLoad.some((name) => expected.mustNotLoad.includes(name) || !names.includes(name))
      || names.some((name) => !expected.mustLoad.includes(name) && !expected.mustNotLoad.includes(name))) {
      throw failure('CORPUS_EXPECTATION', `${entry.id} has unknown, contradictory or incomplete expectations`);
    }
    if ((entry.category === 'positive' && !expected.mustLoad.length)
      || (['negative', 'near-miss'].includes(entry.category) && expected.mustLoad.length)
      || (entry.category === 'collision' && names.length < 2)) {
      throw failure('CORPUS_CATEGORY', `${entry.id}: expectations or Skill sources do not match ${entry.category}`);
    }
    const invocation = entry.invocation;
    const promptSkill = /^\$([a-z0-9]+(?:-[a-z0-9]+)*)(?:\s|$)/.exec(entry.prompt)?.[1];
    if (explicit) {
      if (!hasExactKeys(invocation, ['mode', 'harness', 'skill'])
        || invocation.mode !== 'explicit' || invocation.harness !== 'codex'
        || !names.includes(invocation.skill) || promptSkill !== invocation.skill
        || entry.category !== 'positive' || expected.mustLoad.length !== 1
        || expected.mustLoad[0] !== invocation.skill) {
        throw failure('CORPUS_INVOCATION', `${entry.id} requires a Codex explicit target, matching prompt token and single-target expectation`);
      }
      continue;
    }
    if (Object.hasOwn(entry, 'invocation') || promptSkill) {
      throw failure('CORPUS_INVOCATION', `${entry.id}: explicit invocations belong in explicitProbes, not cases`);
    }
    for (const [name, fixtureId] of Object.entries(entry.skillFixtures)) {
      const key = `${fixtureId}:${name}`;
      if (!coverage.has(key)) coverage.set(key, new Set());
      if (entry.category !== 'positive' || expected.mustLoad.includes(name)) coverage.get(key).add(entry.category);
    }
  }
  for (const [key, covered] of coverage) {
    const missing = categories.filter((category) => !covered.has(category));
    if (missing.length) throw failure('CORPUS_COVERAGE', `${key} lacks ${missing.join(', ')} cases`);
  }
}

async function readJson(filePath) {
  const bytes = await readRegularFileNoFollow(filePath);
  try {
    return { value: JSON.parse(bytes.toString('utf8')), bytes };
  } catch (cause) {
    if (!(cause instanceof SyntaxError)) throw cause;
    throw new Error(`JSON: cannot parse ${filePath}`, { cause });
  }
}

async function treeDigest(root, label) {
  if (typeof root !== 'string' || !root.trim()) throw failure('PHYSICAL_EVIDENCE', `${label} requires a directory`);
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure('PHYSICAL_EVIDENCE', `${label} must be a regular directory: ${root}`);
  return digestTree(root);
}

export async function loadTriggerCorpus(options = {}) {
  const corpusPath = options.corpusPath ?? defaultCorpusPath;
  const fixturesDirectory = options.fixturesDirectory ?? defaultFixturesDirectory;
  const { value: corpus, bytes } = await readJson(corpusPath);
  const fixtures = new Map();
  const knownSkills = new Set();
  for (const entry of await readdir(fixturesDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(fixturesDirectory, entry.name);
    const { value: fixture } = await readJson(path.join(directory, 'fixture.json'));
    const errors = validateFixtureManifest(fixture);
    if (errors.length) throw failure('FIXTURE_SCHEMA', `${entry.name}: ${errors.join('; ')}`);
    fixtures.set(fixture.id, { fixture, directory });
    for (const decision of fixture.expected.skillDecisions) {
      if (['CREATE', 'UPDATE'].includes(decision.action)) knownSkills.add(decision.name);
    }
  }
  validateCorpus(corpus, fixtures, knownSkills);
  return {
    cases: corpus.cases,
    explicitProbes: corpus.explicitProbes ?? [],
    fixtures,
    knownSkills,
    digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
  };
}

export async function prepareTriggerCase(caseId, options = {}) {
  const corpus = await loadTriggerCorpus(options);
  const triggerCase = [...corpus.cases, ...corpus.explicitProbes].find((entry) => entry.id === caseId);
  if (!triggerCase) throw failure('CASE_IDENTITY', `unknown trigger case ${caseId}`);
  const generatedSkills = options.generatedSkills ?? {};
  const names = Object.keys(triggerCase.skillFixtures).sort();
  if (!isObject(generatedSkills)
    || JSON.stringify(Object.keys(generatedSkills).sort()) !== JSON.stringify(names)) {
    throw failure('SKILL_IDENTITY', `${caseId} requires exactly the declared generated Skill payloads: ${names.join(', ')}`);
  }
  const fixtureIds = [...new Set([triggerCase.fixture, ...Object.values(triggerCase.skillFixtures)])].sort();
  const fixtures = [];
  for (const fixtureId of fixtureIds) {
    const root = options.fixtureRoots?.[fixtureId] ?? corpus.fixtures.get(fixtureId).directory;
    const digest = await treeDigest(root, `fixture ${fixtureId}`);
    const { value: fixture } = await readJson(path.join(root, 'fixture.json'));
    if (fixture.id !== fixtureId) throw failure('FIXTURE_IDENTITY', `${fixtureId}: physical fixture metadata has a different identity`);
    fixtures.push({ id: fixtureId, digest });
  }
  const skills = [];
  for (const name of names) {
    const root = generatedSkills[name];
    if (!nonEmptyText(root) || path.basename(path.resolve(root)) !== name) {
      throw failure('SKILL_IDENTITY', `${name}: generated Skill directory must match its name`);
    }
    const digest = await treeDigest(root, `generated Skill ${name}`);
    const markdown = await readRegularFileNoFollow(path.join(root, 'SKILL.md'), 'utf8');
    const metadata = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown)?.[1] ?? '';
    const nameFields = [...metadata.matchAll(/^name:[ \t]*([^\r\n]*)$/gm)];
    if (nameFields.length !== 1 || ![name, JSON.stringify(name), `'${name}'`].includes(nameFields[0][1].trim())) {
      throw failure('SKILL_IDENTITY', `${name}: SKILL.md metadata must declare the same unique name`);
    }
    skills.push({ name, digest });
  }
  return {
    case: triggerCase,
    knownSkills: [...corpus.knownSkills],
    fixtureIds,
    digests: {
      motherSkillDigest: await treeDigest(options.motherSkillRoot ?? path.join(projectRoot, 'skills/agent-init'), 'mother Skill'),
      generatedSkillDigest: digestProposal({ type: 'agent-init-trigger-skills-v1', skills }),
      fixtureDigest: digestProposal({ type: 'agent-init-trigger-fixtures-v1', fixtures }),
      triggerCorpusDigest: corpus.digest,
    },
  };
}

function compareSelection(expected, loaded) {
  const missing = expected.mustLoad.filter((name) => !loaded.includes(name));
  const forbidden = expected.mustNotLoad.filter((name) => loaded.includes(name));
  return {
    result: missing.length || forbidden.length ? 'fail' : 'pass',
    errors: [
      ...missing.map((name) => `MISSING_SKILL: expected ${name} to load`),
      ...forbidden.map((name) => `FORBIDDEN_SKILL: expected ${name} not to load`),
    ],
  };
}

function matchesInvocation(triggerCase, observation) {
  if (!triggerCase.invocation) return !Object.hasOwn(observation, 'invocation');
  const invocation = observation.invocation;
  return hasExactKeys(invocation, ['mode', 'skill', 'prompt'])
    && invocation.mode === triggerCase.invocation.mode
    && invocation.skill === triggerCase.invocation.skill
    && invocation.prompt === triggerCase.prompt
    && observation.harness === triggerCase.invocation.harness;
}

export function createTriggerArtifact(prepared, observation) {
  let evidence = observation?.selectionEvidence;
  if (typeof evidence === 'string') {
    try {
      evidence = JSON.parse(evidence);
    } catch (cause) {
      if (!(cause instanceof SyntaxError)) throw cause;
      throw failure('SELECTION_EVIDENCE', `${prepared.case.id}: cannot parse selection evidence JSON`);
    }
  }
  if (!validSelectionEvidence(evidence, prepared.knownSkills)) {
    throw failure('SELECTION_EVIDENCE', `${prepared.case.id}: selection evidence requires an explicit unique loaded list of known Skill names`);
  }
  const request = { harness: observation.harness };
  if (Object.hasOwn(observation, 'invocation')) {
    const invocation = observation.invocation;
    request.invocation = hasExactKeys(invocation, ['mode', 'skill', 'prompt'])
      ? { mode: invocation.mode, skill: invocation.skill, prompt: invocation.prompt }
      : null;
  }
  if (!matchesInvocation(prepared.case, request)) {
    throw failure('INVOCATION_EVIDENCE', `${prepared.case.id}: invocation must match the authoritative case and harness`);
  }
  const observed = { loaded: [...evidence.loaded] };
  return {
    schemaVersion: prepared.case.invocation ? 2 : 1,
    ...(prepared.case.invocation ? { invocation: request.invocation } : {}),
    harness: request.harness,
    harnessVersion: observation.harnessVersion,
    fixtureId: prepared.case.fixture,
    caseId: prepared.case.id,
    ...prepared.digests,
    expected: structuredClone(prepared.case.expected),
    observed,
    result: compareSelection(prepared.case.expected, observed.loaded).result,
    recordedAt: observation.recordedAt,
  };
}

export async function evaluateTriggerArtifact(artifact, options) {
  const prepared = await prepareTriggerCase(options.caseId, options);
  const errors = validateArtifactSchema(artifact, prepared.knownSkills, prepared.case.invocation ? 2 : 1);
  if (errors.length) return evaluationResult(errors);
  if (artifact.caseId !== prepared.case.id || artifact.fixtureId !== prepared.case.fixture) {
    return evaluationResult(['ARTIFACT_IDENTITY: caseId and fixtureId must match the requested corpus case']);
  }
  if (Object.keys(artifact.expected).length !== expectationKeys.length
    || Object.keys(artifact.expected).some((key) => !expectationKeys.includes(key))
    || expectationKeys.some((key) => JSON.stringify([...artifact.expected[key]].sort()) !== JSON.stringify([...prepared.case.expected[key]].sort()))) {
    return evaluationResult(['ARTIFACT_EXPECTATION: expected must equal the authoritative corpus expectations']);
  }
  const mismatches = digestFields.filter((field) => artifact[field] !== prepared.digests[field]);
  if (mismatches.length) {
    return evaluationResult(mismatches.map((field) => `ARTIFACT_DIGEST: ${field} does not match the current case inputs`));
  }
  if (!matchesInvocation(prepared.case, artifact)) {
    return evaluationResult(['INVOCATION_EVIDENCE: invocation must match the authoritative case and harness']);
  }
  const comparison = compareSelection(prepared.case.expected, artifact.observed.loaded);
  if (artifact.result !== comparison.result) {
    comparison.errors.push(`ARTIFACT_RESULT: claimed ${artifact.result}, observed selection implies ${comparison.result}`);
  }
  return evaluationResult(comparison.errors, comparison.result);
}
