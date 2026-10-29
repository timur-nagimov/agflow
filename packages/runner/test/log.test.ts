import { describe, expect, test } from 'bun:test';
import { memoryLogger, noopLogger } from '../src/log';

describe('Logger', () => {
  test('memoryLogger records messages with their level and fields', () => {
    const logger = memoryLogger();
    logger.debug('tick');
    logger.info('link up', { url: 'ws://hub.test' });
    logger.warn('gap', { ms: 7000 });
    logger.error('push failed', { attemptId: 'T-4-a1', error: 'timeout' });
    expect(logger.entries).toEqual([
      { level: 'debug', message: 'tick', fields: {} },
      { level: 'info', message: 'link up', fields: { url: 'ws://hub.test' } },
      { level: 'warn', message: 'gap', fields: { ms: 7000 } },
      { level: 'error', message: 'push failed', fields: { attemptId: 'T-4-a1', error: 'timeout' } },
    ]);
  });

  test('memoryLogger keeps a copy of the fields it was given', () => {
    const logger = memoryLogger();
    const fields = { n: 1 };
    logger.info('once', fields);
    fields.n = 2;
    expect(logger.entries[0]?.fields).toEqual({ n: 1 });
  });

  test('noopLogger drops everything', () => {
    expect(() => {
      noopLogger.debug('a');
      noopLogger.info('b', { x: 1 });
      noopLogger.warn('c');
      noopLogger.error('d', { y: 2 });
    }).not.toThrow();
  });
});
