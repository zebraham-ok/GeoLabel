/**
 * map.js - 高德地图模块
 */
const UserMap = (function() {
    let map = null;
    let mainMarker = null;
    let searchMarkers = [];
    const POI_TYPES = [
        ['物流园|物流园区',  '#ef5350', '#b71c1c'],
        ['仓库|仓储',        '#42a5f5', '#0d47a1'],
        ['工业园区',         '#66bb6a', '#1b5e20'],
        ['快递公司|物流公司|货运站|货运中心', '#ffa726', '#e65100'],
        ['批发市场',         '#ab47bc', '#4a148c']
    ];

    function clearMarkers() {
        searchMarkers.forEach(m => { if (m && m.setMap) m.setMap(null); });
        searchMarkers = [];
        if (mainMarker) { mainMarker.setMap(null); mainMarker = null; }
    }

    function init(task) {

        if (!map) {
            map = new AMap.Map('user-map', {
                center: [116.397428, 39.90923],
                zoom: 5,
                mapStyle: 'amap://styles/darkblue',
                layers: [new AMap.TileLayer.Satellite()],
                resizeEnable: true
            });
            map.addControl(new AMap.ToolBar({ position: 'RT' }));
            map.addControl(new AMap.Scale({ position: 'LB' }));
            addLegend();
        }

        clearMarkers();

        if (!task) return;
        const center = [task.lng, task.lat];
        map.setCenter(center);
        map.setZoom(15);

        mainMarker = new AMap.Marker({
            position: center,
            title: task.name,
            zIndex: 1000,
            icon: new AMap.Icon({
                size: new AMap.Size(36, 46),
                image: 'https://webapi.amap.com/theme/v1.3/markers/n/mark_b.png',
                imageSize: new AMap.Size(36, 46)
            })
        });
        const shortName = task.name && task.name.length > 12 ? task.name.substring(0, 12) + '...' : (task.name || '');
        mainMarker.setLabel({
            content: '<div style="background:rgba(0,100,255,0.9);color:#fff;padding:3px 8px;border-radius:4px;font-size:12px;font-weight:bold;white-space:nowrap">' + shortName + '</div>',
            offset: new AMap.Pixel(-50, -50)
        });
        mainMarker.setMap(map);
        searchPOI(center);
    }

    function searchPOI(center) {
        // 防护：确保坐标是有效数值
        const lng = Number(center[0]), lat = Number(center[1]);
        if (isNaN(lng) || isNaN(lat)) {
            console.warn('[POI] Invalid center coordinates:', center);
            return;
        }
        const cacheKey = lng.toFixed(5) + '_' + lat.toFixed(5);
        console.log('[POI] searchPOI, center:', lng, lat, 'cacheKey:', cacheKey);

        // 先查后端缓存
        const searchCenter = [lng, lat];
        fetch('/api/poi_cache?key=' + encodeURIComponent(cacheKey))
            .then(r => r.json())
            .then(data => {
                if (data.found && data.pois && data.pois.length > 0) {
                    console.log('[POI] Cache HIT, rendering', data.pois.length, 'markers');
                    data.pois.forEach(p => renderPOIMarker(p));
                    return;
                }
                // 缓存未命中 → 高德搜索
                console.log('[POI] Cache MISS, searching via Amap...');
                ensurePlaceSearch(searchCenter, cacheKey);
            })
            .catch(() => {
                // 网络错误时回退到高德搜索
                console.log('[POI] Cache fetch error, fallback to Amap');
                ensurePlaceSearch(searchCenter, cacheKey);
            });
    }

    function ensurePlaceSearch(center, cacheKey) {
        // AMap SDK 未就绪时跳过
        if (typeof AMap === 'undefined') {
            console.warn('[POI] AMap SDK not loaded, cannot search');
            return;
        }
        // PlaceSearch 已可用 → 直接搜索
        if (typeof AMap.PlaceSearch !== 'undefined') {
            doSearch(center, cacheKey);
            return;
        }
        // 插件尚未就绪 → 异步加载（含超时兜底）
        let pluginFired = false;
        try {
            AMap.plugin('AMap.PlaceSearch', function() {
                if (!pluginFired) { pluginFired = true; doSearch(center, cacheKey); }
            });
        } catch (e) {
            console.warn('[POI] AMap.plugin error:', e);
        }
        // 兜底：3 秒后如果插件回调仍未触发，再次尝试
        setTimeout(function() {
            if (!pluginFired && typeof AMap !== 'undefined' && typeof AMap.PlaceSearch !== 'undefined') {
                pluginFired = true;
                doSearch(center, cacheKey);
            }
        }, 3000);
    }

    function doSearch(center, cacheKey) {
        console.log('[POI] doSearch, center:', center, 'cacheKey:', cacheKey);
        let firstResultLogged = false;
        let hasAmapError = false;
        let amapErrorMsg = null;
        const promises = POI_TYPES.map(t => {
            return new Promise(resolve => {
                try {
                    const ps = new AMap.PlaceSearch({
                        pageSize: 12,
                        pageIndex: 1,
                        autoFitView: false
                    });
                    ps.searchNearBy(t[0], center, 10000, function(status, result) {
                        const pois = [];
                        // 诊断日志：第一个搜索的原始返回
                        if (!firstResultLogged) {
                            firstResultLogged = true;
                            console.log('[POI] Raw Amap response - status:', status, 'type:', typeof result);
                            console.log('[POI] Raw result keys:', result ? Object.keys(result) : 'null');
                            console.log('[POI] Raw result.poiList:', result ? result.poiList : 'null');
                            console.log('[POI] Raw result.pois:', result ? result.pois : 'null');
                            console.log('[POI] Raw result:', result);
                        }
                        if (status === 'complete' && result && result.poiList) {
                            (result.poiList.pois || []).forEach(p => {
                                pois.push({
                                    name: p.name,
                                    lng: p.location.lng,
                                    lat: p.location.lat,
                                    dotColor: t[1],
                                    bgColor: t[2],
                                    type: t[0]
                                });
                            });
                        } else if (status === 'complete' && result && result.pois) {
                            // v2.0 可能直接返回 result.pois 而非 result.poiList.pois
                            console.log('[POI] Using result.pois directly (v2.0 format)');
                            (result.pois || []).forEach(p => {
                                pois.push({
                                    name: p.name,
                                    lng: p.location.lng,
                                    lat: p.location.lat,
                                    dotColor: t[1],
                                    bgColor: t[2],
                                    type: t[0]
                                });
                            });
                        } else if (status === 'error') {
                            hasAmapError = true;
                            amapErrorMsg = typeof result === 'string' ? result : JSON.stringify(result);
                            console.warn('[POI] Amap API error:', amapErrorMsg, 'keyword:', t[0]);
                        } else if (status !== 'complete') {
                            console.warn('[POI] search status not complete:', status, 'keyword:', t[0]);
                        }
                        resolve(pois);
                    });
                } catch (e) {
                    hasAmapError = true;
                    console.warn('[POI] search error:', t[0], e);
                    resolve([]);
                }
            });
        });

        Promise.all(promises).then(allResults => {
            const allPois = allResults.flat();
            console.log('[POI] Amap search done, total POIs:', allPois.length);

            // 渲染所有 marker
            allPois.forEach(p => renderPOIMarker(p));

            if (allPois.length > 0) {
                // 有结果 → 回存缓存 + 重置全空计数器
                fetch('/api/poi_cache', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ key: cacheKey, pois: allPois })
                }).catch(() => {});
                fetch('/api/amap/reset_counter', { method: 'POST' }).catch(() => {});
            } else if (hasAmapError) {
                // API 错误（如配额耗尽）→ 不缓存空结果，避免永久污染
                console.warn('[POI] Skipping empty-coord cache due to Amap API error');
                showAmapErrorToast(amapErrorMsg);
            } else {
                // 5 类全部为空 → 报告空结果（可能只是该区域真的没有 POI）
                console.log('[POI] All 5 types returned 0 results, recording empty coord...');
                fetch('/api/amap/report_exhausted', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ cache_key: cacheKey })
                }).then(r => r.json()).then(data => {
                    if (data.rotated) {
                        console.warn('[POI] Key rotated! Refresh page to use new key.');
                    }
                    console.log('[POI] Empty coord counter:', data.empty_coords_count + '/' + data.threshold +
                        (data.empty_coords_count >= data.threshold ? ' → threshold reached, key rotated' : ' (not exhausted yet)'));
                }).catch(() => {});
            }
        }).catch(function(e) {
            console.error('[POI] Promise.all failed:', e);
        });
    }

    function showAmapErrorToast(msg) {
        // 移除已有 toast
        const old = document.getElementById('amapErrorToast');
        if (old) old.remove();

        let hint = '高德 POI 搜索服务异常';
        if (msg === 'USER_DAILY_QUERY_OVER_LIMIT') {
            hint = '高德 API 今日配额已用完，POI 搜索暂不可用（明日自动恢复）';
        }

        const toast = document.createElement('div');
        toast.id = 'amapErrorToast';
        toast.style.cssText = 'position:absolute;top:8px;left:50%;transform:translateX(-50%);z-index:2000;' +
            'background:rgba(180,30,30,0.92);color:#fff;padding:8px 18px;border-radius:6px;' +
            'font-size:13px;font-weight:bold;box-shadow:0 2px 12px rgba(0,0,0,0.5);pointer-events:none;' +
            'white-space:nowrap';
        toast.textContent = '⚠ ' + hint;
        map.getContainer().appendChild(toast);

        // 30 秒后自动消失
        setTimeout(function() { if (toast.parentNode) toast.remove(); }, 30000);
    }

    function renderPOIMarker(p) {
        const m = new AMap.Marker({
            position: [p.lng, p.lat],
            title: p.name,
            zIndex: 500,
            content: '<div style="position:relative">' +
                '<div style="width:16px;height:16px;border-radius:50%;background:' + p.dotColor + ';border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,0.5)"></div>' +
                '<div style="position:absolute;left:20px;top:-2px;background:' + p.bgColor + ';color:#fff;padding:2px 5px;border-radius:3px;font-size:9px;white-space:nowrap;max-width:110px;overflow:hidden;text-overflow:ellipsis;box-shadow:0 1px 3px rgba(0,0,0,0.4)">' + p.name + '</div>' +
                '</div>',
            offset: new AMap.Pixel(-8, -8)
        });
        m.setMap(map);
        searchMarkers.push(m);
    }

    function addLegend() {
        if (document.getElementById('userMapLegend')) return;
        const legend = document.createElement('div');
        legend.id = 'userMapLegend';
        legend.style.cssText = 'position:absolute;bottom:8px;left:8px;z-index:100;background:rgba(0,0,0,0.75);padding:6px 8px;border-radius:4px;font-size:9px;color:#ccc;line-height:1.6';
        legend.innerHTML = '<div style="color:#fff;font-weight:bold;margin-bottom:3px">图例</div>' +
            '<span style="color:#ef5350">●</span> 物流园 ' +
            '<span style="color:#42a5f5">●</span> 仓库 ' +
            '<span style="color:#66bb6a">●</span> 工业园 ' +
            '<span style="color:#ffa726">●</span> 货运站 ' +
            '<span style="color:#ab47bc">●</span> 批发市场';
        map.getContainer().appendChild(legend);
    }

    return { init };
})();
