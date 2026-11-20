#!/usr/bin/env node
/* Zero-dependency static server so you can preview www/ in a desktop browser
 * (uses the HTMLAudio fallback + <input type=file> picker).  npm run preview → http://localhost:8080 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('www');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(root, p);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(8080, () => console.log('Onda preview → http://localhost:8080'));
