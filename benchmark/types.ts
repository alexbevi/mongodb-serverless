export type Interval = [number, number];

export interface SocketTrace {
  host: string;
  port: number;
  start: number;
  tcp?: Interval;
  tls?: Interval;
  hello?: Interval;
  auth?: Interval;
  authMechanism?: string;
  protocol?: string | null;
  authorized?: boolean;
  role?: string;
}

export interface CommandTrace {
  name: string;
  start: number;
  address: string;
  sent?: number;
  end?: number;
}

export interface RecordedCommand extends CommandTrace {
  connectionId: number;
  socket: SocketTrace;
}

export interface LifecycleEvent {
  name: string;
  at: number;
  address: string;
  connectionId?: number | string;
  requestId?: number;
  commandName?: string;
  durationMS?: number;
  reason?: string;
}
