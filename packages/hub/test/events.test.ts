import { describe, expect, test } from 'bun:test';
import type { HubEvent } from '@agflow/core';
import { tx } from '../src/context';
import { listEvents } from '../src/events';
import { createTestContext } from './helpers';

describe('tx and the event log', () => {
  test('events are stored and published after commit', () => {
    const { ctx } = createTestContext();
    const seen: HubEvent[] = [];
    ctx.bus.subscribe((event) => seen.push(event));
    const stored = tx(ctx, (emit) => emit({ type: 'test.happened', actor: 'system', subject: 'X-1', data: { n: 1 } }));
    expect(stored.id).toBe(1);
    expect(seen.map((event) => event.type)).toEqual(['test.happened']);
    expect(listEvents(ctx.db)).toEqual([stored]);
  });

  test('a failed transaction stores and publishes nothing', () => {
    const { ctx } = createTestContext();
    const seen: HubEvent[] = [];
    ctx.bus.subscribe((event) => seen.push(event));
    expect(() =>
      tx(ctx, (emit) => {
        emit({ type: 'test.happened', actor: 'system' });
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(seen).toEqual([]);
    expect(listEvents(ctx.db)).toEqual([]);
  });

  test('listEvents filters by position and subject, oldest first unless latest', () => {
    const { ctx } = createTestContext();
    tx(ctx, (emit) => {
      emit({ type: 'a', actor: 'system', subject: 'T-1' });
      emit({ type: 'b', actor: 'system', subject: 'T-2' });
      emit({ type: 'c', actor: 'system', subject: 'T-1' });
    });
    expect(listEvents(ctx.db, { after: 1 }).map((event) => event.type)).toEqual(['b', 'c']);
    expect(listEvents(ctx.db, { subject: 'T-1' }).map((event) => event.type)).toEqual(['a', 'c']);
    expect(listEvents(ctx.db, { latest: true, limit: 2 }).map((event) => event.type)).toEqual(['c', 'b']);
  });

  test('a throwing listener does not stop the others', () => {
    const { ctx } = createTestContext();
    const seen: string[] = [];
    ctx.bus.subscribe(() => {
      throw new Error('listener bug');
    });
    ctx.bus.subscribe((event) => seen.push(event.type));
    tx(ctx, (emit) => emit({ type: 'ok', actor: 'system' }));
    expect(seen).toEqual(['ok']);
  });

  test('createContext creates the project row from config', () => {
    const { ctx } = createTestContext({ projectName: 'agflow' });
    expect(ctx.db.query('SELECT name FROM project').get()).toEqual({ name: 'agflow' });
  });
});
