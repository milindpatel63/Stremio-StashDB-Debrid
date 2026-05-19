require('dotenv').config();
const express = require('express');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const landingTemplate = require('stremio-addon-sdk/src/landingTemplate');
const { parseConfig } = require('./config');
const { startScraper } = require('./services/scraper');
const catalogHandler = require('./handlers/catalog');
const metaHandler = require('./handlers/meta');
const streamHandler = require('./handlers/stream');
const { resolveHandler } = require('./handlers/resolve');

// Define the addon manifest
const manifest = {
  id: 'com.stremio.stashdb',
  version: '1.0.0',
  name: 'StashDB - Debrid',
  description: 'Stream trending scenes from StashDB via Real-Debrid, Debrid-Link (cached), and/or TorBox (cached)',
  resources: ['catalog', 'meta', 'stream'],
  types: ['adult'],
  idPrefixes: ['stashdb-scene:', 'stashdb-performer:', 'stashdb-studio:'],
  catalogs: [
    {
      type: 'adult',
      id: 'stashdb-trending-scenes',
      name: 'Trending Scenes',
      extra: [
        { name: 'search', isRequired: false },
        { name: 'skip', isRequired: false }
      ]
    },
    {
      type: 'adult',
      id: 'stashdb-recently-released',
      name: 'Recently Released',
      extra: [
        { name: 'search', isRequired: false },
        { name: 'skip', isRequired: false }
      ]
    },
    {
      type: 'adult',
      id: 'stashdb-trending-performers',
      name: 'Trending Performers',
      extra: [
        { name: 'search', isRequired: false },
        { name: 'skip', isRequired: false }
      ]
    },
    {
      type: 'adult',
      id: 'stashdb-popular-studios',
      name: 'Popular Studios',
      extra: [
        { name: 'search', isRequired: false },
        { name: 'skip', isRequired: false }
      ]
    }
  ],
  behaviorHints: {
    configurable: true,
    configurationRequired: false
  },
  config: [
    {
      key: 'realDebridApiToken',
      type: 'password',
      title: 'Real-Debrid API Token',
      required: false
    },
    {
      key: 'debridLinkApiToken',
      type: 'password',
      title: 'Debrid-Link API Token',
      required: false
    },
    {
      key: 'torboxApiToken',
      type: 'password',
      title: 'TorBox API Token',
      required: false
    }
  ]
};

// Create addon builder with config parser
const builder = new addonBuilder(manifest);

/**
 * Define catalog handler
 */
builder.defineCatalogHandler((args) => {
  if (args.type === 'adult') {
    if (args.id === 'stashdb-trending-scenes') {
      return catalogHandler(args, 'SCENES', 'TRENDING');
    } else if (args.id === 'stashdb-recently-released') {
      return catalogHandler(args, 'SCENES', 'DATE');
    } else if (args.id === 'stashdb-trending-performers') {
      return catalogHandler(args, 'PERFORMERS', 'SCENE_COUNT');
    } else if (args.id === 'stashdb-popular-studios') {
      return catalogHandler(args, 'STUDIOS', 'UPDATED_AT');
    }
  }
  return Promise.resolve({ metas: [] });
});

/**
 * Define meta handler
 */
builder.defineMetaHandler((args) => {
  if (args.type === 'adult') {
    return metaHandler(args);
  }
  return Promise.resolve({ meta: null });
});

/**
 * Define stream handler
 * Config is extracted from args.config (provided by Stremio)
 */
builder.defineStreamHandler((args) => {
  console.log('[index.js defineStreamHandler] Called with type=' + args.type + ' id=' + args.id);
  if (args.type === 'adult') {
    // Parse user config (handles both object and base64 string)
    const userConfig = parseConfig(args.config);
    return streamHandler(args, userConfig);
  }
  return Promise.resolve({ streams: [] });
});

/**
 * Initialize and start the addon
 */
function startAddon() {
  try {
    // Validate environment variables for scraping
    if (!process.env.STASHDB_API_KEY) {
      console.error('❌ Missing required environment variables!');
      console.error('Required: STASHDB_API_KEY');
      console.error('Create a .env file (see .env.example)');
      process.exit(1);
    }

    console.log('✅ Environment configuration loaded');

    // Start HTTP server
    const port = process.env.PORT || 7001;
    const iface = builder.getInterface();

    const app = express();

    const landingHTML = landingTemplate(iface.manifest);
    const hasConfig = !!(iface.manifest.config || []).length;

    // Landing / config pages (serveHTTP normally does this)
    app.get('/', (req, res) => {
      if (hasConfig) {
        res.redirect('/configure');
        return;
      }
      res.setHeader('content-type', 'text/html');
      res.end(landingHTML);
    });

    if (hasConfig) {
      app.get('/configure', (req, res) => {
        res.setHeader('content-type', 'text/html');
        res.end(landingHTML);
      });
    }

    // Resolve endpoint (runs only when user clicks a stream)
    app.get('/resolve/:payload', (req, res) => {
      resolveHandler(req, res, req.params.payload);
    });

    // Search proxy - initiates scene search in Stremio
    app.get('/search/:sceneId', (req, res) => {
      const { sceneId } = req.params;
      // Redirect to meta endpoint which Stremio can handle
      res.redirect(`/meta/adult/stashdb-scene:${sceneId}.json`);
    });

    // Mount Stremio addon router (manifest + resources + CORS)
    app.use(getRouter(iface));

    const server = app.listen(port, () => {
      console.log(`\n📦 Install in Stremio:`);
      console.log(`   1. Open Stremio → Settings → Addons`);
      console.log(`   2. Paste: http://localhost:${port}/manifest.json`);
      console.log(`   3. Click "Install" (browse only) or "Configure" (for streaming)`);
      console.log(`\n   💡 Tip: Users can browse without config, but need a`);
      console.log(`      Real-Debrid, Debrid-Link, and/or TorBox token to stream videos.\n`);
      
      // Start the scraper after HTTP server is ready
      // This ensures Beamup health checks pass before the scraper blocks
      startScraper();
    });
  } catch (error) {
    console.error('Failed to start addon:', error.message);
    process.exit(1);
  }
}

// Start the addon
startAddon();

module.exports = builder;

