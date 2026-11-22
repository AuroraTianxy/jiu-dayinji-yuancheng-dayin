import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const ID = /^[A-Za-z0-9_-]{1,100}$/;
const validId = v => typeof v === 'string' && ID.test(v);
const HASH = /^[a-fA-F0-9]{64}$/;
const CACHE = /^job-[a-f0-9-]{36}\.pdf$/;
export const MAX_PDF = 10 * 1024 * 1024;
export class AgentError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = code => { throw new AgentError(code); };
const object = v => v && typeof v === 'object' && !Array.isArray(v);

export function validateConfig(input, baseDir = process.cwd()) {
  if (!object(input)) fail('CONFIG_INVALID');
  const allowed = ['serverUrl', 'agentId', 'printerId', 'printerName', 'pollIntervalMs', 'stateDir', 'paperSize', 'tokenFile'];
  if (Object.keys(input).some(k => !allowed.includes(k))) fail('CONFIG_UNKNOWN_FIELD');
  if (!validId(input.agentId) || !validId(input.printerId)) fail('CONFIG_ID_INVALID');
  let url;
  try { url = new URL(input.serverUrl); } catch { fail('CONFIG_URL_INVALID'); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') fail('CONFIG_URL_INVALID');
  // Check the literal authority as well: URL normalizes 127.1 and integer IPs.
  const authority = String(input.serverUrl).match(/^https?:\/\/([^/]+)\/?$/)?.[1];
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?$/.test(authority ?? '');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) fail('CONFIG_HTTPS_REQUIRED');
  const plain = v => typeof v === 'string' && v.length > 0 && v.length <= 300 && !/[\x00-\x1f\x7f]/.test(v);
  if (!plain(input.printerName)) fail('CONFIG_PRINTER_REQUIRED');
  if (input.paperSize !== undefined && !plain(input.paperSize)) fail('CONFIG_PAPER_INVALID');
  const pollIntervalMs = input.pollIntervalMs ?? 3000;
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1000 || pollIntervalMs > 3600000) fail('CONFIG_POLL_INVALID');
  if (!plain(input.stateDir ?? './agent-state')) fail('CONFIG_STATE_INVALID');
  if (input.tokenFile !== undefined && !plain(input.tokenFile)) fail('CONFIG_TOKEN_FILE_INVALID');
  return { ...input, serverUrl: url.origin, pollIntervalMs,
    stateDir: path.resolve(baseDir, input.stateDir ?? './agent-state'),
    ...(input.tokenFile ? { tokenFile: path.resolve(baseDir, input.tokenFile) } : {}) };
}

export async function readToken(config, env = process.env) {
  let token = env.REMOTE_PRINT_TOKEN;
  if (!token && config.tokenFile) {
    try { token = (await fs.readFile(config.tokenFile, 'utf8')).trim(); }
    catch { fail('TOKEN_FILE_UNREADABLE'); }
  }
  if (typeof token !== 'string' || !token.length || token.length > 8192 || /\s|[\x00-\x1f\x7f]/.test(token)) fail('TOKEN_REQUIRED');
  return token;
}

export function validateJob(job, config) {
  if (!object(job) || !validId(job.id) || !validId(job.agentId) || !validId(job.printerId)) fail('JOB_ID_INVALID');
  if (job.agentId !== config.agentId || job.printerId !== config.printerId) fail('JOB_SCOPE_MISMATCH');
  if (typeof job.sha256 !== 'string' || !HASH.test(job.sha256)) fail('JOB_HASH_INVALID');
  if (typeof job.createdAt !== 'string' || !Number.isFinite(Date.parse(job.createdAt))) fail('JOB_DATE_INVALID');
  const b64 = job.pdfBase64;
  if (typeof b64 !== 'string' || b64.length > 4 * Math.ceil(MAX_PDF / 3) || b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) fail('JOB_PDF_INVALID');
  const pdf = Buffer.from(b64, 'base64');
  if (pdf.toString('base64') !== b64 || pdf.length < 5 || pdf.length > MAX_PDF || pdf.subarray(0, 5).toString() !== '%PDF-') fail('JOB_PDF_INVALID');
  if (createHash('sha256').update(pdf).digest('hex') !== job.sha256.toLowerCase()) fail('JOB_HASH_MISMATCH');
  return { ...job, sha256: job.sha256.toLowerCase(), pdf };
}

// Never log response bodies, PDF contents, credentials or driver exceptions.
export async function request(config, route, body, token) {
  try {
    const response = await fetch(config.serverUrl + route, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    if (response.status === 204 && route === '/v1/agent/claim') return null;
    if (response.status !== 200) {
      await response.body?.cancel();
      fail(response.status === 408 || response.status === 429 || response.status >= 500 ? 'SERVER_HTTP_ERROR' : 'SERVER_REJECTED');
    }
    const reader = response.body?.getReader();
    if (!reader) fail('SERVER_RESPONSE_INVALID');
    const chunks = []; let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 14 * 1024 * 1024 + 65536) { await reader.cancel(); fail('SERVER_RESPONSE_TOO_LARGE'); }
      chunks.push(Buffer.from(value));
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { fail('SERVER_RESPONSE_INVALID'); }
  } catch (error) {
    if (error instanceof AgentError) throw error;
    fail('SERVER_UNREACHABLE');
  }
}

async function syncDirectory(dir) {
  let h;
  try { h = await fs.open(dir, 'r'); await h.sync(); }
  catch (e) { if (process.platform !== 'win32' || !['EPERM', 'EISDIR', 'EINVAL', 'EACCES', 'ENOTSUP'].includes(e.code)) throw e; }
  finally { await h?.close(); }
}

async function atomicSave(file, value) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(tmp, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(value)); await handle.sync(); await handle.close(); handle = null;
    await fs.rename(tmp, file); await syncDirectory(path.dirname(file));
  } catch { fail('STATE_SAVE_FAILED'); }
  finally { await handle?.close(); /* Preserve failed temporary writes for operator inspection. */ }
}

function checkLedger(ledger, config) {
  if (!object(ledger) || ledger.version !== 1 || ledger.agentId !== config.agentId || ledger.printerId !== config.printerId || !object(ledger.jobs)) fail('LEDGER_CORRUPT_OR_SCOPE');
  for (const [id, entry] of Object.entries(ledger.jobs)) {
    if (!validId(id) || !object(entry) || !HASH.test(entry.sha256 ?? '') ||
        !['started', 'submitted', 'unknown', 'failed'].includes(entry.status) || typeof entry.acked !== 'boolean' ||
        (entry.status === 'started' && entry.acked) || !CACHE.test(entry.cache ?? '') ||
        (entry.errorCode !== undefined && !/^[A-Z_]{1,80}$/.test(entry.errorCode))) fail('LEDGER_CORRUPT_OR_SCOPE');
  }
}

export async function runAgent(config, deps, { once = false, dryRun = false, signal } = {}) {
  config = validateConfig(config);
  const printers = await deps.getPrinters();
  if (!Array.isArray(printers) || !printers.some(p => p.name === config.printerName)) fail('PRINTER_NOT_FOUND');
  if (dryRun) return { dryRun: true, printers: printers.map(p => p.name), physicalOutput: 'NOT_OBSERVED' };
  const token = await (deps.readToken ?? readToken)(config);
  const post = (route, body) => (deps.request ?? request)(config, route, body, token);
  await fs.mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  const lockPath = path.join(config.stateDir, 'agent.lock');
  let lock;
  try { lock = await fs.open(lockPath, 'wx', 0o600); }
  catch { fail('LOCK_EXISTS_OPERATOR_RECOVERY_REQUIRED'); }
  const ownership = JSON.stringify({ pid: process.pid, owner: randomUUID(), createdAt: new Date().toISOString() });
  let lockWritten = false;
  try {
    await lock.writeFile(ownership); await lock.sync(); lockWritten = true;
    const ledgerPath = path.join(config.stateDir, 'ledger.json');
    let ledger;
    try { ledger = JSON.parse(await fs.readFile(ledgerPath, 'utf8')); }
    catch (e) {
      if (e.code !== 'ENOENT') fail('LEDGER_CORRUPT_OR_UNREADABLE');
      // A missing ledger alongside cached PDFs is not a fresh installation.
      if ((await fs.readdir(config.stateDir)).some(n => n !== 'agent.lock')) fail('LEDGER_MISSING_WITH_STATE');
      ledger = { version: 1, agentId: config.agentId, printerId: config.printerId, jobs: {} };
      await atomicSave(ledgerPath, ledger);
    }
    checkLedger(ledger, config);
    const save = () => atomicSave(ledgerPath, ledger);
    const cleanup = async entry => {
      try { await fs.unlink(path.join(config.stateDir, entry.cache)); }
      catch (e) { if (e.code !== 'ENOENT') fail('CACHE_CLEANUP_FAILED'); }
    };
    const ack = async (id, entry) => {
      const result = await post(`/v1/agent/jobs/${id}/result`, {
        agentId: config.agentId, status: entry.status, ...(entry.errorCode ? { errorCode: entry.errorCode } : {})
      });
      if (!object(result) || result.ok !== true) fail('ACK_INVALID');
      entry.acked = true; await save(); await cleanup(entry);
    };
    for (const [id, entry] of Object.entries(ledger.jobs)) {
      if (entry.status === 'started') { entry.status = 'unknown'; entry.errorCode = 'INTERRUPTED_PRINT'; await save(); }
      if (!entry.acked) await ack(id, entry);
      else await cleanup(entry);
    }
    do {
      if (signal?.aborted) break;
      // Revalidate on every claim; never silently switch to the default printer.
      if (!(await deps.getPrinters()).some(p => p.name === config.printerName)) fail('PRINTER_NOT_FOUND');
      const raw = await post('/v1/agent/claim', { agentId: config.agentId });
      if (raw !== null) {
        const job = validateJob(raw, config);
        if (Object.hasOwn(ledger.jobs, job.id)) {
          const entry = ledger.jobs[job.id];
          if (entry.sha256 !== job.sha256) fail('DUPLICATE_HASH_CONFLICT');
          await ack(job.id, entry);
        } else {
          const cache = `job-${randomUUID()}.pdf`;
          const filename = path.join(config.stateDir, cache);
          const file = await fs.open(filename, 'wx', 0o600);
          try { await file.writeFile(job.pdf); await file.sync(); } finally { await file.close(); }
          const entry = { sha256: job.sha256, status: 'started', acked: false, cache };
          Object.defineProperty(ledger.jobs, job.id, { value: entry, enumerable: true, configurable: true, writable: true });
          await save(); // Durable intent MUST precede driver invocation.
          try {
            await deps.print(filename, { printer: config.printerName, scale: 'noscale', copies: 1, silent: true,
              ...(config.paperSize ? { paperSize: config.paperSize } : {}) });
            entry.status = 'submitted';
          } catch { entry.status = 'unknown'; entry.errorCode = 'PRINT_OUTCOME_UNKNOWN'; }
          await save(); // Failure here leaves started on disk: restart reports unknown.
          await ack(job.id, entry);
        }
      }
      if (!once && !signal?.aborted) {
        try { await delay(config.pollIntervalMs, undefined, { signal }); }
        catch (e) { if (e.name !== 'AbortError') throw e; }
      }
    } while (!once && !signal?.aborted);
    return { physicalOutput: 'NOT_OBSERVED' };
  } finally {
    await lock.close();
    // Only the process that acquired wx owns this file. Operators must stop it before recovery.
    if (!lockWritten || await fs.readFile(lockPath, 'utf8') === ownership) await fs.unlink(lockPath);
    else fail('LOCK_OWNERSHIP_CHANGED');
  }
}

// Re-enter through the same durable ledger after transient transport/server failures.
// Never retries a driver call; unknown/submitted entries are replayed as ACKs only.
export async function runWithReconnect(config, deps, {
  once = false, dryRun = false, signal, run = runAgent, sleep = delay, onRetry = () => {}
} = {}) {
  let attempts = 0;
  while (!signal?.aborted) {
    try { return await run(config, deps, { once, dryRun, signal }); }
    catch (error) {
      if (once || dryRun || !['SERVER_UNREACHABLE', 'SERVER_HTTP_ERROR'].includes(error.code)) throw error;
      if (signal?.aborted) break;
      const waitMs = Math.min(5000 * (2 ** Math.min(attempts++, 3)), 30000);
      onRetry(error.code, waitMs);
      try { await sleep(waitMs, undefined, { signal }); }
      catch (e) { if (e.name === 'AbortError' && signal?.aborted) break; throw e; }
    }
  }
  return { physicalOutput: 'NOT_OBSERVED' };
}
