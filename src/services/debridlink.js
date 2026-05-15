const axios = require('axios');
const { pickLargestVideoFile } = require('../utils/videoFiles');

const DL_BASE_URL = (process.env.DEBRIDLINK_URL || 'https://debrid-link.com/api/v2').replace(/\/+$/, '');
const HTTP_TIMEOUT_MS = parseInt(process.env.DEBRIDLINK_TIMEOUT_MS || '30000', 10);
const CACHED_POLL_MS = parseInt(process.env.DEBRIDLINK_CACHED_POLL_MS || '1500', 10);
const CACHED_MAX_WAIT_MS = parseInt(process.env.DEBRIDLINK_CACHED_MAX_WAIT_MS || '20000', 10);

/** null = unknown, true = /seedbox/cached works, false = endpointDisabled (use add-time check) */
let cachedApiAvailable = null;

function createClient(apiToken) {
  return axios.create({
    baseURL: DL_BASE_URL,
    headers: {
      Authorization: `Bearer ${apiToken}`
    },
    timeout: HTTP_TIMEOUT_MS
  });
}

function apiErrorMessage(err) {
  const data = err?.response?.data;
  if (data?.error) return String(data.error);
  if (typeof data === 'string') return data;
  return err?.message || 'Unknown error';
}

function normalizeError(err, context = 'Debrid-Link API') {
  const status = err?.response?.status;
  const message = apiErrorMessage(err);
  return new Error(`${context} error${status ? ` (${status})` : ''}: ${message}`);
}

function isEndpointDisabledError(err) {
  const msg = String(apiErrorMessage(err) || err?.message || '').toLowerCase();
  return msg.includes('endpointdisabled') || msg.includes('endpoint_disabled');
}

function isCachedApiUnavailable() {
  return cachedApiAvailable === false;
}

function isNotCachedAddError(errorCode) {
  const code = String(errorCode || '').toLowerCase();
  return code === 'notaddtorrent'
    || code === 'torrenttoobig'
    || code === 'maxtorrent'
    || code === 'maxtransfer';
}

function normalizeInfoHash(hash) {
  const h = String(hash || '').trim().toLowerCase();
  return /^[a-f0-9]{40}$/.test(h) ? h : null;
}

function unwrapValue(data) {
  if (!data || typeof data !== 'object') return null;
  if (data.success === false) {
    throw new Error(data.error || 'Debrid-Link request failed');
  }
  return data.value !== undefined ? data.value : data;
}

/**
 * Parse GET /seedbox/cached responses (format varies across doc versions).
 * Returns a Set of lowercase info-hashes that are cached on Debrid-Link servers.
 */
function parseCachedHashes(value, requestedHashes, opts = {}) {
  const assumeAllListed = !!opts.assumeAllListed;
  const cached = new Set();

  if (value == null) return cached;

  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string') {
        const h = normalizeInfoHash(item);
        if (h) cached.add(h);
        continue;
      }
      if (!item || typeof item !== 'object') continue;

      const hash = normalizeInfoHash(
        item.hashString || item.hash || item.infoHash || item.info_hash || item.id
      );
      if (!hash) continue;

      const isCached = assumeAllListed
        || item.cached === true
        || item.isCached === true
        || item.available === true
        || item.status === 'cached'
        || item.status === 1
        || item.downloadPercent === 100;

      if (isCached) {
        cached.add(hash);
      }
    }
    return cached;
  }

  if (typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      const keyHash = normalizeInfoHash(key);
      if (entry === true || entry === 1 || entry === 'true') {
        if (keyHash) cached.add(keyHash);
        continue;
      }
      if (entry === false || entry === 0 || entry === 'false') {
        continue;
      }
      if (!entry || typeof entry !== 'object') {
        continue;
      }

      const hash = normalizeInfoHash(
        entry.hashString || entry.hash || entry.infoHash || entry.info_hash || key
      );
      if (!hash) continue;

      const isCached = assumeAllListed
        || entry.cached === true
        || entry.isCached === true
        || entry.available === true
        || entry.downloadPercent === 100;

      if (isCached) {
        cached.add(hash);
      }
    }
  }

  return cached;
}

/**
 * Check which info-hashes are cached on Debrid-Link (global cache).
 * Returns { cached: Set, resolveTimeOnly: boolean }.
 * When /seedbox/cached is disabled (endpointDisabled), resolveTimeOnly is true and
 * cache is verified at play time via hash-only seedbox/add (still cache-only).
 */
async function checkCachedHashes(apiToken, hashes) {
  const cleaned = [...new Set(
    (Array.isArray(hashes) ? hashes : [hashes])
      .map(normalizeInfoHash)
      .filter(Boolean)
  )];

  if (cleaned.length === 0) {
    return { cached: new Set(), resolveTimeOnly: isCachedApiUnavailable() };
  }

  if (cachedApiAvailable === false) {
    return { cached: new Set(), resolveTimeOnly: true };
  }

  try {
    const client = createClient(apiToken);
    const res = await client.get('/seedbox/cached', {
      params: { url: cleaned.join(',') }
    });
    const data = res.data;
    if (data?.success === false && isEndpointDisabledError({ response: { data } })) {
      cachedApiAvailable = false;
      console.warn('[debridlink] /seedbox/cached disabled; cache verified when you play a stream');
      return { cached: new Set(), resolveTimeOnly: true };
    }
    cachedApiAvailable = true;
    return {
      cached: parseCachedHashes(unwrapValue(data), cleaned, { assumeAllListed: true }),
      resolveTimeOnly: false
    };
  } catch (err) {
    if (isEndpointDisabledError(err)) {
      cachedApiAvailable = false;
      console.warn('[debridlink] /seedbox/cached disabled; cache verified when you play a stream');
      return { cached: new Set(), resolveTimeOnly: true };
    }
    throw normalizeError(err);
  }
}

async function isHashCached(apiToken, infoHash) {
  const hash = normalizeInfoHash(infoHash);
  if (!hash) return false;
  const { cached } = await checkCachedHashes(apiToken, [hash]);
  return cached.has(hash);
}

async function getTorrentById(apiToken, torrentId) {
  const client = createClient(apiToken);
  const res = await client.get('/seedbox/list', {
    params: { ids: String(torrentId), perPage: 20, page: 0 }
  });
  const value = unwrapValue(res.data);
  const torrents = Array.isArray(value) ? value : (value ? [value] : []);
  return torrents.find(t => String(t?.id) === String(torrentId)) || torrents[0] || null;
}

async function removeTorrent(apiToken, torrentId) {
  if (!torrentId) return;
  try {
    const client = createClient(apiToken);
    await client.delete(`/seedbox/${encodeURIComponent(torrentId)}/remove`);
  } catch (err) {
    console.warn('[debridlink] remove torrent failed:', err?.message || err);
  }
}

function torrentLooksUncached(torrent) {
  if (!torrent || typeof torrent !== 'object') return true;
  const pct = Number(torrent.downloadPercent);
  if (pct >= 100) return false;

  const peers = Number(torrent.peersConnected) || 0;
  const downSpeed = Number(torrent.downloadSpeed) || 0;
  const upSpeed = Number(torrent.uploadSpeed) || 0;

  return peers > 0 || downSpeed > 0 || upSpeed > 0;
}

async function waitForCachedTorrentReady(apiToken, torrentId) {
  const deadline = Date.now() + CACHED_MAX_WAIT_MS;

  while (Date.now() < deadline) {
    const torrent = await getTorrentById(apiToken, torrentId);
    if (!torrent) {
      throw new Error('Debrid-Link torrent not found after add');
    }

    if (torrentLooksUncached(torrent)) {
      await removeTorrent(apiToken, torrentId);
      throw new Error('Torrent is not cached on Debrid-Link (refusing to download)');
    }

    if (Number(torrent.downloadPercent) >= 100) {
      return torrent;
    }

    await new Promise(r => setTimeout(r, CACHED_POLL_MS));
  }

  await removeTorrent(apiToken, torrentId);
  throw new Error('Timed out waiting for cached torrent on Debrid-Link');
}

/**
 * Add a hash/magnet that was verified cached via /seedbox/cached.
 * Never call this without a prior isHashCached/checkCachedHashes check.
 */
async function addCachedTorrent(apiToken, { infoHash, magnet }) {
  const hash = normalizeInfoHash(infoHash);
  // Prefer bare info-hash: magnets can trigger peer metadata fetch; hashes are cache-only per API docs.
  const url = hash || magnet;
  if (!url) {
    throw new Error('Missing infoHash or magnet for Debrid-Link');
  }

  const client = createClient(apiToken);
  const body = new URLSearchParams({ url: String(url) });

  let res;
  try {
    res = await client.post('/seedbox/add', body.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
  } catch (err) {
    if (isNotCachedAddError(apiErrorMessage(err))) {
      throw new Error('Torrent is not cached on Debrid-Link');
    }
    throw normalizeError(err);
  }

  const data = res.data;
  if (data?.success === false) {
    const code = data.error || '';
    if (isNotCachedAddError(code) || isEndpointDisabledError({ response: { data } })) {
      throw new Error('Torrent is not cached on Debrid-Link');
    }
    throw new Error(code || 'Debrid-Link refused to add torrent');
  }

  const value = unwrapValue(data);
  const torrentId = value?.id || data?.id;
  if (!torrentId) {
    throw new Error('Debrid-Link add did not return a torrent id');
  }

  const torrent = await waitForCachedTorrentReady(apiToken, torrentId);
  const videoFile = pickLargestVideoFile(torrent.files || []);
  const downloadUrl = videoFile?.downloadUrl;

  if (!downloadUrl) {
    await removeTorrent(apiToken, torrentId);
    throw new Error('No playable file URL from cached Debrid-Link torrent');
  }

  return {
    downloadUrl,
    torrentId,
    torrent,
    file: videoFile
  };
}

/**
 * Resolve a cached info-hash to a direct download URL.
 * Enforces cache-only: checks /seedbox/cached before any add.
 */
async function resolveCachedInfoHash(apiToken, infoHash, opts = {}) {
  const hash = normalizeInfoHash(infoHash);
  if (!hash) {
    throw new Error('Invalid info hash');
  }

  if (cachedApiAvailable !== false) {
    try {
      const cached = await isHashCached(apiToken, hash);
      if (!cached) {
        throw new Error('Torrent is not cached on Debrid-Link');
      }
    } catch (err) {
      if (isEndpointDisabledError(err)) {
        cachedApiAvailable = false;
        console.warn('[debridlink] /seedbox/cached disabled; verifying cache via seedbox/add');
      } else {
        throw err;
      }
    }
  }

  return addCachedTorrent(apiToken, {
    infoHash: hash,
    magnet: opts.magnet || null
  });
}

async function getUser(apiToken) {
  try {
    const client = createClient(apiToken);
    const res = await client.get('/account/infos');
    return unwrapValue(res.data);
  } catch (err) {
    throw normalizeError(err);
  }
}

module.exports = {
  checkCachedHashes,
  isHashCached,
  isCachedApiUnavailable,
  isEndpointDisabledError,
  resolveCachedInfoHash,
  addCachedTorrent,
  removeTorrent,
  getUser
};
