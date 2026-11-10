import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {MeshoptDecoder} from 'three/addons/libs/meshopt_decoder.module.js';
import {EffectComposer} from 'three/addons/postprocessing/EffectComposer.js';
import {RenderPass} from 'three/addons/postprocessing/RenderPass.js';
import {UnrealBloomPass} from 'three/addons/postprocessing/UnrealBloomPass.js';
import {OutputPass} from 'three/addons/postprocessing/OutputPass.js';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';

const $=id=>document.getElementById(id);
try{const tw=window.Telegram&&window.Telegram.WebApp;if(tw){tw.ready();tw.expand();try{tw.disableVerticalSwipes&&tw.disableVerticalSwipes()}catch(e){}}}catch(e){}
const LITE=/Android|iPhone|iPad|Mobile/i.test(navigator.userAgent)||!!(window.Telegram&&window.Telegram.WebApp&&window.Telegram.WebApp.initData)||/[?&]lite/.test(location.search);
const TW=(window.Telegram&&window.Telegram.WebApp&&window.Telegram.WebApp.initData)?window.Telegram.WebApp:null;
const API='https://buybot.stagwifhood.fun';
const hap=(k,t)=>{try{if(!TW||!TW.HapticFeedback)return;if(k==='n')TW.HapticFeedback.notificationOccurred(t);else TW.HapticFeedback.impactOccurred(t)}catch(e){}};
if(TW){try{const ins=()=>{const a=(TW.safeAreaInset&&TW.safeAreaInset.top||0)+(TW.contentSafeAreaInset&&TW.contentSafeAreaInset.top||0);document.documentElement.style.setProperty('--top',a+'px')};ins();TW.onEvent&&TW.onEvent('safeAreaChanged',ins);TW.onEvent&&TW.onEvent('contentSafeAreaChanged',ins)}catch(e){}}
const canvas=$('c');
const renderer=new THREE.WebGLRenderer({canvas,antialias:!LITE,powerPreference:'high-performance',preserveDrawingBuffer:!!TW});
let pr=Math.min(devicePixelRatio||1,LITE?1.25:2);const PR_MAX=pr;renderer.setPixelRatio(pr);
renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.0;
renderer.shadowMap.enabled=!LITE;renderer.shadowMap.type=THREE.PCFSoftShadowMap;
const scene=new THREE.Scene();
scene.background=new THREE.Color(0xe9d9b4);scene.fog=new THREE.FogExp2(0xe6d7b0,0.0085);
const camera=new THREE.PerspectiveCamera(58,1,0.1,900);
let composer,bloom,useBloom=!LITE;
function setupComposer(){
  composer=new EffectComposer(renderer);composer.addPass(new RenderPass(scene,camera));
  bloom=new UnrealBloomPass(new THREE.Vector2(innerWidth,innerHeight),0.22,0.6,0.93);composer.addPass(bloom);composer.addPass(new OutputPass());
}
setupComposer();
function resize(){const w=innerWidth,h=innerHeight;renderer.setPixelRatio(pr);renderer.setSize(w,h,false);camera.aspect=w/h;camera.fov=w/h<1?75:58;camera.updateProjectionMatrix();composer.setPixelRatio(pr);composer.setSize(w,h)}
addEventListener('resize',resize);resize();

/* ---------- lights (dawn) ---------- */
scene.add(new THREE.HemisphereLight(0xcfe3ff,0x56663a,1.05));
const moon=new THREE.DirectionalLight(0xffe2b0,3.0);moon.position.set(-26,30,-46);moon.castShadow=!LITE;
moon.shadow.mapSize.set(2048,2048);Object.assign(moon.shadow.camera,{left:-24,right:24,top:24,bottom:-24,near:1,far:160});moon.shadow.bias=-0.0004;
scene.add(moon);scene.add(moon.target);
const stagFill=new THREE.DirectionalLight(0xfff0d8,1.1);stagFill.position.set(5,4,9);stagFill.target.position.set(0,1.2,0);scene.add(stagFill);scene.add(stagFill.target);
const neonA={intensity:0},neonB={intensity:0};
/* ---------- procedural textures ---------- */
function canvasTex(w,h,draw,rep){const c=document.createElement('canvas');c.width=w;c.height=h;draw(c.getContext('2d'),w,h);const t=new THREE.CanvasTexture(c);t.colorSpace=THREE.SRGBColorSpace;t.wrapS=t.wrapT=THREE.RepeatWrapping;t.anisotropy=8;if(rep)t.repeat.set(...rep);return t}
const winTex=canvasTex(128,256,(g,w,h)=>{g.fillStyle='#000';g.fillRect(0,0,w,h);for(let y=6;y<h;y+=16)for(let x=6;x<w;x+=16){if(Math.random()<0.45){const c=['#ffd9a0','#9fd0ff','#39ff88','#ff9fe0'][Math.random()*4|0];g.fillStyle=c;g.globalAlpha=0.5+Math.random()*0.5;g.fillRect(x,y,8,10)}}g.globalAlpha=1});
const floorTex=canvasTex(512,512,(g,w,h)=>{g.fillStyle='#121a22';g.fillRect(0,0,w,h);for(let i=0;i<4000;i++){g.fillStyle=`rgba(255,255,255,${Math.random()*0.04})`;g.fillRect(Math.random()*w,Math.random()*h,2,2)}g.strokeStyle='#0a0f14';g.lineWidth=3;g.strokeRect(0,0,w,h);g.strokeStyle='#39ff8844';g.lineWidth=2;g.beginPath();g.moveTo(w/2,0);g.lineTo(w/2,h);g.stroke()},[3,10]);

/* ---------- environment: Sherwood forest at dawn ---------- */
const env=new THREE.Group();scene.add(env);
const detail=new THREE.Group();detail.visible=!LITE;env.add(detail); // heavy hero props; hidden on slow devices
function noiseTex(w,h,base,var1,dots,rep){const c=document.createElement('canvas');c.width=w;c.height=h;const g=c.getContext('2d');g.fillStyle=base;g.fillRect(0,0,w,h);
  for(let i=0;i<dots;i++){g.fillStyle=var1[(Math.random()*var1.length)|0];g.globalAlpha=0.15+Math.random()*0.35;const s=1+Math.random()*3;g.fillRect(Math.random()*w,Math.random()*h,s,s*(1+Math.random()*3))}g.globalAlpha=1;
  const t=new THREE.CanvasTexture(c);t.colorSpace=THREE.SRGBColorSpace;t.wrapS=t.wrapT=THREE.RepeatWrapping;t.anisotropy=8;if(rep)t.repeat.set(rep[0],rep[1]);return t}
// sky dome (gradient) + sun
{
  const mat=new THREE.ShaderMaterial({side:THREE.BackSide,depthWrite:false,fog:false,uniforms:{},vertexShader:'varying vec3 vP;void main(){vP=normalize(position);gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
    fragmentShader:'varying vec3 vP;void main(){float h=clamp(vP.y,0.0,1.0);vec3 hor=vec3(1.0,0.84,0.60);vec3 mid=vec3(0.66,0.78,0.88);vec3 top=vec3(0.28,0.46,0.70);vec3 c=mix(hor,mid,smoothstep(0.0,0.22,h));c=mix(c,top,smoothstep(0.18,0.8,h));gl_FragColor=vec4(c,1.0);}'});
  const sky=new THREE.Mesh(new THREE.SphereGeometry(520,32,16),mat);sky.renderOrder=-10;scene.add(sky);
  const sunPos=new THREE.Vector3(-70,95,-280);
  const sunTex=noiseTex(2,2,'#fff',['#fff'],0);const gc=document.createElement('canvas');gc.width=gc.height=256;const gg=gc.getContext('2d');const gr=gg.createRadialGradient(128,128,4,128,128,128);gr.addColorStop(0,'rgba(255,248,215,1)');gr.addColorStop(0.18,'rgba(255,230,160,0.85)');gr.addColorStop(0.5,'rgba(255,200,120,0.25)');gr.addColorStop(1,'rgba(255,190,100,0)');gg.fillStyle=gr;gg.fillRect(0,0,256,256);
  const glow=new THREE.Sprite(new THREE.SpriteMaterial({map:new THREE.CanvasTexture(gc),transparent:true,depthWrite:false,fog:false,blending:THREE.AdditiveBlending}));glow.scale.set(260,260,1);glow.position.copy(sunPos);scene.add(glow);
}
// ground: meadow + dirt lane
{
  const gt=noiseTex(512,512,'#4f7a32',['#6d9a3c','#3f6a2a','#86ad4a','#35592a'],5200,[90,90]);
  const ground=new THREE.Mesh(new THREE.PlaneGeometry(700,700),new THREE.MeshStandardMaterial({map:gt,roughness:1,metalness:0}));ground.rotation.x=-Math.PI/2;ground.position.set(0,-0.02,-120);ground.receiveShadow=true;env.add(ground);
  const dt=noiseTex(256,512,'#8a6a45',['#a68459','#6f5236','#b99a6a'],2600,[1,12]);
  const lane=new THREE.Mesh(new THREE.PlaneGeometry(5.2,150),new THREE.MeshStandardMaterial({map:dt,roughness:1}));lane.rotation.x=-Math.PI/2;lane.position.set(0,0.005,-62);lane.receiveShadow=true;env.add(lane);
  // distant rolling hills (real 3D, fogged)
  const hillMat=new THREE.MeshStandardMaterial({color:0x5c8a4a,roughness:1,flatShading:false});
  for(let i=0;i<9;i++){const h=new THREE.Mesh(new THREE.SphereGeometry(1,24,16),hillMat);const a=-1.1+i*0.28;const dist=240+Math.random()*40;h.scale.set(60+Math.random()*50,22+Math.random()*26,40+Math.random()*30);h.position.set(Math.sin(a)*dist*1.1,-6,-Math.cos(a)*dist-30);env.add(h)}
}
// grass tufts (instanced crossed quads)
{
  const c=document.createElement('canvas');c.width=64;c.height=128;const g=c.getContext('2d');
  for(let i=0;i<9;i++){const x=6+i*6.2+(Math.random()-0.5)*3;const hgt=70+Math.random()*50;g.strokeStyle=['#6fa13a','#8fc04a','#4f8a2e'][i%3];g.lineWidth=3.2;g.lineCap='round';g.beginPath();g.moveTo(x,128);g.quadraticCurveTo(x+(Math.random()-0.5)*16,128-hgt*0.6,x+(Math.random()-0.5)*20,128-hgt);g.stroke()}
  const tx=new THREE.CanvasTexture(c);tx.colorSpace=THREE.SRGBColorSpace;
  const q=new THREE.PlaneGeometry(0.5,0.5);q.translate(0,0.25,0);const q2=q.clone();q2.rotateY(Math.PI/2);
  const geo=BufferGeometryUtils.mergeGeometries([q,q2]);
  const mat=new THREE.MeshStandardMaterial({map:tx,alphaTest:0.5,side:THREE.DoubleSide,roughness:1});
  const N=LITE?2200:7000;const im=new THREE.InstancedMesh(geo,mat,N);const m=new THREE.Matrix4(),p=new THREE.Vector3(),s=new THREE.Vector3(),e=new THREE.Euler(),qq=new THREE.Quaternion();const col=new THREE.Color();
  for(let i=0;i<N;i++){let x,z;do{x=(Math.random()-0.5)*90;z=14-Math.random()*110}while(Math.abs(x)<2.9);
    const k=0.6+Math.random()*0.8;p.set(x,0,z);s.set(k,k*(0.8+Math.random()*0.6),k);qq.setFromEuler(e.set(0,Math.random()*6.28,0));m.compose(p,qq,s);im.setMatrixAt(i,m);col.setHSL(0.24+Math.random()*0.06,0.5,0.4+Math.random()*0.18);im.setColorAt(i,col)}
  im.instanceMatrix.needsUpdate=true;env.add(im);
}
// cheap 3D fir forest for the far field (instanced stacked cones) so the horizon is full
{
  const trunk=new THREE.CylinderGeometry(0.35,0.5,3,6);trunk.translate(0,1.5,0);
  const c1=new THREE.ConeGeometry(3.6,6,8);c1.translate(0,5.5,0);const c2=new THREE.ConeGeometry(2.8,5.5,8);c2.translate(0,9.2,0);const c3=new THREE.ConeGeometry(1.9,5,8);c3.translate(0,12.6,0);
  const fir=BufferGeometryUtils.mergeGeometries([trunk,c1,c2,c3]);
  const N=LITE?160:420;const im=new THREE.InstancedMesh(fir,new THREE.MeshStandardMaterial({color:0x4a7a4a,roughness:1,flatShading:true}),N);
  const m=new THREE.Matrix4(),p=new THREE.Vector3(),s=new THREE.Vector3(),qq=new THREE.Quaternion(),e=new THREE.Euler();const col=new THREE.Color();
  for(let i=0;i<N;i++){let x,z;do{x=(Math.random()-0.5)*420;z=40-Math.random()*330}while(Math.abs(x)<26&&z>-120);
    const k=0.9+Math.random()*1.5;p.set(x,0,z);s.set(k,k*(0.9+Math.random()*0.6),k);qq.setFromEuler(e.set(0,Math.random()*6.28,0));m.compose(p,qq,s);im.setMatrixAt(i,m);col.setHSL(0.30+Math.random()*0.05,0.45,0.22+Math.random()*0.12);im.setColorAt(i,col)}
  env.add(im);
}
// drifting mist cards + sun shafts
const mists=[];const shafts=[];
{
  const c=document.createElement('canvas');c.width=c.height=128;const g=c.getContext('2d');const gr=g.createRadialGradient(64,64,4,64,64,64);gr.addColorStop(0,'rgba(255,248,230,0.55)');gr.addColorStop(1,'rgba(255,248,230,0)');g.fillStyle=gr;g.fillRect(0,0,128,128);const mt=new THREE.CanvasTexture(c);
  for(let i=0;i<(LITE?6:14);i++){const m=new THREE.Mesh(new THREE.PlaneGeometry(46,9),new THREE.MeshBasicMaterial({map:mt,transparent:true,depthWrite:false,opacity:0.5,fog:false}));m.position.set((Math.random()-0.5)*80,1.6+Math.random()*2,-10-Math.random()*90);m.rotation.y=Math.random()*0.6-0.3;m.userData.sp=0.15+Math.random()*0.3;m.userData.x0=m.position.x;m.userData.ph=Math.random()*6;env.add(m);mists.push(m)}
  const sc2=document.createElement('canvas');sc2.width=64;sc2.height=256;const sg=sc2.getContext('2d');const lg=sg.createLinearGradient(0,0,0,256);lg.addColorStop(0,'rgba(255,236,170,0.55)');lg.addColorStop(1,'rgba(255,236,170,0)');sg.fillStyle=lg;sg.fillRect(0,0,64,256);const st=new THREE.CanvasTexture(sc2);
  for(let i=0;i<(LITE?4:7);i++){const m=new THREE.Mesh(new THREE.PlaneGeometry(5+Math.random()*4,46),new THREE.MeshBasicMaterial({map:st,transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,opacity:0.34,fog:false,side:THREE.DoubleSide}));
    m.position.set(-22+i*7+(Math.random()-0.5)*4,18,-24-Math.random()*50);m.rotation.z=-0.42;m.rotation.y=0.25;m.userData.ph=Math.random()*6;env.add(m);shafts.push(m)}
}
// fireflies
const flies=(()=>{const n=LITE?70:170,pos=new Float32Array(n*3);const base=new Float32Array(n*3);for(let i=0;i<n;i++){base[i*3]=(Math.random()-0.5)*50;base[i*3+1]=0.4+Math.random()*5;base[i*3+2]=8-Math.random()*70}
  const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.BufferAttribute(pos,3));const c=document.createElement('canvas');c.width=c.height=32;const x=c.getContext('2d');const gr=x.createRadialGradient(16,16,0,16,16,16);gr.addColorStop(0,'rgba(255,255,170,1)');gr.addColorStop(1,'rgba(255,255,170,0)');x.fillStyle=gr;x.fillRect(0,0,32,32);
  const pts=new THREE.Points(g,new THREE.PointsMaterial({size:0.34,map:new THREE.CanvasTexture(c),transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,color:0xffffaa}));pts.frustumCulled=false;env.add(pts);return {pts,pos,base}})();
const decor=new THREE.Group();scene.add(decor);
// hero props from Meshy (loaded in boot)
function instancedFrom(root,placements,opts={}){
  root.updateMatrixWorld(true);const out=new THREE.Group();const rootInv=new THREE.Matrix4().copy(root.matrixWorld).invert();
  root.traverse(o=>{if(!o.isMesh)return;const local=new THREE.Matrix4().multiplyMatrices(rootInv,o.matrixWorld);
    const im=new THREE.InstancedMesh(o.geometry,o.material,placements.length);placements.forEach((P,i)=>{im.setMatrixAt(i,new THREE.Matrix4().multiplyMatrices(P,local))});
    im.instanceMatrix.needsUpdate=true;im.castShadow=!!opts.cast;im.receiveShadow=true;im.frustumCulled=false;out.add(im)});
  return out}
function place(root,list,heightM){ // list of [x,z,rotY,scaleMul]; ground-aligned and sized by height
  const b=new THREE.Box3().setFromObject(root);const h=b.max.y-b.min.y;const base=heightM/h;const P=[];const m=new THREE.Matrix4(),q=new THREE.Quaternion(),e=new THREE.Euler(),s=new THREE.Vector3(),p=new THREE.Vector3();
  const cx=(b.max.x+b.min.x)/2,cz=(b.max.z+b.min.z)/2;
  for(const [x,z,r,k=1] of list){const sc=base*k;q.setFromEuler(e.set(0,r,0));s.set(sc,sc,sc);p.set(x-cx*sc*Math.cos(r)+cz*sc*Math.sin(r),-b.min.y*sc,z-cx*sc*(-Math.sin(r))-cz*sc*Math.cos(r));m.compose(p,q,s);P.push(m.clone())}
  return P}
function buildForest(F){
  const R=(a,b)=>a+Math.random()*(b-a);const sideX=()=>(Math.random()<0.5?-1:1)*R(15,40);
  // hero trees near the lane edges (kept clear of the target zone)
  const oaks=[],oaks2=[],pines=[];for(let i=0;i<(LITE?3:5);i++)oaks.push([sideX(),R(6,-60),R(0,6.28),R(0.8,1.2)]);for(let i=0;i<(LITE?2:4);i++)oaks2.push([sideX(),R(0,-70),R(0,6.28),R(0.8,1.2)]);for(let i=0;i<(LITE?3:5);i++)pines.push([sideX()*1.1,R(10,-80),R(0,6.28),R(0.8,1.2)]);
  env.add(instancedFrom(F.oak_big,place(F.oak_big,oaks,17),{cast:false}));env.add(instancedFrom(F.oak_mid,place(F.oak_mid,oaks2,14)));env.add(instancedFrom(F.pine,place(F.pine,pines,22)));
  // set dressing
  const ferns=[];for(let i=0;i<9;i++)ferns.push([(Math.random()<0.5?-1:1)*R(4.2,16),R(8,-60),R(0,6.28),R(0.7,1.3)]);
  if(F.ferns)detail.add(instancedFrom(F.ferns,place(F.ferns,ferns,1.6)));
  const mush=[];for(let i=0;i<6;i++)mush.push([(Math.random()<0.5?-1:1)*R(3.8,12),R(6,-55),R(0,6.28),R(0.8,1.4)]);
  if(F.mushrooms)detail.add(instancedFrom(F.mushrooms,place(F.mushrooms,mush,1.3)));
  const rocks=[];for(let i=0;i<7;i++)rocks.push([(Math.random()<0.5?-1:1)*R(7,26),R(10,-65),R(0,6.28),R(0.8,1.8)]);
  env.add(instancedFrom(F.boulder,place(F.boulder,rocks,2.4),{cast:true}));
  env.add(instancedFrom(F.log,place(F.log,[[-8.5,-18,0.6,1],[9.5,-33,-0.4,1.2]],2.0)));
  env.add(instancedFrom(F.arch,place(F.arch,[[0,-62,0,1]],8.5)));
  env.add(instancedFrom(F.banner,place(F.banner,[[-5.4,-2.5,0.15,1],[5.6,-2.5,-0.15,1],[-6.2,-30,0.1,1],[6.4,-30,-0.1,1]],5.2),{cast:true}));
  env.add(instancedFrom(F.range,place(F.range,[[-9.2,3.5,0.5,1]],4.6),{cast:true}));
  // warm lantern glows on the range
  if(!LITE){const l=new THREE.PointLight(0xffc27a,14,12,2);l.position.set(-8.4,2.4,3.6);env.add(l)}
}

/* ---------- audio ---------- */
let AC=null,muted=false,master;
const TRACKS=[['Money on My Mind','money'],['Crown Too Heavy','crown'],['Back On Go','backongo'],['Walk Me Through the Fire','walkfire'],["Still Ridin' Slow",'ridinslow'],['No Me Llames','nomellames'],['Fresh Cut, White Tee','whitetee'],['First Heartbreak at School (Remix)','heartbreak']];
let trackI=Math.floor(Math.random()*TRACKS.length),bgm=null;
function playMusic(){try{if(!bgm){bgm=new Audio();bgm.volume=0.55;bgm.addEventListener('ended',()=>{trackI=(trackI+1)%TRACKS.length;loadTrack();bgm.play().catch(()=>{})})}
  loadTrack();bgm.muted=muted;bgm.play().catch(()=>{})}catch(e){}}
function loadTrack(){const [t,f]=TRACKS[trackI];bgm.src='https://records.stagwifhood.fun/assets/audio/'+f+'.mp3';const el=document.getElementById('np');if(el)el.textContent='♪ '+t+' · Winslow Bankz'}
function audioInit(){if(AC)return;try{AC=new (window.AudioContext||window.webkitAudioContext)();master=AC.createGain();master.gain.value=0.5;master.connect(AC.destination)}catch(e){}}
function tone(f,d,type='sine',v=0.3,f2=null,t0=0){if(!AC||muted)return;const t=AC.currentTime+t0,o=AC.createOscillator(),g=AC.createGain();o.type=type;o.frequency.setValueAtTime(f,t);if(f2)o.frequency.exponentialRampToValueAtTime(f2,t+d);g.gain.setValueAtTime(v,t);g.gain.exponentialRampToValueAtTime(0.001,t+d);o.connect(g);g.connect(master);o.start(t);o.stop(t+d+0.02)}
function noise(d,v=0.3,hp=800){if(!AC||muted)return;const n=AC.sampleRate*d|0,b=AC.createBuffer(1,n,AC.sampleRate),a=b.getChannelData(0);for(let i=0;i<n;i++)a[i]=(Math.random()*2-1)*(1-i/n);const s=AC.createBufferSource();s.buffer=b;const f=AC.createBiquadFilter();f.type='highpass';f.frequency.value=hp;const g=AC.createGain();g.gain.value=v;s.connect(f);f.connect(g);g.connect(master);s.start()}
const sfx={draw:()=>tone(120,0.5,'sawtooth',0.06,260),loose:()=>{noise(0.25,0.35,1500);tone(900,0.12,'triangle',0.15,300)},
 hit:()=>{tone(520,0.12,'square',0.15,260);tone(880,0.2,'sine',0.2,0,0.04)},coin:()=>[880,1175,1568,2093].forEach((f,i)=>tone(f,0.18,'sine',0.2,0,i*0.06)),
 bad:()=>{tone(180,0.4,'sawtooth',0.25,60);noise(0.3,0.2,200)},miss:()=>noise(0.15,0.08,3000),end:()=>[523,659,784,1047].forEach((f,i)=>tone(f,0.4,'triangle',0.2,0,i*0.12))};
function startMusic(){ // simple synth bass + arp loop
  const bpm=104,step=60/bpm/2;let i=0;const notes=[55,55,65.4,55,73.4,55,65.4,49];const arp=[220,261.6,329.6,392,329.6,261.6];
  setInterval(()=>{if(!AC||muted||AC.state!=='running'||state!=='play')return;const n=notes[i%8];tone(n,step*1.6,'sawtooth',0.06,0,0);if(i%2===0)tone(arp[(i/2)%arp.length|0]*(i%16<8?1:1.5),step*1.4,'triangle',0.035);if(i%4===0)tone(60,0.18,'sine',0.25,38);if(i%4===2)noise(0.06,0.06,6000);i++},step*1000)}
$('mute').onclick=e=>{e.stopPropagation();muted=!muted;$('mute').textContent=muted?'SOUND OFF':'SOUND ON';if(bgm)bgm.muted=muted};

/* ---------- loading ---------- */
const gl=new GLTFLoader();gl.setMeshoptDecoder(MeshoptDecoder);
let loaded=0;const total=LITE?14:16;const bar=$('bar').firstElementChild;
const load=u=>new Promise((res,rej)=>gl.load(u,g=>{loaded++;bar.style.width=(loaded/total*100)+'%';res(g)},undefined,rej));
const A={};
let stag,mixer,acts={},bones={};
const STAG_H=2.3;
const targetsDef={green:{r:1.6,pts:10,scale:1.5},red:{r:1.6,pts:-15,scale:1.5},gold:{r:1.7,pts:50,scale:1.4}};

async function boot(){
  const [s,bow,arrow,tg,tr,tgold]=await Promise.all(['stag_game','bow','arrow','target_green','target_red','target_gold'].map(n=>load(`./assets/${n}.glb`)));
  const FN=['oak_big_s','oak_mid_s','pine_s','ferns_s','mushrooms_s','log_s','arch_s','boulder','banner','range'].filter(n=>!(LITE&&(n==='ferns_s'||n==='mushrooms_s')));const FG=await Promise.all(FN.map(n=>load(`./assets/forest/${n}.glb`)));const F={};FN.forEach((n,i)=>F[n.replace(/_s$/,'')]=FG[i].scene);buildForest(F);
  A.arrow=arrow.scene;A.bow=bow.scene;A.tg=tg.scene;A.tr=tr.scene;A.gold=tgold.scene;
  // stag
  stag=new THREE.Group();const m=s.scene;stag.add(m);
  const box=new THREE.Box3().setFromObject(m);const h=box.max.y-box.min.y;const sc=STAG_H/h;m.scale.setScalar(sc);m.position.y=-box.min.y*sc;
  m.traverse(o=>{if(o.isMesh||o.isSkinnedMesh){o.castShadow=true;o.receiveShadow=true;o.frustumCulled=false;if(o.material){o.material.envMapIntensity=1}}if(o.isBone)bones[o.name]=o});
  stag.userData.model=m;scene.add(stag);stag.rotation.y=Math.PI/2;
  mixer=new THREE.AnimationMixer(m);s.animations.forEach(a=>{acts[a.name]=mixer.clipAction(a)});
  acts.idle.play();mixer.update(0);stag.updateMatrixWorld(true);
  {const V=new THREE.Vector3();const yOf=n=>{bones[n].getWorldPosition(V);return V.y};const top=yOf('head_end'),toe=Math.min(yOf('LeftToeBase'),yOf('RightToeBase'));
   const f=STAG_H/(top-toe);m.scale.multiplyScalar(f);m.position.y=-toe*f;stag.updateMatrixWorld(true)}
  // bow in left hand
  const lh=bones.LeftHand;
  if(lh){bowObj=A.bow.clone(true);bowObj.traverse(o=>{if(o.isMesh)o.castShadow=true});
    const bb=new THREE.Box3().setFromObject(bowObj);const bs=1.5/(bb.max.y-bb.min.y);
    bowHolder=new THREE.Group();bowHolder.add(bowObj);lh.add(bowHolder);lh.updateWorldMatrix(true,true);{const w=new THREE.Vector3();bowHolder.getWorldScale(w);bowObj.scale.setScalar(bs/w.x)}bowHolder.visible=false;}
  const rh=bones.RightHand;
  if(rh){nockArrow=A.arrow.clone(true);arrowHolder=new THREE.Group();arrowHolder.add(nockArrow);const ab=new THREE.Box3().setFromObject(nockArrow);const as=1.1/(ab.max.x-ab.min.x);rh.add(arrowHolder);rh.updateWorldMatrix(true,true);{const w=new THREE.Vector3();arrowHolder.getWorldScale(w);nockArrow.scale.setScalar(as/w.x)}arrowHolder.visible=false}
  window.__bones=bones;window.__dbg={get bow(){return bowHolder},get arr(){return arrowHolder}};
  $('load').style.display='none';$('menu').style.display='flex';
  $('best').textContent=best?`BEST: ${best}`:'';
  ready=true;
}
let bowObj,bowHolder,nockArrow,arrowHolder,ready=false;

/* ---------- state ---------- */
let state='menu'; // menu|play|end
let best=0;try{best=+localStorage.getItem('stagshot_best')||0}catch(e){}
let score=0,combo=0,timeLeft=60,kills=0,shots=0,hits=0,popT=0;
const aim={yaw:0,pitch:0.08,ty:0,tp:0.08};
let drawing=false,drawT=0,power=0,releaseT=-1,pointer={x:0.5,y:0.5,down:false},poseState='idle',fireQueued=false;

/* ---------- targets ---------- */
const targets=[];
const trails=[];
function makeTarget(type){
  const src=type==='green'?A.tg:type==='red'?A.tr:A.gold;const root=new THREE.Group();const m=src.clone(true);const d=targetsDef[type];m.scale.setScalar(d.scale);
  m.traverse(o=>{if(o.isMesh){o.castShadow=true;o.material=o.material.clone();if(o.material.map){o.material.emissiveMap=o.material.map;o.material.emissive=new THREE.Color(0xffffff);o.material.emissiveIntensity=0.6}}});
  root.add(m);
  // neon halo ring on floor beneath
  const col=type==='green'?0x39ff88:type==='red'?0xff3b5c:0xffd23f;
  const ring=new THREE.Mesh(new THREE.TorusGeometry(1.5,0.07,12,48),new THREE.MeshBasicMaterial({color:col,transparent:true,opacity:0.8,fog:false}));ring.rotation.x=Math.PI/2;root.add(ring);
  const l=LITE?{intensity:0}:new THREE.PointLight(col,type==='gold'?5:4,7,2);if(!LITE)root.add(l);
  root.userData={type,def:d,ring,model:m,light:l,age:0,life:7+Math.random()*4,state:'in',t:0,mv:null,flash:0};
  scene.add(root);return root;
}
function placeTarget(t){
  const u=t.userData;const portrait=innerWidth/innerHeight<1;const z=-((portrait?8:12)+Math.random()*(portrait?15:26));const lim=Math.min(13,3+(-z)*0.3);
  const x=(Math.random()*2-1)*lim;const y=1.4+Math.random()*(5+(-z)*0.06);
  u.base=new THREE.Vector3(x,y,z);u.age=0;u.state='in';u.t=0;u.life=(u.type==='gold'?4.5:7)+Math.random()*4;
  u.mv={amp:u.type==='green'?0.6+Math.random()*1.2:u.type==='red'?2+Math.random()*3:3+Math.random()*4,spd:(u.type==='gold'?1.6:0.7)+Math.random()*0.8,ph:Math.random()*6.28,bob:0.25+Math.random()*0.4};
  u.ring.position.set(0,-y+0.04,0);u.pos=u.base.clone();t.position.copy(u.pos);t.scale.setScalar(0.001);t.visible=true;
}
function pickType(){const r=Math.random();return r<0.22?'red':r<0.37?'gold':'green'}
function spawnTarget(){const t=makeTarget(pickType());placeTarget(t);targets.push(t)}
function clearTargets(){targets.forEach(t=>scene.remove(t));targets.length=0}
function killTarget(t,hitType){const i=targets.indexOf(t);if(i>=0)targets.splice(i,1);scene.remove(t);setTimeout(()=>{if(state==='play'&&targets.length<TARGET_COUNT)spawnTarget()},350)}
const TARGET_COUNT=6;

/* ---------- particles ---------- */
const PN=900;const pPos=new Float32Array(PN*3),pCol=new Float32Array(PN*3),pVel=new Float32Array(PN*3),pLife=new Float32Array(PN);let pHead=0;
const pGeo=new THREE.BufferGeometry();pGeo.setAttribute('position',new THREE.BufferAttribute(pPos,3));pGeo.setAttribute('color',new THREE.BufferAttribute(pCol,3));
const pMat=new THREE.PointsMaterial({size:0.22,vertexColors:true,transparent:true,blending:THREE.AdditiveBlending,depthWrite:false,sizeAttenuation:true});
const points=new THREE.Points(pGeo,pMat);points.frustumCulled=false;scene.add(points);
for(let i=0;i<PN;i++){pPos[i*3+1]=-999}
function burst(p,color,n=60,speed=7){const c=new THREE.Color(color);for(let k=0;k<n;k++){const i=pHead++%PN;pPos[i*3]=p.x;pPos[i*3+1]=p.y;pPos[i*3+2]=p.z;
  const a=Math.random()*Math.PI*2,b=Math.acos(2*Math.random()-1),s=speed*(0.3+Math.random());pVel[i*3]=Math.sin(b)*Math.cos(a)*s;pVel[i*3+1]=Math.cos(b)*s;pVel[i*3+2]=Math.sin(b)*Math.sin(a)*s;
  pCol[i*3]=c.r;pCol[i*3+1]=c.g;pCol[i*3+2]=c.b;pLife[i]=0.6+Math.random()*0.7}}
function stepParticles(dt){for(let i=0;i<PN;i++){if(pLife[i]>0){pLife[i]-=dt;pVel[i*3+1]-=9*dt;pPos[i*3]+=pVel[i*3]*dt;pPos[i*3+1]+=pVel[i*3+1]*dt;pPos[i*3+2]+=pVel[i*3+2]*dt;const f=Math.max(pLife[i],0);pCol[i*3]*=0.985;pCol[i*3+1]*=0.985;pCol[i*3+2]*=0.985;if(pLife[i]<=0)pPos[i*3+1]=-999}}
  pGeo.attributes.position.needsUpdate=true;pGeo.attributes.color.needsUpdate=true}

const arcGeo=new THREE.BufferGeometry();const ARC_N=34;arcGeo.setAttribute('position',new THREE.BufferAttribute(new Float32Array(ARC_N*3),3));
const arc=new THREE.Line(arcGeo,new THREE.LineDashedMaterial({color:0x9fffc8,dashSize:0.5,gapSize:0.35,transparent:true,opacity:0.8,fog:false}));arc.frustumCulled=false;arc.visible=false;scene.add(arc);
function updateArc(){const a=aim.yaw,p=aim.pitch;const dir=new THREE.Vector3(-Math.sin(a)*Math.cos(p),Math.sin(p),-Math.cos(a)*Math.cos(p)).normalize();
  const speed=38+power*42;const pos=new THREE.Vector3(0,1.55,0).addScaledVector(dir,1.0);const v=dir.multiplyScalar(speed);const arr=arcGeo.attributes.position.array;
  for(let i=0;i<ARC_N;i++){arr[i*3]=pos.x;arr[i*3+1]=pos.y;arr[i*3+2]=pos.z;for(let k=0;k<2;k++){v.y-=GRAV*0.011;pos.addScaledVector(v,0.011)}}
  arcGeo.attributes.position.needsUpdate=true;arc.computeLineDistances();arc.visible=true}
/* ---------- arrows ---------- */
const arrows=[];const GRAV=7.5;
const X=new THREE.Vector3(1,0,0);
function shootArrow(){
  if(!A.arrow)return;
  const a=aim.yaw,p=aim.pitch;const dir=new THREE.Vector3(-Math.sin(a)*Math.cos(p),Math.sin(p),-Math.cos(a)*Math.cos(p)).normalize();
  const start=new THREE.Vector3(0,1.55,0).addScaledVector(dir,1.0).add(new THREE.Vector3(Math.cos(a)*0.0,0,0));
  const speed=38+power*42;const obj=A.arrow.clone(true);const ab=new THREE.Box3().setFromObject(obj);const k=1.6/(ab.max.x-ab.min.x);obj.scale.setScalar(k);obj.traverse(o=>{if(o.isMesh)o.castShadow=true});
  obj.position.copy(start);obj.quaternion.setFromUnitVectors(X,dir);scene.add(obj);
  const trail=makeTrail();
  arrows.push({obj,pos:start.clone(),prev:start.clone(),vel:dir.multiplyScalar(speed),life:0,stuck:false,t:0,trail,target:null});shots++;sfx.loose();
}
function makeTrail(){const n=24;const g=new THREE.BufferGeometry();const pos=new Float32Array(n*3);g.setAttribute('position',new THREE.BufferAttribute(pos,3));const l=new THREE.Line(g,new THREE.LineBasicMaterial({color:0x7fffc0,transparent:true,opacity:0.8,blending:THREE.AdditiveBlending,fog:false}));l.frustumCulled=false;scene.add(l);return {l,pos,n,hist:[]}}
function stepArrows(dt){
  for(let i=arrows.length-1;i>=0;i--){const a=arrows[i];a.life+=dt;
    if(a.stuck){a.t+=dt;if(a.target&&a.target.parent){a.obj.position.copy(a.target.position).add(a.off)}if(a.t>1.2||a.life>6){scene.remove(a.obj);scene.remove(a.trail.l);arrows.splice(i,1)}else if(a.t>0.7){a.obj.scale.multiplyScalar(0.94)}trailStep(a,dt,false);continue}
    a.prev.copy(a.pos);a.vel.y-=GRAV*dt;a.pos.addScaledVector(a.vel,dt);
    a.obj.position.copy(a.pos);a.obj.quaternion.setFromUnitVectors(X,a.vel.clone().normalize());
    trailStep(a,dt,true);
    // hit tests
    let hitT=null,hitD=1e9;
    for(const t of targets){const u=t.userData;if(u.state==='out')continue;const r=u.def.r*(u.type==='gold'?1:1)*1.0;const c=t.position;
      const d=segSphere(a.prev,a.pos,c,r);if(d>=0&&d<hitD){hitD=d;hitT=t}}
    if(false && window.__dbgHit){let m=1e9;for(const t of targets)m=Math.min(m,a.pos.distanceTo(t.position));a.minD=Math.min(a.minD??1e9,m);window.__md=a.minD;window.__ap=a.pos.toArray();window.__av=a.vel.toArray()}
    if(hitT){onHit(hitT,a);continue}
    if(a.pos.y<0.02){a.pos.y=0.02;a.stuck=true;a.t=0;a.obj.position.copy(a.pos);burst(a.pos,0x9fbfff,10,2.5);if(a.life>0.05){sfx.miss();combo=0;updateHUD()}}
    else if(a.pos.z<-190||Math.abs(a.pos.x)>120||a.life>8){scene.remove(a.obj);scene.remove(a.trail.l);arrows.splice(i,1);combo=0;updateHUD()}
  }
}
function trailStep(a,dt,live){const T=a.trail;if(live){T.hist.unshift(a.pos.clone())}else T.hist.unshift(T.hist[0]||a.pos.clone());if(T.hist.length>T.n)T.hist.pop();for(let i=0;i<T.n;i++){const p=T.hist[Math.min(i,T.hist.length-1)];T.pos[i*3]=p.x;T.pos[i*3+1]=p.y;T.pos[i*3+2]=p.z}T.l.geometry.attributes.position.needsUpdate=true;if(!live)T.l.material.opacity=Math.max(0,T.l.material.opacity-dt*2)}
function segSphere(p0,p1,c,r){const d=p1.clone().sub(p0);const f=p0.clone().sub(c);const A_=d.dot(d),B=2*f.dot(d),C=f.dot(f)-r*r;if(A_<1e-9)return C<=0?0:-1;let disc=B*B-4*A_*C;if(disc<0)return -1;disc=Math.sqrt(disc);const t1=(-B-disc)/(2*A_),t2=(-B+disc)/(2*A_);if(t1>=0&&t1<=1)return t1;if(t1<0&&t2>=0)return 0;return -1}

function onHit(t,a){
  const u=t.userData;const type=u.type;a.stuck=true;a.t=0;a.target=null;
  burst(t.position,type==='green'?0x39ff88:type==='red'?0xff3b5c:0xffd23f,type==='gold'?110:70,type==='gold'?10:7);
  const col=type==='green'?'#39ff88':type==='red'?'#ff3b5c':'#ffd23f';
  let pts;
  if(type==='red'){hap('n','error');combo=0;pts=u.def.pts;score=Math.max(0,score+pts);sfx.bad();shake=0;stagHit();showPop(`${pts}`,col,t.position)}
  else{hap(type==='gold'?'n':'i',type==='gold'?'success':'rigid');combo++;const mult=1+Math.min(combo-1,9)*0.5|0||1;const m2=Math.min(1+Math.floor((combo-1)/3),5);pts=u.def.pts*m2;score+=pts;hits++;if(type==='gold'){timeLeft=Math.min(timeLeft+2,90);sfx.coin()}else sfx.hit();showPop(`+${pts}${type==='gold'?'  +2s':''}`,col,t.position);if(combo>=3&&combo%3===0)stagVictory()}
  // arrow sticks into world at hit point and fades
  a.obj.position.copy(a.pos);
  // remove target
  killTarget(t);updateHUD();
}
let shake=0; // (no camera shake by design)

/* ---------- stag animation control ---------- */
function fadeTo(name,fade=0.18,time=null,ts=1,loop=true){const next=acts[name];if(!next)return;Object.entries(acts).forEach(([k,a])=>{if(a!==next&&a.isRunning())a.fadeOut(fade)});next.reset();if(time!=null)next.time=time;next.setEffectiveTimeScale(ts);next.setEffectiveWeight(1);next.setLoop(loop?THREE.LoopRepeat:THREE.LoopOnce,Infinity);next.clampWhenFinished=!loop;next.fadeIn(fade).play();}
function beginDraw(){if(poseState==='draw')return;hap('i','light');poseState='draw';drawing=true;drawT=0;power=0;fadeTo('shot',0.15,2.0,1,false);sfx.draw();if(bowHolder)bowHolder.visible=true;if(arrowHolder)arrowHolder.visible=true;setBackBow(false)}
function endDraw(fire){
  if(poseState!=='draw')return;drawing=false;
  if(fire&&power>0.12){poseState='release';releaseT=0;const a=acts.shot;a.time=3.85;a.setEffectiveTimeScale(2.2);a.paused=false;shootArrow();hap('i','medium');if(arrowHolder)arrowHolder.visible=false}
  else{backToIdle()}
}
function backToIdle(){poseState='idle';fadeTo('idle',0.25,null,1,true);if(bowHolder)bowHolder.visible=false;if(arrowHolder)arrowHolder.visible=false;setBackBow(true)}
function stagVictory(){if(poseState!=='idle')return;poseState='react';fadeTo('victory',0.12,0,1,false);setTimeout(()=>{if(poseState==='react')backToIdle()},1500)}
function stagHit(){if(poseState==='draw')return;poseState='react';fadeTo('hit',0.1,0,1,false);setTimeout(()=>{if(poseState==='react')backToIdle()},1800)}
let backBowMeshes=null;
function setBackBow(v){} // the model's own back-mounted bow/quiver stays as part of the mesh

const _q=new THREE.Quaternion(),_q2=new THREE.Quaternion(),_v=new THREE.Vector3(),_d=new THREE.Vector3();
function orientHeld(){
  stag.updateMatrixWorld(true);
  const dir=_d.set(-Math.sin(aim.yaw)*Math.cos(aim.pitch),Math.sin(aim.pitch),-Math.cos(aim.yaw)*Math.cos(aim.pitch)).normalize();
  // bow: curve axis along shot direction, limbs vertical
  const lh=bowHolder.parent;lh.getWorldQuaternion(_q);_q2.setFromEuler(new THREE.Euler(aim.pitch*0.0,0,0));
  const qw=new THREE.Quaternion().copy(stag.quaternion);bowHolder.quaternion.copy(_q.invert().multiply(qw));
  if(arrowHolder&&arrowHolder.visible){const rh=arrowHolder.parent;rh.getWorldQuaternion(_q);const qa=new THREE.Quaternion().setFromUnitVectors(X,dir);arrowHolder.quaternion.copy(_q.invert().multiply(qa));
    rh.getWorldPosition(_v);_v.addScaledVector(dir,0.45);arrowHolder.position.copy(rh.worldToLocal(_v.clone()))}
}
/* ---------- HUD ---------- */
function updateHUD(){$('score').textContent=score;const m=Math.min(1+Math.floor((combo-1)/3),5);$('combo').textContent=`COMBO ${combo}  x${combo>0?m:1}`;$('combo').style.opacity=combo>1?1:0;$('time').textContent=Math.ceil(timeLeft)}
const projV=new THREE.Vector3();
function showPop(txt,col,world){projV.copy(world).project(camera);const el=$('pop');el.textContent=txt;el.style.color=col;el.style.left=((projV.x*0.5+0.5)*innerWidth)+'px';el.style.top=((-projV.y*0.5+0.5)*innerHeight)+'px';el.style.transition='none';el.style.opacity=1;el.style.transform='translate(-50%,-50%) scale(1.4)';requestAnimationFrame(()=>requestAnimationFrame(()=>{el.style.transition='all .8s ease-out';el.style.opacity=0;el.style.transform='translate(-50%,-220%) scale(1)'}))}

/* ---------- Telegram Mini App extras ---------- */
let tiltOn=false,tiltBase=null;
if(TW){
  if(TW.DeviceOrientation&&TW.DeviceOrientation.start){$('tilt').style.display='block';
    $('tilt').onclick=e=>{e.stopPropagation();tiltOn=!tiltOn;$('tilt').textContent='TILT AIM: '+(tiltOn?'ON':'OFF');
      if(tiltOn){try{TW.DeviceOrientation.start({refresh_rate:60,need_absolute:false},ok=>{if(ok){tiltBase={a:TW.DeviceOrientation.alpha,b:TW.DeviceOrientation.beta}}else{tiltOn=false;$('tilt').textContent='TILT AIM: OFF'}})}catch(err){tiltOn=false;$('tilt').textContent='TILT AIM: OFF'}}
      else{try{TW.DeviceOrientation.stop()}catch(err){}}}}
  $('tgx').style.display='block';
  try{TW.checkHomeScreenStatus&&TW.checkHomeScreenStatus(st=>{if(st==='missed'||st==='unknown'){$('home').style.display='inline-block';$('home').onclick=()=>TW.addToHomeScreen()}})}catch(e){}
  const post=(path,body)=>fetch(API+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(Object.assign({initData:TW.initData},body))}).then(r=>r.json());
  $('story').onclick=async()=>{try{
    const src=renderer.domElement;const c=document.createElement('canvas');c.width=720;c.height=1280;const g=c.getContext('2d');
    const sr=src.width/src.height,dr=c.width/c.height;let sw=src.width,sh=src.height,sx=0,sy=0;if(sr>dr){sw=sh*dr;sx=(src.width-sw)/2}else{sh=sw/dr;sy=(src.height-sh)/2}
    g.drawImage(src,sx,sy,sw,sh,0,0,c.width,c.height);const gr=g.createLinearGradient(0,0,0,c.height);gr.addColorStop(0,'rgba(0,0,0,0.55)');gr.addColorStop(0.35,'rgba(0,0,0,0)');gr.addColorStop(0.7,'rgba(0,0,0,0)');gr.addColorStop(1,'rgba(0,0,0,0.65)');g.fillStyle=gr;g.fillRect(0,0,c.width,c.height);
    g.textAlign='center';g.fillStyle='#39ff88';g.font='900 110px Impact,Arial Black,sans-serif';g.shadowColor='#39ff88';g.shadowBlur=30;g.fillText('STAG SHOT',360,150);g.shadowBlur=0;
    g.fillStyle='#ffd23f';g.font='900 220px Impact,Arial Black,sans-serif';g.fillText(String(score),360,1090);g.fillStyle='#fff';g.font='700 42px system-ui,sans-serif';g.fillText('SCORE · BEAT ME',360,1160);g.font='600 34px system-ui,sans-serif';g.fillText('t.me/stagzbuybot/Play',360,1230);
    const r=await post('/api/card',{image:c.toDataURL('image/jpeg',0.82)});
    if(r.ok&&TW.shareToStory)TW.shareToStory(r.url,{text:'I scored '+score+' in Stag Shot 🏹 Beat me: t.me/stagzbuybot/Play',widget_link:{url:'https://t.me/stagzbuybot/Play',name:'Play Stag Shot'}});
    else TW.showAlert('Could not make the story card. Try again.')}catch(e){try{TW.showAlert('Story sharing is not available here.')}catch(x){}}};
  $('chal').onclick=async()=>{try{const r=await post('/api/prepare',{score});if(r.ok&&TW.shareMessage)TW.shareMessage(r.id);else TW.showAlert('Could not prepare the challenge.')}catch(e){}};
  $('wear').onclick=()=>{try{TW.requestEmojiStatusAccess(ok=>{if(ok)TW.setEmojiStatus('5141324265630468031',{},()=>{});else TW.showAlert('Needs Telegram Premium and your permission.')})}catch(e){try{TW.showAlert('Emoji status is not available here.')}catch(x){}}};
}
/* ---------- input ---------- */
function setPointer(e){pointer.x=e.clientX/innerWidth;pointer.y=e.clientY/innerHeight}
canvas.addEventListener('pointermove',e=>{setPointer(e)});
addEventListener('pointerdown',e=>{if(e.target.closest('button,a'))return;audioInit();if(state!=='play')return;setPointer(e);pointer.down=true;beginDraw()});
addEventListener('pointerup',e=>{if(!pointer.down)return;pointer.down=false;if(state==='play')endDraw(true)});
addEventListener('pointercancel',()=>{pointer.down=false;if(state==='play')endDraw(false)});
addEventListener('keydown',e=>{if(e.code==='Space'&&state==='play'&&!pointer.down){pointer.down=true;beginDraw()}if(e.code==='Enter'&&state!=='play'&&ready)startGame()});
addEventListener('keyup',e=>{if(e.code==='Space'&&pointer.down){pointer.down=false;if(state==='play')endDraw(true)}});
canvas.addEventListener('contextmenu',e=>e.preventDefault());
$('play').onclick=()=>{audioInit();startGame()};$('again').onclick=()=>{audioInit();startGame()};

function startGame(){
  playMusic();try{if(TW&&TW.requestFullscreen&&!TW.isFullscreen)TW.requestFullscreen()}catch(e){}
  state='play';score=0;combo=0;timeLeft=60;shots=0;hits=0;clearTargets();arrows.forEach(a=>{scene.remove(a.obj);scene.remove(a.trail.l)});arrows.length=0;
  for(let i=0;i<TARGET_COUNT;i++)spawnTarget();
  $('menu').style.display='none';$('end').style.display='none';$('hud').style.display='block';updateHUD();backToIdle();
}
function endGame(){
  state='end';if(pointer.down){pointer.down=false;endDraw(false)}
  let top=[];try{top=JSON.parse(localStorage.getItem('stagshot_top')||'[]')}catch(e){}top.push(score);top=top.sort((x,y)=>y-x).slice(0,5);try{localStorage.setItem('stagshot_top',JSON.stringify(top))}catch(e){}
  const isBest=score>best;if(isBest){best=score;try{localStorage.setItem('stagshot_best',best)}catch(e){}}
  $('big').textContent=score;const acc=shots?Math.round(hits/shots*100):0;
  $('endmsg').textContent=`${hits} ${hits===1?'hit':'hits'} from ${shots} ${shots===1?'arrow':'arrows'} (${acc}% accuracy). ${isBest?'NEW BEST!':'Best: '+best}  ·  Your top 5: ${top.join(' · ')}`;
  const txt=encodeURIComponent(`I scored ${score} in Stag Shot — 3D forest archery by $STAG. Beat it:`);
  $('share').href=`https://twitter.com/intent/tweet?text=${txt}&url=${encodeURIComponent(location.href.split('?')[0])}`;
  try{const tw=window.Telegram&&window.Telegram.WebApp;if(tw&&tw.initData){fetch('https://buybot.stagwifhood.fun/api/score',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({initData:tw.initData,score})}).then(r=>r.json()).then(j=>{if(j&&j.ok)$('endmsg').textContent+='  ·  Today\'s rank: #'+j.rank}).catch(()=>{})}}catch(e){}
  sfx.end();$('hud').style.display='none';$('end').style.display='flex';$('best').textContent=`BEST: ${best}`;
  fadeTo('victory',0.2,0,1,false);setTimeout(()=>{if(state==='end')fadeTo('idle',0.3)},1800);
}

/* ---------- main loop ---------- */
let dynAcc=0,dynN=0;const clock=new THREE.Clock();let fpsAcc=0,fpsN=0,quality=true,tAll=0;
const camPos=new THREE.Vector3(2,3,6),camLook=new THREE.Vector3(0,1.6,-10);
function frame(){
  requestAnimationFrame(frame);const raw=clock.getDelta();const dt=Math.min(raw,0.05);tAll+=dt;
  dynAcc+=raw;dynN++;if(dynAcc>1.2&&tAll>3){const avg=dynAcc/dynN;dynAcc=0;dynN=0;if(avg>0.034&&pr>0.55){pr=Math.max(0.55,pr*0.82);resize()}else if(avg<0.019&&pr<PR_MAX){pr=Math.min(PR_MAX,pr*1.12);resize()}}
  if(!ready){return}
  // auto quality
  if(tAll>2&&tAll<6){fpsAcc+=dt;fpsN++}else if(tAll>=6&&quality){quality=false;const avg=fpsAcc/fpsN;if(avg>1/34){if(avg>1/22){detail.visible=false;pr=Math.max(0.75,pr*0.7);useBloom=false;renderer.shadowMap.enabled=false;scene.traverse(o=>{if(o.material)o.material.needsUpdate=true})}else{useBloom=false}resize()}}
  // aim from pointer, or from the phone's tilt inside Telegram
  if(state==='play'&&tiltOn&&tiltBase&&TW&&TW.DeviceOrientation&&TW.DeviceOrientation.isStarted){
    let da=TW.DeviceOrientation.alpha-tiltBase.a;da=((da+540)%360)-180;
    aim.ty=Math.max(-0.75,Math.min(0.75,da/50*0.75));
    aim.tp=0.14+Math.max(-0.25,Math.min(0.3,(tiltBase.b-TW.DeviceOrientation.beta)/60*0.4));
  }
  else if(state==='play'){aim.ty=-(pointer.x-0.5)*2*0.75;aim.tp=0.02+(0.5-pointer.y)*0.5+0.12}
  else{aim.ty=Math.sin(tAll*0.3)*0.2;aim.tp=0.1}
  aim.yaw+=(aim.ty-aim.yaw)*Math.min(1,dt*10);aim.pitch+=(aim.tp-aim.pitch)*Math.min(1,dt*10);
  aim.pitch=Math.max(-0.1,Math.min(0.55,aim.pitch));
  stag.rotation.y=Math.PI/2+aim.yaw;
  // draw control
  if(poseState==='draw'){drawT+=dt;power=Math.min(1,drawT/0.9);const a=acts.shot;
    const t=2.0+Math.min(drawT,0.55)*1.0;a.time=Math.min(t,2.55+Math.sin(drawT*14)*0.0);a.paused=false;a.timeScale=1;if(a.time>=2.6){a.time=2.6;a.timeScale=0}
    $('pow').firstElementChild.style.width=(power*100)+'%'}
  else if(poseState==='release'){releaseT+=dt;if(releaseT>0.42){backToIdle();$('pow').firstElementChild.style.width='0%'}}
  else $('pow').firstElementChild.style.width='0%';
  mixer.update(dt);
  if(bowHolder&&bowHolder.visible)orientHeld();
  // clamp shot during hold
  if(poseState==='draw'&&acts.shot.time>=2.6){acts.shot.time=2.6}
  // timer
  if(state==='play'){timeLeft-=dt;if(timeLeft<=0){timeLeft=0;updateHUD();endGame()}else{if(Math.ceil(timeLeft)!==+$('time').textContent)updateHUD()}}
  // targets
  for(const t of targets){const u=t.userData;u.age+=dt;u.t+=dt;
    const m=u.mv;const diff=1+(60-Math.min(60,timeLeft))/60*0.9;let off=new THREE.Vector3();
    if(u.type==='green'){off.set(Math.sin(u.t*m.spd*diff+m.ph)*m.amp,Math.sin(u.t*1.7+m.ph)*m.bob,0)}
    else if(u.type==='red'){off.set(Math.sin(u.t*m.spd*diff+m.ph)*m.amp,Math.sin(u.t*2+m.ph)*m.bob,0)}
    else{off.set(Math.sin(u.t*m.spd*diff+m.ph)*m.amp,Math.sin(u.t*m.spd*diff*1.3+m.ph)*m.amp*0.25,Math.cos(u.t*m.spd*diff+m.ph)*1.5)}
    t.position.copy(u.base).add(off);
    let sc=1;if(u.age<0.4)sc=u.age/0.4;else if(u.age>u.life-0.6){sc=Math.max(0.001,(u.life-u.age)/0.6);if(u.age>=u.life){u.state='out';scene.remove(t);targets.splice(targets.indexOf(t),1);setTimeout(()=>{if(state==='play')spawnTarget()},300);continue}}
    t.scale.setScalar(sc*(1+Math.sin(u.t*3)*0.02));
    u.model.rotation.y=u.type==='gold'?u.t*2.2:Math.sin(u.t*0.8)*0.25;
    u.ring.position.y=-(t.position.y)+0.05;u.ring.scale.setScalar(1+0.1*Math.sin(u.t*4));
  }
  mists.forEach(m=>{m.position.x=m.userData.x0+Math.sin(tAll*0.05*m.userData.sp*6+m.userData.ph)*6});shafts.forEach(m=>{m.material.opacity=0.26+Math.sin(tAll*0.4+m.userData.ph)*0.08});
  {const a=flies.pos,b=flies.base;for(let i=0;i<b.length/3;i++){a[i*3]=b[i*3]+Math.sin(tAll*0.5+i)*0.8;a[i*3+1]=b[i*3+1]+Math.sin(tAll*0.9+i*1.7)*0.5;a[i*3+2]=b[i*3+2]+Math.cos(tAll*0.4+i*0.7)*0.8}flies.pts.geometry.attributes.position.needsUpdate=true}
  arc.visible=false;if(poseState==='draw'&&power>0.1)updateArc();
  stepArrows(dt);stepParticles(dt);
  // camera: smooth third-person behind-right of the archer, follows aim (no shake)
  const fwd=new THREE.Vector3(-Math.sin(aim.yaw),0,-Math.cos(aim.yaw));const right=new THREE.Vector3(Math.cos(aim.yaw),0,-Math.sin(aim.yaw)).multiplyScalar(-1).negate();
  const desired=new THREE.Vector3(0,0,0).addScaledVector(fwd,-5.0).addScaledVector(right,1.5);desired.y=2.7+(state==='menu'?0.6:0);
  const look=new THREE.Vector3(0,1.6,0).addScaledVector(fwd,18*Math.cos(aim.pitch));look.y=1.3+Math.sin(aim.pitch)*18;
  camPos.lerp(desired,Math.min(1,dt*6));camLook.lerp(look,Math.min(1,dt*8));
  camera.position.copy(camPos);camera.lookAt(camLook);
  moon.target.position.set(0,0,-20);
  if(window.__camOverride)window.__camOverride(camera);
  if(useBloom)composer.render();else renderer.render(scene,camera);
}
boot().catch(e=>{console.error(e);$('load').querySelector('h2').textContent='LOAD FAILED — '+e.message});
window.__g={endNow:()=>{timeLeft=0.01},get state(){return state},get score(){return score},aim,startGame,beginDraw,endDraw,targets,arrows,bones:()=>bones,pointer,setPose:(n)=>fadeTo(n),camera,scene,get power(){return power},setBloom:v=>useBloom=v};
requestAnimationFrame(frame);
