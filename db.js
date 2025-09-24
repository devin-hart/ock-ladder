// db.js – clean writer + queries
const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'ladder.db'));
db.pragma('journal_mode = wal');
db.pragma('foreign_keys = ON');

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
  id          INTEGER PRIMARY KEY,
  map         TEXT,
  gametype    TEXT,
  hostname    TEXT,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER
);
CREATE TABLE IF NOT EXISTS frags (
  id        INTEGER PRIMARY KEY,
  match_id  INTEGER NOT NULL,
  killer_id INTEGER,           -- NULL => <world>
  victim_id INTEGER,
  mod       TEXT,
  ts        INTEGER,
  FOREIGN KEY(match_id)  REFERENCES matches(id) ON DELETE CASCADE,
  FOREIGN KEY(killer_id) REFERENCES players(id),
  FOREIGN KEY(victim_id) REFERENCES players(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_player_clean ON players(name_clean);
CREATE INDEX IF NOT EXISTS idx_frags_match ON frags(match_id);
`);

/* Prepared statements */
const upsertPlayer = db.prepare(`
INSERT INTO players (name_clean, name_colored, first_seen, last_seen)
VALUES (@name_clean, @name_colored, @now, @now)
ON CONFLICT(name_clean) DO UPDATE SET
  name_colored = excluded.name_colored,
  last_seen    = excluded.last_seen
RETURNING id
`);

const getLastMatch = db.prepare(`
SELECT id, map, started_at, ended_at
FROM matches
ORDER BY id DESC
LIMIT 1
`);

const insertMatch = db.prepare(`
INSERT INTO matches (map, gametype, hostname, started_at, ended_at)
VALUES (@map, @gametype, @hostname, @started_at, NULL)
RETURNING id
`);

const endMatch = db.prepare(`
UPDATE matches SET ended_at = @now WHERE id = @id
`);

const matchOpen = db.prepare(`
SELECT ended_at IS NULL AS open FROM matches WHERE id = ?
`);

const insertFrag = db.prepare(`
INSERT INTO frags (match_id, killer_id, victim_id, mod, ts)
VALUES (@match_id, @killer_id, @victim_id, @mod, @ts)
`);

/* Helpers */
function getPlayerId(name_clean, name_colored) {
  if (!name_clean || name_clean === '<world>') return null;
  return upsertPlayer.get({ name_clean, name_colored, now: Date.now() }).id;
}

/* Event sink from logtail */
let currentMatchId = null;

function onEvent(evt) {
  if (evt.type === 'init') {
    const now = Date.now();
    const last = getLastMatch.get();
    // Debounce: reuse if same map, not ended, and very recent (3s)
    if (last && !last.ended_at && last.map === evt.meta.map && (now - last.started_at) < 3000) {
      currentMatchId = last.id;
    } else {
      const info = insertMatch.get({
        map: evt.meta.map,
        gametype: evt.meta.gametype,
        hostname: evt.meta.hostname,
        started_at: now
      });
      currentMatchId = info.id;
    }
    return;
  }

  if (evt.type === 'kill') {
    if (!currentMatchId) return;
    if (!matchOpen.get(currentMatchId).open) return; // don’t attach to closed match

    const killer_id = getPlayerId(evt.killerName, evt.killerName); // NULL for <world>
    const victim_id = getPlayerId(evt.victimName, evt.victimName);

    insertFrag.run({
      match_id: currentMatchId,
      killer_id,
      victim_id,
      mod: evt.mod,
      ts: Date.now()
    });
    return;
  }

  if (evt.type === 'shutdown') {
    if (currentMatchId) endMatch.run({ id: currentMatchId, now: Date.now() });
    currentMatchId = null;
    return;
  }

  if (evt.type === 'user') {
    getPlayerId(evt.nameClean, evt.nameColored);
  }
}

/* Queries */
function ladder(limit = 50) {
  return db.prepare(`
    SELECT
      p.id,
      p.name_clean  AS name,
      SUM(CASE WHEN f.killer_id = p.id THEN 1 ELSE 0 END) AS kills,
      SUM(CASE WHEN f.victim_id = p.id THEN 1 ELSE 0 END) AS deaths
    FROM players p
    LEFT JOIN frags f
      ON f.killer_id = p.id OR f.victim_id = p.id
    GROUP BY p.id
    ORDER BY kills DESC
    LIMIT ?
  `).all(limit).map(r => ({
    id: r.id,
    name: r.name,
    kills: r.kills || 0,
    deaths: r.deaths || 0,
    kd: r.deaths ? +((r.kills || 0) / r.deaths).toFixed(2) : (r.kills || 0),
  }));
}

function recentMatches(limit = 10) {
  // Only finished matches; count PLAYER kills only (killer_id NOT NULL)
  return db.prepare(`
    SELECT
      m.id,
      m.map,
      m.started_at,
      SUM(CASE WHEN f.killer_id IS NOT NULL THEN 1 ELSE 0 END) AS frags
    FROM matches m
    LEFT JOIN frags f ON f.match_id = m.id
    WHERE m.ended_at IS NOT NULL
    GROUP BY m.id
    ORDER BY m.started_at DESC
    LIMIT ?
  `).all(limit);
}

function matchDetail(id) {
  const head = db.prepare(`
    SELECT
      m.id, m.map, m.started_at, m.ended_at,
      SUM(CASE WHEN f.killer_id IS NOT NULL THEN 1 ELSE 0 END) AS frags
    FROM matches m
    LEFT JOIN frags f ON f.match_id = m.id
    WHERE m.id = ?
  `).get(id);
  if (!head) return null;

  const lines = db.prepare(`
    SELECT
      p.name_clean AS name,
      SUM(CASE WHEN f.killer_id = p.id THEN 1 ELSE 0 END) AS kills,
      SUM(CASE WHEN f.victim_id = p.id THEN 1 ELSE 0 END) AS deaths
    FROM players p
    LEFT JOIN frags f ON f.match_id = ? AND (f.killer_id = p.id OR f.victim_id = p.id)
    GROUP BY p.id
    ORDER BY kills DESC
  `).all(id);

  const players = lines.map(r => ({
    name: r.name,
    kills: r.kills || 0,
    deaths: r.deaths || 0,
    kd: r.deaths ? +((r.kills || 0) / r.deaths).toFixed(2) : (r.kills || 0),
  }));

  return { ...head, players };
}

function players(limit = 50) {
  return db.prepare(`
    SELECT id, name_clean AS name, last_seen
    FROM players
    ORDER BY last_seen DESC
    LIMIT ?
  `).all(limit);
}

function playerDetail(name) {
  const p = db.prepare(`SELECT * FROM players WHERE name_clean = ?`).get(name);
  if (!p) return null;
  const totals = db.prepare(`
    SELECT
      SUM(CASE WHEN killer_id = ? THEN 1 ELSE 0 END) AS kills,
      SUM(CASE WHEN victim_id = ? THEN 1 ELSE 0 END) AS deaths
    FROM frags
  `).get(p.id, p.id);
  return {
    id: p.id,
    name: p.name_clean,
    kills: totals.kills || 0,
    deaths: totals.deaths || 0,
    kd: (totals.deaths ? +((totals.kills || 0) / totals.deaths).toFixed(2) : (totals.kills || 0)),
  };
}

module.exports = { onEvent, ladder, recentMatches, matchDetail, players, playerDetail };
