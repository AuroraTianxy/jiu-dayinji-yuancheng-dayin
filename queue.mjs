import {createHash, randomUUID} from 'node:crypto';
import {mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, readFileSync, unlinkSync, existsSync} from 'node:fs';
import {join} from 'node:path';

export const MAX_PDF_BYTES = 10 * 1024 * 1024;
export const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
export class QueueError extends Error {
  constructor(code, status = 400) { super(code); this.status = status; }
}
const fail = (code, status) => { throw new QueueError(code, status); };
export function pdfBytes(base64, sha256) {
  if (typeof base64 !== 'string' || base64.length > Math.ceil(MAX_PDF_BYTES / 3) * 4 ||
      base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) fail('INVALID_PDF');
  const pdf = Buffer.from(base64, 'base64');
  if (pdf.toString('base64') !== base64 || pdf.length < 5 || pdf.length > MAX_PDF_BYTES || pdf.subarray(0, 5).toString() !== '%PDF-') fail('INVALID_PDF');
  if (!/^[a-f0-9]{64}$/.test(sha256 ?? '') || createHash('sha256').update(pdf).digest('hex') !== sha256) fail('PDF_HASH_MISMATCH');
  return pdf;
}

// Single-writer store. A stale lock requires explicit operator inspection; never replay on restart.
export function openQueue(directory, {now = Date.now, claimTimeoutMs = 120_000} = {}) {
  mkdirSync(directory, {recursive: true, mode: 0o700});
  const path = join(directory, 'queue.json'), lockPath = join(directory, 'server.lock');
  let lock;
  try { lock = openSync(lockPath, 'wx', 0o600); }
  catch { fail('SERVER_STATE_LOCKED', 503); }
  writeFileSync(lock, JSON.stringify({pid: process.pid, startedAt: new Date().toISOString()})); fsyncSync(lock);
  let closed = false;
  const close = () => { if (!closed) { closed = true; closeSync(lock); unlinkSync(lockPath); } };
  let state;
  try {
    state = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {version: 1, jobs: []};
    if (state.version !== 1 || !Array.isArray(state.jobs) || state.jobs.length > 10_000) fail('CORRUPT_QUEUE', 503);
    const ids = new Set();
    for (const job of state.jobs) {
      if (!validId(job.id) || !validId(job.printerId) || ids.has(job.id) ||
          !['queued','claimed','submitted','failed','unknown'].includes(job.status) ||
          !/^[a-f0-9]{64}$/.test(job.sha256 ?? '') || !Number.isFinite(job.createdAt) ||
          job.status === 'claimed' && (!validId(job.agentId) || !Number.isFinite(job.claimedAt)) ||
          job.status === 'unknown' && !validId(job.agentId)) fail('CORRUPT_QUEUE', 503);
      if (['queued','claimed'].includes(job.status)) pdfBytes(job.pdfBase64, job.sha256);
      ids.add(job.id);
    }
  } catch (error) { close(); throw error; }
  let poisoned = false;
  function persist(next) {
    if (closed || poisoned) fail('QUEUE_UNAVAILABLE', 503);
    const temporary = join(directory, `queue-${randomUUID()}.tmp`);
    let fd;
    try {
      fd = openSync(temporary, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify(next)); fsyncSync(fd); closeSync(fd); fd = undefined;
      renameSync(temporary, path);
      // Directory sync is supported on Unix; Windows uses atomic file replacement above.
      if (process.platform !== 'win32') {
        const dir = openSync(directory, 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
      }
      state = next;
    } catch {
      if (fd !== undefined) closeSync(fd);
      // Do not continue from uncertain disk state after an I/O failure.
      poisoned = true; fail('QUEUE_STORAGE_FAILURE', 503);
    }
  }
  function expire() {
    const expired = state.jobs.some(j => j.status === 'claimed' && now() - j.claimedAt >= claimTimeoutMs);
    if (expired) persist({...state, jobs: state.jobs.map(j => j.status === 'claimed' && now() - j.claimedAt >= claimTimeoutMs
      ? {...j, status: 'unknown', errorCode: 'CLAIM_TIMEOUT', pdfBase64: undefined, updatedAt: now()} : j)});
  }
  const summary = j => ({id: j.id, printerId: j.printerId, agentId: j.agentId ?? null,
    sha256: j.sha256, status: j.status, createdAt: j.createdAt, updatedAt: j.updatedAt,
    errorCode: j.errorCode ?? null, physicalOutput: 'NOT_OBSERVED'});
  return {
    close,
    enqueue(input) {
      if (!input || Object.keys(input).some(k => !['id','printerId','pdfBase64','sha256'].includes(k)) ||
          !validId(input.id) || !validId(input.printerId)) fail('INVALID_JOB');
      pdfBytes(input.pdfBase64, input.sha256);
      expire();
      const old = state.jobs.find(j => j.id === input.id);
      if (old) {
        if (old.printerId !== input.printerId || old.sha256 !== input.sha256) fail('IDEMPOTENCY_CONFLICT', 409);
        return {created: false, job: summary(old)};
      }
      if (state.jobs.length >= 10_000 || state.jobs.filter(j => ['queued','claimed'].includes(j.status)).length >= 100 ||
          state.jobs.reduce((sum,j) => sum + (j.pdfBase64?.length ?? 0), 0) + input.pdfBase64.length > 200 * 1024 * 1024) fail('QUEUE_FULL', 503);
      const job = {...input, status: 'queued', createdAt: now(), updatedAt: now()};
      persist({...state, jobs: [...state.jobs, job]});
      return {created: true, job: summary(job)};
    },
    claim(agent) {
      expire();
      const job = state.jobs.find(j => j.status === 'queued' && j.printerId === agent.printerId);
      if (!job) return null;
      const claimed = {...job, status: 'claimed', agentId: agent.agentId, claimedAt: now(), updatedAt: now()};
      persist({...state, jobs: state.jobs.map(j => j.id === job.id ? claimed : j)});
      return {id: job.id, printerId: job.printerId, agentId: agent.agentId,
        sha256: job.sha256, pdfBase64: job.pdfBase64, createdAt: new Date(job.createdAt).toISOString()};
    },
    result(agent, id, input) {
      if (!input || Object.keys(input).some(k => !['agentId','status','errorCode'].includes(k)) ||
          input.agentId !== agent.agentId || !['submitted','failed','unknown'].includes(input.status) ||
          input.errorCode !== undefined && (typeof input.errorCode !== 'string' || !/^[A-Z0-9_]{1,80}$/.test(input.errorCode))) fail('INVALID_RESULT');
      const job = state.jobs.find(j => j.id === id && j.printerId === agent.printerId && j.agentId === agent.agentId);
      if (!job) fail('JOB_NOT_FOUND', 404);
      if (!['claimed','unknown'].includes(job.status)) {
        if (job.status === input.status) return summary(job);
        fail('RESULT_CONFLICT', 409);
      }
      const next = {...job, status: input.status, errorCode: input.errorCode, pdfBase64: undefined, updatedAt: now()};
      persist({...state, jobs: state.jobs.map(j => j.id === id ? next : j)});
      return summary(next);
    },
    get(id) { expire(); const job = state.jobs.find(j => j.id === id); if (!job) fail('JOB_NOT_FOUND', 404); return summary(job); },
  };
}
