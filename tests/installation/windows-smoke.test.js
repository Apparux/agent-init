import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { executeLifecycle } from '../../src/installation/lifecycle.js';
import { createInstallationFixture } from './helpers.js';

const binPath = fileURLToPath(
  new URL('../../bin/agent-init.js', import.meta.url),
);

function windowsHomeEnvironment(homeDir) {
  const parsed = path.parse(homeDir);
  return {
    ...process.env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    HOMEDRIVE: parsed.root,
    HOMEPATH: homeDir.slice(parsed.root.length),
  };
}

async function exists(entryPath) {
  try {
    await lstat(entryPath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

test(
  'Windows Native CLI completes install, real update, doctor, and uninstall',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const disposableRoot = await mkdtemp(path.join(tmpdir(), 'aps-windows-smoke-'));
    t.after(() => rm(disposableRoot, { recursive: true, force: true }));
    const homeDir = path.join(disposableRoot, 'home');
    const repository = path.join(disposableRoot, 'repository');
    const packageCopy = path.join(disposableRoot, 'package-copy');
    await mkdir(homeDir);
    await mkdir(repository);
    await mkdir(packageCopy);
    await writeFile(path.join(homeDir, 'foreign.txt'), 'foreign home\n');
    await writeFile(path.join(repository, 'AGENTS.md'), 'project sentinel\n');
    const projectRoot = path.resolve(path.dirname(binPath), '..');
    for (const directory of ['bin', 'src', 'skills']) {
      await cp(
        path.join(projectRoot, directory),
        path.join(packageCopy, directory),
        { recursive: true },
      );
    }
    await cp(
      path.join(projectRoot, 'package.json'),
      path.join(packageCopy, 'package.json'),
    );
    const env = windowsHomeEnvironment(homeDir);
    const packageBin = path.join(packageCopy, 'bin', 'agent-init.js');

    function run(command) {
      return spawnSync(process.execPath, [packageBin, command], {
        cwd: repository,
        env,
        encoding: 'utf8',
      });
    }

    const installed = run('install');
    assert.equal(installed.status, 0, installed.stderr);
    const installRoot = path.join(homeDir, '.agent-init');
    const codexTarget = path.join(homeDir, '.agents', 'skills', 'project-setup');
    const claudeTarget = path.join(homeDir, '.claude', 'skills', 'project-setup');
    assert.equal(await exists(installRoot), true);
    assert.equal(await exists(codexTarget), true);
    assert.equal(await exists(claudeTarget), true);

    const doctorBeforeUpdate = run('doctor');
    assert.equal(doctorBeforeUpdate.status, 0, doctorBeforeUpdate.stderr);

    const packageMetadataPath = path.join(packageCopy, 'package.json');
    const packageMetadata = JSON.parse(await readFile(packageMetadataPath, 'utf8'));
    packageMetadata.version = '0.2.0';
    await writeFile(packageMetadataPath, `${JSON.stringify(packageMetadata, null, 2)}\n`);
    await writeFile(
      path.join(packageCopy, 'skills', 'project-setup', 'SKILL.md'),
      '---\nname: project-setup\ndescription: Windows update payload.\n---\n\n# Version 0.2\n',
    );

    const updated = run('update');
    assert.equal(updated.status, 0, updated.stderr);
    const installedManifest = JSON.parse(
      await readFile(path.join(installRoot, 'install.json'), 'utf8'),
    );
    assert.equal(installedManifest.version, '0.2.0');
    assert.match(
      await readFile(
        path.join(installRoot, 'current', 'skills', 'project-setup', 'SKILL.md'),
        'utf8',
      ),
      /Version 0\.2/,
    );

    const doctorAfterUpdate = run('doctor');
    assert.equal(doctorAfterUpdate.status, 0, doctorAfterUpdate.stderr);
    const uninstalled = run('uninstall');
    assert.equal(uninstalled.status, 0, uninstalled.stderr);
    assert.equal(await exists(installRoot), false);
    assert.equal(await exists(codexTarget), false);
    assert.equal(await exists(claudeTarget), false);
    assert.equal(await exists(path.join(homeDir, '.agents', 'skills')), true);
    assert.equal(await exists(path.join(homeDir, '.claude', 'skills')), true);
    assert.equal(await readFile(path.join(homeDir, 'foreign.txt'), 'utf8'), 'foreign home\n');
    assert.equal(
      await readFile(path.join(repository, 'AGENTS.md'), 'utf8'),
      'project sentinel\n',
    );
  },
);

test(
  'Windows Native symlink EPERM falls back to managed copies',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const { runtime, sentinels } = await createInstallationFixture(t);
    runtime.createDirectorySymlink = () => {
      const error = new Error('Windows symlink privilege not held');
      error.code = 'EPERM';
      throw error;
    };

    const installed = await executeLifecycle({ operation: 'install' }, runtime);

    assert.equal(installed.ok, true);
    for (const record of Object.values(installed.manifest.targets)) {
      assert.equal(record.mode, 'copy');
      assert.equal((await lstat(record.path)).isDirectory(), true);
    }

    const packageMetadataPath = path.join(runtime.packageRoot, 'package.json');
    const packageMetadata = JSON.parse(await readFile(packageMetadataPath, 'utf8'));
    packageMetadata.version = '0.2.0';
    await writeFile(packageMetadataPath, `${JSON.stringify(packageMetadata, null, 2)}\n`);
    await writeFile(
      path.join(runtime.packageRoot, 'skills', 'project-setup', 'SKILL.md'),
      '---\nname: project-setup\ndescription: Windows managed-copy update payload.\n---\n\n# Version 0.2\n',
    );
    const nextRuntime = { ...runtime, packageVersion: '0.2.0' };
    const updated = await executeLifecycle({ operation: 'update' }, nextRuntime);

    assert.equal(updated.ok, true);
    assert.equal(updated.outcome, 'updated');
    for (const [name, record] of Object.entries(updated.manifest.targets)) {
      assert.equal(record.mode, 'copy');
      assert.notEqual(record.digest, installed.manifest.targets[name].digest);
      assert.match(await readFile(path.join(record.path, 'SKILL.md'), 'utf8'), /Version 0\.2/);
    }
    assert.equal((await executeLifecycle({ operation: 'doctor' }, nextRuntime)).ok, true);
    assert.equal((await executeLifecycle({ operation: 'uninstall' }, nextRuntime)).ok, true);
    assert.equal(await exists(path.join(runtime.homeDir, '.agent-init')), false);
    for (const record of Object.values(installed.manifest.targets)) {
      assert.equal(await exists(record.path), false);
    }
    for (const [name, sentinelPath] of Object.entries(sentinels)) {
      assert.equal(await readFile(sentinelPath, 'utf8'), `foreign:${name}\n`);
    }
  },
);
