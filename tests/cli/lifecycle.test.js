import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const binPath = fileURLToPath(new URL('../../bin/agent-init.js', import.meta.url));

async function createCliHome(t) {
  const disposableRoot = await mkdtemp(path.join(tmpdir(), 'ai-cli-'));
  t.after(() => rm(disposableRoot, { recursive: true, force: true }));
  const homeDir = path.join(disposableRoot, 'home');
  const repository = path.join(disposableRoot, 'repository');
  await mkdir(homeDir);
  await mkdir(repository);
  await writeFile(path.join(homeDir, 'foreign-sentinel.txt'), 'foreign home\n', {
    mode: 0o640,
  });
  await writeFile(path.join(repository, 'AGENTS.md'), 'project sentinel\n', {
    mode: 0o640,
  });

  const parsed = path.parse(homeDir);
  const env = {
    ...process.env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    HOMEDRIVE: parsed.root,
    HOMEPATH: homeDir.slice(parsed.root.length),
  };
  function run(command) {
    return spawnSync(process.execPath, [binPath, command], {
      cwd: repository,
      env,
      encoding: 'utf8',
    });
  }
  return { disposableRoot, homeDir, repository, run };
}

test('spawned CLI completes install, doctor, update no-op, and uninstall', async (t) => {
  const { homeDir, repository, run } = await createCliHome(t);

  const install = run('install');
  assert.equal(install.status, 0, install.stderr);
  assert.equal(install.stderr, '');
  assert.match(install.stdout, /Agent Init 0\.1\.3-rc\.2/);
  assert.match(install.stdout, /Installation/);
  assert.match(install.stdout, /Ready\./);
  assert.match(install.stdout, /\/agent-init/);
  assert.match(install.stdout, /\$agent-init/);

  const manifestPath = path.join(homeDir, '.agent-init', 'install.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.equal(manifest.installRoot, path.join(homeDir, '.agent-init'));
  assert.equal((await lstat(manifest.targets.codex.path)).isSymbolicLink(), true);
  assert.equal((await lstat(manifest.targets.claude.path)).isSymbolicLink(), true);

  const doctor = run('doctor');
  assert.equal(doctor.status, 0, doctor.stderr);
  assert.equal(doctor.stderr, '');
  assert.match(doctor.stdout, /Status\n  ✓ Healthy/);

  const update = run('update');
  assert.equal(update.status, 0, update.stderr);
  assert.equal(update.stderr, '');
  assert.match(update.stdout, /Already up to date\./);

  const uninstall = run('uninstall');
  assert.equal(uninstall.status, 0, uninstall.stderr);
  assert.equal(uninstall.stderr, '');
  assert.match(uninstall.stdout, /Uninstalled\./);
  assert.equal(await readFile(path.join(homeDir, 'foreign-sentinel.txt'), 'utf8'), 'foreign home\n');
  assert.equal(await readFile(path.join(repository, 'AGENTS.md'), 'utf8'), 'project sentinel\n');
});
