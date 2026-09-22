import { mkdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  copyTree,
  digestTree,
  entryFingerprint,
  readRegularFileNoFollow,
} from './filesystem.js';
import { OWNER_MARKER, serializeJson } from './manifest.js';
import {
  ensureSafeDirectoryChain,
  InstallationError,
  validateManagedAncestors,
} from './paths.js';
import { recordCompletion, recordIntent } from './transaction.js';

const SYMLINK_CAPABILITY_ERRORS = new Set([
  'ENOSYS',
  'ENOTSUP',
  'EOPNOTSUPP',
  'UNKNOWN',
]);

function resolveLinkDestination(targetPath, linkText) {
  return path.resolve(path.dirname(targetPath), linkText);
}

function stripWindowsNamespace(entryPath) {
  if (entryPath.startsWith('\\\\?\\UNC\\')) {
    return `\\\\${entryPath.slice('\\\\?\\UNC\\'.length)}`;
  }
  if (entryPath.startsWith('\\\\?\\')) return entryPath.slice('\\\\?\\'.length);
  return entryPath;
}

function linkDestinationMatchesCanonical(paths, targetPath, linkText) {
  const destination = resolveLinkDestination(targetPath, linkText);
  const canonical = path.resolve(paths.canonicalSkill);
  if (process.platform !== 'win32') return destination === canonical;
  return stripWindowsNamespace(path.win32.normalize(destination)).toLowerCase() ===
    stripWindowsNamespace(path.win32.normalize(canonical)).toLowerCase();
}

async function physicalPathOrMissing(entryPath) {
  try {
    return await realpath(entryPath);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function linkResolvesToCanonical(paths, targetPath, linkText) {
  if (
    typeof linkText !== 'string' ||
    linkText.length === 0 ||
    !linkDestinationMatchesCanonical(paths, targetPath, linkText)
  ) {
    return false;
  }

  const [targetPhysical, canonicalPhysical] = await Promise.all([
    physicalPathOrMissing(targetPath),
    physicalPathOrMissing(paths.canonicalSkill),
  ]);
  if (targetPhysical !== null || canonicalPhysical !== null) {
    return targetPhysical !== null &&
      canonicalPhysical !== null &&
      targetPhysical === canonicalPhysical;
  }

  return true;
}

function markerPath(targetPath) {
  return path.join(targetPath, OWNER_MARKER);
}

async function readMarker(targetPath) {
  try {
    const marker = JSON.parse(
      await readRegularFileNoFollow(markerPath(targetPath), 'utf8'),
    );
    if (marker?.schemaVersion !== 1) {
      throw new Error(`Unsupported ownership marker schema: ${markerPath(targetPath)}`);
    }
    return marker;
  } catch (error) {
    return { error };
  }
}

export async function inspectTarget(paths, name, manifestRecord, manifest) {
  // Unregistered manifest records (written under a since-removed harness
  // config) are inspected at their recorded path so they stay removable.
  const targetPath = paths.targets[name] ?? manifestRecord?.path;
  if (targetPath === undefined) {
    throw new InstallationError(
      'OWNERSHIP_MISMATCH',
      `No path is known for managed target: ${name}`,
      { remediation: 'Run doctor and inspect the installation manifest.' },
    );
  }
  const fingerprint = await entryFingerprint(targetPath);
  if (fingerprint.type === 'missing') {
    return {
      name,
      path: targetPath,
      status: manifestRecord ? 'owned-broken' : 'missing',
      fingerprint,
      removable: false,
      reason: manifestRecord ? 'Managed target is missing.' : 'Target does not exist.',
    };
  }
  if (!manifestRecord) {
    return {
      name,
      path: targetPath,
      status: 'foreign',
      fingerprint,
      removable: false,
      reason: 'Target exists without a manifest ownership record.',
    };
  }
  if (manifestRecord.path !== targetPath || manifestRecord.source !== paths.canonicalSkill) {
    return {
      name,
      path: targetPath,
      status: 'ambiguous',
      fingerprint,
      removable: false,
      reason: 'Manifest target path or source is outside the expected installation.',
    };
  }

  if (manifestRecord.mode === 'symlink') {
    if (fingerprint.type !== 'symlink') {
      return {
        name,
        path: targetPath,
        status: 'owned-drifted',
        fingerprint,
        removable: false,
        reason: 'Managed symlink was replaced by another entry type.',
      };
    }
    const destinationMatches = await linkResolvesToCanonical(
      paths,
      targetPath,
      fingerprint.linkText,
    );
    if (
      !destinationMatches ||
      fingerprint.identity !== manifestRecord.entryIdentity ||
      (manifestRecord.linkText != null &&
        fingerprint.linkText !== manifestRecord.linkText)
    ) {
      return {
        name,
        path: targetPath,
        status: 'owned-drifted',
        fingerprint,
        removable: false,
        reason: 'Managed symlink destination or identity changed.',
      };
    }
    let sourceExists = true;
    try {
      await realpath(targetPath);
    } catch (error) {
      if (error.code === 'ENOENT') sourceExists = false;
      else throw error;
    }
    return {
      name,
      path: targetPath,
      status: sourceExists ? 'owned-valid' : 'owned-broken',
      fingerprint,
      removable: true,
      reason: sourceExists ? 'Managed symlink is valid.' : 'Managed symlink is unchanged but its source is missing.',
    };
  }

  if (manifestRecord.mode !== 'copy' || fingerprint.type !== 'directory') {
    return {
      name,
      path: targetPath,
      status: 'owned-drifted',
      fingerprint,
      removable: false,
      reason: 'Managed copy was replaced by another entry type.',
    };
  }
  const marker = await readMarker(targetPath);
  if (
    marker.error ||
    marker.installId !== manifest.installId ||
    marker.targetId !== manifestRecord.targetId
  ) {
    return {
      name,
      path: targetPath,
      status: 'owned-drifted',
      fingerprint,
      removable: false,
      reason: 'Managed-copy ownership marker does not match the manifest.',
    };
  }
  let digest;
  try {
    digest = await digestTree(targetPath, { exclude: [OWNER_MARKER] });
  } catch (error) {
    return {
      name,
      path: targetPath,
      status: 'ambiguous',
      fingerprint,
      removable: false,
      reason: `Managed copy cannot be inspected safely: ${error.message}`,
    };
  }
  if (digest !== manifestRecord.digest) {
    return {
      name,
      path: targetPath,
      status: 'owned-drifted',
      fingerprint,
      removable: false,
      reason: 'Managed-copy payload digest changed.',
    };
  }
  return {
    name,
    path: targetPath,
    status: 'owned-valid',
    fingerprint,
    removable: true,
    reason: 'Managed copy is valid.',
  };
}

async function assertStillMissing(paths, targetPath) {
  await validateManagedAncestors(paths, path.dirname(targetPath));
  const state = await entryFingerprint(targetPath);
  if (state.type !== 'missing') {
    throw new InstallationError(
      'INSTALL_CONFLICT',
      `Target appeared before it could be created: ${targetPath}`,
      {
        path: targetPath,
        remediation: 'Preserve the new entry, inspect it, and retry only after resolving the conflict.',
      },
    );
  }
}

async function createSymlinkTarget(
  paths,
  name,
  targetId,
  operation,
  createDirectorySymlink,
  afterMutation,
  onPublished,
) {
  const targetPath = paths.targets[name];
  const linkText = path.relative(path.dirname(targetPath), paths.canonicalSkill) || '.';
  await recordIntent(operation, {
    action: 'create-target-link',
    name,
    path: targetPath,
    expected: 'missing',
    linkText,
    targetId,
  });
  try {
    await assertStillMissing(paths, targetPath);
    try {
      await createDirectorySymlink(
        linkText,
        targetPath,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch (error) {
      if (error.code === 'EPERM') return null;
      throw error;
    }
    let published;
    try {
      published = await entryFingerprint(targetPath);
    } catch (error) {
      throw new InstallationError(
        'ROLLBACK_FAILED',
        `Published discovery target could not be fingerprinted safely: ${targetPath}`,
        {
          path: targetPath,
          cause: error,
          unresolved: [targetPath],
          remediation: 'Preserve the target and inspect the retained lifecycle journal before retrying.',
        },
      );
    }
    if (published.type !== 'symlink' || !published.identity) {
      throw new InstallationError(
        'ROLLBACK_FAILED',
        `Published discovery target ownership cannot be proven: ${targetPath}`,
        {
          path: targetPath,
          unresolved: [targetPath],
          remediation: 'Preserve the target and inspect the retained lifecycle journal before retrying.',
        },
      );
    }
    const record = {
      path: targetPath,
      mode: 'symlink',
      source: paths.canonicalSkill,
      targetId,
      entryIdentity: published.identity,
      linkText: published.linkText,
      digest: null,
    };
    if (typeof onPublished === 'function') await onPublished(record);
    await recordCompletion(operation, {
      action: 'create-target-link',
      name,
      path: targetPath,
      entryIdentity: published.identity,
      linkText: published.linkText,
    });
    if (!(await linkResolvesToCanonical(paths, targetPath, published.linkText))) {
      throw new InstallationError(
        'OWNERSHIP_MISMATCH',
        `Published symlink does not resolve to the canonical skill: ${targetPath}`,
        { path: targetPath, remediation: 'Preserve the target and inspect it manually.' },
      );
    }
    return record;
  } catch (error) {
    if (error instanceof InstallationError) throw error;
    if (!SYMLINK_CAPABILITY_ERRORS.has(error.code)) throw error;
    return null;
  }
}

async function createCopyTarget(
  paths,
  name,
  targetId,
  installId,
  digest,
  sourceSkill,
  operation,
  afterMutation,
) {
  const targetPath = paths.targets[name];
  const staging = path.join(
    path.dirname(targetPath),
    `.agent-init-staging-${operation.operationId}-${name}`,
  );
  await recordIntent(operation, {
    action: 'create-target-copy',
    name,
    path: targetPath,
    staging,
    expected: 'missing',
    installId,
    targetId,
    digest,
  });
  try {
    await copyTree(sourceSkill, staging);
    await writeFile(
      markerPath(staging),
      serializeJson({ schemaVersion: 1, installId, targetId }),
      { flag: 'wx', mode: 0o600 },
    );
    if ((await digestTree(staging, { exclude: [OWNER_MARKER] })) !== digest) {
      throw new Error(`Staged managed-copy digest mismatch: ${staging}`);
    }
    if (typeof afterMutation === 'function') {
      await afterMutation(`install:${name}-copy-staged`);
    }
    await assertStillMissing(paths, targetPath);
    await rename(staging, targetPath);
    if (typeof afterMutation === 'function') {
      await afterMutation(`install:${name}-copy-promoted`);
    }
    const published = await entryFingerprint(targetPath);
    await recordCompletion(operation, {
      action: 'create-target-copy',
      name,
      path: targetPath,
      entryIdentity: published.identity,
    });
    return {
      path: targetPath,
      mode: 'copy',
      source: paths.canonicalSkill,
      targetId,
      entryIdentity: null,
      digest,
    };
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function removeOwnedTarget(spec) {
  const { paths, name, manifest, operation, afterMutation } = spec;
  const record = manifest.targets[name];
  const initial = await inspectTarget(paths, name, record, manifest);
  if (initial.status === 'missing') {
    return { action: 'absent', path: initial.path, status: initial.status };
  }
  if (!initial.removable || !['owned-valid', 'owned-broken'].includes(initial.status)) {
    return {
      action: 'preserved',
      path: initial.path,
      status: initial.status,
      reason: initial.reason,
    };
  }

  const quarantine = path.join(
    path.dirname(initial.path),
    `.agent-init-rollback-${operation.operationId}-${name}`,
  );
  await recordIntent(operation, {
    action: 'remove-target',
    name,
    path: initial.path,
    quarantine,
    expectedIdentity: initial.fingerprint.identity,
    expectedStatus: initial.status,
  });
  await validateManagedAncestors(paths, path.dirname(initial.path), { allowMissing: false });
  const current = await inspectTarget(paths, name, record, manifest);
  if (
    !current.removable ||
    current.fingerprint.identity !== initial.fingerprint.identity ||
    !['owned-valid', 'owned-broken'].includes(current.status)
  ) {
    return {
      action: 'preserved',
      path: initial.path,
      status: current.status,
      reason: 'Target changed before removal and was preserved.',
    };
  }
  if ((await entryFingerprint(quarantine)).type !== 'missing') {
    throw new InstallationError(
      'INSTALL_CONFLICT',
      `Target quarantine path already exists: ${quarantine}`,
      { path: quarantine, remediation: 'Preserve and inspect the unexpected sibling entry.' },
    );
  }

  await rename(initial.path, quarantine);
  if (typeof afterMutation === 'function') {
    await afterMutation(`uninstall:${name}-detached`);
  }
  let detachedValid = false;
  try {
    const detached = await entryFingerprint(quarantine);
    if (record.mode === 'symlink') {
      detachedValid =
        detached.type === 'symlink' &&
        detached.identity === initial.fingerprint.identity &&
        detached.linkText === initial.fingerprint.linkText &&
        (await linkResolvesToCanonical(paths, quarantine, detached.linkText));
    } else {
      const marker = await readMarker(quarantine);
      detachedValid =
        detached.type === 'directory' &&
        detached.identity === initial.fingerprint.identity &&
        !marker.error &&
        marker.installId === manifest.installId &&
        marker.targetId === record.targetId &&
        (await digestTree(quarantine, { exclude: [OWNER_MARKER] })) === record.digest;
    }
    if (!detachedValid) {
      if ((await entryFingerprint(initial.path)).type === 'missing') {
        await rename(quarantine, initial.path);
      }
      return {
        action: 'preserved',
        path: initial.path,
        status: 'ambiguous',
        reason: 'Detached target ownership could not be revalidated.',
      };
    }
    if (record.mode === 'symlink') await rm(quarantine, { force: true });
    else await rm(quarantine, { recursive: true });
    if (typeof afterMutation === 'function') {
      await afterMutation(`uninstall:${name}-quarantine-removed`);
    }
    await recordCompletion(operation, {
      action: 'remove-target',
      name,
      path: initial.path,
    });
    return { action: 'removed', path: initial.path, status: initial.status };
  } catch (error) {
    if (!detachedValid && (await entryFingerprint(initial.path)).type === 'missing') {
      await rename(quarantine, initial.path).catch(() => {});
    }
    throw error;
  }
}

export async function materializeTarget(spec) {
  const {
    paths,
    name,
    targetId,
    installId,
    digest,
    sourceSkill,
    operation,
    createDirectorySymlink = symlink,
    beforeMutation,
    afterMutation,
    onPublished,
  } = spec;
  await ensureSafeDirectoryChain(paths, paths.targetParents[name], { beforeMutation });
  await validateManagedAncestors(paths, paths.targetParents[name], { allowMissing: false });
  await assertStillMissing(paths, paths.targets[name]);

  let symlinkRecord;
  try {
    symlinkRecord = await createSymlinkTarget(
      paths,
      name,
      targetId,
      operation,
      createDirectorySymlink,
      afterMutation,
      onPublished,
    );
  } catch (error) {
    if (error.code === 'EACCES' || error.code === 'EROFS') {
      throw new InstallationError(
        'PERMISSION_DENIED',
        `Cannot create ${name} discovery target: ${paths.targets[name]}`,
        { path: paths.targets[name], cause: error, remediation: 'Grant write permission to the target parent.' },
      );
    }
    throw error;
  }
  if (symlinkRecord) return symlinkRecord;

  try {
    return await createCopyTarget(
      paths,
      name,
      targetId,
      installId,
      digest,
      sourceSkill,
      operation,
      afterMutation,
    );
  } catch (error) {
    throw new InstallationError(
      error.code === 'EACCES' || error.code === 'EROFS' ? 'PERMISSION_DENIED' : 'PARTIAL_INSTALLATION',
      `Cannot create managed-copy fallback for ${name}: ${paths.targets[name]}`,
      {
        path: paths.targets[name],
        cause: error,
        remediation: 'Check target-parent permissions and remove only operation-owned staging after inspection.',
      },
    );
  }
}
