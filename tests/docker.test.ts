import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vite-plus/test';

import {
  buildBareRunArgs,
  executeDockerAction,
  formatStartMessage,
  resolveDockerConfig,
  validateBindMounts,
} from '../scripts/docker.js';
import type { DockerRun, DockerRunResult } from '../scripts/docker.js';

function successfulRunner(calls: string[][]): DockerRun {
  return async (args): Promise<DockerRunResult> => {
    calls.push(args);
    return { exitCode: 0, output: '' };
  };
}

const missingCliRunner: DockerRun = async () => ({
  errorCode: 'ENOENT',
  exitCode: 1,
  output: '',
});

const stoppedDaemonRunner: DockerRun = async (args) => ({
  exitCode: args[0] === 'info' ? 1 : 0,
  output: '',
});

const missingComposeRunner: DockerRun = async (args) => ({
  exitCode: args[0] === 'compose' ? 1 : 0,
  output: '',
});

describe('bare Docker command construction', () => {
  it('uses loopback-only port 4242, production mode, deterministic names, and separate volumes', () => {
    const config = resolveDockerConfig({});

    expect(buildBareRunArgs(config)).toEqual([
      'run',
      '--detach',
      '--name',
      'artifacts',
      '--init',
      '--restart',
      'unless-stopped',
      '--publish',
      '127.0.0.1:4242:4242',
      '--env',
      'NODE_ENV=production',
      '--env',
      'ARTIFACTS_PORT=4242',
      '--env',
      'ARTIFACTS_PUBLIC_BASE_URL=http://localhost:4242',
      '--mount',
      'type=volume,source=artifacts-files,target=/app/data/files',
      '--mount',
      'type=volume,source=artifacts-database,target=/app/data/database',
      'artifacts:local',
    ]);
  });

  it('maps explicit ports and absolute host paths without changing container storage paths', () => {
    const config = resolveDockerConfig({
      ARTIFACTS_DATABASE_MOUNT: '/srv/artifacts/database',
      ARTIFACTS_FILES_MOUNT: '/srv/artifacts/files',
      ARTIFACTS_PORT: '5050',
      ARTIFACTS_PUBLIC_BASE_URL: 'https://artifacts.example',
    });

    expect(buildBareRunArgs(config)).toContain('127.0.0.1:5050:5050');
    expect(buildBareRunArgs(config)).toContain(
      'type=bind,source=/srv/artifacts/files,target=/app/data/files',
    );
    expect(buildBareRunArgs(config)).toContain(
      'type=bind,source=/srv/artifacts/database,target=/app/data/database',
    );
  });

  it.each(['', '0', '65536', 'abc'])(
    'rejects invalid Docker ARTIFACTS_PORT value %j before command construction',
    (value) => {
      expect(() => resolveDockerConfig({ ARTIFACTS_PORT: value })).toThrow(
        /ARTIFACTS_PORT must be an integer between 1 and 65535/u,
      );
    },
  );

  it('rejects blank or shared persistence mounts before starting', () => {
    expect(() => resolveDockerConfig({ ARTIFACTS_FILES_MOUNT: ' ' })).toThrow(
      /ARTIFACTS_FILES_MOUNT/u,
    );
    expect(() => resolveDockerConfig({ ARTIFACTS_DATABASE_MOUNT: '' })).toThrow(
      /ARTIFACTS_DATABASE_MOUNT/u,
    );
    expect(() =>
      resolveDockerConfig({
        ARTIFACTS_DATABASE_MOUNT: 'shared-data',
        ARTIFACTS_FILES_MOUNT: 'shared-data',
      }),
    ).toThrow(/must use different sources/u);
  });

  it.each(['relative/path', 'volume:/unexpected-target', 'x'])(
    'rejects invalid mount source %j before starting',
    (value) => {
      expect(() => resolveDockerConfig({ ARTIFACTS_FILES_MOUNT: value })).toThrow(
        /ARTIFACTS_FILES_MOUNT must be a Docker volume name or an absolute host path/u,
      );
    },
  );

  it('rejects mount sources that cannot be represented safely by Docker --mount', () => {
    expect(() => resolveDockerConfig({ ARTIFACTS_FILES_MOUNT: '/tmp/files,old' })).toThrow(
      /ARTIFACTS_FILES_MOUNT must not contain a comma/u,
    );
  });

  it('rejects missing and non-directory bind mounts before Docker commands run', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'artifacts-docker-test-'));
    const file = join(directory, 'database-file');
    await writeFile(file, 'not a directory');

    try {
      await expect(
        validateBindMounts(
          resolveDockerConfig({ ARTIFACTS_FILES_MOUNT: join(directory, 'missing') }),
        ),
      ).rejects.toThrow(/ARTIFACTS_FILES_MOUNT path does not exist/u);
      await expect(
        validateBindMounts(resolveDockerConfig({ ARTIFACTS_DATABASE_MOUNT: file })),
      ).rejects.toThrow(/ARTIFACTS_DATABASE_MOUNT must be a directory/u);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});

describe('Docker operator output', () => {
  it('does not resolve or report bare-only configuration after a Compose start', () => {
    expect(formatStartMessage(true, { ARTIFACTS_FILES_MOUNT: ' ' })).toBe(
      'Artifacts is running through docker-compose.yaml.\n',
    );
  });

  it('reports the configured URL after a bare Docker start', () => {
    expect(
      formatStartMessage(false, { ARTIFACTS_PUBLIC_BASE_URL: 'https://artifacts.example' }),
    ).toBe('Artifacts is running at https://artifacts.example\n');
  });
});

describe('Docker operator actions', () => {
  it('delegates start to an existing local Compose file after targeted preflight checks', async () => {
    const calls: string[][] = [];

    await executeDockerAction('start', {
      composeFileExists: true,
      env: {},
      run: successfulRunner(calls),
    });

    expect(calls).toEqual([
      ['--version'],
      ['info'],
      ['compose', 'version'],
      ['compose', '--file', 'docker-compose.yaml', 'up', '--detach', '--build'],
    ]);
  });

  it('reports a missing Docker CLI with an actionable error', async () => {
    await expect(
      executeDockerAction('check', { composeFileExists: false, env: {}, run: missingCliRunner }),
    ).rejects.toThrow('Docker CLI not found. Install Docker Desktop or Docker Engine and retry.');
  });

  it('distinguishes a stopped daemon from a missing CLI', async () => {
    await expect(
      executeDockerAction('check', {
        composeFileExists: false,
        env: {},
        run: stoppedDaemonRunner,
      }),
    ).rejects.toThrow('Docker daemon is unavailable. Start Docker Desktop or the Docker service');
  });

  it('reports missing Compose v2 only when a local Compose file selects that path', async () => {
    await expect(
      executeDockerAction('check', {
        composeFileExists: true,
        env: {},
        run: missingComposeRunner,
      }),
    ).rejects.toThrow('Docker Compose v2 is unavailable');
    await expect(
      executeDockerAction('check', {
        composeFileExists: false,
        env: {},
        run: missingComposeRunner,
      }),
    ).resolves.toBeUndefined();
  });

  it('rebuilds and safely replaces an existing bare container on repeated start', async () => {
    const calls: string[][] = [];
    const run: DockerRun = async (args) => {
      calls.push(args);
      return {
        exitCode: 0,
        output: args[0] === 'container' && args[1] === 'inspect' ? 'true\n' : '',
      };
    };

    await executeDockerAction('start', {
      composeFileExists: false,
      env: {},
      run,
    });

    expect(calls).toEqual([
      ['--version'],
      ['info'],
      ['build', '--tag', 'artifacts:local', '.'],
      ['container', 'inspect', '--format', '{{.State.Running}}', 'artifacts'],
      ['stop', 'artifacts'],
      ['container', 'rm', 'artifacts'],
      buildBareRunArgs(resolveDockerConfig({})),
    ]);
  });

  it('treats stopping an absent bare container as a successful no-op', async () => {
    const calls: string[][] = [];
    const run: DockerRun = async (args) => {
      calls.push(args);
      return {
        exitCode: args[0] === 'container' && args[1] === 'inspect' ? 1 : 0,
        output: '',
      };
    };

    await executeDockerAction('stop', { composeFileExists: false, env: {}, run });

    expect(calls).toEqual([
      ['--version'],
      ['info'],
      ['container', 'inspect', '--format', '{{.State.Running}}', 'artifacts'],
    ]);
  });

  it('builds the deterministic bare image and follows logs from the deterministic container', async () => {
    const calls: string[][] = [];
    const run: DockerRun = async (args) => {
      calls.push(args);
      return { exitCode: 0, output: '' };
    };

    await executeDockerAction('build', { composeFileExists: false, env: {}, run });
    await executeDockerAction('logs', { composeFileExists: false, env: {}, run });

    expect(calls).toEqual([
      ['--version'],
      ['info'],
      ['build', '--tag', 'artifacts:local', '.'],
      ['--version'],
      ['info'],
      ['container', 'inspect', 'artifacts'],
      ['logs', '--follow', 'artifacts'],
    ]);
  });
});
