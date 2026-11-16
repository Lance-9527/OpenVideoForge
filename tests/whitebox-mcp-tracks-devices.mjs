// 补测：**物体运动轨迹**（object_tracks）+ **设备机位**（wb_device_*）。
// 为什么单独一个文件：上一条 e2e 只覆盖了相机环绕（object_tracks=0），
// 而用户点名的能力里明确有"机位/物体运动轨迹"和"设备机位"——这两块必须有实测。
//
// 前置：sidecar(8765) + 页面(8802) + 桥(8787) + 浏览器打开页面（同 whitebox-mcp-e2e.mjs）。
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const BRIDGE = 'D:/KnowledgeVault/projects/cinemap-teardown/product/server/agent-bridge.mjs'
const ASSET_DIR = join(process.env.LOCALAPPDATA || '', 'VideoForge', 'data', 'studio_bridge', 'assets')
const PASS = [], FAIL = []
const check = (n, c, d = '') => { (c ? PASS : FAIL).push(n); console.log(`  [${c ? 'PASS' : 'FAIL'}] ${n}${d ? '  -- ' + d : ''}`) }

const child = spawn('node', [BRIDGE, '--mcp'], { stdio: ['pipe', 'pipe', 'pipe'] })
let buf = ''
const pending = new Map()
child.stdout.on('data', (d) => {
  buf += d.toString()
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
    if (!line) continue
    let m; try { m = JSON.parse(line) } catch { continue }
    const r = pending.get(m.id); if (r) { pending.delete(m.id); r(m) }
  }
})
let id = 1
const rpc = (method, params) => new Promise((res, rej) => {
  const i = id++
  const t = setTimeout(() => rej(new Error('timeout ' + method)), 120000)
  pending.set(i, (m) => { clearTimeout(t); res(m) })
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n')
})
const call = async (name, args = {}) => {
  const r = await rpc('tools/call', { name, arguments: args })
  const text = (r.result?.content || []).map((c) => c.text || '').join('\n')
  try { return JSON.parse(text) } catch { return { ok: false, raw: text.slice(0, 400) } }
}

async function main() {
  const health = await fetch('http://127.0.0.1:8787/health').then((r) => r.json()).catch(() => null)
  if (!health?.page) { console.log('➖ 跳过：没有页面连接'); process.exit(0) }
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'tracks', version: '1' } })
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')

  await call('wb_scene_new', { env: 'street', size: 'small' })

  console.log('① 物体运动轨迹（object_tracks）')
  // 拿一个模型进工作台，拿到 instance_id
  const pl = await call('wb_previz_list')
  const models = pl?.data?.models || []
  let instanceId = ''
  if (models.length) {
    const imp = await call('wb_asset_import', { asset_id: models[0].id })
    if (imp?.ok) instanceId = imp.data.instance_id
  }
  check('拿到 instance_id', !!instanceId, instanceId)

  // 显式相机关键帧 + 物体轨道：物体从 x=-2 走到 x=2
  const cameraKeys = [
    { frame: 0, position: [6, -6, 3], target: [0, 0, 1], roll: 0 },
    { frame: 47, position: [6, 2, 3], target: [0, 0, 1], roll: 0 },
  ]
  const objectTracks = instanceId ? [{
    instance_id: instanceId,
    keys: [
      { frame: 0, position: [-2, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
      { frame: 47, position: [2, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
    ],
  }] : []
  const trk = await call('wb_track_set', {
    camera: { keys: cameraKeys, vertical_fov: 35 },
    object_tracks: objectTracks,
    render: { fps: 24, seconds: 2, width: 640, height: 360 },
  })
  check('wb_track_set 接受相机关键帧+物体轨道', trk?.ok === true, JSON.stringify(trk?.error || trk?.data || {}).slice(0, 160))

  const exp = await call('wb_scene_export', { seconds: 2, fps: 24, width: 640, height: 360 })
  const scene = exp?.data?.scene || exp?.data
  const ots = scene?.object_tracks || []
  check('导出场景里带上了 object_tracks', ots.length > 0, 'object_tracks=' + ots.length)
  check('物体轨道的 instance_id 对得上', ots.length > 0 && ots[0].instance_id === instanceId,
    (ots[0] && ots[0].instance_id) || '')
  const okeys = ots[0]?.keys || []
  check('物体轨道也有关键帧', okeys.length >= 2, 'keys=' + okeys.length)
  check('物体轨道从第 0 帧开始', okeys.length > 0 && okeys[0].frame === 0, JSON.stringify(okeys[0] || {}))
  const dx = okeys.length >= 2 ? (okeys[1].position?.[0] ?? 0) - (okeys[0].position?.[0] ?? 0) : 0
  check('物体轨道确实在位移（不是原地）', Math.abs(dx) > 0.5, 'Δx=' + dx)
  check('相机关键帧也导出了', (scene?.camera?.keys || []).length >= 2, 'camera.keys=' + (scene?.camera?.keys || []).length)

  const chk = await call('wb_handoff_check', { seconds: 2, fps: 24, width: 640, height: 360 })
  const issues = chk?.data?.issues || []
  check('带物体轨迹也能过交接体检', issues.length === 0, issues.join(' | ').slice(0, 200))

  console.log('② 渲染带物体轨迹的场景（Blender）')
  const sub = await call('wb_render_submit', { scene })
  const jobId = sub?.data?.job_id || ''
  check('wb_render_submit 返回 job_id', !!jobId, JSON.stringify(sub?.error || '').slice(0, 160))
  if (jobId) {
    let st = null
    for (let i = 0; i < 60; i++) {
      st = await call('wb_render_status', { job_id: jobId })
      const s = st?.data?.status
      if (s === 'succeeded' || s === 'failed' || s === 'cancelled') break
      await new Promise((r) => setTimeout(r, 2000))
    }
    check('带物体轨迹的渲染成功', st?.data?.status === 'succeeded',
      'status=' + st?.data?.status + ' ' + JSON.stringify(st?.data?.error || '').slice(0, 160))
    const val = st?.data?.manifest?.validation
    check('manifest 里有校验结论（说明渲染器验过轨迹）', !!val, JSON.stringify(val || {}).slice(0, 200))
  }

  console.log('③ 设备机位（wb_device_*）')
  const devAdd = await call('wb_device_add', { type: 'phone' })
  check('wb_device_add 加设备机位', devAdd?.ok === true, JSON.stringify(devAdd?.data || devAdd?.error || {}).slice(0, 200))
  const devList = await call('wb_device_list')
  const devs = devList?.data?.devices || devList?.data || []
  check('wb_device_list 列得出设备', Array.isArray(devs) && devs.length > 0,
    JSON.stringify(devs).slice(0, 200))
  if (Array.isArray(devs) && devs.length) {
    const did = devs[0].id || devs[0].device_id || ''
    const aim = await call('wb_device_aim', { id: did, yaw: 0.3, pitch: -0.1, fov: 40 })
    check('wb_device_aim 调设备机位', aim?.ok === true, JSON.stringify(aim?.error || aim?.data || {}).slice(0, 160))
    const look = await call('wb_device_look', { id: did })
    check('wb_device_look 对准物体', look?.ok === true, JSON.stringify(look?.error || look?.data || {}).slice(0, 160))
    const shoot = await call('wb_device_shoot', { id: did, type: 'image' })
    check('wb_device_shoot 能出图', shoot?.ok === true, JSON.stringify(shoot?.error || shoot?.data || {}).slice(0, 200))
  }

  child.kill()
  console.log(`\nPASS ${PASS.length}  FAIL ${FAIL.length}`)
  for (const f of FAIL) console.log('  FAIL:', f)
  process.exit(FAIL.length ? 1 : 0)
}
main().catch((e) => { console.error('ERR', e); process.exit(2) })
