// The longest file name most file systems accept, in UTF-16 code units.
export const MAX_FILENAME_LENGTH = 255;

// Control and format characters: C0 and C1 controls, zero-width characters,
// and bidi overrides and isolates, which can make a name display as another.
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/u;

// Whether `filename` is one plain path segment that displays as what it is:
// not empty, `.`, or `..`, no separator, no surrounding whitespace, and no
// control or format character.
export function isSafeFilename(filename: string): boolean {
  return (
    filename.length > 0 &&
    filename.length <= MAX_FILENAME_LENGTH &&
    filename === filename.trim() &&
    filename !== '.' &&
    filename !== '..' &&
    !filename.includes('/') &&
    !filename.includes('\\') &&
    !CONTROL_OR_FORMAT.test(filename)
  );
}
