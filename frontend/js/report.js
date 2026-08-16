/* E-Rakshak Pinpoint — intelligence report renderer. Professional, government-standard. */

const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtTs(iso, withSec = false) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d)) return String(iso);
  const date = d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", ...(withSec ? { second: "2-digit" } : {}) });
  return `${date} · ${time}`;
}

function fmtDur(h) {
  if (h == null || isNaN(h)) return "—";
  if (h < 1) return `${Math.round(h * 60)} min`;
  if (h < 48) return `${h.toFixed(1)} h`;
  return `${(h / 24).toFixed(1)} days`;
}

function fmtKm(v) {
  if (v == null || isNaN(v)) return "—";
  return `${Number(v).toLocaleString("en-GB", { maximumFractionDigits: 2 })} km`;
}

function fmtNum(v, dec = 0) {
  if (v == null || isNaN(v)) return "—";
  return Number(v).toLocaleString("en-GB", { maximumFractionDigits: dec });
}

function refFrom(iso) {
  if (!iso) return "RPT-UNKNOWN";
  const d = new Date(iso);
  return `RPT-${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}-01`;
}

const state = {
  cases: [],
  caseId: "erakshak",
  targets: [],
  targetId: null,
  report: null,
};

/* ------------------------------------------------------------------ */
/* Classification banner                                               */
/* ------------------------------------------------------------------ */

function classificationBar(label = "RESTRICTED") {
  const cl = String(label || "RESTRICTED").toUpperCase();
  const cls = cl === "TOP SECRET" ? "ts" : cl === "SECRET" ? "s" : cl === "RESTRICTED" ? "r" : "c";
  return `<div class="class-bar ${cls}"><span>${esc(cl)}</span> — NOT TO BE DISCLOSED · HANDLING: ${esc(cl)} / NOFORN · VIEW ONLY ON AUTHORISED SYSTEMS</div>`;
}

/* ------------------------------------------------------------------ */
/* Document chrome                                                     */
/* ------------------------------------------------------------------ */

function docHeader(r) {
  return `
    <header class="doc-header">
      <div class="doc-head-left">
        <div class="doc-emblem"><span>★</span></div>
        <div>
          <div class="doc-agency">TACNET · TELECOM ANALYSIS CELL</div>
          <div class="doc-org">E-RAKSHAK PINPOINT GEOLOCATION INVESTIGATION</div>
        </div>
      </div>
      <div class="doc-head-right">
        <div class="doc-meta"><span>REPORT REF</span><strong>${esc(refFrom(r.generated_at))}</strong></div>
        <div class="doc-meta"><span>CLASSIFICATION</span><strong>${esc(r.classification || "RESTRICTED")}</strong></div>
        <div class="doc-meta"><span>DATE ISSUED</span><strong>${esc(fmtTs(r.generated_at))}</strong></div>
        <div class="doc-meta"><span>PREPARED BY</span><strong>${esc(r.generated_by || "—").toUpperCase()}</strong></div>
      </div>
    </header>
  `;
}

function docFooter(r) {
  const rec = state.targets.find((t) => t.msisdn === state.targetId);
  return `
    <footer class="doc-footer">
      <div class="signature-grid">
        <div class="sig-block">
          <div class="sig-line"></div>
          <div class="sig-name">Officer In Charge</div>
          <div class="sig-role">Telecom Analysis Cell</div>
        </div>
        <div class="sig-block">
          <div class="sig-line"></div>
          <div class="sig-name">Case Reference</div>
          <div class="sig-role">${esc(r.case_id.toUpperCase())}</div>
        </div>
        <div class="sig-block">
          <div class="sig-line"></div>
          <div class="sig-name">System Generated</div>
          <div class="sig-role">${esc(fmtTs(r.generated_at))}</div>
        </div>
      </div>
      <div class="doc-foot-note">
        This report is computer-generated from telecom Call Detail Records and Location Based
        Services data. Positions are estimates derived from cell-site triangulation and are not
        a precise GPS fix. ${rec ? `Subject MSISDN ${esc(rec.msisdn)}` : ""} · Handle in accordance
        with ${esc(r.classification || "RESTRICTED")} regulations.
      </div>
    </footer>
  `;
}

/* ------------------------------------------------------------------ */
/* Case report                                                         */
/* ------------------------------------------------------------------ */

function renderCaseReport(r) {
  const s = r.summary || {};
  const rows = (r.targets || []).map((t) => `
    <tr data-msisdn="${esc(t.msisdn)}" class="clickable">
      <td class="mono">${esc(t.msisdn)}</td>
      <td>${esc(t.name || "—")}${t.corridor ? ' <span class="tag corridor">CORRIDOR</span>' : ""}</td>
      <td>${esc(t.operator || "—")}</td>
      <td class="num">${fmtNum(t.ping_count)}</td>
      <td class="num">${fmtNum(t.tower_count)}</td>
      <td class="mono">${esc(fmtTs(t.start))}</td>
      <td class="mono">${esc(fmtTs(t.end))}</td>
      <td class="num">${fmtKm(t.distance_km)}</td>
      <td class="num">${t.max_speed_kmh != null ? `${fmtNum(t.max_speed_kmh, 1)} km/h` : "—"}</td>
      <td class="num">${t.avg_confidence_m != null ? `±${fmtNum(t.avg_confidence_m)} m` : "—"}</td>
      <td class="num">${t.tri_pct != null ? `${fmtNum(t.tri_pct)}%` : "—"}</td>
      <td class="num">${fmtNum(t.sessions)}</td>
    </tr>
  `).join("");

  const ops = (s.operators || []).map((o) => `<span class="op-chip">${esc(o)}</span>`).join(" ");

  return `
    ${classificationBar(r.classification)}
    <article class="doc">
      ${docHeader(r)}
      <section class="case-title-block">
        <p class="title-kicker">OPERATIONAL SUMMARY</p>
        <h1 class="doc-title">${esc((r.case_id === "fir47" ? "FIR 47" : "E-RAKSHAK").toUpperCase())}</h1>
        <p class="doc-subtitle">${esc(r.subtitle || "")}</p>
      </section>

      <section class="kv-grid">
        <div class="kv"><span>COVERAGE PERIOD</span><strong>${esc(fmtTs(r.period && r.period.start))} → ${esc(fmtTs(r.period && r.period.end))}</strong></div>
        <div class="kv"><span>PERIOD LENGTH</span><strong>${fmtDur(r.period && r.period.duration_h)}</strong></div>
        <div class="kv"><span>SUBJECTS TRACKED</span><strong>${fmtNum(s.targets)}</strong></div>
        <div class="kv"><span>OBSERVATIONS</span><strong>${fmtNum(s.total_pings)}</strong></div>
        <div class="kv"><span>CELL TOWERS</span><strong>${fmtNum(s.total_towers)}</strong></div>
        <div class="kv"><span>COMBINED DISTANCE</span><strong>${fmtKm(s.total_distance_km)}</strong></div>
        <div class="kv"><span>OPERATORS</span><strong class="ops">${ops || "—"}</strong></div>
        <div class="kv"><span>CORRIDOR MOVERS</span><strong>${fmtNum(s.corridor_targets)}</strong></div>
      </section>

      <section class="sec">
        <div class="sec-head">
          <h2>1. Subject Register</h2>
          <p>All individuals with telephony activity captured within the designated coverage area.</p>
        </div>
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>MSISDN</th><th>SUBJECT</th><th>OPERATOR</th>
                <th class="num">PINGS</th><th class="num">TOWERS</th>
                <th>PERIOD START</th><th>PERIOD END</th>
                <th class="num">DISTANCE</th><th class="num">MAX SPEED</th>
                <th class="num">CONF.</th><th class="num">TRI %</th><th class="num">SESSIONS</th>
              </tr>
            </thead>
            <tbody>${rows || `<tr><td colspan="12" class="empty">No targets recorded.</td></tr>`}</tbody>
          </table>
        </div>
        <p class="table-hint">Select a row to open the full subject movement report.</p>
      </section>

      ${docFooter(r)}
    </article>
    ${classificationBar(r.classification)}
  `;
}

/* ------------------------------------------------------------------ */
/* Target report                                                       */
/* ------------------------------------------------------------------ */

function hourlyChart(hourly) {
  const max = Math.max(1, ...(hourly || []));
  const bars = (hourly || []).map((v, h) => {
    const pct = Math.round((v / max) * 100);
    return `
      <div class="hr" title="${String(h).padStart(2, "0")}:00 — ${v}">
        <div class="hr-bar" style="height:${Math.max(pct, v > 0 ? 4 : 0)}%"></div>
        <span class="hr-label">${String(h).padStart(2, "0")}</span>
      </div>`;
  }).join("");
  return `
    <div class="chart-head">
      <div><h3>Hourly Activity Distribution</h3><p>Network events per hour (IST, local clock).</p></div>
      <div class="chart-peak">PEAK <strong>${String(hourly.indexOf(max)).padStart(2, "0")}:00</strong></div>
    </div>
    <div class="hourly-chart">${bars}</div>`;
}

function towerTable(towers) {
  const rows = (towers || []).map((t) => `
    <tr>
      <td class="mono">${esc(t.cgi)}</td>
      <td>${esc(t.name || "—")}</td>
      <td>${esc(t.operator || "—")}</td>
      <td class="num mono">${t.lat != null ? t.lat.toFixed(6) : "—"}</td>
      <td class="num mono">${t.lon != null ? t.lon.toFixed(6) : "—"}</td>
      <td class="num">${fmtNum(t.hits)}</td>
      <td class="share-cell">
        <span class="share-track"><i style="width:${Math.min(100, t.share || 0)}%"></i></span>
        <span class="share-val">${fmtNum(t.share, 1)}%</span>
      </td>
    </tr>`).join("");
  return `
    <div class="table-wrap">
      <table class="data-table">
        <thead><tr>
          <th>CGI / CELL ID</th><th>SITE</th><th>OPERATOR</th>
          <th class="num">LATITUDE</th><th class="num">LONGITUDE</th>
          <th class="num">HITS</th><th>SHARE</th>
        </tr></thead>
        <tbody>${rows || `<tr><td colspan="7" class="empty">No tower data.</td></tr>`}</tbody>
      </table>
    </div>`;
}

function sessionsTable(sessions) {
  const rows = (sessions || []).map((s) => `
    <tr>
      <td class="num">${fmtNum(s.id)}</td>
      <td class="mono">${esc(fmtTs(s.start))}</td>
      <td class="mono">${esc(fmtTs(s.end))}</td>
      <td class="num">${fmtNum(s.points)}</td>
      <td class="num">${fmtKm(s.distance_km)}</td>
    </tr>`).join("");
  return `
    <div class="table-wrap">
      <table class="data-table">
        <thead><tr><th class="num">#</th><th>START</th><th>END</th><th class="num">FIXES</th><th class="num">DISTANCE</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="5" class="empty">No movement sessions.</td></tr>`}</tbody>
      </table>
    </div>`;
}

function methodBreakdown(byMethod) {
  const entries = Object.entries(byMethod || {}).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((a, [, v]) => a + v, 0) || 1;
  const rows = entries.map(([m, v]) => `
    <div class="method-row">
      <span class="method-name">${esc(m.toUpperCase())}</span>
      <span class="share-track"><i style="width:${Math.round((v / total) * 100)}%"></i></span>
      <span class="method-val">${fmtNum(v)}</span>
    </div>`).join("");
  return `<div class="method-box">${rows || `<div class="empty">No data.</div>`}</div>`;
}

function renderTargetReport(r) {
  const c = r.coverage || {};
  const m = r.metrics || {};
  const cf = r.confidence || {};
  const center = r.center || {};
  const bbox = r.bbox || {};

  const cards = [
    { k: "TOTAL DISTANCE", v: fmtKm(m.distance_km) },
    { k: "OBSERVATIONS", v: fmtNum(c.ping_count) },
    { k: "SESSIONS", v: fmtNum(m.sessions) },
    { k: "MAX SPEED", v: m.max_speed_kmh != null ? `${fmtNum(m.max_speed_kmh, 1)} km/h` : "—" },
    { k: "AVG. CONFIDENCE", v: cf.avg != null ? `±${fmtNum(cf.avg)} m` : "—" },
    { k: "TRIANGULATION", v: m.tri_pct != null ? `${fmtNum(m.tri_pct)}%` : "—" },
    { k: "LONGEST GAP", v: m.longest_gap_h != null ? `${fmtNum(m.longest_gap_h, 1)} h` : "—" },
    { k: "CELL TOWERS", v: fmtNum(c.tower_count) },
  ].map((x) => `<div class="metric"><span class="metric-k">${x.k}</span><span class="metric-v">${x.v}</span></div>`).join("");

  return `
    ${classificationBar(r.classification)}
    <article class="doc">
      ${docHeader(r)}

      <section class="case-title-block">
        <p class="title-kicker">SUBJECT MOVEMENT &amp; NETWORK ANALYSIS</p>
        <h1 class="doc-title">${esc((r.name ? r.name.toUpperCase() : r.label || r.msisdn).slice(0, 60))}</h1>
        <p class="doc-subtitle">Subject identity ${esc(r.msisdn)} · ${esc(r.operator || "Unknown operator")} · Case ${esc(r.case_id.toUpperCase())}</p>
      </section>

      <section class="metric-grid">${cards}</section>

      <section class="sec">
        <div class="sec-head"><h2>1. Subject Details</h2></div>
        <div class="kv-grid two">
          <div class="kv"><span>MSISDN</span><strong class="mono">${esc(r.msisdn)}</strong></div>
          <div class="kv"><span>OPERATOR</span><strong>${esc(r.operator || "—")}</strong></div>
          <div class="kv"><span>PERIOD START</span><strong>${esc(fmtTs(c.start))}</strong></div>
          <div class="kv"><span>PERIOD END</span><strong>${esc(fmtTs(c.end))}</strong></div>
          <div class="kv"><span>COVERAGE LENGTH</span><strong>${fmtDur(c.duration_h)}</strong></div>
          <div class="kv"><span>AVG. CENTRE</span><strong class="mono">${center.lat != null ? `${center.lat.toFixed(6)}, ${center.lon.toFixed(6)}` : "—"}</strong></div>
          <div class="kv"><span>AREA (BBOX)</span><strong class="mono">${bbox.min_lat != null ? `${bbox.min_lat.toFixed(4)}→${bbox.max_lat.toFixed(4)} N · ${bbox.min_lon.toFixed(4)}→${bbox.max_lon.toFixed(4)} E` : "—"}</strong></div>
          <div class="kv"><span>CONFIDENCE RANGE</span><strong>${cf.min != null ? `${fmtNum(cf.min)}–${fmtNum(cf.max)} m` : "—"}</strong></div>
        </div>
      </section>

      <section class="sec">
        <div class="sec-head"><h2>2. Activity Profile</h2><p>Distribution of network events across the observation window.</p></div>
        ${hourlyChart(r.hourly || [])}
      </section>

      <section class="sec">
        <div class="sec-head"><h2>3. Cell Tower Involvement</h2><p>Most-frequently observed serving cells and their estimated share.</p></div>
        ${towerTable(r.top_towers)}
      </section>

      <section class="sec two-col">
        <div class="col">
          <div class="sec-head"><h2>4. Positional Method</h2><p>How each fix was derived.</p></div>
          ${methodBreakdown(r.by_method)}
        </div>
        <div class="col">
          <div class="sec-head"><h2>5. Movement Sessions</h2><p>Discrete continuity periods in the subject's track.</p></div>
          ${sessionsTable(r.sessions)}
        </div>
      </section>

      ${docFooter(r)}
    </article>
    ${classificationBar(r.classification)}
  `;
}

/* ------------------------------------------------------------------ */
/* Loading / state                                                     */
/* ------------------------------------------------------------------ */

function setLoading(on) {
  $("loading").hidden = !on;
}

function setError(msg) {
  const b = $("errorBanner");
  if (msg) {
    b.textContent = msg;
    b.hidden = false;
  } else {
    b.hidden = true;
  }
}

async function loadCases() {
  const cases = await AUTH.api("/api/cases");
  state.cases = cases;
  $("caseSelect").innerHTML = cases
    .map((c) => `<option value="${esc(c.id)}">${esc(c.label)} · ${esc(c.subtitle || "")}</option>`)
    .join("");
}

async function loadTargets() {
  const targets = await AUTH.api(`/api/targets?case=${encodeURIComponent(state.caseId)}`);
  state.targets = targets;
  const sel = $("targetSelect");
  sel.disabled = !targets.length;
  sel.innerHTML = [
    `<option value="">— WHOLE CASE —</option>`,
    ...targets.map((t) => `<option value="${esc(t.msisdn)}">${esc(t.name || t.label || t.msisdn)} · ${esc(t.msisdn)}</option>`),
  ].join("");
  return targets;
}

async function renderCase() {
  setError("");
  setLoading(true);
  try {
    const r = await AUTH.api(`/api/reports/case/${encodeURIComponent(state.caseId)}`);
    state.report = r;
    state.targetId = null;
    $("targetSelect").value = "";
    $("reportRoot").innerHTML = renderCaseReport(r);
    bindCaseRows();
  } catch (err) {
    setError(err.message || "Failed to load case report");
  } finally {
    setLoading(false);
  }
}

async function renderTarget(msisdn) {
  setError("");
  setLoading(true);
  try {
    const r = await AUTH.api(`/api/reports/target/${encodeURIComponent(msisdn)}?case=${encodeURIComponent(state.caseId)}`);
    state.report = r;
    state.targetId = msisdn;
    $("reportRoot").innerHTML = renderTargetReport(r);
  } catch (err) {
    setError(err.message || "Failed to load target report");
  } finally {
    setLoading(false);
  }
}

function bindCaseRows() {
  document.querySelectorAll("#reportRoot tr.clickable").forEach((tr) => {
    tr.addEventListener("click", () => {
      const msisdn = tr.dataset.msisdn;
      $("targetSelect").value = msisdn;
      renderTarget(msisdn);
    });
  });
}

/* ------------------------------------------------------------------ */
/* Controls                                                            */
/* ------------------------------------------------------------------ */

$("caseSelect").addEventListener("change", async (e) => {
  state.caseId = e.target.value;
  await loadTargets();
  renderCase();
});

$("targetSelect").addEventListener("change", (e) => {
  if (e.target.value) renderTarget(e.target.value);
  else renderCase();
});

$("btnPrint").addEventListener("click", () => window.print());

$("btnCsv").addEventListener("click", async () => {
  try {
    const target = state.targetId;
    if (target) {
      await AUTH.download(`/api/reports/export/target/${encodeURIComponent(target)}.csv?case=${encodeURIComponent(state.caseId)}`, `${state.caseId}_${target}_track.csv`);
    } else {
      await AUTH.download(`/api/reports/export/case/${encodeURIComponent(state.caseId)}.csv`, `${state.caseId}_summary.csv`);
    }
  } catch (err) {
    setError(err.message || "Export failed");
  }
});

$("btnJson").addEventListener("click", async () => {
  try {
    const target = state.targetId;
    if (target) {
      await AUTH.download(`/api/reports/export/target/${encodeURIComponent(target)}.json?case=${encodeURIComponent(state.caseId)}`, `${state.caseId}_${target}_report.json`);
    } else {
      await AUTH.download(`/api/reports/export/case/${encodeURIComponent(state.caseId)}.json`, `${state.caseId}_report.json`);
    }
  } catch (err) {
    setError(err.message || "Export failed");
  }
});

$("btnLogout").addEventListener("click", () => AUTH.logout());

/* ------------------------------------------------------------------ */
/* Admin — user management                                             */
/* ------------------------------------------------------------------ */

function isAdmin() {
  const me = AUTH.getUser();
  return !!me && me.role === "admin";
}

async function renderUsers() {
  const users = await AUTH.api("/api/admin/users");
  const me = AUTH.getUser();
  $("usersBody").innerHTML = users
    .map((u) => `
      <tr>
        <td class="mono">${esc(u.username)}</td>
        <td>${esc((u.role || "").toUpperCase())}</td>
        <td>${u.must_change_password ? '<span class="tag corridor">PENDING PASSWORD</span>' : '<span class="tag ok">ACTIVE</span>'}</td>
        <td class="mono">${esc(fmtTs(u.created))}</td>
        <td>${esc(u.created_by || "—")}</td>
        <td class="num actions">
          <button type="button" class="mini" data-act="reset" data-user="${esc(u.username)}" ${u.username === me.username ? "disabled" : ""}>RESET PW</button>
          <button type="button" class="mini" data-act="del" data-user="${esc(u.username)}" ${u.username === me.username ? "disabled" : ""}>DELETE</button>
        </td>
      </tr>`)
    .join("");
}

function showAdmin(on) {
  $("adminPanel").hidden = !on;
  $("reportRoot").hidden = on;
  $("exportGroup").hidden = on;
  $("btnPrint").hidden = on;
  if (on) renderUsers().catch((e) => setError(e.message));
}

$("btnAdmin").addEventListener("click", () => showAdmin(true));
$("btnBackReports").addEventListener("click", () => showAdmin(false));

$("userForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  setError("");
  const username = $("nuUsername").value.trim();
  const password = $("nuPassword").value;
  const role = $("nuRole").value;
  try {
    await AUTH.api("/api/admin/users", { method: "POST", body: { username, password, role } });
    $("nuUsername").value = "";
    $("nuPassword").value = "";
    await renderUsers();
  } catch (err) {
    setError(err.message || "Failed to create user");
  }
});

$("usersBody").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn || btn.disabled) return;
  setError("");
  const username = btn.dataset.user;
  try {
    if (btn.dataset.act === "del") {
      if (!confirm(`Delete operator ${username}? This cannot be undone.`)) return;
      await AUTH.api(`/api/admin/users/${encodeURIComponent(username)}`, { method: "DELETE" });
    } else if (btn.dataset.act === "reset") {
      if (!confirm(`Reset the password for ${username}?`)) return;
      await AUTH.api(`/api/admin/users/${encodeURIComponent(username)}`, {
        method: "PATCH",
        body: { password: `${username}Pass2026` },
      });
    }
    await renderUsers();
  } catch (err) {
    setError(err.message || "Operation failed");
  }
});

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

(async function boot() {
  try {
    const ok = await AUTH.ready;
    if (!ok) return;
    const me = AUTH.getUser();
    if (me) $("userChip").textContent = `${me.username.toUpperCase()} · ${me.role.toUpperCase()}`;
    $("btnAdmin").hidden = !isAdmin();
    await loadCases();
    const first = state.cases[0];
    if (first) state.caseId = first.id;
    await loadTargets();
    await renderCase();
  } catch (err) {
    setError(err.message || "Failed to initialise report console");
  }
})();
