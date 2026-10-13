# @mongodb-serverless/driver

## 0.2.0

### Minor changes

- Add an opt-in no-monitoring mode for direct connections. Reuse the authenticated
  handshake socket in the application pool, suppress heartbeat and RTT connections,
  and recover on demand against the same host. Expose the native-client helper at
  `@mongodb-serverless/driver/no-monitoring` and the wrapper's `disableMonitoring`
  option. Use MongoDB 7.7.0 as the verified baseline and allow stable versions in
  `>=7.7.0 <8.0.0` when internal API checks pass.

## 0.1.1

### Patch Changes

- Keep bulk find modifier chains intact through upsert, hint, collation, and arrayFilters.
- Expose cursor properties after the underlying cursor has been created.

## 0.1.0

### Minor Changes

- 83dc718: First release.
  
  The driver replaces `MongoClient` and routes reads to a secondary and writes to
  the primary, using a topology a plugin supplies rather than discovering one on
  connect. `plugin-local` reads that topology from an environment variable.
