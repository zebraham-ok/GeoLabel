"""
认证路由：登录、登出、当前用户
"""
from flask import Blueprint, jsonify, request, session

from config import ADMIN_FILE, USER_FILE
from utils import load_json

auth_bp = Blueprint("auth", __name__)


@auth_bp.route("/api/login", methods=["POST"])
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


@auth_bp.route("/api/logout", methods=["POST"])
def logout():
    session.clear()
    return jsonify({"ok": True})


@auth_bp.route("/api/current_user", methods=["GET"])
def current_user():
    if "user" not in session:
        return jsonify({"logged_in": False}), 401
    return jsonify({
        "logged_in": True,
        "username": session["user"],
        "role": session.get("role", "user"),
        "task_type": session.get("task_type", ""),
    })
