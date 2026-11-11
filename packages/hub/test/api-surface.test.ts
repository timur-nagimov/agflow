import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { HUB_EVENT_TYPES } from '@agflow/core';
import { createTestHub } from './http-helpers';

/** Design 6.16's routes, as its table lists them. */
const DESIGN_ROUTES = [
  'GET /api/runner/ws',
  'GET /api/runner/whoami',
  'POST /api/runner/attempts/:id/transcript',
  'GET /api/runners',
  'PATCH /api/runners/:id',
  'DELETE /api/runners/:id',
  'POST /api/runner/retire',
  'GET /api/attempts',
  'GET /api/attempts/:id',
  'POST /api/agents/:id/stop',
  'POST /api/agents/:id/replace',
  'POST /api/tasks/:id/takeover',
  'POST /api/tasks/:id/handback',
  'GET /api/approvals',
  'POST /api/approvals/:id',
  'POST /api/staffing',
  'POST /api/tasks/:id/submit',
  'POST /api/agents/:id/interrupt',
  'GET /api/submissions/:id',
  'POST /api/prepare',
  'GET /api/prepare/:id',
  'POST /api/lead/handoff',
  'GET /api/lead/notes',
  'PATCH /api/project',
  'GET /api/status',
  'GET /api/tasks/:id',
];

/** A route with its parameter names left out, so ':id' and ':attemptId' compare equal. */
const shape = (route: string): string => route.replace(/:[A-Za-z]+/g, ':');

/** Every .ts file under the directory, recursively. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

describe('the API surface', () => {
  test('every route of design 6.16 is mounted', () => {
    const hub = createTestHub();
    const mounted = new Set(hub.app.routes.map((route) => shape(`${route.method} ${route.path}`)));
    expect(DESIGN_ROUTES).toHaveLength(26);
    expect(DESIGN_ROUTES.filter((route) => !mounted.has(shape(route)))).toEqual([]);
  });

  test('the hub emits every event type of design 6.17', () => {
    // An emit names its type literally, as `type: '<type>'`; these come from a helper that returns the literal.
    const viaHelper: Record<string, string> = {
      'agent.stalled': 'stopEventType',
      'agent.stopped': 'stopEventType',
      'agent.replaced': 'stopEventType',
    };
    const text = sources(join(import.meta.dir, '../src'))
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');
    /** The return lines of a helper's body, from its declaration to the first line that closes it. */
    const returns = (helper: string): string[] => {
      const start = text.indexOf(`function ${helper}(`);
      if (start < 0) return [];
      const body = text.slice(start, text.indexOf('\n}\n', start));
      return body.split('\n').filter((line) => line.trimStart().startsWith('return') || line.includes(' return '));
    };
    const emitted = (type: string): boolean => {
      const helper = viaHelper[type];
      if (helper === undefined) return text.includes(`type: '${type}'`);
      return text.includes(`type: ${helper}(`) && returns(helper).some((line) => line.includes(`'${type}'`));
    };
    const types = Object.keys(HUB_EVENT_TYPES);
    expect(types).toHaveLength(37);
    expect(Object.keys(viaHelper).filter((type) => !types.includes(type))).toEqual([]);
    expect(types.filter((type) => !emitted(type))).toEqual([]);
  });
});
