import type { ExampleCollection, OperationRunner } from './handlers.js';
import type { ConnectionSettings } from './connection-string.js';

type CommandStarted = (commandName: string) => void;

type CollectionFactory = (commandStarted: CommandStarted) => ExampleCollection;

export async function initializeParameterCollection(
  load: () => Promise<ConnectionSettings>,
  create: (connectionString: string, commandStarted: CommandStarted) => ExampleCollection
): Promise<OperationRunner> {
  const settings = await load();

  return measured(commandStarted => create(settings.connectionString, commandStarted), settings.ssmMs);
}

export async function initializePluginCollection(
  verify: () => Promise<number>,
  create: CollectionFactory
): Promise<OperationRunner> {
  const ssmMs = await verify();

  return measured(create, ssmMs);
}

function measured(create: CollectionFactory, ssmMs: number): OperationRunner {
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
      ssmMs,
      connectMs: applicationCommandStarted - operationStarted,
      operationMs: operationFinished - applicationCommandStarted
    };
  };
}
