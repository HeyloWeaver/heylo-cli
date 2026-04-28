#!/usr/bin/env node
/**
 * Run AppSync resolvers locally (HTTP) without editing main.go.
 *
 * With -tags local, main_local.go provides main(), but main.go also defines
 * lambda main(). Go's -overlay swaps main.go for a generated copy that omits
 * func main() so the tree compiles.
 *
 * MySQL: main.go defaults to local 127.0.0.1:3306. This script injects the same DSN
 * precedence as go/mysql_dsn.go via `-ldflags -X main.DbConnection=…` when
 * APPSYNC_MYSQL_DSN, MYSQL_DSN, or DB_HOST+DB_USER+DB_NAME are set (e.g. from
 * `dotenv -e .env` / SSM port-forward to cloud RDS).
 *
 * Usage (from repo root):
 *   node appsync-local-dev.mjs              # run once (no file watching)
 *   node appsync-local-dev.mjs --watch    # restart on .go saves under go/backend/appsync
 */

import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, watch, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const candidateMain = join(SCRIPT_DIR, 'go', 'backend', 'appsync', 'main.go');
const ROOT = existsSync(candidateMain)
  ? SCRIPT_DIR
  : resolve(SCRIPT_DIR, '..');
const APPSYNC_DIR = join(ROOT, 'go', 'backend', 'appsync');
const MAIN_GO = join(APPSYNC_DIR, 'main.go');
/** Generated Go `-overlay` files (kept out of `go/backend/appsync/`). */
const OVERLAY_DIR = join(SCRIPT_DIR, 'appsync-local-dev');
const OVERLAY_MAIN = join(OVERLAY_DIR, 'main.overlay.go');
const OVERLAY_JSON = join(OVERLAY_DIR, 'overlay.json');

const watchMode = process.argv.includes('--watch');

const LOCAL_DEFAULT_DSN =
  'root@tcp(127.0.0.1:3306)/heylo?parseTime=true&loc=UTC';

function trimEnvQuotes(s) {
  return s.replace(/^['"]|['"]$/g, '');
}

/**
 * Same precedence as go/backend/appsync/mysql_dsn.go (keep in sync).
 * Returns empty string when env does not specify a DSN (caller uses main.go default).
 * @param {NodeJS.ProcessEnv} env
 */
function mysqlDsnFromEnvForLdflags(env) {
  const t = (k) => String(env[k] ?? '').trim();
  const d1 = t('APPSYNC_MYSQL_DSN');
  if (d1) return d1;
  const d2 = t('MYSQL_DSN');
  if (d2) return d2;

  const host = t('DB_HOST');
  const user = t('DB_USER');
  const dbName = t('DB_NAME');
  if (!host || !user || !dbName) {
    return '';
  }
  const port = t('DB_PORT') || '3306';
  const pass = trimEnvQuotes(t('DB_PASS'));
  const addr = host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
  const auth = pass ? `${user}:${pass}` : user;
  return `${auth}@tcp(${addr})/${dbName}?parseTime=true&loc=UTC`;
}

/**
 * Remove the first top-level `func main(...) { ... }` from Go source.
 * Assumes conventional formatting (same as current main.go).
 */
function stripFirstFuncMain(src) {
  const m = /\bfunc\s+main\s*\(/.exec(src);
  if (!m) {
    throw new Error(`Expected to find func main( in ${MAIN_GO}`);
  }
  let i = m.index + m[0].length;
  let depth = 1;
  while (i < src.length && depth > 0) {
    const c = src[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    i++;
  }
  while (i < src.length && /\s/.test(src[i])) i++;
  if (src[i] !== '{') {
    throw new Error('Expected { after func main(...) signature');
  }
  const bodyOpen = i;
  depth = 1;
  i = bodyOpen + 1;
  while (i < src.length && depth > 0) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    i++;
  }
  const before = src.slice(0, m.index).replace(/\n{3,}/g, '\n\n');
  const after = src.slice(i).replace(/^\n+/, '\n');
  return before + after;
}

/** After removing func main, lambda import is unused in the overlay copy. */
function dropUnusedLambdaImport(src) {
  if (/\blambda\./.test(src)) return src;
  return src.replace(
    /\n[\t ]*"github\.com\/aws\/aws-lambda-go\/lambda"\s*\n/,
    '\n',
  );
}

function writeOverlayFiles() {
  mkdirSync(OVERLAY_DIR, { recursive: true });
  const original = readFileSync(MAIN_GO, 'utf8');
  const stripped = dropUnusedLambdaImport(stripFirstFuncMain(original));
  writeFileSync(OVERLAY_MAIN, stripped, 'utf8');
  const replace = {
    Replace: {
      [MAIN_GO]: OVERLAY_MAIN,
    },
  };
  writeFileSync(OVERLAY_JSON, JSON.stringify(replace, null, 0), 'utf8');
}

function runGo(childEnv = process.env) {
  writeOverlayFiles();
  const dsn = mysqlDsnFromEnvForLdflags(childEnv);
  const args = ['run', `-overlay=${OVERLAY_JSON}`, '-tags', 'local'];
  if (dsn && dsn !== LOCAL_DEFAULT_DSN) {
    args.push(`-ldflags=-X=main.DbConnection=${dsn}`);
  }
  args.push('.');
  const go = spawn('go', args, {
    cwd: APPSYNC_DIR,
    stdio: 'inherit',
    env: childEnv,
  });
  return go;
}

let child = null;
let debounce = null;
let stopping = false;
let pendingRestart = false;

function resolveLocalPort(env = process.env) {
  const addr = String(env.APPSYNC_HTTP_ADDR ?? '').trim();
  if (addr) {
    const m = addr.match(/:(\d+)\s*$/);
    if (m) return Number(m[1]);
  }
  const p = String(env.PORT ?? '').trim();
  if (p) return Number(p);
  return 8080;
}

function listListeners(port) {
  try {
    const out = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -Fpc`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const lines = out.split('\n').filter(Boolean);
    const procs = [];
    let current = null;
    for (const line of lines) {
      const prefix = line[0];
      const value = line.slice(1);
      if (prefix === 'p') {
        if (current) procs.push(current);
        current = { pid: Number(value), command: '' };
      } else if (prefix === 'c' && current) {
        current.command = value;
      }
    }
    if (current) procs.push(current);
    return procs.filter((p) => Number.isFinite(p.pid));
  } catch {
    return [];
  }
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensurePortAvailable(port, childPid) {
  const listeners = listListeners(port);
  if (!listeners.length) return;

  for (const proc of listeners) {
    if (proc.pid === process.pid || proc.pid === childPid) continue;
    // Only reap known local appsync/go listeners on this port.
    if (!['appsync', 'go'].includes(proc.command)) continue;
    try {
      process.kill(proc.pid, 'SIGTERM');
    } catch {}
  }

  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (listListeners(port).length === 0) return;
    await sleepMs(100);
  }
}

async function start() {
  if (child || stopping) return;
  await ensurePortAvailable(resolveLocalPort(), child?.pid);
  child = runGo();
  child.on('exit', (code, signal) => {
    child = null;
    stopping = false;
    if (pendingRestart && watchMode) {
      pendingRestart = false;
      void start();
      return;
    }
    if (!watchMode) process.exit(code ?? (signal ? 1 : 0));
  });
  child.on('error', (err) => {
    console.error(err);
    if (!watchMode) process.exit(1);
  });
}

function stop(cb) {
  if (!child) {
    cb?.();
    return;
  }
  const c = child;
  stopping = true;
  c.once('exit', () => cb?.());
  c.kill('SIGTERM');
}

function restart() {
  if (stopping) {
    pendingRestart = true;
    return;
  }
  stop(async () => {
    await start();
  });
}

if (watchMode) {
  void start();
  watch(
    APPSYNC_DIR,
    { recursive: true },
    (_event, filename) => {
      if (!filename) return;
      if (!filename.endsWith('.go')) return;
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        console.log('\n[appsync-local] source changed, restarting…\n');
        restart();
      }, 200);
    },
  );
  process.on('SIGINT', () => {
    stop(() => process.exit(0));
  });
} else {
  void start();
}
