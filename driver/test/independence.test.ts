import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const pkgRoot = fileURLToPath(new URL('../', import.meta.url));

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);

    if (entry.isDirectory()) return sourceFiles(path);

    return entry.name.endsWith('.ts') ? [path] : [];
  });

describe('plugin independence', () => {
  it('declares no plugin package as a dependency', () => {
    const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')) as Record<
      string,
      Record<string, string> | unknown
    >;

    for (const field of [
      'dependencies',
      'devDependencies',
      'peerDependencies',
      'optionalDependencies'
    ]) {
      const names = Object.keys((pkg[field] as Record<string, string>) ?? {});
      expect(names.filter(n => n.startsWith('@mongodb-serverless/plugin')), field).toEqual([]);
    }
  });

  it('imports no plugin package from source', () => {
    // Matches import/export/require of the package, not prose mentioning it.
    const imports = /(?:from\s*|require\(\s*)['"]@mongodb-serverless\/plugin[^'"]*['"]/;

    const offenders = sourceFiles(join(pkgRoot, 'src'))
      .filter(path => imports.test(readFileSync(path, 'utf8')))
      .map(path => path.slice(pkgRoot.length));

    expect(offenders).toEqual([]);
  });
});
