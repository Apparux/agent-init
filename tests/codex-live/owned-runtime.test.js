import assert from 'node:assert/strict';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { digestTree, readRegularFileNoFollow } from '../../src/installation/filesystem.js';
import { runCodex } from './runner.js';
import { createCodexRuntime, inventoryCodexTree } from './owned-runtime.js';

const packageRoot = fileURLToPath(new URL('../..', import.meta.url));

// Negative command specimen only: successful installation tests always use actual npm.
const failedInstaller = `process.stdout.write('SYNTHETIC_INSTALL_STDOUT\\n');
process.stderr.write('SYNTHETIC_INSTALL_STDERR\\n');
process.exitCode = 23;
`;

test('failed owned installation retains command provenance and confirmed cleanup before any actor launch', async () => {
  const parent = await mkdtemp(path.join(await realpath(tmpdir()), 'ai-codex-install-failure-'));
  const identity = await lstat(parent);
  let failure;
  try {
    const npmCli = path.join(parent, 'synthetic-install-failure.mjs');
    await writeFile(npmCli, failedInstaller, { flag: 'wx', mode: 0o600 });
    await assert.rejects(createCodexRuntime({ packageRoot, temporaryParent: parent, npmCli }), (cause) => {
      failure = cause;
      return cause.code === 'INSTALL_EXIT';
    });
    assert.equal(failure.installation.commands.length, 1);
    const command = failure.installation.commands[0];
    assert.equal(command.exitCode, 23);
    assert.equal(command.signal, null);
    assert.equal(command.stdout, 'SYNTHETIC_INSTALL_STDOUT\n');
    assert.equal(command.stderr, 'SYNTHETIC_INSTALL_STDERR\n');
    assert.equal(command.stdoutDigest, `sha256:${createHash('sha256').update('SYNTHETIC_INSTALL_STDOUT\n').digest('hex')}`);
    assert.equal(command.stderrDigest, `sha256:${createHash('sha256').update('SYNTHETIC_INSTALL_STDERR\n').digest('hex')}`);
    assert.equal(command.processGroupAbsent, true);
    assert.equal(failure.processCleanupUnconfirmed, false);
    assert.equal(failure.cleanup.removed, true);
    await assert.rejects(lstat(failure.ownedRoot), { code: 'ENOENT' });
    let launches = 0;
    let approvals = 0;
    const result = await runCodex({ mode: 'synthetic', packageRoot, temporaryParent: parent, npmCli }, {
      launch: () => { launches++; throw new Error('No actor launch after installation failure'); },
      approve: () => { approvals++; throw new Error('No approval after installation failure'); },
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.phase, 'installation');
    assert.equal(result.error.code, 'INSTALL_EXIT');
    assert.equal(result.installation.commands[0].exitCode, 23);
    assert.equal(result.cleanup.removed, true);
    assert.equal(launches, 0);
    assert.equal(approvals, 0);
  } finally {
    assert.deepEqual(await readdir(parent), ['synthetic-install-failure.mjs']);
    assert.equal((await lstat(parent)).dev, identity.dev);
    assert.equal((await lstat(parent)).ino, identity.ino);
    await inventoryCodexTree(parent);
    await rm(parent, { recursive: true });
  }
});

test('failed installer with nonce drift preserves both errors and the original owned root', async () => {
  const parent = await mkdtemp(path.join(await realpath(tmpdir()), 'ai-codex-install-nonce-'));
  const parentIdentity = await lstat(parent);
  let failure;
  try {
    const npmCli = path.join(parent, 'synthetic-install-failure.mjs');
    await writeFile(npmCli, `import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const root = path.dirname(process.env.HOME);
const marker = await readFile(path.join(root, 'ownership.json'));
await writeFile(path.join(root, 'ownership.original.json'), marker, { flag: 'wx', mode: 0o600 });
await writeFile(path.join(root, 'ownership.json'), JSON.stringify({ ...JSON.parse(marker), nonce: 'synthetic-drift' }));
${failedInstaller}`, { flag: 'wx', mode: 0o600 });
    await assert.rejects(createCodexRuntime({ packageRoot, temporaryParent: parent, npmCli }), (cause) => {
      failure = cause;
      return cause.code === 'INSTALL_EXIT';
    });
    assert.equal(failure instanceof AggregateError, true);
    assert.equal(failure.errors[0].code, 'INSTALL_EXIT');
    assert.equal(failure.errors[1].code, 'OWNED_CLEANUP');
    assert.equal(failure.cleanup.removed, false);
    assert.equal(failure.cleanup.error.code, 'OWNED_CLEANUP');
    assert.equal(failure.processCleanupUnconfirmed, false);
    assert.equal(failure.installation.commands[0].processGroupAbsent, true);
    assert.equal(failure.installation.commands[0].exitCode, 23);
    const current = await lstat(failure.ownedRoot);
    assert.equal(current.dev, failure.ownedIdentity.dev);
    assert.equal(current.ino, failure.ownedIdentity.ino);
    assert.equal(JSON.parse(await readRegularFileNoFollow(path.join(failure.ownedRoot, 'ownership.json'))).nonce, 'synthetic-drift');
  } finally {
    if (failure?.ownedRoot) {
      assert.equal(failure.installation.commands.every((entry) => entry.processGroupAbsent), true);
      assert.equal(path.dirname(failure.ownedRoot), parent);
      const current = await lstat(failure.ownedRoot);
      assert.equal(current.isDirectory() && !current.isSymbolicLink(), true);
      const original = await readRegularFileNoFollow(path.join(failure.ownedRoot, 'ownership.original.json'));
      assert.equal(JSON.parse(original).dev, current.dev);
      assert.equal(JSON.parse(original).ino, current.ino);
      await inventoryCodexTree(failure.ownedRoot);
      await writeFile(path.join(failure.ownedRoot, 'ownership.json'), original);
      await rm(failure.ownedRoot, { recursive: true });
      await assert.rejects(lstat(failure.ownedRoot), { code: 'ENOENT' });
    }
    assert.deepEqual(await readdir(parent), ['synthetic-install-failure.mjs']);
    assert.equal((await lstat(parent)).dev, parentIdentity.dev);
    assert.equal((await lstat(parent)).ino, parentIdentity.ino);
    await inventoryCodexTree(parent);
    await rm(parent, { recursive: true });
  }
});

test('Codex owned runtime installs the current local tarball and binds the installed canonical mother Skill', async () => {
  const runtime = await createCodexRuntime({ packageRoot });
  const root = runtime.root;
  try {
    const metadata = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
    assert.equal(runtime.package.name, metadata.name);
    assert.equal(runtime.package.version, metadata.version);
    assert.equal(runtime.package.files.length, 23);
    assert.equal(runtime.commands.length, 3);
    assert.equal(runtime.commands.every((command) => command.exitCode === 0 && command.processGroupAbsent), true);
    assert.equal(runtime.commands[0].args.includes('--offline'), true);
    assert.equal(runtime.commands[1].args.includes('--ignore-scripts'), true);
    assert.equal(runtime.commands[2].args.at(-1), 'install');
    assert.equal(runtime.motherSkillRoot, path.join(runtime.env.HOME, '.agent-init/current/skills/agent-init'));
    assert.equal((await lstat(runtime.motherSkillRoot)).isDirectory(), true);
    assert.equal((await lstat(runtime.motherSkillRoot)).isSymbolicLink(), false);
    const alias = path.join(runtime.env.HOME, '.agents/skills/agent-init');
    assert.equal((await lstat(alias)).isSymbolicLink(), true);
    assert.equal(await realpath(alias), await realpath(runtime.motherSkillRoot));
    assert.equal(await digestTree(runtime.motherSkillRoot), await digestTree(path.join(packageRoot, 'skills/agent-init')));
    assert.equal(Object.hasOwn(runtime.env, 'OPENAI_API_KEY'), false);
    assert.equal(Object.hasOwn(runtime.env, 'NODE_OPTIONS'), false);
    assert.equal(Object.hasOwn(runtime.env, 'HTTPS_PROXY'), false);
  } finally {
    await runtime.cleanup();
  }
  await assert.rejects(lstat(root), { code: 'ENOENT' });
});

test('Codex fixture copies preserve relative links and independent snapshots detect full-mode and directory changes', async () => {
  const runtime = await createCodexRuntime({ packageRoot });
  try {
    const prepared = await runtime.prepareFixture(path.join(packageRoot, 'tests/fixtures/08-existing-skills'));
    assert.equal(JSON.parse(await readFile(path.join(prepared.fixtureRoot, 'fixture.json'), 'utf8')).id, '08-existing-skills');
    const linkPath = '.claude/skills/release';
    const initial = await prepared.snapshot('initial');
    assert.equal((await lstat(path.join(prepared.repositoryRoot, linkPath))).isSymbolicLink(), true);
    assert.equal(await readlink(path.join(prepared.repositoryRoot, linkPath)), '../../.agents/skills/release');
    assert.equal(await readlink(path.join(initial.root, linkPath)), '../../.agents/skills/release');
    const sourceBytes = await readFile(path.join(prepared.fixtureRoot, 'repository/package.json'));
    await writeFile(path.join(prepared.repositoryRoot, 'package.json'), 'synthetic change\n');
    await chmod(path.join(prepared.repositoryRoot, '.agents/skills/release/SKILL.md'), 0o600);
    await mkdir(path.join(prepared.repositoryRoot, 'unexpected-empty-directory'));
    const proposal = await prepared.snapshot('proposal');
    const preWrite = await prepared.snapshot('preWrite');
    const final = await prepared.snapshot('final');
    assert.equal(new Set([initial.root, proposal.root, preWrite.root, final.root]).size, 4);
    assert.deepEqual(await readFile(path.join(initial.root, 'package.json')), sourceBytes);
    assert.deepEqual(await readFile(path.join(prepared.fixtureRoot, 'repository/package.json')), sourceBytes);
    assert.notDeepEqual(initial.inventory, proposal.inventory);
    assert.equal(proposal.inventory.find((entry) => entry.path === '.agents/skills/release/SKILL.md').mode, 0o600);
    assert.equal(proposal.inventory.find((entry) => entry.path === 'unexpected-empty-directory').type, 'directory');
    assert.deepEqual(proposal.inventory, preWrite.inventory);
    assert.deepEqual(preWrite.inventory, final.inventory);
    await assert.rejects(prepared.snapshot('initial'), { code: 'OWNED_SNAPSHOT' });
  } finally {
    await runtime.cleanup();
  }
});

test('owned inventories reject files beyond their bounded descriptor budget', async () => {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'ai-codex-inventory-bounds-'));
  const identity = await lstat(root);
  try {
    await writeFile(path.join(root, 'oversized.bin'), Buffer.alloc(16 * 1024 * 1024 + 1));
    await assert.rejects(inventoryCodexTree(root), { code: 'NATIVE_INPUTS' });
  } finally {
    const current = await lstat(root);
    assert.equal(current.dev, identity.dev);
    assert.equal(current.ino, identity.ino);
    assert.deepEqual(await readdir(root), ['oversized.bin']);
    await rm(root, { recursive: true });
  }
});

test('fixture preparation rejects oversized repository files before copying unbounded input', async () => {
  const parent = await mkdtemp(path.join(await realpath(tmpdir()), 'ai-codex-fixture-bounds-'));
  const identity = await lstat(parent);
  let runtime;
  try {
    const fixtureSource = path.join(parent, 'fixture');
    await cp(path.join(packageRoot, 'tests/fixtures/03-node-pnpm'), fixtureSource, { recursive: true });
    await writeFile(path.join(fixtureSource, 'repository/oversized.bin'), Buffer.alloc(1024 * 1024 + 1));
    runtime = await createCodexRuntime({ packageRoot });
    await assert.rejects(runtime.prepareFixture(fixtureSource), { code: 'NATIVE_INPUTS' });
    assert.equal((await readdir(runtime.root)).some((name) => name.startsWith('input-') || name.startsWith('work-')), false);
  } finally {
    if (runtime) assert.equal((await runtime.cleanup()).removed, true);
    const current = await lstat(parent);
    assert.equal(current.dev, identity.dev);
    assert.equal(current.ino, identity.ino);
    await rm(parent, { recursive: true });
  }
});

test('native inputs bind the actual current tarball and initial repository without exposing controller files', async () => {
  const runtime = await createCodexRuntime({ packageRoot });
  try {
    const prepared = await runtime.prepareFixture(path.join(packageRoot, 'tests/fixtures/08-existing-skills'));
    const initial = await prepared.snapshot('initial');
    const inputs = await runtime.prepareNativeInputs(prepared.fixture.id);
    assert.equal(inputs.kind, 'codex-native-inputs');
    assert.equal(inputs.nativeExecuted, false);
    assert.equal(inputs.containmentProven, false);
    assert.notEqual(inputs.repositoryRoot, prepared.repositoryRoot);
    assert.notEqual(inputs.repositoryRoot, initial.root);
    assert.deepEqual(await inventoryCodexTree(inputs.repositoryRoot), initial.inventory);
    assert.equal(await readlink(path.join(inputs.repositoryRoot, '.claude/skills/release')), '../../.agents/skills/release');
    assert.deepEqual((await readdir(inputs.root)).sort(), ['manifest.json', 'package.tgz', 'repository']);
    await assert.rejects(lstat(path.join(inputs.repositoryRoot, 'fixture.json')), { code: 'ENOENT' });
    const packed = await readFile(path.join(runtime.root, 'pack', runtime.package.filename));
    assert.deepEqual(await readFile(inputs.tarball), packed);
    const manifestBytes = await readFile(inputs.manifestPath);
    const manifest = JSON.parse(manifestBytes);
    assert.equal(manifest.package.name, '@apparux/agent-init');
    assert.equal(manifest.package.version, runtime.package.version);
    assert.equal(manifest.package.digest, `sha256:${createHash('sha256').update(packed).digest('hex')}`);
    assert.equal(manifest.package.integrity, runtime.package.integrity);
    assert.equal(inputs.manifestDigest, `sha256:${createHash('sha256').update(manifestBytes).digest('hex')}`);
    assert.deepEqual(manifest.repository.entries, initial.inventory);
    assert.equal(manifestBytes.includes(Buffer.from(runtime.root)), false);
    assert.equal(Object.hasOwn(manifest, 'fixture'), false);
    assert.equal(Object.hasOwn(manifest, 'approval'), false);
    assert.equal(Object.hasOwn(manifest, 'snapshots'), false);
    assert.equal(Object.hasOwn(inputs, 'controller'), false);
    assert.equal(JSON.stringify(inputs).includes(runtime.root), false);
    assert.equal((await runtime.verifyNativeInputs(inputs)).verified, true);
    await assert.rejects(runtime.prepareNativeInputs(prepared.fixture.id), { code: 'NATIVE_INPUTS' });
  } finally { await runtime.cleanup(); }
});

test('native input verification rejects private oracle drift without trusting a copied receipt', async () => {
  const runtime = await createCodexRuntime({ packageRoot });
  try {
    const prepared = await runtime.prepareFixture(path.join(packageRoot, 'tests/fixtures/03-node-pnpm'));
    await prepared.snapshot('initial');
    const inputs = await runtime.prepareNativeInputs(prepared.fixture.id);
    await assert.rejects(runtime.verifyNativeInputs({ ...inputs }), { code: 'NATIVE_INPUTS' });
    const oracle = path.join(prepared.fixtureRoot, 'fixture.json');
    await writeFile(oracle, `${await readFile(oracle, 'utf8')}\n`);
    await assert.rejects(runtime.verifyNativeInputs(inputs), { code: 'NATIVE_INPUTS' });
  } finally { await runtime.cleanup(); }
});

test('native input verification rejects changed and unlisted transfer bytes and keeps env metadata presence-only', async () => {
  const runtime = await createCodexRuntime({ packageRoot });
  try {
    const source = path.join(runtime.root, 'owned-privacy-fixture');
    await cp(path.join(packageRoot, 'tests/fixtures/03-node-pnpm'), source, { recursive: true, dereference: false, verbatimSymlinks: true });
    const canary = 'PUBLIC_NATIVE_INPUT_PRIVACY_CANARY';
    await mkdir(path.join(source, 'repository/docs/.EnV.scope'), { recursive: true });
    await writeFile(path.join(source, 'repository/docs/.EnV.scope/README.md'), canary);
    const prepared = await runtime.prepareFixture(source);
    await assert.rejects(runtime.prepareNativeInputs(prepared.fixture.id), { code: 'NATIVE_INPUTS' });
    const initial = await prepared.snapshot('initial');
    const inputs = await runtime.prepareNativeInputs(prepared.fixture.id);
    const manifestBytes = await readFile(inputs.manifestPath);
    assert.equal(manifestBytes.includes(Buffer.from(canary)), false);
    const privateEntry = JSON.parse(manifestBytes).repository.entries.find((entry) => entry.path === 'docs/.EnV.scope/README.md');
    assert.deepEqual(Object.keys(privateEntry).sort(), ['mode', 'path', 'type']);
    assert.deepEqual(privateEntry, { path: 'docs/.EnV.scope/README.md', type: 'file', mode: (await lstat(path.join(inputs.repositoryRoot, privateEntry.path))).mode & 0o7777 });
    for (const target of [inputs.tarball, inputs.manifestPath, path.join(inputs.repositoryRoot, 'package.json'),
      path.join(initial.root, 'package.json'), path.join(prepared.fixtureRoot, 'repository/package.json')]) {
      const original = await readFile(target);
      await writeFile(target, Buffer.concat([original, Buffer.from('\nchanged native input\n')]));
      await assert.rejects(runtime.verifyNativeInputs(inputs), { code: 'NATIVE_INPUTS' });
      await writeFile(target, original);
      assert.equal((await runtime.verifyNativeInputs(inputs)).verified, true);
    }
    await chmod(inputs.root, 0o777);
    try { await assert.rejects(runtime.verifyNativeInputs(inputs), { code: 'NATIVE_INPUTS' }); }
    finally { await chmod(inputs.root, 0o700); }
    await chmod(inputs.manifestPath, 0o666);
    try { await assert.rejects(runtime.verifyNativeInputs(inputs), { code: 'NATIVE_INPUTS' }); }
    finally { await chmod(inputs.manifestPath, 0o600); }
    const extra = path.join(inputs.root, 'fixture.json');
    await writeFile(extra, 'unlisted private controller input');
    await assert.rejects(runtime.verifyNativeInputs(inputs), { code: 'NATIVE_INPUTS' });
    await unlink(extra);
    const link = path.join(inputs.repositoryRoot, 'outside');
    await symlink('../manifest.json', link);
    try { await assert.rejects(runtime.verifyNativeInputs(inputs), { code: 'NATIVE_INPUTS' }); }
    finally { await unlink(link); }
    assert.equal((await runtime.verifyNativeInputs(inputs)).verified, true);
  } finally { await runtime.cleanup(); }
});

test('native input verification binds the original fixture source rather than only owned copies', async () => {
  const runtime = await createCodexRuntime({ packageRoot });
  try {
    const source = path.join(runtime.root, 'owned-versioned-fixture');
    await cp(path.join(packageRoot, 'tests/fixtures/03-node-pnpm'), source, { recursive: true, dereference: false, verbatimSymlinks: true });
    const prepared = await runtime.prepareFixture(source);
    await prepared.snapshot('initial');
    const inputs = await runtime.prepareNativeInputs(prepared.fixture.id);
    const target = path.join(source, 'repository/package.json');
    const original = await readFile(target);
    await writeFile(target, Buffer.concat([original, Buffer.from('\noriginal fixture drift\n')]));
    await assert.rejects(runtime.verifyNativeInputs(inputs), { code: 'NATIVE_INPUTS' });
    await writeFile(target, original);
    assert.equal((await runtime.verifyNativeInputs(inputs)).verified, true);
    const oracle = path.join(source, 'fixture.json');
    await writeFile(oracle, `${await readFile(oracle, 'utf8')}\n`);
    await assert.rejects(runtime.verifyNativeInputs(inputs), { code: 'NATIVE_INPUTS' });
  } finally { await runtime.cleanup(); }
});

test('native input verification binds the current package source as well as its installed tarball', async () => {
  const seed = await createCodexRuntime({ packageRoot });
  let runtime;
  try {
    const source = path.join(seed.root, 'owned-current-package');
    await mkdir(source);
    for (const entry of seed.package.files) {
      const target = path.join(source, entry.path);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, await readFile(path.join(packageRoot, entry.path)), { mode: entry.mode });
      await chmod(target, entry.mode);
    }
    runtime = await createCodexRuntime({ packageRoot: source });
    const prepared = await runtime.prepareFixture(path.join(packageRoot, 'tests/fixtures/03-node-pnpm'));
    await prepared.snapshot('initial');
    const inputs = await runtime.prepareNativeInputs(prepared.fixture.id);
    const target = path.join(source, 'skills/agent-init/SKILL.md');
    await writeFile(target, `${await readFile(target, 'utf8')}\nowned package source drift\n`);
    await assert.rejects(runtime.verifyNativeInputs(inputs), { code: 'NATIVE_INPUTS' });
  } finally {
    if (runtime) await runtime.cleanup();
    await seed.cleanup();
  }
});

test('a failed native input preparation does not consume its fixture or authorize a concurrent retry', async () => {
  const runtime = await createCodexRuntime({ packageRoot });
  try {
    const prepared = await runtime.prepareFixture(path.join(packageRoot, 'tests/fixtures/03-node-pnpm'));
    await prepared.snapshot('initial');
    const target = path.join(prepared.repositoryRoot, 'package.json');
    const original = await readFile(target);
    await writeFile(target, 'owned input drift');
    await assert.rejects(runtime.prepareNativeInputs(prepared.fixture.id), { code: 'NATIVE_INPUTS' });
    await writeFile(target, original);
    const first = runtime.prepareNativeInputs(prepared.fixture.id);
    await assert.rejects(runtime.prepareNativeInputs(prepared.fixture.id), { code: 'NATIVE_INPUTS' });
    const inputs = await first;
    assert.equal((await runtime.verifyNativeInputs(inputs)).verified, true);
    await assert.rejects(runtime.prepareNativeInputs(prepared.fixture.id), { code: 'NATIVE_INPUTS' });
  } finally { await runtime.cleanup(); }
});

test('owned cleanup retains pending native input construction and verification until both settle', async () => {
  const runtime = await createCodexRuntime({ packageRoot });
  let observedCopy;
  try {
    const prepared = await runtime.prepareFixture(path.join(packageRoot, 'tests/fixtures/03-node-pnpm'));
    await prepared.snapshot('initial');
    observedCopy = runtime.prepareNativeInputs(prepared.fixture.id).then((inputs) => ({ inputs }), (error) => ({ error }));
    await assert.rejects(runtime.cleanup(), { code: 'OWNED_CLEANUP' });
    const copied = await observedCopy;
    assert.equal(copied.error, undefined);
    const verification = runtime.verifyNativeInputs(copied.inputs);
    await assert.rejects(runtime.cleanup(), { code: 'OWNED_CLEANUP' });
    assert.equal((await verification).verified, true);
    await runtime.cleanup();
    await assert.rejects(runtime.prepareNativeInputs(prepared.fixture.id), { code: 'NATIVE_INPUTS' });
    await assert.rejects(runtime.verifyNativeInputs(copied.inputs), { code: 'NATIVE_INPUTS' });
  } finally {
    if (observedCopy) await observedCopy;
    await runtime.cleanup();
  }
});

test('owned snapshots include repository-root permissions and special mode bits', async () => {
  const runtime = await createCodexRuntime({ packageRoot });
  try {
    const prepared = await runtime.prepareFixture(path.join(packageRoot, 'tests/fixtures/03-node-pnpm'));
    const before = await prepared.snapshot('initial');
    await chmod(prepared.repositoryRoot, 0o700);
    await chmod(path.join(prepared.repositoryRoot, 'package.json'), 0o1644);
    const after = await prepared.snapshot('proposal');
    assert.notDeepEqual(before.inventory, after.inventory);
    assert.equal(after.inventory.find((entry) => entry.path === '.').mode, 0o700);
    assert.equal(after.inventory.find((entry) => entry.path === 'package.json').mode, 0o1644);
  } finally { await runtime.cleanup(); }
});

test('owned cleanup refuses a replaced root before reading its marker and inventory rejects linked ancestors', async () => {
  const runtime = await createCodexRuntime({ packageRoot });
  const foreign = await mkdtemp(path.join(path.dirname(runtime.root), 'ai-codex-foreign-'));
  const foreignIdentity = await lstat(foreign);
  const backup = `${runtime.root}-backup`;
  let replaced = false;
  try {
    await writeFile(path.join(foreign, 'ownership.json'), 'not JSON; must not be parsed\n');
    await rename(runtime.root, backup);
    await symlink(foreign, runtime.root, 'dir');
    replaced = true;
    await assert.rejects(runtime.cleanup(), { code: 'OWNED_CLEANUP' });
    assert.equal(await readFile(path.join(foreign, 'ownership.json'), 'utf8'), 'not JSON; must not be parsed\n');
    await unlink(runtime.root);
    await rename(backup, runtime.root);
    replaced = false;
    const prepared = await runtime.prepareFixture(path.join(packageRoot, 'tests/fixtures/03-node-pnpm'));
    const alias = path.join(runtime.root, 'linked-ancestor');
    await symlink('.', alias, 'dir');
    await assert.rejects(inventoryCodexTree(path.join(alias, path.basename(prepared.repositoryRoot))), { code: 'OWNED_SCOPE' });
    await unlink(alias);
  } finally {
    if (replaced) { await unlink(runtime.root); await rename(backup, runtime.root); }
    await runtime.cleanup();
    const current = await lstat(foreign);
    assert.equal(current.dev, foreignIdentity.dev);
    assert.equal(current.ino, foreignIdentity.ino);
    assert.equal(current.isSymbolicLink(), false);
    await rm(foreign, { recursive: true });
  }
});
