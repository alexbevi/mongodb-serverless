import { createHook, executionAsyncId, executionAsyncResource } from 'node:async_hooks';
import { threadCpuUsage } from 'node:process';

interface Resource {
  resource: string;
  source: string;
}

interface ExecutionSegment extends Resource {
  kind: 'callback' | 'dispatch';
  start: number;
  end: number;
  threadCpuMs: number;
}

export function executionRecorder() {
  const resources = new Map<number, Resource>();
  const segments: ExecutionSegment[] = [];
  const stack: Resource[] = [];
  let start = 0;
  let boundary = 0;
  let cpuStart = { user: 0, system: 0 };
  let cpuBoundary = cpuStart;
  let enabled = false;
  const handler = { resource: 'HANDLER', source: 'benchmark handler invocation' };

  function transition(next: Resource, entering: boolean) {
    const now = performance.now();
    const cpu = threadCpuUsage();
    const current = stack.at(-1);

    segments.push({
      ...(current ?? next),
      kind: current ? 'callback' : 'dispatch',
      start: boundary,
      end: now,
      threadCpuMs: (cpu.user + cpu.system - cpuBoundary.user - cpuBoundary.system) / 1000
    });
    boundary = now;
    cpuBoundary = cpu;

    if (entering) stack.push(next);
    else stack.pop();
  }

  const hook = createHook({
    init(id, resource, trigger) {
      if (!enabled) return;

      const frames = new Error().stack?.split('\n').slice(1).filter(line =>
        !line.includes('/execution.') && !line.includes('node:internal/async_hooks') &&
        !line.includes('node:internal/promise_hooks')) ?? [];
      resources.set(id, { resource, source: frames.slice(0, 6).join('\n') || resources.get(trigger)?.source || handler.source });
    },
    before(id) {
      if (!enabled) return;

      const resource = resources.get(id) ?? { resource: executionAsyncResource().constructor.name, source: "Resource created before the measured handler" };

      transition(resource, true);
    },
    after() {
      if (enabled) transition(stack.at(-1) ?? handler, false);
    },
    destroy(id) { resources.delete(id); }
  });

  return {
    start() {
      segments.length = 0;
      stack.length = 0;
      resources.clear();
      resources.set(executionAsyncId(), handler);
      stack.push(handler);
      enabled = true;
      hook.enable();
      cpuStart = threadCpuUsage();
      cpuBoundary = cpuStart;
      start = performance.now();
      boundary = start;

      return start;
    },
    invoke<T>(action: () => T): T {
      try { return action(); }
      finally { transition(handler, false); }
    },
    stop() {
      transition(stack.at(-1) ?? handler, false);
      enabled = false;
      hook.disable();

      return {
        start,
        end: boundary,
        threadCpuMs: (cpuBoundary.user + cpuBoundary.system - cpuStart.user - cpuStart.system) / 1000,
        segments
      };
    }
  };
}
