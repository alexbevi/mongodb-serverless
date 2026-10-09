import { expect, it } from 'vitest';
import { callMethod } from '../src/method.js';

it('dispatches prototype methods with their receiver and original arguments', () => {
  class Receiver {
    readonly prefix = 'result';
    run(input: { value: number }) {
      return { receiver: this, input, value: `${this.prefix}:${input.value}` };
    }
  }

  const target = new Receiver();
  const input = { value: 42 };
  const result = callMethod(target, 'run', [input], 'missing method');

  expect(result.receiver).toBe(target);
  expect(result.input).toBe(input);
  expect(result.value).toBe('result:42');
  expect(() => callMethod(target, 'missing', [], 'missing method')).toThrow('missing method');
  expect(() => callMethod(target, 'prefix', [], 'not callable')).toThrow('not callable');
});
