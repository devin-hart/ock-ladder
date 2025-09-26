// db.js — stores raw caret-colored names; computes a stable name_key (no-colors, lowercased)
// Handles legacy columns (e.g., name_colored) and optional frags.match_id gracefully.

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, 'ladder.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ---------- helpers ----------
const BOT_NAMES = new Set([
  'wrack','visor','gorre','angel','mynx','keel','orbb','cadavre','tankjr','lucy','sarge','grunt',
  'ranger','biker','sorlag','mr.gauntlet','anarki','bitterman','hunter','major','uriel','daemia',
  'klesk','stripe','patriot','lakerbot','bones','slash','xaero','doom','hossman','crash',
  'phobos','razor'
]);

// --- lookups by normalized key (already computed in index.js) ---
const findPlayerByNameKey = (key) => selPlayerByKey.get(String(key || '')) || null;

// --- aggregate a full profile for a player id ---
const getPlayerProfile = (id, { days = 7, limitPairs = 10 } = {}) => {
  id = Number(id);
  if (!id) return null;

  const since = sinceMs(days);
  const player = selPlayerById.get(id);
  if (!player) return null;

  const totals = getPlayerTotals(id, { since });

  const nemesis = {
    most_killed: mostKilled(id, { since, bots: 0, limit: limitPairs }),
    killed_by:   killedBy(id,   { since, bots: 0, limit: limitPairs }),
    bots: {
      most_killed: mostKilled(id, { since, bots: 1, limit: limitPairs }),
      killed_by:   killedBy(id,   { since, bots: 1, limit: limitPairs }),
    },
  };

  const sparkline_24h = sparkline24h(id);

  return {
    id: player.id,
    name: player.name,           // raw caret-colored name as stored
    is_bot: !!player.is_bot,
    first_seen: player.first_seen,
    last_seen: player.last_seen,
    model: player.last_model || null,
    hmodel: player.last_hmodel || null,
    totals,
    nemesis,
    sparkline_24h,
  };
};

// used ONLY to compute name_key, never to mutate what we store in `name`
const stripColors = (s = '') =>
  String(s).replace(/\^[0-9]/g, '').replace(/\^x[0-9a-fA-F]{6}/g, '');
const nameKeyOf = (raw = '') => stripColors(String(raw)).trim().toLowerCase();
const isBotClean = (cleanLower = '') => BOT_NAMES.has(cleanLower);

// ---------- migrations ----------
const migrate = () => {
  // Baseline tables (no legacy columns defined here)
  db.exec(`
    CREATE TABLE IF NOT EXISTS players (
      id          INTEGER PRIMARY KEY,
      name        TEXT NOT NULL,            -- raw caret-colored canonical name
      name_key    TEXT,                     -- internal identity (lower+no-colors)
      is_bot      INTEGER NOT NULL DEFAULT 0,
      first_seen  INTEGER,
      last_seen   INTEGER,
      last_model  TEXT,
      last_hmodel TEXT
    );

    CREATE TABLE IF NOT EXISTS frags (
      id         INTEGER PRIMARY KEY,
      ts         INTEGER NOT NULL,          -- ms since epoch
      killer_id  INTEGER,                   -- NULL = <world>
      victim_id  INTEGER NOT NULL,
      mod        TEXT,
      FOREIGN KEY(killer_id) REFERENCES players(id),
      FOREIGN KEY(victim_id) REFERENCES players(id)
    );
  `);

  // Ensure missing columns on players
  const pcols = db.prepare(`PRAGMA table_info(players)`).all().map(r => r.name);

  db.exec('BEGIN');
  try {
    if (!pcols.includes('name'))        db.exec(`ALTER TABLE players ADD COLUMN name TEXT NOT NULL DEFAULT ''`);
    if (!pcols.includes('name_key'))    db.exec(`ALTER TABLE players ADD COLUMN name_key TEXT`);
    if (!pcols.includes('is_bot'))      db.exec(`ALTER TABLE players ADD COLUMN is_bot INTEGER NOT NULL DEFAULT 0`);
    if (!pcols.includes('first_seen'))  db.exec(`ALTER TABLE players ADD COLUMN first_seen INTEGER`);
    if (!pcols.includes('last_seen'))   db.exec(`ALTER TABLE players ADD COLUMN last_seen INTEGER`);
    if (!pcols.includes('last_model'))  db.exec(`ALTER TABLE players ADD COLUMN last_model TEXT`);
    if (!pcols.includes('last_hmodel')) db.exec(`ALTER TABLE players ADD COLUMN last_hmodel TEXT`);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  // indexes
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_players_name_key ON players(name_key);
    CREATE INDEX IF NOT EXISTS idx_players_is_bot   ON players(is_bot);
    CREATE INDEX IF NOT EXISTS idx_frags_killer_ts  ON frags(killer_id, ts);
    CREATE INDEX IF NOT EXISTS idx_frags_victim_ts  ON frags(victim_id, ts);
    CREATE INDEX IF NOT EXISTS idx_frags_ts         ON frags(ts);
  `);

  // backfill name_key
  const missingKeys = db.prepare(`SELECT id, name FROM players WHERE name_key IS NULL OR name_key = ''`).all();
  if (missingKeys.length) {
    const upd = db.prepare(`UPDATE players SET name_key = @key WHERE id = @id`);
    db.exec('BEGIN');
    try {
      for (const r of missingKeys) upd.run({ id: r.id, key: nameKeyOf(r.name || '') });
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }

  // backfill is_bot from known names
  const rows = db.prepare(`SELECT id, name_key, is_bot FROM players`).all();
  const updBot = db.prepare(`UPDATE players SET is_bot = 1 WHERE id = ?`);
  db.exec('BEGIN');
  try {
    for (const r of rows) if (!r.is_bot && isBotClean(r.name_key || '')) updBot.run(r.id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
};
migrate();

// Legacy schema probes
const PLAYER_COLUMNS = db.prepare(`PRAGMA table_info(players)`).all();
const HAS_NAME_COLORED = PLAYER_COLUMNS.some(c => c.name === 'name_colored');

const FRAGS_COLS = db.prepare(`PRAGMA table_info(frags)`).all();
const FRAGS_HAS_MATCH_ID = FRAGS_COLS.some(c => c.name === 'match_id');
const FRAGS_MATCH_ID_NOTNULL = !!FRAGS_COLS.find(c => c.name === 'match_id' && c.notnull === 1);

const HAS_MATCHES_TABLE = !!db.prepare(
  `SELECT name FROM sqlite_master WHERE type='table' AND name='matches'`
).get();

const selLastMatchId = (FRAGS_HAS_MATCH_ID && HAS_MATCHES_TABLE)
  ? db.prepare(`SELECT id FROM matches ORDER BY id DESC LIMIT 1`)
  : null;

// ---------- prepared statements ----------
const selPlayerByKey = db.prepare(`SELECT * FROM players WHERE name_key = ?`);
const selPlayerById  = db.prepare(`SELECT * FROM players WHERE id = ?`);

const insPlayer = HAS_NAME_COLORED
  ? db.prepare(`
      INSERT INTO players (name, name_colored, name_key, is_bot, first_seen, last_seen, last_model, last_hmodel)
      VALUES (@name, @name, @name_key, @is_bot, @ts, @ts, @last_model, @last_hmodel)
    `)
  : db.prepare(`
      INSERT INTO players (name, name_key, is_bot, first_seen, last_seen, last_model, last_hmodel)
      VALUES (@name, @name_key, @is_bot, @ts, @ts, @last_model, @last_hmodel)
    `);

const updPlayerSeen = HAS_NAME_COLORED
  ? db.prepare(`
      UPDATE players
      SET name=@name,
          name_colored=@name,
          is_bot=CASE WHEN @bset=1 THEN MAX(is_bot, @is_bot) ELSE is_bot END,
          last_model=COALESCE(@last_model, last_model),
          last_hmodel=COALESCE(@last_hmodel, last_hmodel),
          last_seen=@ts
      WHERE id=@id
    `)
  : db.prepare(`
      UPDATE players
      SET name=@name,
          is_bot=CASE WHEN @bset=1 THEN MAX(is_bot, @is_bot) ELSE is_bot END,
          last_model=COALESCE(@last_model, last_model),
          last_hmodel=COALESCE(@last_hmodel, last_hmodel),
          last_seen=@ts
      WHERE id=@id
    `);

const insFrag = FRAGS_HAS_MATCH_ID
  ? db.prepare(`
      INSERT INTO frags (ts, killer_id, victim_id, mod, match_id)
      VALUES (@ts, @killer_id, @victim_id, @mod, @match_id)
    `)
  : db.prepare(`
      INSERT INTO frags (ts, killer_id, victim_id, mod)
      VALUES (@ts, @killer_id, @victim_id, @mod)
    `);

// ---------- public API: persistence ----------
const upsertPlayer = (rawName, { ts = Date.now(), model, hmodel } = {}) => {
  if (!rawName) return null;
  const key = nameKeyOf(rawName);
  if (!key) return null;

  const existing = selPlayerByKey.get(key);
  const bot = isBotClean(key) ? 1 : 0;

  if (!existing) {
    const info = insPlayer.run({
      name: rawName,
      name_key: key,
      is_bot: bot,
      ts,
      last_model: model || null,
      last_hmodel: hmodel || null
    });
    return info.lastInsertRowid;
  } else {
    updPlayerSeen.run({
      id: existing.id,
      name: rawName,
      bset: 1,
      is_bot: bot,
      last_model: model || null,
      last_hmodel: hmodel || null,
      ts
    });
    return existing.id;
  }
};

const persistFragFromNames = ({ ts = Date.now(), killerName, victimName, mod, matchId }) => {
  const world = (killerName || '').trim().toLowerCase() === '<world>' ? 1 : 0;
  const victimId = upsertPlayer(victimName, { ts });
  if (!victimId) return;

  const killerId = world ? null : upsertPlayer(killerName, { ts });

  let mId = null;
  if (FRAGS_HAS_MATCH_ID) {
    mId = (typeof matchId === 'number' ? matchId : null);
    if (mId == null && selLastMatchId) mId = selLastMatchId.get()?.id ?? null;
    if (FRAGS_MATCH_ID_NOTNULL && mId == null) {
      console.warn('persistFragFromNames: missing match_id and frags.match_id is NOT NULL — skipping frag');
      return;
    }
  }

  if (FRAGS_HAS_MATCH_ID) {
    insFrag.run({ ts, killer_id: killerId, victim_id: victimId, mod: mod || null, match_id: mId });
  } else {
    insFrag.run({ ts, killer_id: killerId, victim_id: victimId, mod: mod || null });
  }
};

// Bridge from logtail/status events into DB
const onEvent = (evt) => {
  if (!evt || !evt.type) return;
  const t = evt.ts || Date.now();
  const type = String(evt.type).toLowerCase();

  switch (type) {
    case 'initgame':
      // no-op (match creation is managed in index.js, which can stamp ms.currentMatchId)
      return;

    case 'clientuserinfochanged': {
      const raw = evt.name_colored || evt.nameColored || evt.name || '';
      const model = evt.model || null;
      const hmodel = evt.hmodel || null;
      if (raw) upsertPlayer(raw, { ts: t, model, hmodel });
      return;
    }

    case 'kill':
    case 'kill:':
    case 'kill ':
      persistFragFromNames({
        ts: t,
        killerName: evt.killerName || evt.killer?.name || evt.killer || '',
        victimName: evt.victimName || evt.victim?.name || evt.victim || '',
        mod: evt.mod,
        matchId: evt.matchId // supplied by index.js from current match state
      });
      return;

    default:
      return;
  }
};

// ---------- stats & queries ----------
const sinceMs = (days) => (days && Number(days) > 0) ? (Date.now() - Number(days) * 86400000) : null;

const getPlayerTotals = (playerId, { since } = {}) => {
  const WS = since ? ' AND ts >= ? ' : '';
  const args = since ? [since] : [];

  const kills    = db.prepare(`SELECT COUNT(*) c FROM frags WHERE killer_id = ?${WS}`).get(playerId, ...args).c;
  const deaths   = db.prepare(`SELECT COUNT(*) c FROM frags WHERE victim_id = ?${WS}`).get(playerId, ...args).c;
  const suicides = db.prepare(`SELECT COUNT(*) c FROM frags WHERE victim_id = ?${WS} AND (killer_id IS NULL OR killer_id = victim_id)`).get(playerId, ...args).c;

  const railKills   = db.prepare(`SELECT COUNT(*) c FROM frags WHERE killer_id = ? AND mod = 'MOD_RAILGUN'${WS}`).get(playerId, ...args).c;
  const railDeaths  = db.prepare(`SELECT COUNT(*) c FROM frags WHERE victim_id = ? AND mod = 'MOD_RAILGUN'${WS}`).get(playerId, ...args).c;

  const gauntKills  = db.prepare(`SELECT COUNT(*) c FROM frags WHERE killer_id = ? AND mod = 'MOD_GAUNTLET'${WS}`).get(playerId, ...args).c;
  const gauntDeaths = db.prepare(`SELECT COUNT(*) c FROM frags WHERE victim_id = ? AND mod = 'MOD_GAUNTLET'${WS}`).get(playerId, ...args).c;

  const kd = deaths ? +(kills / deaths).toFixed(2) : kills;

  return {
    kills, deaths, kd,
    suicides,
    rail: { kills: railKills, deaths: railDeaths },
    gauntlet: { kills: gauntKills, deaths: gauntDeaths }
  };
};

const mostKilled = (playerId, { since, bots = 0, limit = 5 } = {}) => {
  const WS = since ? ' AND f.ts >= ? ' : '';
  const args = since ? [since] : [];
  return db.prepare(`
    SELECT v.id, v.name AS name, COUNT(*) AS count
    FROM frags f
    JOIN players v ON v.id = f.victim_id
    WHERE f.killer_id = ?
      AND v.id <> ?
      AND v.is_bot = ?
      ${WS}
    GROUP BY v.id
    ORDER BY count DESC
    LIMIT ?
  `).all(playerId, playerId, bots, ...args, limit);
};

const killedBy = (playerId, { since, bots = 0, limit = 5 } = {}) => {
  const WS = since ? ' AND f.ts >= ? ' : '';
  const args = since ? [since] : [];
  return db.prepare(`
    SELECT k.id, k.name AS name, COUNT(*) AS count
    FROM frags f
    JOIN players k ON k.id = f.killer_id
    WHERE f.victim_id = ?
      AND k.id <> ?
      AND k.is_bot = ?
      AND k.id IS NOT NULL
      ${WS}
    GROUP BY k.id
    ORDER BY count DESC
    LIMIT ?
  `).all(playerId, playerId, bots, ...args, limit);
};

const ladder = (limit = 25, offset = 0, { includeBots = false } = {}) => {
  const rows = db.prepare(`
    WITH k AS (SELECT killer_id AS id, COUNT(*) c FROM frags GROUP BY killer_id),
         d AS (SELECT victim_id AS id, COUNT(*) c FROM frags GROUP BY victim_id)
    SELECT p.id,
           p.name AS name,
           COALESCE(k.c,0) AS kills,
           COALESCE(d.c,0) AS deaths
    FROM players p
    LEFT JOIN k ON k.id = p.id
    LEFT JOIN d ON d.id = p.id
    WHERE (? = 1 OR p.is_bot = 0)
    ORDER BY kills DESC,
             (CASE WHEN COALESCE(d.c,0)=0 THEN COALESCE(k.c,0)
                   ELSE (1.0*COALESCE(k.c,0)/COALESCE(d.c,0)) END) DESC,
             deaths ASC
    LIMIT ? OFFSET ?
  `).all(includeBots ? 1 : 0, limit, offset);

  return rows.map(r => ({
    id: r.id,
    name: r.name,
    kills: r.kills,
    deaths: r.deaths,
    kd: r.deaths ? +(r.kills / r.deaths).toFixed(2) : r.kills
  }));
};

const sparkline24h = (playerId) => {
  const end = Date.now();
  const start = end - 24 * 3600 * 1000;
  const rows = db.prepare(`
    SELECT (ts/3600000)*3600000 AS bucket, COUNT(*) AS c
    FROM frags
    WHERE ts >= ? AND (killer_id = ? OR victim_id = ?)
    GROUP BY bucket
    ORDER BY bucket
  `).all(start, playerId, playerId);

  const out = [];
  const firstBucket = Math.floor(start / 3600000) * 3600000;
  const map = new Map(rows.map(r => [Number(r.bucket), r.c]));
  for (let i = 0; i < 24; i++) {
    const t = firstBucket + i * 3600000;
    out.push({ t, c: map.get(t) || 0 });
  }
  return out;
};

const findPlayerByName = (rawName) => {
  const key = nameKeyOf(rawName || '');
  if (!key) return null;
  return selPlayerByKey.get(key) || null;
};
const getPlayer = (id) => selPlayerById.get(id) || null;

// ---------- exports ----------
module.exports = {
  onEvent,
  upsertPlayer,
  persistFragFromNames,
  getPlayer,
  findPlayerByName,
  findPlayerByNameKey,
  getPlayerTotals,
  mostKilled,
  killedBy,
  ladder,
  sparkline24h,
  getPlayerProfile,
  sinceMs,
};

