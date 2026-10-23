import { expect, it } from 'vitest';
import { deploymentResources, endpoints, template } from '../infrastructure.js';

it('defines a Regional API route and Lambda for each example handler', () => {
  expect(endpoints.map(endpoint => `${endpoint.method} /${endpoint.variant}/${endpoint.operation}`)).toEqual([
    'GET /native/find', 'POST /native/save',
    'GET /no-plugin/find', 'POST /no-plugin/save',
    'GET /aws-ssm/find', 'POST /aws-ssm/save'
  ]);

  const api = deploymentResources.find(resource => resource.Type === 'AWS::ApiGateway::RestApi');
  const functions = deploymentResources.filter(resource => resource.Type === 'AWS::Lambda::Function');
  const methods = deploymentResources.filter(resource => resource.Type === 'AWS::ApiGateway::Method');

  expect(api?.Properties?.['EndpointConfiguration']).toEqual({ Types: ['REGIONAL'] });
  expect(functions).toHaveLength(6);
  expect(functions.every(resource => resource.Properties?.['Runtime'] === 'nodejs24.x')).toBe(true);
  expect(methods).toHaveLength(6);
  expect(methods.every(resource => resource.Properties?.['ApiKeyRequired'] === true)).toBe(true);
  expect(template.Parameters.DatabaseName.Default).toBe('bench');
  expect(template.Parameters.CollectionName.Default).toBe('serverless_patterns');
});

it('grants reads of the URI and topology but writes only the topology', () => {
  const role = deploymentResources.find(resource => resource.Type === 'AWS::IAM::Role');
  const policy = JSON.stringify(role);

  expect(policy).toContain('ssm:GetParameters');
  expect(policy).toContain('ssm:PutParameter');
  expect(policy.match(/\$\{ConnectionStringParameterName\}/g)).toHaveLength(1);
  expect(policy.match(/\$\{TopologyParameterName\}/g)).toHaveLength(2);
});
