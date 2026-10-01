// The whole mongodb surface, minus MongoClient.
export * from './generated/reexports.js';

// Ours, standing in for the driver's MongoClient.
export { ServerlessMongoClient as MongoClient } from './client.js';
export type { ServerlessClientOptions } from './client.js';

export { setDefaultPlugin, clearDefaultPlugin, type PluginSource } from './plugin-resolver.js';
export type { TopologyPlugin, ReplSetGetStatus, ReplSetGetStatusMember } from './plugin.js';

export {
  ServerlessDriverError,
  MissingPluginError,
  PluginNotInstalledError,
  InvalidPluginError,
  NoTopologyError,
  InvalidTopologyError,
  NoPrimaryError,
  SessionRoutingError,
  UnsupportedOperationError
} from './errors.js';
