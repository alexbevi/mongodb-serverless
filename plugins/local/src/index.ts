import { ServerlessPlugin, type ReplSetGetStatus } from '@mongodb-serverless/plugin-base';

/** Reads cluster topology from a process environment variable. */
export class LocalPlugin extends ServerlessPlugin {
  readonly name = 'Local Environment';
  readonly version = '0.0.0';
  readonly author = 'MongoDB';

  async setup(): Promise<void> {
    // The environment is already there; nothing to provision.
  }

  async verify(): Promise<void> {
    this.#parse(this.#rawOrThrow());
  }

  async read(): Promise<ReplSetGetStatus> {
    return this.#parse(this.#rawOrThrow());
  }

  async write(status: ReplSetGetStatus): Promise<void> {
    process.env[this.#variableName()] = JSON.stringify(status);
  }

  #variableName(): string {
    return this.get('clusterTopologyVariableName');
  }

  #rawOrThrow(): string {
    const name = this.#variableName();
    const raw = process.env[name];

    if (raw == null || raw === '') {
      throw new Error(
        `${name} is not set. Populate it with the output of replSetGetStatus, ` +
          `for example: export ${name}="$(mongosh --quiet --eval 'JSON.stringify(rs.status())')"`
      );
    }

    return raw;
  }

  #parse(raw: string): ReplSetGetStatus {
    const name = this.#variableName();
    let parsed: unknown;

    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      throw new Error(`${name} does not contain valid JSON`, { cause });
    }

    if (parsed == null || typeof parsed !== 'object') {
      throw new Error(`${name} must contain a JSON object, got ${typeof parsed}`);
    }

    const status = parsed as Partial<ReplSetGetStatus>;

    if (!Array.isArray(status.members)) {
      throw new Error(`${name} has no members array; it must hold a replSetGetStatus document`);
    }

    return status as ReplSetGetStatus;
  }
}
