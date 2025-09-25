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