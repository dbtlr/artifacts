import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
import { DEFAULT_PORT } from '../src/port.js';

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
      'muninn',
      '--init',
      '--restart',
      'unless-stopped',
      '--publish',
      '127.0.0.1:4242:4242',
      '--env',
      'NODE_ENV=production',
      '--env',
      'MUNINN_PORT=4242',
      '--env',
      'MUNINN_PUBLIC_BASE_URL=http://localhost:4242',
      '--mount',
      'type=volume,source=artifacts-files,target=/app/data/files',
      '--mount',
      'type=volume,source=artifacts-database,target=/app/data/database',
      '--mount',
      'type=volume,source=artifacts-thumbs,target=/app/data/thumbs',
      'muninn:local',
    ]);
  });

  // 4242, not the direct-run default (4243), so a dev server and a container
  // on one host do not collide; the Dockerfile's ENV MUNINN_PORT matches.
  it('defaults to port 4242, apart from the direct-run default', async () => {
    const config = resolveDockerConfig({});
    const dockerfile = await readFile(new URL('../Dockerfile', import.meta.url), 'utf8');

    expect(config.port).toBe(4242);
    expect(config.publicBaseUrl).toBe('http://localhost:4242');
    expect(config.port).not.toBe(DEFAULT_PORT);
    expect(dockerfile).toContain(`ENV MUNINN_PORT=${String(config.port)}`);
  });

  it('maps explicit ports and absolute host paths without changing container storage paths', () => {
    const config = resolveDockerConfig({
      MUNINN_DATABASE_MOUNT: '/srv/artifacts/database',
      MUNINN_FILES_MOUNT: '/srv/artifacts/files',
      MUNINN_PORT: '5050',
      MUNINN_PUBLIC_BASE_URL: 'https://artifacts.example',
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
    'rejects invalid Docker MUNINN_PORT value %j before command construction',
    (value) => {
      expect(() => resolveDockerConfig({ MUNINN_PORT: value })).toThrow(
        /MUNINN_PORT must be an integer between 1 and 65535/u,
      );
    },
  );

  it('rejects blank or shared persistence mounts before starting', () => {
    expect(() => resolveDockerConfig({ MUNINN_FILES_MOUNT: ' ' })).toThrow(/MUNINN_FILES_MOUNT/u);
    expect(() => resolveDockerConfig({ MUNINN_DATABASE_MOUNT: '' })).toThrow(
      /MUNINN_DATABASE_MOUNT/u,
    );
    expect(() =>
      resolveDockerConfig({
        MUNINN_DATABASE_MOUNT: 'shared-data',
        MUNINN_FILES_MOUNT: 'shared-data',
      }),
    ).toThrow(/must use different sources/u);
    expect(() => resolveDockerConfig({ MUNINN_THUMBS_MOUNT: ' ' })).toThrow(/MUNINN_THUMBS_MOUNT/u);
    expect(() =>
      resolveDockerConfig({
        MUNINN_FILES_MOUNT: 'shared-data',
        MUNINN_THUMBS_MOUNT: 'shared-data',
      }),
    ).toThrow(/MUNINN_FILES_MOUNT and MUNINN_THUMBS_MOUNT must use different sources/u);
  });

  it('passes a configured owner password by name only, so its value stays off the command line', () => {
    const args = buildBareRunArgs(
      resolveDockerConfig({ MUNINN_OWNER_PASSWORD: 'hunter2 is far too famous' }),
    );

    expect(args.slice(args.indexOf('MUNINN_OWNER_PASSWORD') - 1).slice(0, 2)).toEqual([
      '--env',
      'MUNINN_OWNER_PASSWORD',
    ]);
    expect(args.join(' ')).not.toContain('hunter2');
  });

  it('rejects a blank owner password instead of starting without auth', () => {
    expect(() => resolveDockerConfig({ MUNINN_OWNER_PASSWORD: ' ' })).toThrow(
      /MUNINN_OWNER_PASSWORD must not be blank/u,
    );
  });

  it('rejects a short owner password before replacing the container', () => {
    expect(() => resolveDockerConfig({ MUNINN_OWNER_PASSWORD: 'hunter2' })).toThrow(
      /MUNINN_OWNER_PASSWORD must be at least 16 characters/u,
    );
  });

  it('passes a configured client address header to the container', () => {
    const args = buildBareRunArgs(
      resolveDockerConfig({
        MUNINN_CLIENT_ADDRESS_HEADER: 'CF-Connecting-IP',
        MUNINN_OWNER_PASSWORD: 'a long random owner password',
      }),
    );

    const setting = args.indexOf('MUNINN_CLIENT_ADDRESS_HEADER=CF-Connecting-IP');

    expect(args.slice(setting - 1, setting + 1)).toEqual([
      '--env',
      'MUNINN_CLIENT_ADDRESS_HEADER=CF-Connecting-IP',
    ]);
  });

  it('rejects a client address header that is not a header name', () => {
    expect(() =>
      resolveDockerConfig({
        MUNINN_CLIENT_ADDRESS_HEADER: 'CF Connecting IP',
        MUNINN_OWNER_PASSWORD: 'a long random owner password',
      }),
    ).toThrow(/MUNINN_CLIENT_ADDRESS_HEADER must be an HTTP header name/u);
  });

  it('ignores the client address header without an owner password, as the server does', () => {
    const args = buildBareRunArgs(
      resolveDockerConfig({ MUNINN_CLIENT_ADDRESS_HEADER: 'CF Connecting IP' }),
    );

    expect(args.join(' ')).not.toContain('MUNINN_CLIENT_ADDRESS_HEADER');
  });

  it('mounts an absolute thumbnails directory as a bind mount at the container thumbs path', () => {
    const config = resolveDockerConfig({ MUNINN_THUMBS_MOUNT: '/srv/artifacts/thumbs' });

    expect(buildBareRunArgs(config)).toContain(
      'type=bind,source=/srv/artifacts/thumbs,target=/app/data/thumbs',
    );
  });

  it.each(['relative/path', 'volume:/unexpected-target', 'x'])(
    'rejects invalid mount source %j before starting',
    (value) => {
      expect(() => resolveDockerConfig({ MUNINN_FILES_MOUNT: value })).toThrow(
        /MUNINN_FILES_MOUNT must be a Docker volume name or an absolute host path/u,
      );
    },
  );

  it('rejects mount sources that cannot be represented safely by Docker --mount', () => {
    expect(() => resolveDockerConfig({ MUNINN_FILES_MOUNT: '/tmp/files,old' })).toThrow(
      /MUNINN_FILES_MOUNT must not contain a comma/u,
    );
  });

  it('rejects missing and non-directory bind mounts before Docker commands run', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'artifacts-docker-test-'));
    const file = join(directory, 'database-file');
    await writeFile(file, 'not a directory');

    try {
      await expect(
        validateBindMounts(resolveDockerConfig({ MUNINN_FILES_MOUNT: join(directory, 'missing') })),
      ).rejects.toThrow(/MUNINN_FILES_MOUNT path does not exist/u);
      await expect(
        validateBindMounts(resolveDockerConfig({ MUNINN_DATABASE_MOUNT: file })),
      ).rejects.toThrow(/MUNINN_DATABASE_MOUNT must be a directory/u);
      await expect(
        validateBindMounts(
          resolveDockerConfig({ MUNINN_THUMBS_MOUNT: join(directory, 'missing-thumbs') }),
        ),
      ).rejects.toThrow(/MUNINN_THUMBS_MOUNT path does not exist/u);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});

describe('Docker operator output', () => {
  it('does not resolve or report bare-only configuration after a Compose start', () => {
    expect(formatStartMessage(true, { MUNINN_FILES_MOUNT: ' ' })).toBe(
      'Muninn is running through docker-compose.yaml.\n',
    );
  });

  it('reports the configured URL after a bare Docker start', () => {
    expect(formatStartMessage(false, { MUNINN_PUBLIC_BASE_URL: 'https://artifacts.example' })).toBe(
      'Muninn is running at https://artifacts.example\n',
    );
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

  it.each([true, false])(
    'refuses a legacy variable before starting (Compose: %s)',
    async (composeFileExists) => {
      const calls: string[][] = [];

      await expect(
        executeDockerAction('start', {
          composeFileExists,
          env: { ARTIFACTS_OWNER_PASSWORD: 'a long random password' },
          run: successfulRunner(calls),
        }),
      ).rejects.toThrow(/rename it to MUNINN_OWNER_PASSWORD/u);
      expect(calls).toEqual([
        ['--version'],
        ['info'],
        ...(composeFileExists ? [['compose', 'version']] : []),
      ]);
    },
  );

  it('still stops through Compose while a legacy variable is set', async () => {
    const calls: string[][] = [];

    await executeDockerAction('stop', {
      composeFileExists: true,
      env: { ARTIFACTS_OWNER_PASSWORD: 'a long random password' },
      run: successfulRunner(calls),
    });

    expect(calls).toContainEqual(['compose', '--file', 'docker-compose.yaml', 'down']);
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
        return {
          exitCode: 0,
          output: 'fresh-container-id\nwarning from Docker\n',
          stdout: 'fresh-container-id\n',
        };
      }
      if (args[0] === 'container' && args[1] === 'inspect') {
        const name = args.at(-1);
        if (!['muninn', 'fresh-container-id'].includes(name ?? '') || !containerExists) {
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
    expect(calls).toContainEqual([
      'container',
      'inspect',
      '--format',
      '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}',
      'fresh-container-id',
    ]);
    expect(calls).toContainEqual(['stop', 'fresh-container-id']);
    expect(calls).toContainEqual(['container', 'rm', 'fresh-container-id']);
  });

  it('does not remove a container created by another operator after the fresh-start check', async () => {
    const calls: string[][] = [];
    let rivalCreated = false;
    const run: DockerRun = async (args) => {
      calls.push(args);
      if (args[0] === 'run' && args.includes('--name') && args.includes('muninn')) {
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

    expect(calls).not.toContainEqual(['container', 'rm', 'muninn']);
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
            MUNINN_DATABASE_MOUNT: database,
            MUNINN_FILES_MOUNT: files,
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
      if (args[0] === 'container' && args[1] === 'inspect' && inspectedName === 'muninn') {
        output = isHealthInspection ? 'running healthy\n' : 'true\n';
      }
      return {
        exitCode:
          args[0] === 'container' && args[1] === 'inspect' && inspectedName !== 'muninn' ? 1 : 0,
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
      ['build', '--tag', 'muninn:local', '.'],
      ['container', 'inspect', '--format', '{{.State.Running}}', 'muninn'],
      ['container', 'inspect', '--format', '{{.State.Running}}', 'muninn-previous'],
      ['container', 'inspect', '--format', '{{.State.Running}}', 'muninn-replacement'],
      ['container', 'inspect', '--format', '{{.State.Running}}', 'muninn'],
      ['container', 'inspect', '--format', '{{.State.Running}}', 'muninn-previous'],
      ['container', 'inspect', '--format', '{{.State.Running}}', 'muninn-replacement'],
      [
        'create',
        '--name',
        'muninn-replacement',
        '--init',
        '--restart',
        'unless-stopped',
        '--publish',
        '127.0.0.1:4242:4242',
        '--env',
        'NODE_ENV=production',
        '--env',
        'MUNINN_PORT=4242',
        '--env',
        'MUNINN_PUBLIC_BASE_URL=http://localhost:4242',
        '--mount',
        'type=volume,source=artifacts-files,target=/app/data/files',
        '--mount',
        'type=volume,source=artifacts-database,target=/app/data/database',
        '--mount',
        'type=volume,source=artifacts-thumbs,target=/app/data/thumbs',
        'muninn:local',
      ],
      ['stop', 'muninn'],
      ['rename', 'muninn', 'muninn-previous'],
      ['rename', 'muninn-replacement', 'muninn'],
      ['start', 'muninn'],
      [
        'container',
        'inspect',
        '--format',
        '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}',
        'muninn',
      ],
      ['container', 'rm', 'muninn-previous'],
    ]);
  });

  it('restores a running container when its replacement fails to start', async () => {
    const calls: string[][] = [];
    let replacementStartAttempts = 0;
    const run: DockerRun = async (args) => {
      calls.push(args);
      if (args[0] === 'start' && args[1] === 'muninn') {
        replacementStartAttempts += 1;
        if (replacementStartAttempts === 1) {
          return { exitCode: 1, output: 'replacement failed' };
        }
      }
      if (args[0] === 'container' && args[1] === 'inspect') {
        const name = args.at(-1);
        if (name === 'muninn-previous' || name === 'muninn-replacement') {
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

    expect(calls).toContainEqual(['rename', 'muninn', 'muninn-previous']);
    expect(calls).toContainEqual(['rename', 'muninn-previous', 'muninn']);
    expect(calls.at(-1)).toEqual([
      'container',
      'inspect',
      '--format',
      '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}',
      'muninn',
    ]);
    expect(replacementStartAttempts).toBe(2);
  });

  it('proves the restored container healthy after an unhealthy replacement', async () => {
    let healthInspections = 0;
    const run: DockerRun = async (args) => {
      if (args[0] === 'container' && args[1] === 'inspect') {
        const name = args.at(-1);
        if (name === 'muninn-previous' || name === 'muninn-replacement') {
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
    ).rejects.toThrow(/previous muninn container was restored/u);

    expect(healthInspections).toBe(2);
  });

  it('recovers an interrupted replacement before attempting another one', async () => {
    const calls: string[][] = [];
    const containers = new Map([
      ['muninn-previous', { health: 'healthy', running: false }],
      ['muninn-replacement', { health: 'starting', running: false }],
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

    expect(containers.get('muninn')).toEqual({ health: 'healthy', running: true });
    expect(containers.has('muninn-previous')).toBe(false);
    expect(containers.has('muninn-replacement')).toBe(false);
    expect(calls).toContainEqual(['rename', 'muninn-previous', 'muninn']);
    expect(calls).toContainEqual([
      'container',
      'inspect',
      '--format',
      '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}',
      'muninn',
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
      ['container', 'inspect', '--format', '{{.State.Running}}', 'muninn'],
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
      ['build', '--tag', 'muninn:local', '.'],
      ['--version'],
      ['info'],
      ['container', 'inspect', 'muninn'],
      ['logs', '--follow', 'muninn'],
    ]);
  });

  it('stops, builds, and follows logs even when the start configuration is invalid', async () => {
    const calls: string[][] = [];
    const env = { MUNINN_OWNER_PASSWORD: 'hunter2' };
    const run: DockerRun = async (args) => {
      calls.push(args);
      return { exitCode: 0, output: args[0] === 'container' ? 'true' : '' };
    };

    await executeDockerAction('stop', { composeFileExists: false, env, run });
    await executeDockerAction('build', { composeFileExists: false, env, run });
    await executeDockerAction('logs', { composeFileExists: false, env, run });

    expect(calls).toContainEqual(['stop', 'muninn']);
    expect(calls).toContainEqual(['build', '--tag', 'muninn:local', '.']);
    expect(calls).toContainEqual(['logs', '--follow', 'muninn']);
  });
});
