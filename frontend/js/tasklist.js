/**
 * tasklist.js - 左侧任务 + unit 列表渲染
 */
const TaskList = (function() {
    let onSelect = null;
    let activeTaskIdx = 0;

    function setOnSelect(fn) { onSelect = fn; }

    function renderTabs(tasks) {
        const tabs = document.getElementById('user-taskTabs');
        tabs.innerHTML = '';
        if (tasks.length <= 1) {
            tabs.style.display = 'none';
            return;
        }
        tabs.style.display = 'flex';
        tasks.forEach((t, i) => {
            const el = document.createElement('div');
            el.className = 'user-task-tab' + (i === activeTaskIdx ? ' active' : '');
            el.textContent = (t.task_name || t.task_id) + ' [' + t.group_id + ']';
            el.title = 'dataset: ' + t.dataset;
            el.addEventListener('click', () => {
                activeTaskIdx = i;
                renderTabs(tasks);
                renderUnits(tasks[i], {});
                document.getElementById('user-taskHeader').textContent =
                    (t.task_name || t.task_id) + ' · 组 ' + t.group_id;
            });
            tabs.appendChild(el);
        });
    }

    function renderUnits(task, statusMap) {
        const list = document.getElementById('user-unitList');
        list.innerHTML = '';
        const units = task.units || [];
        if (units.length === 0) {
            list.innerHTML = '<div style="padding:20px 10px;font-size:10px;color:#666;text-align:center">本组无标注任务</div>';
            return;
        }
        units.forEach((u, idx) => {
            const s = statusMap[String(u.id)] || null;
            const el = document.createElement('div');
            let cls = 'user-unit-item';
            if (s && s.done) cls += ' status-done';
            el.className = cls;
            el.dataset.unitId = u.id;

            const title = (u.image || '').replace(/\.png$/i, '');
            const short = title.length > 16 ? title.substring(0, 16) + '...' : title;
            el.innerHTML =
                '<div class="user-unit-title">#' + u.id + ' · ' + short + '</div>' +
                '<div class="user-unit-meta">面积: ' + u.area + 'px</div>' +
                (s && s.done ? '<div class="user-unit-result">✓ ' + (s.result || '已标注') + '</div>' : '');

            el.addEventListener('click', () => {
                if (onSelect) onSelect(u, idx);
            });
            list.appendChild(el);
        });
    }

    function highlightCurrent(unitId) {
        document.querySelectorAll('.user-unit-item').forEach(el => {
            el.classList.remove('status-current');
            if (parseInt(el.dataset.unitId, 10) === unitId) {
                el.classList.add('status-current');
                el.scrollIntoView({ block: 'nearest' });
            }
        });
    }

    function setActiveTaskIdx(i) { activeTaskIdx = i; }

    return { renderTabs, renderUnits, highlightCurrent, setOnSelect, setActiveTaskIdx };
})();
