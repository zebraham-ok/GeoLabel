"""
用户任务路由：任务列表、unit 状态、unit 详情、提交标注
"""
import json
from datetime import datetime

from flask import Blueprint, jsonify, request, session
from urllib.parse import quote

from config import ANNOTATIONS_DIR, TASKS_DIR, DATASETS_JUDGE_DIR
from cache import task_cache, status_cache, annotation_cache
from utils import login_required, save_json

user_bp = Blueprint("user", __name__)


@user_bp.route("/api/user/tasks", methods=["GET"])
@login_required
def get_user_tasks():
    """获取当前用户的所有任务"""
    username = session["user"]

    cache_key = f"user_tasks:{username}"
    cached = task_cache.get(cache_key)
    if cached is not None:
        return jsonify(cached)

    user_tasks = []
    if TASKS_DIR.exists():
        for task_file in sorted(TASKS_DIR.glob("*.json")):
            with open(task_file, "r", encoding="utf-8") as f:
                task = json.load(f)
            for group in task.get("groups", []):
                if group["username"] == username:
                    task_id = task["task_id"]
                    gid = group.get("group_id") or group.get("reviewer_id", "unknown")
                    total = len(group.get("units", []))
                    done = 0
                    annot_dir = ANNOTATIONS_DIR / task_id / gid
                    if annot_dir.exists():
                        done = sum(1 for _ in annot_dir.glob("unit_*.json"))
                    user_task = {
                        "task_id": task_id,
                        "task_name": task["task_name"],
                        "dataset": task["dataset"],
                        "task_type": task.get("task_type", "judge"),
                        "group_id": gid,
                        "created_at": task.get("created_at"),
                        "units": group.get("units", []),
                        "progress": {"done": done, "total": total},
                    }
                    user_tasks.append(user_task)
                    break
    task_cache.set(cache_key, user_tasks)
    return jsonify(user_tasks)


@user_bp.route("/api/user/unit_status", methods=["GET"])
@login_required
def get_unit_status():
    """获取当前用户某任务下所有 unit 的完成状态"""
    username = session["user"]
    task_id = request.args.get("task_id")
    group_id = request.args.get("group_id")

    cache_key = f"status:{task_id}:{group_id}"
    cached = status_cache.get(cache_key)
    if cached is not None:
        return jsonify(cached)

    ann_dir = ANNOTATIONS_DIR / task_id / group_id
    status = {}
    if ann_dir.exists():
        for f in ann_dir.glob("*.json"):
            with open(f, "r", encoding="utf-8") as fp:
                ann = json.load(fp)
            unit_id = ann.get("unit_id")
            if unit_id is not None:
                st = {
                    "done": True,
                    "result": ann.get("result"),
                    "updated_at": ann.get("updated_at"),
                }
                if ann.get("has_park") is not None:
                    st["has_park"] = ann["has_park"]
                    polys = ann.get("polygons", [])
                    st["polygon_count"] = len(polys)
                    st["poi_labels"] = list(set(p["label"] for p in polys if p.get("label")))
                    st["transport_modes"] = ann.get("transport_modes", [])
                status[str(unit_id)] = st
    status_cache.set(cache_key, status)
    return jsonify(status)


@user_bp.route("/api/unit/<task_id>/<group_id>/<int:unit_id>", methods=["GET"])
@login_required
def get_unit(task_id, group_id, unit_id):
    """获取某个 unit 的详细数据"""
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

    anno_cache_key = f"anno:{task_id}:{group_id}:{unit_id}"
    existing = annotation_cache.get(anno_cache_key)
    if existing is None:
        ann_file = ANNOTATIONS_DIR / task_id / group_id / f"unit_{unit_id:06d}.json"
        if ann_file.exists():
            with open(ann_file, "r", encoding="utf-8") as f:
                existing = json.load(f)
        annotation_cache.set(anno_cache_key, existing)

    task_type = task.get("task_type", "judge")
    if task_type in ("judge_shp", "hybrid"):
        mask_url = None
        if task_type == "hybrid" and unit.get("image"):
            mask_url = f"/api/mask/{quote(unit['image'])}?dataset={task['dataset']}"
        return jsonify({
            "unit": unit,
            "image_url": f"/api/image/{quote(unit['image'])}?dataset={task['dataset']}",
            "mask_url": mask_url,
            "task_type": task_type,
            "polygon_pixels": unit.get("polygon_pixels"),
            "existing_annotation": existing,
        })
    else:
        return jsonify({
            "unit": unit,
            "image_url": f"/api/image/{quote(unit['image'])}?dataset={task['dataset']}",
            "mask_url": f"/api/mask/{quote(unit['image'])}?dataset={task['dataset']}",
            "existing_annotation": existing,
        })


@user_bp.route("/api/unit/<task_id>/<group_id>/<int:unit_id>/submit", methods=["POST"])
@login_required
def submit_unit(task_id, group_id, unit_id):
    """保存某个 unit 的标注结果"""
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
    task_type = task.get("task_type", "judge")

    if task_type == "hybrid":
        record = {
            "task_id": task_id,
            "group_id": group_id,
            "unit_id": unit_id,
            "username": username,
            "has_park": data.get("has_park"),
            "result": data.get("result", "否"),
            "polygons": data.get("polygons", []),
            "transport_modes": data.get("transport_modes", []),
            "comment": data.get("comment", ""),
            "updated_at": datetime.now().isoformat(),
        }
    else:
        record = {
            "task_id": task_id,
            "group_id": group_id,
            "unit_id": unit_id,
            "username": username,
            "result": data.get("result"),
            "park_type": data.get("park_type"),
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
    annotation_cache.invalidate(f"anno:{task_id}:{group_id}:{unit_id}")

    return jsonify({"ok": True, "progress": progress})
