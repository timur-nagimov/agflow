export interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
}

export const stdio: Io = {
  out: (text) => {
    process.stdout.write(text);
  },
  err: (text) => {
    process.stderr.write(text);
  },
};
