// Exports its plugin under its own name with no default export, the shape
// plugin-local uses. Also exports an unrelated constant, which must be ignored.
export const VERSION_TAG = 'not-a-plugin';

export class NamedExportPlugin {
  readonly name = 'named-export';
  readonly version = '3.0.0';
  readonly author = 'test';

  async setup(): Promise<void> {}
  async verify(): Promise<void> {}
  async read(): Promise<{ set: string; members: never[] }> {
    return { set: 'rs0', members: [] };
  }
  async write(): Promise<void> {}
}
