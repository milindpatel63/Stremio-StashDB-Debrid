const axios = require('axios');
const { pickLargestVideoFile } = require('../utils/videoFiles');

const TB_BASE_URL = (process.env.TORBOX_URL || 'https://api.torbox.app/v1/api').replace(/\/+$/, '');
const HTTP_TIMEOUT_MS = parseInt(process.env.TORBOX_TIMEOUT_MS || '30000', 10);
const CACHED_POLL_MS = parseInt(process.env.TORBOX_CACHED_POLL_MS || '1500', 10);
const CACHED_MAX_WAIT_MS = parseInt(process.env.TORBOX_CACHED_MAX_WAIT_MS || '20000', 10);

function createClient(apiToken) {
  return axios.create({
    baseURL: TB_BASE_URL,
    headers: {
      Authorization: `Bearer ${apiToken}`
    },
    timeout: HTTP_TIMEOUT_MS
  });
}

function apiErrorMessage(err) {
  const data = err?.response?.data;
  if (data?.detail) return String(data.detail);
  if (data?.error) return String(data.error);
  if (typeof data === 'string') return data;
  return err?.message || 'Unknown error';
}

function normalizeError(err, context = 'TorBox API') {
  const status = err?.response?.status;
  const message = apiErrorMessage(err);
  return new Error(`${context} error${status ? ` (${status})` : ''}: ${message}`);
}

function normalizeInfoHash(hash) {
  const h = String(hash || '').trim().toLowerCase();
  return /^[a-f0-9]{40}$/.test(h) ? h : null;
}

function unwrapData(data) {
  if (!data || typeof data !== 'object') return null;
  if (data.success === false) {
    const code = data.error ? String(data.error) : '';
    const detail = data.detail ? String(data.detail) : '';
    const msg = detail || code || 'TorBox request failed';
    const err = new Error(msg);
    err.torboxError = code;
    throw err;
  }
  return data.data !== undefined ? data.data : data;
}

function isNotCachedError(err) {
  const code = String(err?.torboxError || err?.response?.data?.error || '').toUpperCase();
  const msg = String(err?.message || apiErrorMessage(err) || '').toLowerCase();
  return code === 'ITEM_NOT_FOUND'
    || msg.includes('not cached')
    || msg.includes('only adds the download if it is cached')
    || msg.includes('add_only_if_cached');
}

/**
 * Parse GET /torrents/checkcached `data` (object keyed by hash, or list).
 */
function parseCachedHashes(data, requestedHashes) {
  const cached = new Set();
  const wanted = new Set(
    (Array.isArray(requestedHashes) ? requestedHashes : [requestedHashes])
      .map(normalizeInfoHash)
      .filter(Boolean)
  );

  if (data == null) return cached;

  if (Array.isArray(data)) {
    for (const entry of data) {
      const h = normalizeInfoHash(entry?.hash);
      if (h && (wanted.size === 0 || wanted.has(h))) cached.add(h);
    }
    return cached;
  }

  if (typeof data === 'object') {
    for (const [key, entry] of Object.entries(data)) {
      const h = normalizeInfoHash(
        (entry && typeof entry === 'object' ? entry.hash : null) || key
      );
      if (h && (wanted.size === 0 || wanted.has(h))) cached.add(h);
    }
  }

  return cached;
}

/**
 * Check which info-hashes are cached on TorBox (global cache).
 */
async function checkCachedHashes(apiToken, hashes) {
  const cleaned = [...new Set(
    (Array.isArray(hashes) ? hashes : [hashes])
      .map(normalizeInfoHash)
      .filter(Boolean)
  )];

  if (cleaned.length === 0) {
    return new Set();
  }

  try {
    const client = createClient(apiToken);
    const res = await client.get('/torrents/checkcached', {
      params: {
        hash: cleaned,
        format: 'list'
      },
      paramsSerializer: {
        indexes: null
      }
    });
    return parseCachedHashes(unwrapData(res.data), cleaned);
  } catch (err) {
    throw normalizeError(err);
  }
}

async function isHashCached(apiToken, infoHash) {
  const hash = normalizeInfoHash(infoHash);
  if (!hash) return false;
  const cached = await checkCachedHashes(apiToken, [hash]);
  return cached.has(hash);
}

async function getTorrentById(apiToken, torrentId) {
  const client = createClient(apiToken);
  const res = await client.get('/torrents/mylist', {
    params: {
      id: torrentId,
      bypass_cache: true
    }
  });
  const data = unwrapData(res.data);
  if (Array.isArray(data)) return data[0] || null;
  if (data && typeof data === 'object' && data.id != null) return data;
  return null;
}

async function findTorrentByHash(apiToken, infoHash) {
  const hash = normalizeInfoHash(infoHash);
  if (!hash) return null;

  const client = createClient(apiToken);
  const res = await client.get('/torrents/mylist', {
    params: {
      bypass_cache: true,
      limit: 1000
    }
  });
  const list = unwrapData(res.data);
  if (!Array.isArray(list)) return null;
  return list.find(t => normalizeInfoHash(t?.hash) === hash) || null;
}

async function removeTorrent(apiToken, torrentId) {
  if (torrentId == null) return;
  try {
    const client = createClient(apiToken);
    await client.post('/torrents/controltorrent', {
      torrent_id: torrentId,
      operation: 'delete'
    });
  } catch (err) {
    console.warn('[torbox] remove torrent failed:', err?.message || err);
  }
}

function torrentIsReady(torrent) {
  if (!torrent || typeof torrent !== 'object') return false;
  if (torrent.cached === true) return true;
  const state = String(torrent.download_state || '').toLowerCase();
  if (state === 'cached') return true;
  if (torrent.download_finished && torrent.download_present) return true;
  return false;
}

function torrentLooksUncached(torrent) {
  if (!torrent || typeof torrent !== 'object') return true;
  if (torrentIsReady(torrent)) return false;

  const state = String(torrent.download_state || '').toLowerCase();
  const peers = Number(torrent.peers) || 0;
  const downloadSpeed = Number(torrent.download_speed) || 0;
  const progress = Number(torrent.progress) || 0;

  if (torrent.cached === true) return false;

  if (state.includes('download') || state.includes('metadl') || state === 'queued') {
    if (peers > 0 || downloadSpeed > 0) return true;
    if (progress > 0 && progress < 100 && torrent.cached !== true) return true;
  }

  return false;
}

async function waitForCachedTorrentReady(apiToken, torrentId) {
  const deadline = Date.now() + CACHED_MAX_WAIT_MS;

  while (Date.now() < deadline) {
    const torrent = await getTorrentById(apiToken, torrentId);
    if (!torrent) {
      throw new Error('TorBox torrent not found after add');
    }

    if (torrentLooksUncached(torrent)) {
      await removeTorrent(apiToken, torrentId);
      throw new Error('Torrent is not cached on TorBox (refusing to download)');
    }

    if (torrentIsReady(torrent) && Array.isArray(torrent.files) && torrent.files.length > 0) {
      return torrent;
    }

    await new Promise(r => setTimeout(r, CACHED_POLL_MS));
  }

  await removeTorrent(apiToken, torrentId);
  throw new Error('Timed out waiting for cached torrent on TorBox');
}

async function requestDownloadLink(apiToken, torrentId, fileId) {
  const res = await axios.get(`${TB_BASE_URL}/torrents/requestdl`, {
    params: {
      token: apiToken,
      torrent_id: torrentId,
      file_id: fileId,
      redirect: false
    },
    timeout: HTTP_TIMEOUT_MS
  });

  const url = unwrapData(res.data);
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    throw new Error('TorBox did not return a playable download URL');
  }
  return url;
}

/**
 * Add a magnet only when TorBox global cache already has it.
 * Uses add_only_if_cached and verifies the torrent never enters an uncached download.
 */
async function addCachedTorrent(apiToken, { infoHash, magnet }) {
  const hash = normalizeInfoHash(infoHash);
  if (!hash) {
    throw new Error('Invalid info hash for TorBox');
  }

  const cached = await isHashCached(apiToken, hash);
  if (!cached) {
    throw new Error('Torrent is not cached on TorBox');
  }

  const existing = await findTorrentByHash(apiToken, hash);
  if (existing?.id != null) {
    if (torrentLooksUncached(existing)) {
      await removeTorrent(apiToken, existing.id);
      throw new Error('Torrent is not cached on TorBox (refusing to download)');
    }
    const readyTorrent = torrentIsReady(existing)
      ? existing
      : await waitForCachedTorrentReady(apiToken, existing.id);
    const videoFile = pickLargestVideoFile(readyTorrent.files || []);
    if (videoFile?.id != null) {
      const downloadUrl = await requestDownloadLink(apiToken, readyTorrent.id, videoFile.id);
      return {
        downloadUrl,
        torrentId: readyTorrent.id,
        torrent: readyTorrent,
        file: videoFile
      };
    }
  }

  const magnetLink = magnet || `magnet:?xt=urn:btih:${hash}`;
  const body = new URLSearchParams({
    magnet: magnetLink,
    add_only_if_cached: 'true'
  });

  const client = createClient(apiToken);
  let created;
  try {
    const res = await client.post('/torrents/createtorrent', body.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    created = unwrapData(res.data);
  } catch (err) {
    if (isNotCachedError(err)) {
      throw new Error('Torrent is not cached on TorBox');
    }
    throw normalizeError(err);
  }

  const torrentId = created?.torrent_id ?? created?.id;
  if (torrentId == null) {
    throw new Error('TorBox add did not return a torrent id');
  }

  const torrent = await waitForCachedTorrentReady(apiToken, torrentId);
  const videoFile = pickLargestVideoFile(torrent.files || []);
  if (videoFile?.id == null) {
    await removeTorrent(apiToken, torrentId);
    throw new Error('No playable file found in cached TorBox torrent');
  }

  const downloadUrl = await requestDownloadLink(apiToken, torrentId, videoFile.id);
  return {
    downloadUrl,
    torrentId,
    torrent,
    file: videoFile
  };
}

/**
 * Resolve a cached info-hash to a direct download URL (cache-only).
 */
async function resolveCachedInfoHash(apiToken, infoHash, opts = {}) {
  const hash = normalizeInfoHash(infoHash);
  if (!hash) {
    throw new Error('Invalid info hash');
  }

  const result = await addCachedTorrent(apiToken, {
    infoHash: hash,
    magnet: opts.magnet || null
  });
  return result;
}

module.exports = {
  checkCachedHashes,
  isHashCached,
  resolveCachedInfoHash,
  addCachedTorrent,
  removeTorrent
};
