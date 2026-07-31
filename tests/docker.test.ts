import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

  it('removes an unhealthy container from a failed fresh start', async () => {
    let containerExists = false;
    const calls: string[][] = [];
    const run: DockerRun = async (args) => {
      calls.push(args);
      if (args[0] === 'run') {
        containerExists = true;
        return { exitCode: 0, output: 'fresh-container-id\n' };
      }
      if (args[0] === 'container' && args[1] === 'inspect') {
        const name = args.at(-1);
        if (!['artifacts', 'fresh-container-id'].includes(name ?? '') || !containerExists) {
          return { exitCode: 1, output: '' };
        }
        if (
          args.includes('{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}')
        ) {
          return { exitCode: 0, output: 'running unhealthy\n' };
        }
        return { exitCode: 0, output: 'true\n' };
      }
      if (args[0] === 'container' && args[1] === 'rm' && args[2] === 'fresh-container-id') {
        containerExists = false;
      }
      return { exitCode: 0, output: '' };
    };

    await expect(
      executeDockerAction('start', { composeFileExists: false, env: {}, run }),
    ).rejects.toThrow(/became unhealthy during startup/u);

    expect(containerExists).toBe(false);
    expect(calls).toContainEqual(['stop', 'fresh-container-id']);
    expect(calls).toContainEqual(['container', 'rm', 'fresh-container-id']);
  });

  it('does not remove a container created by another operator after the fresh-start check', async () => {
    const calls: string[][] = [];
    let rivalCreated = false;
    const run: DockerRun = async (args) => {
      calls.push(args);
      if (args[0] === 'run' && args.includes('--name') && args.includes('artifacts')) {
        rivalCreated = true;
        return { exitCode: 1, output: 'Conflict. The container name is already in use.' };
      }
      if (args[0] === 'container' && args[1] === 'inspect') {
        return { exitCode: rivalCreated ? 0 : 1, output: rivalCreated ? 'true\n' : '' };
      }
      return {
        exitCode: 0,
        output: '',
      };
    };

    await expect(
      executeDockerAction('start', { composeFileExists: false, env: {}, run }),
    ).rejects.toThrow(/container name is already in use/u);

    expect(calls).not.toContainEqual(['container', 'rm', 'artifacts']);
  });

  it('rejects bind mounts the container user cannot write before replacing a container', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'artifacts-docker-bind-test-'));
    const files = join(directory, 'files');
    const database = join(directory, 'database');
    await Promise.all([mkdir(files), mkdir(database)]);
    const calls: string[][] = [];
    const run: DockerRun = async (args) => {
      calls.push(args);
      return {
        exitCode: args[0] === 'run' && args.includes('--entrypoint') ? 1 : 0,
        output: args[0] === 'run' ? 'permission denied' : '',
      };
    };

    try {
      await expect(
        executeDockerAction('start', {
          composeFileExists: false,
          env: {
            ARTIFACTS_DATABASE_MOUNT: database,
            ARTIFACTS_FILES_MOUNT: files,
          },
          run,
        }),
      ).rejects.toThrow(/must be writable by the container's node user \(uid 1000\)/u);
      expect(calls.some((args) => args[0] === 'container' && args[1] === 'inspect')).toBe(false);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('rebuilds and safely replaces an existing bare container on repeated start', async () => {
    const calls: string[][] = [];
    const run: DockerRun = async (args) => {
      calls.push(args);
      const inspectedName = args.at(-1);
      const isHealthInspection = args.includes(
        '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}',
      );
      let output = '';
      if (args[0] === 'container' && args[1] === 'inspect' && inspectedName === 'artifacts') {
        output = isHealthInspection ? 'running healthy\n' : 'true\n';
      }
      return {
        exitCode:
          args[0] === 'container' && args[1] === 'inspect' && inspectedName !== 'artifacts' ? 1 : 0,
        output,
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
      ['container', 'inspect', '--format', '{{.State.Running}}', 'artifacts-previous'],
      ['container', 'inspect', '--format', '{{.State.Running}}', 'artifacts-replacement'],
      ['container', 'inspect', '--format', '{{.State.Running}}', 'artifacts'],
      ['container', 'inspect', '--format', '{{.State.Running}}', 'artifacts-previous'],
      ['container', 'inspect', '--format', '{{.State.Running}}', 'artifacts-replacement'],
      [
        'create',
        '--name',
        'artifacts-replacement',
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
      ],
      ['stop', 'artifacts'],
      ['rename', 'artifacts', 'artifacts-previous'],
      ['rename', 'artifacts-replacement', 'artifacts'],
      ['start', 'artifacts'],
      [
        'container',
        'inspect',
        '--format',
        '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}',
        'artifacts',
      ],
      ['container', 'rm', 'artifacts-previous'],
    ]);
  });

  it('restores a running container when its replacement fails to start', async () => {
    const calls: string[][] = [];
    let replacementStartAttempts = 0;
    const run: DockerRun = async (args) => {
      calls.push(args);
      if (args[0] === 'start' && args[1] === 'artifacts') {
        replacementStartAttempts += 1;
        if (replacementStartAttempts === 1) {
          return { exitCode: 1, output: 'replacement failed' };
        }
      }
      if (args[0] === 'container' && args[1] === 'inspect') {
        const name = args.at(-1);
        if (name === 'artifacts-previous' || name === 'artifacts-replacement') {
          return { exitCode: 1, output: '' };
        }
        if (
          args.includes('{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}')
        ) {
          return { exitCode: 0, output: 'running healthy\n' };
        }
        return { exitCode: 0, output: 'true\n' };
      }
      return { exitCode: 0, output: '' };
    };

    await expect(
      executeDockerAction('start', {
        composeFileExists: false,
        env: {},
        run,
      }),
    ).rejects.toThrow(/replacement failed/u);

    expect(calls).toContainEqual(['rename', 'artifacts', 'artifacts-previous']);
    expect(calls).toContainEqual(['rename', 'artifacts-previous', 'artifacts']);
    expect(calls.at(-1)).toEqual([
      'container',
      'inspect',
      '--format',
      '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}',
      'artifacts',
    ]);
    expect(replacementStartAttempts).toBe(2);
  });

  it('proves the restored container healthy after an unhealthy replacement', async () => {
    let healthInspections = 0;
    const run: DockerRun = async (args) => {
      if (args[0] === 'container' && args[1] === 'inspect') {
        const name = args.at(-1);
        if (name === 'artifacts-previous' || name === 'artifacts-replacement') {
          return { exitCode: 1, output: '' };
        }
        if (
          args.includes('{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}')
        ) {
          healthInspections += 1;
          return {
            exitCode: 0,
            output: healthInspections === 1 ? 'running unhealthy\n' : 'running healthy\n',
          };
        }
        return { exitCode: 0, output: 'true\n' };
      }
      return { exitCode: 0, output: '' };
    };

    await expect(
      executeDockerAction('start', { composeFileExists: false, env: {}, run }),
    ).rejects.toThrow(/previous artifacts container was restored/u);

    expect(healthInspections).toBe(2);
  });

  it('recovers an interrupted replacement before attempting another one', async () => {
    const calls: string[][] = [];
    const containers = new Map([
      ['artifacts-previous', { health: 'healthy', running: false }],
      ['artifacts-replacement', { health: 'starting', running: false }],
    ]);
    const run: DockerRun = async (args) => {
      calls.push(args);
      if (args[0] === 'container' && args[1] === 'inspect') {
        const name = args.at(-1) ?? '';
        const container = containers.get(name);
        if (container === undefined) {
          return { exitCode: 1, output: '' };
        }
        const healthFormat = args.includes(
          '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}',
        );
        return {
          exitCode: 0,
          output: healthFormat
            ? `${container.running ? 'running' : 'exited'} ${container.health}\n`
            : `${String(container.running)}\n`,
        };
      }
      if (args[0] === 'container' && args[1] === 'rm') {
        containers.delete(args[2] ?? '');
      } else if (args[0] === 'rename') {
        const source = args[1] ?? '';
        const target = args[2] ?? '';
        const container = containers.get(source);
        if (container !== undefined) {
          containers.delete(source);
          containers.set(target, container);
        }
      } else if (args[0] === 'start') {
        const container = containers.get(args[1] ?? '');
        if (container !== undefined) {
          container.running = true;
          container.health = 'healthy';
        }
      } else if (args[0] === 'create') {
        return { exitCode: 1, output: 'create failed after recovery' };
      }
      return { exitCode: 0, output: '' };
    };

    await expect(
      executeDockerAction('start', { composeFileExists: false, env: {}, run }),
    ).rejects.toThrow(/create failed after recovery/u);

    expect(containers.get('artifacts')).toEqual({ health: 'healthy', running: true });
    expect(containers.has('artifacts-previous')).toBe(false);
    expect(containers.has('artifacts-replacement')).toBe(false);
    expect(calls).toContainEqual(['rename', 'artifacts-previous', 'artifacts']);
    expect(calls).toContainEqual([
      'container',
      'inspect',
      '--format',
      '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}',
      'artifacts',
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
