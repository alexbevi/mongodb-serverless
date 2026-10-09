import { expect, it } from 'vitest';
import { parseManifest } from './harness/package-manifest.js';

it('checks dependency maps without dropping unrelated manifest fields', () => {
  const manifest = { version: '1.2.3', dependencies: { mongodb: '^7' }, custom: 42 };

  expect(parseManifest(JSON.stringify(manifest))).toEqual(manifest);
  expect(() => parseManifest('{"dependencies":{"mongodb":7}}')).toThrow(/dependencies/);
  expect(() => parseManifest('{"dependencies":[]}')).toThrow(/dependencies/);
  expect(() => parseManifest('null')).toThrow(/object/);
});
