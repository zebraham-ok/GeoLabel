"""
judging_app 后端服务入口
- 创建 Flask 应用 + 注册路由
- CLI 启动参数（开发/生产模式）
"""
import argparse
import json
import os
import secrets
from typing import Any, Dict

from flask import Flask
from flask_cors import CORS

from config import FRONTEND_DIR, DATASETS_JUDGE_DIR, DATASETS_POI_DIR, \
    ACCOUNTS_DIR, TASKS_DIR, SERVER_CONFIG_FILE
from routes import register_routes


def create_app() -> Flask:
    """应用工厂：创建 Flask app 并注册所有 Blueprint"""
    app = Flask(__name__, static_folder=str(FRONTEND_DIR), static_url_path="")

    # secret_key
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

    # 注册所有路由蓝图
    register_routes(app)

    return app


if __name__ == "__main__":
    # 1. 加载配置文件中默认值
    config_defaults: Dict[str, Any] = {}
    if SERVER_CONFIG_FILE.exists():
        try:
            with open(SERVER_CONFIG_FILE, "r", encoding="utf-8") as f:
                config_defaults = json.load(f)
            print(f"[config] 已加载服务器配置文件: {SERVER_CONFIG_FILE}")
        except Exception as e:
            print(f"[warn] 服务器配置文件读取失败: {e}，使用内置默认值")

    # 2. 命令行参数优先于配置文件
    parser = argparse.ArgumentParser(
        description="物流园区判读系统（配置文件: backend/server_config.json）",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("--host", default=config_defaults.get("host", "0.0.0.0"), help="监听地址")
    parser.add_argument("--port", type=int, default=config_defaults.get("port", 8081), help="监听端口")
    parser.add_argument("--threads", type=int, default=config_defaults.get("threads", 80), help="工作线程数")
    parser.add_argument("--prod", action="store_true", default=config_defaults.get("prod", False),
                        help="生产模式（使用 Waitress）")
    parser.add_argument("--debug", action="store_true", default=config_defaults.get("debug", False),
                        help="开启 Flask debug 模式（仅开发）")
    args = parser.parse_args()

    app = create_app()

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
                  connection_limit=500, channel_timeout=60)
        except ImportError:
            print("[WARN] waitress 未安装，回退到 Flask 多线程模式")
            print("[TIP]  安装: pip install waitress")
            app.run(host=args.host, port=args.port, threaded=True, debug=args.debug)
    else:
        app.run(host=args.host, port=args.port, threaded=True, debug=args.debug)
