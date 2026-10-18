# Operation preferences

This compares MongoDB Node.js driver 7.7.0 using normal replica-set discovery
with this wrapper after cached-role validation. The five read-preference rows
assume an explicit operation option on a supported collection read. Other
option locations and command types are listed separately.

Role validation checks the selected member against cached topology. It does not
implement all native read-preference semantics. The default secondary-first
policy and the gaps below predate this PR.

| Preference or option | Native MongoDB driver | ServerlessMongoClient |
|---|---|---|
| No read preference supplied | Read from the primary | Prefer a healthy secondary; fall back to the primary |
| `primary` | Select the primary; wait or fail if none is available | Select the cached primary; validate its reported role and refresh once on mismatch. Direct connections still send `primaryPreferred` on the wire, so an election after validation can allow a secondary read |
| `primaryPreferred` | Prefer the primary; otherwise select an eligible secondary | Select the cached primary. A topology without a healthy primary is rejected; secondary fallback is missing |
| `secondary` | Select an eligible secondary; wait or fail if none is available | Validate the selected cached secondary, but still fall back to the primary when no healthy secondary is listed |
| `secondaryPreferred` | Prefer an eligible known secondary; otherwise use the primary | Prefer an already connected cached secondary, then the first healthy cached secondary, then the primary. Tags, staleness, and read-connection failure fallback are incomplete |
| `nearest` | Select an eligible primary or secondary within the latency window | Use secondary-first routing; no comparison of member latency |
| Tag sets / `readPreferenceTags` | Filter eligible members using the ordered tag sets, subject to the mode's fallback rules | Not applied when choosing the direct host; unmatched tags can still produce a read |
| `maxStalenessSeconds` | Filter secondaries using the driver's staleness estimate | Not applied when choosing the direct host |
| `localThresholdMS` | Define the acceptable latency window among eligible members | Passed to native clients, but each has one host; the wrapper does not compare members |
| `hedge` | Pass the option to mongos for deployments/server versions that support hedged reads | Sharded clusters and mongos are outside the wrapper's supported scope |
| Read preference in URI or client options | Inherited by reads unless overridden | Passed to native clients, but not used by the wrapper's host-selection decision |
| Database or collection options | Preserve and inherit read preference and concerns | Options supplied to `db(name, options)` or `collection(name, options)` are discarded |
| Cursor `withReadPreference()` | Affects selection when the cursor executes | Replayed after the wrapper has selected a direct client; does not change that host |
| `readConcern`: `local`, `available`, `majority`, `linearizable`, `snapshot` | Pass to the server; the operation, server, and session rules determine which levels are valid | Client/operation settings are delegated to the native driver; database/collection settings are discarded. Read concern does not influence wrapper routing, and wrapper sessions are unsupported |
| Ordinary inserts, updates, and deletes | Execute on the primary, regardless of read preference | Select the cached primary and validate its reported role before sending; existing write-error recovery handles eligible failures |
| `writeConcern`: `w`, `j`, `wtimeoutMS`, set on client or operation | Control acknowledgement, journaling, and acknowledgement timeout | Passed through to the native driver; observed on real insert commands |
| Write concern set on database or collection | Inherited by operations | Discarded with the database/collection options |
| `w: 0` | Unacknowledged write; no confirmation of server-side success | Passed through. Without acknowledgement, the wrapper cannot depend on a server error to detect a stale primary |
| Read preference on `Db.command` | Use the explicit preference for the generic command | Always classified onto the primary route |
| Read preference on `runCursorCommand` | Use a `ReadPreference` object or `withReadPreference()`. In 7.7.0, a string in the constructor options is ignored and defaults to primary | Always classified onto the primary route |
| Read preference on aggregation ending in `$out` / `$merge` | On supported servers, the read phase may run on a secondary and writes reach the primary | Classified onto the primary route; both differences were reproduced against the local server |

The role check uses native server-description events. Matching roles add no
explicit `hello`. A mismatch reruns discovery and awaits the plugin's write
before selecting again; a second mismatch fails before the application command.
With monitoring disabled, reused connections are not polled for role changes.
An election can still occur between validation and execution.

The wrapper also scans all operation arguments for `readPreference`; a query
field with that name can be mistaken for an option. This remains a separate
routing issue.

The native baseline for this comparison uses replica-set selection.
`directConnection: true` has different semantics: native Single-topology selection
ignores read preference and permits primary reads on a secondary by sending
`primaryPreferred` on the wire. Passing options through to a direct client does
not by itself preserve replica-set selection behavior.

Sources: [read preferences](https://www.mongodb.com/docs/manual/core/read-preference/),
[server selection](https://specifications.readthedocs.io/en/latest/server-selection/server-selection/),
[read and write concern](https://specifications.readthedocs.io/en/latest/read-write-concern/read-write-concern/),
and the pinned native driver's `ReadPreference` and command implementation.

## Tests

`driver/test/preferences/integration.test.ts` runs 82 scenarios against a real
three-member replica set. Each has a native-driver baseline and wrapper checks
with monitoring enabled and disabled: 246 checks in total. Command events prove
which member receives the operation and which read/write concerns reach the wire.
The cases cover all five read modes as strings and objects; URI, client, database,
collection, cursor, and operation settings; inserts, updates, deletes; generic
commands; and aggregation with `$out` or `$merge`.

`driver/test/preferences/selection.test.ts` compares 45 deterministic topology
scenarios with the pinned native driver's actual server selector. It covers
missing primaries and secondaries, ordered tags, staleness, and latency windows.
Synthetic server descriptions avoid changing the live cluster's timing or
replication state. These checks validate selection, not network behavior.

`driver/test/roles/integration.test.ts` exercises stale cached roles for all five
read modes, with monitoring enabled and disabled. It verifies concurrent refresh,
persistence, and the next cold start against real command destinations. Existing
write-recovery tests cover a stale primary before an insert.

The preference suites contain **73 expected failing assertions across 49
scenarios**: 24 live scenarios fail in both monitoring modes, and 25 synthetic
scenarios fail once. They assert native behavior using `it.fails`; an unexpected
pass requires removing the known-gap marker. Fixture, connection, and
authentication errors are checked separately so they cannot satisfy a known gap.
These tests document incomplete parity, not completed fixes.

Run the matrix normally:

```sh
pnpm exec vitest run driver/test/preferences driver/test/roles/integration.test.ts
```

To reproduce every known difference as a failing assertion:

```sh
MONGODB_NATIVE_PARITY=1 pnpm exec vitest run driver/test/preferences
```

The strict run currently reports 264 passes and 73 failures. All native baselines
pass; the failures are wrapper differences. The normal run reports the same 337
checks as satisfied, including those 73 expected failures.
