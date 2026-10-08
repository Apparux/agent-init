import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, readdir, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readRegularFileNoFollow } from '../../src/installation/filesystem.js';
import { ownedGroupAbsent as groupAbsent, signalOwnedGroup as signalGroup } from './process-ownership.js';

const packageDirectory = fileURLToPath(new URL('../..', import.meta.url));

function failure(code, message) {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

export async function assertCodexDirectory(directory) {
  const absolute = path.resolve(directory);
  const stat = await lstat(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(absolute) !== absolute) {
    throw failure('OWNED_SCOPE', 'directory must be canonical with no linked ancestors');
  }
  return stat;
}

function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function runCommand(args, cwd, env) {
  const child = spawn(process.execPath, args, {
    cwd, env, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
  });
  let problem = null;
  let captured = 0;
  let exitCode = null;
  let signal = null;
  let closed = false;
  let probeFailed = false;
  const cleanupErrors = [];
  const output = { stdout: [], stderr: [] };
  const hashes = { stdout: createHash('sha256'), stderr: createHash('sha256') };
  let stopped;
  const stopRequested = new Promise((resolve) => { stopped = resolve; });
  function stop(error) {
    if (problem) return;
    problem = error;
    stopped();
  }
  function absent() {
    if (probeFailed) return false;
    try { return groupAbsent(child); }
    catch (cause) { probeFailed = true; cleanupErrors.push({ code: cause.code, message: cause.message }); return false; }
  }
  function signalOwned(signal) {
    try { signalGroup(child, signal); }
    catch (cause) { cleanupErrors.push({ code: cause.code, message: cause.message }); }
  }
  const timer = setTimeout(() => stop(failure('INSTALL_TIMEOUT', 'owned install command exceeded 60 seconds')), 60_000);
  for (const stream of ['stdout', 'stderr']) {
    child[stream].on('data', (bytes) => {
      captured += bytes.length;
      hashes[stream].update(bytes);
      if (captured > 4 * 1024 * 1024) stop(failure('INSTALL_CAPTURE', 'owned install output exceeded 4 MiB'));
      if (!problem) output[stream].push(bytes);
    });
  }
  child.on('error', (cause) => stop(failure('INSTALL_SPAWN', cause.message)));
  const exited = new Promise((resolve) => child.once('close', (code, exitSignal) => {
    exitCode = code;
    signal = exitSignal;
    closed = true;
    resolve();
  }));
  await Promise.race([exited, stopRequested]);
  clearTimeout(timer);
  if (!absent()) {
    signalOwned('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 1000));
    if (!absent()) {
      signalOwned('SIGKILL');
      const deadline = Date.now() + 1000;
      while (!absent() && !probeFailed && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  const processGroupAbsent = absent();
  if (processGroupAbsent && !closed) {
    let grace;
    await Promise.race([exited, new Promise((resolve) => { grace = setTimeout(resolve, 1000); })]);
    clearTimeout(grace);
  }
  if (!closed) {
    child.stdout.removeAllListeners('data');
    child.stderr.removeAllListeners('data');
    child.stdout.destroy();
    child.stderr.destroy();
    child.unref();
  }
  const record = {
    args: [...args], exitCode, signal, processGroupAbsent, capturedBytes: captured, captureTruncated: captured > 4 * 1024 * 1024,
    stdout: Buffer.concat(output.stdout).toString('utf8'), stderr: Buffer.concat(output.stderr).toString('utf8'),
    stdoutDigest: `sha256:${hashes.stdout.digest('hex')}`, stderrDigest: `sha256:${hashes.stderr.digest('hex')}`, cleanupErrors,
  };
  if (!processGroupAbsent || !closed || cleanupErrors.length) problem ??= failure('INSTALL_CLEANUP', 'owned command finalization failed or process-group absence is unconfirmed');
  if (exitCode !== 0 || signal) problem ??= failure('INSTALL_EXIT', `owned command failed (${exitCode ?? signal}): ${record.stderr}`);
  if (problem) throw Object.assign(problem, { command: record, processCleanupUnconfirmed: !processGroupAbsent });
  return record;
}

async function copyFixtureTree(source, destination, sourceRoot = source, budget = { entries: 0, bytes: 0 }) {
  const before = await assertCodexDirectory(source);
  await assertCodexDirectory(path.dirname(destination));
  if (!before.isDirectory() || before.isSymbolicLink()) throw failure('OWNED_COPY', 'source directory must not be a link');
  await mkdir(destination, { recursive: false });
  const names = (await readdir(source)).sort();
  budget.entries += names.length;
  if (budget.entries > 4096) throw failure('OWNED_COPY', 'fixture copy exceeds 4096 entries');
  for (const name of names) {
    const from = path.join(source, name);
    const to = path.join(destination, name);
    const stat = await lstat(from);
    if (stat.isDirectory() && !stat.isSymbolicLink()) await copyFixtureTree(from, to, sourceRoot, budget);
    else if (stat.isFile()) {
      budget.bytes += stat.size;
      if (budget.bytes > 16 * 1024 * 1024) throw failure('OWNED_COPY', 'fixture copy exceeds 16 MiB');
      await writeFile(to, await readNativeInputFile(sourceRoot, from, 1024 * 1024), { flag: 'wx', mode: stat.mode & 0o7777 });
      await chmod(to, stat.mode & 0o7777);
    } else if (stat.isSymbolicLink()) {
      const text = await readlink(from);
      if (path.isAbsolute(text) || !within(sourceRoot, path.resolve(path.dirname(from), text))) {
        throw failure('OWNED_COPY', 'fixture link escapes its input tree');
      }
      await symlink(text, to, process.platform === 'win32' ? 'dir' : undefined);
    } else throw failure('OWNED_COPY', 'unsupported fixture entry type');
  }
  const after = await lstat(source);
  if (after.dev !== before.dev || after.ino !== before.ino || after.isSymbolicLink()) throw failure('OWNED_COPY', 'source directory identity changed');
  await chmod(destination, before.mode & 0o7777);
}

export async function inventoryCodexTree(root) {
  const rootStat = await assertCodexDirectory(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw failure('OWNED_INVENTORY', 'root must be a regular directory');
  const entries = [{ path: '.', type: 'directory', mode: rootStat.mode & 0o7777 }];
  let entryCount = 0;
  let byteCount = 0;
  async function visit(directory, prefix = '') {
    const before = await assertCodexDirectory(directory);
    if (!before.isDirectory() || before.isSymbolicLink()) throw failure('OWNED_INVENTORY', 'tree directory must not be a link');
    const names = (await readdir(directory)).sort();
    entryCount += names.length;
    if (entryCount > 4096) throw failure('OWNED_INVENTORY', 'owned inventory exceeds 4096 entries');
    for (const name of names) {
      const target = path.join(directory, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const stat = await lstat(target);
      const entry = { path: relative, mode: stat.mode & 0o7777 };
      if (stat.isSymbolicLink()) {
        const linkText = await readlink(target);
        if (path.isAbsolute(linkText) || !within(root, path.resolve(directory, linkText))) throw failure('OWNED_INVENTORY', 'tree contains an escaping link');
        entries.push({ ...entry, type: 'symlink', linkText });
      } else if (stat.isDirectory()) {
        entries.push({ ...entry, type: 'directory' });
        await visit(target, relative);
      } else if (stat.isFile()) {
        byteCount += stat.size;
        if (byteCount > 64 * 1024 * 1024) throw failure('OWNED_INVENTORY', 'owned inventory exceeds 64 MiB');
        entries.push({ ...entry, type: 'file', digest: `sha256:${createHash('sha256').update(await readNativeInputFile(root, target, 16 * 1024 * 1024)).digest('hex')}` });
      } else throw failure('OWNED_INVENTORY', 'unsupported tree entry type');
    }
    const after = await lstat(directory);
    if (after.dev !== before.dev || after.ino !== before.ino || after.isSymbolicLink()) throw failure('OWNED_INVENTORY', 'directory identity changed');
  }
  await visit(root);
  return entries;
}

async function readNativeInputFile(root, target, maximumBytes) {
  if (!within(root, target)) throw failure('NATIVE_INPUTS', 'input file escapes its controller-owned root');
  await assertCodexDirectory(path.dirname(target));
  const before = await lstat(target);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maximumBytes) {
    throw failure('NATIVE_INPUTS', 'input must be a bounded regular file with one physical link');
  }
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await handle.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino || !opened.isFile() || opened.nlink !== 1) {
      throw failure('NATIVE_INPUTS', 'input file identity changed before its controller read');
    }
    const chunks = [];
    let length = 0;
    while (length <= before.size) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, before.size + 1 - length));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      chunks.push(chunk.subarray(0, bytesRead));
      length += bytesRead;
    }
    const after = await handle.stat();
    const named = await lstat(target);
    if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs || named.dev !== before.dev || named.ino !== before.ino
      || named.isSymbolicLink() || named.size !== before.size || named.nlink !== 1) {
      throw failure('NATIVE_INPUTS', 'input file changed during its controller capture');
    }
    return Buffer.concat(chunks, length);
  } finally { await handle.close(); }
}

async function inventoryNativeRepository(root) {
  const rootEntry = await assertCodexDirectory(root);
  const inventory = [{ path: '.', type: 'directory', mode: rootEntry.mode & 0o7777 }];
  let entries = 0;
  let bytes = 0;
  async function inspect(directory, prefix = '') {
    const before = await assertCodexDirectory(directory);
    const names = (await readdir(directory)).sort();
    entries += names.length;
    if (entries > 4096) throw failure('NATIVE_INPUTS', 'repository input exceeds 4096 entries');
    for (const name of names) {
      const target = path.join(directory, name);
      const entry = await lstat(target);
      const relative = prefix ? `${prefix}/${name}` : name;
      const recorded = { path: relative, mode: entry.mode & 0o7777 };
      if (entry.mode & 0o6000) throw failure('NATIVE_INPUTS', 'repository input contains privileged mode bits');
      if (entry.isSymbolicLink()) {
        const linkText = await readlink(target);
        if (path.isAbsolute(linkText) || !within(root, path.resolve(directory, linkText))
          || !within(root, await realpath(target))) {
          throw failure('NATIVE_INPUTS', 'repository input link must resolve within its own repository');
        }
        inventory.push({ ...recorded, type: 'symlink', linkText });
      } else if (entry.isDirectory()) {
        inventory.push({ ...recorded, type: 'directory' });
        await inspect(target, relative);
      } else if (entry.isFile() && entry.nlink === 1 && entry.size <= 1024 * 1024) {
        bytes += entry.size;
        if (bytes > 16 * 1024 * 1024) throw failure('NATIVE_INPUTS', 'repository input exceeds 16 MiB');
        const content = await readNativeInputFile(root, target, 1024 * 1024);
        inventory.push({ ...recorded, type: 'file', digest: `sha256:${createHash('sha256').update(content).digest('hex')}` });
      } else throw failure('NATIVE_INPUTS', 'repository input contains a large, linked or unsupported entry');
    }
    const after = await assertCodexDirectory(directory);
    if (after.dev !== before.dev || after.ino !== before.ino || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs || JSON.stringify((await readdir(directory)).sort()) !== JSON.stringify(names)) {
      throw failure('NATIVE_INPUTS', 'repository input directory changed during its controller inventory');
    }
  }
  await inspect(root);
  return inventory;
}

async function copyNativeRepository(source, destination, inventory) {
  await assertCodexDirectory(path.dirname(destination));
  await mkdir(destination, { mode: 0o700 });
  const identity = await assertCodexDirectory(destination);
  for (const entry of inventory) {
    if (entry.path === '.') continue;
    const from = path.join(source, entry.path);
    const to = path.join(destination, entry.path);
    await assertCodexDirectory(path.dirname(to));
    if (entry.type === 'directory') await mkdir(to, { mode: 0o700 });
    else if (entry.type === 'file') {
      const bytes = await readNativeInputFile(source, from, 1024 * 1024);
      if (`sha256:${createHash('sha256').update(bytes).digest('hex')}` !== entry.digest) {
        throw failure('NATIVE_INPUTS', 'repository file changed while copying its bound input bytes');
      }
      await writeFile(to, bytes, { flag: 'wx', mode: entry.mode });
      await chmod(to, entry.mode);
    } else if (entry.type === 'symlink') {
      if (await readlink(from) !== entry.linkText) throw failure('NATIVE_INPUTS', 'repository link changed while copying');
      await symlink(entry.linkText, to, process.platform === 'win32' ? 'dir' : undefined);
    } else throw failure('NATIVE_INPUTS', 'repository inventory contains an unsupported entry');
  }
  for (const entry of [...inventory].reverse()) {
    if (entry.type === 'directory') await chmod(path.join(destination, entry.path), entry.mode);
  }
  const current = await assertCodexDirectory(destination);
  if (current.dev !== identity.dev || current.ino !== identity.ino) {
    throw failure('NATIVE_INPUTS', 'native repository copy root identity changed');
  }
  return { dev: identity.dev, ino: identity.ino, mode: inventory[0].mode, uid: identity.uid, gid: identity.gid };
}

function nativePublicInventory(inventory) {
  return inventory.map((entry) => entry.path.split('/').some((part) => part.toLowerCase().startsWith('.env'))
    ? { path: entry.path, type: entry.type, mode: entry.mode } : { ...entry });
}

async function inspectCleanupTree(root) {
  const counts = { files: 0, directories: 0, links: 0 };
  async function visit(directory) {
    for (const name of await readdir(directory)) {
      const target = path.join(directory, name);
      const stat = await lstat(target);
      if (stat.isSymbolicLink()) {
        const link = await readlink(target);
        if (path.isAbsolute(link) || !within(root, path.resolve(directory, link))) {
          throw failure('OWNED_CLEANUP', 'refusing cleanup of an escaping link');
        }
        counts.links++;
      } else if (stat.isDirectory()) {
        counts.directories++;
        await visit(target);
      } else if (stat.isFile()) counts.files++;
      else throw failure('OWNED_CLEANUP', 'refusing cleanup with an unsupported entry type');
    }
  }
  await visit(root);
  return counts;
}

// All package-manager and CLI work is offline, local and confined to newly owned paths.
// Redirecting HOME is not a containment claim for a native agent.
export async function createCodexRuntime(options = {}) {
  const source = path.resolve(options.packageRoot ?? packageDirectory);
  const sourceIdentity = await assertCodexDirectory(source);
  const metadata = JSON.parse(await readRegularFileNoFollow(path.join(source, 'package.json'), 'utf8'));
  if (metadata.name !== '@apparux/agent-init' || metadata.dependencies || metadata.optionalDependencies) {
    throw failure('OWNED_PACKAGE', 'expected the dependency-free current agent-init package');
  }
  const temporaryParent = await realpath(options.temporaryParent ?? tmpdir());
  await assertCodexDirectory(temporaryParent);
  const root = await mkdtemp(path.join(temporaryParent, 'ai-codex-runtime-'));
  const identity = await lstat(root);
  const nonce = randomUUID();
  const markerPath = path.join(root, 'ownership.json');
  await writeFile(markerPath, `${JSON.stringify({ nonce, dev: identity.dev, ino: identity.ino })}\n`, { flag: 'wx', mode: 0o600 });
  let cleaned = false;
  let cleaning = false;
  const nativeInputOperations = new Set();
  const commands = [];
  async function cleanup() {
    if (cleaned) return { alreadyCleaned: true };
    if (cleaning || nativeInputOperations.size) {
      throw failure('OWNED_CLEANUP', 'owned cleanup or native input operation is pending; root retained');
    }
    cleaning = true;
    try {
      const current = await lstat(root);
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino) {
        throw failure('OWNED_CLEANUP', 'owned root identity changed; no marker read or deletion is permitted');
      }
      await assertCodexDirectory(root);
      const marker = JSON.parse(await readRegularFileNoFollow(markerPath, 'utf8'));
      if (marker.nonce !== nonce || marker.dev !== identity.dev || marker.ino !== identity.ino) {
        throw failure('OWNED_CLEANUP', 'owned nonce changed; leaving the root untouched');
      }
      const counts = await inspectCleanupTree(root);
      await rm(root, { recursive: true });
      cleaned = true;
      return { removed: true, ...counts };
    } finally { cleaning = false; }
  }
  try {
    const directories = ['home', 'codex-home', 'tmp', 'npm-cache', 'pack', 'prefix', 'repository', 'xdg-config', 'xdg-cache', 'xdg-data'];
    for (const name of directories) await mkdir(path.join(root, name));
    const userConfig = path.join(root, 'npm-user.cfg');
    const globalConfig = path.join(root, 'npm-global.cfg');
    await writeFile(userConfig, '', { flag: 'wx' });
    await writeFile(globalConfig, '', { flag: 'wx' });
    const env = {
      PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.platform === 'win32' ? path.dirname(process.execPath) : '/usr/bin:/bin'}`,
      HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'), CODEX_HOME: path.join(root, 'codex-home'),
      TMPDIR: path.join(root, 'tmp'), LANG: 'C', LC_ALL: 'C',
      XDG_CONFIG_HOME: path.join(root, 'xdg-config'), XDG_CACHE_HOME: path.join(root, 'xdg-cache'), XDG_DATA_HOME: path.join(root, 'xdg-data'),
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_CONFIG_SYSTEM: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_OPTIONAL_LOCKS: '0', GIT_CEILING_DIRECTORIES: root,
      npm_config_userconfig: userConfig, npm_config_globalconfig: globalConfig, npm_config_cache: path.join(root, 'npm-cache'),
      npm_config_offline: 'true', npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false', NO_COLOR: '1',
    };
    const npmCli = await realpath(options.npmCli ?? path.join(path.dirname(process.execPath),
      process.platform === 'win32' ? 'node_modules/npm/bin/npm-cli.js' : 'npm'));
    commands.push(await runCommand([npmCli, 'pack', '--json', '--offline', '--ignore-scripts', '--pack-destination', path.join(root, 'pack')], source, env));
    const packs = JSON.parse(commands[0].stdout);
    const packed = packs[0];
    if (packs.length !== 1 || packed.name !== metadata.name || packed.version !== metadata.version
      || typeof packed.filename !== 'string' || path.basename(packed.filename) !== packed.filename || !packed.filename.endsWith('.tgz')) {
      throw failure('OWNED_PACKAGE', 'local pack identity does not match the current package');
    }
    if (!Array.isArray(packed.files) || !packed.files.length || packed.files.length > 4096) {
      throw failure('OWNED_PACKAGE', 'current package must expose a bounded exact pack file inventory');
    }
    const packageSources = [];
    const packagePaths = new Set();
    let packageSourceBytes = 0;
    for (const entry of packed.files) {
      if (typeof entry.path !== 'string' || !entry.path || entry.path.includes('\\') || entry.path.includes('\0')
        || path.posix.isAbsolute(entry.path) || entry.path.split('/').some((part) => !part || part === '.' || part === '..')
        || packagePaths.has(entry.path)) throw failure('OWNED_PACKAGE', 'pack source paths must be unique normalized relative files');
      packagePaths.add(entry.path);
      const target = path.join(source, entry.path);
      const bytes = await readNativeInputFile(source, target, 1024 * 1024);
      packageSourceBytes += bytes.length;
      if (packageSourceBytes > 16 * 1024 * 1024) throw failure('OWNED_PACKAGE', 'current package sources exceed 16 MiB');
      packageSources.push({ path: target, relative: entry.path, bytes, identity: await lstat(target) });
    }
    const tarball = path.join(root, 'pack', packed.filename);
    const tarballBytes = await readNativeInputFile(root, tarball, 16 * 1024 * 1024);
    const tarballDigest = `sha256:${createHash('sha256').update(tarballBytes).digest('hex')}`;
    const tarballIntegrity = `sha512-${createHash('sha512').update(tarballBytes).digest('base64')}`;
    if (packed.integrity !== tarballIntegrity) throw failure('OWNED_PACKAGE', 'current packed tarball integrity mismatch');
    commands.push(await runCommand([npmCli, 'install', '--offline', '--ignore-scripts', '--no-package-lock', '--prefix', path.join(root, 'prefix'), tarball], path.join(root, 'repository'), env));
    const installed = path.join(root, 'prefix/node_modules/@apparux/agent-init');
    const installedMetadata = JSON.parse(await readRegularFileNoFollow(path.join(installed, 'package.json'), 'utf8'));
    if (installedMetadata.name !== metadata.name || installedMetadata.version !== metadata.version) throw failure('OWNED_PACKAGE', 'installed package identity mismatch');
    for (const entry of packageSources) {
      if (!(await readNativeInputFile(installed, path.join(installed, entry.relative), 1024 * 1024)).equals(entry.bytes)) {
        throw failure('OWNED_PACKAGE', 'installed packed file does not match its bound current source bytes');
      }
    }
    commands.push(await runCommand([path.join(installed, 'bin/agent-init.js'), 'install'], path.join(root, 'repository'), env));
    const motherSkillRoot = path.join(env.HOME, '.agent-init/current/skills/agent-init');
    const mother = await lstat(motherSkillRoot);
    if (!mother.isDirectory() || mother.isSymbolicLink()) throw failure('OWNED_PACKAGE', 'canonical installed mother Skill is not a directory');
    const fixtureIds = new Set();
    const preparedRepositories = new Map();
    const routingIds = new Set();
    const nativeInputIds = new Set();
    const pendingNativeInputIds = new Set();
    const nativeInputs = new WeakMap();
    async function prepareFixture(fixtureSource) {
      const fixtureSourceIdentity = await assertCodexDirectory(fixtureSource);
      const sourceOraclePath = path.join(fixtureSource, 'fixture.json');
      const sourceOracleBytes = await readNativeInputFile(fixtureSource, sourceOraclePath, 1024 * 1024);
      const sourceOracleIdentity = await lstat(sourceOraclePath);
      const fixture = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(sourceOracleBytes));
      if (typeof fixture.id !== 'string' || !/^[a-z0-9-]+$/.test(fixture.id) || fixture.repository !== 'repository' || fixtureIds.has(fixture.id)) {
        throw failure('OWNED_FIXTURE', 'fixture has an unsafe or reused identity');
      }
      fixtureIds.add(fixture.id);
      const versionedRepositoryRoot = path.join(fixtureSource, 'repository');
      const versionedRepositoryIdentity = await assertCodexDirectory(versionedRepositoryRoot);
      const versionedInventory = await inventoryNativeRepository(versionedRepositoryRoot);
      const fixtureRoot = path.join(root, `input-${fixture.id}`);
      await copyFixtureTree(fixtureSource, fixtureRoot);
      const repositoryRoot = path.join(root, `work-${fixture.id}`);
      await copyFixtureTree(path.join(fixtureRoot, 'repository'), repositoryRoot);
      const stages = new Set();
      async function snapshot(stage) {
        if (!['initial', 'proposal', 'proposalCheckPreWrite', 'proposalCheckFinal', 'preWrite', 'final', 'reconcileBefore', 'reconcileAfter'].includes(stage) || stages.has(stage)) {
          throw failure('OWNED_SNAPSHOT', 'snapshot stage must be a fresh, known physical copy');
        }
        stages.add(stage);
        const inventory = await inventoryNativeRepository(repositoryRoot);
        const snapshotRoot = path.join(root, `snapshot-${fixture.id}-${stage}`);
        await copyFixtureTree(repositoryRoot, snapshotRoot);
        if (JSON.stringify(await inventoryNativeRepository(snapshotRoot)) !== JSON.stringify(inventory)
          || JSON.stringify(await inventoryNativeRepository(repositoryRoot)) !== JSON.stringify(inventory)) {
          throw failure('OWNED_SNAPSHOT', 'repository changed during snapshot capture');
        }
        if (stage === 'initial') {
          preparedRepositories.get(fixture.id).initialSnapshot = {
            root: snapshotRoot, identity: await lstat(snapshotRoot), inventory: structuredClone(inventory),
          };
        }
        if (stage === 'reconcileAfter') preparedRepositories.get(fixture.id).routingBaseline = JSON.stringify(inventory);
        return { root: snapshotRoot, inventory };
      }
      const oraclePath = path.join(fixtureRoot, 'fixture.json');
      const oracleBytes = await readNativeInputFile(root, oraclePath, 1024 * 1024);
      if (!oracleBytes.equals(sourceOracleBytes)
        || JSON.stringify(await inventoryNativeRepository(repositoryRoot)) !== JSON.stringify(versionedInventory)
        || JSON.stringify(await inventoryNativeRepository(versionedRepositoryRoot)) !== JSON.stringify(versionedInventory)) {
        throw failure('OWNED_FIXTURE', 'versioned source changed during fixture preparation');
      }
      preparedRepositories.set(fixture.id, { fixtureRoot, repositoryRoot, oraclePath, oracleBytes,
        fixtureIdentity: await lstat(fixtureRoot), repositoryIdentity: await lstat(repositoryRoot),
        originalIdentity: await lstat(path.join(fixtureRoot, 'repository')),
        fixtureSource, fixtureSourceIdentity, versionedRepositoryRoot, versionedRepositoryIdentity,
        sourceOraclePath, sourceOracleBytes, sourceOracleIdentity, versionedInventory,
        initialSnapshot: null, routingBaseline: null });
      return { fixture, fixtureRoot, repositoryRoot, snapshot };
    }
    async function verifyNativeInputs(inputs) {
      const bound = nativeInputs.get(inputs);
      if (cleaned || cleaning || !bound) {
        throw failure('NATIVE_INPUTS', 'verification requires an open runtime and its actual controller-created receipt');
      }
      const operation = Symbol('native input verification');
      nativeInputOperations.add(operation);
      try { return await verifyBoundNativeInputs(bound); }
      finally { nativeInputOperations.delete(operation); }
    }
    async function verifyBoundNativeInputs(bound) {
      for (const [key, target] of Object.entries(bound.directories)) {
        const current = await assertCodexDirectory(target.path);
        if (current.dev !== target.dev || current.ino !== target.ino || (current.mode & 0o7777) !== target.mode
          || current.uid !== target.uid || current.gid !== target.gid) {
          throw failure('NATIVE_INPUTS', `native input ${key} directory identity or permissions changed`);
        }
      }
      for (const [key, target] of Object.entries(bound.files)) {
        const current = await lstat(target.path);
        if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1
          || current.dev !== target.dev || current.ino !== target.ino || (current.mode & 0o7777) !== target.mode
          || current.uid !== target.uid || current.gid !== target.gid) {
          throw failure('NATIVE_INPUTS', `native input ${key} file identity or permissions changed`);
        }
      }
      for (const entry of packageSources) {
        const current = await lstat(entry.path);
        if (current.dev !== entry.identity.dev || current.ino !== entry.identity.ino
          || (current.mode & 0o7777) !== (entry.identity.mode & 0o7777)
          || !(await readNativeInputFile(source, entry.path, 1024 * 1024)).equals(entry.bytes)) {
          throw failure('NATIVE_INPUTS', 'current package source identity or bytes changed');
        }
      }
      const names = (await readdir(bound.root)).sort();
      if (JSON.stringify(names) !== JSON.stringify(['manifest.json', 'package.tgz', 'repository'])) {
        throw failure('NATIVE_INPUTS', 'native input root contains missing or unlisted controller files');
      }
      const manifestBytes = await readNativeInputFile(root, bound.manifestPath, 1024 * 1024);
      const packageBytes = await readNativeInputFile(root, bound.tarball, 16 * 1024 * 1024);
      const currentPackage = await readNativeInputFile(root, tarball, 16 * 1024 * 1024);
      const oracleBytes = await readNativeInputFile(root, bound.oraclePath, 1024 * 1024);
      const sourceOracleBytes = await readNativeInputFile(bound.fixtureSource, bound.sourceOraclePath, 1024 * 1024);
      if (!manifestBytes.equals(bound.manifestBytes) || !packageBytes.equals(tarballBytes)
        || !currentPackage.equals(tarballBytes) || !oracleBytes.equals(bound.oracleBytes)
        || !sourceOracleBytes.equals(bound.sourceOracleBytes)) {
        throw failure('NATIVE_INPUTS', 'native input manifest, current packed package or private oracle changed');
      }
      for (const target of [bound.repositoryRoot, bound.initialSnapshotRoot, bound.sourceRepositoryRoot,
        bound.originalRepositoryRoot, bound.versionedRepositoryRoot]) {
        if (JSON.stringify(await inventoryNativeRepository(target)) !== bound.inventory) {
          throw failure('NATIVE_INPUTS', 'native input repository drifted from the private initial snapshot');
        }
      }
      return { verified: true, manifestDigest: bound.manifestDigest, nativeExecuted: false, containmentProven: false };
    }
    async function prepareNativeInputs(fixtureId) {
      const prepared = preparedRepositories.get(fixtureId);
      if (cleaned || cleaning || !prepared?.initialSnapshot || nativeInputIds.has(fixtureId) || pendingNativeInputIds.has(fixtureId)) {
        throw failure('NATIVE_INPUTS', 'native inputs require one unused, idle controller-prepared initial fixture snapshot');
      }
      pendingNativeInputIds.add(fixtureId);
      const operation = Symbol('native input construction');
      nativeInputOperations.add(operation);
      try {
        const inputs = await buildNativeInputs(fixtureId, prepared);
        nativeInputIds.add(fixtureId);
        return inputs;
      } finally {
        pendingNativeInputIds.delete(fixtureId);
        nativeInputOperations.delete(operation);
      }
    }
    async function buildNativeInputs(fixtureId, prepared) {
      const initial = prepared.initialSnapshot;
      const initialIdentity = await assertCodexDirectory(initial.root);
      if (initialIdentity.dev !== initial.identity.dev || initialIdentity.ino !== initial.identity.ino) {
        throw failure('NATIVE_INPUTS', 'private initial snapshot identity changed');
      }
      const inventory = JSON.stringify(initial.inventory);
      if (JSON.stringify(prepared.versionedInventory) !== inventory
        || JSON.stringify(await inventoryNativeRepository(prepared.versionedRepositoryRoot)) !== inventory
        || !(await readNativeInputFile(prepared.fixtureSource, prepared.sourceOraclePath, 1024 * 1024)).equals(prepared.sourceOracleBytes)
        || JSON.stringify(await inventoryNativeRepository(initial.root)) !== inventory
        || JSON.stringify(await inventoryNativeRepository(prepared.repositoryRoot)) !== inventory
        || JSON.stringify(await inventoryNativeRepository(path.join(prepared.fixtureRoot, 'repository'))) !== inventory
        || !(await readNativeInputFile(root, prepared.oraclePath, 1024 * 1024)).equals(prepared.oracleBytes)
        || !(await readNativeInputFile(root, tarball, 16 * 1024 * 1024)).equals(tarballBytes)) {
        throw failure('NATIVE_INPUTS', 'initial source or packed package changed before native input capture');
      }
      const inputRoot = path.join(root, `native-inputs-${fixtureId}-${randomUUID()}`);
      await mkdir(inputRoot, { mode: 0o700 });
      const inputIdentity = await assertCodexDirectory(inputRoot);
      const repositoryRoot = path.join(inputRoot, 'repository');
      const nativeTarball = path.join(inputRoot, 'package.tgz');
      const manifestPath = path.join(inputRoot, 'manifest.json');
      const repositoryIdentity = await copyNativeRepository(initial.root, repositoryRoot, initial.inventory);
      await writeFile(nativeTarball, tarballBytes, { flag: 'wx', mode: 0o600 });
      const manifest = {
        schemaVersion: 1, kind: 'codex-native-input-manifest', fixtureId,
        package: { path: 'package.tgz', name: metadata.name, version: metadata.version,
          bytes: tarballBytes.length, digest: tarballDigest, integrity: tarballIntegrity },
        repository: { path: 'repository', entries: nativePublicInventory(initial.inventory) },
      };
      const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
      if (manifestBytes.length > 1024 * 1024) throw failure('NATIVE_INPUTS', 'native input manifest exceeds 1 MiB');
      await writeFile(manifestPath, manifestBytes, { flag: 'wx', mode: 0o600 });
      const manifestDigest = `sha256:${createHash('sha256').update(manifestBytes).digest('hex')}`;
      const directories = {};
      for (const [key, [target, entry]] of Object.entries({ owned: [root, identity], packageSource: [source, sourceIdentity],
        input: [inputRoot, inputIdentity],
        repository: [repositoryRoot, repositoryIdentity], source: [prepared.repositoryRoot, prepared.repositoryIdentity],
        initial: [initial.root, initial.identity], fixture: [prepared.fixtureRoot, prepared.fixtureIdentity],
        original: [path.join(prepared.fixtureRoot, 'repository'), prepared.originalIdentity],
        versioned: [prepared.fixtureSource, prepared.fixtureSourceIdentity],
        versionedRepository: [prepared.versionedRepositoryRoot, prepared.versionedRepositoryIdentity] })) {
        directories[key] = { path: target, dev: entry.dev, ino: entry.ino, mode: entry.mode & 0o7777,
          uid: entry.uid, gid: entry.gid };
      }
      const files = {};
      for (const [key, target] of Object.entries({ manifest: manifestPath, tarball: nativeTarball,
        packed: tarball, oracle: prepared.oraclePath })) {
        const entry = await lstat(target);
        files[key] = { path: target, dev: entry.dev, ino: entry.ino, mode: entry.mode & 0o7777,
          uid: entry.uid, gid: entry.gid };
      }
      const sourceOracle = prepared.sourceOracleIdentity;
      files.versionedOracle = { path: prepared.sourceOraclePath, dev: sourceOracle.dev, ino: sourceOracle.ino,
        mode: sourceOracle.mode & 0o7777, uid: sourceOracle.uid, gid: sourceOracle.gid };
      // Only transfer metadata is serializable; private authority stays in this runtime's WeakMap.
      const inputs = Object.freeze(Object.defineProperties({
        kind: 'codex-native-inputs', manifestDigest, nativeExecuted: false, containmentProven: false,
      }, {
        root: { value: inputRoot }, repositoryRoot: { value: repositoryRoot },
        tarball: { value: nativeTarball }, manifestPath: { value: manifestPath },
      }));
      nativeInputs.set(inputs, { root: inputRoot, repositoryRoot, tarball: nativeTarball, manifestPath,
        manifestBytes, manifestDigest, inventory, directories, files, initialSnapshotRoot: initial.root,
        sourceRepositoryRoot: prepared.repositoryRoot, originalRepositoryRoot: path.join(prepared.fixtureRoot, 'repository'),
        oraclePath: prepared.oraclePath, oracleBytes: prepared.oracleBytes, fixtureSource: prepared.fixtureSource,
        sourceOraclePath: prepared.sourceOraclePath, sourceOracleBytes: prepared.sourceOracleBytes,
        versionedRepositoryRoot: prepared.versionedRepositoryRoot });
      await verifyNativeInputs(inputs);
      return inputs;
    }
    async function prepareRouting(caseId, contributors) {
      if (typeof caseId !== 'string' || !/^[a-z0-9-]+$/.test(caseId) || routingIds.has(caseId)
        || !Array.isArray(contributors) || !contributors.length
        || new Set(contributors.map((entry) => entry.fixtureId)).size !== contributors.length
        || contributors.some((entry) => preparedRepositories.get(entry.fixtureId)?.repositoryRoot !== entry.repositoryRoot
          || !preparedRepositories.get(entry.fixtureId)?.routingBaseline)) {
        throw failure('CONTRIBUTOR_CONTEXT', 'routing requires a fresh case and controller-prepared contributor roots');
      }
      routingIds.add(caseId);
      const workspace = path.join(root, `routing-${caseId}-${randomUUID()}`);
      await mkdir(workspace, { mode: 0o700 });
      const copies = [];
      for (const contributor of contributors) {
        const inventory = await inventoryNativeRepository(contributor.repositoryRoot);
        if (JSON.stringify(inventory) !== preparedRepositories.get(contributor.fixtureId).routingBaseline) {
          throw failure('CONTRIBUTOR_CONTEXT', 'contributor drifted from its verified setup baseline');
        }
        const repositoryRoot = path.join(workspace, contributor.fixtureId);
        await copyFixtureTree(contributor.repositoryRoot, repositoryRoot);
        if (JSON.stringify(await inventoryCodexTree(repositoryRoot)) !== JSON.stringify(inventory)
          || JSON.stringify(await inventoryCodexTree(contributor.repositoryRoot)) !== JSON.stringify(inventory)) {
          throw failure('CONTRIBUTOR_CONTEXT', 'contributor changed during fresh routing preparation');
        }
        copies.push({ fixtureId: contributor.fixtureId, repositoryRoot, inventory });
      }
      return copies;
    }
    return { root, env, package: packed, commands, motherSkillRoot, prepareFixture, prepareRouting,
      prepareNativeInputs, verifyNativeInputs, cleanup };
  } catch (cause) {
    const installation = { packageName: metadata.name, packageVersion: metadata.version, commands: [...commands, ...(cause.command ? [cause.command] : [])] };
    const processCleanupUnconfirmed = cause.processCleanupUnconfirmed === true;
    let cleanupResult;
    let error = cause;
    if (processCleanupUnconfirmed) {
      cleanupResult = { removed: false, error: { code: 'INSTALL_CLEANUP', message: 'process-group absence is unconfirmed; owned root retained without deletion' } };
    } else {
      try { cleanupResult = await cleanup(); }
      catch (cleanupError) {
        cleanupResult = { removed: false, error: { code: cleanupError.code ?? 'OWNED_CLEANUP', message: cleanupError.message } };
        error = new AggregateError([cause, cleanupError], 'Owned installation failed and cleanup was refused', { cause });
      }
    }
    throw Object.assign(error, { code: cause.code ?? 'INSTALL_FAILURE', installation, cleanup: cleanupResult, ownedRoot: root,
      ownedIdentity: { dev: identity.dev, ino: identity.ino }, processCleanupUnconfirmed });
  }
}
