import assert from 'node:assert/strict';
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
  socket: TLSSocket;
  address: string;
  writeCommand(...args: unknown[]): Promise<unknown>;
  command(ns: unknown, document: Record<string, unknown>, ...args: unknown[]): Promise<unknown>;
}

interface AuthContext { connection: InstrumentedConnection }

export function instrument() {
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
  const tls = require('node:tls') as { connect(options: ConnectionOptions & { host: string; port: number }): TLSSocket };
  const { Connection } = require('mongodb/lib/cmap/connection.js') as { Connection: { prototype: InstrumentedConnection } };
  const { ScramSHA256 } = require('mongodb/lib/cmap/auth/scram.js') as { ScramSHA256: { prototype: { auth(context: AuthContext): Promise<unknown> } } };
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
    const start = performance.now();
    const socket = originalTls.apply(this, args);
    const trace: SocketTrace = { host: args[0].host, port: args[0].port, start };
    traces.push(trace);
    sockets.set(socket, trace);
    socket.once('connect', () => { trace.tcp = [start, performance.now()]; });
    socket.once('secureConnect', () => {
      if (!trace.tcp) throw new Error('Missing TCP connect event');
      trace.tls = [trace.tcp[1], performance.now()];
      trace.protocol = socket.getProtocol();
      trace.authorized = socket.authorized;
    });
    return socket;
  };
  const originalAuth = ScramSHA256.prototype.auth;
  ScramSHA256.prototype.auth = async function (context) {
    const start = performance.now();
    try { return await originalAuth.call(this, context); }
    finally { traceFor(context.connection.socket).auth = [start, performance.now()]; }
  };
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
    if (name === 'find' || name === 'insert') active.set(this, command);
    try {
      const result = await originalCommand.call(this, ns, document, ...args);
      command.end = performance.now();
      if (name === 'hello' || name === 'ismaster') trace.hello = [start, command.end];
      if (active.get(this) === command) commands.push({ ...command, socket: trace });
      return result;
    } finally { if (active.get(this) === command) active.delete(this); }
  };
  return { traces, commands, version, connections };
}
