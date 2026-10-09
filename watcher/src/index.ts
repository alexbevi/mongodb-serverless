export { Watcher, type WatcherOptions, type CheckResult } from './watcher.js';

export {
  ClusterConnection,
  type ClusterConnectionOptions,
  type ClusterIdentity,
  type ClientFactory
} from './cluster.js';

export {
  WatcherError,
  ClusterUnreachableError,
  AuthenticationFailedError,
  NotAReplicaSetError,
  PluginReadOnlyError,
  MissingPluginError
} from './errors.js';

export {
  setDefaultPlugin,
  clearDefaultPlugin,
  type PluginSource,
  type TopologyPlugin,
  type ReplSetGetStatus
} from '../../plugins/shared/src/index.js';
