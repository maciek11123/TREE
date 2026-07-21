#!/usr/bin/env node
/**
 * Zero-dependency live-reload static server.
 *
 * Serves files from a directory and automatically refreshes the browser
 * whenever any file changes. Uses only Node.js built-in modules — no
 * `npm install` required.
 *
 * Usage:
 *   node server.js                 # serve ./public (or . if it doesn't exist) on port 3000
 *   node server.js --root .        # serve the current directory
 *   node server.js --port 8080     # use a different port
 *   node server.js --root site --port 5000
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

// ---- Parse command-line arguments -----------------------------------------

function parseArgs(argv) {
  const opts = { root: null, port: 3000 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--root' || arg === '-r') {
      opts.root = argv[++i];
    } else if (arg === '--port' || arg === '-p') {
      opts.port = parseInt(argv[++i], 10);
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node server.js [--root DIR] [--port PORT]');
      process.exit(0);
    }
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));

// Default root: ./public if it exists, otherwise the current directory.
if (!opts.root) {
  opts.root = fs.existsSync(path.join(process.cwd(), 'public')) ? 'public' : '.';
}
const ROOT = path.resolve(process.cwd(), opts.root);
const PORT = Number.isFinite(opts.port) ? opts.port : 3000;

// ---- MIME types ------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function mimeFor(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

// ---- Live-reload client snippet --------------------------------------------
// Injected into every HTML response. Opens a Server-Sent Events connection;
// when the server detects a file change it emits a "reload" event and the
// page refreshes itself.

const LIVE_RELOAD_SNIPPET = `
<!-- injected by server.js: live reload -->
<script>
(function () {
  var source = new EventSource('/__livereload');
  source.addEventListener('reload', function () { window.location.reload(); });
  source.onerror = function () {
    // Server restarted or connection dropped; retry until it comes back.
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
// fs.watch with recursive:true is supported on Windows and macOS. On Linux it
// isn't, so we fall back to watching directories individually.

let reloadTimer = null;
function scheduleReload() {
  // Debounce: editors often fire several events for one save.
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(broadcastReload, 100);
}

function watchRecursiveFallback(dir) {
  try {
    fs.watch(dir, (eventType, filename) => scheduleReload());
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git') {
        watchRecursiveFallback(path.join(dir, entry.name));
      }
    }
  } catch (err) {
    // Directory may have been removed; ignore.
  }
}

function startWatching() {
  try {
    fs.watch(ROOT, { recursive: true }, () => scheduleReload());
  } catch (err) {
    // recursive not supported (Linux) — walk the tree manually.
    watchRecursiveFallback(ROOT);
  }
}

// ---- Request handling ------------------------------------------------------

function safeJoin(root, urlPath) {
  // Prevent path traversal outside of ROOT.
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const resolved = path.normalize(path.join(root, decoded));
  if (!resolved.startsWith(root)) return null;
  return resolved;
}

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

const server = http.createServer((req, res) => {
  // Live-reload event stream.
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

  let filePath = safeJoin(ROOT, req.url);
  if (filePath === null) {
    return send(res, 403, { 'Content-Type': 'text/plain' }, 'Forbidden');
  }

  // Directory -> index.html
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
        // Inject the live-reload snippet before </body> (or append).
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
  console.log('  Live-reload server running');
  console.log('  ------------------------------------');
  console.log(`  Serving: ${ROOT}`);
  console.log(`  Local:   http://localhost:${PORT}`);
  console.log('');
  console.log('  Edit any file and the browser refreshes automatically.');
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
