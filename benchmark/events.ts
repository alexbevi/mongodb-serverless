import { subscribe, unsubscribe, type ChannelListener } from 'node:diagnostics_channel';
import type { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import type { TLSSocket } from 'node:tls';

/**
 * Times a cold operation from driver and socket events alone.
 *
 * Nothing in the driver or Node is replaced. Sockets are observed through the
 * `net.client.socket` diagnostics channel, and each one is matched afterwards to
 * the driver event that opened it: the first socket to the same host and port
 * created after that event.
 */

export type Interval = [number, number];

export interface SocketTiming {
  kind: 'application' | 'monitor';
  host: string;
  port: number;
  start: number;
  lookup?: Interval;
  tcp?: Interval;
  tls?: Interval;
  hello?: Interval;
  auth?: Interval;
  role: string;
  authorized?: boolean;
  protocol?: string | null;
}

export interface CommandTiming {
  name: string;
  start: number;
  end: number;
  socket: SocketTiming | undefined;
}

export interface EventTrace {
  start: number;
  end: number;
  sockets: SocketTiming[];
  commands: CommandTiming[];
  /** The last find or update: the measured operation. */
  command: CommandTiming | undefined;
  /** Waits for a pooled connection, with the `host:port` of the member's pool. */
  checkouts: CheckoutTiming[];
}

export interface CheckoutTiming {
  address: string;
  start: number;
  end: number;
}

/** A native MongoClient; listeners receive it as `this`. */
type DriverClient = EventEmitter;

/** The fields read from the driver's SDAM, CMAP and command events. */
export interface DriverEvent {
  address?: string;
  connectionId?: number | string;
  requestId?: number;
  commandName?: string;
  reply?: { isWritablePrimary?: boolean; secondary?: boolean };
  newDescription?: { type?: string };
}

type DriverListener = (this: DriverClient, event: DriverEvent) => void;

/** What `net.client.socket` publishes. TLS connections publish a TLSSocket. */
interface SocketMessage {
  socket: Socket | TLSSocket;
}

interface ObservedSocket {
  created: number;
  host?: string | undefined;
  port?: number | undefined;
  /** The resolved `ip:port`, which command events report instead of the hostname. */
  resolved?: string | undefined;
  lookup?: number;
  connect?: number;
  secure?: number;
  reply?: number;
  authorized?: boolean | undefined;
  protocol?: string | null | undefined;
}

interface Opening {
  kind: 'application' | 'monitor';
  client: DriverClient;
  address: string;
  connectionId: number | undefined;
  at: number;
  ready?: number;
  role?: string;
  socket?: ObservedSocket | undefined;
}

interface Description {
  address: string;
  type: string;
  at: number;
}

interface PendingCommand {
  client: DriverClient;
  requestId: number;
  name: string;
  address: string;
  connectionId: number;
  start: number;
  end?: number;
}

interface PendingCheckout {
  client: DriverClient;
  address: string;
  start: number;
  end?: number;
}

export function recordEvents(now: () => number = () => performance.now()) {
  // History is kept across measurements, so a warm command can still be traced
  // to the socket a cold one opened. Each trace reports only its own window.
  const sockets: ObservedSocket[] = [];
  const openings: Opening[] = [];
  const descriptions: Description[] = [];
  const commands: PendingCommand[] = [];
  const checkouts: PendingCheckout[] = [];
  let started = 0;

  const onSocket = ({ socket }: SocketMessage) => {
    const observed: ObservedSocket = { created: now() };
    sockets.push(observed);
    socket.once('lookup', (_error: Error | null, _address: string, _family: string | number, host: string) => {
      observed.lookup = now();
      observed.host = host;
    });

    // Listening once for the first reply is passive: the driver pipes the
    // socket into its own parser, and nothing arrives before it sends hello.
    const awaitReply = () => socket.once('data', () => { observed.reply = now(); });

    socket.once('connect', () => {
      observed.connect = now();
      observed.port = socket.remotePort;
      observed.host ??= socket.remoteAddress;
      observed.resolved = `${socket.remoteAddress}:${socket.remotePort}`;

      if (!isTls(socket)) awaitReply();
    });

    if (isTls(socket)) {
      socket.once('secureConnect', () => {
        observed.secure = now();
        observed.authorized = socket.authorized;
        observed.protocol = socket.getProtocol();
        awaitReply();
      });
    }
  };

  // SAFETY: Node publishes `{ socket }` on net.client.socket, with a TLSSocket for TLS connections.
  const listener = onSocket as ChannelListener;
  subscribe('net.client.socket', listener);

  const openingFor = (client: DriverClient, address: string, connectionId: number) =>
    openings.find(opening => opening.kind === 'application' && opening.client === client &&
      opening.connectionId === connectionId && (opening.address === address || opening.socket?.resolved === address));

  const listeners = {
    serverDescriptionChanged(event) {
      if (event.address && event.newDescription?.type) descriptions.push({ address: event.address, type: event.newDescription.type, at: now() });
    },
    serverHeartbeatStarted(event) {
      const address = String(event.connectionId);

      if (!openings.some(opening => opening.kind === 'monitor' && opening.client === this && opening.address === address)) {
        openings.push({ kind: 'monitor', client: this, address, connectionId: undefined, at: now() });
      }
    },
    serverHeartbeatSucceeded(event) {
      const opening = openings.find(opening => opening.kind === 'monitor' && opening.client === this &&
        opening.address === String(event.connectionId) && opening.ready === undefined);

      if (!opening) return;
      opening.ready = now();
      opening.role = event.reply?.isWritablePrimary ? 'PRIMARY' : event.reply?.secondary ? 'SECONDARY' : 'UNKNOWN';
    },
    connectionCreated(event) {
      openings.push({ kind: 'application', client: this, address: String(event.address), connectionId: Number(event.connectionId), at: now() });
    },
    connectionReady(event) {
      const opening = openingFor(this, String(event.address), Number(event.connectionId));

      if (opening) opening.ready = now();
    },
    connectionCheckOutStarted(event) {
      checkouts.push({ client: this, address: String(event.address), start: now() });
    },
    connectionCheckedOut(event) {
      const checkout = checkouts.find(checkout => checkout.client === this && checkout.address === String(event.address) && checkout.end === undefined);

      if (checkout) checkout.end = now();
    },
    commandStarted(event) {
      commands.push({ client: this, requestId: Number(event.requestId), name: String(event.commandName),
        address: String(event.address), connectionId: Number(event.connectionId), start: now() });
    },
    commandSucceeded(event) {
      const command = commands.find(command => command.client === this && command.requestId === Number(event.requestId) && command.end === undefined);

      if (command) command.end = now();
    }
  } satisfies Record<string, DriverListener>;

  return {
    listeners,

    /** Starts a measurement window. */
    reset(start = now()) {
      started = start;
    },

    trace(end = now()): EventTrace {
      assignSockets(openings, sockets);

      const timings = new Map<Opening, SocketTiming>();

      for (const opening of openings) {
        if (!opening.socket) continue;
        const timing = socketTiming(opening, opening.socket, roleAt(descriptions, opening));

        if (timing) timings.set(opening, timing);
      }

      const inWindow = (time: number) => time >= started && time <= end;

      const recorded = commands.flatMap(command => command.end !== undefined && inWindow(command.start)
        ? [{ name: command.name, start: command.start, end: command.end,
            socket: timings.get(openingFor(command.client, command.address, command.connectionId)!) }]
        : []);

      return {
        start: started, end,
        sockets: [...timings.values()].filter(socket => inWindow(socket.start)).sort((a, b) => a.start - b.start),
        commands: recorded,
        command: recorded.findLast(command => command.name === 'find' || command.name === 'update'),
        checkouts: checkouts.flatMap(checkout => checkout.end !== undefined && inWindow(checkout.start)
          ? [{ address: checkout.address, start: checkout.start, end: checkout.end }]
          : [])
      };
    },

    close() {
      unsubscribe('net.client.socket', listener);
    }
  };
}

function isTls(socket: Socket | TLSSocket): socket is TLSSocket {
  return 'encrypted' in socket && socket.encrypted;
}

function assignSockets(openings: Opening[], sockets: ObservedSocket[]): void {
  const taken = new Set<ObservedSocket>();

  for (const opening of [...openings].sort((a, b) => a.at - b.at)) {
    opening.socket = sockets
      .filter(socket => !taken.has(socket) && socket.created >= opening.at && `${socket.host}:${socket.port}` === opening.address)
      .sort((a, b) => a.created - b.created)[0];

    if (opening.socket) taken.add(opening.socket);
  }
}

function roleOf(type: string | undefined): string {
  if (type === 'RSPrimary') return 'PRIMARY';

  return type === 'RSSecondary' ? 'SECONDARY' : 'UNKNOWN';
}

function roleAt(descriptions: Description[], opening: Opening): string {
  if (opening.role) return opening.role;

  const until = opening.ready ?? Number.POSITIVE_INFINITY;

  const latest = descriptions.findLast(description => description.address === opening.address && description.at <= until)
    ?? descriptions.find(description => description.address === opening.address);

  return roleOf(latest?.type);
}

function socketTiming(opening: Opening, socket: ObservedSocket, role: string): SocketTiming | undefined {
  if (socket.host === undefined || socket.port === undefined) return undefined;

  const timing: SocketTiming = { kind: opening.kind, host: socket.host, port: socket.port, start: socket.created, role };
  const connected = socket.connect;
  const handshakeStart = socket.secure ?? connected;

  if (socket.lookup !== undefined) timing.lookup = [socket.created, socket.lookup];

  if (connected !== undefined) timing.tcp = [socket.lookup ?? socket.created, connected];

  if (connected !== undefined && socket.secure !== undefined) timing.tls = [connected, socket.secure];

  if (handshakeStart !== undefined && socket.reply !== undefined) timing.hello = [handshakeStart, socket.reply];

  if (opening.kind === 'application' && socket.reply !== undefined && opening.ready !== undefined) timing.auth = [socket.reply, opening.ready];

  if (socket.authorized !== undefined) timing.authorized = socket.authorized;

  if (socket.protocol !== undefined) timing.protocol = socket.protocol;

  return timing;
}
