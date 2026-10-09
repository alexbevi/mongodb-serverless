import { validatePlugin } from '../../../plugins/shared/src/resolver.js';
import type { TopologyPlugin } from '../../../plugins/shared/src/plugin.js';

declare const candidate: unknown;

// @ts-expect-error Unvalidated input cannot be used as a plugin.
const unvalidated: TopologyPlugin = candidate;

validatePlugin(candidate, 'fixture');

const validated: TopologyPlugin = candidate;

void [unvalidated, validated];
