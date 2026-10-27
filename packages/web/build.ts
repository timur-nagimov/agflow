/**
 * Builds the web UI into dist/, which the hub serves when AGFLOW_WEB_DIST points at it.
 *
 * Bun's CSS bundler inlines every url() asset, which would put all fonts into the stylesheet. So the
 * fonts are copied into dist/fonts with their own stylesheet, and index.html links to it after the
 * bundle is written. Only Latin and Cyrillic subsets are kept; other scripts use fallback fonts.
 */
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const root = import.meta.dir;
const dist = join(root, 'dist');

const FONT_STYLESHEETS = [
  '@fontsource/ibm-plex-sans/400.css',
  '@fontsource/ibm-plex-sans/500.css',
  '@fontsource/ibm-plex-sans/600.css',
  '@fontsource/ibm-plex-mono/400.css',
  '@fontsource/ibm-plex-mono/500.css',
  '@fontsource-variable/literata/opsz.css',
  '@fontsource-variable/literata/opsz-italic.css',
];
const SKIPPED_SUBSETS = /-(greek|greek-ext|vietnamese)-/;

function copyFonts(): number {
  const out = join(dist, 'fonts');
  mkdirSync(out, { recursive: true });
  const rules: string[] = [];
  for (const spec of FONT_STYLESHEETS) {
    const stylesheet = Bun.resolveSync(spec, root);
    for (const rule of readFileSync(stylesheet, 'utf8').match(/@font-face\s*{[^}]*}/g) ?? []) {
      const woff2 = rule.match(/url\(\.\/files\/([^)]+?\.woff2)\)\s*format\(([^)]+)\)/);
      if (!woff2 || SKIPPED_SUBSETS.test(woff2[1] as string)) continue;
      const [, file, format] = woff2 as [string, string, string];
      copyFileSync(join(dirname(stylesheet), 'files', file), join(out, file));
      rules.push(rule.replace(/src:[^;]+;/, `src: url(./${file}) format(${format});`));
    }
  }
  writeFileSync(join(out, 'fonts.css'), `${rules.join('\n')}\n`);
  return rules.length;
}

rmSync(dist, { recursive: true, force: true });
const result = await Bun.build({
  entrypoints: [join(root, 'index.html')],
  outdir: dist,
  minify: true,
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
const fonts = copyFonts();
const indexFile = join(dist, 'index.html');
writeFileSync(
  indexFile,
  readFileSync(indexFile, 'utf8').replace('</head>', '<link rel="stylesheet" href="./fonts/fonts.css"></head>'),
);
for (const output of result.outputs) console.log(`${output.path.slice(dist.length + 1)}  ${(output.size / 1024).toFixed(1)} KB`);
console.log(`fonts/  ${fonts} font faces`);
