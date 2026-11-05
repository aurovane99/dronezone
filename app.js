// 드론 비행구역 지도 — 다음(카카오)지도 + 브이월드 공역 데이터
// 카카오 키가 없으면 미리보기용 OSM 지도(Leaflet)로, 브이월드 키가 없으면 시험용 가짜 구역으로 동작한다.
(function () {
  "use strict";
  var CFG = window.DZ_CONFIG || {};
  var KOREA_BOX = "BOX(124,33,132,39)";
  var CACHE_HOURS = 24;

  var LAYERS = [
    { id: "LT_C_AISPRHC", name: "비행금지구역", color: "#e53935", fill: 0.35, on: true, level: "bad" },
    { id: "LT_C_AISRESC", name: "비행제한구역", color: "#fb8c00", fill: 0.25, on: true, level: "warn" },
    { id: "LT_C_AISCTRC", name: "관제권 (공항 반경 9.3km)", color: "#8e24aa", fill: 0.15, on: true, level: "warn" },
    { id: "LT_C_AISFLDC", name: "경량항공기 이착륙장", color: "#c0a000", fill: 0.15, on: true, level: "warn" },
    { id: "LT_C_AISDNGC", name: "위험구역", color: "#c2185b", fill: 0.2, on: false, level: "warn" },
    { id: "LT_C_AISALTC", name: "경계구역", color: "#6d4c41", fill: 0.15, on: false, level: "warn" },
    { id: "LT_C_AISUAC", name: "초경량비행장치공역 (승인 없이 비행 가능)", color: "#43a047", fill: 0.2, on: true, level: "ok" }
  ];

  var $ = function (id) { return document.getElementById(id); };
  var store = {
    get: function (k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 용량 초과 등 무시 */ } }
  };
  var savedOn = store.get("dz_layers_on");
  if (savedOn) LAYERS.forEach(function (L) { if (L.id in savedOn) L.on = !!savedOn[L.id]; });

  var demo = !CFG.vworldKey;
  var M;             // 지도 어댑터
  var zones = {};    // layerId -> [{props, rings:[[ [lat,lon], ... ], ...]}]  (polygon 단위)
  var shapes = {};   // layerId -> [지도 도형]
  var me = null;     // {lat, lon, acc}
  var watchId = null;

  // ---------- 지도 어댑터 ----------
  function kakaoAdapter() {
    var k = window.kakao.maps;
    var map = new k.Map($("map"), { center: new k.LatLng(37.738, 127.034), level: 8 });
    map.addControl(new k.ZoomControl(), k.ControlPosition.RIGHT);
    var meDot = null, meCircle = null, sat = false;
    return {
      kind: "kakao",
      polygon: function (rings, L, onClick) {
        var path = rings.map(function (r) { return r.map(function (p) { return new k.LatLng(p[0], p[1]); }); });
        var pg = new k.Polygon({ path: path, strokeWeight: 2, strokeColor: L.color, strokeOpacity: 0.9,
          fillColor: L.color, fillOpacity: L.fill });
        k.event.addListener(pg, "click", function (e) { onClick(e.latLng.getLat(), e.latLng.getLng()); });
        return { show: function (v) { pg.setMap(v ? map : null); } };
      },
      onClick: function (fn) { k.event.addListener(map, "click", function (e) { fn(e.latLng.getLat(), e.latLng.getLng()); }); },
      setMe: function (lat, lon, acc, pan) {
        var ll = new k.LatLng(lat, lon);
        if (!meDot) {
          var el = document.createElement("div"); el.className = "me";
          meDot = new k.CustomOverlay({ position: ll, content: el, zIndex: 10 }); meDot.setMap(map);
          meCircle = new k.Circle({ center: ll, radius: acc, strokeWeight: 1, strokeColor: "#2563eb",
            strokeOpacity: 0.6, fillColor: "#2563eb", fillOpacity: 0.12 }); meCircle.setMap(map);
        }
        meDot.setPosition(ll); meCircle.setPosition(ll); meCircle.setRadius(acc);
        if (pan) { map.setLevel(6); map.panTo(ll); }
      },
      toggleSat: function () {
        sat = !sat; map.setMapTypeId(sat ? k.MapTypeId.HYBRID : k.MapTypeId.ROADMAP); return sat;
      },
      pin: function (lat, lon) {
        var ll = new k.LatLng(lat, lon);
        if (!pinM) { pinM = new k.Marker({ position: ll }); pinM.setMap(map); }
        pinM.setPosition(ll); map.setLevel(5); map.panTo(ll);
      },
      search: function (q) {
        // 주소 먼저, 없으면 장소 이름
        var svc = k.services;
        return new Promise(function (resolve) {
          new svc.Geocoder().addressSearch(q, function (d, st) {
            if (st === svc.Status.OK && d.length) return resolve(d.map(function (x) {
              return { name: x.address_name, sub: (x.road_address && x.road_address.address_name) || "", lat: +x.y, lon: +x.x };
            }));
            new svc.Places().keywordSearch(q, function (d2, st2) {
              resolve(st2 === svc.Status.OK ? d2.map(function (x) {
                return { name: x.place_name, sub: x.road_address_name || x.address_name, lat: +x.y, lon: +x.x };
              }) : []);
            });
          });
        });
      }
    };
  }
  var pinM = null;

  function leafletAdapter() {
    var map = window.L.map("map", { zoomControl: true }).setView([37.738, 127.034], 11);
    var road = window.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
      { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(map);
    var satL = window.L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      { maxZoom: 19, attribution: "Esri" });
    var meDot = null, meCircle = null, sat = false, clickFn = null, lastPolyClick = 0;
    return {
      kind: "leaflet",
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
      pin: function (lat, lon) {
        if (!pinL) pinL = window.L.circleMarker([lat, lon], { radius: 9, weight: 3, color: "#fff", fillColor: "#dc2626", fillOpacity: 1 }).addTo(map);
        pinL.setLatLng([lat, lon]); map.setView([lat, lon], 15);
      },
      search: function (q) {
        // 미리보기용: OSM 검색 (카카오 키가 생기면 카카오 검색으로 바뀜)
        return fetch("https://nominatim.openstreetmap.org/search?format=json&countrycodes=kr&limit=8&accept-language=ko&q=" + encodeURIComponent(q))
          .then(function (r) { return r.json(); })
          .then(function (d) { return d.map(function (x) { return { name: x.display_name.split(",")[0], sub: x.display_name, lat: +x.lat, lon: +x.lon }; }); });
      }
    };
    var pinL = null;
  }

  function loadScript(src, ok, fail) {
    var s = document.createElement("script"); s.src = src; s.onload = ok;
    s.onerror = fail || function () { setStatus("<span class='bad'>지도 스크립트를 불러오지 못했습니다.</span>"); };
    document.head.appendChild(s);
  }

  function startMap() {
    if (CFG.kakaoKey) {
      loadScript("https://dapi.kakao.com/v2/maps/sdk.js?autoload=false&libraries=services&appkey=" + encodeURIComponent(CFG.kakaoKey), function () {
        window.kakao.maps.load(function () { M = kakaoAdapter(); afterMap(); });
      }, function () { setStatus("<span class='bad'>카카오 지도를 불러오지 못했습니다.</span> 키와 등록한 사이트 주소를 확인하세요."); });
    } else {
      var css = document.createElement("link"); css.rel = "stylesheet";
      css.href = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css"; document.head.appendChild(css);
      loadScript("https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js", function () { M = leafletAdapter(); afterMap(); });
    }
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
          var hint = /KEY/.test(er.code || "") ? " (키 또는 등록 주소 확인)" : "";
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
    setStatus("구역 정보를 받는 중… (0/" + LAYERS.length + ")");
    return Promise.all(LAYERS.map(function (L) {
      var key = "dz_cache_v1_" + L.id, c = store.get(key);
      var p;
      if (demo) p = Promise.resolve(demoFeatures(L));
      else if (!force && c && Date.now() - c.t < CACHE_HOURS * 3600e3) p = Promise.resolve(c.f);
      else p = fetchLayer(L).then(function (f) { store.set(key, { t: Date.now(), f: f }); return f; });
      return p.then(function (f) { addLayer(L, f); }, function (e) {
        fails.push(L.name + ": " + e.message);
        if (c) addLayer(L, c.f); // 실패하면 지난번 받은 것이라도
      }).then(function () { done++; setStatus("구역 정보를 받는 중… (" + done + "/" + LAYERS.length + ")"); });
    })).then(function () {
      var n = LAYERS.reduce(function (s, L) { return s + zones[L.id].length; }, 0);
      var msg = demo ? "<span class='demo'>시험 모드: 브이월드 키가 없어 가짜 구역을 보여 줍니다.</span>"
                     : "<b>구역 " + n + "개 표시</b> · 지도를 누르면 그 지점의 구역을 알려 줍니다.";
      if (M.kind === "leaflet") msg += "<br><span class='demo'>카카오 키가 없어 미리보기 지도(OSM)를 씁니다.</span>";
      if (fails.length) msg += "<br><span class='bad'>못 받은 구역: " + fails.join(" / ") + "</span>";
      setStatus(msg);
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
  function describe(props) {
    var parts = [];
    Object.keys(props).forEach(function (k) {
      var v = props[k];
      if (v === null || v === "" || typeof v === "object") return;
      v = clean(v); if (!v || v.length > 80) return;
      if (parts.indexOf(v) < 0) parts.push(v);
    });
    return parts.join(" · ");
  }

  function verdict(h) {
    if (!h.length) return { cls: "warn", text: "표시된 구역 밖입니다. 일반 지역은 고도 150m 미만이면 대부분 승인 없이 가능하지만, 드론원스톱에서 한 번 더 확인하세요." };
    var lv = h.map(function (x) { return x.L.level; });
    if (lv.indexOf("bad") >= 0) return { cls: "bad", text: "비행금지구역 안입니다. 승인 없이 비행할 수 없습니다." };
    if (lv.indexOf("warn") >= 0) return { cls: "warn", text: "비행 승인이 필요한 구역입니다. 드론원스톱에서 승인 신청하세요." };
    return { cls: "ok", text: "초경량비행장치공역 안입니다. 고도 등 조건을 지키면 승인 없이 비행 가능합니다." };
  }

  function showInfo(title, lat, lon, h) {
    var v = verdict(h);
    var html = "<button class='x' aria-label='닫기'>×</button><h4>" + esc(title) + "</h4>" +
      "<div class='" + v.cls + "'><b>" + esc(v.text) + "</b></div>" +
      "<div style='color:var(--muted);margin:4px 0 6px'>" + lat.toFixed(5) + ", " + lon.toFixed(5) + "</div>";
    h.forEach(function (x) {
      html += "<div class='z'><span class='sw' style='display:inline-block;vertical-align:middle;border-color:" + x.L.color +
        ";background:" + x.L.color + "55'></span> <b>" + esc(x.L.name) + "</b><br>" + esc(describe(x.z.props)) + "</div>";
    });
    html += "<div style='margin-top:8px;color:var(--muted)'>참고용입니다. 실제 승인은 " +
      "<a href='https://drone.onestop.go.kr' target='_blank' rel='noopener'>드론원스톱</a>에서 하세요.</div>";
    var el = $("info"); el.innerHTML = html; el.classList.add("open"); $("layers").classList.remove("open");
    el.querySelector(".x").onclick = function () { el.classList.remove("open"); };
  }

  var lastInspect = 0;
  function inspect(lat, lon) {
    if (Date.now() - lastInspect < 250) return; // 도형+지도 클릭이 같이 올 때 한 번만
    lastInspect = Date.now();
    showInfo("누른 지점", lat, lon, hits(lat, lon).filter(function (x) { return x.L.on; }));
  }

  function judge(lat, lon, quiet) {
    var h = hits(lat, lon).filter(function (x) { return x.L.on; });
    var v = verdict(h);
    if (!quiet) showInfo("내 위치", lat, lon, h);
    setStatus("<b class='" + v.cls + "'>내 위치: " + (h.length ? h.map(function (x) { return x.L.name.replace(/ \(.*\)/, ""); }).join(", ") : "표시된 구역 밖") +
      "</b><br><span style='color:var(--muted)'>정확도 약 " + Math.round(me.acc) + "m</span>");
  }

  function setStatus(html) { $("status").innerHTML = html; }

  // ---------- 버튼 ----------
  function buildLayerPanel() {
    var el = $("layers"); el.innerHTML = "";
    LAYERS.forEach(function (L) {
      var lab = document.createElement("label");
      var cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = L.on;
      var sw = document.createElement("span"); sw.className = "sw"; sw.style.borderColor = L.color; sw.style.background = L.color + "55";
      lab.appendChild(cb); lab.appendChild(sw); lab.appendChild(document.createTextNode(L.name));
      cb.onchange = function () {
        L.on = cb.checked; (shapes[L.id] || []).forEach(function (s) { s.show(L.on); });
        var o = {}; LAYERS.forEach(function (x) { o[x.id] = x.on; }); store.set("dz_layers_on", o);
        if (me) judge(me.lat, me.lon, true);
      };
      el.appendChild(lab);
    });
  }

  function goPlace(r) {
    M.pin(r.lat, r.lon);
    lastInspect = 0;
    showInfo(r.name, r.lat, r.lon, hits(r.lat, r.lon).filter(function (x) { return x.L.on; }));
  }

  function doSearch(ev) {
    ev.preventDefault();
    var q = $("q").value.trim(); if (!q) return;
    $("q").blur();
    setStatus("찾는 중…");
    M.search(q).then(function (list) {
      setStatus("<b>'" + esc(q) + "'</b> 검색 결과 " + list.length + "건");
      if (!list.length) { $("info").classList.remove("open"); return; }
      if (list.length === 1) return goPlace(list[0]);
      var el = $("info");
      el.innerHTML = "<button class='x' aria-label='닫기'>×</button><h4>검색 결과</h4>";
      list.slice(0, 10).forEach(function (r) {
        var b = document.createElement("button"); b.className = "r";
        b.innerHTML = "<b>" + esc(r.name) + "</b><br><small>" + esc(r.sub) + "</small>";
        b.onclick = function () { goPlace(r); };
        el.appendChild(b);
      });
      el.classList.add("open"); $("layers").classList.remove("open");
      el.querySelector(".x").onclick = function () { el.classList.remove("open"); };
    }, function (e) { setStatus("<span class='bad'>검색 실패: " + esc(e.message) + "</span>"); });
  }

  function afterMap() {
    buildLayerPanel();
    M.onClick(inspect);
    $("search").onsubmit = doSearch;
    $("bLayers").onclick = function () { $("info").classList.remove("open"); $("layers").classList.toggle("open"); };
    $("bSat").onclick = function () { $("bSat").classList.toggle("on", M.toggleSat()); };
    $("bReload").onclick = function () { loadAll(true); };
    $("bMe").onclick = function () {
      if (!navigator.geolocation) { setStatus("<span class='bad'>이 기기에서는 위치를 쓸 수 없습니다.</span>"); return; }
      if (watchId !== null) { if (me) { M.setMe(me.lat, me.lon, me.acc, true); judge(me.lat, me.lon); } return; }
      setStatus("위치를 찾는 중…");
      var first = true;
      watchId = navigator.geolocation.watchPosition(function (p) {
        me = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy || 30 };
        M.setMe(me.lat, me.lon, me.acc, first); judge(me.lat, me.lon, !first); first = false;
        $("bMe").classList.add("on");
      }, function (e) {
        watchId = null;
        setStatus("<span class='bad'>위치를 못 찾았습니다: " + esc(e.message) + "</span><br>위치 권한을 허용했는지 확인하세요.");
      }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
    };
    loadAll(false);
  }

  startMap();
})();
