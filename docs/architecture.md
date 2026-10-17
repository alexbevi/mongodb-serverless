# Driver discovery and plugin contract

The driver owns discovery and exception-driven refresh. A plugin supplies a
connection string and persists topology. The local implementation stores topology
in `process.env`; a deployment plugin should use a durable shared store. There is
no AWS plugin in this change.

## Architecture

Each wrapper owns lazy direct read and write clients. Discovery uses a temporary
direct connection, tries candidates sequentially, and closes each connection.
There is no polling service. Native SDAM monitoring on routed clients remains
on unless `disableMonitoring: true` is selected.

```mermaid
flowchart LR
    App[Application or Lambda] --> Driver[Serverless driver]
    Driver <-->|URI and cached topology| Plugin[Topology plugin]
    Driver -->|Persist discovered topology| Plugin
    Plugin <-->|Local implementation| Env[Process environment]
    Plugin <-->|Expected deployment implementation| Store[Shared topology store]
    Plugin -->|Read connection string| Secret[Secret store]
    Driver -->|Temporary direct discovery| Member[One replica-set member]
    Driver -->|Writes| Primary[Primary direct client]
    Driver -->|Reads| Secondary[Secondary direct client]
```

![Architecture diagram](assets/architecture.png)

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

```mermaid
sequenceDiagram
    participant App
    participant Driver
    participant Plugin
    participant Store as Environment or shared store
    participant DNS
    participant Member as Replica-set member
    App->>Driver: First operation
    opt No explicit URI
        Driver->>Plugin: getConnectionString()
        Plugin->>Store: Read URI or secret reference
        Store-->>Plugin: Cluster URI and credentials
        Plugin-->>Driver: URI
    end
    Driver->>Plugin: read()
    Plugin->>Store: Read topology
    alt Topology missing
        Store-->>Plugin: Missing
        Plugin-->>Driver: null
        opt SRV URI
            Driver->>DNS: Resolve TXT and SRV
            DNS-->>Driver: Validated member candidates and options
        end
        Driver->>Plugin: setup()
        Plugin->>Store: Prepare store idempotently
        Driver->>Member: Direct connect, hello, replSetGetStatus
        Member-->>Driver: Replica-set status
        Driver->>Member: Close discovery connection
        Driver->>Plugin: write(validated status)
        Plugin->>Store: Replace topology atomically
        Store-->>Plugin: Persisted
        Plugin-->>Driver: Complete
    else Cached topology
        Store-->>Plugin: Status
        Plugin-->>Driver: Status
        Note over Driver,DNS: SRV URIs still resolve TXT options once per client
    end
    Driver->>Member: Direct operation on selected primary or secondary
    Member-->>Driver: Result
    Driver-->>App: Result
```

![First use diagram](assets/first-use.png)

## Write failure and refresh

Only topology-related write failures trigger recovery. Duplicate-key, validation,
and authorization errors return directly. Calls in the same wrapper that fail
against the same topology generation share one refresh. Different Lambda
instances can discover concurrently; this contract provides no distributed lock.

A refresh waits 100–249 ms, tries cached members once each, validates the resulting
status, and awaits persistence before switching routes. Discovery's default
selection timeout is five seconds per candidate. An explicit
`serverSelectionTimeoutMS` overrides that timeout.

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
    Note over Driver: Share refresh and back off 100–249 ms
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

![Recovery diagram](assets/recovery.png)

Native write retries are disabled underneath the wrapper to keep the total at
two attempts. Ordinary promise-returning operations can replay only for a
`MongoServerError` with code 10107 or 13435, or a `NoWritesPerformed` label.
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
  and to write topology through its plugin. Existing read-only deployments need
  permission changes before adopting discovery.
- Update plugins to return `null` for a missing topology. Existing plugins that
  return a populated status and use an explicit URI remain structurally compatible.
- Use a shared topology store for Lambda. Updating `process.env` does not persist
  across cold starts.
- Replica sets only: no sharded or load-balanced clusters, change streams, or
  sessions spanning clients. Refresh updates future routing; existing cursors and
  bulk builders remain bound to the client that created them.
- Existing direct clients remain open until wrapper `close()`, including members
  no longer selected after refresh. This avoids interrupting in-flight operations.
