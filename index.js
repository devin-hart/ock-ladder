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
  if (!evt._seed) { // only persist real-time events; seed is warm-up only
    try { db.onEvent(evt); } catch (e) { console.error('db.onEvent error:', e); }
  }
}

// start tailing: this seeds (non-persistent) then follows (persistent)
startTail(onEvent);
console.log('tailing log:', LOG);

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

// Snapshot of current match (from log tailer)
app.get('/api/match', (_req, res) => {
  res.json(ms.snapshot());
});

// Ladder (persisted across matches; from SQLite)
app.get('/api/ladder', (_req, res) => {
  res.json({ players: db.ladder(50) });
});

// recent matches (DB helper)
app.get('/api/matches', (req, res) => {
  const limit = Math.min(+req.query.limit || 10, 50);
  res.json({ matches: db.recentMatches(limit) });
});

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
    // Pull all three in parallel (status can fail harmlessly)
    const [ladder, snap, status] = await Promise.all([
      Promise.resolve(db.ladder(5)),
      Promise.resolve(ms.snapshot()),
      getStatus(Q3_HOST, Q3_PORT).catch(() => null),
    ]);

    const current_match = snap.match
      ? {
          map: snap.match.map,
          gametype: snap.match.gametype,
          started_at: snap.match.startedAt,
          top5: snap.players.slice(0, 5),
        }
      : null;

    const live = status
      ? {
          hostname: status.info.hostname,
          mapname: status.info.mapname,
          gametype: status.info.g_gametype || status.info.gametype,
          player_count: status.players.length,
          players: status.players.map(p => ({ name: p.name, score: p.score, ping: p.ping })),
        }
      : null;

    res.json({ live, current_match, ladder });
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
