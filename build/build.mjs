// Builds the bookmarklet and its setup page from src/ssf.js + a config file.
// Usage: node build/build.mjs <config.json> <outDir>
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { minify } from "terser";

const here = dirname(fileURLToPath(import.meta.url));
const [configPath = join(here, "../config/test.json"), outDir = join(here, "../dist/test")] = process.argv.slice(2);

const config = JSON.parse(readFileSync(resolve(configPath), "utf8"));
if (process.env.SSF_MANIFEST_URL) { config.manifestUrl = process.env.SSF_MANIFEST_URL; delete config.manifest; }
config.buildVersion = (config.buildVersion || "build") + " · " + new Date().toISOString().slice(0, 10);

const src = readFileSync(join(here, "../src/ssf.js"), "utf8").replace("const CONFIG = __SSF_CONFIG__;", "const CONFIG = " + JSON.stringify(config) + ";");
const { code } = await minify(src, { compress: { passes: 2 }, mangle: true, format: { comments: false } });
const bookmarklet = "javascript:" + encodeURIComponent(code);

mkdirSync(resolve(outDir), { recursive: true });
writeFileSync(join(resolve(outDir), "ssf.min.js"), code);
writeFileSync(join(resolve(outDir), "bookmarklet.txt"), bookmarklet);

const page = readFileSync(join(here, "setup-template.html"), "utf8")
  .replaceAll("{{NAME}}", config.name || "Search Safety Flagger")
  .replaceAll("{{VERSION}}", config.buildVersion)
  .replace("{{BOOKMARKLET_JSON}}", JSON.stringify(bookmarklet).replace(/</g, "\\u003c"));
// setup-artifact.html: fragment for hosts that add their own skeleton; setup.html: standalone page (e.g. GitHub Pages)
writeFileSync(join(resolve(outDir), "setup-artifact.html"), page);
writeFileSync(join(resolve(outDir), "setup.html"),
  '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n' +
  page.replace(/<script>[\s\S]*<\/script>\s*$/, "") .replace("<div class=\"wrap\">", "</head>\n<body>\n<div class=\"wrap\">") +
  page.match(/<script>[\s\S]*<\/script>/)[0] + "\n</body>\n</html>\n");

console.log(`Built ${config.name}: ${(code.length / 1024).toFixed(1)} KB minified, bookmark ${(bookmarklet.length / 1024).toFixed(1)} KB → ${outDir}`);
