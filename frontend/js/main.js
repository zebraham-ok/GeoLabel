/**
 * main.js - 主控逻辑
 */
(async function() {
    function toast(msg) {
        const t = document.getElementById('user-toast');
        t.textContent = msg;
        t.classList.add('show');
        setTimeout(() => t.classList.remove('show'), 2000);
    }

    function setStatus(id, v) {
        const el = document.getElementById(id);
        if (el) el.textContent = v;
    }

    // 解析文件名中的经纬度（参考 labeling_app）
    const FILENAME_PATTERN = /^(.+?)_(-?\d+\.\d+)_(-?\d+\.\d+)_(?:[^_]+)_(?:cat\d+)\.(?:jpg|jpeg|png)$/i;
    const FILENAME_PATTERN_SIMPLE = /^(.+?)_(-?\d+\.\d+)_(-?\d+\.\d+)\.(?:jpg|jpeg|png)$/i;

    function parseFilename(name) {
        let m = FILENAME_PATTERN.exec(name);
        if (!m) m = FILENAME_PATTERN_SIMPLE.exec(name);
        if (!m) return null;
        return { name: m[1], lat: parseFloat(m[2]), lng: parseFloat(m[3]) };
    }

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
        // 管理员跳到 admin 页
        window.location.href = '/admin';
        return;
    }
    document.getElementById('user-username').textContent = me.username;
    document.getElementById('user-role').textContent = me.role;

    // 变量（必须在使用前声明，避免 TDZ）
    let curUnit = null;
    let curIdx = 0;

    // ===== 加载数据 =====
    let tasks = [];
    try {
        tasks = await API.userTasks();
    } catch (e) {
        toast('加载任务失败: ' + e.message);
        return;
    }
    if (tasks.length === 0) {
        document.getElementById('user-taskHeader').textContent = '未分配任务';
        document.getElementById('user-loading').classList.add('hide');
        return;
    }

    // POI 任务用户自动跳转到 POI 页面
    if (tasks.length > 0 && tasks[0].task_type === 'poi') {
        window.location.href = '/poi';
        return;
    }
    // Hybrid 任务用户自动跳转到 Hybrid 页面
    if (tasks.length > 0 && tasks[0].task_type === 'hybrid') {
        window.location.href = '/hybrid';
        return;
    }

    const curTask = tasks[0];
    document.getElementById('user-taskHeader').textContent =
        (curTask.task_name || curTask.task_id) + ' · 组 ' + curTask.group_id;

    // 加载状态
    let statusMap = {};
    try { statusMap = (await API.unitStatus(curTask.task_id, curTask.group_id)) || {}; }
    catch (e) { statusMap = {}; }

    Annotate.setStatusMap(statusMap);
    TaskList.setOnSelect(async (u, idx) => selectUnit(u, idx, curTask));
    Annotate.setOnSaved(() => {
        // 保存后刷新当前任务列表
        TaskList.renderUnits(curTask, statusMap);
        TaskList.highlightCurrent(curUnit ? curUnit.id : -1);
    });

    // 渲染左侧
    TaskList.renderTabs(tasks);
    TaskList.renderUnits(curTask, statusMap);

    // 默认选第一个未完成的
    let firstIdx = 0;
    for (let i = 0; i < curTask.units.length; i++) {
        if (!statusMap[String(curTask.units[i].id)] || !statusMap[String(curTask.units[i].id)].done) {
            firstIdx = i;
            break;
        }
    }
    document.getElementById('user-loading').classList.add('hide');
    await selectUnit(curTask.units[firstIdx], firstIdx, curTask);

    // 绑定按钮
    document.getElementById('user-btnYes').addEventListener('click', () => onResult('是'));
    document.getElementById('user-btnNo').addEventListener('click', () => onResult('否'));
    document.getElementById('user-btnUnsure').addEventListener('click', () => onResult('不确定'));
    document.getElementById('user-saveBtn').addEventListener('click', () => onSaveOnly());
    document.getElementById('user-prevBtn').addEventListener('click', () => onPrev());
    document.getElementById('user-nextBtn').addEventListener('click', () => onNext());
    document.getElementById('user-logoutBtn').addEventListener('click', async () => {
        try { await API.logout(); } catch (e) {}
        window.location.reload();
    });

    // ==== 园区类型按钮（单选） ====
    document.querySelectorAll('.big-type').forEach(btn => {
        btn.addEventListener('click', () => {
            const type = btn.dataset.type;
            if (Annotate.getParkType() === type) {
                Annotate.setParkType(null);
            } else {
                Annotate.setParkType(type);
            }
        });
    });

    // ==== 运输方式按钮（多选） ====
    document.querySelectorAll('.big-trans').forEach(btn => {
        btn.addEventListener('click', () => {
            Annotate.toggleTransMode(btn.dataset.mode);
        });
    });

    // ==== 快捷键 ====
    document.addEventListener('keydown', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

        // Enter：保存并切换到下一页
        if (e.key === 'Enter') { e.preventDefault(); onSaveOnly(); return; }

        // 翻页
        if (e.key === 'ArrowLeft')  { e.preventDefault(); onPrev(); return; }
        if (e.key === 'ArrowRight') { e.preventDefault(); onNext(); return; }

        // Y / N / U / S：是不是 + 保存
        const k = e.key.toLowerCase();
        if (!e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
            if (k === 'y') { e.preventDefault(); onResult('是');     return; }
            if (k === 'n') { e.preventDefault(); onResult('否');     return; }
            if (k === 'u') { e.preventDefault(); onResult('不确定'); return; }
            if (k === 's') { e.preventDefault(); onSaveOnly();       return; }
        }
        if (!e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
            if (k === 'y') { e.preventDefault(); onResult('是');     return; }
            if (k === 'n') { e.preventDefault(); onResult('否');     return; }
            if (k === 'u') { e.preventDefault(); onResult('不确定'); return; }
        }

        // Q/W/E/R：运输方式多选
        if (!e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
            const modes = { 'q': '公路', 'w': '铁路', 'e': '水路', 'r': '航空' };
            if (modes[k]) {
                e.preventDefault();
                Annotate.toggleTransMode(modes[k]);
                return;
            }
        }

        // 1~8：园区类型单选
        if (!e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && e.key >= '1' && e.key <= '8') {
            e.preventDefault();
            const types = ['露天集装箱', '露天散货', '气液粮仓储罐', '批发市场', '立体现代物流园', '传统集约物流园', '小物流聚集地', '码头/车站/机场'];
            const type = types[parseInt(e.key) - 1];
            if (Annotate.getParkType() === type) {
                Annotate.setParkType(null);
            } else {
                Annotate.setParkType(type);
            }
            return;
        }
    });

    async function selectUnit(u, idx, task) {
        curUnit = u;
        curIdx = idx;
        TaskList.highlightCurrent(u.id);
        setStatus('user-counter', (idx + 1) + '/' + task.units.length);
        setStatus('user-tname', u.image);

        // 经纬度：优先使用 unit 内置字段，否则从文件名解析
        let info;
        if (u.lat != null && u.lng != null) {
            info = { name: u.name || u.image, lat: u.lat, lng: u.lng };
        } else {
            info = parseFilename(u.image) || {};
        }
        setStatus('user-vCoord', (info.lat !== undefined ? info.lat.toFixed(6) : '-') + ', ' + (info.lng !== undefined ? info.lng.toFixed(6) : '-'));

        try {
            const detail = await API.getUnit(task.task_id, task.group_id, u.id);
            Annotate.setUnit(task, { group_id: task.group_id }, u);
            await Annotate.loadImage(detail);

            // 加载已有标注
            Annotate.resetTypeAndTrans();
            clearResultHighlight();
            if (detail.existing_annotation) {
                if (detail.existing_annotation.park_type) {
                    Annotate.setParkType(detail.existing_annotation.park_type);
                }
                if (detail.existing_annotation.transport_modes && Array.isArray(detail.existing_annotation.transport_modes)) {
                    detail.existing_annotation.transport_modes.forEach(m => Annotate.toggleTransMode(m));
                }
                statusMap[String(u.id)] = { done: true, result: detail.existing_annotation.result };
                highlightResult(detail.existing_annotation.result);
            }
            // 默认公路运输
            if (Annotate.getTransModes().length === 0) {
                Annotate.toggleTransMode('公路');
            }
            Annotate.fillBottomInfo();
            UserMap.init(info);
        } catch (e) {
            toast('加载 unit 失败: ' + e.message);
        }
    }

    async function onResult(result) {
        if (!curUnit) return;
        highlightResult(result);
        const r = await Annotate.save(result);
        if (r && r.ok) {
            toast('已保存: ' + result);
            // 不再自动跳转，等待用户主动点击 保存/下一页/回车
        }
    }

    function highlightResult(result) {
        document.querySelectorAll('.user-bigbtn[data-result]').forEach(b => {
            b.classList.toggle('active', b.dataset.result === result);
        });
    }

    function clearResultHighlight() {
        document.querySelectorAll('.user-bigbtn[data-result]').forEach(b => b.classList.remove('active'));
    }

    async function onSaveOnly() {
        if (!curUnit) return;
        // 复用当前 result（如有）
        const s = statusMap[String(curUnit.id)];
        const result = s ? s.result : '不确定';
        const r = await Annotate.save(result);
        if (r && r.ok) {
            toast('已保存');
            await jumpToNextPending();
        }
    }

    async function onNext() {
        if (!curUnit) return;
        // 自动保存当前标注再跳转
        const s = statusMap[String(curUnit.id)];
        const result = s ? s.result : '不确定';
        await Annotate.save(result);
        await jumpToNextPending();
    }

    async function onPrev() {
        if (!curUnit) return;
        // 自动保存当前标注再跳转
        const s = statusMap[String(curUnit.id)];
        const result = s ? s.result : '不确定';
        await Annotate.save(result);

        const task = curTask;
        if (curIdx > 0) {
            await selectUnit(task.units[curIdx - 1], curIdx - 1, task);
        } else {
            toast('已是第一项');
        }
    }

    async function jumpToNextPending() {
        const task = curTask;
        for (let i = curIdx + 1; i < task.units.length; i++) {
            const s = statusMap[String(task.units[i].id)];
            if (!s || !s.done) {
                await selectUnit(task.units[i], i, task);
                return;
            }
        }
        // 没有则停在当前
        TaskList.renderUnits(task, statusMap);
        TaskList.highlightCurrent(curUnit ? curUnit.id : -1);
    }

    // ===== 登录层 =====
    function showLogin() {
        document.getElementById('user-loading').classList.add('hide');
        const wrap = document.createElement('div');
        wrap.className = 'user-login-wrap';
        wrap.id = 'user-login-wrap';
        wrap.innerHTML =
            '<div class="user-login-card">' +
                '<h2>物流园区判读系统</h2>' +
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
        const doLogin = async () => {
            msg.textContent = '';
            try {
                const r = await API.login(u.value.trim(), p.value);
                if (r.ok) {
                    if (r.role === 'admin') {
                        window.location.href = '/admin';
                    } else {
                        window.location.reload();
                    }
                }
            } catch (e) {
                msg.textContent = '登录失败: ' + e.message;
            }
        };
        btn.addEventListener('click', doLogin);
        [u, p].forEach(el => el.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); }));
    }
})();
