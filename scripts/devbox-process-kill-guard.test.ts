import { expect, test } from 'bun:test';
import './devbox-process-kill-guard';

test('rejects UID-wide process signals before entering kill(2)', () => {
  expect(() => process.kill(-1, 'SIGKILL')).toThrow(
    'Refusing to signal every process owned by this user',
  );
});

test('preserves targeted process signals', () => {
  expect(process.kill(process.pid, 0)).toBe(true);
});
