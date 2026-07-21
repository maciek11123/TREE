# Terrain Trees — Live-Reload Dev Server

A tiny, **zero-dependency** local server for previewing HTML with **automatic
browser refresh** on every save. Uses only Node.js built-in modules — no
`npm install`, no config.

## Requirements

- [Node.js](https://nodejs.org) (any recent version — v14+)

Check it's installed:

```
node --version
```

## Run it

From the project folder:

```
node server.js
```

Then open **http://localhost:3000** in your browser.

Now edit any file under `public/` and save — the browser reloads by itself.

## Where do my files go?

Put your HTML, CSS, JS, images, etc. in the **`public/`** folder.
`public/index.html` is the page served at `/`.

If you'd rather serve files from the project root (or any other folder):

```
node server.js --root .
```

## Options

| Flag              | What it does                          | Default            |
| ----------------- | ------------------------------------- | ------------------ |
| `--root DIR`      | Folder to serve files from            | `public` (or `.`)  |
| `--port PORT`     | Port to listen on                     | `3000`             |

Examples:

```
node server.js --port 8080
node server.js --root site --port 5000
```

## How the live reload works

Every HTML page served gets a tiny `<script>` injected that opens a
[Server-Sent Events](https://developer.mozilla.org/docs/Web/API/Server-sent_events)
connection to the server. When the server sees a file change (via
`fs.watch`), it tells the page to reload. No browser extensions needed.
