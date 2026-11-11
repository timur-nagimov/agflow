// Machine power facts for heartbeats and the idle-sleep setup check (design 6.3, 7.1, 7.9).
import type { Runner } from '@agflow/core';
import { defaultExec, type Exec } from '../service/system';

export type PowerSample = NonNullable<Runner['power']>;

const DRAWING_FROM = /^Now drawing from '([^'\r\n]+)'\s*$/m;
const SETTING = /^\s*(lowpowermode|powermode|sleep)\s+(\d+)(?:\s+\([^\r\n]*\))?\s*$/gm;

export function parsePmsetBatt(output: string): Pick<PowerSample, 'source' | 'batteryPercent'> {
  const name = output.match(DRAWING_FROM)?.[1];
  // A UPS is stored energy too, so the battery guard applies to it.
  const source =
    name === 'AC Power' ? 'ac' : name === 'Battery Power' || name === 'UPS Power' ? 'battery' : 'unknown';
  const percentages = new Map<string, number>();
  for (const line of output.split('\n')) {
    // pmset names a UPS after its USB product string (e.g. 'Back-UPS ES 700G ...'), so any other source is a UPS.
    const match = line.match(/^\s*-(.+?)\s+\(id=[^)]+\)\s+(\d+)%;/);
    if (!match) continue;
    const percent = Number(match[2]);
    const kind = match[1].startsWith('InternalBattery') ? 'internal' : 'ups';
    if (Number.isInteger(percent) && percent <= 100 && !percentages.has(kind)) percentages.set(kind, percent);
  }
  return { source, batteryPercent: percentages.get('internal') ?? percentages.get('ups') ?? null };
}

export function parsePmsetSettings(output: string): { lowPowerMode: boolean; sleepMinutes: number | null } {
  const values = new Map<string, number>();
  for (const match of output.matchAll(SETTING)) {
    const value = Number(match[2]);
    if (Number.isSafeInteger(value)) values.set(match[1], value);
  }
  return {
    lowPowerMode: (values.get('lowpowermode') ?? values.get('powermode')) === 1,
    sleepMinutes: values.get('sleep') ?? null,
  };
}

export async function samplePower(
  options: { exec?: Exec; platform?: NodeJS.Platform; timeoutMs?: number } = {},
): Promise<PowerSample | null> {
  if ((options.platform ?? process.platform) !== 'darwin') return null;
  const exec = options.exec ?? defaultExec;
  const timeoutMs = options.timeoutMs ?? 5_000;
  try {
    const run = async (argv: string[]) => exec(argv, { timeoutMs });
    const [batt, settings] = await Promise.all([run(['pmset', '-g', 'batt']), run(['pmset', '-g'])]);
    if (batt.exitCode !== 0 || settings.exitCode !== 0 || batt.timedOut || settings.timedOut) return null;
    if (!DRAWING_FROM.test(batt.stdout)) return null;
    // Missing keys are normal on some Macs; empty or unrelated output is not a power sample.
    if (
      !/^\s*(?:System-wide power settings:|Currently in use:)\s*$/m.test(settings.stdout) &&
      !settings.stdout.match(SETTING)
    ) {
      return null;
    }
    return { ...parsePmsetBatt(batt.stdout), lowPowerMode: parsePmsetSettings(settings.stdout).lowPowerMode };
  } catch {
    return null;
  }
}
