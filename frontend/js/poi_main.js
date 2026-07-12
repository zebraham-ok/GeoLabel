/**
 * poi_main.js - POI 任务主控逻辑
 * 左侧 unit 列表 + 中部 PNG 图像（多边形绘制）+ 右侧高德地图
 * 底部 8 类园区类型（单选）+ 运输方式（多选） + 操作
 */
(async function() {
    function toast(msg) {
        const t = document.getElementById('user-toast');
        t.textContent = msg;
        t.classList.add('show');
        setTimeout(() => t.classList.remove('show'), 2000);
    }

    function $(id) { return document.getElementById(id); }
    function setText(id, v) { const el = $(id); if (el) el.textContent = v; }

    // ===== 8 分类标签（与 judge 任务一致） =====
    const LABEL_TYPES = ['露天集装箱', '露天散货', '气液粮仓储罐', '批发市场', '立体现代物流园', '传统集约物流园', '小物流聚集地', '码头/车站/机场'];
    const LABEL_COLORS = {
        '露天集装箱': '#ef5350',
        '露天散货': '#ff9800',
        '气液粮仓储罐': '#42a5f5',
        '批发市场': '#26c6da',
        '立体现代物流园': '#f06292',
        '传统集约物流园': '#7e57c2',
        '小物流聚集地': '#66bb6a',
        '码头/车站/机场': '#ff7043',
    };

    // ===== 检查登录 =====
    let me;
    try {
        me = await API.currentUser();
    } catch (e) {
        showLogin();
        return;
    }
    if (!me || !me.logged_in) {
        showLogin();
        return;
    }
    if (me.role === 'admin') {
        window.location.href = '/admin';
        return;
    }
    $('user-username').textContent = me.username;
    $('user-role').textContent = me.role;

    // ===== 状态 =====
    let curUnit = null, curIdx = 0, curTask = null, statusMap = {};

    // 运输方式
    let transModes = ['公路'];     // 多选数组，默认公路
    let curLabel = null;           // 当前标签（无默认，必须手动选择）

    // 多边形
    let polygons = [];            // [{label, points: [[pctx,pcty],...]}]
    let drawPts = [];            // 正在绘制中的点 [{x:pctx, y:pcty}]
    let selectedPolyIdx = -1;
    let isDrawing = false;
    let draggingPoint = null;    // {polyIdx, pointIdx}
    let wasDragging = false;

    // 画布尺寸
    let nW, nH, dW, dH, dX, dY;
    let ctx = null;
    let mousePos = { x: 0, y: 0 };

    // ===== 加载任务 =====
    let tasks = [];
    try { tasks = await API.userTasks(); } catch (e) {
        toast('加载任务失败: ' + e.message); return;
    }
    const poiTasks = tasks.filter(t => t.task_type === 'poi');
    if (poiTasks.length === 0 && tasks.length > 0) {
        // 当前用户没有 POI 任务（可能是 judge 用户误入 /poi），跳转到 judge 页面
        window.location.href = '/';
        return;
    }
    if (tasks.length === 0) {
        $('user-taskHeader').textContent = '未分配任务';
        $('user-loading').classList.add('hide');
        return;
    }
    curTask = poiTasks.length > 0 ? poiTasks[0] : tasks[0];
    $('user-taskHeader').textContent =
        (curTask.task_name || curTask.task_id) + ' · 组 ' + curTask.group_id +
        (curTask.task_type === 'poi' ? ' [POI]' : '');

    try { statusMap = (await API.unitStatus(curTask.task_id, curTask.group_id)) || {}; }
    catch (e) { statusMap = {}; }

    // ===== 多边形绘制：画布尺寸计算 =====
    function calcRect() {
        if (!nW || !nH) return;
        const wrap = $('user-imgWrap');
        const pw = wrap.clientWidth, ph = wrap.clientHeight;
        const s = Math.min(pw / nW, ph / nH);
        dW = Math.round(nW * s);
        dH = Math.round(nH * s);
        dX = Math.round((pw - dW) / 2);
        dY = Math.round((ph - dH) / 2);

        const img = $('user-mainImg');
        img.style.position = 'absolute';
        img.style.left = dX + 'px';
        img.style.top = dY + 'px';
        img.style.width = dW + 'px';
        img.style.height = dH + 'px';
        img.style.maxWidth = 'none';
        img.style.maxHeight = 'none';

        const canvas = $('polyCanvas');
        canvas.style.left = dX + 'px';
        canvas.style.top = dY + 'px';
        canvas.style.width = dW + 'px';
        canvas.style.height = dH + 'px';
        canvas.width = dW;
        canvas.height = dH;
        ctx = canvas.getContext('2d');
    }

    function px2pct(px, py) { return [(px / dW) * 100, (py / dH) * 100]; }
    function pct2px(px, py) { return [px * dW / 100, py * dH / 100]; }

    // ===== 多边形绘制：渲染 =====
    const GRAY_COLOR = '#ffffff';  // 未设定类别时白色填充
    function getPolyColor(label) { return label ? (LABEL_COLORS[label] || GRAY_COLOR) : GRAY_COLOR; }

    function drawAll() {
        if (!ctx || !dW || !dH) return;
        ctx.clearRect(0, 0, dW, dH);

        // 已完成的 polygons
        polygons.forEach(function(p, i) {
            const c = getPolyColor(p.label);
            const isSel = (i === selectedPolyIdx);
            ctx.beginPath();
            p.points.forEach(function(pt, j) {
                const xy = pct2px(pt[0], pt[1]);
                j === 0 ? ctx.moveTo(xy[0], xy[1]) : ctx.lineTo(xy[0], xy[1]);
            });
            ctx.closePath();
            // 未选中：白色填充 + 浅灰描边；选中：色块填充 + 粗描边
            const strokeColor = isSel ? c : (p.label ? c : '#aaaaaa');
            ctx.strokeStyle = strokeColor;
            ctx.lineWidth = isSel ? 3 : 2;
            ctx.stroke();
            ctx.fillStyle = isSel ? (c + '40') : '#ffffff30';
            ctx.fill();

            // 顶点（未设定标签时用浅灰可见色）
            const vertexColor = p.label ? c : '#aaaaaa';
            p.points.forEach(function(pt) {
                const xy = pct2px(pt[0], pt[1]);
                ctx.beginPath();
                ctx.arc(xy[0], xy[1], isSel ? 5 : 3, 0, Math.PI * 2);
                ctx.fillStyle = isSel ? '#fff' : vertexColor;
                ctx.fill();
                ctx.strokeStyle = vertexColor;
                ctx.lineWidth = 1;
                ctx.stroke();
            });

            // 标签文字
            if (p.points.length) {
                const xy = pct2px(p.points[0][0], p.points[0][1]);
                const labelText = p.label ? (i + 1) + '. ' + p.label : (i + 1) + '. 未设定';
                ctx.fillStyle = p.label ? c : '#aaaaaa';
                ctx.strokeStyle = 'transparent';
                ctx.font = 'bold 10px sans-serif';
                ctx.fillText(labelText, xy[0], xy[1] - 8);
            }
        });

        // 正在绘制中
        if (isDrawing && drawPts.length > 0) {
            const c = curLabel ? (LABEL_COLORS[curLabel] || '#ffffff') : '#ffffff';
            ctx.beginPath();
            drawPts.forEach(function(p, i) {
                const xy = pct2px(p.x, p.y);
                i === 0 ? ctx.moveTo(xy[0], xy[1]) : ctx.lineTo(xy[0], xy[1]);
            });
            if (drawPts.length > 0) {
                const mxy = pct2px(mousePos.x, mousePos.y);
                ctx.lineTo(mxy[0], mxy[1]);
            }
            ctx.strokeStyle = c;
            ctx.lineWidth = 2;
            ctx.setLineDash([5, 3]);
            ctx.stroke();
            ctx.setLineDash([]);

            const PR = 4;
            drawPts.forEach(function(p, i) {
                const xy = pct2px(p.x, p.y);
                ctx.beginPath(); ctx.arc(xy[0], xy[1], PR + 2, 0, Math.PI * 2);
                ctx.fillStyle = c + '60'; ctx.fill();
                ctx.beginPath(); ctx.arc(xy[0], xy[1], PR, 0, Math.PI * 2);
                ctx.fillStyle = (i === 0) ? '#fff' : c; ctx.fill();
                ctx.strokeStyle = c; ctx.lineWidth = 1; ctx.stroke();
                ctx.fillStyle = '#000';
                ctx.font = 'bold 8px sans-serif';
                ctx.fillText(i + 1, xy[0] + 6, xy[1] - 4);
            });

            if (drawPts.length >= 3) {
                const fxy = pct2px(drawPts[0].x, drawPts[0].y);
                ctx.beginPath(); ctx.arc(fxy[0], fxy[1], PR + 6, 0, Math.PI * 2);
                ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
                ctx.setLineDash([2, 2]); ctx.stroke(); ctx.setLineDash([]);
                ctx.fillStyle = '#fff'; ctx.font = 'bold 9px sans-serif';
                ctx.fillText('双击闭合', fxy[0] + 10, fxy[1] - 8);
            }
        }

        // 更新计数器
        setText('user-polyCount', polygons.length);
        $('poiToolbarCount').textContent = polygons.length + ' 个框';
    }

    // ===== 多边形：命中检测 =====
    function findPointAt(px, py, threshold) {
        for (let i = polygons.length - 1; i >= 0; i--) {
            const p = polygons[i];
            for (let j = 0; j < p.points.length; j++) {
                const pt = p.points[j];
                const dist = Math.sqrt((px - pt[0]) ** 2 + (py - pt[1]) ** 2);
                if (dist <= threshold) return { type: 'point', polyIdx: i, pointIdx: j };
            }
        }
        return null;
    }

    function findPolyAt(px, py) {
        for (let i = polygons.length - 1; i >= 0; i--) {
            const p = polygons[i];
            if (p.points.length >= 3 && pointInPolygon(px, py, p.points)) return i;
        }
        return -1;
    }

    function pointInPolygon(x, y, poly) {
        let inside = false;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
            const xi = poly[i][0], yi = poly[i][1];
            const xj = poly[j][0], yj = poly[j][1];
            if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi))
                inside = !inside;
        }
        return inside;
    }

    function finishPoly() {
        if (drawPts.length < 3) {
            isDrawing = false;
            drawPts = [];
            drawAll();
            setHint('点击画布添加顶点 · 双击闭合 · 右键取消');
            return;
        }
        polygons.push({
            label: curLabel || null,
            points: drawPts.map(function(p) {
                return [+p.x.toFixed(2), +p.y.toFixed(2)];
            })
        });
        drawPts = [];
        isDrawing = false;
        selectedPolyIdx = polygons.length - 1;
        drawAll();
        if (curLabel) {
            toast('框已添加 (' + polygons.length + '个) · ' + curLabel);
        } else {
            toast('框已添加 (' + polygons.length + '个) · 请选择园区类型！');
        }
        setHint('点击画布添加顶点 · 双击闭合 · 点击已有框可选中');
    }

    // ===== 标签 & 运输方式管理 =====
    function selectLabel(label) {
        // 选中了已有框 → 修改该框的标签
        if (selectedPolyIdx >= 0 && polygons[selectedPolyIdx]) {
            const p = polygons[selectedPolyIdx];
            const old = p.label;
            if (old !== label) {
                p.label = label;
                curLabel = label;
                updateLabelBtns();
                $('poiToolbarActiveLabel').textContent = label;
                drawAll();
                toast('框 ' + (selectedPolyIdx + 1) + ': ' + (old || '未设定') + ' → ' + label);
            }
            return;
        }
        // 没有选中框 → 设置全局绘制标签
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
        const idx = transModes.indexOf(mode);
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
        polygons = [];
        drawPts = [];
        isDrawing = false;
        selectedPolyIdx = -1;
        draggingPoint = null;
        wasDragging = false;
        transModes = ['公路'];
        curLabel = null;
        highlightTransBtns();
        updateLabelBtns();
        $('poiToolbarActiveLabel').textContent = '未选择';
        drawAll();
    }

    function setHint(msg) {
        $('poiToolbarHint').textContent = msg;
    }

    // ===== 画布事件 =====
    function attachCanvasEvents() {
        const canvas = $('polyCanvas');

        canvas.addEventListener('mousedown', function(e) {
            if (!curUnit || isDrawing) return;
            const rect = this.getBoundingClientRect();
            const pct = px2pct(e.clientX - rect.left, e.clientY - rect.top);
            const ptHit = findPointAt(pct[0], pct[1], 1.5);
            if (ptHit && ptHit.polyIdx === selectedPolyIdx && selectedPolyIdx >= 0) {
                draggingPoint = { polyIdx: ptHit.polyIdx, pointIdx: ptHit.pointIdx };
                wasDragging = false;
                e.stopPropagation();
            }
        });

        canvas.addEventListener('mousemove', function(e) {
            if (!curUnit) return;
            const rect = this.getBoundingClientRect();
            const pct = px2pct(e.clientX - rect.left, e.clientY - rect.top);
            mousePos = pct;

            if (draggingPoint) {
                wasDragging = true;
                polygons[draggingPoint.polyIdx].points[draggingPoint.pointIdx] =
                    [+pct[0].toFixed(2), +pct[1].toFixed(2)];
                this.style.cursor = 'grabbing';
                drawAll();
                return;
            }
            if (isDrawing) { drawAll(); return; }

            const ptHit = findPointAt(pct[0], pct[1], 1.5);
            if (ptHit && ptHit.polyIdx === selectedPolyIdx && selectedPolyIdx >= 0)
                this.style.cursor = 'grab';
            else
                this.style.cursor = 'crosshair';
        });

        document.addEventListener('mouseup', function() {
            if (draggingPoint) {
                draggingPoint = null;
                const cv = $('polyCanvas');
                if (cv) cv.style.cursor = 'crosshair';
            }
        });

        canvas.addEventListener('click', function(e) {
            if (!curUnit) return;
            if (wasDragging) { wasDragging = false; return; }

            const rect = this.getBoundingClientRect();
            const pct = px2pct(e.clientX - rect.left, e.clientY - rect.top);

            const ptHit = findPointAt(pct[0], pct[1], 1.5);
            if (ptHit) return; // 点在顶点上，留给 mousedown 处理拖动

            const polyHit = findPolyAt(pct[0], pct[1]);
            if (polyHit >= 0) {
                selectedPolyIdx = polyHit;
                isDrawing = false;
                drawPts = [];
                drawAll();
                const pLabel = polygons[polyHit].label;
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
            if (!isDrawing || drawPts.length < 3) return;
            e.preventDefault();
            finishPoly();
        });

        canvas.addEventListener('contextmenu', function(e) {
            e.preventDefault();
            if (isDrawing) {
                isDrawing = false;
                drawPts = [];
                drawAll();
                setHint('点击画布添加顶点 · 双击闭合 · 右键取消');
            }
        });

        // 窗口 resize 重算
        window.addEventListener('resize', function() {
            if (nW && nH) { calcRect(); drawAll(); }
        });
    }

    // ===== 左侧 unit 列表 =====
    function renderUnitList() {
        const list = $('user-unitList');
        list.innerHTML = '';
        const units = curTask.units || [];
        if (units.length === 0) {
            list.innerHTML = '<div style="padding:20px 10px;font-size:10px;color:#666;text-align:center">本组无标注任务</div>';
            return;
        }
        units.forEach(function(u, idx) {
            const s = statusMap[String(u.id)] || null;
            const el = document.createElement('div');
            let cls = 'user-unit-item';
            if (s && s.done) cls += ' status-done';
            el.className = cls;
            el.dataset.unitId = u.id;

            const title = shortFileName(u.image || '');
            const short = title.length > 20 ? title.substring(0, 20) + '...' : title;
            el.innerHTML =
                '<div class="user-unit-title">#' + u.id + ' · ' + short + '</div>' +
                (u.lat != null ? '<div class="user-unit-meta">' + u.lat + ', ' + u.lng + '</div>' : '') +
                (s && s.done ? '<div class="user-unit-result">✓ ' +
                    ((s.poi_labels && s.poi_labels.length > 0)
                        ? s.poi_labels.join(',')
                        : '已标注') + '</div>'
                    : '');

            el.addEventListener('click', function() { selectUnit(u, idx); });
            list.appendChild(el);
        });
    }

    function highlightCurrent(unitId) {
        document.querySelectorAll('.user-unit-item').forEach(function(el) {
            el.classList.remove('status-current');
            if (parseInt(el.dataset.unitId, 10) === unitId)
                el.classList.add('status-current');
        });
    }

    // ===== 选择 unit =====
    async function selectUnit(u, idx) {
        curUnit = u;
        curIdx = idx;
        highlightCurrent(u.id);
        setText('user-counter', (idx + 1) + '/' + curTask.units.length);
        setText('user-tname', shortFileName(u.image));
        setText('user-vCoord', (u.lat != null) ? u.lat + ', ' + u.lng : '-');
        setText('user-vSize', (u.img_width && u.img_height) ? u.img_width + '×' + u.img_height + ' px' : '-');

        // 加载图像
        try {
            const detail = await API.getPoiUnit(curTask.task_id, curTask.group_id, u.id);
            const imgEl = $('user-mainImg');
            imgEl.onload = function() {
                nW = this.naturalWidth;
                nH = this.naturalHeight;
                calcRect();
                drawAll();
            };
            imgEl.src = detail.image_url;

            // 加载已有标注
            resetAnnotations();
            if (detail.existing_annotation) {
                const ann = detail.existing_annotation;
                if (ann.polygons && Array.isArray(ann.polygons)) {
                    polygons = ann.polygons;
                    if (polygons.length > 0) {
                        const lastLabel = polygons[polygons.length - 1].label;
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
                    done: true,
                    poi_labels: ann.poi_labels,
                    transport_modes: (ann.transport_modes || []).slice(),
                    polygon_count: (ann.polygons || []).length,
                };
            }

            setText('user-vName', shortFileName(u.image));
            const s = statusMap[String(u.id)];
            const polyN = (s && s.polygon_count != null) ? s.polygon_count : polygons.length;
            setText('user-polyCount', polyN);
            $('poiToolbarCount').textContent = polyN + ' 个框';
            setText('user-vTrans', s && s.transport_modes && s.transport_modes.length > 0
                ? s.transport_modes.join(', ')
                : (transModes.length > 0 ? transModes.join(', ') : '-'));

            // 如果图像已加载（缓存），直接算
            if (imgEl.complete && imgEl.naturalWidth) {
                nW = imgEl.naturalWidth;
                nH = imgEl.naturalHeight;
                calcRect();
                drawAll();
            }

            setHint('点击画布添加顶点 · 双击闭合 · 右键取消');

            // 初始化地图
            if (u.lat != null && u.lng != null) {
                UserMap.init({ lng: u.lng, lat: u.lat, name: shortFileName(u.image) });
            } else {
                UserMap.init({ lng: 116.397428, lat: 39.90923, name: '' });
            }
        } catch (e) {
            toast('加载 unit 失败: ' + e.message);
        }

        renderUnitList();
    }

    // ===== 保存 =====
    function hasUnlabeledPolys() {
        return polygons.some(function(p) { return !p.label; });
    }

    async function savePOI() {
        if (!curUnit || !curTask) return;
        try {
            // 如果正在绘制，先完成
            if (isDrawing && drawPts.length >= 3) finishPoly();
            if (isDrawing) { isDrawing = false; drawPts = []; drawAll(); }

            // 检查是否所有多边形都已设定园区类型
            if (polygons.length > 0 && hasUnlabeledPolys()) {
                const unlabeledCount = polygons.filter(function(p) { return !p.label; }).length;
                toast('有 ' + unlabeledCount + ' 个多边形未设定园区类型，请点击选中后选择类型！');
                return null;
            }

            const derivedLabels = [];
            const seen = {};
            polygons.forEach(function(p) {
                if (p.label && !seen[p.label]) { seen[p.label] = true; derivedLabels.push(p.label); }
            });

            const payload = {
                poi_labels: derivedLabels,
                polygons: polygons,
                transport_modes: transModes.slice(),
                comment: '',
            };
            const resp = await API.submitPoiUnit(curTask.task_id, curTask.group_id, curUnit.id, payload);
            statusMap[String(curUnit.id)] = {
                done: true,
                poi_labels: derivedLabels,
                transport_modes: transModes.slice(),
                polygon_count: polygons.length,
                updated_at: new Date().toISOString(),
            };
            renderUnitList();
            highlightCurrent(curUnit.id);
            setText('user-vTrans', transModes.length > 0 ? transModes.join(', ') : '-');
            return resp;
        } catch (e) {
            console.error(e);
            toast('保存失败: ' + e.message);
            return null;
        }
    }

    async function onSaveAndNext() {
        if (!curUnit) return;
        const saved = await savePOI();
        if (saved === null) return;  // 未通过验证（存在未设定类型的多边形）
        await jumpToNextPending();
    }

    async function onPrev() {
        if (!curUnit) return;
        const saved = await savePOI();
        if (saved === null) return;
        if (curIdx > 0) {
            await selectUnit(curTask.units[curIdx - 1], curIdx - 1);
        } else {
            toast('已是第一项');
        }
    }

    async function onNext() {
        if (!curUnit) return;
        const saved = await savePOI();
        if (saved === null) return;
        await jumpToNextPending();
    }

    async function jumpToNextPending() {
        for (let i = curIdx + 1; i < curTask.units.length; i++) {
            const s = statusMap[String(curTask.units[i].id)];
            if (!s || !s.done) {
                await selectUnit(curTask.units[i], i);
                return;
            }
        }
        renderUnitList();
        highlightCurrent(curUnit ? curUnit.id : -1);
    }

    function undoPoly() {
        if (isDrawing && drawPts.length > 0) {
            drawPts.pop();
            if (drawPts.length === 0) {
                isDrawing = false;
                selectedPolyIdx = -1;
                setHint('点击画布添加顶点 · 双击闭合 · 右键取消');
            }
            drawAll();
        } else if (polygons.length > 0) {
            polygons.pop();
            selectedPolyIdx = -1;
            drawAll();
            toast('已删除最后一个框');
        }
    }

    function deleteSelectedPoly() {
        if (selectedPolyIdx >= 0) {
            polygons.splice(selectedPolyIdx, 1);
            selectedPolyIdx = -1;
            drawAll();
            toast('已删除选中框');
        } else if (polygons.length > 0) {
            polygons.pop();
            drawAll();
            toast('已删除最后一个框');
        }
    }

    // ===== 渲染初始列表并默认选中第一个 =====
    renderUnitList();
    let firstIdx = 0;
    for (let i = 0; i < curTask.units.length; i++) {
        if (!statusMap[String(curTask.units[i].id)] || !statusMap[String(curTask.units[i].id)].done) {
            firstIdx = i;
            break;
        }
    }

    // 绑定画布事件
    attachCanvasEvents();

    // ===== 按钮绑定 =====
    // 8 类标签按钮（单选）
    document.querySelectorAll('#poi-labelBtns .big-type').forEach(function(btn) {
        btn.addEventListener('click', function() { selectLabel(btn.dataset.label); });
    });

    // 运输方式按钮（多选）
    document.querySelectorAll('#poi-transBtns .big-trans').forEach(function(btn) {
        btn.addEventListener('click', function() { toggleTransMode(btn.dataset.mode); });
    });

    // 操作按钮
    $('user-saveBtn').addEventListener('click', onSaveAndNext);
    $('user-prevBtn').addEventListener('click', onPrev);
    $('user-nextBtn').addEventListener('click', onNext);
    $('user-logoutBtn').addEventListener('click', async function() {
        try { await API.logout(); } catch (e) {}
        window.location.reload();
    });
    $('poiUndoBtn').addEventListener('click', undoPoly);
    $('poiDelPolyBtn').addEventListener('click', deleteSelectedPoly);

    // ===== 快捷键 =====
    document.addEventListener('keydown', function(e) {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

        // Enter：保存并下一页
        if (e.key === 'Enter') { e.preventDefault(); onSaveAndNext(); return; }

        // 翻页
        if (e.key === 'ArrowLeft') { e.preventDefault(); onPrev(); return; }
        if (e.key === 'ArrowRight') { e.preventDefault(); onNext(); return; }

        const k = e.key.toLowerCase();

        // Delete：删除选中框
        if (e.key === 'Delete' || e.key === 'Backspace') {
            e.preventDefault();
            if (isDrawing) { isDrawing = false; drawPts = []; drawAll(); setHint('点击画布添加顶点 · 双击闭合 · 右键取消'); return; }
            deleteSelectedPoly();
            return;
        }

        // Escape：取消绘制 / 取消选中
        if (e.key === 'Escape') {
            e.preventDefault();
            isDrawing = false;
            drawPts = [];
            selectedPolyIdx = -1;
            drawAll();
            setHint('点击画布添加顶点 · 双击闭合 · 右键取消');
            return;
        }

        // S 保存
        if (!e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && k === 's') {
            e.preventDefault(); onSaveAndNext(); return;
        }

        // 1-8：园区类型
        if (!e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && e.key >= '1' && e.key <= '8') {
            e.preventDefault();
            selectLabel(LABEL_TYPES[parseInt(e.key) - 1]);
            return;
        }

        // Q/W/E/R：运输方式多选
        if (!e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
            const transMap = { 'q': '公路', 'w': '铁路', 'e': '水路', 'r': '航空' };
            if (transMap[k]) {
                e.preventDefault();
                toggleTransMode(transMap[k]);
                return;
            }
        }
    });

    // ===== 初始加载 =====
    $('user-loading').classList.add('hide');
    await selectUnit(curTask.units[firstIdx], firstIdx);

    // ===== 登录层 =====
    function showLogin() {
        $('user-loading').classList.add('hide');
        const wrap = document.createElement('div');
        wrap.className = 'user-login-wrap';
        wrap.id = 'user-login-wrap';
        wrap.innerHTML =
            '<div class="user-login-card">' +
                '<h2>物流园区 POI 判读系统</h2>' +
                '<div class="user-login-row"><label>账号</label><input id="user-login-username" /></div>' +
                '<div class="user-login-row"><label>密码</label><input id="user-login-password" type="password" /></div>' +
                '<button class="user-login-btn" id="user-login-btn">登 录</button>' +
                '<p class="user-login-msg" id="user-login-msg"></p>' +
            '</div>';
        document.body.appendChild(wrap);
        const u = document.getElementById('user-login-username');
        const p = document.getElementById('user-login-password');
        const btn = document.getElementById('user-login-btn');
        const msg = document.getElementById('user-login-msg');
        u.focus();
        const doLogin = async function() {
            msg.textContent = '';
            try {
                const r = await API.login(u.value.trim(), p.value);
                if (r.ok) {
                    if (r.role === 'admin') {
                        window.location.href = '/admin';
                    } else if (r.task_type === 'judge' || r.task_type === 'judge_mask' || r.task_type === 'judge_shp') {
                        // judge 用户在 /poi 页面登录 → 跳转到 judge 页面
                        window.location.href = '/';
                    } else if (r.task_type === 'hybrid') {
                        window.location.href = '/hybrid';
                    } else {
                        window.location.reload();
                    }
                }
            } catch (e) {
                msg.textContent = '登录失败: ' + e.message;
            }
        };
        btn.addEventListener('click', doLogin);
        [u, p].forEach(function(el) {
            el.addEventListener('keydown', function(e) { if (e.key === 'Enter') doLogin(); });
        });
    }
})();
