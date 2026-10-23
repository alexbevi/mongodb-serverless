import { GetParameterCommand, SSMClient, type GetParameterCommandOutput } from '@aws-sdk/client-ssm';

type SendParameter = (command: GetParameterCommand) => Promise<Pick<GetParameterCommandOutput, 'Parameter'>>;

export interface ConnectionSettings {
  connectionString: string;
  ssmMs: number;
}

export async function loadConnectionString(
  parameterName: string,
  send: SendParameter
): Promise<ConnectionSettings> {
  const started = performance.now();
  const result = await send(new GetParameterCommand({ Name: parameterName, WithDecryption: true }));
  const ssmMs = performance.now() - started;

  if (result.Parameter?.Type !== 'SecureString' || !result.Parameter.Value) {
    throw new Error(`SSM parameter "${parameterName}" must contain a SecureString connection string`);
  }

  return { connectionString: result.Parameter.Value, ssmMs };
}

export async function connectionStringFromSsm(parameterName: string): Promise<ConnectionSettings> {
  const client = new SSMClient({});

  try {
    return await loadConnectionString(parameterName, command => client.send(command));
  } finally {
    client.destroy();
  }
}
