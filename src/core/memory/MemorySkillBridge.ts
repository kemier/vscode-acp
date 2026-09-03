/**
 * Localhost HTTP bridge so the LLM can load memory skills via Shell curl
 * without embedding gateway API keys in the prompt.
 *
 * Endpoints:
 *   POST /view   { name, agent_id? } → full skill (get-by-name)
 *   POST /search { query, agent_id?, top_k? } → search hits
 *   POST /update { skill_id, content, name?, description? } → update a stale skill
 *   GET  /health → 200 ok
 */

import * as http from 'node:http';
import { readMemorySettings, isMemoryConfigured } from './MemoryConfig';
import { MemoryHttpClient } from './MemoryHttpClient';
import { log, logError } from '../../utils/Logger';

const DEFAULT_PORT = 8126;
const HOST = '127.0.0.1';

export class MemorySkillBridge {
  private server: http.Server | undefined;
  private port = 0;

  get baseUrl(): string {
    return this.port > 0 ? `http://${HOST}:${this.port}` : '';
  }

  async start(): Promise<number> {
    if (this.server && this.port > 0) {
      return this.port;
    }
    const server = http.createServer((req, res) => {
      void this.handle(req, res);
    });
    const port = await this.listen(server, DEFAULT_PORT);
    this.server = server;
    this.port = port;
    log(`MemorySkillBridge listening on http://${HOST}:${port}`);
    return port;
  }

  stop(): void {
    if (!this.server) {
      return;
    }
    this.server.close();
    this.server = undefined;
    this.port = 0;
  }

  private listen(server: http.Server, preferred: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const tryPort = (port: number, attemptsLeft: number): void => {
        server.once('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
            tryPort(port + 1, attemptsLeft - 1);
            return;
          }
          reject(err);
        });
        server.listen(port, HOST, () => {
          const addr = server.address();
          const bound = typeof addr === 'object' && addr ? addr.port : port;
          resolve(bound);
        });
      };
      tryPort(preferred, 5);
    });
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = req.url ?? '/';
    if (req.method === 'GET' && (url === '/health' || url === '/')) {
      this.json(res, 200, { ok: true });
      return;
    }
    if (req.method !== 'POST') {
      this.json(res, 405, { error: 'method not allowed' });
      return;
    }

    const settings = readMemorySettings();
    if (!isMemoryConfigured(settings)) {
      this.json(res, 503, { error: 'memory not configured (acp.memory.*)' });
      return;
    }

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(await this.readBody(req)) as Record<string, unknown>;
    } catch {
      this.json(res, 400, { error: 'invalid JSON body' });
      return;
    }

    const agentId = typeof body.agent_id === 'string' && body.agent_id.trim() ? body.agent_id.trim() : 'cursor';
    const client = new MemoryHttpClient({
      endpoint: settings.endpoint,
      apiKey: settings.apiKey,
      serviceId: settings.serviceId,
      timeoutMs: settings.timeoutMs,
      retryCount: settings.recallRetryCount,
      retryDelayMs: settings.recallRetryDelayMs,
    });
    const iso = {
      teamId: settings.teamId,
      agentId,
      userId: settings.userId,
    };

    try {
      if (url === '/view' || url === '/view/') {
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (!name) {
          this.json(res, 400, { error: 'name is required' });
          return;
        }
        const skill = await client.getSkillByName(iso, name);
        this.json(res, 200, skill);
        return;
      }
      if (url === '/search' || url === '/search/') {
        const query = typeof body.query === 'string' ? body.query.trim() : '';
        if (!query) {
          this.json(res, 400, { error: 'query is required' });
          return;
        }
        const topK = typeof body.top_k === 'number' ? body.top_k : 5;
        const result = await client.searchSkills(iso, { query, topK });
        this.json(res, 200, result);
        return;
      }
      if (url === '/conversation-lookup' || url === '/conversation-lookup/') {
        const ids = Array.isArray(body.conversation_ids) ? (body.conversation_ids as string[]).filter((x) => typeof x === 'string') : [];
        if (ids.length === 0) {
          this.json(res, 400, { error: 'conversation_ids is required (non-empty array)' });
          return;
        }
        const result = await client.getConversationsByIds(iso, ids);
        this.json(res, 200, result);
        return;
      }
      if (url === '/memory-search' || url === '/memory-search/') {
        const query = typeof body.query === 'string' ? body.query.trim() : '';
        if (!query) {
          this.json(res, 400, { error: 'query is required' });
          return;
        }
        const topK = typeof body.top_k === 'number' ? body.top_k : 5;
        const result = await client.searchAtomic(iso, { query, limit: topK });
        this.json(res, 200, result);
        return;
      }
      if (url === '/update' || url === '/update/') {
        // Update a stale skill's content in place. Mirrors the gateway's
        // POST /v3/skill/update: `content` is a FULL SKILL.md overwrite.
        // skill_id (skl-…) is required; name/description are optional.
        const skillId = typeof body.skill_id === 'string' ? body.skill_id.trim() : '';
        const content = typeof body.content === 'string' ? body.content : '';
        if (!skillId) {
          this.json(res, 400, { error: 'skill_id is required' });
          return;
        }
        if (!content) {
          this.json(res, 400, { error: 'content is required (full SKILL.md overwrite)' });
          return;
        }
        const name = typeof body.name === 'string' ? body.name.trim() : undefined;
        const description = typeof body.description === 'string' ? body.description.trim() : undefined;
        const removeScriptPaths = Array.isArray(body.remove_script_paths)
          ? (body.remove_script_paths as string[]).filter((x) => typeof x === 'string')
          : undefined;
        const result = await client.skillUpdate(iso, {
          skillId,
          content,
          ...(name ? { name } : {}),
          ...(description ? { description } : {}),
          ...(removeScriptPaths ? { removeScriptPaths } : {}),
        });
        this.json(res, 200, result);
        return;
      }
      this.json(res, 404, { error: 'not found' });
    } catch (e) {
      logError('MemorySkillBridge request failed', e);
      const message = e instanceof Error ? e.message : String(e);
      this.json(res, 502, { error: message });
    }
  }

  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  private json(res: http.ServerResponse, status: number, data: unknown): void {
    const payload = JSON.stringify(data);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(payload);
  }
}
