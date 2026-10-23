import { GetParameterCommand, SSMClient, type GetParameterCommandOutput } from '@aws-sdk/client-ssm';

type SendParameter = (command: GetParameterCommand) => Promise<Pick<GetParameterCommandOutput, 'Parameter'>>;

export async function loadConnectionString(parameterName: string, send: SendParameter): Promise<string> {
  const result = await send(new GetParameterCommand({ Name: parameterName, WithDecryption: true }));

  if (result.Parameter?.Type !== 'SecureString' || !result.Parameter.Value) {
    throw new Error(`SSM parameter "${parameterName}" must contain a SecureString connection string`);
  }

  return result.Parameter.Value;
}

export async function connectionStringFromSsm(parameterName: string): Promise<string> {
  const client = new SSMClient({});

  try {
    return await loadConnectionString(parameterName, command => client.send(command));
  } finally {
    client.destroy();
  }
}
