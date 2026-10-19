# LocalStack integration tests

The `plugin-aws-ssm` CI job runs alongside the Node test jobs and the benchmark
job. It uses LocalStack 4.14.0 with SSM and KMS enabled. The tests send real AWS
SDK requests to the emulator; they do not mock the SDK or deploy Lambda functions.

From the repository root, start LocalStack in one terminal:

```sh
docker run --rm --publish 127.0.0.1:4566:4566 --env SERVICES=ssm,kms \
  localstack/localstack:4.14.0
```

Once LocalStack reports `Ready`, run in another terminal:

```sh
pnpm install --frozen-lockfile
SSM_ENDPOINT=http://127.0.0.1:4566 \
  pnpm --filter @mongodb-serverless/plugin-aws-ssm test:integration
```

Stop the container with Ctrl-C when finished. Each test uses its own parameter
names and deletes them afterward. Credentials and connection strings are test
values. The command fails if `SSM_ENDPOINT` is missing; the ordinary Node test
jobs exclude this suite and still run the plugin's unit and package tests.

The suite checks:

- SecureString decryption and one shared `GetParameters` call for URI and topology.
- Missing topology, creation, refresh, and retrieval by subsequent plugin instances.
- Preservation of authentication metadata and exclusion of extra fields from stored topology.
- Missing or plaintext credentials, credential rotation, and retry after a failed load.
- Malformed topology, read-only stores, and the 4096-byte Standard parameter limit.

LocalStack verifies API behavior. It does not establish production IAM or KMS
policy enforcement, AWS latency, or MongoDB routing correctness. The driver's
replica-set tests and the Lambda benchmark cover those connection paths separately.
