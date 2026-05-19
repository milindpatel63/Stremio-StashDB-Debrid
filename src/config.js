/**
 * Parse user configuration
 * Config can come as:
 * 1. Object (from Stremio's built-in config form - already parsed)
 * 2. URL-encoded JSON string (from Stremio's config form in URL)
 * 3. Base64-encoded JSON string (from manual install URL)
 */

function parseConfig(config) {
  if (!config) {
    return null;
  }

  try {
    let parsedConfig;

    if (typeof config === 'object' && !Buffer.isBuffer(config)) {
      parsedConfig = config;
    } else if (typeof config === 'string') {
      try {
        const urlDecoded = decodeURIComponent(config);
        parsedConfig = JSON.parse(urlDecoded);
      } catch (e) {
        try {
          const base64Decoded = Buffer.from(config, 'base64').toString('utf-8');
          parsedConfig = JSON.parse(base64Decoded);
        } catch (e2) {
          return null;
        }
      }
    } else {
      return null;
    }

    const realDebridApiToken = parsedConfig.realDebridApiToken
      ? String(parsedConfig.realDebridApiToken).trim()
      : '';
    const debridLinkApiToken = parsedConfig.debridLinkApiToken
      ? String(parsedConfig.debridLinkApiToken).trim()
      : '';
    const torboxApiToken = parsedConfig.torboxApiToken
      ? String(parsedConfig.torboxApiToken).trim()
      : '';

    if (!realDebridApiToken && !debridLinkApiToken && !torboxApiToken) {
      return null;
    }

    return {
      realDebridApiToken: realDebridApiToken || null,
      debridLinkApiToken: debridLinkApiToken || null,
      torboxApiToken: torboxApiToken || null
    };
  } catch (error) {
    return null;
  }
}

module.exports = { parseConfig };
