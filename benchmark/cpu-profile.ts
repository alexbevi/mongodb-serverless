import { Session } from 'node:inspector/promises';

export async function startCpuProfile() {
  const session = new Session();
  session.connect();
  await session.post('Profiler.enable');
  await session.post('Profiler.setSamplingInterval', { interval: 100 });
  const clockOffset = performance.now() - Number(process.hrtime.bigint()) / 1e6;
  await session.post('Profiler.start');

  return async () => {
    try {
      const { profile } = await session.post('Profiler.stop');

      return { profile, origin: profile.startTime / 1000 + clockOffset, samplingIntervalUs: 100 };
    } finally {
      session.disconnect();
    }
  };
}
