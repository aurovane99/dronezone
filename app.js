// 드론 비행구역 지도 — 브이월드 지도·공역 데이터 (Leaflet)
// 검색: 카카오 키가 있으면 카카오, 없으면 브이월드. 브이월드 키가 없으면 OSM 지도 + 시험용 가짜 구역.
(function () {
  "use strict";
  var CFG = window.DZ_CONFIG || {};
  var KOREA_BOX = "BOX(124,33,132,39)";
  var CACHE_HOURS = 24;

  var LAYERS = [
    { id: "LT_C_AISPRHC", name: "비행금지구역", color: "#e53935", fill: 0.18, on: true, level: "bad" },
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
          autoPanPaddingTopLeft: [10, 120], autoPanPaddingBottomRight: [10, 90] });
        pop.setLatLng([lat, lon]).setContent(html).openOn(map);
      }
    };
    var pinL = null, pop = null;
  }

  function loadScript(src, ok, fail) {
    var s = document.createElement("script"); s.src = src; s.onload = ok;
    s.onerror = fail || function () { setStatus("<span class='bad'>지도 스크립트를 불러오지 못했습니다.</span>"); };
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
      var msg = demo ? "<span class='demo'>시험 모드: 이 기기에 키가 없어 가짜 구역을 보여 줍니다.</span> " +
                       "<button id='bKey' type='button'>키 넣기</button>"
                     : "<b>구역 " + n + "개 표시</b> · 지도를 누르면 그 지점의 구역을 알려 줍니다.";
      if (M.kind === "leaflet" && !CFG.vworldKey) msg += "<br><span class='demo'>키가 없어 미리보기 지도(OSM)를 씁니다.</span>";
      if (fails.length) msg += "<br><span class='bad'>못 받은 구역: " + fails.join(" / ") + "</span>";
      setStatus(msg);
      var bk = $("bKey");
      if (bk) bk.onclick = function () {
        var k = (window.prompt("브이월드 인증키를 붙여 넣으세요") || "").trim();
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
  var ALT = { GND: "지면", UNL: "무제한", SFC: "지면" };
  function describe(props, L) {
    var parts = [];
    Object.keys(props).forEach(function (k) {
      var v = props[k];
      if (v === null || v === "" || typeof v === "object") return;
      v = clean(v); if (!v || v.length > 80) return;
      if (/^\d{1,2}$/.test(v)) return;                 // 구분용 숫자(타입 코드)
      if (L && L.name.indexOf(v) === 0) return;         // 구역 이름과 같은 글
      v = v.replace(/^RK\s+/, "");                       // 국가 접두어
      if (ALT[v]) v = "고도 " + ALT[v];
      if (parts.indexOf(v) < 0) parts.push(v);
    });
    return parts.join(" · ");
  }

  function verdict(h) {
    if (!h.length) return { cls: "warn", text: "구역 밖 · 150m 미만은 대부분 승인 불필요" };
    var lv = h.map(function (x) { return x.L.level; });
    if (lv.indexOf("bad") >= 0) return { cls: "bad", text: "비행금지 · 승인 필요" };
    if (lv.indexOf("warn") >= 0) return { cls: "warn", text: "승인 필요" };
    return { cls: "ok", text: "승인 없이 비행 가능" };
  }

  // 누른 곳 옆 작은 말풍선: 구역 이름 + 코드·고도만
  function showInfo(title, lat, lon, h) {
    var html = "";
    h.forEach(function (x) {
      var d = describe(x.z.props, x.L);
      html += "<div class='pp-z'><b><i style='border-color:" + x.L.color + ";background:" + x.L.color + "55'></i>" +
        esc(x.L.name.replace(/ \(.*\)/, "")) + "</b>" + (d ? "<small>" + esc(d) + "</small>" : "") + "</div>";
    });
    if (!html) html = "<div class='pp-z'><b>표시된 구역 없음</b></div>";
    // 맨 아래 한 줄 판정
    var v = verdict(h);
    var txt = v.cls === "ok" ? "비행 가능" : (h.length ? "비행승인 필요" : "비행 가능 (고도 150m 미만)");
    html += "<div class='pp-v " + (txt.indexOf("가능") >= 0 ? "ok" : "bad") + "'>" + txt + "</div>";
    $("layers").classList.remove("open");
    M.popup(lat, lon, html);
  }

  var lastInspect = 0;
  function inspect(lat, lon) {
    if (Date.now() - lastInspect < 250) return; // 도형+지도 클릭이 같이 올 때 한 번만
    lastInspect = Date.now();
    hideSuggest();
    M.pin(lat, lon, false);
    showInfo("", lat, lon, hits(lat, lon).filter(function (x) { return x.L.on; }));
  }

  function judge(lat, lon, quiet) {
    var h = hits(lat, lon).filter(function (x) { return x.L.on; });
    var v = verdict(h);
    if (!quiet) showInfo("", lat, lon, h);
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
    hideSuggest();
    $("q").value = r.name; $("q").blur();
    M.pin(r.lat, r.lon, true);
    lastInspect = 0;
    showInfo(r.name, r.lat, r.lon, hits(r.lat, r.lon).filter(function (x) { return x.L.on; }));
  }

  // ---------- 검색창 드롭다운 ----------
  var sugSeq = 0, sugTimer = null, sugList = [];
  function hideSuggest() { $("suggest").classList.remove("open"); }
  function renderSuggest(q, list, busy) {
    var el = $("suggest"); el.innerHTML = "";
    if (busy) el.innerHTML = "<div class='s-msg'>찾는 중…</div>";
    else if (!list.length) el.innerHTML = "<div class='s-msg'>'" + esc(q) + "' 결과가 없습니다</div>";
    list.slice(0, 12).forEach(function (r) {
      var b = document.createElement("button"); b.type = "button"; b.className = "s-item";
      b.innerHTML = "<b>" + esc(r.name) + "</b><small>" + esc(r.sub) + "</small>";
      // 휴대폰에서 키보드가 닫히며 목록이 먼저 사라지지 않게 mousedown/touchstart에서 처리
      b.addEventListener("mousedown", function (e) { e.preventDefault(); goPlace(r); });
      b.addEventListener("touchstart", function (e) { e.preventDefault(); goPlace(r); }, { passive: false });
      el.appendChild(b);
    });
    el.classList.add("open");
    $("info").classList.remove("open"); $("layers").classList.remove("open");
  }
  function runSuggest(now) {
    var q = $("q").value.trim();
    clearTimeout(sugTimer);
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
    $("q").addEventListener("input", function () { sugList = []; runSuggest(false); });
    $("q").addEventListener("focus", function () { if (sugList.length) renderSuggest($("q").value.trim(), sugList, false); });
    $("q").addEventListener("blur", function () { setTimeout(hideSuggest, 150); });
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
