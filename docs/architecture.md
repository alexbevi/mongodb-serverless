# Driver discovery and plugin contract

The driver owns discovery and refresh after role mismatches or write failures. Topology stays in memory
for each client; a plugin optionally supplies a connection string and persists
topology across clients. The local implementation uses `process.env`. The
[SSM plugin](../plugins/aws-ssm) shares topology across Lambda instances and reads it
with the SecureString connection string in one request.

## Architecture

Each wrapper owns direct connections to members needed by its operations. On a
cache miss, the native driver resolves the original URI and connection settings,
including SRV/TXT records when applicable. The wrapper tries seeds in random
order, connects directly to one member, validates its status, and retains that
connection for operations. If a different role is needed, it opens a connection
to the appropriate member. Explicit operation-level `nearest` reads reuse either
connected healthy role. Other reads prefer a connected healthy secondary.

See [the two bootstrap diagrams](bootstrap.md) for the one-connection and
two-connection paths. Those counts require `disableMonitoring: true` and one
application socket per member. Monitoring remains enabled by default. The
monitoring patch applies to bootstrap, routed clients, and refresh clients.

Before selecting a connected client for an operation, the wrapper compares its
latest native server description with the cached member role. A mismatch shares
the existing refresh path, persists the corrected topology, and selects again.
Only one refresh is attempted for a role mismatch; a second mismatch fails
before the application operation is sent. A matching handshake adds no explicit
`hello` command. Monitoring-disabled clients do not poll between operations, and
an election can occur after validation.

The facade receives a router for selecting read and write clients and a separate
write executor for handling failures and deciding whether to retry. The client
pair owns topology state and coalesces refresh requests across operations. Each
retry selects its client again using the refreshed topology.

## First use and cached routing

`getConnectionString()` is optional for plugins used with an explicit URI. It
returns the cluster URI, credentials, and URI options from the plugin's existing
configuration or secret store. The driver never copies credentials into topology.
An explicit constructor URI takes precedence. Secret rotation requires a new
wrapper instance; the connection string is resolved once for each wrapper.

`read()` returns `null` only when no topology exists. Authentication, permission,
transport, and malformed-data failures must throw. On a miss, `setup()` must be
idempotent and prepare the topology store if needed. The driver then discovers
and validates status before awaiting `write(status)` and routing the operation.
`verify()` remains an explicit diagnostic operation, not a per-request hook.

With no plugin and an explicit URI, the driver uses no external topology store.
A new wrapper discovers for itself. An explicit plugin overrides a configured
default plugin; either continues to provide caching and optional URI lookup.
A cached status skips DNS resolution and discovery, opening only the direct
connections required by operations.

The driver adds `authentication: { mechanism, source }` to the status document
when the connected native client has credentials. Plugins must preserve this
non-secret metadata when writing and reading topology. Direct read, write, and
refresh clients use the resolved source unless the caller supplies `authSource`.
They retain the original URI and options for passwords, certificates, provider
callbacks, and other authentication properties. Cached routing needs no SRV or
TXT lookup. A different authentication mechanism triggers native discovery.

Keep separate records for different authentication defaults, even within one
cluster. Legacy status documents remain valid. If they depend on a TXT-only
`authSource`, clear the record once to populate the new metadata, or supply
`authSource` explicitly.

## Write failure and refresh

Only topology-related write failures trigger recovery. Duplicate-key, validation,
and authorization errors return directly. Calls in the same wrapper that fail
against the same topology generation share one refresh. Different Lambda
instances can discover concurrently; this contract provides no distributed lock.

A refresh starts at once, tries cached members once each, validates the resulting
status, and awaits persistence before switching routes. The default selection
timeout is five seconds per seed during initial discovery or refresh. An
explicit `serverSelectionTimeoutMS` overrides that timeout.

```mermaid
sequenceDiagram
    participant App
    participant Driver
    participant Old as Old primary
    participant Member as Known member
    participant Plugin
    participant Store as Environment or shared store
    participant New as New primary
    App->>Driver: Write
    Driver->>Old: Attempt 1
    Old-->>Driver: Topology-related error
    Note over Driver: Share one refresh per client
    Driver->>Member: Direct hello and replSetGetStatus
    Member-->>Driver: Validated topology
    Driver->>Member: Close discovery connection
    Driver->>Plugin: write(status)
    Plugin->>Store: Replace topology atomically
    Store-->>Plugin: Persisted
    Plugin-->>Driver: Complete
    alt Ordinary write explicitly rejected before execution
        Driver->>New: Attempt 2, exactly once
        New-->>Driver: Result or final error
        Driver-->>App: Result or final error
    else Network ambiguity, bulk, cursor, or explicit session
        Driver-->>App: Original error, no automatic replay
    end
    Note over Driver,App: Discovery or persistence failure returns the original write error
```

Direct clients keep the native `retryWrites` setting, which is on by default.
The native retry goes back to the same member, so it recovers a dropped
connection but not a primary change. After a failover the native retry is
rejected too, and the wrapper's replay reaches the new primary: up to three
attempts in total. With `retryWrites: false`, only the wrapper's replay remains.
The wrapper replays ordinary promise-returning operations only for a
`MongoServerError` with code 10107 or 13435, or a `NoWritesPerformed` label.
When a native retry after a dropped connection is rejected, the native driver
returns the network error, so the wrapper refreshes topology without replaying.
Bulk builders and cursors never replay automatically, because earlier batches,
results, or writes may already exist. Read failures do not trigger refresh.
An election that outlasts this recovery attempt remains a caller-visible error.

## Expected plugin implementations

| Concern | Local plugin | Expected deployment plugin |
|---|---|---|
| URI and credentials | Environment variable | Secret store or deployment configuration |
| Topology read | Parse environment JSON; missing means `null` | Read a cluster-specific item; missing means `null` |
| Setup | No operation | Idempotent provisioning, or validate pre-provisioned storage |
| Topology write | Replace environment JSON | Atomically replace the cluster-specific document |
| Permissions | Process environment access | Secret read, topology read/write, and any setup permissions |
| Persistence | Current process only | Shared across cold starts and instances |

A store must not expose a partially written document. Plugin authors should
consider conditional writes using replica-set election metadata to avoid older
discoveries overwriting newer ones. The current contract does not provide
compare-and-swap or return an accepted topology from `write()`: coherence across
concurrent writers is best effort, and a later failure can trigger another refresh.
Keep credentials out of topology records and logs; the secret store remains the
authoritative source. Configure a separate key for each cluster.

Plugins are validated structurally. `setup`, `verify`, `read`, and `write` must be
functions; `name`, `version`, and `author` must be strings. Extending
`ServerlessPlugin` is optional. A subclass used for discovery must enable writes
in its constructor. Shared contract source compiles into each package and is not
published as a separate dependency.

## Migration and review notes

- Remove the watcher deployment and its polling configuration. The watcher package
  and `refreshIntervalMS` are removed from this workspace.
- Give the application identity permission to run `hello` and `replSetGetStatus`,
  and, when using a plugin, to write topology through it. Existing read-only deployments need
  permission changes before adopting discovery.
- Update plugins to return `null` for a missing topology. Existing plugins that
  return a populated status and use an explicit URI remain structurally compatible.
- A shared topology store can skip discovery across Lambda cold starts. It is
  optional. Updating `process.env` does not persist across cold starts.
- Replica sets only: no sharded or load-balanced clusters, change streams, or
  sessions spanning clients. Refresh updates future routing; existing cursors and
  bulk builders remain bound to the client that created them.
- Existing direct clients remain open until wrapper `close()`, including members
  no longer selected after refresh. This avoids interrupting in-flight operations.
