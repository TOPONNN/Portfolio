const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = 3099;
const visitors = new Map(); // id -> visitor info
let visitorCounter = 0;

// Fetch geolocation — ipinfo.io primary (accurate for KR), ip-api.com fallback
async function getGeoInfo(ip) {
  // Skip private/local IPs
  if (!ip || ip === '127.0.0.1' || ip === '::1' || ip.startsWith('10.') || ip.startsWith('172.') || ip.startsWith('192.168.')) {
    return { country: 'Local', city: 'Server', region: '', isp: 'Local Network', lat: 0, lon: 0, timezone: '', org: '' };
  }
  // Try ipinfo.io first (better accuracy for Korean IPs)
  try {
    const resp = await fetch(`https://ipinfo.io/${ip}/json`);
    const data = await resp.json();
    if (data && data.country && !data.bogon) {
      const [lat, lon] = (data.loc || '0,0').split(',').map(Number);
      const orgParts = (data.org || '').replace(/^AS\d+\s*/, '');
      return {
        country: regionNames(data.country),
        city: data.city || 'Unknown',
        region: data.region || '',
        isp: orgParts || '',
        lat, lon,
        timezone: data.timezone || '',
        org: orgParts || '',
        as: (data.org || '').match(/^AS\d+/)?.[0] || ''
      };
    }
  } catch (e) {
    console.error('ipinfo.io failed, trying fallback:', e.message);
  }
  // Fallback to ip-api.com
  try {
    const resp = await fetch(`http://ip-api.com/json/${ip}?fields=status,country,regionName,city,lat,lon,timezone,isp,org,as,query`);
    const data = await resp.json();
    if (data.status === 'success') {
      return {
        country: data.country || 'Unknown',
        city: data.city || 'Unknown',
        region: data.regionName || '',
        isp: data.isp || '',
        lat: data.lat || 0,
        lon: data.lon || 0,
        timezone: data.timezone || '',
        org: data.org || '',
        as: data.as || ''
      };
    }
  } catch (e) {
    console.error('Geo lookup failed:', e.message);
  }
  return { country: 'Unknown', city: 'Unknown', region: '', isp: '', lat: 0, lon: 0, timezone: '', org: '' };
}

// Convert country code to full name
function regionNames(code) {
  const names = { KR: 'South Korea', US: 'United States', JP: 'Japan', CN: 'China', GB: 'United Kingdom', DE: 'Germany', FR: 'France', CA: 'Canada', AU: 'Australia', SG: 'Singapore' };
  return names[code] || code;
}

// Parse User-Agent into readable device info
function parseUA(ua) {
  if (!ua) return { browser: 'Unknown', os: 'Unknown', device: 'Unknown' };

  let browser = 'Unknown';
  let os = 'Unknown';
  let device = 'Desktop';

  // Browser detection
  if (ua.includes('Firefox/')) browser = 'Firefox';
  else if (ua.includes('Edg/')) browser = 'Edge';
  else if (ua.includes('OPR/') || ua.includes('Opera/')) browser = 'Opera';
  else if (ua.includes('Chrome/')) browser = 'Chrome';
  else if (ua.includes('Safari/') && !ua.includes('Chrome')) browser = 'Safari';
  else if (ua.includes('MSIE') || ua.includes('Trident/')) browser = 'IE';

  // OS detection
  if (ua.includes('Windows NT')) os = 'Windows';
  else if (ua.includes('Mac OS X')) os = 'macOS';
  else if (ua.includes('Linux') && !ua.includes('Android')) os = 'Linux';
  else if (ua.includes('Android')) { os = 'Android'; device = 'Mobile'; }
  else if (ua.includes('iPhone')) { os = 'iOS'; device = 'Mobile'; }
  else if (ua.includes('iPad')) { os = 'iPadOS'; device = 'Tablet'; }

  return { browser, os, device };
}

// Broadcast current visitors to all connected clients
function broadcast() {
  const visitorList = Array.from(visitors.values()).map(v => ({
    id: v.id,
    ip: v.ip,
    geo: v.geo,
    ua: v.ua,
    page: v.page,
    connectedAt: v.connectedAt,
    lastActivity: v.lastActivity
  }));

  const message = JSON.stringify({
    type: 'visitors',
    count: visitorList.length,
    visitors: visitorList,
    serverTime: Date.now()
  });

  wss.clients.forEach(client => {
    if (client.readyState === 1) {
      client.send(message);
    }
  });
}

// HTTP server for health check
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', visitors: visitors.size }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

// WebSocket server
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', async (ws, req) => {
  visitorCounter++;
  const id = `v_${visitorCounter}_${Date.now()}`;

  // Get real IP from X-Forwarded-For (set by nginx) or direct connection
  const forwarded = req.headers['x-forwarded-for'];
  const ip = forwarded ? forwarded.split(',')[0].trim() : req.socket.remoteAddress?.replace('::ffff:', '') || 'Unknown';
  const userAgent = req.headers['user-agent'] || '';
  const uaInfo = parseUA(userAgent);

  // Fetch geo info
  const geo = await getGeoInfo(ip);

  const visitor = {
    id,
    ip,
    geo,
    ua: uaInfo,
    page: '/',
    connectedAt: Date.now(),
    lastActivity: Date.now(),
    ws
  };

  visitors.set(id, visitor);
  console.log(`[+] ${id} connected from ${ip} (${geo.city}, ${geo.country}) - ${uaInfo.browser}/${uaInfo.os}`);

  // Send visitor their own info
  ws.send(JSON.stringify({ type: 'welcome', id, ip, geo, ua: uaInfo }));

  // Broadcast updated list
  broadcast();

  // Handle messages (page navigation, heartbeat)
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'page') {
        visitor.page = msg.page || '/';
        visitor.lastActivity = Date.now();
        broadcast();
      } else if (msg.type === 'ping') {
        visitor.lastActivity = Date.now();
        ws.send(JSON.stringify({ type: 'pong' }));
      }
    } catch (e) {}
  });

  ws.on('close', () => {
    visitors.delete(id);
    console.log(`[-] ${id} disconnected (${ip})`);
    broadcast();
  });

  ws.on('error', () => {
    visitors.delete(id);
    broadcast();
  });
});

// Cleanup stale connections every 30s
setInterval(() => {
  const now = Date.now();
  for (const [id, v] of visitors) {
    if (now - v.lastActivity > 120000) { // 2 min timeout
      v.ws.terminate();
      visitors.delete(id);
      console.log(`[x] ${id} timed out`);
    }
  }
  broadcast();
}, 30000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Tracker server running on port ${PORT}`);
});
