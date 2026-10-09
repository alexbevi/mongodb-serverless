export function breakdown(start, end, socket, command) {
  const duration = ([a, b]) => b - a;
  const phases = Object.fromEntries(['tcp', 'tls', 'hello', 'auth'].map(key => [key, duration(socket[key])]));
  phases.send = command.sent - command.start;
  phases.receive = command.end - command.sent;
  const total = end - start;
  phases.other = total - Object.values(phases).reduce((sum, value) => sum + value, 0);
  if (Object.values(phases).some(value => !Number.isFinite(value) || value < 0)) {
    throw new Error('Invalid or overlapping benchmark timing intervals');
  }
  return { ...phases, total };
}
