const express = require('express');
const cors = require('cors');
const { getStatus } = require('./status');

const db = require('./db');
const { startTail, MatchState, LOG } = require('./logtail'); // << the only logtail imports

const Q3_HOST = process.env.Q3_HOST || '127.0.0.1';
const Q3_PORT = +(process.env.Q3_PORT || 27960);

const app = express();

// in-memory match state (used by /api/match if you have it)
const ms = new MatchState();

// one handler for all parsed log events
function onEvent(evt) {
  try { ms.onEvent(evt); } catch (e) { console.error('ms.onEvent error:', e); }
const shouldPersist = (evt.type === 'init') || !evt._seed;

  if (shouldPersist) {
    try { db.onEvent(evt); } catch (e) { console.error('db.onEvent error:', e); }
  }
}

// start tailing: this seeds (non-persistent) then follows (persistent)
startTail(onEvent);
console.log('tailing log:', LOG);

// Prime DB with a current match if we started mid-map (no InitGame seen)
(async () => {
  try {
    const s = await statusWithTimeout(Q3_HOST, Q3_PORT, 900);
    const info = s.info || {};
    const meta = {
      map: info.mapname || 'unknown',
      gametype: info.g_gametype || info.gametype || '0',
      hostname: info.hostname || info.sv_hostname || ''
    };
    // send a synthetic init through the normal pipeline (persists to DB)
    onEvent({ type: 'init', meta });
    console.log('primed match from UDP:', meta);
  } catch (e) {
    console.log('prime skipped:', e.message);
  }
})();

// Caching headers (no-store everywhere)
app.set('etag', false);
app.use((req,res,next)=>{res.set({
  'Cache-Control':'no-store, no-cache, must-revalidate, proxy-revalidate',
  'Pragma':'no-cache','Expires':'0',
  'CDN-Cache-Control':'no-store','Vercel-CDN-Cache-Control':'no-store'
}); next();});

// --- Routes ---

app.use(cors({
  origin: [
    'http://localhost:3000',   // if you run React on 3000
    'http://localhost:5173',   // Vite default
    'http://127.0.0.1:5173'
  ],
  methods: ['GET'],
}));

// Live server status via UDP getstatus
app.get('/api/status', async (_req, res) => {
  try {
    const data = await getStatus(Q3_HOST, Q3_PORT);
    res.json(data);
  } catch (e) {
    res.status(504).json({ error: e.message });
  }
});

// index.js
const clean = s => (s || '')
  .replace(/\^[0-9]/g, '')       // strip ^1 color codes
  .replace(/[^\x20-\x7E]/g, '')  // drop weird bytes
  .trim();

const BOT_NAMES = new Set([
  'Wrack','Visor','Gorre','Angel','Mynx','Keel','Orbb','Cadavre','TankJr','Lucy',
  'Sarge','Grunt','Ranger','Biker','Sorlag','Mr.Gauntlet','Anarki','Bitterman',
  'Hunter','Major','Uriel','Daemia','Klesk','Stripe', 'Mr.Gauntlet', 'Bones', 'Patriot', 'LakerboT'
]);

const isBot = (name) => BOT_NAMES.has(clean(name));

const statusWithTimeout = (host, port, ms = 900) =>
  Promise.race([
    getStatus(host, port),                            // your UDP status fn
    new Promise((_, rej) => setTimeout(() => rej(new Error('udp-timeout')), ms)),
  ]);

app.get('/api/match', async (req, res) => {
  try {
    // UDP is the source of truth for who is in the server and their KILLS (score)
    const s = await statusWithTimeout(Q3_HOST, Q3_PORT, 900);
    const info = s.info || {};
    const snap = ms.snapshot();  // used only to add deaths if the same name exists

    // map of live names -> deaths (from snapshot), only if present now
    const deathsMap = new Map();
    for (const p of snap.players || []) deathsMap.set(p.name, p.deaths || 0);

    const top5 = (s.players || [])
      .map(p => {
        const name = clean(p.name);
        const kills = Number(p.score) || 0;          // authoritative from UDP
        const deaths = deathsMap.get(name) || 0;     // best-effort from tail
        const kd = deaths ? +(kills / deaths).toFixed(2) : kills;
        return { name, kills, deaths, kd };
      })
      .sort((a,b) => b.kills - a.kills)
      .slice(0, 5);

    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    return res.json({
      source: 'udp',
      current_match: {
        map: info.mapname || snap.match?.map || 'unknown',
        gametype: info.g_gametype || snap.match?.gametype || '0',
        started_at: snap.match?.startedAt || Date.now(),
        top5
      }
    });
  } catch {
    // If UDP fails, fall back to tail ONLY (you'll see source:'tail')
    const snap = ms.snapshot();
    const top5 = (snap.players || []).slice(0, 5);
    return res.json({
      source: 'tail',
      current_match: {
        map: snap.match?.map || 'unknown',
        gametype: snap.match?.gametype || '0',
        started_at: snap.match?.startedAt || Date.now(),
        top5
      }
    });
  }
});


// Ladder (persisted across matches; from SQLite)
app.get('/api/ladder', (req, res) => {
  const raw = db.ladder(100);
  const includeBots = 'includeBots' in req.query;  // e.g. /api/ladder?includeBots=1
  const players = includeBots ? raw : raw.filter(p => !isBot(p.name));
  res.json({ players });
});

// recent matches (DB helper)
// app.get('/api/matches', (req, res) => {
//   const limit = Math.min(+req.query.limit || 10, 50);
//   res.json({ matches: db.recentMatches(limit) });
// });

app.get('/api/matches', (_req, res) => res.json({ matches: [] }));

// Single match detail with per-player scoreboard
app.get('/api/matches/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const data = db.matchDetail(id);
  if (!data) return res.status(404).json({ error: 'match not found' });
  res.json(data);
});

// List players (supports ?limit=, ?search=)
app.get('/api/players', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
  const search = (req.query.search || '').trim();
  res.json({ players: db.players(limit, search) });
});

// Single player by clean name (URL-encoded if it has spaces)
app.get('/api/players/:name', (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const data = db.playerDetail(name, 20);
  if (!data) return res.status(404).json({ error: 'player not found' });
  res.json(data);
});

// One-shot summary for the UI (live + current match + persistent ladder)
app.get('/api/summary', async (_req, res) => {
  try {
    const [rawLadder, snap] = await Promise.all([
      Promise.resolve(db.ladder(100)),   // was db.ladder(5)
      Promise.resolve(ms.snapshot()),
    ]);

    // 2) filter out bots, then take top 5
    const ladder = rawLadder.filter(p => !isBot(p.name)).slice(0, 25);

    let status = null;
    try { status = await statusWithTimeout(Q3_HOST, Q3_PORT, 900); } catch (_) {}

    let current_match = null;
    let live = null;

    if (status) {
      const info = status.info || {};
      const deathsMap = new Map();
      for (const p of snap.players || []) deathsMap.set(p.name, p.deaths || 0);

      const top5 = (status.players || [])
        .map(p => {
          const name = clean(p.name);
          const kills = Number(p.score) || 0;         // authoritative from UDP
          const deaths = deathsMap.get(name) || 0;    // best-effort from tail
          const kd = deaths ? +(kills / deaths).toFixed(2) : kills;
          return { name, kills, deaths, kd };
        })
        .sort((a,b) => b.kills - a.kills)
        .slice(0, 5);

      current_match = {
        map: info.mapname || snap.match?.map || 'unknown',
        gametype: info.g_gametype || snap.match?.gametype || '0',
        started_at: snap.match?.startedAt || Date.now(),
        top5,
      };

      live = {
        hostname: info.hostname,
        mapname: info.mapname,
        gametype: info.g_gametype || info.gametype,
        player_count: status.players.length,
        players: status.players.map(p => ({ name: clean(p.name), score: p.score, ping: p.ping })),
      };
    } else if (snap.match) {
      // UDP failed → fall back to tail only (can be stale, but consistent)
      current_match = {
        map: snap.match.map,
        gametype: snap.match.gametype,
        started_at: snap.match.startedAt,
        top5: snap.players.slice(0, 5).map(p => ({
          name: clean(p.name), kills: p.kills, deaths: p.deaths, kd: p.kd
        })),
      };
    }

    res.set('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate');
    res.json({ source: status ? 'udp' : 'tail', live, current_match, ladder });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Simple health check
app.get('/health', (_req, res) => res.json({ ok: true }));

// Bind to localhost (use SSH tunnel for remote access)
const PORT = 3000;
app.listen(PORT, '127.0.0.1', () => {
  console.log(`API on http://127.0.0.1:${PORT} → querying ${Q3_HOST}:${Q3_PORT}`);
});
