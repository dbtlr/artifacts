// Artifact ids are nanoid output. The stores refuse anything else before it
// becomes a file name or an object key, since ids reach them from URL
// parameters.
const SAFE_ID = /^[A-Za-z0-9_-]+$/u;

export function isSafeId(id: string): boolean {
  return SAFE_ID.test(id);
}
