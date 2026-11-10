// Serves the one-page Elysium launcher over plain http (Vyre puts https in front of it).
const http = require('http'), fs = require('fs'), path = require('path');
const page = fs.readFileSync(path.join(__dirname, 'index.html'));
http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(page);
}).listen(Number(process.env.PORT || 3000), () => console.log('launcher up'));
