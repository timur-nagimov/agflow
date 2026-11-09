// A stand-in for claude in the spawn hook's tests: `bun child.ts <mode>`.
import { writeFileSync, writeSync } from 'node:fs';

const mode = process.argv[2];
switch (mode) {
  case 'inspect':
    // What the hook gave it: the executable, argv, cwd and the whole environment.
    console.log(
      JSON.stringify({
        executable: process.execPath,
        args: process.argv.slice(2),
        cwd: process.cwd(),
        env: process.env,
      }),
    );
    break;
  case 'stderr': {
    // Two megabytes, far past the log's bound, then three lines with a UTF-8 character split across writes and
    // no final newline.
    for (let index = 0; index < 256; index += 1) writeSync(2, `${'x'.repeat(8_191)}\n`);
    const last = Buffer.from('last α\nlast β\nlast γ');
    writeSync(2, last.subarray(0, 6));
    await Bun.sleep(10);
    writeSync(2, last.subarray(6));
    console.log('done');
    break;
  }
  case 'echo':
    for await (const chunk of process.stdin) writeSync(1, chunk);
    process.exitCode = 23;
    break;
  case 'group':
  case 'orphan': {
    // Claude exits 143 on SIGTERM rather than by the signal.
    process.on('SIGTERM', () => process.exit(143));
    // A grandchild in the same process group.
    const member = Bun.spawn(['/bin/sleep', '60'], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
    console.log(member.pid);
    if (mode === 'orphan') process.exit(0);
    setInterval(() => {}, 1_000);
    break;
  }
  case 'heir': {
    // A grandchild that inherits stdout and stderr, so the pipes outlive the leader's exit.
    const heir = Bun.spawn(['/bin/sleep', '60'], { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' });
    console.log(heir.pid);
    process.exit(0);
    break;
  }
  case 'stubborn': {
    // Like a claude in a turn: stdin EOF does not end it, SIGTERM does (exit 143). Its grandchild's pid goes to the
    // file argv[3], because the SDK reads stdout as JSON.
    process.on('SIGTERM', () => process.exit(143));
    const member = Bun.spawn(['/bin/sleep', '60'], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
    writeFileSync(process.argv[3] as string, String(member.pid));
    process.stdin.resume();
    setInterval(() => {}, 1_000);
    break;
  }
  case 'longline':
    // A megabyte of stderr without a newline.
    for (let index = 0; index < 128; index += 1) writeSync(2, 'y'.repeat(8_192));
    writeSync(2, 'the end');
    console.log('done');
    break;
  case 'wait':
    console.log('ready');
    setInterval(() => {}, 1_000);
    break;
  default:
    throw new Error(`unknown child mode: ${mode}`);
}
