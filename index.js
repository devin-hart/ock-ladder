// index.js — keep caret-colored names end-to-end; no stripping sent to DB

const express = require('express');
const cors = require('cors');
const { getStatus } = require('./status');
const db = require('./db');
const { startTail } = require('./logtail');

const PORT    = +(process.env.PORT || 3000);
const Q3_HOST = process.env.Q3_HOST || '127.0.0.1';
const Q3_PORT = +(process.env.Q3_PORT || 27960);

const app = express();
app.use(cors()); // enable locally if you want

/* -------- helpers (ONLY for in-memory math / filters) -------- */
// We *do not* use this for storage. It's just to key KD stats and filter bots.
const decolor = (s = '') =>
  s.replace(/\^[0-9]/g, '').replace(/\^x[0-9a-fA-F]{6}/g, '').trim();

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
  snapshot() {
    const players = Object.entries(this.stats)
      .filter(([name]) => name && name !== '<world>')
      .map(([name, s]) => ({
        name,
        kills: s.kills,
        deaths: s.deaths,
        kd: s.deaths ? +(s.kills / s.deaths).toFixed(2) : s.kills,
      }))
      .sort((a, b) => b.kills - a.kills);
    return { match: this.current, players };
  }
}

const ms = new MatchState();

/* -------------------- helpers -------------------- */
const normalizeName = (s = '') => decolor(s).toLowerCase();

const BOT_NAMES = new Set([
  'wrack','visor','gorre','angel','mynx','keel','orbb','cadavre','tankjr','lucy','sarge','grunt',
  'ranger','biker','sorlag','mr.gauntlet','anarki','bitterman','hunter','major','uriel','daemia',
  'klesk','stripe','patriot','lakerbot','bones','slash','argus^f+','xaero','doom','hossman','crash', 'phobos', 'razor'
]);

const mergeDeaths = (udpPlayers = [], state = ms) => {
  const stats = state?.stats || {};
  return udpPlayers.map((p) => {
    const clean = decolor(p.name);
    const deathStat = stats[clean];
    const kills = Number(p.score || 0);
    const deaths = Number(deathStat?.deaths || 0);
    return {
      // this is just for the "current match" view; DB/ladder still use colored
      name: clean,
      kills,
      deaths,
      kd: deaths ? +(kills / deaths).toFixed(2) : kills
    };
  });
};

const statusWithTimeout = async (host = Q3_HOST, port = Q3_PORT, timeoutMs = 1200) => {
  try {
    return await getStatus(host, port, timeoutMs);
  } catch {
    return null;
  }
};

/* -------------------- log tail → DB sink -------------------- */
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
  if (type === 'Kill' && !evt._seed) return true;              // live kills only
  if (evt._seed && type !== 'InitGame') return false;          // only seed InitGame
  return true;
};

const onTailEvent = (evt) => {
  try {
    const norm = evt ? { ...evt, type: mapType(evt.type) } : null;
    ms.onEvent(norm);
    if (shouldPersist(norm)) {
      if (norm.type === 'Kill' && !norm._seed) {
        console.log('PERSIST KILL:', norm.killer?.name, '→', norm.victim?.name);
      }
      db.onEvent(norm); // norm carries colored names from logtail
    }
  } catch (e) {
    console.error('onTailEvent error:', e);
  }
};

startTail(onTailEvent); // logtail already preserves colors. :contentReference[oaicite:1]{index=1}

/* Prime a match from UDP on boot so frags persist mid-game */
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
  } catch {
    // non-fatal
  }
})();

/* -------------------- routes -------------------- */

// Health
app.get('/health', (_req, res) => res.json({ ok: true }));

// UDP raw
app.get('/api/status', async (_req, res) => {
  const status = await statusWithTimeout();
  if (!status) return res.status(504).json({ error: 'udp_timeout' });
  res.set('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate');
  res.json(status);
});

// Current match snapshot (UDP-first with death merge). Keep `top5` to avoid UI break.
app.get('/api/match', async (_req, res) => {
  const status = await statusWithTimeout();
  const info = status?.info || {};
  const players = Array.isArray(status?.players) ? status.players : [];
  const merged = mergeDeaths(players, ms).sort((a, b) => b.kills - a.kills);
  const top5 = merged.slice(0, 5);

  const current_match = {
    map: info.mapname || 'unknown',
    gametype: info.g_gametype || info.gametype || 'FFA',
    started_at: ms?.current?.startedAt || Date.now(),
    top5
  };

  res.set('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate');
  res.json({ source: status ? 'udp' : 'tail', current_match });
});

// Ladder (humans by default; includeBots=1 to show all)
app.get('/api/ladder', (req, res) => {
  const includeBots = req.query.includeBots === '1';
  const limit = Math.min(Number(req.query.limit || 25), 100);

  const rows = db.ladder(limit); // rows already have colored names from DB
  const filtered = includeBots
    ? rows
    : rows.filter(r => !BOT_NAMES.has(normalizeName(r.name)));

  const players = filtered.map(r => {
    const kills = Number(r.kills || 0);
    const deaths = Number(r.deaths || 0);
    return {
      ...r, // includes: id, name (colored), name_colored (same), kills, deaths
      kills,
      deaths,
      kd: deaths ? +(kills / deaths).toFixed(2) : kills
    };
  });

  res.set('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate');
  res.json({ players });
});

// Matches placeholder (hidden for now)
app.get('/api/matches', (_req, res) => res.json({ matches: [] }));

// Summary: current match + ladder (NO DB "hint" with stripped name anymore)
app.get('/api/summary', async (req, res) => {
  try {
    const includeBots = req.query.includeBots === '1';

    // Live status (UDP-first)
    const status = await statusWithTimeout();
    const info = status?.info || {};
    const players = Array.isArray(status?.players) ? status.players : [];

    // Current match snapshot with kd
    const merged = mergeDeaths(players, ms).sort((a, b) => b.kills - a.kills);
    const top5 = merged.slice(0, 5);

    const current_match = {
      map: info.mapname || 'unknown',
      gametype: info.g_gametype || info.gametype || 'FFA',
      started_at: ms?.current?.startedAt || Date.now(),
      top5
    };

    // Ladder with kd and bot filtering (names already colored from DB)
    const limit = Math.min(Number(req.query.limit || 25), 100);
    const ladderRaw = db.ladder(limit);
    const filtered = includeBots
      ? ladderRaw
      : ladderRaw.filter(r => !BOT_NAMES.has(normalizeName(r.name)));

    const ladder = filtered.map(r => {
      const kills = Number(r.kills || 0);
      const deaths = Number(r.deaths || 0);
      return {
        ...r,
        kills,
        deaths,
        kd: deaths ? +(kills / deaths).toFixed(2) : kills
      };
    });

    const live = Boolean(status);
    res.set('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate');
    res.json({ source: status ? 'udp' : 'tail', live, current_match, ladder });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* -------------------- server -------------------- */
app.listen(PORT, '127.0.0.1', () => {
  console.log(`API on http://127.0.0.1:${PORT} → querying ${Q3_HOST}:${Q3_PORT}`);
});
