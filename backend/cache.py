"""
内存缓存层：TTL 缓存 + LRU 图片缓存 + 并发锁
"""
import threading
import time
from collections import OrderedDict
from typing import Any, Dict, Optional


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


class ImageLRUCache:
    """线程安全的 LRU 图片缓存，用 OrderedDict 实现 O(1) 驱逐"""

    def __init__(self, max_size_bytes: int = int(512 * 1024 * 1024)):
        self._max_size = max_size_bytes
        self._store: OrderedDict = OrderedDict()
        self._lock = threading.Lock()
        self._current_size = 0

    def get(self, key: str) -> Optional[bytes]:
        with self._lock:
            data = self._store.pop(key, None)
            if data is not None:
                self._store[key] = data  # move to end (most recent)
            return data

    def set(self, key: str, data: bytes) -> None:
        with self._lock:
            old = self._store.pop(key, None)
            if old is not None:
                self._current_size -= len(old)
            self._store[key] = data
            self._current_size += len(data)
            while self._current_size > self._max_size and self._store:
                _, removed = self._store.popitem(last=False)
                self._current_size -= len(removed)

    def stats(self) -> Dict[str, Any]:
        with self._lock:
            return {
                "entries": len(self._store),
                "size_mb": round(self._current_size / (1024 * 1024), 2),
                "max_mb": round(self._max_size / (1024 * 1024), 2),
            }


# ==================== 共享缓存实例 ====================
task_cache = MemoryCache(default_ttl=60.0)        # task JSON 60 秒缓存
status_cache = MemoryCache(default_ttl=15.0)       # unit 状态 15 秒缓存
annotation_cache = MemoryCache(default_ttl=30.0)   # 标注内容 30 秒缓存
poi_mem_cache = MemoryCache(default_ttl=3600.0)    # POI 结果 1 小时缓存
image_cache = ImageLRUCache(max_size_bytes=int(512 * 1024 * 1024))  # 图片 512MB LRU

# ==================== 并发锁 ====================
_user_file_lock = threading.Lock()  # 防止 user.json 的 read-modify-write 竞态
_coco_cache_lock = threading.Lock()  # COCO JSON 加载锁
