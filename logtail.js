// logtail.js — preserves caret colors; emits colored names into DB events

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/* ------------ config ------------ */
const LOG_PATH =
  process.env.Q3_LOG ||
  path.join(os.homedir(), '.q3a', 'excessiveplus', 'games.log');

const DEBUG = !!process.env.DEBUG_TAIL;

/* ------------ helpers ------------ */

// Parse quake-style \key\val\key\val userinfo blobs verbatim (keep colors)
const parseInfoString = (s = '') => {
  const out = {};
  const parts = s.split('\\');
  for (let i = 1; i + 1 < parts.length; i += 2) out[parts[i]] = parts[i + 1];
  return out;
};

// Minimal cleaner (used only for '<world>' checks in this file, NOT for DB storage)
const isWorldName = (name = '') => name === '<world>' || name === 'world' || name === '';

/* ------------ line parsers ------------ */

const parseInitGame = (line) => {
  // InitGame: \sv_hostname\...\mapname\q3dm17\g_gametype\0\...
  const m = /InitGame:\s+(.*)$/.exec(line);
  if (!m) return null;
  const info = parseInfoString(m[1]);
  return {
    type: 'InitGame',
    map: info.mapname || 'unknown',
    gametype: info.g_gametype || info.gametype || 'FFA',
    ts: Date.now(),
  };
};

const parseShutdownGame = (line) => (/^ShutdownGame:/.test(line) ? { type: 'ShutdownGame', ts: Date.now() } : null);

const parseClientUserinfoChanged = (line) => {
  // ClientUserinfoChanged: <id> \key\val\...
  const m = /ClientUserinfoChanged:\s+(\d+)\s+(.*)$/.exec(line);
  if (!m) return null;
  const clientId = +m[1];
  const info = parseInfoString(m[2] || '');

  // Keep colored display name EXACTLY as the log shows (e.g., ^6d^32)
  const name_colored = info.n || info.name || '';
  const guid = info.cl_guid || info.guid || info.sguid || info.pb_guid || null;
  const ip = (info.ip || '').split(':')[0] || null; // if ever present

  return {
    type: 'ClientUserinfoChanged',
    clientId,
    name_colored, // <- colored name preserved
    // also include a plain 'name' for older consumers that expect it
    name: name_colored,
    guid,
    ip,
    ts: Date.now(),
  };
};

const parseKill = (line) => {
  // Kill: <kid> <vid> <modnum>: <killer> killed <victim> by MOD_XXXX
  const m = /Kill:\s+\d+\s+\d+(?:\s+\d+)?:\s+(.*?)\s+killed\s+(.*?)\s+by\s+([A-Z0-9_]+)/.exec(line);
  if (!m) return null;
  const killer = m[1];  // may be "<world>" or caret-colored name
  const victim = m[2];
  const mod = m[3];

  return {
    type: 'Kill',
    killer: { name: killer },   // <- keep caret codes as-is
    victim: { name: victim },   // <- keep caret codes as-is
    mod,
    ts: Date.now(),
  };
};

const parseLine = (line) =>
  parseInitGame(line) ||
  parseShutdownGame(line) ||
  parseClientUserinfoChanged(line) ||
  parseKill(line) ||
  null;

/* ------------ tail process ------------ */

const startTail = (onEvent) => {
  // ensure the file exists to avoid tail error loop
  if (!fs.existsSync(LOG_PATH)) {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.writeFileSync(LOG_PATH, '', 'utf8');
  }

  const args = ['-n', '0', '-F', LOG_PATH];
  const proc = spawn('tail', args, { stdio: ['ignore', 'pipe', 'pipe'] });

  if (DEBUG) console.error(`[tail] started: tail ${args.join(' ')}`);

  let buf = '';
  const handleChunk = (chunk) => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      if (!line) continue;

      const evt = parseLine(line);
      if (evt) {
        if (DEBUG) console.error(`[tail] ${evt.type}`, JSON.stringify(evt));
        try { onEvent(evt); } catch (e) { if (DEBUG) console.error('[tail] onEvent error', e); }
      }
    }
  };

  proc.stdout.on('data', handleChunk);
  proc.stderr.on('data', (d) => DEBUG && console.error('[tail][stderr]', d.toString()));
  proc.on('exit', (code, sig) => {
    if (DEBUG) console.error(`[tail] exited code=${code} sig=${sig}, respawning in 1s`);
    setTimeout(() => startTail(onEvent), 1000); // auto-respawn
  });

  return proc;
};

module.exports = { startTail, parseLine, LOG_PATH };
