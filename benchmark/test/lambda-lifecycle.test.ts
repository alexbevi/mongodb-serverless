import { expect, it } from 'vitest';
import { initializeLazyClient } from '../lambda-lifecycle.js';

it('awaits settings during initialization and retains one lazily created client', async () => {
  let fetched = false;
  let constructions = 0;
  const uri = 'mongodb://example.test/bench';

  const initialize = initializeLazyClient(async () => {
    await Promise.resolve();
    fetched = true;

    return uri;
  }, connectionString => {
    expect(connectionString).toBe(uri);
    constructions += 1;

    return { connected: false, connect() { this.connected = true; } };
  });

  expect(fetched).toBe(false);
  const getClient = await initialize;

  expect(fetched).toBe(true);
  expect(constructions).toBe(0);
  const cold = getClient();
  cold.connect();
  const warm = getClient();

  expect(warm).toBe(cold);
  expect(warm.connected).toBe(true);
  expect(constructions).toBe(1);
});
