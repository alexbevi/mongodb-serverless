---
"@mongodb-serverless/driver": minor
"@mongodb-serverless/plugin-local": minor
"@mongodb-serverless/plugin-aws-ssm": minor
---

Plugins extending `ServerlessPlugin` are writable unless constructed with
`{ writable: false }`, since discovery writes topology on a cache miss. The
SSM plugin now extends `ServerlessPlugin` too. `connectionStringVariableName`
moves from the shared config to `plugin-local`'s own. Both plugins report
unusable stored settings with the new `PluginConfigurationError`, which the
driver exports. The SSM plugin no longer fetches its settings just to write
topology.
