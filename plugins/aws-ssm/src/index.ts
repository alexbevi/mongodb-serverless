import { GetParametersCommand, PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import {
  assertStatus, parseStatus, PluginConfigurationError, ServerlessPlugin,
  type PluginConfig, type ReplSetGetStatus, type ReplSetGetStatusMember
} from '../../shared/src/index.js';

export interface SsmPluginOptions {
  client?: SSMClient;
  writable?: boolean;
  connectionStringParameter?: string;
  topologyParameter?: string;
}

interface Settings {
  uri: string;
  topology: ReplSetGetStatus | null;
}

/** The topology parameter is the base `clusterTopologyVariableName`; this adds the connection string's. */
export interface SsmPluginConfig extends PluginConfig {
  connectionStringParameter: string;
}

export class SsmPlugin extends ServerlessPlugin<SsmPluginConfig> {
  readonly name = 'AWS SSM Parameter Store';
  readonly version = '0.1.0';
  readonly author = 'MongoDB Serverless contributors';
  readonly #client: SSMClient;
  #settings: Promise<Settings> | undefined;
  #fetchDurationMs: number | undefined;

  constructor(options: SsmPluginOptions = {}) {
    const connectionStringParameter = options.connectionStringParameter ?? '/mongodb-serverless/connection-string';
    super(options.writable === undefined ? { connectionStringParameter } : { connectionStringParameter, writable: options.writable });
    this.set('clusterTopologyVariableName', options.topologyParameter ?? '/mongodb-serverless/topology');
    this.#client = options.client ?? new SSMClient({});

    if (!this.#uriParameter || !this.#topologyParameter || this.#uriParameter === this.#topologyParameter) {
      throw new TypeError('Connection string and topology require distinct, nonempty SSM parameter names');
    }
  }

  get #uriParameter(): string {
    return this.get('connectionStringParameter');
  }

  get #topologyParameter(): string {
    return this.get('clusterTopologyVariableName');
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

  get fetchDurationMs(): number | undefined {
    return this.#fetchDurationMs;
  }

  async write(status: ReplSetGetStatus): Promise<void> {
    this.assertWritable();
    assertStatus(status);
    const topology = routingTopology(status);
    const value = JSON.stringify(topology);

    if (Buffer.byteLength(value, 'utf8') > 4096) throw new RangeError('Topology exceeds the SSM Standard parameter limit of 4096 bytes');
    const loaded = this.#settings;
    await this.#client.send(new PutParameterCommand({
      Name: this.#topologyParameter, Value: value, Type: 'String', Tier: 'Standard', Overwrite: true
    }));

    // Keep cached settings current, without fetching settings nothing has needed yet.
    const settings = await loaded?.catch(() => undefined);

    if (settings) settings.topology = topology;
  }

  #load(): Promise<Settings> {
    this.#settings ??= this.#fetch().catch(error => {
      this.#settings = undefined;
      throw error;
    });

    return this.#settings;
  }

  async #fetch(): Promise<Settings> {
    const started = performance.now();

    const result = await this.#client.send(new GetParametersCommand({
      Names: [this.#uriParameter, this.#topologyParameter], WithDecryption: true
    }));

    this.#fetchDurationMs = performance.now() - started;

    const uri = result.Parameters?.find(parameter => parameter.Name === this.#uriParameter);
    const topology = result.Parameters?.find(parameter => parameter.Name === this.#topologyParameter);

    if (!uri?.Value || uri.Type !== 'SecureString') {
      throw new PluginConfigurationError(`SSM parameter "${this.#uriParameter}" must contain a SecureString connection string`);
    }

    return { uri: uri.Value, topology: topology?.Value === undefined ? null : parseStatus(topology.Value) };
  }
}

function routingTopology(status: ReplSetGetStatus): ReplSetGetStatus {
  const topology: ReplSetGetStatus = { members: status.members.map(member => {
    const selected: ReplSetGetStatusMember = { name: member.name };

    if (member.state !== undefined) selected.state = member.state;

    if (member.stateStr !== undefined) selected.stateStr = member.stateStr;

    if (member.health !== undefined) selected.health = member.health;

    return selected;
  }) };

  if (status.set !== undefined) topology.set = status.set;

  if (status.authentication !== undefined) {
    topology.authentication = { mechanism: status.authentication.mechanism, source: status.authentication.source };
  }

  return topology;
}
