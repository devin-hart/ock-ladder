// db.js (minimal, known-good)
const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'ladder.db'));
db.pragma('journal_mode = wal');

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
  hostname   TEXT,
  started_at INTEGER,
  ended_at   INTEGER
);
CREATE TABLE IF NOT EXISTS frags (
  id INTEGER PRIMARY KEY,
  match_id  INTEGER NOT NULL,
  killer_id INTEGER,     -- NULL allowed for <world>
  victim_id INTEGER,     -- keep NULL-safe just in case
  mod       TEXT,
  ts        INTEGER NOT NULL,
  FOREIGN KEY(match_id)  REFERENCES matches(id),
  FOREIGN KEY(killer_id) REFERENCES players(id),
  FOREIGN KEY(victim_id) REFERENCES players(id)
);
`);

/* Prepared statements */
const upsertPlayer = db.prepare(`
INSERT INTO players (name_clean, name_colored, first_seen, last_seen)
VALUES (@name_clean, @name_colored, @now, @now)
ON CONFLICT(name_clean) DO UPDATE SET
  name_colored = excluded.name_colored,
  last_seen    = excluded.last_seen
RETURNING id;
`);

const insertMatch = db.prepare(`
INSERT INTO matches (map, gametype, hostname, started_at)
VALUES (@map, @gametype, @hostname, @started_at)
RETURNING id;
`);

const endMatch = db.prepare(`UPDATE matches SET ended_at=@now WHERE id=@id;`);

const insertFrag = db.prepare(`
INSERT INTO frags (match_id, killer_id, victim_id, mod, ts)
VALUES (@match_id, @killer_id, @victim_id, @mod, @ts);
`);

/* State */
let currentMatchId = null;

/* Helpers */
const clean = s => (s || '').replace(/\^[0-9]/g, '').replace(/[^\x20-\x7E]/g, '').trim();

function getPlayerId(name_clean, name_colored) {
  if (!name_clean || name_clean === '<world>') return null;
  return upsertPlayer.get({ name_clean, name_colored, now: Date.now() }).id;
}

/* Event sink */
function onEvent(evt) {
  if (evt.type === 'init') {
    const meta = evt.meta || {};
    currentMatchId = insertMatch.get({
      map: meta.map || 'unknown',
      gametype: meta.gametype || '0',
      hostname: meta.hostname || '',
      started_at: Date.now()
    }).id;
    return;
  }

  if (evt.type === 'user') {
    // optional: keep roster up to date
    const nameClean = clean(evt.nameClean);
    const nameColored = evt.nameColored ?? evt.nameClean ?? nameClean;
    if (nameClean) getPlayerId(nameClean, nameColored);
    return;
  }

  if (evt.type === 'kill') {
    if (!currentMatchId) return; // need an opened match
    // Tailer emits killerName/victimName (your logtail.js)
    const kName = evt.killerName;
    const vName = evt.victimName;

    const killer_id = (clean(kName) && clean(kName) !== '<world>') ? getPlayerId(clean(kName), kName) : null;
    const victim_id = (clean(vName) && clean(vName) !== '<world>') ? getPlayerId(clean(vName), vName) : null;

    insertFrag.run({
      match_id: currentMatchId,
      killer_id,
      victim_id,
      mod: evt.mod || '',
      ts: Date.now()
    });
    return;
  }

  if (evt.type === 'shutdown') {
    if (currentMatchId) endMatch.run({ id: currentMatchId, now: Date.now() });
    currentMatchId = null;
    return;
  }
}

/* Queries for API */
function ladder(limit = 100) {
  return db.prepare(`
    SELECT p.name_clean AS name,
           SUM(f.killer_id = p.id) AS kills,
           SUM(f.victim_id = p.id) AS deaths
    FROM players p
    LEFT JOIN frags f ON f.killer_id = p.id OR f.victim_id = p.id
    GROUP BY p.id
    ORDER BY kills DESC
    LIMIT ?
  `).all(limit).map(r => ({
    name: r.name,
    kills: r.kills || 0,
    deaths: r.deaths || 0,
    kd: r.deaths ? +((r.kills || 0) / r.deaths).toFixed(2) : (r.kills || 0)
  }));
}

function recentMatches(limit = 10) {
  return db.prepare(`
    SELECT m.id, m.map, m.started_at,
           COUNT(f.id) AS frags
    FROM matches m
    LEFT JOIN frags f ON f.match_id = m.id
    GROUP BY m.id
    ORDER BY m.id DESC
    LIMIT ?
  `).all(limit);
}

module.exports = { onEvent, ladder, recentMatches };
