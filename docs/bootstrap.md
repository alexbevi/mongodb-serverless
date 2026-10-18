# Bootstrap without cached topology

A client can discover and route operations without a plugin. It keeps topology
and connections in memory until `close()`. A plugin optionally shares topology
with later client instances.

These diagrams show `disableMonitoring: true`, `maxPoolSize: 1`, and
`minPoolSize: 0` on a healthy replica set. They count TCP connections opened for
bootstrap and sequential operations. Concurrent work, failed seeds, idle socket
replacement, and elections can require more connections.

## Lucky landing: reuse the first connection

The selected member can serve the operation: a primary for a write, or a healthy
secondary for a read. Discovery and the operation use the same authenticated
connection. Reads can also use the primary when no healthy secondary exists.

![Discovery and the operation share one TCP connection](assets/bootstrap-reuse.png)

<details>
<summary>Editable Mermaid</summary>

```mermaid
sequenceDiagram
    participant Driver as ServerlessMongoClient
    participant Seed as Chosen member
    Note over Driver: Resolve seeds and native connection settings<br/>SRV and TXT only for an SRV URI
    Driver->>Seed: Open connection 1; handshake and authenticate
    Driver->>Seed: hello and replSetGetStatus
    Seed-->>Driver: Topology; member can serve the operation
    Driver->>Seed: Run operation on connection 1
    Seed-->>Driver: Result
    Note over Driver,Seed: Retain topology and connection in memory<br/>1 TCP connection; no monitor sockets
```

</details>

## Other member needed: add one connection

The selected member reports topology but has the wrong role for the operation.
The client opens one connection to the required member and retains the first
connection for operations that can use it. Later reads prefer an already
connected healthy secondary.

![Discovery uses connection one and the operation uses connection two](assets/bootstrap-second-member.png)

<details>
<summary>Editable Mermaid</summary>

```mermaid
sequenceDiagram
    participant Driver as ServerlessMongoClient
    participant Seed as Chosen member
    participant Target as Required member
    Note over Driver: Resolve seeds and native connection settings<br/>SRV and TXT only for an SRV URI
    Driver->>Seed: Open connection 1; handshake and authenticate
    Driver->>Seed: hello and replSetGetStatus
    Seed-->>Driver: Topology; another member is needed
    Driver->>Target: Open connection 2 with resolved authentication settings
    Driver->>Target: Run operation on connection 2
    Target-->>Driver: Result
    Note over Driver,Seed: Retain the first connection and topology
    Note over Driver,Target: 2 TCP connections; no monitor sockets
```

</details>

## Configuration

```js
import { MongoClient } from '@mongodb-serverless/driver';

const client = new MongoClient(uri, {
  disableMonitoring: true,
  maxPoolSize: 1,
  minPoolSize: 0
});

try {
  await client.db('app').collection('users').insertOne({ name: 'Ada' });
} finally {
  await client.close();
}
```

Monitoring remains enabled by default. The experimental monitoring patch
supports SCRAM, unauthenticated connections, and TLS. Other authentication
mechanisms use normal monitoring. The one/two-socket count requires monitoring
to be disabled from bootstrap onward; `directConnection` alone does not remove
monitor sockets. Larger pools can open more sockets for concurrent operations.

The native driver's parser and SRV/TXT resolver retain authentication precedence,
TLS defaults, replica-set settings, and DNS host validation. Native clients still
perform handshake and authentication. SRV resolution and the monitoring patch
use internal APIs verified against `mongodb@7.7.0`; stable versions in
`>=7.7.0 <8.0.0` are accepted, with behavior rechecked on upgrades.

Failed seeds are closed before trying another. A failed topology-store write
closes the discovered connection and fails the operation. A successful bootstrap
connection is owned by the wrapper and closes with it. No credentials are
persisted in topology; optional shared records contain only the authentication
mechanism and resolved source alongside replica-set status.

A cached topology skips seed resolution and status discovery. Direct connections
then open only for members needed by operations. Without a plugin, each new
client discovers for itself. Write-error recovery continues to use known members;
see [recovery and plugin behavior](architecture.md#write-failure-and-refresh).

## Verification

Run `pnpm exec vitest run driver/test/bootstrap driver/test/seeds.test.ts`.
The bootstrap suites use real MongoDB servers, command events, and TCP relays
that count actual sockets. Only DNS records are stubbed for SRV tests.

| Case | Assertion |
|---|---|
| Primary landing, first write | Discovery and insert share one socket |
| Secondary landing, first read | Discovery and find share one socket, even when another secondary is listed first |
| Wrong role, first read or write | Two sockets; correct member serves the operation |
| Later reads and writes | Reuse the retained primary and secondary |
| Concurrent first writes | One discovery and one socket with a pool limit of one |
| SRV, TXT, SCRAM and TLS | One authenticated socket; resolved source survives into operations |
| Explicit TLS opt-out | Bootstrap and a new wrapper using cached topology both preserve it |
| Failed handshake | Close the failed client, then try another seed |
| Failed persistence or concurrent close | Close the discovered socket; do not execute the application operation |
| Invalid DNS or URI options | Reject before opening a connection |

The [authentication matrix](authentication-tests.md) separately verifies all
native mechanisms, cached clients, explicit-option precedence, and refresh.
