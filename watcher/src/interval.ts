import {
  DEFAULT_PLUGIN_CONFIG,
  type ServerlessPlugin,
  type TopologyPlugin
} from '../../plugins/shared/src/index.js';

function hasConfigGetter(plugin: TopologyPlugin): plugin is TopologyPlugin & Pick<ServerlessPlugin, 'get'> {
  return 'get' in plugin && typeof plugin.get === 'function';
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && value > 0;
}

export function refreshIntervalMS(plugin: TopologyPlugin): number {
  const value = hasConfigGetter(plugin) ? plugin.get('refreshIntervalMS') : undefined;

  return isPositiveNumber(value) ? value : DEFAULT_PLUGIN_CONFIG.refreshIntervalMS;
}
