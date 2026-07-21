#!/usr/bin/env node
/**
 * Live-reload static server with model directory API.
 *
 * Usage:
 *   node server.js                        # serve ./public on port 3000
 *   node server.js --models "C:\path\to\models"
 *   node server.js --port 8080
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

// ---- Parse command-line arguments -----------------------------------------

function parseArgs(argv) {
  const opts = { root: null, port: 3000, models: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--root' || arg === '-r') {
      opts.root = argv[++i];
    } else if (arg === '--port' || arg === '-p') {
      opts.port = parseInt(argv[++i], 10);
    } else if (arg === '--models' || arg === '-m') {
      opts.models = argv[++i];
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node server.js [--root DIR] [--port PORT] [--models DIR]');
      process.exit(0);
    }
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));

if (!opts.root) {
  opts.root = fs.existsSync(path.join(process.cwd(), 'public')) ? 'public' : '.';
}
const ROOT = path.resolve(process.cwd(), opts.root);
const PORT = Number.isFinite(opts.port) ? opts.port : 3000;

// Models directory — read from CLI arg, or from models.config.json, or default
let MODELS_DIR = null;
if (opts.models) {
  MODELS_DIR = path.resolve(opts.models);
} else {
  const cfgPath = path.join(process.cwd(), 'models.config.json');
  if (fs.existsSync(cfgPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      if (cfg.modelsDir) MODELS_DIR = path.resolve(cfg.modelsDir);
    } catch (e) { /* ignore */ }
  }
}

// ---- MIME types ------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm':  'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
  '.otf':  'font/otf',
  '.mp4':  'video/mp4',
  '.webm': 'video/webm',
  '.mp3':  'audio/mpeg',
  '.wav':  'audio/wav',
  '.wasm': 'application/wasm',
  '.txt':  'text/plain; charset=utf-8',
  '.map':  'application/json; charset=utf-8',
  '.glb':  'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.fbx':  'application/octet-stream',
  '.obj':  'text/plain; charset=utf-8',
  '.mtl':  'text/plain; charset=utf-8',
  '.bin':  'application/octet-stream',
};

function mimeFor(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

// ---- Live-reload snippet ---------------------------------------------------

const LIVE_RELOAD_SNIPPET = `
<!-- injected by server.js: live reload -->
<script>
(function () {
  var source = new EventSource('/__livereload');
  source.addEventListener('reload', function () { window.location.reload(); });
  source.onerror = function () {
    source.close();
    setTimeout(function () { window.location.reload(); }, 1000);
  };
})();
</script>
`;

// ---- SSE client registry ---------------------------------------------------

const clients = new Set();

function broadcastReload() {
  for (const res of clients) {
    res.write('event: reload\ndata: {}\n\n');
  }
}

// ---- File watching ---------------------------------------------------------

let reloadTimer = null;
function scheduleReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(broadcastReload, 100);
}

function watchRecursiveFallback(dir) {
  try {
    fs.watch(dir, () => scheduleReload());
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git') {
        watchRecursiveFallback(path.join(dir, entry.name));
      }
    }
  } catch (err) { /* ignore removed dirs */ }
}

function startWatching() {
  try {
    fs.watch(ROOT, { recursive: true }, () => scheduleReload());
  } catch (err) {
    watchRecursiveFallback(ROOT);
  }
}

// ---- Models API helpers ----------------------------------------------------

const MODEL_EXTS = new Set(['.glb', '.gltf', '.fbx', '.obj']);

function scanModelsDir(dir) {
  // Returns { folders: [{name, path, models:[{name,path}]}] }
  const result = { modelsDir: dir, folders: [] };
  if (!dir || !fs.existsSync(dir)) return result;

  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (e) { return result; }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const folderPath = path.join(dir, entry.name);
    const models = [];
    let sub;
    try { sub = fs.readdirSync(folderPath, { withFileTypes: true }); }
    catch (e) { continue; }

    for (const f of sub) {
      if (f.isFile() && MODEL_EXTS.has(path.extname(f.name).toLowerCase())) {
        models.push({ name: f.name, relativePath: path.join(entry.name, f.name) });
      }
    }
    // Also check one level deeper
    for (const f of sub) {
      if (f.isDirectory()) {
        const deepPath = path.join(folderPath, f.name);
        let deep;
        try { deep = fs.readdirSync(deepPath, { withFileTypes: true }); }
        catch (e) { continue; }
        for (const d of deep) {
          if (d.isFile() && MODEL_EXTS.has(path.extname(d.name).toLowerCase())) {
            models.push({ name: d.name, relativePath: path.join(entry.name, f.name, d.name) });
          }
        }
      }
    }

    if (models.length > 0) {
      result.folders.push({ name: entry.name, models });
    }
  }
  return result;
}

// ---- Path safety check for models dir -------------------------------------

function safeModelsJoin(modelsDir, urlSubPath) {
  const decoded = decodeURIComponent(urlSubPath.split('?')[0]);
  const resolved = path.normalize(path.join(modelsDir, decoded));
  if (!resolved.startsWith(modelsDir)) return null;
  return resolved;
}

// ---- Request handling ------------------------------------------------------

function safeJoin(root, urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const resolved = path.normalize(path.join(root, decoded));
  if (!resolved.startsWith(root)) return null;
  return resolved;
}

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

function sendJSON(res, data) {
  const body = JSON.stringify(data);
  send(res, 200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, body);
}

const server = http.createServer((req, res) => {
  // CORS for local dev
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Live-reload SSE
  if (req.url === '/__livereload') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('retry: 1000\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  // API: list all models in subfolders
  if (req.url === '/api/models') {
    return sendJSON(res, scanModelsDir(MODELS_DIR));
  }

  // API: get current models dir config
  if (req.url === '/api/config') {
    return sendJSON(res, { modelsDir: MODELS_DIR || null });
  }

  // Serve model files from MODELS_DIR via /models/<relative-path>
  if (req.url.startsWith('/models/') && MODELS_DIR) {
    const sub = req.url.slice('/models/'.length);
    const filePath = safeModelsJoin(MODELS_DIR, sub);
    if (!filePath) {
      return send(res, 403, { 'Content-Type': 'text/plain' }, 'Forbidden');
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        return send(res, 404, { 'Content-Type': 'text/plain' }, `Not found: ${sub}`);
      }
      send(res, 200, {
        'Content-Type': mimeFor(filePath),
        'Cache-Control': 'no-store',
      }, data);
    });
    return;
  }

  // Static files from ROOT
  let filePath = safeJoin(ROOT, req.url);
  if (filePath === null) {
    return send(res, 403, { 'Content-Type': 'text/plain' }, 'Forbidden');
  }

  fs.stat(filePath, (err, stats) => {
    if (!err && stats.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }

    fs.readFile(filePath, (readErr, data) => {
      if (readErr) {
        return send(
          res,
          404,
          { 'Content-Type': 'text/html; charset=utf-8' },
          `<h1>404 Not Found</h1><p>${req.url}</p>`
        );
      }

      const type = mimeFor(filePath);
      if (type.startsWith('text/html')) {
        let html = data.toString('utf8');
        if (html.includes('</body>')) {
          html = html.replace('</body>', LIVE_RELOAD_SNIPPET + '</body>');
        } else {
          html += LIVE_RELOAD_SNIPPET;
        }
        return send(res, 200, { 'Content-Type': type, 'Cache-Control': 'no-store' }, html);
      }

      send(res, 200, { 'Content-Type': type, 'Cache-Control': 'no-store' }, data);
    });
  });
});

// ---- Start -----------------------------------------------------------------

server.listen(PORT, () => {
  startWatching();
  console.log('');
  console.log('  Bluey Model Viewer — Live-reload server');
  console.log('  ----------------------------------------');
  console.log(`  Serving:    ${ROOT}`);
  console.log(`  Local:      http://localhost:${PORT}`);
  if (MODELS_DIR) {
    console.log(`  Models dir: ${MODELS_DIR}`);
  } else {
    console.log('  Models dir: (not set — create models.config.json or use --models)');
  }
  console.log('');
  console.log('  Press Ctrl+C to stop.');
  console.log('');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use. Try: node server.js --port ${PORT + 1}\n`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
