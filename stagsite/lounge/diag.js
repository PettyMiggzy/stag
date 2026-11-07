// Diagnostic panel (?diag). For a tester on a real device: switch graphics features on/off to find which one causes a black box,
// mark the moment it happens, and copy a short report. Nothing is sent anywhere.
const L = window.__lounge, F = L.FLAGS, R = L.renderer, cam = L.camera;
const gl = R.getContext(); const dbg = gl.getExtension('WEBGL_debug_renderer_info');
const gpu = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown', vendor = dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : 'unknown';
const marks = []; let fps = 0, n = 0, t0 = performance.now();
const box = document.createElement('div');
box.style.cssText = 'position:fixed;right:8px;top:8px;z-index:99999;width:min(300px,86vw);max-height:92vh;overflow:auto;background:rgba(0,0,0,.82);color:#e9c97a;font:12px/1.35 system-ui,sans-serif;padding:10px;border:1px solid #e9c97a;border-radius:10px';
box.innerHTML = '<b>Display check</b> <button id="dgx" style="float:right">hide</button><div id="dgi" style="margin:6px 0;color:#fff"></div><div id="dgf"></div>' +
  '<div style="margin:8px 0">Walk to where the black box shows. Untick one thing at a time; when the box disappears, that is the cause.</div>' +
  '<button id="dgm">⚠ Black box is showing now (mark it)</button> <button id="dgs">Safe mode</button> <button id="dgc">Copy report</button><textarea id="dgt" style="display:none;width:100%;height:120px;margin-top:6px"></textarea>';
document.body.appendChild(box);
const q = (s) => box.querySelector(s);
q('#dgx').onclick = () => { box.style.display = 'none'; };
const names = { reflector: 'Mirror floor', bloom: 'Glow / bloom pass', beams: 'Light beams', shadows: 'Shadows', videos: 'Video screens', env: 'Room reflections' };
const fd = q('#dgf');
for (const k of Object.keys(names)) { const l = document.createElement('label'); l.style.cssText = 'display:block;margin:2px 0;color:#fff'; l.innerHTML = '<input type="checkbox" checked> ' + names[k]; l.firstChild.onchange = (e) => { F[k] = e.target.checked; L.applyFlags(); }; fd.appendChild(l); }
q('#dgs').onclick = () => L.setSafe(!L.isSafe(), true);
const snap = () => { const p = cam.position, e = new L.THREE.Euler().setFromQuaternion(cam.quaternion, 'YXZ'); return { cam: [p.x, p.y, p.z].map((v) => +v.toFixed(2)), yawDeg: Math.round(e.y * 180 / Math.PI), pitchDeg: Math.round(e.x * 180 / Math.PI), flags: { ...F }, safe: L.isSafe() }; };
q('#dgm').onclick = () => { marks.push(snap()); q('#dgm').textContent = '⚠ Marked (' + marks.length + '). Mark again at another spot'; };
const report = () => JSON.stringify({ gpu, vendor, ua: navigator.userAgent, dpr: devicePixelRatio, canvas: [R.domElement.width, R.domElement.height], webgl2: !!window.WebGL2RenderingContext && gl instanceof WebGL2RenderingContext, maxTex: gl.getParameter(gl.MAX_TEXTURE_SIZE), fps: +fps.toFixed(1), calls: R.info.render.calls, tris: R.info.render.triangles, textures: R.info.memory.textures, now: snap(), blackBoxMarks: marks }, null, 1);
q('#dgc').onclick = async () => { const t = report(); try { await navigator.clipboard.writeText(t); q('#dgc').textContent = 'Copied!'; } catch (e) { const ta = q('#dgt'); ta.style.display = 'block'; ta.value = t; ta.select(); q('#dgc').textContent = 'Select all + copy below'; } };
(function tick() { n++; const now = performance.now(); if (now - t0 > 1000) { fps = n * 1000 / (now - t0); n = 0; t0 = now; q('#dgi').textContent = 'GPU: ' + gpu + ' · ' + fps.toFixed(0) + ' fps · ' + R.info.render.calls + ' draws · ' + (L.isSafe() ? 'SAFE mode' : 'full'); } requestAnimationFrame(tick); })();
