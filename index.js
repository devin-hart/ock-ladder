// index.js
/* eslint-disable no-console */
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const db = require('./db');
const { getStatus } = require('./status');
const { startTail } = require('./logtail');

// ---------------------------
// Config
// ---------------------------
const Q3_HOST = process.env.Q3_HOST || '127.0.0.1';
const Q3_PORT = Number(process.env.Q3_PORT || 27960);
const API_PORT = Number(process.env.PORT || 3000);

// ---------------------------
// In-memory match state (for live deaths merge, not for storage)
// ---------------------------
const ms = {
  current: { startedAt: Date.now(), id: null, map: null, gametype: null },
  // key = name_key (normalized), value = { deaths: number }
  stats: Object.create(null),
};

// Same normalization DB uses for name_key lookups (keep storage raw; use this just for matching)
const normalizeNameKey = (s = '') =>
  String(s)
    .replace(/\^x[0-9A-Fa-f]{6}/g, '')
    .replace(/\^[0-9]/g, '')
    .toLowerCase()
    .normalize('NFKC')
    .trim();

// ---------------------------
// Helpers
// ---------------------------
const statusWithTimeout = async (host = Q3_HOST, port = Q3_PORT, timeoutMs = 500) => {
  try {
    const p = getStatus(host, port);
    const t = new Promise((_, rej) => setTimeout(() => rej(new Error('udp timeout')), timeoutMs));
    return await Promise.race([p, t]);
  } catch {
    return null;
  }
};

const mergeDeaths = (udpPlayers = [], state = ms) => {
  const stats = state?.stats || {};
  return udpPlayers.map((p) => {
    const kills = Number(p.score || 0);
    const key = normalizeNameKey(p.name);
    const deaths = Number(stats[key]?.deaths || 0);
    const kd = deaths ? +(kills / deaths).toFixed(2) : kills;
    return { name: p.name, kills, deaths, kd };
  });
};

// ETag responder (handles If-None-Match)
const sendJSONWithETag = (req, res, jsonString) => {
  const etag = 'W/"' + crypto.createHash('sha1').update(jsonString).digest('hex') + '"';
  res.set('ETag', etag);
  res.set('Cache-Control', 'no-cache');
  if (req.headers['if-none-match'] === etag) return res.status(304).end();
  res.type('application/json').send(jsonString);
};

// ---------------------------
// Tail wiring → persist to DB + keep a tiny deaths overlay in memory
// ---------------------------
startTail((e) => {
  try {
    if (e.type === 'InitGame') {
      // Reset in-memory deaths overlay and note match metadata
      ms.stats = Object.create(null);
      ms.current.startedAt = e.ts || Date.now();
      ms.current.map = e.map || null;
      ms.current.gametype = e.gametype || null;
    } else if (e.type === 'Kill' && !e._seed) {
      // Track deaths in-memory by normalized key for live KD
      const victimName = e?.victim?.name || '';
      const vKey = normalizeNameKey(victimName);
      if (vKey) {
        const slot = (ms.stats[vKey] = ms.stats[vKey] || { deaths: 0 });
        slot.deaths++;
      }
    }

    // Persist everything authoritative to the DB (players, frags, models, bots, suicides, etc.)
    if (db?.onEvent) db.onEvent(e, ms);
  } catch (err) {
    console.error('onTailEvent error:', err);
  }
});

// ---------------------------
// App
// ---------------------------
const app = express();
app.disable('x-powered-by');
app.use(cors());
app.use(express.json());

// ---------------------------
// Routes
// ---------------------------

// Health
app.get('/health', (_req, res) => res.json({ ok: true }));

// Raw UDP status passthrough (debug)
app.get('/api/status', async (_req, res) => {
  const s = await statusWithTimeout();
  if (!s) return res.json({ ok: false, error: 'no-udp' });
  res.json({ ok: true, ...s });
});

// Ladder (server-side)
app.get('/api/ladder', (req, res) => {
  const limit = Math.min(Number(req.query.limit || 25), 100);
  const includeBots = req.query.includeBots === '1';
  try {
    const players = db.ladder(limit, 0, { includeBots });
    res.json({ players });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Snapshot (home page: live status + current match players + ladder)
let SNAP_CACHE = { key: '', at: 0, etag: '', json: '' };

app.get('/api/snapshot', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 25), 100);
    const includeBots = req.query.includeBots === '1';
    const key = `${limit}|${includeBots}`;
    const now = Date.now();

    // Tiny 1s local cache to calm bursts and enable 304s
    if (SNAP_CACHE.json && SNAP_CACHE.key === key && now - SNAP_CACHE.at < 1000) {
      return sendJSONWithETag(req, res, SNAP_CACHE.json);
    }

    const status = await statusWithTimeout();
    const info = status?.info || {};
    const udpList = Array.isArray(status?.players) ? status.players : [];
    const merged = mergeDeaths(udpList, ms).sort((a, b) => b.kills - a.kills || b.kd - a.kd);

    const current_match = {
      map: info.mapname || info.map || 'unknown',
      gametype: info.g_gametype || info.gametype || 'FFA',
      started_at: ms?.current?.startedAt || Date.now(),
      players: merged,             // full list
      top5: merged.slice(0, 5),    // convenience
    };

    const ladder = db.ladder(limit, 0, { includeBots });

    const live = status
      ? {
          hostname: info.sv_hostname || info.hostname || '',
          mapname: info.mapname || info.map || 'unknown',
          player_count: udpList.length,
        }
      : null;

    const snapshot = { source: status ? 'udp' : 'tail', live, current_match, ladder };
    const json = JSON.stringify(snapshot);

    // Save cache & reply with ETag
    SNAP_CACHE = {
      key,
      at: now,
      etag: 'W/"' + crypto.createHash('sha1').update(json).digest('hex') + '"',
      json,
    };
    sendJSONWithETag(req, res, json);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------
// Player detail
// ---------------------------

// Helper: respond with computed player profile by id
const sendPlayerById = (res, id, { days = 7, limitPairs = 10 } = {}) => {
  try {
    if (!id) return res.status(404).json({ error: 'player not found' });
    if (!db.getPlayerProfile) {
      return res.status(500).json({ error: 'getPlayerProfile not implemented in db.js' });
    }
    const player = db.getPlayerProfile(Number(id), {
      days: Number(days) || 7,
      limitPairs: Math.max(1, Math.min(Number(limitPairs) || 10, 50)),
    });
    if (!player) return res.status(404).json({ error: 'player not found' });
    return res.json({ player });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};

// GET /api/player?by=<name>
app.get('/api/player', (req, res) => {
  const { by, days = 7, limitPairs = 10 } = req.query;
  if (!by) return res.status(400).json({ error: 'provide ?by=<name>' });

  const key = normalizeNameKey(by);
  // Prefer lookup by name_key; fall back to exact name match if needed
  const row =
    (db.findPlayerByNameKey && db.findPlayerByNameKey(key)) ||
    (db.findPlayerByName && db.findPlayerByName(by)) ||
    null;

  if (!row?.id) return res.status(404).json({ error: 'player not found' });
  return sendPlayerById(res, row.id, { days: Number(days), limitPairs: Number(limitPairs) });
});

// GET /api/player/:id
app.get('/api/player/:id', (req, res) => {
  const { id } = req.params;
  const { days = 7, limitPairs = 10 } = req.query;
  return sendPlayerById(res, Number(id), { days: Number(days), limitPairs: Number(limitPairs) });
});

// ---------------------------
// Boot
// ---------------------------
app.listen(API_PORT, () => {
  console.log(`API listening on http://127.0.0.1:${API_PORT} → querying ${Q3_HOST}:${Q3_PORT}`);
});
