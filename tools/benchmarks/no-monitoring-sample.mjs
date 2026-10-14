import { MongoClient } from 'mongodb';

const [mode, uri, ca, warmCount] = process.argv.slice(2);

const client = new MongoClient(uri, {
  directConnection: true,
  maxPoolSize: 1,
  minPoolSize: 0,
  retryReads: false,
  retryWrites: false,
  serverMonitoringMode: 'poll',
  authMechanism: 'SCRAM-SHA-256',
  tls: true,
  tlsCAFile: ca
});

if (mode === 'polyfill') {
  const { disableMonitoring } = await import('../../driver/dist/driver/src/no-monitoring/index.js');
  disableMonitoring(client);
}

try {
  const started = performance.now();
  await client.connect();
  const connected = performance.now();
  await client.db('admin').command({ listDatabases: 1 });
  const finished = performance.now();
  process.send?.({ connectMS: connected - started, firstOperationMS: finished - started });
  const warmMS = [];

  for (let sample = 0; sample < Number(warmCount); sample++) {
    const before = performance.now();
    await client.db('admin').command({ listDatabases: 1 });
    warmMS.push(performance.now() - before);
  }

  process.send?.({ warmMS });
} finally {
  await client.close();
}
