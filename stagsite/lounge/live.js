// Hood Rich Club lounge: the live layer. Wallet sign-in, your avatar, other holders, chat, the free bar and voice.
// Loaded by index.html in normal (non-capture) mode. Nothing here moves money: sign-in is a plain message signature.
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
const L = window.__lounge;
const { THREE, scene, camera, M, STAGE_Y } = L;
const Q = new URLSearchParams(location.search);
const API = (Q.get('api') || 'https://buybot.stagwifhood.fun').replace(/\/$/, '');
const WS_URL = API.replace(/^http/, 'ws') + '/ws/lounge';
const TIER_COL = { 'Fawn': 0x6fd08c, 'Buck': 0xd9a441, 'Stag': 0xf2f2f2, 'Royal Stag': 0xffd34d, 'Founder': 0xff5fb8 };
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------- UI ---------- */
const css = document.createElement('style');
css.textContent = `
#gate{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:radial-gradient(ellipse at center,rgba(20,6,18,.55),rgba(5,2,8,.92));z-index:20;padding:16px}
#gate .card{max-width:380px;width:100%;text-align:center;color:#f3e7c9;border:1px solid rgba(233,201,122,.35);border-radius:18px;padding:26px 22px;background:rgba(14,6,14,.82);box-shadow:0 0 60px rgba(255,45,154,.18)}
#gate h1{font:700 22px Georgia,serif;letter-spacing:.22em;margin:0 0 6px;color:#e9c97a}
#gate p{font-size:14px;line-height:1.5;color:#cdb98f;margin:8px 0}
#gate input{width:100%;box-sizing:border-box;margin-top:10px;padding:12px;border-radius:10px;border:1px solid #5a4630;background:#120a12;color:#f3e7c9;font-size:15px}
.btn{display:block;width:100%;box-sizing:border-box;margin-top:12px;padding:14px;border:0;border-radius:12px;font-size:16px;font-weight:700;letter-spacing:.06em;cursor:pointer;text-decoration:none;color:#1a0b00;background:linear-gradient(180deg,#ffe29a,#d9a441)}
.btn.alt{background:transparent;color:#e9c97a;border:1px solid rgba(233,201,122,.4)}
#msg{min-height:18px;font-size:13px;color:#ff8fb8;margin-top:8px}
#top{position:fixed;left:14px;top:12px;color:#e9c97a;font-size:12px;letter-spacing:.16em;text-transform:uppercase;z-index:10;text-shadow:0 0 10px #000;display:none}
#chat{position:fixed;left:12px;bottom:58px;width:min(420px,calc(100vw - 24px));z-index:10;display:none;font-size:14px}
#log{max-height:150px;overflow:hidden;display:flex;flex-direction:column;justify-content:flex-end;gap:3px;margin-bottom:6px;pointer-events:none}
#log div{color:#fff;text-shadow:0 1px 4px #000,0 0 8px #000;background:rgba(10,4,12,.45);padding:3px 8px;border-radius:8px;width:fit-content;max-width:100%;word-break:break-word}
#log .t{color:#e9c97a;font-weight:700}#log .sys{color:#ffb6d9;font-style:italic}
#row{display:flex;gap:6px}#row input{flex:1;min-width:0;padding:10px 12px;border-radius:10px;border:1px solid #5a4630;background:rgba(14,6,14,.85);color:#fff;font-size:15px}
#row button,#bar button,#dock button{padding:10px 12px;border-radius:10px;border:1px solid rgba(233,201,122,.45);background:rgba(14,6,14,.85);color:#e9c97a;font-size:15px;cursor:pointer}
#dock{position:fixed;right:12px;bottom:12px;display:none;gap:6px;z-index:10}
#bar{position:fixed;right:12px;bottom:62px;display:none;flex-direction:column;gap:6px;z-index:10}
#joy{position:fixed;left:18px;bottom:120px;width:110px;height:110px;border-radius:50%;border:1px solid rgba(233,201,122,.35);background:rgba(14,6,14,.35);z-index:9;display:none;touch-action:none}
#joy i{position:absolute;left:35px;top:35px;width:40px;height:40px;border-radius:50%;background:rgba(233,201,122,.55)}
body.touch #joy{display:block}
#studio{position:fixed;right:12px;top:12px;width:min(300px,calc(100vw - 24px));z-index:12;display:none;color:#f3e7c9;border:1px solid rgba(233,201,122,.4);border-radius:14px;padding:14px;background:rgba(14,6,14,.9);font-size:14px}
#studio h3{margin:0 0 8px;font:700 15px Georgia,serif;letter-spacing:.2em;color:#e9c97a}
#studio select,#studio input[type=file]{width:100%;box-sizing:border-box;margin:4px 0 8px;padding:8px;border-radius:8px;border:1px solid #5a4630;background:#120a12;color:#f3e7c9}
#studio .r{display:flex;gap:6px;margin:6px 0}#studio .r button,#studio a.dl{flex:1;padding:10px;border-radius:10px;border:1px solid rgba(233,201,122,.45);background:rgba(30,12,28,.9);color:#e9c97a;font-size:14px;cursor:pointer;text-align:center;text-decoration:none}
#studio .rec{background:#7a1020!important;color:#fff!important;border-color:#ff5a6a!important}
#studio small{display:block;opacity:.75;line-height:1.4;margin-top:6px}
#sc{font:700 40px Georgia,serif;text-align:center;color:#ff6a7a;height:44px}
#talkp,#djp{position:fixed;left:50%;transform:translateX(-50%);bottom:130px;width:min(380px,calc(100vw - 24px));z-index:13;display:none;color:#f3e7c9;border:1px solid rgba(233,201,122,.45);border-radius:14px;padding:14px;background:rgba(14,6,14,.93);font-size:14px}
#talkp h3,#djp h3{margin:0 0 6px;font:700 15px Georgia,serif;letter-spacing:.2em;color:#e9c97a}
#tpSub{min-height:38px;line-height:1.4;margin-bottom:8px;color:#fff}
#tpBtns{display:flex;gap:6px;flex-wrap:wrap}#tpBtns button,.dj-t{padding:9px 12px;border-radius:10px;border:1px solid rgba(233,201,122,.45);background:rgba(30,12,28,.9);color:#e9c97a;font-size:14px;cursor:pointer}
#djNow{margin:2px 0 8px;color:#fff}.dj-t{display:flex;justify-content:space-between;width:100%;box-sizing:border-box;margin:4px 0;text-align:left}.dj-t.on{background:#4a2a08;color:#fff}.dj-t b{color:#ffb6d9}
@media (max-width:640px){#chat{bottom:176px}#talkp,#djp{bottom:150px}}
`;
document.head.appendChild(css);
const ui = document.createElement('div');
ui.innerHTML = `
<div id="gate"><div class="card">
  <h1>HOOD RICH CLUB</h1>
  <p id="gp">Holders only. Sign in with your wallet. It is a plain message signature: no gas, no transaction, no approvals.</p>
  <input id="nm" maxlength="16" placeholder="Name in the club (optional)">
  <button class="btn" id="go">Sign in with wallet</button>
  <a class="btn alt" id="mm" style="display:none" href="#">Open in MetaMask</a>
  <button class="btn alt" id="look">Just look around</button>
  <div id="msg"></div>
  <p style="font-size:12px;opacity:.8">Members only: 10,000,000 $STAG, or a Hooded 20, Sherwood Saints or WANTED NFT.</p>
</div></div>
<div id="top"></div>
<div id="chat"><div id="log"></div><div id="row"><input id="ci" maxlength="160" placeholder="Say something..." autocomplete="off"><button id="send">Send</button></div></div>
<div id="bar"></div>
<div id="studio"><h3>STUDIO</h3>
  <div id="sc"></div>
  <label>Beat</label><select id="beat"><option value="trap">Trap · 140 bpm (demo)</option><option value="boombap">Boom bap · 90 bpm (demo)</option><option value="latenight">Late night · 100 bpm (demo)</option><option value="file">My own file…</option></select>
  <input type="file" id="beatfile" accept="audio/*" style="display:none">
  <div class="r"><button id="srec">● Record</button><button id="splay" disabled>▶ Play</button></div>
  <div class="r"><a class="dl" id="sdl" style="display:none" download>⬇ Download take</a></div>
  <small>Use headphones, or the beat will bleed into your mic. Nothing is uploaded or saved: your take lives on this device until you download it.</small></div>
<div id="talkp"><h3 id="tpName"></h3><div id="tpSub"></div><div id="tpBtns"></div></div>
<div id="djp"><h3>DJ BOOTH</h3><div id="djNow"></div><div id="djList"></div><small style="opacity:.75">Tap a track to vote. The most votes plays next.</small></div>
<div id="dock"><button id="talkBtn" style="display:none">💬 Talk</button><button id="djBtn">🎧 DJ</button><button id="studioBtn" style="display:none">🎙 Studio</button><button id="drink">🍸 Bar</button><button id="mic">🎤 Voice</button></div>
<div id="joy"><i></i></div>`;
document.body.appendChild(ui);
if ('ontouchstart' in window) document.body.classList.add('touch');
const setMsg = (t) => { $('#msg').textContent = t || ''; };
$('#look').onclick = () => { $('#gate').remove(); document.getElementById('hud').textContent = 'Hood Rich Club · visitor view · reload to sign in'; };
if (!window.ethereum) { const a = $('#mm'); a.style.display = 'block'; a.href = 'https://metamask.app.link/dapp/' + location.host + location.pathname; }

/* ---------- sign in ---------- */
let TOKEN = null, SELF = { name: '', tier: '' };
try { const t = JSON.parse(sessionStorage.getItem('lounge')); if (t && t.exp > Date.now()) { TOKEN = t.token; SELF.tier = t.tier; $('#nm').value = t.name || ''; } } catch {}
async function signIn() {
  setMsg('');
  if (!window.ethereum) { setMsg('No wallet found. Open this page inside your wallet app\'s browser.'); return; }
  try {
    const { nonce } = await (await fetch(API + '/api/lounge/nonce')).json();
    const [a] = await window.ethereum.request({ method: 'eth_requestAccounts' });
    const msg = `Enter the Hood Rich Club lounge.\nNonce: ${nonce}\nWallet: ${a}\nThis signs a message only. It costs no gas and gives no access to funds.`;
    const sig = await window.ethereum.request({ method: 'personal_sign', params: [msg, a] });
    const r = await (await fetch(API + '/api/lounge/login', { method: 'POST', body: JSON.stringify({ nonce, address: a, signature: sig }) })).json();
    if (!r.ok) { setMsg(r.error || 'Could not sign in.'); return; }
    TOKEN = r.token; SELF.tier = r.tier;
    sessionStorage.setItem('lounge', JSON.stringify({ token: r.token, tier: r.tier, exp: Date.now() + 11 * 3600e3, name: $('#nm').value }));
    enter();
  } catch (e) { setMsg((e && e.message) || 'Sign-in cancelled.'); }
}
$('#go').onclick = () => { if (TOKEN) enter(); else signIn(); };
if (TOKEN) { $('#go').textContent = 'Enter the club'; }

/* ---------- avatars ---------- */
function nameTag(text, col) {
  const c = document.createElement('canvas'); c.width = 512; c.height = 96; const g = c.getContext('2d');
  g.font = '700 40px system-ui,sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillStyle = 'rgba(10,4,12,.6)'; const w = Math.min(500, g.measureText(text).width + 40); g.beginPath(); g.roundRect((512 - w) / 2, 14, w, 68, 20); g.fill();
  g.fillStyle = '#' + col.toString(16).padStart(6, '0'); g.fillText(text, 256, 49);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthTest: false, toneMapped: false }));
  s.scale.set(1.5, .28, 1); s.renderOrder = 10; return s;
}
const bodyGeo = new THREE.CapsuleGeometry(.24, .62, 6, 14), headGeo = new THREE.SphereGeometry(.2, 18, 14), snoutGeo = new THREE.ConeGeometry(.08, .2, 12), legGeo = new THREE.CylinderGeometry(.06, .05, .5, 8), earGeo = new THREE.ConeGeometry(.07, .22, 8);
const antlerMat = new THREE.MeshStandardMaterial({ color: 0xe8d9b0, roughness: .6 });
function antlers() {
  const g = new THREE.Group(); const V = (x, y, z = 0) => new THREE.Vector3(x, y, z);
  for (const sx of [-1, 1]) for (const pts of [[V(0, 0), V(.1, .18), V(.2, .38), V(.24, .55)], [V(.1, .18), V(.26, .24), V(.34, .36)], [V(.2, .38), V(.06, .46), V(.02, .6)]]) {
    const m = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts.map((p) => V(p.x * sx, p.y, p.z))), 10, .018, 6), antlerMat); g.add(m);
  } return g;
}
// The holder avatar: a rigged hooded stag (Meshy model), cloned per player. Falls back to a simple figure if the model fails to load.
const gl = new GLTFLoader(); const loadGLB = (u) => new Promise((res, rej) => gl.load(u, res, undefined, rej));
let AV = null;
const AVP = (async () => {
  try {
    const g = await loadGLB('./assets/avatar/avatar.glb'); g.scene.updateMatrixWorld(true);
    const bb = new THREE.Box3().setFromObject(g.scene, true); const sc = 1.8 / (bb.max.y - bb.min.y);
    g.scene.traverse((o) => { if (o.isMesh || o.isSkinnedMesh) { o.frustumCulled = false; o.castShadow = true; o.receiveShadow = true; if (o.material) o.material.envMapIntensity = 1; } });
    const clips = {};
    for (const n of ['idle', 'walk', 'wave', 'drink']) {
      try { const a = await loadGLB('./assets/avatar/' + n + '.glb'); const c = a.animations[0]; if (!c) continue;
        for (const tr of c.tracks) if (tr.name.endsWith('.position') && tr.name.indexOf('Hips') >= 0) { const v = tr.values; const x0 = v[0], z0 = v[2]; for (let i = 0; i < v.length; i += 3) { v[i] -= x0; v[i + 2] -= z0; } }
        clips[n] = c; } catch (e) { console.warn('avatar clip', n, e); }
    }
    AV = { scene: g.scene, clips, sc, bb };
  } catch (e) { console.warn('avatar model failed, using simple figure', e); }
})();
function makeAvatar(info) {
  const key = info.founder && !TIER_COL[info.tier] ? 'Founder' : info.tier; const col = TIER_COL[key] || 0xffffff;
  const g = new THREE.Group();
  g.userData = { legs: [], walkPh: 0, tx: info.x || 0, tz: info.z || 0, try: info.ry || 0, moving: false, mixer: null };
  const glass = new THREE.Mesh(new THREE.CylinderGeometry(.04, .03, .12, 10), new THREE.MeshStandardMaterial({ color: 0xffd9a0, emissive: 0xffa040, emissiveIntensity: 1.2, transparent: true, opacity: .9 }));
  glass.position.set(.28, 1.05, .22); glass.visible = false; g.add(glass); g.userData.glass = glass;
  if (AV) {
    const inst = SkeletonUtils.clone(AV.scene); inst.scale.multiplyScalar(AV.sc); inst.position.y = -AV.bb.min.y * AV.sc; g.add(inst);
    let hand = null; inst.traverse((o) => { if (!hand && o.isBone && /right.?hand$/i.test(o.name)) hand = o; }); g.userData.hand = hand;
    const mixer = new THREE.AnimationMixer(inst); const acts = {};
    for (const [n, c] of Object.entries(AV.clips)) { const a = mixer.clipAction(c); a.setLoop(THREE.LoopRepeat, Infinity); acts[n] = a; }
    if (acts.walk) acts.walk.timeScale = 1.5;
    (acts.idle || acts.walk).play(); mixer.update(Math.random() * 3);
    Object.assign(g.userData, { mixer, acts, cur: acts.idle || acts.walk, curName: 'idle' });
  } else {
    const cloak = new THREE.MeshStandardMaterial({ color: 0x14101a, roughness: .55, metalness: .25 }), fur = new THREE.MeshStandardMaterial({ color: 0xb5753a, roughness: .7 });
    const body = new THREE.Mesh(bodyGeo, cloak); body.position.y = .88; g.add(body);
    const head = new THREE.Mesh(headGeo, fur); head.position.set(0, 1.47, 0); g.add(head); const a = antlers(); a.position.set(0, 1.62, 0); a.scale.setScalar(.8); g.add(a);
  }
  // a glowing ring at the feet shows the tier from across the room
  const ring = new THREE.Mesh(new THREE.TorusGeometry(.5, .018, 8, 40), new THREE.MeshBasicMaterial({ color: col, toneMapped: false })); ring.rotation.x = Math.PI / 2; ring.position.y = .02; g.add(ring);
  const tag = nameTag((info.name || '?') + (info.tier ? '  ·  ' + info.tier : ''), col); tag.position.y = 2.2; g.add(tag); g.userData.tag = tag;
  g.position.set(info.x || 0, 0, info.z || 12); g.rotation.y = info.ry || Math.PI;
  scene.add(g); return g;
}
function playAnim(v, name) { // crossfade between idle and walk
  if (!v.mixer || v.curName === name || !v.acts[name]) return; const next = v.acts[name]; next.reset().play(); if (v.cur) v.cur.crossFadeTo(next, .25, false); v.cur = next; v.curName = name;
}
const DRINK_COL = { champagne: 0xfff0b0, whiskey: 0xd98a2b, mojito: 0x8bff9a, gold: 0xffd34d };
const others = new Map(); // id -> avatar
let me = null, ws = null, myId = null;
const pos = { x: 0, z: 12, ry: Math.PI, yaw: 0, anim: 'idle' };
const keys = {};
if (Q.has('debug')) L.setCam = (a) => { L.camOverride = a; };
if (Q.has('debug')) L.teleport = (x, z) => { pos.x = x; pos.z = z; }; // test hook only, never on in normal use

/* ---------- network ---------- */
const logEl = () => $('#log');
function say(cls, who, text, col) {
  const d = document.createElement('div'); if (cls) d.className = cls;
  d.innerHTML = who ? `<span class="t" style="color:#${(col || 0xe9c97a).toString(16).padStart(6, '0')}">${esc(who)}</span> ${esc(text)}` : esc(text);
  logEl().appendChild(d); while (logEl().children.length > 8) logEl().firstChild.remove();
  setTimeout(() => { d.style.transition = 'opacity 2s'; d.style.opacity = 0; setTimeout(() => d.remove(), 2100); }, 14000);
}
function updateTop() { $('#top').textContent = `Hood Rich Club · ${SELF.tier || ''} · Lounge ${SELF.room || 1} · ${others.size + 1} in the room`; }
async function connect() {
  await AVP; loadNpcs(); ws = new WebSocket(WS_URL);
  ws.onopen = () => ws.send(JSON.stringify({ t: 'join', token: TOKEN, name: SELF.req || '', room: Q.get('room') || 0 }));
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.t === 'welcome') {
      if (m.dj) djSync(m.dj); myId = m.id; SELF.name = m.you.name; SELF.room = m.room; if (L.syncDance) L.syncDance((m.now - m.epoch) / 1000);
      me = makeAvatar({ ...m.you, x: pos.x, z: pos.z, ry: pos.ry }); me.userData.mine = true;
      for (const p of m.players) others.set(p.id, makeAvatar(p));
      updateTop(); say('sys', '', 'Welcome to the Hood Rich Club.');
    } else if (m.t === 'join') { others.set(m.p.id, makeAvatar(m.p)); say('sys', '', `${m.p.name} walked in`); updateTop(); }
    else if (m.t === 'leave') { recorders.delete(m.id); L.studio.setOnAir(recorders.size > 0); const a = others.get(m.id); if (a) { scene.remove(a); others.delete(m.id); updateTop(); } }
    else if (m.t === 'state') {
      if (m.full) { const ids = new Set(m.s.map((r) => r[0])); for (const [id, a] of others) if (!ids.has(id)) { scene.remove(a); others.delete(id); } updateTop(); }
      for (const [id, x, z, ry, an, dr] of m.s) {
        if (id === myId) continue; const a = others.get(id); if (!a) continue;
        const u = a.userData; u.moving = an === 'walk' || Math.hypot(x - u.tx, z - u.tz) > .05; u.tx = x; u.tz = z; u.try = ry; u.glass.visible = !!dr; if (dr) u.glass.material.emissive.setHex(DRINK_COL[dr] || 0xffa040);
      }
    } else if (m.t === 'chat') say('', m.name, m.text, TIER_COL[m.tier]);
    else if (m.t === 'sys') say('sys', '', m.text);
    else if (m.t === 'denied') { say('sys', '', m.why || 'Disconnected.'); sessionStorage.removeItem('lounge'); ws = null; }
    else if (m.t === 'voice') voiceReady(m);
    else if (m.t === 'dj') { const was = DJ.idx; djSync(m); if (m.changed && was !== m.idx) djChanged(); }
    else if (m.t === 'rec') { if (m.on) recorders.add(m.id); else recorders.delete(m.id); L.studio.setOnAir(recorders.size > 0); if (m.on) say('sys', '', `${m.name} is recording in the studio`); }
  };
  ws.onclose = () => { if (ws) say('sys', '', 'Connection lost. Reload to rejoin.'); };
}
const sendWs = (o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };

/* ---------- controls ---------- */
const STAGE = { x0: -2.5, x1: 2.5, z0: -9.8, z1: 3.5 };
addEventListener('keydown', (e) => { if (document.activeElement && document.activeElement.tagName === 'INPUT') { if (e.key === 'Enter') sendChat(); return; } keys[e.key.toLowerCase()] = true; if (e.key === 'Enter') $('#ci').focus(); });
addEventListener('keyup', (e) => { keys[e.key.toLowerCase()] = false; });
const joy = { x: 0, y: 0 };
{
  const j = $('#joy'), k = j.querySelector('i'); let on = false;
  const mv = (t) => { const r = j.getBoundingClientRect(); let dx = (t.clientX - r.left - 55) / 45, dy = (t.clientY - r.top - 55) / 45; const l = Math.hypot(dx, dy); if (l > 1) { dx /= l; dy /= l; } joy.x = dx; joy.y = dy; k.style.transform = `translate(${dx * 30}px,${dy * 30}px)`; };
  j.addEventListener('touchstart', (e) => { on = true; mv(e.touches[0]); e.preventDefault(); }, { passive: false });
  j.addEventListener('touchmove', (e) => { if (on) mv(e.touches[0]); e.preventDefault(); }, { passive: false });
  j.addEventListener('touchend', () => { on = false; joy.x = joy.y = 0; k.style.transform = ''; });
}
let drag = null;
L.renderer.domElement.addEventListener('pointerdown', (e) => { drag = e.clientX; });
addEventListener('pointerup', () => { drag = null; });
addEventListener('pointermove', (e) => { if (drag !== null && me) { pos.yaw -= (e.clientX - drag) * .006; drag = e.clientX; } });
function sendChat() { const i = $('#ci'); const t = i.value.trim(); if (t) sendWs({ t: 'chat', text: t }); i.value = ''; i.blur(); }
$('#send').onclick = sendChat;
$('#drink').onclick = () => { const b = $('#bar'); b.style.display = b.style.display === 'flex' ? 'none' : 'flex'; };
$('#bar').innerHTML = [['champagne', '🥂 Champagne'], ['whiskey', '🥃 Whiskey'], ['mojito', '🍹 Mojito'], ['gold', '✨ Gold Label']].map(([id, n]) => `<button data-d="${id}">${n} · free</button>`).join('');
$('#bar').onclick = (e) => { const d = e.target.dataset && e.target.dataset.d; if (d) { sendWs({ t: 'drink', id: d }); if (me) { me.userData.glass.visible = true; me.userData.glass.material.emissive.setHex(DRINK_COL[d]); setTimeout(() => { if (me) me.userData.glass.visible = false; }, 60000); } $('#bar').style.display = 'none'; } };

/* ---------- voice (LiveKit, proximity volume) ---------- */
let lkRoom = null, micOn = false, LKM = null, subT = 0;
$('#mic').onclick = async () => {
  if (lkRoom) { micOn = !micOn; await lkRoom.localParticipant.setMicrophoneEnabled(micOn); $('#mic').textContent = micOn ? '🎤 Live' : '🔇 Muted'; return; }
  $('#mic').textContent = '…'; sendWs({ t: 'voice' });
};
async function voiceReady(m) {
  if (m.error) { say('sys', '', m.error); $('#mic').textContent = '🎤 Voice'; return; }
  try {
    const LK = await import('https://cdn.jsdelivr.net/npm/livekit-client@2.9.9/dist/livekit-client.esm.mjs');
    lkRoom = new LK.Room({ adaptiveStream: true, dynacast: true }); LKM = LK;
    lkRoom.on(LK.RoomEvent.TrackSubscribed, (track, pub, part) => { if (track.kind === 'audio') { const el = track.attach(); el.dataset.pid = part.identity; document.body.appendChild(el); } });
    lkRoom.on(LK.RoomEvent.TrackUnsubscribed, (track) => track.detach().forEach((el) => el.remove()));
    await lkRoom.connect(m.url, m.token, { autoSubscribe: false }); await lkRoom.localParticipant.setMicrophoneEnabled(true); micOn = true; $('#mic').textContent = '🎤 Live'; say('sys', '', 'Voice on. You hear people near you.');
  } catch (e) { lkRoom = null; $('#mic').textContent = '🎤 Voice'; say('sys', '', 'Could not start voice: ' + ((e && e.message) || e)); }
}
function subscribeNearby(dt) { // only the closest few voices are downloaded at all, so a full room costs nothing extra
  subT += dt; if (subT < .6 || !lkRoom) return; subT = 0;
  const near = [...lkRoom.remoteParticipants.values()].map((p) => { const a = others.get(p.identity); return [p, a ? Math.hypot(a.position.x - pos.x, a.position.z - pos.z) : 99]; }).sort((x, y) => x[1] - y[1]);
  near.forEach(([p, d], i) => { const want = i < 6 && d < 13; for (const pub of p.audioTrackPublications.values()) if (pub.isSubscribed !== want) pub.setSubscribed(want); });
}
function voiceTick() { // volume fades with distance, so you hear the booth you stand at
  if (!lkRoom || !me) return;
  for (const el of document.querySelectorAll('audio[data-pid]')) { const a = others.get(el.dataset.pid); if (!a) { el.volume = 0; continue; } const d = Math.hypot(a.position.x - pos.x, a.position.z - pos.z); el.volume = Math.max(0, Math.min(1, 1 - (d - 2) / 10)); }
}

/* ---------- per-frame ---------- */
const HP = new THREE.Vector3(), camT = new THREE.Vector3(), lookT = new THREE.Vector3();
let sendAcc = 0, lodT = 0, frameN = 0;
L.hooks.tick = (dt) => {
  if (!me) { L.hooks.autoCam(); return; }
  let f = 0, s = 0;
  if (keys['w'] || keys['arrowup']) f += 1; if (keys['s'] || keys['arrowdown']) f -= 1;
  if (keys['a'] || keys['arrowleft']) s -= 1; if (keys['d'] || keys['arrowright']) s += 1;
  f += -joy.y; s += joy.x;
  if (keys['q']) pos.yaw += dt * 1.8; if (keys['e']) pos.yaw -= dt * 1.8;
  const len = Math.hypot(f, s); const moving = len > .08;
  if (moving) {
    const sp = 2.4 * dt / Math.max(1, len); const Fx = -Math.sin(pos.yaw), Fz = -Math.cos(pos.yaw), Rx = Math.cos(pos.yaw), Rz = -Math.sin(pos.yaw);
    let nx = pos.x + (Fx * f + Rx * s) * sp, nz = pos.z + (Fz * f + Rz * s) * sp;
    nx = Math.max(-11, Math.min(11, nx)); nz = Math.max(-14.5, Math.min(14.5, nz));
    { const hit = (x, z) => L.COLLIDERS.some((c) => x > c.x0 - .28 && x < c.x1 + .28 && z > c.z0 - .28 && z < c.z1 + .28);
      if (hit(nx, nz)) { if (!hit(nx, pos.z)) nz = pos.z; else if (!hit(pos.x, nz)) nx = pos.x; else { nx = pos.x; nz = pos.z; } } }
    if (nx > STAGE.x0 && nx < STAGE.x1 && nz > STAGE.z0 && nz < STAGE.z1) { if (!(pos.x > STAGE.x0 && pos.x < STAGE.x1 && pos.z > STAGE.z0 && pos.z < STAGE.z1)) { nx = pos.x; nz = pos.z; } } // the stage is the dancer's
    const mx = nx - pos.x, mz = nz - pos.z; if (Math.hypot(mx, mz) > 1e-4) pos.ry = Math.atan2(mx, mz);
    pos.x = nx; pos.z = nz;
  }
  pos.anim = moving ? 'walk' : 'idle';
  const u = me.userData; u.moving = moving; me.position.set(pos.x, 0, pos.z); me.rotation.y += ((pos.ry - me.rotation.y + Math.PI * 3) % (Math.PI * 2) - Math.PI) * Math.min(1, dt * 12);
  sendAcc += dt; if (sendAcc > .1) { sendAcc = 0; sendWs({ t: 'pos', x: pos.x, z: pos.z, ry: pos.ry, a: pos.anim }); }
  for (const a of others.values()) { const v = a.userData; a.position.x += (v.tx - a.position.x) * Math.min(1, dt * 9); a.position.z += (v.tz - a.position.z) * Math.min(1, dt * 9); a.rotation.y += ((v.try - a.rotation.y + Math.PI * 3) % (Math.PI * 2) - Math.PI) * Math.min(1, dt * 10); }
  lodT += dt; if (lodT > .5) { lodT = 0; const arr = [...others.values()].map((a) => [a, Math.hypot(a.position.x - pos.x, a.position.z - pos.z)]).sort((x, y) => x[1] - y[1]); arr.forEach(([a, d], i) => { a.userData.near = i < 18 && d < 22; a.userData.tag.visible = d < 16; }); }
  frameN++;
  for (const a of [me, ...others.values()]) { const v = a.userData; if (v.mixer) { playAnim(v, v.moving ? 'walk' : 'idle'); if (v.near !== false || frameN % 4 === 0) v.mixer.update(v.near !== false ? dt : dt * 4); }
    if (v.glass.visible && v.hand) { v.hand.getWorldPosition(HP); a.worldToLocal(HP); v.glass.position.set(HP.x, HP.y + .07, HP.z); } }
  // third-person camera behind and above, easing, never inside a wall
  const camD = inRoom() ? 2.3 : 4.2; const cx = pos.x + Math.sin(pos.yaw) * camD, cz = pos.z + Math.cos(pos.yaw) * camD;
  camT.set(Math.max(-11.3, Math.min(11.3, cx)), inRoom() ? 1.9 : 2.3, Math.max(-15.3, Math.min(15.3, cz))); lookT.set(pos.x, 1.35, pos.z);
  camera.position.lerp(camT, Math.min(1, dt * 6)); camera.lookAt(lookT);
  if (L.camOverride) { const c = L.camOverride; camera.position.set(c[0], c[1], c[2]); camera.lookAt(c[3], c[4], c[5]); }
  voiceTick(); subscribeNearby(dt); studioTick(); npcTick(dt); djTick(dt);
};

/* ---------- studio: record over a beat, entirely in the browser. Nothing is uploaded or stored. ---------- */
const ST = { ctx: null, rec: null, beatEl: null, chunks: [], blobUrl: null, stream: null, on: false, takeUnsaved: false, playEl: null };
const BEAT_URL = (k) => './assets/beats/' + k + '.mp3';
const inRoom = () => { const r = L.studio.room; return pos.x > r.x0 && pos.x < r.x1 + .6 && pos.z > r.z0 && pos.z < r.z1; };
$('#beat').onchange = () => { $('#beatfile').style.display = $('#beat').value === 'file' ? 'block' : 'none'; };
$('#studioBtn').onclick = () => { const p = $('#studio'); p.style.display = p.style.display === 'block' ? 'none' : 'block'; };
async function startTake() {
  try {
    const sel = $('#beat').value; let url;
    if (sel === 'file') { const f = $('#beatfile').files[0]; if (!f) { say('sys', '', 'Pick a beat file first.'); return; } url = URL.createObjectURL(f); } else url = BEAT_URL(sel);
    ST.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    const AC = window.AudioContext || window.webkitAudioContext; ST.ctx = ST.ctx || new AC(); await ST.ctx.resume();
    const dest = ST.ctx.createMediaStreamDestination();
    ST.beatEl = new Audio(url); ST.beatEl.loop = true; ST.beatEl.crossOrigin = 'anonymous';
    const bs = ST.ctx.createMediaElementSource(ST.beatEl); const bg = ST.ctx.createGain(); bg.gain.value = .8; bs.connect(bg); bg.connect(dest); bg.connect(ST.ctx.destination);
    const ms = ST.ctx.createMediaStreamSource(ST.stream); const mg = ST.ctx.createGain(); mg.gain.value = 1.0; ms.connect(mg); mg.connect(dest);
    ST.meter = { peak: 0, voice: 0, clip: 0, n: 0 }; const an = ST.ctx.createAnalyser(); an.fftSize = 1024; ms.connect(an); const buf = new Float32Array(an.fftSize);
    clearInterval(ST.mt); ST.mt = setInterval(() => { an.getFloatTimeDomainData(buf); let pk = 0; for (const v of buf) { const a = Math.abs(v); if (a > pk) pk = a; } const M = ST.meter; M.n++; if (pk > M.peak) M.peak = pk; if (pk > .02) M.voice++; if (pk > .98) M.clip++; }, 50); // the mic goes into the take, not to your speakers
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
    ST.rec = new MediaRecorder(dest.stream, mime ? { mimeType: mime } : undefined); ST.chunks = [];
    ST.rec.ondataavailable = (e) => { if (e.data.size) ST.chunks.push(e.data); };
    ST.rec.onstop = () => {
      const type = ST.rec.mimeType || 'audio/webm'; const blob = new Blob(ST.chunks, { type }); if (ST.blobUrl) URL.revokeObjectURL(ST.blobUrl); ST.blobUrl = URL.createObjectURL(blob);
      const ext = type.includes('mp4') ? 'm4a' : 'webm'; const a = $('#sdl'); a.href = ST.blobUrl; a.download = 'hood-rich-session.' + ext; a.style.display = 'block'; $('#splay').disabled = false; ST.takeUnsaved = true;
      ST.stream.getTracks().forEach((t) => t.stop());
    };
    if (lkRoom && micOn) { await lkRoom.localParticipant.setMicrophoneEnabled(false); ST.voiceWas = true; }
    if (ENG.session) engSay('countin');
    for (const n of [3, 2, 1]) { $('#sc').textContent = n; await new Promise((r) => setTimeout(r, 800)); }
    $('#sc').textContent = ''; ST.rec.start(250); await ST.beatEl.play(); ST.on = true; sendWs({ t: 'rec', on: true });
    $('#srec').textContent = '■ Stop'; $('#srec').classList.add('rec');
  } catch (e) { say('sys', '', 'Could not start recording: ' + ((e && e.message) || e)); $('#sc').textContent = ''; }
}
function stopTake() {
  if (!ST.on) return; ST.on = false; try { ST.rec.stop(); } catch {} try { ST.beatEl.pause(); } catch {}
  $('#srec').textContent = '● Record'; $('#srec').classList.remove('rec'); sendWs({ t: 'rec', on: false });
  clearInterval(ST.mt); if (ENG.session) engFeedback();
  if (ST.voiceWas && lkRoom) { lkRoom.localParticipant.setMicrophoneEnabled(true); ST.voiceWas = false; }
}
$('#srec').onclick = () => { if (ST.on) stopTake(); else startTake(); };
$('#splay').onclick = () => { if (!ST.blobUrl) return; if (ST.playEl && !ST.playEl.paused) { ST.playEl.pause(); $('#splay').textContent = '▶ Play'; return; } ST.playEl = new Audio(ST.blobUrl); ST.playEl.onended = () => { $('#splay').textContent = '▶ Play'; }; ST.playEl.play(); $('#splay').textContent = '■ Stop'; };
$('#sdl').addEventListener('click', () => { ST.takeUnsaved = false; });
addEventListener('beforeunload', (e) => { if (ST.takeUnsaved) { e.preventDefault(); e.returnValue = ''; } });
const recorders = new Set();
function studioTick() { // the studio button shows only inside the studio; leaving mid-take stops it
  const inside = !!me && inRoom(); $('#studioBtn').style.display = inside ? 'inline-block' : 'none';
  if (!inside) { if (ST.on) stopTake(); $('#studio').style.display = 'none'; }
}

/* ---------- NPCs (studio engineer, DJ) and the shared DJ playlist ---------- */
const NPC_DEFS = [
  { id: 'eng', name: 'Engineer', file: 'engineer', x: -9.15, z: 7.05, ry: 0, anims: ['idle', 'talk', 'wave', 'agree', 'listen'], reach: 2.8 },
  { id: 'dj', name: 'DJ', file: 'dj', x: 8.6, z: -12.3, ry: 0, anims: ['groove', 'idle', 'wave', 'bass'], reach: 3.4 },
];
const NPCS = {}; let LINES = {}; let talking = null;
const voiceVol = (npc) => { if (!me) return .6; const d = Math.hypot(npc.obj.position.x - pos.x, npc.obj.position.z - pos.z); return Math.max(.25, Math.min(1, 1.2 - d / 14)); };
async function loadNpcs() {
  try { LINES = await (await fetch('./assets/npc/voices/lines.json')).json(); } catch {}
  for (const d of NPC_DEFS) {
    try {
      const g = await loadGLB(`./assets/npc/${d.file}.glb`); g.scene.updateMatrixWorld(true);
      const bb = new THREE.Box3().setFromObject(g.scene, true); const sc = 1.8 / (bb.max.y - bb.min.y);
      g.scene.scale.multiplyScalar(sc); g.scene.position.y = -bb.min.y * sc; g.scene.traverse((o) => { if (o.isMesh || o.isSkinnedMesh) { o.frustumCulled = false; o.castShadow = true; } });
      const grp = new THREE.Group(); grp.add(g.scene); grp.position.set(d.x, 0, d.z); grp.rotation.y = d.ry; scene.add(grp);
      const mixer = new THREE.AnimationMixer(g.scene); const acts = {};
      for (const a of d.anims) { try { const f = await loadGLB(`./assets/npc/${d.file}_${a}.glb`); const c = f.animations[0]; if (!c) continue;
        for (const tr of c.tracks) if (tr.name.endsWith('.position') && tr.name.indexOf('Hips') >= 0) { const v = tr.values; const x0 = v[0], z0 = v[2]; for (let i = 0; i < v.length; i += 3) { v[i] -= x0; v[i + 2] -= z0; } }
        const act = mixer.clipAction(c); act.setLoop(THREE.LoopRepeat, Infinity); acts[a] = act; } catch (e) { console.warn('npc anim', d.file, a); } }
      const base = d.id === 'dj' ? (acts.groove ? 'groove' : 'idle') : 'idle';
      const npc = { ...d, obj: grp, mixer, acts, base, cur: null, curName: '', talkUntil: 0 }; NPCS[d.id] = npc; npcPlay(npc, base); mixer.update(Math.random() * 2);
      const tag = nameTag(d.name + '  ·  ' + (d.id === 'dj' ? 'Resident DJ' : 'Studio engineer'), 0xe9c97a); tag.position.y = 2.2; grp.add(tag);
    } catch (e) { console.warn('npc failed', d.file, e); }
  }
  try { const b = await loadGLB('./assets/npc/djbooth.glb'); b.scene.updateMatrixWorld(true); let bb = new THREE.Box3().setFromObject(b.scene); const sz = bb.getSize(new THREE.Vector3()); b.scene.scale.multiplyScalar(2.6 / Math.max(sz.x, sz.z)); b.scene.updateMatrixWorld(true); bb = new THREE.Box3().setFromObject(b.scene); b.scene.position.set(8.6 - (bb.min.x + bb.max.x) / 2, -bb.min.y, -11.2 - (bb.min.z + bb.max.z) / 2); scene.add(b.scene); } catch (e) { console.warn('dj booth model missing'); }
}
function npcPlay(n, name) { const a = n.acts[name] || n.acts[n.base] || n.acts.idle; if (!a || n.curName === name) return; a.reset().play(); if (n.cur && n.cur !== a) n.cur.crossFadeTo(a, .3, false); n.cur = a; n.curName = name; }
function npcSay(n, key) { // play a pre-recorded line, show it as a subtitle, and have the NPC talk while it plays
  const text = (LINES[n.id] || {})[key]; if (!text) return null; say('', n.name, text, 0xe9c97a);
  const a = new Audio(`./assets/npc/voices/${n.id}_${key}.mp3`); a.volume = voiceVol(n); n.talkUntil = performance.now() + 4500; a.onloadedmetadata = () => { n.talkUntil = performance.now() + a.duration * 1000 + 200; };
  a.play().catch(() => {}); return a;
}
const engSay = (k) => { const n = NPCS.eng; return n ? npcSay(n, k) : null; };
const ENG = { session: false };
function engFeedback() { // simple, honest feedback from what the mic actually did during the take
  const M = ST.meter || { n: 1, voice: 0, clip: 0, peak: 0 }; let key = 'good';
  if (M.voice < Math.max(3, M.n * .06)) key = 'silent'; else if (M.clip >= 3) key = 'clip'; else if (M.peak < .22) key = 'quiet';
  setTimeout(() => { const a = engSay(key); if (a) a.onended = () => setTimeout(() => engSay('save'), 600); }, 700);
}
function npcTick(dt) {
  const now = performance.now(); let near = null, nd = 99;
  for (const n of Object.values(NPCS)) {
    const d = Math.hypot(n.obj.position.x - pos.x, n.obj.position.z - pos.z);
    if (d < 30) n.mixer.update(dt);
    const speaking = now < n.talkUntil; if (n.id === 'eng') npcPlay(n, speaking ? (n.acts.talk ? 'talk' : 'idle') : 'idle'); else npcPlay(n, speaking && n.acts.wave ? 'wave' : n.base);
    if ((speaking || talking === n) && d < 8) { const t = Math.atan2(pos.x - n.obj.position.x, pos.z - n.obj.position.z); n.obj.rotation.y += ((t - n.obj.rotation.y + Math.PI * 3) % (Math.PI * 2) - Math.PI) * Math.min(1, dt * 6); }
    else if (talking !== n) n.obj.rotation.y += ((n.ry - n.obj.rotation.y + Math.PI * 3) % (Math.PI * 2) - Math.PI) * Math.min(1, dt * 3);
    if (d < n.reach && d < nd) { near = n; nd = d; }
  }
  const btn = $('#talkBtn'); if (near) { btn.style.display = 'inline-block'; btn.textContent = '💬 Talk to ' + near.name; btn.dataset.n = near.id; } else { btn.style.display = 'none'; if (talking && !ST.on) closeTalk(); }
}
function openTalk(n) {
  talking = n; $('#tpName').textContent = n.name.toUpperCase(); const b = $('#tpBtns'); b.innerHTML = ''; const sub = $('#tpSub');
  const add = (label, fn) => { const x = document.createElement('button'); x.textContent = label; x.onclick = fn; b.appendChild(x); };
  if (n.id === 'eng') {
    sub.textContent = "Welcome to the studio. Want to cut a track?"; const a = engSay('greet');
    add('🎙 Book a session', () => { ENG.session = true; const a2 = engSay('pickbeat'); $('#studio').style.display = 'block'; sub.textContent = 'Pick a beat in the Studio panel, then hit Record. I count you in. Nothing is saved or uploaded.'; });
    add('Just looking', closeTalk);
  } else {
    sub.textContent = "What's good. I take requests all night."; npcSay(n, 'greet');
    add('🎧 Vote for the next track', () => { npcSay(n, 'ask'); openDj(); }); add('Close', closeTalk);
  }
}
function closeTalk() { talking = null; $('#talkp').style.display = 'none'; ENG.session = false; }
$('#talkBtn').onclick = () => { const n = NPCS[$('#talkBtn').dataset.n]; if (!n) return; $('#talkp').style.display = 'block'; openTalk(n); };
// ---- shared DJ playlist: the server says which track started when; we play it from the right point, quieter the further you are
const DJ = { idx: -1, start: 0, dur: 40, titles: [], nums: [], votes: {}, skew: 0, audio: null, myVote: -1 };
function djSync(m) {
  const first = DJ.idx < 0; DJ.titles = m.titles || DJ.titles; DJ.nums = m.nums || DJ.nums; DJ.votes = m.votes || {}; DJ.skew = Date.now() - m.now; DJ.dur = m.dur;
  if (m.idx !== DJ.idx || first) { DJ.idx = m.idx; DJ.start = m.start + DJ.skew; DJ.myVote = -1; djPlay(); }
  djRender();
}
function djPlay() {
  if (!DJ.nums.length) return; if (DJ.audio) { DJ.audio.pause(); DJ.audio = null; }
  const a = new Audio(`./assets/music/${DJ.nums[DJ.idx]}.mp3`); a.loop = false; a.volume = 0; DJ.audio = a;
  const go = () => { const off = Math.max(0, (Date.now() - DJ.start) / 1000); if (off < DJ.dur - .5) { try { a.currentTime = off; } catch {} } a.play().catch(() => {}); };
  a.addEventListener('loadedmetadata', go, { once: true });
}
function djChanged() { const n = NPCS.dj; if (n && me && Math.hypot(n.obj.position.x - pos.x, n.obj.position.z - pos.z) < 20) npcSay(n, Math.random() < .6 ? 'next' : 'hype'); }
function djRender() {
  if (!DJ.titles.length) return; $('#djNow').innerHTML = `Now playing: <b style="color:#ffd34d">${esc(DJ.titles[DJ.idx] || '')}</b> · Winslow Bankz`;
  $('#djList').innerHTML = DJ.titles.map((t, i) => `<button class="dj-t${i === DJ.idx ? ' on' : ''}" data-i="${i}">${i === DJ.idx ? '▶ ' : ''}${esc(t)} <b>${DJ.votes[i] ? DJ.votes[i] + ' vote' + (DJ.votes[i] > 1 ? 's' : '') : (DJ.myVote === i ? '✓' : '')}</b></button>`).join('');
}
$('#djList').onclick = (e) => { const b = e.target.closest('.dj-t'); if (!b) return; const i = +b.dataset.i; if (i === DJ.idx) return; DJ.myVote = i; sendWs({ t: 'djvote', i }); if (NPCS.dj) npcSay(NPCS.dj, 'vote'); };
addEventListener('pointerdown', () => { if (DJ.audio && DJ.audio.paused && DJ.idx >= 0) DJ.audio.play().catch(() => {}); }, { passive: true }); // phones only start audio on a tap
function openDj() { $('#djp').style.display = 'block'; djRender(); }
$('#djBtn').onclick = () => { const p = $('#djp'); if (p.style.display === 'block') p.style.display = 'none'; else openDj(); };
function djTick() { // volume follows distance to the booth; softer inside the studio and silent while you record
  const a = DJ.audio; if (!a || !me) return; const n = NPCS.dj; const d = n ? Math.hypot(n.obj.position.x - pos.x, n.obj.position.z - pos.z) : 10;
  let v = Math.max(.14, Math.min(.9, 1.05 - d / 22)); if (inRoom()) v *= .35; if (ST.on) v = 0; a.volume += (v - a.volume) * .1;
  if (a.ended && DJ.idx >= 0) { /* the server will announce the next track within a second */ }
}

function enter() {
  SELF.req = $('#nm').value; $('#gate').remove(); $('#hud').style.display = 'none';
  for (const id of ['#top', '#chat', '#bar']) $(id).style.display = id === '#bar' ? 'none' : 'block';
  $('#dock').style.display = 'flex'; connect();
}
if (Q.has('autologin')) $('#go').click();
