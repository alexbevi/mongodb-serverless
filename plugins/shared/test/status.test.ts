import { expect, it } from 'vitest';
import { Long, Timestamp } from 'mongodb';
import { assertStatus, parseStatus } from '../src/status.js';

it('validates routing fields and preserves the full BSON or JSON status document', () => {
  const status = {
    set: 'rs0',
    members: [{ name: 'a:27017', state: 1, health: 1, uptime: 100 }],
    date: new Date(),
    optimes: { timestamp: new Timestamp({ t: 1, i: 2 }), term: Long.fromNumber(3) },
    extra: { nested: [null, true, 'text'] }
  };

  expect(() => assertStatus(status)).not.toThrow();
  expect(parseStatus(JSON.stringify(status))).toEqual(JSON.parse(JSON.stringify(status)));
  expect(() => assertStatus({ members: [null] })).toThrow(/member/);
  expect(() => assertStatus({ members: [{ name: 42 }] })).toThrow(/member/);
  expect(() => assertStatus({ members: [{ name: 'a:27017', health: 'yes' }] })).toThrow(/member/);
  expect(() => assertStatus({ set: 1, members: [] })).toThrow(/set/);
  expect(() => assertStatus({})).toThrow(/members/);
});
