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
@media (max-width:640px){#chat{bottom:176px}}
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
<div id="dock"><button id="drink">🍸 Bar</button><button id="mic">🎤 Voice</button></div>
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
  const tag = nameTag((info.name || '?') + (info.tier ? '  ·  ' + info.tier : ''), col); tag.position.y = 2.2; g.add(tag);
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

/* ---------- network ---------- */
const logEl = () => $('#log');
function say(cls, who, text, col) {
  const d = document.createElement('div'); if (cls) d.className = cls;
  d.innerHTML = who ? `<span class="t" style="color:#${(col || 0xe9c97a).toString(16).padStart(6, '0')}">${esc(who)}</span> ${esc(text)}` : esc(text);
  logEl().appendChild(d); while (logEl().children.length > 8) logEl().firstChild.remove();
  setTimeout(() => { d.style.transition = 'opacity 2s'; d.style.opacity = 0; setTimeout(() => d.remove(), 2100); }, 14000);
}
function updateTop() { $('#top').textContent = `Hood Rich Club · ${SELF.tier || ''} · ${others.size + 1} in the room`; }
async function connect() {
  await AVP; ws = new WebSocket(WS_URL);
  ws.onopen = () => ws.send(JSON.stringify({ t: 'join', token: TOKEN, name: SELF.req || '' }));
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.t === 'welcome') {
      myId = m.id; SELF.name = m.you.name;
      me = makeAvatar({ ...m.you, x: pos.x, z: pos.z, ry: pos.ry }); me.userData.mine = true;
      for (const p of m.players) others.set(p.id, makeAvatar(p));
      updateTop(); say('sys', '', 'Welcome to the Hood Rich Club.');
    } else if (m.t === 'join') { others.set(m.p.id, makeAvatar(m.p)); say('sys', '', `${m.p.name} walked in`); updateTop(); }
    else if (m.t === 'leave') { const a = others.get(m.id); if (a) { scene.remove(a); others.delete(m.id); updateTop(); } }
    else if (m.t === 'state') {
      for (const [id, x, z, ry, an, dr] of m.s) {
        if (id === myId) continue; const a = others.get(id); if (!a) continue;
        const u = a.userData; u.moving = an === 'walk' || Math.hypot(x - u.tx, z - u.tz) > .05; u.tx = x; u.tz = z; u.try = ry; u.glass.visible = !!dr; if (dr) u.glass.material.emissive.setHex(DRINK_COL[dr] || 0xffa040);
      }
    } else if (m.t === 'chat') say('', m.name, m.text, TIER_COL[m.tier]);
    else if (m.t === 'sys') say('sys', '', m.text);
    else if (m.t === 'denied') { say('sys', '', m.why || 'Disconnected.'); sessionStorage.removeItem('lounge'); ws = null; }
    else if (m.t === 'voice') voiceReady(m);
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
let lkRoom = null, micOn = false;
$('#mic').onclick = async () => {
  if (lkRoom) { micOn = !micOn; await lkRoom.localParticipant.setMicrophoneEnabled(micOn); $('#mic').textContent = micOn ? '🎤 Live' : '🔇 Muted'; return; }
  $('#mic').textContent = '…'; sendWs({ t: 'voice' });
};
async function voiceReady(m) {
  if (m.error) { say('sys', '', m.error); $('#mic').textContent = '🎤 Voice'; return; }
  try {
    const LK = await import('https://cdn.jsdelivr.net/npm/livekit-client@2.9.9/dist/livekit-client.esm.mjs');
    lkRoom = new LK.Room({ adaptiveStream: true, dynacast: true });
    lkRoom.on(LK.RoomEvent.TrackSubscribed, (track, pub, part) => { if (track.kind === 'audio') { const el = track.attach(); el.dataset.pid = part.identity; document.body.appendChild(el); } });
    lkRoom.on(LK.RoomEvent.TrackUnsubscribed, (track) => track.detach().forEach((el) => el.remove()));
    await lkRoom.connect(m.url, m.token); await lkRoom.localParticipant.setMicrophoneEnabled(true); micOn = true; $('#mic').textContent = '🎤 Live'; say('sys', '', 'Voice on. You hear people near you.');
  } catch (e) { lkRoom = null; $('#mic').textContent = '🎤 Voice'; say('sys', '', 'Could not start voice: ' + ((e && e.message) || e)); }
}
function voiceTick() { // volume fades with distance, so you hear the booth you stand at
  if (!lkRoom || !me) return;
  for (const el of document.querySelectorAll('audio[data-pid]')) { const a = others.get(el.dataset.pid); if (!a) { el.volume = 0; continue; } const d = Math.hypot(a.position.x - pos.x, a.position.z - pos.z); el.volume = Math.max(0, Math.min(1, 1 - (d - 2) / 10)); }
}

/* ---------- per-frame ---------- */
const HP = new THREE.Vector3(), camT = new THREE.Vector3(), lookT = new THREE.Vector3();
let sendAcc = 0;
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
    if (nx > STAGE.x0 && nx < STAGE.x1 && nz > STAGE.z0 && nz < STAGE.z1) { if (!(pos.x > STAGE.x0 && pos.x < STAGE.x1 && pos.z > STAGE.z0 && pos.z < STAGE.z1)) { nx = pos.x; nz = pos.z; } } // the stage is the dancer's
    const mx = nx - pos.x, mz = nz - pos.z; if (Math.hypot(mx, mz) > 1e-4) pos.ry = Math.atan2(mx, mz);
    pos.x = nx; pos.z = nz;
  }
  pos.anim = moving ? 'walk' : 'idle';
  const u = me.userData; u.moving = moving; me.position.set(pos.x, 0, pos.z); me.rotation.y += ((pos.ry - me.rotation.y + Math.PI * 3) % (Math.PI * 2) - Math.PI) * Math.min(1, dt * 12);
  sendAcc += dt; if (sendAcc > .1) { sendAcc = 0; sendWs({ t: 'pos', x: pos.x, z: pos.z, ry: pos.ry, a: pos.anim }); }
  for (const a of others.values()) { const v = a.userData; a.position.x += (v.tx - a.position.x) * Math.min(1, dt * 9); a.position.z += (v.tz - a.position.z) * Math.min(1, dt * 9); a.rotation.y += ((v.try - a.rotation.y + Math.PI * 3) % (Math.PI * 2) - Math.PI) * Math.min(1, dt * 10); }
  for (const a of [me, ...others.values()]) { const v = a.userData; if (v.mixer) { playAnim(v, v.moving ? 'walk' : 'idle'); v.mixer.update(dt); }
    if (v.glass.visible && v.hand) { v.hand.getWorldPosition(HP); a.worldToLocal(HP); v.glass.position.set(HP.x, HP.y + .07, HP.z); } }
  // third-person camera behind and above, easing, never inside a wall
  const cx = pos.x + Math.sin(pos.yaw) * 4.2, cz = pos.z + Math.cos(pos.yaw) * 4.2;
  camT.set(Math.max(-11.3, Math.min(11.3, cx)), 2.3, Math.max(-15.3, Math.min(15.3, cz))); lookT.set(pos.x, 1.35, pos.z);
  camera.position.lerp(camT, Math.min(1, dt * 6)); camera.lookAt(lookT);
  voiceTick();
};
function enter() {
  SELF.req = $('#nm').value; $('#gate').remove(); $('#hud').style.display = 'none';
  for (const id of ['#top', '#chat', '#bar']) $(id).style.display = id === '#bar' ? 'none' : 'block';
  $('#dock').style.display = 'flex'; connect();
}
if (Q.has('autologin')) $('#go').click();
