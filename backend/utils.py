"""
通用工具函数：JSON 读写、密码生成、认证装饰器
"""
import json
import os
import secrets
import string
import threading
import uuid
from functools import wraps
from pathlib import Path
from typing import Any

from flask import jsonify, session


# ==================== JSON 文件操作 ====================
def load_json(path: Path, default: Any = None) -> Any:
    if not path.exists():
        return default if default is not None else {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, IOError):
        return default if default is not None else {}


def save_json(path: Path, data: Any, atomic: bool = True) -> None:
    """原子写入 JSON：用唯一临时文件 + rename，避免并发竞态"""
    if atomic:
        tmp = path.with_suffix(path.suffix + f".{os.getpid()}_{threading.get_ident()}_{uuid.uuid4().hex[:6]}.tmp")
        try:
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
            tmp.replace(path)
        except Exception:
            tmp.unlink(missing_ok=True)
            raise
    else:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)


def gen_password(length: int = 8) -> str:
    """生成随机密码"""
    alphabet = string.ascii_letters + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(length))


# ==================== 认证装饰器 ====================
def login_required(f):
    """要求已登录（session 中有 user）"""
    @wraps(f)
    def wrapper(*args, **kwargs):
        if "user" not in session:
            return jsonify({"error": "未登录"}), 401
        return f(*args, **kwargs)
    return wrapper


def admin_required(f):
    """要求管理员角色（隐含已登录检查）"""
    @wraps(f)
    def wrapper(*args, **kwargs):
        if "user" not in session:
            return jsonify({"error": "未登录"}), 401
        if session.get("role") != "admin":
            return jsonify({"error": "无权限"}), 403
        return f(*args, **kwargs)
    return wrapper
