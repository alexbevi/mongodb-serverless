import type { ExampleCollection, OperationRunner } from './handlers.js';
import type { ConnectionSettings } from './connection-string.js';

type CommandStarted = (commandName: string) => void;

type CollectionFactory = (commandStarted: CommandStarted) => ExampleCollection;

export async function initializeParameterCollection(
  load: () => Promise<ConnectionSettings>,
  create: (connectionString: string, commandStarted: CommandStarted) => ExampleCollection,
  close: () => Promise<void>
): Promise<OperationRunner> {
  const settings = await load();

  return measured(commandStarted => create(settings.connectionString, commandStarted), close, settings.ssmMs);
}

export async function initializePluginCollection(
  verify: () => Promise<number>,
  create: CollectionFactory,
  close: () => Promise<void>
): Promise<OperationRunner> {
  const ssmMs = await verify();

  return measured(create, close, ssmMs);
}

function measured(create: CollectionFactory, close: () => Promise<void>, ssmMs: number): OperationRunner {
  let collection: ExampleCollection | undefined;
  let operationStarted = 0;
  let commandStarted: number | undefined;

  const observeCommand = (commandName: string) => {
    if (commandStarted === undefined && (commandName === 'find' || commandName === 'update')) {
      commandStarted = performance.now();
    }
  };

  const run: OperationRunner = async operation => {
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

  run.close = async () => {
    collection = undefined;
    await close();
  };

  return run;
}
