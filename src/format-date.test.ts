import { describe, expect, it } from 'vite-plus/test';

import { formatTimeLeft } from './format-date.js';

const NOW = new Date('2026-01-01T00:00:00.000Z');

function inSeconds(seconds: number): string {
  return new Date(NOW.getTime() + seconds * 1000).toISOString();
}

describe('formatTimeLeft', () => {
  it('counts whole hours under two days, rounding down', () => {
    expect(formatTimeLeft(inSeconds(24 * 3600 - 1), NOW)).toBe('23 h');
    expect(formatTimeLeft(inSeconds(3600), NOW)).toBe('1 h');
    expect(formatTimeLeft(inSeconds(47 * 3600 + 59 * 60), NOW)).toBe('47 h');
  });

  it('counts whole days from two days on', () => {
    expect(formatTimeLeft(inSeconds(48 * 3600), NOW)).toBe('2 d');
    expect(formatTimeLeft(inSeconds(7 * 24 * 3600 - 1), NOW)).toBe('6 d');
  });

  it('counts minutes under an hour, never showing less than one', () => {
    expect(formatTimeLeft(inSeconds(3599), NOW)).toBe('59 min');
    expect(formatTimeLeft(inSeconds(1), NOW)).toBe('1 min');
    expect(formatTimeLeft(inSeconds(-5), NOW)).toBe('1 min');
  });
});
