// 드론 비행구역 지도 — 브이월드 지도·공역 데이터 (Leaflet)
// 검색: 카카오 키가 있으면 카카오, 없으면 브이월드. 브이월드 키가 없으면 OSM 지도 + 시험용 가짜 구역.
(function () {
  "use strict";
  var CFG = window.DZ_CONFIG || {};

  // ---------- 새 버전 자동 적용 ----------
  // 홈 화면 앱은 켜 둔 화면을 그대로 다시 보여 주므로, 켤 때·돌아올 때 index.html의 app.js?v= 번호를 확인해
  // 지금 것과 다르면 새로 불러온다. (주소 뒤 ?v= 를 바꿔 브라우저 저장본도 건너뜀)
  var MY_VER = ((document.currentScript && /[?&]v=(\d+)/.exec(document.currentScript.src)) || [])[1] || "";
  var lastCheck = 0;
  function checkUpdate() {
    if (!MY_VER || Date.now() - lastCheck < 60000) return;
    lastCheck = Date.now();
    fetch(location.pathname + "?u=" + Date.now(), { cache: "no-store" })
      .then(function (r) { return r.ok ? r.text() : ""; })
      .then(function (t) {
        var m = /app\.js\?v=(\d+)/.exec(t);
        if (!m || m[1] === MY_VER) return;
        // 같은 번호로 이미 한 번 다시 불렀는데도 옛 파일이면 반복하지 않음 (서버 반영 지연 대비)
        var tried = null; try { tried = sessionStorage.getItem("dz_upd"); } catch (e) { /* 무시 */ }
        if (tried === m[1]) return;
        try { sessionStorage.setItem("dz_upd", m[1]); } catch (e) { /* 무시 */ }
        location.replace(location.pathname + "?v=" + m[1] + location.hash);
      })
      .catch(function () { /* 오프라인이면 그냥 둠 */ });
  }
  document.addEventListener("visibilitychange", function () { if (!document.hidden) checkUpdate(); });
  window.addEventListener("pageshow", checkUpdate);
  setTimeout(checkUpdate, 3000);
  var KOREA_BOX = "BOX(124,33,132,39)";
  var CACHE_HOURS = 24;

  var LAYERS = [
    { id: "LT_C_AISPRHC", name: "비행금지구역", desc: "P구역, 비행승인 대상", color: "#e53935", fill: 0.18, on: true, level: "bad" },
    { id: "LT_C_AISRESC", name: "비행제한구역", desc: "R구역, 비행승인 대상", color: "#fb8c00", fill: 0.25, on: true, level: "warn" },
    { id: "LT_C_AISCTRC", name: "관제권", desc: "비행장 반경 9.3km(5NM), 비행승인 대상", color: "#8e24aa", fill: 0.15, on: true, level: "warn" },
    { id: "LT_C_AISFLDC", name: "경량항공기 이착륙장", desc: "반경 3km, 비행승인 대상", color: "#c0a000", fill: 0.15, on: true, level: "warn" },
    { id: "LT_C_AISDNGC", name: "위험구역", desc: "D구역, 비행승인 대상(보수적 적용)", color: "#c2185b", fill: 0.2, on: false, level: "warn" },
    { id: "LT_C_AISALTC", name: "경계구역", desc: "A구역, 주의공역", color: "#6d4c41", fill: 0.15, on: false, level: "caution" },
    { id: "LT_C_AISUAC", name: "초경량비행장치공역", desc: "UA구역, 비행승인 불필요", color: "#43a047", fill: 0.2, on: true, level: "ok" }
  ];

  var $ = function (id) { return document.getElementById(id); };
  var store = {
    get: function (k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 용량 초과 등 무시 */ } }
  };
  var savedOn = store.get("dz_layers_on");
  if (savedOn) LAYERS.forEach(function (L) { if (L.id in savedOn) L.on = !!savedOn[L.id]; });

  // 키: 링크 뒤 #k=키 로 한 번 열면 이 기기에 저장 (주소창에서는 바로 지움)
  var hk = /[#&]k=([0-9A-Fa-f-]{20,})/.exec(location.hash);
  if (hk) {
    store.set("dz_vworld_key", hk[1].toUpperCase());
    try { history.replaceState(null, "", location.pathname + location.search); } catch (e) { /* 무시 */ }
  }
  if (!CFG.vworldKey) CFG.vworldKey = store.get("dz_vworld_key") || "";
  var demo = !CFG.vworldKey;
  var M;             // 지도 어댑터
  var zones = {};    // layerId -> [{props, rings:[[ [lat,lon], ... ], ...]}]  (polygon 단위)
  var shapes = {};   // layerId -> [지도 도형]
  var me = null;     // {lat, lon, acc}
  var watchId = null;

  // ---------- 지도 어댑터 ----------
  function leafletAdapter() {
    var map = window.L.map("map", { zoomControl: false, minZoom: 6, maxZoom: 19 }).setView([37.738, 127.034], 11);
    map.attributionControl.setPrefix("<a href='https://leafletjs.com' target='_blank' rel='noopener'>Leaflet</a>");
    var road, satL;
    if (CFG.vworldKey) {
      // 브이월드 배경지도: 일반 / 위성+지명
      var base = "https://api.vworld.kr/req/wmts/1.0.0/" + encodeURIComponent(CFG.vworldKey) + "/";
      var att = "© 브이월드(국토교통부)";
      road = window.L.tileLayer(base + "Base/{z}/{y}/{x}.png", { maxZoom: 19, attribution: att });
      satL = window.L.layerGroup([
        window.L.tileLayer(base + "Satellite/{z}/{y}/{x}.jpeg", { maxZoom: 19, attribution: att }),
        window.L.tileLayer(base + "Hybrid/{z}/{y}/{x}.png", { maxZoom: 19 })
      ]);
    } else {
      road = window.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" });
      satL = window.L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        { maxZoom: 19, attribution: "Esri" });
    }
    road.addTo(map);
    var meDot = null, meCircle = null, sat = false, clickFn = null, lastPolyClick = 0;
    return {
      kind: "leaflet",
      zoomBy: function (d) { map.setZoom(map.getZoom() + d); },
      polygon: function (rings, L, onClick) {
        var pg = window.L.polygon(rings, { weight: 2, color: L.color, opacity: 0.9, fillColor: L.color, fillOpacity: L.fill });
        pg.on("click", function (e) { lastPolyClick = Date.now(); onClick(e.latlng.lat, e.latlng.lng); });
        return { show: function (v) { if (v) pg.addTo(map); else pg.remove(); } };
      },
      onClick: function (fn) {
        clickFn = fn;
        map.on("click", function (e) { if (Date.now() - lastPolyClick > 300) fn(e.latlng.lat, e.latlng.lng); });
      },
      setMe: function (lat, lon, acc, pan) {
        if (!meDot) {
          meCircle = window.L.circle([lat, lon], { radius: acc, weight: 1, color: "#2563eb", fillOpacity: 0.12 }).addTo(map);
          meDot = window.L.circleMarker([lat, lon], { radius: 8, weight: 3, color: "#fff", fillColor: "#2563eb", fillOpacity: 1 }).addTo(map);
        }
        meDot.setLatLng([lat, lon]); meCircle.setLatLng([lat, lon]); meCircle.setRadius(acc);
        if (pan) map.setView([lat, lon], 14);
      },
      toggleSat: function () {
        sat = !sat;
        if (sat) { map.removeLayer(road); satL.addTo(map); } else { map.removeLayer(satL); road.addTo(map); }
        return sat;
      },
      // 핀: 검색이면 그 자리로 이동(zoom), 지도 누름이면 화면은 그대로
      pin: function (lat, lon, zoom) {
        if (!pinL) {
          var icon = window.L.divIcon({ className: "", html: "<div class='pin'></div>", iconSize: [26, 34], iconAnchor: [13, 34] });
          pinL = window.L.marker([lat, lon], { icon: icon, interactive: false, keyboard: false }).addTo(map);
        }
        pinL.setLatLng([lat, lon]);
        if (zoom) map.setView([lat, lon], Math.max(map.getZoom(), 16));
      },
      popup: function (lat, lon, html) {
        if (!pop) pop = window.L.popup({ className: "pp", maxWidth: 230, minWidth: 120, offset: [0, -30],
          autoPanPaddingTopLeft: [10, 120], autoPanPaddingBottomRight: [70, 30] });
        pop.setLatLng([lat, lon]).setContent(html).openOn(map);
      },
      popupUpdate: function (html) { if (pop && pop.isOpen()) pop.setContent(html); },
      // 공원 경계: 누름을 막지 않는 점선 (판정은 따로 함)
      parkLayer: function (rings, color) {
        var pg = window.L.polygon(rings, { interactive: false, weight: 2, color: color, opacity: 0.95, dashArray: "6 5",
          fillColor: color, fillOpacity: 0.07, smoothFactor: 1.5 });
        return { show: function (v) { if (v) pg.addTo(map); else pg.remove(); } };
      },
      view: function () { var b = map.getBounds(); return { z: map.getZoom(), w: b.getWest(), s: b.getSouth(), e: b.getEast(), n: b.getNorth() }; },
      onMoveEnd: function (fn) { map.on("moveend", fn); }
    };
    var pinL = null, pop = null;
  }

  // ---------- 국립·도립·군립공원 (자연공원법: 관리사무소 허가 필요) ----------
  var PARKS = [
    { id: "LT_C_WGISNPGUG", name: "국립공원", color: "#1E7A3C" },
    { id: "LT_C_WGISNPDO", name: "도립공원", color: "#4D8B2A" },
    { id: "LT_C_WGISNPGUN", name: "군립공원", color: "#6C9A23" }
  ];
  var PARK_MIN_ZOOM = 10;               // 이보다 멀리서 보면 경계를 받지 않음(데이터가 큼)
  var parksOn = store.get("dz_parks_on"); if (parksOn === null) parksOn = true;
  var parkDrawn = {};                    // 이미 그린 공원 (중복 방지)
  var parkShapes = [];
  var parkPointCache = {};

  function vwData(id, geomFilter, extra) {
    var url = "https://api.vworld.kr/req/data?service=data&version=2.0&request=GetFeature&format=json&errorFormat=json" +
      "&size=100&page=1&data=" + id + "&geomFilter=" + encodeURIComponent(geomFilter) + "&crs=EPSG:4326" + (extra || "") +
      "&key=" + encodeURIComponent(CFG.vworldKey) + "&domain=" + encodeURIComponent(CFG.vworldDomain || location.origin);
    return jsonp(url, 20000).then(function (d) {
      var r = d && d.response;
      if (!r || r.status === "NOT_FOUND") return [];
      if (r.status !== "OK") throw new Error((r.error || {}).code || r.status);
      return ((r.result || {}).featureCollection || {}).features || [];
    });
  }

  // 한 점이 어느 공원 안인지 (응답이 작아 빠름). 결과는 [{P, name}]
  function parksAt(lat, lon) {
    if (!CFG.vworldKey) return Promise.resolve([]);
    var k = lat.toFixed(4) + "," + lon.toFixed(4);
    if (parkPointCache[k]) return Promise.resolve(parkPointCache[k]);
    var pt = "POINT(" + lon.toFixed(6) + " " + lat.toFixed(6) + ")";
    var failed = false;
    return Promise.all(PARKS.map(function (P) {
      return vwData(P.id, pt, "&geometry=false").then(function (fs) {
        return fs.map(function (f) { return { P: P, name: (f.properties || {}).park_name || "" }; });
      }, function () { failed = true; return []; });
    })).then(function (rs) {
      var out = [].concat.apply([], rs);
      if (!failed) parkPointCache[k] = out;   // 실패한 결과는 기억하지 않음
      return out;
    });
  }

  // 지금 보이는 범위의 공원 경계 그리기
  var parkTimer = null;
  function refreshParks() {
    clearTimeout(parkTimer);
    parkTimer = setTimeout(function () {
      if (!CFG.vworldKey || !parksOn || !M) return;
      var v = M.view();
      if (v.z < PARK_MIN_ZOOM) return;
      var box = "BOX(" + [v.w, v.s, v.e, v.n].map(function (x) { return x.toFixed(5); }).join(",") + ")";
      PARKS.forEach(function (P) {
        vwData(P.id, box).then(function (fs) {
          fs.forEach(function (f) {
            var g = f.geometry; if (!g) return;
            var key = P.id + "|" + ((f.properties || {}).park_name || "") + "|" + JSON.stringify(g.coordinates).slice(0, 60);
            if (parkDrawn[key]) return;
            parkDrawn[key] = 1;
            toPolys([f]).forEach(function (z) {
              var s = M.parkLayer(z.rings, P.color); s.show(parksOn); parkShapes.push(s);
            });
          });
        }, function () { /* 실패해도 판정은 점 조회로 따로 함 */ });
      });
    }, 400);
  }

  function loadScript(src, ok, fail) {
    var s = document.createElement("script"); s.src = src; s.onload = ok;
    s.onerror = fail || function () { setStatus("<span class='bad'>지도 모듈 로드 실패. 네트워크 연결을 확인하십시오.</span>"); };
    document.head.appendChild(s);
  }

  function startMap() {
    var css = document.createElement("link"); css.rel = "stylesheet";
    css.href = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css"; document.head.appendChild(css);
    loadScript("https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js", function () { M = leafletAdapter(); afterMap(); });
    // 검색용 카카오 (키가 있을 때만). 지도는 브이월드 그대로.
    if (CFG.kakaoKey) {
      loadScript("https://dapi.kakao.com/v2/maps/sdk.js?autoload=false&libraries=services&appkey=" + encodeURIComponent(CFG.kakaoKey), function () {
        window.kakao.maps.load(function () { kakaoReady = true; });
      }, function () { /* 실패하면 브이월드 검색으로 */ });
    }
  }
  var kakaoReady = false;

  // ---------- 검색 ----------
  function search(q) {
    if (kakaoReady) return kakaoSearch(q);
    if (CFG.vworldKey) return vworldSmartSearch(q);
    return fetch("https://nominatim.openstreetmap.org/search?format=json&countrycodes=kr&limit=8&accept-language=ko&q=" + encodeURIComponent(q))
      .then(function (r) { return r.json(); })
      .then(function (d) { return d.map(function (x) { return { name: x.display_name.split(",")[0], sub: x.display_name, lat: +x.lat, lon: +x.lon }; }); });
  }

  // 카카오: 주소 + 장소 이름(아파트·상호)
  function kakaoSearch(q) {
    var svc = window.kakao.maps.services;
    var places = new Promise(function (res) {
      new svc.Places().keywordSearch(q, function (d, st) {
        res(st === svc.Status.OK ? d.map(function (x) {
          return { name: x.place_name, sub: x.road_address_name || x.address_name, lat: +x.y, lon: +x.x };
        }) : []);
      }, { size: 15 });
    });
    var addrs = new Promise(function (res) {
      new svc.Geocoder().addressSearch(q, function (d, st) {
        res(st === svc.Status.OK ? d.map(function (x) {
          return { name: x.address_name, sub: (x.road_address && x.road_address.address_name) || "", lat: +x.y, lon: +x.x };
        }) : []);
      });
    });
    return Promise.all([addrs, places]).then(function (r) { return r[0].concat(r[1]); });
  }

  // 브이월드: "의정부 루엘리안"처럼 지역+이름이면, 이름만으로 다시 찾아 지역 맞는 것을 앞으로
  function vworldSmartSearch(q) {
    return vworldSearch(q).then(function (list) {
      var words = q.split(/\s+/).filter(Boolean);
      if (list.length >= 3 || words.length < 2) return list;
      var name = words[words.length - 1], region = words.slice(0, -1);
      return vworldSearch(name).then(function (more) {
        var hit = function (r) { return region.every(function (w) { return (r.name + " " + r.sub).indexOf(w) >= 0; }); };
        var seen = {}; list.forEach(function (r) { seen[r.name + "|" + r.sub] = 1; });
        more = more.filter(function (r) { return !seen[r.name + "|" + r.sub]; });
        return list.concat(more.filter(hit), more.filter(function (r) { return !hit(r); }));
      });
    });
  }

  // ---------- 브이월드 데이터 ----------
  var jsonpSeq = 0;
  function jsonp(url, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var name = "dzcb" + (++jsonpSeq) + "_" + Date.now();
      var s = document.createElement("script");
      var timer = setTimeout(function () { cleanup(); reject(new Error("응답 시간 초과")); }, timeoutMs || 20000);
      function cleanup() { clearTimeout(timer); try { delete window[name]; } catch (e) { window[name] = undefined; } s.remove(); }
      window[name] = function (data) { cleanup(); resolve(data); };
      s.onerror = function () { cleanup(); reject(new Error("요청 실패")); };
      s.src = url + "&callback=" + name;
      document.head.appendChild(s);
    });
  }

  function fetchLayer(L) {
    var all = [];
    var domain = CFG.vworldDomain || location.origin;
    function page(n) {
      var url = "https://api.vworld.kr/req/data?service=data&version=2.0&request=GetFeature&format=json&errorFormat=json" +
        "&size=1000&page=" + n + "&data=" + L.id + "&geomFilter=" + encodeURIComponent(KOREA_BOX) +
        "&crs=EPSG:4326&key=" + encodeURIComponent(CFG.vworldKey) + "&domain=" + encodeURIComponent(domain);
      return jsonp(url).then(function (d) {
        var r = d && d.response;
        if (!r) throw new Error("응답 형식이 다릅니다");
        if (r.status === "NOT_FOUND") return all;
        if (r.status !== "OK") {
          var er = r.error || {};
          var hint = /KEY/.test(er.code || "") ? " (인증키 또는 등록 도메인 확인)" : "";
          throw new Error((er.code || r.status) + " " + (er.text || "") + hint);
        }
        var fc = (r.result && r.result.featureCollection) || {};
        all = all.concat(fc.features || []);
        var pg = r.page || {};
        if (+pg.current < +pg.total) return page(n + 1);
        return all;
      });
    }
    return page(1);
  }

  // 브이월드 검색: 도로명주소 + 지번주소 + 장소이름을 한 번에 찾아 합침
  function vworldSearch(q) {
    var domain = CFG.vworldDomain || location.origin;
    function one(type, category) {
      var url = "https://api.vworld.kr/req/search?service=search&request=search&version=2.0&crs=EPSG:4326&size=10&page=1" +
        "&format=json&errorformat=json&type=" + type + (category ? "&category=" + category : "") +
        "&query=" + encodeURIComponent(q) + "&key=" + encodeURIComponent(CFG.vworldKey) + "&domain=" + encodeURIComponent(domain);
      return jsonp(url, 15000).then(function (d) {
        var r = d && d.response;
        if (!r || r.status !== "OK") {
          if (r && r.status === "ERROR") throw new Error(((r.error || {}).code || "") + " " + ((r.error || {}).text || ""));
          return [];
        }
        return ((r.result || {}).items || []).map(function (it) {
          var a = it.address || {}, p = it.point || {};
          var name = type === "place" ? it.title : (category === "road" ? a.road : a.parcel) || it.title;
          var sub = type === "place" ? (a.road || a.parcel || "") : (category === "road" ? a.parcel : a.road) || "";
          return { name: name || "", sub: sub || "", lat: +p.y, lon: +p.x };
        });
      }, function () { return []; });
    }
    return Promise.all([one("address", "road"), one("address", "parcel"), one("place")]).then(function (rs) {
      var out = [], seen = {};
      rs.forEach(function (list) { list.forEach(function (r) {
        // 같은 주소(건물 동마다 좌표만 다른 것)는 하나만
        var k = (r.name + "|" + r.sub).replace(/\s+/g, "");
        if (isFinite(r.lat) && !seen[k]) { seen[k] = 1; out.push(r); }
      }); });
      return out;
    });
  }

  function demoFeatures(L) {
    // 키가 없을 때 화면 시험용. 실제 구역이 아님.
    var c = { LT_C_AISPRHC: [37.76, 127.00], LT_C_AISRESC: [37.70, 127.10], LT_C_AISCTRC: [37.66, 126.98],
      LT_C_AISUAC: [37.80, 127.12], LT_C_AISFLDC: [37.72, 126.92] }[L.id];
    if (!c) return [];
    var ring = [];
    for (var i = 0; i <= 40; i++) {
      var a = i / 40 * 2 * Math.PI;
      ring.push([c[1] + 0.04 * Math.cos(a), c[0] + 0.03 * Math.sin(a)]);
    }
    return [{ type: "Feature", properties: { name: "시험용 가짜 구역 (" + L.name + ")" },
      geometry: { type: "Polygon", coordinates: [ring] } }];
  }

  // GeoJSON -> 폴리곤 목록 ([lat,lon] 고리)
  function toPolys(features) {
    var out = [];
    features.forEach(function (f) {
      var g = f.geometry; if (!g) return;
      var polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
      polys.forEach(function (rings) {
        out.push({ props: f.properties || {}, rings: rings.map(function (r) { return r.map(function (p) { return [p[1], p[0]]; }); }) });
      });
    });
    return out;
  }

  function loadAll(force) {
    LAYERS.forEach(function (L) { (shapes[L.id] || []).forEach(function (s) { s.show(false); }); shapes[L.id] = []; zones[L.id] = []; });
    var fails = [], done = 0;
    setStatus("공역 데이터 수신 중 (0/" + LAYERS.length + ")");
    return Promise.all(LAYERS.map(function (L) {
      var key = "dz_cache_v1_" + L.id, c = store.get(key);
      var p;
      if (demo) p = Promise.resolve(demoFeatures(L));
      else if (!force && c && Date.now() - c.t < CACHE_HOURS * 3600e3) p = Promise.resolve(c.f);
      else p = fetchLayer(L).then(function (f) { store.set(key, { t: Date.now(), f: f }); return f; });
      return p.then(function (f) { addLayer(L, f); }, function (e) {
        fails.push(L.name + ": " + e.message);
        if (c) addLayer(L, c.f); // 실패하면 지난번 받은 것이라도
      }).then(function () { done++; setStatus("공역 데이터 수신 중 (" + done + "/" + LAYERS.length + ")"); });
    })).then(function () {
      var n = LAYERS.reduce(function (s, L) { return s + zones[L.id].length; }, 0);
      var msg = demo ? "<span class='demo'>시험 모드: 인증키 미등록 상태로 예시 공역과 일반 지도를 표시합니다.</span>" +
                       "<button id='bKey' class='key-btn' type='button'>인증키 입력</button>"
                     : "<b>공역 " + n + "개소</b> 수신 완료. 지점을 선택하면 비행승인 여부를 판정합니다.";
      if (fails.length) msg += "<br><span class='bad'>수신 실패: " + fails.join(", ") + ". 공역 데이터 갱신으로 재시도하십시오.</span>";
      setStatus(msg);
      var bk = $("bKey");
      if (bk) bk.onclick = function () {
        var k = (window.prompt("브이월드 인증키를 입력하십시오") || "").trim();
        if (/^[0-9A-Fa-f-]{20,}$/.test(k)) { store.set("dz_vworld_key", k.toUpperCase()); location.reload(); }
      };
      if (me) judge(me.lat, me.lon, true);
    });
  }

  function addLayer(L, features) {
    zones[L.id] = toPolys(features);
    shapes[L.id] = zones[L.id].map(function (z) {
      var s = M.polygon(z.rings, L, function (lat, lon) { inspect(lat, lon); });
      s.show(L.on); return s;
    });
  }

  // ---------- 판정 ----------
  function inRing(lat, lon, ring) {
    var inside = false;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var yi = ring[i][0], xi = ring[i][1], yj = ring[j][0], xj = ring[j][1];
      if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function inPoly(lat, lon, rings) {
    if (!inRing(lat, lon, rings[0])) return false;
    for (var h = 1; h < rings.length; h++) if (inRing(lat, lon, rings[h])) return false;
    return true;
  }
  function hits(lat, lon) {
    var out = [];
    LAYERS.forEach(function (L) {
      zones[L.id].forEach(function (z) { if (inPoly(lat, lon, z.rings)) out.push({ L: L, z: z }); });
    });
    return out;
  }

  function clean(v) { return String(v).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim(); }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  // 고도 글자 해석: "5 000 AMSL" → 해발 5,000ft(1,524m), "500FT HEI"/"1 000 AGL" → 지상 …, FL180, GND/SFC, UNL
  function parseAlt(s) {
    var t = String(s).toUpperCase().replace(/\s+/g, " ").trim();
    if (/^(GND|SFC)$/.test(t)) return { ft: 0, txt: "지표면(GND)", agl: true };
    if (t === "UNL") return { ft: 1e9, txt: "상한 없음(UNL)" };
    var fl = /^FL\s?(\d+)$/.exec(t);
    if (fl) { var f = +fl[1] * 100; return { ft: f, txt: "FL" + fl[1] + "(약 " + Math.round(f * 0.3048).toLocaleString() + "m)" }; }
    var m = /^([\d ,]+)\s*(FT)?\s*(AMSL|MSL|AGL|HEI)?$/.exec(t);
    if (!m) return null;
    var ft = +m[1].replace(/[ ,]/g, ""); if (!isFinite(ft)) return null;
    var agl = m[3] === "AGL" || m[3] === "HEI";
    var ref = agl ? "지표면 기준 " : (m[3] ? "해발 " : "");
    return { ft: ft, agl: agl, txt: ref + ft.toLocaleString() + "ft(" + Math.round(ft * 0.3048).toLocaleString() + "m)" };
  }

  // 드론은 항상 지상 150m 아래로 난다고 보고, 구역 하한이 지상 150m 이상이면 해당 없음
  var DRONE_MAX_M = 150;
  function aboveDrone(props) {
    var alts = [];
    Object.keys(props).forEach(function (k) {
      if (/_lbl_[23]$/.test(k) && typeof props[k] === "string") { var a = parseAlt(clean(props[k])); if (a) alts.push(a); }
    });
    if (alts.length !== 2) return false;
    alts.sort(function (a, b) { return a.ft - b.ft; });
    return alts[0].agl && alts[0].ft * 0.3048 >= DRONE_MAX_M;
  }

  // 구역 정보 나누기: code "R20", alt "지면 ~ 해발 5,000ft(1,524m)", note "원전 관련 임시 (금지)공역"
  function zoneParts(props, L) {
    var code = "", note = "", alts = [];
    Object.keys(props).forEach(function (k) {
      var v = props[k]; if (typeof v !== "string") return;
      v = clean(v); if (!v) return;
      if (/_label$/.test(k)) { code = v; return; }                   // 이착륙장 이름(한글)
      if (/_lbl_1$/.test(k)) { if (!code) code = v.replace(/^RK\s+/, ""); return; }
      if (/_lbl_[23]$/.test(k)) { var a = parseAlt(v); if (a) alts.push(a); return; }
      if (/_lbl_4$/.test(k) && L.name.indexOf(v) !== 0) note = v;
    });
    if (code === "Airfield") code = "";
    var alt = "";
    if (alts.length === 2) {
      alts.sort(function (a, b) { return a.ft - b.ft; });
      alt = alts[0].txt + " ~ " + alts[1].txt;
    } else if (alts.length === 1) alt = "~ " + alts[0].txt;
    return { code: code, alt: alt, note: note };
  }
  function zoneText(props, L) {
    var p = zoneParts(props, L);
    return [p.code, p.alt, p.note].filter(Boolean).join(", ");
  }
  function describe(props, L) {
    var parts = [];
    Object.keys(props).forEach(function (k) {
      var v = props[k];
      if (v === null || v === "" || typeof v === "object") return;
      v = clean(v); if (!v || v.length > 80) return;
      if (/^\d{1,2}$/.test(v)) return;                 // 구분용 숫자(타입 코드)
      if (L && L.name.indexOf(v) === 0) return;         // 구역 이름과 같은 글
      v = v.replace(/^RK\s+/, "");                       // 국가 접두어
      if (parts.indexOf(v) < 0) parts.push(v);
    });
    return parts.join(" · ");
  }

  // 판정: 드론 고도(150m) 위 구역은 빼고, 금지·승인 > 주의 > 가능
  function verdict(h) {
    var lv = h.filter(function (x) { return !aboveDrone(x.z.props); }).map(function (x) { return x.L.level; });
    if (lv.indexOf("bad") >= 0 || lv.indexOf("warn") >= 0) return { cls: "bad", text: "비행승인 필요" };
    if (lv.indexOf("caution") >= 0) return { cls: "caution", text: "비행 가능 (주의공역)" };
    return { cls: "ok", text: "비행 가능 (승인 불필요)" };
  }

  // 누른 곳 말풍선: 판정 띠(색·아이콘) → 걸린 구역 → 주소
  var ICON = {
    ok: "<svg class='i' viewBox='0 0 24 24'><path d='M20 6 9 17l-5-5'/></svg>",
    caution: "<svg class='i' viewBox='0 0 24 24'><path d='M12 3 2 20h20z'/><path d='M12 10v4M12 17.5v.01'/></svg>",
    bad: "<svg class='i' viewBox='0 0 24 24'><circle cx='12' cy='12' r='9'/><path d='M5.6 5.6l12.8 12.8'/></svg>",
    pin: "<svg class='i' viewBox='0 0 24 24'><path d='M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z'/><circle cx='12' cy='9.5' r='2.5'/></svg>",
    clock: "<svg class='i' viewBox='0 0 24 24'><circle cx='12' cy='12' r='9'/><path d='M12 7v5l3 2'/></svg>"
  };
  var popSeq = 0;
  function showInfo(title, lat, lon, h) {
    var my = ++popSeq;
    $("layers").classList.remove("open");
    var zonesHtml = zoneRows(h);
    if (!CFG.vworldKey) {   // 시험 모드: 공원·주소 조회 없음
      var v0 = verdict(h);
      M.popup(lat, lon, band(v0) + "<div class='pp-body'>" + zonesHtml + "</div>");
      return;
    }
    // 공원 여부를 확인한 뒤에 판정을 보여 줌(먼저 '가능'이 떴다가 바뀌지 않게)
    M.popup(lat, lon, "<div class='pp-v wait'>" + ICON.clock + "조회 중</div><div class='pp-body'>" + zonesHtml + "</div>");
    Promise.all([parksAt(lat, lon), getAddress(lat, lon)]).then(function (r) {
      if (my !== popSeq) return;   // 그 사이 다른 곳을 눌렀으면 버림
      var parks = r[0], a = r[1];
      var v = verdict(h);
      if (parks.length && v.cls !== "bad") v = { cls: "bad", text: "공원 행위허가 필요" };
      var ph = parks.map(function (p) {
        return "<div class='pp-z'><i class='sw park' style='border-color:" + p.P.color + "'></i><div><b>" + esc(p.P.name) + "</b>" +
          (p.name ? "<span class='code'>" + esc(p.name) + "</span>" : "") +
          "<small>자연공원법상 공원관리청 행위허가 대상 (사적 촬영 목적은 통상 불허)</small></div></div>";
      }).join("");
      var ah = a.parcel || a.road ? "<div class='pp-a'>" + esc(a.parcel || a.road) +
        (a.parcel && a.road ? "<small>" + esc(a.road) + "</small>" : "") + "</div>" : "";
      M.popupUpdate(band(v) + "<div class='pp-body'>" + zonesHtml + ph + ah + "</div>");
    });
  }
  function band(v) { return "<div class='pp-v " + v.cls + "'>" + ICON[v.cls] + v.text + "</div>"; }
  function zoneRows(h) {
    var html = "";
    h.forEach(function (x) {
      var p = zoneParts(x.z.props, x.L);
      var up = aboveDrone(x.z.props);
      var line = p.alt || (!p.code ? describe(x.z.props, x.L) : "");
      if (p.note) line = line ? line + ", " + p.note : p.note;
      html += "<div class='pp-z" + (up ? " dim" : "") + "'><i class='sw' style='border-color:" + x.L.color + ";background:" + x.L.color + "44'></i><div>" +
        "<b>" + esc(x.L.name) + "</b>" + (p.code ? "<span class='code'>" + esc(p.code) + "</span>" : "") +
        (line ? "<small>" + esc(line) + "</small>" : "") +
        (up ? "<small>하한고도가 150m를 초과하여 적용 제외</small>" : "") + "</div></div>";
    });
    return html;
  }

  // 좌표 → 주소 (브이월드 지오코더). 실패하면 빈 값.
  function getAddress(lat, lon) {
    if (!CFG.vworldKey) return Promise.resolve({});
    var url = "https://api.vworld.kr/req/address?service=address&request=getAddress&version=2.0&crs=epsg:4326" +
      "&point=" + lon.toFixed(7) + "," + lat.toFixed(7) + "&format=json&type=both&zipcode=false&simple=false" +
      "&key=" + encodeURIComponent(CFG.vworldKey) + "&domain=" + encodeURIComponent(CFG.vworldDomain || location.origin);
    return jsonp(url, 8000).then(function (d) {
      var r = d && d.response, out = {};
      if (r && r.status === "OK") (r.result || []).forEach(function (x) { out[x.type] = x.text; });
      return out;
    }, function () { return {}; });
  }

  var lastInspect = 0;
  function inspect(lat, lon) {
    if (Date.now() - lastInspect < 250) return; // 도형+지도 클릭이 같이 올 때 한 번만
    lastInspect = Date.now();
    hideSuggest();
    M.pin(lat, lon, false);
    showInfo("", lat, lon, hits(lat, lon));   // 판정은 꺼 둔 구역 종류까지 모두 넣음
  }

  function judge(lat, lon, quiet) {
    var h = hits(lat, lon);
    var v = verdict(h);
    if (!quiet) showInfo("", lat, lon, h);
    var names = h.map(function (x) { return x.L.name; });
    function show(vv, nn) {
      setStatus("<b class='" + vv.cls + "'>현위치 " + vv.text + "</b>" + (nn.length ? ", " + nn.join(", ") : "") +
        " <span style='color:var(--ink-3)'>(GPS 오차 약 " + Math.round(me.acc) + "m)</span>");
    }
    show(v, names);
    parksAt(lat, lon).then(function (parks) {
      if (!parks.length) return;
      var vv = v.cls === "bad" ? v : { cls: "bad", text: "공원 행위허가 필요" };
      show(vv, names.concat(parks.map(function (p) { return p.name ? p.name + " " + p.P.name : p.P.name; })));
    });
  }

  function setStatus(html) { $("status").innerHTML = html; }

  // ---------- 버튼 ----------
  function buildLayerPanel() {
    var el = $("layers"); el.innerHTML = "<h3>공역 표시 설정</h3>";
    LAYERS.forEach(function (L) {
      var lab = document.createElement("label");
      var cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = L.on;
      cb.setAttribute("aria-label", L.name);
      var sw = document.createElement("span"); sw.className = "sw"; sw.style.borderColor = L.color; sw.style.background = L.color + "44";
      var t = document.createElement("span"); t.className = "t";
      t.innerHTML = esc(L.name) + (L.desc ? "<small>" + esc(L.desc) + "</small>" : "");
      lab.appendChild(sw); lab.appendChild(t); lab.appendChild(cb);
      cb.onchange = function () {
        L.on = cb.checked; (shapes[L.id] || []).forEach(function (s) { s.show(L.on); });
        var o = {}; LAYERS.forEach(function (x) { o[x.id] = x.on; }); store.set("dz_layers_on", o);
        if (me) judge(me.lat, me.lon, true);
      };
      el.appendChild(lab);
    });
    // 공원 경계 (국립·도립·군립 한 번에)
    var lab = document.createElement("label");
    var cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = parksOn; cb.setAttribute("aria-label", "자연공원");
    var sw = document.createElement("span"); sw.className = "sw park"; sw.style.borderColor = PARKS[0].color;
    var t = document.createElement("span"); t.className = "t";
    t.innerHTML = "자연공원 (국립·도립·군립)<small>공원관리청 행위허가 대상, 확대 시 경계 표시</small>";
    lab.appendChild(sw); lab.appendChild(t); lab.appendChild(cb);
    cb.onchange = function () {
      parksOn = cb.checked; store.set("dz_parks_on", parksOn);
      parkShapes.forEach(function (s) { s.show(parksOn); });
      if (parksOn) refreshParks();
    };
    el.appendChild(lab);
    var note = document.createElement("p");
    note.textContent = "표시를 끈 공역도 지점 판정에는 포함됩니다.";
    el.appendChild(note);
  }

  function goPlace(r) {
    hideSuggest();
    saveHist(r);
    sugList = [];   // 다음에 검색창을 누르면 최근 검색이 뜨도록
    $("q").value = r.name; $("q").blur(); $("qClear").classList.add("show");
    M.pin(r.lat, r.lon, true);
    lastInspect = 0;
    showInfo(r.name, r.lat, r.lon, hits(r.lat, r.lon));
  }

  // ---------- 최근 검색 기록 (이 기기에만 저장) ----------
  var HKEY = "dz_history", HKEEP = 50, HSHOW = 10;
  function loadHist() { var h = store.get(HKEY); return Array.isArray(h) ? h : []; }
  function saveHist(r) {
    var h = loadHist().filter(function (x) { return !(x.name === r.name && x.sub === r.sub); });
    h.unshift({ name: r.name, sub: r.sub, lat: r.lat, lon: r.lon });
    store.set(HKEY, h.slice(0, HKEEP));
  }
  function itemButton(r, recent) {
    var b = document.createElement("button"); b.type = "button"; b.className = "s-item" + (recent ? " recent" : "");
    b.innerHTML = (recent ? ICON.clock : ICON.pin) + "<span><b>" + esc(r.name) + "</b>" +
      (r.sub ? "<small>" + esc(r.sub) + "</small>" : "") + "</span>";
    b.addEventListener("click", function () { goPlace(r); });
    return b;
  }
  function renderHistory(expanded) {
    var h = loadHist(), el = $("suggest");
    el.innerHTML = "";
    if (!h.length) { hideSuggest(); return; }
    var head = document.createElement("div"); head.className = "s-head";
    head.innerHTML = "<span>최근 검색</span>";
    var clr = document.createElement("button"); clr.type = "button"; clr.className = "s-clear"; clr.textContent = "기록 삭제";
    clr.addEventListener("click", function () {
      if (window.confirm("최근 검색 기록을 모두 삭제하시겠습니까?")) { store.set(HKEY, []); hideSuggest(); }
    });
    head.appendChild(clr); el.appendChild(head);
    var list = document.createElement("div"); list.className = "s-list" + (expanded ? " scroll" : "");
    (expanded ? h : h.slice(0, HSHOW)).forEach(function (r) { list.appendChild(itemButton(r, true)); });
    el.appendChild(list);
    if (!expanded && h.length > HSHOW) {
      var more = document.createElement("button"); more.type = "button"; more.className = "s-more";
      more.textContent = "더보기 (" + (h.length - HSHOW) + "건)";
      more.addEventListener("click", function () { renderHistory(true); });
      el.appendChild(more);
    }
    el.classList.add("open");
    $("info").classList.remove("open"); $("layers").classList.remove("open");
  }

  // ---------- 검색창 드롭다운 ----------
  var sugSeq = 0, sugTimer = null, sugList = [];
  function hideSuggest() { $("suggest").classList.remove("open"); }
  function renderSuggest(q, list, busy) {
    var el = $("suggest"); el.innerHTML = "";
    if (busy) el.innerHTML = "<div class='s-msg'>검색 중</div>";
    else if (!list.length) el.innerHTML = "<div class='s-msg'>'" + esc(q) + "' 검색 결과 없음</div>";
    var box = document.createElement("div"); box.className = "s-list scroll";
    list.forEach(function (r) { box.appendChild(itemButton(r, false)); });
    el.appendChild(box);
    el.classList.add("open");
    $("info").classList.remove("open"); $("layers").classList.remove("open");
  }
  function runSuggest(now) {
    var q = $("q").value.trim();
    clearTimeout(sugTimer);
    if (!q) { sugList = []; renderHistory(false); return; }
    if (q.length < 2) { sugList = []; hideSuggest(); return; }
    sugTimer = setTimeout(function () {
      var my = ++sugSeq;
      renderSuggest(q, sugList, !sugList.length);
      search(q).then(function (list) {
        if (my !== sugSeq) return;            // 그 사이 더 친 글자가 있으면 버림
        sugList = list; renderSuggest(q, list, false);
      }, function () { if (my === sugSeq) renderSuggest(q, [], false); });
    }, now ? 0 : 350);
  }

  function doSearch(ev) {
    ev.preventDefault();
    // 엔터/찾기: 목록만 보여 줌. 이동은 목록에서 고를 때만.
    if (sugList.length) return renderSuggest($("q").value.trim(), sugList, false);
    runSuggest(true);
  }

  function afterMap() {
    buildLayerPanel();
    M.onClick(inspect);
    $("search").onsubmit = doSearch;
    $("q").addEventListener("input", function () {
      $("qClear").classList.toggle("show", !!$("q").value); sugList = []; runSuggest(false);
    });
    $("qClear").addEventListener("click", function () {
      $("q").value = ""; $("qClear").classList.remove("show"); sugList = []; $("q").focus(); renderHistory(false);
    });
    $("bZin").onclick = function () { M.zoomBy(1); };
    $("bZout").onclick = function () { M.zoomBy(-1); };
    // 검색창을 누르면: 막 친 글자의 결과가 있으면 그것, 아니면 최근 검색
    $("q").addEventListener("focus", function () {
      if (sugList.length) renderSuggest($("q").value.trim(), sugList, false); else renderHistory(false);
    });
    // 목록 밖(지도 등)을 누르면 닫기. 목록 안 스크롤·버튼은 그대로 동작.
    document.addEventListener("pointerdown", function (e) {
      if (!$("top").contains(e.target)) { hideSuggest(); $("q").blur(); }
    });
    $("bLayers").onclick = function () { $("info").classList.remove("open"); $("layers").classList.toggle("open"); };
    $("bSat").onclick = function () { $("bSat").classList.toggle("on", M.toggleSat()); };
    $("bReload").onclick = function () {
      var b = $("bReload"); b.classList.add("spin");
      loadAll(true).then(function () { b.classList.remove("spin"); }, function () { b.classList.remove("spin"); });
    };
    // 오른쪽 아이콘 줄은 검색창 바로 아래에. 드롭다운이 열려도 아이콘은 제자리(드롭다운이 위로 덮음).
    function placeButtons() {
      var top = $("top"), sug = $("suggest");
      // 화면이 넓어 검색창 옆에 자리가 있으면 맨 위에, 아니면 검색창 아래에
      var roomBeside = window.innerWidth - (top.offsetLeft + top.offsetWidth) > 76;
      var y = roomBeside ? top.offsetTop
        : top.offsetTop + top.offsetHeight - (sug.classList.contains("open") ? sug.offsetHeight + 6 : 0) + 8;
      document.documentElement.style.setProperty("--btns-top", y + "px");
    }
    placeButtons();
    window.addEventListener("resize", placeButtons);
    if (window.ResizeObserver) new ResizeObserver(placeButtons).observe($("top"));
    $("bMe").onclick = function () {
      if (!navigator.geolocation) { setStatus("<span class='bad'>이 기기는 위치 정보를 지원하지 않습니다.</span>"); return; }
      if (watchId !== null) { if (me) { M.setMe(me.lat, me.lon, me.acc, true); judge(me.lat, me.lon); } return; }
      setStatus("현위치 조회 중");
      var first = true;
      watchId = navigator.geolocation.watchPosition(function (p) {
        me = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy || 30 };
        M.setMe(me.lat, me.lon, me.acc, first); judge(me.lat, me.lon, !first); first = false;
        $("bMe").classList.add("on");
      }, function (e) {
        watchId = null;
        setStatus("<span class='bad'>위치 정보 수신 실패: " + esc(e.message) + "</span><br>브라우저의 위치 권한 설정을 확인하십시오.");
      }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
    };
    loadAll(false);
    M.onMoveEnd(refreshParks);
    refreshParks();
  }

  startMap();
})();
