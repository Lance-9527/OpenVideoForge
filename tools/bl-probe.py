import bpy
import sys
import math

# 清空场景
bpy.ops.wm.read_factory_settings(use_empty=True)

path = sys.argv[-1]
print("PROBE loading:", path)
try:
    bpy.ops.import_scene.gltf(filepath=path)
except Exception as e:
    print("PROBE import failed:", e)
    sys.exit(1)

objs = [o for o in bpy.context.scene.objects]
print("PROBE objects:", len(objs))
mn = [1e9] * 3
mx = [-1e9] * 3
for o in objs:
    if o.type != 'MESH':
        continue
    for corner in o.bound_box:
        w = o.matrix_world @ __import__('mathutils').Vector(corner)
        for i in range(3):
            mn[i] = min(mn[i], w[i])
            mx[i] = max(mx[i], w[i])
print("PROBE bbox min:", [round(v, 2) for v in mn])
print("PROBE bbox max:", [round(v, 2) for v in mx])

# 从固定机位渲一帧（和 openVideoForge 的 canonical 相机一致）
cam_data = bpy.data.cameras.new("P")
cam = bpy.data.objects.new("P", cam_data)
bpy.context.scene.collection.objects.link(cam)
bpy.context.scene.camera = cam
target = (-106.27, 30.97, 75.44)
pos = (200.5, -417.43, 543.17)
cam.location = pos
direction = __import__('mathutils').Vector(target) - __import__('mathutils').Vector(pos)
cam.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()
cam_data.lens = 18.0

light_data = bpy.data.lights.new("S", type='SUN')
light_data.energy = 3.0
light = bpy.data.objects.new("S", light_data)
bpy.context.scene.collection.objects.link(light)
light.rotation_euler = (math.radians(50), 0, math.radians(35))

bpy.context.scene.render.resolution_x = 960
bpy.context.scene.render.resolution_y = 540
bpy.context.scene.render.filepath = "D:/KnowledgeVault/work_videoforge_deck/ovf_shots/GLB-probe.png"
bpy.ops.render.render(write_still=True)
print("PROBE rendered:", bpy.context.scene.render.filepath)
