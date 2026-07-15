"""
高德 Key 耗竭检测路由
"""
from flask import Blueprint, jsonify, request

from amap import amap_empty_coords, rotate_amap_key
from config import AMAP_EXHAUSTION_THRESHOLD

amap_bp = Blueprint("amap_routes", __name__)


@amap_bp.route("/api/amap/report_exhausted", methods=["POST"])
def report_amap_exhausted():
    """
    前端报告：某个坐标周边 5 类 POI 全部返回空
    后端统计不同坐标数，达到阈值自动切换 key
    """
    data = request.get_json() or {}
    cache_key = (data.get("cache_key") or "").strip()
    if not cache_key:
        return jsonify({"ok": False, "reason": "missing cache_key"})

    amap_empty_coords.add(cache_key)
    count = len(amap_empty_coords)

    rotated = False
    if count >= AMAP_EXHAUSTION_THRESHOLD:
        rotated = True
        info = rotate_amap_key()
        print(f"[AMAP] 自动切换 Key → {info.get('label')} (index={info.get('index')})")
        print(f"       {count} 个不同坐标返回全空，达到阈值 {AMAP_EXHAUSTION_THRESHOLD}，疑似 Key 配额耗竭")

    return jsonify({
        "ok": True,
        "empty_coords_count": count,
        "threshold": AMAP_EXHAUSTION_THRESHOLD,
        "rotated": rotated,
    })


@amap_bp.route("/api/amap/reset_counter", methods=["POST"])
def reset_amap_counter():
    """前端有任一 POI 搜索返回结果时，重置全空计数器"""
    amap_empty_coords.clear()
    return jsonify({"ok": True})
