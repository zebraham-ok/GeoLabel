"""
图片 & Mask 服务（带 LRU 内存缓存 + 浏览器缓存头）
"""
import os
from pathlib import Path

from flask import Blueprint, jsonify, request, Response
from urllib.parse import quote, unquote

from config import DATASETS_JUDGE_DIR, DATASETS_POI_DIR, IMAGE_CACHE_MAX_AGE, MIME_BY_EXT
from cache import image_cache

images_bp = Blueprint("images", __name__)


def _cached_send_file(filepath: Path, mimetype: str, cache_key: str):
    """
    带内存缓存 + 浏览器缓存头的 send_file：
    1. 内存 LRU 缓存命中 → 直接返回 bytes
    2. 磁盘读取 → 存入 LRU 缓存 → 返回
    3. 浏览器 If-None-Match → 304 Not Modified
    """
    etag_val = quote(cache_key, safe='')

    cached = image_cache.get(cache_key)
    if cached is not None:
        req_etag = request.headers.get("If-None-Match", "")
        if req_etag == etag_val:
            return Response(status=304)
        return Response(cached, mimetype=mimetype, headers={
            "Cache-Control": f"public, max-age={IMAGE_CACHE_MAX_AGE}, immutable",
            "ETag": etag_val,
        })

    try:
        data = filepath.read_bytes()
        image_cache.set(cache_key, data)
    except (IOError, OSError):
        return jsonify({"error": "read failed"}), 500

    return Response(data, mimetype=mimetype, headers={
        "Cache-Control": f"public, max-age={IMAGE_CACHE_MAX_AGE}, immutable",
        "ETag": etag_val,
    })


@images_bp.route("/api/image/<path:filename>")
def serve_image(filename):
    """从 datasets_judge/<dataset>/ 读取原图"""
    dataset = request.args.get("dataset", "")
    decoded = unquote(filename)

    img_dir = DATASETS_JUDGE_DIR / dataset / "img"
    path = img_dir / os.path.basename(decoded)
    if path.exists():
        ck = f"img:{dataset}:{os.path.basename(decoded)}:{path.stat().st_mtime}"
        return _cached_send_file(path, "image/png", ck)

    path = DATASETS_JUDGE_DIR / dataset / decoded
    if path.exists():
        ck = f"img:{dataset}:{decoded}:{path.stat().st_mtime}"
        return _cached_send_file(path, "image/jpeg", ck)

    return jsonify({"error": "not found"}), 404


@images_bp.route("/api/mask/<path:filename>")
def serve_mask(filename):
    dataset = request.args.get("dataset", "")
    mask_dir = DATASETS_JUDGE_DIR / dataset / "mask"
    safe = os.path.basename(unquote(filename))
    path = mask_dir / safe
    if not path.exists():
        return jsonify({"error": "not found"}), 404
    ck = f"mask:{dataset}:{safe}:{path.stat().st_mtime}"
    return _cached_send_file(path, "image/png", ck)


@images_bp.route("/api/poi_image/<path:filename>")
def serve_poi_image(filename):
    """从 datasets_poi/<dataset>/ 读取图片；找不到时 fallback 到 judge/img/"""
    dataset = request.args.get("dataset", "")
    safe = os.path.basename(unquote(filename))

    path = DATASETS_POI_DIR / dataset / safe
    if path.exists():
        ext = Path(safe).suffix.lower()
        mime = MIME_BY_EXT.get(ext, "image/png")
        ck = f"poi:{dataset}:{safe}:{path.stat().st_mtime}"
        return _cached_send_file(path, mime, ck)

    path = DATASETS_JUDGE_DIR / dataset / "img" / safe
    if path.exists():
        ext = Path(safe).suffix.lower()
        mime = MIME_BY_EXT.get(ext, "image/png")
        ck = f"poi_fb:{dataset}:{safe}:{path.stat().st_mtime}"
        return _cached_send_file(path, mime, ck)

    return jsonify({"error": "not found"}), 404
