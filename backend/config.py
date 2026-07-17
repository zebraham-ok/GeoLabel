"""
judging_app 路径与常量配置
"""
from pathlib import Path

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

# ==================== 文件路径常量 ====================
ADMIN_FILE = ACCOUNTS_DIR / "admin.json"
USER_FILE = ACCOUNTS_DIR / "user.json"
AMAP_CONFIG_FILE = ROOT / "amap_config.json"
SERVER_CONFIG_FILE = ROOT / "server_config.json"

# ==================== 高德 Key 耗竭阈值 ====================
AMAP_EXHAUSTION_THRESHOLD = 8   # N 个不同坐标全空 → 自动切换 key

# ==================== 图片浏览器缓存 ====================
IMAGE_CACHE_MAX_AGE = 86400  # 24 小时

# ==================== POI 图像格式支持 ====================
# POI 数据集可能包含的常见图片扩展名（小写，含点号）
POI_IMAGE_EXTENSIONS = {'.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif'}

# 扩展名 → MIME 类型映射（前端 /api/poi_image 返回）
MIME_BY_EXT = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
}
