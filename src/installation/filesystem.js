import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  symlink,
} from 'node:fs/promises';
import path from 'node:path';

export async function readRegularFileNoFollow(filePath, encoding = null) {
  const before = await lstat(filePath);
  if (!before.isFile() || before.isSymbolicLink()) {
    const error = new Error(`Expected a regular no-follow file: ${filePath}`);
    error.code = 'EINVAL';
    throw error;
  }
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  let handle;
  try {
    handle = await open(filePath, fsConstants.O_RDONLY | noFollow);
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    ) {
      const error = new Error(`File identity changed before no-follow read: ${filePath}`);
      error.code = 'ESTALE';
      throw error;
    }
    return await handle.readFile(encoding == null ? undefined : { encoding });
  } finally {
    await handle?.close().catch(() => {});
  }
}

function addField(hash, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  hash.update(String(bytes.length));
  hash.update(':');
  hash.update(bytes);
  hash.update(';');
}

export async function digestTree(root, options = {}) {
  const excluded = new Set(options.exclude ?? []);
  const entries = [];

  async function visit(directory, relativeDirectory = '') {
    const names = await readdir(directory);
    names.sort((left, right) => left.localeCompare(right, 'en'));

    for (const name of names) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${name}`
        : name;
      if (excluded.has(relativePath)) continue;

      const absolutePath = path.join(directory, name);
      const stat = await lstat(absolutePath);
      if (stat.isSymbolicLink()) {
        throw new Error(`Unsupported symlink in managed payload: ${absolutePath}`);
      }
      if (stat.isDirectory()) {
        entries.push({ relativePath, type: 'directory' });
        await visit(absolutePath, relativePath);
        continue;
      }
      if (stat.isFile()) {
        entries.push({
          relativePath,
          type: 'file',
          executable: (stat.mode & 0o111) !== 0,
          content: await readFile(absolutePath),
        });
        continue;
      }
      throw new Error(`Unsupported entry type in managed payload: ${absolutePath}`);
    }
  }

  await visit(root);
  entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'en'));

  const hash = createHash('sha256');
  addField(hash, 'agent-project-setup-tree-v1');
  for (const entry of entries) {
    addField(hash, entry.type);
    addField(hash, entry.relativePath);
    if (entry.type === 'file') {
      addField(hash, entry.executable ? 'executable' : 'regular');
      addField(hash, entry.content);
    }
  }
  return `sha256:${hash.digest('hex')}`;
}

export async function copyTree(source, destination) {
  const sourceStat = await lstat(source);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error(`Managed payload source must be a regular directory: ${source}`);
  }
  await mkdir(destination, { recursive: false });
  const names = await readdir(source);
  names.sort((left, right) => left.localeCompare(right, 'en'));
  for (const name of names) {
    const sourcePath = path.join(source, name);
    const destinationPath = path.join(destination, name);
    const stat = await lstat(sourcePath);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      await copyTree(sourcePath, destinationPath);
    } else if (stat.isFile()) {
      await copyFile(sourcePath, destinationPath);
      await chmod(destinationPath, stat.mode & 0o777);
    } else {
      throw new Error(`Unsupported entry type in managed payload: ${sourcePath}`);
    }
  }
}

export async function entryFingerprint(entryPath) {
  try {
    const stat = await lstat(entryPath);
    const identity = `${stat.dev}:${stat.ino}`;
    if (stat.isSymbolicLink()) {
      return { type: 'symlink', identity, linkText: await readlink(entryPath) };
    }
    if (stat.isDirectory()) return { type: 'directory', identity };
    if (stat.isFile()) return { type: 'file', identity };
    return { type: 'other', identity };
  } catch (error) {
    if (error.code === 'ENOENT') return { type: 'missing' };
    throw error;
  }
}

export async function createRelativeDirectoryLink(source, target) {
  const linkText = path.relative(path.dirname(target), source) || '.';
  await symlink(linkText, target, process.platform === 'win32' ? 'junction' : 'dir');
  const fingerprint = await entryFingerprint(target);
  if (fingerprint.type !== 'symlink') {
    throw new Error(`Created link cannot be identified without following it: ${target}`);
  }
  return { linkText, entryIdentity: fingerprint.identity };
}
