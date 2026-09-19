#!/usr/bin/env node
// Thin launcher so the plugin can live in Codex's plugin cache while the application
// stays in its own directory. Resolution order: DEEPASTRA_SWARM_ROOT, runtime.json
// beside this file (written by scripts/install-codex-plugin.ps1), then the repo layout.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const candidates = [process.env.DEEPASTRA_SWARM_ROOT];
try {
  candidates.push(JSON.parse(fs.readFileSync(path.join(here, 'runtime.json'), 'utf8')).root);
} catch { /* not installed through the script */ }
candidates.push(path.resolve(here, '..', '..'));

const root = candidates.find((c) => c && fs.existsSync(path.join(c, 'src', 'server.mjs')));
if (!root) {
  console.error('deepastra-swarm: application root not found. Set DEEPASTRA_SWARM_ROOT or reinstall with scripts/install-codex-plugin.ps1');
  process.exit(2);
}
process.env.DEEPASTRA_SWARM_ROOT = root;
await import(pathToFileURL(path.join(root, 'src', 'server.mjs')).href);
