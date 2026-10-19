import path from 'node:path';

/**
 * Compiles a small glob dialect to a RegExp: `**` (any number of path segments, including none),
 * `*` (anything but `/`), `?` (one character but `/`) and `{a,b}` alternatives.
 */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  let braces = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    const atSegmentStart = i === 0 || glob[i - 1] === '/';
    if (c === '*' && glob[i + 1] === '*' && atSegmentStart && (glob[i + 2] === '/' || i + 2 === glob.length)) {
      if (glob[i + 2] === '/') {
        re += '(?:.*/)?'; // `**/`: zero or more leading segments
        i += 2;
      } else if (re.endsWith('/')) {
        re = `${re.slice(0, -1)}(?:/.*)?`; // trailing `/**`: the path itself or anything below it
        i += 1;
      } else {
        re += '.*'; // a bare `**`
        i += 1;
      }
    } else if (c === '*') {
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '{') {
      braces++;
      re += '(?:';
    } else if (c === '}' && braces > 0) {
      braces--;
      re += ')';
    } else if (c === ',' && braces > 0) {
      re += '|';
    } else {
      re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

/**
 * Loosely normalizes an import specifier for pattern matching: collapses `.` / `..` segments and drops
 * the leading ones, so `./activities/x`, `../../src/activities/x` and `src/activities/x` all match
 * `**\/activities/**`. Nothing is resolved against the file system.
 */
export function normalizeSpecifier(specifier: string): string {
  return path.posix
    .normalize(specifier.replaceAll('\\', '/'))
    .replace(/^(?:\.\.?\/)+/, '')
    .replace(/\/+$/, '');
}
