import { createSaveHandler } from '../handlers.js';
import { collection } from './client.js';

export const handler = createSaveHandler(collection);
