import {chromium} from '../../meshy/view/node_modules/playwright-core/index.mjs';import http from 'http';import fs from 'fs';import path from 'path';
const [,,v,out,t0s,t1s]=process.argv;const port=8770+Math.floor(Math.random()*100);
const srv=http.createServer((req,res)=>{const p=path.join(process.cwd(),decodeURIComponent(req.url.split('?')[0]));fs.readFile(p,(e,b)=>{if(e){res.writeHead(404);res.end();return}const x=path.extname(p);res.writeHead(200,{'content-type':{'.js':'text/javascript','.html':'text/html','.png':'image/png','.webp':'image/webp','.ttf':'font/ttf'}[x]||'application/octet-stream'});res.end(b)})}).listen(port);
const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium',args:['--use-gl=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
const pg=await b.newPage({viewport:{width:1080,height:1920}});pg.on('console',m=>{if(!/GPU stall|Driver Message/.test(m.text()))console.log(m.text())});pg.on('pageerror',e=>console.log('ERR',e.message));
await pg.goto(`http://localhost:${port}/index.html?v=${v}`);await pg.waitForFunction('window.ready',null,{timeout:120000});
const dur=await pg.evaluate('window.dur');fs.mkdirSync(out,{recursive:true});const fps=24;const a=Math.round((+t0s||0)*fps),z=t1s?Math.round(+t1s*fps):Math.round(dur*fps);
for(let i=a;i<z;i++){await pg.evaluate(t=>window.render(t),i/fps);await pg.screenshot({path:`${out}/f${String(i).padStart(4,'0')}.png`})}
console.log('done',a,z);await b.close();srv.close();
