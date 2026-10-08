import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import { digestTree } from '../../src/installation/filesystem.js';
import { snapshotTree } from '../installation/helpers.js';
import { claudeEventFailure, parseClaudeTrace } from './claude-selection.js';
import { captureClaudeProposal, claudeProposalPrompt, claudeProposalSchema } from './claude-proposal.js';
import { captureClaudeApproval, claudeApprovalRequest, claudeTerminalJson, readClaudeTerminalApproval } from './claude-approval.js';
import { resolveClaudeConnection } from './claude-connection.js';
import { prepareClaudeNativeObservation, collectClaudeNativeObservation, collectClaudeNativeProposalObservation, enableClaudeNativeApplyHooks,
  captureClaudeNativeDeferred, collectClaudeNativeDeniedResume, invokeClaudeNativeRoutingSession } from './claude-native-session.js';
import { prepareClaudeNativeApply, captureClaudeNativeApplyDeferred, completeClaudeNativeApply } from './claude-native-apply.js';
import { claudeJsonSecretFailure, sensitiveClaudeText } from './claude-input-policy.js';
import { validateClaudeNativeSetup } from './claude-native-validation.js';
import { runClaudeNativeRouting } from './claude-native-routing.js';
import { digestProposal, fingerprintPath, fingerprintRepository, validateWriteTargetPhysicalScope } from './evaluation-harness.js';
import { loadTriggerCorpus, prepareTriggerCase } from './trigger-evaluation.js';
import { assertClaudeContextsFresh, simulateClaudeRouting, simulateClaudeSetup, snapshotContext } from './claude-protocol.js';

const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
const baseSha = 'e5097877fa4172c8b2eb27b394aff374803b42fe';
const fixtureId = '11-maven-multi-module-build-verify';
const version = '2.1.285';
const model = 'claude-opus-5-5';
const requiredFlags = ['--bare', '--restricted', '--print', '--output-format', '--verbose', '--tools',
  '--permission-mode', '--permission-prompts', '--max-budget-usd', '--model', '--add-dir', '--session-id',
  '--no-session-persistence', '--strict-mcp-config', '--mcp-config', '--prompt-suggestions'];

function outcome(status, code) {
  return { status, code, artifacts: [], liveSkillBehaviorProven: false };
}

function failure(code) {
  return Object.assign(new Error(code), { code });
}

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

// No shell, unbounded output, implicit retries, or inherited authentication.
export function invokeClaudeProcess(request) {
  if (process.platform === 'win32') {
    return Promise.resolve({ status: null, signal: null, stdout: '', stderr: '',
      spawnError: failure('PROCESS_TREE_UNSUPPORTED') });
  }
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let timedOut = false;
    let truncated = false;
    let stopReason;
    let spawnError;
    let cleanupError;
    let groupKilled = false;
    let pending = '';
    let child;
    try {
      child = spawn(request.command, request.args, {
        cwd: request.cwd, env: request.env, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ status: null, signal: null, stdout, stderr, spawnError: error });
      return;
    }
    let killTimer;
    let reapTimer;
    let settled = false;
    function finish(status, signal) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearTimeout(reapTimer);
      resolve({ status: spawnError ? null : status, signal, stdout, stderr, spawnError, cleanupError, timedOut, truncated, stopReason });
    }
    function killGroup(signal) {
      if (!child.pid || groupKilled) return;
      try {
        process.kill(-child.pid, signal);
        if (signal === 'SIGKILL') groupKilled = true;
      } catch (error) {
        if (error.code === 'ESRCH') groupKilled = true;
        else cleanupError = { code: error.code ?? 'PROCESS_CLEANUP_FAILED', signal };
      }
    }
    function stop() {
      if (killTimer) return;
      killGroup('SIGTERM');
      killTimer = setTimeout(() => killGroup('SIGKILL'), 250);
      reapTimer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish(null, 'SIGKILL');
      }, 750);
    }
    const timer = setTimeout(() => { timedOut = true; stop(); }, request.timeoutMs ?? 180000);
    function receive(chunk, channel) {
      bytes += Buffer.byteLength(chunk);
      if (bytes > (request.maxOutputBytes ?? 8 * 1024 * 1024)) {
        truncated = true;
        stop();
        return;
      }
      if (channel === 'stderr') { stderr += chunk; return; }
      stdout += chunk;
      if (!request.stopOnRetry) return;
      pending += chunk;
      let newline;
      while ((newline = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        try {
          const event = JSON.parse(line);
          const eventFailure = claudeEventFailure(event, request);
          if (!eventFailure) continue;
          stopReason = eventFailure;
        } catch (cause) {
          stopReason = cause instanceof SyntaxError ? 'TRACE_MALFORMED' : 'TRACE_MONITOR_FAILED';
        }
        stop();
        return;
      }
    }
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => receive(chunk, 'stdout'));
    child.stderr.on('data', (chunk) => receive(chunk, 'stderr'));
    child.on('error', (error) => { spawnError = error; });
    // A parent can exit before its descendants, including ones holding our pipes.
    child.on('exit', () => killGroup('SIGKILL'));
    child.on('close', (status, signal) => {
      killGroup('SIGKILL');
      finish(status, signal);
    });
  });
}

function isolatedEnvironment(home, root, source) {
  const parsed = path.parse(home);
  return {
    ...(source.PATH ? { PATH: source.PATH } : {}),
    ...(process.platform === 'win32' && source.SystemRoot ? { SystemRoot: source.SystemRoot } : {}),
    HOME: home, USERPROFILE: home, HOMEDRIVE: parsed.root, HOMEPATH: home.slice(parsed.root.length),
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_DATA_HOME: path.join(home, '.local/share'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    TMPDIR: path.join(root, 'tmp'), TEMP: path.join(root, 'tmp'), TMP: path.join(root, 'tmp'),
    npm_config_cache: path.join(root, 'npm-cache'), npm_config_userconfig: path.join(root, 'user.npmrc'),
    npm_config_globalconfig: path.join(root, 'global.npmrc'), npm_config_offline: 'true',
    npm_config_ignore_scripts: 'true', npm_config_audit: 'false', npm_config_fund: 'false',
    npm_config_update_notifier: 'false', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig'),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: '1',
  };
}

async function checkedProcess(command, args, cwd, env, code) {
  const result = await invokeClaudeProcess({ command, args, cwd, env });
  if (result.cleanupError) throw failure('PROCESS_CLEANUP_FAILED');
  if (result.status !== 0 || result.signal || result.spawnError || result.timedOut || result.truncated) throw failure(code);
  return result;
}

async function installBaseline(root, repository, env, gitExecutable, fixtureIds = [fixtureId]) {
  const source = path.join(root, 'source');
  const pack = path.join(root, 'pack');
  const prefix = path.join(root, 'prefix');
  const archive = path.join(root, 'baseline.tar');
  await Promise.all([mkdir(source), mkdir(pack), mkdir(prefix)]);
  await checkedProcess(gitExecutable, ['archive', '--format=tar', '--output', archive, baseSha,
    'package.json', 'README.md', 'LICENSE', 'bin', 'src', 'skills', ...fixtureIds.map((id) => `tests/fixtures/${id}`)], repository, env, 'BASELINE_UNAVAILABLE');
  await checkedProcess('tar', ['-xf', archive, '-C', source], root, env, 'BASELINE_UNPACK_FAILED');
  const metadata = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'));
  const packed = await checkedProcess(process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['pack', '--ignore-scripts', '--offline', '--json', '--pack-destination', pack], source, env, 'PACK_FAILED');
  const entries = JSON.parse(packed.stdout);
  const entry = entries[0];
  if (entries.length !== 1 || entry.name !== metadata.name || entry.version !== metadata.version
    || typeof entry.filename !== 'string' || path.basename(entry.filename) !== entry.filename) throw failure('PACK_IDENTITY');
  const tarball = path.join(pack, entry.filename);
  await checkedProcess(process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['install', '--offline', '--ignore-scripts', '--no-package-lock', '--prefix', prefix, tarball], source, env, 'PACKAGE_INSTALL_FAILED');
  const packageDirectory = path.join(prefix, 'node_modules', ...metadata.name.split('/'));
  await checkedProcess(process.execPath, [path.join(packageDirectory, 'bin/agent-init.js'), 'install'], source, env, 'MOTHER_INSTALL_FAILED');
  const motherSkillRoot = await realpath(path.join(env.HOME, '.claude/skills/agent-init'));
  const relativeMother = path.relative(await realpath(env.HOME), motherSkillRoot);
  if (relativeMother === '..' || relativeMother.startsWith(`..${path.sep}`) || path.isAbsolute(relativeMother)) throw failure('MOTHER_OUTSIDE_HOME');
  const motherSkillDigest = await digestTree(motherSkillRoot);
  if (motherSkillDigest !== await digestTree(path.join(source, 'skills/agent-init'))) throw failure('MOTHER_DIGEST');
  return {
    source,
    package: { name: metadata.name, version: metadata.version, baseSha, tarballDigest: sha256(await readFile(tarball)), motherSkillRoot, motherSkillDigest },
  };
}

async function repositoryEvidence(entries, secrets, cwd) {
  const privatePath = target => sensitiveClaudeText(target) || secrets.some(secret => secret && target.includes(secret));
  const files = entries.filter(entry => entry.type === 'file').map(entry => {
    if (privatePath(entry.path)) throw failure('SECRET_INPUT');
    const bytes = Buffer.from(entry.content, 'base64');
    const metadata = { path: entry.path, fingerprint: sha256(bytes) };
    if (/(?:^|\/)(?:\.env(?:\.[^/]+)?|\.npmrc|(?:credentials|secrets)(?:\.[^/]+)?|id_(?:rsa|ed25519)|[^/]+\.(?:pem|key|p12|pfx))$|(?:^|\/)\.claude\/(?:settings|settings\.local)\.json$/i.test(entry.path)) return { ...metadata, presenceOnly: true };
    let content;
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { return { ...metadata, presenceOnly: true, binary: true }; }
    return sensitiveClaudeText(content) || secrets.some(secret => secret && content.includes(secret))
      ? { ...metadata, presenceOnly: true } : { ...metadata, content };
  });
  // Only reference planning metadata enters the model input; physical identities,
  // timestamps, unrelated link targets and the validation inventory stay private.
  const agentAssets = [];
  for (const entry of entries.filter(entry => entry.path === '.claude' || entry.path === '.claude/skills'
    || /^\.claude\/skills\/[^/]+$/.test(entry.path))) {
    if (privatePath(entry.path)) throw failure('SECRET_INPUT');
    const asset = { path: entry.path, type: entry.type, mode: entry.mode };
    if (entry.type === 'symlink') {
      asset.fingerprint = await fingerprintPath(cwd, entry.path);
      const name = /^\.claude\/skills\/([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(entry.path)?.[1];
      const canonical = `.agents/skills/${name}`;
      if (name && entry.linkText === `../../${canonical}` && !(await validateWriteTargetPhysicalScope(cwd, canonical)).length) {
        try {
          if (await realpath(path.join(cwd, entry.path)) === await realpath(path.join(cwd, canonical))) asset.linkText = entry.linkText;
        } catch (cause) { if (cause.code !== 'ENOENT') throw failure('NATIVE_SETUP_ASSET_SCOPE'); }
      }
      if (!asset.linkText) asset.presenceOnly = true;
    }
    agentAssets.push(asset);
  }
  const input = { source: 'owned-repository-snapshot', files, agentAssets };
  if (files.length > 512 || agentAssets.length > 128 || Buffer.byteLength(JSON.stringify(input)) > 1024 * 1024) throw failure('NATIVE_SETUP_INPUT_LIMIT');
  return input;
}

// Preparation only: callers still need approved real setup and observed discovery.
// Explicit probes are Claude-private descriptors, not AI-040 corpus artifacts.
export async function prepareClaudeRoutingInputs(options) {
  if (!options?.motherSkillRoot || !options.fixtureRoots || !options.generatedSkillsByFixture) throw failure('ROUTING_INPUTS_REQUIRED');
  const corpus = await loadTriggerCorpus();
  const cases = [];
  const explicitProbes = new Map();
  for (const triggerCase of corpus.cases) {
    const fixtureIds = [...new Set([triggerCase.fixture, ...Object.values(triggerCase.skillFixtures)])];
    if (fixtureIds.some((id) => !options.fixtureRoots[id])) throw failure('FIXTURE_ROOT_REQUIRED');
    const generatedSkills = Object.fromEntries(Object.entries(triggerCase.skillFixtures).map(([name, fixture]) => [name, options.generatedSkillsByFixture[fixture]?.[name]]));
    const inputs = { fixtureRoots: options.fixtureRoots, generatedSkills, motherSkillRoot: options.motherSkillRoot };
    const prepared = await prepareTriggerCase(triggerCase.id, inputs);
    cases.push({ prepared, inputs, discoveryDirectories: fixtureIds.map((id) => path.join(options.fixtureRoots[id], 'repository')) });
    if (triggerCase.category !== 'positive') continue;
    for (const [skill, fixture] of Object.entries(triggerCase.skillFixtures)) {
      const id = `${fixture}-${skill}-explicit-01`;
      const prompt = `/${skill}`;
      explicitProbes.set(id, { id, kind: 'explicit-invocation', fixture, skill, prompt, promptDigest: sha256(prompt),
        digests: prepared.digests, consumerValidated: false, liveSkillBehaviorProven: false });
    }
  }
  return { cases, explicitProbes: [...explicitProbes.values()], liveSkillBehaviorProven: false };
}

export async function runClaudeSimulation(options = {}, boundaries = {}) {
  const result = { ...outcome('blocked', 'SIMULATION_OPT_IN_REQUIRED'), executionKind: 'test-double',
    qualification: 'unqualified', simulationArtifacts: [] };
  if (options.simulate !== true) return result;
  if (options.live === true) return { ...result, code: 'SIMULATION_LIVE_CONFLICT' };
  if (process.platform === 'win32') return { ...result, code: 'PROCESS_TREE_UNSUPPORTED' };
  if ((options.baseSha ?? baseSha) !== baseSha) return { ...result, code: 'BASELINE_MISMATCH' };
  const root = await mkdtemp(path.join(tmpdir(), 'agent-init-claude-simulation-'));
  const home = path.join(root, 'home');
  const env = { ...isolatedEnvironment(home, root, options.env ?? process.env), GIT_CEILING_DIRECTORIES: root };
  Object.assign(result, { disposableRoot: root, harness: 'claude-code', setups: [], routingSessions: [],
    reportPath: path.join(root, 'evidence/claude-simulation/report.json') });
  try {
    await Promise.all([mkdir(home, { mode: 0o700 }), mkdir(path.join(root, 'tmp')), mkdir(path.join(root, 'npm-cache')),
      mkdir(path.dirname(result.reportPath), { recursive: true, mode: 0o700 }),
      ...['user.npmrc', 'global.npmrc', 'gitconfig'].map((name) => writeFile(path.join(root, name), '', { mode: 0o600 }))]);
    const corpus = await loadTriggerCorpus();
    const fixtureIds = [...new Set(corpus.cases.flatMap((entry) => [entry.fixture, ...Object.values(entry.skillFixtures)]))].sort();
    const installation = await installBaseline(root, options.packageRoot ?? projectRoot, env,
      options.gitExecutable ?? (process.platform === 'darwin' ? '/usr/bin/git' : 'git'), fixtureIds);
    result.package = installation.package;
    for (const id of fixtureIds) {
      const setup = await simulateClaudeSetup({ root, source: installation.source, fixtureId: id }, boundaries);
      result.setups.push(setup);
      result.status = setup.status;
      result.code = setup.code;
      if (setup.status !== 'pass') break;
    }
    if (result.setups.length === fixtureIds.length && result.setups.every((setup) => setup.status === 'pass')) {
      await assertClaudeContextsFresh(result.setups);
      const fixtureRoots = Object.fromEntries(result.setups.map((setup) => [setup.fixtureId, setup.routingFixtureRoot]));
      const generatedSkillsByFixture = Object.fromEntries(result.setups.map((setup) => [setup.fixtureId,
        Object.fromEntries(setup.proposal.actions.filter((action) => action.kind === 'project-skill' && action.action === 'CREATE')
          .map((action) => [action.skillCandidate.name, path.dirname(path.join(setup.roots.finalRoot, action.target))]))]));
      const preparation = await prepareClaudeRoutingInputs({ fixtureRoots, generatedSkillsByFixture, motherSkillRoot: result.package.motherSkillRoot });
      Object.assign(result, await simulateClaudeRouting(preparation, result.setups, result.package.motherSkillRoot, boundaries));
    }
  } catch (cause) {
    result.status = 'error';
    result.code = /^[A-Z_]+$/.test(cause.code ?? '') ? cause.code : 'SIMULATION_FAILED';
  }
  const physicalRoot = await realpath(root);
  const redact = (value) => JSON.stringify(value, null, 2).replaceAll(physicalRoot, '<owned-disposable-root>').replaceAll(root, '<owned-disposable-root>');
  for (const record of result.simulationArtifacts) {
    record.evidencePath = path.join(path.dirname(result.reportPath), `${record.id}.json`);
    await writeFile(record.evidencePath, `${redact(record).replaceAll(physicalRoot, '<owned-disposable-root>')}\n`, { mode: 0o600, flag: 'wx' });
  }
  const evidence = redact(result).replaceAll(physicalRoot, '<owned-disposable-root>');
  await writeFile(result.reportPath, `${evidence}\n`, { mode: 0o600, flag: 'wx' });
  return result;
}

export async function runClaudeLiveAcceptance(options = {}, boundaries = {}) {
  if (options.simulate === true && options.live === true) return outcome('blocked', 'SIMULATION_LIVE_CONFLICT');
  if (options.live !== true) return outcome('blocked', 'LIVE_OPT_IN_REQUIRED');
  if (!['capability-probe', 'setup-proposal', 'native-observation', 'native-defer', 'native-discovery', 'native-setup', 'native-corpus'].includes(options.scope)) return outcome('blocked', 'LIVE_SCOPE_REQUIRED');
  if (options.authorizeNativeCorpus !== undefined && (options.authorizeNativeCorpus !== true || options.scope !== 'native-corpus')) return outcome('blocked', 'NATIVE_CORPUS_SCOPE');
  if (options.scope === 'native-corpus' && options.authorizeNativeCorpus !== true) return outcome('blocked', 'NATIVE_CORPUS_AUTHORIZATION_REQUIRED');
  if (options.authorizeNativeSetup !== undefined && (options.authorizeNativeSetup !== true || options.scope !== 'native-setup')) return outcome('blocked', 'NATIVE_SETUP_SCOPE');
  if (options.scope === 'native-setup' && options.authorizeNativeSetup !== true) return outcome('blocked', 'NATIVE_SETUP_AUTHORIZATION_REQUIRED');
  if (options.authorizeNativeDiscovery !== undefined && (options.authorizeNativeDiscovery !== true || options.scope !== 'native-discovery')) return outcome('blocked', 'NATIVE_DISCOVERY_SCOPE');
  if (options.scope === 'native-discovery' && options.authorizeNativeDiscovery !== true) return outcome('blocked', 'NATIVE_DISCOVERY_AUTHORIZATION_REQUIRED');
  if (options.authorizeNativeProtocol !== undefined && (options.authorizeNativeProtocol !== true || options.scope !== 'native-defer')) return outcome('blocked', 'NATIVE_PROTOCOL_SCOPE');
  if (options.scope === 'native-defer' && options.authorizeNativeProtocol !== true) return outcome('blocked', 'NATIVE_PROTOCOL_AUTHORIZATION_REQUIRED');
  if (options.authorizeNativeObservation !== undefined && (options.authorizeNativeObservation !== true || options.scope !== 'native-observation')) return outcome('blocked', 'NATIVE_SCOPE');
  if (options.scope === 'native-observation' && options.authorizeNativeObservation !== true) return outcome('blocked', 'NATIVE_AUTHORIZATION_REQUIRED');
  if (options.probeInvocation !== undefined && (options.scope !== 'capability-probe'
    || !['explicit', 'implicit'].includes(options.probeInvocation))) return outcome('blocked', 'PROBE_SCOPE');
  if (options.requestProposalApproval !== undefined && (options.requestProposalApproval !== true || !['setup-proposal', 'native-setup', 'native-corpus'].includes(options.scope))) return outcome('blocked', 'APPROVAL_SCOPE');
  if (options.scope === 'setup-proposal' && options.authorizeSetupProposal !== true) return outcome('blocked', 'SETUP_AUTHORIZATION_REQUIRED');
  if (boundaries.approvalTerminal && boundaries.requestApproval) return outcome('blocked', 'APPROVAL_BOUNDARY');
  if (['native-setup', 'native-corpus'].includes(options.scope) && !boundaries.invokeClaude && (boundaries.approvalTerminal || boundaries.requestApproval)) {
    return outcome('blocked', 'NATIVE_APPROVAL_AUTHORITY');
  }
  const approvalTerminal = boundaries.approvalTerminal ?? { input: process.stdin, output: process.stdout };
  if (options.requestProposalApproval && !boundaries.requestApproval && (!approvalTerminal.input?.isTTY || !approvalTerminal.output?.isTTY)) return outcome('blocked', 'APPROVAL_TERMINAL_REQUIRED');
  if (options.fixtureId !== undefined && (!['setup-proposal', 'native-setup'].includes(options.scope)
    || typeof options.fixtureId !== 'string' || !/^[0-9]{2}-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(options.fixtureId))) return outcome('blocked', 'FIXTURE_SCOPE');
  const defaultFixtureId = options.fixtureId ?? fixtureId;
  const nativeCorpus = options.scope === 'native-corpus';
  if ((nativeCorpus || options.maxModelProcesses !== undefined || options.totalModelBudgetUsd !== undefined)
    && (!['native-setup', 'native-corpus'].includes(options.scope) || !Number.isSafeInteger(options.maxModelProcesses) || options.maxModelProcesses < 1
      || options.maxModelProcesses > 256 || !Number.isSafeInteger(options.totalModelBudgetUsd)
      || options.totalModelBudgetUsd < 3 || options.totalModelBudgetUsd > 768
      || options.totalModelBudgetUsd < options.maxModelProcesses * 3)) return outcome('blocked', 'MODEL_BUDGET_SCOPE');
  if (process.platform === 'win32') return outcome('blocked', 'PROCESS_TREE_UNSUPPORTED');
  const sourceEnv = options.env ?? process.env;
  let connection;
  try { connection = resolveClaudeConnection(options, sourceEnv, model); }
  catch (cause) { return outcome('blocked', /^[A-Z_]+$/.test(cause.code ?? '') ? cause.code : 'CONNECTION_INVALID'); }
  if ((options.baseSha ?? baseSha) !== baseSha) return outcome('blocked', 'BASELINE_MISMATCH');
  if (typeof options.claudeExecutable !== 'string' || !path.isAbsolute(options.claudeExecutable)) return outcome('blocked', 'CLAUDE_EXECUTABLE_REQUIRED');
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'agent-init-claude-live-')));
  const home = path.join(root, 'home');
  const env = { ...isolatedEnvironment(home, root, sourceEnv), GIT_CEILING_DIRECTORIES: root };
  const result = { ...outcome('blocked', 'SELECTION_PROTOCOL_UNVERIFIED'), disposableRoot: root, scope: options.scope,
    ...(connection.provenance ? { connection: connection.provenance } : {}),
    executionKind: boundaries.invokeClaude || boundaries.requestApproval || boundaries.approvalTerminal ? 'test-double' : 'real-cli', qualification: 'unqualified', harness: 'claude-code', probes: [] };
  try {
    await Promise.all([mkdir(home, { mode: 0o700 }), mkdir(path.join(root, 'tmp')), mkdir(path.join(root, 'npm-cache')),
      mkdir(path.join(root, 'evidence/claude-live'), { recursive: true }),
      ...['user.npmrc', 'global.npmrc', 'gitconfig'].map((name) => writeFile(path.join(root, name), '', { mode: 0o600 }))]);
    const invoke = boundaries.invokeClaude ?? invokeClaudeProcess;
    const executable = await realpath(options.claudeExecutable);
    const closedSetups = [];
    let heldMother;
    let motherSkillRoot;
    const checkHeldContexts = async () => {
      if (!nativeCorpus) return;
      await assertClaudeContextsFresh(closedSetups);
      if (heldMother && !isDeepStrictEqual(heldMother, await snapshotContext(motherSkillRoot))) throw failure('UNAPPROVED_WRITES');
    };
    // Every setup, pending Apply resume, reconcile and routing process shares this
    // one independently bounded counter; adapter calls cannot bypass the quota.
    const modelQuotaExhausted = () => result.runtimeLimits && (result.runtimeLimits.modelProcessAttempts >= result.runtimeLimits.maxModelProcessAttempts
      || (result.runtimeLimits.modelProcessAttempts + 1) * 3 > result.runtimeLimits.configuredTotalBudgetUsd);
    const countedInvoke = async request => {
      await checkHeldContexts();
      if (request.sessionId && result.runtimeLimits) {
        if (modelQuotaExhausted()) throw failure('MODEL_PROCESS_BUDGET_EXHAUSTED');
        result.runtimeLimits.modelProcessAttempts++;
      }
      try { return await invoke(request); }
      finally { await checkHeldContexts(); }
    };
    const invokeRequest = (args, cwd, sessionId) => countedInvoke({ command: executable, args, cwd, sessionId,
      env: sessionId ? { ...env, ...connection.env } : env, timeoutMs: 180000, maxOutputBytes: 8 * 1024 * 1024,
      stopOnRetry: Boolean(sessionId) && options.scope === 'capability-probe', readRoots: [home, cwd] });
    const installedVersion = await invokeRequest(['--version'], root);
    if (installedVersion.cleanupError) throw failure('PROCESS_CLEANUP_FAILED');
    if (installedVersion.status !== 0 || installedVersion.signal || installedVersion.spawnError || installedVersion.timedOut
      || installedVersion.truncated || installedVersion.stopReason || typeof installedVersion.stdout !== 'string'
      || installedVersion.stdout.trim() !== `${version} (Claude Code)`) throw failure('HARNESS_VERSION_UNAVAILABLE');
    const help = await invokeRequest(['--help'], root);
    if (help.cleanupError) throw failure('PROCESS_CLEANUP_FAILED');
    const nativeDiscovery = options.scope === 'native-discovery';
    const nativeSetup = nativeCorpus || options.scope === 'native-setup';
    const nativeToolFree = nativeDiscovery || nativeSetup;
    const nativeObservation = nativeDiscovery || options.scope === 'native-observation';
    const nativeDefer = options.scope === 'native-defer';
    const nativeSessionMode = nativeObservation || nativeDefer || nativeSetup;
    if (nativeSessionMode) result.runtimeLimits = { maxModelProcessAttempts: nativeSetup ? options.maxModelProcesses ?? 1 : nativeDefer ? 2 : 1,
      modelProcessAttempts: 0, perProcessTimeoutMs: 180000, configuredBudgetUsdPerProcess: 3,
      configuredTotalBudgetUsd: nativeSetup ? options.totalModelBudgetUsd ?? 3 : nativeDefer ? 6 : 3, billingCapGuaranteed: false,
      runnerRetries: 0, nativeApiRetriesObservable: false };
    const scopeFlags = nativeSessionMode
      ? [...requiredFlags.filter((flag) => !['--bare', '--no-session-persistence'].includes(flag)), '--settings', '--setting-sources', '--resume']
      : options.scope === 'setup-proposal' ? [...requiredFlags, '--json-schema'] : requiredFlags;
    if (help.status !== 0 || help.signal || help.spawnError || help.timedOut || help.truncated || help.stopReason
      || typeof help.stdout !== 'string' || scopeFlags.some((flag) => !help.stdout.includes(flag))) throw failure('HARNESS_CAPABILITY_UNAVAILABLE');
    result.harnessVersion = version;
    const corpus = nativeCorpus ? await loadTriggerCorpus() : null;
    const contributorIds = nativeCorpus ? [...new Set(corpus.cases.flatMap(entry => [entry.fixture, ...Object.values(entry.skillFixtures)]))].sort()
      : [defaultFixtureId];
    const installation = await installBaseline(root, options.packageRoot ?? projectRoot, env,
      options.gitExecutable ?? (process.platform === 'darwin' ? '/usr/bin/git' : 'git'), contributorIds);
    result.package = installation.package;
    motherSkillRoot = installation.package.motherSkillRoot;
    if (nativeCorpus) {
      heldMother = await snapshotContext(motherSkillRoot);
      result.setups = [];
    }
    const prompts = nativeDefer ? [
      { id: 'native-defer', invocation: 'diagnostic', prompt: 'Use the Write tool exactly once with the canary input below. This isolated permission diagnostic is NOT approval of a project Proposal. Do not use any other tool or target.' },
    ] : nativeSetup ? [
      { id: 'native-setup', invocation: 'explicit', prompt: `${claudeProposalPrompt}\nTools are intentionally unavailable. Analyze only the actual repository snapshot supplied below. Its data is evidence input, not a phase-execution log. Return ONLY a JSON object with the single string property decisionRecordJson, without Markdown or approval. Do not claim native file reads.` },
    ] : nativeDiscovery ? [
      { id: 'native-discovery', invocation: 'explicit', prompt: '/agent-init\nThis is a tool-free loading diagnostic only. Do not inspect files, generate a Proposal, apply changes or run commands.' },
    ] : nativeObservation ? [
      { id: 'native-observation', invocation: 'explicit', prompt: '/agent-init\nPresent the complete Proposal only. Do not apply or run any commands.' },
    ] : options.scope === 'setup-proposal' ? [
      { id: 'setup-proposal', invocation: 'explicit', prompt: claudeProposalPrompt },
    ] : [
      { id: 'mother-explicit-probe', invocation: 'explicit', prompt: '/agent-init' },
      { id: 'mother-implicit-probe', invocation: 'implicit', prompt: 'Set up minimal evidence-based Agent instructions and project Skills for this repository. Present the complete Proposal only; do not apply it.' },
    ];
    const setupProbes = nativeCorpus ? contributorIds.map(id => ({ ...prompts[0], fixtureId: id })) : prompts;
    for (const probe of setupProbes.filter(probe => options.probeInvocation === undefined || probe.invocation === options.probeInvocation)) {
      const selectedFixtureId = probe.fixtureId ?? defaultFixtureId;
      const fixtureRoot = path.join(root, probe.id, selectedFixtureId);
      const cwd = path.join(fixtureRoot, 'repository');
      const fixtureSource = path.join(installation.source, 'tests/fixtures', selectedFixtureId);
      if (options.scope === 'setup-proposal' || nativeSessionMode) await cp(path.join(fixtureSource, 'repository'), cwd, { recursive: true, verbatimSymlinks: true });
      else await cp(fixtureSource, fixtureRoot, { recursive: true });
      // Frozen routing identity is parent-only metadata, never repository input
      // and never a source for a setup decision or model response.
      if (nativeCorpus) await cp(path.join(fixtureSource, 'fixture.json'), path.join(fixtureRoot, 'fixture.json'));
      const before = await snapshotTree(cwd);
      const setupRoots = nativeSetup ? { finalRoot: cwd, initialRoot: path.join(fixtureRoot, 'snapshots/initial'),
        proposalRoot: path.join(fixtureRoot, 'snapshots/proposal'), preWriteRoot: path.join(fixtureRoot, 'snapshots/pre-write') } : null;
      if (nativeSetup) await cp(cwd, setupRoots.initialRoot, { recursive: true, verbatimSymlinks: true });
      const sessionId = randomUUID();
      const fingerprints = Object.fromEntries(before.filter((entry) => entry.type === 'file')
        .map((entry) => [entry.path, sha256(Buffer.from(entry.content, 'base64'))]));
      const repositoryInput = nativeSetup ? await repositoryEvidence(before, connection.secrets, cwd) : null;
      const inputJson = repositoryInput ? JSON.stringify(repositoryInput) : '';
      // The physical inventory stays parent-only, never in the model prompt or report.
      const validationInput = nativeSetup ? { ...repositoryInput, inventory: await snapshotContext(cwd) } : null;
      if (nativeSetup && (repositoryInput.files.length > 512 || Buffer.byteLength(inputJson) > 1024 * 1024)) throw failure('NATIVE_SETUP_INPUT_LIMIT');
      const proposalPrompt = options.scope === 'setup-proposal' || nativeSetup;
      const prompt = proposalPrompt
        ? `${probe.prompt}\nExisting target fingerprints (runner-computed metadata, not inferred facts): ${JSON.stringify(fingerprints)}\nA missing target uses baselineFingerprint "missing". Every CREATE/UPDATE action must carry the exact baselineFingerprint; do not invent hashes.${nativeSetup ? `\nRepository evidence input: ${inputJson}` : ''}`
        : probe.prompt;
      const nativeSession = nativeSessionMode ? await prepareClaudeNativeObservation({ root, home, cwd, sessionId,
        motherSkillRoot: installation.package.motherSkillRoot, secrets: connection.secrets, deferCanary: nativeDefer, toolFree: nativeToolFree,
        ...(nativeToolFree ? { harnessVersion: version, materializationSources: [{ name: 'agent-init', namespace: 'user',
          aliasRoot: path.join(home, '.claude/skills/agent-init'), canonicalRoot: installation.package.motherSkillRoot, sourceContainer: home }] } : {}) }) : null;
      // Discovery and Proposal generation use owned inputs with every model
      // tool removed, rather than relaxing the existing readonly-tool profile.
      const args = [...(connection.bare && !nativeSessionMode ? ['--bare'] : []), ...(nativeToolFree ? [] : ['--restricted']), '--print', '--output-format',
        ...(nativeDefer || nativeSetup ? ['json'] : options.scope === 'setup-proposal' ? ['json', '--json-schema', JSON.stringify(claudeProposalSchema)] : ['stream-json', '--verbose']),
        '--tools', nativeToolFree ? '' : nativeDefer ? 'Write' : 'Read,Glob,Grep,Skill', '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
        '--max-budget-usd', '3', '--model', connection.model,
        ...(nativeSessionMode ? ['--settings', nativeSession.settingsFile, '--setting-sources', nativeToolFree ? 'user' : ''] : ['--no-session-persistence']), '--strict-mcp-config',
        '--mcp-config', '{"mcpServers":{}}', '--prompt-suggestions', 'false',
        '--add-dir', home, cwd, '--session-id', sessionId,
        nativeDefer ? `${prompt}\nCanary tool input: ${JSON.stringify(nativeSession.canary)}` : prompt];
      const readonlyRoots = [cwd, installation.package.motherSkillRoot];
      const readonlyBefore = options.scope === 'setup-proposal' || nativeSessionMode ? await Promise.all(readonlyRoots.map(snapshotContext)) : null;
      let processResult;
      try { processResult = await invokeRequest(args, cwd, sessionId); }
      finally {
        if (readonlyBefore) {
          const readonlyAfter = await Promise.all(readonlyRoots.map(snapshotContext));
          if (!isDeepStrictEqual(readonlyBefore, readonlyAfter)) throw failure('UNAPPROVED_WRITES');
        }
      }
      if (nativeDefer) {
        const context = { sessionId, secrets: connection.secrets };
        const pending = await captureClaudeNativeDeferred(nativeSession, processResult, context);
        const resumeArgs = [...args.slice(0, args.indexOf('--session-id')), '--resume', sessionId,
          'Resume the pending diagnostic only. It must be denied; do not issue a new tool call or modify any file.'];
        let resumed;
        try { resumed = await invokeRequest(resumeArgs, cwd, sessionId); }
        finally {
          if (!isDeepStrictEqual(readonlyBefore, await Promise.all(readonlyRoots.map(snapshotContext)))) throw failure('UNAPPROVED_WRITES');
        }
        const observed = await collectClaudeNativeDeniedResume(nativeSession, pending, resumed, context);
        result.nativeProtocol = { sessionId, fixtureId: selectedFixtureId, ...observed, zeroWrites: true,
          bashEnabled: false, liveSkillBehaviorProven: false };
        result.status = observed.status;
        result.code = observed.code;
        break;
      }
      if (nativeObservation) {
        const observed = await collectClaudeNativeObservation(nativeSession, processResult, { sessionId, harnessVersion: version,
          secrets: connection.secrets, captureSkillEvidence: false, requireSkillObservation: true, toolFree: nativeDiscovery,
          evidenceRoots: [root, await realpath(root)], cwd });
        result.nativeObservation = { sessionId, fixtureId: selectedFixtureId, ...observed, zeroWrites: true,
          ...(nativeDiscovery ? { toolFree: true, restricted: false, settingSources: ['user'] } : {}),
          mutationEnabled: false, bashEnabled: false, liveSkillBehaviorProven: false };
        result.status = observed.status;
        result.code = observed.code;
        break;
      }
      if (options.scope === 'setup-proposal' || nativeSetup) {
        const nativeProposalObservation = nativeSetup ? await collectClaudeNativeProposalObservation(nativeSession, processResult,
          { sessionId, harnessVersion: version, cwd, secrets: connection.secrets }) : null;
        const captured = await captureClaudeProposal(processResult, { sessionId, harnessVersion: version, secrets: connection.secrets, cwd,
          ...(nativeSetup ? { decisionFormat: 'json-result' } : {}) });
        if (nativeSetup) await cp(cwd, setupRoots.proposalRoot, { recursive: true, verbatimSymlinks: true });
        // JSON mode cannot monitor intermediate retries or reads; a configured
        // CLI budget is not a server-side hard billing cap or isolation proof.
        result.setup = { fixtureId: selectedFixtureId, sessionId, cwd, promptDigest: sha256(prompt), ...captured,
          ...(nativeSetup ? { sessionClosed: false, roots: setupRoots, nativeObservation: nativeProposalObservation, inputEvidence: { source: 'owned-repository-snapshot',
            inputDigest: sha256(inputJson), fileCount: repositoryInput.files.length, nativeFileReadClaimed: false } } : {}),
          zeroProposalWrites: true, readonlyGuard: 'before-after-fixture-and-mother-metadata', liveSkillBehaviorProven: false,
          runtimeLimits: nativeSetup ? result.runtimeLimits
            : { maxProcessAttempts: 1, timeoutMs: 180000, configuredBudgetUsd: 3, billingCapGuaranteed: false } };
        if (nativeCorpus) result.setups.push(result.setup);
        if (nativeSetup) {
          result.setup.validationScope = 'source-grounded-claude-native-contract';
          result.setup.run = { schemaVersion: 1, fixtureId: selectedFixtureId, harness: 'claude-native-decision-data',
            qualification: 'unqualified', evidenceLedger: captured.decisionRecord.evidenceLedger, events: [
              { type: 'preflight', readOnly: true, baselineId: `native-${sessionId}`,
                repositoryFingerprintBefore: await fingerprintRepository(setupRoots.initialRoot),
                existingAgentAssets: before.map(entry => entry.path)
                  .filter(target => target === 'AGENTS.md' || target === 'CLAUDE.md' || target.startsWith('.agents/') || target.startsWith('.claude/')) },
              { type: 'explore', readOnly: true, repositoryFingerprintAfter: await fingerprintRepository(setupRoots.proposalRoot),
                source: 'owned-repository-snapshot', nativeFileReadClaimed: false, sensitiveFiles: 'presence-only' },
              ...captured.decisionRecord.events,
            ] };
          // Validate against actual source bytes, not the recorded fixture oracle.
          // This establishes neither phase execution nor approval/permission.
          result.setup.proposalValidation = await validateClaudeNativeSetup({ captured, cwd, repositoryInput: validationInput, phase: 'proposal' });
          if (!result.setup.proposalValidation.ok) throw failure('PROPOSAL_INVALID');
        }
        result.code = 'APPROVAL_REQUIRED';
        if (options.requestProposalApproval) {
          const request = claudeApprovalRequest(captured, { nativeApply: nativeSetup });
          let input;
          await checkHeldContexts();
          try { input = await (boundaries.requestApproval ? boundaries.requestApproval(request) : readClaudeTerminalApproval(request, approvalTerminal)); }
          finally {
            await checkHeldContexts();
            result.setup.zeroApprovalWrites = isDeepStrictEqual(readonlyBefore, await Promise.all(readonlyRoots.map(snapshotContext)));
            if (!result.setup.zeroApprovalWrites) throw failure('APPROVAL_CONTEXT_DRIFT');
          }
          result.setup.approval = captureClaudeApproval(input, request, boundaries.requestApproval || boundaries.approvalTerminal ? 'test-double' : 'human-terminal', connection.secrets);
          result.code = result.setup.approval.code;
          if (nativeSetup && result.setup.approval.status === 'exact') {
            await cp(cwd, setupRoots.preWriteRoot, { recursive: true, verbatimSymlinks: true });
            const control = await realpath(nativeSession.control);
            const mutationCwd = await realpath(cwd);
            const preparedApply = await prepareClaudeNativeApply({ control, cwd: mutationCwd, sessionId, captured, approval: result.setup.approval,
              executionKind: boundaries.invokeClaude ? 'test-double' : 'real-cli', secrets: connection.secrets });
            await enableClaudeNativeApplyHooks(nativeSession);
            const writable = captured.proposal.actions.filter(action => ['CREATE', 'UPDATE'].includes(action.action));
            const fileWrites = writable.some(action => action.kind !== 'claude-skill-reference');
            const references = writable.some(action => action.kind === 'claude-skill-reference');
            const needsPreread = writable.some(action => action.action === 'UPDATE' && action.kind !== 'claude-skill-reference');
            const prereadInstruction = needsPreread
              ? 'Read each exact approved UPDATE target once in full before its Write/Edit; no other Reads.' : '';
            const referenceInstruction = references
              ? 'For each reference, use only a single exact /bin/mkdir -m 0755 -- for each displayed missing parent, then /bin/ln -s -- for its approved relative link. Bash input must contain only command; no force, overwrite, chaining, shell variants, deployment or other commands.'
              : 'No Bash or commands.';
            const applyTools = [...(needsPreread ? ['Read'] : []), ...(fileWrites ? ['Write', 'Edit'] : []), ...(references ? ['Bash'] : [])].join(',');
            const applyArgs = ['--restricted', '--print', '--output-format', 'json', '--tools', applyTools,
              '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--max-budget-usd', '3', '--model', connection.model,
              '--settings', nativeSession.settingsFile, '--setting-sources', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
              '--prompt-suggestions', 'false', '--add-dir', mutationCwd, '--resume', sessionId];
            const maxApplyProcesses = preparedApply.mutationToolCount + 1;
            let applyResult;
            try {
            for (let attempt = 0; attempt < maxApplyProcesses; attempt++) {
              applyResult = await invokeRequest([...applyArgs, attempt === 0
                ? `Apply only the exact approved Proposal actions already presented. ${prereadInstruction} Use Write/Edit only for approved file mutations; no extra targets. ${referenceInstruction}`
                : `Resume only the same pending approved action; then continue the remaining approved actions. ${prereadInstruction} ${referenceInstruction} Do not request a new approval.`], mutationCwd, sessionId);
              const secretFailure = claudeJsonSecretFailure(applyResult.stdout ?? '', connection.secrets);
              if (secretFailure) throw failure(secretFailure);
              let envelope;
              try { envelope = JSON.parse(applyResult.stdout); } catch { throw failure('NATIVE_RESULT_INVALID'); }
              if (envelope.stop_reason !== 'tool_deferred') break;
              await captureClaudeNativeApplyDeferred({ control, processResult: applyResult, authorizedCall: envelope.deferred_tool_use });
            }
            result.setup.apply = await completeClaudeNativeApply({ control, processResult: applyResult });
            } catch (cause) {
              // Revoke any armed permit and retain only controller-produced
              // verified effects/indexes/digests; never reconstruct a final diff.
              try { await completeClaudeNativeApply({ control, processResult: { status: null, stdout: '' } }); }
              catch (stopped) {
                if (stopped.failureContext) {
                  result.setup.applyFailure = stopped.failureContext;
                  result.setup.run.events.push(...stopped.failureContext.completed.map(completed => {
                    const action = writable[completed.actionIndex];
                    return { type: 'write', proposalId: captured.proposal.id, revision: captured.proposal.revision,
                      actionId: action.id, target: action.target, observedBeforeFingerprint: action.baselineFingerprint };
                  }));
                }
              }
              throw cause;
            }
            const beforeReconcile = await snapshotContext(cwd);
            const reconcileInput = JSON.stringify(await repositoryEvidence(await snapshotTree(cwd), connection.secrets, cwd));
            if (Buffer.byteLength(reconcileInput) > 1024 * 1024) throw failure('NATIVE_SETUP_INPUT_LIMIT');
            const reconcileArgs = [...applyArgs];
            reconcileArgs[reconcileArgs.indexOf('--tools') + 1] = '';
            const reconcileBefore = await Promise.all(readonlyRoots.map(snapshotContext));
            let reconciled;
            try { reconciled = await invokeRequest([...reconcileArgs,
              `Perform readonly reconcile from the supplied actual repository state. No tools, writes, commands or new Proposal approval. Return ONLY JSON {"type":"reconcile","mode":"dry-run","proposalActions":[],"writes":[]} if unchanged; otherwise report the actual nonempty proposalActions without applying. Repository: ${reconcileInput}`], mutationCwd, sessionId); }
            finally {
              result.setup.reconcileZeroChurn = isDeepStrictEqual(reconcileBefore, await Promise.all(readonlyRoots.map(snapshotContext)));
              if (!result.setup.reconcileZeroChurn) throw failure('RECONCILE_CHANGED');
            }
            const secretFailure = claudeJsonSecretFailure(reconciled.stdout ?? '', connection.secrets);
            if (secretFailure) throw failure(secretFailure);
            let reconcileEnvelope;
            try { reconcileEnvelope = JSON.parse(reconciled.stdout); } catch { throw failure('NATIVE_RESULT_INVALID'); }
            if (reconciled.status !== 0 || ['cleanupError', 'spawnError', 'timedOut', 'truncated', 'signal', 'stopReason'].some(key => reconciled[key])
              || reconcileEnvelope.type !== 'result' || reconcileEnvelope.session_id !== sessionId || reconcileEnvelope.subtype !== 'success'
              || reconcileEnvelope.is_error !== false || !Array.isArray(reconcileEnvelope.permission_denials)
              || reconcileEnvelope.permission_denials.length) throw failure('NATIVE_PROCESS_FAILED');
            let reconcile;
            try { reconcile = JSON.parse(reconcileEnvelope.result); } catch { throw failure('RECONCILE_INVALID'); }
            if (reconcile?.type !== 'reconcile' || reconcile.mode !== 'dry-run' || !Array.isArray(reconcile.writes)
              || reconcile.writes.length || !Array.isArray(reconcile.proposalActions) || reconcile.proposalActions.length) throw failure('RECONCILE_CHANGED');
            result.setup.sessionClosed = true; // The bounded print process has exited; no owned subprocess remains.
            result.setup.reconcile = reconcile;
            result.setup.validation = await validateClaudeNativeSetup({ captured, cwd, repositoryInput: validationInput,
              phase: 'final', completed: result.setup.apply.completed });
            result.setup.run.events.push(result.setup.approval.record,
              ...result.setup.apply.completed.map(completed => {
                const action = writable[completed.actionIndex];
                return { type: 'write', proposalId: captured.proposal.id, revision: captured.proposal.revision,
                  actionId: action.id, target: action.target, observedBeforeFingerprint: action.baselineFingerprint };
              }),
              { type: 'validation', passed: result.setup.validation.ok, scope: result.setup.validationScope,
                source: 'controller-completion-and-physical-files', liveSkillBehaviorProven: false }, reconcile);
            result.setup.physicalPhaseFingerprints = Object.fromEntries(await Promise.all(Object.entries(setupRoots)
              .map(async ([phase, dir]) => [phase, await fingerprintRepository(dir)])));
            if (!result.setup.validation.ok) throw failure('NATIVE_SETUP_VALIDATION_FAILED');
            if (!isDeepStrictEqual(beforeReconcile, await snapshotContext(cwd))) throw failure('SESSION_CLOSE_WRITES');
            result.setup.status = 'pass';
            result.setup.expectedContextFingerprint = await fingerprintRepository(cwd);
            result.setup.expectedContextSeal = digestProposal({ type: 'claude-context-seal-v1', snapshot: await snapshotContext(cwd) });
            result.setup.archivedBaselineFixtureDigest = await digestTree(fixtureSource);
            if (nativeCorpus) {
              Object.assign(result.setup, { fixtureRoot, routingFixtureRoot: fixtureSource });
              // These physical seals, not mutable callback declarations, are the
              // held authority for every subsequent setup and fresh routing call.
              closedSetups.push(Object.freeze({ fixtureId: selectedFixtureId, fixtureRoot, routingFixtureRoot: fixtureSource,
                roots: Object.freeze({ ...setupRoots }), sessionId, status: 'pass', sessionClosed: true,
                expectedContextFingerprint: result.setup.expectedContextFingerprint, expectedContextSeal: result.setup.expectedContextSeal,
                archivedBaselineFixtureDigest: result.setup.archivedBaselineFixtureDigest }));
            }
            result.code = 'NATIVE_SETUP_VALIDATED';
          }
        }
        if (nativeCorpus && result.setup.status === 'pass' && result.setup.sessionClosed) continue;
        break;
      }
      const parsed = parseClaudeTrace(processResult, { sessionId, harnessVersion: version, requiredSkills: ['agent-init'],
        secrets: connection.secrets, captureSkillEvidence: true, evidenceRoots: [root, await realpath(root)], readRoots: [home, cwd], cwd });
      const after = await snapshotTree(cwd);
      const zeroWrites = isDeepStrictEqual(before, after);
      result.probes.push({ id: probe.id, invocation: probe.invocation, promptDigest: sha256(probe.prompt),
        fixtureId, fixtureDigest: await digestTree(fixtureRoot), sessionId, zeroWrites, ...parsed });
      if (!zeroWrites || parsed.status === 'error') {
        result.status = 'error';
        result.code = zeroWrites ? parsed.code : 'UNAPPROVED_WRITES';
        break;
      }
    }
    if (nativeCorpus && closedSetups.length === contributorIds.length) {
      await checkHeldContexts();
      const fixtureRoots = Object.fromEntries(closedSetups.map(setup => [setup.fixtureId, setup.routingFixtureRoot]));
      const generatedSkillsByFixture = Object.fromEntries(result.setups.map(setup => [setup.fixtureId,
        Object.fromEntries(setup.proposal.actions.filter(action => action.kind === 'project-skill' && ['CREATE', 'UPDATE'].includes(action.action)
          && action.target === `.agents/skills/${action.skillCandidate?.name}/SKILL.md`)
          .map(action => [action.skillCandidate.name, path.dirname(path.join(setup.roots.finalRoot, action.target))]))]));
      const preparation = await prepareClaudeRoutingInputs({ fixtureRoots, generatedSkillsByFixture, motherSkillRoot });
      const routingSessions = new Map();
      result.nativeRoutingObservations = [];
      const invokeSession = async request => {
        if (request.phase === 'close') {
          const held = routingSessions.get(request.sessionId);
          routingSessions.delete(request.sessionId);
          if (held?.id === request.id && held.processStarted === false) return { closed: false, processStarted: false,
            controlClosed: held.controlClosed === true, sessionId: request.sessionId, id: request.id };
          return { closed: held?.id === request.id && held.closed === true, sessionId: request.sessionId, id: request.id };
        }
        if (request.phase !== 'routing' || routingSessions.has(request.sessionId)) throw failure('NATIVE_ROUTING_SCOPE');
        if (modelQuotaExhausted()) {
          // Exact owned admission failure: no native preparation/invocation has
          // started. Finally may close this control, not an imaginary process.
          routingSessions.set(request.sessionId, { id: request.id, closed: false, processStarted: false, controlClosed: true });
          throw failure('MODEL_PROCESS_BUDGET_EXHAUSTED');
        }
        const routed = await invokeClaudeNativeRoutingSession({ root, home, request: { ...request, harnessVersion: version },
          command: executable, model: connection.model, env: { ...env, ...connection.env }, secrets: connection.secrets,
          executionKind: boundaries.invokeClaude ? 'test-double' : 'real-cli', invoke: countedInvoke });
        routingSessions.set(request.sessionId, { id: request.id, processResult: routed.processResult,
          observation: routed.observation, closed: routed.closed });
        return routed.processResult;
      };
      const observeSession = (processResult, request) => {
        const held = routingSessions.get(request.sessionId);
        if (!held || held.id !== request.id || held.processResult !== processResult) throw failure('NATIVE_ROUTING_SCOPE');
        // Frozen routing qualification deliberately narrows provenance. Keep the
        // public collector's screened partial source proof in a Claude-private
        // sidecar, never the raw process output or private preparation profile.
        result.nativeRoutingObservations.push({ id: request.id, sessionId: request.sessionId, observation: {
          status: held.observation.status, code: held.observation.code, provenance: structuredClone(held.observation.provenance) } });
        return held.observation;
      };
      result.nativeRouting = await runClaudeNativeRouting({ executionKind: result.executionKind, harnessVersion: version,
        setups: closedSetups, preparation, motherSkillRoot, evidenceRoot: path.join(root, 'evidence/claude-live'), invokeSession, observeSession });
      result.status = result.nativeRouting.status;
      result.code = result.nativeRouting.code;
      result.artifacts = result.nativeRouting.artifacts;
      await checkHeldContexts();
    }
  } catch (cause) {
    result.status = 'error';
    result.code = /^[A-Z_]+$/.test(cause.code ?? '') ? cause.code : 'RUNNER_FAILED';
    result.errorType = ['Error', 'TypeError', 'SyntaxError', 'RangeError'].includes(cause.name) ? cause.name : 'Error';
  }
  // Do not persist raw model output, credentials, settings, stderr or auth files.
  const evidence = JSON.stringify(result, null, 2).replaceAll(await realpath(root), '<owned-disposable-root>').replaceAll(root, '<owned-disposable-root>');
  if (connection.secrets.some((value) => value && evidence.includes(value))) throw failure('SECRET_EVIDENCE');
  // Redact root aliases before encoding controls; JSON decoding preserves payloads.
  await writeFile(path.join(root, 'evidence/claude-live/report.json'), `${claudeTerminalJson(JSON.parse(evidence), 2)}\n`, { mode: 0o600, flag: 'wx' });
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const options = {};
  let invalid = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--live' && options.live === undefined) options.live = true;
    else if (arg === '--simulate' && options.simulate === undefined) options.simulate = true;
    else if (arg === '--authorize-setup-proposal' && options.authorizeSetupProposal === undefined) options.authorizeSetupProposal = true;
    else if (arg === '--authorize-native-observation' && options.authorizeNativeObservation === undefined) options.authorizeNativeObservation = true;
    else if (arg === '--authorize-native-protocol' && options.authorizeNativeProtocol === undefined) options.authorizeNativeProtocol = true;
    else if (arg === '--authorize-native-discovery' && options.authorizeNativeDiscovery === undefined) options.authorizeNativeDiscovery = true;
    else if (arg === '--authorize-native-setup' && options.authorizeNativeSetup === undefined) options.authorizeNativeSetup = true;
    else if (arg === '--authorize-native-corpus' && options.authorizeNativeCorpus === undefined) options.authorizeNativeCorpus = true;
    else if (arg === '--request-proposal-approval' && options.requestProposalApproval === undefined) options.requestProposalApproval = true;
    else if (arg === '--reuse-current-connection' && options.reuseCurrentConnection === undefined) options.reuseCurrentConnection = true;
    else if (['--scope', '--claude-executable', '--fixture-id', '--model', '--probe-invocation', '--max-model-processes', '--total-model-budget-usd'].includes(arg) && args[index + 1] && !args[index + 1].startsWith('--')) {
      const key = { '--scope': 'scope', '--claude-executable': 'claudeExecutable', '--fixture-id': 'fixtureId', '--model': 'model', '--probe-invocation': 'probeInvocation',
        '--max-model-processes': 'maxModelProcesses', '--total-model-budget-usd': 'totalModelBudgetUsd' }[arg];
      if (options[key] !== undefined) invalid = true;
      const value = args[++index];
      options[key] = ['maxModelProcesses', 'totalModelBudgetUsd'].includes(key) ? Number(value) : value;
    } else invalid = true;
  }
  if (options.authorizeSetupProposal && (!options.live || options.simulate || options.scope !== 'setup-proposal')) invalid = true;
  if (options.authorizeNativeObservation && (!options.live || options.simulate || options.scope !== 'native-observation')) invalid = true;
  if (options.authorizeNativeProtocol && (!options.live || options.simulate || options.scope !== 'native-defer')) invalid = true;
  if (options.authorizeNativeDiscovery && (!options.live || options.simulate || options.scope !== 'native-discovery')) invalid = true;
  if (options.authorizeNativeSetup && (!options.live || options.simulate || options.scope !== 'native-setup')) invalid = true;
  if (options.authorizeNativeCorpus && (!options.live || options.simulate || options.scope !== 'native-corpus')) invalid = true;
  if (options.requestProposalApproval && (!options.live || options.simulate || !['setup-proposal', 'native-setup', 'native-corpus'].includes(options.scope))) invalid = true;
  if (options.reuseCurrentConnection && (!options.live || options.simulate)) invalid = true;
  if (options.model !== undefined && (!options.live || options.simulate || !options.reuseCurrentConnection)) invalid = true;
  if (options.fixtureId !== undefined && (!options.live || options.simulate || !['setup-proposal', 'native-setup'].includes(options.scope))) invalid = true;
  if (options.probeInvocation !== undefined && (!options.live || options.simulate || options.scope !== 'capability-probe'
    || !['explicit', 'implicit'].includes(options.probeInvocation))) invalid = true;
  const result = invalid ? outcome('blocked', 'CLI_ARGUMENTS')
    : options.simulate ? await runClaudeSimulation(options) : await runClaudeLiveAcceptance(options);
  process.stdout.write(`${claudeTerminalJson(result, 2)}\n`);
  process.exitCode = ['error', 'fail'].includes(result.status) ? 1 : result.status === 'pass' ? 0 : 2;
}
