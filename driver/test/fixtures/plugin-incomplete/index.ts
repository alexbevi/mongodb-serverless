// Missing read() and author, so validation must name both.
export default class IncompletePlugin {
  readonly name = 'incomplete';
  readonly version = '1.0.0';

  async setup(): Promise<void> {}
  async verify(): Promise<void> {}
  async write(): Promise<void> {}
}
