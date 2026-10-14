// Build: inline CSS, JS and shader sources into a single self-contained dist/index.html.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(root, p), 'utf8');
let html = read('index.html');

// <link rel="stylesheet" href="X"> -> <style>...</style>
html = html.replace(/<link\s+[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)["'][^>]*>/g,
  (_, href) => `<style>\n${read(href)}\n</style>`);
html = html.replace(/<link\s+[^>]*href=["']([^"']+)["'][^>]*rel=["']stylesheet["'][^>]*>/g,
  (_, href) => `<style>\n${read(href)}\n</style>`);

// <script type="x-shader/..." id=".." data-src="X"></script> -> filled with the shader text
html = html.replace(/<script([^>]*type=["']x-shader\/[^"']+["'][^>]*)>\s*<\/script>/g, (m, attrs) => {
  const src = /data-src=["']([^"']+)["']/.exec(attrs);
  if (!src) return m;
  return `<script${attrs}>\n${read(src[1])}\n</script>`;
});

// <script src="X"></script> -> inline (escape closing tags inside the source)
html = html.replace(/<script\s+[^>]*src=["']([^"']+)["'][^>]*>\s*<\/script>/g, (m, src) => {
  if (/type=["']x-shader/.test(m)) return m;
  const js = read(src).replace(/<\/script/gi, '<\\/script');
  return `<script>\n${js}\n</script>`;
});

mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist', 'index.html'), html);
console.log(`dist/index.html written (${(html.length / 1024).toFixed(1)} KB)`);
