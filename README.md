# Moonfin

Jellyfin client for LG webOS and Samsung Tizen smart TVs, built with Enact/React.

## Repository Structure

```
moonfin/
├── packages/
│   ├── app/                  # Shared application code (React components, services, hooks)
│   ├── platform-webos/       # webOS-specific implementations (HTML5/HLS.js video, Luna storage)
│   ├── platform-tizen/       # Tizen-specific implementations (AVPlay video, Smart Hub)
│   ├── build-webos/          # webOS build tooling → produces .ipk
│   └── build-tizen/          # Tizen build tooling → produces .wgt
├── package.json              # npm workspaces root
└── .eslintrc.js              # Shared ESLint config
```

## Prerequisites

- Node.js 18+
- npm 9+
- `@enact/cli` (installed as devDependency)
- For webOS: `@webos-tools/cli` and an LG developer account
- For Tizen: Samsung Tizen Studio with `sdb` and a Samsung developer certificate

## Setup

```bash
npm install
```

## Build Commands

| Command | Output | Description |
|---|---|---|
| `npm run build:webos` | `.ipk` in `packages/build-webos/` | Production webOS package |
| `npm run build:tizen` | `.wgt` in `packages/build-tizen/` | Production Tizen package |
| `npm run dev:webos` | localhost:8080 | Development server (webOS mode) |
| `npm run dev:tizen` | localhost:8080 | Development server (Tizen mode) |

## Platform Abstraction

Shared code in `packages/app/` never imports directly from `@enact/webos`, `tizen.*`, or `webapis.*`. Platform-specific behavior is isolated through:

### Runtime Detection (`packages/app/src/platform.js`)

```js
import {isTizen, isWebOS, getPlatform} from './platform';
```

### Dynamic Platform Imports

Services like video, storage, device profile, and server logger use runtime detection to load the correct platform implementation:

```js
// packages/app/src/services/video.js
if (getPlatform() === 'tizen') {
    impl = await import('@moonfin/platform-tizen/video');
} else {
    impl = await import('@moonfin/platform-webos/video');
}
```

### Unified Key Handling (`packages/app/src/utils/keys.js`)

A single key abstraction provides `KEYS`, `isBackKey()`, `isExitKey()`, and `registerKeys()` for both platforms.

### Conditional Platform Code in Shared Files

Two files in shared code contain guarded platform references (acceptable):

- `App.js` — `tizen.application.exit()` and `import('@enact/webos/application')` behind `isTizen()`/`isWebOS()` checks
- `keys.js` — `tizen.tvinputdevice` behind `typeof tizen === 'undefined'` guard

## Adding Platform-Specific Code

1. Add the implementation in `packages/platform-{webos,tizen}/src/`
2. Export it via the platform package's `package.json` exports map
3. In shared code, use `getPlatform()` to dynamically import the correct module
4. Never add `@enact/webos`, `tizen.*`, or `webapis.*` references to `packages/app/`

## License

MPL-2.0
