# @mongodb-serverless/plugin-local

## 0.1.0

### Minor Changes

- 83dc718: First release.
  
  The driver replaces `MongoClient` and routes reads to a secondary and writes to
  the primary, using a topology a plugin supplies rather than discovering one on
  connect. `plugin-local` reads that topology from an environment variable.
