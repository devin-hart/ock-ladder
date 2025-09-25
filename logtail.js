// logtail.js — tolerant to "1397:07Kill:" (no space), long minutes, debug mode
const fs = require('fs');
const { spawn } = require('child_process');
const readline = require('readline');

const LOG = process.env.Q3_LOG || `${process.env.HOME}/.q3a/excessiveplus/games.log`;

/* ---------- helpers ---------- */
const now = () => Date.now();
// Strip an optional "mm:ss" or "mmmm:ss" prefix with or without a following space
// Examples: "12:34Kill: ...", "1397:07Kill: ...", "  9:03 ClientUserinfoChanged: ..."
const normalizeLine = (line = '') => line.replace(/^\s*\d{1,5}:\d{2}\s*/, '').trimEnd();
const stripColors = (s = '') => s.replace(/\^[0-9]/g, '');

// \key\val\key\val...
const parseInfoString = (s = '') => {
  const out = {};
  if (!s) return out;
  const parts = s.split('\\');
  for (let i = 1; i + 1 < parts.length; i += 2) out[parts[i]] = parts[i + 1];
  return out;
};

/* ---------- tolerant regexes (not anchored at start) ---------- */
const RE_INIT     = /InitGame:\s+(.*)$/;
const RE_SHUTDOWN = /ShutdownGame:/;
// "ClientUserinfoChanged: 3 n\^4rail^7god\c\2..." (some mods use "name\" instead of "n\")
const RE_USER     = /ClientUserinfoChanged:\s+(\d+)\s+(.*)$/;
// "Kill: 2 3 7: killer killed victim by MOD_RAILGUN" (3rd number sometimes omitted)
// Allow any ALLCAPS/underscore mod token; names can contain colors, so strip after.
const RE_KILL     = /Kill:\s+(\d+)\s+(\d+)(?:\s+\d+)?:\s+(.*?)\s+killed\s+(.*?)\s+by\s+([A-Z0-9_]+)/;

/* ---------- line parsers ---------- */
const parseInitGame = (line) => {
  const m = RE_INIT.exec(line);
  if (!m) return null;
  const info = parseInfoString(m[1] || '');
  return {
    map: info.mapname || 'unknown',
    gametype: info.g_gametype || info.gametype || '0',
    hostname: info.sv_hostname || info.hostname || '',
  };
};

const parseClientUserinfoChanged = (line) => {
  const m = RE_USER.exec(line);
  if (!m) return null;
  const clientId = +m[1];
  const info = parseInfoString(m[2] || '');
  const name_colored = info.n || info.name || '';
  const name_clean = stripColors(name_colored).trim();
  return { clientId, name_colored, name_clean };
};

const parseKill = (line) => {
  const m = RE_KILL.exec(line);
  if (!m) return null;
  const killerName = stripColors(m[3]).trim();
  const victimName = stripColors(m[4]).trim();
  return {
    killerId: +m[1],
    victimId: +m[2],
    killer: { name: killerName },
    victim: { name: victimName },
    mod: m[5],
  };
};

/* ---------- dispatcher with debug ---------- */
const DEBUG_TAIL = process.env.DEBUG_TAIL === '1';

const dispatch = (raw, onEvent) => {
  const line = normalizeLine(raw);
  if (!line) return;

  if (line.includes('InitGame:')) {
    const meta = parseInitGame(line);
    if (meta) return onEvent({ type: 'InitGame', ...meta, ts: now() });
  }
  if (line.includes('ShutdownGame:')) {
    return onEvent({ type: 'ShutdownGame', ts: now() });
  }
  if (line.includes('ClientUserinfoChanged:')) {
    const u = parseClientUserinfoChanged(line);
    if (u) return onEvent({ type: 'ClientUserinfoChanged', ...u, ts: now() });
  }
  if (line.includes('Kill:')) {
    const k = parseKill(line);
    if (k) return onEvent({ type: 'Kill', ...k, ts: now() });
  }

  if (DEBUG_TAIL && /(InitGame:|ShutdownGame:|ClientUserinfoChanged:|Kill:)/.test(line)) {
    console.log('UNMATCHED:', raw);
  }
};

/* ---------- seeding + tail ---------- */
const seedFromFile = (onEvent, logPath = LOG) =>
  new Promise((resolve) => {
    try {
      if (!fs.existsSync(logPath)) return resolve();
      const stream = fs.createReadStream(logPath, { encoding: 'utf8' });
      const rl = readline.createInterface({ input: stream });
      const emitSeed = (evt) => { evt._seed = true; onEvent(evt); };
      rl.on('line', (raw) => dispatch(raw, emitSeed));
      rl.once('close', resolve);
      rl.once('error', () => resolve());
    } catch {
      resolve();
    }
  });

const startTail = async (onEvent, logPath = LOG) => {
  await seedFromFile(onEvent, logPath);

  const spawnTail = () => {
    const child = spawn('tail', ['-n', '0', '-F', logPath], { stdio: ['ignore', 'pipe', 'inherit'] });
    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (raw) => dispatch(raw, onEvent));

    const restart = () => setTimeout(spawnTail, 1000);
    child.once('error', restart);
    child.once('close', restart);
  };

  spawnTail();
};

/* ---------- in-memory state (unchanged) ---------- */
class MatchState {
  constructor() {
    this.current = null;
    this.playersById = {};
    this.stats = {};
  }

  onEvent = (evt = {}) => {
    switch (evt.type) {
      case 'InitGame': {
        this.current = { map: evt.map, gametype: evt.gametype, hostname: evt.hostname, startedAt: now() };
        this.playersById = {};
        this.stats = {};
        return;
      }
      case 'ShutdownGame': {
        this.current = null;
        return;
      }
      case 'ClientUserinfoChanged': {
        this.playersById[evt.clientId] = {
          name_colored: evt.name_colored,
          name_clean: evt.name_clean,
          lastSeen: now(),
        };
        const n = evt.name_clean;
        if (n && n !== '<world>' && !this.stats[n]) this.stats[n] = { kills: 0, deaths: 0 };
        return;
      }
      case 'Kill': {
        const k = evt.killer?.name;
        const v = evt.victim?.name;
        if (v) {
          if (!this.stats[v]) this.stats[v] = { kills: 0, deaths: 0 };
          this.stats[v].deaths += 1;
        }
        if (k && k !== '<world>') {
          if (!this.stats[k]) this.stats[k] = { kills: 0, deaths: 0 };
          this.stats[k].kills += 1;
        }
        return;
      }
      default: return;
    }
  };

  snapshot = () => {
    const players = Object.entries(this.stats)
      .filter(([name]) => name && name !== '<world>')
      .map(([name, s]) => ({ name, kills: s.kills, deaths: s.deaths, kd: s.deaths ? +(s.kills / s.deaths).toFixed(2) : s.kills }))
      .sort((a, b) => b.kills - a.kills);

    return { match: this.current, players };
  };
}

module.exports = { startTail, MatchState, LOG };
