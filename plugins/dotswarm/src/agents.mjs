// Codex subagents that pair with swarms: the designer (taste), the imager (image generation,
// which the DeepSeek harness cannot do), and the writer (prose that has to persuade).
// A plugin cannot ship agents directly, so swarm_setup copies them into the Codex home.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from './config.mjs';

export const MANAGED_MARKER = '# managed-by: dotswarm';

/** Codex's home directory: CODEX_HOME when set, else ~/.codex. */
export function codexHome() {
  return process.env.CODEX_HOME ? path.resolve(process.env.CODEX_HOME) : path.join(os.homedir(), '.codex');
}

export function templatesDir() {
  return path.join(ROOT, 'agents');
}

function templates() {
  try {
    return fs.readdirSync(templatesDir()).filter((f) => f.endsWith('.toml')).sort();
  } catch {
    return [];
  }
}

const normalize = (text) => text.replace(/\r\n/g, '\n');

/**
 * Where each DotSwarm agent stands in the Codex home.
 * @returns {Array<{name: string, path: string, state: 'missing'|'current'|'outdated'|'user-owned'}>}
 */
export function agentsStatus() {
  const dir = path.join(codexHome(), 'agents');
  return templates().map((file) => {
    const target = path.join(dir, file);
    const name = file.replace(/\.toml$/, '');
    if (!fs.existsSync(target)) return { name, path: target, state: 'missing' };
    const installed = normalize(fs.readFileSync(target, 'utf8'));
    if (!installed.startsWith(MANAGED_MARKER)) return { name, path: target, state: 'user-owned' };
    const shipped = normalize(fs.readFileSync(path.join(templatesDir(), file), 'utf8'));
    return { name, path: target, state: installed === shipped ? 'current' : 'outdated' };
  });
}

/**
 * Copy missing agents and refresh outdated ones. A file without the managed marker belongs
 * to the user and is never overwritten.
 */
export function installAgents() {
  const dir = path.join(codexHome(), 'agents');
  fs.mkdirSync(dir, { recursive: true });
  return agentsStatus().map((agent) => {
    if (agent.state === 'missing' || agent.state === 'outdated') {
      fs.copyFileSync(path.join(templatesDir(), `${agent.name}.toml`), agent.path);
      return { ...agent, state: agent.state === 'missing' ? 'installed' : 'updated' };
    }
    return agent;
  });
}
