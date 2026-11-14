// One CI shard of the test suite (.github/workflows/ci.yml): the tracked test files, sorted, every Nth one from the
// Kth, run by one `bun test`. Every test file lands in exactly one of the N shards.
//
//   bun scripts/test-shard.ts <shard, 1..N> <N>
const [shard, total] = process.argv.slice(2).map(Number);
if (!Number.isInteger(shard) || !Number.isInteger(total) || total < 1 || shard < 1 || shard > total) {
  console.error('usage: bun scripts/test-shard.ts <shard, 1..N> <N>');
  process.exit(2);
}

// The names bun test looks for, as git pathspecs (a "*" matches across directories).
const patterns = ['test', '_test', '.spec', '_spec'].flatMap((tail) =>
  ['ts', 'tsx', 'js', 'jsx'].map((ext) => `*${tail === 'test' ? '.test' : tail}.${ext}`),
);
const listed = Bun.spawnSync(['git', 'ls-files', '-z', '--', ...patterns]);
if (listed.exitCode !== 0) {
  console.error(listed.stderr.toString());
  process.exit(1);
}
const files = listed.stdout.toString().split('\0').filter(Boolean).sort();
const mine = files.filter((_, at) => at % total === shard - 1);
console.log(`shard ${shard}/${total}: ${mine.length} of ${files.length} test files`);
// With no file at all, bun test would run the whole suite.
if (mine.length === 0) process.exit(0);

// "./" makes each one a path: a bare argument is a filter that matches any path containing it.
const run = Bun.spawnSync(['bun', 'test', ...mine.map((file) => `./${file}`)], {
  stdio: ['inherit', 'inherit', 'inherit'],
});
process.exit(run.exitCode ?? 1);
