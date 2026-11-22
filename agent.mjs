#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { AgentError, validateConfig, runWithReconnect } from './agent-core.mjs';

// This module stays importable for synthetic tests on macOS/Linux.
export async function windowsPrinter() {
  if (process.platform !== 'win32') throw new AgentError('WINDOWS_REQUIRED');
  const module = await import('pdf-to-printer');
  const api = module.default ?? module;
  return { getPrinters: () => api.getPrinters(), print: (file, options) => api.print(file, options) };
}

export function parseArgs(args) {
  const flags = new Set(); let configPath;
  for (const arg of args) {
    if (['--setup', '--printers', '--once', '--dry-run', '--help'].includes(arg)) flags.add(arg);
    else if (arg.startsWith('-') || configPath) throw new AgentError('ARGUMENT_INVALID');
    else configPath = path.resolve(arg);
  }
  if (flags.has('--setup') && flags.size > 1) throw new AgentError('ARGUMENT_INVALID');
  if (flags.has('--printers') && flags.size > 1) throw new AgentError('ARGUMENT_INVALID');
  return { flags, configPath: configPath ?? path.resolve('agent.config.json') };
}

async function setup(configPath, api) {
  const printers = await api.getPrinters();
  if (!printers.length) throw new AgentError('NO_WINDOWS_PRINTERS');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ask = async (label, fallback = '') => (await rl.question(`${label}${fallback ? ` [${fallback}]` : ''}: `)).trim() || fallback;
    const serverUrl = await ask('Server origin (HTTPS; local test may use http://127.0.0.1:port)');
    const printerId = await ask('Printer ID');
    const defaultId = os.hostname().replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 100) || 'print-pc';
    const agentId = await ask('Agent ID', defaultId);
    console.log('Windows printers (exact driver names):');
    printers.forEach((p, i) => console.log(`${i + 1}. ${p.name}`));
    const choice = await ask('Printer number');
    if (!/^[1-9][0-9]*$/.test(choice) || !printers[Number(choice) - 1]) throw new AgentError('PRINTER_SELECTION_INVALID');
    const printerName = printers[Number(choice) - 1].name;
    console.log('Set the actual label stock/form in Windows printer preferences. Blank below uses the driver default; no label size is assumed.');
    const paperSize = await ask('Optional Windows driver paper form name (blank = driver default)');
    console.log('Do not type the token into this wizard or put it in JSON. Use REMOTE_PRINT_TOKEN in the agent process environment.');
    console.log('PowerShell hidden entry (session only; start the agent from this same window):');
    console.log('$s = Read-Host "Remote print token" -AsSecureString');
    console.log('$env:REMOTE_PRINT_TOKEN = [System.Net.NetworkCredential]::new("", $s).Password');
    console.log('Run set-token.cmd separately to create ./agent.token with masked input and a user-only ACL. This file works at logon; session environment variables do not survive logon.');
    const tokenFile = await ask('Private token file path (created by set-token.cmd; environment overrides it)', './agent.token');
    const config = { serverUrl, agentId, printerId, printerName, pollIntervalMs: 3000, stateDir: './agent-state',
      ...(paperSize ? { paperSize } : {}), ...(tokenFile ? { tokenFile } : {}) };
    validateConfig(config, path.dirname(configPath));
    // Refuse to overwrite an existing configuration, including accidentally pasted credentials.
    const file = await fs.open(configPath, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(config, null, 2) + '\n'); await file.sync(); } finally { await file.close(); }
    console.log('Configuration saved. Use --dry-run to validate and list printers without claiming or acknowledging jobs.');
    console.log('Physical output: NOT_OBSERVED');
  } finally { rl.close(); }
}

export async function main(args = process.argv.slice(2)) {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new AgentError('NODE_22_REQUIRED');
  const { flags, configPath } = parseArgs(args);
  if (flags.has('--help')) {
    console.log('node agent.mjs [config.json] [--setup | --printers | --once | --dry-run]');
    console.log('Default config: ./agent.config.json. Relative stateDir/tokenFile resolve beside that config.');
    console.log('--dry-run: validate configuration and list printers only; no network, claim, ACK or print.');
    console.log('A stale agent.lock requires explicit operator recovery: stop all agents, confirm no process is printing, preserve state, then remove only agent.lock. Never delete ledger.json to retry.');
    return;
  }
  const api = await windowsPrinter();
  if (flags.has('--printers')) {
    for (const printer of await api.getPrinters()) console.log(printer.name);
    return;
  }
  if (flags.has('--setup')) return setup(configPath, api);
  let config;
  try { config = JSON.parse(await fs.readFile(configPath, 'utf8')); }
  catch { throw new AgentError('CONFIG_UNREADABLE_OR_INVALID_JSON'); }
  config = validateConfig(config, path.dirname(configPath));
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    const result = await runWithReconnect(config, api, {
      once: flags.has('--once'), dryRun: flags.has('--dry-run'), signal: controller.signal,
      onRetry: (code, ms) => console.error(`${code}; reconnect in ${ms / 1000}s. Pending ACK retained; no reprint.`)
    });
    if (result.dryRun) console.log(JSON.stringify(result));
    else console.log('Agent stopped. Physical output: NOT_OBSERVED');
  } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error instanceof AgentError ? error.code : 'AGENT_STOPPED_LOCAL_ERROR');
    console.error('Stopped; preserve ledger and pending ACKs. No automatic reprint. Physical output: NOT_OBSERVED');
    process.exitCode = 1;
  });
}
