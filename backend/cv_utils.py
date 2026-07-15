"""
CV 分析、数据集类型检测、aux.xml 解析、COCO 多边形处理
"""
import json
import re
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any, Dict, List, Optional

import cv2
import numpy as np

from config import DATASETS_JUDGE_DIR, DATASETS_POI_DIR
from cache import _coco_cache_lock

# COCO 内存缓存（模块级，全局共享）
_COCO_CACHE: Dict[str, Dict[str, Any]] = {}


# ==================== 连通集分析 ====================
def analyze_connected_components(mask_path: Path) -> Dict[str, Any]:
    """
    分析 mask 中值为 1 的区域的连通集
    返回每个连通集的基本信息（id, bbox, area, centroid, contour）
    """
    mask = cv2.imdecode(np.fromfile(str(mask_path), dtype=np.uint8), cv2.IMREAD_GRAYSCALE)
    if mask is None:
        return {"error": f"无法读取 mask: {mask_path.name}", "components": []}

    binary = (mask > 0).astype(np.uint8) * 255
    num_labels, labels, stats, centroids = cv2.connectedComponentsWithStats(binary, connectivity=8)

    components = []
    for label_id in range(1, num_labels):
        x, y, w, h, area = stats[label_id]
        cx, cy = centroids[label_id]

        component_mask = (labels == label_id).astype(np.uint8) * 255
        contours, _ = cv2.findContours(component_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        contour = contours[0].reshape(-1, 2).tolist() if contours else []

        components.append({
            "id": int(label_id),
            "bbox": [int(x), int(y), int(w), int(h)],
            "area": int(area),
            "centroid": [float(cx), float(cy)],
            "contour": contour,
        })

    return {
        "mask_size": [int(mask.shape[1]), int(mask.shape[0])],
        "num_components": len(components),
        "components": components,
    }


# ==================== 数据集类型检测 ====================
def detect_dataset_type(dataset_name: str) -> Optional[str]:
    """检测数据集类型：judge_mask / judge_shp / poi"""
    judge_path = DATASETS_JUDGE_DIR / dataset_name
    poi_path = DATASETS_POI_DIR / dataset_name
    if judge_path.is_dir():
        coco_files = list(judge_path.glob("*_coco_clean.json")) + list(judge_path.glob("*_coco.json"))
        index_csv = judge_path / "index.csv"
        mask_dir = judge_path / "mask"
        if coco_files and index_csv.exists():
            return "judge_shp"
        if mask_dir.exists():
            return "judge_mask"
        return "judge_mask"
    if poi_path.is_dir():
        return "poi"
    return None


def get_dataset_dir(dataset_name: str) -> Optional[Path]:
    """根据数据集名找到实际路径"""
    for base in [DATASETS_JUDGE_DIR, DATASETS_POI_DIR]:
        p = base / dataset_name
        if p.is_dir():
            return p
    return None


# ==================== aux.xml 解析 ====================
def parse_aux_xml(aux_path: Path) -> Optional[Dict[str, Any]]:
    """解析 aux.xml，提取 GeoTransform 和 SRS 信息"""
    try:
        tree = ET.parse(str(aux_path))
        root_elem = tree.getroot()
        gt_text = root_elem.findtext("GeoTransform", "").strip()
        srs_text = root_elem.findtext("SRS", "").strip()
        if not gt_text:
            return None
        parts = [float(x.strip()) for x in gt_text.split(",")]
        if len(parts) != 6:
            return None
        return {
            "originX": parts[0],
            "pixelWidth": parts[1],
            "rowRotation": parts[2],
            "originY": parts[3],
            "colRotation": parts[4],
            "pixelHeight": parts[5],
            "srs": srs_text,
        }
    except Exception:
        return None


# ==================== 文件名坐标提取 ====================
_FILENAME_COORD_PATTERN = re.compile(
    r'^.+_(-?\d+\.\d+)_(-?\d+\.\d+)\.(?:jpg|jpeg|png)$', re.IGNORECASE
)
_SHP_FILENAME_PATTERN = re.compile(
    r'^(-?\d+\.\d+)_(-?\d+\.\d+)_(\d+)\.(?:jpg|jpeg|png)$', re.IGNORECASE
)


def parse_coords_from_filename(filename: str) -> Optional[tuple]:
    """从文件名提取 (lat, lng)，如 '中国物流_33.2535_116.5785.png' → (33.2535, 116.5785)"""
    m = _FILENAME_COORD_PATTERN.match(filename)
    if not m:
        return None
    return float(m.group(1)), float(m.group(2))


def parse_shp_filename(filename: str) -> Optional[dict]:
    """从 judge_shp 文件名提取 {lat, lng, ann_id}，如 '40.325130_116.047701_8452.jpg'"""
    m = _SHP_FILENAME_PATTERN.match(filename)
    if not m:
        return None
    return {"lat": float(m.group(1)), "lng": float(m.group(2)), "ann_id": int(m.group(3))}


# ==================== COCO 数据处理 ====================
def load_coco_data(dataset_path: Path) -> Dict[str, Any]:
    """加载 COCO JSON，返回 {annotations_by_id, images_by_id}（带缓存，线程安全）"""
    coco_files = list(dataset_path.glob("*_coco_clean.json")) + list(dataset_path.glob("*_coco.json"))
    if not coco_files:
        return {}
    json_path = str(coco_files[0])

    with _coco_cache_lock:
        if json_path in _COCO_CACHE:
            return _COCO_CACHE[json_path]

    with open(coco_files[0], "r", encoding="utf-8") as f:
        data = json.load(f)

    ann_by_id = {a["id"]: a for a in data.get("annotations", [])}
    img_by_id = {i["id"]: i for i in data.get("images", [])}

    result = {"annotations_by_id": ann_by_id, "images_by_id": img_by_id}
    with _coco_cache_lock:
        _COCO_CACHE[json_path] = result
    return result


def compute_crop_polygon(
    ann: Dict[str, Any],
    crop_img_path: Path,
) -> Optional[List[List[int]]]:
    """
    将 COCO segmentation（源 TIF 像素坐标）转换为 crop 图像的像素坐标。
    返回 [[x, y], ...] 多边形顶点列表。
    """
    from PIL import Image as PILImage

    if "segmentation" not in ann or not ann["segmentation"]:
        return None

    try:
        crop_img = PILImage.open(str(crop_img_path))
        crop_w, crop_h = crop_img.size
        crop_img.close()
    except Exception:
        return None

    seg = ann["segmentation"]
    seg = seg[0] if (isinstance(seg, list) and seg and isinstance(seg[0], list)) else seg

    seg_xs = seg[0::2]
    seg_ys = seg[1::2]
    seg_min_x, seg_max_x = min(seg_xs), max(seg_xs)
    seg_min_y, seg_max_y = min(seg_ys), max(seg_ys)

    poly_center_x = (seg_min_x + seg_max_x) / 2.0
    poly_center_y = (seg_min_y + seg_max_y) / 2.0

    offset_x = poly_center_x - crop_w / 2.0
    offset_y = poly_center_y - crop_h / 2.0

    points = []
    for i in range(0, len(seg), 2):
        px = round(seg[i] - offset_x)
        py = round(seg[i + 1] - offset_y)
        points.append([px, py])

    return points


def load_judge_shp_units(dataset_path: Path) -> List[Dict[str, Any]]:
    """从 judge_shp 数据集加载所有 unit（遍历 district 子目录中的 jpg 文件）"""
    coco_data = load_coco_data(dataset_path)
    ann_by_id = coco_data.get("annotations_by_id", {})
    if not ann_by_id:
        return []

    all_units = []
    for img_file in sorted(dataset_path.rglob("*.jpg")):
        rel_path = img_file.relative_to(dataset_path)
        parts = rel_path.parts
        if len(parts) < 2:
            continue

        info = parse_shp_filename(img_file.name)
        if not info:
            continue

        ann_id = info["ann_id"]
        ann = ann_by_id.get(ann_id)
        if not ann:
            continue

        polygon_pixels = compute_crop_polygon(ann, img_file)

        if polygon_pixels and len(polygon_pixels) > 0:
            xs = [p[0] for p in polygon_pixels]
            ys = [p[1] for p in polygon_pixels]
            min_x, max_x = min(xs), max(xs)
            min_y, max_y = min(ys), max(ys)
            bbox_pixels = [min_x, min_y, max_x - min_x, max_y - min_y]
        else:
            bbox_pixels = [0, 0, 0, 0]

        unit = {
            "id": len(all_units) + 1,
            "image": str(rel_path).replace("\\", "/"),
            "lat": info["lat"],
            "lng": info["lng"],
            "ann_id": ann_id,
            "polygon_pixels": polygon_pixels,
            "bbox": bbox_pixels,
            "area": int(ann.get("area", 0)),
        }
        all_units.append(unit)

    return all_units
