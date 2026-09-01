const originalKill = process.kill.bind(process);

process.kill = ((pid: number, signal?: NodeJS.Signals | number): boolean => {
  if (pid === -1) {
    throw Object.assign(new Error('Refusing to signal every process owned by this user'), {
      code: 'EPERM',
      syscall: 'kill',
    });
  }
  return originalKill(pid, signal);
}) as typeof process.kill;
