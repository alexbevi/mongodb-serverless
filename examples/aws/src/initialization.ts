import type { ExampleCollection, OperationRunner } from './handlers.js';

type CommandStarted = (commandName: string) => void;

type CollectionFactory = (commandStarted: CommandStarted) => ExampleCollection;

export async function initializeParameterCollection(
  load: () => Promise<string>,
  create: (connectionString: string, commandStarted: CommandStarted) => ExampleCollection
): Promise<OperationRunner> {
  const connectionString = await load();

  return measured(commandStarted => create(connectionString, commandStarted));
}

export async function initializePluginCollection(
  verify: () => Promise<void>,
  create: CollectionFactory
): Promise<OperationRunner> {
  await verify();

  return measured(create);
}

function measured(create: CollectionFactory): OperationRunner {
  let collection: ExampleCollection | undefined;
  let operationStarted = 0;
  let commandStarted: number | undefined;

  const observeCommand = (commandName: string) => {
    if (commandStarted === undefined && (commandName === 'find' || commandName === 'update')) {
      commandStarted = performance.now();
    }
  };

  return async operation => {
    operationStarted = performance.now();
    commandStarted = undefined;
    collection ??= create(observeCommand);
    const result = await operation(collection);
    const operationFinished = performance.now();
    const applicationCommandStarted = commandStarted ?? operationStarted;

    return {
      result,
      ssmMs: 0,
      connectMs: applicationCommandStarted - operationStarted,
      operationMs: operationFinished - applicationCommandStarted
    };
  };
}
