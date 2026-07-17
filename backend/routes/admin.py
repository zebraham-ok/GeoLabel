"""
管理员路由：dataset 管理、任务创建/查看/删除、高德 Key 管理、缓存统计
"""
import io
import json
import secrets
import shutil
import zipfile
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List

import cv2
import numpy as np
from flask import Blueprint, jsonify, request, send_file, session

from config import (
    DATASETS_JUDGE_DIR, DATASETS_POI_DIR, TASKS_DIR, ANNOTATIONS_DIR,
    USER_FILE, AMAP_EXHAUSTION_THRESHOLD, POI_IMAGE_EXTENSIONS,
)
from cache import task_cache, status_cache, image_cache, _user_file_lock
from utils import admin_required, load_json, save_json, gen_password
from cv_utils import (
    detect_dataset_type, parse_coords_from_filename, parse_aux_xml,
    analyze_connected_components, load_judge_shp_units,
)
from amap import _load_amap_config_raw, rotate_amap_key, amap_empty_coords
from task_distribution import distribute_units_with_overlap

admin_bp = Blueprint("admin", __name__)


# ==================== 高德 Key 管理 ====================
@admin_bp.route("/api/admin/amap/status", methods=["GET"])
@admin_required
def admin_amap_status():
    """查看当前 key 状态"""
    cfg = _load_amap_config_raw()
    keys = cfg.get("keys", [])
    exhausted = set(cfg.get("exhausted", []))
    active = cfg.get("active_index", 0)

    key_info = []
    for i, k in enumerate(keys):
        key_info.append({
            "index": i,
            "label": k.get("label", f"key{i+1}"),
            "key_preview": k.get("key", "")[:8] + "..." if k.get("key") else "",
            "active": i == active,
            "exhausted": i in exhausted,
        })

    return jsonify({
        "keys": key_info,
        "active_index": active,
        "exhausted_indices": sorted(exhausted),
        "empty_coords_count": len(amap_empty_coords),
        "threshold": AMAP_EXHAUSTION_THRESHOLD,
    })


@admin_bp.route("/api/admin/amap/rotate", methods=["POST"])
@admin_required
def admin_amap_rotate():
    """管理员手动切换 key"""
    info = rotate_amap_key()
    return jsonify({"ok": True, "new_key": info})


@admin_bp.route("/api/admin/cache_stats", methods=["GET"])
@admin_required
def admin_cache_stats():
    """返回图片 LRU 缓存状态"""
    return jsonify(image_cache.stats())


# ==================== Dataset 管理 ====================
@admin_bp.route("/api/admin/datasets", methods=["GET"])
@admin_required
def admin_list_datasets():
    datasets = []

    if DATASETS_JUDGE_DIR.exists():
        for d in sorted(DATASETS_JUDGE_DIR.iterdir()):
            if not d.is_dir():
                continue
            img_dir = d / "img"
            mask_dir = d / "mask"
            coco_files = list(d.glob("*_coco_clean.json")) + list(d.glob("*_coco.json"))
            index_csv = d / "index.csv"
            if coco_files and index_csv.exists():
                jpg_count = len(list(d.rglob("*.jpg")))
                img_count = jpg_count
                mask_count = 0
                ds_type = "judge_shp"
            else:
                img_count = len(list(img_dir.glob("*"))) if img_dir.exists() else 0
                mask_count = len(list(mask_dir.glob("*"))) if mask_dir.exists() else 0
                ds_type = "judge_mask" if mask_dir.exists() else "judge"
            datasets.append({
                "name": d.name,
                "type": ds_type,
                "img_count": img_count,
                "mask_count": mask_count,
            })

    if DATASETS_POI_DIR.exists():
        for d in sorted(DATASETS_POI_DIR.iterdir()):
            if not d.is_dir():
                continue
            poi_images = [f for f in d.iterdir()
                          if f.is_file() and f.suffix.lower() in POI_IMAGE_EXTENSIONS]
            aux_count = len(list(d.glob("*.aux.xml")))
            datasets.append({
                "name": d.name,
                "type": "poi",
                "img_count": len(poi_images),
                "mask_count": aux_count,
            })

    return jsonify(datasets)


@admin_bp.route("/api/admin/dataset/<name>/analyze", methods=["GET"])
@admin_required
def admin_analyze_dataset(name):
    """分析 dataset 信息"""
    ds_type = detect_dataset_type(name)
    if ds_type is None:
        return jsonify({"error": "dataset 不存在"}), 404

    if ds_type in ("judge_mask", "judge"):
        mask_dir = DATASETS_JUDGE_DIR / name / "mask"
        if not mask_dir.exists():
            return jsonify({"error": "dataset 无 mask 目录"}), 404

        total_units = 0
        per_image = []
        for mask_file in sorted(mask_dir.glob("*.png")):
            coords = parse_coords_from_filename(mask_file.name)
            info = analyze_connected_components(mask_file)
            n = info.get("num_components", 0)
            total_units += n
            entry = {"image": mask_file.name, "num_units": n}
            if coords:
                entry["lat"], entry["lng"] = coords
            per_image.append(entry)
        return jsonify({
            "dataset": name,
            "type": "judge_mask",
            "total_units": total_units,
            "per_image": per_image,
        })

    elif ds_type == "judge_shp":
        dataset_path = DATASETS_JUDGE_DIR / name
        units = load_judge_shp_units(dataset_path)
        per_image = []
        for u in units:
            per_image.append({
                "image": u["image"],
                "num_units": 1,
                "lat": u.get("lat"),
                "lng": u.get("lng"),
            })
        return jsonify({
            "dataset": name,
            "type": "judge_shp",
            "total_units": len(units),
            "per_image": per_image,
        })
    else:
        poi_dir = DATASETS_POI_DIR / name
        img_files = sorted(
            f for f in poi_dir.iterdir()
            if f.is_file() and f.suffix.lower() in POI_IMAGE_EXTENSIONS
        )
        per_image = []
        total_units = 0
        for img_file in img_files:
            aux_file = Path(str(img_file) + ".aux.xml")
            geo = parse_aux_xml(aux_file) if aux_file.exists() else None
            if geo:
                total_units += 1
                per_image.append({
                    "image": img_file.name,
                    "num_units": 1,
                    "lat": round(geo["originY"] + geo["pixelHeight"] * 1000, 6),
                    "lng": round(geo["originX"] + geo["pixelWidth"] * 1000, 6),
                })
            else:
                total_units += 1
                per_image.append({"image": img_file.name, "num_units": 1})

        return jsonify({
            "dataset": name,
            "type": "poi",
            "total_units": total_units,
            "per_image": per_image,
        })


# ==================== 创建任务 ====================
@admin_bp.route("/api/admin/create_task", methods=["POST"])
@admin_required
def admin_create_task():
    """
    Body: { task_name, dataset, num_groups, overlap_factor, task_type }
    """
    data = request.get_json() or {}
    task_name = (data.get("task_name") or "").strip()
    dataset = (data.get("dataset") or "").strip()
    num_groups = int(data.get("num_groups") or 1)
    overlap_factor = int(data.get("overlap_factor") or 1)
    req_task_type = (data.get("task_type") or "auto").strip()

    if not task_name or not dataset:
        return jsonify({"error": "缺少 task_name 或 dataset"}), 400
    if num_groups < 1:
        return jsonify({"error": "组数必须 >= 1"}), 400

    ds_type = detect_dataset_type(dataset)
    if ds_type is None:
        return jsonify({"error": f"dataset {dataset} 不存在"}), 404

    if req_task_type == "hybrid" and ds_type in ("judge_mask", "judge_shp", "judge"):
        ds_type = "hybrid"
    elif req_task_type == "hybrid":
        return jsonify({"error": "hybrid 模式仅支持判读数据集（datasets_judge）"}), 400

    # judge_mask / judge 任务
    if ds_type in ("judge_mask", "judge"):
        if overlap_factor < 1 or overlap_factor > num_groups:
            return jsonify({"error": "重叠系数非法"}), 400

        mask_dir = DATASETS_JUDGE_DIR / dataset / "mask"
        if not mask_dir.exists():
            return jsonify({"error": f"dataset {dataset} 无 mask 目录"}), 404

        all_units = []
        for mask_file in sorted(mask_dir.glob("*.png")):
            coords = parse_coords_from_filename(mask_file.name)
            lat, lng = coords if coords else (None, None)

            info = analyze_connected_components(mask_file)
            for comp in info.get("components", []):
                unit_data = {
                    "id": len(all_units) + 1,
                    "image": mask_file.name,
                    "lat": lat,
                    "lng": lng,
                    "component_id": comp["id"],
                    "bbox": comp["bbox"],
                    "area": comp["area"],
                    "centroid": comp["centroid"],
                }
                if ds_type == "hybrid":
                    unit_data["polygon_pixels"] = comp.get("contour", [])
                all_units.append(unit_data)

        groups_units = distribute_units_with_overlap(all_units, num_groups, overlap_factor)

    # judge_shp / hybrid 任务
    elif ds_type in ("judge_shp", "hybrid"):
        if overlap_factor < 1 or overlap_factor > num_groups:
            return jsonify({"error": "重叠系数非法"}), 400

        dataset_path = DATASETS_JUDGE_DIR / dataset
        all_units = load_judge_shp_units(dataset_path)
        if not all_units:
            return jsonify({"error": f"dataset {dataset} 无有效单元"}), 404

        groups_units = distribute_units_with_overlap(all_units, num_groups, overlap_factor)

    # POI 任务
    else:
        if overlap_factor < 1 or overlap_factor > num_groups:
            return jsonify({"error": "重叠系数非法"}), 400

        poi_dir = DATASETS_POI_DIR / dataset
        img_files = sorted(
            f for f in poi_dir.iterdir()
            if f.is_file() and f.suffix.lower() in POI_IMAGE_EXTENSIONS
        )

        all_units = []
        for img_file in img_files:
            name_no_ext = img_file.stem
            aux_file = Path(str(img_file) + ".aux.xml")
            geo = parse_aux_xml(aux_file) if aux_file.exists() else None

            unit = {
                "id": len(all_units) + 1,
                "image": img_file.name,
                "name": name_no_ext,
                "lat": None,
                "lng": None,
            }
            if geo:
                try:
                    img = cv2.imdecode(np.fromfile(str(img_file), dtype=np.uint8), cv2.IMREAD_GRAYSCALE)
                    if img is not None:
                        h, w = img.shape[:2]
                        center_lat = geo["originY"] + geo["pixelHeight"] * h / 2
                        center_lng = geo["originX"] + geo["pixelWidth"] * w / 2
                        unit["lat"] = round(center_lat, 6)
                        unit["lng"] = round(center_lng, 6)
                        unit["img_width"] = w
                        unit["img_height"] = h
                except Exception:
                    pass
                if unit["lat"] is None:
                    unit["lat"] = round(geo["originY"] + geo["pixelHeight"] * 1000, 6)
                    unit["lng"] = round(geo["originX"] + geo["pixelWidth"] * 1000, 6)
                unit["geo_transform"] = geo

            all_units.append(unit)

        groups_units = distribute_units_with_overlap(all_units, num_groups, overlap_factor)

    # ===== 生成账号 =====
    task_id = f"task_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{secrets.token_hex(3)}"
    with _user_file_lock:
        users_data = load_json(USER_FILE, {"users": []})
        created_groups = []
        for i, units in enumerate(groups_units):
            gid = f"g{i+1:02d}"
            username = f"{task_id}_{gid}"
            password = gen_password(8)
            created_groups.append({
                "group_id": gid,
                "username": username,
                "password": password,
                "unit_count": len(units),
                "units": units,
                "progress": {"done": 0, "total": len(units)},
            })
            users_data.setdefault("users", []).append({
                "username": username,
                "password": password,
                "task_id": task_id,
                "group_id": gid,
                "task_type": ds_type,
                "created_at": datetime.now().isoformat(),
            })
        save_json(USER_FILE, users_data)

    task = {
        "task_id": task_id,
        "task_name": task_name,
        "dataset": dataset,
        "task_type": ds_type,
        "num_groups": num_groups,
        "overlap_factor": overlap_factor,
        "total_units": len(all_units),
        "units_per_group": [g["unit_count"] for g in created_groups],
        "created_at": datetime.now().isoformat(),
        "groups": created_groups,
    }
    save_json(TASKS_DIR / f"{task_id}.json", task)

    task_cache.invalidate_prefix("user_tasks:")
    task_cache.invalidate(f"task:{task_id}")

    return jsonify({"ok": True, "task": task})


# ==================== 任务列表 ====================
@admin_bp.route("/api/admin/tasks", methods=["GET"])
@admin_required
def admin_list_tasks():
    tasks = []
    if TASKS_DIR.exists():
        for f in sorted(TASKS_DIR.glob("*.json")):
            with open(f, "r", encoding="utf-8") as fp:
                t = json.load(fp)
            tasks.append({
                "task_id": t["task_id"],
                "task_name": t["task_name"],
                "dataset": t["dataset"],
                "task_type": t.get("task_type", "judge"),
                "num_groups": t["num_groups"],
                "overlap_factor": t["overlap_factor"],
                "total_units": t.get("total_units", 0),
                "created_at": t.get("created_at"),
            })
    return jsonify(tasks)


# ==================== 任务详情（含交叉一致性分析） ====================
@admin_bp.route("/api/admin/task/<task_id>/detail", methods=["GET"])
@admin_required
def admin_task_detail(task_id):
    task_path = TASKS_DIR / f"{task_id}.json"
    if not task_path.exists():
        return jsonify({"error": "任务不存在"}), 404

    with open(task_path, "r", encoding="utf-8") as fp:
        task = json.load(fp)

    for group in task["groups"]:
        gid = group["group_id"]
        annot_dir = ANNOTATIONS_DIR / task_id / gid
        done = 0
        if annot_dir.exists():
            done = len(list(annot_dir.glob("unit_*.json")))
        group["progress"] = {"done": done, "total": group["unit_count"]}

    # 交叉标注一致性分析
    unit_ann_map: Dict[str, list] = {}
    task_type = task.get("task_type", "judge")

    for group in task["groups"]:
        gid = group["group_id"]
        annot_dir = ANNOTATIONS_DIR / task_id / gid
        if not annot_dir.exists():
            continue
        for ann_file in annot_dir.glob("unit_*.json"):
            with open(ann_file, "r", encoding="utf-8") as fp:
                ann = json.load(fp)
            unit_id = ann.get("unit_id")

            if task_type == "hybrid":
                binary = "是" if ann.get("has_park") else "否"
            elif task_type == "poi":
                binary = "是" if ann.get("poi_labels") else "否"
            else:
                binary = ann.get("result", "")

            if not binary:
                continue

            if task_type == "hybrid":
                labels = sorted({p["label"] for p in ann.get("polygons", []) if p.get("label")})
            elif task_type == "poi":
                labels = sorted(ann.get("poi_labels", []))
            else:
                pt = ann.get("park_type", "")
                labels = [pt] if pt else []

            transport_modes = sorted(ann.get("transport_modes", []))

            unit_info = next((u for u in group.get("units", []) if u["id"] == unit_id), None)
            if not unit_info:
                continue
            comp_id = unit_info.get('component_id', unit_info['id'])
            key = f"{unit_info['image']}|{comp_id}"
            if key not in unit_ann_map:
                unit_ann_map[key] = []
            unit_ann_map[key].append({
                "group_id": gid,
                "unit_id": unit_id,
                "binary": binary,
                "labels": labels,
                "transport_modes": transport_modes,
            })

    def _compute_agreement(ann_by_key, field):
        total = 0
        consistent = 0
        details = []
        for key, ann_list in ann_by_key.items():
            if len(ann_list) < 2:
                continue
            total += 1
            vals = [a[field] for a in ann_list]
            if field == "binary":
                equal = len(set(vals)) == 1
            else:
                equal = len(set(tuple(v) for v in vals)) == 1
            if equal:
                consistent += 1
            else:
                img, comp_id = key.split("|", 1)
                details.append({
                    "image": img,
                    "component_id": int(comp_id) if comp_id.isdigit() else comp_id,
                    "annotations": [
                        {"group_id": a["group_id"], "value": a[field]}
                        for a in ann_list
                    ]
                })
        return {
            "total_overlap": total,
            "consistent": consistent,
            "inconsistent": total - consistent,
            "inconsistent_ratio": round((total - consistent) / total * 100, 1) if total > 0 else 0,
            "details": details
        }

    agreement_binary = _compute_agreement(unit_ann_map, "binary")
    agreement_labels = _compute_agreement(unit_ann_map, "labels")
    agreement_transport = _compute_agreement(unit_ann_map, "transport_modes")

    total_done = sum(g["progress"]["done"] for g in task["groups"])
    total_units = sum(g["unit_count"] for g in task["groups"])

    return jsonify({
        "task_id": task["task_id"],
        "task_name": task["task_name"],
        "dataset": task["dataset"],
        "task_type": task.get("task_type", "judge"),
        "num_groups": task["num_groups"],
        "overlap_factor": task["overlap_factor"],
        "total_units": task["total_units"],
        "created_at": task.get("created_at"),
        "groups": [{
            "group_id": g["group_id"],
            "username": g["username"],
            "unit_count": g["unit_count"],
            "done": g["progress"]["done"],
            "pct": round(g["progress"]["done"] / g["unit_count"] * 100, 1) if g["unit_count"] > 0 else 0
        } for g in task["groups"]],
        "total_progress": {
            "done": total_done,
            "total": total_units,
            "pct": round(total_done / total_units * 100, 1) if total_units > 0 else 0
        },
        "agreement": {
            "binary": agreement_binary,
            "park_type": agreement_labels,
            "transport_modes": agreement_transport
        }
    })


# ==================== 删除任务 ====================
@admin_bp.route("/api/admin/task/<task_id>/delete", methods=["POST"])
@admin_required
def admin_delete_task(task_id):
    task_path = TASKS_DIR / f"{task_id}.json"
    if not task_path.exists():
        return jsonify({"error": "任务不存在"}), 404

    with open(task_path, "r", encoding="utf-8") as f:
        task = json.load(f)

    task_name = task.get("task_name", task_id)

    with _user_file_lock:
        users_data = load_json(USER_FILE, {"users": []})
        original_count = len(users_data.get("users", []))
        users_data["users"] = [
            u for u in users_data.get("users", [])
            if u.get("task_id") != task_id
        ]
        save_json(USER_FILE, users_data)
    removed_accounts = original_count - len(users_data.get("users", []))

    annot_dir = ANNOTATIONS_DIR / task_id
    if annot_dir.exists():
        shutil.rmtree(str(annot_dir))

    task_path.unlink()

    task_cache.invalidate(f"task:{task_id}")
    task_cache.invalidate_prefix("user_tasks:")
    task_cache.invalidate_prefix("status:")
    task_cache.invalidate_prefix("anno:")
    task_cache.invalidate_prefix("anno_poi:")

    return jsonify({
        "ok": True,
        "deleted_task_id": task_id,
        "deleted_task_name": task_name,
        "removed_accounts": removed_accounts,
    })


# ==================== 下载账号 ====================
@admin_bp.route("/api/admin/task/<task_id>/download_accounts", methods=["GET"])
@admin_required
def admin_download_accounts(task_id):
    task_file = TASKS_DIR / f"{task_id}.json"
    if not task_file.exists():
        return jsonify({"error": "task 不存在"}), 404
    with open(task_file, "r", encoding="utf-8") as f:
        task = json.load(f)

    lines = [
        f"任务: {task['task_name']}",
        f"任务ID: {task['task_id']}",
        f"类型: {'POI 判读' if task.get('task_type') == 'poi' else '遥感判读'}",
        f"Dataset: {task['dataset']}",
        f"组数: {task['num_groups']}, 重叠系数: {task['overlap_factor']}",
        f"创建时间: {task.get('created_at', '')}",
        "",
        "=" * 50,
        "账号列表",
        "=" * 50,
    ]
    for g in task.get("groups", []):
        lines.append(f"组ID:    {g['group_id']}")
        lines.append(f"账号:    {g['username']}")
        lines.append(f"密码:    {g['password']}")
        lines.append(f"标注数:  {g['unit_count']}")
        lines.append("-" * 30)

    txt_content = "\n".join(lines).encode("utf-8")

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(f"{task['task_name']}_账号.txt", txt_content)
    buf.seek(0)
    return send_file(
        buf,
        mimetype="application/zip",
        as_attachment=True,
        download_name=f"{task['task_name']}_账号.zip"
    )
