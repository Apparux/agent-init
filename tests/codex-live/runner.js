import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';

import { digestTree, readRegularFileNoFollow } from '../../src/installation/filesystem.js';
import path from 'node:path';

import { digestProposal, evaluateRunRecord, fingerprintPath, fingerprintRepository, validateWriteTargetPhysicalScope } from '../agent-init/evaluation-harness.js';
import { createTriggerArtifact, evaluateTriggerArtifact, loadTriggerCorpus, prepareTriggerCase } from '../agent-init/trigger-evaluation.js';
import { openCodexProcess } from './app-server.js';
import { assertCodexDirectory, createCodexRuntime, inventoryCodexTree } from './owned-runtime.js';
import { parseCodexSelection, parseCodexTurn } from './parser.js';
import { setupContractLabels, setupProposalSchema, setupReconcileSchema, setupValidationSchema } from './machine-record.js';
import { bindCodexEvidence } from './source-binding.js';
import { createContributorContext } from './contributor-context.js';
import { createCodexMeasurementTools } from './measurement-tools.js';

function failure(code, message) {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

function validateApplyInventory(before, after, proposal, approval) {
  const baseline = new Map(before.map((entry) => [entry.path, entry]));
  const final = new Map(after.map((entry) => [entry.path, entry]));
  const targets = proposal.actions.filter((action) => approval.approvedActionIds.includes(action.id)).map((action) => action.target);
  for (const target of new Set([...baseline.keys(), ...final.keys()])) {
    const prior = baseline.get(target);
    const current = final.get(target);
    if (JSON.stringify(prior) === JSON.stringify(current)) continue;
    if (prior && current && prior.mode !== current.mode) throw failure('UNAPPROVED_DELTA', `mode changed without an exact permission Proposal: ${target}`);
    if (!prior && current?.type === 'directory' && targets.some((write) => write.startsWith(`${target}/`))
      && [0o700, 0o755].includes(current.mode)) continue;
    if (!targets.includes(target) || !current || current.type === 'directory'
      || (!prior && current.type === 'file' && ![0o600, 0o644].includes(current.mode))) {
      throw failure('UNAPPROVED_DELTA', `physical delta exceeds exact approved payload scope: ${target}`);
    }
  }
}

async function openSession(runtime, cwd, role, fixtureId, runId, launch, context = {}, limits = {}) {
  const sessionId = randomUUID();
  const codexHome = path.join(runtime.root, `codex-${sessionId}`);
  await mkdir(codexHome);
  const env = { ...runtime.env, CODEX_HOME: codexHome };
  const measurementTools = await createCodexMeasurementTools({
    ownedRoot: runtime.root, ownedIdentity: await assertCodexDirectory(runtime.root),
    repositoryRoot: cwd, repositoryIdentity: await assertCodexDirectory(cwd),
    motherSkillRoot: runtime.motherSkillRoot, motherSkillIdentity: await assertCodexDirectory(runtime.motherSkillRoot),
  });
  const client = await openCodexProcess({
    mode: 'synthetic', root: runtime.root, ownedRoot: runtime.root, cwd, env, measurementTools,
    timeoutMs: limits.sessionTimeoutMs, approvalTimeoutMs: limits.approvalTimeoutMs, closeTimeoutMs: limits.closeTimeoutMs,
    launch: await launch({ root: runtime.root, cwd, env: structuredClone(env), role, fixtureId, runId, sessionId, ...structuredClone(context) }),
  });
  try {
    const initialized = await client.request('initialize', {
      clientInfo: { name: 'agent-init-ticket08', version: 'synthetic' }, capabilities: { experimentalApi: true },
    });
    if (initialized?.codexHome !== codexHome || typeof initialized.userAgent !== 'string' || !initialized.userAgent.includes('synthetic')) {
      throw failure('HARNESS_IDENTITY', 'synthetic initialize identity or owned CODEX_HOME mismatch');
    }
    client.notify('initialized');
    const started = await client.request('thread/start', {
      cwd, ephemeral: true, experimentalRawEvents: true, environments: [],
      approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: 'read-only', dynamicTools: measurementTools.dynamicTools,
      ...(context.contributors ? { runtimeWorkspaceRoots: context.contributors.map((entry) => entry.repositoryRoot) } : {}),
    });
    if (typeof started?.thread?.id !== 'string' || !started.thread.id) throw failure('THREAD_IDENTITY', 'missing actual fresh thread ID');
    const threadRequest = client.sent.find((entry) => entry.method === 'thread/start');
    return { client, sessionId, threadId: started.thread.id, threadRequest, harnessVersion: initialized.userAgent, role, fixtureId };
  } catch (cause) {
    try { await client.close(); }
    catch (cleanupError) {
      throw Object.assign(new AggregateError([cause, cleanupError], 'Codex initialization failed and process cleanup could not be confirmed'), {
        code: 'CODEX_CLEANUP', processCleanupUnconfirmed: true,
      });
    }
    throw cause;
  }
}

// Importing this module is inert. Native execution has no boolean/bypass activation path.
export async function runCodex(config = {}, dependencies = {}) {
  if (config.mode !== 'synthetic') throw failure('NATIVE_EXECUTION_DEFERRED', 'native authorization and containment integration are deferred');
  if (typeof dependencies.launch !== 'function') throw failure('SYNTHETIC_LAUNCH', 'synthetic execution requires the explicit checked test-double launcher');
  const evidenceMode = config.evidenceMode === undefined ? 'fixture-exact' : config.evidenceMode;
  if (!['fixture-exact', 'source-bound'].includes(evidenceMode)) throw failure('SOURCE_BINDING', 'unsupported controller-selected evidence mode');
  const result = {
    schemaVersion: 1, synthetic: true, runId: randomUUID(), status: 'failed', phase: 'installation',
    claims: { nativeExecution: false, liveEndToEnd: false, selectionProof: false, qualification: false },
    setups: [], setupCaptures: [], cases: [], sessions: [], cleanup: null,
  };
  let runtime;
  let session;
  let processCleanupUnconfirmed = false;
  try {
    const corpus = await loadTriggerCorpus(config);
    runtime = await createCodexRuntime(config);
    result.installation = { packageName: runtime.package.name, packageVersion: runtime.package.version,
      filename: runtime.package.filename, packedFiles: runtime.package.files.length,
      motherSkillDigest: await digestTree(runtime.motherSkillRoot),
      commands: runtime.commands.map(({ exitCode, signal, processGroupAbsent, stdoutDigest, stderrDigest }) => ({ exitCode, signal, processGroupAbsent, stdoutDigest, stderrDigest })) };
    const preparedFixtures = new Map();
    const generatedByFixture = new Map();
    const threadIds = new Set();
    const fixtureIds = config.fixtureIds ?? [...corpus.fixtures.keys()];
    if (!Array.isArray(fixtureIds) || !fixtureIds.length || new Set(fixtureIds).size !== fixtureIds.length) throw failure('FIXTURE_IDENTITY', 'fixture IDs must be a nonempty unique set');
    for (const fixtureId of fixtureIds) {
      const source = corpus.fixtures.get(fixtureId);
      if (!source) throw failure('FIXTURE_IDENTITY', `unknown fixture ${fixtureId}`);
      result.phase = 'setup-proposal';
      const prepared = await runtime.prepareFixture(source.directory);
      preparedFixtures.set(fixtureId, prepared);
      const initial = await prepared.snapshot('initial');
      const evidenceOptions = evidenceMode === 'source-bound' ? {
        evidenceMode, sourceBinding: await bindCodexEvidence(prepared.fixture, path.join(source.directory, 'repository')),
      } : {};
      session = await openSession(runtime, prepared.repositoryRoot, 'setup', fixtureId, result.runId, dependencies.launch, {}, config);
      if (threadIds.has(session.threadId)) throw failure('SESSION_REUSE', 'fresh process returned a previously used thread ID');
      threadIds.add(session.threadId);
      const capture = await session.client.runTurn({
        threadId: session.threadId,
        input: [
          { type: 'skill', name: 'agent-init', path: path.join(runtime.motherSkillRoot, 'SKILL.md') },
          { type: 'text', text: JSON.stringify({ operation: 'setup-proposal', fixtureId, evidenceMode, contractLabels: setupContractLabels(prepared.fixture),
            ...(evidenceMode === 'source-bound' ? { sourceCitationInstruction: 'For every ledger entry, cite the inspected source with sourceCitation. For regular non-sensitive files use {kind:"bytes",start,end,quote}: exact UTF-8 byte offsets, exclusive end, nonempty range at most 64 KiB, from a file at most 1 MiB. Missing sources, directories, sourceLocation "presence" and .env-prefixed basenames use only {kind:"presence",type:"file"|"directory"|"missing"}; do not read or quote sensitive contents. Write your own nonempty fact, observation and whyItMatters. A verified quote does not establish narration relevance or approve writes.' } : {}),
            instruction: 'Execute $agent-init in Proposal-only mode. Do not write files. Return the setup-proposal envelope described by outputSchema. These slots label observations, not supplied answers. Inspect repository evidence yourself; derive facts, classification and Skill decisions independently. Treat unclassifiedQuestions as questions, not prefilled Unknown conclusions. Record preflight, explore, profile, classify, skills, proposal in order, with complete ledger and full Proposal, summary and audit digest. Preserve actual observations; do not invent missing phases or claim external/live acceptance.' }) },
        ],
        approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly', networkAccess: false }, outputSchema: setupProposalSchema(fixtureId, evidenceMode),
      });
      result.setupCaptures.push({ fixtureId, capture });
      const proposal = await prepared.snapshot('proposal');
      if (JSON.stringify(initial.inventory) !== JSON.stringify(proposal.inventory)) throw failure('PROPOSAL_WRITE', 'Proposal-only phase changed the physical repository');
      const body = parseCodexTurn(capture);
      if (body.schemaVersion !== 1 || body.kind !== 'setup-proposal' || !body.record || !body.summary || !body.audit) {
        throw failure('MACHINE_RECORD', 'missing captured setup record, full Proposal, summary or audit');
      }
      const record = body.record;
      const fullProposal = record.events?.find((event) => event.type === 'proposal');
      if (record.schemaVersion !== 1 || record.fixtureId !== fixtureId || record.harness !== 'recorded-contract'
        || !Array.isArray(record.evidenceLedger) || !Array.isArray(record.events)
        || record.evidenceLedger.some((entry) => ['id', 'fact', 'sourcePath', 'sourceLocation', 'observation', 'whyItMatters'].some((key) => typeof entry[key] !== 'string' || !entry[key]))
        || record.events[0]?.readOnly !== true || record.events[1]?.readOnly !== true
        || !Array.isArray(record.events[2]?.facts) || !Array.isArray(record.events[2]?.unknowns)
        || record.events[2].facts.some((fact) => typeof fact.id !== 'string' || !Object.hasOwn(fact, 'value') || typeof fact.status !== 'string' || !Array.isArray(fact.evidenceIds))
        || !Array.isArray(record.events[3]?.decisions) || !Array.isArray(record.events[4]?.candidates)
        || record.events.map((event) => event.type).join(',') !== 'preflight,explore,profile,classify,skills,proposal'
        || !fullProposal || typeof fullProposal.id !== 'string' || !Number.isSafeInteger(fullProposal.revision)
        || !Array.isArray(fullProposal.actions) || !fullProposal.projectSummary
        || ['unknowns', 'warnings', 'nonGoals', 'validationPlan'].some((key) => !Array.isArray(fullProposal[key]))
        || body.summary.proposalId !== fullProposal.id || body.summary.revision !== fullProposal.revision
        || JSON.stringify(body.summary.actionIds) !== JSON.stringify(fullProposal.actions.map((action) => action.id))
        || body.audit.proposalDigest !== digestProposal(fullProposal)) {
        throw failure('MACHINE_RECORD', 'captured Proposal or summary/audit is incomplete or inconsistent');
      }
      // Validate the actual partial record; never invent approval/validation/reconcile events.
      // Only these exact, not-yet-observed later-phase diagnostics are deferred.
      const proposalCheckPreWrite = await prepared.snapshot('proposalCheckPreWrite');
      const proposalCheckFinal = await prepared.snapshot('proposalCheckFinal');
      const pendingLaterPhases = new Set([
        'VALIDATION: run did not record a passing validation',
        'VALIDATION: validation did not prove preservationPassed',
        'VALIDATION: validation did not prove evidencePassed',
        'VALIDATION: validation did not prove singleSourcePassed',
        'VALIDATION: validation did not prove unknownsPreserved',
        'RECONCILE: second-run dry-run reconcile evidence is required',
      ]);
      const proposalCheck = await evaluateRunRecord(prepared.fixture, JSON.parse(JSON.stringify(record)), {
        ...evidenceOptions, initialRoot: initial.root, proposalRoot: proposal.root, preWriteRoot: proposalCheckPreWrite.root, finalRoot: proposalCheckFinal.root,
      });
      const proposalErrors = proposalCheck.errors.filter((message) => !pendingLaterPhases.has(message));
      if (proposalErrors.length) throw failure('PROPOSAL_CONTRACT', proposalErrors.join('; '));
      const proposalDigest = digestProposal(fullProposal);
      if (typeof dependencies.approve !== 'function') {
        result.status = 'awaiting-approval';
        result.setups.push({ fixtureId, proposal: fullProposal, proposalDigest, synthetic: true,
          evidenceLedger: structuredClone(record.evidenceLedger), sourceEvidenceAudit: structuredClone(proposalCheck.sourceEvidenceAudit ?? []) });
        break;
      }
      result.phase = 'approval';
      const decision = await session.client.waitForApproval(({ signal }) => dependencies.approve({
        signal, fixtureId, proposal: structuredClone(fullProposal), proposalDigest, summary: structuredClone(body.summary), audit: structuredClone(body.audit),
        evidenceLedger: structuredClone(record.evidenceLedger), sourceEvidenceAudit: structuredClone(proposalCheck.sourceEvidenceAudit ?? []),
      }));
      let approval;
      try { approval = JSON.parse(JSON.stringify(decision)); }
      catch { throw failure('EXACT_APPROVAL', 'approval must be an explicit JSON-compatible decision'); }
      const writeIds = new Set(fullProposal.actions.filter((action) => ['CREATE', 'UPDATE'].includes(action.action)).map((action) => action.id));
      if (!approval || !['approve', 'reject'].includes(approval.decision) || approval.scope !== 'exact-proposal'
        || approval.proposalId !== fullProposal.id || approval.revision !== fullProposal.revision
        || approval.proposalDigest !== proposalDigest || !Array.isArray(approval.approvedActionIds)
        || new Set(approval.approvedActionIds).size !== approval.approvedActionIds.length
        || approval.approvedActionIds.some((id) => !writeIds.has(id))
        || (approval.decision === 'reject' && approval.approvedActionIds.length)) {
        throw failure('EXACT_APPROVAL', 'approval must bind this exact Proposal and unique write action subset');
      }
      if (digestProposal(fullProposal) !== proposalDigest) throw failure('PROPOSAL_DRIFT', 'Proposal changed after approval');
      const preWrite = await prepared.snapshot('preWrite');
      if (JSON.stringify(proposal.inventory) !== JSON.stringify(preWrite.inventory)) throw failure('FINGERPRINT_DRIFT', 'physical repository changed after Proposal');
      for (const action of fullProposal.actions.filter((entry) => writeIds.has(entry.id))) {
        const scopeErrors = await validateWriteTargetPhysicalScope(prepared.repositoryRoot, action.target);
        if (scopeErrors.length || await fingerprintPath(prepared.repositoryRoot, action.target) !== action.baselineFingerprint) {
          throw failure('WRITE_SCOPE', 'Proposal target scope or baseline does not match its physical repository');
        }
      }
      const willApply = approval.approvedActionIds.length > 0;
      record.events.push({ ...approval, type: 'approval' });
      result.phase = willApply ? 'setup-apply' : 'setup-validation';
      const validationCapture = await session.client.runTurn({
        threadId: session.threadId,
        input: [{ type: 'text', text: JSON.stringify({ operation: willApply ? 'setup-apply' : 'setup-validation', fixtureId, instruction: willApply
          ? 'Execute the mother Skill Apply phase for only these exact approved action IDs. Return setup-apply with actual write and validation events. Do not change the Proposal or perform any other operation.'
          : 'No write action is approved. Do not Apply. Validate the unchanged repository and return setup-validation with actual validation events.', approval, proposal: fullProposal }) }],
        approvalPolicy: 'never', sandboxPolicy: willApply
          ? { type: 'workspaceWrite', writableRoots: [prepared.repositoryRoot], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true }
          : { type: 'readOnly', networkAccess: false }, outputSchema: setupValidationSchema(willApply),
      });
      const validation = parseCodexTurn(validationCapture);
      if (validation.kind !== (willApply ? 'setup-apply' : 'setup-validation') || validation.schemaVersion !== 1 || !Array.isArray(validation.events)
        || validation.events.at(-1)?.type !== 'validation' || validation.events.some((event) => !['write', 'validation'].includes(event.type))
        || validation.events.filter((event) => event.type === 'validation').length !== 1) throw failure('MACHINE_RECORD', 'missing actual write/validation events');
      record.events.push(...validation.events);
      const final = await prepared.snapshot('final');
      validateApplyInventory(preWrite.inventory, final.inventory, fullProposal, approval);
      if (!willApply && JSON.stringify(preWrite.inventory) !== JSON.stringify(final.inventory)) throw failure('UNAPPROVED_WRITE', 'unapproved phase changed the physical repository');
      result.phase = 'setup-reconcile';
      const reconcileBefore = await prepared.snapshot('reconcileBefore');
      const reconcileCapture = await session.client.runTurn({
        threadId: session.threadId,
        input: [{ type: 'text', text: JSON.stringify({ operation: 'setup-reconcile', fixtureId, instruction: 'Run $agent-init a second time, read-only. Return the actual dry-run reconcile event described by outputSchema, with observed actions and writes. Do not change any file.' }) }],
        approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly', networkAccess: false }, outputSchema: setupReconcileSchema(),
      });
      const reconciled = parseCodexTurn(reconcileCapture);
      if (reconciled.schemaVersion !== 1 || reconciled.kind !== 'setup-reconcile' || reconciled.event?.type !== 'reconcile'
        || reconciled.event.mode !== 'dry-run' || !Array.isArray(reconciled.event.proposalActions) || !Array.isArray(reconciled.event.writes)) {
        throw failure('MACHINE_RECORD', 'missing actual second read-only reconcile event');
      }
      const reconcileAfter = await prepared.snapshot('reconcileAfter');
      if (JSON.stringify(reconcileBefore.inventory) !== JSON.stringify(reconcileAfter.inventory)) throw failure('RECONCILE_WRITE', 'second read-only turn changed the physical repository');
      record.events.push(reconciled.event);
      const evaluation = await evaluateRunRecord(prepared.fixture, JSON.parse(JSON.stringify(record)), {
        ...evidenceOptions, initialRoot: initial.root, proposalRoot: proposal.root, preWriteRoot: preWrite.root, finalRoot: final.root,
      });
      const generatedSkills = [];
      if (evaluation.ok) for (const action of fullProposal.actions.filter((entry) => approval.approvedActionIds.includes(entry.id)
        && entry.kind === 'project-skill' && /^\.agents\/skills\/[^/]+\/SKILL\.md$/.test(entry.target))) {
        const skillRoot = path.dirname(path.join(prepared.repositoryRoot, action.target));
        generatedSkills.push({ name: path.basename(skillRoot), fixtureId, root: skillRoot,
          content: await readRegularFileNoFollow(path.join(skillRoot, 'SKILL.md'), 'utf8'), digest: await digestTree(skillRoot) });
      }
      result.setups.push({ fixtureId, record, evaluation, generatedSkills, finalInventory: final.inventory,
        reconcileZeroDelta: true, turns: [capture, validationCapture, reconcileCapture] });
      if (!evaluation.ok) throw failure('SETUP_CONTRACT', evaluation.errors.join('; '));
      generatedByFixture.set(fixtureId, new Map(generatedSkills.map((entry) => [entry.name, entry])));
      const setupExit = await session.client.close();
      result.sessions.push({ sessionId: session.sessionId, threadId: session.threadId, harnessVersion: session.harnessVersion, role: session.role, fixtureId, ...setupExit });
      session = null;
      if (setupExit.failure || setupExit.exitCode !== 0 || setupExit.signal) throw failure('CODEX_SESSION_FAILURE', 'setup process failed; routing was not started');
      result.status = 'synthetic-pass';
      result.phase = 'complete';
    }
    if (result.status !== 'awaiting-approval') {
      const allCases = [...corpus.cases, ...corpus.explicitProbes];
      const caseIds = config.caseIds ?? allCases.map((entry) => entry.id);
      if (!Array.isArray(caseIds) || new Set(caseIds).size !== caseIds.length) throw failure('CASE_IDENTITY', 'case IDs must be an explicit unique set');
      for (const caseId of caseIds) {
        result.phase = 'routing';
        const triggerCase = allCases.find((entry) => entry.id === caseId);
        if (!triggerCase) throw failure('CASE_IDENTITY', `unknown case ${caseId}`);
        const contributorIds = [...new Set([triggerCase.fixture, ...Object.values(triggerCase.skillFixtures)])].sort();
        const copies = await runtime.prepareRouting(caseId, contributorIds.map((fixtureId) => {
          const prepared = preparedFixtures.get(fixtureId);
          if (!prepared) throw failure('CONTRIBUTOR_CONTEXT', `case requires verified setup for ${fixtureId}`);
          return { fixtureId, repositoryRoot: prepared.repositoryRoot };
        }));
        const contributors = copies.map(({ fixtureId, repositoryRoot }) => ({ fixtureId, repositoryRoot }));
        const generatedSkills = {};
        const skillMetadata = [];
        for (const [name, fixtureId] of Object.entries(triggerCase.skillFixtures)) {
          const skill = generatedByFixture.get(fixtureId)?.get(name);
          const root = path.join(contributors.find((entry) => entry.fixtureId === fixtureId).repositoryRoot, '.agents/skills', name);
          if (!skill || await digestTree(skill.root) !== skill.digest || await digestTree(root) !== skill.digest) {
            throw failure('SKILL_IDENTITY', `missing or changed ${fixtureId}/${name}`);
          }
          generatedSkills[name] = root;
          skillMetadata.push({ name, fixtureId, path: path.join(root, 'SKILL.md'), digest: skill.digest });
        }
        const fixtureRoots = Object.fromEntries(contributorIds.map((id) => [id, preparedFixtures.get(id).fixtureRoot]));
        const contractOptions = { ...config, caseId, generatedSkills, fixtureRoots, motherSkillRoot: runtime.motherSkillRoot };
        const contract = await prepareTriggerCase(caseId, contractOptions);
        const contextInventories = new Map();
        const expectedContexts = [];
        for (const contributor of contributors) {
          contextInventories.set(contributor.fixtureId, await inventoryCodexTree(contributor.repositoryRoot));
          expectedContexts.push({ ...contributor, repositoryFingerprint: await fingerprintRepository(contributor.repositoryRoot) });
        }
        session = await openSession(runtime, contributors.find((entry) => entry.fixtureId === triggerCase.fixture).repositoryRoot, 'trigger', triggerCase.fixture, result.runId, dependencies.launch, { caseId, contributors }, config);
        if (threadIds.has(session.threadId)) throw failure('SESSION_REUSE', 'routing reused an earlier thread');
        threadIds.add(session.threadId);
        await session.client.request('skills/extraRoots/set', { extraRoots: Object.values(generatedSkills) });
        const discovery = await session.client.request('skills/list', { cwds: contributors.map((entry) => entry.repositoryRoot), forceReload: true });
        if (!Array.isArray(discovery?.data) || discovery.data.length !== contributors.length) throw failure('SKILL_DISCOVERY', 'missing complete discovery results');
        for (const entry of discovery.data) {
          if (!contributors.some((context) => context.repositoryRoot === entry.cwd) || !Array.isArray(entry.skills) || !Array.isArray(entry.errors) || entry.errors.length) throw failure('SKILL_DISCOVERY', 'discovery cwd or errors are invalid');
        }
        for (const [name, root] of Object.entries(generatedSkills)) {
          if (!discovery.data.some((entry) => entry.skills.some((skill) => skill.name === name && skill.path === path.join(root, 'SKILL.md') && skill.enabled === true && ['user', 'repo', 'system', 'admin'].includes(skill.scope)))) {
            throw failure('SKILL_DISCOVERY', `generated contributor ${name} was not discovered at its exact physical path`);
          }
        }
        const input = [{ type: 'text', text: triggerCase.prompt }];
        if (triggerCase.invocation) input.push({ type: 'skill', name: triggerCase.invocation.skill, path: path.join(generatedSkills[triggerCase.invocation.skill], 'SKILL.md') });
        const contextPreparation = await createContributorContext(copies, skillMetadata.map((metadata) => ({ ...metadata,
          description: discovery.data.flatMap((entry) => entry.skills).find((entry) => entry.path === metadata.path && entry.name === metadata.name).description,
        })));
        const capture = await session.client.runTurn({ threadId: session.threadId, input,
          additionalContext: { 'agent-init:contributors': { kind: 'untrusted', value: contextPreparation.value } },
          approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly', networkAccess: false }, outputSchema: { type: 'object' } });
        const caseRecord = { caseId, synthetic: true, status: 'incomplete', artifact: null, capture, discovery,
          threadRequest: session.threadRequest, contextPreparation: { digest: contextPreparation.digest, nativeConsumptionProven: false } };
        result.cases.push(caseRecord);
        const selection = parseCodexSelection(capture, { mode: 'synthetic', runId: result.runId, sessionId: session.sessionId, knownSkills: [...corpus.knownSkills] });
        if (selection.status !== 'complete') {
          caseRecord.selection = selection;
          throw failure('SELECTION_INCOMPLETE', 'no complete selection evidence; loaded is not inferred');
        }
        const contexts = capture.events.find((event) => event.method === 'synthetic/selection.complete').params.contexts;
        if (JSON.stringify(contexts) !== JSON.stringify(expectedContexts)) throw failure('CONTRIBUTOR_CONTEXT', 'synthetic receipt does not cover every actual contributor context');
        for (const contributor of contributors) {
          if (JSON.stringify(await inventoryCodexTree(contributor.repositoryRoot)) !== JSON.stringify(contextInventories.get(contributor.fixtureId))) throw failure('ROUTING_WRITE', 'read-only routing changed a contributor repository');
        }
        const observation = { harness: 'codex', harnessVersion: session.harnessVersion, selectionEvidence: selection.selectionEvidence, recordedAt: new Date().toISOString() };
        if (triggerCase.invocation) {
          const actualSkill = capture.request.params.input.filter((entry) => entry.type === 'skill');
          const actualText = capture.request.params.input.filter((entry) => entry.type === 'text');
          if (actualSkill.length !== 1 || actualText.length !== 1) throw failure('INVOCATION_EVIDENCE', 'explicit request lacks a unique actual Skill and prompt');
          observation.invocation = { mode: 'explicit', skill: actualSkill[0].name, prompt: actualText[0].text };
        }
        const artifact = JSON.parse(JSON.stringify(createTriggerArtifact(contract, observation)));
        const evaluation = await evaluateTriggerArtifact(artifact, contractOptions);
        const triggerExit = await session.client.close();
        result.sessions.push({ sessionId: session.sessionId, threadId: session.threadId, harnessVersion: session.harnessVersion, role: session.role, caseId, ...triggerExit });
        session = null;
        if (triggerExit.failure || triggerExit.exitCode !== 0 || triggerExit.signal) {
          throw failure('CODEX_SESSION_FAILURE', 'routing process failed; its candidate artifact is not valid evidence');
        }
        Object.assign(caseRecord, { status: artifact.result, artifact, evaluation, contextObserved: true });
      }
      result.status = result.cases.some((entry) => !entry.evaluation?.ok) ? 'synthetic-fail' : 'synthetic-pass';
      result.phase = 'complete';
    }
  } catch (cause) {
    result.status = 'failed';
    result.error = { code: cause.code ?? 'CODEX_RUN', message: cause.message };
    if (cause.errors) result.error.causes = cause.errors.map((error) => ({ code: error.code ?? 'INSTALL_FAILURE', message: error.message }));
    if (cause.installation) result.installation = cause.installation;
    if (cause.cleanup) result.cleanup = { ...cause.cleanup, ...(cause.cleanup.removed === false ? { ownedRoot: cause.ownedRoot, ownedIdentity: cause.ownedIdentity } : {}) };
    processCleanupUnconfirmed = cause.processCleanupUnconfirmed === true;
  } finally {
    try {
      if (session) result.sessions.push({ sessionId: session.sessionId, threadId: session.threadId, harnessVersion: session.harnessVersion, role: session.role, fixtureId: session.fixtureId, ...(await session.client.close()) });
    } catch (cause) {
      result.status = 'failed';
      result.cleanupError = { code: cause.code ?? 'CODEX_CLEANUP', message: cause.message };
      processCleanupUnconfirmed = true;
    } finally {
      if (runtime) {
        if (processCleanupUnconfirmed) {
          result.cleanup = { removed: false, error: { code: 'CODEX_CLEANUP', message: 'session or callback finalization is unconfirmed; owned root retained without deletion' } };
        } else {
          try { result.cleanup = await runtime.cleanup(); }
          catch (cause) { result.status = 'failed'; result.cleanup = { removed: false, error: { code: cause.code ?? 'OWNED_CLEANUP', message: cause.message } }; }
        }
      }
      if (result.cleanupError || result.cleanup?.removed === false) {
        for (const entry of result.cases) {
          entry.artifact = null;
          entry.status = 'incomplete';
          delete entry.evaluation;
        }
      }
    }
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length === 3 && process.argv[2] === '--help') {
    process.stdout.write('Codex ticket08 runner: exported runCodex(config, { launch, approve }).\n'
      + 'Synthetic orchestration is exercised by tests/codex-live/runner.test.js.\n'
      + 'Native execution is deferred: separate authorization, containment and complete observation integration are required.\n');
  } else {
    process.stderr.write('NATIVE_EXECUTION_DEFERRED: direct command invocation cannot launch Codex or a model. Use --help.\n');
    process.exitCode = 2;
  }
}
