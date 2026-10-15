export interface Activity {
  name: string;
  kind: 'sync' | 'async';
  start: number;
  end: number;
}

export function activityRecorder(clock = () => performance.now()) {
  let active = false;
  const spans: Activity[] = [];

  return {
    start() { spans.length = 0; active = true; },
    stop(end: number) {
      active = false;
      return spans.filter(span => span.start < end).map(span => ({ ...span, end: Math.min(span.end, end) }));
    },
    sync<T>(name: string, action: () => T): T {
      if (!active) return action();
      const start = clock();

      try { return action(); }
      finally { spans.push({ name, kind: 'sync', start, end: clock() }); }
    },
    async<T>(name: string, action: () => Promise<T>): Promise<T> {
      if (!active) return action();
      const start = clock();
      const pending = action();
      const finish = () => { if (active) spans.push({ name, kind: 'async', start, end: clock() }); };

      void pending.then(finish, finish);
      return pending;
    }
  };
}

export const activities = activityRecorder();

// The Docker-only source probes call this recorder; production packages are untouched.
Object.assign(globalThis, { __benchmarkActivities: activities });
