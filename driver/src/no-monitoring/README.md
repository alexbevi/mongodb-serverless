# No monitoring

An opt-in patch for short-lived operations against one MongoDB replica set
member. The verified baseline is `mongodb@7.7.0`. Stable releases in
`>=7.7.0 <8.0.0` are allowed when the internal API checks pass. Private driver
behavior can still change within that range.

## Install

```sh
npm install @mongodb-serverless/driver 'mongodb@^7.7.0'
```

## Usage

Call the helper before connecting. `uri` must name one replica set member.

```js
import { MongoClient } from 'mongodb';
import { disableMonitoring } from '@mongodb-serverless/driver/no-monitoring';

const client = disableMonitoring(new MongoClient(uri, {
  directConnection: true,
  maxPoolSize: 1,
  minPoolSize: 0
}));

try {
  await client.connect();
  await client.db('admin').command({ listDatabases: 1 });
} finally {
  await client.close();
}
```

For the serverless wrapper, set `disableMonitoring: true` instead.

The patch completes the native handshake and authentication on the first
socket, then puts that connection in the application pool. It starts no
heartbeat or RTT sockets, timers, or heartbeat events, regardless of
`serverMonitoringMode`.

Recovery runs on demand against the same host. Pool settings, command events,
and pool events still apply. Minimum-pool maintenance can open application
connections. `close()` never reconnects for session cleanup.

## Limitations

Supports primary and secondary replica set members, SCRAM or no authentication,
and TLS. Rejects standalone, sharded, load-balanced, and automatically encrypted
clients, along with other authentication mechanisms.

There is no discovery or failover. Writes can fail after the selected member
steps down; native retry rules still apply.

The hooks install once per MongoDB module and apply only to opted-in clients.
The client and helper must resolve the same physical `mongodb` installation.
