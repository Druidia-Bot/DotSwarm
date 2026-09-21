// A minimal MCP server over stdio: newline-delimited JSON-RPC 2.0 with
// initialize, ping, tools/list, and tools/call. Kept dependency-free so the
// plugin runs from a Codex plugin cache with nothing installed but Node.
import readline from 'node:readline';

const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

/**
 * @param {object} options
 * @param {string} options.name
 * @param {string} options.version
 * @param {Array<{name: string, description: string, inputSchema: object}>} options.tools
 * @param {(name: string, args: Record<string, unknown>) => Promise<unknown>} options.call
 *   Returns a string, a `{ content, isError? }` result, or any JSON value (pretty-printed as text).
 * @param {string} [options.instructions]
 * @param {() => void} [options.onClose]
 */
export function serveStdio({ name, version, tools, call, instructions, onClose }) {
  const write = (frame) => process.stdout.write(JSON.stringify(frame) + '\n');
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

  lines.on('line', (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message === null || typeof message !== 'object' || Array.isArray(message)) return;
    void handle(message);
  });
  lines.on('close', () => onClose?.());

  async function handle({ id, method, params = {} }) {
    const hasId = id !== undefined && id !== null;
    const reply = (result) => { if (hasId) write({ jsonrpc: '2.0', id, result }); };
    const fail = (code, text) => { if (hasId) write({ jsonrpc: '2.0', id, error: { code, message: text } }); };
    try {
      switch (method) {
        case 'initialize': {
          const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
          reply({
            protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0],
            capabilities: { tools: {} },
            serverInfo: { name, version },
            ...(instructions ? { instructions } : {}),
          });
          return;
        }
        case 'ping':
          reply({});
          return;
        case 'tools/list':
          reply({ tools });
          return;
        case 'tools/call': {
          const tool = tools.find((t) => t.name === params.name);
          if (!tool) {
            reply({ isError: true, content: [{ type: 'text', text: `Unknown tool ${params.name}` }] });
            return;
          }
          try {
            const result = await call(params.name, params.arguments ?? {});
            reply(toolResult(result));
          } catch (error) {
            reply({ isError: true, content: [{ type: 'text', text: error?.message ?? String(error) }] });
          }
          return;
        }
        default:
          if (typeof method === 'string' && method.startsWith('notifications/')) return;
          fail(-32601, `Method not found: ${method}`);
      }
    } catch (error) {
      fail(-32603, error?.message ?? String(error));
    }
  }

  return { write };
}

function toolResult(result) {
  if (typeof result === 'string') return { content: [{ type: 'text', text: result }] };
  if (result && typeof result === 'object' && Array.isArray(result.content)) return result;
  return { content: [{ type: 'text', text: JSON.stringify(result ?? null, null, 2) }] };
}
