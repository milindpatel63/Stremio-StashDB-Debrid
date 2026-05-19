const realdebrid = require('../services/realdebrid');
const debridlink = require('../services/debridlink');
const torbox = require('../services/torbox');
const prowlarr = require('../services/prowlarr');
const { decryptJson } = require('../services/crypto');
const { pickLargestVideoFile } = require('../utils/videoFiles');
const crypto = require('crypto');
const { extractInfoHashFromMagnet } = require('../utils/magnet');

function tokenKey(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 16);
}

const inFlight = new Map();
const resolved = new Map();

function fingerprint(str, len = 12) {
  return crypto.createHash('sha256').update(String(str)).digest('hex').slice(0, len);
}

function pickLargestVideoFileIndex(files = []) {
  const file = pickLargestVideoFile(files);
  return file?.id ?? null;
}

async function resolveToDirectUrlFromMagnet(apiToken, magnet) {
  const added = await realdebrid.addMagnet(apiToken, magnet);
  const torrentId = added?.id;
  if (!torrentId) throw new Error('Failed to add magnet to Real-Debrid');
  console.log('[resolve] added magnet torrentId=', torrentId);

  const info = await realdebrid.getTorrentInfo(apiToken, torrentId);
  const fileId = pickLargestVideoFileIndex(info?.files || []);
  if (fileId != null) {
    await realdebrid.selectFiles(apiToken, torrentId, [fileId]);
  } else {
    await realdebrid.selectFiles(apiToken, torrentId, 'all');
  }

  const attempts = 8;
  for (let i = 0; i < attempts; i++) {
    const updated = await realdebrid.getTorrentInfo(apiToken, torrentId);
    const link = updated?.links?.[0];
    if (link) {
      const unres = await realdebrid.unrestrictLink(apiToken, link);
      const directUrl = unres?.download || unres?.link;
      if (!directUrl) throw new Error('Unrestrict failed');
      console.log('[resolve] Real-Debrid unrestrict ok, redirecting');
      return directUrl;
    }
    await new Promise(r => setTimeout(r, 1500));
  }

  throw new Error('Timed out waiting for Real-Debrid torrent links');
}

async function resolveToDirectUrlFromTorrentFile(apiToken, torrentBuf) {
  const added = await realdebrid.addTorrent(apiToken, torrentBuf);
  const torrentId = added?.id;
  if (!torrentId) throw new Error('Failed to add torrent file to Real-Debrid');
  console.log('[resolve] added torrent file torrentId=', torrentId);

  const info = await realdebrid.getTorrentInfo(apiToken, torrentId);
  const fileId = pickLargestVideoFileIndex(info?.files || []);
  if (fileId != null) {
    await realdebrid.selectFiles(apiToken, torrentId, [fileId]);
  } else {
    await realdebrid.selectFiles(apiToken, torrentId, 'all');
  }

  const attempts = 8;
  for (let i = 0; i < attempts; i++) {
    const updated = await realdebrid.getTorrentInfo(apiToken, torrentId);
    const link = updated?.links?.[0];
    if (link) {
      const unres = await realdebrid.unrestrictLink(apiToken, link);
      const directUrl = unres?.download || unres?.link;
      if (!directUrl) throw new Error('Unrestrict failed');
      console.log('[resolve] Real-Debrid unrestrict ok, redirecting');
      return directUrl;
    }
    await new Promise(r => setTimeout(r, 1500));
  }

  throw new Error('Timed out waiting for Real-Debrid torrent links');
}

async function resolveRealDebridToDirectUrl(apiToken, payload) {
  const magnet = payload?.magnet || null;
  const downloadUrl = payload?.downloadUrl || null;

  if (magnet) {
    return resolveToDirectUrlFromMagnet(apiToken, magnet);
  }

  if (downloadUrl) {
    const resolvedDl = await prowlarr.resolveDownloadUrlToMagnetOrTorrent(downloadUrl, { wantTorrentBuf: true });
    if (resolvedDl?.magnet) {
      console.log('[resolve] Derived magnet from downloadUrl');
      return resolveToDirectUrlFromMagnet(apiToken, resolvedDl.magnet);
    }
    if (resolvedDl?.torrentBuf) {
      console.log('[resolve] Using torrent file upload for downloadUrl');
      return resolveToDirectUrlFromTorrentFile(apiToken, resolvedDl.torrentBuf);
    }
    throw new Error('Could not resolve downloadUrl into magnet or torrent file');
  }

  throw new Error('Missing magnet/downloadUrl for Real-Debrid');
}

async function resolveDebridLinkToDirectUrl(apiToken, payload) {
  const infoHash = payload?.infoHash || (payload?.magnet ? extractInfoHashFromMagnet(payload.magnet) : null);
  if (!infoHash) {
    throw new Error('Debrid-Link requires an info hash (cached torrents only)');
  }

  const result = await debridlink.resolveCachedInfoHash(apiToken, infoHash, {
    magnet: payload?.magnet || null
  });
  return result.downloadUrl;
}

async function resolveTorboxToDirectUrl(apiToken, payload) {
  const infoHash = payload?.infoHash || (payload?.magnet ? extractInfoHashFromMagnet(payload.magnet) : null);
  if (!infoHash) {
    throw new Error('TorBox requires an info hash (cached torrents only)');
  }

  const result = await torbox.resolveCachedInfoHash(apiToken, infoHash, {
    magnet: payload?.magnet || null
  });
  return result.downloadUrl;
}

function buildCacheKey(decoded) {
  const provider = decoded?.provider === 'debridlink'
    ? 'debridlink'
    : (decoded?.provider === 'torbox' ? 'torbox' : 'realdebrid');
  const token = decoded?.token;
  const infoHash = decoded?.infoHash
    || (decoded?.magnet ? extractInfoHashFromMagnet(decoded.magnet) : null);
  const downloadUrl = decoded?.downloadUrl || null;

  if (provider === 'debridlink' || provider === 'torbox') {
    return `${provider === 'torbox' ? 'tb' : 'dl'}:${tokenKey(token)}:${infoHash || 'unknown'}`;
  }
  return `rd:${tokenKey(token)}:${infoHash || (downloadUrl ? `dl:${fingerprint(downloadUrl)}` : 'unknown')}`;
}

/**
 * HTTP handler for GET /resolve/<payload>
 * Encrypted JSON:
 * - Real-Debrid: { provider?: 'realdebrid', token, magnet?, downloadUrl? }
 * - Debrid-Link (cached only): { provider: 'debridlink', token, infoHash, magnet? }
 * - TorBox (cached only): { provider: 'torbox', token, infoHash, magnet? }
 */
async function resolveHandler(req, res, payload) {
  try {
    const decoded = decryptJson(payload);
    const provider = decoded?.provider === 'debridlink'
      ? 'debridlink'
      : (decoded?.provider === 'torbox' ? 'torbox' : 'realdebrid');
    const token = decoded?.token;
    const magnet = decoded?.magnet || null;
    const downloadUrl = decoded?.downloadUrl || null;
    const infoHash = decoded?.infoHash || (magnet ? extractInfoHashFromMagnet(magnet) : null);

    if (!token) {
      res.statusCode = 400;
      res.end('Bad payload');
      return;
    }

    if (provider === 'debridlink' || provider === 'torbox') {
      if (!infoHash) {
        res.statusCode = 400;
        res.end(`${provider === 'torbox' ? 'TorBox' : 'Debrid-Link'} requires infoHash`);
        return;
      }
    } else if (!magnet && !downloadUrl) {
      res.statusCode = 400;
      res.end('Bad payload');
      return;
    }

    const key = buildCacheKey(decoded);
    const now = Date.now();
    const ttlMs = parseInt(process.env.RESOLVE_CACHE_TTL_MS || String(2 * 60 * 60 * 1000), 10);
    const cached = resolved.get(key);
    if (cached && cached.exp > now) {
      res.statusCode = 302;
      res.setHeader('Location', cached.url);
      res.end();
      return;
    }

    if (inFlight.has(key)) {
      const direct = await inFlight.get(key);
      res.statusCode = 302;
      res.setHeader('Location', direct);
      res.end();
      return;
    }

    console.log(`[resolve] resolving via ${provider} key=`, key);
    const p = (async () => {
      const directUrl = provider === 'debridlink'
        ? await resolveDebridLinkToDirectUrl(token, decoded)
        : (provider === 'torbox'
          ? await resolveTorboxToDirectUrl(token, decoded)
          : await resolveRealDebridToDirectUrl(token, decoded));
      resolved.set(key, { url: directUrl, exp: Date.now() + ttlMs });
      return directUrl;
    })();
    inFlight.set(key, p);

    let direct;
    try {
      direct = await p;
    } finally {
      inFlight.delete(key);
    }

    res.statusCode = 302;
    res.setHeader('Location', direct);
    res.end();
  } catch (err) {
    console.error('[resolve] error:', err?.message || err);
    res.statusCode = 500;
    res.end(`Resolve error: ${err?.message || err}`);
  }
}

module.exports = { resolveHandler };
