// Bun imports these files `with { type: 'file' }`: as a path, which `bun build --compile` embeds in the binary.
declare module '@anthropic-ai/sandbox-runtime/vendor/seccomp/*/apply-seccomp' {
  const path: string;
  export default path;
}
