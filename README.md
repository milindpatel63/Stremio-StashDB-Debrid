# Stremio StashDB Addon

⚠️ **Fully Vibe-coded project** - Built rapidly, prioritizes functionality over perfect architecture.

Stream adult content from StashDB via Real-Debrid/Debrid-Link. Browse scenes, performers, and studios with full metadata.

## Installation

### Option 1: Docker (Recommended)

```bash
cp .env.example .env
# Edit .env with your credentials
docker-compose up -d
```
Then in Stremio: Settings → Addons → Install from URL → `http://localhost:7070/manifest.json`

### Option 2: Node.js

```bash
npm install
npm start
```

## Configuration

Edit `.env` with:
- `STASHDB_API_KEY` - Get from https://stashdb.org/settings#api
- `PROWLARR_URL` - Your Prowlarr instance (e.g., `https://prowlarr.example.com`)
- `PROWLARR_API_KEY` - Your Prowlarr API key
- `PROWLARR_INDEXER_IDS` (optional) - comma-separated indexer IDs to restrict search (empty = all enabled indexers)
- `PUBLIC_URL` and `SECRET_KEY` - required to enable Real-Debrid “on click” stream resolution

Real-Debrid/Debrid-Link API token is configured in the Stremio addon settings (not in `.env`).

See `.env.example` for all configuration options.

## Features

- Browse scenes, performers, studios
- Real-Debrid/Debrid-Link stream resolution
- Prowlarr-only discovery (no Torznab)
- Smart caching & indexer rate-limit handling
- Full metadata display
- Docker-ready

## Docker Quick Start

```bash
# Setup
cp .env.example .env
nano .env  # Add credentials

# Run
docker-compose up -d
docker-compose logs -f

# Stop
docker-compose down
```

## Troubleshooting

**No streams?**
- Verify Real-Debrid/Debrid-Link token is valid (Stremio addon settings)
- Check Prowlarr is running and accessible
- Verify PROWLARR_URL and PROWLARR_API_KEY are correct in `.env`
- Check logs: `docker-compose logs` or console output
- Enable debug logs to see search queries and results

**Slow searches?**
- May need more time, Prowlarr might be rate-limited
- Check Prowlarr UI for indexer status

## Security

- API tokens stored in `.env` (never committed)
- No credentials in code
- Docker runs as non-root user


## Architecture

Uses Prowlarr API to search across all enabled torrent indexers:

1. User browses scenes/performers in Stremio
2. Addon queries StashDB for metadata
3. On stream request, runs 2 Prowlarr searches in parallel (scene title, and studio+title)
4. Returns playable “Real-Debrid/Debrid-Link on click” streams (resolution happens when you click)
5. Returns playable torrent fallbacks when Real-Debrid info is available

## License

ISC

## Disclaimer

Adult content addon. Use responsibly and per local laws.
