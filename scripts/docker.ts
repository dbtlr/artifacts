import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, stat } from 'node:fs/promises';
import { isAbsolute, win32 } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

export type DockerConfig = {
  databaseMount: string;
  filesMount: string;
  port: number;
  publicBaseUrl: string;
};

export type DockerAction = 'build' | 'check' | 'logs' | 'start' | 'stop';
export type DockerRunResult = { errorCode?: string; exitCode: number; output: string };
export type DockerRun = (
  args: string[],
  options?: { allowFailure?: boolean; stream?: boolean },
) => Promise<DockerRunResult>;

type DockerActionOptions = {
  composeFileExists: boolean;
  env: NodeJS.ProcessEnv;
  run: DockerRun;
};

const CONTAINER_NAME = 'artifacts';
const PREVIOUS_CONTAINER_NAME = 'artifacts-previous';
const REPLACEMENT_CONTAINER_NAME = 'artifacts-replacement';
const IMAGE_NAME = 'artifacts:local';
const DEFAULT_PORT = 4242;

function resolveDockerPort(raw: string | undefined): number {
  if (raw === undefined) {
    return DEFAULT_PORT;
  }
  if (!/^\d+$/u.test(raw.trim())) {
    throw new Error(
      `ARTIFACTS_PORT must be an integer between 1 and 65535, got ${JSON.stringify(raw)}`,
    );
  }
  const port = Number(raw.trim());
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(
      `ARTIFACTS_PORT must be an integer between 1 and 65535, got ${JSON.stringify(raw)}`,
    );
  }
  return port;
}

function resolveMount(name: string, raw: string | undefined, fallback: string): string {
  if (raw === undefined) {
    return fallback;
  }
  if (raw.trim() === '') {
    throw new Error(`${name} must not be blank`);
  }
  if (raw.includes(',')) {
    throw new Error(`${name} must not contain a comma`);
  }
  if (!isAbsolute(raw) && !win32.isAbsolute(raw) && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/u.test(raw)) {
    throw new Error(`${name} must be a Docker volume name or an absolute host path`);
  }
  return raw;
}

export function resolveDockerConfig(env: NodeJS.ProcessEnv): DockerConfig {
  const port = resolveDockerPort(env.ARTIFACTS_PORT);
  const databaseMount = resolveMount(
    'ARTIFACTS_DATABASE_MOUNT',
    env.ARTIFACTS_DATABASE_MOUNT,
    'artifacts-database',
  );
  const filesMount = resolveMount(
    'ARTIFACTS_FILES_MOUNT',
    env.ARTIFACTS_FILES_MOUNT,
    'artifacts-files',
  );
  if (databaseMount === filesMount) {
    throw new Error(
      'ARTIFACTS_DATABASE_MOUNT and ARTIFACTS_FILES_MOUNT must use different sources',
    );
  }
  return {
    databaseMount,
    filesMount,
    port,
    publicBaseUrl: env.ARTIFACTS_PUBLIC_BASE_URL ?? `http://localhost:${String(port)}`,
  };
}

function mountArgument(source: string, target: string): string {
  const type = isAbsolute(source) || win32.isAbsolute(source) ? 'bind' : 'volume';
  return `type=${type},source=${source},target=${target}`;
}

export function buildBareRunArgs(config: DockerConfig): string[] {
  return [
    'run',
    '--detach',
    '--name',
    CONTAINER_NAME,
    '--init',
    '--restart',
    'unless-stopped',
    '--publish',
    `127.0.0.1:${String(config.port)}:${String(config.port)}`,
    '--env',
    'NODE_ENV=production',
    '--env',
    `ARTIFACTS_PORT=${String(config.port)}`,
    '--env',
    `ARTIFACTS_PUBLIC_BASE_URL=${config.publicBaseUrl}`,
    '--mount',
    mountArgument(config.filesMount, '/app/data/files'),
    '--mount',
    mountArgument(config.databaseMount, '/app/data/database'),
    IMAGE_NAME,
  ];
}

function buildBareCreateArgs(config: DockerConfig): string[] {
  const runArgs = buildBareRunArgs(config);
  return ['create', '--name', REPLACEMENT_CONTAINER_NAME, ...runArgs.slice(4)];
}

export async function validateBindMounts(config: DockerConfig): Promise<void> {
  const mounts = [
    ['ARTIFACTS_DATABASE_MOUNT', config.databaseMount],
    ['ARTIFACTS_FILES_MOUNT', config.filesMount],
  ] as const;

  await Promise.all(
    mounts.map(async ([name, source]) => {
      if (!isAbsolute(source) && !win32.isAbsolute(source)) {
        return;
      }
      let sourceStat;
      try {
        sourceStat = await stat(source);
      } catch (error) {
        if (isErrnoException(error) && error.code === 'ENOENT') {
          throw new Error(`${name} path does not exist: ${source}`, { cause: error });
        }
        throw new Error(
          `${name} path cannot be inspected: ${source}\n${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      if (!sourceStat.isDirectory()) {
        throw new Error(`${name} must be a directory: ${source}`);
      }
    }),
  );
}

async function validateBindMountWritability(config: DockerConfig, run: DockerRun): Promise<void> {
  const mounts = [
    ['ARTIFACTS_DATABASE_MOUNT', config.databaseMount],
    ['ARTIFACTS_FILES_MOUNT', config.filesMount],
  ] as const;

  await Promise.all(
    mounts.map(async ([name, source]) => {
      if (!isAbsolute(source) && !win32.isAbsolute(source)) {
        return;
      }
      const result = await run(
        [
          'run',
          '--rm',
          '--user',
          '1000:1000',
          '--entrypoint',
          'sh',
          '--mount',
          mountArgument(source, '/probe'),
          IMAGE_NAME,
          '-c',
          'probe=/probe/.artifacts-write-probe-$$; : > "$probe" && rm "$probe"',
        ],
        { allowFailure: true },
      );
      if (result.exitCode !== 0) {
        throw new Error(
          `${name} must be writable by the container's node user (uid 1000): ${source}\n${result.output}`.trim(),
        );
      }
    }),
  );
}

export function formatStartMessage(composeFileExists: boolean, env: NodeJS.ProcessEnv): string {
  if (composeFileExists) {
    return 'Artifacts is running through docker-compose.yaml.\n';
  }
  return `Artifacts is running at ${resolveDockerConfig(env).publicBaseUrl}\n`;
}

async function runRequired(
  run: DockerRun,
  args: string[],
  stream = false,
): Promise<DockerRunResult> {
  const result = await run(args, { stream });
  if (result.exitCode !== 0) {
    throw new Error(`Docker command failed: docker ${args.join(' ')}\n${result.output}`.trim());
  }
  return result;
}

async function containerState(
  run: DockerRun,
  name: string,
): Promise<{ exists: boolean; running: boolean }> {
  const result = await run(['container', 'inspect', '--format', '{{.State.Running}}', name], {
    allowFailure: true,
  });
  return {
    exists: result.exitCode === 0,
    running: result.exitCode === 0 && result.output.trim() === 'true',
  };
}

async function removeContainerIfExists(run: DockerRun, name: string): Promise<void> {
  const state = await containerState(run, name);
  if (!state.exists) {
    return;
  }
  if (state.running) {
    await runRequired(run, ['stop', name]);
  }
  await runRequired(run, ['container', 'rm', name]);
}

async function waitForHealthyContainer(
  run: DockerRun,
  name: string,
  attemptsRemaining = 30,
): Promise<void> {
  const result = await run(
    [
      'container',
      'inspect',
      '--format',
      '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}',
      name,
    ],
    { allowFailure: true },
  );
  if (result.exitCode !== 0) {
    throw new Error(`Container disappeared before it became healthy: ${name}`);
  }
  const [status, health] = result.output.trim().split(/\s+/u);
  if (status !== 'running') {
    throw new Error(`Container entered ${status ?? 'an unknown state'} before it became healthy.`);
  }
  if (health === 'healthy') {
    return;
  }
  if (health === 'unhealthy') {
    throw new Error('Container became unhealthy during startup.');
  }
  if (attemptsRemaining <= 1) {
    throw new Error('Container did not become healthy within 30 seconds.');
  }
  await delay(1000);
  await waitForHealthyContainer(run, name, attemptsRemaining - 1);
}

async function reconcileReplacementState(run: DockerRun): Promise<void> {
  const [canonical, previous, replacement] = await Promise.all([
    containerState(run, CONTAINER_NAME),
    containerState(run, PREVIOUS_CONTAINER_NAME),
    containerState(run, REPLACEMENT_CONTAINER_NAME),
  ]);

  if (!previous.exists) {
    if (replacement.exists) {
      await removeContainerIfExists(run, REPLACEMENT_CONTAINER_NAME);
    }
    return;
  }

  if (!canonical.exists) {
    if (replacement.exists) {
      await removeContainerIfExists(run, REPLACEMENT_CONTAINER_NAME);
    }
    await runRequired(run, ['rename', PREVIOUS_CONTAINER_NAME, CONTAINER_NAME]);
    if (!previous.running) {
      await runRequired(run, ['start', CONTAINER_NAME]);
    }
    await waitForHealthyContainer(run, CONTAINER_NAME);
    return;
  }

  try {
    await waitForHealthyContainer(run, CONTAINER_NAME);
  } catch {
    await removeContainerIfExists(run, CONTAINER_NAME);
    if (replacement.exists) {
      await removeContainerIfExists(run, REPLACEMENT_CONTAINER_NAME);
    }
    await runRequired(run, ['rename', PREVIOUS_CONTAINER_NAME, CONTAINER_NAME]);
    if (!previous.running) {
      await runRequired(run, ['start', CONTAINER_NAME]);
    }
    await waitForHealthyContainer(run, CONTAINER_NAME);
    return;
  }

  if (replacement.exists) {
    await removeContainerIfExists(run, REPLACEMENT_CONTAINER_NAME);
  }
  await removeContainerIfExists(run, PREVIOUS_CONTAINER_NAME);
}

async function replaceBareContainer(
  run: DockerRun,
  config: DockerConfig,
  existingWasRunning: boolean,
): Promise<void> {
  const previous = await containerState(run, PREVIOUS_CONTAINER_NAME);
  if (previous.exists) {
    throw new Error(
      `Cannot replace ${CONTAINER_NAME} while recovery container ${PREVIOUS_CONTAINER_NAME} exists. Inspect and recover or remove it first.`,
    );
  }
  await removeContainerIfExists(run, REPLACEMENT_CONTAINER_NAME);
  try {
    await runRequired(run, buildBareCreateArgs(config));
  } catch (error) {
    await removeContainerIfExists(run, REPLACEMENT_CONTAINER_NAME);
    throw error;
  }

  let oldStopped = false;
  let oldRenamed = false;
  let replacementPromoted = false;
  try {
    if (existingWasRunning) {
      await runRequired(run, ['stop', CONTAINER_NAME]);
      oldStopped = true;
    }
    await runRequired(run, ['rename', CONTAINER_NAME, PREVIOUS_CONTAINER_NAME]);
    oldRenamed = true;
    await runRequired(run, ['rename', REPLACEMENT_CONTAINER_NAME, CONTAINER_NAME]);
    replacementPromoted = true;
    await runRequired(run, ['start', CONTAINER_NAME]);
    await waitForHealthyContainer(run, CONTAINER_NAME);
    await runRequired(run, ['container', 'rm', PREVIOUS_CONTAINER_NAME]);
  } catch (error) {
    try {
      await removeContainerIfExists(
        run,
        replacementPromoted ? CONTAINER_NAME : REPLACEMENT_CONTAINER_NAME,
      );
      if (oldRenamed) {
        await runRequired(run, ['rename', PREVIOUS_CONTAINER_NAME, CONTAINER_NAME]);
      }
      if (existingWasRunning && (oldStopped || oldRenamed)) {
        await runRequired(run, ['start', CONTAINER_NAME]);
        await waitForHealthyContainer(run, CONTAINER_NAME);
      }
    } catch (rollbackError) {
      throw new Error(
        `Replacement failed (${error instanceof Error ? error.message : String(error)}) and automatic rollback also failed. Inspect ${CONTAINER_NAME}, ${PREVIOUS_CONTAINER_NAME}, and ${REPLACEMENT_CONTAINER_NAME} before retrying.`,
        { cause: rollbackError },
      );
    }
    throw new Error(
      `Replacement failed; the previous ${CONTAINER_NAME} container was restored.\n${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

async function startFreshBareContainer(run: DockerRun, config: DockerConfig): Promise<void> {
  let createdContainerId: string | undefined;
  try {
    const result = await runRequired(run, buildBareRunArgs(config));
    createdContainerId = result.output.trim();
    await waitForHealthyContainer(run, CONTAINER_NAME);
  } catch (error) {
    try {
      if (createdContainerId !== undefined) {
        await removeContainerIfExists(run, createdContainerId);
      }
    } catch (cleanupError) {
      throw new Error(
        `Fresh start failed (${error instanceof Error ? error.message : String(error)}) and the failed ${CONTAINER_NAME} container could not be removed. Inspect it before retrying.`,
        { cause: cleanupError },
      );
    }
    throw error;
  }
}

async function preflight(run: DockerRun, needsCompose: boolean): Promise<void> {
  const cli = await run(['--version'], { allowFailure: true });
  if (cli.errorCode === 'ENOENT') {
    throw new Error('Docker CLI not found. Install Docker Desktop or Docker Engine and retry.');
  }
  if (cli.exitCode !== 0) {
    throw new Error('Docker CLI is unavailable. Install or repair Docker, then retry.');
  }
  const daemon = await run(['info'], { allowFailure: true });
  if (daemon.exitCode !== 0) {
    throw new Error(
      'Docker daemon is unavailable. Start Docker Desktop or the Docker service and retry.',
    );
  }
  if (needsCompose) {
    const compose = await run(['compose', 'version'], { allowFailure: true });
    if (compose.exitCode !== 0) {
      throw new Error(
        'Docker Compose v2 is unavailable. Install the Docker Compose plugin and retry.',
      );
    }
  }
}

export async function executeDockerAction(
  action: DockerAction,
  { composeFileExists, env, run }: DockerActionOptions,
): Promise<void> {
  await preflight(run, composeFileExists);
  if (action === 'check') {
    return;
  }
  if (composeFileExists) {
    const actionArgs: Record<Exclude<DockerAction, 'check'>, string[]> = {
      build: ['build'],
      logs: ['logs', '--follow'],
      start: ['up', '--detach', '--build'],
      stop: ['down'],
    };
    await runRequired(
      run,
      ['compose', '--file', 'docker-compose.yaml', ...actionArgs[action]],
      action === 'logs',
    );
    return;
  }

  const config = resolveDockerConfig(env);
  if (action === 'build') {
    await runRequired(run, ['build', '--tag', IMAGE_NAME, '.']);
    return;
  }
  if (action === 'start') {
    await validateBindMounts(config);
    await runRequired(run, ['build', '--tag', IMAGE_NAME, '.']);
    await validateBindMountWritability(config, run);
    await reconcileReplacementState(run);
    const existing = await containerState(run, CONTAINER_NAME);
    if (existing.exists) {
      await replaceBareContainer(run, config, existing.running);
    } else {
      await startFreshBareContainer(run, config);
    }
    return;
  }
  if (action === 'stop') {
    const existing = await run(
      ['container', 'inspect', '--format', '{{.State.Running}}', CONTAINER_NAME],
      { allowFailure: true },
    );
    if (existing.exitCode === 0 && existing.output.trim() === 'true') {
      await runRequired(run, ['stop', CONTAINER_NAME]);
    }
    return;
  }
  if (action === 'logs') {
    const existing = await run(['container', 'inspect', CONTAINER_NAME], { allowFailure: true });
    if (existing.exitCode === 0) {
      await runRequired(run, ['logs', '--follow', CONTAINER_NAME], true);
    }
    return;
  }
  throw new Error('Unsupported bare Docker action');
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

async function collectOutput(stream: NodeJS.ReadableStream | null): Promise<string> {
  let output = '';
  if (stream !== null) {
    for await (const chunk of stream) {
      output += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
    }
  }
  return output;
}

const runDocker: DockerRun = async (args, options = {}) => {
  try {
    const child = spawn('docker', args, {
      stdio: options.stream ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    });
    const [stdout, stderr, closeResult] = await Promise.all([
      collectOutput(child.stdout),
      collectOutput(child.stderr),
      once(child, 'close'),
    ]);
    const exitCode = closeResult[0];
    return {
      exitCode: typeof exitCode === 'number' ? exitCode : 1,
      output: `${stdout}${stderr}`,
    };
  } catch (error) {
    return {
      errorCode: isErrnoException(error) ? error.code : undefined,
      exitCode: 1,
      output: error instanceof Error ? error.message : String(error),
    };
  }
};

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function isDockerAction(value: string | undefined): value is DockerAction {
  return (
    value === 'build' ||
    value === 'check' ||
    value === 'logs' ||
    value === 'start' ||
    value === 'stop'
  );
}

async function main(): Promise<void> {
  const action = process.argv[2];
  if (!isDockerAction(action)) {
    throw new Error('Usage: tsx scripts/docker.ts <check|build|start|stop|logs>');
  }
  const composeFileExists = await fileExists('docker-compose.yaml');
  await executeDockerAction(action, {
    composeFileExists,
    env: process.env,
    run: runDocker,
  });
  if (action === 'check') {
    process.stdout.write('Docker is ready.\n');
  } else if (action === 'start') {
    process.stdout.write(formatStartMessage(composeFileExists, process.env));
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
