// The Claude adapter's barrel (X-44): what the runner, the CLI and the end-to-end suites use of it. The package
// barrel, packages/runner/src/index.ts, stays M2b's; the registry reaches the adapter through entry.ts.
export * from './adapter';
export * from './factory';
export { claudeBinary } from './options';
export * from './paths';
export * from './pin';
export * from './preflight';
export { QuotaBook } from './quota';
export * from './transcript';
