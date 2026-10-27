const LEGACY_PREFIX = 'ARTIFACTS_';
const CURRENT_PREFIX = 'MUNINN_';

// The product was renamed from Artifacts to Muninn (ADR-0007). A deployment
// that still sets ARTIFACTS_OWNER_PASSWORD would otherwise start without
// owner auth, so any variable under the old prefix stops startup. Only names
// are reported; values may be secrets. The match ignores case because
// Windows reads environment names that way. A Worker's bindings are checked
// the same way, whatever kind of binding a name holds.
export function assertNoLegacyEnv(env: Readonly<Record<string, unknown>> = process.env): void {
  const legacy = Object.keys(env)
    .filter((name) => name.toUpperCase().startsWith(LEGACY_PREFIX))
    .toSorted();
  if (legacy.length === 0) {
    return;
  }
  const renames = legacy.map(
    (name) =>
      `${name} is no longer read; rename it to ${CURRENT_PREFIX}${name.slice(LEGACY_PREFIX.length).toUpperCase()}`,
  );
  throw new Error(`Artifacts is now Muninn (ADR-0007).\n${renames.join('\n')}`);
}
