"""
路由注册：集中导入并注册所有 Blueprint
"""
from flask import Flask


def register_routes(app: Flask) -> None:
    """注册所有路由 Blueprint"""
    from routes.pages import pages_bp
    from routes.auth import auth_bp
    from routes.user import user_bp
    from routes.images import images_bp
    from routes.poi import poi_bp
    from routes.amap import amap_bp
    from routes.admin import admin_bp
    from routes.review import review_bp

    app.register_blueprint(pages_bp)
    app.register_blueprint(auth_bp)
    app.register_blueprint(user_bp)
    app.register_blueprint(images_bp)
    app.register_blueprint(poi_bp)
    app.register_blueprint(amap_bp)
    app.register_blueprint(admin_bp)
    app.register_blueprint(review_bp)
