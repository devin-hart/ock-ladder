const dgram = require('dgram');

function parseInfoString(s) {
  const out = {};
  const parts = s.split('\\').slice(1);
  for (let i = 0; i < parts.length; i += 2) out[parts[i]] = parts[i + 1];
  return out;
}

function parseStatusResponse(buf) {
  const text = buf.toString('utf8');
  const lines = text.split('\n').slice(1); // drop "statusResponse"
  const info = parseInfoString(lines[0] || '');
  const players = lines.slice(1).filter(Boolean).map(l => {
    const m = l.match(/^(-?\d+)\s+(\d+)\s+"(.*)"$/);
    return m ? { score: +m[1], ping: +m[2], name: m[3] } : null;
  }).filter(Boolean);
  return { info, players };
}

function getStatus(host = '127.0.0.1', port = 27960, timeoutMs = 1200) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    const pkt = Buffer.concat([Buffer.alloc(4, 0xff), Buffer.from('getstatus\n')]);
    let finished = false;
    const done = (err, res) => { if (!finished) { finished = true; sock.close(); err ? reject(err) : resolve(res); } };

    sock.once('message', msg => { try { done(null, parseStatusResponse(msg)); } catch (e) { done(e); } });
    sock.once('error', done);
    sock.send(pkt, 0, pkt.length, port, host);
    setTimeout(() => done(new Error('timeout')), timeoutMs);
  });
}

module.exports = { getStatus };