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
  socket: SocketTrace;
}
