"""
审核任务路由：创建审核任务、审核 unit 获取、提交审核结果
"""
import json
import math
import secrets
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from flask import Blueprint, jsonify, request, session

from config import (
    TASKS_DIR, ANNOTATIONS_DIR, USER_FILE, DATASETS_JUDGE_DIR, DATASETS_POI_DIR
)
from cache import task_cache, status_cache, annotation_cache, _user_file_lock
from utils import login_required, admin_required, load_json, save_json, gen_password
from cv_utils import detect_dataset_type

review_bp = Blueprint("review", __name__)

REVIEW_TASKS_DIR = TASKS_DIR  # 审核任务与普通任务共用 tasks 目录
REVIEW_ANNOTATIONS_DIR = ANNOTATIONS_DIR  # 审核标注共用 annotations 目录


# ==================== 几何工具 ====================

def _polygon_area(points: List[Tuple[float, float]]) -> float:
    """Shoelace 公式计算多边形面积"""
    n = len(points)
    if n < 3:
        return 0.0
    area = 0.0
    for i in range(n):
        x1, y1 = points[i]
        x2, y2 = points[(i + 1) % n]
        area += x1 * y2 - x2 * y1
    return abs(area) / 2.0


def _polygon_iou(poly1: List[Tuple[float, float]], poly2: List[Tuple[float, float]]) -> float:
    """计算两个多边形的 IoU（使用 PIL 或简单的多边形裁剪近似）"""
    try:
        from shapely.geometry import Polygon as ShapelyPolygon
        p1 = ShapelyPolygon(poly1)
        p2 = ShapelyPolygon(poly2)
        if not p1.is_valid or not p2.is_valid:
            return 0.0
        inter = p1.intersection(p2).area
        union = p1.union(p2).area
        if union == 0:
            return 0.0
        return inter / union
    except ImportError:
        # 降级方案：使用 Axis-Aligned Bounding Box IoU 近似
        xs1, ys1 = [p[0] for p in poly1], [p[1] for p in poly1]
        xs2, ys2 = [p[0] for p in poly2], [p[1] for p in poly2]
        box1 = (min(xs1), min(ys1), max(xs1), max(ys1))
        box2 = (min(xs2), min(ys2), max(xs2), max(ys2))
        x_left = max(box1[0], box2[0])
        y_top = max(box1[1], box2[1])
        x_right = min(box1[2], box2[2])
        y_bottom = min(box1[3], box2[3])
        if x_right <= x_left or y_bottom <= y_top:
            return 0.0
        inter = (x_right - x_left) * (y_bottom - y_top)
        area1 = (box1[2] - box1[0]) * (box1[3] - box1[1])
        area2 = (box2[2] - box2[0]) * (box2[3] - box2[1])
        union = area1 + area2 - inter
        return inter / union if union > 0 else 0.0


def _compute_polygon_intersection(poly1: List[Tuple[float, float]],
                                   poly2: List[Tuple[float, float]]) -> Optional[List[Tuple[float, float]]]:
    """计算两个多边形的交集多边形"""
    try:
        from shapely.geometry import Polygon as ShapelyPolygon
        from shapely.ops import unary_union
        p1 = ShapelyPolygon(poly1)
        p2 = ShapelyPolygon(poly2)
        inter = p1.intersection(p2)
        if inter.is_empty:
            return None
        if inter.geom_type == 'Polygon':
            return list(inter.exterior.coords[:-1])
        elif inter.geom_type == 'MultiPolygon':
            largest = max(inter.geoms, key=lambda g: g.area)
            return list(largest.exterior.coords[:-1])
        return None
    except ImportError:
        return None


def _extract_polygon_points(poly: dict) -> List[Tuple[float, float]]:
    """从多边形记录中提取坐标点列表 [(x1,y1), (x2,y2), ...]
    兼容两种格式：{"points": [[x,y], ...]} 和 {"points": [{"x":x,"y":y}, ...]}
    """
    pts = poly.get("points", [])
    if not pts:
        return []
    if isinstance(pts[0], dict):
        return [(p["x"], p["y"]) for p in pts]
    else:
        return [(p[0], p[1]) for p in pts]


def _points_to_polygon_dict(points: List[Tuple[float, float]], label: str = "") -> dict:
    """将坐标点列表转换为多边形记录格式（与标注存储格式一致：[[x,y], ...]）"""
    return {"points": [[x, y] for x, y in points], "label": label}


def _compute_multi_polygon_intersection(all_polygon_sets: List[List[dict]]) -> List[dict]:
    """计算多个标注者之间多边形的多路交集。
    假设多边形数量相等且已通过最优匹配验证。
    先将各标注者的多边形对齐到标注者0的顺序，再逐位置求交集。
    """
    if len(all_polygon_sets) < 1:
        return []
    n_polys = len(all_polygon_sets[0])
    if n_polys == 0:
        return []

    # 对齐：从标注者0出发，依次与后续标注者匹配，建立索引映射
    aligned = [all_polygon_sets[0]]
    for k in range(1, len(all_polygon_sets)):
        prev_pts = [_extract_polygon_points(p) for p in aligned[-1]]
        curr_pts = [_extract_polygon_points(p) for p in all_polygon_sets[k]]
        matches, _ = _optimal_polygon_matching(prev_pts, curr_pts)
        b_to_a = {b: a for a, b in matches}
        remapped = [None] * n_polys
        for b_idx, poly in enumerate(all_polygon_sets[k]):
            a_idx = b_to_a.get(b_idx)
            if a_idx is not None and a_idx < n_polys:
                remapped[a_idx] = poly
        aligned.append(remapped)

    # 逐位置计算多路交集
    result = []
    for pos in range(n_polys):
        polys_at_pos = []
        label = ""
        for annot_polys in aligned:
            p = annot_polys[pos] if pos < len(annot_polys) else None
            if p:
                polys_at_pos.append(_extract_polygon_points(p))
                if not label and p.get("label"):
                    label = p["label"]

        if len(polys_at_pos) < 2:
            continue

        inter_pts = polys_at_pos[0]
        for pts in polys_at_pos[1:]:
            inter_pts = _compute_polygon_intersection(inter_pts, pts)
            if inter_pts is None:
                break

        if inter_pts:
            result.append(_points_to_polygon_dict(inter_pts, label))

    return result


def _build_resolved_record(task_type: str, task_id: str, unit_info: dict,
                           annotator_data: List[dict],
                           majority_result: str,
                           result_stats: dict) -> dict:
    """构建自动免审的标注记录，格式与审核提交一致"""
    record = {
        "task_id": task_id,
        "group_id": "_auto",
        "unit_id": unit_info.get("id"),
        "username": "_auto_resolved",
        "review_result": majority_result,
        "auto_resolved": True,
        "result_stats": result_stats,
        "resolved_at": datetime.now().isoformat(),
    }
    if task_type in ("poi_review", "hybrid_review"):
        # 计算多边形交集
        all_poly_sets = [ad.get("polygons", []) for ad in annotator_data]
        inter_polys = _compute_multi_polygon_intersection(all_poly_sets)
        record["review_polygons"] = inter_polys
        record["review_transport_modes"] = annotator_data[0].get("transport_modes", [])
        record["review_comment"] = "自动免审"
    else:
        record["review_park_type"] = annotator_data[0].get("park_type", "")
        record["review_transport_modes"] = annotator_data[0].get("transport_modes", [])
        record["comment"] = "自动免审"
    return record


def _optimal_polygon_matching(polys_a: List[List[Tuple[float, float]]],
                                polys_b: List[List[Tuple[float, float]]]) -> Tuple[List[Tuple[int, int]], List[float]]:
    """使用匈牙利算法/贪心算法计算两组多边形的最优一对一匹配，返回 [(idx_a, idx_b), ...] 和对应的 IoU 列表"""
    n_a, n_b = len(polys_a), len(polys_b)
    if n_a == 0 or n_b == 0:
        return [], []

    # 计算 n_a × n_b IoU 矩阵
    iou_matrix = [[0.0] * n_b for _ in range(n_a)]
    for i in range(n_a):
        for j in range(n_b):
            iou_matrix[i][j] = _polygon_iou(polys_a[i], polys_b[j])

    # 贪心匹配（简单且效果良好）
    used_a = set()
    used_b = set()
    all_pairs = []
    for i in range(n_a):
        for j in range(n_b):
            all_pairs.append((iou_matrix[i][j], i, j))
    all_pairs.sort(reverse=True)

    matches = []
    match_ious = []
    for iou, i, j in all_pairs:
        if iou <= 0:
            continue
        if i not in used_a and j not in used_b:
            used_a.add(i)
            used_b.add(j)
            matches.append((i, j))
            match_ious.append(iou)

    # 对于未匹配的，强制匹配（IoU=0）
    unmatched_a = set(range(n_a)) - used_a
    unmatched_b = set(range(n_b)) - used_b
    for i in sorted(unmatched_a):
        if unmatched_b:
            j = min(unmatched_b)
            unmatched_b.remove(j)
            matches.append((i, j))
            match_ious.append(0.0)
    for j in sorted(unmatched_b):
        if unmatched_a:
            i = min(unmatched_a)
            unmatched_a.remove(i)
            matches.append((i, j))
            match_ious.append(0.0)

    return matches, match_ious


# ==================== 审核任务创建逻辑 ====================

def _load_all_annotations(task: dict) -> Dict[str, List[dict]]:
    """加载一个原始任务的所有标注，按 unit key 分组"""
    task_id = task["task_id"]
    task_type = task.get("task_type", "judge")
    unit_ann_map: Dict[str, list] = {}

    for group in task.get("groups", []):
        gid = group["group_id"]
        annot_dir = ANNOTATIONS_DIR / task_id / gid
        if not annot_dir.exists():
            continue
        for ann_file in annot_dir.glob("unit_*.json"):
            with open(ann_file, "r", encoding="utf-8") as f:
                ann = json.load(f)
            unit_id = ann.get("unit_id")
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
                "annotation": ann.copy(),
                "unit_info": unit_info.copy(),
            })

    return unit_ann_map


def _build_review_units_judge(task: dict, unit_ann_map: Dict[str, List[dict]],
                                exemption_ratio: float) -> Tuple[List[dict], List[dict]]:
    """构建 judge 类型审核任务的 unit 列表。
    返回 (review_units, auto_resolved_records)
    """
    review_units = []
    auto_resolved_records = []
    task_id = task["task_id"]

    for key, ann_list in unit_ann_map.items():
        if len(ann_list) < 2:
            continue

        # 计算各选项比例
        result_counts = {}
        for item in ann_list:
            r = item["annotation"].get("result", "")
            if r:
                result_counts[r] = result_counts.get(r, 0) + 1

        total = sum(result_counts.values())
        if total == 0:
            continue

        max_result = max(result_counts, key=result_counts.get)
        max_count = result_counts[max_result]
        max_ratio = max_count / total

        # 计算选项统计
        options_stats = {
            opt: {"count": cnt, "ratio": round(cnt / total, 3)}
            for opt, cnt in result_counts.items()
        }

        if max_ratio >= exemption_ratio:
            # 免审：自动采用多数结果，保存记录
            ref_unit = ann_list[0]["unit_info"]
            annotator_data = []
            for item in ann_list:
                ann = item["annotation"]
                annotator_data.append({
                    "group_id": item["group_id"],
                    "unit_id": item["unit_id"],
                    "username": ann.get("username", ""),
                    "result": ann.get("result", ""),
                    "park_type": ann.get("park_type", ""),
                    "transport_modes": ann.get("transport_modes", []),
                    "comment": ann.get("comment", ""),
                })
            record = _build_resolved_record(
                "judge_review", task_id, ref_unit,
                annotator_data, max_result, options_stats
            )
            auto_resolved_records.append(record)
            continue

        # 需要审核
        img, comp_id_str = key.split("|", 1)
        ref_unit = ann_list[0]["unit_info"]

        annotator_data = []
        for item in ann_list:
            ann = item["annotation"]
            annotator_data.append({
                "group_id": item["group_id"],
                "unit_id": item["unit_id"],
                "username": ann.get("username", ""),
                "result": ann.get("result", ""),
                "park_type": ann.get("park_type", ""),
                "transport_modes": ann.get("transport_modes", []),
                "comment": ann.get("comment", ""),
            })

        review_unit = {
            "id": len(review_units) + 1,
            "image": img,
            "component_id": int(comp_id_str) if comp_id_str.isdigit() else comp_id_str,
            "lat": ref_unit.get("lat"),
            "lng": ref_unit.get("lng"),
            "bbox": ref_unit.get("bbox"),
            "area": ref_unit.get("area"),
            "centroid": ref_unit.get("centroid"),
            "annotator_count": len(ann_list),
            "options_stats": options_stats,
            "annotator_data": annotator_data,
        }
        # 传递 polygon_pixels（judge_shp 数据集需要）
        pp = ref_unit.get("polygon_pixels")
        if pp:
            review_unit["polygon_pixels"] = pp
        review_units.append(review_unit)

    return review_units, auto_resolved_records


def _build_review_units_poi(task: dict, unit_ann_map: Dict[str, List[dict]],
                              min_overlap_ratio: float,
                              exemption_ratio: float) -> Tuple[List[dict], List[dict]]:
    """构建 POI/Hybrid 类型审核任务的 unit 列表。
    同时检查多边形重叠比和结果投票一致性，两者都通过才免审。
    返回 (review_units, auto_resolved_records)
    """
    review_units = []
    auto_resolved_records = []
    task_id = task["task_id"]

    for key, ann_list in unit_ann_map.items():
        if len(ann_list) < 2:
            continue

        # 收集所有标注者的多边形和结果
        annotator_polygons = []
        annotator_results = []
        for item in ann_list:
            ann = item["annotation"]
            polys = ann.get("polygons", [])
            annotator_polygons.append(polys)
            annotator_results.append(ann.get("result", ""))

        # ---- 检查多边形一致性 ----
        poly_counts = [len(p) for p in annotator_polygons]
        poly_ok = True

        if len(set(poly_counts)) > 1:
            poly_ok = False
        elif poly_counts[0] == 0:
            poly_ok = True  # 都没有多边形，视为一致
        else:
            for i in range(len(annotator_polygons)):
                for j in range(i + 1, len(annotator_polygons)):
                    polys_a = [_extract_polygon_points(p) for p in annotator_polygons[i]]
                    polys_b = [_extract_polygon_points(p) for p in annotator_polygons[j]]
                    if not polys_a or not polys_b:
                        continue
                    _, ious = _optimal_polygon_matching(polys_a, polys_b)
                    if any(iou < min_overlap_ratio for iou in ious):
                        poly_ok = False
                        break
                if not poly_ok:
                    break

        # ---- 检查结果投票一致性 ----
        result_counts = {}
        for r in annotator_results:
            if r:
                result_counts[r] = result_counts.get(r, 0) + 1
        total_votes = sum(result_counts.values())
        vote_ok = False
        majority_result = ""
        result_stats = {}
        if total_votes > 0:
            majority_result = max(result_counts, key=result_counts.get)
            max_ratio = result_counts[majority_result] / total_votes
            vote_ok = (max_ratio >= exemption_ratio)
            result_stats = {
                opt: {"count": cnt, "ratio": round(cnt / total_votes, 3)}
                for opt, cnt in result_counts.items()
            }

        # 构建标注者数据
        ref_unit = ann_list[0]["unit_info"]
        annotator_data = []
        for item in ann_list:
            ann = item["annotation"]
            annotator_data.append({
                "group_id": item["group_id"],
                "unit_id": item["unit_id"],
                "username": ann.get("username", ""),
                "result": ann.get("result", ""),
                "has_park": ann.get("has_park"),
                "polygons": ann.get("polygons", []),
                "poi_labels": ann.get("poi_labels", []),
                "transport_modes": ann.get("transport_modes", []),
                "comment": ann.get("comment", ""),
            })

        # ---- 判断：两者都通过才免审 ----
        if poly_ok and vote_ok and poly_counts[0] > 0:
            record = _build_resolved_record(
                "poi_review" if task.get("task_type") == "poi" else "hybrid_review",
                task_id, ref_unit,
                annotator_data, majority_result, result_stats
            )
            auto_resolved_records.append(record)
            continue
        elif poly_ok and poly_counts[0] == 0 and vote_ok:
            # 都没有多边形且投票一致 → 免审
            record = _build_resolved_record(
                "poi_review" if task.get("task_type") == "poi" else "hybrid_review",
                task_id, ref_unit,
                annotator_data, majority_result, result_stats
            )
            auto_resolved_records.append(record)
            continue

        # 需要审核
        img, comp_id_str = key.split("|", 1)

        review_units.append({
            "id": len(review_units) + 1,
            "image": img,
            "component_id": int(comp_id_str) if comp_id_str.isdigit() else comp_id_str,
            "lat": ref_unit.get("lat"),
            "lng": ref_unit.get("lng"),
            "bbox": ref_unit.get("bbox"),
            "area": ref_unit.get("area"),
            "centroid": ref_unit.get("centroid"),
            "polygon_pixels": ref_unit.get("polygon_pixels"),
            "annotator_count": len(ann_list),
            "options_stats": result_stats,
            "annotator_data": annotator_data,
        })

    return review_units, auto_resolved_records


# ==================== API: 创建审核任务 ====================

@review_bp.route("/api/admin/task/<original_task_id>/create_review", methods=["POST"])
@admin_required
def create_review_task(original_task_id):
    """
    Body: {
        num_reviewers: int,
        exemption_ratio: float (judge 默认0.6; POI/Hybrid 也用于结果投票检查),
        min_overlap_ratio: float (poi/hybrid only, default 0.5)
    }
    """
    task_path = TASKS_DIR / f"{original_task_id}.json"
    if not task_path.exists():
        return jsonify({"error": "原任务不存在"}), 404

    with open(task_path, "r", encoding="utf-8") as f:
        original_task = json.load(f)

    data = request.get_json() or {}
    num_reviewers = int(data.get("num_reviewers") or 2)
    if num_reviewers < 1:
        return jsonify({"error": "审核员数量必须 >= 1"}), 400

    original_task_type = original_task.get("task_type", "judge")
    is_poly_drawing = original_task_type in ("poi", "hybrid")

    exemption_ratio = float(data.get("exemption_ratio", 0.6))
    min_overlap_ratio = float(data.get("min_overlap_ratio", 0.5)) if is_poly_drawing else None

    # 加载所有标注
    unit_ann_map = _load_all_annotations(original_task)

    # 构建审核 unit 列表（含 auto_resolved 记录）
    if is_poly_drawing:
        review_units, auto_resolved_records = _build_review_units_poi(
            original_task, unit_ann_map, min_overlap_ratio, exemption_ratio)
        review_task_type = "poi_review" if original_task_type == "poi" else "hybrid_review"
    else:
        review_units, auto_resolved_records = _build_review_units_judge(
            original_task, unit_ann_map, exemption_ratio)
        review_task_type = "judge_review"

    if not review_units:
        return jsonify({"error": "没有需要审核的条目（标注完全一致或已满足免审条件）"}), 400

    # 分配 unit 给审核员（每人工作量尽量均匀）
    total = len(review_units)
    base = total // num_reviewers
    remainder = total % num_reviewers

    reviewer_units = []
    idx = 0
    for i in range(num_reviewers):
        count = base + (1 if i < remainder else 0)
        reviewer_units.append(review_units[idx:idx + count])
        idx += count

    # 创建审核任务
    review_task_id = f"review_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{secrets.token_hex(3)}"
    review_type_labels = {
        "judge_review": "判读-审核",
        "poi_review": "POI-审核",
        "hybrid_review": "Hybrid-审核",
    }
    review_type_label = review_type_labels.get(review_task_type, "审核")
    review_task_name = original_task.get("task_name", original_task_id) + f"[{review_type_label}]"

    # 生成审核员账号
    with _user_file_lock:
        users_data = load_json(USER_FILE, {"users": []})
        created_reviewers = []
        for i, units in enumerate(reviewer_units):
            rid = f"r{i + 1:02d}"
            username = f"{review_task_id}_{rid}"
            password = gen_password(8)
            created_reviewers.append({
                "reviewer_id": rid,
                "group_id": rid,
                "username": username,
                "password": password,
                "unit_count": len(units),
                "units": units,
                "progress": {"done": 0, "total": len(units)},
            })
            users_data.setdefault("users", []).append({
                "username": username,
                "password": password,
                "task_id": review_task_id,
                "group_id": rid,
                "task_type": review_task_type,
                "created_at": datetime.now().isoformat(),
            })
        save_json(USER_FILE, users_data)

    review_task = {
        "task_id": review_task_id,
        "task_name": review_task_name,
        "original_task_id": original_task_id,
        "original_task_type": original_task_type,  # 保留原始任务类型，用于 mask/shp 区分
        "dataset": original_task.get("dataset", ""),
        "task_type": review_task_type,
        "num_groups": num_reviewers,
        "overlap_factor": 1,
        "total_units": total,
        "units_per_group": [r["unit_count"] for r in created_reviewers],
        "auto_resolved_count": len(auto_resolved_records),
        "created_at": datetime.now().isoformat(),
        "groups": created_reviewers,
        "review_config": {
            "exemption_ratio": exemption_ratio,
            "min_overlap_ratio": min_overlap_ratio,
        },
    }
    save_json(TASKS_DIR / f"{review_task_id}.json", review_task)

    # 保存免审记录到 annotations
    if auto_resolved_records:
        auto_dir = REVIEW_ANNOTATIONS_DIR / review_task_id / "_auto"
        auto_dir.mkdir(parents=True, exist_ok=True)
        for rec in auto_resolved_records:
            uid = rec.get("unit_id", 0)
            save_json(auto_dir / f"unit_{int(uid):06d}.json", rec)

    task_cache.invalidate_prefix("user_tasks:")
    task_cache.invalidate(f"task:{review_task_id}")

    auto_from_judge = len(auto_resolved_records) if not is_poly_drawing else 0
    auto_from_poly = len(auto_resolved_records) if is_poly_drawing else 0

    return jsonify({
        "ok": True,
        "review_task": review_task,
        "stats": {
            "total_original_overlaps": sum(1 for v in unit_ann_map.values() if len(v) >= 2),
            "auto_resolved": len(auto_resolved_records),
            "needs_review": len(review_units),
        }
    })


# ==================== API: 审核员获取 unit（含所有标注者数据 + 一致性统计） ====================

@review_bp.route("/api/review/unit/<task_id>/<group_id>/<int:unit_id>", methods=["GET"])
@login_required
def get_review_unit(task_id, group_id, unit_id):
    """获取审核 unit 详情（含所有标注者的标注数据和比例信息）"""
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

    task_type = task.get("task_type", "judge_review")
    original_task_type = task.get("original_task_type", task_type)  # 原始任务类型，用于区分 mask/shp

    # 获取已有的审核标注
    anno_cache_key = f"anno_review:{task_id}:{group_id}:{unit_id}"
    existing = annotation_cache.get(anno_cache_key)
    if existing is None:
        ann_file = REVIEW_ANNOTATIONS_DIR / task_id / group_id / f"unit_{unit_id:06d}.json"
        if ann_file.exists():
            with open(ann_file, "r", encoding="utf-8") as f:
                existing = json.load(f)
        annotation_cache.set(anno_cache_key, existing)

    result = {
        "unit": unit,
        "task_type": task_type,
        "existing_review": existing,
    }

    if task_type == "judge_review":
        result["image_url"] = f"/api/image/{unit['image']}?dataset={task['dataset']}"
        # judge_shp: 返回 polygon_pixels，不返回 mask_url（无 mask 目录）
        # judge_mask 或默认 judge: 返回 mask_url
        if original_task_type == "judge_shp":
            result["mask_url"] = None
            result["polygon_pixels"] = unit.get("polygon_pixels")
        else:
            result["mask_url"] = f"/api/mask/{unit['image']}?dataset={task['dataset']}"
    elif task_type == "poi_review":
        result["image_url"] = f"/api/poi_image/{unit['image']}?dataset={task['dataset']}"
    elif task_type == "hybrid_review":
        result["image_url"] = f"/api/image/{unit['image']}?dataset={task['dataset']}"
        # 判断数据集实际类型：shp 数据集无 mask 目录，不应返回 mask_url
        ds_type = detect_dataset_type(task.get("dataset", ""))
        if ds_type == "judge_shp" or original_task_type == "judge_shp":
            result["mask_url"] = None
        else:
            result["mask_url"] = f"/api/mask/{unit['image']}?dataset={task['dataset']}"
        result["polygon_pixels"] = unit.get("polygon_pixels")

    return jsonify(result)


# ==================== API: 审核员获取 unit 完成状态 ====================

@review_bp.route("/api/review/unit_status/<task_id>/<group_id>", methods=["GET"])
@login_required
def get_review_unit_status(task_id, group_id):
    """获取当前审核员某任务下所有 unit 的完成状态（与标注系统 /api/user/unit_status 对标）"""
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

    status_cache_key = f"status_review:{task_id}:{group_id}"
    cached = status_cache.get(status_cache_key)
    if cached is not None:
        return jsonify(cached)

    annot_dir = REVIEW_ANNOTATIONS_DIR / task_id / group_id
    status_map = {}
    if annot_dir.exists():
        for ann_file in annot_dir.glob("unit_*.json"):
            with open(ann_file, "r", encoding="utf-8") as f:
                ann = json.load(f)
            uid = str(ann.get("unit_id", ""))
            if uid:
                status_map[uid] = {"done": True}

    status_cache.set(status_cache_key, status_map)
    # 未标注的 unit 无需显式列出，前端默认未完成
    return jsonify(status_map)


# ==================== API: 审核员提交审核结果 ====================

@review_bp.route("/api/review/unit/<task_id>/<group_id>/<int:unit_id>/submit", methods=["POST"])
@login_required
def submit_review_unit(task_id, group_id, unit_id):
    """保存审核结果"""
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
    task_type = task.get("task_type", "judge_review")

    if task_type == "judge_review":
        record = {
            "task_id": task_id,
            "group_id": group_id,
            "unit_id": unit_id,
            "username": username,
            "review_result": data.get("review_result"),  # "是"/"否"/"不确定"
            "review_park_type": data.get("review_park_type", ""),
            "review_transport_modes": data.get("review_transport_modes", []),
            "comment": data.get("comment", ""),
            "updated_at": datetime.now().isoformat(),
        }
    elif task_type in ("poi_review", "hybrid_review"):
        record = {
            "task_id": task_id,
            "group_id": group_id,
            "unit_id": unit_id,
            "username": username,
            "review_result": data.get("review_result", ""),
            "review_polygons": data.get("review_polygons", []),
            "review_transport_modes": data.get("review_transport_modes", []),
            "review_comment": data.get("review_comment", ""),
            "updated_at": datetime.now().isoformat(),
        }
    else:
        return jsonify({"error": "未知审核类型"}), 400

    out_dir = REVIEW_ANNOTATIONS_DIR / task_id / group_id
    out_dir.mkdir(parents=True, exist_ok=True)
    save_json(out_dir / f"unit_{unit_id:06d}.json", record)

    done = sum(1 for f in out_dir.glob("*.json"))
    total_units = len(group.get("units", []))
    progress = {"done": done, "total": total_units}

    task_cache.invalidate(f"user_tasks:{username}")
    task_cache.invalidate(f"task:{task_id}")
    annotation_cache.invalidate(f"anno_review:{task_id}:{group_id}:{unit_id}")
    status_cache.invalidate(f"status_review:{task_id}:{group_id}")

    return jsonify({"ok": True, "progress": progress})
