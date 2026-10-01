/**
 * A plugin that satisfies the contract structurally without extending
 * the shared plugin contract, standing in for a third-party plugin.
 */
export default class ThirdPartyPlugin {
  readonly name = 'third-party';
  readonly version = '2.1.0';
  readonly author = 'someone else';

  async setup(): Promise<void> {}
  async verify(): Promise<void> {}
  async read(): Promise<{ set: string; members: never[] }> {
    return { set: 'rs0', members: [] };
  }
  async write(): Promise<void> {}
}
