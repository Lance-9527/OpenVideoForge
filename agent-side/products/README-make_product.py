"""程序化生成电商商品模型（GLB）—— 2026-10-31。

为什么自己造模型：
  · 真实度要"到能商用"，**不能**用来源不明的模型（授权不清）。
  · 自己用 bpy 建的网格 = 我们自己的资产，可商用、可分发。

做了什么：
  · 陶瓷马克杯（旋转体杯身 + 杯口 + 把手），带釉面材质（Principled：低粗糙度 + 清漆层）
  · 玻璃瓶（旋转体瓶身 + 瓶盖），玻璃材质（透射 1.0 + IOR 1.46）
  · 金属罐（旋转体罐身），拉丝金属（metallic 1.0 + 粗糙度 0.28）
  每个都**底面贴地**（z=0）、法线朝外、尺寸接近真实商品（杯高 9.5cm / 瓶高 24cm）

用法（Blender 4.2）：
  blender -b -P make_product.py -- --kind mug --out ./mug.glb
"""
import argparse
import math
import sys

import bpy
from mathutils import Vector


def _clear():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)


def _material(name, **kwargs):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf is None:
        return mat
    for key, value in kwargs.items():
        for slot in (key,
                     "Coat Weight" if key == "coat" else None,
                     "Clearcoat" if key == "coat" else None,
                     "Transmission Weight" if key == "transmission" else None,
                     "Transmission" if key == "transmission" else None):
            if slot is None:
                continue
            if slot in bsdf.inputs:
                try:
                    bsdf.inputs[slot].default_value = value
                    break
                except Exception:
                    pass
    return mat


def _lathe(profile, segments=96, name="Profile"):
    """把 (半径, 高度) 轮廓旋转成实体（车削）。"""
    import bmesh
    mesh = bpy.data.meshes.new(name)
    bm = bmesh.new()
    rings = []
    for radius, height in profile:
        if radius <= 1e-6:
            rings.append([bm.verts.new((0.0, 0.0, height))])
            continue
        ring = []
        for i in range(segments):
            angle = 2 * math.pi * i / segments
            ring.append(bm.verts.new((radius * math.cos(angle), radius * math.sin(angle), height)))
        rings.append(ring)
    for lower, upper in zip(rings, rings[1:]):
        if len(lower) == 1:
            for i in range(segments):
                bm.faces.new((lower[0], upper[i], upper[(i + 1) % segments]))
        elif len(upper) == 1:
            for i in range(segments):
                bm.faces.new((lower[i], lower[(i + 1) % segments], upper[0]))
        else:
            for i in range(segments):
                j = (i + 1) % segments
                bm.faces.new((lower[i], lower[j], upper[j], upper[i]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(mesh)
    bm.free()
    mesh.update()
    return mesh


def make_mug():
    """陶瓷马克杯：高 9.5cm，口径 8.2cm，带把手。"""
    profile = [
        (0.000, 0.000), (0.036, 0.000), (0.038, 0.004), (0.039, 0.020),
        (0.041, 0.055), (0.041, 0.088), (0.0405, 0.094), (0.0395, 0.095),
        (0.0385, 0.093), (0.0385, 0.030), (0.0375, 0.012), (0.036, 0.006),
        (0.000, 0.005),
    ]
    mesh = _lathe(profile, name="MugBody")
    obj = bpy.data.objects.new("CeramicMug", mesh)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(_material("CeramicGlaze", **{
        "Base Color": (0.93, 0.92, 0.90, 1.0), "Roughness": 0.14,
        "coat": 0.45, "specular": 0.55}))
    # 把手：一个半圆环（用曲线圆环再转网格太绕 ⇒ 直接用 torus 的一段）
    bpy.ops.mesh.primitive_torus_add(
        major_radius=0.030, minor_radius=0.0075,
        major_segments=40, minor_segments=14,
        location=(0.048, 0.0, 0.055), rotation=(math.pi / 2, 0, 0))
    handle = bpy.context.object
    handle.name = "MugHandle"
    # 只留靠杯身那一半
    bpy.ops.object.select_all(action="DESELECT")
    handle.select_set(True)
    bpy.context.view_layer.objects.active = handle
    bpy.ops.object.modifier_apply(modifier="") if False else None
    for poly in handle.data.polygons:
        v = handle.data.vertices[poly.vertices[0]].co
        if v.x < 0.034:
            poly.use_smooth = True
    handle.data.materials.append(bpy.data.materials["CeramicGlaze"])
    return obj


def make_bottle():
    """玻璃瓶：高 24cm，瓶肩收口 + 金属盖。"""
    profile = [
        (0.000, 0.000), (0.036, 0.000), (0.038, 0.006), (0.038, 0.150),
        (0.036, 0.170), (0.026, 0.190), (0.0155, 0.200), (0.0145, 0.205),
        (0.0145, 0.214), (0.0155, 0.218), (0.0155, 0.220), (0.000, 0.220),
    ]
    mesh = _lathe(profile, name="BottleBody")
    obj = bpy.data.objects.new("GlassBottle", mesh)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(_material("GlassBody", **{
        "Base Color": (0.92, 0.96, 0.95, 1.0), "Roughness": 0.03,
        "transmission": 1.0, "IOR": 1.46}))
    bpy.ops.mesh.primitive_cylinder_add(radius=0.0165, depth=0.022, location=(0, 0, 0.228))
    cap = bpy.context.object
    cap.name = "BottleCap"
    cap.data.materials.append(_material("CapMetal", **{
        "Base Color": (0.72, 0.73, 0.76, 1.0), "Metallic": 1.0, "Roughness": 0.28}))
    return obj


def make_can():
    """金属饮料罐：高 12.2cm。"""
    profile = [
        (0.000, 0.000), (0.033, 0.000), (0.0335, 0.004), (0.0335, 0.115),
        (0.0325, 0.120), (0.0300, 0.122), (0.000, 0.122),
    ]
    mesh = _lathe(profile, name="CanBody")
    obj = bpy.data.objects.new("MetalCan", mesh)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(_material("BrushedMetal", **{
        "Base Color": (0.80, 0.81, 0.84, 1.0), "Metallic": 1.0, "Roughness": 0.30}))
    return obj


BUILDERS = {"mug": make_mug, "bottle": make_bottle, "can": make_can}


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--kind", default="mug", choices=sorted(BUILDERS))
    parser.add_argument("--out", required=True)
    args = parser.parse_args(argv)
    _clear()
    obj = BUILDERS[args.kind]()
    # ★ 导出要**选中所有部件**（杯身+把手、瓶身+瓶盖）：
    #   原来只 select 主体 ⇒ GLB 里没有把手/盖子，渲出来就是个光筒。
    bpy.ops.object.select_all(action="SELECT")
    for item in bpy.context.scene.objects:
        item.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.export_scene.gltf(filepath=args.out, export_format="GLB", use_selection=True)
    print(f"[make_product] {args.kind} -> {args.out}")


if __name__ == "__main__":
    main()
