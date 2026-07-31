import { describe, expect, it } from 'vite-plus/test';

import { resolvePort } from './port.js';

describe('resolvePort', () => {
  it('defaults when unset', () => {
    expect(resolvePort(undefined)).toBe(3000);
  });

  it('defaults when blank or whitespace-only', () => {
    expect(resolvePort('')).toBe(3000);
    expect(resolvePort('   ')).toBe(3000);
  });

  it('honors 0 for an OS-assigned port', () => {
    expect(resolvePort('0')).toBe(0);
  });

  it('parses plain and whitespace-padded numerics', () => {
    expect(resolvePort('8080')).toBe(8080);
    expect(resolvePort('  3000  ')).toBe(3000);
    expect(resolvePort('65535')).toBe(65_535);
  });

  it('throws on non-numeric values', () => {
    expect(() => resolvePort('abc')).toThrow(/ARTIFACTS_PORT must be a non-negative integer/u);
    expect(() => resolvePort('0x50')).toThrow(/ARTIFACTS_PORT must be a non-negative integer/u);
    expect(() => resolvePort('30.5')).toThrow(/ARTIFACTS_PORT must be a non-negative integer/u);
    expect(() => resolvePort('+3000')).toThrow(/ARTIFACTS_PORT must be a non-negative integer/u);
    expect(() => resolvePort('-1')).toThrow(/ARTIFACTS_PORT must be a non-negative integer/u);
  });

  it('throws on out-of-range values', () => {
    expect(() => resolvePort('65536')).toThrow(/ARTIFACTS_PORT must be between 0 and 65535/u);
    expect(() => resolvePort('99999999999999999999')).toThrow(
      /ARTIFACTS_PORT must be between 0 and 65535/u,
    );
  });
});
