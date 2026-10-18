# Authentication tests

Run `pnpm exec vitest run driver/test/authentication`. The integration suite needs
Docker and OpenSSL. It starts the shared secure replica-set fixture; no external
identity provider is required.

| Coverage | What runs |
|---|---|
| DEFAULT, SCRAM-SHA-1, SCRAM-SHA-256 | Native authentication and real insert/find operations against the local replica set |
| MONGODB-X509 | A generated client certificate, a `$external` user, native authentication, and real insert/find operations |
| GSSAPI, PLAIN, MONGODB-AWS, MONGODB-OIDC | Native URI/options parsing and TXT resolution; mocked connections and discovery commands |
| Every mechanism, plus no authentication | Separate direct read/write clients, a new wrapper reading serialized topology, and refresh through cached members |

The mocked suite checks complete native credentials and preserves callback
identity, certificate paths, mechanism properties, and explicit source precedence.
It also checks password/callback rotation, mechanism changes, and the native
rejection of AWS credentials embedded in a URI. It does not prove authentication
against a KDC, LDAP server, AWS, or an OIDC provider. Tokens and credential-provider
results remain the native driver's responsibility.

Only DNS responses are stubbed in the integration tests. Discovery connects through
the real native resolver, while cached connections and refresh avoid DNS. The
stored JSON contains only the mechanism and resolved source, alongside topology.

These tests follow the pinned Node.js driver's v7.7.0 test patterns:

- [Authentication prose tests](https://github.com/mongodb/node-mongodb-native/blob/v7.7.0/test/integration/auth/auth.prose.test.ts) exercise SCRAM and mechanism negotiation against a server.
- [DNS seedlist tests](https://github.com/mongodb/node-mongodb-native/blob/v7.7.0/test/integration/initial-dns-seedlist-discovery/initial_dns_seedlist_discovery.prose.test.ts) stub `dns.promises.resolve` while retaining the native resolver.
- [X.509 tests](https://github.com/mongodb/node-mongodb-native/blob/v7.7.0/test/manual/x509_auth.test.ts) use certificates and server commands.
- [OIDC callback tests](https://github.com/mongodb/node-mongodb-native/blob/v7.7.0/test/unit/cmap/auth/mongodb_oidc/automated_callback_workflow.test.ts) use callback and connection stubs.
- [AWS tests](https://github.com/mongodb/node-mongodb-native/blob/v7.7.0/test/integration/auth/mongodb_aws.prose.test.ts) and [Kerberos tests](https://github.com/mongodb/node-mongodb-native/blob/v7.7.0/test/manual/kerberos.test.ts) require configured external environments for live authentication.

Production bootstrap and the mocked suite use the native `resolveSRVRecord`
implementation. Bootstrap resolves settings before opening a direct connection,
so no monitor connections are needed for DNS resolution. Recheck this internal
API and the authentication matrix when upgrading `mongodb`.
