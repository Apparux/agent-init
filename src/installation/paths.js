import { lstat, mkdir, realpath, rmdir } from 'node:fs/promises';
import path from 'node:path';

export class InstallationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'InstallationError';
    this.code = code;
    this.details = details;
  }
}

export function isPathInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export async function validateManagedAncestors(paths, candidate, options = {}) {
  const allowMissing = options.allowMissing ?? true;
  const relative = path.relative(paths.logicalHome, path.resolve(candidate));
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new InstallationError(
      'PHYSICAL_PATH_ESCAPE',
      `Managed path escapes the home directory: ${candidate}`,
      { path: candidate, remediation: 'Use paths contained by the resolved home directory.' },
    );
  }

  let cursor = paths.logicalHome;
  for (const segment of relative.split(path.sep)) {
    cursor = path.join(cursor, segment);
    let stat;
    try {
      stat = await lstat(cursor);
    } catch (error) {
      if (error.code === 'ENOENT' && allowMissing) return;
      if (error.code === 'ENOENT') {
        throw new InstallationError(
          'PARTIAL_INSTALLATION',
          `Required managed ancestor is missing: ${cursor}`,
          { path: cursor, remediation: 'Run install or update after reviewing the installation.' },
        );
      }
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new InstallationError(
        'PHYSICAL_PATH_ESCAPE',
        `Managed ancestor must not be a symbolic link: ${cursor}`,
        { path: cursor, remediation: 'Replace the linked parent with a real directory or choose another HOME.' },
      );
    }
    if (!stat.isDirectory() && cursor !== candidate) {
      throw new InstallationError(
        'INSTALL_CONFLICT',
        `Managed ancestor is not a directory: ${cursor}`,
        { path: cursor, remediation: 'Move the conflicting entry and retry.' },
      );
    }
    const physical = await realpath(cursor);
    if (physical !== paths.physicalHome && !isPathInside(paths.physicalHome, physical)) {
      throw new InstallationError(
        'PHYSICAL_PATH_ESCAPE',
        `Managed ancestor resolves outside the physical home: ${cursor}`,
        { path: cursor, remediation: 'Use a normal directory tree contained by HOME.' },
      );
    }
  }
}

export async function ensureSafeDirectoryChain(paths, targetDirectory, options = {}) {
  const absoluteTarget = path.resolve(targetDirectory);
  const relative = path.relative(paths.logicalHome, absoluteTarget);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new InstallationError(
      'PHYSICAL_PATH_ESCAPE',
      `Directory chain escapes the resolved home: ${targetDirectory}`,
      { path: targetDirectory, remediation: 'Use a target contained by the resolved home directory.' },
    );
  }
  const created = [];
  let cursor = paths.logicalHome;
  try {
    for (const segment of relative.split(path.sep)) {
      cursor = path.join(cursor, segment);
      let stat;
      try {
        stat = await lstat(cursor);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        if (typeof options.beforeMutation === 'function') {
          await options.beforeMutation(`parent:create:${segment}`, cursor);
        }
        try {
          await mkdir(cursor);
          created.push(cursor);
        } catch (mkdirError) {
          if (mkdirError.code !== 'EEXIST') throw mkdirError;
        }
        stat = await lstat(cursor);
      }
      if (stat.isSymbolicLink()) {
        throw new InstallationError(
          'PHYSICAL_PATH_ESCAPE',
          `Managed parent became a symbolic link: ${cursor}`,
          { path: cursor, remediation: 'Preserve the link and retry only with a real directory parent.' },
        );
      }
      if (!stat.isDirectory()) {
        throw new InstallationError(
          'INSTALL_CONFLICT',
          `Managed parent is not a directory: ${cursor}`,
          { path: cursor, remediation: 'Move the conflicting entry and retry.' },
        );
      }
      const physical = await realpath(cursor);
      if (physical !== paths.physicalHome && !isPathInside(paths.physicalHome, physical)) {
        throw new InstallationError(
          'PHYSICAL_PATH_ESCAPE',
          `Managed parent resolves outside the physical home: ${cursor}`,
          { path: cursor, remediation: 'Use a directory chain physically contained by HOME.' },
        );
      }
    }
    return created;
  } catch (error) {
    for (const createdDirectory of created.reverse()) {
      await rmdir(createdDirectory).catch(() => {});
    }
    throw error;
  }
}

export async function rollbackCreatedParents(createdDirectories) {
  for (const directory of [...createdDirectories].reverse()) {
    await rmdir(directory).catch(() => {});
  }
}

export async function resolveInstallationPaths(homeDir) {
  if (typeof homeDir !== 'string' || !path.isAbsolute(homeDir)) {
    throw new InstallationError(
      'INVALID_HOME',
      `Home directory must be an absolute path: ${String(homeDir)}`,
      { path: homeDir, remediation: 'Set HOME to an existing writable directory.' },
    );
  }

  let homeStat;
  let physicalHome;
  try {
    homeStat = await lstat(homeDir);
    physicalHome = await realpath(homeDir);
  } catch (error) {
    throw new InstallationError(
      'INVALID_HOME',
      `Home directory cannot be resolved: ${homeDir}`,
      { path: homeDir, cause: error, remediation: 'Set HOME to an existing readable directory.' },
    );
  }
  if (!homeStat.isDirectory() && !homeStat.isSymbolicLink()) {
    throw new InstallationError(
      'INVALID_HOME',
      `Home path is not a directory: ${homeDir}`,
      { path: homeDir, remediation: 'Set HOME to an existing directory.' },
    );
  }

  const installRoot = path.join(homeDir, '.agent-init');
  const canonicalRoot = path.join(installRoot, 'current');
  const canonicalSkill = path.join(canonicalRoot, 'skills', 'agent-init');
  const paths = {
    logicalHome: path.resolve(homeDir),
    physicalHome,
    installRoot,
    canonicalRoot,
    canonicalSkill,
    manifest: path.join(installRoot, 'install.json'),
    canonicalMarker: path.join(canonicalRoot, '.agent-init-owner.json'),
    targets: {
      codex: path.join(homeDir, '.agents', 'skills', 'agent-init'),
      claude: path.join(homeDir, '.claude', 'skills', 'agent-init'),
    },
    targetParents: {
      codex: path.join(homeDir, '.agents', 'skills'),
      claude: path.join(homeDir, '.claude', 'skills'),
    },
    lock: path.join(homeDir, '.agent-init.operation.lock'),
  };

  for (const candidate of [
    paths.installRoot,
    paths.canonicalRoot,
    paths.canonicalSkill,
    paths.manifest,
    ...Object.values(paths.targets),
    ...Object.values(paths.targetParents),
    paths.lock,
  ]) {
    if (!isPathInside(paths.logicalHome, candidate)) {
      throw new InstallationError(
        'PHYSICAL_PATH_ESCAPE',
        `Managed path escapes the home directory: ${candidate}`,
        { path: candidate, remediation: 'Use a normal absolute home directory without path aliases.' },
      );
    }
  }

  return paths;
}
