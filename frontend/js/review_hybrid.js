/**
 * review_hybrid.js - 审核 Hybrid 主控
 * 组合判读审核 + 多边形审核（两步式）
 */
(function() {
    // ===== 工具 =====
    function toast(m) {
        const t = document.getElementById('user-toast');
        t.textContent = m;
        t.classList.add('show');
        setTimeout(() => t.classList.remove('show'), 2200);
    }
    function setLoading(s) { document.getElementById('user-loading').classList.toggle('hide', !s); }

    // 审核者颜色（大红 Crimson）
    const REVIEW_COLOR = '#dc143c';
    const REVIEW_FILL = 'rgba(220, 20, 60, 0.3)';
    const REVIEW_COLOR_SELECTED = '#fff';

    // 标注者颜色（避免与审核者大红冲突：移除了 e94560 玫红和 ef5350 红色，替换为粉色/浅橙）
    const annotatorColors = [
        '#f06292', '#4ecca3', '#42a5f5', '#ffa726',
        '#ab47bc', '#26c6da', '#ffb74d', '#66bb6a'
    ];

    let currentTask = null, allUnits = [], currentUnitIdx = -1;
    let unitData = null;
    let reviewResult = null;     // "是"/"否"
    let reviewPolygons = [];
    let selectedPolygons = [];
    let visibleAnnotators = {};
    let visibleReviewResult = true; // 审核结果多边形可见性
    let reviewTransModes = [];
    let currentLabel = null;
    let isPhase2 = false;       // 是否处于 Phase 2
    let reviewStatusMap = {};   // {unitId: {done: true}} 审核完成状态

    let _justDragged = false;

    // 顶点编辑状态
    let _editMode = false;
    let _editAnnotatorIdx = -1;
    let _editPolyIdx = -1;
    let _editReviewIdx = -1;     // 正在编辑的审核结果多边形索引
    let _draggingVertex = -1;
    let _editPointsRef = null;

    // 平移状态
    let _reviewPanning = false, _reviewPanStart = { x: 0, y: 0, panX: 0, panY: 0 };

    const polyCanvas = document.getElementById('polyCanvas');
    const reviewCanvas = document.getElementById('reviewCanvas');
    const ctx = polyCanvas.getContext('2d');
    const rctx = reviewCanvas.getContext('2d');

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
            const rt = (tasks || []).filter(t => t.task_type === 'hybrid_review');
            if (!rt.length) { setLoading(false); toast('没有审核 Hybrid 任务'); return; }
            renderTaskTabs(rt);
            await selectTask(rt[0]);
        } catch (e) { toast('加载失败: ' + e.message); setLoading(false); }
    }

    function renderTaskTabs(tasks) {
        const tabsEl = document.getElementById('user-taskTabs');
        tabsEl.innerHTML = tasks.map((t, i) =>
            `<div class="user-task-tab active" data-idx="${i}">${t.task_name || t.task_id}</div>`).join('');
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
        document.getElementById('user-taskHeader').textContent = task.task_name || '审核 Hybrid';
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

    function showImgLoading(s) { document.getElementById('img-loading').classList.toggle('hidden', !s); }

    async function loadUnit(idx) {
        if (idx < 0 || idx >= allUnits.length) return;
        const unit = allUnits[idx];
        currentUnitIdx = idx;
        showImgLoading(true);
        selectedPolygons = [];
        reviewPolygons = [];
        isPhase2 = false;

        try {
            const resp = await API.getReviewUnit(currentTask.task_id, currentTask.group_id, unit.id);
            unitData = resp;

            resetZoom();  // 切换 unit 时重置缩放

            // 恢复已有审核（必须在 onImgLoaded 之前，确保 bbox/多边形绘制时状态已正确）
            if (resp.existing_review) {
                reviewResult = resp.existing_review.review_result;
                reviewPolygons = resp.existing_review.review_polygons || [];
                reviewTransModes = resp.existing_review.review_transport_modes || [];
                if (reviewResult === '是') isPhase2 = true;
            } else {
                reviewResult = null;
                reviewPolygons = [];
                reviewTransModes = [];
                isPhase2 = false;
            }

            const img = document.getElementById('user-mainImg');
            img.src = resp.image_url;
            img.onload = onImgLoaded;
            if (img.complete && img.naturalWidth > 0) onImgLoaded();

            function onImgLoaded() {
                syncCanvasSizes();
                buildAnnotatorPolygons(resp.unit);
                drawAllPolygons();
                drawMaskAndBBox(resp);
                drawReviewPolygons();
                showImgLoading(false);
            }

            document.getElementById('user-vName').textContent = shortFileName(unit.image || '');
            document.getElementById('user-vCoord').textContent = unit.lat != null ? `${unit.lat}, ${unit.lng}` : '-';
            document.getElementById('user-vStatus').textContent = '待审核';

            // 更新比例标签
            updateRatioLabels(unit);

            updatePhaseUI();
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

    function updateRatioLabels(unit) {
        const stats = unit.options_stats || {};
        ['ratio-yes', 'ratio-no'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.textContent = '';
        });
        for (const [opt, info] of Object.entries(stats)) {
            const elId = 'ratio-' + (opt === '是' ? 'yes' : 'no');
            const el = document.getElementById(elId);
            if (el) {
                el.textContent = `${info.count}/${unit.annotator_count} (${Math.round(info.ratio * 100)}%)`;
            }
        }
    }

    function buildAnnotatorPolygons(unit) {
        const annotatorData = unit.annotator_data || [];
        if (Object.keys(visibleAnnotators).length === 0) {
            annotatorData.forEach((_, i) => { visibleAnnotators[i] = true; });
        }
        const checksEl = document.getElementById('review-annotator-checks');
        checksEl.innerHTML = annotatorData.map((ad, i) => {
            const color = annotatorColors[i % annotatorColors.length];
            const checked = visibleAnnotators[i] !== false ? 'checked' : '';
            return `<label>
                <input type="checkbox" class="annotator-check" data-idx="${i}" ${checked}>
                <span class="annotator-color-dot" style="background:${color}"></span>
                ${ad.group_id || '标注者'+(i+1)}
                <span style="color:#888;font-size:8px">(${(ad.polygons||[]).length}框)</span>
            </label>`;
        }).join('') + `
            <hr style="border-color:#0f3460;margin:4px 0">
            <label>
                <input type="checkbox" class="review-result-check" ${visibleReviewResult ? 'checked' : ''}>
                <span class="annotator-color-dot" style="background:${REVIEW_COLOR}"></span>
                审核结果
                <span class="review-result-count" style="color:#888;font-size:8px">(${reviewPolygons.length}框)</span>
            </label>`;
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
        initHybridSidebarDrag();
    }

    let _hybridSidebarDragging = false;
    let _hybridSidebarStart = { x: 0, y: 0, left: 0, top: 0 };

    function initHybridSidebarDrag() {
        const sidebar = document.getElementById('review-sidebar');
        const header = sidebar.querySelector('h4');
        if (!header) return;

        header.style.cursor = 'move';
        header.style.userSelect = 'none';
        header.title = '拖拽移动面板';

        header.addEventListener('mousedown', function(e) {
            if (e.target.tagName === 'INPUT') return;
            e.preventDefault();
            _hybridSidebarDragging = true;
            const rect = sidebar.getBoundingClientRect();
            const parentRect = sidebar.parentElement.getBoundingClientRect();
            _hybridSidebarStart = {
                x: e.clientX,
                y: e.clientY,
                left: rect.left - parentRect.left,
                top: rect.top - parentRect.top
            };
            sidebar.style.cursor = 'grabbing';
        });

        window.addEventListener('mousemove', function(e) {
            if (!_hybridSidebarDragging) return;
            const parentRect = sidebar.parentElement.getBoundingClientRect();
            let newLeft = _hybridSidebarStart.left + (e.clientX - _hybridSidebarStart.x);
            let newTop = _hybridSidebarStart.top + (e.clientY - _hybridSidebarStart.y);
            newLeft = Math.max(0, Math.min(newLeft, parentRect.width - sidebar.offsetWidth));
            newTop = Math.max(0, Math.min(newTop, parentRect.height - sidebar.offsetHeight));
            sidebar.style.left = newLeft + 'px';
            sidebar.style.top = newTop + 'px';
            sidebar.style.right = 'auto';
        });

        window.addEventListener('mouseup', function(e) {
            if (_hybridSidebarDragging) {
                _hybridSidebarDragging = false;
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
                    annotatorIdx: ai, polyIdx: pi,
                    points: poly.points || [], label: poly.label || '', color: color,
                });
            });
        });
        return result;
    }

    // ===== 缩放与平移（参考 hybrid_main.js 的 calcRect 逻辑） =====
    let _zoom = 1.0, _panX = 0, _panY = 0;
    let _fitW, _fitH, _fitX, _fitY;  // 无缩放时的 fit 参数
    let _dW, _dH, _dX, _dY;          // 当前缩放+平移后的实际显示参数
    let _nW, _nH;                     // 图片原始尺寸

    function _computeFit() {
        const wrap = document.getElementById('user-imgWrap');
        const pw = wrap.clientWidth, ph = wrap.clientHeight;
        const s = Math.min(pw / _nW, ph / _nH);
        _fitW = _nW * s;
        _fitH = _nH * s;
        _fitX = (pw - _fitW) / 2;
        _fitY = (ph - _fitH) / 2;
    }

    function syncCanvasSizes() {
        const img = document.getElementById('user-mainImg');
        _nW = img.naturalWidth || 0;
        _nH = img.naturalHeight || 0;
        if (!_nW || !_nH) return;

        _computeFit();

        // 应用缩放 + 平移
        _dW = Math.round(_fitW * _zoom);
        _dH = Math.round(_fitH * _zoom);
        _dX = Math.round(_fitX + _panX - (_dW - _fitW) / 2);
        _dY = Math.round(_fitY + _panY - (_dH - _fitH) / 2);

        // 定位图片
        img.style.position = 'absolute';
        img.style.left = _dX + 'px';
        img.style.top = _dY + 'px';
        img.style.width = _dW + 'px';
        img.style.height = _dH + 'px';
        img.style.maxWidth = 'none';
        img.style.maxHeight = 'none';

        // 定位所有 canvas
        const canvases = ['user-maskCanvas', 'user-bboxCanvas', 'polyCanvas', 'reviewCanvas'];
        canvases.forEach(cid => {
            const c = document.getElementById(cid);
            if (!c) return;
            c.style.left = _dX + 'px';
            c.style.top = _dY + 'px';
            c.style.width = _dW + 'px';
            c.style.height = _dH + 'px';
            c.width = _dW;
            c.height = _dH;
        });
    }

    function resetZoom() { _zoom = 1.0; _panX = 0; _panY = 0; }

    function getImageTransform() {
        if (!_dW || !_dH || !_nW || !_nH) {
            return { scale: 1, offsetX: 0, offsetY: 0 };
        }
        // 返回当前显示参数（用于 pct2hybrid 转换）
        return {
            scale: _dW / _nW,  // 当前实际缩放比例
            offsetX: _dX,
            offsetY: _dY,
            imgW: _nW,
            imgH: _nH,
        };
    }

    // ===== 百分比坐标 ↔ canvas 像素坐标转换 =====
    // 多边形数据存储为百分比坐标（0-100），需要映射到 canvas 像素空间进行绘制和命中检测
    // pct2hybrid: 百分比 → canvas 内的像素位置（相对于 canvas 左上角）
    function pct2hybrid(pctx, pcty) {
        return [
            (pctx / 100) * _dW,
            (pcty / 100) * _dH
        ];
    }
    // hybrid2pct: canvas 内的像素位置（通过 getBoundingClientRect 得到，已相对 canvas 左上角） → 百分比
    function hybrid2pct(px, py) {
        return {
            x: px / _dW * 100,
            y: py / _dH * 100
        };
    }

    // ===== 像素空间命中检测（避免百分比阈值过大导致误命中） =====
    function pxVertexHybrid(cv, pctPts, thPx) {
        for (let i = 0; i < pctPts.length; i++) {
            const pxy = pct2hybrid(pctPts[i][0], pctPts[i][1]);
            if (Math.hypot(cv[0] - pxy[0], cv[1] - pxy[1]) < thPx) return i;
        }
        return -1;
    }
    function pxEdgeHybrid(cv, pctPts, thPx) {
        for (let i = 0, j = pctPts.length - 1; i < pctPts.length; j = i++) {
            const p1 = pct2hybrid(pctPts[i][0], pctPts[i][1]);
            const p2 = pct2hybrid(pctPts[j][0], pctPts[j][1]);
            if (ptSegDist(cv[0], cv[1], p1[0], p1[1], p2[0], p2[1]) < thPx) return true;
        }
        return false;
    }

    function drawAllPolygons() {
        ctx.clearRect(0, 0, _dW || polyCanvas.width, _dH || polyCanvas.height);
        getVisiblePolys().forEach(poly => {
            if (!poly.points || poly.points.length < 3) return;
            const sel = selectedPolygons.some(sp =>
                sp.source === 'annotator' &&
                sp.annotatorIdx === poly.annotatorIdx && sp.polyIdx === poly.polyIdx);
            const isEditing = _editMode && poly.annotatorIdx === _editAnnotatorIdx && poly.polyIdx === _editPolyIdx;

            ctx.beginPath();
            poly.points.forEach((pt, i) => {
                const xy = pct2hybrid(pt[0], pt[1]);
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
                ctx.strokeStyle = sel ? '#fff' : poly.color;
                ctx.lineWidth = sel ? 3 : 1.5;
            }
            ctx.stroke();
            ctx.setLineDash([]);

            // 编辑模式：绘制顶点手柄
            if (isEditing && _editPointsRef) {
                const srcPts = _editPointsRef;
                for (let i = 0; i < srcPts.length; i++) {
                    const xy = pct2hybrid(srcPts[i][0], srcPts[i][1]);
                    ctx.fillStyle = (i === _draggingVertex) ? '#ffeb3b' : '#fff';
                    ctx.strokeStyle = '#000';
                    ctx.lineWidth = 1.5;
                    ctx.beginPath();
                    ctx.arc(xy[0], xy[1], 5, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.stroke();
                }
            }

            if (poly.label && poly.points[0]) {
                ctx.fillStyle = poly.color;
                ctx.font = '9px sans-serif';
                const lxy = pct2hybrid(poly.points[0][0], poly.points[0][1]);
                ctx.fillText(poly.label, lxy[0], lxy[1] - 5);
            }
        });
    }

    function drawReviewPolygons() {
        rctx.clearRect(0, 0, _dW || reviewCanvas.width, _dH || reviewCanvas.height);
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
                const xy = pct2hybrid(pt[0], pt[1]);
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
                    const xy = pct2hybrid(pt[0], pt[1]);
                    rctx.fillStyle = (i === _draggingVertex) ? '#ffeb3b' : '#fff';
                    rctx.strokeStyle = '#000';
                    rctx.lineWidth = 1.5;
                    rctx.beginPath();
                    rctx.arc(xy[0], xy[1], 5, 0, Math.PI * 2);
                    rctx.fill();
                    rctx.stroke();
                });
            }
            if (poly.label && pts[0]) {
                const xy = pct2hybrid(pts[0][0], pts[0][1]);
                rctx.fillStyle = REVIEW_COLOR;
                rctx.font = 'bold 10px sans-serif';
                rctx.fillText(poly.label, xy[0], xy[1] - 5);
            }
        });
    }

    function drawMaskAndBBox(resp) {
        // Mask canvas
        const maskCvs = document.getElementById('user-maskCanvas');
        if (resp && resp.mask_url) {
            const mi = new Image();
            mi.onload = () => {
                maskCvs.width = _dW;
                maskCvs.height = _dH;
                const mctx = maskCvs.getContext('2d');
                mctx.clearRect(0, 0, maskCvs.width, maskCvs.height);
                mctx.globalAlpha = 0.35;
                mctx.drawImage(mi, 0, 0, _dW, _dH);
                mctx.globalAlpha = 1.0;
            };
            mi.src = resp.mask_url;
        }
        // BBox canvas — 仅在用户尚未做出"是/否"选择时显示
        const bboxCvs = document.getElementById('user-bboxCanvas');
        const bctx = bboxCvs.getContext('2d');
        bboxCvs.width = _dW;
        bboxCvs.height = _dH;
        bctx.clearRect(0, 0, bboxCvs.width, bboxCvs.height);
        if (reviewResult !== null) return;  // 已选择，不绘制 bbox
        const u = (resp && resp.unit) ? resp.unit : (unitData && unitData.unit);
        if (u && u.bbox && u.bbox[2] > 0 && _nW && _nH) {
            const sx = _dW / _nW;
            const sy = _dH / _nH;
            const [x, y, w, h] = u.bbox;
            bctx.strokeStyle = '#e94560';
            bctx.lineWidth = 2;
            bctx.strokeRect(x * sx, y * sy, w * sx, h * sy);
        }
    }

    // ===== Polygon hit testing =====
    // 返回百分比坐标（多边形数据存储格式）
    function canvasPointToImage(ev) {
        const rect = polyCanvas.getBoundingClientRect();
        return hybrid2pct(ev.clientX - rect.left, ev.clientY - rect.top);
    }

    function pointNearEdge(px, py, pts, th) {
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
            const d = ptSegDist(px, py, pts[i][0], pts[i][1], pts[j][0], pts[j][1]);
            if (d < th) return true;
        }
        return false;
    }

    function ptSegDist(px, py, x1, y1, x2, y2) {
        const dx = x2 - x1, dy = y2 - y1;
        const ls = dx * dx + dy * dy;
        if (ls === 0) return Math.hypot(px - x1, py - y1);
        let t = ((px - x1) * dx + (py - y1) * dy) / ls;
        t = Math.max(0, Math.min(1, t));
        return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
    }

    function pointNearVertex(px, py, pts, th) {
        for (let i = 0; i < pts.length; i++) {
            if (Math.hypot(px - pts[i][0], py - pts[i][1]) < th) return i;
        }
        return -1;
    }

    function pointInPolygon(px, py, pts) {
        let inside = false;
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
            if ((pts[i][1] > py) !== (pts[j][1] > py) &&
                px < (pts[j][0] - pts[i][0]) * (py - pts[i][1]) / (pts[j][1] - pts[i][1]) + pts[i][0]) {
                inside = !inside;
            }
        }
        return inside;
    }

    // ===== 点击选择多边形 =====
    polyCanvas.addEventListener('click', function(ev) {
        if (!isPhase2) return;
        if (_justDragged) { _justDragged = false; return; }
        if (_editMode) return;

        const rect = polyCanvas.getBoundingClientRect();
        const cv = [ev.clientX - rect.left, ev.clientY - rect.top];
        const pt = canvasPointToImage(ev);
        const polys = getVisiblePolys();
        let found = null;
        let foundSource = 'annotator';

        // 优先级：审核结果多边形优先 → 顶点 > 边 > 内部
        // 先搜审核结果（审核者多边形优先选中）
        if (visibleReviewResult) {
            for (let i = reviewPolygons.length - 1; i >= 0; i--) {
                const rp = reviewPolygons[i];
                if (!rp.points || rp.points.length < 3) continue;
                if (pxVertexHybrid(cv, rp.points, 12) >= 0) {
                    found = { reviewIdx: i, points: rp.points, label: rp.label || '', _selfDrawn: rp._selfDrawn };
                    foundSource = 'review'; break;
                }
            }
        }
        if (!found && visibleReviewResult) {
            for (let i = reviewPolygons.length - 1; i >= 0; i--) {
                const rp = reviewPolygons[i];
                if (!rp.points || rp.points.length < 3) continue;
                if (pxEdgeHybrid(cv, rp.points, 10)) {
                    found = { reviewIdx: i, points: rp.points, label: rp.label || '', _selfDrawn: rp._selfDrawn };
                    foundSource = 'review'; break;
                }
            }
        }
        // 再搜标注者多边形
        if (!found) {
            for (const poly of polys) {
                if (!poly.points || poly.points.length < 3) continue;
                if (pxVertexHybrid(cv, poly.points, 10) >= 0) { found = poly; foundSource = 'annotator'; break; }
            }
        }
        if (!found) {
            for (const poly of polys) {
                if (!poly.points || poly.points.length < 3) continue;
                if (pxEdgeHybrid(cv, poly.points, 8)) { found = poly; foundSource = 'annotator'; break; }
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
            const selItem = foundSource === 'annotator'
                ? { source: 'annotator', annotatorIdx: found.annotatorIdx, polyIdx: found.polyIdx,
                    points: found.points, label: found.label, color: found.color }
                : { source: 'review', reviewIdx: found.reviewIdx,
                    points: found.points, label: found.label, color: REVIEW_COLOR };

            const exIdx = selectedPolygons.findIndex(sp => {
                if (sp.source === 'annotator' && selItem.source === 'annotator')
                    return sp.annotatorIdx === selItem.annotatorIdx && sp.polyIdx === selItem.polyIdx;
                if (sp.source === 'review' && selItem.source === 'review')
                    return sp.reviewIdx === selItem.reviewIdx;
                return false;
            });

            if (isMulti) {
                exIdx >= 0 ? selectedPolygons.splice(exIdx, 1) : selectedPolygons.push(selItem);
            } else {
                selectedPolygons = (exIdx >= 0 && selectedPolygons.length === 1) ? [] : [selItem];
            }
            drawAllPolygons();
            drawReviewPolygons();
            updateHybridSelectionInfo();
        } else {
            selectedPolygons = [];
            drawAllPolygons();
            drawReviewPolygons();
            updateHybridSelectionInfo();
        }
    });

    // ===== 选中后更新底栏信息 =====
    function updateHybridSelectionInfo() {
        const infoEl = document.getElementById('review-selection-info');
        if (!selectedPolygons.length) {
            if (infoEl) infoEl.innerHTML = '';
            document.querySelectorAll('#poi-labelBtns .user-bigbtn').forEach(b =>
                b.classList.remove('active'));
            document.querySelectorAll('#poi-transBtns .user-bigbtn').forEach(b => {
                b.classList.toggle('on', reviewTransModes.includes(b.dataset.mode));
            });
            return;
        }

        const sel = selectedPolygons[0];
        let html = '';
        if (sel.source === 'annotator') {
            const ad = (unitData && unitData.unit && unitData.unit.annotator_data) || [];
            const ann = ad[sel.annotatorIdx];
            const poly = ann && ann.polygons ? ann.polygons[sel.polyIdx] : null;
            const label = poly ? (poly.label || '无标签') : '无标签';
            const transModes = ann ? (ann.transport_modes || []) : [];
            html = `<span style="color:${sel.color}">■</span> 标注者: ${ann ? ann.group_id : '?'}` +
                ` | 园区类型: <b>${label}</b>` +
                ` | 运输方式: <b>${transModes.join(', ') || '无'}</b>` +
                ` <span style="color:#888;font-size:9px">(只读)</span>`;
            document.querySelectorAll('#poi-labelBtns .user-bigbtn').forEach(b => {
                b.classList.toggle('active', b.dataset.label === label);
            });
            document.querySelectorAll('#poi-transBtns .user-bigbtn').forEach(b => {
                b.classList.toggle('on', transModes.includes(b.dataset.mode));
            });
        } else if (sel.source === 'review') {
            const rp = reviewPolygons[sel.reviewIdx];
            const label = rp ? (rp.label || '无标签') : '无标签';
            // 显示该多边形自身的运输方式（继承自原标注者），如无则显示全局 reviewTransModes
            const polyTransModes = rp && rp.transport_modes ? rp.transport_modes : reviewTransModes;
            html = `<span style="color:${REVIEW_COLOR}">■</span> 审核结果 #${sel.reviewIdx + 1}` +
                (rp && rp._adoptedFrom ? ` <span style="color:#888;font-size:9px">(采纳自标注者)</span>` : '') +
                ` | 园区类型: <b>${label}</b>` +
                ` | 运输方式: <b>${polyTransModes.join(', ') || '无'}</b>` +
                ` <span style="color:#4ecca3;font-size:9px">(可修改：点击下方按钮)</span>`;
            currentLabel = label;
            document.getElementById('poiToolbarActiveLabel').textContent = currentLabel || '未选择';
            document.querySelectorAll('#poi-labelBtns .user-bigbtn').forEach(b => {
                b.classList.toggle('active', b.dataset.label === label);
            });
            document.querySelectorAll('#poi-transBtns .user-bigbtn').forEach(b => {
                b.classList.toggle('on', polyTransModes.includes(b.dataset.mode));
            });
        }
        if (infoEl) infoEl.innerHTML = html;
    }

    // ===== 鼠标事件（平移 / 顶点编辑） =====
    polyCanvas.addEventListener('mousedown', function(e) {
        if (!isPhase2) return;
        // 右键平移
        if (e.button === 2) {
            if (_editMode) return;
            e.preventDefault();
            _reviewPanning = true;
            _reviewPanStart.x = e.clientX;
            _reviewPanStart.y = e.clientY;
            _reviewPanStart.panX = _panX;
            _reviewPanStart.panY = _panY;
            polyCanvas.style.cursor = 'grabbing';
            return;
        }
        if (e.button !== 0) return;

        const rect = polyCanvas.getBoundingClientRect();
        const cv = [e.clientX - rect.left, e.clientY - rect.top];
        const pt = canvasPointToImage(e);

        // 编辑模式：检测拖拽顶点（像素空间距离检测）
        if (_editMode && _editPointsRef) {
            const vi = pxVertexHybrid(cv, _editPointsRef, 12);
            if (vi >= 0) {
                _draggingVertex = vi;
                polyCanvas.style.cursor = 'grabbing';
                e.preventDefault();
                e.stopPropagation();
                return;
            }
            if (!pxEdgeHybrid(cv, _editPointsRef, 8) &&
                pxVertexHybrid(cv, _editPointsRef, 10) < 0 &&
                !pointInPolygon(pt.x, pt.y, _editPointsRef)) {
                exitHybridEditMode();
                return;
            }
            return;
        }

        // 非编辑模式：左键拖拽平移画布
        _reviewPanning = true;
        _reviewPanStart.x = e.clientX;
        _reviewPanStart.y = e.clientY;
        _reviewPanStart.panX = _panX;
        _reviewPanStart.panY = _panY;
        polyCanvas.style.cursor = 'grabbing';
        _justDragged = false;
    });

    window.addEventListener('mousemove', function(e) {
        // 新增绘制模式：持续显示预览（带橡皮筋线）
        if (_newDrawing && _newDrawPts.length > 0) {
            const pt = canvasPointToImage(e);
            const curXy = pct2hybrid(pt.x, pt.y);
            drawNewDrawingPreview(curXy[0], curXy[1]);
            return;
        }
        // 平移
        if (_reviewPanning) {
            _panX = _reviewPanStart.panX + (e.clientX - _reviewPanStart.x);
            _panY = _reviewPanStart.panY + (e.clientY - _reviewPanStart.y);
            syncCanvasSizes();
            drawAllPolygons();
            drawReviewPolygons();
            drawMaskAndBBox(unitData);
            return;
        }
        // 顶点拖拽（标注者多边形）
        if (_editMode && _draggingVertex >= 0 && _editPointsRef && _editAnnotatorIdx >= 0 && _editPolyIdx >= 0) {
            const pt = canvasPointToImage(e);
            _editPointsRef[_draggingVertex] = [pt.x, pt.y];
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
        if (_reviewPanning) {
            const dx = e.clientX - _reviewPanStart.x;
            const dy = e.clientY - _reviewPanStart.y;
            _justDragged = (Math.abs(dx) > 3 || Math.abs(dy) > 3);
            _reviewPanning = false;
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
            polyCanvas.style.cursor = 'crosshair';
            return;
        }
    });

    // ===== 双击编辑多边形顶点 =====
    polyCanvas.addEventListener('dblclick', function(ev) {
        if (!isPhase2 || _editMode || _newDrawing) return;
        const rect = polyCanvas.getBoundingClientRect();
        const cv = [ev.clientX - rect.left, ev.clientY - rect.top];
        const pt = canvasPointToImage(ev);

        // 1. 先检测审核结果多边形（优先级更高，因为在上层）
        let foundReviewIdx = -1;
        for (let i = 0; i < reviewPolygons.length; i++) {
            const poly = reviewPolygons[i];
            if (!poly.points || poly.points.length < 3) continue;
            if (pxVertexHybrid(cv, poly.points, 10) >= 0) { foundReviewIdx = i; break; }
        }
        if (foundReviewIdx < 0) {
            for (let i = 0; i < reviewPolygons.length; i++) {
                const poly = reviewPolygons[i];
                if (!poly.points || poly.points.length < 3) continue;
                if (pxEdgeHybrid(cv, poly.points, 8)) { foundReviewIdx = i; break; }
            }
        }
        if (foundReviewIdx >= 0) {
            _editMode = true;
            _editAnnotatorIdx = -1;
            _editPolyIdx = -1;
            _editReviewIdx = foundReviewIdx;
            _draggingVertex = -1;
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
            if (pxVertexHybrid(cv, poly.points, 10) >= 0) { found = poly; break; }
        }
        if (!found) {
            for (const poly of polys) {
                if (!poly.points || poly.points.length < 3) continue;
                if (pxEdgeHybrid(cv, poly.points, 8)) { found = poly; break; }
            }
        }
        if (!found) return;

        const ad = (unitData && unitData.unit && unitData.unit.annotator_data) || [];
        const annotator = ad[found.annotatorIdx];
        if (!annotator || !annotator.polygons || !annotator.polygons[found.polyIdx]) return;

        _editMode = true;
        _editAnnotatorIdx = found.annotatorIdx;
        _editPolyIdx = found.polyIdx;
        _editReviewIdx = -1;
        _draggingVertex = -1;
        _editPointsRef = annotator.polygons[found.polyIdx].points;
        document.getElementById('review-sidebar').style.opacity = '0.5';
        polyCanvas.style.cursor = 'crosshair';
        drawAllPolygons();
        toast('编辑模式：拖拽顶点修改多边形，点击外部退出');
    });

    function exitHybridEditMode() {
        _editMode = false;
        _editAnnotatorIdx = -1;
        _editPolyIdx = -1;
        _editReviewIdx = -1;
        _draggingVertex = -1;
        _editPointsRef = null;
        document.getElementById('review-sidebar').style.opacity = '1';
        polyCanvas.style.cursor = 'default';
        drawAllPolygons();
        drawReviewPolygons();
    }

    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape' && _editMode) {
            exitHybridEditMode();
        }
    });

    // ===== Phase UI =====
    function updatePhaseUI() {
        const phase1 = document.getElementById('review-phase1-col');
        const phase2 = document.getElementById('review-phase2-col');
        const trans = document.getElementById('review-trans-col');
        const toggleBtn = document.getElementById('user-toggleBtn');
        const toolbar = document.getElementById('review-toolbar');
        const sidebar = document.getElementById('review-sidebar');
        const cols = document.querySelector('.user-bb-cols');

        if (isPhase2) {
            if (phase1) phase1.style.display = 'none';
            if (phase2) phase2.style.display = '';
            if (trans) trans.style.display = '';
            if (toggleBtn) toggleBtn.style.display = '';
            if (toolbar) toolbar.style.display = '';
            if (sidebar) sidebar.style.display = '';
            if (cols) cols.className = 'user-bb-cols hybrid-phase2-layout';
        } else {
            if (phase1) phase1.style.display = '';
            if (phase2) phase2.style.display = 'none';
            if (trans) trans.style.display = 'none';
            if (toggleBtn) toggleBtn.style.display = 'none';
            if (toolbar) toolbar.style.display = 'none';
            if (sidebar) sidebar.style.display = 'none';
            if (cols) cols.className = 'user-bb-cols hybrid-phase1-layout';
        }

        // 更新按钮状态
        const btnYes = document.getElementById('user-btnYes');
        const btnNo = document.getElementById('user-btnNo');
        btnYes.classList.toggle('active', reviewResult === '是');
        btnNo.classList.toggle('active', reviewResult === '否');

        // 运输方式
        document.querySelectorAll('#poi-transBtns .user-bigbtn').forEach(btn => {
            btn.classList.toggle('on', reviewTransModes.includes(btn.dataset.mode));
        });

        // 标签
        document.querySelectorAll('#poi-labelBtns .user-bigbtn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.label === currentLabel);
        });
    }

    // ===== 按钮事件 =====
    document.getElementById('user-btnYes').addEventListener('click', () => {
        reviewResult = '是';
        isPhase2 = true;
        updatePhaseUI();
        drawMaskAndBBox(unitData);
        document.getElementById('user-polyCount').textContent = reviewPolygons.length;
    });

    document.getElementById('user-btnNo').addEventListener('click', () => {
        reviewResult = '否';
        isPhase2 = false;
        reviewPolygons = [];
        selectedPolygons = [];
        updatePhaseUI();
        drawReviewPolygons();
        drawMaskAndBBox(unitData);
        document.getElementById('user-polyCount').textContent = '0';
        document.getElementById('user-vStatus').textContent = '待审核';
    });

    document.getElementById('user-toggleBtn').addEventListener('click', () => {
        reviewResult = '否';
        isPhase2 = false;
        reviewPolygons = [];
        selectedPolygons = [];
        updatePhaseUI();
        drawReviewPolygons();
        drawMaskAndBBox(unitData);
        document.getElementById('user-polyCount').textContent = '0';
    });

    // 标签
    document.querySelectorAll('#poi-labelBtns .user-bigbtn').forEach(btn => {
        btn.addEventListener('click', () => {
            const newLabel = (currentLabel === btn.dataset.label) ? null : btn.dataset.label;
            currentLabel = newLabel;
            document.getElementById('poiToolbarActiveLabel').textContent = currentLabel || '未选择';
            updatePhaseUI();
            // 如果选中了审核结果多边形，同步更新其 label（仅被采纳的多边形可修改属性）
            if (selectedPolygons.length === 1 && selectedPolygons[0].source === 'review') {
                const rp = reviewPolygons[selectedPolygons[0].reviewIdx];
                if (rp && !rp._adoptedFrom) {
                    toast('只有被采纳的多边形可以修改属性');
                } else if (rp) {
                    rp.label = currentLabel || '';
                    selectedPolygons[0].label = currentLabel || '';
                    drawReviewPolygons();
                    updateHybridSelectionInfo();
                }
            }
        });
    });

    // 运输方式
    document.querySelectorAll('#poi-transBtns .user-bigbtn').forEach(btn => {
        btn.addEventListener('click', () => {
            const mode = btn.dataset.mode;
            // 更新全局运输方式
            const idx = reviewTransModes.indexOf(mode);
            idx >= 0 ? reviewTransModes.splice(idx, 1) : reviewTransModes.push(mode);
            updatePhaseUI();
            document.getElementById('user-vTrans').textContent = reviewTransModes.join(', ') || '-';
            // 如果选中了审核结果多边形，同步更新该多边形的 transport_modes（仅被采纳的多边形可修改属性）
            if (selectedPolygons.length === 1 && selectedPolygons[0].source === 'review') {
                const rp = reviewPolygons[selectedPolygons[0].reviewIdx];
                if (rp && !rp._adoptedFrom) {
                    toast('只有被采纳的多边形可以修改属性');
                } else if (rp) {
                    if (!rp.transport_modes) rp.transport_modes = [];
                    const pidx = rp.transport_modes.indexOf(mode);
                    pidx >= 0 ? rp.transport_modes.splice(pidx, 1) : rp.transport_modes.push(mode);
                    updateHybridSelectionInfo();
                }
            }
        });
    });

    // ===== Tool buttons =====
    document.getElementById('tool-select-all').addEventListener('click', () => {
        selectedPolygons = getVisiblePolys()
            .filter(p => p.points && p.points.length >= 3)
            .map(p => ({ source: 'annotator', annotatorIdx: p.annotatorIdx, polyIdx: p.polyIdx,
                points: p.points, label: p.label, color: p.color }));
        drawAllPolygons();
        updateHybridSelectionInfo();
    });
    document.getElementById('tool-deselect-all').addEventListener('click', () => {
        selectedPolygons = [];
        drawAllPolygons();
        updateHybridSelectionInfo();
    });

    // ===== 保存 =====
    async function doSaveHybrid() {
        if (!reviewResult) { toast('请先选择审核结果'); return false; }
        // 验证：选"是"时，每个审核多边形必须已分配园区类型和运输方式
        if (reviewResult === '是' && reviewPolygons.length > 0) {
            for (let i = 0; i < reviewPolygons.length; i++) {
                const rp = reviewPolygons[i];
                const label = rp.label || '';
                const trans = rp.transport_modes || [];
                if (!label) { toast(`第 ${i + 1} 个审核多边形尚未选择园区类型，请选中后点击园区类型按钮`); return false; }
                if (trans.length === 0) { toast(`第 ${i + 1} 个审核多边形尚未选择运输方式，请选中后点击运输方式按钮`); return false; }
            }
        }
        const unit = allUnits[currentUnitIdx];
        try {
            const payload = {
                review_result: reviewResult,
                review_polygons: reviewResult === '是' ? reviewPolygons : [],
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

    async function saveHybridAndNext() {
        const ok = await doSaveHybrid();
        if (ok && currentUnitIdx < allUnits.length - 1) {
            setTimeout(() => loadUnit(currentUnitIdx + 1), 300);
        }
    }

    document.getElementById('user-saveBtn').addEventListener('click', async () => {
        await doSaveHybrid();
    });

    // ===== 导航 =====
    document.getElementById('user-prevBtn').addEventListener('click', () => {
        if (currentUnitIdx > 0) loadUnit(currentUnitIdx - 1);
    });
    document.getElementById('user-nextBtn').addEventListener('click', () => {
        saveHybridAndNext();
    });
    document.getElementById('user-logoutBtn').addEventListener('click', async () => {
        try { await API.logout(); } catch (e) {}
        window.location.href = '/';
    });

    // ===== 采纳：将选中的标注者多边形变为审核结果（继承原属性） =====
    document.getElementById('tool-accept-result').addEventListener('click', () => {
        if (!isPhase2) { toast('请先选择"是"进入多边形审核阶段'); return; }
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
            updateHybridSelectionInfo();
            toast(`已采纳 ${added} 个多边形为审核结果`);
        }
    });

    // ===== 新增：审核者自行绘制多边形 =====
    let _newDrawing = false;
    let _newDrawPts = [];

    document.getElementById('tool-add-new').addEventListener('click', () => {
        if (!isPhase2) { toast('请先选择"是"进入多边形审核阶段'); return; }
        _newDrawing = true;
        _newDrawPts = [];
        selectedPolygons = [];
        drawAllPolygons();
        drawReviewPolygons();
        polyCanvas.style.cursor = 'crosshair';
        toast('点击画布添加顶点，双击闭合多边形');
    });

    // 在现有 mousedown 事件处理器中添加新绘制逻辑
    // 修改 polyCanvas mousedown 以支持新绘制模式（capture phase 优先拦截）
    polyCanvas.addEventListener('mousedown', function(e) {
        if (!_newDrawing) return;
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        const pt = canvasPointToImage(e);
        _newDrawPts.push([pt.x, pt.y]);
        // 实时绘制预览
        drawReviewPolygons();
        drawNewDrawingPreview();
    }, true);  // capture phase to run before existing handler

    polyCanvas.addEventListener('dblclick', function(e) {
        if (!_newDrawing || _newDrawPts.length < 3) return;
        e.preventDefault();
        e.stopPropagation();
        finishNewDrawing();
    }, true);

    function drawNewDrawingPreview(toX, toY) {
        if (!_newDrawing || _newDrawPts.length === 0) return;
        drawReviewPolygons();
        const pxy = _newDrawPts.map(p => pct2hybrid(p[0], p[1]));
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
        updateHybridSelectionInfo();
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
        if (!isPhase2) return;
        // 优先处理选中的审核结果多边形
        const selReview = selectedPolygons.filter(sp => sp.source === 'review');
        if (selReview.length > 0) {
            // 按索引从大到小排序，避免删除时索引偏移
            const indices = selReview.map(sp => sp.reviewIdx).sort((a, b) => b - a);
            indices.forEach(i => reviewPolygons.splice(i, 1));
            selectedPolygons = [];
            drawAllPolygons();
            drawReviewPolygons();
            document.getElementById('user-polyCount').textContent = reviewPolygons.length;
            updateHybridSelectionInfo();
            toast(`已取消采纳 ${indices.length} 个多边形`);
        } else {
            toast('请先选择审核结果多边形（红色多边形）');
        }
    });

    document.getElementById('poiDelPolyBtn').addEventListener('click', () => {
        if (_newDrawing) { cancelNewDrawing(); return; }
        document.getElementById('tool-unaccept').click();
    });
    document.getElementById('poiUndoBtn').addEventListener('click', () => {
        if (_newDrawing) { cancelNewDrawing(); return; }
        selectedPolygons = []; drawAllPolygons(); drawReviewPolygons();
    });

    // ===== 键盘 =====
    document.addEventListener('keydown', e => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
        switch (e.key.toLowerCase()) {
            case 'y': document.getElementById('user-btnYes').click(); break;
            case 'n':
                if (isPhase2) document.getElementById('user-toggleBtn').click();
                else document.getElementById('user-btnNo').click();
                break;
            case 's': if (!e.ctrlKey) { e.preventDefault(); document.getElementById('user-saveBtn').click(); } break;
            case 'enter': e.preventDefault();
                saveHybridAndNext(); break;
            case 'arrowleft': e.preventDefault();
                if (currentUnitIdx > 0) loadUnit(currentUnitIdx - 1); break;
            case 'arrowright': e.preventDefault();
                saveHybridAndNext(); break;
            case 'delete': document.getElementById('poiDelPolyBtn').click(); break;
            case 'escape': if (_newDrawing) { cancelNewDrawing(); } else { exitHybridEditMode(); } break;
            case '1': case '2': case '3': case '4':
            case '5': case '6': case '7': case '8':
                if (isPhase2) {
                    const b = document.querySelector(`#poi-labelBtns .user-bigbtn:nth-child(${e.key})`);
                    if (b) b.click();
                }
                break;
            case 'q': toggleHTrans('公路'); break;
            case 'w': toggleHTrans('铁路'); break;
            case 'e': toggleHTrans('水路'); break;
            case 'r': toggleHTrans('航空'); break;
        }
    });

    function toggleHTrans(mode) {
        const idx = reviewTransModes.indexOf(mode);
        idx >= 0 ? reviewTransModes.splice(idx, 1) : reviewTransModes.push(mode);
        updatePhaseUI();
        document.getElementById('user-vTrans').textContent = reviewTransModes.join(', ') || '-';
    }


    window.addEventListener('resize', () => {
        syncCanvasSizes();
        drawAllPolygons();
        drawReviewPolygons();
        drawMaskAndBBox(unitData);
    });

    // ===== 滚轮缩放 + 右键平移（参考 hybrid_main.js） =====
    const imgWrapEl = document.getElementById('user-imgWrap');
    const ZOOM_STEP = 1.12, ZOOM_MIN = 1.0, ZOOM_MAX = 8.0;

    imgWrapEl.addEventListener('wheel', function(e) {
        if (!_nW || !_nH) return;
        e.preventDefault();
        const wr = imgWrapEl.getBoundingClientRect();
        const cx = e.clientX - wr.left, cy = e.clientY - wr.top;
        const fx = (cx - _dX) / _dW, fy = (cy - _dY) / _dH;
        const newZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN,
            _zoom * (e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP)));
        if (Math.abs(newZoom - _zoom) < 0.001) return;
        const ndW = _fitW * newZoom, ndH = _fitH * newZoom;
        _panX = cx - fx * ndW - _fitX + (ndW - _fitW) / 2;
        _panY = cy - fy * ndH - _fitY + (ndH - _fitH) / 2;
        _zoom = newZoom;
        syncCanvasSizes();
        drawAllPolygons();
        drawReviewPolygons();
        drawMaskAndBBox(unitData);
    }, { passive: false });

    polyCanvas.addEventListener('contextmenu', function(e) {
        e.preventDefault();  // 阻止右键菜单
    });

    init();
})();
