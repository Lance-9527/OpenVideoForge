/* Registered GLB assets and exact frame-based Blender renders. No generation API is called here. */
import * as THREE from 'three';
import { GLTFExporter } from './vendor/GLTFExporter.js?v=60';
import { sampleShots } from './timeline.js?v=75';
import { sha256Hex } from './sha256.js?v=1';

/* ★ 2026-11-09：VideoForge 服务端口**不写死**。
 *   · 老版 8765 / 新版 8798 —— 但新版 sidecar 默认用**随机端口**（实测 52056）。
 *   · 桥的 `wb_caps` 已经在扫了 ⇒ 这里直接问桥要地址。
 *   · ★ 2026-11-10：统一走 studio-endpoint.js（别的模块也用同一套解析）。
 */
import { studioBase, absStudioUrl, resolveStudioBase } from './studio-endpoint.js?v=77';
const FALLBACK_API = 'http://127.0.0.1:8765/api/studio';
let apiBase = null;
async function studioApiBase() {
  if (apiBase) return apiBase;
  try {
    await resolveStudioBase(true);
    const u = studioBase();
    if (u) { apiBase = u + '/api/studio'; return apiBase; }
  } catch (_) { /* 桥没起 → 用默认值 */ }
  apiBase = FALLBACK_API;
  return apiBase;
}
const basis = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0), Math.PI/2);
const inverseBasis = basis.clone().invert();
const editor = () => window.__wb?.editor;
const round = value => Math.round(value * 1e9) / 1e9;
export const toCanonicalPosition = p => [p[0], -p[2], p[1]].map(round);
export const fromCanonicalPosition = p => [p[0], p[2], -p[1]];
export const toCanonicalScale = s => [s[0],s[2],s[1]];
export function toCanonicalQuaternion(q) {
  return basis.clone().multiply(new THREE.Quaternion().fromArray(q)).multiply(inverseBasis).normalize().toArray().map(round);
}
function requiredEditor() { const e=editor(); if(!e) throw new Error('请先打开场景编辑器'); return e; }
async function api(path, options={}) {
  const base = await studioApiBase();
  const response=await fetch(base+path,options);
  const body=await response.json();
  if(!response.ok || body.code!=='000000') {
    // ★ 端口可能变了（sidecar 重启）⇒ 清缓存重试一次
    if (!options.__retry) {
      apiBase = null;
      const b2 = await studioApiBase();
      const r2 = await fetch(b2+path,{...options, __retry:true});
      const j2 = await r2.json();
      if (r2.ok && j2.code === '000000') return j2.data;
    }
    throw new Error(body.detail?.message || body.detail || body.message || '场景服务请求失败');
  }
  return body.data;
}
async function upload(file) {
  const form=new FormData();form.append('file',file);
  return api('/assets',{method:'POST',body:form});
}

/* ────────────────────────────────────────────────────────────────
 * 资产沉淀：内容哈希 → 已登记资产（**同内容只登记一次**）
 *
 * ★ 2026-10-26（用户：「要注重资产积累，再设计一下，后面生产过程中你生成的
 *   都最好存资产库，后面遇到类似的生产过程可以直接复用」）：
 *   以前每次导出场景都把环境/每个内置物体**重新导出成新 GLB 再上传**，
 *   于是资产库里堆出一堆 willow.glb×8、bench2.glb×7 这种重复条目 ——
 *   同一棵树存了 8 遍，下一个项目还得再存一遍。
 *   现在：
 *     ① 先算导出字节的 sha256；
 *     ② 命中本地索引（localStorage，重启也在）→ 直接复用已有 asset id，**不重复上传**；
 *     ③ 命中服务端资产列表（后端 upload 本身就是按内容哈希建目录的）→ 同样复用；
 *     ④ 都没命中才上传，并把 {hash → asset id} 记进索引。
 *   顺带把产物登记进「我的资产」库（studio-myassets.js 的 wb-my-assets），
 *   下次直接复用 —— 这就是"沉淀"。
 * ──────────────────────────────────────────────────────────────── */
const HASH_INDEX_KEY = 'wb-asset-hash-index-v1';

function hashIndex() {
  try { return JSON.parse(localStorage.getItem(HASH_INDEX_KEY) || '{}'); } catch (_) { return {}; }
}
function saveHashIndex(idx) {
  try {
    const keys = Object.keys(idx);
    if (keys.length > 400) {                     // 只留最近的 400 条，别把存储撑爆
      const sorted = keys.map(k => [k, idx[k]]).sort((a, b) => (b[1].at || 0) - (a[1].at || 0)).slice(0, 400);
      const next = {};
      for (const [k, v] of sorted) next[k] = v;
      idx = next;
    }
    localStorage.setItem(HASH_INDEX_KEY, JSON.stringify(idx));
  } catch (_) { /* 存储满了就算了，下次照常用 */ }
}
let assetListCache = null;
let assetListAt = 0;
/** 沉淀统计（复用 vs 新建）—— 给调试/体检看 */
const depositStats = { reused: 0, created: 0, last: null };
/** 已登记资产列表（短缓存：一次导出里多次命中不用反复打服务端） */
async function assetList(maxAgeMs = 5000) {
  const now = Date.now();
  if (assetListCache && now - assetListAt < maxAgeMs) return assetListCache;
  const data = await api('/assets');
  assetListCache = (data && data.assets) || [];
  assetListAt = now;
  return assetListCache;
}

/**
 * 把一段 GLB 字节"沉淀"进资产库：**同内容复用已有资产，不重复登记**。
 * 这是后端/Agent 想往资产库里"存东西"时的统一入口（deposit hook）。
 * @param bytes ArrayBuffer / Uint8Array（GLB 字节）
 * @param filename 展示用文件名
 * @param meta {source, role, skipLibrary} —— skipLibrary=true 时只进哈希索引，不进「我的资产」
 */
export async function depositArtifact(bytes, filename, meta = {}) {
  const buf = bytes instanceof Uint8Array ? bytes
    : (bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : new Uint8Array(bytes.buffer || bytes));
  const sha = sha256Hex(buf);
  const idx = hashIndex();
  let asset = null;
  let reused = false;
  // ① 本地索引命中 → 复用（顺便确认服务端还在，资产可能被手动删了）
  const known = idx[sha];
  if (known && known.id) {
    const list = await assetList();
    asset = list.find(a => a.id === known.id) || null;
    if (asset) reused = true; else delete idx[sha];
  }
  // ② 服务端按内容哈希命中 → 复用（后端 upload 就是按 sha 建目录的）
  if (!asset) {
    const list = await assetList();
    asset = list.find(a => a.sha256 && String(a.sha256).toLowerCase() === sha) || null;
    if (asset) reused = true;
  }
  // ③ 都没有 → 才真的上传
  if (!asset) {
    asset = await upload(new File([buf], filename, { type: 'model/gltf-binary' }));
  }
  idx[sha] = { id: asset.id, name: asset.name || filename, at: Date.now(), source: meta.source || 'previz-export' };
  saveHashIndex(idx);
  if (reused) depositStats.reused++; else depositStats.created++;
  depositStats.last = { name: asset.name || filename, sha256: sha, reused };
  // 登记进「我的资产」库 → 出现在「我的模型」里，可直接复用
  if (!meta.skipLibrary) {
    try {
      if (window.WBMyAssets && typeof window.WBMyAssets.add === 'function') {
        window.WBMyAssets.add({ id: asset.id, name: asset.name || filename, bytes: buf.length },
          { source: 'videoforge-previz', sha256: sha, role: meta.role || 'previz-export' });
      }
    } catch (_) { /* 我的资产库挂了不影响渲染 */ }
  }
  return { ...asset, sha256: asset.sha256 || sha, reused };
}

async function registerGeometry(group, name, meta = {}) {
  const glb=await new GLTFExporter().parseAsync(group,{binary:true,onlyVisible:true});
  if(!(glb instanceof ArrayBuffer)) throw new Error('GLB导出失败');
  return depositArtifact(glb, name+'.glb', meta);
}
export function cameraPosition(cam) {
  return [cam.t[0]+cam.r*Math.sin(cam.phi)*Math.sin(cam.theta),
    cam.t[1]+cam.r*Math.cos(cam.phi),cam.t[2]+cam.r*Math.sin(cam.phi)*Math.cos(cam.theta)];
}
function settings(options={}) {
  const saved=editor()?.studioRender||{};
  const fps=Number(options.fps??saved.fps??24);
  const seconds=options.seconds??window.__wb?.timeline?.totalDuration?.()??3;
  const frameCount=options.frame_count??(options.seconds!=null?Math.round(Number(seconds)*fps):saved.frame_count??Math.round(Number(seconds||3)*fps));
  const render={width:Number(options.width??saved.width??640),height:Number(options.height??saved.height??360),fps,frame_count:Number(frameCount)};
  for(const value of Object.values(render)) if(!Number.isInteger(value)||value<=0)throw new Error('渲染尺寸/帧率/帧数须是正整数');
  return render;
}
async function importAsset(args={}) {
  const e=requiredEditor();
  let asset=args.asset;
  if(!asset) {
    const list=(await api('/assets')).assets||[];
    asset=list.find(a=>a.id===args.asset_id);
  }
  if(!asset?.id)throw new Error('请指定已登记的GLB资产ID');
  const rec=await e.addExternalAsset(asset,args.instance||{});
  return {instance_id:rec.instanceId,asset_id:asset.id};
}
function setInstance(args={}) {
  const e=requiredEditor(),rec=e.objects.find(o=>o.instanceId===args.instance_id);
  if(!rec)throw new Error('找不到实例ID');
  if(args.position)rec.group.position.fromArray(fromCanonicalPosition(args.position));
  if(args.quaternion)rec.group.quaternion.copy(inverseBasis.clone().multiply(new THREE.Quaternion().fromArray(args.quaternion)).multiply(basis));
  if(args.scale)rec.group.scale.fromArray(toCanonicalScale(args.scale));
  e.select(rec);return {instance_id:rec.instanceId,position:toCanonicalPosition(rec.group.position.toArray()),quaternion:toCanonicalQuaternion(rec.group.quaternion.toArray()),scale:toCanonicalScale(rec.group.scale.toArray())};
}
async function exportScene(options={}) {
  const e=requiredEditor(),render=settings(options),assets=[],instances=[];
  // ★ 2026-11-10：VideoForge 的 id 只能是字母/数字/下划线/短横线
  //   （服务端会拒："ID只能包含字母、数字、下划线和短横线"）。
  //   资产库里的模型 id 是**中文名**（比如「站立的人4」）⇒ 提交渲染直接失败。
  //   所以统一在这里清洗，并保证**引用和资产登记用的是同一个 id**。
  const safeId=(id,fallback)=>String(id||'').replace(/[^A-Za-z0-9_-]/g,'').slice(0,64)||fallback;
  const add=(asset,id,group)=>{
    const aid=safeId(asset.id,'asset-'+(assets.length+1));
    if(!assets.some(a=>a.id===aid))assets.push({id:aid});
    instances.push({id,asset_id:aid,position:toCanonicalPosition(group.position.toArray()),quaternion:toCanonicalQuaternion(group.quaternion.toArray()),scale:toCanonicalScale(group.scale.toArray())});
  };
  // Built-in environment and assets become real registered GLBs too, so Blender receives the visible set.
  // ★ 同内容复用已有资产（sha256 去重），别每次都往资产库里塞重复条目
  if(e.envGroup.children.length) {
    const clone=e.envGroup.clone(true);clone.position.set(0,0,0);clone.quaternion.identity();clone.scale.set(1,1,1);
    const asset=await registerGeometry(clone,'environment-'+e.envId,{role:'previz-environment',skipLibrary:true});
    // ★ 2026-11-10：**实例 id 不用 'environment'**。
    //   VideoForge 的 render_scene.py 有一条"大场景跳过环境盒子"的规则：
    //     if 相机距离目标 > 500m and instance.id == 'environment': continue
    //   那条规则本来是给**电商棚拍**用的（跳过 80×80 米的影棚房间盒子）。
    //   但真实城市(OSM)的 environment 是**整个街区**（几千栋楼）⇒
    //   被一起跳过 ⇒ Blender 里只剩人影，画面一片灰（实测踩到）。
    //   换个 id 就绕开了，场景内容一点不少。
    add(asset,'world',e.envGroup);
  }
  for(const rec of e.objects) {
    rec.instanceId ||= crypto.randomUUID();
    let asset=rec.externalAsset;
    if(!asset) {
      const clone=rec.group.clone(true);clone.position.set(0,0,0);clone.quaternion.identity();clone.scale.set(1,1,1);
      asset=await registerGeometry(clone,'builtin-'+rec.assetId,{role:'previz-object'});
    } else if(!asset.__registered) {
      // ★ 2026-11-10：**外部模型也得先登记进 VideoForge**。
      //   之前直接拿资产库的中文 id 去引用 ⇒
      //   ① id 不合法，服务端直接拒提交
      //   ② 服务端根本没有这个资产，Blender 那边是空引用（渲染出来没有这个模型）
      //   现在把 GLB 传上去，拿到服务端生成的合法 id。
      try {
        const url = asset.file_url || (asset.url || '');
        if (url) {
          const r = await fetch(url);
          const buf = await r.arrayBuffer();
          const name = (asset.name || asset.id || 'model') + '.glb';
          const up = await upload(new File([buf], name, { type: 'model/gltf-binary' }));
          asset = Object.assign({}, asset, { id: up.id, name: up.name || asset.name, __registered: true });
        } else {
          asset = Object.assign({}, asset, { __registered: true });
        }
      } catch (_) {
        asset = Object.assign({}, asset, { __registered: true });
      }
    }
    add(asset,rec.instanceId,rec.group);
  }
  if(!instances.length)throw new Error('场景中没有可渲染的模型');
  const shots=window.__wb?.timeline?.getShots()||[];
  const total=shots.reduce((sum,s)=>sum+s.duration,0);
  const track=e.studioTracks?.camera;
  // ★ 2026-11-10：**轨迹比渲染帧数长时，自动把帧数扩到能覆盖整条轨迹**。
  //   之前这里是直接抛错："指定轨迹超出渲染帧数；请匹配帧数" ——
  //   用户画了 16 帧轨迹、时长又填了 1 秒（12fps ⇒ 12 帧）⇒ **拍不了**。
  //   现在以轨迹为准扩帧（时长随之变成 帧数/fps），轨迹一个关键帧都不丢。
  if (track?.keys?.length) {
    let lastFrame=0;
    for (const k of track.keys) { const f=Number(k.frame)||0; if (f>lastFrame) lastFrame=f; }
    if (lastFrame >= render.frame_count) {
      render.frame_count = lastFrame + 1;
    }
  }
  const keys=[];
  for(let frame=0;frame<render.frame_count;frame++) {
    const time=render.frame_count>1?frame/(render.frame_count-1)*total:0;
    const cam=sampleShots(shots,time)?.cam||e.captureCam();
    keys.push({frame,position:toCanonicalPosition(cameraPosition(cam)),target:toCanonicalPosition(cam.t),roll:0,vertical_fov:cam.fov});
  }
  // ★ 2026-11-10：scene_id 必须只含字母/数字/下划线/短横线 ——
  //   VideoForge 服务端会校验（"ID只能包含字母、数字、下划线和短横线"）。
  //   之前直接用 e.studioSceneId，而它可能来自场景存档里的中文名 ⇒ 提交被拒。
  //   现在**清洗 + 兜底**，保证任何情况下都能提交。
  const rawSceneId = e.studioSceneId || '';
  const safeSceneId = String(rawSceneId).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64)
    || 'scene-' + crypto.randomUUID();
  const scene={schema:'videoforge.scene/1',scene_id:safeSceneId,revision:(e.studioRevision||0)+1,
    coordinates:{up:'Z',handedness:'right',unit:'meter'},assets,instances,
    camera:track||{vertical_fov:(sampleShots(shots,0)?.cam||e.captureCam()).fov,keys},object_tracks:e.studioTracks?.object_tracks||[],render};
  await api('/scenes',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(scene)});
  e.studioSceneId=scene.scene_id;
  e.studioRevision=scene.revision;
  e.studioRender=structuredClone(render);
  return scene;
}
async function loadScene(args={}) {
  const e=requiredEditor();
  const scene=args.scene||(await api('/scenes/'+encodeURIComponent(args.scene_id)+(args.revision?'?revision='+Number(args.revision):''))).scene;
  if(scene?.schema!=='videoforge.scene/1')throw new Error('需要videoforge.scene/1');
  const assets=(await api('/assets')).assets||[];
  const required=scene.instances.map(instance=>({instance,asset:assets.find(a=>a.id===instance.asset_id)}));
  if(required.some(item=>!item.asset))throw new Error('部分GLB登记不存在，须先恢复资产目录');
  for(const device of [...(e.devices||[])])e.removeDevice(device.id);
  e._clearGroup(e.envGroup);e._clearGroup(e.assetGroup);e.objects=[];e.externalEnvironment=true;e.envId='external';
  for(const {instance,asset}of required)await e.addExternalAsset(asset,{instanceId:instance.id,p:fromCanonicalPosition(instance.position),
    q:inverseBasis.clone().multiply(new THREE.Quaternion().fromArray(instance.quaternion)).multiply(basis).toArray(),scale:toCanonicalScale(instance.scale)});
  e.studioSceneId=scene.scene_id;e.studioRevision=scene.revision;
  e.studioRender=structuredClone(scene.render);
  e.studioTracks={camera:structuredClone(scene.camera),object_tracks:structuredClone(scene.object_tracks||[])};
  window.__wb?.timeline?.setShots([]);preview({frame:0});
  return {scene_id:scene.scene_id,revision:scene.revision,instances:e.objects.length,frames:scene.render.frame_count};
}
function setTrack(args={}) {
  const e=requiredEditor();
  if(!args.camera?.keys?.length)throw new Error('camera.keys不能为空');
  if(args.camera.keys[0].frame!==0)throw new Error('轨迹须从第0帧开始');
  e.studioTracks={camera:structuredClone(args.camera),object_tracks:structuredClone(args.object_tracks||[])};
  if(args.render)e.studioRender=settings(args.render);
  return {camera_keys:args.camera.keys.length,object_tracks:e.studioTracks.object_tracks.length};
}
function orbit(options={}) {
  const e=requiredEditor(),render=settings(options),cam=e.captureCam(),keys=[];
  for(let frame=0;frame<render.frame_count;frame++) {
    const c={...cam,theta:cam.theta+(Number(options.turns)||1)*Math.PI*2*frame/Math.max(1,render.frame_count-1)};
    keys.push({frame,position:toCanonicalPosition(cameraPosition(c)),target:toCanonicalPosition(c.t),roll:0});
  }
  return setTrack({camera:{vertical_fov:cam.fov,keys},object_tracks:[],render});
}
async function render(options={}) {
  const scene=options.scene||await exportScene(options);
  const result=await api('/renders',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({scene,
    ...(options.project_id?{project_id:options.project_id}:{}),...(options.shot_id?{shot_id:options.shot_id}:{}),
    ...(options.idempotency_key?{idempotency_key:options.idempotency_key}:{})})});
  // v31：提交后立刻接管进度 HUD —— 用户和 Agent 看同一份实时状态
  try { if(result&&result.job_id&&window.WBRender)window.WBRender.watch(result.job_id); } catch(_) {}
  return result;
}
async function status({job_id}) {return api('/renders/'+encodeURIComponent(job_id));}
async function cancel({job_id}) {return api('/renders/'+encodeURIComponent(job_id)+'/cancel',{method:'POST'});}
async function bind({job_id,project_id,shot_id}) {return api('/renders/'+encodeURIComponent(job_id)+'/bind',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({project_id,shot_id})});}
export function sampleTrack(keys,frame,defaults={}) {
  if(!keys?.length)throw new Error('没有轨迹关键帧');
  keys=keys.map(key=>({...defaults,...key}));
  if(frame<=keys[0].frame)return structuredClone(keys[0]);
  for(let index=1;index<keys.length;index++) {
    const left=keys[index-1],right=keys[index];
    if(frame>right.frame)continue;
    const t=(frame-left.frame)/(right.frame-left.frame),result={frame};
    for(const name of ['position','target','scale'])if(left[name])result[name]=left[name].map((value,i)=>value+(right[name][i]-value)*t);
    for(const name of ['roll','vertical_fov'])if(left[name]!=null)result[name]=left[name]+((right[name]??left[name])-left[name])*t;
    if(left.quaternion)result.quaternion=new THREE.Quaternion().fromArray(left.quaternion).slerp(new THREE.Quaternion().fromArray(right.quaternion),t).normalize().toArray();
    return result;
  }
  return structuredClone(keys[keys.length-1]);
}
function preview({frame=0}={}) {
  if(!Number.isInteger(frame)||frame<0)throw new Error('预览帧须为非负整数');
  const e=requiredEditor(),track=e.studioTracks?.camera,key=sampleTrack(track?.keys,frame,{roll:0,vertical_fov:track?.vertical_fov??35});
  for(const objectTrack of e.studioTracks?.object_tracks||[]) {
    const pose=sampleTrack(objectTrack.keys,frame);
    setInstance({instance_id:objectTrack.instance_id,position:pose.position,quaternion:pose.quaternion,scale:pose.scale});
  }
  const p=fromCanonicalPosition(key.position),t=fromCanonicalPosition(key.target),offset=new THREE.Vector3(...p).sub(new THREE.Vector3(...t));
  const r=offset.length();if(r<1e-7)throw new Error('相机位置与目标不能重合');
  e.applyCamState({r,phi:Math.acos(Math.max(-1,Math.min(1,offset.y/r))),theta:Math.atan2(offset.x,offset.z),t,fov:key.vertical_fov??track.vertical_fov});
  e.camera.rotateZ(key.roll||0);
  return {frame,position:key.position,target:key.target};
}
const commands={'studio.asset.import':importAsset,'studio.instance.set':setInstance,'studio.scene.export':exportScene,'studio.scene.load':loadScene,
  'studio.track.set':setTrack,'studio.track.orbit':orbit,'studio.track.preview':preview,'studio.render.submit':render,
  'studio.render.status':status,'studio.render.cancel':cancel,'studio.render.bind':bind,
  // ★ 资产沉淀入口：后端/Agent 把产物"存进资产库"就走这条（内容哈希去重）
  'studio.asset.deposit':async args=>{
    const list=await assetList();
    const asset=list.find(a=>a.id===args.asset_id);
    if(!asset)throw new Error('找不到已登记的资产：'+String(args.asset_id));
    if(window.WBMyAssets&&window.WBMyAssets.add){
      window.WBMyAssets.add({id:asset.id,name:asset.name||asset.id,bytes:asset.bytes||0},
        {source:'videoforge-previz',sha256:asset.sha256||'',role:args.role||'deposit'});
    }
    const e=editor();
    return {asset_id:asset.id,name:asset.name,bytes:asset.bytes||0,sha256:asset.sha256||'',scene_id:(e&&e.studioSceneId)||null};
  }};
window.WBStudio={upload,importAsset,setInstance,exportScene,loadScene,setTrack,orbit,preview,render,status,cancel,bind,depositArtifact,
  depositStats:()=>({...depositStats})};

function mount() {
  const tools=document.querySelector('.tb-tools')||document.querySelector('.ed-top-actions');
  if(!tools||tools.querySelector('#wbBlenderBridge'))return;
  const button=document.createElement('button');button.id='wbBlenderBridge';button.className='tb-btn';button.textContent='Blender 接入';button.type='button';tools.appendChild(button);
  button.onclick=()=>{
    let panel=document.getElementById('wbBlenderPanel');if(panel){panel.remove();return;}
    panel=document.createElement('section');panel.id='wbBlenderPanel';panel.style.cssText='position:fixed;right:20px;top:90px;z-index:1000;width:380px;max-height:80vh;overflow:auto;padding:18px;background:var(--ed-panel,#202124);color:var(--ed-text,#eee);border:1px solid #666;border-radius:12px;font:13px sans-serif';
    panel.innerHTML='<h3>Blender 固定轨迹渲染</h3><p>模型保持原始尺寸；逐帧渲染并返回可校验文件。</p><label>导入 GLB <input id="wbGlbFile" type="file" accept=".glb"></label><p><label>时长(秒) <input id="wbRenderSeconds" type="number" min="1" max="60" value="3" style="width:60px"></label>　24fps / 640×360</p><p><button id="wbFullOrbit">生成完整环绕轨迹</button> <button id="wbTrackClear">使用时间线轨迹</button></p><p><button id="wbSceneExport">导出场景 JSON</button> <button id="wbRenderSubmit">提交 Blender 渲染</button></p><p><button id="wbRenderCancel">取消当前任务</button> <button id="wbBridgeClose">关闭</button></p><p><label>VideoForge 项目 ID <input id="wbProjectBind" style="width:95%"></label><label>分镜 ID <input id="wbShotBind" style="width:95%"></label><button id="wbRenderBind">绑定已完成白膜</button></p><pre id="wbRenderResult" style="white-space:pre-wrap;overflow-wrap:anywhere"></pre>';
    document.body.appendChild(panel);
    const out=panel.querySelector('#wbRenderResult');let jobId='';let polling=null;
    const stored=requiredEditor().studioRender;
    if(stored) {
      panel.querySelector('#wbRenderSeconds').value=String(stored.frame_count/stored.fps);
      panel.querySelector('#wbRenderSeconds').closest('p').lastChild.textContent='　'+stored.fps+'fps / '+stored.width+'×'+stored.height;
    }
    const options=()=>({seconds:Number(panel.querySelector('#wbRenderSeconds').value)});
    const run=async fn=>{try{const result=await fn();out.textContent=JSON.stringify(result,null,2);for(const file of result?.manifest?.outputs||[]){const a=document.createElement('a');a.href=absStudioUrl(file.url);a.target='_blank';a.rel='noopener';a.textContent='打开 '+file.kind;out.appendChild(document.createElement('br'));out.appendChild(a);}return result;}catch(error){out.textContent=error.message;return null;}};
    panel.querySelector('#wbGlbFile').onchange=event=>{const file=event.target.files[0];if(file)void run(async()=>{const asset=await upload(file);return importAsset({asset});});};
    panel.querySelector('#wbFullOrbit').onclick=()=>run(()=>orbit(options()));
    panel.querySelector('#wbTrackClear').onclick=()=>{requiredEditor().studioTracks=null;out.textContent='将使用时间线的逐帧采样';};
    panel.querySelector('#wbSceneExport').onclick=()=>run(async()=>{const scene=await exportScene(options());const blob=new Blob([JSON.stringify(scene,null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=scene.scene_id+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),60000);return {scene_id:scene.scene_id,revision:scene.revision,frames:scene.render.frame_count};});
    panel.querySelector('#wbRenderSubmit').onclick=async()=>{const submit=panel.querySelector('#wbRenderSubmit');submit.disabled=true;const submitted=await run(async()=>{if(polling)clearInterval(polling);const result=await render(options());jobId=result.job_id;let reading=false;polling=setInterval(async()=>{if(reading)return;reading=true;await run(async()=>{const state=await status({job_id:jobId});if(['succeeded','failed','cancelled','interrupted'].includes(state.status)){clearInterval(polling);polling=null;submit.disabled=false;}return state;});reading=false;},1500);return result;});if(!submitted)submit.disabled=false;};
    panel.querySelector('#wbRenderCancel').onclick=()=>run(()=>cancel({job_id:jobId}));
    panel.querySelector('#wbRenderBind').onclick=()=>run(()=>bind({job_id:jobId,project_id:panel.querySelector('#wbProjectBind').value.trim(),shot_id:panel.querySelector('#wbShotBind').value.trim()}));
    panel.querySelector('#wbBridgeClose').onclick=()=>{if(polling)clearInterval(polling);panel.remove();};
  };
}
const observer=new MutationObserver(()=>{mount();if(window.WB_AGENT&&!window.WBStudio.commandsRegistered){for(const [name,fn]of Object.entries(commands))window.WB_AGENT.register(name,fn);window.WBStudio.commandsRegistered=true;}});
observer.observe(document.body,{subtree:true,childList:true});mount();
