import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { pathToFileURL, fileURLToPath } from 'node:url';
const ROOT=fileURLToPath(new URL('..', import.meta.url)).replaceAll('\\','/').replace(/\/$/,'');
const THREE=await import(pathToFileURL(ROOT+'/assets/three.module.js'));
const {GLTFLoader}=await import(pathToFileURL(ROOT+'/js/vendor/GLTFLoader.js'));
const {GLTFExporter}=await import(pathToFileURL(ROOT+'/js/vendor/GLTFExporter.js'));
globalThis.self=globalThis;
globalThis.FileReader=class {readAsArrayBuffer(blob){blob.arrayBuffer().then(data=>{this.result=data;this.onloadend?.()})}};
let passed=0;
function ok(label, test) {assert.ok(test,label);passed++;console.log('PASS '+label);}

// Parse a genuine GLB fixture with the real r160 loader, not a geometry stub.
const raw=fs.readFileSync(new URL('./fixtures/test-bottle.glb',import.meta.url));
const ab=raw.buffer.slice(raw.byteOffset,raw.byteOffset+raw.byteLength);
const loaded=await new GLTFLoader().parseAsync(ab,'');
const box=new THREE.Box3().setFromObject(loaded.scene);
ok('GLB parser returns real meshes',loaded.scene.children.length>0);
ok('GLB is still one meter high in Three Y-up',Math.abs(box.max.y-box.min.y-1)<1e-6);
const exported=await new GLTFExporter().parseAsync(loaded.scene,{binary:true});
const reloaded=await new GLTFLoader().parseAsync(exported,'');
const roundTripBox=new THREE.Box3().setFromObject(reloaded.scene);
ok('real GLTFExporter -> GLTFLoader round-trip preserves one meter height',Math.abs(roundTripBox.max.y-roundTripBox.min.y-1)<1e-6);

globalThis.window={};
globalThis.document={body:{},querySelector:()=>null};
globalThis.MutationObserver=class{observe(){}};
const studio=await import(pathToFileURL(ROOT+'/js/studio-bridge.js'));
ok('basis maps Y-up to Z-up without left/right inversion',JSON.stringify(studio.toCanonicalPosition([1,2,3]))==='[1,-3,2]');
ok('position basis inverse recovers original',JSON.stringify(studio.fromCanonicalPosition(studio.toCanonicalPosition([1,2,3])))==='[1,2,3]');
ok('identity quaternion stays identity',studio.toCanonicalQuaternion([0,0,0,1]).every((x,i)=>Math.abs(x-[0,0,0,1][i])<1e-9));

const group=new THREE.Group();group.position.set(1.25,0,-.75);group.add(loaded.scene);
const rec={instanceId:'product-001',assetId:'external:fixture',externalAsset:{id:'fixture'},group};
const e={objects:[rec],envGroup:new THREE.Group(),envId:'studio',camera:{fov:35},captureCam:()=>({r:5,phi:1,theta:.2,t:[0,1,0],fov:35}),select(){}};
window.__wb={editor:e,timeline:{getShots:()=>[]}};
let saved;
globalThis.fetch=async(url,options)=>{if(String(url).endsWith('/scenes'))saved=JSON.parse(options.body);return{ok:true,json:async()=>({code:'000000',data:{scene:saved}})}};
const scene=await window.WBStudio.exportScene({width:384,height:216,fps:24,frame_count:24});
ok('export keeps stable instance and registered asset IDs',scene.instances[0].id==='product-001'&&scene.assets[0].id==='fixture');
ok('export produces 24 explicit camera samples',scene.camera.keys.length===24&&scene.camera.keys[23].frame===23);
ok('scene is actually sent to backend persistence',saved.schema==='videoforge.scene/1'&&saved.revision===1);
window.WBStudio.orbit({fps:24,frame_count:24});
const orbitKeys=e.studioTracks.camera.keys;
ok('360-degree path has distinct middle and equal endpoints',Math.abs(orbitKeys[0].position[0]-orbitKeys[12].position[0])>0.1&&orbitKeys[0].position.every((x,i)=>Math.abs(x-orbitKeys[23].position[i])<1e-7));
const placed=window.WBStudio.setInstance({instance_id:'product-001',position:[3,-2,1],quaternion:[0,0,0,1],scale:[1,2,3]});
ok('instance is addressed and fully placed by stable ID',JSON.stringify(placed.position)==='[3,-2,1]'&&JSON.stringify(placed.scale)==='[1,2,3]');
ok('nonuniform scale axes follow the same basis conversion',group.scale.y===3&&group.scale.z===2);

// The editor serialization/load methods use real Three objects with a fake renderer-free host.
const {EditorApp}=await import(pathToFileURL(ROOT+'/js/editor.js'));
const serialized=EditorApp.prototype.serialize.call({...e,cams:[],getLight:()=>({on:true}),getColorGrade:()=>({contrast:1}),getFilmLook:()=>({on:false}),listDevices:()=>[]});
ok('serialization retains external asset + instance + quaternion + nonuniform scale',serialized.objects[0].externalAsset.id==='fixture'&&serialized.objects[0].instanceId==='product-001'&&serialized.objects[0].scale[1]===3&&serialized.studioTracks.camera.keys.length===24);
const host={objects:[],assetGroup:new THREE.Group(),opts:{},loadEnv(){},_clearGroup(g){g.clear()},select(){},setLight(){},setColorGrade(){},setFilmLook(){},applyCamState(){},clearPanorama(){},
  async addExternalAsset(asset,instance){this.objects.push({instanceId:instance.instanceId,externalAsset:asset,group:new THREE.Group()})}};
await EditorApp.prototype.loadScene.call(host,serialized);
ok('reload resolves external GLB record and preserves explicit camera path',host.objects[0].instanceId==='product-001'&&host.studioTracks.camera.keys.length===24);

const storeCode=fs.readFileSync(ROOT+'/js/store.js','utf8').replace('export const store =','const store =')+'\nglobalThis.store=store;';
const ctx={JSON,Date};vm.runInNewContext(storeCode,ctx);
const payload=JSON.parse(ctx.store.exportProject([{type:'native',id:'one',title:'A',data:serialized,shots:[{id:'shot-1',duration:3,cam:{r:5}}]}]));
ok('project export retains shots',payload.scenes[0].shots[0].id==='shot-1');
const importerCode=fs.readFileSync(ROOT+'/js/importer.js','utf8');
const importer=importerCode.slice(importerCode.indexOf('export function importProjectJSON')).replace('export function','function')+'\nglobalThis.importProjectJSON=importProjectJSON;';
const ic={JSON,Date,Math};vm.runInNewContext(importer,ic);
ok('project import retains shots and external objects',ic.importProjectJSON(payload).records[0].shots[0].id==='shot-1'&&ic.importProjectJSON(payload).records[0].data.objects[0].externalAsset.id==='fixture');

let nativeClicks=0;
class Anchor{click(){nativeClicks++}getAttribute(){return this.href}}
const sc={HTMLAnchorElement:Anchor,window:{},document:{getElementById:()=>null,createElement:()=>new Anchor()},console,
  fetch:async url=>{if(String(url).startsWith('data:'))return{blob:async()=>new Blob(['test'])};throw new Error('offline')},
  AbortSignal,Blob,Date,URL:{createObjectURL:()=> 'blob:owned',revokeObjectURL(){}},setTimeout:()=>{},requestAnimationFrame:f=>f()};
vm.runInNewContext(fs.readFileSync(ROOT+'/js/save-file.js','utf8'),sc);
await new Promise(resolve=>setImmediate(resolve));const a=new Anchor();a.download='test.png';a.href='data:image/png;base64,AAAA';a.click();await new Promise(resolve=>setImmediate(resolve));
ok('bridge-offline download invokes native fallback once',nativeClicks===1);
const bridge=fs.readFileSync(ROOT+'/server/agent-bridge.mjs','utf8');
const dc=bridge.slice(bridge.indexOf('async function dispatch('),bridge.indexOf('/* MCP（stdio）'));
let forwards=0;const bc={clients:new Map(),clientView:new Map(),pageClient:null,forwardOnly:false,PORT:8787,fetch:()=>{forwards++;throw Error('self')},AbortSignal};
vm.runInNewContext(dc+'\nglobalThis.dispatch=dispatch;',bc);const absent=await bc.dispatch('state.get',{});
ok('no-page bridge fails without self-forwarding',absent.ok===false&&forwards===0);
console.log(JSON.stringify({passed,failed:0,paidApiCalls:0,realGlbParsed:true}));
