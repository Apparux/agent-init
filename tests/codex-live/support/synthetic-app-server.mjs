import { randomUUID } from 'node:crypto';
import { chmod, mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { digestProposal, fingerprintPath, fingerprintRepository, renderExactDiff, validateWriteTargetPhysicalScope } from '../../agent-init/evaluation-harness.js';
import readline from 'node:readline';

import { readRegularFileNoFollow } from '../../../src/installation/filesystem.js';

// A local test double, not Codex and not model/discovery/selection evidence.
const split = process.argv.includes('--split');
let sending = Promise.resolve();

function send(message) {
  sending = sending.then(async () => {
    const line = Buffer.from(`${JSON.stringify(message)}\n`);
    if (split) {
      process.stdout.write(line.subarray(0, 11));
      await new Promise((resolve) => setTimeout(resolve, 5));
      process.stdout.write(line.subarray(11));
    } else {
      process.stdout.write(line);
    }
  });
}

const scenarioPath = process.argv.find((arg) => arg.startsWith('--scenario='))?.slice('--scenario='.length);
let scenario;
if (scenarioPath) {
  if (!path.isAbsolute(scenarioPath) || path.dirname(scenarioPath) !== path.dirname(process.env.CODEX_HOME)) throw new Error('Synthetic scenario must be directly inside the owned runtime');
  scenario = JSON.parse(await readRegularFileNoFollow(scenarioPath, 'utf8'));
  if (scenario.synthetic !== true) throw new Error('Missing synthetic scenario marker');
}
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let initializationId;
let extraRoots = [];

function initialized(id) {
  send({
    id,
    result: {
      userAgent: 'synthetic-codex/0.0.0-synthetic',
      codexHome: process.env.CODEX_HOME,
      platformFamily: 'synthetic',
      platformOs: 'synthetic',
    },
  });
}

input.on('line', async (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') {
    initializationId = request.id;
    const fault = process.argv.find((arg) => arg.startsWith('--fault='))?.slice('--fault='.length);
    if (fault) {
      if (fault === 'truncated') { process.stdout.write('{"id":'); input.close(); process.stdin.destroy(); }
      else if (fault === 'unknown-request') send({ id: 'unsupported', method: 'synthetic/unauthorized-tool', params: {} });
      else if (fault === 'wrong-id') send({ id: 'wrong-response-id', result: {} });
      else if (fault === 'line-limit') send({ id: request.id, result: { text: 'x'.repeat(1024) } });
      else if (fault === 'stderr-limit') process.stderr.write('x'.repeat(1024));
      else if (fault !== 'timeout') throw new Error('Unknown synthetic fault');
      return;
    }
    const requestedMethod = process.argv.find((arg) => arg.startsWith('--server-request='))?.slice('--server-request='.length);
    if (process.argv.includes('--approval') || requestedMethod) {
      send({
        id: 'server-approval-1',
        method: requestedMethod ?? 'item/commandExecution/requestApproval',
        params: { threadId: 'synthetic-thread', turnId: 'synthetic-turn', itemId: 'synthetic-command' },
      });
    } else {
      initialized(request.id);
    }
  } else if (request.id === 'server-approval-1' && request.result) {
    initialized(initializationId);
  } else if (request.method === 'skills/extraRoots/set') {
    extraRoots = request.params.extraRoots;
    send({ id: request.id, result: {} });
  } else if (request.method === 'skills/list') {
    const skills = [];
    for (const root of extraRoots) {
      const file = path.join(root, 'SKILL.md');
      const body = await readRegularFileNoFollow(file, 'utf8');
      skills.push({ name: /^name: (.+)$/m.exec(body)[1], description: /^description: (.+)$/m.exec(body)[1], path: file, scope: 'repo', enabled: true, pluginId: null });
    }
    send({ id: request.id, result: { data: request.params.cwds.map((cwd) => ({ cwd, skills, errors: [] })) } });
  } else if (request.method === 'thread/start') {
    send({ id: request.id, result: { thread: { id: `synthetic-thread-${randomUUID()}` } } });
  } else if (request.method === 'turn/start') {
    const threadId = request.params.threadId;
    const turnId = `synthetic-turn-${randomUUID()}`;
    let body = { synthetic: true };
    if (scenario && !scenario.routing) {
      const task = JSON.parse(request.params.input.find((entry) => entry.type === 'text').text);
      if (task.operation === 'setup-apply') {
        const proposal = scenario.proposal.record.events.at(-1);
        if (task.approval.proposalDigest !== digestProposal(proposal) || task.approval.decision !== 'approve') throw new Error('Synthetic Apply requires the exact approval');
        const writes = [];
        for (const id of task.approval.approvedActionIds) {
          const action = proposal.actions.find((entry) => entry.id === id);
          if (!action || !['CREATE', 'UPDATE'].includes(action.action) || (await validateWriteTargetPhysicalScope(process.cwd(), action.target)).length) throw new Error('Unsafe synthetic write');
          const observedBeforeFingerprint = await fingerprintPath(process.cwd(), action.target);
          if (observedBeforeFingerprint !== action.baselineFingerprint) throw new Error('Synthetic baseline drift');
          const target = path.join(process.cwd(), action.target);
          await mkdir(path.dirname(target), { recursive: true });
          if (action.action === 'CREATE' && action.kind === 'claude-skill-reference' && action.linkText !== undefined) {
            if (typeof action.linkText !== 'string' || action.linkText.includes('\\') || path.posix.isAbsolute(action.linkText)
              || !/^\.agents\/skills\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(action.canonicalTarget ?? '')
              || path.posix.normalize(path.posix.join(path.posix.dirname(action.target), action.linkText)) !== action.canonicalTarget
              || (await validateWriteTargetPhysicalScope(process.cwd(), `${action.canonicalTarget}/SKILL.md`)).length) {
              throw new Error('Unsafe synthetic canonical Skill reference');
            }
            await readRegularFileNoFollow(path.join(process.cwd(), action.canonicalTarget, 'SKILL.md'));
            await symlink(action.linkText, target);
          } else if (action.action === 'CREATE') await writeFile(target, action.proposedContent, { flag: 'wx' });
          else {
            const before = await readRegularFileNoFollow(target, 'utf8');
            const after = scenario.afterContents?.[id];
            if (typeof after !== 'string' || renderExactDiff(action.target, before, after) !== action.proposedDiff) throw new Error('Synthetic UPDATE bytes do not match the exact diff');
            await writeFile(target, after);
          }
          writes.push({ type: 'write', proposalId: proposal.id, revision: proposal.revision, actionId: id, target: action.target, observedBeforeFingerprint });
        }
        if (scenario.afterApplyMutation) {
          const mutation = scenario.afterApplyMutation;
          if ((await validateWriteTargetPhysicalScope(process.cwd(), mutation.modeTarget)).length
            || (await validateWriteTargetPhysicalScope(process.cwd(), mutation.directory)).length) throw new Error('Unsafe synthetic mutation');
          await chmod(path.join(process.cwd(), mutation.modeTarget), mutation.mode);
          await mkdir(path.join(process.cwd(), mutation.directory));
        }
        body = { schemaVersion: 1, kind: 'setup-apply', events: [...writes, { ...scenario.validation.events[0], changedPaths: writes.map((entry) => entry.target) }] };
      } else body = scenario[{ 'setup-proposal': 'proposal', 'setup-validation': 'validation', 'setup-reconcile': 'reconcile' }[task.operation]];
      if (!body) throw new Error('Unsupported synthetic operation');
    }
    const text = JSON.stringify(body);
    const item = { type: 'agentMessage', id: `synthetic-message-${randomUUID()}`, text };
    const started = {
      id: request.id,
      result: { turn: { id: turnId, status: 'inProgress', error: null, items: [], itemsView: 'notLoaded' } },
    };
    const events = [
      { method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: item.id, delta: text.slice(0, 9) } },
      { method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: item.id, delta: text.slice(9) } },
      { method: 'item/completed', params: { threadId, turnId, item } },
      { method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed', error: null, items: [item], itemsView: 'summary' } } },
    ];
    if (process.argv.includes('--foreign-event')) events.splice(3, 0, { method: 'rawResponseItem/completed', params: { threadId: 'foreign-thread', turnId, item: null } });
    if (scenario?.routing) {
      const contexts = [];
      const ownedRoot = path.dirname(process.env.CODEX_HOME);
      for (const contributor of scenario.routing.contributors) {
        const relative = path.relative(ownedRoot, contributor.repositoryRoot);
        if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Synthetic context escapes owned assets');
        contexts.push({ ...contributor, repositoryFingerprint: await fingerprintRepository(contributor.repositoryRoot) });
      }
      events.splice(3, 0, { method: 'synthetic/selection.complete', params: {
        threadId, turnId, runId: scenario.routing.runId, sessionId: scenario.routing.sessionId,
        requestDigest: digestProposal(request), complete: true, loaded: scenario.routing.loaded, contexts,
      } });
    }
    if (!process.argv.includes('--notifications-first')) send(started);
    for (const event of events) send(event);
    if (process.argv.includes('--notifications-first')) send(started);
  }
});

input.on('close', () => {
  sending.then(() => { process.exitCode = process.argv.includes('--exit-nonzero') ? 9 : 0; });
});
