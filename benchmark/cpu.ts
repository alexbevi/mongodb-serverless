import process from 'node:process';

export function threadCpuUsage() {
  if (!process.threadCpuUsage) {
    throw new Error('Thread CPU diagnostics require process.threadCpuUsage; use the Node 24 benchmark container');
  }

  return process.threadCpuUsage();
}
