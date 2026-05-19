const cache = require('../cache');
const stashdb = require('../services/stashdb');
const prowlarr = require('../services/prowlarr');
const torrentCandidates = require('../services/torrentCandidates');
const { buildDiscoveryQueries } = require('../services/scraper');
const debridlink = require('../services/debridlink');
const torbox = require('../services/torbox');
const { encryptJson } = require('../services/crypto');
const { extractInfoHashFromMagnet } = require('../utils/magnet');

/**
 * Stream handler - returns stream objects resolved via Real-Debrid
 * IMPORTANT: Token and unrestricted links are never cached
 */

function pickBestVideoFile(files = []) {
  const videoExts = new Set(['.mkv', '.mp4', '.avi', '.mov', '.wmv', '.m4v', '.webm', '.mpg', '.mpeg']);
  const candidates = files
    .filter(f => f && typeof f === 'object')
    .map(f => {
      const path = (f.path || '').toLowerCase();
      const bytes = typeof f.bytes === 'number' ? f.bytes : (f.bytes ? parseInt(f.bytes, 10) : 0);
      const extMatch = path.match(/(\.[a-z0-9]{2,5})$/);
      const ext = extMatch ? extMatch[1] : '';
      const isVideo = videoExts.has(ext);
      const isSample = path.includes('sample');
      return { ...f, _bytes: bytes, _isVideo: isVideo, _isSample: isSample };
    })
    .filter(f => f._isVideo && !f._isSample);

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => (b._bytes || 0) - (a._bytes || 0));
  return candidates[0];
}

function tokenize(str) {
  if (!str) return [];
  return String(str)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(t => t.length >= 3);
}

function scoreCandidate(candidate, scene) {
  const name = candidate?.name || '';
  const tokens = new Set(tokenize(name));
  const titleTokens = tokenize(scene?.title || '');
  const studioTokens = tokenize(scene?.studio?.name || '');

  let hitsTitle = 0;
  for (const t of titleTokens) if (tokens.has(t)) hitsTitle++;

  let hitsStudio = 0;
  for (const t of studioTokens) if (tokens.has(t)) hitsStudio++;

  // Hard reject candidates that don't match at least the title (prevents unrelated 2160p wins)
  if (titleTokens.length > 0 && hitsTitle === 0) {
    return -1e9;
  }

  const quality = torrentCandidates.parseQuality(candidate?.quality);
  const size = candidate?.sizeBytes && !isNaN(candidate.sizeBytes) ? Number(candidate.sizeBytes) : 0;
  const hasMagnet = candidate?.magnet ? 1 : 0;
  const hasHash = candidate?.infoHash ? 1 : 0;
  const hasDownload = candidate?.downloadUrl ? 1 : 0;

  return (
    hitsTitle * 1000 +
    hitsStudio * 200 +
    (hasMagnet + hasHash) * 50 +
    hasDownload * 15 +
    quality * 0.5 +
    Math.min(size / (1024 * 1024 * 1024), 20)
  );
}

function buildMagnetFromInfoHash(infoHash, name) {
  if (!infoHash) return null;
  const hash = String(infoHash).toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(hash)) return null;
  const dn = name ? `&dn=${encodeURIComponent(String(name).slice(0, 200))}` : '';
  return `magnet:?xt=urn:btih:${hash}${dn}`;
}

async function ensureCandidates(sceneId, scene) {
  const ttlMs = parseInt(process.env.CANDIDATE_CACHE_TTL_MS || String(6 * 60 * 60 * 1000), 10);
  const now = Date.now();
  const updatedAt = scene.debridCandidatesUpdatedAt || 0;

  if (scene.debridCandidates && scene.debridCandidates.length > 0 && (now - updatedAt) < ttlMs) {
    return scene.debridCandidates;
  }

  if ((now - updatedAt) < ttlMs) {
    // Cached empty result is still fresh; don't re-query
    return scene.debridCandidates || [];
  }

  const queries = buildDiscoveryQueries(scene);
  if (!queries || queries.length === 0) {
    console.log(`[stream] No queries generated for scene ${sceneId}`);
    cache.set(sceneId, { ...scene, debridCandidates: [], debridCandidatesUpdatedAt: now });
    return [];
  }

  console.log(`[stream] Generated ${queries.length} discovery queries for scene ${sceneId}`);

  const perQueryLimit = parseInt(process.env.PROWLARR_LIMIT || '25', 10);
  // We intentionally keep discovery to 2 queries (scene title, and studio+title).
  const maxVariants = parseInt(process.env.DISCOVERY_QUERY_VARIANTS || '2', 10);
  const queryDelayMs = parseInt(process.env.DISCOVERY_QUERY_DELAY_MS || '750', 10);
  const stopAfter = parseInt(process.env.DISCOVERY_STOP_AFTER_CANDIDATES || '30', 10);
  const debug = process.env.STREAM_DEBUG === '1';

  // Prefilter to avoid expensive dedupe/sort/scoring over irrelevant releases.
  // This is intentionally conservative: keep candidates that match at least one scene-token.
  const titleTokensSet = new Set(tokenize(scene?.title || ''));
  const prefilterCap = parseInt(process.env.DISCOVERY_PREFILTER_CAP || String(stopAfter * 3), 10);

  const sceneInfo = {
    sceneDate: scene.date || scene.release_date || scene.production_date
  };

  const queriesToRun = queries.slice(0, Math.max(1, maxVariants));

  // Run Prowlarr searches in parallel (2 queries by default).
  const resultsByQuery = await Promise.all(
    queriesToRun.map(async (q) => {
      if (debug) console.log(`[stream] Querying: "${q}"`);
      const results = await prowlarr.search(q, { limit: perQueryLimit });
      if (!Array.isArray(results) || results.length === 0) return [];

      // Prefilter quickly by scene-title token match.
      const filtered = titleTokensSet.size === 0
        ? results
        : results.filter(r => {
          const nameTokens = new Set(tokenize(r?.name || ''));
          for (const t of titleTokensSet) {
            if (nameTokens.has(t)) return true;
          }
          return false;
        });

      // Cap per query to keep dedupe/sort cheap.
      const capped = filtered
        .sort((a, b) => {
          const qa = torrentCandidates.parseQuality(a?.quality);
          const qb = torrentCandidates.parseQuality(b?.quality);
          if (qb !== qa) return qb - qa;
          const sa = a?.sizeBytes && !isNaN(a.sizeBytes) ? Number(a.sizeBytes) : 0;
          const sb = b?.sizeBytes && !isNaN(b.sizeBytes) ? Number(b.sizeBytes) : 0;
          return sb - sa;
        })
        .slice(0, prefilterCap);

      if (debug) console.log(`[stream] Query "${q}" -> kept ${capped.length}/${results.length}`);
      return capped;
    })
  );

  // Optional: small delay can help when the user environment rate-limits Prowlarr.
  // We keep it non-blocking for speed, but allow tuning via env.
  if (queryDelayMs > 0 && process.env.STREAM_QUERY_DELAY_AFTER_PARALLEL === '1') {
    await new Promise(r => setTimeout(r, queryDelayMs));
  }

  const all = resultsByQuery.flat();
  const merged = torrentCandidates.mergeAndSort(all, sceneInfo);
  const maxCandidatesToReturn = parseInt(
    process.env.DEBRID_CANDIDATES_RETURN_LIMIT || String(stopAfter),
    10
  );
  const finalCandidates = merged.slice(0, maxCandidatesToReturn);

  cache.set(sceneId, { ...scene, debridCandidates: finalCandidates, debridCandidatesUpdatedAt: now });
  return finalCandidates;
}

async function streamHandler(args, userConfig) {
  const { id } = args;
  console.log(`[stream] request id=${id} mode=debrid_lazy`);
  
  // Handle scenes
  if (id.startsWith('stashdb-scene:')) {
    const sceneId = id.replace('stashdb-scene:', '');
    return handleSceneStream(sceneId, userConfig);
  }
  
  // Handle performers - show their scenes
  if (id.startsWith('stashdb-performer:')) {
    console.log('[stream] Routing to performer handler');
    const performerId = id.replace('stashdb-performer:', '');
    return handlePerformerStreams(performerId, userConfig);
  }
  
  // Handle studios - show their scenes
  if (id.startsWith('stashdb-studio:')) {
    console.log('[stream] Routing to studio handler');
    const studioId = id.replace('stashdb-studio:', '');
    return handleStudioStreams(studioId, userConfig);
  }

  console.log('[stream] No handler matched, returning empty');
  return Promise.resolve({ streams: [] });
}

async function handleSceneStream(sceneId, userConfig) {
  let scene = cache.get(`scene:${sceneId}`);
  
  if (!scene) {
    return Promise.resolve({ streams: [] });
  }

  const publicUrl = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
  const hasServerCrypto = !!publicUrl && !!process.env.SECRET_KEY;
  const hasRdConfig = !!(userConfig && userConfig.realDebridApiToken);
  const hasDlConfig = !!(userConfig && userConfig.debridLinkApiToken);
  const hasTbConfig = !!(userConfig && userConfig.torboxApiToken);
  console.log(`[stream] rdConfig=${hasRdConfig} dlConfig=${hasDlConfig} tbConfig=${hasTbConfig} serverCrypto=${hasServerCrypto} publicUrl=${publicUrl ? 'set' : 'missing'} secretKey=${process.env.SECRET_KEY ? 'set' : 'missing'}`);

  // Check if candidates are already cached (skip expensive discovery if available)
  let candidates = (scene.debridCandidates || []);
  
  // Only discover candidates if we don't have any cached
  if (candidates.length === 0) {
    try {
      candidates = await ensureCandidates(`scene:${sceneId}`, scene);
      // Always refresh local copy after discovery (ensures debridCandidates are present)
      scene = cache.get(`scene:${sceneId}`) || scene;
      candidates = scene.debridCandidates || candidates;
    } catch (err) {
      console.error('Candidate discovery error:', err?.message || err);
      return { streams: [] };
    }
  }
  
  if (!candidates || candidates.length === 0) {
    console.log(`[stream] No candidates found for scene ${sceneId}`);
    return { streams: [] };
  }

  const streams = [];
  let rdStreams = 0;
  let dlStreams = 0;
  let tbStreams = 0;
  let torrentStreams = 0;

  if (!hasRdConfig && !hasDlConfig && !hasTbConfig) {
    streams.push({
      name: 'Debrid (setup)',
      title: 'Configure this addon with a Real-Debrid, Debrid-Link, and/or TorBox API token to enable on-click streams.',
      externalUrl: 'https://debrid-link.com/token_app'
    });
  } else if (!hasServerCrypto && (hasRdConfig || hasDlConfig || hasTbConfig)) {
    streams.push({
      name: 'Debrid (server setup)',
      title: 'Server is missing PUBLIC_URL and/or SECRET_KEY, so on-click streams are disabled.',
      externalUrl: 'https://debrid-link.com/token_app'
    });
  } else if (hasRdConfig && !hasDlConfig) {
    streams.push({
      name: 'Debrid-Link (optional)',
      title: 'Add a Debrid-Link API token in addon settings for cached-only streams (no uncached downloads).',
      externalUrl: 'https://debrid-link.com/token_app'
    });
  }

  const maxCandidates = parseInt(process.env.STREAM_CANDIDATES_LIMIT || '10', 10);
  const minScore = parseInt(process.env.CANDIDATE_MIN_SCORE || '400', 10);
  const debug = process.env.STREAM_DEBUG === '1';

  console.log(`[stream] Scoring candidates (minScore=${minScore})...`);
  const ranked = [...(scene.debridCandidates || [])]
    .map(c => {
      const s = scoreCandidate(c, scene);
      if (debug) console.log(`[stream]   Score ${s.toFixed(1)}: "${c.name}"`);
      return { c, s };
    })
    .sort((a, b) => b.s - a.s)
    .filter(x => {
      const keep = x.s >= minScore;
      if (!keep && debug) console.log(`[stream]   FILTERED OUT (score ${x.s.toFixed(1)} < ${minScore}): "${x.c.name}"`);
      return keep;
    })
    .slice(0, maxCandidates)
    .map(x => x.c);

  console.log(`[stream] After filtering: ${ranked.length} candidates meet threshold`);

  console.log(`[stream] candidates=${scene.debridCandidates?.length || 0} ranked=${ranked.length}`);

  let dlCachedHashes = new Set();
  let dlResolveTimeCacheCheck = false;
  let tbCachedHashes = new Set();
  if (hasTbConfig && hasServerCrypto) {
    const hashesForTb = ranked
      .map(c => c.infoHash || extractInfoHashFromMagnet(c.magnet))
      .filter(Boolean);
    if (hashesForTb.length > 0) {
      try {
        tbCachedHashes = await torbox.checkCachedHashes(userConfig.torboxApiToken, hashesForTb);
        console.log(`[stream] TorBox cached ${tbCachedHashes.size}/${hashesForTb.length} ranked hashes`);
      } catch (err) {
        console.error('[stream] TorBox cache check failed:', err?.message || err);
      }
    }
  }

  if (hasDlConfig && hasServerCrypto) {
    const hashesForDl = ranked
      .map(c => c.infoHash || extractInfoHashFromMagnet(c.magnet))
      .filter(Boolean);
    if (hashesForDl.length > 0) {
      try {
        const cacheResult = await debridlink.checkCachedHashes(
          userConfig.debridLinkApiToken,
          hashesForDl
        );
        dlCachedHashes = cacheResult.cached;
        dlResolveTimeCacheCheck = cacheResult.resolveTimeOnly;
        if (dlResolveTimeCacheCheck) {
          console.log('[stream] Debrid-Link /seedbox/cached unavailable; offering on-click streams (cache verified at play)');
        } else {
          console.log(`[stream] Debrid-Link cached ${dlCachedHashes.size}/${hashesForDl.length} ranked hashes`);
        }
      } catch (err) {
        console.error('[stream] Debrid-Link cache check failed:', err?.message || err);
      }
    }
  }

  for (const cand of ranked) {
    const infoHash = cand.infoHash || extractInfoHashFromMagnet(cand.magnet);

    const titleParts = [];
    const q = cand.quality ? String(cand.quality) : null;
    titleParts.push(q ? `📺 ${q}` : '📺 Unknown Quality');

    if (cand.sizeBytes && !isNaN(cand.sizeBytes)) {
      const gb = (Number(cand.sizeBytes) / 1073741824);
      titleParts.push(`⚙️ ${gb >= 1 ? `${gb.toFixed(2)} GB` : `${(Number(cand.sizeBytes) / 1048576).toFixed(1)} MB`}`);
    }

    if (cand.name) {
      let name = String(cand.name);
      if (name.length > 60) name = name.substring(0, 57) + '...';
      titleParts.push(`📁 ${name}`);
    }

    titleParts.push(`🔎 ${cand.source || 'Torznab'}`);

    // Try to create a magnet for RD; if we can't, we'll fall back to using downloadUrl.
    const magnet = cand.magnet || (cand.infoHash ? buildMagnetFromInfoHash(cand.infoHash, cand.name) : null);

    let debridStreamAdded = false;

    const hashKey = infoHash ? String(infoHash).toLowerCase() : '';
    const showDlStream = hasDlConfig && hasServerCrypto && infoHash
      && (dlResolveTimeCacheCheck || dlCachedHashes.has(hashKey));
    const showTbStream = hasTbConfig && hasServerCrypto && infoHash
      && tbCachedHashes.has(hashKey);

    if (showDlStream) {
      try {
        const payload = encryptJson({
          provider: 'debridlink',
          token: userConfig.debridLinkApiToken,
          infoHash,
          ...(magnet ? { magnet } : {})
        });
        streams.push({
          name: dlResolveTimeCacheCheck
            ? 'Torrent (Debrid-Link on click)'
            : 'Torrent (Debrid-Link cached)',
          title: titleParts.join('\n'),
          url: `${publicUrl}/resolve/${payload}`
        });
        dlStreams++;
        debridStreamAdded = true;
      } catch (e) {
        // fall through
      }
    }

    if (showTbStream && !debridStreamAdded) {
      try {
        const payload = encryptJson({
          provider: 'torbox',
          token: userConfig.torboxApiToken,
          infoHash,
          ...(magnet ? { magnet } : {})
        });
        streams.push({
          name: 'Torrent (TorBox cached)',
          title: titleParts.join('\n'),
          url: `${publicUrl}/resolve/${payload}`
        });
        tbStreams++;
        debridStreamAdded = true;
      } catch (e) {
        // fall through
      }
    }

    if (hasRdConfig && hasServerCrypto && !debridStreamAdded) {
      try {
        if (magnet) {
          const payload = encryptJson({
            provider: 'realdebrid',
            token: userConfig.realDebridApiToken,
            magnet
          });
          streams.push({
            name: 'Torrent (Real-Debrid on click)',
            title: titleParts.join('\n'),
            url: `${publicUrl}/resolve/${payload}`
          });
          rdStreams++;
          debridStreamAdded = true;
        } else if (cand.downloadUrl) {
          const payload = encryptJson({
            provider: 'realdebrid',
            token: userConfig.realDebridApiToken,
            downloadUrl: cand.downloadUrl
          });
          streams.push({
            name: 'Torrent (Real-Debrid on click)',
            title: titleParts.join('\n'),
            url: `${publicUrl}/resolve/${payload}`
          });
          rdStreams++;
          debridStreamAdded = true;
        }
      } catch (e) {
        // fall through to torrent fallback (if possible)
      }
    }

    if (infoHash && !debridStreamAdded) {
      streams.push({
        name: 'Torrent',
        title: titleParts.join('\n'),
        infoHash
      });
      torrentStreams++;
    } else if (!infoHash && !debridStreamAdded) {
      // Candidate is not directly playable (no infoHash) and RD can't resolve it (no magnet/downloadUrl).
      // We already filtered most of these out earlier, but keep this as a safety net.
    }
  }

  console.log(`[stream] returningStreams=${streams.length} rdStreams=${rdStreams} dlStreams=${dlStreams} tbStreams=${tbStreams} torrentStreams=${torrentStreams}`);
  return { streams };
}

async function handlePerformerStreams(performerId, userConfig) {
  console.log('[handlePerformerStreams] Fetching scenes for performer:', performerId);
  const apiKey = process.env.STASHDB_API_KEY;
  
  if (!apiKey) {
    return Promise.resolve({ streams: [] });
  }

  try {
    // Fetch top scenes for this performer
    const result = await stashdb.queryPerformerScenes(apiKey, performerId, { page: 1, perPage: 25 });
    const scenes = result.scenes || [];
    
    if (scenes.length === 0) {
      return Promise.resolve({ streams: [] });
    }

    // Return scene list - clicking navigates to scene details in Stremio
    const streams = scenes.map(scene => {
      const studioName = scene.studio?.name || 'Unknown Studio';
      const sceneTitle = scene.title || 'Unknown Title';
      const sceneDate = scene.date || 'Unknown Date';
      
      return {
        name: `Released: ${sceneDate}`,
        title: `${studioName} - ${sceneTitle}`,
        externalUrl: `stremio:///detail/adult/stashdb-scene:${scene.id}`
      };
    });

    console.log(`[handlePerformerStreams] Returning ${streams.length} scene options for performer`);
    return Promise.resolve({ streams });
  } catch (error) {
    console.error('[handlePerformerStreams] Error:', error.message);
    return Promise.resolve({ streams: [] });
  }
}

async function handleStudioStreams(studioId, userConfig) {
  console.log('[handleStudioStreams] Fetching scenes for studio:', studioId);
  const apiKey = process.env.STASHDB_API_KEY;
  
  if (!apiKey) {
    return Promise.resolve({ streams: [] });
  }

  try {
    // Fetch top scenes from this studio
    const result = await stashdb.queryStudioScenes(apiKey, studioId, { page: 1, perPage: 25 });
    const scenes = result.scenes || [];
    
    if (scenes.length === 0) {
      return Promise.resolve({ streams: [] });
    }

    // Return scene list - clicking navigates to scene details in Stremio
    const streams = scenes.map(scene => {
      const studioName = scene.studio?.name || 'Unknown Studio';
      const sceneTitle = scene.title || 'Unknown Title';
      const sceneDate = scene.date || 'Unknown Date';
      
      return {
        name: `Released: ${sceneDate}`,
        title: `${studioName} - ${sceneTitle}`,
        externalUrl: `stremio:///detail/adult/stashdb-scene:${scene.id}`
      };
    });

    console.log(`[handleStudioStreams] Returning ${streams.length} scene options for studio`);
    return Promise.resolve({ streams });
  } catch (error) {
    console.error('[handleStudioStreams] Error:', error.message);
    return Promise.resolve({ streams: [] });
  }
}

module.exports = streamHandler;

