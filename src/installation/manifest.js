import { constants as fsConstants } from 'node:fs';
import { link, lstat, open, unlink } from 'node:fs/promises';
import path from 'node:path';

import { readRegularFileNoFollow } from './filesystem.js';
import { InstallationError } from './paths.js';

export const MANIFEST_SCHEMA_VERSION = 1;
export const OWNER_MARKER = '.agent-project-setup-owner.json';

function sortJsonValue(value) {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(
      Object.keys(value)
        .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
        .map((key) => [key, sortJsonValue(value[key])]),
    );
  }
  return value;
}

export function serializeJson(value) {
  return `${JSON.stringify(sortJsonValue(value), null, 2)}\n`;
}

export async function syncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, fsConstants.O_RDONLY);
    await handle.sync();
    return { directoryFsync: true };
  } catch (error) {
    if (['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM'].includes(error.code)) {
      return { directoryFsync: false, weakerCrashDurability: true };
    }
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function writeSyncedTemp(destination, value, uniqueId) {
  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${uniqueId}.tmp`,
  );
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(serializeJson(value), 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await syncDirectory(path.dirname(destination));
    return temporary;
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

export async function sameRegularEntry(entryPath, expectedIdentity) {
  try {
    const stat = await lstat(entryPath);
    return stat.isFile() && !stat.isSymbolicLink() && `${stat.dev}:${stat.ino}` === expectedIdentity;
  } catch {
    return false;
  }
}

export async function publishJsonNoReplace(
  destination,
  value,
  uniqueId,
  options = {},
) {
  const temporary = await writeSyncedTemp(destination, value, uniqueId);
  try {
    if (typeof options.beforePublish === 'function') await options.beforePublish();
    await link(temporary, destination);
    await syncDirectory(path.dirname(destination));
    const published = await lstat(destination);
    return { identity: `${published.dev}:${published.ino}` };
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

export async function replaceJsonCas(
  destination,
  value,
  uniqueId,
  expectedIdentity,
  options = {},
) {
  const temporary = await writeSyncedTemp(destination, value, uniqueId);
  const rollback = options.rollbackPath ?? path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${uniqueId}.rollback`,
  );
  let rollbackLinked = false;
  let destinationDetached = false;
  let publishedIdentity = null;
  try {
    if (!(await sameRegularEntry(destination, expectedIdentity))) {
      const error = new Error(`JSON destination identity changed before replace: ${destination}`);
      error.code = 'ESTALE';
      throw error;
    }
    await link(destination, rollback);
    rollbackLinked = true;
    if (!(await sameRegularEntry(destination, expectedIdentity))) {
      const error = new Error(`JSON destination identity changed during replace: ${destination}`);
      error.code = 'ESTALE';
      throw error;
    }
    if (typeof options.beforeDetach === 'function') await options.beforeDetach();
    if (!(await sameRegularEntry(destination, expectedIdentity))) {
      const error = new Error(`JSON destination identity changed before detach: ${destination}`);
      error.code = 'ESTALE';
      throw error;
    }
    await unlink(destination);
    destinationDetached = true;
    if (typeof options.afterDetach === 'function') await options.afterDetach();
    try {
      await link(temporary, destination);
    } catch (error) {
      if ((await lstat(destination).catch(() => null)) == null) {
        await link(rollback, destination).catch(() => {});
        destinationDetached = false;
      }
      throw error;
    }
    const published = await lstat(destination);
    publishedIdentity = `${published.dev}:${published.ino}`;
    destinationDetached = false;
    await syncDirectory(path.dirname(destination));
    if (options.keepRollback !== true) {
      await unlink(rollback);
      rollbackLinked = false;
      await syncDirectory(path.dirname(destination));
    }
    const rollbackIdentity = rollbackLinked
      ? `${(await lstat(rollback)).dev}:${(await lstat(rollback)).ino}`
      : null;
    return {
      identity: publishedIdentity,
      rollbackPath: rollbackLinked ? rollback : null,
      rollbackIdentity,
    };
  } finally {
    await unlink(temporary).catch(() => {});
    if (
      rollbackLinked &&
      options.keepRollback !== true &&
      !destinationDetached &&
      (publishedIdentity || (await sameRegularEntry(destination, expectedIdentity)))
    ) {
      await unlink(rollback).catch(() => {});
    }
  }
}

function requireString(value, field, manifestPath) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new InstallationError(
      'CORRUPT_MANIFEST',
      `Manifest field ${field} must be a non-empty string: ${manifestPath}`,
      {
        path: manifestPath,
        remediation: 'Preserve the installation and repair or remove the corrupt manifest manually.',
      },
    );
  }
}

export function validateManifest(manifest, expected, manifestPath) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new InstallationError(
      'CORRUPT_MANIFEST',
      `Installation manifest is not a JSON object: ${manifestPath}`,
      { path: manifestPath, remediation: 'Inspect install.json and restore a valid manifest.' },
    );
  }
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new InstallationError(
      manifest.schemaVersion == null ? 'CORRUPT_MANIFEST' : 'UNSUPPORTED_MANIFEST',
      `Unsupported installation manifest schema at ${manifestPath}: ${String(manifest.schemaVersion)}`,
      { path: manifestPath, remediation: 'Run a compatible CLI or remove the installation manually after review.' },
    );
  }
  if (manifest.package !== expected.packageName) {
    throw new InstallationError(
      'CORRUPT_MANIFEST',
      `Manifest package does not match ${expected.packageName}: ${manifestPath}`,
      { path: manifestPath, remediation: 'Do not let this package manage the foreign installation.' },
    );
  }
  if (manifest.installRoot !== expected.paths.installRoot) {
    throw new InstallationError(
      'CORRUPT_MANIFEST',
      `Manifest installRoot does not match this home: ${manifestPath}`,
      { path: manifestPath, remediation: 'Use the HOME that owns this installation or inspect it manually.' },
    );
  }
  requireString(manifest.version, 'version', manifestPath);
  requireString(manifest.installId, 'installId', manifestPath);
  requireString(manifest.installedAt, 'installedAt', manifestPath);
  requireString(manifest.updatedAt, 'updatedAt', manifestPath);
  if (
    !manifest.canonical ||
    manifest.canonical.root !== expected.paths.canonicalRoot ||
    manifest.canonical.skillPath !== expected.paths.canonicalSkill ||
    typeof manifest.canonical.digest !== 'string'
  ) {
    throw new InstallationError(
      'CORRUPT_MANIFEST',
      `Manifest canonical paths or digest are invalid: ${manifestPath}`,
      { path: manifestPath, remediation: 'Inspect the installation before retrying.' },
    );
  }
  if (!manifest.targets || typeof manifest.targets !== 'object') {
    throw new InstallationError(
      'CORRUPT_MANIFEST',
      `Manifest target records are missing: ${manifestPath}`,
      { path: manifestPath, remediation: 'Inspect the installation before retrying.' },
    );
  }
  for (const name of ['codex', 'claude']) {
    const target = manifest.targets[name];
    if (!target || target.path !== expected.paths.targets[name]) {
      throw new InstallationError(
        'CORRUPT_MANIFEST',
        `Manifest ${name} target path is invalid: ${manifestPath}`,
        { path: manifestPath, remediation: 'Inspect the installation before retrying.' },
      );
    }
    if (!['symlink', 'copy'].includes(target.mode)) {
      throw new InstallationError(
        'CORRUPT_MANIFEST',
        `Manifest ${name} target mode is invalid: ${manifestPath}`,
        { path: manifestPath, remediation: 'Inspect the installation before retrying.' },
      );
    }
    requireString(target.source, `targets.${name}.source`, manifestPath);
    requireString(target.targetId, `targets.${name}.targetId`, manifestPath);
    if (target.source !== expected.paths.canonicalSkill) {
      throw new InstallationError(
        'CORRUPT_MANIFEST',
        `Manifest ${name} source is not the canonical skill: ${manifestPath}`,
        { path: manifestPath, remediation: 'Inspect the installation before retrying.' },
      );
    }
    if (target.mode === 'symlink') {
      requireString(target.entryIdentity, `targets.${name}.entryIdentity`, manifestPath);
      if (target.linkText !== undefined) {
        requireString(target.linkText, `targets.${name}.linkText`, manifestPath);
      }
      if (target.digest !== null) {
        throw new InstallationError(
          'CORRUPT_MANIFEST',
          `Manifest ${name} symlink digest must be null: ${manifestPath}`,
          { path: manifestPath, remediation: 'Inspect the installation before retrying.' },
        );
      }
    } else if (target.entryIdentity !== null || typeof target.digest !== 'string') {
      throw new InstallationError(
        'CORRUPT_MANIFEST',
        `Manifest ${name} managed-copy evidence is invalid: ${manifestPath}`,
        { path: manifestPath, remediation: 'Inspect the installation before retrying.' },
      );
    }
  }
  return manifest;
}

export async function removeRegularIfIdentity(entryPath, expectedIdentity) {
  if (!(await sameRegularEntry(entryPath, expectedIdentity))) return false;
  await unlink(entryPath);
  await syncDirectory(path.dirname(entryPath));
  return true;
}

export async function restoreJsonRollback(
  destination,
  newIdentity,
  rollbackPath,
  rollbackIdentity,
) {
  if (!(await sameRegularEntry(rollbackPath, rollbackIdentity))) return false;
  const destinationState = await lstat(destination).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (destinationState) {
    const destinationIdentity = `${destinationState.dev}:${destinationState.ino}`;
    if (
      !destinationState.isFile() ||
      destinationState.isSymbolicLink() ||
      destinationIdentity !== newIdentity
    ) {
      return false;
    }
    await unlink(destination);
  }
  try {
    await link(rollbackPath, destination);
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
  await syncDirectory(path.dirname(destination));
  await removeRegularIfIdentity(rollbackPath, rollbackIdentity);
  return true;
}

export async function readManifest(manifestPath, expected) {
  let raw;
  try {
    raw = await readRegularFileNoFollow(manifestPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new InstallationError(
      'CORRUPT_MANIFEST',
      `Installation manifest cannot be read: ${manifestPath}`,
      { path: manifestPath, cause: error, remediation: 'Check permissions and inspect install.json.' },
    );
  }
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (error) {
    throw new InstallationError(
      'CORRUPT_MANIFEST',
      `Installation manifest contains invalid JSON: ${manifestPath}`,
      { path: manifestPath, cause: error, remediation: 'Preserve the installation and repair install.json manually.' },
    );
  }
  return validateManifest(manifest, expected, manifestPath);
}
