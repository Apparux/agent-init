import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const PACKAGE_NAME = '@apparux/agent-init';

export async function createInstallationFixture(t, options = {}) {
  const disposableRoot = await mkdtemp(path.join(tmpdir(), 'aps-installation-'));
  t.after(() => rm(disposableRoot, { recursive: true, force: true }));

  const homeDir = path.join(disposableRoot, 'home');
  const packageRoot = path.join(disposableRoot, 'package');
  await mkdir(path.join(homeDir, '.agents', 'skills'), { recursive: true });
  await mkdir(path.join(homeDir, '.claude', 'skills'), { recursive: true });
  await mkdir(path.join(packageRoot, 'skills', 'project-setup', 'references'), {
    recursive: true,
  });

  const version = options.version ?? '0.1.0';
  await writeFile(
    path.join(packageRoot, 'package.json'),
    `${JSON.stringify({ name: PACKAGE_NAME, version }, null, 2)}\n`,
  );
  await writeFile(
    path.join(packageRoot, 'skills', 'project-setup', 'SKILL.md'),
    options.skill ?? `---\nname: project-setup\ndescription: Set up agent assets for an existing repository.\n---\n\n# Project Setup\n`,
  );
  await writeFile(
    path.join(packageRoot, 'skills', 'project-setup', 'references', 'guide.md'),
    options.guide ?? '# Guide\n',
  );

  const sentinels = {
    home: path.join(homeDir, 'user-home-sentinel.txt'),
    agents: path.join(homeDir, '.agents', 'user-agents-sentinel.txt'),
    agentsSkills: path.join(homeDir, '.agents', 'skills', 'user-skill.txt'),
    claude: path.join(homeDir, '.claude', 'user-claude-sentinel.txt'),
    claudeSkills: path.join(homeDir, '.claude', 'skills', 'user-skill.txt'),
  };
  for (const [name, sentinelPath] of Object.entries(sentinels)) {
    await writeFile(sentinelPath, `foreign:${name}\n`, { mode: 0o640 });
  }

  let randomCounter = 0;
  const runtime = {
    homeDir,
    packageRoot,
    packageName: PACKAGE_NAME,
    packageVersion: version,
    platform: process.platform,
    now: () => new Date('2026-01-02T03:04:05.000Z'),
    randomBytes(size) {
      randomCounter += 1;
      return Buffer.alloc(size, randomCounter);
    },
  };

  return { disposableRoot, homeDir, packageRoot, runtime, sentinels };
}

export async function assertSentinelsUnchanged(sentinels) {
  for (const [name, sentinelPath] of Object.entries(sentinels)) {
    const content = await readFile(sentinelPath, 'utf8');
    if (content !== `foreign:${name}\n`) {
      throw new Error(`Foreign sentinel changed: ${sentinelPath}`);
    }
    const stat = await lstat(sentinelPath);
    const modeChanged =
      process.platform !== 'win32' && (stat.mode & 0o777) !== 0o640;
    if (!stat.isFile() || modeChanged) {
      throw new Error(`Foreign sentinel type or mode changed: ${sentinelPath}`);
    }
  }
}

export async function snapshotTree(root) {
  const snapshot = [];
  async function visit(directory, relativeDirectory = '') {
    const names = await readdir(directory);
    names.sort();
    for (const name of names) {
      const absolutePath = path.join(directory, name);
      const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      const stat = await lstat(absolutePath);
      const common = {
        path: relativePath,
        mode: stat.mode & 0o777,
        mtimeMs: stat.mtimeMs,
        identity: `${stat.dev}:${stat.ino}`,
      };
      if (stat.isSymbolicLink()) {
        snapshot.push({ ...common, type: 'symlink', linkText: await readlink(absolutePath) });
      } else if (stat.isDirectory()) {
        snapshot.push({ ...common, type: 'directory' });
        await visit(absolutePath, relativePath);
      } else if (stat.isFile()) {
        snapshot.push({
          ...common,
          type: 'file',
          content: (await readFile(absolutePath)).toString('base64'),
        });
      } else {
        snapshot.push({ ...common, type: 'other' });
      }
    }
  }
  await visit(root);
  return snapshot;
}
