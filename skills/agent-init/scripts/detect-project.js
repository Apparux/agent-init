#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

const SCHEMA_VERSION = 1;
const MAX_ENTRIES_PER_DIRECTORY = 64;
const MAX_JSON_BYTES = 1024 * 1024;
const WORKSPACE_CONTAINERS = ['apps', 'components', 'libs', 'modules', 'packages', 'services'];
const BUILD_FILES = [
  'Cargo.toml',
  'Makefile',
  'build.gradle',
  'build.gradle.kts',
  'go.mod',
  'package.json',
  'pom.xml',
  'pyproject.toml',
  'settings.gradle',
  'settings.gradle.kts',
];
const LOCK_FILES = [
  'Cargo.lock',
  'bun.lock',
  'bun.lockb',
  'go.sum',
  'package-lock.json',
  'pnpm-lock.yaml',
  'poetry.lock',
  'uv.lock',
  'yarn.lock',
];
const RUNTIME_INDICATORS = [
  '.java-version',
  '.node-version',
  '.nvmrc',
  '.python-version',
  '.ruby-version',
  'mise.toml',
  'rust-toolchain',
  'rust-toolchain.toml',
];
const ROOT_CI_FILES = [
  '.circleci/config.yml',
  '.gitlab-ci.yml',
  'Jenkinsfile',
  'azure-pipelines.yml',
];
const AGENT_CONFIG_PATHS = [
  '.agents',
  '.claude',
  '.claude/settings.json',
  '.claude/settings.local.json',
  '.cursor',
  '.github/copilot-instructions.md',
  'AGENTS.md',
  'AGENTS.override.md',
  'CLAUDE.local.md',
  'CLAUDE.md',
  'docs/agents',
];

function toRepositoryPath(value) {
  return value.split(path.sep).join('/');
}

function compareText(left, right) {
  return left.localeCompare(right, 'en');
}

function errorRecord(check, relativePath, error, code = error?.code ?? 'CHECK_FAILED') {
  return {
    check,
    path: toRepositoryPath(relativePath),
    code,
    message: error instanceof Error ? error.message : String(error),
  };
}

async function inspectEntry(root, relativePath, errors, check) {
  const segments = relativePath.split(/[\\/]/).filter((segment) => segment !== '.');
  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = await lstat(current);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        errors.push(errorRecord(check, relativePath, error));
      }
      return null;
    }
    const isFinal = index === segments.length - 1;
    if (!isFinal && stat.isSymbolicLink()) {
      errors.push(errorRecord(
        check,
        relativePath,
        `Ancestor symbolic link was not followed: ${segments.slice(0, index + 1).join('/')}`,
        'SYMLINK_ANCESTOR_SKIPPED',
      ));
      return null;
    }
    if (!isFinal && !stat.isDirectory()) return null;
    if (isFinal) return stat;
  }
  return lstat(root);
}

async function readJsonNoFollow(root, relativePath, expectedStat) {
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  let handle;
  try {
    handle = await open(path.join(root, relativePath), flags);
    const openedStat = await handle.stat();
    if (!openedStat.isFile()
      || openedStat.dev !== expectedStat.dev
      || openedStat.ino !== expectedStat.ino
      || openedStat.size !== expectedStat.size) {
      const error = new Error('File identity changed before read');
      error.code = 'IDENTITY_CHANGED';
      throw error;
    }
    return JSON.parse(await handle.readFile('utf8'));
  } finally {
    await handle?.close();
  }
}

async function collectExistingFiles(root, relativeDirectories, names, errors, check) {
  const found = [];
  for (const directory of relativeDirectories) {
    for (const name of names) {
      const relativePath = directory === '.' ? name : path.join(directory, name);
      const stat = await inspectEntry(root, relativePath, errors, check);
      if (!stat) continue;
      if (stat.isSymbolicLink()) {
        errors.push(errorRecord(check, relativePath, 'Symbolic link was not followed', 'SYMLINK_SKIPPED'));
      } else if (stat.isFile()) {
        found.push(toRepositoryPath(relativePath));
      }
    }
  }
  return found.sort(compareText);
}

async function collectWorkspaceDirectories(root, errors) {
  const directories = ['.'];

  for (const container of WORKSPACE_CONTAINERS) {
    const containerStat = await inspectEntry(root, container, errors, 'workspace-containers');
    if (!containerStat) continue;
    if (containerStat.isSymbolicLink()) {
      errors.push(errorRecord('workspace-containers', container, 'Symbolic link was not followed', 'SYMLINK_SKIPPED'));
      continue;
    }
    if (!containerStat.isDirectory()) continue;

    try {
      const names = (await readdir(path.join(root, container))).sort(compareText);
      if (names.length > MAX_ENTRIES_PER_DIRECTORY) {
        errors.push(errorRecord(
          'workspace-containers',
          container,
          `Inspected the first ${MAX_ENTRIES_PER_DIRECTORY} of ${names.length} entries`,
          'ENTRY_LIMIT',
        ));
      }

      for (const name of names.slice(0, MAX_ENTRIES_PER_DIRECTORY)) {
        const relativePath = path.join(container, name);
        const stat = await inspectEntry(root, relativePath, errors, 'workspace-containers');
        if (!stat) continue;
        if (stat.isSymbolicLink()) {
          errors.push(errorRecord('workspace-containers', relativePath, 'Symbolic link was not followed', 'SYMLINK_SKIPPED'));
        } else if (stat.isDirectory()) {
          directories.push(relativePath);
        }
      }
    } catch (error) {
      errors.push(errorRecord('workspace-containers', container, error));
    }
  }

  return directories.sort(compareText);
}

function sortedStringObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => typeof item === 'string')
      .sort(([left], [right]) => compareText(left, right)),
  );
}

async function collectPackageManifests(root, workspaceDirectories, errors) {
  const manifests = [];

  for (const directory of workspaceDirectories) {
    const relativePath = directory === '.' ? 'package.json' : path.join(directory, 'package.json');
    const stat = await inspectEntry(root, relativePath, errors, 'package-manifests');
    if (!stat) continue;
    if (stat.isSymbolicLink()) {
      errors.push(errorRecord('package-manifests', relativePath, 'Symbolic link was not followed', 'SYMLINK_SKIPPED'));
      continue;
    }
    if (!stat.isFile()) continue;
    if (stat.size > MAX_JSON_BYTES) {
      errors.push(errorRecord(
        'package-manifests',
        relativePath,
        `File exceeds the ${MAX_JSON_BYTES}-byte read limit`,
        'FILE_SIZE_LIMIT',
      ));
      continue;
    }

    try {
      const parsed = await readJsonNoFollow(root, relativePath, stat);
      const scripts = parsed?.scripts && typeof parsed.scripts === 'object' && !Array.isArray(parsed.scripts)
        ? Object.keys(parsed.scripts).sort(compareText)
        : [];
      manifests.push({
        path: toRepositoryPath(relativePath),
        packageManager: typeof parsed?.packageManager === 'string' ? parsed.packageManager : null,
        engines: sortedStringObject(parsed?.engines),
        scripts,
      });
    } catch (error) {
      const code = ['ELOOP', 'IDENTITY_CHANGED'].includes(error?.code)
        ? 'PACKAGE_MANIFEST_RACE'
        : 'INVALID_PACKAGE_JSON';
      errors.push(errorRecord('package-manifests', relativePath, error, code));
    }
  }

  return manifests.sort((left, right) => compareText(left.path, right.path));
}

async function collectCiPaths(root, errors) {
  const paths = await collectExistingFiles(root, ['.'], ROOT_CI_FILES, errors, 'ci');
  const workflowDirectory = '.github/workflows';
  const workflowStat = await inspectEntry(root, workflowDirectory, errors, 'ci');

  if (!workflowStat) return paths;
  if (workflowStat.isSymbolicLink()) {
    errors.push(errorRecord('ci', workflowDirectory, 'Symbolic link was not followed', 'SYMLINK_SKIPPED'));
    return paths;
  }
  if (!workflowStat.isDirectory()) return paths;

  try {
    const names = (await readdir(path.join(root, workflowDirectory))).sort(compareText);
    if (names.length > MAX_ENTRIES_PER_DIRECTORY) {
      errors.push(errorRecord(
        'ci',
        workflowDirectory,
        `Inspected the first ${MAX_ENTRIES_PER_DIRECTORY} of ${names.length} entries`,
        'ENTRY_LIMIT',
      ));
    }
    for (const name of names.slice(0, MAX_ENTRIES_PER_DIRECTORY)) {
      const relativePath = path.join(workflowDirectory, name);
      const stat = await inspectEntry(root, relativePath, errors, 'ci');
      if (!stat) continue;
      if (stat.isSymbolicLink()) {
        errors.push(errorRecord('ci', relativePath, 'Symbolic link was not followed', 'SYMLINK_SKIPPED'));
      } else if (stat.isFile() && /\.(?:yaml|yml)$/i.test(name)) {
        paths.push(toRepositoryPath(relativePath));
      }
    }
  } catch (error) {
    errors.push(errorRecord('ci', workflowDirectory, error));
  }

  return [...new Set(paths)].sort(compareText);
}

async function collectAgentConfigPaths(root, errors) {
  const paths = [];
  for (const relativePath of AGENT_CONFIG_PATHS) {
    const stat = await inspectEntry(root, relativePath, errors, 'agent-config');
    if (!stat) continue;
    paths.push(toRepositoryPath(relativePath));
    if (stat.isSymbolicLink()) {
      errors.push(errorRecord('agent-config', relativePath, 'Symbolic link recorded but not followed', 'SYMLINK_NOT_FOLLOWED'));
    }
  }
  return paths.sort(compareText);
}

async function collectSkillDirectories(root, errors) {
  const paths = [];
  for (const parent of ['.agents/skills', '.claude/skills']) {
    const parentStat = await inspectEntry(root, parent, errors, 'skill-directories');
    if (!parentStat) continue;
    if (parentStat.isSymbolicLink()) {
      errors.push(errorRecord('skill-directories', parent, 'Symbolic link was not followed', 'SYMLINK_SKIPPED'));
      continue;
    }
    if (!parentStat.isDirectory()) continue;

    try {
      const names = (await readdir(path.join(root, parent))).sort(compareText);
      if (names.length > MAX_ENTRIES_PER_DIRECTORY) {
        errors.push(errorRecord(
          'skill-directories',
          parent,
          `Inspected the first ${MAX_ENTRIES_PER_DIRECTORY} of ${names.length} entries`,
          'ENTRY_LIMIT',
        ));
      }
      for (const name of names.slice(0, MAX_ENTRIES_PER_DIRECTORY)) {
        const relativePath = path.join(parent, name);
        const stat = await inspectEntry(root, relativePath, errors, 'skill-directories');
        if (!stat) continue;
        if (stat.isDirectory() || stat.isSymbolicLink()) {
          paths.push(toRepositoryPath(relativePath));
          if (stat.isSymbolicLink()) {
            errors.push(errorRecord(
              'skill-directories',
              relativePath,
              'Symbolic link recorded but not followed',
              'SYMLINK_NOT_FOLLOWED',
            ));
          }
        }
      }
    } catch (error) {
      errors.push(errorRecord('skill-directories', parent, error));
    }
  }
  return paths.sort(compareText);
}

function collectGitFacts(root, errors) {
  const options = {
    cwd: root,
    encoding: 'utf8',
    timeout: 3_000,
    maxBuffer: 1024 * 1024,
  };
  const rootResult = spawnSync('git', ['rev-parse', '--show-toplevel'], options);

  if (rootResult.error?.code === 'ENOENT') {
    errors.push(errorRecord('git', '.', rootResult.error, 'GIT_UNAVAILABLE'));
    return { isRepository: false, root: null, status: null };
  }
  if (rootResult.status !== 0) {
    return { isRepository: false, root: null, status: null };
  }

  const gitRoot = rootResult.stdout.trim();
  const statusResult = spawnSync(
    'git',
    ['status', '--porcelain=v1', '-z', '--untracked-files=normal'],
    options,
  );
  if (statusResult.error || statusResult.status !== 0) {
    const detail = statusResult.error ?? new Error(statusResult.stderr.trim() || 'git status failed');
    errors.push(errorRecord('git-status', '.', detail));
    return { isRepository: true, root: gitRoot, status: null };
  }

  const summary = { staged: 0, unstaged: 0, untracked: 0 };
  for (const record of statusResult.stdout.split('\0').filter(Boolean)) {
    const x = record[0];
    const y = record[1];
    if (x === '?' && y === '?') {
      summary.untracked += 1;
      continue;
    }
    if (x && x !== ' ' && x !== '?') summary.staged += 1;
    if (y && y !== ' ' && y !== '?') summary.unstaged += 1;
  }
  return { isRepository: true, root: gitRoot, status: summary };
}

async function resolveRoot(input) {
  const requested = path.resolve(input);
  let stat;
  try {
    stat = await lstat(requested);
  } catch (error) {
    throw new Error(`Repository root is not readable: ${requested} (${error.message})`);
  }
  if (!stat.isDirectory() && !stat.isSymbolicLink()) {
    throw new Error(`Repository root is not a directory: ${requested}`);
  }

  let resolved;
  try {
    resolved = await realpath(requested);
    const resolvedStat = await lstat(resolved);
    if (!resolvedStat.isDirectory()) {
      throw new Error('resolved path is not a directory');
    }
  } catch (error) {
    throw new Error(`Repository root cannot be resolved: ${requested} (${error.message})`);
  }
  return resolved;
}

async function main() {
  const inputRoot = process.argv[2] ?? process.cwd();
  const root = await resolveRoot(inputRoot);
  const errors = [];
  const workspaceDirectories = await collectWorkspaceDirectories(root, errors);
  const buildFiles = await collectExistingFiles(root, workspaceDirectories, BUILD_FILES, errors, 'build-files');
  const lockFiles = await collectExistingFiles(root, workspaceDirectories, LOCK_FILES, errors, 'lock-files');
  const runtimeIndicators = await collectExistingFiles(root, ['.'], RUNTIME_INDICATORS, errors, 'runtime-indicators');
  const packageManifests = await collectPackageManifests(root, workspaceDirectories, errors);
  const ciPaths = await collectCiPaths(root, errors);
  const agentConfigPaths = await collectAgentConfigPaths(root, errors);
  const skillDirectories = await collectSkillDirectories(root, errors);
  const git = collectGitFacts(root, errors);
  const indicators = [...new Set([...buildFiles, ...lockFiles, ...runtimeIndicators])].sort(compareText);

  errors.sort((left, right) => (
    compareText(left.path, right.path)
    || compareText(left.check, right.check)
    || compareText(left.code, right.code)
  ));

  const result = {
    schemaVersion: SCHEMA_VERSION,
    root,
    git,
    buildFiles,
    lockFiles,
    runtimeIndicators,
    indicators,
    packageManifests,
    ciPaths,
    agentConfigPaths,
    skillDirectories,
    errors,
    limits: {
      maxDepth: 2,
      maxEntriesPerDirectory: MAX_ENTRIES_PER_DIRECTORY,
      maxJsonBytes: MAX_JSON_BYTES,
    },
  };

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`detect-project: ${error.message}\n`);
  process.exitCode = 1;
});
