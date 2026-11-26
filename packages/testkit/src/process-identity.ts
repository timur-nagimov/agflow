// Kernel birth times survive exec. ps's second-resolution lstart does not distinguish rapid PID reuse.
import { dlopen, FFIType, ptr } from 'bun:ffi';
import { readdirSync, readFileSync } from 'node:fs';
import type { PsRow } from './process-table';

interface IdentitySource {
  snapshot(): Map<number, string>;
  read(pid: number): string | undefined;
}

export function parseLinuxStartTime(stat: string): string | undefined {
  // comm is parenthesized and may itself contain spaces or parentheses. Field 22 is starttime (clock ticks).
  const end = stat.lastIndexOf(')');
  const start = end < 0 ? undefined : stat.slice(end + 1).trim().split(/\s+/)[19];
  return start && /^\d+$/.test(start) ? `linux:${start}` : undefined;
}

function linuxIdentities(): IdentitySource {
  const read = (pid: number) => {
    try { return parseLinuxStartTime(readFileSync(`/proc/${pid}/stat`, 'utf8')); }
    catch (error) {
      if (['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) return undefined;
      throw error;
    }
  };
  return { read, snapshot: () => collect(readdirSync('/proc').filter(name => /^\d+$/.test(name)).map(Number), read) };
}

function collect(pids: Iterable<number>, read: IdentitySource['read']): Map<number, string> {
  const result = new Map<number, string>();
  for (const pid of pids) {
    if (pid <= 1) continue;
    const identity = read(pid);
    if (identity !== undefined) result.set(pid, identity);
  }
  return result;
}

function darwinIdentities(): IdentitySource {
  const { symbols } = dlopen('/usr/lib/libproc.dylib', {
    proc_listallpids: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    proc_pidinfo: { args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  });
  // Darwin's public sys/proc_info.h: PROC_PIDTBSDINFO=3, sizeof(proc_bsdinfo)=136;
  // pbi_start_tvsec and pbi_start_tvusec are the final two uint64_t fields, at offsets 120 and 128.
  const buffer = new Uint8Array(136);
  const view = new DataView(buffer.buffer);
  const read = (pid: number): string | undefined => {
    if (symbols.proc_pidinfo(pid, 3, 0, ptr(buffer), buffer.length) !== buffer.length) return undefined;
    return `darwin:${view.getBigUint64(120, true)}:${view.getBigUint64(128, true)}`;
  };
  return { read, snapshot() {
    const count = symbols.proc_listallpids(null, 0);
    if (count <= 0) throw new Error('test process cleanup: cannot list kernel process identities');
    const pids = new Int32Array(count + 1024);
    const found = symbols.proc_listallpids(ptr(pids), pids.byteLength);
    if (found <= 0) throw new Error('test process cleanup: cannot read kernel process identities');
    return collect(pids.subarray(0, Math.min(found, pids.length)), read);
  } };
}

let source: IdentitySource | undefined;
function systemIdentities(): IdentitySource {
  if (source) return source;
  if (process.platform === 'darwin') return source = darwinIdentities();
  if (process.platform === 'linux') return source = linuxIdentities();
  throw new Error(`test process cleanup: unsupported process identity platform ${process.platform}`);
}

/** Bracket ps: never attach an old environment/ppid/pgid to a replacement that appeared during the scan. */
export function identifyProcesses(snapshot: () => PsRow[], identities = systemIdentities()): PsRow[] {
  const before = identities.snapshot();
  return snapshot().map(row => {
    const identity = before.get(row.pid);
    // Keep unverifiable rows visible as bystanders: omitting one could make a shared group look wholly owned.
    return { ...row, identity: identity !== undefined && identity === identities.read(row.pid) ? identity : null };
  });
}
