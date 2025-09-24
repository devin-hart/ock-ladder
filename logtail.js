// logtail.js
const fs = require('fs');
const { spawn } = require('child_process');
const readline = require('readline');
const path = require('path');
const os = require('os');

const LOG = process.env.Q3_LOG || `${process.env.HOME}/.q3a/excessiveplus/games.log`;

// Some Quake log formats prefix lines with " 5:07 " timestamps.
// Normalize by stripping any leading "hh:mm " (with optional leading spaces).
function normalize(line) {
  return line.replace(/^\s*\d{1,2}:\d{2}\s+/, '');
}

function stripColors(s) {
  return s.replace(/\^[0-9]/g, '');
}

// Parse \key\value info strings
function parseInfoString(s) {
  const out = {};
  const parts = s.split('\\').slice(1);
  for (let i = 0; i < parts.length; i += 2) out[parts[i]] = parts[i + 1];
  return out;
}

function parseKill(line) {
  // Kill: <killerId> <victimId> <modId>: <killer> killed <victim> by MOD_XXXX
  const m = line.match(/^Kill:\s+(\d+)\s+(\d+)\s+(\d+):\s+(.*?)\s+killed\s+(.*?)\s+by\s+(MOD_\w+)/);
  return m
    ? {
        killerId: +m[1],
        victimId: +m[2],
        killerName: stripColors(m[4]),
        victimName: stripColors(m[5]),
        mod: m[6],
      }
    : null;
}

function parseClientUserinfoChanged(line) {
  // ClientUserinfoChanged: 2 n\Name\...
  const idm = line.match(/^ClientUserinfoChanged:\s+(\d+)\s+(.*)$/);
  if (!idm) return null;
  const cid = +idm[1];
  const info = parseInfoString(idm[2] || '');
  const nameColored = info.n || '';
  return { clientId: cid, nameColored, nameClean: stripColors(nameColored) };
}

function parseInitGame(line) {
  // InitGame: \key\val\key\val...
  const m = line.match(/^InitGame:\s+(.*)$/);
  if (!m) return null;
  const info = parseInfoString(m[1] || '');
  return {
    map: info.mapname || 'unknown',
    gametype: info.g_gametype || info.gametype || '0',
    hostname: info.sv_hostname || '',
  };
}

function dispatch(raw, onEvent) {
  const line = normalize(raw);
  if (line.startsWith('InitGame:')) {
    const meta = parseInitGame(line);
    if (meta) onEvent({ type: 'init', meta });
    return;
  }
  if (line.startsWith('ShutdownGame:')) {
    onEvent({ type: 'shutdown' });
    return;
  }
  if (line.startsWith('ClientUserinfoChanged:')) {
    const u = parseClientUserinfoChanged(line);
    if (u) onEvent({ type: 'user', ...u });
    return;
  }
  if (line.startsWith('Kill:')) {
    const k = parseKill(line);
    if (k) onEvent({ type: 'kill', ...k });
    return;
  }
}

// Reads the entire log once at boot and emits "seed" events that DO NOT persist to DB
function seedFromFile(onEvent) {
  try {
    const data = fs.readFileSync(LOG, 'utf8');
    if (!data) return;
    const emitSeed = (evt) => { evt._seed = true; onEvent(evt); }; // mark seeds
    for (const raw of data.split('\n')) {
      if (!raw) continue;
      dispatch(raw, emitSeed);
    }
  } catch { /* ignore */ }
}

function startTail(onEvent) {
  // Replay existing log once, then follow new lines
  seedFromFile(onEvent);

  const child = spawn('tail', ['-n', '0', '-F', LOG]);
  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', (raw) => dispatch(raw, onEvent));
  child.on('error', (err) => onEvent({ type: 'error', err }));
  return () => {
    try {
      child.kill();
    } catch (_) {}
  };
}

// In-memory state for /api/match
class MatchState {
  constructor() {
    this.reset();
  }
  reset() {
    this.current = null; // { map, gametype, hostname, startedAt }
    this.playersById = {}; // id -> { nameColored, nameClean, lastSeen }
    this.stats = {}; // nameClean -> { kills, deaths }
  }
  onEvent(evt) {
    if (evt.type === 'init') {
      this.current = { ...evt.meta, startedAt: Date.now() };
      this.playersById = {};
      this.stats = {};
    }
    if (evt.type === 'user') {
      this.playersById[evt.clientId] = {
        nameColored: evt.nameColored,
        nameClean: evt.nameClean,
        lastSeen: Date.now(),
      };
      if (evt.nameClean && evt.nameClean !== '<world>' && !this.stats[evt.nameClean]) {
        this.stats[evt.nameClean] = { kills: 0, deaths: 0 };
      }
    }
    if (evt.type === 'kill') {
      const k = evt.killerName;
      const v = evt.victimName;

      // Always count the victim's death
      if (v) {
        if (!this.stats[v]) this.stats[v] = { kills: 0, deaths: 0 };
        this.stats[v].deaths += 1;
      }

      // Count killer only if it's a real player (not <world> or empty)
      if (k && k !== '<world>') {
        if (!this.stats[k]) this.stats[k] = { kills: 0, deaths: 0 };
        this.stats[k].kills += 1;
      }
    }
    if (evt.type === 'shutdown') {
      this.current = null;
    }
  }
  snapshot() {
    const players = Object.entries(this.stats)
      .filter(([name]) => name && name !== '<world>') // drop world/empty
      .map(([name, s]) => ({
        name,
        kills: s.kills,
        deaths: s.deaths,
        kd: s.deaths ? +(s.kills / s.deaths).toFixed(2) : s.kills,
      }))
      .sort((a, b) => b.kills - a.kills);
    return {
      match: this.current,
      players,
    };
  }
}

module.exports = { startTail, MatchState, LOG };
