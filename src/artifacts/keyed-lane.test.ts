import { describe, expect, it } from 'vite-plus/test';

import { createKeyedLane } from './keyed-lane.js';

describe('createKeyedLane', () => {
  it('runs tasks for one key one at a time, in call order', async () => {
    const lane = createKeyedLane();
    const events: string[] = [];
    const gate = Promise.withResolvers<void>();

    const first = lane.run('a', async () => {
      events.push('first start');
      await gate.promise;
      events.push('first end');
    });
    const second = lane.run('a', async () => {
      events.push('second');
    });
    await Promise.resolve();
    gate.resolve();
    await Promise.all([first, second]);

    expect(events).toEqual(['first start', 'first end', 'second']);
  });

  it('keeps running a key after a task rejects, and forgets keys once idle', async () => {
    const lane = createKeyedLane();

    const failed = lane.run('a', () => Promise.reject(new Error('boom')));
    const next = lane.run('a', async () => 'ran');
    const other = lane.run('b', async () => 'other');
    expect(lane.activeKeys()).toBe(2);

    await expect(failed).rejects.toThrow('boom');
    await expect(next).resolves.toBe('ran');
    await expect(other).resolves.toBe('other');
    expect(lane.activeKeys()).toBe(0);
  });
});
