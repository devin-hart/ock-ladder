const dgram = require('dgram');

// \key\val\key\val ...
const parseInfoString = (s) => {
    const out = {};
    if (!s) return out;
    const parts = s.split('\\');
    // parts[0] is empty before the first backslash
    for (let i = 1; i + 1 < parts.length; i += 2) out[parts[i]] = parts[i + 1];
    return out;
};

const LINE_RE = /^(-?\d+)\s+(\d+)\s+"(.*)"$/;

// Raw UDP buffer -> { info, players:[{score,ping,name}] }
const parseStatusResponse = (buf) => {
    const text = buf.toString('utf8');
    // First line is "statusResponse"
    const lines = text.split('\n');
    if (lines.length === 0) return {
        info: {},
        players: []
    };

    const info = parseInfoString(lines[1] || '');
    const players = [];

    for (let i = 2; i < lines.length; i++) {
        const l = lines[i];
        if (!l) continue;
        const m = LINE_RE.exec(l);
        if (!m) continue;
        players.push({
            score: +m[1],
            ping: +m[2],
            name: m[3]
        });
    }

    return {
        info,
        players
    };
};

// Query ioquake3 getstatus over UDP
const getStatus = (host = '127.0.0.1', port = 27960, timeoutMs = 1200) =>
    new Promise((resolve, reject) => {
        const sock = dgram.createSocket('udp4');
        const pkt = Buffer.concat([Buffer.alloc(4, 0xff), Buffer.from('getstatus\n')]);

        let finished = false;
        const done = (err, res) => {
            if (finished) return;
            finished = true;
            try {
                sock.close();
            } catch {}
            err ? reject(err) : resolve(res);
        };

        sock.once('message', (msg) => {
            try {
                done(null, parseStatusResponse(msg));
            } catch (e) {
                done(e);
            }
        });
        sock.once('error', done);

        // fire the packet
        sock.send(pkt, 0, pkt.length, port, host);

        // safety timeout
        setTimeout(() => done(new Error('timeout')), timeoutMs);
    });

module.exports = {
    getStatus
};

// --- Optional: RCON "status" (gets ip:port per player) ---
const rconStatus = ({ host = '127.0.0.1', port = 27960, password, timeoutMs = 600 }) =>
  new Promise((resolve) => {
    if (!password) return resolve([]);           // no password => no-op
    const sock = dgram.createSocket('udp4');     // dgram already required above
    let buf = Buffer.alloc(0);
    const msg = Buffer.from('\xff\xff\xff\xff' + 'rcon ' + password + ' status');

    const close = () => { try { sock.close(); } catch {} };
    sock.on('message', m => { buf = Buffer.concat([buf, m]); });
    sock.on('error', () => { close(); resolve([]); });

    sock.send(msg, port, host, () => {
      setTimeout(() => {                           // small window to collect the reply
        close();
        resolve(parseRconStatus(buf.toString('latin1')));
      }, timeoutMs);
    });
  });

const parseRconStatus = (text = '') => {
  const lines = text.split('\n').map(s => s.trim()).filter(Boolean);
  const hdr = lines.findIndex(l => /^num\s+score\s+ping\s+name/i.test(l));
  if (hdr === -1) return [];
  const out = [];
  for (let i = hdr + 1; i < lines.length; i++) {
    const L = lines[i];
    // Typical row: "0  20  50  d2           40  1.2.3.4:27960  12345  25000"
    const parts = L.split(/\s+/);
    if (parts.length < 8) continue;
    const num   = +parts[0];
    const score = +parts[1];
    const ping  = +parts[2];
    // name may contain spaces; walk until we hit ip:port
    let j = 3, nameParts = [];
    while (j < parts.length && !/^\d+\.\d+\.\d+\.\d+:\d+$/.test(parts[j])) { nameParts.push(parts[j]); j++; }
    const name = nameParts.join(' ').trim();
    const [ip, portStr] = (parts[j] || '').split(':');
    out.push({ num, score, ping, name, ip: ip || null, port: +(portStr || 0) || null });
  }
  return out;
};

// extend exports without touching existing ones
module.exports.rconStatus = rconStatus;
