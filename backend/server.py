"""
judging_app 后端服务
- 普通用户：图片+地图+任务列表
- 管理员：dataset 管理 + 任务创建（含重叠参数、连通集分析）
"""
import io
import json
import os
import re
import secrets
import string
import threading
import time
import zipfile
from datetime import datetime
from pathlib import Path
from typing import Optional, List, Dict, Any
from urllib.parse import quote, unquote

import cv2
import numpy as np
from flask import Flask, jsonify, request, send_file, send_from_directory, session
from flask_cors import CORS

# ==================== 路径配置 ====================
ROOT = Path(__file__).resolve().parent                       # backend/
APP_ROOT = ROOT.parent                                       # judging_app/
FRONTEND_DIR = APP_ROOT / "frontend"
DATASETS_JUDGE_DIR = ROOT / "datasets_judge"
DATASETS_POI_DIR = ROOT / "datasets_poi"
ACCOUNTS_DIR = ROOT / "accounts"
TASKS_DIR = ROOT / "tasks"
ANNOTATIONS_DIR = ROOT / "annotations"
POI_CACHE_DIR = ROOT / "poi_cache"

for d in [DATASETS_JUDGE_DIR, DATASETS_POI_DIR, ACCOUNTS_DIR, TASKS_DIR, ANNOTATIONS_DIR, POI_CACHE_DIR]:
    d.mkdir(parents=True, exist_ok=True)

# ==================== 内存缓存（138 并发优化） ====================
class MemoryCache:
    """简单的 TTL 内存缓存，用于减少高频文件 I/O"""

    def __init__(self, default_ttl: float = 30.0):
        self._store: Dict[str, Any] = {}
        self._expires: Dict[str, float] = {}
        self._lock = threading.Lock()
        self._default_ttl = default_ttl

    def get(self, key: str):
        with self._lock:
            if key in self._expires and time.time() < self._expires[key]:
                return self._store.get(key)
            # 过期则清理
            self._store.pop(key, None)
            self._expires.pop(key, None)
        return None

    def set(self, key: str, value: Any, ttl: Optional[float] = None):
        with self._lock:
            self._store[key] = value
            self._expires[key] = time.time() + (ttl if ttl is not None else self._default_ttl)

    def invalidate(self, key: str):
        with self._lock:
            self._store.pop(key, None)
            self._expires.pop(key, None)

    def invalidate_prefix(self, prefix: str):
        """删除所有以 prefix 开头的缓存条目"""
        with self._lock:
            keys = [k for k in self._store if k.startswith(prefix)]
            for k in keys:
                self._store.pop(k, None)
                self._expires.pop(k, None)


# 不同数据的缓存 TTL
task_cache = MemoryCache(default_ttl=60.0)       # task JSON 60 秒缓存
status_cache = MemoryCache(default_ttl=15.0)      # unit 状态 15 秒缓存
annotation_cache = MemoryCache(default_ttl=30.0)  # 标注内容 30 秒缓存
poi_mem_cache = MemoryCache(default_ttl=3600.0)   # POI 结果 1 小时缓存

ADMIN_FILE = ACCOUNTS_DIR / "admin.json"
USER_FILE = ACCOUNTS_DIR / "user.json"
AMAP_CONFIG_FILE = ROOT / "amap_config.json"

app = Flask(__name__, static_folder=str(FRONTEND_DIR), static_url_path="")

# secret_key：生产环境从环境变量读取，开发环境使用固定值保证 session 不丢失
_secret_key = os.environ.get("JUDGING_SECRET_KEY")
if _secret_key:
    app.secret_key = _secret_key
elif os.environ.get("JUDGING_ENV") == "production":
    _secret_key = secrets.token_hex(32)
    app.secret_key = _secret_key
    print(f"[INFO] 已生成随机 SECRET_KEY（服务重启后 session 将失效）")
else:
    app.secret_key = "judging_app_dev_secret_key"

CORS(app, supports_credentials=True)

# ==================== 工具函数 ====================
def load_json(path: Path, default: Any = None) -> Any:
    if not path.exists():
        return default if default is not None else {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, IOError):
        return default if default is not None else {}


def save_json(path: Path, data: Any) -> None:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def gen_password(length: int = 8) -> str:
    """生成随机密码"""
    alphabet = string.ascii_letters + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(length))


# ==================== 连通集分析 ====================
def analyze_connected_components(mask_path: Path) -> Dict[str, Any]:
    """
    分析 mask 中值为 1 的区域的连通集
    返回每个连通集的基本信息（id, bbox, area, centroid, contour）
    """
    # Windows 下 cv2.imread 不支持中文路径，用 np.fromfile 绕过
    mask = cv2.imdecode(np.fromfile(str(mask_path), dtype=np.uint8), cv2.IMREAD_GRAYSCALE)
    if mask is None:
        return {"error": f"无法读取 mask: {mask_path.name}", "components": []}

    # 二值化（mask 值为 0/1，>0 即视为前景）
    binary = (mask > 0).astype(np.uint8) * 255

    # 连通域分析（8 邻接）
    num_labels, labels, stats, centroids = cv2.connectedComponentsWithStats(binary, connectivity=8)

    components = []
    # 跳过背景（label 0）
    for label_id in range(1, num_labels):
        x, y, w, h, area = stats[label_id]
        cx, cy = centroids[label_id]

        # 提取该连通集的轮廓
        component_mask = (labels == label_id).astype(np.uint8) * 255
        contours, _ = cv2.findContours(component_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        contour = contours[0].reshape(-1, 2).tolist() if contours else []

        components.append({
            "id": int(label_id),
            "bbox": [int(x), int(y), int(w), int(h)],   # x, y, w, h
            "area": int(area),                            # 像素面积
            "centroid": [float(cx), float(cy)],
            "contour": contour,                           # 轮廓点列表 [[x,y], ...]
        })

    return {
        "mask_size": [int(mask.shape[1]), int(mask.shape[0])],  # width, height
        "num_components": len(components),
        "components": components,
    }


# ==================== 任务分配算法 ====================
def distribute_units_with_overlap(
    all_units: List[Dict[str, Any]],
    num_groups: int,
    overlap_factor: int
) -> List[List[Dict[str, Any]]]:
    """
    将标注基本单位（连通集）分配到 num_groups 个组中
    overlap_factor: 每个基本单位被几个组标注
        - 1 = 不重叠
        - 2 = 每个被 2 个组标过
        - N = 每个被 N 个组标过
    返回每个组的 unit 列表
    """
    if num_groups <= 0 or not all_units:
        return [[] for _ in range(num_groups)]

    if overlap_factor < 1:
        overlap_factor = 1
    if overlap_factor > num_groups:
        overlap_factor = num_groups

    # 为每个 unit 随机选择 overlap_factor 个组
    rng = np.random.default_rng(seed=42)
    groups: List[List[Dict[str, Any]]] = [[] for _ in range(num_groups)]

    for unit in all_units:
        # 随机分配给 overlap_factor 个组
        chosen = rng.choice(num_groups, size=overlap_factor, replace=False)
        for g in chosen:
            groups[int(g)].append(unit)

    return groups


# ==================== 数据集类型检测 & aux.xml 解析 ====================
import xml.etree.ElementTree as ET


def _detect_dataset_type(dataset_name: str) -> Optional[str]:
    """检测数据集类型：judge_mask / judge_shp / poi"""
    judge_path = DATASETS_JUDGE_DIR / dataset_name
    poi_path = DATASETS_POI_DIR / dataset_name
    if judge_path.is_dir():
        # 检测 judge 子类型：有 COCO JSON → shp；有 mask 目录 → mask
        coco_files = list(judge_path.glob("*_coco_clean.json")) + list(judge_path.glob("*_coco.json"))
        index_csv = judge_path / "index.csv"
        mask_dir = judge_path / "mask"
        if coco_files and index_csv.exists():
            return "judge_shp"
        if mask_dir.exists():
            return "judge_mask"
        # 兜底：尝试按 mask 处理
        return "judge_mask"
    if poi_path.is_dir():
        return "poi"
    return None


def _get_dataset_dir(dataset_name: str) -> Optional[Path]:
    """根据数据集名找到实际路径"""
    for base in [DATASETS_JUDGE_DIR, DATASETS_POI_DIR]:
        p = base / dataset_name
        if p.is_dir():
            return p
    return None


def _parse_aux_xml(aux_path: Path) -> Optional[Dict[str, Any]]:
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
            "originX": parts[0],  # 左上角经度
            "pixelWidth": parts[1],
            "rowRotation": parts[2],
            "originY": parts[3],   # 左上角纬度
            "colRotation": parts[4],
            "pixelHeight": parts[5],  # 负值表示北向上
            "srs": srs_text,
        }
    except Exception:
        return None


# 文件名经纬度提取（judge 任务无 aux.xml，从文件名解析）
_FILENAME_COORD_PATTERN = re.compile(
    r'^.+_(-?\d+\.\d+)_(-?\d+\.\d+)\.(?:jpg|jpeg|png)$', re.IGNORECASE
)
# judge_shp 文件名模式: lat_lon_id.jpg
_SHP_FILENAME_PATTERN = re.compile(
    r'^(-?\d+\.\d+)_(-?\d+\.\d+)_(\d+)\.(?:jpg|jpeg|png)$', re.IGNORECASE
)


def _parse_coords_from_filename(filename: str) -> Optional[tuple]:
    """从文件名提取 (lat, lng)，如 '中国物流_33.2535_116.5785.png' → (33.2535, 116.5785)"""
    m = _FILENAME_COORD_PATTERN.match(filename)
    if not m:
        return None
    return float(m.group(1)), float(m.group(2))


def _parse_shp_filename(filename: str) -> Optional[dict]:
    """从 judge_shp 文件名提取 {lat, lng, ann_id}，如 '40.325130_116.047701_8452.jpg'"""
    m = _SHP_FILENAME_PATTERN.match(filename)
    if not m:
        return None
    return {"lat": float(m.group(1)), "lng": float(m.group(2)), "ann_id": int(m.group(3))}


# ==================== judge_shp: COCO 多边形处理 ====================
_COCO_CACHE = {}  # path → {annotations_by_id, images_by_id}


def _load_coco_data(dataset_path: Path) -> Dict[str, Any]:
    """加载 COCO JSON，返回 {annotations_by_id, images_by_id}（带缓存）"""
    coco_files = list(dataset_path.glob("*_coco_clean.json")) + list(dataset_path.glob("*_coco.json"))
    if not coco_files:
        return {}
    json_path = str(coco_files[0])
    if json_path in _COCO_CACHE:
        return _COCO_CACHE[json_path]

    with open(coco_files[0], "r", encoding="utf-8") as f:
        data = json.load(f)

    ann_by_id = {a["id"]: a for a in data.get("annotations", [])}
    img_by_id = {i["id"]: i for i in data.get("images", [])}

    result = {"annotations_by_id": ann_by_id, "images_by_id": img_by_id}
    _COCO_CACHE[json_path] = result
    return result


def _compute_crop_polygon(
    ann: Dict[str, Any],
    crop_img_path: Path,
) -> Optional[List[List[int]]]:
    """
    将 COCO segmentation（源 TIF 像素坐标）转换为 crop 图像的像素坐标。
    返回 [[x, y], ...] 多边形顶点列表。

    算法：以多边形 bbox 中心对齐 crop 图像中心（而非 centroid_lonlat 几何质心）。
    对于不规则形状，质心可能偏离 bbox 中心数百像素，因此必须用 bbox 中心对齐。
    每个 crop 图像尺寸独立读取，无需 tfw/地理坐标参与。
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

    # seg 是一维交替坐标 [x1, y1, x2, y2, ...] 或嵌套列表（TIF 像素）
    seg = ann["segmentation"]
    seg = seg[0] if (isinstance(seg, list) and seg and isinstance(seg[0], list)) else seg

    # 提取 x 和 y 分量，计算多边形 bbox
    seg_xs = seg[0::2]
    seg_ys = seg[1::2]
    seg_min_x, seg_max_x = min(seg_xs), max(seg_xs)
    seg_min_y, seg_max_y = min(seg_ys), max(seg_ys)

    # 多边形 bbox 中心（即 crop 图像的中心）
    poly_center_x = (seg_min_x + seg_max_x) / 2.0
    poly_center_y = (seg_min_y + seg_max_y) / 2.0

    # crop 窗口在原 TIF 中的起点（以 bbox 中心对齐）
    offset_x = poly_center_x - crop_w / 2.0
    offset_y = poly_center_y - crop_h / 2.0

    points = []
    for i in range(0, len(seg), 2):
        px = round(seg[i] - offset_x)
        py = round(seg[i + 1] - offset_y)
        points.append([px, py])

    return points


def _load_judge_shp_units(dataset_path: Path) -> List[Dict[str, Any]]:
    """
    从 judge_shp 数据集加载所有 unit（遍历 district 子目录中的 jpg 文件）"""
    coco_data = _load_coco_data(dataset_path)
    ann_by_id = coco_data.get("annotations_by_id", {})
    if not ann_by_id:
        return []

    all_units = []
    # 遍历子目录中的 jpg 文件
    for img_file in sorted(dataset_path.rglob("*.jpg")):
        # 跳过非 district 子目录中的文件
        rel_path = img_file.relative_to(dataset_path)
        parts = rel_path.parts
        if len(parts) < 2:
            continue  # 根目录的 jpg 跳过

        info = _parse_shp_filename(img_file.name)
        if not info:
            continue

        ann_id = info["ann_id"]
        ann = ann_by_id.get(ann_id)
        if not ann:
            continue

        # 计算 crop 图像上的多边形像素坐标
        polygon_pixels = _compute_crop_polygon(ann, img_file)

        # 从 polygon 像素坐标计算 bbox
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


# ==================== 高德多 Key 管理 ====================
AMAP_EXHAUSTION_THRESHOLD = 8   # N 个不同坐标全空 → 自动切换 key（提高阈值避免郊区正常空结果误判）
amap_empty_coords: set = set()  # 记录"全空"坐标，线程安全由 GIL 保证


def _load_amap_config_raw() -> Dict[str, Any]:
    """加载原始配置，兼容旧格式自动迁移"""
    cfg = load_json(AMAP_CONFIG_FILE, None)
    if cfg is None:
        return {"keys": [], "active_index": 0, "exhausted": []}
    # 兼容旧格式 {"key": "...", "security_code": "..."}
    if "key" in cfg and "keys" not in cfg:
        cfg = {
            "keys": [{"key": cfg["key"], "security_code": cfg.get("security_code", ""), "label": "default"}],
            "active_index": 0,
            "exhausted": [],
        }
        save_json(AMAP_CONFIG_FILE, cfg)
    return cfg


def _get_active_amap_key() -> Dict[str, str]:
    """获取当前可用的高德 key，自动跳过已标记耗尽的"""
    cfg = _load_amap_config_raw()
    keys = cfg.get("keys", [])
    exhausted = set(cfg.get("exhausted", []))
    active = cfg.get("active_index", 0)

    if not keys:
        return {"key": "", "security_code": ""}

    # 从 active 开始找第一个非耗尽 key
    for offset in range(len(keys)):
        idx = (active + offset) % len(keys)
        if idx not in exhausted:
            if idx != active:
                # 持久化新的 active_index
                cfg["active_index"] = idx
                save_json(AMAP_CONFIG_FILE, cfg)
            k = keys[idx]
            return {"key": k.get("key", ""), "security_code": k.get("security_code", "")}

    # 全部耗尽，返回最后一个（用户应该添加新 key）
    k = keys[active % len(keys)]
    return {"key": k.get("key", ""), "security_code": k.get("security_code", "")}


def _rotate_amap_key() -> Dict[str, Any]:
    """主动切换 key（管理员触发或自动），返回新 key 信息"""
    cfg = _load_amap_config_raw()
    keys = cfg.get("keys", [])
    exhausted = set(cfg.get("exhausted", []))
    active = cfg.get("active_index", 0)

    # 标记当前 key 为耗尽
    if 0 <= active < len(keys):
        exhausted.add(active)
        cfg["exhausted"] = sorted(exhausted)

    # 找下一个可用 key
    new_active = active
    for offset in range(1, len(keys) + 1):
        idx = (active + offset) % len(keys)
        if idx not in exhausted:
            new_active = idx
            break

    cfg["active_index"] = new_active
    save_json(AMAP_CONFIG_FILE, cfg)

    global amap_empty_coords
    amap_empty_coords.clear()

    if new_active < len(keys):
        k = keys[new_active]
        return {"key": k.get("key", ""), "security_code": k.get("security_code", ""),
                "label": k.get("label", ""), "index": new_active,
                "total_keys": len(keys), "exhausted_count": len(exhausted)}
    return {"key": "", "security_code": "", "label": "(all exhausted)",
            "index": -1, "total_keys": len(keys), "exhausted_count": len(exhausted)}


@app.route("/")
def index():
    amap = _get_active_amap_key()
    html_path = FRONTEND_DIR / "index.html"
    with open(html_path, "r", encoding="utf-8") as f:
        html = f.read()
    html = html.replace("{{ AMAP_KEY }}", amap["key"])
    html = html.replace("{{ AMAP_SECURITY_CODE }}", amap["security_code"])
    return html


@app.route("/poi")
def poi_page():
    """POI 任务页面"""
    amap = _get_active_amap_key()
    html_path = FRONTEND_DIR / "poi.html"
    if not html_path.exists():
        return "POI 页面不存在", 404
    with open(html_path, "r", encoding="utf-8") as f:
        html = f.read()
    html = html.replace("{{ AMAP_KEY }}", amap["key"])
    html = html.replace("{{ AMAP_SECURITY_CODE }}", amap["security_code"])
    return html


@app.route("/admin")
def admin_page():
    return send_file(str(FRONTEND_DIR / "admin.html"))


# ==================== 路由：登录 ====================
@app.route("/api/login", methods=["POST"])
def login():
    data = request.get_json() or {}
    username = (data.get("username") or "").strip()
    password = data.get("password") or ""

    # 1. 优先检查管理员
    admins = load_json(ADMIN_FILE, {"admin_accounts": []}).get("admin_accounts", [])
    for a in admins:
        if a["username"] == username and a["password"] == password:
            session["user"] = username
            session["role"] = "admin"
            return jsonify({"ok": True, "role": "admin", "username": username})

    # 2. 检查普通用户
    users = load_json(USER_FILE, {"users": []}).get("users", [])
    for u in users:
        if u["username"] == username and u["password"] == password:
            session["user"] = username
            session["role"] = "user"
            session["task_type"] = u.get("task_type", "")
            return jsonify({
                "ok": True, "role": "user", "username": username,
                "task_type": u.get("task_type", "")
            })

    return jsonify({"ok": False, "message": "账号或密码错误"}), 401


@app.route("/api/logout", methods=["POST"])
def logout():
    session.clear()
    return jsonify({"ok": True})


@app.route("/api/current_user", methods=["GET"])
def current_user():
    if "user" not in session:
        return jsonify({"logged_in": False}), 401
    return jsonify({
        "logged_in": True,
        "username": session["user"],
        "role": session.get("role", "user"),
    })


# ==================== 路由：用户任务 ====================
@app.route("/api/user/tasks", methods=["GET"])
def get_user_tasks():
    """获取当前用户的所有任务（来自 tasks 目录中分配给该用户的）"""
    if "user" not in session:
        return jsonify({"error": "未登录"}), 401
    username = session["user"]

    cache_key = f"user_tasks:{username}"
    cached = task_cache.get(cache_key)
    if cached is not None:
        return jsonify(cached)

    # 找到包含该用户的 task
    user_tasks = []
    if TASKS_DIR.exists():
        for task_file in sorted(TASKS_DIR.glob("*.json")):
            with open(task_file, "r", encoding="utf-8") as f:
                task = json.load(f)
            # 找到该用户所在的组
            for group in task.get("groups", []):
                if group["username"] == username:
                    task_id = task["task_id"]
                    gid = group["group_id"]
                    total = len(group.get("units", []))
                    # 实时统计进度（从标注目录，而非 task.json 中的过时值）
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


@app.route("/api/user/unit_status", methods=["GET"])
def get_unit_status():
    """获取当前用户某任务下所有 unit 的完成状态（用于侧边栏颜色）"""
    if "user" not in session:
        return jsonify({"error": "未登录"}), 401
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
                status[str(unit_id)] = {
                    "done": True,
                    "result": ann.get("result"),
                    "updated_at": ann.get("updated_at"),
                }
    status_cache.set(cache_key, status)
    return jsonify(status)


# ==================== 路由：图片 & Mask ====================
@app.route("/api/image/<path:filename>")
def serve_image(filename):
    """从 datasets_judge/<dataset>/ 读取原图（支持 img/ 子目录或 district 子目录）"""
    dataset = request.args.get("dataset", "")
    decoded = unquote(filename)

    # 1. 先尝试 img/ 子目录（judge_mask 类型）
    img_dir = DATASETS_JUDGE_DIR / dataset / "img"
    path = img_dir / os.path.basename(decoded)
    if path.exists():
        return send_file(path.open("rb"), mimetype="image/png")

    # 2. 尝试直接相对路径（judge_shp 类型，如 "延庆区/40.325_116.048_8452.jpg"）
    path = DATASETS_JUDGE_DIR / dataset / decoded
    if path.exists():
        return send_file(path.open("rb"), mimetype="image/jpeg")

    return jsonify({"error": "not found"}), 404


@app.route("/api/mask/<path:filename>")
def serve_mask(filename):
    dataset = request.args.get("dataset", "")
    mask_dir = DATASETS_JUDGE_DIR / dataset / "mask"
    safe = os.path.basename(unquote(filename))
    path = mask_dir / safe
    if not path.exists():
        return jsonify({"error": "not found"}), 404
    return send_file(path.open("rb"), mimetype="image/png")


@app.route("/api/poi_image/<path:filename>")
def serve_poi_image(filename):
    """从 datasets_poi/<dataset>/ 读取 PNG；找不到时 fallback 到 datasets_judge/<dataset>/img/"""
    dataset = request.args.get("dataset", "")
    safe = os.path.basename(unquote(filename))
    
    # 1. 先查 POI 目录
    path = DATASETS_POI_DIR / dataset / safe
    if path.exists():
        return send_file(path.open("rb"), mimetype="image/png")
    
    # 2. Fallback：查 judge 目录下的 img 子目录
    path = DATASETS_JUDGE_DIR / dataset / "img" / safe
    if path.exists():
        return send_file(path.open("rb"), mimetype="image/png")
    
    return jsonify({"error": "not found"}), 404


# ==================== 路由：unit 详情 & 标注 ====================
@app.route("/api/unit/<task_id>/<group_id>/<int:unit_id>", methods=["GET"])
def get_unit(task_id, group_id, unit_id):
    """获取某个 unit 的详细数据（含原图、mask 路径、连通集元信息）"""
    if "user" not in session:
        return jsonify({"error": "未登录"}), 401
    username = session["user"]

    # 校验权限：缓存 task 读取
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

    # 加载已有标注：缓存 30 秒
    anno_cache_key = f"anno:{task_id}:{group_id}:{unit_id}"
    existing = annotation_cache.get(anno_cache_key)
    if existing is None:
        ann_file = ANNOTATIONS_DIR / task_id / group_id / f"unit_{unit_id:06d}.json"
        if ann_file.exists():
            with open(ann_file, "r", encoding="utf-8") as f:
                existing = json.load(f)
        annotation_cache.set(anno_cache_key, existing)

    task_type = task.get("task_type", "judge")
    if task_type == "judge_shp":
        # judge_shp: 无 mask，返回多边形数据用于前端渲染
        return jsonify({
            "unit": unit,
            "image_url": f"/api/image/{quote(unit['image'])}?dataset={task['dataset']}",
            "mask_url": None,
            "task_type": "judge_shp",
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


@app.route("/api/unit/<task_id>/<group_id>/<int:unit_id>/submit", methods=["POST"])
def submit_unit(task_id, group_id, unit_id):
    """保存某个 unit 的标注结果"""
    if "user" not in session:
        return jsonify({"error": "未登录"}), 401
    username = session["user"]

    # 权限校验
    task_file = TASKS_DIR / f"{task_id}.json"
    if not task_file.exists():
        return jsonify({"error": "task 不存在"}), 404
    with open(task_file, "r", encoding="utf-8") as f:
        task = json.load(f)
    group = next((g for g in task.get("groups", []) if g["group_id"] == group_id), None)
    if not group or group["username"] != username:
        return jsonify({"error": "无权访问"}), 403

    data = request.get_json() or {}
    record = {
        "task_id": task_id,
        "group_id": group_id,
        "unit_id": unit_id,
        "username": username,
        "result": data.get("result"),                # 标注结果（如 "是"/"否"/"不确定"）
        "park_type": data.get("park_type"),           # 园区类型
        "transport_modes": data.get("transport_modes", []),  # 运输方式列表
        "comment": data.get("comment", ""),
        "updated_at": datetime.now().isoformat(),
    }
    out_dir = ANNOTATIONS_DIR / task_id / group_id
    out_dir.mkdir(parents=True, exist_ok=True)
    save_json(out_dir / f"unit_{unit_id:06d}.json", record)

    # 实时统计进度（不写回 task.json，避免并发竞态）
    done = sum(1 for f in out_dir.glob("*.json"))
    progress = {"done": done, "total": len(group.get("units", []))}

    # 使相关缓存失效
    task_cache.invalidate(f"user_tasks:{username}")
    task_cache.invalidate(f"task:{task_id}")
    status_cache.invalidate(f"status:{task_id}:{group_id}")
    annotation_cache.invalidate(f"anno:{task_id}:{group_id}:{unit_id}")

    return jsonify({"ok": True, "progress": progress})


# ==================== POI 任务 unit 详情 & 标注 ====================
@app.route("/api/poi_unit/<task_id>/<group_id>/<int:unit_id>", methods=["GET"])
def get_poi_unit(task_id, group_id, unit_id):
    """获取 POI 任务 unit 详情（PNG 图片 + aux.xml 地理信息）"""
    if "user" not in session:
        return jsonify({"error": "未登录"}), 401
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

    # 加载已有标注
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


@app.route("/api/poi_unit/<task_id>/<group_id>/<int:unit_id>/submit", methods=["POST"])
def submit_poi_unit(task_id, group_id, unit_id):
    """保存 POI 任务 unit 标注（checkbox 多选 + 状态）"""
    if "user" not in session:
        return jsonify({"error": "未登录"}), 401
    username = session["user"]

    task_file = TASKS_DIR / f"{task_id}.json"
    if not task_file.exists():
        return jsonify({"error": "task 不存在"}), 404
    with open(task_file, "r", encoding="utf-8") as f:
        task = json.load(f)
    group = next((g for g in task.get("groups", []) if g["group_id"] == group_id), None)
    if not group or group["username"] != username:
        return jsonify({"error": "无权访问"}), 403

    data = request.get_json() or {}
    record = {
        "task_id": task_id,
        "group_id": group_id,
        "unit_id": unit_id,
        "username": username,
        "poi_labels": data.get("poi_labels", []),            # 派生自 polygons 的标签列表
        "polygons": data.get("polygons", []),                # [{label, points: [[pctx,pcty],...]}]
        "transport_modes": data.get("transport_modes", []),   # ["公路","铁路",...]
        "comment": data.get("comment", ""),
        "updated_at": datetime.now().isoformat(),
    }
    out_dir = ANNOTATIONS_DIR / task_id / group_id
    out_dir.mkdir(parents=True, exist_ok=True)
    save_json(out_dir / f"unit_{unit_id:06d}.json", record)

    # 实时统计进度（不写回 task.json，避免并发竞态）
    done = sum(1 for f in out_dir.glob("*.json"))
    progress = {"done": done, "total": len(group.get("units", []))}

    task_cache.invalidate(f"user_tasks:{username}")
    task_cache.invalidate(f"task:{task_id}")
    status_cache.invalidate(f"status:{task_id}:{group_id}")
    annotation_cache.invalidate(f"anno_poi:{task_id}:{group_id}:{unit_id}")

    return jsonify({"ok": True, "progress": progress})


# ==================== POI 缓存 ====================
@app.route("/api/poi_cache", methods=["GET"])
def get_poi_cache():
    """查询某个坐标的 POI 缓存"""
    key = request.args.get("key", "")
    if not key:
        return jsonify({"found": False})
    safe_key = re.sub(r'[^0-9._\-]', '', key)
    if not safe_key or len(safe_key) > 64:
        return jsonify({"found": False})

    # 先查内存缓存（1 小时 TTL）
    mem_key = f"poi:{safe_key}"
    cached = poi_mem_cache.get(mem_key)
    if cached is not None:
        return jsonify({"found": True, "pois": cached})

    # 再查文件缓存
    cache_file = POI_CACHE_DIR / f"{safe_key}.json"
    if cache_file.exists():
        data = load_json(cache_file)
        pois = data.get("pois", [])
        poi_mem_cache.set(mem_key, pois)
        return jsonify({"found": True, "pois": pois})
    return jsonify({"found": False})


@app.route("/api/poi_cache", methods=["POST"])
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
    # 同步更新内存缓存
    poi_mem_cache.set(f"poi:{safe_key}", pois)
    return jsonify({"ok": True})


# ==================== 高德 Key 耗竭检测 ====================
@app.route("/api/amap/report_exhausted", methods=["POST"])
def report_amap_exhausted():
    """
    前端报告：某个坐标周边 5 类 POI 全部返回空
    后端统计不同坐标数，达到阈值自动切换 key
    """
    data = request.get_json() or {}
    cache_key = (data.get("cache_key") or "").strip()
    if not cache_key:
        return jsonify({"ok": False, "reason": "missing cache_key"})

    global amap_empty_coords
    amap_empty_coords.add(cache_key)
    count = len(amap_empty_coords)

    rotated = False
    if count >= AMAP_EXHAUSTION_THRESHOLD:
        rotated = True
        info = _rotate_amap_key()
        print(f"[AMAP] 自动切换 Key → {info.get('label')} (index={info.get('index')})")
        print(f"       {count} 个不同坐标返回全空，达到阈值 {AMAP_EXHAUSTION_THRESHOLD}，疑似 Key 配额耗竭")

    return jsonify({
        "ok": True,
        "empty_coords_count": count,
        "threshold": AMAP_EXHAUSTION_THRESHOLD,
        "rotated": rotated,
    })


@app.route("/api/amap/reset_counter", methods=["POST"])
def reset_amap_counter():
    """前端有任一 POI 搜索返回结果时，重置全空计数器"""
    global amap_empty_coords
    amap_empty_coords.clear()
    return jsonify({"ok": True})


# ==================== 管理员：高德 Key 管理 ====================
@app.route("/api/admin/amap/status", methods=["GET"])
def admin_amap_status():
    """查看当前 key 状态"""
    if session.get("role") != "admin":
        return jsonify({"error": "无权限"}), 403
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


@app.route("/api/admin/amap/rotate", methods=["POST"])
def admin_amap_rotate():
    """管理员手动切换 key"""
    if session.get("role") != "admin":
        return jsonify({"error": "无权限"}), 403
    info = _rotate_amap_key()
    return jsonify({"ok": True, "new_key": info})


# ==================== 管理员：dataset 管理 ====================
@app.route("/api/admin/datasets", methods=["GET"])
def admin_list_datasets():
    if session.get("role") != "admin":
        return jsonify({"error": "无权限"}), 403
    datasets = []

    # 扫描 judge 数据集
    if DATASETS_JUDGE_DIR.exists():
        for d in sorted(DATASETS_JUDGE_DIR.iterdir()):
            if not d.is_dir():
                continue
            img_dir = d / "img"
            mask_dir = d / "mask"
            # 检测子类型
            coco_files = list(d.glob("*_coco_clean.json")) + list(d.glob("*_coco.json"))
            index_csv = d / "index.csv"
            if coco_files and index_csv.exists():
                # judge_shp: 统计所有子目录中的 jpg
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

    # 扫描 POI 数据集
    if DATASETS_POI_DIR.exists():
        for d in sorted(DATASETS_POI_DIR.iterdir()):
            if not d.is_dir():
                continue
            png_count = len(list(d.glob("*.png")))
            aux_count = len(list(d.glob("*.png.aux.xml")))
            datasets.append({
                "name": d.name,
                "type": "poi",
                "img_count": png_count,
                "mask_count": aux_count,
            })

    return jsonify(datasets)


@app.route("/api/admin/dataset/<name>/analyze", methods=["GET"])
def admin_analyze_dataset(name):
    """分析 dataset 信息"""
    if session.get("role") != "admin":
        return jsonify({"error": "无权限"}), 403

    ds_type = _detect_dataset_type(name)
    if ds_type is None:
        return jsonify({"error": "dataset 不存在"}), 404

    if ds_type in ("judge_mask", "judge"):
        mask_dir = DATASETS_JUDGE_DIR / name / "mask"
        if not mask_dir.exists():
            return jsonify({"error": "dataset 无 mask 目录"}), 404

        total_units = 0
        per_image = []
        for mask_file in sorted(mask_dir.glob("*.png")):
            coords = _parse_coords_from_filename(mask_file.name)
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
        units = _load_judge_shp_units(dataset_path)
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
        # POI 数据集：每个 PNG 是一个 unit
        poi_dir = DATASETS_POI_DIR / name
        png_files = sorted(poi_dir.glob("*.png"))
        per_image = []
        total_units = 0
        for png_file in png_files:
            aux_file = Path(str(png_file) + ".aux.xml")
            geo = _parse_aux_xml(aux_file) if aux_file.exists() else None
            if geo:
                total_units += 1
                per_image.append({
                    "image": png_file.name,
                    "num_units": 1,
                    "lat": round(geo["originY"] + geo["pixelHeight"] * 1000, 6),   # 粗略中心
                    "lng": round(geo["originX"] + geo["pixelWidth"] * 1000, 6),
                })
            else:
                total_units += 1
                per_image.append({"image": png_file.name, "num_units": 1})

        return jsonify({
            "dataset": name,
            "type": "poi",
            "total_units": total_units,
            "per_image": per_image,
        })


# ==================== 管理员：创建任务 ====================
@app.route("/api/admin/create_task", methods=["POST"])
def admin_create_task():
    """
    Body:
    {
      "task_name": "xxx",
      "dataset": "test",
      "num_groups": 3,
      "overlap_factor": 2        # 1=不重叠, 2=每图被2组标 (POI 任务忽略)
    }
    系统根据 dataset 所在目录自动判定 task_type: "judge" 或 "poi"
    """
    if session.get("role") != "admin":
        return jsonify({"error": "无权限"}), 403
    data = request.get_json() or {}
    task_name = (data.get("task_name") or "").strip()
    dataset = (data.get("dataset") or "").strip()
    num_groups = int(data.get("num_groups") or 1)
    overlap_factor = int(data.get("overlap_factor") or 1)

    if not task_name or not dataset:
        return jsonify({"error": "缺少 task_name 或 dataset"}), 400
    if num_groups < 1:
        return jsonify({"error": "组数必须 >= 1"}), 400

    ds_type = _detect_dataset_type(dataset)
    if ds_type is None:
        return jsonify({"error": f"dataset {dataset} 不存在"}), 404

    # ===== judge_mask 任务：mask 连通集分析 =====
    if ds_type in ("judge_mask", "judge"):
        if overlap_factor < 1 or overlap_factor > num_groups:
            return jsonify({"error": "重叠系数非法"}), 400

        mask_dir = DATASETS_JUDGE_DIR / dataset / "mask"
        if not mask_dir.exists():
            return jsonify({"error": f"dataset {dataset} 无 mask 目录"}), 404

        all_units = []
        for mask_file in sorted(mask_dir.glob("*.png")):
            # 从文件名提取经纬度
            coords = _parse_coords_from_filename(mask_file.name)
            lat, lng = coords if coords else (None, None)

            info = analyze_connected_components(mask_file)
            for comp in info.get("components", []):
                all_units.append({
                    "id": len(all_units) + 1,
                    "image": mask_file.name,
                    "lat": lat,
                    "lng": lng,
                    "component_id": comp["id"],
                    "bbox": comp["bbox"],
                    "area": comp["area"],
                    "centroid": comp["centroid"],
                })

        groups_units = distribute_units_with_overlap(all_units, num_groups, overlap_factor)

    # ===== judge_shp 任务：从 COCO JSON 加载多边形 =====
    elif ds_type == "judge_shp":
        if overlap_factor < 1 or overlap_factor > num_groups:
            return jsonify({"error": "重叠系数非法"}), 400

        dataset_path = DATASETS_JUDGE_DIR / dataset
        all_units = _load_judge_shp_units(dataset_path)
        if not all_units:
            return jsonify({"error": f"dataset {dataset} 无有效单元"}), 404

        groups_units = distribute_units_with_overlap(all_units, num_groups, overlap_factor)

    # ===== POI 任务：每个 PNG 是一个 unit =====
    else:
        if overlap_factor < 1 or overlap_factor > num_groups:
            return jsonify({"error": "重叠系数非法"}), 400

        poi_dir = DATASETS_POI_DIR / dataset
        png_files = sorted(poi_dir.glob("*.png"))

        all_units = []
        for png_file in png_files:
            name_no_ext = png_file.stem
            aux_file = Path(str(png_file) + ".aux.xml")
            geo = _parse_aux_xml(aux_file) if aux_file.exists() else None

            unit = {
                "id": len(all_units) + 1,
                "image": png_file.name,
                "name": name_no_ext,
                "lat": None,
                "lng": None,
            }
            if geo:
                # 用 cv2 获取图像尺寸来计算中心坐标
                try:
                    img = cv2.imdecode(np.fromfile(str(png_file), dtype=np.uint8), cv2.IMREAD_GRAYSCALE)
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
                    # 回退：粗略估计中心
                    unit["lat"] = round(geo["originY"] + geo["pixelHeight"] * 1000, 6)
                    unit["lng"] = round(geo["originX"] + geo["pixelWidth"] * 1000, 6)
                unit["geo_transform"] = geo

            all_units.append(unit)

        # POI 任务也使用交叉验证分配（与 Judge 一致）
        groups_units = distribute_units_with_overlap(all_units, num_groups, overlap_factor)

    # ===== 生成账号 =====
    task_id = f"task_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{secrets.token_hex(3)}"
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

    # ===== 持久化 task =====
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

    # 清空所有用户任务缓存
    task_cache.invalidate_prefix("user_tasks:")
    task_cache.invalidate(f"task:{task_id}")

    return jsonify({
        "ok": True,
        "task": task,
    })


@app.route("/api/admin/tasks", methods=["GET"])
def admin_list_tasks():
    if session.get("role") != "admin":
        return jsonify({"error": "无权限"}), 403
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


@app.route("/api/admin/task/<task_id>/detail", methods=["GET"])
def admin_task_detail(task_id):
    """任务执行详情：各组进度 + 交叉标注一致性分析"""
    if session.get("role") != "admin":
        return jsonify({"error": "无权限"}), 403

    task_path = TASKS_DIR / f"{task_id}.json"
    if not task_path.exists():
        return jsonify({"error": "任务不存在"}), 404

    with open(task_path, "r", encoding="utf-8") as fp:
        task = json.load(fp)

    # 更新各组进度
    for group in task["groups"]:
        gid = group["group_id"]
        annot_dir = ANNOTATIONS_DIR / task_id / gid
        done = 0
        if annot_dir.exists():
            done = len(list(annot_dir.glob("unit_*.json")))
        group["progress"] = {"done": done, "total": group["unit_count"]}

    # ---- 交叉标注一致性分析 ----
    # key = "image文件名|component_id" → 跨组匹配
    unit_ann_map: Dict[str, list] = {}

    for group in task["groups"]:
        gid = group["group_id"]
        annot_dir = ANNOTATIONS_DIR / task_id / gid
        if not annot_dir.exists():
            continue
        for ann_file in annot_dir.glob("unit_*.json"):
            with open(ann_file, "r", encoding="utf-8") as fp:
                ann = json.load(fp)
            unit_id = ann.get("unit_id")
            result = ann.get("result", "")
            if not result:
                continue
            # 找到该 unit 的 image + component_id
            unit_info = next((u for u in group.get("units", []) if u["id"] == unit_id), None)
            if not unit_info:
                continue
            # POI unit 没有 component_id，用 id 替代
            comp_id = unit_info.get('component_id', unit_info['id'])
            key = f"{unit_info['image']}|{comp_id}"
            if key not in unit_ann_map:
                unit_ann_map[key] = []
            unit_ann_map[key].append({
                "group_id": gid,
                "unit_id": unit_id,
                "result": result,
                "park_type": ann.get("park_type", ""),
                "transport_modes": ann.get("transport_modes", [])
            })

    total_overlap = 0   # 被 ≥2 组标注的 unit 数
    consistent = 0
    inconsistent_details = []

    for key, ann_list in unit_ann_map.items():
        if len(ann_list) < 2:
            continue
        total_overlap += 1
        results = [a["result"] for a in ann_list]
        if len(set(results)) == 1:
            consistent += 1
        else:
            img, comp_id = key.split("|", 1)
            inconsistent_details.append({
                "image": img,
                "component_id": int(comp_id) if comp_id.isdigit() else comp_id,
                "annotations": ann_list
            })

    inconsistent = total_overlap - consistent

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
            "total_overlap": total_overlap,
            "consistent": consistent,
            "inconsistent": inconsistent,
            "inconsistent_ratio": round(inconsistent / total_overlap * 100, 1) if total_overlap > 0 else 0,
            "details": inconsistent_details
        }
    })


@app.route("/api/admin/task/<task_id>/delete", methods=["POST"])
def admin_delete_task(task_id):
    """删除指定任务及其关联数据"""
    if session.get("role") != "admin":
        return jsonify({"error": "无权限"}), 403

    task_path = TASKS_DIR / f"{task_id}.json"
    if not task_path.exists():
        return jsonify({"error": "任务不存在"}), 404

    # 读取任务信息
    with open(task_path, "r", encoding="utf-8") as f:
        task = json.load(f)

    task_name = task.get("task_name", task_id)

    # 1. 从 user.json 中移除关联账号
    users_data = load_json(USER_FILE, {"users": []})
    original_count = len(users_data.get("users", []))
    users_data["users"] = [
        u for u in users_data.get("users", [])
        if u.get("task_id") != task_id
    ]
    save_json(USER_FILE, users_data)
    removed_accounts = original_count - len(users_data.get("users", []))

    # 2. 删除标注目录
    import shutil
    annot_dir = ANNOTATIONS_DIR / task_id
    if annot_dir.exists():
        shutil.rmtree(str(annot_dir))

    # 3. 删除任务 JSON 文件
    task_path.unlink()

    # 4. 清除相关缓存
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


@app.route("/api/admin/task/<task_id>/download_accounts", methods=["GET"])
def admin_download_accounts(task_id):
    """下载该任务所有组的账号密码为 txt / zip"""
    if session.get("role") != "admin":
        return jsonify({"error": "无权限"}), 403
    task_file = TASKS_DIR / f"{task_id}.json"
    if not task_file.exists():
        return jsonify({"error": "task 不存在"}), 404
    with open(task_file, "r", encoding="utf-8") as f:
        task = json.load(f)

    # 生成 txt 内容
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

    # 返回 zip
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


# ==================== 启动 ====================
if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="物流园区判读系统")
    parser.add_argument("--host", default="0.0.0.0", help="监听地址")
    parser.add_argument("--port", type=int, default=8081, help="监听端口")
    parser.add_argument("--prod", action="store_true", help="生产模式（使用 Waitress，否则用 Flask 多线程开发服务器）")
    parser.add_argument("--threads", type=int, default=20, help="工作线程数（默认 20，适配 138 并发用户）")
    parser.add_argument("--debug", action="store_true", help="开启 Flask debug 模式（仅开发）")
    args = parser.parse_args()

    print(f"Datasets Judge: {DATASETS_JUDGE_DIR}")
    print(f"Datasets POI:   {DATASETS_POI_DIR}")
    print(f"Accounts:       {ACCOUNTS_DIR}")
    print(f"Tasks:          {TASKS_DIR}")
    print(f"Frontend:       {FRONTEND_DIR}")
    print(f"Mode:      {'Waitress (production)' if args.prod else 'Flask dev (multi-threaded)'}")
    print(f"Threads:   {args.threads}")

    if args.prod:
        try:
            from waitress import serve
            print(f"Starting Waitress on {args.host}:{args.port} with {args.threads} threads")
            serve(app, host=args.host, port=args.port, threads=args.threads,
                  connection_limit=200, channel_timeout=120)
        except ImportError:
            print("[WARN] waitress 未安装，回退到 Flask 多线程模式")
            print("[TIP]  安装: D:\\Coding\\python.exe -m pip install waitress")
            app.run(host=args.host, port=args.port, threaded=True, debug=args.debug)
    else:
        app.run(host=args.host, port=args.port, threaded=True, debug=args.debug)
