import assert from 'node:assert/strict';
import { link, lstat, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { fingerprintPath, fingerprintRepository } from '../agent-init/evaluation-harness.js';
import { createCodexMeasurementTools } from './measurement-tools.js';

async function fixture(t) {
  const ownedRoot = await mkdtemp(path.join(await realpath(tmpdir()), 'codex-measurement-'));
  const repositoryRoot = path.join(ownedRoot, 'repository');
  await mkdir(repositoryRoot);
  const ownedIdentity = await lstat(ownedRoot);
  const repositoryIdentity = await lstat(repositoryRoot);
  t.after(async () => {
    const current = await lstat(ownedRoot);
    assert.equal(current.isSymbolicLink(), false);
    assert.equal(current.dev, ownedIdentity.dev);
    assert.equal(current.ino, ownedIdentity.ino);
    await rm(ownedRoot, { recursive: true });
  });
  const tools = await createCodexMeasurementTools({ ownedRoot, ownedIdentity, repositoryRoot, repositoryIdentity });
  tools.activateTurn({ threadId: 'controller-thread', turnId: 'controller-turn' });
  let nextCall = 0;
  const call = (tool, args, overrides = {}) => tools.handleToolCall({
    threadId: 'controller-thread', turnId: 'controller-turn', callId: `call-${++nextCall}`,
    namespace: null, tool, arguments: args, ...overrides,
  });
  return { ownedRoot, repositoryRoot, tools, call, ownedIdentity, repositoryIdentity };
}

test('published DynamicToolSpec grammar is fixed and has no actor-selected root, write or exec API', async (t) => {
  const { tools } = await fixture(t);
  assert.deepEqual(tools.dynamicTools.map((spec) => spec.name), [
    'fingerprintPath', 'fingerprintRepository', 'digestProposal', 'renderExactDiff',
  ]);
  const required = [['target'], [], ['proposal'], ['target', 'before', 'after']];
  for (const [index, spec] of tools.dynamicTools.entries()) {
    assert.deepEqual(Object.keys(spec).sort(), ['description', 'inputSchema', 'name', 'type']);
    assert.equal(spec.type, 'function');
    assert.ok(spec.description.length);
    assert.equal(spec.inputSchema.type, 'object');
    assert.equal(spec.inputSchema.additionalProperties, false);
    assert.deepEqual(spec.inputSchema.required, required[index]);
    assert.deepEqual(Object.keys(spec.inputSchema.properties), required[index]);
  }
  tools.dynamicTools[0].name = 'exec';
  assert.equal(tools.dynamicTools[0].name, 'fingerprintPath');
});

test('unknown, mismatched, replayed and inactive tool callbacks fail closed without selection claims', async (t) => {
  const { tools, call } = await fixture(t);
  for (const overrides of [{ threadId: 'foreign' }, { turnId: 'foreign' }, { callId: '' },
    { namespace: 'actor-namespace' }, { tool: 'exec' }, { extra: 'actor authority' }]) {
    const reply = await call('digestProposal', { proposal: {} }, overrides);
    assert.equal(reply.success, false);
    assert.equal(JSON.parse(reply.contentItems[0].text).status, 'error');
    assert.doesNotMatch(reply.contentItems[0].text, /loaded|selection|controller-thread/);
  }
  value(await call('digestProposal', { proposal: {} }, { callId: 'one-use' }));
  assert.equal((await call('digestProposal', { proposal: {} }, { callId: 'one-use' })).success, false);
  tools.finishTurn();
  assert.equal((await call('digestProposal', { proposal: {} })).success, false);
  assert.equal((await tools.handleToolCall(null)).success, false);
});

test('pure measurement arguments are closed JSON values with safe UTF-8 and hard byte bounds', async (t) => {
  const { call } = await fixture(t);
  for (const [tool, args] of [
    ['digestProposal', { proposal: {}, repositoryRoot: '/actor/root' }],
    ['digestProposal', { proposal: '\ud800' }],
    ['digestProposal', { proposal: { large: 'x'.repeat(65537) } }],
    ['digestProposal', { proposal: { unsupported: undefined } }],
    ['digestProposal', { proposal: NaN }],
    ['renderExactDiff', { target: '../outside', before: '', after: '' }],
    ['renderExactDiff', { target: 'AGENTS.md', before: 1, after: '' }],
    ['renderExactDiff', { target: 'AGENTS.md', before: '', after: 'é'.repeat(32769) }],
    ['renderExactDiff', { target: 'AGENTS.md', before: '', after: '\n'.repeat(65536) }],
  ]) {
    const reply = await call(tool, args);
    assert.equal(reply.success, false);
    assert.equal(JSON.parse(reply.contentItems[0].text).status, 'error');
    assert.ok(Buffer.byteLength(JSON.stringify(reply)) <= 128 * 1024);
  }
  value(await call('digestProposal', { proposal: 'x'.repeat(65536) }));
});

test('fingerprintPath measures only a bound physical repository file and reports genuine missing paths', async (t) => {
  const { call, repositoryRoot } = await fixture(t);
  await writeFile(path.join(repositoryRoot, 'AGENTS.md'), 'hello\n', { flag: 'wx' });
  assert.deepEqual(value(await call('fingerprintPath', { target: 'AGENTS.md' })), {
    fingerprint: 'sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
  });
  assert.deepEqual(value(await call('fingerprintPath', { target: 'not-created/file.md' })), { fingerprint: 'missing' });
});

test('binding requires owned repository identity and root replacement invalidates even pure calls', async (t) => {
  const { tools, call, ownedRoot, repositoryRoot, ownedIdentity, repositoryIdentity } = await fixture(t);
  await assert.rejects(createCodexMeasurementTools({ ownedRoot, ownedIdentity, repositoryRoot,
    repositoryIdentity: { dev: repositoryIdentity.dev, ino: repositoryIdentity.ino + 1 } }), { code: 'MEASUREMENT_SCOPE' });
  await assert.rejects(createCodexMeasurementTools({ ownedRoot, ownedIdentity, repositoryRoot: ownedRoot,
    repositoryIdentity: ownedIdentity }), { code: 'MEASUREMENT_SCOPE' });
  await rename(repositoryRoot, path.join(ownedRoot, 'original-repository'));
  await mkdir(repositoryRoot);
  const reply = await call('digestProposal', { proposal: {} });
  assert.equal(reply.success, false);
  assert.equal(JSON.parse(reply.contentItems[0].text).code, 'MEASUREMENT_SCOPE');
  tools.finishTurn();
});

test('.env-prefixed components expose only presence and type, never sensitive contents or fingerprints', async (t) => {
  const { call, repositoryRoot } = await fixture(t);
  await writeFile(path.join(repositoryRoot, '.env.local'), Buffer.from([0xff, 0x00]), { flag: 'wx' });
  await mkdir(path.join(repositoryRoot, '.env-private'));
  await writeFile(path.join(repositoryRoot, '.env-private', 'secret'), 'PRIVATE_CONTENT', { flag: 'wx' });
  for (const [target, type] of [['.env.local', 'file'], ['.env-private', 'directory'],
    ['.env-private/secret', 'file'], ['.env.missing', 'missing']]) {
    assert.deepEqual(value(await call('fingerprintPath', { target })), { presence: type !== 'missing', type });
  }
});

test('repository and directory measurements preserve public fingerprints but refuse sensitive aggregates', async (t) => {
  const { call, repositoryRoot } = await fixture(t);
  assert.deepEqual(value(await call('fingerprintRepository', {})), {
    fingerprint: 'tree-sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  });
  await mkdir(path.join(repositoryRoot, 'docs'));
  await writeFile(path.join(repositoryRoot, 'docs', 'guide.md'), 'public\n', { flag: 'wx' });
  assert.deepEqual(value(await call('fingerprintRepository', {})), { fingerprint: await fingerprintRepository(repositoryRoot) });
  assert.deepEqual(value(await call('fingerprintPath', { target: 'docs' })), { fingerprint: await fingerprintPath(repositoryRoot, 'docs') });
  await writeFile(path.join(repositoryRoot, 'docs', '.env'), 'PRIVATE_CONTENT', { flag: 'wx' });
  for (const [tool, args] of [['fingerprintRepository', {}], ['fingerprintPath', { target: 'docs' }]]) {
    const reply = await call(tool, args);
    assert.equal(reply.success, false);
    assert.equal(JSON.parse(reply.contentItems[0].text).code, 'MEASUREMENT_SENSITIVE');
    assert.doesNotMatch(JSON.stringify(reply), /sha256|PRIVATE_CONTENT/);
  }
});

test('terminal canonical sharing links are measured without following them or widening the bound root', {
  skip: process.platform === 'win32' ? 'POSIX relative-link scope; no Windows symlink privilege claim.' : false,
}, async (t) => {
  const { call, ownedRoot, repositoryRoot, ownedIdentity, repositoryIdentity } = await fixture(t);
  await mkdir(path.join(repositoryRoot, '.agents', 'skills', 'workflow'), { recursive: true });
  await mkdir(path.join(repositoryRoot, '.claude', 'skills'), { recursive: true });
  await symlink('../../.agents/skills/workflow', path.join(repositoryRoot, '.claude', 'skills', 'workflow'));
  assert.deepEqual(value(await call('fingerprintPath', { target: '.claude/skills/workflow' })), {
    fingerprint: await fingerprintPath(repositoryRoot, '.claude/skills/workflow'),
  });
  const motherSkillRoot = path.join(ownedRoot, 'home', '.agent-init', 'current', 'skills', 'agent-init');
  await mkdir(motherSkillRoot, { recursive: true });
  const motherSkillIdentity = await lstat(motherSkillRoot);
  const motherAlias = '.agents/skills/agent-init';
  await symlink(path.relative(path.dirname(path.join(repositoryRoot, motherAlias)), motherSkillRoot), path.join(repositoryRoot, motherAlias));
  assert.equal((await call('fingerprintPath', { target: motherAlias })).success, false);
  const bound = await createCodexMeasurementTools({ ownedRoot, ownedIdentity, repositoryRoot, repositoryIdentity, motherSkillRoot, motherSkillIdentity });
  bound.activateTurn({ threadId: 'thread', turnId: 'turn' });
  const invoke = (target, callId) => bound.handleToolCall({ threadId: 'thread', turnId: 'turn', callId,
    namespace: null, tool: 'fingerprintPath', arguments: { target } });
  assert.deepEqual(value(await invoke(motherAlias, 'alias')), { fingerprint: await fingerprintPath(repositoryRoot, motherAlias) });
  assert.equal((await invoke(`${motherAlias}/SKILL.md`, 'no-follow')).success, false);
  await symlink(path.relative(path.join(repositoryRoot, '.agents', 'skills'), motherSkillRoot), path.join(repositoryRoot, '.agents', 'skills', 'unapproved-alias'));
  assert.equal((await invoke('.agents/skills/unapproved-alias', 'wrong-alias')).success, false);
});

test('controller turn ownership cannot be replaced, reused or completed while a call silently succeeds', async (t) => {
  const { tools, call } = await fixture(t);
  assert.throws(() => tools.activateTurn({ threadId: 'foreign', turnId: 'new' }), { code: 'MEASUREMENT_TURN' });
  const params = { threadId: 'controller-thread', turnId: 'controller-turn', callId: 'inflight', namespace: null,
    tool: 'digestProposal', arguments: { proposal: { b: 2, a: 1 } } };
  const pending = tools.handleToolCall(params);
  params.arguments.proposal.a = 999;
  assert.deepEqual(value(await pending), { digest: 'sha256:43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777' });
  const finishing = call('digestProposal', { proposal: {} });
  tools.finishTurn();
  assert.equal((await finishing).success, false);
  assert.throws(() => tools.activateTurn({ threadId: 'controller-thread', turnId: 'controller-turn' }), { code: 'MEASUREMENT_TURN' });
  assert.throws(() => tools.activateTurn({ threadId: '', turnId: 'new' }), { code: 'MEASUREMENT_TURN' });
  tools.activateTurn({ threadId: 'controller-thread', turnId: 'second-turn' });
  assert.equal((await call('digestProposal', { proposal: {} })).success, false);
});

test('absolute, traversal, linked ancestors, escapes and hardlinks never become missing or valid measurements', async (t) => {
  const { call, ownedRoot, repositoryRoot } = await fixture(t);
  await writeFile(path.join(repositoryRoot, 'regular'), 'public', { flag: 'wx' });
  await writeFile(path.join(ownedRoot, 'outside'), 'OUTSIDE_CONTENT', { flag: 'wx' });
  for (const target of ['/absolute', '../outside', 'a/../regular', './regular', 'a//b', 'a\\b', 'C:/outside', 'a\u0000b', 'regular/child']) {
    assert.equal((await call('fingerprintPath', { target })).success, false, target);
  }
  await link(path.join(repositoryRoot, 'regular'), path.join(repositoryRoot, 'hardlink'));
  assert.equal((await call('fingerprintPath', { target: 'regular' })).success, false);
  assert.equal((await call('fingerprintRepository', {})).success, false);
  await rm(path.join(repositoryRoot, 'hardlink'));
  if (process.platform !== 'win32') {
    await symlink('../outside', path.join(repositoryRoot, 'escape'));
    await symlink(path.join(ownedRoot, 'outside'), path.join(repositoryRoot, 'absolute-link'));
    await symlink('.', path.join(repositoryRoot, 'linked-parent'));
    for (const target of ['escape', 'absolute-link', 'linked-parent/regular']) {
      const reply = await call('fingerprintPath', { target });
      assert.equal(reply.success, false, target);
      assert.doesNotMatch(JSON.stringify(reply), /OUTSIDE_CONTENT|sha256|codex-measurement/);
    }
    assert.equal((await call('fingerprintRepository', {})).success, false);
  }
});

test('file UTF-8 and filesystem bounds fail closed, without truncated or binary fingerprints', async (t) => {
  const { call, repositoryRoot } = await fixture(t);
  await writeFile(path.join(repositoryRoot, 'invalid'), Buffer.from([0xff]), { flag: 'wx' });
  await writeFile(path.join(repositoryRoot, 'large'), 'x'.repeat(65537), { flag: 'wx' });
  for (const target of ['invalid', 'large']) assert.equal((await call('fingerprintPath', { target })).success, false);
  assert.equal((await call('fingerprintRepository', {})).success, false);
  await rm(path.join(repositoryRoot, 'invalid'));
  await rm(path.join(repositoryRoot, 'large'));
  await mkdir(path.join(repositoryRoot, 'tree'));
  for (let index = 0; index < 17; index++) await writeFile(path.join(repositoryRoot, 'tree', `file-${index}`), 'x'.repeat(65536), { flag: 'wx' });
  const overBudget = await call('fingerprintRepository', {});
  assert.equal(overBudget.success, false);
  assert.equal(JSON.parse(overBudget.contentItems[0].text).code, 'MEASUREMENT_LIMIT');
});

test('case-folded sensitive aliases remain metadata-only, including upper-case on case-sensitive filesystems', async (t) => {
  const { call, repositoryRoot } = await fixture(t);
  await writeFile(path.join(repositoryRoot, '.ENV.local'), 'PRIVATE_CONTENT', { flag: 'wx' });
  assert.deepEqual(value(await call('fingerprintPath', { target: '.ENV.local' })), { presence: true, type: 'file' });
  const reply = await call('fingerprintRepository', {});
  assert.equal(reply.success, false);
  assert.equal(JSON.parse(reply.contentItems[0].text).code, 'MEASUREMENT_SENSITIVE');
});

test('the callback tool and arguments are captured together before any asynchronous inspection', async (t) => {
  const { tools, repositoryRoot } = await fixture(t);
  await writeFile(path.join(repositoryRoot, 'public'), 'hello\n', { flag: 'wx' });
  const params = { threadId: 'controller-thread', turnId: 'controller-turn', callId: 'immutable-envelope', namespace: null,
    tool: 'digestProposal', arguments: { proposal: { b: 2, a: 1 } } };
  const pending = tools.handleToolCall(params);
  params.tool = 'fingerprintRepository';
  params.arguments = {};
  assert.deepEqual(value(await pending), { digest: 'sha256:43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777' });
});

test('measurement-only calls leave the owned repository untouched and never expose controller siblings', async (t) => {
  const { call, ownedRoot, repositoryRoot } = await fixture(t);
  await writeFile(path.join(repositoryRoot, 'AGENTS.md'), 'hello\n', { flag: 'wx' });
  await writeFile(path.join(ownedRoot, 'fixture.json'), 'CONTROLLER_ORACLE', { flag: 'wx' });
  const before = await fingerprintRepository(repositoryRoot);
  value(await call('fingerprintPath', { target: 'AGENTS.md' }));
  value(await call('fingerprintRepository', {}));
  value(await call('digestProposal', { proposal: { body: '😀\n' } }));
  value(await call('renderExactDiff', { target: 'AGENTS.md', before: 'hello\n', after: 'not-applied\n' }));
  assert.deepEqual(value(await call('fingerprintPath', { target: 'fixture.json' })), { fingerprint: 'missing' });
  const forbidden = await call('fingerprintRepository', { repositoryRoot: ownedRoot });
  assert.equal(forbidden.success, false);
  assert.doesNotMatch(JSON.stringify(forbidden), /CONTROLLER_ORACLE|codex-measurement|loaded|live/);
  assert.equal(await fingerprintRepository(repositoryRoot), before);
});

test('callback and repository-entry budgets fail closed instead of growing an unbounded trusted measurement', async (t) => {
  const { call, repositoryRoot } = await fixture(t);
  for (let index = 0; index < 1024; index++) value(await call('digestProposal', { proposal: {} }));
  const refused = await call('digestProposal', { proposal: {} });
  assert.equal(refused.success, false);
  assert.equal(JSON.parse(refused.contentItems[0].text).code, 'MEASUREMENT_LIMIT');
  const fresh = await createCodexMeasurementTools({ ownedRoot: path.dirname(repositoryRoot), ownedIdentity: await lstat(path.dirname(repositoryRoot)),
    repositoryRoot, repositoryIdentity: await lstat(repositoryRoot) });
  fresh.activateTurn({ threadId: 'entry-thread', turnId: 'entry-turn' });
  for (let index = 0; index < 1024; index++) await writeFile(path.join(repositoryRoot, `file-${index}`), '', { flag: 'wx' });
  const reply = await fresh.handleToolCall({ threadId: 'entry-thread', turnId: 'entry-turn', callId: 'entries',
    namespace: null, tool: 'fingerprintRepository', arguments: {} });
  assert.equal(reply.success, false);
  assert.equal(JSON.parse(reply.contentItems[0].text).code, 'MEASUREMENT_LIMIT');
});

function value(response) {
  assert.equal(response.success, true);
  assert.equal(response.contentItems.length, 1);
  assert.equal(response.contentItems[0].type, 'inputText');
  return JSON.parse(response.contentItems[0].text);
}

test('renderExactDiff uses submitted strings, including a target absent from the filesystem', async (t) => {
  const { call } = await fixture(t);
  assert.deepEqual(value(await call('renderExactDiff', { target: 'AGENTS.md', before: 'old\n', after: 'new\n' })), {
    diff: '--- a/AGENTS.md\n+++ b/AGENTS.md\n@@ -1,1 +1,1 @@\n-old\n+new\n',
  });
});

test('controller-correlated digestProposal computes only the submitted JSON proposal', async (t) => {
  const { call } = await fixture(t);
  assert.deepEqual(value(await call('digestProposal', { proposal: { b: 2, a: 1 } })), {
    digest: 'sha256:43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777',
  });
});
