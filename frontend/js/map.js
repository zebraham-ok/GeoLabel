/**
 * map.js - 高德地图模块
 */
const UserMap = (function() {
    let map = null;
    let mainMarker = null;
    let searchMarkers = [];
    let placeSearchReady = false;   // PlaceSearch 插件是否就绪

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
        // 以 5 位小数精度（约 1m）作为缓存 key
        const cacheKey = center[0].toFixed(5) + '_' + center[1].toFixed(5);
        console.log('[POI] searchPOI, cacheKey:', cacheKey);

        // 先查后端缓存
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
                ensurePlaceSearch(center, cacheKey);
            })
            .catch(() => {
                // 网络错误时回退到高德搜索
                console.log('[POI] Cache fetch error, fallback to Amap');
                ensurePlaceSearch(center, cacheKey);
            });
    }

    function ensurePlaceSearch(center, cacheKey) {
        if (placeSearchReady && typeof AMap.PlaceSearch !== 'undefined') {
            doSearch(center, cacheKey);
            return;
        }
        AMap.plugin('AMap.PlaceSearch', function() {
            placeSearchReady = true;
            doSearch(center, cacheKey);
        });
    }

    function doSearch(center, cacheKey) {
        console.log('[POI] doSearch, POI_TYPES:', POI_TYPES.length);
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
                        }
                        resolve(pois);
                    });
                } catch (e) {
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
        });
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
