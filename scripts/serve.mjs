#!/usr/bin/env node
// Local static server for the viewer and render tests. All map resources come
// from this origin; nothing is fetched from third parties.
//
//   /viewer/                 viewer/ (repo)
//   /vendor/maplibre-gl/     node_modules/maplibre-gl/dist
//   /vendor/pmtiles/         node_modules/pmtiles/dist
//   /assets/                 $FACTORY_DIR/assets (styles, glyphs, sprites)
//   /tiles/<region>.pmtiles  $FACTORY_DIR/output/<region>/<RTT_BUILD_ID|current>/<region>.pmtiles
//
// PMTiles are read by the browser with HTTP Range requests, which sirv supports.
// usage: PORT=8080 RTT_BUILD_ID=<id> scripts/serve.mjs
import http from 'node:http';
import path from 'node:path';
import sirv from 'sirv';
import { FACTORY, REPO, buildDir } from './lib/common.mjs';

const port = Number(process.env.PORT || 8080);
const host = process.env.HOST || '127.0.0.1';
const opts = { dev: true, etag: true };

const mounts = [
  ['/viewer', sirv(path.join(REPO, 'viewer'), opts)],
  ['/vendor/maplibre-gl', sirv(path.join(REPO, 'node_modules', 'maplibre-gl', 'dist'), opts)],
  ['/vendor/pmtiles', sirv(path.join(REPO, 'node_modules', 'pmtiles', 'dist'), opts)],
  ['/assets', sirv(path.join(FACTORY, 'assets'), opts)],
];
const tiles = sirv(path.join(FACTORY, 'output'), opts);

const notFound = (res) => { res.statusCode = 404; res.end('not found'); };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://local');
  if (url.pathname === '/') {
    res.writeHead(302, { location: '/viewer/' });
    return res.end();
  }
  const tile = /^\/tiles\/([a-z0-9-]+)\.pmtiles$/.exec(url.pathname);
  if (tile) {
    const region = tile[1];
    req.url = '/' + path.relative(path.join(FACTORY, 'output'), path.join(buildDir(region), `${region}.pmtiles`));
    return tiles(req, res, () => notFound(res));
  }
  for (const [prefix, handler] of mounts) {
    if (url.pathname === prefix || url.pathname.startsWith(prefix + '/')) {
      req.url = req.url.slice(prefix.length) || '/';
      return handler(req, res, () => notFound(res));
    }
  }
  notFound(res);
});

server.listen(port, host, () => {
  console.log(`serving on http://${host}:${port}/viewer/  (build: ${process.env.RTT_BUILD_ID || 'current'})`);
});
