import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { CloudFormationClient, CreateStackCommand, UpdateStackCommand, DescribeStacksCommand, waitUntilStackCreateComplete, waitUntilStackUpdateComplete } from '@aws-sdk/client-cloudformation';
import { LambdaClient, GetFunctionConfigurationCommand, CreateFunctionCommand, UpdateFunctionCodeCommand, UpdateFunctionConfigurationCommand, PublishVersionCommand, DeleteFunctionCommand, waitUntilFunctionActiveV2, waitUntilFunctionUpdatedV2 } from '@aws-sdk/client-lambda';
import { SSMClient, PutParameterCommand } from '@aws-sdk/client-ssm';
import { collect, invokeCold, workerNames } from './lambda-collect.mjs';

const { values } = parseArgs({ options: {
  samples: { type: 'string', default: '100' }, output: { type: 'string', default: 'benchmark/results/lambda-aws/samples.json' },
  package: { type: 'string', default: '/tmp/mongodb-pattern-runtime/worker' },
  region: { type: 'string', default: 'ap-southeast-2' },
  'source-function': { type: 'string', default: 'mongodb-serverless-prod-worker-1' },
  prefix: { type: 'string', default: 'mongodb-serverless-pattern' }
} });

const count = Number(values.samples);

assert.ok(Number.isInteger(count) && count > 0 && count <= 1000, 'Use 1–1000 samples per case');

const prefix = values.prefix;

assert.match(prefix, /^mongodb-serverless-pattern(?:-[a-z0-9]+)?$/, 'Use a dedicated benchmark prefix');

const uriParameter = `/${prefix}/uri`;

const topologyParameter = `/${prefix}/topology`;

const options = { region: values.region, maxAttempts: 3 };

const lambda = new LambdaClient(options);

const ssm = new SSMClient(options);

const cloudformation = new CloudFormationClient(options);

const stackName = `${prefix}-permissions`;

const parameterArn = name => ({ 'Fn::Sub': `arn:\${AWS::Partition}:ssm:\${AWS::Region}:\${AWS::AccountId}:parameter${name}` });

const template = {
  AWSTemplateFormatVersion: '2010-09-09',
  Description: 'SSM access for the MongoDB cold Lambda routing benchmark',
  Resources: { WorkerRole: { Type: 'AWS::IAM::Role', Properties: {
    AssumeRolePolicyDocument: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' }] },
    Policies: [{ PolicyName: 'BenchmarkParameters', PolicyDocument: { Version: '2012-10-17', Statement: [
      { Effect: 'Allow', Action: ['ssm:GetParameter', 'ssm:GetParameters'], Resource: [parameterArn(uriParameter), parameterArn(topologyParameter)] },
      { Effect: 'Allow', Action: 'ssm:PutParameter', Resource: parameterArn(topologyParameter) },
      { Effect: 'Allow', Action: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'], Resource: { 'Fn::Sub': `arn:\${AWS::Partition}:logs:\${AWS::Region}:\${AWS::AccountId}:log-group:/aws/lambda/${prefix}-*` } }
    ] } }]
  } } },
  Outputs: { RoleArn: { Value: { 'Fn::GetAtt': ['WorkerRole', 'Arn'] } } }
};

async function deployPermissions() {
  const input = { StackName: stackName, TemplateBody: JSON.stringify(template), Capabilities: ['CAPABILITY_IAM'], Tags: [{ Key: 'Project', Value: 'mongodb-serverless-benchmark' }] };
  let exists = false;

  try { await cloudformation.send(new DescribeStacksCommand({ StackName: stackName })); exists = true; }
  catch (error) { if (!error.message.includes('does not exist')) throw error; }

  if (exists) {
    try {
      await cloudformation.send(new UpdateStackCommand(input));
      await waitUntilStackUpdateComplete({ client: cloudformation, maxWaitTime: 300, minDelay: 3, maxDelay: 5 }, { StackName: stackName });
    } catch (error) { if (!error.message.includes('No updates are to be performed')) throw error; }
  } else {
    await cloudformation.send(new CreateStackCommand(input));
    await waitUntilStackCreateComplete({ client: cloudformation, maxWaitTime: 300, minDelay: 3, maxDelay: 5 }, { StackName: stackName });
  }

  const stack = await cloudformation.send(new DescribeStacksCommand({ StackName: stackName }));

  return stack.Stacks[0].Outputs.find(output => output.OutputKey === 'RoleArn').OutputValue;
}

try {
  const source = await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: values['source-function'] }));
  const uri = source.Environment?.Variables?.MONGODB_URI;
  assert.ok(uri?.startsWith('mongodb+srv://'), 'Source must provide an SRV connection string');
  await ssm.send(new PutParameterCommand({ Name: uriParameter, Type: 'SecureString', Tier: 'Standard', Value: uri, Overwrite: true }));
  const role = await deployPermissions();
  const directory = resolve(values.package);
  const zip = readFileSync(resolve(directory, '../lambda-worker.zip'));
  const variables = { URI_PARAMETER: uriParameter, TOPOLOGY_PARAMETER: topologyParameter, DATABASE: source.Environment.Variables.DATABASE ?? 'bench' };

  for (const name of workerNames(prefix)) {
    let exists = false;

    try { await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: name })); exists = true; }
    catch (error) { if (error.name !== 'ResourceNotFoundException') throw error; }

    const configuration = { FunctionName: name, Role: role, Runtime: 'nodejs24.x', Handler: 'benchmark/dist/lambda-worker.handler', MemorySize: 1769, Timeout: 30, Environment: { Variables: variables }, Description: 'Cold MongoDB routing benchmark; credentials fetched from SSM' };

    if (exists) {
      await lambda.send(new UpdateFunctionCodeCommand({ FunctionName: name, ZipFile: zip, Architectures: ['arm64'] }));
      await waitUntilFunctionUpdatedV2({ client: lambda, maxWaitTime: 120, minDelay: 1, maxDelay: 2 }, { FunctionName: name });
      await lambda.send(new UpdateFunctionConfigurationCommand(configuration));
      await waitUntilFunctionUpdatedV2({ client: lambda, maxWaitTime: 120, minDelay: 1, maxDelay: 2 }, { FunctionName: name });
    } else {
      for (let attempt = 0; ; attempt += 1) {
        try {
          await lambda.send(new CreateFunctionCommand({ ...configuration, Architectures: ['arm64'], Code: { ZipFile: zip }, Tags: { Project: 'mongodb-serverless-benchmark' } }));
          break;
        } catch (error) {
          if (attempt >= 5 || !error.message.includes('cannot be assumed')) throw error;
          await new Promise(resolve => setTimeout(resolve, 3000));
        }
      }

      await waitUntilFunctionActiveV2({ client: lambda, maxWaitTime: 120, minDelay: 1, maxDelay: 2 }, { FunctionName: name });
    }
  }

  const preparationVersion = await lambda.send(new PublishVersionCommand({ FunctionName: `${prefix}-ssm-write` }));
  const preparation = await invokeCold(lambda, `${prefix}-ssm-write`, preparationVersion.Version, { variant: 'ssm', operation: 'write', prepare: true });
  await lambda.send(new DeleteFunctionCommand({ FunctionName: `${prefix}-ssm-write`, Qualifier: preparationVersion.Version }));
  await collect(lambda, prefix, count, resolve(values.output), { environment: 'AWS Lambda', packageSha256: createHash('sha256').update(zip).digest('hex'), region: values.region, architecture: 'arm64', memoryMB: 1769, current: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), preparation, diagnostics: true });
} finally {
  lambda.destroy();
  ssm.destroy();
  cloudformation.destroy();
}
