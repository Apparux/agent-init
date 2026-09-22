#!/usr/bin/env node
// Generates and verifies the checked-in release manifest that pins the
// release artifact shape: entryCount, tree digest, and per-file modes.
//
//   node scripts/release-manifest.js           regenerate release-manifest.json
//   node scripts/release-manifest.js --check   verify repo state matches the manifest (CI)
//
// The digest algorithm mirrors the one in .github/workflows/release.yml so a
// locally regenerated manifest matches what the publish workflow computes.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const manifestPath = path.join(packageRoot, 'release-manifest.json');
const checkOnly = process.argv.includes('--check');

function addField(hash, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  hash.update(String(bytes.length));
  hash.update(':');
  hash.update(bytes);
  hash.update(';');
}

async function digestUnpackedTree(root) {
  const entries = [];
  async function visit(directory, relativeDirectory = '') {
    const names = await readdir(directory);
    names.sort((left, right) => left.localeCompare(right, 'en'));
    for (const name of names) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      const absolutePath = path.join(directory, name);
      const stat = await lstat(absolutePath);
      if (stat.isSymbolicLink()) {
        throw new Error(`Unsupported symlink in release artifact: ${relativePath}`);
      }
      if (stat.isDirectory()) {
        entries.push({ relativePath, type: 'directory' });
        await visit(absolutePath, relativeDirectory ? `${relativeDirectory}/${name}` : name);
      } else if (stat.isFile()) {
        entries.push({
          relativePath,
          type: 'file',
          executable: (stat.mode & 0o111) !== 0,
          content: await readFile(absolutePath),
        });
      } else {
        throw new Error(`Unsupported entry type in release artifact: ${relativePath}`);
      }
    }
  }
  await visit(root);
  entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'en'));
  const hash = createHash('sha256');
  addField(hash, 'agent-init-tree-v1');
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

async function main() {
  const pack = spawnSync('npm', ['pack', '--ignore-scripts', '--json'], {
    cwd: packageRoot,
    encoding: 'utf8',
  });
  if (pack.error || pack.status !== 0) {
    process.stderr.write(pack.stderr ?? String(pack.error));
    throw new Error(`npm pack failed: ${pack.error?.message ?? pack.status}`);
  }
  const [artifact] = JSON.parse(pack.stdout);
  const workRoot = path.join(packageRoot, '.release-manifest-work');
  await rm(workRoot, { recursive: true, force: true });
  await mkdir(path.join(workRoot, 'package'), { recursive: true });
  const unpackRoot = path.join(workRoot, 'package');
  const tar = spawnSync('tar', ['-xzf', artifact.filename, '-C', '.release-manifest-work'], {
    cwd: packageRoot,
    encoding: 'utf8',
  });
  if (tar.error || tar.status !== 0) {
    process.stderr.write(tar.stderr ?? String(tar.error));
    throw new Error(`tar extract failed: ${tar.error?.message ?? tar.status}`);
  }

  try {
    const treeDigest = await digestUnpackedTree(unpackRoot);
    const generated = {
      schemaVersion: 1,
      name: artifact.name,
      filename: artifact.filename,
      entryCount: artifact.files.length,
      treeDigest,
      files: artifact.files
        .map(({ path: filePath, mode }) => [filePath, mode])
        .sort(([left], [right]) => left.localeCompare(right, 'en')),
    };

    if (checkOnly) {
      const pinned = JSON.parse(await readFile(manifestPath, 'utf8'));
      for (const field of ['entryCount', 'treeDigest', 'files']) {
        if (JSON.stringify(pinned[field]) !== JSON.stringify(generated[field])) {
          throw new Error(
            `Release manifest mismatch for ${field}.\nExpected: ${JSON.stringify(pinned[field])}\nReceived: ${JSON.stringify(generated[field])}\nRegenerate with: node scripts/release-manifest.js`,
          );
        }
      }
      console.log(`Release manifest verified: ${generated.entryCount} entries, ${generated.treeDigest}`);
      return;
    }
    await writeFile(manifestPath, `${JSON.stringify(generated, null, 2)}\n`);
    console.log(`Release manifest regenerated: ${generated.entryCount} entries, ${generated.treeDigest}`);
  } finally {
    await rm(workRoot, { recursive: true, force: true });
    await rm(path.join(packageRoot, artifact.filename), { force: true });
  }
}

main().then(
  () => {},
  (error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  },
);
