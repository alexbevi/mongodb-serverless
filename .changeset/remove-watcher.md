---
"@mongodb-serverless/driver": minor
"@mongodb-serverless/plugin-local": minor
---

Discover missing replica-set topology in the driver and persist it through the
plugin. Refresh after topology-related write failures and retry an explicitly
rejected ordinary write once. Remove the watcher and polling configuration.

Plugins may provide a connection string and return null for missing topology.
The local plugin permits writes by default. Discovery requires application
permission to run replSetGetStatus and write the topology store.
