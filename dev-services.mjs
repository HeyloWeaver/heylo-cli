#!/usr/bin/env node
/**
 * Start one or more local dev servers (API, Web, Go/AppSync) with optional interactive pick.
 * Services not started locally automatically fall back to cloud URLs from the chosen env file.
 *
 * Usage:
 *   node dev-services.mjs
 *   node dev-services.mjs api web
 *   node dev-services.mjs --all
 *   node dev-services.mjs --env local
 *   node dev-services.mjs --db local
 *   node dev-services.mjs --env dev api web
 *   npm run dev:services -- api
 */
import { execSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

{
  const lockfile = join(ROOT, 'package-lock.json');
  const marker = join(ROOT, 'node_modules', '.package-lock.json');
  const stale = !existsSync(marker) ||
    (existsSync(lockfile) && statSync(lockfile).mtimeMs > statSync(marker).mtimeMs);
  if (stale) {
    console.log('[heylo] Dependencies out of date — running npm install…');
    execSync('npm install', { cwd: ROOT, stdio: 'inherit' });
  }
}

const { default: prompts } = await import('prompts');

/**
 * Read key=value pairs from an env file without touching process.env.
 * @param {string} filePath
 * @returns {Record<string, string>}
 */
function readEnvFile(filePath) {
  try {
    const src = readFileSync(filePath, 'utf8');
    const env = {};
    for (const line of src.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^"|"$/g, '');
      env[key] = val;
    }
    return env;
  } catch {
    return {};
  }
}

const ENV_PROFILES = {
  local: '.env.local',
  dev: '.env.dev',
};

/**
 * Load base .env then overlay the chosen profile file on top.
 * Override file is applied after base so its values take precedence.
 * Returns the merged vars for display purposes.
 * @param {'local'|'dev'} profile
 * @returns {Record<string, string>}
 */
function applyEnvProfile(profile) {
  const baseVars = readEnvFile(join(ROOT, '.env'));
  const overrideVars = readEnvFile(join(ROOT, ENV_PROFILES[profile]));
  const merged = { ...baseVars, ...overrideVars };
  for (const [k, v] of Object.entries(merged)) {
    process.env[k] = v;
  }
  const dbHost = overrideVars.DB_HOST || merged.DB_HOST || '';
  const dbTag = profile === 'local'
    ? '↳ local  127.0.0.1:3306 (Docker)'
    : `↳ dev    ${dbHost}`;
  console.log(`DB       ${dbTag}`);
  return merged;
}

/**
 * Each service declares the env vars it provides when running locally.
 * .env should hold the cloud equivalents as defaults — the CLI injects
 * localhost values for whichever services you actually start.
 *
 * @type {{ id: string, title: string, npmScript: string, color: string, port: number, localEnv: Record<string, string> }[]}
 */
const SERVICES = [
  {
    id: 'api',
    title: 'API (Nest, heylo-api)',
    npmScript: 'dev:api',
    color: 'blue',
    port: 4000,
    localEnv: {
      NEXT_PUBLIC_API_BASE_URL: 'http://localhost:4000',
    },
  },
  {
    id: 'web',
    title: 'Web (Next, heylo-web)',
    npmScript: 'dev:web',
    color: 'magenta',
    port: 3000,
    localEnv: {},
  },
  {
    id: 'go',
    title: 'AppSync (Go — local GraphQL + cloud MySQL via DB_* in .env)',
    npmScript: 'dev:go',
    color: 'cyan',
    port: 8080,
    localEnv: {
      NEXT_PUBLIC_APPSYNC_GRAPHQL_ENDPOINT: 'http://localhost:8080/graphql',
    },
  },
];

const ANSI_COLORS = {
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
};
const ANSI_RESET = '\x1b[0m';

const WEB_RECOVERABLE_ERROR_PATTERNS = [
  /Could not find the module .* in the React Client Manifest/,
  /Cannot find module '\.\/\d+\.js'/,
  /Cannot read properties of undefined \(reading 'call'\)/,
];

function printHelp() {
  console.log(`Heylo local dev — pick which services to run.
Services not started locally fall back to cloud URLs from .env automatically.

Usage:
  heylo [options] [service ...]
  npm run dev:services -- [options] [service ...]

Services:
${SERVICES.map((s) => `  ${s.id.padEnd(8)} ${s.title}`).join('\n')}

Options:
  -a, --all          Start every service locally
  --env local|dev    Environment: local Docker DB or dev cloud RDS (default: prompt)
  --db local|dev     Same as --env (shorthand for “which database”)
  -h, --help         Show this help

Examples:
  heylo                          # interactive pick: services + env
  heylo api                      # API local, everything else → cloud (prompts for env)
  heylo api web --env local      # API + web local, Docker MySQL
  heylo api web --db local       # same as --env local
  heylo go --env dev             # Go GraphQL, cloud RDS
  heylo --all --env local        # all services local, Docker MySQL
`);
}

function parseArgv(argv) {
  const raw = argv.slice(2);
  if (raw.some((a) => a === '-h' || a === '--help')) return { help: true };
  const all = raw.some((a) => a === '-a' || a === '--all');
  const envIdx = raw.findIndex((a) => a === '--env' || a === '--db');
  const env = envIdx !== -1 ? raw[envIdx + 1] : null;
  if (env && !ENV_PROFILES[env]) {
    console.error(`Unknown --env/--db value: "${env}". Valid: ${Object.keys(ENV_PROFILES).join(', ')}`);
    process.exit(1);
  }
  const ids = raw.filter((a, i) => !a.startsWith('-') && !raw[i - 1]?.startsWith('--'));
  return { help: false, all, ids, env };
}

function validateIds(ids) {
  const known = new Set(SERVICES.map((s) => s.id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length) {
    console.error(`Unknown service(s): ${unknown.join(', ')}`);
    console.error(`Valid: ${[...known].join(', ')}`);
    process.exit(1);
  }
}

/** @param {string[]} ids */
function orderedServices(ids) {
  const seen = new Set();
  const out = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const svc = SERVICES.find((s) => s.id === id);
    if (svc) out.push(svc);
  }
  return out;
}

async function pickServices() {
  const { picked } = await prompts({
    type: 'multiselect',
    name: 'picked',
    message: 'Which services should we start?',
    choices: SERVICES.map((s) => ({ title: s.title, value: s.id })),
    hint: 'Space toggles · Enter runs',
    instructions: false,
    min: 1,
  });
  if (!picked?.length) {
    console.error('Nothing selected.');
    process.exit(1);
  }
  return picked;
}

async function pickEnv() {
  const { env } = await prompts({
    type: 'select',
    name: 'env',
    message: 'Which environment?',
    choices: [
      { title: 'local  — Docker MySQL (127.0.0.1:3306)', value: 'local' },
      { title: 'dev    — Cloud RDS (AWS dev)', value: 'dev' },
    ],
  });
  if (!env) {
    console.error('No environment selected.');
    process.exit(1);
  }
  return env;
}

function warnMissingEnv(profile) {
  if (!existsSync(join(ROOT, '.env'))) {
    console.warn('Warning: .env not found. Copy .env.example and fill in values.\n');
  }
  const overrideFile = ENV_PROFILES[profile];
  if (!existsSync(join(ROOT, overrideFile))) {
    console.warn(`Warning: ${overrideFile} not found. Copy ${overrideFile}.example and fill in values.\n`);
  }
}

/**
 * For each service running locally, inject its localEnv values into process.env so
 * child processes inherit them. dotenv-cli won't overwrite already-set vars, so local
 * values take precedence over whatever .env has.
 *
 * Services NOT in `selected` keep whatever .env has (their cloud URLs).
 * Prints a routing summary so it's always clear what's hitting local vs cloud.
 *
 * @param {typeof SERVICES} selected
 * @param {Record<string, string>} envVars  parsed env file values (for display only)
 */
function applyLocalEnv(selected, envVars) {
  const selectedIds = new Set(selected.map((s) => s.id));
  const rows = [];

  for (const svc of SERVICES) {
    if (!Object.keys(svc.localEnv).length) continue; // web has no env vars to route
    const isLocal = selectedIds.has(svc.id);
    for (const [key, localVal] of Object.entries(svc.localEnv)) {
      if (isLocal) {
        process.env[key] = localVal;
        rows.push({ label: key, value: localVal, tag: 'local' });
      } else {
        const cloudVal = envVars[key] || process.env[key] || '(not set in env file)';
        rows.push({ label: key, value: cloudVal, tag: 'cloud' });
      }
    }
  }

  if (rows.length) {
    const pad = Math.max(...rows.map((r) => r.label.length));
    console.log('\nRouting:');
    for (const { label, value, tag } of rows) {
      const marker = tag === 'local' ? '↳ local' : '↳ cloud';
      console.log(`  ${label.padEnd(pad)}  ${marker}  ${value}`);
    }
    console.log('');
  }
}

/**
 * Run a single shell command from the repo root; exits the process when the child exits.
 * @param {string} command
 */
function runShell(command) {
  return new Promise((_, reject) => {
    const child = spawn(command, {
      cwd: ROOT,
      stdio: 'inherit',
      env: process.env,
      shell: true,
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (signal) process.exit(1);
      process.exit(code ?? 1);
    });
  });
}

/**
 * Prefix child output line-by-line so we can keep service logs readable without
 * shelling out to concurrently. The returned function flushes a partial line.
 * @param {{ id: string, color: string }} svc
 * @param {(line: string) => void} onLine
 */
function createLineWriter(svc, onLine) {
  let pending = '';
  const color = ANSI_COLORS[svc.color] ?? '';
  const prefix = `${color}[${svc.id}]${ANSI_RESET} `;

  return {
    write(chunk) {
      pending += chunk.toString();
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) {
        console.log(prefix + line);
        onLine(line);
      }
    },
    flush() {
      if (!pending) return;
      console.log(prefix + pending);
      onLine(pending);
      pending = '';
    },
  };
}

/**
 * Run selected services directly so the CLI can recover the Next dev server
 * when its HMR/client manifest gets into a bad state.
 *
 * @param {typeof SERVICES} selected
 */
function runManagedServices(selected) {
  return new Promise((resolve) => {
    /** @type {Map<string, { svc: typeof SERVICES[number], child: import('node:child_process').ChildProcess, stopping: boolean, restarting: boolean, restartTimer: NodeJS.Timeout | null }>} */
    const running = new Map();
    let shuttingDown = false;
    let exitCode = 0;

    const stopAll = (code = 0) => {
      if (shuttingDown) return;
      shuttingDown = true;
      exitCode = code;
      for (const state of running.values()) {
        state.stopping = true;
        state.child.kill('SIGTERM');
      }
      if (running.size === 0) resolve(exitCode);
    };

    const maybeResolveShutdown = () => {
      if (shuttingDown && running.size === 0) {
        resolve(exitCode);
      }
    };

    const scheduleWebRestart = () => {
      const state = running.get('web');
      if (!state || state.stopping || state.restarting) return;

      state.restarting = true;
      console.log('\n[web] Detected a recoverable Next dev/HMR cache error; restarting web only...\n');
      state.restartTimer = setTimeout(() => {
        state.stopping = true;
        state.child.kill('SIGTERM');
      }, 100);
    };

    const startService = (svc) => {
      const child = spawn('npm', ['run', svc.npmScript], {
        cwd: ROOT,
        env: process.env,
        stdio: ['inherit', 'pipe', 'pipe'],
      });

      const state = {
        svc,
        child,
        stopping: false,
        restarting: false,
        restartTimer: null,
      };
      running.set(svc.id, state);

      const onLine = (line) => {
        if (
          svc.id === 'web' &&
          WEB_RECOVERABLE_ERROR_PATTERNS.some((pattern) => pattern.test(line))
        ) {
          scheduleWebRestart();
        }
      };

      const stdout = createLineWriter(svc, onLine);
      const stderr = createLineWriter(svc, onLine);
      child.stdout?.on('data', (chunk) => stdout.write(chunk));
      child.stderr?.on('data', (chunk) => stderr.write(chunk));

      child.on('error', (err) => {
        console.error(`[${svc.id}]`, err);
        if (!state.restarting) stopAll(1);
      });

      child.on('exit', (code, signal) => {
        stdout.flush();
        stderr.flush();
        running.delete(svc.id);
        if (state.restartTimer) clearTimeout(state.restartTimer);

        if (shuttingDown) {
          maybeResolveShutdown();
          return;
        }

        if (state.restarting && svc.id === 'web') {
          startService(svc);
          return;
        }

        console.log(`[${svc.id}] exited ${signal ? `with signal ${signal}` : `with code ${code ?? 0}`}`);
        stopAll(code ?? 1);
      });
    };

    process.once('SIGINT', () => stopAll(0));
    process.once('SIGTERM', () => stopAll(0));

    for (const svc of selected) {
      startService(svc);
    }
  }).then((code) => {
    process.exit(code);
  });
}

/**
 * @param {typeof SERVICES} selected
 * @param {Record<string, string>} envVars
 */
async function start(selected, envVars) {
  applyLocalEnv(selected, envVars);

  if (selected.some((svc) => svc.id === 'web')) {
    await runManagedServices(selected);
    return;
  }

  if (selected.length === 1) {
    await runShell(`npm run ${selected[0].npmScript}`);
    return;
  }
  const names = selected.map((s) => s.id).join(',');
  const colors = selected.map((s) => s.color).join(',');
  const quoted = selected.map((s) => `"npm run ${s.npmScript}"`).join(' ');
  await runShell(`npx concurrently -k -n ${names} -c ${colors} ${quoted}`);
}

async function main() {
  const { help, all, ids: cliIds, env: cliEnv } = parseArgv(process.argv);
  if (help) {
    printHelp();
    process.exit(0);
  }

  let ids;
  if (all) {
    ids = SERVICES.map((s) => s.id);
  } else if (cliIds.length) {
    ids = cliIds;
  } else if (process.stdin.isTTY) {
    ids = await pickServices();
  } else {
    console.error('Not a TTY: pass service ids (api, web, go), or use --all. See --help.');
    process.exit(1);
  }

  const env = cliEnv ?? (process.stdin.isTTY ? await pickEnv() : 'dev');

  validateIds(ids);
  warnMissingEnv(env);
  const selected = orderedServices(ids);
  const envVars = applyEnvProfile(env);
  await start(selected, envVars);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
