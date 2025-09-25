// db.js — ES6/arrow, prepared statements, small perf wins
const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'ladder.db'));
db.pragma('journal_mode = wal');
db.pragma('foreign_keys = ON');
// Keep durability reasonable; comment out if you prefer FULL
db.pragma('synchronous = NORMAL');

/* Schema */
db.exec(`
CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY,
  name_clean   TEXT UNIQUE,
  name_colored TEXT,
  first_seen   INTEGER,
  last_seen    INTEGER
);
CREATE TABLE IF NOT EXISTS matches (
  id INTEGER PRIMARY KEY,
  map        TEXT,
  gametype   TEXT,
  started_at INTEGER,
  ended_at   INTEGER
);
CREATE TABLE IF NOT EXISTS frags (
  id INTEGER PRIMARY KEY,
  match_id  INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  killer_id INTEGER REFERENCES players(id) ON DELETE SET NULL,
  victim_id INTEGER REFERENCES players(id) ON DELETE SET NULL,
  mod       TEXT,
  ts        INTEGER
);
CREATE INDEX IF NOT EXISTS idx_players_name_clean ON players(name_clean);
CREATE INDEX IF NOT EXISTS idx_frags_match_id   ON frags(match_id);
CREATE INDEX IF NOT EXISTS idx_frags_killer_id  ON frags(killer_id);
CREATE INDEX IF NOT EXISTS idx_frags_victim_id  ON frags(victim_id);
CREATE INDEX IF NOT EXISTS idx_frags_ts         ON frags(ts);
`);

/* State */
let currentMatchId = null;

/* Utils */
const now = () => Date.now();
const clean = (s) =>
  (s || '').replace(/\^[0-9]/g, '').replace(/[^\x20-\x7E]/g, '').trim();

/* Prepared statements */
const selPlayerByClean = db.prepare(`SELECT id FROM players WHERE name_clean = ?`);

const selPlayerByKey = db.prepare(`
  SELECT id, name_clean
  FROM players
  WHERE name_clean = ? COLLATE NOCASE
  ORDER BY last_seen DESC
  LIMIT 1
`);

const insPlayer = db.prepare(`
  INSERT INTO players (name_clean, name_colored, first_seen, last_seen)
  VALUES (?, ?, ?, ?)
`);
const updPlayerSeen = db.prepare(`
  UPDATE players SET name_colored = ?, last_seen = ? WHERE id = ?
`);

const insMatch = db.prepare(`
  INSERT INTO matches (map, gametype, started_at, ended_at)
  VALUES (?, ?, ?, NULL)
`);
const endMatchStmt = db.prepare(`
  UPDATE matches SET ended_at = ? WHERE id = ?
`);

const insFrag = db.prepare(`
  INSERT INTO frags (match_id, killer_id, victim_id, mod, ts)
  VALUES (?, ?, ?, ?, ?)
`);

const ladderStmt = db.prepare(`
  SELECT
    p.id,
    p.name_clean AS name,
    (SELECT COUNT(*) FROM frags fx WHERE fx.killer_id = p.id) AS kills,
    (SELECT COUNT(*) FROM frags fy WHERE fy.victim_id = p.id) AS deaths
  FROM players p
  ORDER BY kills DESC, deaths ASC, p.name_clean ASC
  LIMIT ?
`);

const recentMatchesStmt = db.prepare(`
  SELECT
    m.id,
    m.map,
    m.gametype,
    m.started_at,
    m.ended_at,
    COUNT(f.id) AS frags
  FROM matches m
  LEFT JOIN frags f ON f.match_id = m.id
  GROUP BY m.id
  ORDER BY m.id DESC
  LIMIT ?
`);

/* Tiny transaction helper */
const inTx = (fn) => {
  const tx = db.transaction(fn);
  return (...args) => tx(...args);
};

/* Player helper: get-or-create and update last_seen/colored */
const getPlayerId = (name_clean, name_colored) => {
  if (!name_clean || name_clean === '<world>') return null;

  // Prefer a case-insensitive match to avoid splitting players across rows
  let row = selPlayerByKey.get(name_clean);

  if (!row) {
    const t = now();
    insPlayer.run(name_clean, name_colored || name_clean, t, t);
    row = selPlayerByKey.get(name_clean); // re-read (handles race/insert)
  } else {
    // Keep display name fresh
    updPlayerSeen.run(name_colored || name_clean, now(), row.id);
  }

  return row ? row.id : null;
};

/* Event sink */
const onEvent = inTx((evt) => {
  // Expected evt: { type, ts?, map?, gametype?, killer?, victim?, mod?, name_clean?, name_colored? }
  switch (evt?.type) {
    case 'InitGame': {
      const map = evt.map || 'unknown';
      const gametype = evt.gametype || 'FFA';
      const started = evt.ts || now();
      const info = insMatch.run(map, gametype, started);
      currentMatchId = info.lastInsertRowid;
      return { ok: true, currentMatchId };
    }
    case 'ShutdownGame': {
      if (currentMatchId != null) {
        endMatchStmt.run(evt.ts || now(), currentMatchId);
        currentMatchId = null;
      }
      return { ok: true, currentMatchId };
    }
    case 'ClientUserinfoChanged': {
      // keep roster fresh
      const name_clean = clean(evt.name_clean || evt.name || '');
      const name_colored = evt.name_colored || evt.colored || evt.name || name_clean;
      if (name_clean) getPlayerId(name_clean, name_colored);
      return { ok: true };
    }
    case 'Kill': {
      const ts = evt.ts || now();

      // If we somehow missed InitGame (restart, logging hiccup), open a match on demand
      if (currentMatchId == null) {
        const map = 'unknown';
        const gametype = 'FFA';
        const info = insMatch.run(map, gametype, ts);
        currentMatchId = info.lastInsertRowid;
      }

      const killer_clean = clean(evt.killer?.name_clean || evt.killer?.name || evt.killer || '');
      const killer_col   = evt.killer?.name_colored || evt.killer?.colored || killer_clean;
      const victim_clean = clean(evt.victim?.name_clean || evt.victim?.name || evt.victim || '');
      const victim_col   = evt.victim?.name_colored || evt.victim?.colored || victim_clean;

      const killer_id = getPlayerId(killer_clean, killer_col);
      const victim_id = getPlayerId(victim_clean, victim_col);

      // Allow <world> as killer by letting killer_id be null
      insFrag.run(currentMatchId, killer_id, victim_id, evt.mod || null, ts);
      return { ok: true };
    }
    default:
      return { ok: true }; // ignore unknowns
  }
});

/* Queries */
const ladder = (limit = 25) => ladderStmt.all(limit);
const recentMatches = (limit = 10) => recentMatchesStmt.all(limit);

/* Exports */
module.exports = { onEvent, ladder, recentMatches };
