/**
 * Iridium Constellation 3D Globe Visualization
 * Uses CesiumJS for photorealistic 3D Earth rendering + satellite.js (SGP4)
 * for smooth client-side orbital propagation at 30fps.
 *
 * v3.0 — CesiumJS integration. Photorealistic Bing Maps imagery via Cesium
 *         Ion, native 3D satellite entities with orbit tracks, beam coverage
 *         ellipses, and atmospheric glow.  satellite.js SGP4 unchanged.
 */
window.IridiumGlobe = (function () {
    'use strict';

    /* ---- State ---- */
    var _viewer = null;
    var _container = null;
    var _data = null;
    var _showBeams = true;
    var _showOrbits = true;
    var _showHeatmap = false;
    var _onSelect = null;
    var _resizeObs = null;

    /* ---- Layer overlay references ---- */
    var _bordersLayer = null;    // ArcGIS country borders + names tile layer
    var _citiesLayer = null;     // ArcGIS city-labels tile layer
    var _satelliteLayer = null;  // reference to default Bing/Ion base imagery
    var _osmLayer = null;        // OpenStreetMap layer (lazy-created)
    var _beamFillAlpha = 0.14;  // current beam fill transparency (0-0.35)

    /* ---- Entity groups ---- */
    var _satEntities = [];
    var _orbitEntities = [];
    var _beamEntities = [];
    var _heatEntities = [];
    var _spotEntities = [];
    var _observerEntity = null;

    /* ---- Animation state (satellite.js SGP4) ---- */
    var _satrecs = [];
    var _observer = null;
    var _tleList = null;
    var _animId = null;
    var _animBaseEpoch = 0;
    var _animStartWall = 0;
    var _timeScale = 120;
    var _lastBeamUpdate = 0;
    var _lastHeatUpdate = 0;
    var _animCallback = null;

    /* ---- Constants ---- */
    var EARTH_R = 6371.0;
    var DEG = 180 / Math.PI;
    var RAD = Math.PI / 180;
    var TWO_PI = 2 * Math.PI;
    var PLANE_COLORS = ['#ff4444', '#ff8800', '#ffcc00', '#00ff88', '#0088ff', '#aa44ff'];

    var CESIUM_VERSION = '1.139.1';
    var CESIUM_BASE = 'https://cesium.com/downloads/cesiumjs/releases/' + CESIUM_VERSION + '/Build/Cesium/';
    var CESIUM_TOKEN = (window.INTERCEPT_CESIUM_TOKEN || '').trim();

    /* ============================================================
     *  CDN loaders — CesiumJS + satellite.js
     * ============================================================ */
    var _cesiumLoading = null;
    var _satjsLoading = null;

    function _loadCesium() {
        if (window.Cesium) return Promise.resolve();
        if (_cesiumLoading) return _cesiumLoading;
        _cesiumLoading = new Promise(function (ok, fail) {
            console.log('[Globe/Cesium] Loading CesiumJS ' + CESIUM_VERSION + ' from CDN…');
            window.CESIUM_BASE_URL = CESIUM_BASE;
            var link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = CESIUM_BASE + 'Widgets/widgets.css';
            document.head.appendChild(link);
            var s = document.createElement('script');
            s.src = CESIUM_BASE + 'Cesium.js';
            var timer = setTimeout(function () {
                _cesiumLoading = null;
                fail(new Error('CesiumJS CDN load timed out after 20s — check network/firewall'));
            }, 20000);
            s.onload = function () {
                clearTimeout(timer);
                if (window.Cesium) {
                    console.log('[Globe/Cesium] CesiumJS loaded successfully');
                    ok();
                } else {
                    _cesiumLoading = null;
                    fail(new Error('CesiumJS script loaded but Cesium global not found'));
                }
            };
            s.onerror = function () {
                clearTimeout(timer);
                _cesiumLoading = null;
                fail(new Error('Failed to load CesiumJS from ' + CESIUM_BASE + 'Cesium.js'));
            };
            document.head.appendChild(s);
        });
        return _cesiumLoading;
    }

    function _loadSatelliteJs() {
        if (window.satellite) return Promise.resolve();
        if (_satjsLoading) return _satjsLoading;
        _satjsLoading = new Promise(function (ok, fail) {
            var s = document.createElement('script');
            s.src = 'https://unpkg.com/satellite.js@5.0.0/dist/satellite.min.js';
            s.onload = ok;
            s.onerror = function () { _satjsLoading = null; fail(new Error('Failed to load satellite.js')); };
            document.head.appendChild(s);
        });
        return _satjsLoading;
    }

    function _loadLibs() {
        return Promise.all([_loadCesium(), _loadSatelliteJs()]);
    }

    /* ============================================================
     *  Color helper
     * ============================================================ */
    function _cc(hex, alpha) {
        if (!window.Cesium) return null;
        try {
            return Cesium.Color.fromCssColorString(hex || '#888').withAlpha(alpha != null ? alpha : 1);
        } catch (e) {
            return Cesium.Color.GRAY.withAlpha(alpha != null ? alpha : 1);
        }
    }

    /* ============================================================
     *  Geometry helpers
     * ============================================================ */

    /** Generate 48 spot-beam circles around a satellite nadir point. */
    function _spotBeamCoords(satLat, satLon) {
        var beams = [];
        var spotR = 200;
        beams.push({ lat: satLat, lon: satLon, r: spotR });
        var i;
        for (i = 0; i < 6; i++)  beams.push(_offsetPoint(satLat, satLon, 400, i * 60 * RAD, spotR));
        for (i = 0; i < 12; i++) beams.push(_offsetPoint(satLat, satLon, 800, i * 30 * RAD, spotR));
        for (i = 0; i < 18; i++) beams.push(_offsetPoint(satLat, satLon, 1200, i * 20 * RAD, spotR));
        for (i = 0; i < 11; i++) beams.push(_offsetPoint(satLat, satLon, 1600, i * (360 / 11) * RAD, spotR));
        return beams;
    }

    function _offsetPoint(lat, lon, distKm, bearing, spotR) {
        var latR = lat * RAD, lonR = lon * RAD;
        var d = distKm / EARTH_R;
        var pLat = Math.asin(
            Math.sin(latR) * Math.cos(d) + Math.cos(latR) * Math.sin(d) * Math.cos(bearing)
        );
        var pLon = lonR + Math.atan2(
            Math.sin(bearing) * Math.sin(d) * Math.cos(latR),
            Math.cos(d) - Math.sin(latR) * Math.sin(pLat)
        );
        return { lat: pLat * DEG, lon: pLon * DEG, r: spotR };
    }

    /* ============================================================
     *  Visibility calculation (geometric horizon)
     * ============================================================ */
    function _isVisible(satLat, satLon, satAlt, obsLat, obsLon) {
        if (obsLat == null || obsLon == null) return false;
        var dLat = (satLat - obsLat) * RAD;
        var dLon = (satLon - obsLon) * RAD;
        var a = Math.sin(dLat / 2); a *= a;
        var b = Math.sin(dLon / 2); b *= b;
        a += Math.cos(obsLat * RAD) * Math.cos(satLat * RAD) * b;
        var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        var visAngle = Math.acos(EARTH_R / (EARTH_R + satAlt));
        return c < visAngle;
    }

    /* ============================================================
     *  satellite.js SGP4 integration
     * ============================================================ */

    function _initSatrecs(data) {
        _satrecs = [];
        if (!window.satellite) return;
        var sats = data.satellites || [];
        var total = sats.length;
        var perPlane = Math.max(Math.floor(total / 6), 1);

        for (var i = 0; i < total; i++) {
            var s = sats[i];
            if (!s.tle1 || !s.tle2) continue;
            try {
                var satrec = satellite.twoline2satrec(s.tle1, s.tle2);
                var planeIdx = s.plane ? s.plane - 1 : Math.min(Math.floor(i / perPlane), 5);
                _satrecs.push({
                    satrec: satrec,
                    idx: i,
                    name: s.name,
                    norad: s.norad,
                    plane: s.plane || (planeIdx + 1),
                    slot: s.slot || ((i % perPlane) + 1),
                    color: s.color || PLANE_COLORS[planeIdx],
                    beam_radius_km: s.beam_radius_km || 2350,
                    velocity_kms: s.velocity_kms || 7.46,
                    lat: s.lat,
                    lon: s.lon,
                    alt_km: s.alt_km || 780,
                    visible: s.visible || false,
                });
            } catch (e) {
                console.debug('SGP4 init failed for', s.name, e.message);
            }
        }
        _observer = data.observer || null;
    }

    function _propagateAll(dateObj) {
        if (!_satrecs.length || !window.satellite) return;
        var gmst = satellite.gstime(dateObj);

        for (var i = 0; i < _satrecs.length; i++) {
            var sr = _satrecs[i];
            var pv = satellite.propagate(sr.satrec, dateObj);
            if (pv.position && typeof pv.position.x === 'number') {
                var geo = satellite.eciToGeodetic(pv.position, gmst);
                sr.lat = satellite.degreesLat(geo.latitude);
                sr.lon = satellite.degreesLong(geo.longitude);
                sr.alt_km = geo.height;
                if (_observer) {
                    sr.visible = _isVisible(sr.lat, sr.lon, sr.alt_km, _observer.lat, _observer.lon);
                }
            }
        }
    }

    /* ============================================================
     *  Client-side constellation computation from raw TLEs
     * ============================================================ */

    function _buildConstellationData(tles, observer, epochMs, orbitPts) {
        if (!window.satellite || !tles || !tles.length) return null;

        var targetDate = epochMs ? new Date(epochMs) : new Date();
        var gmst = satellite.gstime(targetDate);
        orbitPts = orbitPts || 60;
        var ORBITAL_PERIOD_S = 6024.0;

        var total = tles.length;
        var perPlane = Math.max(Math.floor(total / 6), 1);
        var satellites = [];
        var visibleCount = 0;

        for (var i = 0; i < total; i++) {
            var entry = tles[i];
            if (!entry.tle1 || !entry.tle2) continue;

            var satrec;
            try { satrec = satellite.twoline2satrec(entry.tle1, entry.tle2); }
            catch (e) { continue; }

            var pv = satellite.propagate(satrec, targetDate);
            if (!pv.position || typeof pv.position.x !== 'number') continue;

            var geo = satellite.eciToGeodetic(pv.position, gmst);
            var lat = satellite.degreesLat(geo.latitude);
            var lon = satellite.degreesLong(geo.longitude);
            var alt_km = geo.height;
            var velocity = Math.sqrt(398600.4418 / (EARTH_R + alt_km));

            var visible = false;
            var elevation_deg = null;
            if (observer && observer.lat != null && observer.lon != null) {
                visible = _isVisible(lat, lon, alt_km, observer.lat, observer.lon);
                if (visible) {
                    var dLat = (lat - observer.lat) * RAD;
                    var dLon = (lon - observer.lon) * RAD;
                    var a = Math.sin(dLat / 2); a *= a;
                    var b = Math.sin(dLon / 2); b *= b;
                    a += Math.cos(observer.lat * RAD) * Math.cos(lat * RAD) * b;
                    var angDist = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
                    elevation_deg = Math.round(90 - angDist * DEG);
                    if (elevation_deg < 0) elevation_deg = 0;
                }
            }
            if (visible) visibleCount++;

            var ground_track = [];
            for (var k = 0; k < orbitPts; k++) {
                var frac = k / orbitPts;
                var trackDate = new Date(targetDate.getTime() + frac * ORBITAL_PERIOD_S * 1000);
                var tpv = satellite.propagate(satrec, trackDate);
                if (tpv.position && typeof tpv.position.x === 'number') {
                    var tgmst = satellite.gstime(trackDate);
                    var tgeo = satellite.eciToGeodetic(tpv.position, tgmst);
                    ground_track.push([
                        Math.round(satellite.degreesLat(tgeo.latitude) * 100) / 100,
                        Math.round(satellite.degreesLong(tgeo.longitude) * 100) / 100,
                    ]);
                }
            }

            var planeIdx = Math.min(Math.floor(i / perPlane), 5);
            var satData = {
                id: i + 1,
                norad: entry.norad,
                name: entry.name,
                plane: planeIdx + 1,
                slot: (i % perPlane) + 1,
                lat: Math.round(lat * 10000) / 10000,
                lon: Math.round(lon * 10000) / 10000,
                alt_km: Math.round(alt_km * 10) / 10,
                velocity_kms: Math.round(velocity * 100) / 100,
                ground_track: ground_track,
                beam_radius_km: 2350,
                color: PLANE_COLORS[planeIdx],
                visible: visible,
                tle1: entry.tle1,
                tle2: entry.tle2,
            };
            if (elevation_deg !== null) satData.elevation_deg = elevation_deg;
            satellites.push(satData);
        }

        return {
            status: 'success',
            constellation: {
                name: 'Iridium NEXT',
                altitude_km: 780,
                inclination_deg: 86.4,
                planes: 6,
                sats_per_plane: perPlane,
                total_satellites: satellites.length,
                period_min: 100.4,
                beam_count_per_sat: 48,
            },
            satellites: satellites,
            observer: observer,
            visible_count: visibleCount,
            tle_source: 'celestrak_sgp4',
            tle_count: satellites.length,
            mode: epochMs ? 'session' : 'live',
            timestamp: targetDate.toISOString(),
            _computed_client_side: true,
        };
    }

    /* ============================================================
     *  Cesium Viewer creation
     * ============================================================ */

    function _createViewer(container) {
        console.log('[Globe/Cesium] Creating Cesium Viewer…');
        var hasToken = CESIUM_TOKEN && CESIUM_TOKEN.length > 10;
        if (!hasToken) {
            console.warn('[Globe/Cesium] No Cesium Ion token — using dark globe (no Bing imagery)');
        }
        Cesium.Ion.defaultAccessToken = hasToken ? CESIUM_TOKEN : undefined;

        // Clear any spinner/previous content
        container.innerHTML = '';

        // Credit container must be in the DOM for Cesium to work
        var creditDiv = document.createElement('div');
        creditDiv.style.cssText = 'position:absolute;bottom:0;right:0;font-size:9px;opacity:0.4;pointer-events:none;z-index:1;';
        container.style.position = 'relative';
        container.appendChild(creditDiv);

        try {
            var viewerOpts = {
                timeline: false,
                animation: false,
                homeButton: false,
                geocoder: false,
                baseLayerPicker: false,
                navigationHelpButton: false,
                sceneModePicker: false,
                fullscreenButton: false,
                selectionIndicator: false,
                infoBox: false,
                creditContainer: creditDiv,
                requestRenderMode: false,
                orderIndependentTranslucency: false,
            };
            // Without an Ion token, Bing Maps imagery will crash Cesium
            // with "RangeError: invalid array length" — skip it entirely.
            if (!hasToken) {
                viewerOpts.baseLayer = false;
            }
            var viewer = new Cesium.Viewer(container, viewerOpts);
        } catch (e) {
            throw new Error('Cesium Viewer failed to initialize: ' + e.message + ' — check WebGL support');
        }

        viewer.scene.backgroundColor = Cesium.Color.fromCssColorString('#07071a');
        viewer.scene.globe.enableLighting = false;
        viewer.scene.fog.enabled = false;
        viewer.scene.skyAtmosphere.show = true;
        viewer.scene.globe.depthTestAgainstTerrain = false;
        viewer.scene.globe.showGroundAtmosphere = true;

        // When no token: start with a dark globe face; add OSM as a fallback
        if (!hasToken) {
            viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString('#0d0d22');
            try {
                _osmLayer = viewer.imageryLayers.addImageryProvider(
                    new Cesium.OpenStreetMapImageryProvider({ url: 'https://tile.openstreetmap.org/' })
                );
                _osmLayer.alpha = 0.6;
                _satelliteLayer = null;
            } catch (osmErr) {
                console.warn('[Globe/Cesium] OSM fallback also failed:', osmErr.message);
            }
        }

        /* Smooth wheel zoom — public zoomFactor property (Cesium 1.100+), default is 5.0 */
        var ctrl = viewer.scene.screenSpaceCameraController;
        ctrl.minimumZoomDistance = 200000;   // 200 km floor
        ctrl.maximumZoomDistance = 35000000; // 35,000 km ceiling
        ctrl.zoomFactor = 1.5;               // public API — significantly smoother than default 5.0
        ctrl._zoomFactor = 1.5;              // fallback: private field for older Cesium builds

        /* Save reference to the default Bing/Ion base imagery for style-switching */
        _satelliteLayer = viewer.imageryLayers.get(0);

        /* ---- Tooltip overlay (hover) ---- */
        var tooltip = document.createElement('div');
        tooltip.className = 'globe-tooltip';
        tooltip.style.cssText = 'position:absolute;display:none;pointer-events:none;z-index:100;' +
            'background:rgba(10,14,23,0.92);border:1px solid #1e3a5f;border-radius:6px;' +
            'padding:6px 10px;font:12px monospace;color:#e2e8f0;max-width:320px;' +
            'box-shadow:0 4px 12px rgba(0,0,0,0.6);white-space:nowrap;';
        container.appendChild(tooltip);

        /* ---- Info panel (click) ---- */
        var infoPanel = document.createElement('div');
        infoPanel.className = 'globe-info-panel';
        infoPanel.style.cssText = 'position:absolute;top:40px;right:8px;display:none;z-index:100;' +
            'background:rgba(10,14,23,0.95);border:1px solid #0ea5e9;border-radius:8px;' +
            'padding:12px 16px;font:12px monospace;color:#e2e8f0;max-width:340px;min-width:200px;' +
            'box-shadow:0 6px 24px rgba(0,0,0,0.7);';
        container.appendChild(infoPanel);

        /* ---- Interaction handlers ---- */
        var handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);

        /* Hover tooltip */
        handler.setInputAction(function (ev) {
            var pick = viewer.scene.pick(ev.endPosition);
            if (Cesium.defined(pick) && pick.id && pick.id._meta) {
                tooltip.innerHTML = _buildTooltipHtml(pick.id._meta);
                tooltip.style.display = 'block';
                tooltip.style.left = (ev.endPosition.x + 16) + 'px';
                tooltip.style.top = (ev.endPosition.y - 8) + 'px';
                container.style.cursor = 'pointer';
            } else {
                tooltip.style.display = 'none';
                container.style.cursor = '';
            }
        }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

        /* Click detail panel */
        handler.setInputAction(function (ev) {
            var pick = viewer.scene.pick(ev.position);
            if (Cesium.defined(pick) && pick.id && pick.id._meta) {
                infoPanel.innerHTML = _buildInfoHtml(pick.id._meta);
                infoPanel.style.display = 'block';
                /* Also fire legacy satellite select callback */
                if (pick.id._sat && _onSelect) _onSelect(pick.id._sat);
            } else {
                infoPanel.style.display = 'none';
            }
        }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

        return viewer;
    }

    /* ---- Tooltip / Info panel content builders ---- */

    function _buildTooltipHtml(meta) {
        switch (meta.type) {
            case 'satellite':
                var s = meta.data;
                return '<span style="color:' + (s.color || '#ff8') + '">\u25CF</span> ' +
                    (s.name || 'SAT') +
                    (s.visible ? ' <span style="color:#0f0">\u2713 visible</span>' : '') +
                    '<br>Alt: ' + (s.alt_km ? s.alt_km.toFixed(0) + ' km' : '?') +
                    ' &nbsp; Vel: ' + (s.velocity_kms ? s.velocity_kms.toFixed(2) + ' km/s' : '?');
            case 'beam':
                var b = meta.data;
                return '<span style="color:#ff4444">\u25CE</span> Beam ' + b.beam + ' / Sat ' + b.sat +
                    '<br>Lat: ' + b.lat.toFixed(4) + ' &nbsp; Lon: ' + b.lon.toFixed(4) +
                    (b.freq ? '<br>Freq: ' + (b.freq / 1e6).toFixed(3) + ' MHz' : '');
            case 'mt':
                var m = meta.data;
                return '<span style="color:#ff8c00">\u25CF</span> Mobile Terminal' +
                    '<br>Lat: ' + m.lat.toFixed(4) + ' &nbsp; Lon: ' + m.lon.toFixed(4) +
                    (m.alt ? '<br>Alt: ' + m.alt + ' km' : '') +
                    (m.msg_type ? '<br>Type: 0x' + m.msg_type.toString(16) : '');
            case 'aircraft':
                var ac = meta.data;
                return '<span style="color:#00e5ff">\u2708</span> ' + (ac.label || ac.reg || '?') +
                    (ac.alt ? '<br>FL' + Math.round(ac.alt / 100) + ' (' + ac.alt + ' ft)' : '') +
                    '<br>Lat: ' + ac.lat.toFixed(4) + ' &nbsp; Lon: ' + ac.lon.toFixed(4);
            case 'receiver':
                var rx = meta.data;
                return '<span style="color:#a855f7">\uD83D\uDCE1</span> Receiver (Doppler)' +
                    '<br>Lat: ' + rx.lat.toFixed(4) + ' &nbsp; Lon: ' + rx.lon.toFixed(4) +
                    '<br>HDOP: ' + (rx.hdop || '?');
            case 'satpos':
                var sp = meta.data;
                return '<span style="color:#ff0">\u25CF</span> Sat ' + sp.sat +
                    ' (Beam ' + (sp.beam || '?') + ')' +
                    '<br>Lat: ' + sp.lat.toFixed(4) + ' &nbsp; Lon: ' + sp.lon.toFixed(4) +
                    (sp.alt ? '<br>Alt: ' + sp.alt + ' km' : '');
            case 'observer':
                var ob = meta.data;
                return '<span style="color:#ff0000">\uD83D\uDCCD</span> Observer' +
                    '<br>Lat: ' + ob.lat.toFixed(4) + ' &nbsp; Lon: ' + ob.lon.toFixed(4);
            default:
                return meta.type || 'Entity';
        }
    }

    function _buildInfoHtml(meta) {
        var close = '<div style="float:right;cursor:pointer;color:#888;font-size:16px;" ' +
            'onclick="this.parentElement.style.display=\'none\'">\u2715</div>';
        switch (meta.type) {
            case 'satellite':
                var s = meta.data;
                return close +
                    '<div style="color:' + (s.color || '#ff8') + ';font-size:14px;font-weight:bold;margin-bottom:6px;">' +
                    (s.name || 'Satellite') + '</div>' +
                    '<table style="border-spacing:4px 2px;font-size:12px;">' +
                    _row('NORAD', s.norad || '?') +
                    _row('Plane/Slot', (s.plane || '?') + '/' + (s.slot || '?')) +
                    _row('Latitude', s.lat != null ? s.lat.toFixed(4) + '\u00B0' : '?') +
                    _row('Longitude', s.lon != null ? s.lon.toFixed(4) + '\u00B0' : '?') +
                    _row('Altitude', s.alt_km ? s.alt_km.toFixed(1) + ' km' : '?') +
                    _row('Velocity', s.velocity_kms ? s.velocity_kms.toFixed(2) + ' km/s' : '?') +
                    _row('Beam radius', (s.beam_radius_km || 2350) + ' km') +
                    _row('Visible', s.visible ? '<span style="color:#0f0">Yes</span>' :
                        '<span style="color:#888">No</span>') +
                    (s.elevation_deg != null ? _row('Elevation', s.elevation_deg + '\u00B0') : '') +
                    '</table>';
            case 'beam':
                var b = meta.data;
                return close +
                    '<div style="color:#ff4444;font-size:14px;font-weight:bold;margin-bottom:6px;">' +
                    'Beam ' + b.beam + '</div>' +
                    '<table style="border-spacing:4px 2px;font-size:12px;">' +
                    _row('Satellite', b.sat) +
                    _row('Beam ID', b.beam) +
                    _row('Latitude', b.lat.toFixed(4) + '\u00B0') +
                    _row('Longitude', b.lon.toFixed(4) + '\u00B0') +
                    (b.freq ? _row('Frequency', (b.freq / 1e6).toFixed(3) + ' MHz') : '') +
                    (b.pages ? _row('Pages', b.pages) : '') +
                    (b.tmsi ? _row('TMSI', '0x' + b.tmsi.toString(16).toUpperCase()) : '') +
                    '</table>';
            case 'mt':
                var m = meta.data;
                return close +
                    '<div style="color:#ff8c00;font-size:14px;font-weight:bold;margin-bottom:6px;">' +
                    'Mobile Terminal</div>' +
                    '<table style="border-spacing:4px 2px;font-size:12px;">' +
                    _row('Latitude', m.lat.toFixed(4) + '\u00B0') +
                    _row('Longitude', m.lon.toFixed(4) + '\u00B0') +
                    (m.alt ? _row('Altitude', m.alt + ' km') : '') +
                    (m.msg_type ? _row('Msg Type', '0x' + m.msg_type.toString(16).toUpperCase()) : '') +
                    (m.freq ? _row('Frequency', (m.freq / 1e6).toFixed(3) + ' MHz') : '') +
                    '</table>';
            case 'aircraft':
                var ac = meta.data;
                return close +
                    '<div style="color:#00e5ff;font-size:14px;font-weight:bold;margin-bottom:6px;">' +
                    '\u2708 ' + (ac.label || ac.reg || 'Aircraft') + '</div>' +
                    '<table style="border-spacing:4px 2px;font-size:12px;">' +
                    (ac.reg ? _row('Registration', ac.reg) : '') +
                    (ac.flight ? _row('Flight', ac.flight) : '') +
                    _row('Latitude', ac.lat.toFixed(4) + '\u00B0') +
                    _row('Longitude', ac.lon.toFixed(4) + '\u00B0') +
                    (ac.alt ? _row('Altitude', ac.alt + ' ft (FL' + Math.round(ac.alt / 100) + ')') : '') +
                    (ac.fixes ? _row('Fixes', ac.fixes + ' positions') : '') +
                    '</table>';
            case 'receiver':
                var rx = meta.data;
                return close +
                    '<div style="color:#a855f7;font-size:14px;font-weight:bold;margin-bottom:6px;">' +
                    '\uD83D\uDCE1 Receiver</div>' +
                    '<table style="border-spacing:4px 2px;font-size:12px;">' +
                    _row('Latitude', rx.lat.toFixed(4) + '\u00B0') +
                    _row('Longitude', rx.lon.toFixed(4) + '\u00B0') +
                    _row('HDOP', rx.hdop || '?') +
                    _row('Source', 'Doppler positioning') +
                    '</table>';
            case 'satpos':
                var sp = meta.data;
                return close +
                    '<div style="color:#ff0;font-size:14px;font-weight:bold;margin-bottom:6px;">' +
                    'Satellite ' + sp.sat + '</div>' +
                    '<table style="border-spacing:4px 2px;font-size:12px;">' +
                    _row('Sat ID', sp.sat) +
                    (sp.beam ? _row('Beam', sp.beam) : '') +
                    _row('Latitude', sp.lat.toFixed(4) + '\u00B0') +
                    _row('Longitude', sp.lon.toFixed(4) + '\u00B0') +
                    (sp.alt ? _row('Altitude', sp.alt + ' km') : '') +
                    '</table>';
            case 'observer':
                var ob = meta.data;
                return close +
                    '<div style="color:#ff0000;font-size:14px;font-weight:bold;margin-bottom:6px;">' +
                    '\uD83D\uDCCD Observer</div>' +
                    '<table style="border-spacing:4px 2px;font-size:12px;">' +
                    _row('Latitude', ob.lat.toFixed(4) + '\u00B0') +
                    _row('Longitude', ob.lon.toFixed(4) + '\u00B0') +
                    '</table>';
            default:
                return close + '<div>' + (meta.type || 'Unknown entity') + '</div>';
        }
    }

    function _row(label, value) {
        return '<tr><td style="color:#64748b;padding-right:8px;">' + label +
            '</td><td>' + value + '</td></tr>';
    }

    /* ============================================================
     *  Entity rendering helpers
     * ============================================================ */

    var _webmapEntities = [];  // entities from web_map data overlay
    var _sightedSatIds = null;   // Set of sighted Iridium sat numbers, or null = show all

    function _extractIridiumNumber(name) {
        if (!name) return 0;
        var m = name.match(/(\d+)/);
        return m ? parseInt(m[1], 10) : 0;
    }

    function _removeGroup(arr) {
        if (!_viewer) return;
        for (var i = 0; i < arr.length; i++) {
            try { _viewer.entities.remove(arr[i]); } catch (x) { /* already removed */ }
        }
        arr.length = 0;
    }

    function _applyData(data) {
        if (!_viewer || !data) return;
        var sats = data.satellites || [];
        var obs = data.observer;
        _applyPoints(sats, obs);
        _applyPaths(sats);
        _applyBeams(sats);
        _applyHeatmap(sats);
    }

    function _applyPoints(sats, obs) {
        _removeGroup(_satEntities);
        if (_observerEntity) {
            try { _viewer.entities.remove(_observerEntity); } catch (x) {}
            _observerEntity = null;
        }

        for (var i = 0; i < sats.length; i++) {
            var s = sats[i];
            var e = _viewer.entities.add({
                position: Cesium.Cartesian3.fromDegrees(s.lon, s.lat, (s.alt_km || 780) * 1000),
                point: {
                    pixelSize: s.visible ? 16 : 10,
                    color: _cc(s.color, s.visible ? 1.0 : 0.6),
                    outlineColor: _cc(s.color, 0.6),
                    outlineWidth: s.visible ? 4 : 2,
                    scaleByDistance: new Cesium.NearFarScalar(1e6, 1.5, 5e7, 0.9),
                    // No disableDepthTestDistance — Earth globe naturally occludes
                    // satellites on the far side via the depth buffer.
                },
                label: {
                    text: s.name || ('SAT ' + (i + 1)),
                    font: '14px monospace',
                    fillColor: _cc(s.color, 0.9),
                    outlineColor: Cesium.Color.BLACK,
                    outlineWidth: 2,
                    style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                    pixelOffset: new Cesium.Cartesian2(0, -14),
                    scaleByDistance: new Cesium.NearFarScalar(1e6, 1.0, 5e7, 0.3),
                    distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 3e7),
                    // Labels also respect depth — hidden when satellite is behind Earth.
                },
                _sat: s,
                _meta: { type: 'satellite', data: s },
            });
            _satEntities.push(e);
        }

        if (obs && obs.lat != null && obs.lon != null) {
            _observerEntity = _viewer.entities.add({
                position: Cesium.Cartesian3.fromDegrees(obs.lon, obs.lat, 0),
                point: {
                    pixelSize: 12,
                    color: Cesium.Color.RED,
                    outlineColor: Cesium.Color.RED.withAlpha(0.3),
                    outlineWidth: 4,
                    disableDepthTestDistance: Number.POSITIVE_INFINITY,
                },
                label: {
                    text: '\uD83D\uDCCD Observer',
                    font: '12px sans-serif',
                    fillColor: Cesium.Color.RED,
                    outlineColor: Cesium.Color.BLACK,
                    outlineWidth: 2,
                    style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                    pixelOffset: new Cesium.Cartesian2(0, -20),
                    disableDepthTestDistance: Number.POSITIVE_INFINITY,
                },
                _meta: { type: 'observer', data: obs },
            });
        }
    }

    function _applyPaths(sats) {
        _removeGroup(_orbitEntities);
        if (!_showOrbits) return;

        for (var i = 0; i < sats.length; i++) {
            var s = sats[i];
            if (!s.ground_track || !s.ground_track.length) continue;

            var positions = [];
            for (var k = 0; k < s.ground_track.length; k++) {
                var pt = s.ground_track[k];
                positions.push(Cesium.Cartesian3.fromDegrees(pt[1], pt[0], 5000));
            }

            var e = _viewer.entities.add({
                polyline: {
                    positions: positions,
                    width: 1.5,
                    material: new Cesium.PolylineDashMaterialProperty({
                        color: _cc(s.color, s.visible ? 0.5 : 0.15),
                        dashLength: 16,
                    }),
                    clampToGround: false,
                },
            });
            _orbitEntities.push(e);
        }
    }

    function _applyBeams(sats) {
        _removeGroup(_beamEntities);
        if (!_showBeams) return;

        for (var i = 0; i < sats.length; i++) {
            var s = sats[i];
            var radius = (s.beam_radius_km || 2350) * 1000;
            var e = _viewer.entities.add({
                position: Cesium.Cartesian3.fromDegrees(s.lon, s.lat),
                ellipse: {
                    semiMinorAxis: radius,
                    semiMajorAxis: radius,
                    material: _cc(s.color, s.visible ? _beamFillAlpha : _beamFillAlpha * 0.2),
                    outline: true,
                    outlineColor: _cc(s.color, s.visible ? Math.min(1, _beamFillAlpha * 3.5) : Math.min(1, _beamFillAlpha * 0.85)),
                    outlineWidth: 1,
                    height: 0,
                },
            });
            _beamEntities.push(e);
        }
    }

    function _applyHeatmap(sats) {
        _removeGroup(_heatEntities);
        if (!_showHeatmap || !sats.length) return;

        for (var i = 0; i < sats.length; i++) {
            var s = sats[i];
            var e = _viewer.entities.add({
                position: Cesium.Cartesian3.fromDegrees(s.lon, s.lat),
                ellipse: {
                    semiMinorAxis: 3000000,
                    semiMajorAxis: 3000000,
                    material: _cc(s.visible ? '#00ff88' : '#0044ff', s.visible ? 0.05 : 0.01),
                    height: 0,
                    outline: false,
                },
            });
            _heatEntities.push(e);
        }
    }

    /* ============================================================
     *  Animation — client-side SGP4 via requestAnimationFrame
     * ============================================================ */

    function startAnimation(baseEpochMs, timeScale, callback) {
        stopAnimation();
        if (!_satrecs.length) return false;

        _animBaseEpoch = baseEpochMs || Date.now();
        _timeScale = timeScale || 120;
        _animStartWall = performance.now();
        _animCallback = callback || null;
        _lastBeamUpdate = 0;
        _lastHeatUpdate = 0;

        _animId = requestAnimationFrame(_animFrame);
        return true;
    }

    function stopAnimation() {
        if (_animId) {
            cancelAnimationFrame(_animId);
            _animId = null;
        }
        _animCallback = null;
    }

    function isAnimating() {
        return _animId !== null;
    }

    var _lastFrameWall = 0;
    function _animFrame(wallNow) {
        if (!_viewer || _viewer.isDestroyed() || !_satrecs.length) { _animId = null; return; }

        if (wallNow - _lastFrameWall < 33) {
            _animId = requestAnimationFrame(_animFrame);
            return;
        }
        _lastFrameWall = wallNow;

        var wallElapsed = (wallNow - _animStartWall) / 1000;
        var simElapsed = wallElapsed * _timeScale;
        var simDate = new Date(_animBaseEpoch + simElapsed * 1000);
        var offsetMin = simElapsed / 60;

        if (offsetMin > 200) {
            _animStartWall = wallNow;
            offsetMin = 0;
        }

        _propagateAll(simDate);

        var visCount = 0;
        for (var i = 0; i < _satrecs.length && i < _satEntities.length; i++) {
            var sr = _satrecs[i];
            var ent = _satEntities[i];

            // Sighted filter: hide satellites not in the sighted set
            var sighted = true;
            if (_sightedSatIds) {
                var satNum = _extractIridiumNumber(sr.name);
                sighted = satNum > 0 && _sightedSatIds.has(satNum);
            }
            ent.show = sighted;

            if (sr.visible && sighted) visCount++;
            ent.position = Cesium.Cartesian3.fromDegrees(sr.lon, sr.lat, sr.alt_km * 1000);
            ent.point.pixelSize = sr.visible ? 16 : 10;
            ent.point.color = _cc(sr.color, sr.visible ? 1.0 : 0.6);
            ent.point.outlineWidth = sr.visible ? 4 : 2;
            ent._sat = sr;
            ent._meta = { type: 'satellite', data: sr };
        }

        if (wallNow - _lastBeamUpdate > 3000) {
            _lastBeamUpdate = wallNow;
            if (_showBeams) {
                for (var j = 0; j < _satrecs.length && j < _beamEntities.length; j++) {
                    var bSighted = true;
                    if (_sightedSatIds) {
                        var bSatNum = _extractIridiumNumber(_satrecs[j].name);
                        bSighted = bSatNum > 0 && _sightedSatIds.has(bSatNum);
                    }
                    _beamEntities[j].show = bSighted;
                    _beamEntities[j].position = Cesium.Cartesian3.fromDegrees(_satrecs[j].lon, _satrecs[j].lat);
                    _beamEntities[j].ellipse.material = _cc(_satrecs[j].color, _satrecs[j].visible ? _beamFillAlpha : _beamFillAlpha * 0.2);
                    _beamEntities[j].ellipse.outlineColor = _cc(_satrecs[j].color, _satrecs[j].visible ? Math.min(1, _beamFillAlpha * 3.5) : Math.min(1, _beamFillAlpha * 0.85));
                }
            }
        }

        if (_showHeatmap && wallNow - _lastHeatUpdate > 5000) {
            _lastHeatUpdate = wallNow;
            for (var h = 0; h < _satrecs.length && h < _heatEntities.length; h++) {
                _heatEntities[h].position = Cesium.Cartesian3.fromDegrees(_satrecs[h].lon, _satrecs[h].lat);
            }
        }

        if (_animCallback) {
            _animCallback({ offsetMin: Math.round(offsetMin), visibleCount: visCount, simDateMs: simDate.getTime() });
        }

        _animId = requestAnimationFrame(_animFrame);
    }

    /* ============================================================
     *  Spot-beam detail overlay
     * ============================================================ */

    function showSpotBeams(sat) {
        if (!_viewer) return;
        var beams = _spotBeamCoords(sat.lat, sat.lon);
        for (var i = 0; i < beams.length; i++) {
            var b = beams[i];
            var e = _viewer.entities.add({
                position: Cesium.Cartesian3.fromDegrees(b.lon, b.lat),
                ellipse: {
                    semiMinorAxis: b.r * 1000,
                    semiMajorAxis: b.r * 1000,
                    material: _cc(sat.color, 0.08),
                    outline: true,
                    outlineColor: _cc(sat.color, 0.3),
                    outlineWidth: 1,
                    height: 0,
                },
            });
            _spotEntities.push(e);
        }
    }

    function clearSpotBeams() {
        _removeGroup(_spotEntities);
    }

    /* ============================================================
     *  Toggle controls
     * ============================================================ */

    function toggleBeams(show) {
        _showBeams = show;
        var sats = (_animId && _satrecs.length) ? _satrecs : (_data ? _data.satellites || [] : []);
        _applyBeams(sats);
    }

    function toggleOrbits(show) {
        _showOrbits = show;
        if (_data) _applyPaths(_data.satellites || []);
    }

    function toggleHeatmap(show) {
        _showHeatmap = show;
        var sats = (_animId && _satrecs.length) ? _satrecs : (_data ? _data.satellites || [] : []);
        _applyHeatmap(sats);
    }

    function setTimeScale(scale) {
        _timeScale = Math.max(1, Math.min(600, scale));
    }

    /* ============================================================
     *  Map style + layer toggles
     * ============================================================ */

    function setMapStyle(style) {
        if (!_viewer) return;
        var layers = _viewer.imageryLayers;
        if (!_satelliteLayer) _satelliteLayer = layers.get(0);

        if (style === 'satellite') {
            if (_osmLayer && layers.contains(_osmLayer)) _osmLayer.show = false;
            if (_satelliteLayer && layers.contains(_satelliteLayer)) _satelliteLayer.show = true;
            _viewer.scene.globe.baseColor = Cesium.Color.WHITE;
        } else if (style === 'osm') {
            if (_satelliteLayer && layers.contains(_satelliteLayer)) _satelliteLayer.show = false;
            if (!_osmLayer || !layers.contains(_osmLayer)) {
                _osmLayer = layers.addImageryProvider(
                    new Cesium.OpenStreetMapImageryProvider({ url: 'https://tile.openstreetmap.org/' }), 0
                );
            } else {
                _osmLayer.show = true;
            }
            _viewer.scene.globe.baseColor = Cesium.Color.WHITE;
        } else if (style === 'dark') {
            if (_satelliteLayer && layers.contains(_satelliteLayer)) _satelliteLayer.show = false;
            if (_osmLayer && layers.contains(_osmLayer)) _osmLayer.show = false;
            _viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString('#0d0d22');
        }
    }

    function toggleBorders(show) {
        if (!_viewer) return;
        var layers = _viewer.imageryLayers;
        if (!show) {
            if (_bordersLayer && layers.contains(_bordersLayer)) {
                layers.remove(_bordersLayer, true);
                _bordersLayer = null;
            }
            return;
        }
        if (_bordersLayer && layers.contains(_bordersLayer)) { _bordersLayer.show = true; return; }
        _bordersLayer = layers.addImageryProvider(new Cesium.UrlTemplateImageryProvider({
            url: 'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
            credit: 'Esri',
            minimumLevel: 0,
            maximumLevel: 10,
        }));
        _bordersLayer.alpha = 0.9;
    }

    function toggleCities(show) {
        if (!_viewer) return;
        var layers = _viewer.imageryLayers;
        if (!show) {
            if (_citiesLayer && layers.contains(_citiesLayer)) {
                layers.remove(_citiesLayer, true);
                _citiesLayer = null;
            }
            return;
        }
        if (_citiesLayer && layers.contains(_citiesLayer)) { _citiesLayer.show = true; return; }
        _citiesLayer = layers.addImageryProvider(new Cesium.UrlTemplateImageryProvider({
            url: 'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Reference_Overlay/MapServer/tile/{z}/{y}/{x}',
            credit: 'Esri',
            minimumLevel: 0,
            maximumLevel: 10,
        }));
        _citiesLayer.alpha = 0.85;
    }

    function setBeamAlpha(pct) {
        _beamFillAlpha = Math.max(0.001, parseFloat(pct) / 100 * 0.35);
        var sats = (_animId && _satrecs.length) ? _satrecs : (_data ? _data.satellites || [] : []);
        _applyBeams(sats);
    }

    /* ============================================================
     *  Camera / focus
     * ============================================================ */

    function focusSatellite(sat) {
        if (!_viewer) return;
        _viewer.camera.flyTo({
            destination: Cesium.Cartesian3.fromDegrees(sat.lon, sat.lat, 10000000),
            duration: 0.8,
        });
    }

    function focusObserver(obs) {
        if (!_viewer) return;
        _viewer.camera.flyTo({
            destination: Cesium.Cartesian3.fromDegrees(obs.lon, obs.lat, 20000000),
            duration: 0.8,
        });
    }

    /* ============================================================
     *  Lifecycle
     * ============================================================ */

    async function createFromTLEs(container, epochMs, orbitPts) {
        var statusEl = document.getElementById('globeStatus');
        if (statusEl) statusEl.textContent = '⏳ Loading CesiumJS library (~4 MB)…';
        await _loadLibs();
        if (statusEl) statusEl.textContent = '⏳ Fetching TLE data…';

        var res = await fetch('/api/tles');
        var json = await res.json();
        if (json.status !== 'success' || !json.tles || !json.tles.length) {
            throw new Error(json.message || 'No TLE data available');
        }

        var t0 = performance.now();
        var data = _buildConstellationData(json.tles, json.observer, epochMs, orbitPts);
        var elapsed = Math.round(performance.now() - t0);
        console.log('[Globe/Cesium] Client-side constellation computed in ' + elapsed + 'ms (' + (data ? data.satellites.length : 0) + ' sats)');

        if (!data) throw new Error('satellite.js computation failed');
        data.tle_age_min = json.tle_age_min;
        _tleList = json.tles;
        _container = container;
        _data = data;

        if (statusEl) statusEl.textContent = '⏳ Initializing 3D viewer…';
        _viewer = _createViewer(container);
        console.log('[Globe/Cesium] Viewer created, applying data…');
        _applyData(data);
        _initSatrecs(data);

        var home = data.observer
            ? Cesium.Cartesian3.fromDegrees(data.observer.lon, data.observer.lat, 20000000)
            : Cesium.Cartesian3.fromDegrees(0, 30, 20000000);
        _viewer.camera.flyTo({ destination: home, duration: 1.0 });

        _resizeObs = new ResizeObserver(function () {
            if (_viewer && !_viewer.isDestroyed()) _viewer.resize();
        });
        _resizeObs.observe(container);

        return data;
    }

    async function create(container, data) {
        await _loadLibs();
        _container = container;
        _data = data;

        _viewer = _createViewer(container);
        _applyData(data);
        _initSatrecs(data);

        var home = data.observer
            ? Cesium.Cartesian3.fromDegrees(data.observer.lon, data.observer.lat, 20000000)
            : Cesium.Cartesian3.fromDegrees(0, 30, 20000000);
        _viewer.camera.flyTo({ destination: home, duration: 1.0 });

        _resizeObs = new ResizeObserver(function () {
            if (_viewer && !_viewer.isDestroyed()) _viewer.resize();
        });
        _resizeObs.observe(container);

        return _viewer;
    }

    function updateData(data) {
        _data = data;
        try { _applyData(data); } catch (e) { console.debug('Globe update skipped:', e.message); }
        _initSatrecs(data);
    }

    function recomputeAt(epochMs) {
        if (!_tleList || !_viewer) return null;
        var data = _buildConstellationData(_tleList, _observer, epochMs, 60);
        if (data) {
            _data = data;
            _applyData(data);
            _initSatrecs(data);
        }
        return data;
    }

    function zoomIn() {
        if (!_viewer || _viewer.isDestroyed()) return;
        var h = _viewer.camera.positionCartographic.height;
        _viewer.camera.zoomIn(h * 0.4);
    }

    function zoomOut() {
        if (!_viewer || _viewer.isDestroyed()) return;
        var h = _viewer.camera.positionCartographic.height;
        _viewer.camera.zoomOut(h * 0.5);
    }

    function resetView() {
        if (!_viewer || _viewer.isDestroyed()) return;
        if (_observer && _observer.lat != null && _observer.lon != null) {
            _viewer.camera.flyTo({
                destination: Cesium.Cartesian3.fromDegrees(_observer.lon, _observer.lat, 20000000),
                duration: 1.5,
            });
        } else {
            _viewer.camera.flyHome(1.5);
        }
    }

    function onSatelliteSelect(fn) { _onSelect = fn; }

    function resize() {
        if (_viewer && !_viewer.isDestroyed()) _viewer.resize();
    }

    function dispose() {
        stopAnimation();
        _removeGroup(_webmapEntities);
        if (_resizeObs) { _resizeObs.disconnect(); _resizeObs = null; }
        if (_viewer && !_viewer.isDestroyed()) { _viewer.destroy(); }
        _viewer = null;
        _container = null;
        _data = null;
        _satrecs = [];
        _satelliteLayer = null;
        _osmLayer = null;
        _bordersLayer = null;
        _citiesLayer = null;
        _tleList = null;
        _satEntities = [];
        _orbitEntities = [];
        _beamEntities = [];
        _heatEntities = [];
        _spotEntities = [];
        _observerEntity = null;
        _webmapEntities = [];
        _sightedSatIds = null;
    }

    /* ============================================================
     *  Public API
     * ============================================================ */

    return {
        create: create,
        createFromTLEs: createFromTLEs,
        recomputeAt: recomputeAt,
        updateData: updateData,
        startAnimation: startAnimation,
        stopAnimation: stopAnimation,
        isAnimating: isAnimating,
        setTimeScale: setTimeScale,
        toggleBeams: toggleBeams,
        toggleOrbits: toggleOrbits,
        toggleHeatmap: toggleHeatmap,
        zoomIn: zoomIn,
        zoomOut: zoomOut,
        resetView: resetView,
        setMapStyle: setMapStyle,
        toggleBorders: toggleBorders,
        toggleCities: toggleCities,
        setBeamAlpha: setBeamAlpha,
        onSatelliteSelect: onSatelliteSelect,
        focusSatellite: focusSatellite,
        focusObserver: focusObserver,
        showSpotBeams: showSpotBeams,
        clearSpotBeams: clearSpotBeams,
        resize: resize,
        dispose: dispose,
        getViewer: function() { return _viewer; },
        setSightedSatellites: function(idArray) {
            if (!idArray || idArray.length === 0) {
                _sightedSatIds = null;  // show all
            } else {
                _sightedSatIds = new Set(idArray);
            }
            // Also show/hide orbit tracks immediately
            for (var i = 0; i < _satrecs.length && i < _orbitEntities.length; i++) {
                if (_sightedSatIds) {
                    var oNum = _extractIridiumNumber(_satrecs[i].name);
                    _orbitEntities[i].show = oNum > 0 && _sightedSatIds.has(oNum);
                } else {
                    _orbitEntities[i].show = true;
                }
            }
        },
        /* backward compat: truthiness check for _globe */
        get _globe() { return _viewer; },
    };
})();
