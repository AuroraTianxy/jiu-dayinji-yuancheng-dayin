import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { AgentError, MAX_PDF, validateConfig, validateJob, runAgent, runWithReconnect, readToken, request } from './agent-core.mjs';
import { parseArgs } from './agent.mjs';

const pdf = Buffer.from('%PDF-1.7\nsynthetic test only');
const hash = b => createHash('sha256').update(b).digest('hex');
const rawConfig = { serverUrl: 'http://127.0.0.1:12345', agentId: 'agent-1', printerId: 'wh-1', printerName: 'Sample Printer' };
const job = overrides => ({ id: 'job-1', printerId: 'wh-1', agentId: 'agent-1', sha256: hash(pdf), pdfBase64: pdf.toString('base64'), createdAt: '2026-10-23T00:00:00.000Z', ...overrides });
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-agent-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const config = validateConfig({ ...rawConfig, stateDir: path.join(dir, 'state') });
  const prints = [], acks = [], claims = [];
  let next = job();
  const deps = {
    getPrinters: async () => [{ name: config.printerName }],
    readToken: async () => 'test-only-token',
    print: async (filename, options) => {
      const ledger = await readLedger();
      assert.equal(ledger.jobs['job-1'].status, 'started', 'intent must already be durable');
      assert.deepEqual(await fs.readFile(filename), pdf);
      prints.push({ filename, options });
    },
    request: async (_config, route, body) => {
      if (route === '/v1/agent/claim') { claims.push(body); return next; }
      acks.push(body); return { ok: true, job: { status: body.status } };
    }
  };
  const readLedger = async () => JSON.parse(await fs.readFile(path.join(config.stateDir, 'ledger.json'), 'utf8'));
  return { dir, config, deps, prints, acks, claims, readLedger, setJob: v => { next = v; } };
}
const once = { once: true };

test('submitted intent, exact options, ACK and cache removal; duplicate never reprints', async t => {
  const f = await fixture(t);
  await runAgent(f.config, f.deps, once);
  await runAgent(f.config, f.deps, once);
  assert.equal(f.prints.length, 1);
  assert.deepEqual(f.prints[0].options, { printer: 'Sample Printer', scale: 'noscale', copies: 1, silent: true });
  assert.equal(f.acks.length, 2);
  assert.equal((await f.readLedger()).jobs['job-1'].acked, true);
  assert.deepEqual((await fs.readdir(f.config.stateDir)).sort(), ['ledger.json']);
});

test('server ACK failure preserves submitted; restart ACKs without printing again', async t => {
  const f = await fixture(t); const original = f.deps.request;
  f.deps.request = async (...args) => {
    if (args[1].endsWith('/result')) throw new AgentError('SERVER_UNREACHABLE');
    return original(...args);
  };
  await assert.rejects(runAgent(f.config, f.deps, once), /SERVER_UNREACHABLE/);
  let entry = (await f.readLedger()).jobs['job-1'];
  assert.equal(entry.status, 'submitted'); assert.equal(entry.acked, false);
  await fs.access(path.join(f.config.stateDir, entry.cache));
  f.deps.request = original; f.setJob(null);
  await runAgent(f.config, f.deps, once);
  assert.equal(f.prints.length, 1);
  assert.equal(f.acks[0].status, 'submitted');
  entry = (await f.readLedger()).jobs['job-1']; assert.equal(entry.acked, true);
});

test('started recovery reports unknown, including duplicate claim; never reprints', async t => {
  const f = await fixture(t);
  await fs.mkdir(f.config.stateDir);
  const cache = 'job-00000000-0000-0000-0000-000000000000.pdf';
  await fs.writeFile(path.join(f.config.stateDir, cache), pdf);
  await fs.writeFile(path.join(f.config.stateDir, 'ledger.json'), JSON.stringify({ version: 1, agentId: 'agent-1', printerId: 'wh-1', jobs: {
    'job-1': { sha256: hash(pdf), status: 'started', acked: false, cache }
  } }));
  await runAgent(f.config, f.deps, once);
  assert.equal(f.prints.length, 0);
  assert.deepEqual(f.acks.map(a => a.status), ['unknown', 'unknown']);
  assert.equal((await f.readLedger()).jobs['job-1'].errorCode, 'INTERRUPTED_PRINT');
});

test('driver failure is unknown and no automatic retry, even with repeated job', async t => {
  const f = await fixture(t); let calls = 0;
  f.deps.print = async () => { calls++; throw new Error('private driver details'); };
  await runAgent(f.config, f.deps, once);
  await runAgent(f.config, f.deps, once);
  assert.equal(calls, 1);
  assert.deepEqual(f.acks.map(a => a.status), ['unknown', 'unknown']);
  assert.equal(f.acks[0].errorCode, 'PRINT_OUTCOME_UNKNOWN');
  assert.doesNotMatch(JSON.stringify(await f.readLedger()), /private driver/);
});

test('same ID with different valid hash fails closed', async t => {
  const f = await fixture(t); await runAgent(f.config, f.deps, once);
  const changed = Buffer.from('%PDF-other-content');
  f.setJob(job({ sha256: hash(changed), pdfBase64: changed.toString('base64') }));
  await assert.rejects(runAgent(f.config, f.deps, once), /DUPLICATE_HASH_CONFLICT/);
  assert.equal(f.prints.length, 1); assert.equal(f.acks.length, 1);
});

for (const [name, change] of [
  ['hash mismatch', { sha256: '0'.repeat(64) }], ['hash syntax', { sha256: 'abc' }],
  ['printer scope', { printerId: 'wh-2' }], ['agent scope', { agentId: 'other' }],
  ['ID path escape', { id: '../escape' }], ['numeric ID', { id: 123 }],
  ['PDF prefix', { pdfBase64: Buffer.from('not pdf').toString('base64') }],
  ['invalid base64', { pdfBase64: '%%%%' }], ['invalid createdAt', { createdAt: 123 }]
]) test(`reject ${name} before driver or ACK`, async t => {
  const f = await fixture(t); f.setJob(job(change));
  await assert.rejects(runAgent(f.config, f.deps, once));
  assert.equal(f.prints.length, 0); assert.equal(f.acks.length, 0);
});

test('reject >10MiB PDF', () => {
  const big = Buffer.alloc(MAX_PDF + 1, 65); big.write('%PDF-');
  assert.throws(() => validateJob(job({ pdfBase64: big.toString('base64'), sha256: hash(big) }), rawConfig), /JOB_PDF_INVALID/);
});

test('dry run validates printer only: no token, network, state, ACK or driver', async t => {
  const f = await fixture(t);
  f.deps.readToken = f.deps.request = f.deps.print = async () => assert.fail('dry run side effect');
  const result = await runAgent(f.config, f.deps, { dryRun: true });
  assert.equal(result.physicalOutput, 'NOT_OBSERVED'); assert.equal(result.dryRun, true);
  await assert.rejects(fs.access(f.config.stateDir));
});

test('missing exact printer fails before claim and never picks default', async t => {
  const f = await fixture(t); f.deps.getPrinters = async () => [{ name: 'default printer' }];
  await assert.rejects(runAgent(f.config, f.deps, once), /PRINTER_NOT_FOUND/);
  assert.equal(f.claims.length, 0);
});

test('exclusive lock refuses concurrent/stale state and never removes foreign lock', async t => {
  const f = await fixture(t); await fs.mkdir(f.config.stateDir);
  const lockPath = path.join(f.config.stateDir, 'agent.lock'); await fs.writeFile(lockPath, 'foreign lock');
  await assert.rejects(runAgent(f.config, f.deps, once), /LOCK_EXISTS_OPERATOR_RECOVERY_REQUIRED/);
  assert.equal(await fs.readFile(lockPath, 'utf8'), 'foreign lock'); assert.equal(f.claims.length, 0);
});

test('corrupt ledger stops and releases owned lock, never falls back to empty ledger', async t => {
  const f = await fixture(t); await fs.mkdir(f.config.stateDir);
  await fs.writeFile(path.join(f.config.stateDir, 'ledger.json'), '{broken');
  await assert.rejects(runAgent(f.config, f.deps, once), /LEDGER_CORRUPT_OR_UNREADABLE/);
  assert.equal(await fs.readFile(path.join(f.config.stateDir, 'ledger.json'), 'utf8'), '{broken');
  await assert.rejects(fs.access(path.join(f.config.stateDir, 'agent.lock')));
  assert.equal(f.claims.length, 0);
});

test('missing ledger alongside state fails closed', async t => {
  const f = await fixture(t); await fs.mkdir(f.config.stateDir);
  await fs.writeFile(path.join(f.config.stateDir, 'job-old.pdf'), pdf);
  await assert.rejects(runAgent(f.config, f.deps, once), /LEDGER_MISSING_WITH_STATE/);
});

test('optional paper form is passed exactly', async t => {
  const f = await fixture(t); f.config.paperSize = 'Driver custom form';
  await runAgent(f.config, f.deps, once);
  assert.equal(f.prints[0].options.paperSize, 'Driver custom form');
});

test('URL security, defaults and no inline credential configuration', () => {
  for (const serverUrl of ['http://printer.example', 'http://127.1', 'http://2130706433', 'http://localhost.evil', 'https://u:p@example.com', 'https://example.com/?token=secret', 'https://example.com/api']) {
    assert.throws(() => validateConfig({ ...rawConfig, serverUrl }));
  }
  for (const serverUrl of ['https://print.example.com', 'http://127.0.0.1:80', 'http://localhost:8000', 'http://[::1]:8000']) assert.ok(validateConfig({ ...rawConfig, serverUrl }));
  assert.equal(validateConfig(rawConfig).pollIntervalMs, 3000);
  assert.throws(() => validateConfig({ ...rawConfig, token: 'do-not-store' }), /CONFIG_UNKNOWN_FIELD/);
  assert.throws(() => validateConfig({ ...rawConfig, agentId: 123 }), /CONFIG_ID_INVALID/);
});

test('token environment takes precedence, fallback file and safe failure', async t => {
  const f = await fixture(t); const tokenFile = path.join(f.dir, 'private-token');
  await fs.writeFile(tokenFile, 'file-token\n');
  assert.equal(await readToken({ tokenFile }, { REMOTE_PRINT_TOKEN: 'env-token' }), 'env-token');
  assert.equal(await readToken({ tokenFile }, {}), 'file-token');
  await assert.rejects(readToken({}, {}), /TOKEN_REQUIRED/);
  await assert.rejects(readToken({}, { REMOTE_PRINT_TOKEN: 'bad\nsecret' }), /TOKEN_REQUIRED/);
});

test('CLI imports without Windows printer library and parses explicit config path', () => {
  assert.equal(parseArgs(['--once', '/tmp/example.json']).configPath, path.resolve('/tmp/example.json'));
  assert.ok(parseArgs(['--dry-run']).flags.has('--dry-run'));
  assert.throws(() => parseArgs(['--setup', '--once']), /ARGUMENT_INVALID/);
});

test('maximum-sized valid PDF does not overflow regex stack', () => {
  const big = Buffer.alloc(MAX_PDF, 65); big.write('%PDF-');
  assert.equal(validateJob(job({ pdfBase64: big.toString('base64'), sha256: hash(big) }), rawConfig).pdf.length, MAX_PDF);
});

test('reconnect retries pending submitted ACK and never invokes driver twice', async t => {
  const f = await fixture(t); const original = f.deps.request; const waits = [];
  let failed = false;
  f.deps.request = async (...args) => {
    if (args[1].endsWith('/result') && !failed) { failed = true; throw new AgentError('SERVER_UNREACHABLE'); }
    return original(...args);
  };
  let attempts = 0;
  await runWithReconnect(f.config, f.deps, {
    sleep: async ms => { waits.push(ms); },
    run: async (config, deps) => { attempts++; return runAgent(config, deps, { once: true }); }
  });
  assert.equal(attempts, 2); assert.deepEqual(waits, [5000]);
  assert.equal(f.prints.length, 1);
  assert.ok(f.acks.every(a => a.status === 'submitted'));
  assert.equal((await f.readLedger()).jobs['job-1'].acked, true);
});

test('reconnect backoff is bounded, fatal errors stop, once does not retry', async () => {
  const waits = []; let calls = 0;
  await assert.rejects(runWithReconnect(rawConfig, {}, {
    sleep: async ms => waits.push(ms),
    run: async () => { if (++calls <= 6) throw new AgentError('SERVER_HTTP_ERROR'); throw new AgentError('LEDGER_CORRUPT_OR_UNREADABLE'); }
  }), /LEDGER_CORRUPT_OR_UNREADABLE/);
  assert.deepEqual(waits, [5000, 10000, 20000, 30000, 30000, 30000]);
  await assert.rejects(runWithReconnect(rawConfig, {}, {
    once: true, sleep: async () => assert.fail('must not sleep'),
    run: async () => { throw new AgentError('SERVER_UNREACHABLE'); }
  }), /SERVER_UNREACHABLE/);
  for (const code of ['DUPLICATE_HASH_CONFLICT', 'STATE_SAVE_FAILED', 'SERVER_REJECTED']) {
    await assert.rejects(runWithReconnect(rawConfig, {}, {
      run: async () => { throw new AgentError(code); }, sleep: async () => assert.fail('fatal error retried')
    }), new RegExp(code));
  }
});

test('transport sends bearer JSON, timeout and no-redirect policy; rejects redirect', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const seen = [];
  globalThis.fetch = async (url, options) => {
    seen.push({ url, options });
    return new Response(JSON.stringify({ ok: true, job: { status: 'submitted' } }), { status: 200 });
  };
  assert.equal((await request(rawConfig, '/v1/agent/jobs/job-1/result', { agentId: 'agent-1', status: 'submitted' }, 'test-token')).ok, true);
  assert.equal(seen[0].options.redirect, 'error');
  assert.equal(seen[0].options.headers.authorization, 'Bearer test-token');
  assert.equal(seen[0].options.method, 'POST');
  assert.ok(seen[0].options.signal instanceof AbortSignal);
  globalThis.fetch = async () => new Response(null, { status: 401 });
  await assert.rejects(request(rawConfig, '/v1/agent/claim', {}, 'test-token'), /SERVER_REJECTED/);
  globalThis.fetch = async () => new Response(null, { status: 503 });
  await assert.rejects(request(rawConfig, '/v1/agent/claim', {}, 'test-token'), /SERVER_HTTP_ERROR/);
  globalThis.fetch = async () => new Response(null, { status: 204 });
  assert.equal(await request(rawConfig, '/v1/agent/claim', {}, 'test-token'), null);
  globalThis.fetch = async () => { throw new TypeError('redirect or private network details'); };
  await assert.rejects(request(rawConfig, '/v1/agent/claim', {}, 'test-token'), /SERVER_UNREACHABLE/);
});
