import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../..', import.meta.url));

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', ...options });
}

test('packed artifact independently completes the distribution lifecycle', async (t) => {
  const disposableRoot = await mkdtemp(path.join(tmpdir(), 'aps-tarball-'));
  t.after(() => rm(disposableRoot, { recursive: true, force: true }));
  const packDir = path.join(disposableRoot, 'pack');
  const prefix = path.join(disposableRoot, 'prefix');
  const homeDir = path.join(disposableRoot, 'home');
  const npmCache = path.join(disposableRoot, 'npm-cache');
  const repository = path.join(disposableRoot, 'repository');
  await Promise.all([
    mkdir(packDir),
    mkdir(prefix),
    mkdir(homeDir),
    mkdir(npmCache),
    mkdir(repository),
  ]);
  await writeFile(path.join(homeDir, 'foreign.txt'), 'foreign home\n', { mode: 0o640 });
  await writeFile(path.join(repository, 'AGENTS.md'), 'project asset\n', { mode: 0o640 });

  const parsed = path.parse(homeDir);
  const env = {
    ...process.env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    HOMEDRIVE: parsed.root,
    HOMEPATH: homeDir.slice(parsed.root.length),
    npm_config_cache: npmCache,
    npm_config_update_notifier: 'false',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
  };
  const packed = run(
    'npm',
    ['pack', '--json', '--pack-destination', packDir],
    { cwd: projectRoot, env },
  );
  assert.equal(packed.status, 0, packed.stderr);
  const packResult = JSON.parse(packed.stdout)[0];
  const packagedPaths = packResult.files.map((entry) => entry.path).sort();
  assert.equal(packagedPaths.includes('package.json'), true);
  assert.equal(packagedPaths.includes('LICENSE'), true);
  assert.equal(packagedPaths.includes('bin/agent-project-setup.js'), true);
  assert.equal(packagedPaths.includes('skills/project-setup/SKILL.md'), true);
  assert.equal(
    packagedPaths.every(
      (entry) =>
        entry === 'package.json' ||
        entry === 'README.md' ||
        entry === 'LICENSE' ||
        entry.startsWith('bin/') ||
        entry.startsWith('src/') ||
        entry.startsWith('skills/'),
    ),
    true,
    packagedPaths.join('\n'),
  );
  assert.equal(packagedPaths.some((entry) => entry.startsWith('tests/')), false);
  assert.equal(packagedPaths.some((entry) => /PRD|DESIGN|TASKS/.test(entry)), false);

  const tarball = path.join(packDir, packResult.filename);
  const installed = run(
    'npm',
    ['install', '--ignore-scripts', '--no-package-lock', '--prefix', prefix, tarball],
    { cwd: repository, env },
  );
  assert.equal(installed.status, 0, installed.stderr);
  const binPath = path.join(
    prefix,
    'node_modules',
    '@apparux',
    'agent-project-setup',
    'bin',
    'agent-project-setup.js',
  );
  await rm(packDir, { recursive: true });
  await rm(npmCache, { recursive: true });

  function cli(command) {
    return run(process.execPath, [binPath, command], { cwd: repository, env });
  }
  const version = cli('--version');
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout, 'agent-project-setup 0.1.3-rc.0\n');

  const install = cli('install');
  assert.equal(install.status, 0, install.stderr);
  const manifest = JSON.parse(
    await readFile(path.join(homeDir, '.agent-project-setup', 'install.json'), 'utf8'),
  );
  assert.equal(manifest.installRoot, path.join(homeDir, '.agent-project-setup'));
  assert.equal(manifest.canonical.skillPath.includes(prefix), false);
  assert.equal((await lstat(manifest.targets.codex.path)).isSymbolicLink(), true);
  assert.equal((await lstat(manifest.targets.claude.path)).isSymbolicLink(), true);

  for (const command of ['doctor', 'install', 'update']) {
    const result = cli(command);
    assert.equal(result.status, 0, `${command}: ${result.stderr}`);
  }

  assert.match(
    await readFile(path.join(manifest.canonical.skillPath, 'SKILL.md'), 'utf8'),
    /name:\s*project-setup/,
  );

  const uninstall = cli('uninstall');
  assert.equal(uninstall.status, 0, uninstall.stderr);
  await rm(prefix, { recursive: true });
  assert.equal(await readFile(path.join(homeDir, 'foreign.txt'), 'utf8'), 'foreign home\n');
  assert.equal(await readFile(path.join(repository, 'AGENTS.md'), 'utf8'), 'project asset\n');
});
