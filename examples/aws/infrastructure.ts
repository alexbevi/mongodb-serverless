type HttpMethod = 'GET' | 'POST';

type Variant = 'native' | 'no-plugin' | 'aws-ssm';

type Operation = 'find' | 'save';

type CloudFormationValue = string | number | boolean | CloudFormationObject | CloudFormationValue[];

interface CloudFormationObject {
  [name: string]: CloudFormationValue;
}

export interface Endpoint {
  variant: Variant;
  operation: Operation;
  method: HttpMethod;
  bundle: string;
  functionName: string;
  logicalName: string;
}

export interface CloudFormationResource {
  Type: string;
  Properties?: CloudFormationObject;
  DependsOn?: string | string[];
}

export const endpoints: Endpoint[] = [
  endpoint('NativeFind', 'native', 'find', 'GET'),
  endpoint('NativeSave', 'native', 'save', 'POST'),
  endpoint('NoPluginFind', 'no-plugin', 'find', 'GET'),
  endpoint('NoPluginSave', 'no-plugin', 'save', 'POST'),
  endpoint('AwsSsmFind', 'aws-ssm', 'find', 'GET'),
  endpoint('AwsSsmSave', 'aws-ssm', 'save', 'POST')
];

const variants = [
  { logicalName: 'Native', path: 'native' },
  { logicalName: 'NoPlugin', path: 'no-plugin' },
  { logicalName: 'AwsSsm', path: 'aws-ssm' }
] as const;

const baseResources = {
  ExampleApi: {
    Type: 'AWS::ApiGateway::RestApi',
    Properties: {
      Name: 'mongodb-serverless-examples',
      EndpointConfiguration: { Types: ['REGIONAL'] },
      ApiKeySourceType: 'HEADER'
    }
  },
  LambdaRole: {
    Type: 'AWS::IAM::Role',
    Properties: {
      AssumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [{
          Effect: 'Allow', Principal: { Service: ['lambda.amazonaws.com'] }, Action: ['sts:AssumeRole']
        }]
      },
      Policies: [{
        PolicyName: 'mongodb-serverless-examples',
        PolicyDocument: {
          Version: '2012-10-17',
          Statement: [
            {
              Effect: 'Allow',
              Action: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
              Resource: { 'Fn::Sub': 'arn:${AWS::Partition}:logs:${AWS::Region}:${AWS::AccountId}:*' }
            },
            {
              Effect: 'Allow',
              Action: ['ssm:GetParameter', 'ssm:GetParameters'],
              Resource: [
                { 'Fn::Sub': 'arn:${AWS::Partition}:ssm:${AWS::Region}:${AWS::AccountId}:parameter${ConnectionStringParameterName}' },
                { 'Fn::Sub': 'arn:${AWS::Partition}:ssm:${AWS::Region}:${AWS::AccountId}:parameter${TopologyParameterName}' }
              ]
            },
            {
              Effect: 'Allow',
              Action: 'ssm:PutParameter',
              Resource: { 'Fn::Sub': 'arn:${AWS::Partition}:ssm:${AWS::Region}:${AWS::AccountId}:parameter${TopologyParameterName}' }
            }
          ]
        }
      }]
    }
  }
} satisfies Record<string, CloudFormationResource>;

const variantResources = resourcesFrom(variants.map(variant => [
  `${variant.logicalName}Resource`,
  {
    Type: 'AWS::ApiGateway::Resource',
    Properties: {
      RestApiId: { Ref: 'ExampleApi' },
      ParentId: { 'Fn::GetAtt': ['ExampleApi', 'RootResourceId'] },
      PathPart: variant.path
    }
  }
]));

const routeResources = resourcesFrom(endpoints.flatMap(endpointResources));

const methodNames = endpoints.map(route => `${route.logicalName}Method`);

const resources = {
  ...baseResources,
  ...variantResources,
  ...routeResources,
  ApiDeployment: {
    Type: 'AWS::ApiGateway::Deployment',
    DependsOn: methodNames,
    Properties: { RestApiId: { Ref: 'ExampleApi' } }
  },
  ApiStage: {
    Type: 'AWS::ApiGateway::Stage',
    Properties: {
      RestApiId: { Ref: 'ExampleApi' }, DeploymentId: { Ref: 'ApiDeployment' }, StageName: 'live'
    }
  },
  ApiKey: {
    Type: 'AWS::ApiGateway::ApiKey',
    DependsOn: 'ApiStage',
    Properties: { Enabled: true, Name: 'mongodb-serverless-examples' }
  },
  UsagePlan: {
    Type: 'AWS::ApiGateway::UsagePlan',
    DependsOn: 'ApiStage',
    Properties: {
      UsagePlanName: 'mongodb-serverless-examples',
      ApiStages: [{ ApiId: { Ref: 'ExampleApi' }, Stage: { Ref: 'ApiStage' } }],
      Throttle: { BurstLimit: 20, RateLimit: 10 }
    }
  },
  UsagePlanKey: {
    Type: 'AWS::ApiGateway::UsagePlanKey',
    Properties: { KeyId: { Ref: 'ApiKey' }, KeyType: 'API_KEY', UsagePlanId: { Ref: 'UsagePlan' } }
  }
} satisfies Record<string, CloudFormationResource>;

export const deploymentResources: CloudFormationResource[] = Object.values(resources);

export const template = {
  AWSTemplateFormatVersion: '2010-09-09',
  Description: 'Minimal native and serverless MongoDB Lambda examples',
  Parameters: {
    ConnectionStringParameterName: {
      Type: 'String', Default: '/mongodb-serverless-pattern/uri'
    },
    TopologyParameterName: {
      Type: 'String', Default: '/mongodb-serverless-examples/topology'
    },
    DatabaseName: { Type: 'String', Default: 'bench' },
    CollectionName: { Type: 'String', Default: 'serverless_patterns' }
  },
  Resources: resources,
  Outputs: {
    ApiUrl: {
      Value: { 'Fn::Sub': 'https://${ExampleApi}.execute-api.${AWS::Region}.${AWS::URLSuffix}/live' }
    },
    ApiKeyId: { Value: { Ref: 'ApiKey' } }
  }
};

function endpoint(
  logicalName: string,
  variant: Variant,
  operation: Operation,
  method: HttpMethod
): Endpoint {
  return {
    logicalName,
    variant,
    operation,
    method,
    bundle: `${variant}-${operation}`,
    functionName: `mongodb-serverless-example-${variant}-${operation}`
  };
}

function resourcesFrom(
  entries: Array<[string, CloudFormationResource]>
): Record<string, CloudFormationResource> {
  return Object.fromEntries(entries);
}

function endpointResources(route: Endpoint): Array<[string, CloudFormationResource]> {
  const parent = route.variant === 'native' ? 'Native' : route.variant === 'no-plugin' ? 'NoPlugin' : 'AwsSsm';
  const functionLogicalName = `${route.logicalName}Function`;
  const resourceLogicalName = `${route.logicalName}Resource`;

  return [
    [functionLogicalName, {
      Type: 'AWS::Lambda::Function',
      Properties: {
        FunctionName: route.functionName,
        Description: `${route.variant} ${route.operation} example`,
        Runtime: 'nodejs24.x',
        Architectures: ['arm64'],
        MemorySize: 1769,
        Timeout: 15,
        Handler: 'index.handler',
        Role: { 'Fn::GetAtt': ['LambdaRole', 'Arn'] },
        Code: { ZipFile: "exports.handler = async () => ({ statusCode: 503, body: 'deployment pending' });" },
        Environment: {
          Variables: {
            CONNECTION_STRING_PARAMETER: { Ref: 'ConnectionStringParameterName' },
            TOPOLOGY_PARAMETER: { Ref: 'TopologyParameterName' },
            DATABASE: { Ref: 'DatabaseName' },
            COLLECTION: { Ref: 'CollectionName' },
            COLD_NONCE: 'initial'
          }
        }
      }
    }],
    [resourceLogicalName, {
      Type: 'AWS::ApiGateway::Resource',
      Properties: {
        RestApiId: { Ref: 'ExampleApi' },
        ParentId: { Ref: `${parent}Resource` },
        PathPart: route.operation
      }
    }],
    [`${route.logicalName}Method`, {
      Type: 'AWS::ApiGateway::Method',
      Properties: {
        RestApiId: { Ref: 'ExampleApi' },
        ResourceId: { Ref: resourceLogicalName },
        HttpMethod: route.method,
        AuthorizationType: 'NONE',
        ApiKeyRequired: true,
        Integration: {
          Type: 'AWS_PROXY',
          IntegrationHttpMethod: 'POST',
          Uri: {
            'Fn::Sub': `arn:\${AWS::Partition}:apigateway:\${AWS::Region}:lambda:path/2015-03-31/functions/\${${functionLogicalName}.Arn}/invocations`
          }
        }
      }
    }],
    [`${route.logicalName}Permission`, {
      Type: 'AWS::Lambda::Permission',
      Properties: {
        Action: 'lambda:InvokeFunction',
        FunctionName: { Ref: functionLogicalName },
        Principal: 'apigateway.amazonaws.com',
        SourceArn: {
          'Fn::Sub': `arn:\${AWS::Partition}:execute-api:\${AWS::Region}:\${AWS::AccountId}:\${ExampleApi}/*/${route.method}/${route.variant}/${route.operation}`
        }
      }
    }]
  ];
}
