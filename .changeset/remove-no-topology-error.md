---
"@mongodb-serverless/driver": minor
---

Remove `NoTopologyError`. A plugin returning no topology now triggers discovery,
so nothing raises it.
