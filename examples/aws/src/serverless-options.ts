import type { ServerlessClientOptions } from '@mongodb-serverless/driver';

type CommandStarted = (commandName: string) => void;

export function serverlessClientOptions(commandStarted: CommandStarted): ServerlessClientOptions {
  return {
    disableMonitoring: true,
    maxPoolSize: 1,
    minPoolSize: 0,
    monitorCommands: true,
    on: { commandStarted: event => commandStarted(event.commandName) }
  };
}
