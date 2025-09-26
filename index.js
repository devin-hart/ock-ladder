// index.js — unified /api/snapshot (alias: /api/summary) + ETag + 1s cache

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { getStatus } = require('./status');
const db = require('./db');
const { startTail } = require('./logtail');

const PORT    = +(process.env.PORT || 3000);
const Q3_HOST = process.env.Q3_HOST || '127.0.0.1';
const Q3_PORT = +(process.env.Q3_PORT || 27960);

const app = express();
app.use(cors()); // allow local dev (Vite/localhost)

// ---------------- helpers ----------------
const decolor = (s = '') =>
  s.replace(/\^[0-9]/g, '').replace(/\^x[0-9a-fA-F]{6}/g, '').trim();

const normalizeName = (s = '') => decolor(s).toLowerCase();

const BOT_NAMES = new Set([
  'wrack','visor','gorre','angel','mynx','keel','orbb','cadavre','tankjr','lucy','sarge','grunt',
  'ranger','biker','sorlag','mr.gauntlet','anarki','bitterman','hunter','major','uriel','daemia',
  'klesk','stripe','patriot','lakerbot','bones','slash','argus^f+','xaero','doom','hossman','crash',
  'phobos','razor'
]);

class MatchState {
  constructor() { this.reset(); }
  reset() {
    this.current = null;          // { map, gametype, hostname, startedAt }
    this.playersById = {};        // id -> { nameColored, nameClean, lastSeen }
    this.stats = {};              // nameClean -> { kills, deaths }
    this.id = null;
    this.name = null;
  }
  onEvent(evt) {
    const t = Date.now();
    switch (evt?.type) {
      case 'init':
      case 'InitGame': {
        const meta = evt.meta || evt;
        this.current = {
          map: meta.map || meta.mapname || 'unknown',
          gametype: meta.gametype || meta.g_gametype || 'FFA',
          hostname: meta.hostname || '',
          startedAt: t,
        };
        this.name = this.current.map;
        this.playersById = {};
        this.stats = {};
        return;
      }
      case 'shutdown':
      case 'ShutdownGame':
        this.reset();
        return;

      case 'user':
      case 'ClientUserinfoChanged': {
        const nameColored = evt.name_colored || evt.nameColored || evt.name || '';
        const nameClean   = decolor(nameColored);
        if (!nameClean || nameClean === '<world>') return;
        const cid = evt.clientId ?? -1;
        this.playersById[cid] = { nameColored, nameClean, lastSeen: t };
        if (!this.stats[nameClean]) this.stats[nameClean] = { kills: 0, deaths: 0 };
        return;
      }

      case 'kill':
      case 'Kill': {
        const k = decolor(evt.killerName || evt.killer?.name || '');
        const v = decolor(evt.victimName || evt.victim?.name || '');
        if (k) {
          if (!this.stats[k]) this.stats[k] = { kills: 0, deaths: 0 };
          this.stats[k].kills++;
        }
        if (v) {
          if (!this.stats[v]) this.stats[v] = { kills: 0, deaths: 0 };
          this.stats[v].deaths++;
        }
        return;
      }
      default:
        return;
    }
  }
}

const ms = new MatchState();

const mergeDeaths = (udpPlayers = [], state = ms) => {
  const stats = state?.stats || {};
  return udpPlayers.map((p) => {
    const colored = p.name || '';           // caret-colored from UDP
    const clean   = decolor(colored);       // plain for KD merge / keys
    const deathStat = stats[clean];
    const kills  = Number(p.score || 0);
    const deaths = Number(deathStat?.deaths || 0);
    return {
      name: clean,
      colored,
      kills,
      deaths,
      kd: deaths ? +(kills / deaths).toFixed(2) : kills
    };
  });
};

const statusWithTimeout = async (host = Q3_HOST, port = Q3_PORT, timeoutMs = 1200) => {
  try { return await getStatus(host, port, timeoutMs); }
  catch { return null; }
};

// --------------- log tail → DB ---------------
const mapType = (t) => {
  const s = String(t || '').toLowerCase();
  if (s === 'init' || s === 'initgame') return 'InitGame';
  if (s === 'shutdown' || s === 'shutdowngame') return 'ShutdownGame';
  if (s === 'user' || s === 'clientuserinfochanged') return 'ClientUserinfoChanged';
  if (s === 'kill') return 'Kill';
  return t || '';
};

const shouldPersist = (evt) => {
  if (!evt) return false;
  const type = mapType(evt.type);
  if (type === 'Kill' && !evt._seed) return true;       // live kills only
  if (evt._seed && type !== 'InitGame') return false;   // only seed InitGame
  return true;
};

const onTailEvent = (evt) => {
  try {
    const norm = evt ? { ...evt, type: mapType(evt.type) } : null;
    ms.onEvent(norm);
    if (shouldPersist(norm)) db.onEvent(norm); // persist colored names
  } catch (e) {
    console.error('onTailEvent error:', e);
  }
};

startTail(onTailEvent);

// Prime a match from UDP on boot so frags persist mid-game
(async () => {
  try {
    const status = await statusWithTimeout();
    const info = status?.info || {};
    db.onEvent({
      type: 'InitGame',
      map: info.mapname || info.map || 'unknown',
      gametype: info.g_gametype || info.gametype || 'FFA',
      hostname: info.sv_hostname || info.hostname || '',
      ts: Date.now()
    });
  } catch { /* non-fatal */ }
})();

// --------------- snapshot builder + cache ---------------
const buildSnapshot = async ({ limit = 25, includeBots = false } = {}) => {
  const status   = await statusWithTimeout();
  const info     = status?.info || {};
  const udpList  = Array.isArray(status?.players) ? status.players : [];

  const merged   = mergeDeaths(udpList, ms).sort((a, b) => b.kills - a.kills);
  const current_match = {
    map: info.mapname || 'unknown',
    gametype: info.g_gametype || info.gametype || 'FFA',
    started_at: ms?.current?.startedAt || Date.now(),
    players: merged,
    top5: merged.slice(0, 5), // back-compat
  };

  const ladderRaw = db.ladder(Math.min(Number(limit) || 25, 100));
  const filtered  = includeBots ? ladderRaw
    : ladderRaw.filter(r => !BOT_NAMES.has(normalizeName(r.name)));

  const ladder = filtered.map(r => {
    const kills = Number(r.kills || 0);
    const deaths = Number(r.deaths || 0);
    return { ...r, kills, deaths, kd: deaths ? +(kills / deaths).toFixed(2) : kills };
  });

  const live = status ? {
    hostname: info.sv_hostname || info.hostname || '',
    mapname:  info.mapname || info.map || 'unknown',
    player_count: udpList.length
  } : null;

  return { source: status ? 'udp' : 'tail', live, current_match, ladder };
};

// 1s per-key hot cache + ETag
let SNAP_CACHE = { key: '', at: 0, etag: '', json: '' };

const sendJSONWithETag = (req, res, payload) => {
  const json = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const etag = 'W/"' + crypto.createHash('sha1').update(json).digest('hex') + '"';
  res.set('ETag', etag);
  res.set('Cache-Control', 'no-cache'); // client revalidates with ETag
  if (req.headers['if-none-match'] === etag) {
    res.status(304).end();
  } else {
    res.type('application/json').send(json);
  }
};

// ---------------- routes ----------------
app.get('/health', (_req, res) => res.json({ ok: true }));

// Canonical: /api/snapshot
const snapshotHandler = async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 25), 100);
    const includeBots = req.query.includeBots === '1';
    const key = `${limit}|${includeBots}`;
    const now = Date.now();

    if (SNAP_CACHE.json && SNAP_CACHE.key === key && (now - SNAP_CACHE.at) < 1000) {
      res.set('ETag', SNAP_CACHE.etag);
      res.set('Cache-Control', 'no-cache');
      if (req.headers['if-none-match'] === SNAP_CACHE.etag) res.status(304).end();
      else res.type('application/json').send(SNAP_CACHE.json);
      return;
    }

    const snapshot = await buildSnapshot({ limit, includeBots });
    const json = JSON.stringify(snapshot);
    const etag = 'W/"' + crypto.createHash('sha1').update(json).digest('hex') + '"';
    SNAP_CACHE = { key, at: now, etag, json };

    sendJSONWithETag(req, res, json);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

app.get('/api/snapshot', snapshotHandler);

// Alias for old clients: /api/summary -> /api/snapshot
app.get('/api/summary', snapshotHandler);

// Thin views (back-compat) — built from the same snapshot
app.get('/api/match', async (req, res) => {
  const s = await buildSnapshot({ limit: 25, includeBots: req.query.includeBots === '1' });
  res.json({ source: s.source, current_match: s.current_match });
});

app.get('/api/ladder', async (req, res) => {
  const s = await buildSnapshot({
    limit: Math.min(Number(req.query.limit || 25), 100),
    includeBots: req.query.includeBots === '1'
  });
  res.json({ players: s.ladder });
});

// Hidden/unused placeholder
app.get('/api/matches', (_req, res) => res.json({ matches: [] }));

// --------------- server ---------------
app.listen(PORT, '127.0.0.1', () => {
  console.log(`API on http://127.0.0.1:${PORT} → querying ${Q3_HOST}:${Q3_PORT}`);
});
