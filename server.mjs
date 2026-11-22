import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {createHash, timingSafeEqual} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {openQueue, QueueError, validId, MAX_PDF_BYTES} from './queue.mjs';

const digest = value => createHash('sha256').update(value).digest();
const validToken = token => typeof token === 'string' && /^[\x21-\x7e]{32,1024}$/.test(token);
const webFiles = new Map([
  ['/', ['index.html', 'text/html']],
  ['/print.css', ['print.css', 'text/css']],
  ['/print.js', ['print.js', 'text/javascript']]
].map(([route, [name, type]]) => [route, {
  type: type + '; charset=utf-8',
  body: readFileSync(new URL('./web/' + name, import.meta.url))
}]));
const contentPolicy = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src data:; form-action 'none'; base-uri 'none'; frame-ancestors 'none'";

export function validateConfig(config) {
  if (!validToken(config.adminToken) || !Array.isArray(config.agents) || !config.agents.length) throw new Error('INVALID_SERVER_CONFIG');
  const tokens = new Set([config.adminToken]), ids = new Set(), printerIds = new Set();
  for (const agent of config.agents) {
    if (!agent || !validId(agent.agentId) || !validId(agent.printerId) || !validToken(agent.token) ||
        tokens.has(agent.token) || ids.has(agent.agentId) || printerIds.has(agent.printerId)) throw new Error('INVALID_AGENT_CONFIG');
    tokens.add(agent.token); ids.add(agent.agentId); printerIds.add(agent.printerId);
  }
}
async function jsonBody(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) throw new QueueError('JSON_REQUIRED', 415);
  const chunks = []; let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > Math.ceil(MAX_PDF_BYTES / 3) * 4 + 4096) throw new QueueError('BODY_TOO_LARGE', 413);
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new QueueError('INVALID_JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new QueueError('INVALID_JSON');
  return value;
}
export function createPrintServer(config, queue) {
  validateConfig(config);
  const auth = (req, token) => {
    const header = req.headers.authorization;
    return typeof header === 'string' && header.startsWith('Bearer ') && timingSafeEqual(digest(header.slice(7)), digest(token));
  };
  return createServer(async (req, res) => {
    const send = (status, data) => {
      res.writeHead(status, {'content-type':'application/json; charset=utf-8','cache-control':'no-store',
        'x-content-type-options':'nosniff','referrer-policy':'no-referrer'});
      res.end(data === undefined ? undefined : JSON.stringify(data));
    };
    try {
      const path = req.url;
      if (req.method === 'GET' && webFiles.has(path)) {
        const {type, body} = webFiles.get(path);
        res.writeHead(200, {
          'content-type': type,
          'cache-control': 'no-store',
          'content-security-policy': contentPolicy,
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer'
        });
        return res.end(body);
      }
      if (req.method === 'GET' && path === '/health') return send(200, {ok: true});
      if (path === '/v1/jobs' || /^\/v1\/jobs\/[A-Za-z0-9_-]{1,100}$/.test(path ?? '')) {
        if (!auth(req, config.adminToken)) return send(401, {error:'UNAUTHORIZED'});
        if (req.method === 'POST' && path === '/v1/jobs') {
          const body = await jsonBody(req);
          if (!config.agents.some(a => a.printerId === body.printerId)) throw new QueueError('PRINTER_NOT_CONFIGURED');
          const result = queue.enqueue(body); return send(result.created ? 201 : 200, result);
        }
        if (req.method === 'GET' && path !== '/v1/jobs') return send(200, {job:queue.get(path.split('/').at(-1))});
        return send(405, {error:'METHOD_NOT_ALLOWED'});
      }
      const agent = config.agents.find(a => auth(req, a.token));
      if (!agent) return send(401, {error:'UNAUTHORIZED'});
      if (req.method === 'POST' && path === '/v1/agent/claim') {
        const body = await jsonBody(req);
        if (body.agentId !== agent.agentId || Object.keys(body).length !== 1) throw new QueueError('AGENT_MISMATCH', 403);
        const job = queue.claim(agent); return job ? send(200, job) : send(204);
      }
      if (req.method === 'POST' && /^\/v1\/agent\/jobs\/[A-Za-z0-9_-]{1,100}\/result$/.test(path ?? '')) {
        const job = queue.result(agent, path.split('/')[4], await jsonBody(req)); return send(200, {ok:true, job});
      }
      return send(404, {error:'NOT_FOUND'});
    } catch (error) {
      send(error instanceof QueueError ? error.status : 503,
        {error:error instanceof QueueError ? error.message : 'SERVER_UNAVAILABLE'});
    }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let queue, server;
  try {
    const config = {adminToken:process.env.REMOTE_PRINT_ADMIN_TOKEN, agents:JSON.parse(process.env.REMOTE_PRINT_AGENTS_JSON ?? '[]')};
    validateConfig(config);
    const host = process.env.REMOTE_PRINT_HOST ?? '127.0.0.1';
    const port = Number(process.env.REMOTE_PRINT_PORT ?? 17890);
    if (!['127.0.0.1','::1','localhost'].includes(host) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('INVALID_LISTEN_CONFIG');
    queue = openQueue(resolve(process.env.REMOTE_PRINT_STATE_DIR ?? './server-state'));
    server = createPrintServer(config, queue);
    server.requestTimeout = 30_000; server.headersTimeout = 10_000;
    server.on('error', () => { console.error('PRINT_SERVER_LISTEN_FAILED'); queue.close(); process.exitCode=1; });
    server.listen(port, host, () => console.log(`打印队列已启动 ${host}:${port}；远程连接需通过 HTTPS 反向代理。`));
    const stop = () => server.close(() => { queue.close(); });
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  } catch { console.error('PRINT_SERVER_START_FAILED: 请检查环境变量、独占锁和状态文件。'); queue?.close(); process.exitCode=1; }
}
