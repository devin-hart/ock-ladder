// db.js — store names exactly as in games.log; no color stripping in storage.
// Identity uses a simple name_key = lowercase(sanitized original).
// Exports: onEvent(evt), ladder(limit), recentMatches(limit)

const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'ladder.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('synchronous = NORMAL');

/* ---------------- helpers ---------------- */
const now = () => Date.now();

// Keep the original name; only remove control chars that could break storage.
// This preserves ^ color codes, quotes, unicode letters, etc.
const sanitizeName = (s = '') =>
  String(s).replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, 128);

// **No color stripping**: join key is just sanitized lowercase original.
// If someone changes colors, it will be treated as a different identity.
// (We can evolve this later if you decide otherwise.)
const nameKey = (s = '') => sanitizeName(s).toLowerCase();
const isWorld = (s = '') => s === '<world>' || s === 'world' || s === '' || s == null;

/* ---------------- schema ---------------- */
db.exec(`
CREATE TABLE IF NOT EXISTS players (
  id           INTEGER PRIMARY KEY,
  name_colored TEXT NOT NULL,   -- EXACTLY as in log (e.g. "^6d^32")
  name_key     TEXT NOT NULL,   -- sanitized+lowercase (no color stripping)
  guid         TEXT,            -- optional if ever available
  last_ip      TEXT,            -- optional if ever available
  first_seen   INTEGER NOT NULL,
  last_seen    INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_players_name_key ON players(name_key);
CREATE UNIQUE INDEX IF NOT EXISTS ux_players_guid     ON players(guid) WHERE guid IS NOT NULL;

CREATE TABLE IF NOT EXISTS player_aliases (
  id           INTEGER PRIMARY KEY,
  player_id    INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  name_colored TEXT NOT NULL,
  name_key     TEXT NOT NULL,
  first_seen   INTEGER NOT NULL,
  last_seen    INTEGER NOT NULL,
  UNIQUE(player_id, name_key)
);

CREATE TABLE IF NOT EXISTS matches (
  id          INTEGER PRIMARY KEY,
  map         TEXT,
  gametype    TEXT,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER
);

CREATE TABLE IF NOT EXISTS frags (
  id         INTEGER PRIMARY KEY,
  match_id   INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  killer_id  INTEGER REFERENCES players(id) ON DELETE SET NULL,
  victim_id  INTEGER REFERENCES players(id) ON DELETE SET NULL,
  mod        TEXT,
  ts         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_aliases_player ON player_aliases(player_id);
CREATE INDEX IF NOT EXISTS ix_frags_match    ON frags(match_id);
CREATE INDEX IF NOT EXISTS ix_frags_killer   ON frags(killer_id);
CREATE INDEX IF NOT EXISTS ix_frags_victim   ON frags(victim_id);
CREATE INDEX IF NOT EXISTS ix_frags_ts       ON frags(ts);
`);

/* ---------------- prepared statements ---------------- */
const selPlayerByGuid = db.prepare(`SELECT * FROM players WHERE guid = ? LIMIT 1`);
const selPlayerByKey  = db.prepare(`SELECT * FROM players WHERE name_key = ? LIMIT 1`);

const insPlayer = db.prepare(`
  INSERT INTO players (name_colored, name_key, guid, last_ip, first_seen, last_seen)
  VALUES (@name_colored, @name_key, @guid, @last_ip, @now, @now)
`);

const updPlayerSeen = db.prepare(`UPDATE players SET last_seen=@now WHERE id=@id`);

const updPlayerDisplay = db.prepare(`
  UPDATE players
  SET name_colored=@name_colored, last_seen=@now
  WHERE id=@id
`);

const updPlayerGuid = db.prepare(`UPDATE players SET guid=COALESCE(guid,@guid) WHERE id=@id`);
const updPlayerIp   = db.prepare(`UPDATE players SET last_ip=@ip, last_seen=@now WHERE id=@id`);

const selAlias = db.prepare(`SELECT id FROM player_aliases WHERE player_id=? AND name_key=? LIMIT 1`);
const insAlias = db.prepare(`
  INSERT INTO player_aliases (player_id, name_colored, name_key, first_seen, last_seen)
  VALUES (@player_id, @name_colored, @name_key, @now, @now)
`);
const touchAlias = db.prepare(`UPDATE player_aliases SET last_seen=@now WHERE id=@id`);

const insMatch = db.prepare(`
  INSERT INTO matches (map, gametype, started_at, ended_at)
  VALUES (@map, @gametype, @started_at, NULL)
`);
const endMatchStmt = db.prepare(`UPDATE matches SET ended_at=@ended_at WHERE id=@id`);

const insFrag = db.prepare(`
  INSERT INTO frags (match_id, killer_id, victim_id, mod, ts)
  VALUES (@match_id, @killer_id, @victim_id, @mod, @ts)
`);

const ladderStmt = db.prepare(`
  SELECT
    p.id,
    p.name_colored AS name_colored,
    (SELECT COUNT(*) FROM frags k WHERE k.killer_id = p.id) AS kills,
    (SELECT COUNT(*) FROM frags v WHERE v.victim_id = p.id) AS deaths
  FROM players p
  ORDER BY kills DESC, deaths ASC, p.last_seen DESC
  LIMIT ?
`);

const recentMatchesStmt = db.prepare(`
  SELECT
    m.id, m.map, m.gametype, m.started_at, m.ended_at,
    COUNT(f.id) AS frags
  FROM matches m
  LEFT JOIN frags f ON f.match_id = m.id
  GROUP BY m.id
  ORDER BY m.id DESC
  LIMIT ?
`);

/* ---------------- tx helper ---------------- */
const inTx = (fn) => {
  const tx = db.transaction(fn);
  return (...args) => tx(...args);
};

/* ---------------- identity resolution ---------------- */
const getOrCreatePlayer = inTx(({ colored, guid = null, ip = null, ts = now() }) => {
  if (isWorld(colored)) return null;

  const display = sanitizeName(colored);
  if (!display) return null;

  const key = nameKey(display);
  let row = null;
  if (guid) row = selPlayerByGuid.get(guid);
  if (!row) row = selPlayerByKey.get(key);

  if (!row) {
    insPlayer.run({ name_colored: display, name_key: key, guid, last_ip: ip, now: ts });
    row = selPlayerByKey.get(key);
    insAlias.run({ player_id: row.id, name_colored: display, name_key: key, now: ts });
    return row.id;
  }

  // touch last_seen always
  updPlayerSeen.run({ id: row.id, now: ts });

  // if the visible name changed, update + add/touch alias
  if (display && display !== row.name_colored) {
    updPlayerDisplay.run({ id: row.id, name_colored: display, now: ts });
    const akey = nameKey(display);
    const arow = selAlias.get(row.id, akey);
    if (!arow) insAlias.run({ player_id: row.id, name_colored: display, name_key: akey, now: ts });
    else       touchAlias.run({ id: arow.id, now: ts });
  }

  if (guid && !row.guid) updPlayerGuid.run({ id: row.id, guid });
  if (ip)                updPlayerIp.run({ id: row.id, ip, now: ts });

  return row.id;
});

/* ---------------- event sink ---------------- */
const onEvent = inTx((evt) => {
  if (!evt || !evt.type) return { ok: true };
  const t = evt.ts || now();

  switch (evt.type) {
    case 'InitGame': {
      const map = evt.map || 'unknown';
      const gametype = evt.gametype || evt.g_gametype || 'FFA';
      const info = insMatch.run({ map, gametype, started_at: t });
      currentMatchId = info.lastInsertRowid;
      return { ok: true, currentMatchId };
    }
    case 'ShutdownGame': {
      if (currentMatchId != null) endMatchStmt.run({ id: currentMatchId, ended_at: t });
      currentMatchId = null;
      return { ok: true };
    }
    case 'ClientUserinfoChanged': {
      const colored = evt.name_colored || evt.name || '';
      const guid = evt.guid || null;
      const ip   = evt.ip || null;
      getOrCreatePlayer({ colored, guid, ip, ts: t });
      return { ok: true };
    }
    case 'Kill': {
      if (currentMatchId == null) {
        const info = insMatch.run({ map: 'unknown', gametype: 'FFA', started_at: t });
        currentMatchId = info.lastInsertRowid;
      }
      const killerName = evt.killer?.name || '';
      const victimName = evt.victim?.name || '';
      const killerId = isWorld(killerName) ? null : getOrCreatePlayer({ colored: killerName, ts: t });
      const victimId = isWorld(victimName) ? null : getOrCreatePlayer({ colored: victimName, ts: t });
      insFrag.run({
        match_id: currentMatchId,
        killer_id: killerId,
        victim_id: victimId,
        mod: evt.mod || null,
        ts: t
      });
      return { ok: true };
    }
    default:
      return { ok: true };
  }
});

/* ---------------- queries ---------------- */
const ladder = (limit = 25) =>
  ladderStmt.all(Math.max(1, Math.min(+limit || 25, 200))).map((r) => {
    const kills = Number(r.kills) || 0;
    const deaths = Number(r.deaths) || 0;
    return {
      id: r.id,
      name: r.name_colored,          // expose original caret name
      name_colored: r.name_colored,  // same, explicit
      kills,
      deaths,
      kd: deaths ? +(kills / deaths).toFixed(2) : kills
    };
  });

const recentMatches = (limit = 10) =>
  recentMatchesStmt.all(Math.max(1, Math.min(+limit || 10, 200)));

/* ---------------- state & exports ---------------- */
let currentMatchId = null;

module.exports = { onEvent, ladder, recentMatches };
