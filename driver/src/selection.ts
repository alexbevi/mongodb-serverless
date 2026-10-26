import type { Topology } from './topology.js';

/** What an operation needs: the primary, a secondary if healthy, or any healthy member. */
export type Route = 'read' | 'write' | 'any';

/** The routes a read can take. */
export type ReadRoute = Exclude<Route, 'write'>;

/** Whether a member reporting this server type can serve the route. */
export function serves(route: Route, type: string): boolean {
  if (route === 'any') return type === 'RSPrimary' || type === 'RSSecondary';

  return type === (route === 'write' ? 'RSPrimary' : 'RSSecondary');
}

/**
 * The member an operation should run on.
 *
 * Writes go to the primary. Reads prefer a secondary that is already connected,
 * then the first healthy one, then the primary. Unrestricted reads reuse any
 * connected member before falling back to the read rule.
 */
export function chooseHost(route: Route, topology: Topology, connected: Iterable<string>): string {
  if (route === 'write') return topology.primary;

  const hosts = [...connected];
  const members = [topology.primary, ...topology.secondaries];

  if (route === 'any') {
    const reusable = hosts.find(host => members.includes(host));

    if (reusable) return reusable;
  }

  return topology.secondaries.find(host => hosts.includes(host)) ?? topology.secondaries[0] ?? topology.primary;
}
