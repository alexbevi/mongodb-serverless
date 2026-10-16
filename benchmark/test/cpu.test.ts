import process from 'node:process';
import { expect, test } from 'vitest';
import { threadCpuUsage } from '../cpu.js';

test('reports unsupported thread diagnostics without substituting process CPU', () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'threadCpuUsage');
  Object.defineProperty(process, 'threadCpuUsage', { value: undefined, configurable: true });

  try {
    expect(() => threadCpuUsage()).toThrow('Thread CPU diagnostics require process.threadCpuUsage');
  } finally {
    if (descriptor) Object.defineProperty(process, 'threadCpuUsage', descriptor);
    else Reflect.deleteProperty(process, 'threadCpuUsage');
  }
});
