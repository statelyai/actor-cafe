import { expect, test } from 'vitest';
import { selectDelivery } from '../../../../packages/durable/src/rivet/delivery.ts';

const timer = {
  address: 'machine',
  at: 100,
  event: { type: 'xstate.timer' },
  commandId: null,
};
const command = {
  address: 'machine',
  at: 100,
  event: { type: 'submit' },
  commandId: 'request',
};

test('native event time orders a late backlog and a timer wins equal timestamps', () => {
  expect(selectDelivery(timer, { ...command, at: 99 }, 1000)).toBe('message');
  expect(selectDelivery(timer, command, 1000)).toBe('timer');
  expect(selectDelivery(timer, { ...command, at: 101 }, 1000)).toBe('timer');
  expect(selectDelivery(timer, undefined, 99)).toBe('none');
  expect(selectDelivery(undefined, command, 1000)).toBe('message');
});

test('a queue timestamp keeps an earlier timer first even if the runner clock is behind', () => {
  expect(selectDelivery(timer, { ...command, at: 101 }, 90)).toBe('timer');
  expect(selectDelivery(timer, command, 90)).toBe('timer');
  expect(selectDelivery(timer, { ...command, at: 99 }, 90)).toBe('message');
});
