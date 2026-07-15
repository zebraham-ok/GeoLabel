"""
POI 任务路由：unit 详情、标注提交、POI 缓存
"""
import json
import re
from datetime import datetime

from flask import Blueprint, jsonify, request, session
from urllib.parse import quote

from config import ANNOTATIONS_DIR, TASKS_DIR, POI_CACHE_DIR
from cache import task_cache, status_cache, annotation_cache, poi_mem_cache
from utils import login_required, load_json, save_json

poi_bp = Blueprint("poi_routes", __name__)


# ==================== POI Unit 路由 ====================
@poi_bp.route("/api/poi_unit/<task_id>/<group_id>/<int:unit_id>", methods=["GET"])
@login_required
def get_poi_unit(task_id, group_id, unit_id):
    """获取 POI 任务 unit 详情"""
    username = session["user"]

    task_cache_key = f"task:{task_id}"
    task = task_cache.get(task_cache_key)
    if task is None:
        task_file = TASKS_DIR / f"{task_id}.json"
        if not task_file.exists():
            return jsonify({"error": "task 不存在"}), 404
        with open(task_file, "r", encoding="utf-8") as f:
            task = json.load(f)
        task_cache.set(task_cache_key, task)

    group = next((g for g in task.get("groups", []) if g["group_id"] == group_id), None)
    if not group or group["username"] != username:
        return jsonify({"error": "无权访问"}), 403

    unit = next((u for u in group.get("units", []) if u["id"] == unit_id), None)
    if not unit:
        return jsonify({"error": "unit 不存在"}), 404

    anno_cache_key = f"anno_poi:{task_id}:{group_id}:{unit_id}"
    existing = annotation_cache.get(anno_cache_key)
    if existing is None:
        ann_file = ANNOTATIONS_DIR / task_id / group_id / f"unit_{unit_id:06d}.json"
        if ann_file.exists():
            with open(ann_file, "r", encoding="utf-8") as f:
                existing = json.load(f)
        annotation_cache.set(anno_cache_key, existing)

    return jsonify({
        "unit": unit,
        "image_url": f"/api/poi_image/{quote(unit['image'])}?dataset={task['dataset']}",
        "existing_annotation": existing,
    })


@poi_bp.route("/api/poi_unit/<task_id>/<group_id>/<int:unit_id>/submit", methods=["POST"])
@login_required
def submit_poi_unit(task_id, group_id, unit_id):
    """保存 POI 任务 unit 标注"""
    username = session["user"]

    task_cache_key = f"task:{task_id}"
    task = task_cache.get(task_cache_key)
    if task is None:
        task_file = TASKS_DIR / f"{task_id}.json"
        if not task_file.exists():
            return jsonify({"error": "task 不存在"}), 404
        with open(task_file, "r", encoding="utf-8") as f:
            task = json.load(f)
        task_cache.set(task_cache_key, task)
    group = next((g for g in task.get("groups", []) if g["group_id"] == group_id), None)
    if not group or group["username"] != username:
        return jsonify({"error": "无权访问"}), 403

    data = request.get_json() or {}
    record = {
        "task_id": task_id,
        "group_id": group_id,
        "unit_id": unit_id,
        "username": username,
        "poi_labels": data.get("poi_labels", []),
        "polygons": data.get("polygons", []),
        "transport_modes": data.get("transport_modes", []),
        "comment": data.get("comment", ""),
        "updated_at": datetime.now().isoformat(),
    }
    out_dir = ANNOTATIONS_DIR / task_id / group_id
    out_dir.mkdir(parents=True, exist_ok=True)
    save_json(out_dir / f"unit_{unit_id:06d}.json", record)

    done = sum(1 for f in out_dir.glob("*.json"))
    progress = {"done": done, "total": len(group.get("units", []))}

    task_cache.invalidate(f"user_tasks:{username}")
    task_cache.invalidate(f"task:{task_id}")
    status_cache.invalidate(f"status:{task_id}:{group_id}")
    annotation_cache.invalidate(f"anno_poi:{task_id}:{group_id}:{unit_id}")

    return jsonify({"ok": True, "progress": progress})


# ==================== POI 缓存 ====================
@poi_bp.route("/api/poi_cache", methods=["GET"])
def get_poi_cache():
    """查询某个坐标的 POI 缓存"""
    key = request.args.get("key", "")
    if not key:
        return jsonify({"found": False})
    safe_key = re.sub(r'[^0-9._\-]', '', key)
    if not safe_key or len(safe_key) > 64:
        return jsonify({"found": False})

    mem_key = f"poi:{safe_key}"
    cached = poi_mem_cache.get(mem_key)
    if cached is not None:
        return jsonify({"found": True, "pois": cached})

    cache_file = POI_CACHE_DIR / f"{safe_key}.json"
    if cache_file.exists():
        data = load_json(cache_file)
        pois = data.get("pois", [])
        poi_mem_cache.set(mem_key, pois)
        return jsonify({"found": True, "pois": pois})
    return jsonify({"found": False})


@poi_bp.route("/api/poi_cache", methods=["POST"])
def save_poi_cache():
    """保存某个坐标的 POI 搜索结果到缓存"""
    data = request.get_json() or {}
    key = data.get("key", "")
    pois = data.get("pois", [])
    if not key or not pois:
        return jsonify({"ok": False})
    safe_key = re.sub(r'[^0-9._\-]', '', key)
    if not safe_key or len(safe_key) > 64:
        return jsonify({"ok": False})
    cache_file = POI_CACHE_DIR / f"{safe_key}.json"
    if cache_file.exists():
        existing = load_json(cache_file, {}).get("pois", [])
        existing_names = {(p.get("name"), p.get("lng"), p.get("lat")) for p in existing}
        for p in pois:
            if (p.get("name"), p.get("lng"), p.get("lat")) not in existing_names:
                existing.append(p)
        pois = existing
    save_json(cache_file, {
        "key": safe_key,
        "pois": pois,
        "cached_at": datetime.now().isoformat(),
    })
    poi_mem_cache.set(f"poi:{safe_key}", pois)
    return jsonify({"ok": True})
