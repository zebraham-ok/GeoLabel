/**
 * admin.js - 管理员后台主控
 */
(function() {
    function toast(msg) {
        const t = document.getElementById('admin-toast');
        t.textContent = msg;
        t.classList.add('show');
        setTimeout(() => t.classList.remove('show'), 2200);
    }

    // 登录处理
    document.getElementById('admin-login-btn').addEventListener('click', doLogin);
    ['admin-login-username', 'admin-login-password'].forEach(id => {
        document.getElementById(id).addEventListener('keydown', e => {
            if (e.key === 'Enter') doLogin();
        });
    });

    async function doLogin() {
        const u = document.getElementById('admin-login-username').value.trim();
        const p = document.getElementById('admin-login-password').value;
        const msg = document.getElementById('admin-login-msg');
        msg.textContent = '';
        try {
            const r = await API.login(u, p);
            if (r.ok && r.role === 'admin') {
                document.getElementById('admin-login-layer').style.display = 'none';
                document.getElementById('admin-app').style.display = 'flex';
                document.getElementById('admin-welcome').textContent = '👤 ' + r.username;
                initAdmin();
            } else {
                msg.textContent = '该账号不是管理员';
            }
        } catch (e) {
            msg.textContent = '登录失败: ' + e.message;
        }
    }

    document.getElementById('admin-logout-btn').addEventListener('click', async () => {
        try { await API.logout(); } catch (e) {}
        window.location.reload();
    });

    // 检查是否已登录
    (async () => {
        try {
            const me = await API.currentUser();
            if (me && me.logged_in && me.role === 'admin') {
                document.getElementById('admin-login-layer').style.display = 'none';
                document.getElementById('admin-app').style.display = 'flex';
                document.getElementById('admin-welcome').textContent = '👤 ' + me.username;
                initAdmin();
            }
        } catch (e) { /* 未登录 */ }
    })();

    // 弹窗
    const modal = document.getElementById('admin-modal');
    document.getElementById('admin-modal-close').addEventListener('click', () => modal.style.display = 'none');
    document.getElementById('admin-modal-ok-btn').addEventListener('click', () => modal.style.display = 'none');

    function showModal(title, html, downloadUrl) {
        document.getElementById('admin-modal-title').textContent = title;
        document.getElementById('admin-modal-body').innerHTML = html;
        const dl = document.getElementById('admin-modal-download-btn');
        if (downloadUrl) {
            dl.style.display = '';
            dl.onclick = () => window.open(downloadUrl, '_blank');
        } else {
            dl.style.display = 'none';
        }
        modal.style.display = 'flex';
    }

    // 主逻辑
    let datasets = [];
    let currentDatasetInfo = null;
    let lastCreatedTaskId = null;

    async function initAdmin() {
        await loadDatasets();
        await loadTasks();
        bindCreateForm();
        document.getElementById('admin-refresh-datasets').addEventListener('click', loadDatasets);
        document.getElementById('admin-refresh-tasks').addEventListener('click', loadTasks);
    }

    async function loadDatasets() {
        const list = document.getElementById('admin-dataset-list');
        list.innerHTML = '<li class="admin-empty">加载中...</li>';
        try {
            datasets = await API.adminDatasets();
            renderDatasets();
            // 同步填充 select
            const sel = document.getElementById('admin-task-dataset');
            sel.innerHTML = '<option value="">-- 请先选择 dataset --</option>' +
                datasets.map(d => {
                    const t = d.type === 'poi' ? '[POI]' : '[判读]';
                    const desc = d.type === 'poi'
                        ? `${d.img_count} PNG / ${d.mask_count} aux`
                        : `${d.img_count} 图 / ${d.mask_count} mask`;
                    return `<option value="${d.name}">${t} ${d.name} (${desc})</option>`;
                }).join('');
        } catch (e) {
            list.innerHTML = '<li class="admin-empty">加载失败: ' + e.message + '</li>';
        }
    }

    function renderDatasets() {
        const list = document.getElementById('admin-dataset-list');
        if (datasets.length === 0) {
            list.innerHTML = '<li class="admin-empty">无数据</li>';
            return;
        }
        list.innerHTML = datasets.map(d => `
            <li class="admin-dataset-item" data-name="${d.name}">
                <div class="ds-name">${d.type === 'poi' ? '📍' : '📁'} ${d.name}
                    <span style="font-size:9px;color:${d.type === 'poi' ? '#ffa726' : '#4ecca3'};margin-left:4px">[${d.type === 'poi' ? 'POI' : '判读'}]</span>
                </div>
                <div class="ds-meta">${d.type === 'poi' ? 'PNG: ' + d.img_count + ' · aux: ' + d.mask_count : 'img: ' + d.img_count + ' · mask: ' + d.mask_count}</div>
            </li>
        `).join('');
        list.querySelectorAll('.admin-dataset-item').forEach(el => {
            el.addEventListener('click', () => {
                list.querySelectorAll('.admin-dataset-item').forEach(x => x.classList.remove('active'));
                el.classList.add('active');
                analyzeDataset(el.dataset.name);
            });
        });
    }

    async function analyzeDataset(name) {
        // 同步下拉框
        document.getElementById('admin-task-dataset').value = name;
        const overview = document.getElementById('admin-dataset-overview');
        overview.style.display = 'block';
        document.getElementById('admin-dataset-name-title').textContent = '📊 ' + name + ' 分析中...';
        document.getElementById('admin-dataset-stats').textContent = '总 unit: 加载中...';
        document.getElementById('admin-per-image-tbody').innerHTML = '<tr><td colspan="3" class="admin-empty">分析中...</td></tr>';

        try {
            const data = await API.adminAnalyzeDataset(name);
            currentDatasetInfo = data;
            document.getElementById('admin-dataset-name-title').textContent =
                (data.type === 'poi' ? '📍 ' : '📊 ') + name +
                (data.type === 'poi' ? ' POI 数据集' : ' 连通集分析');
            document.getElementById('admin-dataset-stats').textContent = '总 unit: ' + data.total_units;
            const rows = data.per_image.map((p, i) => {
                const info = p.lat != null
                    ? `${p.image} <span style="font-size:9px;color:#ffa726">(${p.lat}, ${p.lng})</span>`
                    : p.image;
                return `<tr><td>${i+1}</td><td>${info}</td><td><strong style="color:#4ecca3">${p.num_units}</strong></td></tr>`;
            }).join('');
            document.getElementById('admin-per-image-tbody').innerHTML = rows ||
                '<tr><td colspan="3" class="admin-empty">无数据</td></tr>';
            updateCalcBox();
        } catch (e) {
            document.getElementById('admin-dataset-stats').textContent = '加载失败';
            document.getElementById('admin-per-image-tbody').innerHTML = '<tr><td colspan="3" class="admin-empty">' + e.message + '</td></tr>';
        }
    }

    function bindCreateForm() {
        const form = document.getElementById('admin-create-form');
        // dataset 下拉框变更时自动拉取该数据集信息
        document.getElementById('admin-task-dataset').addEventListener('change', function() {
            const name = this.value;
            if (name) {
                // 同步侧边栏高亮
                document.querySelectorAll('.admin-dataset-item').forEach(x => x.classList.remove('active'));
                const sidebarEl = Array.from(document.querySelectorAll('.admin-dataset-item'))
                    .find(el => el.dataset.name === name);
                if (sidebarEl) sidebarEl.classList.add('active');
                analyzeDataset(name);
            } else {
                currentDatasetInfo = null;
                updateCalcBox();
            }
        });
        // 组数 / 重叠系数变更时自动重算
        ['admin-num-groups', 'admin-overlap'].forEach(id => {
            document.getElementById(id).addEventListener('input', updateCalcBox);
            document.getElementById(id).addEventListener('change', updateCalcBox);
        });

        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const btn = document.getElementById('admin-create-btn');
            if (btn.disabled) return; // 防止重复点击

            const payload = {
                task_name: document.getElementById('admin-task-name').value.trim(),
                dataset: document.getElementById('admin-task-dataset').value,
                num_groups: parseInt(document.getElementById('admin-num-groups').value) || 1,
                overlap_factor: parseInt(document.getElementById('admin-overlap').value) || 1,
                task_type: document.getElementById('admin-task-type').value,
            };
            if (!payload.task_name || !payload.dataset) {
                toast('请填写任务名称和 dataset');
                return;
            }

            // 显示加载中，禁用按钮
            btn.disabled = true;
            btn.textContent = '创建中...';
            btn.style.opacity = '0.6';
            btn.style.cursor = 'not-allowed';

            try {
                const r = await API.adminCreateTask(payload);
                if (r.ok) {
                    lastCreatedTaskId = r.task.task_id;
                    showCreatedAccounts(r.task);
                    form.reset();
                    document.getElementById('admin-num-groups').value = 3;
                    document.getElementById('admin-overlap').value = 1;
                    updateCalcBox();
                    loadTasks();
                }
            } catch (e) {
                toast('创建失败: ' + e.message);
            } finally {
                // 恢复按钮
                btn.disabled = false;
                btn.textContent = '创建任务';
                btn.style.opacity = '';
                btn.style.cursor = '';
            }
        });
    }

    function showCreatedAccounts(task) {
        const rows = task.groups.map(g => `
            <div style="margin-bottom:8px;padding-bottom:8px;border-bottom:1px dashed #333">
                <div class="acc-gid">组 ${g.group_id}</div>
                <div><span class="acc-key">账号:</span><span class="acc-val">${g.username}</span></div>
                <div><span class="acc-key">密码:</span><span class="acc-val">${g.password}</span></div>
                <div><span class="acc-key">标量:</span><span class="acc-val">${g.unit_count} 个</span></div>
            </div>
        `).join('');
        const taskTypeLabel = task.task_type === 'poi'
            ? '<span style="color:#ffa726">[POI]</span>'
            : (task.task_type === 'hybrid'
                ? '<span style="color:#e94560">[Hybrid]</span>'
                : '<span style="color:#4ecca3">[判读]</span>');
        const html = `
            <p style="color:#4ecca3;margin-bottom:10px">✓ 任务已创建（${task.task_id}）${taskTypeLabel}</p>
            <p style="color:#888;margin-bottom:10px;font-size:11px">总 unit: ${task.total_units} · 组数: ${task.num_groups} · 重叠: ${task.overlap_factor}</p>
            <div class="admin-account-list">${rows}</div>
            <p style="color:#888;margin-top:10px;font-size:10px">每组实际分配：${task.units_per_group.join(', ')}</p>
        `;
        showModal('任务创建成功', html, API.adminDownloadUrl(task.task_id));
    }

    function updateCalcBox() {
        const datasetName = document.getElementById('admin-task-dataset').value;
        const numGroups = parseInt(document.getElementById('admin-num-groups').value) || 1;
        const overlap = parseInt(document.getElementById('admin-overlap').value) || 1;
        const overlapContainer = document.getElementById('admin-overlap-row');

        let totalUnits = 0;
        let loading = false;
        let isPoi = false;
        if (currentDatasetInfo && currentDatasetInfo.dataset === datasetName) {
            totalUnits = currentDatasetInfo.total_units;
            isPoi = currentDatasetInfo.type === 'poi';
        } else if (datasetName) {
            loading = true;
        }

        // 重叠系数对所有任务类型均适用
        overlapContainer.style.display = '';

        const effectiveOverlap = overlap;
        const perGroup = totalUnits > 0 ? Math.ceil(totalUnits * effectiveOverlap / numGroups) : 0;
        document.getElementById('admin-calc-total').textContent = loading ? '...' : totalUnits;
        document.getElementById('admin-calc-per-group').textContent = loading ? '...' : perGroup;
    }

    async function loadTasks() {
        const tbody = document.getElementById('admin-tasks-tbody');
        tbody.innerHTML = '<tr><td colspan="7" class="admin-empty">加载中...</tr>';
        try {
            const tasks = await API.adminTasks();
            if (tasks.length === 0) {
                tbody.innerHTML = '<tr><td colspan="7" class="admin-empty">尚无任务</td></tr>';
                return;
            }
            tbody.innerHTML = tasks.map(t => {
                const typeBadge = t.task_type === 'poi'
                    ? '<span style="color:#ffa726;font-size:9px">[POI]</span>'
                    : (t.task_type === 'hybrid'
                        ? '<span style="color:#e94560;font-size:9px">[Hybrid]</span>'
                        : '<span style="color:#4ecca3;font-size:9px">[判读]</span>');
                return `
                <tr>
                    <td><a class="admin-task-link" data-taskid="${t.task_id}" href="#">${t.task_name}</a> ${typeBadge}</td>
                    <td>${t.dataset}</td>
                    <td>${t.num_groups}</td>
                    <td>${t.overlap_factor}</td>
                    <td>${t.total_units}</td>
                    <td><span style="font-size:10px;color:#888">${(t.created_at || '').replace('T', ' ').substring(0, 19)}</span></td>
                    <td>
                        <a class="admin-btn admin-btn-ghost admin-btn-small" href="${API.adminDownloadUrl(t.task_id)}" target="_blank">下载</a>
                        <button class="admin-btn admin-btn-ghost admin-btn-small admin-detail-btn" data-taskid="${t.task_id}">详情</button>
                        <button class="admin-btn admin-btn-danger admin-btn-small admin-delete-btn" data-taskid="${t.task_id}" data-taskname="${t.task_name}">删除</button>
                    </td>
                </tr>
            `;}).join('');

            // 绑定详情按钮和任务名链接事件
            tbody.querySelectorAll('.admin-detail-btn, .admin-task-link').forEach(el => {
                el.addEventListener('click', function(e) {
                    e.preventDefault();
                    showTaskDetail(this.dataset.taskid);
                });
            });

            // 绑定删除按钮
            tbody.querySelectorAll('.admin-delete-btn').forEach(el => {
                el.addEventListener('click', function(e) {
                    e.preventDefault();
                    confirmDeleteTask(this.dataset.taskid, this.dataset.taskname);
                });
            });
        } catch (e) {
            tbody.innerHTML = '<tr><td colspan="7" class="admin-empty">加载失败: ' + e.message + '</td></tr>';
        }
    }

    async function showTaskDetail(taskId) {
        const modal = document.getElementById('admin-detail-modal');
        const body = document.getElementById('admin-detail-body');
        const title = document.getElementById('admin-detail-title');
        const dlBtn = document.getElementById('admin-detail-download-btn');

        modal.style.display = 'flex';
        title.textContent = '加载中...';
        body.innerHTML = '<p class="admin-empty">加载中...</p>';
        dlBtn.style.display = 'none';

        try {
            const d = await API.adminTaskDetail(taskId);
            title.textContent = '📋 ' + d.task_name;

            // 下载按钮
            dlBtn.style.display = '';
            dlBtn.onclick = () => window.open(API.adminDownloadUrl(taskId), '_blank');

            // Meta 信息
            const taskType = d.task_type || 'judge';
            const typeBadge = taskType === 'poi'
                ? '<span style="color:#ffa726;font-weight:bold">📍 POI 判读</span>'
                : '<span style="color:#4ecca3;font-weight:bold">📊 遥感判读</span>';
            const metaHtml = `
                <div class="admin-detail-meta">
                    <span>类型: ${typeBadge}</span>
                    <span>Dataset: <strong>${d.dataset}</strong></span>
                    <span>组数: <strong>${d.num_groups}</strong></span>
                    <span>重叠系数: <strong>${d.overlap_factor}</strong></span>
                    <span>总 unit: <strong>${d.total_units}</strong></span>
                    <span>创建: ${(d.created_at || '').replace('T', ' ').substring(0, 19)}</span>
                </div>`;

            // 各组进度
            const groupsHtml = d.groups.map(g => {
                const pct = g.pct || 0;
                const cls = pct >= 100 ? 'high' : (pct >= 50 ? 'mid' : 'low');
                return `
                <div class="admin-progress-row">
                    <span class="admin-progress-label">${g.group_id}</span>
                    <div class="admin-progress-bar-bg">
                        <div class="admin-progress-bar-fill ${cls}" style="width:${pct}%"></div>
                    </div>
                    <span class="admin-progress-num">${g.done}/${g.unit_count}</span>
                    <span class="admin-progress-pct">${pct}%</span>
                </div>`;
            }).join('');

            const tp = d.total_progress;
            const tpPct = tp.pct || 0;
            const tpCls = tpPct >= 100 ? 'high' : (tpPct >= 50 ? 'mid' : 'low');

            const progressHtml = `
            <div class="admin-detail-section">
                <h4>各组进度</h4>
                <div class="admin-progress-list">
                    ${groupsHtml}
                    <div class="admin-progress-row total">
                        <span class="admin-progress-label">总计</span>
                        <div class="admin-progress-bar-bg">
                            <div class="admin-progress-bar-fill ${tpCls}" style="width:${tpPct}%"></div>
                        </div>
                        <span class="admin-progress-num">${tp.done}/${tp.total}</span>
                        <span class="admin-progress-pct">${tpPct}%</span>
                    </div>
                </div>
            </div>`;

            // 一致性分析 — 三个维度
            const ag = d.agreement;
            const dims = [
                { key: 'binary',         title: '是否判定',   icon: '🔍' },
                { key: 'park_type',      title: '园区类型',   icon: '🏷️' },
                { key: 'transport_modes',title: '运输方式',   icon: '🚛' },
            ];

            let agreementHtml = '<div class="admin-detail-section"><h4>交叉标注一致性</h4>';
            let hasAnyData = false;
            dims.forEach(dim => {
                const a = ag[dim.key];
                if (!a) return;
                if (a.total_overlap === 0) {
                    agreementHtml += `<p class="admin-detail-none" style="font-size:11px">${dim.icon} ${dim.title}：暂无重叠标注数据</p>`;
                    return;
                }
                hasAnyData = true;
                const consistentCls = a.inconsistent === 0 ? ' agree' : '';
                agreementHtml += `
                <div class="admin-agree-dim">
                    <div class="admin-agree-dim-head">${dim.icon} ${dim.title}</div>
                    <div class="admin-agree-stats mini">
                        <div class="admin-agree-card"><div class="val">${a.total_overlap}</div><div class="lbl">重叠</div></div>
                        <div class="admin-agree-card${consistentCls}"><div class="val">${a.consistent}</div><div class="lbl">一致</div></div>
                        <div class="admin-agree-card${a.inconsistent > 0 ? ' disagree' : ''}"><div class="val">${a.inconsistent}</div><div class="lbl">不一致 ${a.inconsistent_ratio}%</div></div>
                    </div>
                    ${a.details.length > 0 ? renderDisagreeDetails(dim.key, dim.title, a.details) : '<p class="admin-detail-none" style="font-size:11px">标注全部一致 ✓</p>'}
                </div>`;
            });
            if (!hasAnyData) {
                agreementHtml += '<p class="admin-detail-none">暂无重叠标注数据（重叠系数为 1 或无标注数据）</p>';
            }
            agreementHtml += '</div>';

            body.innerHTML = metaHtml + progressHtml + agreementHtml;

        } catch (e) {
            body.innerHTML = '<p class="admin-empty" style="color:#e94560">加载失败: ' + e.message + '</p>';
        }
    }

    function renderDisagreeDetails(dimKey, dimTitle, details) {
        const items = details.map(d => {
            const annRows = d.annotations.map(a => {
                let valStr;
                if (dimKey === 'binary') {
                    valStr = a.value;
                } else {
                    valStr = Array.isArray(a.value) && a.value.length > 0
                        ? a.value.join(', ') : '（无）';
                }
                const rCls = (dimKey === 'binary' && valStr === '是') ? 'yes' : '';
                return `<span class="di-row"><span class="di-gid">${a.group_id}</span><span class="di-result ${rCls}">${valStr}</span></span>`;
            }).join('');
            const extra = typeof d.component_id === 'number'
                ? ` · 连通集 #${d.component_id}`
                : '';
            return `<div class="admin-disagree-item">
                <div class="di-head">📷 ${d.image}${extra}</div>
                ${annRows}
            </div>`;
        }).join('');
        return `<details class="admin-disagree-details"><summary>查看 ${details.length} 处不一致</summary><div class="admin-disagree-list">${items}</div></details>`;
    }

    // ===== 删除任务 =====
    function confirmDeleteTask(taskId, taskName) {
        const modal = document.getElementById('admin-confirm-modal');
        const body = document.getElementById('admin-confirm-body');
        const okBtn = document.getElementById('admin-confirm-ok-btn');

        body.innerHTML = `<p style="font-size:14px;color:#fff;text-align:center;margin:16px 0;">你确定要删除任务「<strong style="color:#e94560">${taskName}</strong>」吗？</p>
            <p style="font-size:11px;color:#888;text-align:center">该操作将同时删除所有关联账号、标注数据，不可恢复。</p>`;

        modal.style.display = 'flex';

        // 移除旧的监听器并绑定新的
        const newBtn = okBtn.cloneNode(true);
        okBtn.parentNode.replaceChild(newBtn, okBtn);
        newBtn.addEventListener('click', async function() {
            modal.style.display = 'none';
            try {
                const r = await API.adminDeleteTask(taskId);
                if (r.ok) {
                    toast('任务「' + r.deleted_task_name + '」已删除（含 ' + r.removed_accounts + ' 个账号）');
                    loadTasks();
                }
            } catch (e) {
                toast('删除失败: ' + e.message);
            }
        });
    }
})();
