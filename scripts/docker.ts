import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access } from 'node:fs/promises';
import { isAbsolute, win32 } from 'node:path';
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
    await runRequired(run, ['build', '--tag', IMAGE_NAME, '.']);
    const existing = await run(
      ['container', 'inspect', '--format', '{{.State.Running}}', CONTAINER_NAME],
      { allowFailure: true },
    );
    if (existing.exitCode === 0) {
      if (existing.output.trim() === 'true') {
        await runRequired(run, ['stop', CONTAINER_NAME]);
      }
      await runRequired(run, ['container', 'rm', CONTAINER_NAME]);
    }
    await runRequired(run, buildBareRunArgs(config));
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
  await executeDockerAction(action, {
    composeFileExists: await fileExists('docker-compose.yaml'),
    env: process.env,
    run: runDocker,
  });
  if (action === 'check') {
    process.stdout.write('Docker is ready.\n');
  } else if (action === 'start') {
    const { publicBaseUrl } = resolveDockerConfig(process.env);
    process.stdout.write(`Artifacts is running at ${publicBaseUrl}\n`);
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
