// Append-only shared findings ledger: one JSONL file per swarm.
import fs from 'node:fs';
import path from 'node:path';

export const FINDING_TYPES = ['discovery', 'warning', 'failure', 'decision', 'question', 'result', 'steer'];

export class Findings {
  constructor(file) {
    this.file = file;
  }

  readAll() {
    let text;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch {
      return [];
    }
    const out = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch { /* skip torn line */ }
    }
    return out;
  }

  list({ scope, type, limit = 50 } = {}) {
    let rows = this.readAll();
    if (scope) rows = rows.filter((r) => r.scope === scope || r.scope.startsWith(scope + '/'));
    if (type) rows = rows.filter((r) => r.type === type);
    return rows.slice(-Math.max(1, Math.min(limit, 500)));
  }

  append({ author, type, scope, message }) {
    if (!FINDING_TYPES.includes(type)) throw new Error(`type must be one of ${FINDING_TYPES.join(', ')}`);
    if (typeof scope !== 'string' || !scope.trim()) throw new Error('scope is required');
    if (typeof message !== 'string' || !message.trim()) throw new Error('message is required');
    if (message.length > 4000) throw new Error('message must be 4000 characters or fewer');
    const existing = this.readAll();
    const id = `F-${String(existing.length + 1).padStart(3, '0')}`;
    const row = {
      id,
      time: new Date().toISOString(),
      author: String(author || 'unknown').slice(0, 64),
      type,
      scope: scope.trim().slice(0, 200),
      message: message.trim(),
    };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.appendFileSync(this.file, JSON.stringify(row) + '\n');
    return row;
  }

  /** Compact text rendering for prompts and status. */
  static render(rows) {
    return rows
      .map((r) => `${r.id} [${r.type}] (${r.scope}) by ${r.author}: ${r.message}`)
      .join('\n');
  }
}
