/**
 * api.js - fetch 封装
 */
const API = (function() {
    async function request(url, options = {}) {
        options.credentials = 'include';
        if (options.body && typeof options.body === 'object' && !(options.body instanceof FormData)) {
            options.headers = Object.assign({'Content-Type': 'application/json'}, options.headers || {});
            options.body = JSON.stringify(options.body);
        }
        try {
            const resp = await fetch(url, options);
            const text = await resp.text();
            let data;
            try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
            if (!resp.ok) {
                const msg = (data && (data.error || data.message))
                    || (typeof data === 'string' ? data : null)
                    || ('HTTP ' + resp.status);
                const err = new Error(msg);
                err.status = resp.status;
                err.data = data;
                throw err;
            }
            return data;
        } catch (e) {
            throw e;
        }
    }

    return {
        login: (username, password) => request('/api/login', { method: 'POST', body: { username, password } }),
        logout: () => request('/api/logout', { method: 'POST' }),
        currentUser: () => request('/api/current_user'),

        // 用户任务
        userTasks: () => request('/api/user/tasks'),
        unitStatus: (taskId, groupId) => request('/api/user/unit_status?task_id=' + encodeURIComponent(taskId) + '&group_id=' + encodeURIComponent(groupId)),
        getUnit: (taskId, groupId, unitId) => request('/api/unit/' + encodeURIComponent(taskId) + '/' + encodeURIComponent(groupId) + '/' + unitId),
        submitUnit: (taskId, groupId, unitId, payload) => request('/api/unit/' + encodeURIComponent(taskId) + '/' + encodeURIComponent(groupId) + '/' + unitId + '/submit', { method: 'POST', body: payload }),

        // 管理员
        adminDatasets: () => request('/api/admin/datasets'),
        adminAnalyzeDataset: (name) => request('/api/admin/dataset/' + encodeURIComponent(name) + '/analyze'),
        adminTasks: () => request('/api/admin/tasks'),
        adminCreateTask: (payload) => request('/api/admin/create_task', { method: 'POST', body: payload }),
        adminDownloadUrl: (taskId) => '/api/admin/task/' + encodeURIComponent(taskId) + '/download_accounts',
        adminTaskDetail: (taskId) => request('/api/admin/task/' + encodeURIComponent(taskId) + '/detail'),
        adminDeleteTask: (taskId) => request('/api/admin/task/' + encodeURIComponent(taskId) + '/delete', { method: 'POST' }),
        adminCreateReview: (taskId, payload) => request('/api/admin/task/' + encodeURIComponent(taskId) + '/create_review', { method: 'POST', body: payload }),

        // POI 任务
        getPoiUnit: (taskId, groupId, unitId) => request('/api/poi_unit/' + encodeURIComponent(taskId) + '/' + encodeURIComponent(groupId) + '/' + unitId),
        submitPoiUnit: (taskId, groupId, unitId, payload) => request('/api/poi_unit/' + encodeURIComponent(taskId) + '/' + encodeURIComponent(groupId) + '/' + unitId + '/submit', { method: 'POST', body: payload }),

        // 审核 API
        getReviewUnit: (taskId, groupId, unitId) => request('/api/review/unit/' + encodeURIComponent(taskId) + '/' + encodeURIComponent(groupId) + '/' + unitId),
        submitReviewUnit: (taskId, groupId, unitId, payload) => request('/api/review/unit/' + encodeURIComponent(taskId) + '/' + encodeURIComponent(groupId) + '/' + unitId + '/submit', { method: 'POST', body: payload }),
        reviewUnitStatus: (taskId, groupId) => request('/api/review/unit_status/' + encodeURIComponent(taskId) + '/' + encodeURIComponent(groupId)),
    };
})();

/**
 * 简化文件名用于展示：去扩展名 + 去 B000XXXXXX_ 前缀
 * 例如: "B000A8WDOP_北京西南金港物流园.jpg" → "北京西南金港物流园"
 */
function shortFileName(filename) {
    if (!filename) return '';
    let name = filename.replace(/\.(png|jpe?g|webp|bmp|gif|tiff?)$/i, '');
    name = name.replace(/^[A-Z0-9]+_/, '');
    return name;
}
