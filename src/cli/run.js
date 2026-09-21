import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { executeLifecycle } from '../installation/lifecycle.js';
import { renderFailure, renderSuccess } from './output.js';

const PACKAGE_JSON_URL = new URL('../../package.json', import.meta.url);
const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url));

const USAGE = `Usage: agent-init <command>

Commands:
  install | update | doctor | uninstall

Options:
  --help
  --version
`;

async function readPackageMetadata(packageJsonUrl = PACKAGE_JSON_URL) {
  return JSON.parse(await readFile(packageJsonUrl, 'utf8'));
}

export async function runCli(argv, runtimeOverrides = {}) {
  const stdout = runtimeOverrides.stdout ?? process.stdout;
  const stderr = runtimeOverrides.stderr ?? process.stderr;

  if (argv.length === 1 && argv[0] === '--help') {
    stdout.write(USAGE);
    return 0;
  }

  let metadata;
  try {
    metadata = await readPackageMetadata(runtimeOverrides.packageJsonUrl);
  } catch (error) {
    stderr.write(
      `Agent Init\n\nError [INVALID_PACKAGE_PAYLOAD]: Package metadata cannot be read.\nPath: ${fileURLToPath(runtimeOverrides.packageJsonUrl ?? PACKAGE_JSON_URL)}\nWhy stopped: the running package identity cannot be validated.\nChanged: none reported\nNext: Use an intact published package and retry.\n`,
    );
    return 1;
  }

  if (argv.length === 1 && argv[0] === '--version') {
    stdout.write(`agent-init ${metadata.version}\n`);
    return 0;
  }

  const commands = new Set(['install', 'update', 'doctor', 'uninstall']);
  if (argv.length !== 1 || !commands.has(argv[0])) {
    stderr.write(USAGE);
    return 2;
  }

  const runtime = {
    homeDir: homedir(),
    platform: process.platform,
    packageRoot: PACKAGE_ROOT,
    packageName: metadata.name,
    packageVersion: metadata.version,
    now: () => new Date(),
    randomBytes,
    ...runtimeOverrides,
    stdout,
    stderr,
  };
  const result = await executeLifecycle({ operation: argv[0] }, runtime);
  if (result.ok) {
    stdout.write(renderSuccess(result, runtime));
    return 0;
  }
  stderr.write(renderFailure(result, runtime));
  return 1;
}
