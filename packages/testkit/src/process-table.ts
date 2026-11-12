// Test-only ps primitives, intentionally independent of runner modules: the tracking preload also runs in
// ordinary CLI children, where importing the runner would violate the CLI's lazy-loading contract.
export interface PsRow {
  pid: number;
  ppid: number;
  pgid: number;
  stat: string;
  lstart: string;
  command: string;
}

export const PS_COLUMNS = 'pid=,ppid=,pgid=,stat=,lstart=,command=';
export const PS_ENV: Readonly<Record<'LC_ALL' | 'TZ', string>> = { LC_ALL: 'C', TZ: 'UTC' };

const LSTART = '[A-Z][a-z]{2} [A-Z][a-z]{2} [ \\d]\\d \\d{2}:\\d{2}:\\d{2} \\d{4}';
const PS_ROW = new RegExp(`^\\s*(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+(\\S+)\\s+(${LSTART})(?: +(.*))?$`);

export function parsePs(output: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of output.split('\n')) {
    const match = line.match(PS_ROW);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]),
      stat: match[4]!, lstart: match[5]!, command: (match[6] ?? '').trimEnd(),
    });
  }
  return rows;
}

export function sameProcess(a: Pick<PsRow, 'pid' | 'lstart'>, b: Pick<PsRow, 'pid' | 'lstart'>): boolean {
  return a.pid === b.pid && a.lstart === b.lstart;
}
