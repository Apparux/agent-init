import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { digestTree } from './filesystem.js';
import { InstallationError } from './paths.js';

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function parseFrontmatter(content, skillPath) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!match) {
    throw new InstallationError(
      'INVALID_PACKAGE_PAYLOAD',
      `Mother Skill frontmatter is missing: ${skillPath}`,
      { path: skillPath, remediation: 'Use an intact published package and retry.' },
    );
  }
  const metadata = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    metadata[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  if (metadata.name !== 'project-setup' || !metadata.description) {
    throw new InstallationError(
      'INVALID_PACKAGE_PAYLOAD',
      `Mother Skill metadata is invalid: ${skillPath}`,
      {
        path: skillPath,
        remediation: 'Use a package whose project-setup/SKILL.md has matching name and description.',
      },
    );
  }
  return metadata;
}

async function validateRegularTree(root) {
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new InstallationError(
      'INVALID_PACKAGE_PAYLOAD',
      `Mother Skill payload is not a regular directory: ${root}`,
      { path: root, remediation: 'Use an intact published package and retry.' },
    );
  }
  async function visit(directory) {
    const names = await readdir(directory);
    for (const name of names) {
      const entryPath = path.join(directory, name);
      const stat = await lstat(entryPath);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
        throw new InstallationError(
          'INVALID_PACKAGE_PAYLOAD',
          `Unsupported entry in mother Skill payload: ${entryPath}`,
          { path: entryPath, remediation: 'Remove links or special files from the published payload.' },
        );
      }
      if (stat.isDirectory()) await visit(entryPath);
    }
  }
  await visit(root);
}

export async function validatePackagePayload(runtime) {
  if (typeof runtime.packageRoot !== 'string' || !path.isAbsolute(runtime.packageRoot)) {
    throw new InstallationError(
      'INVALID_PACKAGE_PAYLOAD',
      `Package root must be an absolute path: ${String(runtime.packageRoot)}`,
      { path: runtime.packageRoot, remediation: 'Run the CLI from an intact npm package.' },
    );
  }
  const metadataPath = path.join(runtime.packageRoot, 'package.json');
  let metadata;
  try {
    metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
  } catch (error) {
    throw new InstallationError(
      'INVALID_PACKAGE_PAYLOAD',
      `Package metadata cannot be read: ${metadataPath}`,
      { path: metadataPath, cause: error, remediation: 'Use an intact published package and retry.' },
    );
  }
  if (
    metadata.name !== runtime.packageName ||
    metadata.version !== runtime.packageVersion ||
    !VERSION_PATTERN.test(metadata.version)
  ) {
    throw new InstallationError(
      'INVALID_PACKAGE_PAYLOAD',
      `Package metadata does not match the running package: ${metadataPath}`,
      { path: metadataPath, remediation: 'Use a complete, consistently versioned npm package.' },
    );
  }

  const skillPath = path.join(runtime.packageRoot, 'skills', 'project-setup');
  const skillFile = path.join(skillPath, 'SKILL.md');
  try {
    await validateRegularTree(skillPath);
    parseFrontmatter(await readFile(skillFile, 'utf8'), skillFile);
    return {
      packageName: metadata.name,
      version: metadata.version,
      sourceSkill: skillPath,
      digest: await digestTree(skillPath),
    };
  } catch (error) {
    if (error instanceof InstallationError) throw error;
    throw new InstallationError(
      'INVALID_PACKAGE_PAYLOAD',
      `Mother Skill payload cannot be validated: ${skillPath}`,
      { path: skillPath, cause: error, remediation: 'Use an intact published package and retry.' },
    );
  }
}

export function compareVersions(left, right) {
  const leftMatch = VERSION_PATTERN.exec(left);
  const rightMatch = VERSION_PATTERN.exec(right);
  if (!leftMatch || !rightMatch) {
    throw new InstallationError(
      'CORRUPT_MANIFEST',
      `Versions cannot be compared: running=${left}, installed=${right}`,
      { remediation: 'Use valid semantic package versions and inspect install.json.' },
    );
  }
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(leftMatch[index]) - Number(rightMatch[index]);
    if (difference !== 0) return Math.sign(difference);
  }
  const leftPre = leftMatch[4];
  const rightPre = rightMatch[4];
  if (leftPre === rightPre) return 0;
  if (leftPre == null) return 1;
  if (rightPre == null) return -1;
  const leftParts = leftPre.split('.');
  const rightParts = rightPre.split('.');
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    if (leftParts[index] == null) return -1;
    if (rightParts[index] == null) return 1;
    if (leftParts[index] === rightParts[index]) continue;
    const leftNumeric = /^\d+$/.test(leftParts[index]);
    const rightNumeric = /^\d+$/.test(rightParts[index]);
    if (leftNumeric && rightNumeric) return Math.sign(Number(leftParts[index]) - Number(rightParts[index]));
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftParts[index] < rightParts[index] ? -1 : 1;
  }
  return 0;
}
