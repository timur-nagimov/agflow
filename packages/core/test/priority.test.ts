import { expect, test } from 'bun:test';
import { z } from 'zod';
import { NewTaskSchema, PRIORITY_HELP, TaskPatchSchema } from '../src/schemas';

test('task priority says which way is urgent', () => {
  type Shape = { properties: { priority: { description?: string } } };
  const create = z.toJSONSchema(NewTaskSchema, { io: 'input' }) as unknown as Shape;
  const patch = z.toJSONSchema(TaskPatchSchema, { io: 'input' }) as unknown as Shape;
  expect(PRIORITY_HELP).toBe('0 is the most urgent, 9 the least');
  expect(create.properties.priority.description).toBe(PRIORITY_HELP);
  expect(patch.properties.priority.description).toBe(PRIORITY_HELP);
});
