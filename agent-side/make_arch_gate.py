"""Agent 侧：用 Blender 造一个白膜道具并导出 GLB（供 wb_handoff 直接吃）。

职责：Agent 只负责「造」——几何、比例、命名；不碰相机/时间线（那些归工作台）。
"""
import bpy
import json
import os

OUT = os.path.join(os.path.expanduser('~'), 'Downloads', 'OpenVideoForge', '_agent', 'arch_gate.glb')

bpy.ops.wm.read_factory_settings(use_empty=True)

mat = bpy.data.materials.new("wb_clay")
mat.use_nodes = True
bsdf = mat.node_tree.nodes.get("Principled BSDF")
bsdf.inputs["Base Color"].default_value = (0.84, 0.80, 0.72, 1.0)
bsdf.inputs["Roughness"].default_value = 0.72


def cube(name, loc, size):
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=loc)
    ob = bpy.context.object
    ob.name = name
    ob.scale = size
    ob.data.materials.append(mat)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return ob


# 门洞：两根柱 + 横梁 + 底座台阶（单位：米，Z-up）
cube("pillar_L", (-1.35, 0.0, 1.2), (0.45, 0.45, 2.4))
cube("pillar_R", (1.35, 0.0, 1.2), (0.45, 0.45, 2.4))
cube("lintel", (0.0, 0.0, 2.62), (3.2, 0.55, 0.44))
cube("step", (0.0, 0.0, 0.06), (4.2, 1.6, 0.12))
cube("cap_L", (-1.35, 0.0, 2.42), (0.62, 0.62, 0.16))
cube("cap_R", (1.35, 0.0, 2.42), (0.62, 0.62, 0.16))

# 轻微倒角，白膜更好看
for ob in [o for o in bpy.data.objects if o.type == "MESH"]:
    m = ob.modifiers.new("bevel", "BEVEL")
    m.width = 0.02
    m.segments = 2

os.makedirs(os.path.dirname(OUT), exist_ok=True)
bpy.ops.export_scene.gltf(
    filepath=OUT,
    export_format="GLB",
    export_apply=True,
    use_selection=False,
)

info = {
    "glb": OUT,
    "bytes": os.path.getsize(OUT),
    "objects": [o.name for o in bpy.data.objects if o.type == "MESH"],
    "bbox_m": None,
}
import mathutils

pts = []
for ob in [o for o in bpy.data.objects if o.type == "MESH"]:
    for corner in ob.bound_box:
        pts.append(ob.matrix_world @ mathutils.Vector(corner))
if pts:
    info["bbox_m"] = {
        "min": [round(min(p[i] for p in pts), 3) for i in range(3)],
        "max": [round(max(p[i] for p in pts), 3) for i in range(3)],
    }
print("HEADLESS " + json.dumps(info))
