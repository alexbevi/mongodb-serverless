import { createFindHandler } from '../handlers.js';
import { collection } from './client.js';

export const handler = createFindHandler(collection);
