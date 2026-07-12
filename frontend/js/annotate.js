/**
 * annotate.js - 标注操作（mask 渲染、bbox 绘制、保存、类型/运输方式）
 */
const Annotate = (function() {
    let curUnit = null;
    let curTask = null;
    let curGroup = null;
    let onSaved = null;
    let statusMap = {};
    let polygonPixels = null;  // judge_shp 模式的多边形像素坐标

    // 园区类型 & 运输方式状态
    let parkType = null;        // 当前选中的园区类型（字符串或 null）
    let transModes = [];        // 当前选中的运输方式（多选数组）

    function setStatusMap(m) { statusMap = m || {}; }

    function setOnSaved(fn) { onSaved = fn; }

    function setUnit(task, group, unit) {
        curTask = task;
        curGroup = group;
        curUnit = unit;
    }

    function getUnit() { return curUnit; }

    function getParkType() { return parkType; }
    function getTransModes() { return transModes.slice(); }

    function setParkType(t) { parkType = t; highlightParkBtn(); }
    function toggleTransMode(mode) {
        const idx = transModes.indexOf(mode);
        if (idx >= 0) transModes.splice(idx, 1);
        else transModes.push(mode);
        highlightTransBtns();
    }
    function resetTypeAndTrans() {
        parkType = null;
        transModes = [];
        highlightParkBtn();
        highlightTransBtns();
    }

    function highlightParkBtn() {
        document.querySelectorAll('.big-type').forEach(b => {
            b.classList.toggle('active', b.dataset.type === parkType);
        });
    }

    function highlightTransBtns() {
        document.querySelectorAll('.big-trans').forEach(b => {
            b.classList.toggle('on', transModes.indexOf(b.dataset.mode) >= 0);
        });
    }

    async function loadImage(unitInfo) {
        const imgEl = document.getElementById('user-mainImg');
        const imgUrl = unitInfo.image_url;
        const maskUrl = unitInfo.mask_url;

        // 存储 judge_shp 的多边形数据
        polygonPixels = unitInfo.polygon_pixels || null;

        return new Promise((resolve, reject) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => {
                // 先设 src
                imgEl.src = imgUrl;
                // 用 rAF 等待浏览器布局完成（与 img 实际渲染尺寸对齐）
                const apply = () => syncCanvasSize(img, maskUrl).then(resolve, resolve);
                if (imgEl.complete && imgEl.naturalWidth) {
                    apply();
                } else {
                    imgEl.onload = apply;
                }
            };
            img.onerror = () => reject(new Error('原图加载失败'));
            img.src = imgUrl;
        });
    }

    function syncCanvasSize(img, maskUrl) {
        const imgEl = document.getElementById('user-mainImg');
        const maskC = document.getElementById('user-maskCanvas');
        const bboxC = document.getElementById('user-bboxCanvas');

        // 取 img 元素的实际渲染尺寸（受 object-fit: contain 影响）
        const rect = imgEl.getBoundingClientRect();
        const w = Math.max(1, Math.round(rect.width));
        const h = Math.max(1, Math.round(rect.height));

        [maskC, bboxC].forEach(c => {
            c.width = w;
            c.height = h;
            c.style.width = w + 'px';
            c.style.height = h + 'px';
            // canvas 绝对定位到与 img 重合
            c.style.left = rect.left - imgEl.parentElement.getBoundingClientRect().left + 'px';
            c.style.top  = rect.top  - imgEl.parentElement.getBoundingClientRect().top  + 'px';
        });
        // 缓存原图像素尺寸（用于 bbox 缩放）
        const natW = imgEl.naturalWidth || img.naturalWidth;
        const natH = imgEl.naturalHeight || img.naturalHeight;
        maskC._natW = natW;
        maskC._natH = natH;
        bboxC._natW = natW;
        bboxC._natH = natH;

        if (polygonPixels && polygonPixels.length > 0) {
            // judge_shp: 用多边形渲染 overlay
            drawPolygonOverlay(polygonPixels, w, h, natW, natH);
            return Promise.resolve(drawBboxes());
        }
        return drawMask(maskUrl, w, h).then(drawBboxes);
    }

    async function drawMask(maskUrl, dispW, dispH) {
        const canvas = document.getElementById('user-maskCanvas');
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (!maskUrl) return;

        return new Promise((resolve) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => {
                ctx.globalAlpha = 0.35;
                ctx.drawImage(img, 0, 0, dispW, dispH);
                ctx.globalAlpha = 1.0;
                resolve();
            };
            img.onerror = () => resolve();
            img.src = maskUrl;
        });
    }

    function drawPolygonOverlay(polyData, dispW, dispH, natW, natH) {
        const canvas = document.getElementById('user-maskCanvas');
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (!polyData || polyData.length < 3) return;

        // 缩放比例：从原图像素坐标 → 显示尺寸
        const sx = dispW / natW;
        const sy = dispH / natH;

        // 1. 用半透明黑色填充全部（变暗效果）
        ctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // 2. 在多边形区域内清除暗色覆盖，露出下方原图正常亮度
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

    function drawBboxes() {
        const canvas = document.getElementById('user-bboxCanvas');
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (!curUnit) return;
        const natW = canvas._natW, natH = canvas._natH;
        if (!natW || !natH) return;
        const sx = canvas.width / natW;
        const sy = canvas.height / natH;
        const [x, y, w, h] = curUnit.bbox;
        ctx.strokeStyle = '#e94560';
        ctx.lineWidth = 2;
        ctx.strokeRect(x * sx, y * sy, w * sx, h * sy);
    }

    function fillBottomInfo() {
        const v = (id, t) => document.getElementById(id).textContent = t;
        if (!curUnit) {
            v('user-vName', '-');
            v('user-vBbox', '-');
            v('user-vArea', '-');
            v('user-vStatus', '-');
            return;
        }
        v('user-vName', curUnit.image);
        const [x, y, w, h] = curUnit.bbox;
        v('user-vBbox', `${x},${y} ${w}×${h}`);
        v('user-vArea', curUnit.area + ' px');
        const s = statusMap[String(curUnit.id)];
        v('user-vStatus', s && s.done ? ('已完成: ' + (s.result || '')) : '待标注');
    }

    async function save(result) {
        if (!curUnit || !curTask) return;
        const comment = document.getElementById('user-comment') ? document.getElementById('user-comment').value : '';
        try {
            const payload = {
                result,
                park_type: parkType,
                transport_modes: transModes.slice(),
                comment,
            };
            const resp = await API.submitUnit(curTask.task_id, curGroup.group_id, curUnit.id, payload);
            statusMap[String(curUnit.id)] = { done: true, result, updated_at: new Date().toISOString() };
            fillBottomInfo();
            if (onSaved) onSaved(curUnit, result);
            return resp;
        } catch (e) {
            console.error(e);
            return null;
        }
    }

    return {
        setUnit, getUnit, loadImage, drawBboxes, fillBottomInfo, save,
        setOnSaved, setStatusMap,
        getParkType, setParkType, getTransModes, toggleTransMode,
        resetTypeAndTrans,
    };
})();
