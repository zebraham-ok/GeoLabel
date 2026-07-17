/**
 * review_judge.js - 审核判读主控
 * 基于原判读页面，增加标注者比例显示和审核功能
 */
(function() {
    // ===== 工具函数 =====
    function toast(msg) {
        const t = document.getElementById('user-toast');
        t.textContent = msg;
        t.classList.add('show');
        setTimeout(() => t.classList.remove('show'), 2200);
    }

    function setLoading(show) {
        const el = document.getElementById('user-loading');
        el.classList.toggle('hide', !show);
    }

    // ===== 全局状态 =====
    let currentTask = null;
    let taskData = null;       // 任务完整数据
    let unitData = null;       // 当前 unit 数据
    let currentUnitIdx = -1;
    let reviewResult = null;   // "是"/"否"/"不确定"
    let reviewParkType = null;
    let reviewTransModes = [];
    let allUnits = [];
    let reviewStatusMap = {};   // {unitId: {done: true}} 审核完成状态

    // ===== 初始化 =====
    async function init() {
        try {
            const me = await API.currentUser();
            if (!me || !me.logged_in) {
                window.location.href = '/';
                return;
            }
            document.getElementById('user-username').textContent = me.username;
            await loadTasks();
        } catch (e) {
            setLoading(false);
        }
    }

    async function loadTasks() {
        try {
            const tasks = await API.userTasks();
            if (!tasks || tasks.length === 0) {
                setLoading(false);
                toast('没有审核任务');
                return;
            }
            // 仅显示 review 类型的任务
            const reviewTasks = tasks.filter(t => t.task_type === 'judge_review');
            if (reviewTasks.length === 0) {
                setLoading(false);
                toast('没有审核判读任务');
                return;
            }
            renderTaskTabs(reviewTasks);
            await selectTask(reviewTasks[0]);
        } catch (e) {
            toast('加载任务失败: ' + e.message);
            setLoading(false);
        }
    }

    function renderTaskTabs(tasks) {
        const tabsEl = document.getElementById('user-taskTabs');
        tabsEl.innerHTML = tasks.map((t, i) =>
            `<div class="user-task-tab active" data-idx="${i}">${t.task_name || t.task_id}</div>`
        ).join('');
        tabsEl.querySelectorAll('.user-task-tab').forEach(el => {
            el.addEventListener('click', async () => {
                tabsEl.querySelectorAll('.user-task-tab').forEach(x => x.classList.remove('active'));
                el.classList.add('active');
                await selectTask(tasks[parseInt(el.dataset.idx)]);
            });
        });
    }

    async function selectTask(task) {
        currentTask = task;
        document.getElementById('user-taskHeader').textContent = task.task_name || '审核判读';
        allUnits = task.units || [];
        document.getElementById('user-tname').textContent = `${allUnits.length} 项待审核`;

        // 获取审核状态，自动跳转到第一个未完成的 unit
        try { reviewStatusMap = (await API.reviewUnitStatus(task.task_id, task.group_id)) || {}; }
        catch (e) { reviewStatusMap = {}; }

        let firstIdx = 0;
        for (let i = 0; i < allUnits.length; i++) {
            if (!reviewStatusMap[String(allUnits[i].id)]) { firstIdx = i; break; }
        }

        renderUnitList();
        setLoading(false);
        if (allUnits.length > 0) {
            currentUnitIdx = firstIdx;
            await loadUnit(firstIdx);
        }
    }

    function renderUnitList() {
        const listEl = document.getElementById('user-unitList');
        if (allUnits.length === 0) {
            listEl.innerHTML = '<div class="user-unit-item">无待审核项</div>';
            return;
        }
        listEl.innerHTML = allUnits.map((u, i) => {
            let cls = 'user-unit-item';
            if (i === currentUnitIdx) cls += ' status-current';
            if (reviewStatusMap[String(u.id)]) cls += ' status-done';
            const name = shortFileName(u.image || '');
            const idStr = u.component_id != null ? ` #${u.component_id}` : '';
            return `<div class="user-unit-item ${cls}" data-idx="${i}">
                <div class="user-unit-title">${name}${idStr}</div>
                <div class="user-unit-meta">${u.annotator_count || '?'} 标注者</div>
            </div>`;
        }).join('');
        listEl.querySelectorAll('.user-unit-item').forEach(el => {
            el.addEventListener('click', async () => {
                const idx = parseInt(el.dataset.idx);
                currentUnitIdx = idx;
                await loadUnit(idx);
                renderUnitList();
            });
        });
    }

    // ===== 加载 unit =====
    function showImgLoading(show) {
        document.getElementById('img-loading').classList.toggle('hidden', !show);
    }

    async function loadUnit(idx) {
        if (idx < 0 || idx >= allUnits.length) return;
        const unit = allUnits[idx];
        currentUnitIdx = idx;
        showImgLoading(true);

        try {
            const resp = await API.getReviewUnit(currentTask.task_id, currentTask.group_id, unit.id);
            unitData = resp;

            // 加载图片
            const img = document.getElementById('user-mainImg');
            img.src = resp.image_url;

            // Mask canvas / Polygon overlay（根据数据类型区分）
            const maskCvs = document.getElementById('user-maskCanvas');
            const polygonPixels = resp.polygon_pixels;  // judge_shp 模式的多边形坐标

            if (polygonPixels && polygonPixels.length >= 3) {
                // judge_shp 模式：绘制多边形高亮（暗色覆盖 + 多边形区域清亮 + 轮廓线）
                img.onload = () => {
                    const natW = img.naturalWidth;
                    const natH = img.naturalHeight;
                    maskCvs.width = img.naturalWidth;
                    maskCvs.height = img.naturalHeight;
                    drawPolygonOverlay(polygonPixels, natW, natH, natW, natH);
                    drawBBox(unit);
                    showImgLoading(false);
                    updateImageViewport();
                };
                if (img.complete && img.naturalWidth > 0) {
                    const natW = img.naturalWidth;
                    const natH = img.naturalHeight;
                    maskCvs.width = natW;
                    maskCvs.height = natH;
                    drawPolygonOverlay(polygonPixels, natW, natH, natW, natH);
                    drawBBox(unit);
                    showImgLoading(false);
                    updateImageViewport();
                }
            } else if (resp.mask_url) {
                // judge_mask 模式：加载半透明 mask 图像叠加
                const maskImg = new Image();
                maskImg.onload = () => {
                    maskCvs.width = img.naturalWidth;
                    maskCvs.height = img.naturalHeight;
                    const ctx = maskCvs.getContext('2d');
                    ctx.clearRect(0, 0, maskCvs.width, maskCvs.height);
                    ctx.drawImage(maskImg, 0, 0);
                };
                maskImg.src = resp.mask_url;

                img.onload = () => {
                    drawBBox(unit);
                    showImgLoading(false);
                    updateImageViewport();
                };

                if (img.complete && img.naturalWidth > 0) {
                    drawBBox(unit);
                    showImgLoading(false);
                    updateImageViewport();
                }
            } else {
                // 无 mask 无 polygon：直接显示原图
                img.onload = () => {
                    drawBBox(unit);
                    showImgLoading(false);
                    updateImageViewport();
                };
                if (img.complete && img.naturalWidth > 0) {
                    drawBBox(unit);
                    showImgLoading(false);
                    updateImageViewport();
                }
            }

            // 更新信息栏
            document.getElementById('user-vName').textContent = shortFileName(unit.image || '');
            document.getElementById('user-vCoord').textContent =
                unit.lat != null ? `${unit.lat}, ${unit.lng}` : '-';
            document.getElementById('user-vBbox').textContent =
                unit.bbox ? unit.bbox.join(', ') : '-';
            document.getElementById('user-vStatus').textContent = '待审核';

            // 更新比例标签
            updateRatioLabels(unit);

            // 恢复已有审核标注
            if (resp.existing_review) {
                reviewResult = resp.existing_review.review_result;
                reviewParkType = resp.existing_review.review_park_type;
                reviewTransModes = resp.existing_review.review_transport_modes || [];
            } else {
                reviewResult = null;
                reviewParkType = null;
                reviewTransModes = [];
            }
            updateBtnStates();

            // 初始化地图
            if (unit.lat != null && unit.lng != null) {
                UserMap.init({ lng: unit.lng, lat: unit.lat, name: shortFileName(unit.image || '') });
            } else {
                UserMap.init({ lng: 116.397428, lat: 39.90923, name: '' });
            }

            // 更新计数器
            document.getElementById('user-counter').textContent =
                `${idx + 1} / ${allUnits.length}`;

            renderUnitList();

        } catch (e) {
            showImgLoading(false);
            toast('加载失败: ' + e.message);
        }
    }

    function updateRatioLabels(unit) {
        // 从 unit 的 options_stats 获取比例
        const stats = unit.options_stats || {};
        for (const [opt, info] of Object.entries(stats)) {
            const elId = 'ratio-' + (opt === '是' ? 'yes' : opt === '否' ? 'no' : 'unsure');
            const el = document.getElementById(elId);
            if (el) {
                el.textContent = `${info.count}/${unit.annotator_count} (${Math.round(info.ratio * 100)}%)`;
            }
        }
        // 隐藏没有数据的比例标签
        ['ratio-yes', 'ratio-no', 'ratio-unsure'].forEach(id => {
            const el = document.getElementById(id);
            if (el && !el.textContent) el.textContent = '';
        });
    }

    function drawBBox(unit) {
        const cvs = document.getElementById('user-bboxCanvas');
        const img = document.getElementById('user-mainImg');
        if (!img.naturalWidth) return;

        const parent = cvs.parentElement;
        const scaleX = parent.clientWidth / img.naturalWidth;
        const scaleY = parent.clientHeight / img.naturalHeight;
        const scale = Math.min(scaleX, scaleY);

        cvs.width = parent.clientWidth;
        cvs.height = parent.clientHeight;
        const ctx = cvs.getContext('2d');
        ctx.clearRect(0, 0, cvs.width, cvs.height);

        if (unit.bbox && unit.bbox.length >= 4) {
            const [x, y, w, h] = unit.bbox;
            if (w > 0 && h > 0) {
                const offsetX = (parent.clientWidth - img.naturalWidth * scale) / 2;
                const offsetY = (parent.clientHeight - img.naturalHeight * scale) / 2;
                ctx.strokeStyle = '#e94560';
                ctx.lineWidth = 2;
                ctx.strokeRect(offsetX + x * scale, offsetY + y * scale, w * scale, h * scale);
            }
        }
    }

    function updateImageViewport() {
        // 简单适配
    }

    // ===== 多边形高亮（judge_shp 模式复用 annotate.js 的逻辑） =====
    function drawPolygonOverlay(polyData, dispW, dispH, natW, natH) {
        const canvas = document.getElementById('user-maskCanvas');
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (!polyData || polyData.length < 3) return;

        const sx = dispW / natW;
        const sy = dispH / natH;

        // 1. 半透明黑色覆盖全图（变暗效果）
        ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // 2. 在多边形区域内清除暗色覆盖，露出原图正常亮度
        ctx.save();
        ctx.beginPath();
        polyData.forEach(function(pt, i) {
            const px = pt[0] * sx;
            const py = pt[1] * sy;
            i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
        });
        ctx.closePath();
        ctx.clip();
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // 3. 绘制多边形轮廓线（增强边界辨识）
        ctx.strokeStyle = 'rgba(233, 69, 96, 0.6)';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.restore();
    }

    // ===== 按钮状态 =====
    function updateBtnStates() {
        // 是否是物流园区
        ['user-btnYes', 'user-btnNo', 'user-btnUnsure'].forEach(id => {
            const btn = document.getElementById(id);
            btn.classList.remove('active');
        });
        if (reviewResult === '是') document.getElementById('user-btnYes').classList.add('active');
        if (reviewResult === '否') document.getElementById('user-btnNo').classList.add('active');
        if (reviewResult === '不确定') document.getElementById('user-btnUnsure').classList.add('active');

        // 园区类型
        document.querySelectorAll('#user-parkTypeBtns .user-bigbtn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.type === reviewParkType);
        });

        // 运输方式
        document.querySelectorAll('#user-transBtns .user-bigbtn').forEach(btn => {
            btn.classList.toggle('on', reviewTransModes.includes(btn.dataset.mode));
        });
    }

    // ===== 按钮事件绑定 =====
    function bindEvents() {
        // 是/否/不确定
        document.getElementById('user-btnYes').addEventListener('click', () => {
            reviewResult = '是'; updateBtnStates();
        });
        document.getElementById('user-btnNo').addEventListener('click', () => {
            reviewResult = '否'; updateBtnStates();
        });
        document.getElementById('user-btnUnsure').addEventListener('click', () => {
            reviewResult = '不确定'; updateBtnStates();
        });

        // 园区类型
        document.querySelectorAll('#user-parkTypeBtns .user-bigbtn').forEach(btn => {
            btn.addEventListener('click', () => {
                reviewParkType = (reviewParkType === btn.dataset.type) ? null : btn.dataset.type;
                updateBtnStates();
            });
        });

        // 运输方式
        document.querySelectorAll('#user-transBtns .user-bigbtn').forEach(btn => {
            btn.addEventListener('click', () => {
                const mode = btn.dataset.mode;
                const idx = reviewTransModes.indexOf(mode);
                if (idx >= 0) reviewTransModes.splice(idx, 1);
                else reviewTransModes.push(mode);
                updateBtnStates();
            });
        });

        // 保存
        document.getElementById('user-saveBtn').addEventListener('click', saveReview);

        // 导航
        document.getElementById('user-prevBtn').addEventListener('click', () => {
            if (currentUnitIdx > 0) loadUnit(currentUnitIdx - 1);
        });
        document.getElementById('user-nextBtn').addEventListener('click', () => {
            saveReviewAndNext();
        });

        // 退出
        document.getElementById('user-logoutBtn').addEventListener('click', async () => {
            try { await API.logout(); } catch (e) {}
            window.location.href = '/';
        });
    }

    async function doSaveReview() {
        if (!reviewResult) {
            toast('请先选择审核结果');
            return false;
        }
        const unit = allUnits[currentUnitIdx];
        try {
            const payload = {
                review_result: reviewResult,
                review_park_type: reviewParkType || '',
                review_transport_modes: reviewTransModes,
            };
            const r = await API.submitReviewUnit(currentTask.task_id, currentTask.group_id, unit.id, payload);
            if (r.ok) {
                reviewStatusMap[String(unit.id)] = { done: true };
                toast('审核结果已保存');
                const counter = document.getElementById('user-counter');
                counter.textContent = `${currentUnitIdx + 1} / ${allUnits.length}`;
                document.getElementById('user-vStatus').textContent = '已审核';
                renderUnitList();  // 刷新列表显示完成状态
                return true;
            }
            return false;
        } catch (e) {
            toast('保存失败: ' + e.message);
            return false;
        }
    }

    async function saveReview() {
        await doSaveReview();
    }

    async function saveReviewAndNext() {
        const ok = await doSaveReview();
        if (ok && currentUnitIdx < allUnits.length - 1) {
            setTimeout(() => loadUnit(currentUnitIdx + 1), 300);
        }
    }

    // ===== 键盘快捷键 =====
    document.addEventListener('keydown', e => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
        switch (e.key.toLowerCase()) {
            case 'y': reviewResult = '是'; updateBtnStates(); break;
            case 'n': reviewResult = '否'; updateBtnStates(); break;
            case 'u': reviewResult = '不确定'; updateBtnStates(); break;
            case 's':
                if (!e.ctrlKey) { e.preventDefault(); saveReview(); }
                break;
            case 'enter': e.preventDefault();
                saveReviewAndNext();
                break;
            case 'arrowleft': e.preventDefault();
                if (currentUnitIdx > 0) loadUnit(currentUnitIdx - 1);
                break;
            case 'arrowright': e.preventDefault();
                if (currentUnitIdx < allUnits.length - 1) loadUnit(currentUnitIdx + 1);
                break;
            case '1': case '2': case '3': case '4':
            case '5': case '6': case '7': case '8':
                reviewParkType = document.querySelector(`#user-parkTypeBtns .user-bigbtn:nth-child(${e.key})`)?.dataset.type || null;
                updateBtnStates();
                break;
            case 'q': toggleTransMode('公路'); break;
            case 'w': toggleTransMode('铁路'); break;
            case 'e': toggleTransMode('水路'); break;
            case 'r': toggleTransMode('航空'); break;
        }
    });

    function toggleTransMode(mode) {
        const idx = reviewTransModes.indexOf(mode);
        if (idx >= 0) reviewTransModes.splice(idx, 1);
        else reviewTransModes.push(mode);
        updateBtnStates();
    }

    // 窗口大小变化时重绘 bbox
    window.addEventListener('resize', () => {
        if (unitData && unitData.unit) drawBBox(unitData.unit);
    });

    // ===== 启动 =====
    init();
    bindEvents();
})();
