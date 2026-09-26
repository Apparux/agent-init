import { lstat, mkdir, readdir, realpath, rmdir } from 'node:fs/promises';

import { entryFingerprint } from './filesystem.js';
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
  for (const segment of relative.split(path.sep)) {
    cursor = path.join(cursor, segment);
    let stat;
    let didCreate = false;
    try {
      stat = await lstat(cursor);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await options.onParentIntent(cursor);
      if (typeof options.beforeMutation === 'function') {
        await options.beforeMutation(`parent:create:${segment}`, cursor);
      }
      if (path.dirname(cursor) !== paths.logicalHome) {
        await validateManagedAncestors(paths, path.dirname(cursor), { allowMissing: false });
      }
      try {
        await mkdir(cursor);
        didCreate = true;
      } catch (mkdirError) {
        if (mkdirError.code !== 'EEXIST') throw mkdirError;
        await options.onParentCompletion(cursor, null);
      }
      stat = await lstat(cursor);
      if (didCreate && typeof options.afterMutation === 'function') {
        await options.afterMutation('parent:created', cursor);
        const current = await lstat(cursor);
        if (current.dev !== stat.dev || current.ino !== stat.ino || !current.isDirectory()) {
          throw new InstallationError('OWNERSHIP_MISMATCH', `Parent changed during creation: ${cursor}`, {
            path: cursor,
            remediation: 'Preserve the replacement directory and inspect the operation journal.',
          });
        }
      }
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
    if (didCreate) {
      await options.onParentCompletion(cursor, `${stat.dev}:${stat.ino}`);
      created.push(cursor);
    }
  }
  return created;
}

export function validateCreatedParents(paths, operation) {
  if (!Array.isArray(operation.journal.intents) || !Array.isArray(operation.journal.completed) ||
    [...operation.journal.intents, ...operation.journal.completed].some((record) => !record || typeof record !== 'object')) {
    throw new InstallationError('AMBIGUOUS_OPERATION', 'Discovery parent journal records are invalid.', {
      path: operation.journalPath ?? paths.lock,
      remediation: 'Preserve the operation journal and discovery parents for manual review.',
    });
  }
  const intents = operation.journal.intents.filter((record) => record.action === 'create-parent');
  const completed = operation.journal.completed.filter((record) => record.action === 'create-parent');
  const seen = new Set();
  const records = [];
  for (const intent of intents) {
    const matches = completed.filter((record) => record.path === intent.path);
    const completion = matches[0];
    if (
      typeof intent.path !== 'string' ||
      intent.path !== path.resolve(intent.path) ||
      !isPathInside(paths.logicalHome, intent.path) ||
      !Object.values(paths.targetParents).some((parent) =>
        parent === intent.path || isPathInside(intent.path, parent)) ||
      intent.operationId !== operation.operationId ||
      intent.expected !== 'missing' || seen.has(intent.path) || matches.length > 1 ||
      (completion && (completion.operationId !== operation.operationId ||
        typeof completion.created !== 'boolean' ||
        (completion.created && typeof completion.entryIdentity !== 'string')))
    ) {
      throw new InstallationError('AMBIGUOUS_OPERATION', 'Discovery parent creation evidence is invalid.', {
        path: intent.path,
        remediation: 'Preserve the operation journal and discovery parents for manual review.',
      });
    }
    seen.add(intent.path);
    if (completion?.created === false) continue;
    records.push({ ...intent, entryIdentity: completion?.entryIdentity });
  }
  if (completed.some((record) => !seen.has(record.path))) {
    throw new InstallationError('AMBIGUOUS_OPERATION', 'Discovery parent completion has no creation intent.', {
      remediation: 'Preserve the operation journal and discovery parents for manual review.',
    });
  }
  return records;
}

export async function rollbackCreatedParents(paths, operation, options = {}) {
  const records = validateCreatedParents(paths, operation);
  const unresolved = [];
  for (const record of records.sort((a, b) => b.path.split(path.sep).length - a.path.split(path.sep).length)) {
    let removed = false;
    try {
      if (typeof options.beforeMutation === 'function') await options.beforeMutation('parent:remove', record.path);
      await validateManagedAncestors(paths, record.path);
      const current = await entryFingerprint(record.path);
      if (current.type === 'missing') continue;
      if (!record.entryIdentity || current.type !== 'directory' || current.identity !== record.entryIdentity) {
        throw new Error('Creation ownership or directory identity cannot be established');
      }
      if ((await readdir(record.path)).length !== 0) throw new Error('Directory contains foreign or retained entries');
      for (const ancestor of records.filter((entry) => isPathInside(entry.path, record.path))) {
        const state = await entryFingerprint(ancestor.path);
        if (!ancestor.entryIdentity || state.type !== 'directory' || state.identity !== ancestor.entryIdentity) {
          throw new Error(`Operation-created ancestor identity changed: ${ancestor.path}`);
        }
      }
      await validateManagedAncestors(paths, record.path, { allowMissing: false });
      const checked = await entryFingerprint(record.path);
      if (checked.type !== 'directory' || checked.identity !== record.entryIdentity) {
        throw new Error('Directory identity changed before removal');
      }
      await rmdir(record.path);
      removed = true;
      if (typeof options.afterMutation === 'function') await options.afterMutation('parent:removed', record.path);
    } catch (error) {
      unresolved.push({ path: record.path, reason: error.message, removed });
    }
  }
  if (unresolved.length > 0) {
    throw new InstallationError('ROLLBACK_FAILED', 'Discovery parents were preserved because safe rollback could not be established.', {
      path: unresolved[0].path,
      preserved: unresolved.filter((entry) => !entry.removed).map((entry) => entry.path),
      unresolved: unresolved.map((entry) => entry.path),
      remediation: `Inspect the retained operation journal and parents before retrying: ${unresolved.map((entry) => `${entry.path}: ${entry.reason}`).join('; ')}`,
    });
  }
}

// Effective target view for a (possibly stale) manifest: registry keys plus
// any manifest record whose path is not covered by the registry. This lets
// inspect/uninstall handle targets written under a harness config that has
// since been removed, without ever widening what may be deleted: a manifest
// record's path is used verbatim, never re-derived.
export function withManifestTargets(paths, manifest) {
  const targets = { ...paths.targets };
  const targetParents = { ...paths.targetParents };
  if (manifest?.targets && typeof manifest.targets === 'object') {
    for (const [name, record] of Object.entries(manifest.targets)) {
      if (targets[name] !== undefined || typeof record?.path !== 'string') continue;
      targets[name] = record.path;
      targetParents[name] = path.dirname(record.path);
    }
  }
  return { targets, targetParents };
}

export async function resolveInstallationPaths(homeDir, registry) {
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

  if (
    !registry ||
    !Array.isArray(registry.entries) ||
    registry.entries.length === 0
  ) {
    throw new InstallationError(
      'INVALID_HOME',
      'Harness registry must be a non-empty array.',
      { remediation: 'Load the harness registry before resolving installation paths.' },
    );
  }

  const aliases = registry.aliases ?? new Map();
  const installRoot = path.join(homeDir, '.agent-init');
  const canonicalRoot = path.join(installRoot, 'current');
  const canonicalSkill = path.join(canonicalRoot, 'skills', 'agent-init');
  const targets = {};
  const targetParents = {};
  for (const entry of registry.entries) {
    if (!entry || typeof entry.key !== 'string' || typeof entry.skillsDir !== 'string') {
      throw new InstallationError(
        'INVALID_HARNESS_REGISTRY',
        `Harness registry entry is invalid: ${JSON.stringify(entry)}`,
        { remediation: 'Use entries produced by loadHarnessRegistry.' },
      );
    }
    const parent = path.join(homeDir, ...entry.skillsDir.split('/'));
    const target = path.join(parent, 'agent-init');
    if (targets[entry.key] !== undefined || targetParents[entry.key] !== undefined) {
      throw new InstallationError(
        'INVALID_HARNESS_REGISTRY',
        `Harness registry has duplicate keys: ${entry.key}`,
        { remediation: 'Use a registry with unique harness keys.' },
      );
    }
    targets[entry.key] = target;
    targetParents[entry.key] = parent;
  }
  const paths = {
    logicalHome: path.resolve(homeDir),
    physicalHome,
    installRoot,
    canonicalRoot,
    canonicalSkill,
    manifest: path.join(installRoot, 'install.json'),
    canonicalMarker: path.join(canonicalRoot, '.agent-init-owner.json'),
    targets,
    targetParents,
    registry: registry.entries,
    aliases,
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
