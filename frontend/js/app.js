/* E-Rakshak Pinpoint — satellite + SIMPLE sci-fi cinematic mode */

if (!window.AUTH || !window.AUTH.token) {
  window.location.replace("/login.html");
  throw new Error("Not authenticated");
}

Cesium.Ion.defaultAccessToken =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiJlYWE1OWUxNy1mMWZiLTQzYjYtYTQ0OS1kMWFjYmFkNjc5YzciLCJpZCI6NTc3MzMsImlhdCI6MTYyNzg0NTE4Mn0.XcKpgANiY19MC4bdFUXMVEBToBmqS8kuYpUlxJiq3l8";

const BASE_VIEWER_OPTS = {
  animation: false,
  timeline: false,
  baseLayerPicker: false,
  geocoder: false,
  homeButton: false,
  sceneModePicker: true,
  navigationHelpButton: false,
  fullscreenButton: false,
  infoBox: false,
  selectionIndicator: false,
  terrain: undefined,
  // Keep default skyBox — disabling it breaks environment lighting in some builds
};

function probeWebGL() {
  try {
    const c = document.createElement("canvas");
    const gl =
      c.getContext("webgl2", { failIfMajorPerformanceCaveat: false }) ||
      c.getContext("webgl", { failIfMajorPerformanceCaveat: false }) ||
      c.getContext("experimental-webgl", { failIfMajorPerformanceCaveat: false });
    if (!gl) return { ok: false, detail: "No WebGL context from canvas.getContext" };
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = info
      ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL)
      : gl.getParameter(gl.RENDERER);
    return { ok: true, detail: String(renderer || "unknown GPU") };
  } catch (err) {
    return { ok: false, detail: err?.message || String(err) };
  }
}

function showWebGLError(err) {
  const box = document.getElementById("webglError");
  const detail = document.getElementById("webglErrorDetail");
  const probe = probeWebGL();
  if (detail) {
    detail.textContent = [
      err?.message || String(err || "CesiumWidget construction failed"),
      probe.ok ? `Probe GPU: ${probe.detail}` : `Probe failed: ${probe.detail}`,
    ].join(" · ");
  }
  if (box) box.hidden = false;
}

function createCesiumViewer() {
  const attempts = [
    {
      // WSL / flaky GPU: force WebGL1, allow software/compat paths
      scene3DOnly: true,
      orderIndependentTranslucency: false,
      msaaSamples: 1,
      contextOptions: {
        requestWebgl1: true,
        webgl: {
          alpha: false,
          depth: true,
          stencil: false,
          antialias: false,
          premultipliedAlpha: true,
          preserveDrawingBuffer: true,
          failIfMajorPerformanceCaveat: false,
          powerPreference: "default",
        },
      },
    },
    {
      orderIndependentTranslucency: false,
      contextOptions: {
        webgl: {
          antialias: false,
          failIfMajorPerformanceCaveat: false,
          powerPreference: "high-performance",
        },
      },
    },
    {
      contextOptions: {
        webgl: { failIfMajorPerformanceCaveat: false },
      },
    },
    {},
  ];

  let lastErr = null;
  for (let i = 0; i < attempts.length; i++) {
    const host = document.getElementById("cesiumContainer");
    if (host) host.innerHTML = "";
    try {
      const v = new Cesium.Viewer("cesiumContainer", {
        ...BASE_VIEWER_OPTS,
        ...attempts[i],
      });
      console.info(`Cesium viewer OK (attempt ${i + 1}/${attempts.length})`);
      return v;
    } catch (err) {
      lastErr = err;
      console.warn(`Cesium viewer attempt ${i + 1} failed`, err);
    }
  }
  throw lastErr || new Error("Failed to construct CesiumWidget");
}

let viewer;
try {
  viewer = createCesiumViewer();
} catch (err) {
  console.error(err);
  showWebGLError(err);
  document.getElementById("webglRetry")?.addEventListener("click", () => {
    location.reload();
  });
  // Stop module init — map APIs below need a live viewer
  throw err;
}

document.getElementById("webglError").hidden = true;

viewer.scene.globe.depthTestAgainstTerrain = false; // safer on WSL / weak GL
// Dynamic lighting path crashes some WebGL contexts (setDynamicLighting)
viewer.scene.globe.enableLighting = false;
viewer.scene.fog.enabled = true;
viewer.scene.skyAtmosphere.show = true;
viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString("#02060c");
viewer.scene.screenSpaceCameraController.minimumZoomDistance = 60;
viewer.scene.screenSpaceCameraController.maximumZoomDistance = 50000;
// Lower GPU pressure after a prior GL crash
if (viewer.scene.fxaa) viewer.scene.fxaa = false;
if (typeof viewer.scene.msaaSamples === "number") viewer.scene.msaaSamples = 1;

if (viewer.scene.atmosphere && Cesium.DynamicAtmosphereLightingType) {
  viewer.scene.atmosphere.dynamicLighting = Cesium.DynamicAtmosphereLightingType.NONE;
}

const el = (id) => document.getElementById(id);

const state = {
  caseId: "erakshak",
  msisdn: null,
  track: [],
  towers: [],
  playing: false,
  follow: false,
  viewMode: "simple", // default: sci-fi cinematic
  idx: 0,
  total: 0,
  speed: 2,
  lastFix: null,
  trailPositions: [],
  heatEntities: [],
  towerEntities: [],
  beamEntities: [],
  lastHeatIdx: -1,
  anim: null,
  lerpFrom: null,
  lerpTo: null,
  lerpT: 1,
  userControlling: false,
  buildings: null,
  cinematicHeading: 35,
  dwellUntil: 0, // pause between same-cell hops so track doesn't burn out
};

/** Stable entity id from CGI / string */
function eid(prefix, key) {
  return `${prefix}-${String(key).replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

/** Create-or-update entity — never remove/re-add (avoids Cesium flicker). */
function upsertEntity(id, defaults, apply) {
  let ent = viewer.entities.getById(id);
  if (!ent) {
    ent = viewer.entities.add({ id, ...defaults });
  }
  if (apply) apply(ent);
  return ent;
}

function towerByCgi(cgi) {
  if (!cgi) return null;
  const key = String(cgi).toUpperCase();
  return (
    state.towers.find((t) => t.cgi === cgi) ||
    state.towers.find((t) => String(t.cgi).toUpperCase() === key) ||
    null
  );
}

const MAX_TRI_BEAMS = 12;

function isValidLL(lat, lon) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lon) <= 180
  );
}

function safeCartographic(lon, lat, height = 0) {
  if (!isValidLL(lat, lon)) return null;
  const h = Number.isFinite(height) ? height : 0;
  return Cesium.Cartesian3.fromDegrees(lon, lat, h);
}

// Locked brand — never green / never "TARGET" (any mode, any case)
const SUSPECT_HEX = "#ff2d6a";
const SUSPECT_ACCENT_HEX = "#ffe566";
const SUSPECT_LABEL = "● SUSPECT";

function prop(v) {
  return new Cesium.ConstantProperty(v);
}

/** Pink/red SUSPECT marker — ConstantProperty so SAT/FIR can't keep a stale green TARGET. */
function syncSuspectMarker(pos, simple) {
  const color = Cesium.Color.fromCssColorString(SUSPECT_HEX);
  const accent = Cesium.Color.fromCssColorString(SUSPECT_ACCENT_HEX);
  let ent = viewer.entities.getById("suspect");
  if (!ent) {
    ent = viewer.entities.add({
      id: "suspect",
      show: true,
      position: pos,
      point: {
        pixelSize: simple ? 18 : 28,
        color,
        outlineColor: accent,
        outlineWidth: simple ? 3 : 5,
        heightReference: Cesium.HeightReference.NONE,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        scaleByDistance: new Cesium.NearFarScalar(200, 1.4, 8000, 0.7),
      },
      label: {
        text: SUSPECT_LABEL,
        font: simple ? "bold 13px Orbitron" : "bold 16px Orbitron",
        fillColor: color,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 5,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        pixelOffset: new Cesium.Cartesian2(0, -28),
        heightReference: Cesium.HeightReference.NONE,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        showBackground: true,
        backgroundColor: Cesium.Color.fromCssColorString("#000000").withAlpha(0.65),
        backgroundPadding: new Cesium.Cartesian2(8, 5),
        scaleByDistance: new Cesium.NearFarScalar(200, 1.2, 8000, 0.75),
      },
    });
    return ent;
  }
  ent.show = true;
  ent.position = pos;
  ent.point.pixelSize = prop(simple ? 18 : 28);
  ent.point.color = prop(color);
  ent.point.outlineColor = prop(accent);
  ent.point.outlineWidth = prop(simple ? 3 : 5);
  ent.label.text = prop(SUSPECT_LABEL);
  ent.label.font = prop(simple ? "bold 13px Orbitron" : "bold 16px Orbitron");
  ent.label.fillColor = prop(color);
  ent.label.outlineColor = prop(Cesium.Color.BLACK);
  return ent;
}

const STYLES = {
  satelliteBuildings: new Cesium.Cesium3DTileStyle({
    color: {
      conditions: [
        ["${feature['building']} === 'commercial'", "color('#d4c4a8', 0.72)"],
        ["${feature['building']} === 'residential'", "color('#c8b9a0', 0.68)"],
        ["true", "color('#bfb09a', 0.65)"],
      ],
    },
  }),
  simpleBuildings: new Cesium.Cesium3DTileStyle({
    color: {
      conditions: [
        ["${feature['building']} === 'commercial'", "color('#5b4dff', 0.95)"],
        ["${feature['building']} === 'apartments'", "color('#6e3dff', 0.92)"],
        ["${feature['building']} === 'residential'", "color('#4a6bff', 0.9)"],
        ["${feature['building']} === 'industrial'", "color('#3d5ae6', 0.9)"],
        ["${feature['building']} === 'retail'", "color('#7a5cff', 0.93)"],
        ["true", "color('#5560f0', 0.88)"],
      ],
    },
  }),
};

async function setupReal3DMap() {
  viewer.imageryLayers.removeAll();

  try {
    viewer.terrainProvider = await Cesium.createWorldTerrainAsync({
      requestVertexNormals: true,
    });
  } catch (err) {
    console.warn("World terrain unavailable", err);
  }

  try {
    state.buildings = await Cesium.createOsmBuildingsAsync();
    // Disable dynamic IBL — causes setDynamicLighting crashes on some GPUs/browsers
    if (state.buildings.environmentMapManager) {
      state.buildings.environmentMapManager.enabled = false;
    }
    if (state.buildings.imageBasedLighting) {
      try {
        state.buildings.imageBasedLighting.imageBasedLightingFactor =
          new Cesium.Cartesian2(1.0, 1.0);
      } catch (_) {}
    }
    viewer.scene.primitives.add(state.buildings);
  } catch (err) {
    console.warn("OSM buildings unavailable", err);
    state.buildings = null;
  }

  await setViewMode("simple", true);
}

async function setViewMode(mode, initial = false) {
  state.viewMode = mode;
  document.body.classList.toggle("simple-mode", mode === "simple");
  document.querySelectorAll(".mode-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.mode === mode);
  });

  // Unlock cinematic lookAt so SAT mode isn't stuck in empty space
  viewer.camera.cancelFlight();
  viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);

  viewer.imageryLayers.removeAll();

  if (mode === "satellite") {
    viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString("#1a1f18");
    viewer.scene.fog.density = 0.0002;
    viewer.scene.fog.minimumBrightness = 0.03;
    if (viewer.scene.skyAtmosphere) {
      viewer.scene.skyAtmosphere.hueShift = 0;
      viewer.scene.skyAtmosphere.saturationShift = 0;
      viewer.scene.skyAtmosphere.brightnessShift = 0;
    }
    viewer.scene.globe.enableLighting = false;
    viewer.clock.currentTime = Cesium.JulianDate.now();
    if (viewer.scene.atmosphere && Cesium.DynamicAtmosphereLightingType) {
      viewer.scene.atmosphere.dynamicLighting = Cesium.DynamicAtmosphereLightingType.NONE;
    }

    try {
      const esri = await Cesium.ArcGisMapServerImageryProvider.fromUrl(
        "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer"
      );
      const sat = viewer.imageryLayers.addImageryProvider(esri);
      sat.brightness = 1.08;
      sat.contrast = 1.12;
      sat.saturation = 1.05;
    } catch (err) {
      console.warn("Esri imagery failed", err);
      try {
        viewer.imageryLayers.addImageryProvider(
          new Cesium.UrlTemplateImageryProvider({
            url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
            credit: "© OpenStreetMap",
          })
        );
      } catch (_) {}
    }
    try {
      viewer.imageryLayers.addImageryProvider(
        new Cesium.UrlTemplateImageryProvider({
          url: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}.png",
          subdomains: ["a", "b", "c", "d"],
          credit: "© CARTO",
        })
      );
    } catch (_) {}

    if (state.buildings) state.buildings.style = STYLES.satelliteBuildings;
    el("mapSource").textContent = "SAT MODE · Esri Imagery + Terrain + OSM Buildings";
    el("modeHint").textContent =
      "SAT MODE: real satellite + 3D buildings. CDR ≠ GPS. Zoom to SUSPECT for street context.";

    // Don't keep simple-mode chase lock in SAT
    state.follow = false;
    el("followToggle").checked = false;
    state.userControlling = false;
  } else {
    // SIMPLE — violet/blue sci-fi city: roads + buildings, no satellite
    viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString("#0c0820");
    viewer.scene.globe.undergroundColor = Cesium.Color.fromCssColorString("#070414");
    viewer.scene.fog.density = 0.00022;
    viewer.scene.fog.minimumBrightness = 0.1;
    if (viewer.scene.skyAtmosphere) {
      viewer.scene.skyAtmosphere.hueShift = 0.45;
      viewer.scene.skyAtmosphere.saturationShift = 0.15;
      viewer.scene.skyAtmosphere.brightnessShift = -0.05;
    }
    viewer.scene.globe.enableLighting = false;
    viewer.clock.currentTime = Cesium.JulianDate.fromIso8601("2026-07-17T14:45:00Z");
    viewer.clock.shouldAnimate = false;
    if (viewer.scene.atmosphere && Cesium.DynamicAtmosphereLightingType) {
      viewer.scene.atmosphere.dynamicLighting = Cesium.DynamicAtmosphereLightingType.NONE;
    }

    viewer.scene.globe.show = true;

    try {
      const roads = viewer.imageryLayers.addImageryProvider(
        new Cesium.UrlTemplateImageryProvider({
          url: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
          subdomains: ["a", "b", "c", "d"],
          credit: "© CARTO / OSM",
        })
      );
      roads.hue = 0.72;
      roads.saturation = 1.85;
      roads.brightness = 0.85;
      roads.contrast = 1.25;
      roads.gamma = 0.85;
    } catch (err) {
      console.warn("Road basemap failed", err);
    }

    try {
      const grid = viewer.imageryLayers.addImageryProvider(
        new Cesium.GridImageryProvider({
          cells: 8,
          color: Cesium.Color.fromBytes(160, 120, 255, 40),
          glowColor: Cesium.Color.fromBytes(100, 140, 255, 20),
          glowWidth: 1,
          backgroundColor: Cesium.Color.fromBytes(0, 0, 0, 0),
        })
      );
      grid.alpha = 0.35;
    } catch (_) {}

    if (state.buildings) state.buildings.style = STYLES.simpleBuildings;
    el("mapSource").textContent =
      "SIMPLE MODE · Violet/blue roads + OSM 3D buildings";
    el("modeHint").textContent =
      "SIMPLE MODE: violet/blue city mesh · cinematic chase. Switch to SAT for real imagery.";

    if (!initial) {
      state.userControlling = false;
      state.follow = true;
      el("followToggle").checked = true;
    }
  }

  // Drop stale suspect entity so SAT/FIR can't keep an old green TARGET label
  if (viewer.entities.getById("suspect")) {
    viewer.entities.removeById("suspect");
  }

  // Refresh entities + reframe on suspect so tracking stays visible
  if (state.towers.length) placeTowers(state.towers);
  if (state.lastFix) {
    renderFix(state.lastFix, state.idx, true);
    frameOnSuspect(state.lastFix, 1.0, { snap: true });
  }

  // Resume playback if the track isn't finished
  if (!initial && state.track.length) {
    if (state.idx >= state.total - 1) {
      // Restart from beginning so SAT isn't stuck on COMPLETE
      state.idx = 0;
      state.lerpT = 1;
      state.lerpFrom = null;
      state.lerpTo = null;
      clearDynamics();
      if (state.track[0]) renderFix(state.track[0], 0, true);
    }
    state.playing = true;
    setLive("LIVE", "live");
    startAnim();
  }
}

setupReal3DMap();

document.getElementById("viewMode")?.addEventListener("click", (e) => {
  const btn = e.target.closest(".mode-btn");
  if (!btn) return;
  setViewMode(btn.dataset.mode);
});

// Cancel camera flights / cinematic lock when user grabs the map
["pointerdown", "wheel", "touchstart"].forEach((evt) => {
  viewer.canvas.addEventListener(
    evt,
    () => {
      viewer.camera.cancelFlight();
      viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
      state.userControlling = true;
      if (state.follow) {
        state.follow = false;
        el("followToggle").checked = false;
      }
    },
    { passive: true }
  );
});

function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toR = Math.PI / 180;
  const dLat = (lat2 - lat1) * toR;
  const dLon = (lon2 - lon1) * toR;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function formatGap(s) {
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  return `${(s / 3600).toFixed(1)} h`;
}

function setCase(caseId) {
  state.caseId = caseId;
  document.querySelectorAll(".case-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.case === caseId);
  });
  // Nuke suspect marker so FIR/SAT never inherits a stale green TARGET entity
  if (viewer.entities.getById("suspect")) {
    viewer.entities.removeById("suspect");
  }
  const heading = el("targetHeading");
  if (heading) {
    heading.textContent =
      caseId === "fir47" ? "FIR 47 · INDIVIDUALS" : "TARGET SELECT";
  }
  const ticker = el("ticker");
  if (ticker) {
    ticker.textContent =
      caseId === "fir47"
        ? "FIR 47 · NCCRP 222/2024 · MORA BHAGAL ↔ JAHANGIRPURA CORRIDOR · KALMAN TRACK"
        : "TRIANGULATION ENGINE ACTIVE · KALMAN FILTER ENGAGED · GROUND-CLAMPED TRACK";
  }
  loadTargets();
}

async function loadTargets() {
  const targets = await AUTH.api(`/api/targets?case=${encodeURIComponent(state.caseId)}`);
  const list = el("targetList");
  list.innerHTML = "";
  if (!Array.isArray(targets) || !targets.length) {
    list.innerHTML = `<div class="meta">No targets in this case.</div>`;
    return;
  }
  targets.forEach((t, i) => {
    const btn = document.createElement("button");
    btn.className = "target-btn" + (i === 0 ? " active" : "");
    const badge = t.corridor ? `<span class="badge">CORRIDOR</span>` : "";
    const name = t.name ? `${t.name}` : t.label;
    const sites = Array.isArray(t.sites) && t.sites.length
      ? ` · ${t.sites.join("↔")}`
      : "";
    btn.innerHTML = `
      <div class="op">${name}${badge}</div>
      <div class="meta">${t.msisdn} · ${t.ping_count} pings · ${t.tower_count} towers${sites}</div>
    `;
    btn.onclick = () => {
      document.querySelectorAll(".target-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      loadTarget(t.msisdn);
    };
    list.appendChild(btn);
  });
  loadTarget(targets[0].msisdn);
}

function clearDynamics() {
  state.trailPositions = [];
  state.lastHeatIdx = -1;
  // Keep tri-beams allocated; just park them (syncTriBeams will re-show next frame)
  for (let i = 0; i < MAX_TRI_BEAMS; i++) {
    const b = viewer.entities.getById(`tri-beam-${i}`);
    if (b) b.show = false;
  }
  state.beamEntities = [];
  state.heatEntities.forEach((e) => viewer.entities.remove(e));
  state.heatEntities = [];
  [
    "suspect",
    "rawPing",
    "uncertainty",
    "trail",
    "gapArc",
    "pulseRing",
    "suspectBeam",
    "suspectHalo",
    "suspectRing",
  ].forEach((id) => {
    const e = viewer.entities.getById(id);
    if (e) e.show = false;
  });
}

function clearTowers() {
  state.towerEntities.forEach((e) => {
    try {
      viewer.entities.remove(e);
    } catch (_) {}
  });
  state.towerEntities = [];
  const toRemove = [];
  viewer.entities.values.forEach((e) => {
    const id = e.id && String(e.id);
    if (
      id &&
      (id.startsWith("tower-") ||
        id.startsWith("cover-") ||
        id.startsWith("towercap-") ||
        id.startsWith("towerlbl-"))
    ) {
      toRemove.push(e);
    }
  });
  toRemove.forEach((e) => viewer.entities.remove(e));
}

/** Spread stacked co-located sectors so every CGI is visible on the map. */
function fanOutColocated(towers) {
  const groups = new Map();
  towers.forEach((t) => {
    const lat = Number(t.lat);
    const lon = Number(t.lon);
    if (!isValidLL(lat, lon)) return;
    const key = `${lat.toFixed(5)},${lon.toFixed(5)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  });
  const out = [];
  const R = 6371000;
  groups.forEach((group, key) => {
    if (group.length < 2) {
      out.push({ ...group[0] });
      return;
    }
    const [lat0, lon0] = key.split(",").map(Number);
    if (!isValidLL(lat0, lon0)) return;
    group
      .slice()
      .sort((a, b) => String(a.cgi).localeCompare(String(b.cgi)))
      .forEach((t, i) => {
        const bearing = ((i * 360) / group.length + 15) * (Math.PI / 180);
        const dist = 30 + (i % 3) * 6;
        const cosLat = Math.cos((lat0 * Math.PI) / 180);
        if (!Number.isFinite(cosLat) || Math.abs(cosLat) < 1e-6) {
          out.push({ ...t });
          return;
        }
        const lat = lat0 + ((dist * Math.cos(bearing)) / R) * (180 / Math.PI);
        const lon = lon0 + ((dist * Math.sin(bearing)) / (R * cosLat)) * (180 / Math.PI);
        if (!isValidLL(lat, lon)) {
          out.push({ ...t });
          return;
        }
        out.push({ ...t, lat, lon });
      });
  });
  return out;
}

function placeTowers(towers) {
  clearTowers();
  if (!Array.isArray(towers) || !towers.length) return;
  const simple = state.viewMode === "simple";
  // Always show EVERY tower; fan out co-located sectors (same eNodeB lat/lon)
  const list = fanOutColocated(
    towers.filter((t) => t && isValidLL(Number(t.lat), Number(t.lon)))
  ).sort((a, b) => (b.hits || 0) - (a.hits || 0));
  // Keep state.towers coords in sync so tri-beams hit the visible masts
  state.towers = list;
  list.forEach((t) => {
    if (!isValidLL(Number(t.lat), Number(t.lon))) return;
    const h = Math.max(55, (simple ? 70 : 50) + Math.min(t.hits || 0, 120) * 0.45);
    const mastColor = simple ? "#00f0ff" : "#ffcc66";
    const tid = eid("tower", t.cgi);
    const cid = eid("cover", t.cgi);
    const capId = eid("towercap", t.cgi);
    const lblId = eid("towerlbl", t.cgi);
    const shortCgi = String(t.cgi).length > 14 ? String(t.cgi).slice(-10) : String(t.cgi);

    // Mast body — absolute height so terrain tiles can't make it blink
    const mast = viewer.entities.add({
      id: tid,
      show: true,
      position: Cesium.Cartesian3.fromDegrees(t.lon, t.lat, h * 0.5),
      cylinder: {
        length: h,
        topRadius: simple ? 3.5 : 4.5,
        bottomRadius: simple ? 7 : 8,
        material: Cesium.Color.fromCssColorString(mastColor).withAlpha(0.92),
        outline: true,
        outlineColor: Cesium.Color.fromCssColorString(mastColor),
        outlineWidth: 2,
      },
    });

    // Cap point — always draws on top of buildings/terrain
    const cap = viewer.entities.add({
      id: capId,
      show: true,
      position: Cesium.Cartesian3.fromDegrees(t.lon, t.lat, h + 6),
      point: {
        pixelSize: simple ? 14 : 16,
        color: Cesium.Color.fromCssColorString(mastColor),
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 3,
        heightReference: Cesium.HeightReference.NONE,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        scaleByDistance: new Cesium.NearFarScalar(150, 1.3, 12000, 0.85),
      },
    });

    // Label always visible
    const lbl = viewer.entities.add({
      id: lblId,
      show: true,
      position: Cesium.Cartesian3.fromDegrees(t.lon, t.lat, h + 18),
      label: {
        text: `◆ ${shortCgi}`,
        font: "bold 11px Share Tech Mono",
        fillColor: Cesium.Color.fromCssColorString(mastColor),
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 4,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        pixelOffset: new Cesium.Cartesian2(0, -6),
        heightReference: Cesium.HeightReference.NONE,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        showBackground: true,
        backgroundColor: Cesium.Color.fromCssColorString("#000000").withAlpha(0.55),
        backgroundPadding: new Cesium.Cartesian2(5, 3),
        scaleByDistance: new Cesium.NearFarScalar(200, 1.1, 10000, 0.7),
      },
    });

    const cover = viewer.entities.add({
      id: cid,
      show: true,
      position: Cesium.Cartesian3.fromDegrees(t.lon, t.lat, 1),
      ellipse: {
        semiMajorAxis: simple ? 420 : 500,
        semiMinorAxis: simple ? 420 : 500,
        material: Cesium.Color.fromCssColorString(mastColor).withAlpha(simple ? 0.1 : 0.07),
        outline: true,
        outlineColor: Cesium.Color.fromCssColorString(mastColor).withAlpha(0.45),
        height: 1,
      },
    });
    state.towerEntities.push(mast, cap, lbl, cover);
  });
}

function streetLevelFly(lat, lon, duration = 1.4) {
  // Follow lock owns the camera in simple mode — flyTo vs lookAt race misses the suspect
  if (state.follow && state.viewMode === "simple" && !state.userControlling) {
    return;
  }
  viewer.camera.cancelFlight();
  viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
  const simple = state.viewMode === "simple";
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(
      lon,
      lat - (simple ? 0 : 0.0018),
      simple ? 420 : 900
    ),
    orientation: {
      heading: Cesium.Math.toRadians(simple ? state.cinematicHeading : 15),
      pitch: Cesium.Math.toRadians(simple ? -28 : -48),
      roll: 0,
    },
    duration,
  });
}

/** Cinematic chase lock. Pass snap:true to hard-frame on suspect (toggle / recenter). */
function applyCinematicCamera(f, { snap = false } = {}) {
  if (state.viewMode !== "simple") return;
  if (state.userControlling) return;
  if (!state.follow) return;
  if (!f || !isValidLL(Number(f.lat), Number(f.lon))) return;

  viewer.camera.cancelFlight();
  const target = Cesium.Cartesian3.fromDegrees(Number(f.lon), Number(f.lat), 8);
  if (snap) {
    // Stable framing so re-lock always lands on the marker
    state.cinematicHeading = 35;
  } else {
    state.cinematicHeading = (state.cinematicHeading + 0.15) % 360;
  }
  const heading = Cesium.Math.toRadians(state.cinematicHeading);
  const pitch = Cesium.Math.toRadians(-28);
  // Keep range steady on snap; soft confidence coupling while chasing
  const range = snap
    ? 380
    : 320 + Math.min(Number(f.confidence_m) || 100, 180) * 0.35;

  viewer.camera.lookAt(target, new Cesium.HeadingPitchRange(heading, pitch, range));
}

/** Reframe on current fix — chase lock in simple+follow, otherwise flyTo. */
function frameOnSuspect(f, duration = 1.0, { snap = true } = {}) {
  if (!f || !isValidLL(Number(f.lat), Number(f.lon))) return;
  state.userControlling = false;
  if (state.follow && state.viewMode === "simple") {
    applyCinematicCamera(f, { snap });
  } else {
    streetLevelFly(f.lat, f.lon, duration);
  }
}


function showGapBanner(fix) {
  const banner = el("gapBanner");
  banner.hidden = false;
  banner.textContent = `CDR time gap · ${formatGap(fix.gap_s)} · ${(fix.gap_m / 1000).toFixed(1)} km relocate · session ${fix.session_id + 1}`;
  clearTimeout(showGapBanner._t);
  showGapBanner._t = setTimeout(() => {
    banner.hidden = true;
  }, 3200);
}

async function loadTarget(msisdn) {
  stopAnim();
  clearDynamics();
  clearTowers();
  state.msisdn = msisdn;
  state.idx = 0;
  state.lerpT = 1;
  state.userControlling = false;
  setLive("LOADING…", "");

  const data = await AUTH.api(
    `/api/targets/${msisdn}?case=${encodeURIComponent(state.caseId)}`
  );
  state.track = data.track || [];
  state.towers = data.towers || [];
  state.total = state.track.length;

  placeTowers(state.towers);
  el("seekSlider").max = Math.max(state.total - 1, 0);
  el("statFixes").textContent = String(state.total);
  el("statTowers").textContent = String(data.tower_count ?? "—");
  const st = data.stats || {};
  el("statTri").textContent =
    st.pct_trilateration != null ? `${st.pct_trilateration.toFixed(0)}%` : "—";
  el("statConf").textContent =
    st.avg_refined_conf_m != null ? `${st.avg_refined_conf_m.toFixed(0)} m` : "—";

  if (state.track.length) {
    const first = state.track[0];
    if (state.viewMode === "simple") {
      state.follow = true;
      el("followToggle").checked = true;
      state.userControlling = false;
    }
    renderFix(first, 0, true);
    frameOnSuspect(first, 1.4, { snap: true });
  }

  setLive("READY", "paused");
  state.playing = true;
  setLive("LIVE", "live");
  startAnim();
}

function stopAnim() {
  if (state.anim) cancelAnimationFrame(state.anim);
  state.anim = null;
}

function startAnim() {
  stopAnim();
  let last = performance.now();

  const tick = (now) => {
    state.anim = requestAnimationFrame(tick);
    if (!state.playing || !state.track.length) return;

    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    // Hold on same-cell dwell before advancing
    if (now < state.dwellUntil) {
      if (state.viewMode === "simple" && state.lastFix) applyCinematicCamera(state.lastFix);
      return;
    }

    // Advance interpolation
    if (state.lerpT < 1 && state.lerpFrom && state.lerpTo) {
      const dist = Math.max(
        30,
        haversineM(
          state.lerpFrom.lat,
          state.lerpFrom.lon,
          state.lerpTo.lat,
          state.lerpTo.lon
        )
      );
      const duration = Math.min(8.0, Math.max(0.5, dist / (12 * state.speed)));
      state.lerpT = Math.min(1, state.lerpT + dt / duration);
      const t = easeInOut(state.lerpT);
      const cur = {
        ...state.lerpTo,
        lat: lerp(state.lerpFrom.lat, state.lerpTo.lat, t),
        lon: lerp(state.lerpFrom.lon, state.lerpTo.lon, t),
        alt_m: lerp(state.lerpFrom.alt_m || 0, state.lerpTo.alt_m || 0, t),
        confidence_m: lerp(state.lerpFrom.confidence_m, state.lerpTo.confidence_m, t),
        heading_deg: state.lerpTo.heading_deg,
      };
      renderFix(cur, state.idx, false);
      return;
    }

    if (state.idx >= state.total - 1) {
      state.playing = false;
      setLive("COMPLETE", "paused");
      return;
    }

    const from = state.track[state.idx];
    const to = state.track[state.idx + 1];
    state.idx += 1;

    if (to.is_gap_start || to.gap_m > 10000) {
      showGapBanner(to);
      state.trailPositions = [];
      const trail = viewer.entities.getById("trail");
      if (trail) trail.show = false;
      state.lerpFrom = null;
      state.lerpTo = null;
      state.lerpT = 1;
      renderFix(to, state.idx, true);
      if (!state.userControlling) frameOnSuspect(to, 1.0, { snap: true });
      state.dwellUntil = now + 900 / Math.max(state.speed, 1);
      return;
    }

    const stepDist = haversineM(from.lat, from.lon, to.lat, to.lon);
    if (from.cgi === to.cgi || stepDist < 40) {
      // Dwell instead of burning through hundreds of same-cell pings at 60fps
      state.lerpFrom = null;
      state.lerpTo = null;
      state.lerpT = 1;
      renderFix(to, state.idx, true);
      state.dwellUntil = now + 220 / Math.max(state.speed, 1);
      return;
    }

    state.lerpFrom = from;
    state.lerpTo = to;
    state.lerpT = 0;
  };

  state.anim = requestAnimationFrame(tick);
}

function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

function depositHeat(f, idx, simple, marker) {
  // Persistent heat corridor — once per track index, never flicker-removed mid-playback
  if (state.lastHeatIdx === idx) return;
  state.lastHeatIdx = idx;
  const r = Math.min(220, Math.max(70, Number(f.confidence_m) * 0.55));
  const heat = viewer.entities.add({
    id: eid("heat", `${idx}-${state.heatEntities.length}`),
    position: Cesium.Cartesian3.fromDegrees(f.lon, f.lat, 1),
    ellipse: {
      semiMajorAxis: r,
      semiMinorAxis: r * 0.85,
      material: Cesium.Color.fromCssColorString(marker).withAlpha(simple ? 0.1 : 0.16),
      outline: false,
      height: 1,
    },
  });
  state.heatEntities.push(heat);
  while (state.heatEntities.length > 120) {
    const old = state.heatEntities.shift();
    if (old) {
      try {
        viewer.entities.remove(old);
      } catch (_) {}
    }
  }
}

function syncTriBeams(f, pos, elev, simple) {
  if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) {
    return;
  }

  const usedSet = new Set(
    (Array.isArray(f.towers_used) ? f.towers_used : []).map((c) => String(c).toUpperCase())
  );
  if (f.cgi) usedSet.add(String(f.cgi).toUpperCase());

  // Active towers first, then every other mast — lines stay up (dim when inactive)
  const endpoints = [];
  const seen = new Set();
  const pushTw = (tw, active) => {
    if (!tw || !isValidLL(Number(tw.lat), Number(tw.lon))) return;
    const key = `${Number(tw.lat).toFixed(6)},${Number(tw.lon).toFixed(6)}`;
    if (seen.has(key)) return;
    seen.add(key);
    endpoints.push({
      lon: Number(tw.lon),
      lat: Number(tw.lat),
      cgi: tw.cgi,
      active,
      h: Math.max(40, 50 + Math.min(Number(tw.hits) || 1, 80) * 0.35),
    });
  };

  usedSet.forEach((cgi) => pushTw(towerByCgi(cgi), true));
  if (isValidLL(Number(f.raw_lat), Number(f.raw_lon))) {
    const key = `${Number(f.raw_lat).toFixed(6)},${Number(f.raw_lon).toFixed(6)}`;
    if (!seen.has(key)) {
      seen.add(key);
      endpoints.unshift({
        lon: Number(f.raw_lon),
        lat: Number(f.raw_lat),
        cgi: f.cgi,
        active: true,
        h: elev + 20,
      });
    }
  }
  state.towers.forEach((tw) => {
    pushTw(tw, usedSet.has(String(tw.cgi).toUpperCase()));
  });
  if (!endpoints.length && state.towers.length) {
    state.towers.forEach((tw) => pushTw(tw, true));
  }

  state.beamEntities = [];
  for (let i = 0; i < MAX_TRI_BEAMS; i++) {
    const id = `tri-beam-${i}`;
    const ep = endpoints[i];
    let ent = viewer.entities.getById(id);
    if (!ep) {
      if (ent) ent.show = false;
      continue;
    }
    const mastTop = safeCartographic(ep.lon, ep.lat, ep.h || elev + 25);
    if (!mastTop) {
      if (ent) ent.show = false;
      continue;
    }
    const colorHex = ep.active ? (i === 0 ? "#ff7a59" : "#ffe566") : simple ? "#3a6a88" : "#6a5a30";
    const width = ep.active ? (simple ? 3.5 : 4.5) : simple ? 1.5 : 2;
    // Fresh Cartesian3 array — NEVER wrap in ConstantProperty (crashes Cesium 1.128)
    const positions = [
      Cesium.Cartesian3.clone(mastTop),
      Cesium.Cartesian3.clone(pos),
    ];

    if (!ent) {
      ent = viewer.entities.add({
        id,
        show: true,
        polyline: {
          positions,
          width,
          material: new Cesium.PolylineGlowMaterialProperty({
            glowPower: ep.active ? 0.55 : 0.2,
            color: Cesium.Color.fromCssColorString(colorHex),
          }),
          clampToGround: false,
        },
      });
    } else {
      ent.show = true;
      ent.polyline.positions = positions;
      ent.polyline.width = width;
      // Only refresh material color when activity changes (avoid per-frame thrash)
      const wantActive = !!ep.active;
      if (ent._beamActive !== wantActive || ent._beamColor !== colorHex) {
        ent._beamActive = wantActive;
        ent._beamColor = colorHex;
        ent.polyline.material = new Cesium.PolylineGlowMaterialProperty({
          glowPower: wantActive ? 0.55 : 0.2,
          color: Cesium.Color.fromCssColorString(colorHex),
        });
      }
    }
    state.beamEntities.push(ent);
  }
}

function renderFix(f, idx, snap) {
  const simple = state.viewMode === "simple";
  el("progressIdx").textContent = `${idx + 1} / ${state.total}`;
  el("progressTs").textContent = (f.ts || "").replace("T", " ").slice(0, 19);
  el("seekSlider").value = idx;

  el("fixLat").textContent = f.lat.toFixed(6);
  el("fixLon").textContent = f.lon.toFixed(6);
  el("fixAlt").textContent = "ground";
  el("fixConf").textContent = `±${Number(f.confidence_m).toFixed(0)} m`;
  el("fixMethod").textContent = f.method;
  el("fixSpeed").textContent = `${(Number(f.speed_mps) * 3.6).toFixed(1)} km/h`;
  el("fixHeading").textContent = `${Number(f.heading_deg).toFixed(0)}°`;
  el("fixCgi").textContent = f.cgi || "—";
  el("fixTowers").textContent = (f.towers_used || []).join(", ") || "—";
  el("fixGap").textContent =
    f.gap_m > 1
      ? `${(f.gap_m / 1000).toFixed(2)} km / ${formatGap(f.gap_s || 0)}`
      : "—";

  const marker = SUSPECT_HEX;
  const accent = SUSPECT_ACCENT_HEX;
  const elev = simple ? 8 : 35;
  if (!isValidLL(Number(f.lat), Number(f.lon))) return;
  const pos = safeCartographic(Number(f.lon), Number(f.lat), elev);
  const groundPos = safeCartographic(Number(f.lon), Number(f.lat), 1.5);
  if (!pos || !groundPos) return;
  const r = Math.min(280, Math.max(90, Number(f.confidence_m) || 120));

  // Trail — keep FULL path for this session (only cleared on reset / gap / new target)
  const lastTrail = state.trailPositions[state.trailPositions.length - 1];
  const moved =
    !lastTrail ||
    Cesium.Cartesian3.distance(lastTrail, pos) > (snap ? 0.3 : 2);
  if (moved) {
    state.trailPositions.push(Cesium.Cartesian3.clone(pos));
  }
  if (state.trailPositions.length > 1) {
    let trail = viewer.entities.getById("trail");
    if (!trail) {
      trail = viewer.entities.add({
        id: "trail",
        show: true,
        polyline: {
          positions: new Cesium.CallbackProperty(
            () => state.trailPositions,
            false
          ),
          width: simple ? 6 : 8,
          // Solid + glow so the history path does not look like it fades out
          material: new Cesium.PolylineGlowMaterialProperty({
            glowPower: 0.25,
            color: Cesium.Color.fromCssColorString(marker).withAlpha(1.0),
          }),
          clampToGround: false,
          arcType: Cesium.ArcType.GEODESIC,
        },
      });
    } else {
      trail.show = true;
      trail.polyline.width = simple ? 6 : 8;
    }
  }

  // Live confidence disc — always on, updated in place
  upsertEntity(
    "uncertainty",
    {
      show: true,
      position: groundPos,
      ellipse: {
        semiMajorAxis: r,
        semiMinorAxis: r * 0.9,
        material: Cesium.Color.fromCssColorString(marker).withAlpha(simple ? 0.16 : 0.3),
        outline: true,
        outlineColor: Cesium.Color.fromCssColorString(marker).withAlpha(0.95),
        height: 1.5,
      },
    },
    (ent) => {
      ent.show = true;
      ent.position = groundPos;
      ent.ellipse.semiMajorAxis = r;
      ent.ellipse.semiMinorAxis = r * 0.9;
      ent.ellipse.material = Cesium.Color.fromCssColorString(marker).withAlpha(
        simple ? 0.16 : 0.3
      );
      ent.ellipse.outlineColor = Cesium.Color.fromCssColorString(marker).withAlpha(0.95);
    }
  );

  // Heat corridor: deposit on settled fixes only (not every lerp frame)
  if (snap || state.lerpT >= 1 || !state.lerpFrom) {
    depositHeat(f, idx, simple, marker);
  }

  upsertEntity(
    "suspectHalo",
    {
      show: true,
      position: groundPos,
      ellipse: {
        semiMajorAxis: simple ? 28 : 45,
        semiMinorAxis: simple ? 28 : 45,
        material: Cesium.Color.fromCssColorString(marker).withAlpha(simple ? 0.25 : 0.45),
        outline: true,
        outlineColor: Cesium.Color.fromCssColorString(accent),
        height: 2,
      },
    },
    (ent) => {
      ent.show = true;
      ent.position = groundPos;
    }
  );

  if (!simple) {
    const ring = viewer.entities.getById("pulseRing");
    if (ring) ring.show = false;
    upsertEntity(
      "suspectRing",
      {
        show: true,
        position: groundPos,
        ellipse: {
          semiMajorAxis: 70,
          semiMinorAxis: 70,
          material: Cesium.Color.TRANSPARENT,
          outline: true,
          outlineColor: Cesium.Color.fromCssColorString(accent).withAlpha(0.9),
          height: 3,
        },
      },
      (ent) => {
        ent.show = true;
        ent.position = groundPos;
      }
    );
  } else {
    const ring = viewer.entities.getById("suspectRing");
    if (ring) ring.show = false;
    upsertEntity(
      "pulseRing",
      {
        show: true,
        position: groundPos,
        ellipse: {
          semiMajorAxis: r * 1.35,
          semiMinorAxis: r * 1.2,
          material: Cesium.Color.TRANSPARENT,
          outline: true,
          outlineColor: Cesium.Color.fromCssColorString(accent).withAlpha(0.45),
          height: 1,
        },
      },
      (ent) => {
        ent.show = true;
        ent.position = groundPos;
        ent.ellipse.semiMajorAxis = r * 1.35;
        ent.ellipse.semiMinorAxis = r * 1.2;
      }
    );
  }

  const beamTop = safeCartographic(Number(f.lon), Number(f.lat), simple ? 110 : 160);
  const beamBot = safeCartographic(Number(f.lon), Number(f.lat), 2);
  if (beamTop && beamBot) {
    const beamPos = [beamBot, beamTop];
    let sbeam = viewer.entities.getById("suspectBeam");
    if (!sbeam) {
      viewer.entities.add({
        id: "suspectBeam",
        show: true,
        polyline: {
          positions: beamPos,
          width: simple ? 5 : 8,
          material: new Cesium.PolylineGlowMaterialProperty({
            glowPower: 0.6,
            color: Cesium.Color.fromCssColorString(SUSPECT_HEX),
          }),
          clampToGround: false,
        },
      });
    } else {
      sbeam.show = true;
      sbeam.polyline.positions = beamPos;
      sbeam.polyline.width = simple ? 5 : 8;
    }
  }

  syncSuspectMarker(pos, simple);

  if (f.raw_lat != null) {
    const rawPos = Cesium.Cartesian3.fromDegrees(
      f.raw_lon,
      f.raw_lat,
      simple ? 8 : 40
    );
    upsertEntity(
      "rawPing",
      {
        show: true,
        position: rawPos,
        point: {
          pixelSize: simple ? 9 : 14,
          color: Cesium.Color.fromCssColorString(accent),
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 2,
          heightReference: Cesium.HeightReference.NONE,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: {
          text: simple ? "BTS" : "TOWER",
          font: "bold 11px Share Tech Mono",
          fillColor: Cesium.Color.fromCssColorString(accent),
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          verticalOrigin: Cesium.VerticalOrigin.TOP,
          pixelOffset: new Cesium.Cartesian2(0, 16),
          heightReference: Cesium.HeightReference.NONE,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      },
      (ent) => {
        ent.show = true;
        ent.position = rawPos;
      }
    );
  } else {
    const raw = viewer.entities.getById("rawPing");
    if (raw) raw.show = false;
  }

  // Multi-tower triangulation links — update in place, always visible while tracking
  syncTriBeams(f, pos, elev, simple);

  state.lastFix = f;

  if (simple) {
    applyCinematicCamera(f);
  }
}

function setLive(label, cls) {
  el("liveLabel").textContent = label;
  el("livePill").className = "live-pill " + (cls || "");
}

// Controls
el("btnPlay").onclick = () => {
  state.playing = true;
  setLive("LIVE", "live");
  if (!state.anim) startAnim();
};
el("btnPause").onclick = () => {
  state.playing = false;
  setLive("PAUSED", "paused");
};
el("btnReset").onclick = () => {
  clearDynamics();
  state.idx = 0;
  state.lerpT = 1;
  state.userControlling = false;
  if (state.track.length) {
    renderFix(state.track[0], 0, true);
    frameOnSuspect(state.track[0], 0.9, { snap: true });
  }
  state.playing = true;
  setLive("LIVE", "live");
  startAnim();
};
el("btnRecenter").onclick = () => {
  if (state.lastFix) frameOnSuspect(state.lastFix, 0.9, { snap: true });
};
el("followToggle").onchange = (e) => {
  state.follow = e.target.checked;
  state.userControlling = false;
  viewer.camera.cancelFlight();
  if (state.follow) {
    if (state.lastFix) {
      if (state.viewMode === "simple") {
        applyCinematicCamera(state.lastFix, { snap: true });
      } else {
        viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
        streetLevelFly(state.lastFix.lat, state.lastFix.lon, 0.6);
      }
    }
  } else {
    // Unlock lookAt while keeping current world view (radius flash on drag is Cesium rendering)
    viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
  }
};
el("speedSlider").oninput = (e) => {
  state.speed = Number(e.target.value);
  el("speedVal").textContent = `${state.speed}×`;
};
el("seekSlider").onchange = (e) => {
  clearDynamics();
  state.idx = Number(e.target.value);
  state.lerpT = 1;
  const f = state.track[state.idx];
  if (f) {
    renderFix(f, state.idx, true);
    if (!state.userControlling) frameOnSuspect(f, 0.7, { snap: true });
  }
};

document.getElementById("caseMenu")?.addEventListener("click", (e) => {
  const btn = e.target.closest(".case-btn");
  if (!btn || btn.dataset.case === state.caseId) return;
  setCase(btn.dataset.case);
});

document.getElementById("logoutBtn")?.addEventListener("click", () => AUTH.logout());

(async function boot() {
  try {
    const ok = await AUTH.ready;
    if (!ok) return;
    const me = AUTH.getUser();
    if (me) {
      const chip = el("userChip");
      if (chip) chip.textContent = `${me.username.toUpperCase()} · ${me.role.toUpperCase()}`;
    }
    await loadTargets();
  } catch (err) {
    console.error(err);
    el("targetList").innerHTML = `<div class="meta">Failed to load targets.</div>`;
  }
})();
