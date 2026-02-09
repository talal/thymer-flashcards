# Contributing

## Prerequisites

- Node.js 20+
- Chrome with `--remote-debugging-port=9222` for hot reload

## Setup

```bash
# Install dependencies
npm install

# Production build
npm run build

# Development with hot reload
npm run dev
```

## Project Structure

```
thymer-flashcards/
├── plugin.js          # Main plugin code
├── plugin.json        # Plugin configuration
├── styles.css         # Practice UI styles
├── dev.js             # Build & hot-reload script
├── types.d.ts         # Thymer Plugin SDK type definitions
└── dist/
    └── plugin.js      # Bundled output (includes ts-fsrs)
```

## Installing in Thymer

1. Build the plugin: `npm run build`
2. In Thymer, open Command Palette → **Plugins** → **Create Plugin**
3. Paste the contents of `dist/plugin.js` into **Custom Code**
4. Paste the contents of `plugin.json` into **Configuration**
5. Save

## Creating a Release

Releases are automated via GitHub Actions. Push a version tag to trigger a build:

```bash
git tag 26.02
git push origin 26.02
```

Tags follow a `YY.MM` format (e.g. `26.02` for February 2026), with an optional patch suffix (`26.02.1`) if multiple releases happen in the same month.

This will create a GitHub Release with the built `plugin.js` and `plugin.json` attached.