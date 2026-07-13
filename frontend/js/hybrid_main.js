/**
 * hybrid_main.js - Hybrid 任务主控逻辑
 * Step 1: 判断图中是否有物流园区（是/否）
 * Step 2（选"是"后）: 多边形可编辑 + 园区类型标记 + 运输方式
 */
(async function() {
    function toast(msg) {
        var t = document.getElementById('user-toast');
        t.textContent = msg;
        t.classList.add('show');
        setTimeout(function() { t.classList.remove('show'); }, 2000);
    }

    function $(id) { return document.getElementById(id); }
    function setText(id, v) { var el = $(id); if (el) el.textContent = v; }

    // ===== 8 分类标签 =====
    var LABEL_TYPES = ['露天集装箱', '露天散货', '气液粮仓储罐', '批发市场', '立体现代物流园', '传统集约物流园', '小物流聚集地', '码头/车站/机场'];
    var LABEL_COLORS = {
        '露天集装箱': '#ef5350', '露天散货': '#ff9800', '气液粮仓储罐': '#42a5f5',
        '批发市场': '#26c6da', '立体现代物流园': '#f06292', '传统集约物流园': '#7e57c2',
        '小物流聚集地': '#66bb6a', '码头/车站/机场': '#ff7043',
    };

    // ===== 检查登录 =====
    var me;
    try { me = await API.currentUser(); } catch (e) { showLogin(); return; }
    if (!me || !me.logged_in) { showLogin(); return; }
    if (me.role === 'admin') { window.location.href = '/admin'; return; }
    $('user-username').textContent = me.username;
    $('user-role').textContent = me.role;

    // ===== 加载锁定 =====
    var _imgLoading = false;
    function showImgLoading() {
        _imgLoading = true;
        var ov = $('img-loading');
        if (ov) ov.classList.remove('hidden');
    }
    function hideImgLoading() {
        _imgLoading = false;
        var ov = $('img-loading');
        if (ov) ov.classList.add('hidden');
    }

    // ===== 状态 =====
    var curUnit = null, curIdx = 0, curTask = null, statusMap = {};
    var phase = 1;
    var hasPark = null;
    var transModes = ['公路'];
    var curLabel = null;
    var polygons = [], drawPts = [];
    var selectedPolyIdx = -1, isDrawing = false;
    var draggingPoint = null, wasDragging = false;
    var nW, nH, dW, dH, dX, dY;
    var ctx = null, mousePos = { x: 0, y: 0 };
    var _prefetchAbort = null;  // 预加载取消控制器

    // ===== 缩放与平移 =====
    var _zoom = 1.0, _panX = 0, _panY = 0;
    var _panning = false, _panStart = { x: 0, y: 0, panX: 0, panY: 0 };
    var _overlayCache = null;  // Phase 1 高亮数据缓存（缩放/平移时重绘）

    // ===== 加载任务 =====
    var tasks = [];
    try { tasks = await API.userTasks(); } catch (e) {
        toast('加载任务失败: ' + e.message); return;
    }
    var _prefetchedDetail = null;  // 并行预取的 unit 详情缓存
    var hybridTasks = tasks.filter(function(t) { return t.task_type === 'hybrid'; });
    if (hybridTasks.length === 0 && tasks.length > 0) {
        var ft = tasks[0];
        window.location.href = ft.task_type === 'poi' ? '/poi' : '/';
        return;
    }
    if (tasks.length === 0) {
        $('user-taskHeader').textContent = '未分配任务';
        $('user-loading').classList.add('hide'); return;
    }
    curTask = hybridTasks.length > 0 ? hybridTasks[0] : tasks[0];
    $('user-taskHeader').textContent = (curTask.task_name || curTask.task_id) + ' · 组 ' + curTask.group_id + ' [Hybrid]';

    try { statusMap = (await API.unitStatus(curTask.task_id, curTask.group_id)) || {}; }
    catch (e) { statusMap = {}; }

    // ===== 画布尺寸（含缩放和平移） =====
    function _fitRect() {
        var wrap = $('user-imgWrap');
        var pw = wrap.clientWidth, ph = wrap.clientHeight;
        var s = Math.min(pw / nW, ph / nH);
        var fitW = nW * s, fitH = nH * s;
        return { w: fitW, h: fitH, x: (pw - fitW) / 2, y: (ph - fitH) / 2, s: s };
    }

    function calcRect() {
        if (!nW || !nH) return;
        var fit = _fitRect();
        dW = Math.round(fit.w * _zoom);
        dH = Math.round(fit.h * _zoom);
        // 缩放以 fit 中心为锚点，叠加平移偏移
        dX = Math.round(fit.x + _panX - (dW - fit.w) / 2);
        dY = Math.round(fit.y + _panY - (dH - fit.h) / 2);

        var img = $('user-mainImg');
        img.style.position = 'absolute'; img.style.left = dX + 'px'; img.style.top = dY + 'px';
        img.style.width = dW + 'px'; img.style.height = dH + 'px';
        img.style.maxWidth = 'none'; img.style.maxHeight = 'none';

        ['user-maskCanvas', 'user-bboxCanvas', 'polyCanvas'].forEach(function(cid) {
            var c = $(cid);
            if (!c) return;
            c.style.left = dX + 'px'; c.style.top = dY + 'px';
            c.style.width = dW + 'px'; c.style.height = dH + 'px';
            c.width = dW; c.height = dH;
        });
        ctx = $('polyCanvas').getContext('2d');
    }

    function resetZoom() { _zoom = 1.0; _panX = 0; _panY = 0; }

    function _reapplyOverlay() {
        if (_overlayCache) {
            renderMaskOverlay(_overlayCache.mask_url, _overlayCache.bbox, _overlayCache.poly_px);
        }
    }

    function px2pct(px, py) { return [(px / dW) * 100, (py / dH) * 100]; }
    function pct2px(px, py) { return [px * dW / 100, py * dH / 100]; }

    function getPolyColor(label) { return label ? (LABEL_COLORS[label] || '#ffffff') : '#ffffff'; }

    // ===== 渲染多边形（仅 Phase 2 用户绘制的多边形） =====
    function drawAll() {
        if (!ctx || !dW || !dH) return;
        ctx.clearRect(0, 0, dW, dH);

        // Phase 1：不渲染任何多边形，mask+bbox 由 renderMaskOverlay 负责
        if (phase === 1) {
            setText('user-polyCount', 0);
            $('poiToolbarCount').textContent = '0 个框';
            return;
        }

        // Phase 2：渲染用户绘制的多边形
        polygons.forEach(function(p, i) {
            var c = getPolyColor(p.label);
            var isSel = (i === selectedPolyIdx);
            // Phase 2：带颜色
            ctx.beginPath();
            p.points.forEach(function(pt, j) {
                var xy = pct2px(pt[0], pt[1]);
                j === 0 ? ctx.moveTo(xy[0], xy[1]) : ctx.lineTo(xy[0], xy[1]);
            });
            ctx.closePath();
            var strokeColor = isSel ? c : (p.label ? c : '#aaaaaa');
            ctx.strokeStyle = strokeColor;
            ctx.lineWidth = isSel ? 3 : 2;
            ctx.stroke();
            ctx.fillStyle = isSel ? (c + '40') : '#ffffff15';
            ctx.fill();

            var vertexColor = p.label ? c : '#aaaaaa';
            p.points.forEach(function(pt) {
                var xy = pct2px(pt[0], pt[1]);
                ctx.beginPath();
                ctx.arc(xy[0], xy[1], isSel ? 5 : 3, 0, Math.PI * 2);
                ctx.fillStyle = isSel ? '#fff' : vertexColor;
                ctx.fill();
                ctx.strokeStyle = vertexColor; ctx.lineWidth = 1; ctx.stroke();
            });

            if (p.points.length) {
                var xy = pct2px(p.points[0][0], p.points[0][1]);
                var labelText = p.label ? (i + 1) + '. ' + p.label : (i + 1) + '. 未设定';
                ctx.fillStyle = p.label ? c : '#aaaaaa';
                ctx.font = 'bold 10px sans-serif';
                ctx.fillText(labelText, xy[0], xy[1] - 8);
            }
        });

        // 正在绘制中
        if (isDrawing && drawPts.length > 0) {
            var c = curLabel ? (LABEL_COLORS[curLabel] || '#ffffff') : '#ffffff';
            ctx.beginPath();
            drawPts.forEach(function(p, i) {
                var xy = pct2px(p.x, p.y);
                i === 0 ? ctx.moveTo(xy[0], xy[1]) : ctx.lineTo(xy[0], xy[1]);
            });
            if (drawPts.length > 0) {
                var mxy = pct2px(mousePos.x, mousePos.y);
                ctx.lineTo(mxy[0], mxy[1]);
            }
            ctx.strokeStyle = c; ctx.lineWidth = 2;
            ctx.setLineDash([5, 3]); ctx.stroke(); ctx.setLineDash([]);

            // 渲染已点击的顶点圆点
            var PR = 4;
            drawPts.forEach(function(p, i) {
                var xy = pct2px(p.x, p.y);
                // 外层光晕
                ctx.beginPath(); ctx.arc(xy[0], xy[1], PR + 2, 0, Math.PI * 2);
                ctx.fillStyle = c + '60'; ctx.fill();
                // 内层实心
                ctx.beginPath(); ctx.arc(xy[0], xy[1], PR, 0, Math.PI * 2);
                ctx.fillStyle = (i === 0) ? '#fff' : c; ctx.fill();
                ctx.strokeStyle = c; ctx.lineWidth = 1; ctx.stroke();
                // 序号
                ctx.fillStyle = '#000';
                ctx.font = 'bold 8px sans-serif';
                ctx.fillText(i + 1, xy[0] + 6, xy[1] - 4);
            });

            // 3 个点以上提示"双击闭合"
            if (drawPts.length >= 3) {
                var fxy = pct2px(drawPts[0].x, drawPts[0].y);
                ctx.beginPath(); ctx.arc(fxy[0], fxy[1], PR + 6, 0, Math.PI * 2);
                ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
                ctx.setLineDash([2, 2]); ctx.stroke(); ctx.setLineDash([]);
                ctx.fillStyle = '#fff'; ctx.font = 'bold 9px sans-serif';
                ctx.fillText('双击闭合', fxy[0] + 10, fxy[1] - 8);
            }
        }

        setText('user-polyCount', polygons.length);
        $('poiToolbarCount').textContent = polygons.length + ' 个框';
    }

    // ===== Mask 高亮 / 多边形 overlay + Bbox 渲染（Phase 1 专用） =====
    var _maskImgObj = null;  // 缓存已加载的 mask Image 对象
    var _polyPx = null;      // 缓存多边形像素坐标（shp 模式）

    function renderMaskOverlay(maskUrl, bbox, polyPx) {
        var maskC = $('user-maskCanvas');
        var bboxC = $('user-bboxCanvas');
        if (!maskC || !bboxC || !dW || !dH) return;

        var mc = maskC.getContext('2d');
        mc.clearRect(0, 0, maskC.width, maskC.height);
        var bc = bboxC.getContext('2d');
        bc.clearRect(0, 0, bboxC.width, bboxC.height);

        // ═══ 判断渲染模式 ═══
        var useShp = polyPx && Array.isArray(polyPx) && polyPx.length >= 3;
        _polyPx = useShp ? polyPx : null;

        if (useShp) {
            // ===== shp 模式：暗色覆盖 + 多边形镂空聚光灯 =====
            maskC.style.display = '';

            // 缩放：多边形像素坐标 → canvas 显示坐标
            var px = dW / nW;
            var py = dH / nH;

            // 1. 全屏变暗
            mc.fillStyle = 'rgba(0, 0, 0, 0.45)';
            mc.fillRect(0, 0, dW, dH);

            // 2. 多边形内清除暗色，露出原图亮度
            mc.save();
            mc.beginPath();
            polyPx.forEach(function(pt, i) {
                i === 0 ? mc.moveTo(pt[0] * px, pt[1] * py) : mc.lineTo(pt[0] * px, pt[1] * py);
            });
            mc.closePath();
            mc.clip();
            mc.clearRect(0, 0, dW, dH);

            // 3. 红色轮廓线
            mc.strokeStyle = 'rgba(233, 69, 96, 0.6)';
            mc.lineWidth = 2;
            mc.stroke();
            mc.restore();

        } else if (maskUrl) {
            // ===== mask 模式：半透明 mask 叠加 =====
            maskC.style.display = '';
            if (_maskImgObj && _maskImgObj._src === maskUrl && _maskImgObj.complete) {
                mc.globalAlpha = 0.35;
                mc.drawImage(_maskImgObj, 0, 0, dW, dH);
                mc.globalAlpha = 1.0;
            } else {
                var img = new Image();
                img.crossOrigin = 'anonymous';
                img._src = maskUrl;
                img.onload = function() {
                    _maskImgObj = img;
                    if (maskC.width === dW && maskC.height === dH) {
                        mc.clearRect(0, 0, maskC.width, maskC.height);
                        mc.globalAlpha = 0.35;
                        mc.drawImage(img, 0, 0, dW, dH);
                        mc.globalAlpha = 1.0;
                    }
                };
                img.src = maskUrl;
            }
        } else {
            maskC.style.display = 'none';
        }

        // ═══ 红色 bbox（两种模式通用） ═══
        bboxC.style.display = '';
        if (bbox && bbox.length === 4 && nW && nH) {
            var sx = dW / nW;
            var sy = dH / nH;
            var [bx, by, bw, bh] = bbox;
            bc.strokeStyle = '#e94560';
            bc.lineWidth = 2;
            bc.strokeRect(bx * sx, by * sy, bw * sx, bh * sy);
        }
        _overlayCache = { mask_url: maskUrl, bbox: bbox, poly_px: polyPx };
    }

    function clearMaskOverlay() {
        _maskImgObj = null;
        _polyPx = null;
        ['user-maskCanvas', 'user-bboxCanvas'].forEach(function(cid) {
            var c = $(cid);
            if (!c) return;
            var cx = c.getContext('2d');
            cx.clearRect(0, 0, c.width, c.height);
            c.style.display = 'none';
        });
    }
    function findPointAt(px, py, threshold) {
        for (var i = polygons.length - 1; i >= 0; i--) {
            var p = polygons[i];
            for (var j = 0; j < p.points.length; j++) {
                var pt = p.points[j];
                if (Math.sqrt((px - pt[0]) * (px - pt[0]) + (py - pt[1]) * (py - pt[1])) <= threshold)
                    return { type: 'point', polyIdx: i, pointIdx: j };
            }
        }
        return null;
    }

    function findPolyAt(px, py) {
        for (var i = polygons.length - 1; i >= 0; i--) {
            var p = polygons[i];
            if (p.points.length >= 3 && pointInPolygon(px, py, p.points)) return i;
        }
        return -1;
    }

    function pointInPolygon(x, y, poly) {
        var inside = false;
        for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
            var xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
            if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
        }
        return inside;
    }

    function finishPoly() {
        if (drawPts.length < 3) { isDrawing = false; drawPts = []; drawAll(); return; }
        polygons.push({
            label: curLabel || null,
            points: drawPts.map(function(p) { return [+p.x.toFixed(2), +p.y.toFixed(2)]; })
        });
        drawPts = []; isDrawing = false;
        selectedPolyIdx = polygons.length - 1;
        drawAll();
        toast('框已添加 (' + polygons.length + '个)');
    }

    // ===== 标签 & 运输方式 =====
    function selectLabel(label) {
        if (phase === 1) return;
        if (selectedPolyIdx >= 0 && polygons[selectedPolyIdx]) {
            var p = polygons[selectedPolyIdx];
            var old = p.label;
            if (old !== label) {
                p.label = label; curLabel = label;
                updateLabelBtns();
                $('poiToolbarActiveLabel').textContent = label;
                drawAll();
                toast('框 ' + (selectedPolyIdx + 1) + ': ' + (old || '未设定') + ' → ' + label);
            }
            return;
        }
        curLabel = label;
        updateLabelBtns();
        $('poiToolbarActiveLabel').textContent = label;
    }

    function updateLabelBtns() {
        document.querySelectorAll('#poi-labelBtns .big-type').forEach(function(btn) {
            btn.classList.toggle('active', btn.dataset.label === curLabel);
        });
    }

    function toggleTransMode(mode) {
        if (phase === 1) return;
        var idx = transModes.indexOf(mode);
        if (idx >= 0) transModes.splice(idx, 1);
        else transModes.push(mode);
        highlightTransBtns();
    }

    function highlightTransBtns() {
        document.querySelectorAll('#poi-transBtns .big-trans').forEach(function(btn) {
            btn.classList.toggle('on', transModes.indexOf(btn.dataset.mode) >= 0);
        });
    }

    function resetAnnotations() {
        polygons = []; drawPts = [];
        isDrawing = false; selectedPolyIdx = -1;
        draggingPoint = null; wasDragging = false;
        transModes = ['公路']; curLabel = null;
        hasPark = null; phase = 1;
        setPhaseUI(1);
        highlightTransBtns(); updateLabelBtns();
        $('poiToolbarActiveLabel').textContent = '未选择';
        clearResultHighlight();
        clearMaskOverlay();
        drawAll();
    }

    function setHint(msg) { $('poiToolbarHint').textContent = msg; }

    function setPhaseUI(p) {
        phase = p;
        $('hybrid-phase1-col').style.display = (p === 1) ? '' : 'none';
        $('hybrid-phase2-col').style.display = (p === 1) ? 'none' : '';
        $('hybrid-trans-col').style.display = (p === 1) ? 'none' : '';
        var cols = document.querySelector('.user-bb-cols');
        cols.className = (p === 1) ? 'user-bb-cols hybrid-phase1-layout' : 'user-bb-cols hybrid-phase2-layout';
        if (p === 1) {
            $('polyCanvas').style.pointerEvents = 'none';
            $('polyCanvas').style.display = '';
            setHint('请判断图中是否有物流园区');
        } else {
            $('polyCanvas').style.pointerEvents = 'auto';
            $('polyCanvas').style.display = '';
            // Phase 2：清除 mask/bbox 高亮效果
            clearMaskOverlay();
            setHint('点击选中多边形 · 拖动顶点调整 · 双击画布添加新多边形 · 按 N 改为否');
        }
    }

    // 已标注"否"的完成态 UI：隐藏是/否按钮，仅展示 mask+bbox
    function setDonePhaseUI() {
        phase = 1;
        $('hybrid-phase1-col').style.display = 'none';
        $('hybrid-phase2-col').style.display = 'none';
        $('hybrid-trans-col').style.display = 'none';
        var cols = document.querySelector('.user-bb-cols');
        cols.className = 'user-bb-cols hybrid-phase1-layout';
        $('polyCanvas').style.pointerEvents = 'none';
        $('polyCanvas').style.display = '';
        setHint('已标注为"否"，点击"改为是"按钮或按 Y 重新标注');
    }

    function clearResultHighlight() {
        document.querySelectorAll('.user-bigbtn[data-result]').forEach(function(b) { b.classList.remove('active'); });
    }

    // ===== 画布事件（含缩放/平移） =====
    function attachCanvasEvents() {
        var canvas = $('polyCanvas');
        var wrap = $('user-imgWrap');
        var ZOOM_STEP = 1.12, ZOOM_MIN = 1.0, ZOOM_MAX = 8.0;

        // ── 滚轮缩放（鼠标位置为中心缩放） ──
        wrap.addEventListener('wheel', function(e) {
            if (!curUnit || !nW || !nH) return;
            e.preventDefault();
            var fit = _fitRect();
            var wr = wrap.getBoundingClientRect();
            var cx = e.clientX - wr.left, cy = e.clientY - wr.top;
            var fx = (cx - dX) / dW, fy = (cy - dY) / dH;
            var newZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN,
                _zoom * (e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP)));
            if (Math.abs(newZoom - _zoom) < 0.001) return;
            var ndW = fit.w * newZoom, ndH = fit.h * newZoom;
            _panX = cx - fx * ndW - fit.x + (ndW - fit.w) / 2;
            _panY = cy - fy * ndH - fit.y + (ndH - fit.h) / 2;
            _zoom = newZoom;
            calcRect();
            if (phase === 1) _reapplyOverlay();
            drawAll();
        }, { passive: false });

        // ── 右键拖拽平移 ──
        canvas.addEventListener('mousedown', function(e) {
            if (!curUnit) return;
            if (e.button === 2) {
                // 正在绘制时右键留给 contextmenu 取消绘制
                if (isDrawing) return;
                e.preventDefault();
                _panning = true;
                _panStart.x = e.clientX; _panStart.y = e.clientY;
                _panStart.panX = _panX; _panStart.panY = _panY;
                this.style.cursor = 'grabbing';
                return;
            }
            // 左键：顶点拖动（仅 Phase 2）
            if (isDrawing || phase === 1) return;
            var rect = this.getBoundingClientRect();
            var pct = px2pct(e.clientX - rect.left, e.clientY - rect.top);
            var ptHit = findPointAt(pct[0], pct[1], 1.5);
            if (ptHit && ptHit.polyIdx === selectedPolyIdx && selectedPolyIdx >= 0) {
                draggingPoint = { polyIdx: ptHit.polyIdx, pointIdx: ptHit.pointIdx };
                wasDragging = false;
                e.stopPropagation();
            }
        });

        canvas.addEventListener('mousemove', function(e) {
            if (!curUnit) return;
            // 平移中
            if (_panning) {
                _panX = _panStart.panX + (e.clientX - _panStart.x);
                _panY = _panStart.panY + (e.clientY - _panStart.y);
                calcRect();
                if (phase === 1) _reapplyOverlay();
                drawAll();
                return;
            }
            var rect = this.getBoundingClientRect();
            var pct = px2pct(e.clientX - rect.left, e.clientY - rect.top);
            mousePos = pct;
            if (draggingPoint) {
                wasDragging = true;
                polygons[draggingPoint.polyIdx].points[draggingPoint.pointIdx] =
                    [+pct[0].toFixed(2), +pct[1].toFixed(2)];
                this.style.cursor = 'grabbing';
                drawAll(); return;
            }
            if (isDrawing) { drawAll(); return; }
            if (phase === 1) { this.style.cursor = 'default'; return; }
            var ptHit = findPointAt(pct[0], pct[1], 1.5);
            this.style.cursor = (ptHit && ptHit.polyIdx === selectedPolyIdx && selectedPolyIdx >= 0) ? 'grab' : 'crosshair';
        });

        document.addEventListener('mouseup', function() {
            if (draggingPoint) { draggingPoint = null; var cv = $('polyCanvas'); if (cv) cv.style.cursor = 'crosshair'; }
            if (_panning) { _panning = false; var cv = $('polyCanvas'); if (cv) cv.style.cursor = 'crosshair'; }
        });

        canvas.addEventListener('click', function(e) {
            if (!curUnit || phase === 1) return;
            if (wasDragging) { wasDragging = false; return; }
            var rect = this.getBoundingClientRect();
            var pct = px2pct(e.clientX - rect.left, e.clientY - rect.top);
            var ptHit = findPointAt(pct[0], pct[1], 1.5);
            if (ptHit) return;
            var polyHit = findPolyAt(pct[0], pct[1]);
            if (polyHit >= 0) {
                selectedPolyIdx = polyHit; isDrawing = false; drawPts = [];
                drawAll();
                var pLabel = polygons[polyHit].label;
                toast('选中框 ' + (polyHit + 1) + ': ' + (pLabel || '未设定类型'));
                return;
            }
            selectedPolyIdx = -1;
            if (!isDrawing) {
                isDrawing = true;
                drawPts = [{ x: pct[0], y: pct[1] }];
                setHint('继续点击添加点 · 双击闭合 · 右键取消');
            } else {
                drawPts.push({ x: pct[0], y: pct[1] });
            }
            drawAll();
        });

        canvas.addEventListener('dblclick', function(e) {
            if (!isDrawing || drawPts.length < 3 || phase === 1) return;
            e.preventDefault();
            // 双击时 click 先触发加了一个点，这里去掉那个多余点
            drawPts.pop();
            finishPoly();
        });

        canvas.addEventListener('contextmenu', function(e) {
            e.preventDefault();
            // 如果是平移结束后的右键，忽略（已在 mouseup 清理）
            if (isDrawing) { isDrawing = false; drawPts = []; drawAll(); setHint('点击画布添加顶点 · 双击闭合 · 右键取消'); }
        });

        window.addEventListener('resize', function() { if (nW && nH) { resetZoom(); calcRect(); drawAll(); } });
    }

    // ===== 左侧 unit 列表 =====
    function renderUnitList() {
        var list = $('user-unitList');
        list.innerHTML = '';
        var units = curTask.units || [];
        if (units.length === 0) {
            list.innerHTML = '<div style="padding:20px 10px;font-size:10px;color:#666;text-align:center">本组无标注任务</div>';
            return;
        }
        units.forEach(function(u, idx) {
            var s = statusMap[String(u.id)] || null;
            var el = document.createElement('div');
            var cls = 'user-unit-item';
            if (s && s.done) cls += ' status-done';
            el.className = cls;
            el.dataset.unitId = u.id;
            var title = shortFileName(u.image || '');
            var short = title.length > 20 ? title.substring(0, 20) + '...' : title;
            var statusText = '';
            if (s && s.done) {
                statusText = s.has_park === false ? '✓ 否' :
                    (s.poi_labels && s.poi_labels.length > 0 ? '✓ ' + s.poi_labels.join(',') : '✓ 是');
            }
            el.innerHTML =
                '<div class="user-unit-title">#' + u.id + ' · ' + short + '</div>' +
                (u.lat != null ? '<div class="user-unit-meta">' + u.lat + ', ' + u.lng + '</div>' : '') +
                (statusText ? '<div class="user-unit-result">' + statusText + '</div>' : '');
            el.addEventListener('click', function() { selectUnit(u, idx); });
            list.appendChild(el);
        });
    }

    function highlightCurrent(unitId) {
        document.querySelectorAll('.user-unit-item').forEach(function(el) {
            el.classList.remove('status-current');
            if (parseInt(el.dataset.unitId, 10) === unitId) el.classList.add('status-current');
        });
    }

    // ===== 选择 unit =====
    async function selectUnit(u, idx) {
        if (_imgLoading) return;  // 防重复点击
        resetZoom();  // 切换 unit 时恢复默认缩放
        showImgLoading();

        curUnit = u; curIdx = idx;
        highlightCurrent(u.id);
        setText('user-counter', (idx + 1) + '/' + curTask.units.length);
        setText('user-tname', shortFileName(u.image));
        setText('user-vCoord', (u.lat != null) ? u.lat + ', ' + u.lng : '-');

        try {
            // 使用并行预取的详情（如果有），否则发起 API 请求
            var detail = (_prefetchedDetail && _prefetchedDetail._unitId === u.id)
                ? _prefetchedDetail : await API.getUnit(curTask.task_id, curTask.group_id, u.id);
            _prefetchedDetail = null;  // 用完清除
            var imgEl = $('user-mainImg');
            imgEl.onload = function() {
                nW = this.naturalWidth; nH = this.naturalHeight;
                calcRect();
                hideImgLoading();     // 图片解码完立即显示，mask 叠加层同步渲染很快
                prefetchNextUnit(idx);
                // Phase 1：渲染高亮区域（mask 或 shp 多边形 overlay）
                if (phase === 1) {
                    renderMaskOverlay(detail.mask_url, u.bbox, detail.polygon_pixels);
                }
                drawAll();
            };
            imgEl.onerror = function() {
                hideImgLoading();
                toast('图片加载失败');
            };
            imgEl.src = detail.image_url;

            resetAnnotations();

            // 加载已有标注
            if (detail.existing_annotation) {
                var ann = detail.existing_annotation;
                hasPark = ann.has_park;
                if (ann.has_park === false) {
                    // 已标注为"否"：隐藏是/否按钮，仅展示 mask+bbox，按 Y 可改为"是"
                    setText('user-vStatus', '已完成: 否');
                    statusMap[String(u.id)] = { done: true, has_park: false };
                    setDonePhaseUI();
                } else if (ann.has_park === true) {
                    // 之前标注为"是"：进入 Phase 2，恢复用户绘制的多边形
                    phase = 2;
                    setPhaseUI(2);
                    setText('user-vStatus', '已完成: 是');
                    if (ann.polygons && Array.isArray(ann.polygons)) {
                        polygons = ann.polygons;
                        if (polygons.length > 0) {
                            var lastLabel = polygons[polygons.length - 1].label;
                            if (lastLabel) curLabel = lastLabel;
                        }
                    }
                    if (ann.transport_modes && Array.isArray(ann.transport_modes) && ann.transport_modes.length > 0) {
                        transModes = ann.transport_modes.slice();
                    } else {
                        transModes = ['公路'];
                    }
                    highlightTransBtns();
                    updateLabelBtns();
                    $('poiToolbarActiveLabel').textContent = curLabel || '未选择';
                    statusMap[String(u.id)] = {
                        done: true, has_park: true,
                        poi_labels: ann.poi_labels,
                        transport_modes: ann.transport_modes ? ann.transport_modes.slice() : [],
                        polygon_count: ann.polygons ? ann.polygons.length : 0,
                    };
                }
            } else {
                // 全新标注：Phase 1，只展示 mask+bbox，不预填充 AI 多边形
                // polygons 保持空数组，等用户点击"是"后手动绘制
            }

            setText('user-vName', shortFileName(u.image));
            setText('user-vStatus', '待标注');
            var s = statusMap[String(u.id)];
            var polyN = (s && s.polygon_count != null) ? s.polygon_count : polygons.length;
            setText('user-polyCount', polyN);
            $('poiToolbarCount').textContent = polyN + ' 个框';
            setText('user-vTrans', s && s.transport_modes && s.transport_modes.length > 0
                ? s.transport_modes.join(', ') : (transModes.length > 0 ? transModes.join(', ') : '-'));

            if (imgEl.complete && imgEl.naturalWidth) {
                nW = imgEl.naturalWidth; nH = imgEl.naturalHeight;
                calcRect();
                hideImgLoading();
                prefetchNextUnit(idx);
                // 图片已加载完成：Phase 1 展示高亮区域
                if (phase === 1) {
                    renderMaskOverlay(detail.mask_url, u.bbox, detail.polygon_pixels);
                }
                drawAll();
            }

            if (u.lat != null && u.lng != null) {
                UserMap.init({ lng: u.lng, lat: u.lat, name: shortFileName(u.image) });
            } else {
                UserMap.init({ lng: 116.397428, lat: 39.90923, name: '' });
            }
        } catch (e) {
            hideImgLoading();
            toast('加载 unit 失败: ' + e.message);
        }
        renderUnitList();
        updateToggleBtn();
    }

    // ===== 是/否 处理 =====
    function onYes() {
        if (!curUnit || phase === 2) return;
        hasPark = true;
        phase = 2;
        // 清除 AI 多边形和 mask 高亮，用户从头绘制
        polygons = [];
        drawPts = [];
        isDrawing = false;
        selectedPolyIdx = -1;
        setPhaseUI(2);
        drawAll();
        updateToggleBtn();
        toast('请手动用多边形框选出物流园区位置');
    }

    async function onNo() {
        if (!curUnit || _imgLoading) return;
        hasPark = false;
        // 立即显示加载遮罩（直接操作 DOM，不设 _imgLoading 避免阻塞 selectUnit）
        var ov = $('img-loading');
        if (ov) ov.classList.remove('hidden');

        // 本地查找下一个未完成的 unit（无网络开销）
        var nextUnit = null, nextIdx = -1;
        for (var i = curIdx + 1; i < curTask.units.length; i++) {
            var st = statusMap[String(curTask.units[i].id)];
            if (!st || !st.done) { nextUnit = curTask.units[i]; nextIdx = i; break; }
        }

        try {
            // 并行发起：保存 + 下一个 unit 详情（节省一次网络往返）
            var savePromise = API.submitUnit(curTask.task_id, curTask.group_id, curUnit.id, {
                has_park: false, result: '否',
                polygons: [], transport_modes: [], comment: ''
            });
            var detailPromise = nextUnit
                ? API.getUnit(curTask.task_id, curTask.group_id, nextUnit.id)
                : Promise.resolve(null);

            var results = await Promise.all([savePromise, detailPromise]);
            var resp = results[0];
            _prefetchedDetail = results[1];
            if (_prefetchedDetail) _prefetchedDetail._unitId = nextUnit.id;

            if (resp && resp.ok) {
                statusMap[String(curUnit.id)] = { done: true, has_park: false, updated_at: new Date().toISOString() };
                renderUnitList();
                highlightCurrent(curUnit.id);
                setText('user-vStatus', '已完成: 否');
                toast('已保存: 否');
                updateToggleBtn();
                if (nextUnit) {
                    await selectUnit(nextUnit, nextIdx);
                } else {
                    if (ov) ov.classList.add('hidden');
                    renderUnitList();
                    highlightCurrent(curUnit ? curUnit.id : -1);
                }
            } else {
                _prefetchedDetail = null;
                if (ov) ov.classList.add('hidden');
            }
        } catch (e) {
            _prefetchedDetail = null;
            if (ov) ov.classList.add('hidden');
            toast('保存失败: ' + e.message);
        }
    }

    // ===== 切换是/否 =====
    async function onToggleHasPark() {
        if (!curUnit || _imgLoading) return;
        if (hasPark === true) {
            // 当前"是" → 改为"否"
            await onNo();
        } else if (hasPark === false) {
            // 当前"否" → 改为"是"
            onYes();
        }
    }

    function updateToggleBtn() {
        var btn = $('user-toggleBtn');
        if (!btn) return;
        if (hasPark === true) {
            btn.querySelector('.bigbtn-glyph').innerHTML = '&#10008;';
            btn.querySelector('.bigbtn-text').textContent = '改为否';
            btn.querySelector('.bigbtn-key').textContent = 'N';
            btn.className = 'user-bigbtn big-no';
            btn.style.display = '';
        } else if (hasPark === false) {
            btn.querySelector('.bigbtn-glyph').innerHTML = '&#10004;';
            btn.querySelector('.bigbtn-text').textContent = '改为是';
            btn.querySelector('.bigbtn-key').textContent = 'Y';
            btn.className = 'user-bigbtn big-yes';
            btn.style.display = '';
        } else {
            btn.style.display = 'none';
        }
    }

    // ===== 保存 =====
    function hasUnlabeledPolys() {
        return polygons.some(function(p) { return !p.label; });
    }

    async function saveHybrid() {
        if (!curUnit || !curTask) return;
        if (phase === 1 && hasPark === null) {
            toast('请先选择"是"或"否"');
            return null;
        }
        // Phase 1 + 但还没选 → 不能保存（除非选了"否"自动跳走）
        if (phase === 1 && hasPark === true) {
            // 已经在 phase 2 了，这里不应该进入
            return null;
        }
        try {
            if (isDrawing && drawPts.length >= 3) finishPoly();
            if (isDrawing) { isDrawing = false; drawPts = []; drawAll(); }

            if (hasPark === true && polygons.length > 0 && hasUnlabeledPolys()) {
                var unlabeledCount = polygons.filter(function(p) { return !p.label; }).length;
                toast('有 ' + unlabeledCount + ' 个多边形未设定园区类型，请点击选中后选择类型！');
                return null;
            }

            var derivedLabels = [];
            var seen = {};
            polygons.forEach(function(p) {
                if (p.label && !seen[p.label]) { seen[p.label] = true; derivedLabels.push(p.label); }
            });

            var payload = {
                has_park: hasPark,
                result: hasPark ? '是' : '否',
                polygons: polygons,
                transport_modes: hasPark ? transModes.slice() : [],
                comment: '',
            };
            var resp = await API.submitUnit(curTask.task_id, curTask.group_id, curUnit.id, payload);
            statusMap[String(curUnit.id)] = {
                done: true, has_park: hasPark,
                poi_labels: derivedLabels,
                transport_modes: hasPark ? transModes.slice() : [],
                polygon_count: polygons.length,
                updated_at: new Date().toISOString(),
            };
            renderUnitList();
            highlightCurrent(curUnit.id);
            setText('user-vStatus', '已完成: ' + (hasPark ? '是' : '否'));
            setText('user-vTrans', transModes.length > 0 ? transModes.join(', ') : '-');
            return resp;
        } catch (e) {
            console.error(e);
            toast('保存失败: ' + e.message);
            return null;
        }
    }

    async function onSaveAndNext() {
        if (!curUnit || _imgLoading) return;
        if (phase === 1 && hasPark === null) {
            toast('请先选择"是"或"否"');
            return;
        }
        showImgLoading();  // 立即显示加载中，不等保存完成

        // 本地查找下一个未完成的 unit
        var nextUnit = null, nextIdx = -1;
        for (var i = curIdx + 1; i < curTask.units.length; i++) {
            var st = statusMap[String(curTask.units[i].id)];
            if (!st || !st.done) { nextUnit = curTask.units[i]; nextIdx = i; break; }
        }

        // 并行：保存 + 下一个 unit 详情
        var savePromise = saveHybrid();
        var detailPromise = nextUnit
            ? API.getUnit(curTask.task_id, curTask.group_id, nextUnit.id)
            : Promise.resolve(null);
        var results = await Promise.all([savePromise, detailPromise]);
        var saved = results[0];
        _prefetchedDetail = results[1];
        if (_prefetchedDetail) _prefetchedDetail._unitId = nextUnit ? nextUnit.id : null;

        if (saved === null) { _prefetchedDetail = null; hideImgLoading(); return; }
        _imgLoading = false;  // 临时解除锁，selectUnit 内部会立即重新加锁
        if (nextUnit) {
            await selectUnit(nextUnit, nextIdx);
        } else {
            hideImgLoading();
            renderUnitList();
            highlightCurrent(curUnit ? curUnit.id : -1);
        }
    }

    async function onPrev() {
        if (!curUnit || _imgLoading) return;
        showImgLoading();  // 立即显示加载中
        var saved = await saveHybrid();
        if (saved === null) { hideImgLoading(); return; }
        _imgLoading = false;  // 临时解除锁
        if (curIdx > 0) {
            await selectUnit(curTask.units[curIdx - 1], curIdx - 1);
        } else {
            hideImgLoading();
            toast('已是第一项');
        }
    }

    async function onNext() {
        if (!curUnit || _imgLoading) return;
        showImgLoading();  // 立即显示加载中

        // 本地查找下一个未完成的 unit
        var nextUnit = null, nextIdx = -1;
        for (var i = curIdx + 1; i < curTask.units.length; i++) {
            var st = statusMap[String(curTask.units[i].id)];
            if (!st || !st.done) { nextUnit = curTask.units[i]; nextIdx = i; break; }
        }

        // 并行：保存 + 下一个 unit 详情
        var savePromise = saveHybrid();
        var detailPromise = nextUnit
            ? API.getUnit(curTask.task_id, curTask.group_id, nextUnit.id)
            : Promise.resolve(null);
        var results = await Promise.all([savePromise, detailPromise]);
        var saved = results[0];
        _prefetchedDetail = results[1];
        if (_prefetchedDetail) _prefetchedDetail._unitId = nextUnit ? nextUnit.id : null;

        if (saved === null) { _prefetchedDetail = null; hideImgLoading(); return; }
        _imgLoading = false;  // 临时解除锁
        if (nextUnit) {
            await selectUnit(nextUnit, nextIdx);
        } else {
            hideImgLoading();
            renderUnitList();
            highlightCurrent(curUnit ? curUnit.id : -1);
        }
    }

    async function jumpToNextPending() {
        for (var i = curIdx + 1; i < curTask.units.length; i++) {
            var s = statusMap[String(curTask.units[i].id)];
            if (!s || !s.done) { await selectUnit(curTask.units[i], i); return; }
        }
        renderUnitList();
        highlightCurrent(curUnit ? curUnit.id : -1);
    }

    // ===== 预加载下一个 unit 的图片（低优先级，不阻塞当前操作） =====
    function _prefetchUnitDetail(taskId, groupId, unitId) {
        return fetch('/api/unit/' + encodeURIComponent(taskId) + '/' +
            encodeURIComponent(groupId) + '/' + unitId, { credentials: 'include' })
            .then(function(r) { return r.ok ? r.json() : null; })
            .catch(function() { return null; });
    }

    function prefetchNextUnit(currentIdx) {
        // 取消上一个预加载
        if (_prefetchAbort) { _prefetchAbort = null; }

        // 找下一个 unit（优先找未完成的）
        var nextIdx = -1;
        for (var i = currentIdx + 1; i < curTask.units.length; i++) {
            var s = statusMap[String(curTask.units[i].id)];
            if (!s || !s.done) { nextIdx = i; break; }
        }
        // 如果后面全完成了，预加载上一个（退回去的可能）
        if (nextIdx === -1 && currentIdx > 0) {
            nextIdx = currentIdx - 1;
        }
        if (nextIdx === -1) return;

        var nextUnit = curTask.units[nextIdx];
        var doPrefetch = function() {
            _prefetchUnitDetail(curTask.task_id, curTask.group_id, nextUnit.id)
                .then(function(detail) {
                    if (!detail || !detail.image_url) return;
                    // 用 <link rel="prefetch"> 让浏览器后台缓存图片
                    var link = document.createElement('link');
                    link.rel = 'prefetch';
                    link.href = detail.image_url;
                    link.setAttribute('as', 'image');
                    document.head.appendChild(link);
                    // 5 秒后清理 DOM 节点（缓存已生效）
                    setTimeout(function() { if (link.parentNode) link.parentNode.removeChild(link); }, 5000);
                });
        };

        // requestIdleCallback: 等浏览器空闲再执行，不影响当前渲染
        if (window.requestIdleCallback) {
            _prefetchAbort = requestIdleCallback(doPrefetch, { timeout: 3000 });
        } else {
            _prefetchAbort = setTimeout(doPrefetch, 800);
        }
    }

    function undoPoly() {
        if (isDrawing && drawPts.length > 0) {
            drawPts.pop();
            if (drawPts.length === 0) { isDrawing = false; selectedPolyIdx = -1; }
            drawAll();
        } else if (polygons.length > 0) {
            polygons.pop(); selectedPolyIdx = -1;
            drawAll();
            toast('已删除最后一个框');
        }
    }

    function deleteSelectedPoly() {
        if (selectedPolyIdx >= 0) {
            polygons.splice(selectedPolyIdx, 1);
            selectedPolyIdx = -1; drawAll();
            toast('已删除选中框');
        } else if (polygons.length > 0) {
            polygons.pop(); drawAll();
            toast('已删除最后一个框');
        }
    }

    // ===== 渲染初始列表并默认选中第一个 =====
    renderUnitList();
    var firstIdx = 0;
    for (var i = 0; i < curTask.units.length; i++) {
        if (!statusMap[String(curTask.units[i].id)] || !statusMap[String(curTask.units[i].id)].done) {
            firstIdx = i; break;
        }
    }

    attachCanvasEvents();

    // ===== 按钮绑定 =====
    $('user-btnYes').addEventListener('click', onYes);
    $('user-btnNo').addEventListener('click', onNo);

    document.querySelectorAll('#poi-labelBtns .big-type').forEach(function(btn) {
        btn.addEventListener('click', function() { selectLabel(btn.dataset.label); });
    });

    document.querySelectorAll('#poi-transBtns .big-trans').forEach(function(btn) {
        btn.addEventListener('click', function() { toggleTransMode(btn.dataset.mode); });
    });

    $('user-saveBtn').addEventListener('click', onSaveAndNext);
    $('user-prevBtn').addEventListener('click', onPrev);
    $('user-nextBtn').addEventListener('click', onNext);
    $('user-logoutBtn').addEventListener('click', async function() {
        try { await API.logout(); } catch (e) {}
        window.location.reload();
    });
    $('poiUndoBtn').addEventListener('click', undoPoly);
    $('poiDelPolyBtn').addEventListener('click', deleteSelectedPoly);
    $('user-toggleBtn').addEventListener('click', onToggleHasPark);

    // ===== 快捷键 =====
    document.addEventListener('keydown', function(e) {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

        // 加载中时拦截导航类快捷键
        if (_imgLoading) {
            var navKeys = ['Enter', 'ArrowLeft', 'ArrowRight', 'y', 'Y', 'n', 'N', 's', 'S'];
            if (navKeys.indexOf(e.key) >= 0 || navKeys.indexOf(e.key.toLowerCase()) >= 0) {
                e.preventDefault();
                return;
            }
        }

        if (e.key === 'Enter') { e.preventDefault(); onSaveAndNext(); return; }
        if (e.key === 'ArrowLeft') { e.preventDefault(); onPrev(); return; }
        if (e.key === 'ArrowRight') { e.preventDefault(); onNext(); return; }

        var k = e.key.toLowerCase();

        // Phase 1 快捷键：Y/N
        if (phase === 1 && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
            if (k === 'y') { e.preventDefault(); onYes(); return; }
            if (k === 'n') { e.preventDefault(); onNo(); return; }
            if (k === 's') { e.preventDefault(); onSaveAndNext(); return; }
            return;
        }

        // Phase 2 快捷键
        if (e.key === 'Delete' || e.key === 'Backspace') {
            e.preventDefault();
            if (isDrawing) { isDrawing = false; drawPts = []; drawAll(); return; }
            deleteSelectedPoly(); return;
        }

        if (e.key === 'Escape') {
            e.preventDefault();
            isDrawing = false; drawPts = []; selectedPolyIdx = -1;
            drawAll(); return;
        }

        // Phase 2: N → 改为"否"
        if (!e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && k === 'n') {
            e.preventDefault(); onToggleHasPark(); return;
        }

        if (!e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && k === 's') {
            e.preventDefault(); onSaveAndNext(); return;
        }

        if (!e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && e.key >= '1' && e.key <= '8') {
            e.preventDefault();
            selectLabel(LABEL_TYPES[parseInt(e.key) - 1]);
            return;
        }

        if (!e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
            var transMap = { 'q': '公路', 'w': '铁路', 'e': '水路', 'r': '航空' };
            if (transMap[k]) { e.preventDefault(); toggleTransMode(transMap[k]); return; }
        }
    });

    // ===== 初始加载 =====
    $('user-loading').classList.add('hide');
    await selectUnit(curTask.units[firstIdx], firstIdx);

    // ===== 登录层 =====
    function showLogin() {
        $('user-loading').classList.add('hide');
        var wrap = document.createElement('div');
        wrap.className = 'user-login-wrap'; wrap.id = 'user-login-wrap';
        wrap.innerHTML =
            '<div class="user-login-card">' +
                '<h2>物流园区 Hybrid 判读系统</h2>' +
                '<div class="user-login-row"><label>账号</label><input id="user-login-username" /></div>' +
                '<div class="user-login-row"><label>密码</label><input id="user-login-password" type="password" /></div>' +
                '<button class="user-login-btn" id="user-login-btn">登 录</button>' +
                '<p class="user-login-msg" id="user-login-msg"></p>' +
            '</div>';
        document.body.appendChild(wrap);
        var u = document.getElementById('user-login-username');
        var p = document.getElementById('user-login-password');
        var btn = document.getElementById('user-login-btn');
        var msg = document.getElementById('user-login-msg');
        u.focus();
        var doLogin = async function() {
            msg.textContent = '';
            try {
                var r = await API.login(u.value.trim(), p.value);
                if (r.ok) {
                    if (r.role === 'admin') { window.location.href = '/admin'; }
                    else if (r.task_type === 'poi') { window.location.href = '/poi'; }
                    else if (r.task_type === 'judge' || r.task_type === 'judge_mask' || r.task_type === 'judge_shp') {
                        window.location.href = '/';
                    } else { window.location.reload(); }
                }
            } catch (e) { msg.textContent = '登录失败: ' + e.message; }
        };
        btn.addEventListener('click', doLogin);
        [u, p].forEach(function(el) {
            el.addEventListener('keydown', function(e) { if (e.key === 'Enter') doLogin(); });
        });
    }
})();
