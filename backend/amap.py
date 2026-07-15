"""
高德多 Key 管理 + 耗竭自动切换
"""
from pathlib import Path
from typing import Any, Dict

from config import AMAP_CONFIG_FILE, AMAP_EXHAUSTION_THRESHOLD
from utils import load_json, save_json

# 记录"全空"坐标，线程安全由 GIL 保证
amap_empty_coords: set = set()


def _load_amap_config_raw() -> Dict[str, Any]:
    """加载原始配置，兼容旧格式自动迁移"""
    cfg = load_json(AMAP_CONFIG_FILE, None)
    if cfg is None:
        return {"keys": [], "active_index": 0, "exhausted": []}
    if "key" in cfg and "keys" not in cfg:
        cfg = {
            "keys": [{"key": cfg["key"], "security_code": cfg.get("security_code", ""), "label": "default"}],
            "active_index": 0,
            "exhausted": [],
        }
        save_json(AMAP_CONFIG_FILE, cfg)
    return cfg


def get_active_amap_key() -> Dict[str, str]:
    """获取当前可用的高德 key，自动跳过已标记耗尽的"""
    cfg = _load_amap_config_raw()
    keys = cfg.get("keys", [])
    exhausted = set(cfg.get("exhausted", []))
    active = cfg.get("active_index", 0)

    if not keys:
        return {"key": "", "security_code": ""}

    for offset in range(len(keys)):
        idx = (active + offset) % len(keys)
        if idx not in exhausted:
            if idx != active:
                cfg["active_index"] = idx
                save_json(AMAP_CONFIG_FILE, cfg)
            k = keys[idx]
            return {"key": k.get("key", ""), "security_code": k.get("security_code", "")}

    k = keys[active % len(keys)]
    return {"key": k.get("key", ""), "security_code": k.get("security_code", "")}


def rotate_amap_key() -> Dict[str, Any]:
    """主动切换 key（管理员触发或自动），返回新 key 信息"""
    global amap_empty_coords

    cfg = _load_amap_config_raw()
    keys = cfg.get("keys", [])
    exhausted = set(cfg.get("exhausted", []))
    active = cfg.get("active_index", 0)

    if 0 <= active < len(keys):
        exhausted.add(active)
        cfg["exhausted"] = sorted(exhausted)

    new_active = active
    for offset in range(1, len(keys) + 1):
        idx = (active + offset) % len(keys)
        if idx not in exhausted:
            new_active = idx
            break

    cfg["active_index"] = new_active
    save_json(AMAP_CONFIG_FILE, cfg)

    amap_empty_coords.clear()

    if new_active < len(keys):
        k = keys[new_active]
        return {"key": k.get("key", ""), "security_code": k.get("security_code", ""),
                "label": k.get("label", ""), "index": new_active,
                "total_keys": len(keys), "exhausted_count": len(exhausted)}
    return {"key": "", "security_code": "", "label": "(all exhausted)",
            "index": -1, "total_keys": len(keys), "exhausted_count": len(exhausted)}
