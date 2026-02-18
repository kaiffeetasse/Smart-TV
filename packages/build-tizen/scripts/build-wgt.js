#!/usr/bin/env node
/**
 * Moonfin Tizen Build Script
 * 
 * Usage:
 *   npm run build          - Build unsigned .wgt (for development)
 *   npm run build:signed   - Build signed .wgt (for store/production)
 *   npm run install-tv     - Build and install to connected TV
 */

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const APP_DIR = path.resolve(ROOT, '..', 'app');
const DIST = path.join(ROOT, 'dist');
const TIZEN_DIR = path.join(ROOT, 'tizen');

const args = process.argv.slice(2);
const isSigned = args.includes('--signed');
const shouldInstall = args.includes('--install');
const isDev = args.includes('--dev');  // Use --dev for debug builds

// ANSI colors
const green = (text) => `\x1b[32m${text}\x1b[0m`;
const yellow = (text) => `\x1b[33m${text}\x1b[0m`;
const red = (text) => `\x1b[31m${text}\x1b[0m`;
const cyan = (text) => `\x1b[36m${text}\x1b[0m`;

function log(msg) { console.log(cyan('[build]'), msg); }
function success(msg) { console.log(green('[✓]'), msg); }
function warn(msg) { console.log(yellow('[!]'), msg); }
function error(msg) { console.log(red('[✗]'), msg); }

function run(cmd, options = {}) {
	log(`Running: ${cmd}`);
	try {
		execSync(cmd, { stdio: 'inherit', cwd: ROOT, ...options });
		return true;
	} catch (e) {
		return false;
	}
}

function findTizenCLI() {
	const possiblePaths = [
		// Windows
		'C:\\tizen-studio\\tools\\ide\\bin\\tizen.bat',
		process.env.LOCALAPPDATA + '\\tizen-studio\\tools\\ide\\bin\\tizen.bat',
		process.env.USERPROFILE + '\\tizen-studio\\tools\\ide\\bin\\tizen.bat',
		// Tizen VS Code Extension path
		process.env.USERPROFILE + '\\.tizen-extension-platform\\server\\sdktools\\data\\tools\\ide\\bin\\tizen.bat',
		// macOS/Linux
		'/usr/local/tizen-studio/tools/ide/bin/tizen',
		process.env.HOME + '/tizen-studio/tools/ide/bin/tizen',
	];
	
	for (const p of possiblePaths) {
		if (p && fs.existsSync(p)) return p;
	}
	
	// Try PATH
	try {
		execSync('tizen version', { stdio: 'pipe' });
		return 'tizen';
	} catch (e) {
		return null;
	}
}

function findSDB() {
	const possiblePaths = [
		// Windows
		'C:\\tizen-studio\\tools\\sdb.exe',
		process.env.LOCALAPPDATA + '\\tizen-studio\\tools\\sdb.exe',
		process.env.USERPROFILE + '\\tizen-studio\\tools\\sdb.exe',
		// Tizen VS Code Extension path
		process.env.USERPROFILE + '\\.tizen-extension-platform\\server\\sdktools\\data\\tools\\sdb.exe',
		// macOS/Linux
		'/usr/local/tizen-studio/tools/sdb',
		process.env.HOME + '/tizen-studio/tools/sdb',
	];
	
	for (const p of possiblePaths) {
		if (p && fs.existsSync(p)) return p;
	}
	
	// Try PATH
	try {
		execSync('sdb version', { stdio: 'pipe' });
		return 'sdb';
	} catch (e) {
		return null;
	}
}

function copyDir(src, dest) {
	if (!fs.existsSync(src)) return;
	
	const files = fs.readdirSync(src);
	for (const file of files) {
		const srcPath = path.join(src, file);
		const destPath = path.join(dest, file);
		
		if (fs.statSync(srcPath).isDirectory()) {
			if (!fs.existsSync(destPath)) fs.mkdirSync(destPath, { recursive: true });
			copyDir(srcPath, destPath);
		} else {
			fs.copyFileSync(srcPath, destPath);
		}
	}
}

function copyFiles(src, dest, pattern = null) {
	if (!fs.existsSync(src)) return;
	if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
	
	const files = fs.readdirSync(src);
	for (const file of files) {
		if (pattern && !file.match(pattern)) continue;
		const srcPath = path.join(src, file);
		const destPath = path.join(dest, file);
		if (!fs.statSync(srcPath).isDirectory()) {
			fs.copyFileSync(srcPath, destPath);
		}
	}
}

function findDir(base, target) {
	if (!fs.existsSync(base)) return null;
	const stack = [base];
	while (stack.length) {
		const dir = stack.pop();
		for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
			if (!entry.isDirectory()) continue;
			const full = path.join(dir, entry.name);
			if (entry.name === target) return full;
			stack.push(full);
		}
	}
	return null;
}

async function main() {
	console.log('\n' + cyan('═'.repeat(50)));
	console.log(cyan('  Moonfin Tizen Build'));
	console.log(cyan('═'.repeat(50)) + '\n');
	
	// Step 1: Find Tizen CLI
	const tizenCLI = findTizenCLI();
	if (!tizenCLI) {
		error('Tizen CLI not found!');
		console.log('\nPlease install Tizen Studio from:');
		console.log('https://developer.samsung.com/smarttv/develop/getting-started/setting-up-sdk/installing-tv-sdk.html');
		process.exit(1);
	}
	success(`Found Tizen CLI: ${tizenCLI}`);
	
	// Step 2: Build Enact app
	log(`Building Enact app (${isDev ? 'development' : 'production'})...`);
	const packCmd = isDev ? 'npx enact pack' : 'npx enact pack -p';
	const browserslistConfig = path.join(ROOT, '.browserslistrc');
	const enactAlias = JSON.stringify({
		'@moonfin/platform-webos': path.resolve(ROOT, '..', 'platform-webos', 'src'),
		'@moonfin/platform-tizen': path.resolve(ROOT, '..', 'platform-tizen', 'src'),
		'@moonfin/app': path.resolve(ROOT, '..', 'app')
	});
	const appPkg = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8'));
	if (!run(packCmd, { cwd: APP_DIR, env: { ...process.env, BROWSERSLIST_CONFIG: browserslistConfig, ENACT_ALIAS: enactAlias, REACT_APP_VERSION: appPkg.version } })) {
		error('Enact build failed!');
		process.exit(1);
	}
	success('Enact build complete');

	log('Copying build output...');
	if (fs.existsSync(DIST)) fs.rmSync(DIST, { recursive: true, force: true });
	fs.mkdirSync(DIST, { recursive: true });
	copyDir(path.join(APP_DIR, 'dist'), DIST);
	success('Copied build output');
	
	// Step 2.5: Patch index.html to fix ilib XHR file:// issue on Tizen
	log('Patching index.html for Tizen file:// compatibility...');
	const indexPath = path.join(DIST, 'index.html');
	if (fs.existsSync(indexPath)) {
		let html = fs.readFileSync(indexPath, 'utf8');
		
		// Add XHR patch script before the main.js script tag
		const xhrPatch = `<script>
// Patch XMLHttpRequest for Tizen file:// protocol compatibility
// ilib tries to load locale files via XHR which fails on file:// URLs
(function() {
	var OrigXHR = window.XMLHttpRequest;
	window.XMLHttpRequest = function() {
		var xhr = new OrigXHR();
		var origOpen = xhr.open;
		xhr.open = function(method, url) {
			// If it's a file:// URL trying to load ilib locale data, mock it
			if (url && (url.indexOf('file://') === 0 || url.indexOf('ilib') !== -1 || url.indexOf('locale') !== -1)) {
				this._mockIlib = true;
				this._url = url;
			}
			return origOpen.apply(this, arguments);
		};
		var origSend = xhr.send;
		xhr.send = function() {
			if (this._mockIlib) {
				var self = this;
				setTimeout(function() {
					Object.defineProperty(self, 'status', { value: 404, writable: false });
					Object.defineProperty(self, 'readyState', { value: 4, writable: false });
					Object.defineProperty(self, 'responseText', { value: '{}', writable: false });
					if (self.onreadystatechange) self.onreadystatechange();
					if (self.onload) self.onload();
				}, 0);
				return;
			}
			return origSend.apply(this, arguments);
		};
		return xhr;
	};
})();
</script>
`;
		// Insert before the main.js script tag
		html = html.replace(/<script defer="defer" src="main\.js"><\/script>/, xhrPatch + '<script defer="defer" src="main.js"></script>');
		fs.writeFileSync(indexPath, html);
		success('Patched index.html with XHR fix for ilib');
	}
	
	// Step 3: Copy Tizen config files
	log('Copying Tizen configuration...');
	copyFiles(TIZEN_DIR, DIST);
	success('Copied config.xml and icons');
	
	// Step 3.5: Copy Smart Hub Preview background service
	const serviceDir = path.join(TIZEN_DIR, 'service');
	const distServiceDir = path.join(DIST, 'service');
	if (fs.existsSync(serviceDir)) {
		log('Copying Smart Hub Preview service...');
		if (!fs.existsSync(distServiceDir)) fs.mkdirSync(distServiceDir, { recursive: true });
		copyDir(serviceDir, distServiceDir);
		success('Copied Smart Hub Preview service');
	}
	
	// Step 4: Clean up unnecessary files to reduce package size
	log('Cleaning up unnecessary files...');
	
	// Remove source maps if any
	const distFiles = fs.readdirSync(DIST);
	distFiles.forEach(file => {
		if (file.endsWith('.map')) {
			fs.unlinkSync(path.join(DIST, file));
		}
	});
	
	// Clean up iLib locale data - keep only essential files
	const ilibDir = findDir(DIST, 'ilib');
	const ilibLocalePath = ilibDir ? path.join(ilibDir, 'locale') : null;
	if (ilibLocalePath && fs.existsSync(ilibLocalePath)) {
		log(`ilib found at: ${ilibDir}`);
		const localeDirs = fs.readdirSync(ilibLocalePath);
		let removedCount = 0;
		localeDirs.forEach(item => {
			const itemPath = path.join(ilibLocalePath, item);
			if (item === 'ilibmanifest.json' || item === 'en' || item === 'und') {
				return;
			}
			if (fs.statSync(itemPath).isDirectory()) {
				fs.rmSync(itemPath, { recursive: true, force: true });
				removedCount++;
			}
		});
		success(`Removed ${removedCount} unused locale folders`);
	} else {
		warn('No ilib locale directory found — skipping locale cleanup');
	}
	
	// Step 6: Clean up old .wgt files in root
	log('Cleaning up old .wgt files...');
	const rootWgtFiles = fs.readdirSync(ROOT).filter(f => f.endsWith('.wgt'));
	rootWgtFiles.forEach(f => {
		fs.unlinkSync(path.join(ROOT, f));
		log(`Removed ${f}`);
	});
	
	// Step 7: Package WGT
	log(`Packaging ${isSigned ? 'signed' : 'unsigned'} .wgt...`);
	
	const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
	const version = pkg.version || '0.0.0';
	const wgtName = `Moonfin-v${version}.wgt`;
	
	let packageCmd;
	const signProfile = process.env.TIZEN_SIGN_PROFILE;
	if (isSigned || signProfile) {
		// Use an explicit signing profile (from --signed flag or TIZEN_SIGN_PROFILE env var)
		const profile = signProfile || 'default';
		packageCmd = `"${tizenCLI}" package -t wgt --sign "${profile}" -- "${DIST}" -o "${ROOT}"`;
	} else {
		// Package without explicit profile (uses active profile)
		packageCmd = `"${tizenCLI}" package -t wgt -- "${DIST}" -o "${ROOT}"`;
	}
	
	if (!run(packageCmd)) {
		error('Packaging failed!');
		process.exit(1);
	}
	
	// Find the generated wgt in root
	const wgtFiles = fs.readdirSync(ROOT).filter(f => f.endsWith('.wgt'));
	if (wgtFiles.length === 0) {
		error('No .wgt file generated!');
		process.exit(1);
	}
	
	const generatedWgt = path.join(ROOT, wgtFiles[0]);
	const finalWgt = path.join(ROOT, wgtName);
	
	// Rename to consistent name if needed
	if (generatedWgt !== finalWgt) {
		if (fs.existsSync(finalWgt)) fs.unlinkSync(finalWgt);
		fs.renameSync(generatedWgt, finalWgt);
	}
	
	// Show final size
	const stats = fs.statSync(finalWgt);
	const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
	success(`Package created: ${finalWgt} (${sizeMB} MB)`);
	
	// Step 8: Install to TV (if requested)
	if (shouldInstall) {
		const sdb = findSDB();
		if (!sdb) {
			error('SDB not found! Cannot install to TV.');
			process.exit(1);
		}
		
		log('Installing to TV...');
		if (!run(`"${tizenCLI}" install -n "${finalWgt}"`)) {
			error('Installation failed! Make sure your TV is connected.');
			console.log('\nTo connect your TV:');
			console.log('1. Enable Developer Mode on your TV');
			console.log('2. Run: sdb connect <TV_IP_ADDRESS>');
			process.exit(1);
		}
		success('Installed to TV!');
		
		log('Launching app...');
		run(`"${tizenCLI}" run -p MoonfinApp.moonfin`);
	}
	
	console.log('\n' + green('═'.repeat(50)));
	console.log(green(`  Build Complete! (v${version})`));
	console.log(green('═'.repeat(50)));
	console.log(`\n  Output: ${cyan(finalWgt)}`);
	
	if (!shouldInstall) {
		console.log('\n  To install to your TV:');
		console.log(`  ${yellow('npm run install-tv')}`);
		console.log('\n  Or manually:');
		console.log(`  ${yellow(`tizen install -n "${wgtName}"`)}`);
	}
	
	console.log('');
}

main().catch(e => {
	error(e.message);
	process.exit(1);
});
