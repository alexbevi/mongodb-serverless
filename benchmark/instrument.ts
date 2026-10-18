import { activities } from './activities.js';
import assert from 'node:assert/strict';
import type { LookupFunction } from 'node:net';
import type { TLSSocket, ConnectionOptions } from 'node:tls';
import type { CommandTrace, RecordedCommand, SocketTrace } from './types.js';
import { createRequire } from 'node:module';
import { ConnectionString } from 'mongodb-connection-string-url';
const require = createRequire(import.meta.url);

interface InstrumentedClient {
  connect(): Promise<unknown>;
  s: { url: string };
  options: { directConnection: boolean; hosts: { toString(): string }[]; replicaSet?: string };
  topology: { description: { type: string; servers: Map<string, unknown> } };
}

interface InstrumentedConnection {
  id: number;
  socket: TLSSocket;
  address: string;
  writeCommand(...args: unknown[]): Promise<unknown>;
  command(ns: unknown, document: Record<string, unknown>, ...args: unknown[]): Promise<unknown>;
}

interface AuthContext { connection: InstrumentedConnection }

interface HelloRole { isWritablePrimary?: boolean; ismaster?: boolean; secondary?: boolean }

export function instrument(mongoOnly = false) {
  const { version } = require('mongodb/package.json') as { version: string };
  if (version !== '7.7.0') throw new Error(`Re-verify benchmark instrumentation for mongodb ${version}`);
  const { MongoClient } = require('mongodb') as { MongoClient: { prototype: InstrumentedClient } };
  const clients = new Set<InstrumentedClient>();
  const originalConnect = MongoClient.prototype.connect;
  MongoClient.prototype.connect = function (...args) {
    clients.add(this);
    return originalConnect.apply(this, args);
  };
  const connections = () => [...clients].map(client => {
    const uri = new ConnectionString(client.s.url);
    uri.username = '';
    uri.password = '';
    return {
      uri: uri.toString(),
      directConnection: client.options.directConnection,
      hosts: client.options.hosts.map(host => host.toString()),
      replicaSet: client.options.replicaSet ?? null,
      topologyType: client.topology.description.type,
      servers: [...client.topology.description.servers.keys()]
    };
  });

  const dns: typeof import('node:dns') = require('node:dns');
  const dnsQueries: { kind: 'SRV' | 'TXT'; start: number; end: number }[] = [];
  const resolve = dns.promises.resolve;

  // SAFETY: Forward every DNS record type unchanged; the overload's result is preserved.
  dns.promises.resolve = ((hostname: string, kind: string = 'A') => {
    const start = performance.now();

    return resolve(hostname, kind).finally(() => {
      if (kind === 'SRV' || kind === 'TXT') dnsQueries.push({ kind, start, end: performance.now() });
    });
  }) as typeof dns.promises.resolve;
  const tls = require('node:tls') as { connect(options: ConnectionOptions & { host: string; port: number }): TLSSocket };
  const { Connection } = require('mongodb/lib/cmap/connection.js') as { Connection: { prototype: InstrumentedConnection } };
  // SAFETY: These provider exports and their auth signature are verified against the pinned driver version.
  const { ScramSHA1, ScramSHA256 } = require('mongodb/lib/cmap/auth/scram.js') as Record<'ScramSHA1' | 'ScramSHA256', { prototype: { auth(context: AuthContext): Promise<void> } }>;
  const sockets = new WeakMap<TLSSocket, SocketTrace>();
  const traceFor = (socket: TLSSocket): SocketTrace => {
    const trace = sockets.get(socket);
    assert.ok(trace, 'Missing socket trace');
    return trace;
  };
  const traces: SocketTrace[] = [];
  const commands: RecordedCommand[] = [];
  const originalTls = tls.connect;
  tls.connect = function (...args) {
    if (mongoOnly && Number(args[0].port) !== 27017) return originalTls.apply(this, args);
    const start = performance.now();
    const trace: SocketTrace = { host: args[0].host, port: args[0].port, start };
    const lookup: LookupFunction = args[0].lookup ?? dns.lookup;

    const options = { ...args[0], lookup: ((hostname, options, callback) => {
      const begin = performance.now();
      lookup(hostname, options, (error, address, family) => {
        trace.lookup = [begin, performance.now()];
        callback(error, address, family);
      });
    }) satisfies LookupFunction };

    const socket = activities.sync("TLS socket/context construction", () => originalTls.call(this, options));
    traces.push(trace);
    sockets.set(socket, trace);
    socket.once('connect', () => { trace.tcp = [trace.lookup?.[1] ?? start, performance.now()]; });
    socket.once('secureConnect', () => {
      if (!trace.tcp) throw new Error('Missing TCP connect event');
      trace.tls = [trace.tcp[1], performance.now()];
      trace.protocol = socket.getProtocol();
      trace.authorized = socket.authorized;
    });
    return socket;
  };

  for (const [Provider, mechanism] of [[ScramSHA1!, 'SCRAM-SHA-1'], [ScramSHA256!, 'SCRAM-SHA-256']] as const) {
    const originalAuth = Provider.prototype.auth;
    Provider.prototype.auth = async function (context) {
      const start = performance.now();
      try { return await originalAuth.call(this, context); }
      finally {
        const trace = traceFor(context.connection.socket);
        trace.auth = [start, performance.now()];
        trace.authMechanism = mechanism;
      }
    };
  }
  const active = new WeakMap<InstrumentedConnection, CommandTrace>();
  const originalWrite = Connection.prototype.writeCommand;
  Connection.prototype.writeCommand = async function (...args) {
    const result = await originalWrite.apply(this, args);
    const command = active.get(this);
    if (command) command.sent = performance.now();
    return result;
  };
  const originalCommand = Connection.prototype.command;
  Connection.prototype.command = async function (ns, document, ...args) {
    const name = Object.keys(document)[0]!;
    const start = performance.now();
    const trace = traceFor(this.socket);
    const command: CommandTrace = { name, start, address: this.address };

    if (name === 'find' || name === 'update') active.set(this, command);
    try {
      const result = await originalCommand.call(this, ns, document, ...args);
      command.end = performance.now();

      if (name === 'hello' || name === 'ismaster') {
        trace.hello ??= [start, command.end];
        // SAFETY: Driver 7.7 returns a document for handshakes and a BSON response with toObject for explicit commands.
        const response = result as HelloRole & { toObject?: () => HelloRole };
        const reply = response.toObject?.() ?? response;
        trace.role = reply.isWritablePrimary || reply.ismaster ? 'PRIMARY' : reply.secondary ? 'SECONDARY' : 'UNKNOWN';
      }
      if (active.get(this) === command) {
        commands.push({ ...command, connectionId: this.id, socket: trace });
      }
      return result;
    } finally { if (active.get(this) === command) active.delete(this); }
  };
  return { traces, commands, version, connections, dns: dnsQueries };
}
