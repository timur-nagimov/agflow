import { describe, expect, test } from 'bun:test';
import { linuxMemory, MemoryAdmission, MEMORY_GB as GB, parseMeminfo } from '../../src/ops/memory';

describe('RAM admission', () => {
  test('reserves growth headroom atomically, rechecks without double charging, releases on completion', () => {
    let availableBytes = 6 * GB;
    const gate = new MemoryAdmission(() => ({}), () => ({ totalBytes: 16 * GB, availableBytes }));
    expect(gate.admit('worker')).toBe(true);
    expect(gate.admit('lead')).toBe(true);
    expect(gate.admit('third')).toBe(false);
    expect(gate.admit('lead')).toBe(true);
    // Actual consumption does not spend the reservations: they protect further growth.
    availableBytes = 5 * GB;
    expect(gate.admit('third')).toBe(false);
    gate.release('worker');
    expect(gate.admit('third')).toBe(false);
    availableBytes = 6 * GB;
    expect(gate.admit('third')).toBe(true);
    gate.release('lead');
    gate.release('lead');
    expect(gate.admit('fourth')).toBe(true);
  });

  test('keeps at least ten percent on large machines and honours configured budgets', () => {
    const gate = new MemoryAdmission(() => ({ memoryReserveGb: 1, memoryPerAgentGb: 3 }),
      () => ({ totalBytes: 100 * GB, availableBytes: 12 * GB }));
    expect(gate.admit('lead')).toBe(false);
    const largerReserve = new MemoryAdmission(() => ({ memoryReserveGb: 8, memoryPerAgentGb: 3 }),
      () => ({ totalBytes: 16 * GB, availableBytes: 10 * GB }));
    expect(largerReserve.admit('worker')).toBe(false);
  });

  test('unknown, invalid and failed measurements close admission; a later reading recovers it', () => {
    for (const sample of [null, { totalBytes: NaN, availableBytes: 1 }, { totalBytes: 1, availableBytes: Infinity },
      { totalBytes: 1, availableBytes: -1 }, { totalBytes: 1, availableBytes: 2 }]) {
      expect(new MemoryAdmission(() => ({}), () => sample).admit('a')).toBe(false);
    }
    let fail = true;
    const gate = new MemoryAdmission(() => ({}), () => {
      if (fail) throw new Error('unavailable');
      return { totalBytes: 8 * GB, availableBytes: 4 * GB };
    });
    expect(gate.admit('a')).toBe(false);
    fail = false;
    expect(gate.admit('a')).toBe(true);
  });
});

function files(values: Record<string, string>) {
  return (path: string): string => {
    if (values[path] === undefined) throw Object.assign(new Error(path), { code: 'ENOENT' });
    return values[path];
  };
}
const meminfo = 'MemTotal:       16000000 kB\nMemFree: 100 kB\nMemAvailable:    12000000 kB\n';

describe('Linux RAM measurements', () => {
  test('uses available RAM rather than free pages, and rejects missing or malformed readings', () => {
    expect(parseMeminfo(meminfo)).toEqual({ totalBytes: 16_000_000 * 1024, availableBytes: 12_000_000 * 1024 });
    expect(parseMeminfo('MemTotal: 10 kB\nMemFree: 2 kB')).toBeNull();
    expect(parseMeminfo('MemTotal: 10 kB\nMemAvailable: 11 kB')).toBeNull();
  });

  test('bounds available memory by both the leaf and a shared parent, even with a larger parent limit', () => {
    expect(linuxMemory(files({
      '/proc/meminfo': meminfo,
      '/proc/self/cgroup': '0::/service/runner',
      '/proc/self/mountinfo': '1 0 0:1 / /sys/fs/cgroup rw - cgroup2 cgroup rw',
      '/sys/fs/cgroup/service/runner/memory.max': String(6 * GB),
      '/sys/fs/cgroup/service/runner/memory.current': String(2 * GB),
      '/sys/fs/cgroup/service/memory.max': String(8 * GB),
      '/sys/fs/cgroup/service/memory.current': String(7 * GB),
    }))).toEqual({ totalBytes: 6 * GB, availableBytes: GB });
  });

  test('supports cgroup v1 and a mount rooted at the container subtree', () => {
    expect(linuxMemory(files({
      '/proc/meminfo': meminfo,
      '/proc/self/cgroup': '2:cpu:/other\n3:memory:/docker/runner',
      '/proc/self/mountinfo': '1 0 0:1 /docker/runner /sys/fs/cgroup/memory rw - cgroup cgroup rw,memory',
      '/sys/fs/cgroup/memory/memory.limit_in_bytes': String(4 * GB),
      '/sys/fs/cgroup/memory/memory.usage_in_bytes': String(3 * GB),
    }))).toEqual({ totalBytes: 4 * GB, availableBytes: GB });
  });

  test('unlimited cgroups use host memory; inaccessible membership fails closed', () => {
    const base = {
      '/proc/meminfo': meminfo,
      '/proc/self/cgroup': '0::/',
      '/proc/self/mountinfo': '1 0 0:1 / /sys/fs/cgroup rw - cgroup2 cgroup rw',
      '/sys/fs/cgroup/memory.max': 'max',
    };
    expect(linuxMemory(files(base))).toEqual(parseMeminfo(meminfo));
    expect(linuxMemory(files({ ...base, '/proc/self/cgroup': '0::/../outside' }))).toBeNull();
    expect(linuxMemory(files({ ...base, '/proc/self/mountinfo': '' }))).toBeNull();
  });
});
