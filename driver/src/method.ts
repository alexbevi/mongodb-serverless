import { ServerlessDriverError } from './errors.js';

export type MethodResult<T> = {
  [K in keyof T]-?: T[K] extends (...args: never[]) => infer R ? R : never;
}[keyof T];

function isCallable<T>(value: T): value is T & Function {
  return typeof value === 'function';
}

export function callMethod<T extends object, K extends keyof T & string>(
  target: T,
  method: K,
  args: unknown[],
  missingMessage: string
): MethodResult<Pick<T, K>>;
export function callMethod<T extends object>(
  target: T,
  method: string,
  args: unknown[],
  missingMessage: string
): MethodResult<T>;
export function callMethod<T extends object>(
  target: T,
  method: string,
  args: unknown[],
  missingMessage: string
): MethodResult<T> {
  // SAFETY: Proxy callers classify method names; the callable check rejects absent members.
  const fn = target[method as keyof T];

  if (!isCallable(fn)) throw new ServerlessDriverError(missingMessage);

  // SAFETY: Proxies forward the arguments from the public method unchanged, with its original receiver.
  const call = fn as (...args: unknown[]) => MethodResult<T>;

  return call.apply(target, args);
}
