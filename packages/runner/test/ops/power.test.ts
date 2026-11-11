import { describe, expect, test } from 'bun:test';
import { RunnerPowerSchema } from '@agflow/core';
import { parsePmsetBatt, parsePmsetSettings, samplePower } from '../../src/ops/power';
import type { Exec, ExecResult } from '../../src/service/system';
import { recordingExec } from '../service-helpers';

const ac = `Now drawing from 'AC Power'
 -InternalBattery-0 (id=22741091)\t100%; charged; 0:00 remaining present: true
`;
const battery = `Now drawing from 'Battery Power'
 -InternalBattery-0 (id=22741091)\t18%; discharging; 0:52 remaining present: true
`;
// pmset prints a UPS under its USB product name.
const ups = `Now drawing from 'UPS Power'
 -Back-UPS ES 700G FW:871.O3 .I USB FW:O3  (id=4456448)\t85%; discharging; (no estimate) present: true
`;
const cyberPower = `Now drawing from 'UPS Power'
 -CP1500PFCLCDa (id=7536640)\t96%; discharging; (no estimate) present: true
`;
const desktop = "Now drawing from 'AC Power'\n";
const settings = `System-wide power settings:
Currently in use:
 standby              1
 Sleep On Power Button 1
 hibernatefile        /var/vm/sleepimage
 powernap             1
 networkoversleep     0
 disksleep            10
 sleep                1 (sleep prevented by powerd)
 hibernatemode        3
 ttyskeepawake        1
 displaysleep         0 (display sleep prevented by Yandex)
 tcpkeepalive         1
 lowpowermode         0
 womp                 1
`;
const cases = [
  { output: ac, source: 'ac', batteryPercent: 100 },
  { output: battery, source: 'battery', batteryPercent: 18 },
  { output: ups, source: 'battery', batteryPercent: 85 },
  { output: cyberPower, source: 'battery', batteryPercent: 96 },
  { output: desktop, source: 'ac', batteryPercent: null },
] as const;

function pmset(batt = ac, general = settings) {
  return recordingExec([
    { argv: ['pmset', '-g', 'batt'], result: { stdout: batt } },
    { argv: ['pmset', '-g'], result: { stdout: general } },
  ]);
}

describe('pmset parsers', () => {
  test('reads recorded AC, battery, UPS and desktop output', () => {
    for (const { output, source, batteryPercent } of cases) {
      expect(parsePmsetBatt(output)).toEqual({ source, batteryPercent });
    }
    expect(parsePmsetBatt(ac.replace('charged;', 'AC attached; not charging;'))).toEqual({
      source: 'ac', batteryPercent: 100,
    });
  });

  test('prefers an internal battery, falls back to UPS, and validates percentages', () => {
    expect(parsePmsetBatt(ups + battery.split('\n')[1]).batteryPercent).toBe(18);
    for (const percent of ['101', '-1', '18.5', 'unknown']) {
      expect(parsePmsetBatt(battery.replace('18%', `${percent}%`)).batteryPercent).toBeNull();
    }
    expect(parsePmsetBatt(battery.replace('18%', '0%')).batteryPercent).toBe(0);
    expect(parsePmsetBatt("Now drawing from 'Other Power'\n")).toEqual({
      source: 'unknown', batteryPercent: null,
    });
  });

  test('reads exact sleep and lowpowermode keys, ignoring prevention annotations', () => {
    expect(parsePmsetSettings(settings)).toEqual({ lowPowerMode: false, sleepMinutes: 1 });
    expect(parsePmsetSettings(' sleep 0\n lowpowermode 1\n')).toEqual({ lowPowerMode: true, sleepMinutes: 0 });
    expect(parsePmsetSettings('disksleep 10\ndisplaysleep 5\nSleep On Power Button 1\n')).toEqual({
      lowPowerMode: false, sleepMinutes: null,
    });
    expect(parsePmsetSettings('')).toEqual({ lowPowerMode: false, sleepMinutes: null });
    expect(parsePmsetSettings(' sleep -1\n')).toEqual({ lowPowerMode: false, sleepMinutes: null });
  });

  test('accepts powermode as a fallback, with lowpowermode taking precedence', () => {
    expect(parsePmsetSettings('powermode 1').lowPowerMode).toBe(true);
    expect(parsePmsetSettings('powermode 2').lowPowerMode).toBe(false);
    expect(parsePmsetSettings('lowpowermode 0\npowermode 1').lowPowerMode).toBe(false);
  });
});

describe('samplePower', () => {
  test('combines schema-valid samples and passes a bounded timeout to both commands', async () => {
    for (const { output, source, batteryPercent } of cases) {
      const exec = pmset(output);
      const sample = await samplePower({ platform: 'darwin', exec });
      expect(sample).toEqual({ source, batteryPercent, lowPowerMode: false });
      expect(RunnerPowerSchema.parse(sample)).toEqual({ source, batteryPercent, lowPowerMode: false });
      expect(exec.calls.map((call) => call.options?.timeoutMs)).toEqual([5_000, 5_000]);
    }
    const sample = await samplePower({ platform: 'darwin', exec: pmset(battery, 'lowpowermode 1') });
    expect(RunnerPowerSchema.parse(sample).lowPowerMode).toBe(true);
  });

  test('starts both commands before waiting for either', async () => {
    const pending: ((result: ExecResult) => void)[] = [];
    const exec: Exec = () => new Promise((resolve) => pending.push(resolve));
    const sample = samplePower({ platform: 'darwin', exec });
    expect(pending).toHaveLength(2);
    pending[0]({ exitCode: 0, stdout: ac, stderr: '', timedOut: false });
    pending[1]({ exitCode: 0, stdout: settings, stderr: '', timedOut: false });
    expect((await sample)?.source).toBe('ac');
  });

  test('returns null off macOS without executing commands', async () => {
    const exec = pmset();
    expect(await samplePower({ platform: 'linux', exec })).toBeNull();
    expect(exec.calls).toEqual([]);
  });

  test('returns null for either failed, timed-out or malformed command, and never throws', async () => {
    for (const argv of [['pmset', '-g', 'batt'], ['pmset', '-g']]) {
      // Failures carry valid output, so only the exit code or the timeout can make the sample null.
      const valid = Bun.deepEquals(argv, ['pmset', '-g', 'batt']) ? ac : settings;
      for (const result of [
        { exitCode: 1, stdout: valid },
        { timedOut: true, stdout: valid },
        { stdout: '' },
        { stdout: 'garbage' },
      ]) {
        const success = pmset();
        const exec: Exec = (args, options) => Bun.deepEquals(args, argv)
          ? recordingExec([], result)(args, options) : success(args, options);
        expect(await samplePower({ platform: 'darwin', exec })).toBeNull();
      }
    }
    const exec = pmset();
    await samplePower({ platform: 'darwin', exec, timeoutMs: 42 });
    expect(exec.calls.map((call) => call.options?.timeoutMs)).toEqual([42, 42]);
    expect(await samplePower({ platform: 'darwin', exec: () => { throw new Error('spawn'); } })).toBeNull();
    expect(await samplePower({ platform: 'darwin', exec: async () => { throw new Error('read'); } })).toBeNull();
  });
});
