export type Target =
  | { kind: 'lead' }
  | { kind: 'all' }
  | { kind: 'humans' }
  | { kind: 'agent'; id: string }
  | { kind: 'task'; id: string };

export const TARGET_PATTERN = /^(lead|all|humans|agent:A-\d+|task:T-\d+)$/;

export function parseTarget(value: string): Target | null {
  if (!TARGET_PATTERN.test(value)) return null;
  if (value === 'lead') return { kind: 'lead' };
  if (value === 'all') return { kind: 'all' };
  if (value === 'humans') return { kind: 'humans' };
  const [kind, id] = value.split(':') as [string, string];
  return kind === 'agent' ? { kind: 'agent', id } : { kind: 'task', id };
}
