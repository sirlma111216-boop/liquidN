/* 「극저온의 세계」 로컬 서버
   블루투스(Web Bluetooth)는 http://localhost 또는 https 에서만 동작하므로,
   파일을 직접 여는 대신 이 작은 서버로 실행합니다.
   실행: node server.js   (보통은 시작.bat 을 더블클릭하면 됩니다) */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const PORT = 8321;
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';

  const filePath = path.join(ROOT, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(ROOT)) { res.writeHead(403).end('Forbidden'); return; }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('파일을 찾을 수 없습니다: ' + rel);
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}/`;
  console.log('');
  console.log('  ❄️  극저온의 세계 — 캠프 앱이 실행되었습니다.');
  console.log('  ➜  ' + url);
  console.log('');
  console.log('  * 이 검은 창은 수업이 끝날 때까지 닫지 마세요.');
  console.log('  * 끝내려면 이 창에서 Ctrl + C 를 누르거나 창을 닫으면 됩니다.');
  console.log('');
  // 크롬으로 열기 (없으면 기본 브라우저).  --no-open 을 붙이면 자동으로 열지 않음
  if (!process.argv.includes('--no-open')) {
    exec(`start chrome "${url}"`, (e) => { if (e) exec(`start "" "${url}"`); });
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n  포트 ${PORT}이(가) 이미 사용 중입니다. 이미 실행 중인 창이 있는지 확인하세요.`);
    console.error(`  브라우저에서 http://localhost:${PORT}/ 로 접속해 보세요.\n`);
  } else {
    console.error(e);
  }
});
