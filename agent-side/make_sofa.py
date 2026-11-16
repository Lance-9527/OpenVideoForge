"""Agent 侧：Blender 造一张现代布艺沙发（居家电商棚用），导出 GLB。

职责边界：Agent 只做几何与比例（米制、Z-up，导出后由 glTF 转 Y-up），
灯光 / 机位 / 运镜 / 时长全部留给工作台。
尺寸参考：宽 2.1m × 深 0.92m × 高 0.82m（三人位）
"""
import bpy
import json
import os
import mathutils

OUT = os.path.join(os.path.expanduser('~'), 'Downloads', 'OpenVideoForge', '_agent', 'sofa_home.glb')

bpy.ops.wm.read_factory_settings(use_empty=True)

def mat(name, color, rough=0.75, sheen=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes.get("Principled BSDF")
    b.inputs["Base Color"].default_value = (*color, 1.0)
    b.inputs["Roughness"].default_value = rough
    if "Sheen Weight" in b.inputs:
        b.inputs["Sheen Weight"].default_value = sheen
    return m

fabric = mat("sofa_fabric", (0.78, 0.74, 0.68), 0.85, 0.3)
fabric2 = mat("sofa_cushion", (0.84, 0.80, 0.74), 0.88, 0.35)
wood = mat("sofa_leg", (0.35, 0.24, 0.16), 0.5)

def box(name, loc, size, material, bevel=0.02):
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=loc)
    ob = bpy.context.object
    ob.name = name
    ob.scale = size
    ob.data.materials.append(material)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if bevel:
        m = ob.modifiers.new("bev", "BEVEL")
        m.width = bevel
        m.segments = 2
    return ob

# 底座 + 座深
box("base", (0, 0, 0.26), (2.10, 0.88, 0.30), fabric)
# 靠背框
box("back_frame", (0, 0.40, 0.60), (2.10, 0.16, 0.52), fabric)
# 扶手
box("arm_L", (-1.02, 0.02, 0.50), (0.16, 0.86, 0.44), fabric)
box("arm_R", (1.02, 0.02, 0.50), (0.16, 0.86, 0.44), fabric)
# 坐垫（两块）
box("seat_L", (-0.52, -0.04, 0.44), (0.96, 0.78, 0.14), fabric2, bevel=0.05)
box("seat_R", (0.52, -0.04, 0.44), (0.96, 0.78, 0.14), fabric2, bevel=0.05)
# 靠垫（两块，略前倾）
for i, x in enumerate((-0.52, 0.52)):
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=(x, 0.30, 0.66))
    ob = bpy.context.object
    ob.name = f"back_cushion_{i}"
    ob.scale = (0.94, 0.16, 0.46)
    ob.rotation_euler[0] = -0.16
    ob.data.materials.append(fabric2)
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    m = ob.modifiers.new("bev", "BEVEL")
    m.width = 0.05
    m.segments = 2
# 四条木腿
for x in (-0.92, 0.92):
    for y in (-0.34, 0.34):
        bpy.ops.mesh.primitive_cylinder_add(radius=0.035, depth=0.12, location=(x, y, 0.06), vertices=12)
        ob = bpy.context.object
        ob.name = "leg"
        ob.data.materials.append(wood)

# 平滑
for ob in [o for o in bpy.data.objects if o.type == "MESH"]:
    for p in ob.data.polygons:
        p.use_smooth = True

os.makedirs(os.path.dirname(OUT), exist_ok=True)
bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", export_apply=True, use_selection=False)

pts = []
for ob in [o for o in bpy.data.objects if o.type == "MESH"]:
    for c in ob.bound_box:
        pts.append(ob.matrix_world @ mathutils.Vector(c))
info = {
    "glb": OUT,
    "bytes": os.path.getsize(OUT),
    "meshes": [o.name for o in bpy.data.objects if o.type == "MESH"],
    "bbox_m": {
        "min": [round(min(p[i] for p in pts), 3) for i in range(3)],
        "max": [round(max(p[i] for p in pts), 3) for i in range(3)],
    },
}
print("HEADLESS " + json.dumps(info, ensure_ascii=False))
