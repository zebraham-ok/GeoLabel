"""
HTML 页面路由
"""
from flask import Blueprint, send_file

from config import FRONTEND_DIR
from amap import get_active_amap_key

pages_bp = Blueprint("pages", __name__)


@pages_bp.route("/")
def index():
    amap = get_active_amap_key()
    html_path = FRONTEND_DIR / "index.html"
    with open(html_path, "r", encoding="utf-8") as f:
        html = f.read()
    html = html.replace("{{ AMAP_KEY }}", amap["key"])
    html = html.replace("{{ AMAP_SECURITY_CODE }}", amap["security_code"])
    return html


@pages_bp.route("/poi")
def poi_page():
    """POI 任务页面"""
    amap = get_active_amap_key()
    html_path = FRONTEND_DIR / "poi.html"
    if not html_path.exists():
        return "POI 页面不存在", 404
    with open(html_path, "r", encoding="utf-8") as f:
        html = f.read()
    html = html.replace("{{ AMAP_KEY }}", amap["key"])
    html = html.replace("{{ AMAP_SECURITY_CODE }}", amap["security_code"])
    return html


@pages_bp.route("/hybrid")
def hybrid_page():
    """Hybrid 任务页面（判读+POI 两步标注）"""
    amap = get_active_amap_key()
    html_path = FRONTEND_DIR / "hybrid.html"
    if not html_path.exists():
        return "Hybrid 页面不存在", 404
    with open(html_path, "r", encoding="utf-8") as f:
        html = f.read()
    html = html.replace("{{ AMAP_KEY }}", amap["key"])
    html = html.replace("{{ AMAP_SECURITY_CODE }}", amap["security_code"])
    return html


@pages_bp.route("/admin")
def admin_page():
    return send_file(str(FRONTEND_DIR / "admin.html"))


@pages_bp.route("/review_judge")
def review_judge_page():
    """审核-判读页面"""
    amap = get_active_amap_key()
    html_path = FRONTEND_DIR / "review_judge.html"
    if not html_path.exists():
        return "审核判读页面不存在", 404
    with open(html_path, "r", encoding="utf-8") as f:
        html = f.read()
    html = html.replace("{{ AMAP_KEY }}", amap["key"])
    html = html.replace("{{ AMAP_SECURITY_CODE }}", amap["security_code"])
    return html


@pages_bp.route("/review_poi")
def review_poi_page():
    """审核-POI页面"""
    amap = get_active_amap_key()
    html_path = FRONTEND_DIR / "review_poi.html"
    if not html_path.exists():
        return "审核POI页面不存在", 404
    with open(html_path, "r", encoding="utf-8") as f:
        html = f.read()
    html = html.replace("{{ AMAP_KEY }}", amap["key"])
    html = html.replace("{{ AMAP_SECURITY_CODE }}", amap["security_code"])
    return html


@pages_bp.route("/review_hybrid")
def review_hybrid_page():
    """审核-Hybrid页面"""
    amap = get_active_amap_key()
    html_path = FRONTEND_DIR / "review_hybrid.html"
    if not html_path.exists():
        return "审核Hybrid页面不存在", 404
    with open(html_path, "r", encoding="utf-8") as f:
        html = f.read()
    html = html.replace("{{ AMAP_KEY }}", amap["key"])
    html = html.replace("{{ AMAP_SECURITY_CODE }}", amap["security_code"])
    return html
