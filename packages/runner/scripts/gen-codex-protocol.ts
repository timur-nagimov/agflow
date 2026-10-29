// Regenerates the committed app-server protocol types from the pinned Codex (design 9.1): `bun run gen:codex-protocol`
// after a re-pin, then fix whatever methods.ts and the adapter no longer typecheck against.
//
//   --bin <codex>  the binary to generate with; by default findCodexBinary's (AGFLOW_CODEX_BIN or the runner's vendor
//                  directory). It must print the pinned version.
//   --out <dir>    replaced by the generated files; packages/runner/src/adapters/codex/protocol by default. A
//                  non-empty directory without a VERSION file is not a protocol directory and is never replaced.
//
// The version check and the generator run with scratch HOME and CODEX_HOME directories, so they never read or write
// ~/.codex.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { CODEX_VERSION, codexBinaryVersion, findCodexBinary } from '../src/adapters/codex/binary';

const GENERATE_TIMEOUT_MS = 120_000;

const { values } = parseArgs({
  options: { bin: { type: 'string' }, out: { type: 'string' } },
  strict: true,
});
// Resolved here, since generate-ts runs in a scratch directory.
const out = resolve(values.out ?? join(import.meta.dir, '..', 'src', 'adapters', 'codex', 'protocol'));

function fail(message: string): never {
  console.error(`gen-codex-protocol: ${message}`);
  process.exit(1);
}

if (existsSync(out) && readdirSync(out).length > 0 && !existsSync(join(out, 'VERSION'))) {
  fail(`${out} is not a protocol directory (it has files but no VERSION), so it is not replaced`);
}
const bin = values.bin === undefined ? await findCodexBinary() : resolve(values.bin);
if (!bin) {
  fail(`no codex ${CODEX_VERSION} found: set AGFLOW_CODEX_BIN or run \`bun run vendor:install\``);
}
const version = await codexBinaryVersion(bin);
if (version !== CODEX_VERSION) {
  fail(`${bin} is codex ${version ?? 'of an unreadable version'}, expected ${CODEX_VERSION}`);
}

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'agflow-codex-gen-')));
let failure: string | null = null;
try {
  const home = join(scratch, 'home');
  const codexHome = join(scratch, 'codex-home');
  const staging = join(scratch, 'protocol');
  mkdirSync(home);
  mkdirSync(codexHome);
  const proc = Bun.spawn([bin, 'app-server', 'generate-ts', '--out', staging], {
    cwd: scratch,
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, CODEX_HOME: codexHome, LANG: 'en_US.UTF-8' },
    stdin: 'ignore',
    stdout: 'inherit',
    stderr: 'inherit',
    timeout: GENERATE_TIMEOUT_MS,
  });
  const code = await proc.exited;
  if (code !== 0 || !existsSync(staging)) {
    failure = `codex app-server generate-ts failed (exit ${code})`;
  } else {
    writeFileSync(join(staging, 'VERSION'), `${CODEX_VERSION}\n`);
    rmSync(out, { recursive: true, force: true });
    cpSync(staging, out, { recursive: true });
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
if (failure) fail(failure);
console.log(`gen-codex-protocol: wrote the codex ${CODEX_VERSION} protocol to ${out}`);
