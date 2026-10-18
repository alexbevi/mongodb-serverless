import { GetParametersCommand, SSMClient } from '@aws-sdk/client-ssm';
import { parseStatus, PluginReadOnlyError, type ReplSetGetStatus, type TopologyPlugin } from '../../shared/src/index.js';

export interface SsmPluginOptions {
  client?: SSMClient;
  connectionStringParameter?: string;
  topologyParameter?: string;
}

interface Settings {
  uri: string;
  topology: ReplSetGetStatus | null;
}

export class SsmPlugin implements TopologyPlugin {
  readonly name = 'AWS SSM Parameter Store';
  readonly version = '0.1.0';
  readonly author = 'MongoDB Serverless contributors';
  readonly #client: SSMClient;
  readonly #uriParameter: string;
  readonly #topologyParameter: string;
  #settings: Promise<Settings> | undefined;

  constructor(options: SsmPluginOptions = {}) {
    this.#client = options.client ?? new SSMClient({});
    this.#uriParameter = options.connectionStringParameter ?? '/mongodb-serverless/connection-string';
    this.#topologyParameter = options.topologyParameter ?? '/mongodb-serverless/topology';

    if (!this.#uriParameter || !this.#topologyParameter || this.#uriParameter === this.#topologyParameter) {
      throw new TypeError('Connection string and topology require distinct, nonempty SSM parameter names');
    }
  }

  async getConnectionString(): Promise<string> {
    return (await this.#load()).uri;
  }

  async read(): Promise<ReplSetGetStatus | null> {
    return (await this.#load()).topology;
  }

  async setup(): Promise<void> {}

  async verify(): Promise<void> {
    await this.#load();
  }

  async write(_status: ReplSetGetStatus): Promise<void> {
    throw new PluginReadOnlyError('SSM topology writes are disabled');
  }

  #load(): Promise<Settings> {
    this.#settings ??= this.#fetch().catch(error => {
      this.#settings = undefined;
      throw error;
    });

    return this.#settings;
  }

  async #fetch(): Promise<Settings> {
    const result = await this.#client.send(new GetParametersCommand({
      Names: [this.#uriParameter, this.#topologyParameter], WithDecryption: true
    }));

    const uri = result.Parameters?.find(parameter => parameter.Name === this.#uriParameter);
    const topology = result.Parameters?.find(parameter => parameter.Name === this.#topologyParameter);

    if (!uri?.Value || uri.Type !== 'SecureString') {
      throw new Error(`SSM parameter "${this.#uriParameter}" must contain a SecureString connection string`);
    }

    return { uri: uri.Value, topology: topology?.Value === undefined ? null : parseStatus(topology.Value) };
  }
}
