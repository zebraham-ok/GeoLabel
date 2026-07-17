/**
 * review_poi.js - 审核 POI 主控
 * 多标注者多边形显示、选择、交集/并集/平均操作
 */
(function() {
    // ===== 工具 =====
    function toast(msg) {
        const t = document.getElementById('user-toast');
        t.textContent = msg;
        t.classList.add('show');
        setTimeout(() => t.classList.remove('show'), 2200);
    }
    function setLoading(show) { document.getElementById('user-loading').classList.toggle('hide', !show); }

    // ===== 审核者颜色（大红 Crimson） =====
    const REVIEW_COLOR = '#dc143c';
    const REVIEW_FILL = 'rgba(220, 20, 60, 0.3)';
    const REVIEW_COLOR_SELECTED = '#fff';

    // ===== 标注者颜色（避免与审核者大红冲突：移除了 e94560 玫红和 ef5350 红色，替换为粉色/浅橙） =====
    const annotatorColors = [
        '#f06292', '#4ecca3', '#42a5f5', '#ffa726',
        '#ab47bc', '#26c6da', '#ffb74d', '#66bb6a',
        '#ff7043', '#5c6bc0',
    ];

    // ===== 全局状态 =====
    let currentTask = null;
    let allUnits = [];
    let currentUnitIdx = -1;
    let unitData = null;
    let reviewPolygons = [];      // [{points: [[x,y],...], label: ''}]
    let selectedPolygons = [];    // [{annotatorIdx, polyIdx, canvas...}]
    let visibleAnnotators = {};   // {annotatorIdx: true}
    let visibleReviewResult = true; // 审核结果多边形可见性
    let reviewTransModes = [];
    let currentLabel = null;
    let reviewStatusMap = {};   // {unitId: {done: true}} 审核完成状态

    // 画布状态（与 poi_main.js 一致：百分比坐标 + 缩放/平移）
    let nW = 0, nH = 0, dW = 0, dH = 0, dX = 0, dY = 0;
    let _zoom = 1.0, _panX = 0, _panY = 0;
    let _panning = false;
    let _panStart = { x: 0, y: 0, panX: 0, panY: 0 };

    let _justDragged = false;

    // 顶点编辑状态
    let _editMode = false;
    let _editAnnotatorIdx = -1;
    let _editPolyIdx = -1;
    let _editReviewIdx = -1;     // 正在编辑的审核结果多边形索引
    let _draggingVertex = -1;
    let _editDragStartPct = null;
    // 编辑多边形的原始点集快照（标注数据中的源）
    let _editPointsRef = null;

    const polyCanvas = document.getElementById('polyCanvas');
    const reviewCanvas = document.getElementById('reviewCanvas');
    const ctx = polyCanvas.getContext('2d');
    const rctx = reviewCanvas.getContext('2d');

    // 禁用右键菜单（用于右键平移）
    document.getElementById('user-imgWrap').addEventListener('contextmenu', e => e.preventDefault());

    // ===== 初始化 =====
    async function init() {
        try {
            const me = await API.currentUser();
            if (!me || !me.logged_in) { window.location.href = '/'; return; }
            document.getElementById('user-username').textContent = me.username;
            await loadTasks();
        } catch (e) { setLoading(false); }
    }

    async function loadTasks() {
        try {
            const tasks = await API.userTasks();
            const reviewTasks = (tasks || []).filter(t => t.task_type === 'poi_review');
            if (!reviewTasks.length) { setLoading(false); toast('没有审核 POI 任务'); return; }
            renderTaskTabs(reviewTasks);
            await selectTask(reviewTasks[0]);
        } catch (e) { toast('加载失败: ' + e.message); setLoading(false); }
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
        document.getElementById('user-taskHeader').textContent = task.task_name || '审核 POI';
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
        if (allUnits.length > 0) { currentUnitIdx = firstIdx; await loadUnit(firstIdx); }
    }

    function renderUnitList() {
        const listEl = document.getElementById('user-unitList');
        if (!allUnits.length) { listEl.innerHTML = '<div class="user-unit-item">无待审核项</div>'; return; }
        listEl.innerHTML = allUnits.map((u, i) => {
            let cls = 'user-unit-item';
            if (i === currentUnitIdx) cls += ' status-current';
            if (reviewStatusMap[String(u.id)]) cls += ' status-done';
            return `<div class="user-unit-item ${cls}" data-idx="${i}">
                <div class="user-unit-title">${shortFileName(u.image || '')}</div>
                <div class="user-unit-meta">${u.annotator_count || '?'} 标注者</div>
            </div>`;
        }).join('');
        listEl.querySelectorAll('.user-unit-item').forEach(el => {
            el.addEventListener('click', async () => {
                currentUnitIdx = parseInt(el.dataset.idx);
                await loadUnit(currentUnitIdx);
                renderUnitList();
            });
        });
    }

    // ===== 加载 unit =====
    function showImgLoading(show) { document.getElementById('img-loading').classList.toggle('hidden', !show); }

    async function loadUnit(idx) {
        if (idx < 0 || idx >= allUnits.length) return;
        const unit = allUnits[idx];
        currentUnitIdx = idx;
        showImgLoading(true);
        selectedPolygons = [];
        reviewPolygons = [];

        try {
            const resp = await API.getReviewUnit(currentTask.task_id, currentTask.group_id, unit.id);
            unitData = resp;

            // 加载图片
            const img = document.getElementById('user-mainImg');
            img.src = resp.image_url;
            img.onload = () => {
                nW = img.naturalWidth;
                nH = img.naturalHeight;
                _zoom = 1.0; _panX = 0; _panY = 0;
                calcRect();
                buildAnnotatorPolygons(resp.unit);
                drawAllPolygons();
                drawReviewPolygons();
                showImgLoading(false);
            };
            if (img.complete && img.naturalWidth > 0) {
                nW = img.naturalWidth;
                nH = img.naturalHeight;
                _zoom = 1.0; _panX = 0; _panY = 0;
                calcRect();
                buildAnnotatorPolygons(resp.unit);
                drawAllPolygons();
                drawReviewPolygons();
                showImgLoading(false);
            }

            // 信息栏
            document.getElementById('user-vName').textContent = shortFileName(unit.image || '');
            document.getElementById('user-vCoord').textContent = unit.lat != null ? `${unit.lat}, ${unit.lng}` : '-';
            document.getElementById('user-vStatus').textContent = '待审核';

            // 恢复已有审核
            if (resp.existing_review) {
                reviewPolygons = resp.existing_review.review_polygons || [];
                reviewTransModes = resp.existing_review.review_transport_modes || [];
            } else {
                reviewPolygons = [];
                reviewTransModes = [];
            }
            updateTransBtnStates();
            document.getElementById('user-polyCount').textContent = reviewPolygons.length;
            document.getElementById('user-vTrans').textContent = reviewTransModes.join(', ') || '-';

            document.getElementById('user-counter').textContent = `${idx + 1} / ${allUnits.length}`;

            if (unit.lat != null && unit.lng != null) {
                UserMap.init({ lng: unit.lng, lat: unit.lat, name: shortFileName(unit.image || '') });
            } else {
                UserMap.init({ lng: 116.397428, lat: 39.90923, name: '' });
            }

            renderUnitList();
            drawReviewPolygons();

        } catch (e) { showImgLoading(false); toast('加载失败: ' + e.message); }
    }

    // ===== 构建标注者多边形数据 =====
    function buildAnnotatorPolygons(unit) {
        const annotatorData = unit.annotator_data || [];
        // 初始化可见性
        if (Object.keys(visibleAnnotators).length === 0) {
            annotatorData.forEach((_, i) => { visibleAnnotators[i] = true; });
        }
        // 更新侧边栏
        const checksEl = document.getElementById('review-annotator-checks');
        checksEl.innerHTML = annotatorData.map((ad, i) => {
            const color = annotatorColors[i % annotatorColors.length];
            const checked = visibleAnnotators[i] !== false ? 'checked' : '';
            return `<label>
                <input type="checkbox" class="annotator-check" data-idx="${i}" ${checked}>
                <span class="annotator-color-dot" style="background:${color}"></span>
                ${ad.group_id || `标注者${i+1}`}
                <span style="color:#888;font-size:8px">(${ad.polygons ? ad.polygons.length : 0}框)</span>
            </label>`;
        }).join('') + `
            <hr style="border-color:#0f3460;margin:4px 0">
            <label>
                <input type="checkbox" class="review-result-check" ${visibleReviewResult ? 'checked' : ''}>
                <span class="annotator-color-dot" style="background:${REVIEW_COLOR}"></span>
                审核结果
                <span class="review-result-count" style="color:#888;font-size:8px">(${reviewPolygons.length}框)</span>
            </label>`;

        // 绑定标注者勾选框事件
        checksEl.querySelectorAll('.annotator-check').forEach(cb => {
            cb.addEventListener('change', function() {
                visibleAnnotators[parseInt(this.dataset.idx)] = this.checked;
                drawAllPolygons();
            });
        });

        // 绑定审核结果勾选框事件
        const reviewCb = checksEl.querySelector('.review-result-check');
        if (reviewCb) {
            reviewCb.addEventListener('change', function() {
                visibleReviewResult = this.checked;
                drawReviewPolygons();
            });
        }

        // 面板拖动
        initSidebarDrag();
    }

    // ===== 标注者面板拖动 =====
    let _sidebarDragging = false;
    let _sidebarDragStart = { x: 0, y: 0, left: 0, top: 0 };

    function initSidebarDrag() {
        const sidebar = document.getElementById('review-sidebar');
        const header = sidebar.querySelector('h4');
        if (!header) return;

        header.style.cursor = 'move';
        header.style.userSelect = 'none';
        header.title = '拖拽移动面板';

        header.addEventListener('mousedown', function(e) {
            if (e.target.tagName === 'INPUT') return;
            e.preventDefault();
            _sidebarDragging = true;
            const rect = sidebar.getBoundingClientRect();
            const parentRect = sidebar.parentElement.getBoundingClientRect();
            _sidebarDragStart = {
                x: e.clientX,
                y: e.clientY,
                left: rect.left - parentRect.left,
                top: rect.top - parentRect.top
            };
            sidebar.style.cursor = 'grabbing';
        });

        window.addEventListener('mousemove', function(e) {
            if (!_sidebarDragging) return;
            const parentRect = sidebar.parentElement.getBoundingClientRect();
            let newLeft = _sidebarDragStart.left + (e.clientX - _sidebarDragStart.x);
            let newTop = _sidebarDragStart.top + (e.clientY - _sidebarDragStart.y);
            // 限制在父容器内
            newLeft = Math.max(0, Math.min(newLeft, parentRect.width - sidebar.offsetWidth));
            newTop = Math.max(0, Math.min(newTop, parentRect.height - sidebar.offsetHeight));
            sidebar.style.left = newLeft + 'px';
            sidebar.style.top = newTop + 'px';
            sidebar.style.right = 'auto';
        });

        window.addEventListener('mouseup', function(e) {
            if (_sidebarDragging) {
                _sidebarDragging = false;
                sidebar.style.cursor = '';
            }
        });
    }

    function getVisiblePolys() {
        const ad = (unitData && unitData.unit && unitData.unit.annotator_data) || [];
        const result = [];
        ad.forEach((annotator, ai) => {
            if (!visibleAnnotators[ai]) return;
            const color = annotatorColors[ai % annotatorColors.length];
            (annotator.polygons || []).forEach((poly, pi) => {
                result.push({
                    annotatorIdx: ai,
                    polyIdx: pi,
                    points: poly.points || [],
                    label: poly.label || '',
                    color: color,
                });
            });
        });
        return result;
    }

    // ===== 绘制 =====
    function _fitRect() {
        const wrap = document.getElementById('user-imgWrap');
        const pw = wrap.clientWidth, ph = wrap.clientHeight;
        const s = Math.min(pw / nW, ph / nH);
        const fitW = nW * s, fitH = nH * s;
        return { w: fitW, h: fitH, x: (pw - fitW) / 2, y: (ph - fitH) / 2, s: s };
    }

    function calcRect() {
        if (!nW || !nH) return;
        const fit = _fitRect();
        dW = Math.round(fit.w * _zoom);
        dH = Math.round(fit.h * _zoom);
        dX = Math.round(fit.x + _panX - (dW - fit.w) / 2);
        dY = Math.round(fit.y + _panY - (dH - fit.h) / 2);

        const img = document.getElementById('user-mainImg');
        img.style.position = 'absolute';
        img.style.left = dX + 'px';
        img.style.top = dY + 'px';
        img.style.width = dW + 'px';
        img.style.height = dH + 'px';
        img.style.maxWidth = 'none';
        img.style.maxHeight = 'none';

        polyCanvas.style.position = 'absolute';
        polyCanvas.style.left = dX + 'px';
        polyCanvas.style.top = dY + 'px';
        polyCanvas.style.width = dW + 'px';
        polyCanvas.style.height = dH + 'px';
        polyCanvas.width = dW;
        polyCanvas.height = dH;

        reviewCanvas.style.position = 'absolute';
        reviewCanvas.style.left = dX + 'px';
        reviewCanvas.style.top = dY + 'px';
        reviewCanvas.style.width = dW + 'px';
        reviewCanvas.style.height = dH + 'px';
        reviewCanvas.width = dW;
        reviewCanvas.height = dH;
    }

    function pct2px(px, py) { return [px * dW / 100, py * dH / 100]; }
    function px2pct(px, py) { return [px * 100 / dW, py * 100 / dH]; }

    function drawAllPolygons() {
        if (!dW || !dH) return;
        ctx.clearRect(0, 0, dW, dH);
        const polys = getVisiblePolys();

        polys.forEach(poly => {
            if (!poly.points || poly.points.length < 3) return;
            const isSelected = selectedPolygons.some(sp =>
                sp.source === 'annotator' &&
                sp.annotatorIdx === poly.annotatorIdx && sp.polyIdx === poly.polyIdx);
            const isEditing = _editMode && poly.annotatorIdx === _editAnnotatorIdx && poly.polyIdx === _editPolyIdx;

            ctx.beginPath();
            poly.points.forEach((pt, i) => {
                const xy = pct2px(pt[0], pt[1]);
                i === 0 ? ctx.moveTo(xy[0], xy[1]) : ctx.lineTo(xy[0], xy[1]);
            });
            ctx.closePath();
            ctx.fillStyle = poly.color + '44';
            ctx.fill();
            if (isEditing) {
                ctx.setLineDash([6, 4]);
                ctx.strokeStyle = '#ffeb3b';
                ctx.lineWidth = 3;
            } else {
                ctx.setLineDash([]);
                ctx.strokeStyle = isSelected ? '#fff' : poly.color;
                ctx.lineWidth = isSelected ? 3 : 1.5;
            }
            ctx.stroke();
            ctx.setLineDash([]);

            // 编辑模式：绘制顶点手柄
            if (isEditing && _editPointsRef) {
                const srcPts = _editPointsRef;
                for (let i = 0; i < srcPts.length; i++) {
                    const xy = pct2px(srcPts[i][0], srcPts[i][1]);
                    ctx.fillStyle = (i === _draggingVertex) ? '#ffeb3b' : '#fff';
                    ctx.strokeStyle = '#000';
                    ctx.lineWidth = 1.5;
                    ctx.beginPath();
                    ctx.arc(xy[0], xy[1], 5, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.stroke();
                }
            }

            if (poly.label) {
                const xy = pct2px(poly.points[0][0], poly.points[0][1]);
                ctx.fillStyle = poly.color;
                ctx.font = '9px sans-serif';
                ctx.fillText(poly.label, xy[0], xy[1] - 5);
            }
        });
    }

    function drawReviewPolygons() {
        if (!dW || !dH) return;
        rctx.clearRect(0, 0, dW, dH);
        // 更新侧边栏审核结果计数
        const countEl = document.querySelector('.review-result-count');
        if (countEl) countEl.textContent = `(${reviewPolygons.length}框)`;
        if (!visibleReviewResult) return;
        reviewPolygons.forEach((poly, idx) => {
            if (!poly.points || poly.points.length < 3) return;
            const isSelected = selectedPolygons.some(sp =>
                sp.source === 'review' && sp.reviewIdx === idx);
            const isEditing = _editMode && _editReviewIdx === idx;
            rctx.beginPath();
            const pts = isEditing && _editPointsRef ? _editPointsRef : poly.points;
            pts.forEach((pt, i) => {
                const xy = pct2px(pt[0], pt[1]);
                i === 0 ? rctx.moveTo(xy[0], xy[1]) : rctx.lineTo(xy[0], xy[1]);
            });
            rctx.closePath();
            // 大红填充 + 描边
            rctx.fillStyle = REVIEW_FILL;
            rctx.fill();
            if (isEditing) {
                rctx.setLineDash([6, 4]);
                rctx.strokeStyle = '#ffeb3b';
                rctx.lineWidth = 3;
            } else {
                rctx.setLineDash([]);
                rctx.strokeStyle = isSelected ? REVIEW_COLOR_SELECTED : REVIEW_COLOR;
                rctx.lineWidth = isSelected ? 3.5 : 3;
            }
            rctx.shadowColor = isSelected && !isEditing ? REVIEW_COLOR : 'transparent';
            rctx.shadowBlur = isSelected && !isEditing ? 6 : 0;
            rctx.stroke();
            rctx.shadowColor = 'transparent';
            rctx.shadowBlur = 0;
            rctx.setLineDash([]);
            // 编辑模式：顶点手柄
            if (isEditing && _editPointsRef) {
                _editPointsRef.forEach((pt, i) => {
                    const xy = pct2px(pt[0], pt[1]);
                    rctx.fillStyle = (i === _draggingVertex) ? '#ffeb3b' : '#fff';
                    rctx.strokeStyle = '#000';
                    rctx.lineWidth = 1.5;
                    rctx.beginPath();
                    rctx.arc(xy[0], xy[1], 5, 0, Math.PI * 2);
                    rctx.fill();
                    rctx.stroke();
                });
            }
            // 显示标签
            if (poly.label && pts[0]) {
                const xy = pct2px(pts[0][0], pts[0][1]);
                rctx.fillStyle = REVIEW_COLOR;
                rctx.font = 'bold 10px sans-serif';
                rctx.fillText(poly.label, xy[0], xy[1] - 5);
            }
        });
    }

    // ===== 多边形点击检测 =====
    function canvasPointToImage(ev) {
        const rect = polyCanvas.getBoundingClientRect();
        const pct = px2pct(ev.clientX - rect.left, ev.clientY - rect.top);
        return { x: pct[0], y: pct[1] };
    }

    // ===== 缩放与平移 =====
    const wrap = document.getElementById('user-imgWrap');
    const ZOOM_STEP = 1.12, ZOOM_MIN = 1.0, ZOOM_MAX = 8.0;

    wrap.addEventListener('wheel', function(e) {
        if (!nW || !nH) return;
        e.preventDefault();
        const fit = _fitRect();
        const wr = wrap.getBoundingClientRect();
        const cx = e.clientX - wr.left, cy = e.clientY - wr.top;
        const fx = (cx - dX) / dW, fy = (cy - dY) / dH;
        const newZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN,
            _zoom * (e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP)));
        if (Math.abs(newZoom - _zoom) < 0.001) return;
        const ndW = fit.w * newZoom, ndH = fit.h * newZoom;
        _panX = cx - fx * ndW - fit.x + (ndW - fit.w) / 2;
        _panY = cy - fy * ndH - fit.y + (ndH - fit.h) / 2;
        _zoom = newZoom;
        calcRect();
        drawAllPolygons();
        drawReviewPolygons();
    }, { passive: false });

    // ===== 画布鼠标事件（平移 / 顶点编辑） =====
    polyCanvas.addEventListener('mousedown', function(e) {
        // 右键平移
        if (e.button === 2) {
            e.preventDefault();
            _panning = true;
            _panStart = { x: e.clientX, y: e.clientY, panX: _panX, panY: _panY };
            this.style.cursor = 'grabbing';
            return;
        }
        if (e.button !== 0) return;

        const rect = polyCanvas.getBoundingClientRect();
        const cv = [e.clientX - rect.left, e.clientY - rect.top];
        const pt = canvasPointToImage(e);

        // 编辑模式：检测拖拽顶点（像素空间距离检测）
        if (_editMode && _editPointsRef) {
            const srcPts = _editPointsRef;
            const vi = pxVertex(cv, srcPts, 12);
            if (vi >= 0) {
                _draggingVertex = vi;
                _editDragStartPct = { x: pt.x, y: pt.y };
                polyCanvas.style.cursor = 'grabbing';
                e.preventDefault();
                e.stopPropagation();
                return;
            }
            // 点击编辑多边形外部 → 退出编辑模式
            const editPts = _editPointsRef;
            if (!pxEdge(cv, editPts, 8) && pxVertex(cv, editPts, 10) < 0 && !pointInPolygon(pt.x, pt.y, editPts)) {
                exitEditMode();
                return;
            }
            return;
        }

        // 非编辑模式：左键拖拽平移画布
        _panning = true;
        _panStart = { x: e.clientX, y: e.clientY, panX: _panX, panY: _panY };
        polyCanvas.style.cursor = 'grabbing';
        _justDragged = false;
    });

    window.addEventListener('mousemove', function(e) {
        // 新增绘制模式：持续显示预览（带橡皮筋线）
        if (_newDrawing && _newDrawPts.length > 0) {
            const pt = canvasPointToImage(e);
            const curXy = pct2px(pt.x, pt.y);
            drawNewDrawingPreview(curXy[0], curXy[1]);
            return;
        }
        // 平移
        if (_panning) {
            _panX = _panStart.panX + (e.clientX - _panStart.x);
            _panY = _panStart.panY + (e.clientY - _panStart.y);
            calcRect();
            drawAllPolygons();
            drawReviewPolygons();
            return;
        }
        // 顶点拖拽（标注者多边形）
        if (_editMode && _draggingVertex >= 0 && _editPointsRef && _editAnnotatorIdx >= 0 && _editPolyIdx >= 0) {
            const pt = canvasPointToImage(e);
            _editPointsRef[_draggingVertex] = [pt.x, pt.y];
            // 实时更新标注数据
            const ad = (unitData && unitData.unit && unitData.unit.annotator_data) || [];
            if (ad[_editAnnotatorIdx] && ad[_editAnnotatorIdx].polygons && ad[_editAnnotatorIdx].polygons[_editPolyIdx]) {
                ad[_editAnnotatorIdx].polygons[_editPolyIdx].points[_draggingVertex] = [pt.x, pt.y];
            }
            drawAllPolygons();
            drawReviewPolygons();
            return;
        }
        // 顶点拖拽（审核结果多边形）
        if (_editMode && _draggingVertex >= 0 && _editPointsRef && _editReviewIdx >= 0) {
            const pt = canvasPointToImage(e);
            _editPointsRef[_draggingVertex] = [pt.x, pt.y];
            if (_editReviewIdx < reviewPolygons.length) {
                reviewPolygons[_editReviewIdx].points[_draggingVertex] = [pt.x, pt.y];
            }
            drawReviewPolygons();
            return;
        }
    });

    window.addEventListener('mouseup', function(e) {
        // 结束平移
        if (_panning) {
            const dx = e.clientX - _panStart.x;
            const dy = e.clientY - _panStart.y;
            _justDragged = (Math.abs(dx) > 3 || Math.abs(dy) > 3);
            _panning = false;
            // 恢复光标：编辑模式或新绘制模式保持 crosshair，否则 default
            if (_editMode || _newDrawing) {
                polyCanvas.style.cursor = 'crosshair';
            } else {
                polyCanvas.style.cursor = 'default';
            }
            return;
        }
        // 结束顶点拖拽
        if (_editMode && _draggingVertex >= 0) {
            _draggingVertex = -1;
            _editDragStartPct = null;
            polyCanvas.style.cursor = 'crosshair';
            return;
        }
    });

    // ===== 双击编辑多边形顶点 =====
    polyCanvas.addEventListener('dblclick', function(ev) {
        if (_editMode || _newDrawing) return;
        const rect = polyCanvas.getBoundingClientRect();
        const cv = [ev.clientX - rect.left, ev.clientY - rect.top];
        const pt = canvasPointToImage(ev);

        // 1. 先检测审核结果多边形（优先级更高，因为在上层）
        let foundReviewIdx = -1;
        for (let i = 0; i < reviewPolygons.length; i++) {
            const poly = reviewPolygons[i];
            if (!poly.points || poly.points.length < 3) continue;
            if (pxVertex(cv, poly.points, 10) >= 0) { foundReviewIdx = i; break; }
        }
        if (foundReviewIdx < 0) {
            for (let i = 0; i < reviewPolygons.length; i++) {
                const poly = reviewPolygons[i];
                if (!poly.points || poly.points.length < 3) continue;
                if (pxEdge(cv, poly.points, 8)) { foundReviewIdx = i; break; }
            }
        }
        if (foundReviewIdx >= 0) {
            _editMode = true;
            _editAnnotatorIdx = -1;
            _editPolyIdx = -1;
            _editReviewIdx = foundReviewIdx;
            _draggingVertex = -1;
            _editDragStartPct = null;
            _editPointsRef = reviewPolygons[foundReviewIdx].points;
            document.getElementById('review-sidebar').style.opacity = '0.5';
            polyCanvas.style.cursor = 'crosshair';
            selectedPolygons = [];
            drawAllPolygons();
            drawReviewPolygons();
            toast('编辑模式：拖拽顶点修改审核结果多边形，点击外部退出');
            return;
        }

        // 2. 再检测标注者多边形
        const polys = getVisiblePolys();
        let found = null;
        for (const poly of polys) {
            if (!poly.points || poly.points.length < 3) continue;
            if (pxVertex(cv, poly.points, 10) >= 0) { found = poly; break; }
        }
        if (!found) {
            for (const poly of polys) {
                if (!poly.points || poly.points.length < 3) continue;
                if (pxEdge(cv, poly.points, 8)) { found = poly; break; }
            }
        }
        if (!found) return;

        // 进入编辑模式
        const ad = (unitData && unitData.unit && unitData.unit.annotator_data) || [];
        const annotator = ad[found.annotatorIdx];
        if (!annotator || !annotator.polygons || !annotator.polygons[found.polyIdx]) return;

        _editMode = true;
        _editAnnotatorIdx = found.annotatorIdx;
        _editPolyIdx = found.polyIdx;
        _editReviewIdx = -1;
        _draggingVertex = -1;
        // 快照当前点集
        _editPointsRef = annotator.polygons[found.polyIdx].points;
        document.getElementById('review-sidebar').style.opacity = '0.5';
        polyCanvas.style.cursor = 'crosshair';
        drawAllPolygons();
        toast('编辑模式：拖拽顶点修改多边形，点击外部退出');
    });

    // 退出编辑模式
    function exitEditMode() {
        _editMode = false;
        _editAnnotatorIdx = -1;
        _editPolyIdx = -1;
        _editReviewIdx = -1;
        _draggingVertex = -1;
        _editPointsRef = null;
        _editDragStartPct = null;
        document.getElementById('review-sidebar').style.opacity = '1';
        polyCanvas.style.cursor = 'default';
        drawAllPolygons();
        drawReviewPolygons();
    }

    // Esc 退出编辑
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape' && _editMode) {
            exitEditMode();
        }
    });

    // ===== 多边形点击检测 =====
    function pointInPolygon(px, py, points) {
        let inside = false;
        for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
            const xi = points[i][0], yi = points[i][1];
            const xj = points[j][0], yj = points[j][1];
            if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) {
                inside = !inside;
            }
        }
        return inside;
    }

    function pointNearEdge(px, py, points, threshold) {
        for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
            const dist = pointToSegmentDist(px, py, points[i][0], points[i][1], points[j][0], points[j][1]);
            if (dist < threshold) return true;
        }
        return false;
    }

    function pointToSegmentDist(px, py, x1, y1, x2, y2) {
        const dx = x2 - x1, dy = y2 - y1;
        const lenSq = dx * dx + dy * dy;
        if (lenSq === 0) return Math.hypot(px - x1, py - y1);
        let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
        t = Math.max(0, Math.min(1, t));
        return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
    }

    function pointNearVertex(px, py, points, threshold) {
        for (let i = 0; i < points.length; i++) {
            if (Math.hypot(px - points[i][0], py - points[i][1]) < threshold) return i;
        }
        return -1;
    }

    // ===== 像素空间命中检测（解决百分比坐标系阈值过大问题） =====
    // cv: [canvasX, canvasY] 画布像素坐标
    // pctPts: 多边形顶点数组 [[x%, y%], ...]
    // thPx: 像素阈值
    function pxVertex(cv, pctPts, thPx) {
        for (let i = 0; i < pctPts.length; i++) {
            const pxy = pct2px(pctPts[i][0], pctPts[i][1]);
            if (Math.hypot(cv[0] - pxy[0], cv[1] - pxy[1]) < thPx) return i;
        }
        return -1;
    }
    function pxEdge(cv, pctPts, thPx) {
        for (let i = 0, j = pctPts.length - 1; i < pctPts.length; j = i++) {
            const p1 = pct2px(pctPts[i][0], pctPts[i][1]);
            const p2 = pct2px(pctPts[j][0], pctPts[j][1]);
            if (pointToSegmentDist(cv[0], cv[1], p1[0], p1[1], p2[0], p2[1]) < thPx) return true;
        }
        return false;
    }

    // ===== 点击选择多边形 =====
    polyCanvas.addEventListener('click', function(ev) {
        // 平移拖拽后的 click 忽略
        if (_justDragged) { _justDragged = false; return; }
        // 编辑模式下由 mousedown/mouseup 处理
        if (_editMode) return;

        const rect = polyCanvas.getBoundingClientRect();
        const cv = [ev.clientX - rect.left, ev.clientY - rect.top];
        const pt = canvasPointToImage(ev);

        // Shift+点击审核多边形：删除
        if (ev.shiftKey && !ev.ctrlKey) {
            let foundIdx = -1;
            for (let i = reviewPolygons.length - 1; i >= 0; i--) {
                if (!reviewPolygons[i].points || reviewPolygons[i].points.length < 3) continue;
                if (pxEdge(cv, reviewPolygons[i].points, 8) ||
                    pxVertex(cv, reviewPolygons[i].points, 8) >= 0 ||
                    pointInPolygon(pt.x, pt.y, reviewPolygons[i].points)) {
                    foundIdx = i;
                    break;
                }
            }
            if (foundIdx >= 0) {
                reviewPolygons.splice(foundIdx, 1);
                drawReviewPolygons();
                document.getElementById('user-polyCount').textContent = reviewPolygons.length;
                updateSelectionInfo();
                return;
            }
        }

        // 同时搜索标注者多边形和审核结果多边形
        const polys = getVisiblePolys();
        let found = null;
        let foundSource = 'annotator';  // 'annotator' or 'review'

        // 优先级：审核结果多边形优先 → 顶点 > 边 > 内部
        // 先搜审核结果（审核者多边形优先选中）
        if (visibleReviewResult) {
            for (let i = reviewPolygons.length - 1; i >= 0; i--) {
                const rp = reviewPolygons[i];
                if (!rp.points || rp.points.length < 3) continue;
                if (pxVertex(cv, rp.points, 12) >= 0) {
                    found = { reviewIdx: i, points: rp.points, label: rp.label || '', _selfDrawn: rp._selfDrawn };
                    foundSource = 'review'; break;
                }
            }
        }
        if (!found && visibleReviewResult) {
            for (let i = reviewPolygons.length - 1; i >= 0; i--) {
                const rp = reviewPolygons[i];
                if (!rp.points || rp.points.length < 3) continue;
                if (pxEdge(cv, rp.points, 10)) {
                    found = { reviewIdx: i, points: rp.points, label: rp.label || '', _selfDrawn: rp._selfDrawn };
                    foundSource = 'review'; break;
                }
            }
        }
        // 再搜标注者多边形
        if (!found) {
            for (const poly of polys) {
                if (!poly.points || poly.points.length < 3) continue;
                if (pxVertex(cv, poly.points, 10) >= 0) { found = poly; foundSource = 'annotator'; break; }
            }
        }
        if (!found) {
            for (const poly of polys) {
                if (!poly.points || poly.points.length < 3) continue;
                if (pxEdge(cv, poly.points, 8)) { found = poly; foundSource = 'annotator'; break; }
            }
        }
        // 内部命中：审核者优先
        if (!found && visibleReviewResult) {
            for (let i = reviewPolygons.length - 1; i >= 0; i--) {
                const rp = reviewPolygons[i];
                if (!rp.points || rp.points.length < 3) continue;
                if (pointInPolygon(pt.x, pt.y, rp.points)) {
                    found = { reviewIdx: i, points: rp.points, label: rp.label || '', _selfDrawn: rp._selfDrawn };
                    foundSource = 'review'; break;
                }
            }
        }
        if (!found) {
            for (const poly of polys) {
                if (!poly.points || poly.points.length < 3) continue;
                if (pointInPolygon(pt.x, pt.y, poly.points)) { found = poly; foundSource = 'annotator'; break; }
            }
        }

        if (found) {
            const isMulti = ev.ctrlKey;
            // 构造统一的选择项
            const selItem = foundSource === 'annotator'
                ? { source: 'annotator', annotatorIdx: found.annotatorIdx, polyIdx: found.polyIdx,
                    points: found.points, label: found.label, color: found.color }
                : { source: 'review', reviewIdx: found.reviewIdx,
                    points: found.points, label: found.label,
                    color: REVIEW_COLOR };

            const exIdx = selectedPolygons.findIndex(sp => {
                if (sp.source === 'annotator' && selItem.source === 'annotator')
                    return sp.annotatorIdx === selItem.annotatorIdx && sp.polyIdx === selItem.polyIdx;
                if (sp.source === 'review' && selItem.source === 'review')
                    return sp.reviewIdx === selItem.reviewIdx;
                return false;
            });

            if (isMulti) {
                if (exIdx >= 0) selectedPolygons.splice(exIdx, 1);
                else selectedPolygons.push(selItem);
            } else {
                if (exIdx >= 0 && selectedPolygons.length === 1) selectedPolygons = [];
                else selectedPolygons = [selItem];
            }
            drawAllPolygons();
            drawReviewPolygons();
            updateSelectionInfo();
        } else {
            selectedPolygons = [];
            drawAllPolygons();
            drawReviewPolygons();
            updateSelectionInfo();
        }
    });

    // ===== 选中后更新底栏信息 =====
    function updateSelectionInfo() {
        const infoEl = document.getElementById('review-selection-info');
        if (!selectedPolygons.length) {
            // 清空选中信息，恢复默认
            if (infoEl) infoEl.innerHTML = '';
            // 取消所有标签/运输方式高亮
            document.querySelectorAll('#poi-labelBtns .user-bigbtn').forEach(b =>
                b.classList.remove('active'));
            // 不清除 reviewTransModes，只更新按钮状态
            updateTransBtnStates();
            return;
        }

        const sel = selectedPolygons[0];
        let html = '';
        if (sel.source === 'annotator') {
            // 标注者多边形：只读显示
            const ad = (unitData && unitData.unit && unitData.unit.annotator_data) || [];
            const ann = ad[sel.annotatorIdx];
            const poly = ann && ann.polygons ? ann.polygons[sel.polyIdx] : null;
            const label = poly ? (poly.label || '无标签') : '无标签';
            const transModes = ann ? (ann.transport_modes || []) : [];
            html = `<span style="color:${sel.color}">■</span> 标注者: ${ann ? ann.group_id : '?'}` +
                ` | 园区类型: <b>${label}</b>` +
                ` | 运输方式: <b>${transModes.join(', ') || '无'}</b>` +
                ` <span style="color:#888;font-size:9px">(只读)</span>`;
            // 高亮对应的标签按钮
            document.querySelectorAll('#poi-labelBtns .user-bigbtn').forEach(b => {
                b.classList.toggle('active', b.dataset.label === label);
            });
            // 高亮运输方式按钮（不修改 reviewTransModes）
            document.querySelectorAll('#poi-transBtns .user-bigbtn').forEach(b => {
                b.classList.toggle('on', transModes.includes(b.dataset.mode));
            });
        } else if (sel.source === 'review') {
            // 审核结果多边形：可修改
            const rp = reviewPolygons[sel.reviewIdx];
            const label = rp ? (rp.label || '无标签') : '无标签';
            const polyTransModes = rp && rp.transport_modes ? rp.transport_modes : reviewTransModes;
            html = `<span style="color:${REVIEW_COLOR}">■</span> 审核结果 #${sel.reviewIdx + 1}` +
                (rp && rp._adoptedFrom ? ` <span style="color:#888;font-size:9px">(采纳自标注者)</span>` : '') +
                ` | 园区类型: <b>${label}</b>` +
                ` | 运输方式: <b>${polyTransModes.join(', ') || '无'}</b>` +
                ` <span style="color:#4ecca3;font-size:9px">(可修改：点击下方按钮)</span>`;
            // 设置当前标签为审核多边形的标签
            currentLabel = label;
            document.getElementById('poiToolbarActiveLabel').textContent = currentLabel || '未选择';
            document.querySelectorAll('#poi-labelBtns .user-bigbtn').forEach(b => {
                b.classList.toggle('active', b.dataset.label === label);
            });
            // 高亮该多边形自身的运输方式按钮
            document.querySelectorAll('#poi-transBtns .user-bigbtn').forEach(b => {
                b.classList.toggle('on', polyTransModes.includes(b.dataset.mode));
            });
        }
        if (infoEl) infoEl.innerHTML = html;
    }

    document.getElementById('tool-select-all').addEventListener('click', () => {
        selectedPolygons = getVisiblePolys()
            .filter(p => p.points && p.points.length >= 3)
            .map(p => ({ source: 'annotator', annotatorIdx: p.annotatorIdx, polyIdx: p.polyIdx,
                points: p.points, label: p.label, color: p.color }));
        drawAllPolygons();
        updateSelectionInfo();
    });

    document.getElementById('tool-deselect-all').addEventListener('click', () => {
        selectedPolygons = [];
        drawAllPolygons();
        updateSelectionInfo();
    });

    // ===== 采纳：将选中的标注者多边形变为审核结果（继承原属性） =====
    document.getElementById('tool-accept-result').addEventListener('click', () => {
        const toAdopt = selectedPolygons.filter(sp => sp.source === 'annotator');
        if (!toAdopt.length) { toast('请先选择标注者多边形'); return; }
        let added = 0;
        toAdopt.forEach(sp => {
            // 避免重复添加
            const dup = reviewPolygons.some(rp =>
                rp._adoptedFrom && rp._adoptedFrom.annotatorIdx === sp.annotatorIdx &&
                rp._adoptedFrom.polyIdx === sp.polyIdx);
            if (dup) return;
            // 从原始标注者数据中获取该多边形的完整属性
            const ad = (unitData && unitData.unit && unitData.unit.annotator_data) || [];
            const ann = ad[sp.annotatorIdx];
            const origPoly = ann && ann.polygons ? ann.polygons[sp.polyIdx] : null;
            reviewPolygons.push({
                points: sp.points.map(p => [p[0], p[1]]),  // 深拷贝
                label: origPoly ? (origPoly.label || '') : (sp.label || ''),
                transport_modes: ann ? [...(ann.transport_modes || [])] : [],
                _adoptedFrom: { annotatorIdx: sp.annotatorIdx, polyIdx: sp.polyIdx }
            });
            added++;
        });
        if (added > 0) {
            selectedPolygons = [];
            drawAllPolygons();
            drawReviewPolygons();
            document.getElementById('user-polyCount').textContent = reviewPolygons.length;
            updateSelectionInfo();
            toast(`已采纳 ${added} 个多边形为审核结果`);
        }
    });

    // ===== 新增：审核者自行绘制多边形 =====
    let _newDrawing = false;
    let _newDrawPts = [];

    document.getElementById('tool-add-new').addEventListener('click', () => {
        _newDrawing = true;
        _newDrawPts = [];
        selectedPolygons = [];
        drawAllPolygons();
        drawReviewPolygons();
        polyCanvas.style.cursor = 'crosshair';
        toast('点击画布添加顶点，双击闭合多边形');
    });

    // 修改 mousedown 以支持新绘制模式（capture phase 优先拦截）
    polyCanvas.addEventListener('mousedown', function(e) {
        if (!_newDrawing) return;
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        const pt = canvasPointToImage(e);
        _newDrawPts.push([pt.x, pt.y]);
        drawReviewPolygons();
        drawNewDrawingPreview();
    }, true);

    polyCanvas.addEventListener('dblclick', function(e) {
        if (!_newDrawing || _newDrawPts.length < 3) return;
        e.preventDefault();
        e.stopPropagation();
        finishNewDrawing();
    }, true);

    function drawNewDrawingPreview(toX, toY) {
        if (!_newDrawing || _newDrawPts.length === 0) return;
        drawReviewPolygons();
        const pxy = _newDrawPts.map(p => pct2px(p[0], p[1]));
        // 已有顶点之间的连线
        rctx.strokeStyle = '#ff0';
        rctx.lineWidth = 2;
        rctx.setLineDash([5, 5]);
        rctx.beginPath();
        rctx.moveTo(pxy[0][0], pxy[0][1]);
        for (let i = 1; i < pxy.length; i++) {
            rctx.lineTo(pxy[i][0], pxy[i][1]);
        }
        rctx.stroke();
        // 橡皮筋线：从最后一个顶点到鼠标位置
        if (toX !== undefined && toY !== undefined) {
            rctx.strokeStyle = '#ffeb3b';
            rctx.lineWidth = 1.5;
            rctx.setLineDash([4, 4]);
            rctx.beginPath();
            rctx.moveTo(pxy[pxy.length - 1][0], pxy[pxy.length - 1][1]);
            rctx.lineTo(toX, toY);
            rctx.stroke();
        }
        rctx.setLineDash([]);
        pxy.forEach(p => {
            rctx.fillStyle = '#ff0';
            rctx.beginPath();
            rctx.arc(p[0], p[1], 4, 0, Math.PI * 2);
            rctx.fill();
        });
    }

    function finishNewDrawing() {
        if (_newDrawPts.length < 3) return;
        reviewPolygons.push({
            points: _newDrawPts.map(p => [p[0], p[1]]),
            label: currentLabel || '',
            transport_modes: [...reviewTransModes],
            _selfDrawn: true,
        });
        _newDrawing = false;
        _newDrawPts = [];
        polyCanvas.style.cursor = 'default';
        drawReviewPolygons();
        document.getElementById('user-polyCount').textContent = reviewPolygons.length;
        updateSelectionInfo();
        toast('新多边形已添加');
    }

    function cancelNewDrawing() {
        _newDrawing = false;
        _newDrawPts = [];
        polyCanvas.style.cursor = 'default';
        drawReviewPolygons();
        toast('已取消绘制');
    }

    // ===== 取消采纳：移除已采纳的多边形 =====
    document.getElementById('tool-unaccept').addEventListener('click', () => {
        const selReview = selectedPolygons.filter(sp => sp.source === 'review');
        if (selReview.length > 0) {
            const indices = selReview.map(sp => sp.reviewIdx).sort((a, b) => b - a);
            indices.forEach(i => reviewPolygons.splice(i, 1));
            selectedPolygons = [];
            drawAllPolygons();
            drawReviewPolygons();
            document.getElementById('user-polyCount').textContent = reviewPolygons.length;
            updateSelectionInfo();
            toast(`已取消采纳 ${indices.length} 个多边形`);
        } else {
            toast('请先选择审核结果多边形（红色多边形）');
        }
    });

    // ===== 标签选择 =====
    document.querySelectorAll('#poi-labelBtns .user-bigbtn').forEach(btn => {
        btn.addEventListener('click', () => {
            const newLabel = (currentLabel === btn.dataset.label) ? null : btn.dataset.label;
            currentLabel = newLabel;
            document.getElementById('poiToolbarActiveLabel').textContent = currentLabel || '未选择';
            document.querySelectorAll('#poi-labelBtns .user-bigbtn').forEach(b =>
                b.classList.toggle('active', b.dataset.label === currentLabel));

            // 如果选中了审核结果多边形，同步更新其 label（仅被采纳的多边形可修改属性）
            if (selectedPolygons.length === 1 && selectedPolygons[0].source === 'review') {
                const rp = reviewPolygons[selectedPolygons[0].reviewIdx];
                if (rp && !rp._adoptedFrom) {
                    toast('只有被采纳的多边形可以修改属性');
                } else if (rp) {
                    rp.label = currentLabel || '';
                    selectedPolygons[0].label = currentLabel || '';
                    drawReviewPolygons();
                    updateSelectionInfo();
                }
            }
        });
    });

    // ===== 运输方式 =====
    function updateTransBtnStates() {
        document.querySelectorAll('#poi-transBtns .user-bigbtn').forEach(btn => {
            btn.classList.toggle('on', reviewTransModes.includes(btn.dataset.mode));
        });
        document.getElementById('user-vTrans').textContent = reviewTransModes.join(', ') || '-';
    }

    document.querySelectorAll('#poi-transBtns .user-bigbtn').forEach(btn => {
        btn.addEventListener('click', () => {
            const mode = btn.dataset.mode;
            const idx = reviewTransModes.indexOf(mode);
            if (idx >= 0) reviewTransModes.splice(idx, 1);
            else reviewTransModes.push(mode);
            updateTransBtnStates();
            // 如果选中了审核结果多边形，同步更新该多边形的 transport_modes（仅被采纳的多边形可修改属性）
            if (selectedPolygons.length === 1 && selectedPolygons[0].source === 'review') {
                const rp = reviewPolygons[selectedPolygons[0].reviewIdx];
                if (rp && !rp._adoptedFrom) {
                    toast('只有被采纳的多边形可以修改属性');
                } else if (rp) {
                    if (!rp.transport_modes) rp.transport_modes = [];
                    const pidx = rp.transport_modes.indexOf(mode);
                    pidx >= 0 ? rp.transport_modes.splice(pidx, 1) : rp.transport_modes.push(mode);
                    updateSelectionInfo();
                }
            }
        });
    });

    // ===== 保存 =====
    async function doSavePOI() {
        const unit = allUnits[currentUnitIdx];
        try {
            const payload = {
                review_result: reviewPolygons.length > 0 ? '是' : '否',
                review_polygons: reviewPolygons,
                review_transport_modes: reviewTransModes,
            };
            const r = await API.submitReviewUnit(currentTask.task_id, currentTask.group_id, unit.id, payload);
            if (r.ok) {
                reviewStatusMap[String(unit.id)] = { done: true };
                toast('审核结果已保存');
                document.getElementById('user-vStatus').textContent = '已审核';
                renderUnitList();  // 刷新列表显示完成状态
                return true;
            }
            return false;
        } catch (e) { toast('保存失败: ' + e.message); return false; }
    }

    async function savePOIAndNext() {
        const ok = await doSavePOI();
        if (ok && currentUnitIdx < allUnits.length - 1) {
            setTimeout(() => loadUnit(currentUnitIdx + 1), 300);
        }
    }

    document.getElementById('user-saveBtn').addEventListener('click', async () => {
        await doSavePOI();
    });

    // ===== 导航 =====
    document.getElementById('user-prevBtn').addEventListener('click', () => {
        if (currentUnitIdx > 0) loadUnit(currentUnitIdx - 1);
    });
    document.getElementById('user-nextBtn').addEventListener('click', () => {
        savePOIAndNext();
    });

    // ===== 删除审核多边形（复用取消采纳逻辑） =====
    document.getElementById('poiDelPolyBtn').addEventListener('click', () => {
        if (_newDrawing) { cancelNewDrawing(); return; }
        document.getElementById('tool-unaccept').click();
    });

    document.getElementById('poiUndoBtn').addEventListener('click', () => {
        if (_newDrawing) { cancelNewDrawing(); return; }
        selectedPolygons = [];
        drawAllPolygons();
        drawReviewPolygons();
    });

    // ===== 退出 =====
    document.getElementById('user-logoutBtn').addEventListener('click', async () => {
        try { await API.logout(); } catch (e) {}
        window.location.href = '/';
    });

    // ===== 键盘快捷键 =====
    document.addEventListener('keydown', e => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
        switch (e.key.toLowerCase()) {
            case 's': if (!e.ctrlKey) { e.preventDefault(); document.getElementById('user-saveBtn').click(); } break;
            case 'enter': e.preventDefault();
                savePOIAndNext(); break;
            case 'arrowleft': e.preventDefault();
                if (currentUnitIdx > 0) loadUnit(currentUnitIdx - 1); break;
            case 'arrowright': e.preventDefault();
                if (currentUnitIdx < allUnits.length - 1) loadUnit(currentUnitIdx + 1); break;
            case 'delete': document.getElementById('poiDelPolyBtn').click(); break;
            case 'escape': if (_newDrawing) { cancelNewDrawing(); } else { exitEditMode(); } break;
            case '1': case '2': case '3': case '4':
            case '5': case '6': case '7': case '8':
                const btn = document.querySelector(`#poi-labelBtns .user-bigbtn:nth-child(${e.key})`);
                if (btn) btn.click();
                break;
            case 'q': toggleTrans('公路'); break;
            case 'w': toggleTrans('铁路'); break;
            case 'e': toggleTrans('水路'); break;
            case 'r': toggleTrans('航空'); break;
        }
    });

    function toggleTrans(mode) {
        const idx = reviewTransModes.indexOf(mode);
        idx >= 0 ? reviewTransModes.splice(idx, 1) : reviewTransModes.push(mode);
        updateTransBtnStates();
    }

    window.addEventListener('resize', () => {
        _zoom = 1.0; _panX = 0; _panY = 0;
        calcRect();
        drawAllPolygons();
        drawReviewPolygons();
    });

    init();
})();
