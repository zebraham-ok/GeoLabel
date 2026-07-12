# 物流园区判读标注系统 (judging_app)

基于遥感影像与高德地图 POI 的物流园区人工判读标注系统。支持两种标注模式：**判读模式**（连通集分析 + 是/否判读）和 **POI 绘制模式**（卫星影像上手动绘制多边形 + 园区分类）。

管理员上传标注数据集（遥感原图 + 二值 mask）并创建标注任务，系统自动进行连通集分析、任务分配（支持重叠系数），生成标注账号分发给标注人员。标注人员在地图辅助下完成判读标注。

---

## 1. 快速启动

```cmd
cd backend
D:\Coding\python.exe server.py
```

服务运行在 `http://127.0.0.1:8081`

---

## 2. 访问地址

| 入口                  | 地址                            | 默认账号                   |
| --------------------- | ------------------------------- | -------------------------- |
| 管理员后台            | `http://127.0.0.1:8081/admin` | `admin` / `admin123`   |
| 用户标注端（判读）    | `http://127.0.0.1:8081/`      | 由管理员创建任务时自动生成 |
| 用户标注端（POI绘制） | `http://127.0.0.1:8081/poi`   | 同上                       |

---

## 3. 功能概述

### 3.1 管理员端 (`/admin`)

| 功能         | 说明                                                               |
| ------------ | ------------------------------------------------------------------ |
| 浏览数据组   | 列出`backend/datasets/` 下的所有 dataset 及图片/mask 数量        |
| 连通集分析   | 对 mask 中的每个连通区域进行连通域分析（bbox、面积、质心、轮廓）   |
| 创建标注任务 | 指定 dataset、组数 N、重叠系数 K，自动将连通集分配到各标注组       |
| 账号生成     | 每创建一个任务自动生成 N 组账号密码，可下载为`.zip` 分发         |
| 任务管理     | 查看所有已创建任务的基本信息                                       |
| 任务详情     | 查看某任务的详细统计（各组进度、标注一致性等）                     |
| 任务删除     | 删除任务及其关联账号和标注数据，弹窗确认「你确定要删除任务XX吗？」 |

**任务分配算法**：每个标注基本单位（一个连通集）随机选择 K 个组进行标注。K=1 时无重叠（每个 unit 只被一组标注），K=2 时每个 unit 由两组交叉验证，以此类推。

### 3.2 用户标注端 — 判读模式 (`/`)

| 区域       | 内容                   | 说明                                               |
| ---------- | ---------------------- | -------------------------------------------------- |
| 左侧面板   | 任务标签页 + Unit 列表 | 颜色区分已完成 / 当前 / 待标注                     |
| 中部主图   | 原图 + Mask 叠加       | 当前 unit 的 bbox 高亮框 + 半透明 mask             |
| 右侧地图   | 高德地图               | 自动定位到图片经纬度（从文件名解析），搜索周边 POI |
| 底部操作栏 | 三栏大按钮布局         | 判读 + 园区类型 + 运输方式 + 保存/翻页             |

**标注维度**：

| 维度                   | 类型                                                                                                              | 快捷键                        |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| 高亮区域是否是物流园区 | 是 / 否 / 不确定                                                                                                  | `Y` / `N` / `U`         |
| 园区类型（单选）       | 露天集装箱 / 露天散货 / 气液粮仓储罐 / 批发市场 / 立体现代物流园 / 传统集约物流园 / 小物流聚集地 / 码头/车站/机场 | `1` ~ `8`                 |
| 运输方式（多选）       | 公路 / 铁路 / 水路 / 航空                                                                                         | `Q` / `W` / `E` / `R` |

**交互行为**：

- 点击 Y/N/U 大按钮：仅保存并高亮，不自动跳转
- 点击「保存」/「下一项」/ 按 `Enter`：保存当前标注并跳转到下一个未完成项
- 点击「上一项」/ 按 `←`：自动保存当前标注并跳转到前一项
- 已完成项自动跳过；全部完成后停在当前页面

### 3.3 POI 绘制模式 (`/poi`)

在卫星影像上自由绘制多边形，标注物流园区类型和运输方式。适用于需要精确绘制园区边界的场景。

**页面布局**：

| 区域       | 内容                           | 说明                                            |
| ---------- | ------------------------------ | ----------------------------------------------- |
| 顶栏工具栏 | 当前标签 + 框数 + 撤销/删除    | 内嵌在顶栏中，左右面板对称对齐                  |
| 左侧面板   | 任务标签页 + Unit 列表         | 与判读模式相同的导航结构                        |
| 中部画布   | 卫星影像 + Canvas 覆盖层       | 鼠标点击添加顶点，双击闭合多边形                |
| 右侧地图   | 高德地图                       | 自动定位，搜索周边 POI 辅助判断                 |
| 底部操作栏 | 园区类型 + 运输方式 + 操作按钮 | 8 类园区类型（2×4 网格），按每个多边形单独设定 |

**标注方式**：

| 操作         | 说明                                                         |
| ------------ | ------------------------------------------------------------ |
| 绘制多边形   | 点击画布添加顶点 → 双击闭合（右键取消绘制）                 |
| 修改形状     | 拖动已有多边形顶点调整                                       |
| 设定园区类型 | 点击选中多边形 → 按数字键`1`~`8` 或点击底部按钮         |
| 设定运输方式 | 按`Q` / `W` / `E` / `R` 键切换（整幅图统一，可多选） |

**标注维度**：

| 维度     | 选项                                                                                                              | 快捷键                        | 范围             |
| -------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------- | ---------------- |
| 园区类型 | 露天集装箱 / 露天散货 / 气液粮仓储罐 / 批发市场 / 立体现代物流园 / 传统集约物流园 / 小物流聚集地 / 码头/车站/机场 | `1` ~ `8`                 | 每个框单独设定   |
| 运输方式 | 公路 / 铁路 / 水路 / 航空                                                                                         | `Q` / `W` / `E` / `R` | 整幅图统一，多选 |

**快捷键**：

| 键                            | 功能                     |
| ----------------------------- | ------------------------ |
| `1` ~ `8`                 | 设置选中多边形的园区类型 |
| `Q` / `W` / `E` / `R` | 切换运输方式（整幅图）   |
| `Del`                       | 删除选中的多边形         |
| `Esc`                       | 取消当前绘制             |
| `S`                         | 保存                     |
| `↵`                        | 保存并跳转下一页         |
| `←` `→`                 | 翻页                     |
| `↩`                        | 撤销（顶栏按钮）         |

### 3.4 高德地图 POI 搜索

右侧高德地图自动搜索图片经纬度周边 10km 范围内的 POI：

| POI 类别 | 关键词                               | 标记颜色 |
| -------- | ------------------------------------ | -------- |
| 物流园   | 物流园\|物流园区                     | 🔴 红    |
| 仓库     | 仓库\|仓储                           | 🔵 蓝    |
| 工业园区 | 工业园区                             | 🟢 绿    |
| 货运站   | 快递公司\|物流公司\|货运站\|货运中心 | 🟠 橙    |
| 批发市场 | 批发市场                             | 🟣 紫    |

地图右侧显示图例，支持卫星图层切换。

---

## 4. 技术架构

```
judging_app/
├── backend/                       # Python Flask 后端
│   ├── server.py                  # 主服务（含 MemoryCache、连通集分析、任务分配算法）
│   ├── amap_config.json           # 高德地图 API 密钥（不入 git）
│   ├── requirements.txt           # Python 依赖
│   ├── datasets/                  # 判读模式标注数据集
│   │   └── <dataset_name>/
│   │       ├── img/               # 遥感原图 PNG
│   │       └── mask/              # 二值 mask PNG（前景=255/1，背景=0）
│   ├── datasets_poi/              # POI 绘制模式数据集（仅需原图，无需 mask）
│   ├── accounts/                  # 账号存储
│   │   ├── admin.json             # 管理员账号
│   │   └── user.json             # 用户账号
│   ├── tasks/                     # 任务定义 JSON
│   ├── annotations/               # 标注结果 JSON
│   │   └── <task_id>/<group_id>/unit_XXXXXX.json
│   └── poi_cache/                 # POI 缓存持久化
│       └── <lng>_<lat>.json
├── frontend/                      # 静态前端
│   ├── index.html                 # 用户端 — 判读模式（高德密钥由后端模板注入）
│   ├── poi.html                   # 用户端 — POI 绘制模式（多边形标注）
│   ├── admin.html                 # 管理员端
│   ├── css/style.css              # 用户端公共样式
│   ├── css/poi.css                # POI 绘制模式样式
│   ├── css/admin.css              # 管理员样式
│   └── js/
│       ├── api.js                 # fetch API 封装（含判读+POI+管理员）
│       ├── main.js                # 判读模式主控逻辑（登录、快捷键、导航）
│       ├── poi_main.js            # POI 绘制模式主控逻辑（Canvas 多边形绘制）
│       ├── tasklist.js            # 左侧任务/unit 列表渲染
│       ├── annotate.js            # 标注操作（mask/render、bbox 绘制、保存）
│       └── map.js                 # 高德地图 + POI 搜索 + 缓存
└── README.md
```

**技术栈**：

- **后端**：Python 3, Flask 3, OpenCV (连通集分析), NumPy
- **生产服务器**：Waitress（多线程 WSGI）
- **前端**：原生 HTML/CSS/JS（无框架依赖）
- **地图**：高德地图 JS API 2.0 (AMap.PlaceSearch)
- **图像**：文件名含经纬度坐标，`object_lat_lng_...png` 格式
- **Canvas 绘制**：原生 Canvas API 实现多边形自由绘制，支持顶点拖动、撤销、删除

---

## 5. 环境要求

- **Python**：3.10+
- **操作系统**：Windows / Linux / macOS
- **高德地图 API Key**：需申请 Web 服务 Key（JS API 和 PlaceSearch 插件）
- **内存**：>= 512MB（单机）
- **磁盘**：SSD 推荐，取决于 dataset 大小（每个 PNG 约 1-5 MB）

---

## 6. 本地开发运行

### 6.1 安装依赖

```cmd
cd backend

:: 使用 pip 安装
D:\Coding\python.exe -m pip install -r requirements.txt
```

### 6.2 配置高德地图密钥（支持多 Key 自动切换）

在 `backend/` 目录下创建 `amap_config.json`：

```json
{
  "keys": [
    {
      "key": "您的高德JS API Key 1",
      "security_code": "安全密钥 1",
      "label": "key1"
    },
    {
      "key": "您的高德JS API Key 2",
      "security_code": "安全密钥 2",
      "label": "key2"
    }
  ],
  "active_index": 0,
  "exhausted": []
}
```

> 也兼容旧格式 `{"key": "...", "security_code": "..."}`，首次启动自动迁移。

**多 Key 自动切换机制**：当前端搜索 POI 时 5 类全部返回空结果，系统会记录该坐标。当 **3 个不同坐标** 均返回空时，自动标记当前 key 为耗尽、切换至下一个可用 key。下次页面刷新即使用新 key。管理员也可通过 API 手动切换：

```cmd
# 查看 key 状态
curl http://127.0.0.1:8081/api/admin/amap/status -b cookies.txt

# 手动切换 key
curl -X POST http://127.0.0.1:8081/api/admin/amap/rotate -b cookies.txt
```

管理员访问入口的默认账号在 `backend/accounts/admin.json` 中配置：

```json
{
  "admin_accounts": [
    {
      "username": "admin",
      "password": "admin123"
    }
  ]
}
```

生产环境请务必修改默认密码。

### 6.3 准备数据集

将遥感影像 PNG 和对应的二值 mask PNG 放入：

```
backend/datasets/<dataset_name>/
├── img/
│   ├── 丰台物流园_39.856_116.288_xxx.png
│   └── ...
└── mask/
    ├── 丰台物流园_39.856_116.288_xxx.png
    └── ...
```

**文件名规范**：包含经纬度坐标，格式为 `{名称}_{纬度}_{经度}_{...}.png`。系统自动从文件名解析地理坐标用于地图定位。

### 6.4 启动服务（本地开发）

```cmd
cd backend
D:\Coding\python.exe server.py
```

服务运行在 `http://127.0.0.1:8081`。

#### 启动参数说明

| 参数          | 默认值      | 说明                                     |
| ------------- | ----------- | ---------------------------------------- |
| `--host`    | `0.0.0.0` | 监听地址                                 |
| `--port`    | `8081`    | 监听端口                                 |
| `--prod`    | 关闭        | 启用 Waitress 生产服务器                 |
| `--threads` | `20`      | 工作线程数                               |
| `--debug`   | 关闭        | Flask debug 模式（仅开发，生产切勿开启） |

---

## 7. 生产环境部署（Linux 服务器）

生产环境使用 **Waitress（多线程 WSGI）+ Nginx（反向代理）+ Systemd（进程守护）**，兼容 Ubuntu/Debian 和 Alibaba Cloud Linux/RHEL/CentOS。

### 7.1 一键部署

将项目上传至服务器后执行：

```bash
chmod +x deploy/deploy.sh
sudo bash deploy/deploy.sh [域名] [端口]
# 示例：
sudo bash deploy/deploy.sh 39.97.238.76
sudo bash deploy/deploy.sh your-domain.com 8081
```

脚本自动完成：安装系统依赖 → 创建 Python 虚拟环境 → 安装 pip 包 → 配置 Systemd 服务 → 配置 Nginx 反向代理 → 启动服务。

### 7.2 手动部署

如果一键脚本不适用，按以下步骤手动部署：

```bash
# 1. 安装系统依赖（根据发行版选择）
# Ubuntu/Debian:
sudo apt-get update && sudo apt-get install -y python3 python3-pip python3-venv nginx
# RHEL/CentOS/Alibaba Cloud Linux:
sudo yum install -y epel-release && sudo yum install -y python3 python3-pip nginx
# 或 sudo dnf install -y python3 python3-pip nginx

# 2. 创建虚拟环境并安装依赖
python3 -m venv /opt/judging_app/backend/venv
/opt/judging_app/backend/venv/bin/pip install -r backend/requirements.txt

# 3. 复制 Systemd 服务文件
sudo cp deploy/judging_app.service /etc/systemd/system/
# 编辑文件，修改 WorkingDirectory、ExecStart 等路径
sudo vim /etc/systemd/system/judging_app.service

# 4. 复制 Nginx 配置
sudo cp deploy/nginx.conf /etc/nginx/conf.d/judging_app.conf
# 或 Ubuntu/Debian:
sudo cp deploy/nginx.conf /etc/nginx/sites-available/judging_app
sudo ln -s /etc/nginx/sites-available/judging_app /etc/nginx/sites-enabled/
sudo nginx -t

# 5. 设置环境变量（生产环境必须设置随机 SECRET_KEY）
export JUDGING_SECRET_KEY=$(openssl rand -hex 32)
```

### 7.3 服务管理命令

服务部署完成后，使用 `systemctl` 管理：

```bash
# ===== 启动服务 =====
sudo systemctl start judging_app     # 启动后端服务
sudo systemctl start nginx           # 启动 Nginx（通常已启动）

# ===== 停止服务 =====
sudo systemctl stop judging_app      # 停止后端服务
sudo systemctl stop nginx            # 停止 Nginx（谨慎，影响所有站点）

# ===== 重启服务 =====
sudo systemctl restart judging_app   # 完全重启后端（代码修改后执行）
sudo systemctl reload nginx          # 平滑重载 Nginx 配置（不中断连接）

# ===== 开机自启 =====
sudo systemctl enable judging_app    # 设置后端开机自启
sudo systemctl enable nginx          # Nginx 通常已自启

# ===== 禁用开机自启 =====
sudo systemctl disable judging_app   # 取消后端开机自启

# ===== 查看状态 =====
sudo systemctl status judging_app    # 查看后端运行状态
sudo systemctl status nginx          # 查看 Nginx 状态

# ===== 查看日志 =====
sudo journalctl -u judging_app -f                     # 实时日志（Ctrl+C 退出）
sudo journalctl -u judging_app -n 100 --no-pager      # 最近 100 条日志
sudo journalctl -u judging_app --since "10 min ago"   # 最近 10 分钟的日志
tail -f /var/log/nginx/judging_app_access.log         # Nginx 访问日志
tail -f /var/log/nginx/judging_app_error.log          # Nginx 错误日志
```

### 7.4 配置 HTTPS（推荐）

```bash
# Ubuntu/Debian:
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com

# RHEL/CentOS:
sudo dnf install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com

# 证书会自动续期，可手动测试续期流程：
sudo certbot renew --dry-run
```

### 7.5 生产环境注意事项

**推荐硬件配置**（支持 138 人同时使用）：

- CPU：4 核
- 内存：8 GB
- 磁盘：SSD
- 网络：带宽 >= 10 Mbps

**必须修改的配置**：

- SECRET_KEY：环境变量 `JUDGING_SECRET_KEY`，用 `openssl rand -hex 32` 生成
- 管理员密码：修改 `backend/accounts/admin.json` 中的默认密码
- 不要开启 `--debug` 模式

**SELinux 注意**（RHEL/CentOS 系）：
如果 Nginx 报 502 错误，执行：

```bash
sudo setsebool -P httpd_can_network_connect 1
```

---

## 8. 性能优化说明

系统已针对 138 并发用户场景进行优化：

### 8.1 四层内存缓存

| 缓存                 | TTL     | 作用                    |
| -------------------- | ------- | ----------------------- |
| `task_cache`       | 60 秒   | 缓存 task JSON 文件读取 |
| `status_cache`     | 15 秒   | 缓存 unit 完成状态查询  |
| `annotation_cache` | 30 秒   | 缓存单元已有标注内容    |
| `poi_mem_cache`    | 3600 秒 | 缓存 POI 搜索结果       |

所有缓存均为线程安全，写操作后精准失效相关条目。

### 8.2 POI 跨用户缓存

- 坐标精度 5 位小数（约 1 米），作为缓存 key
- 首次检索调用高德 PlaceSearch API，结果自动持久化到 `backend/poi_cache/`
- 后续用户访问相同坐标直接命中缓存，零 API 调用
- 前端 `Promise.all` 并行搜索 5 类 POI，搜索结果合并后回存
- 命中时跳过 PlaceSearch 插件加载，标记渲染瞬间完成

### 8.3 Waitress 多线程

生产模式下使用 Waitress（20 threads, connection_limit=200），比单线程 Werkzeug 开发服务器吞吐量提升约 20 倍。

---

## 9. API 参考

### 用户端 API（含判读 + POI 绘制模式）

| 方法     | 路径                                               | 说明                                                                 |
| -------- | -------------------------------------------------- | -------------------------------------------------------------------- |
| `GET`  | `/poi`                                           | POI 绘制模式页面                                                     |
| `POST` | `/api/login`                                     | 用户登录                                                             |
| `POST` | `/api/logout`                                    | 退出登录                                                             |
| `GET`  | `/api/current_user`                              | 获取当前登录用户信息                                                 |
| `GET`  | `/api/user/tasks`                                | 获取用户的任务列表                                                   |
| `GET`  | `/api/user/unit_status`                          | 获取用户某任务下所有 unit 状态                                       |
| `GET`  | `/api/unit/<task_id>/<group_id>/<id>`            | 获取 unit 详情（含原图/mask/已有标注）                               |
| `POST` | `/api/unit/<task_id>/<group_id>/<id>/submit`     | 提交标注结果                                                         |
| `GET`  | `/api/poi_unit/<task_id>/<group_id>/<id>`        | 获取 POI unit 详情（含原图/已有多边形）                              |
| `POST` | `/api/poi_unit/<task_id>/<group_id>/<id>/submit` | 提交 POI 多边形标注结果                                              |
| `GET`  | `/api/poi_cache?key=lng_lat`                     | 查询 POI 缓存                                                        |
| `POST` | `/api/poi_cache`                                 | 写入 POI 缓存                                                        |
| `POST` | `/api/amap/report_exhausted`                     | 报告坐标全空（5 类 POI 均为 0，全局累积达 8 个不同坐标后自动换 Key） |
| `POST` | `/api/amap/reset_counter`                        | 重置全空计数器                                                       |

### 管理员 API

| 方法     | 路径                                       | 说明                                   |
| -------- | ------------------------------------------ | -------------------------------------- |
| `GET`  | `/api/admin/datasets`                    | 列出所有 dataset                       |
| `GET`  | `/api/admin/dataset/<name>/analyze`      | 连通集分析                             |
| `GET`  | `/api/admin/tasks`                       | 列出所有任务                           |
| `POST` | `/api/admin/create_task`                 | 创建标注任务                           |
| `GET`  | `/api/admin/task/<id>/detail`            | 查看任务详情                           |
| `POST` | `/api/admin/task/<id>/delete`            | 删除任务（同时删除关联账号和标注数据） |
| `GET`  | `/api/admin/task/<id>/download_accounts` | 下载任务账号 zip                       |
| `GET`  | `/api/admin/amap/status`                 | 查看高德 key 状态                      |
| `POST` | `/api/admin/amap/rotate`                 | 手动切换高德 key                       |

### 标注提交 JSON 格式

**判读模式**：

```json
{
  "result": "是",
  "park_type": "立体现代物流园",
  "transport_modes": ["公路", "铁路"],
  "comment": ""
}
```

**POI 绘制模式**：

```json
{
  "polygons": [
    {
      "id": "poly_001",
      "vertices": [[100.0, 200.0], [300.0, 200.0], [300.0, 400.0], [100.0, 400.0]],
      "park_type": "露天集装箱"
    }
  ],
  "transport_modes": ["公路", "铁路"],
  "comment": ""
}
```

---

## 10. 目录结构

```
backend/
├── accounts/
│   ├── admin.json               # 管理员账号
│   └── user.json               # 用户账号库
├── annotations/
│   └── <task_id>/
│       └── <group_id>/
│           ├── unit_XXXXXX.json # 判读模式标注结果
│           └── poi_XXXXXX.json  # POI 绘制模式标注结果
├── datasets/
│   └── <dataset_name>/
│       ├── img/                 # 遥感原图
│       └── mask/                # 二值 mask
├── datasets_poi/
│   └── <dataset_name>/
│       └── img/                 # POI 绘制模式遥感原图
├── poi_cache/
│   └── <lng>_<lat>.json        # POI 持久化缓存
├── tasks/
│   └── <task_id>.json           # 任务定义
├── amap_config.json             # 高德密钥（不入 git）
├── requirements.txt             # Python 依赖
└── server.py                    # Flask 主程序
```

---

## 11. 工作流程

```
管理员                                   标注人员
  │                                        │
  ├─ 准备 dataset（img/ + mask/）          │
  ├─ 登录 /admin                           │
  ├─ 浏览、分析 dataset                    │
  ├─ 创建任务（选 dataset、组数、重叠系数）  │
  ├─ 下载账号 zip                          │
  │                                        │
  │  ──── 分发账号 ────────────────────→   │
  │                                        ├─ 登录 /（判读模式）或 /poi（POI绘制模式）
  │                                        ├─ 逐 unit 判读标注
  │                                        │   ├─ 判读模式：是/否/不确定 → 园区类型 → 运输方式
  │                                        │   └─ POI模式：绘制多边形 → 每个多边形设定园区类型 → 整图运输方式
  │                                        │   ├─ 地图 POI 辅助参考
  │                                        │   └─ 保存 → 下一项
  │                                        ├─ 完成所有标注
  │                                        │
  │  ←──── 标注结果汇总 ─────────────────  │
  │                                        │
  └─ backend/annotations/ 查看标注结果     │
```
