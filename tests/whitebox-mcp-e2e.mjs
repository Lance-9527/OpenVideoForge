// 白膜 3D（MCP → Blender）端到端验收：场景 + 模型 + 机位/物体运动轨迹 + 出白膜视频。
//
// ★ 为什么要有这个文件（2026-10-26）：
//   之前的沉淀全是"照着做"的说明，没人真跑过**整条**链路。
//   这个脚本把那条链路跑一遍并**逐项断言**，跑挂了就是真问题，不是"应该可以"。
//
// 跑法（需要四个服务都起着）：
//   1) sidecar : cd D:/VideoForge-dev/backend && python -X utf8 main.py      (8765)
//   2) 页面    : cd product && python -m http.server 8802 --bind 127.0.0.1
//   3) 桥      : cd product && node server/agent-bridge.mjs --port 8787 --out <outdir>
//   4) 页面要**真的被浏览器打开**（桥只看 SSE 是否连上，没有浏览器就 page:false）
//   然后：node tests/whitebox-mcp-e2e.mjs
//
// 服务不齐 ⇒ 打印"跳过"并 exit 0（不制造假失败）。
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const BRIDGE = 'D:/KnowledgeVault/projects/cinemap-teardown/product/server/agent-bridge.mjs'
const OUT_DIR = process.env.VF_OUT_DIR || 'D:/下载/白膜工作台'
const ASSET_DIR = join(process.env.LOCALAPPDATA || '', 'VideoForge', 'data', 'studio_bridge', 'assets')

const PASS = []
const FAIL = []
function check(name, cond, detail = '') {
  ;(cond ? PASS : FAIL).push(name)
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? '  -- ' + detail : ''}`)
}
function skip(reason) {
  console.log(`➖ 跳过：${reason}`)
  process.exit(0)
}

async function httpJson(url, opts = {}) {
  const res = await fetch(url, opts)
  const text = await res.text()
  try { return JSON.parse(text) } catch { return { ok: false, raw: text } }
}

async function main() {
  // ── 0. 前置：服务齐不齐 ──
  const health = await httpJson('http://127.0.0.1:8787/health').catch(() => null)
  if (!health || !health.ok) skip('桥(8787) 没起来')
  if (!health.page) skip('桥起来了但没有页面连接（page:false）—— 请用浏览器打开 http://127.0.0.1:8802/index.html')
  const caps = await httpJson('http://127.0.0.1:8765/api/studio/health').catch(() => null)
  if (!caps) skip('sidecar(8765) 没起来')

  // ── MCP 客户端（stdio JSON-RPC）──
  const child = spawn('node', [BRIDGE, '--mcp'], { stdio: ['pipe', 'pipe', 'pipe'] })
  let buf = ''
  const pending = new Map()
  child.stdout.on('data', (d) => {
    buf += d.toString()
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      const r = pending.get(msg.id)
      if (r) { pending.delete(msg.id); r(msg) }
    }
  })
  let nextId = 1
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('MCP 超时: ' + method)) }, 120000)
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg) })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
  const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } })
  check('MCP initialize', init.result?.protocolVersion === '2024-11-05', init.result?.protocolVersion)
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
  const tools = (await rpc('tools/list', {})).result?.tools || []
  check('tools/list 拿到工具', tools.length > 0, tools.length + ' 个')
  const call = async (name, args = {}) => {
    const r = await rpc('tools/call', { name, arguments: args })
    const text = (r.result?.content || []).map((c) => c.text || '').join('\n')
    let data
    try { data = JSON.parse(text) } catch { data = { ok: false, raw: text.slice(0, 300) } }
    return data
  }

  console.log('① 场景')
  const state0 = await call('wb_state')
  check('wb_state 能读到工作台', state0?.ok === true, JSON.stringify(state0?.data || state0?.error || {}).slice(0, 120))
  const sc = await call('wb_scene_new', { env: 'street', size: 'small' })
  check('wb_scene_new 建场景', sc?.ok === true, JSON.stringify(sc?.data || sc?.error || {}).slice(0, 160))
  const sceneId = sc?.data?.scene_id || sc?.data?.id || ''

  console.log('② 模型')
  // 优先用后端已登记的资产（wb_previz_list 的模型清单）；没有就拿一个本地 GLB 上传。
  let assetId = ''
  let instanceId = ''
  const assetList = await call('wb_previz_list')
  const models = assetList?.data?.models || []
  if (models.length) {
    const a = models[0]
    const imp = await call('wb_asset_import', { asset_id: a.id })
    if (imp?.ok) { assetId = a.id; instanceId = imp?.data?.instance_id || '' }
  }
  if (!assetId) {
    // 兜底：直接上传登记库里现成的 model.glb
    const { readdirSync } = await import('node:fs')
    const dirs = existsSync(ASSET_DIR) ? readdirSync(ASSET_DIR) : []
    for (const d of dirs) {
      const p = join(ASSET_DIR, d, 'model.glb')
      if (!existsSync(p)) continue
      const up = await call('wb_asset_upload', { path: p, name: 'e2e-' + d.slice(0, 8) + '.glb' })
      if (up?.ok) {
        const id = up?.data?.id || up?.data?.asset_id
        const imp = await call('wb_asset_import', { asset_id: id })
        if (imp?.ok) { assetId = id; instanceId = imp?.data?.instance_id || ''; break }
      }
    }
  }
  check('模型能进工作台（有 asset_id）', !!assetId, assetId)
  check('模型有实例（instance_id）', !!instanceId, instanceId)

  console.log('③ 机位与运动轨迹')
  const orbit = await call('wb_track_orbit', { seconds: 2, fps: 24, width: 640, height: 360, turns: 1 })
  check('wb_track_orbit 生成环绕轨迹', orbit?.ok === true, JSON.stringify(orbit?.data || orbit?.error || {}).slice(0, 160))
  const keys = orbit?.data?.camera?.keys || orbit?.data?.keys || []
  check('轨迹从第 0 帧开始', keys.length === 0 || keys[0]?.frame === 0, 'keys=' + keys.length)
  const prev = await call('wb_track_preview', { frame: 12 })
  check('wb_track_preview 能预览指定帧', prev?.ok === true, JSON.stringify(prev?.data || prev?.error || {}).slice(0, 120))
  const cam = await call('wb_camera', { r: 6, phi: 1.2, theta: 0.6, tx: 0, ty: 1, tz: 0, fov: 35 })
  check('wb_camera 设机位', cam?.ok === true, JSON.stringify(cam?.error || '').slice(0, 120))

  console.log('④ 交接体检（提交前必做）')
  const chk = await call('wb_handoff_check', { seconds: 2, fps: 24, width: 640, height: 360 })
  const issues = chk?.data?.issues || []
  check('wb_handoff_check 返回 issues 列表', Array.isArray(issues), JSON.stringify(issues).slice(0, 200))
  check('交接体检无阻塞项', issues.length === 0, issues.join(' | ').slice(0, 240))

  console.log('⑤ 导出规范场景')
  const exp = await call('wb_scene_export', { seconds: 2, fps: 24, width: 640, height: 360 })
  const scene = exp?.data?.scene || exp?.data
  check('wb_scene_export 导出成功', exp?.ok === true, JSON.stringify(exp?.error || '').slice(0, 160))
  check('schema 是 videoforge.scene/1', scene?.schema === 'videoforge.scene/1', String(scene?.schema))
  check('坐标系是 Z-up', scene?.coordinates?.up === 'Z', String(scene?.coordinates?.up))
  check('assets 非空', Array.isArray(scene?.assets) && scene.assets.length > 0, String(scene?.assets?.length))
  check('instances 非空', Array.isArray(scene?.instances) && scene.instances.length > 0, String(scene?.instances?.length))
  check('导出的场景里有我们导入的模型实例', !!instanceId &&
    (scene?.instances || []).some((i) => i.id === instanceId),
    'instance_id=' + instanceId)
  check('camera.keys 非空', Array.isArray(scene?.camera?.keys) && scene.camera.keys.length > 0, String(scene?.camera?.keys?.length))
  check('render.frame_count 有效', scene?.render?.frame_count > 0, String(scene?.render?.frame_count))

  console.log('⑥ 出白膜视频（Blender）')
  const sub = await call('wb_render_submit', { scene, project_id: '', shot_id: '' })
  const jobId = sub?.data?.job_id || ''
  check('wb_render_submit 返回 job_id', !!jobId, JSON.stringify(sub?.error || '').slice(0, 200))
  if (!jobId) {
    console.log('   （Blender 不可用时这里会停：' + JSON.stringify(sub?.error || '').slice(0, 160) + '）')
  } else {
    let st = null
    for (let i = 0; i < 60; i++) {
      st = await call('wb_render_status', { job_id: jobId })
      const s = st?.data?.status
      if (s === 'succeeded' || s === 'failed' || s === 'cancelled') break
      await new Promise((r) => setTimeout(r, 2000))
    }
    const status = st?.data?.status
    check('渲染任务成功', status === 'succeeded', 'status=' + status + ' ' + JSON.stringify(st?.data?.error || '').slice(0, 160))
    if (status === 'succeeded') {
      const outs = st?.data?.manifest?.outputs || []
      check('manifest 里有视频产物', outs.some((o) => o.kind === 'video'), outs.map((o) => o.kind).join(','))
      check('manifest 里有首帧', outs.some((o) => o.kind === 'first_frame'), outs.map((o) => o.kind).join(','))
      const saved = await call('wb_render_save', { job_id: jobId, prefix: 'e2e白膜' })
      const files = saved?.data?.files || saved?.data?.paths || []
      const mp4 = (Array.isArray(files) ? files : []).find((f) => /\.mp4$/i.test(f.path || f || ''))
      check('白膜视频已下载到本地', !!(mp4 && existsSync(mp4.path || mp4)), String((mp4 && (mp4.path || mp4)) || '').slice(0, 160))
      if (mp4 && existsSync(mp4.path || mp4)) {
        const size = statSync(mp4.path || mp4).size
        check('白膜视频不是空文件', size > 1024, size + ' B')
      }
    }
  }

  console.log('⑦ 存档与沉淀')
  const saved = await call('wb_scene_save', { title: 'e2e-白膜链路-' + new Date().toISOString().slice(0, 16) })
  check('wb_scene_save 能存档', saved?.ok === true, JSON.stringify(saved?.error || '').slice(0, 120))
  const list = await call('wb_scene_list')
  check('wb_scene_list 列得出来', list?.ok === true, JSON.stringify(list?.error || '').slice(0, 120))

  child.kill()
  console.log(`\nPASS ${PASS.length}  FAIL ${FAIL.length}`)
  for (const f of FAIL) console.log('  FAIL:', f)
  process.exit(FAIL.length ? 1 : 0)
}

main().catch((e) => { console.error('E2E_ERROR', e); process.exit(2) })
