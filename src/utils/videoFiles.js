const VIDEO_EXTS = new Set(['.mkv', '.mp4', '.avi', '.mov', '.wmv', '.m4v', '.webm', '.mpg', '.mpeg']);

/**
 * Pick the largest non-sample video file from a Debrid-Link / Real-Debrid style file list.
 * Supports `name` or `path`, and `size` or `bytes`.
 */
function pickLargestVideoFile(files = []) {
  let best = null;

  for (const f of files) {
    if (!f || typeof f !== 'object') continue;

    const path = String(f.path || f.name || '').toLowerCase();
    const bytes = typeof f.bytes === 'number'
      ? f.bytes
      : (typeof f.size === 'number' ? f.size : (f.size ? parseInt(f.size, 10) : 0));

    const extMatch = path.match(/(\.[a-z0-9]{2,5})$/);
    const ext = extMatch ? extMatch[1] : '';
    const isVideo = VIDEO_EXTS.has(ext);
    const isSample = path.includes('sample');

    if (!isVideo || isSample) continue;
    if (!best || bytes > best.bytes) {
      best = { file: f, bytes };
    }
  }

  return best?.file ?? null;
}

module.exports = {
  pickLargestVideoFile
};
