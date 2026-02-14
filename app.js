const CASE_FILES = {
  low: "./demo_cases/case_low_risk_nl.json",
  moderate: "./demo_cases/case_moderate_risk_nl.json",
  high: "./demo_cases/case_high_risk_nl.json",
};

const AGENTS = {
  lead: { name: "Lead", role: "Orchestration", color: "#4d8fff", x: 450, y: 70, short: "LEAD" },
  ndt: { name: "NDT-Triage", role: "Indicators + Red Flags", color: "#00e88f", x: 710, y: 170, short: "NDT" },
  psycho: { name: "Psychosocial", role: "Fear/Stress/Adherence", color: "#ffd23f", x: 710, y: 350, short: "PSY" },
  pathway: { name: "Pathway", role: "State Machine", color: "#bf6dff", x: 450, y: 450, short: "PATH" },
  interv: { name: "Intervention", role: "EBP + Ergonomics", color: "#ff7b3a", x: 190, y: 350, short: "INT" },
  audit: { name: "Outcome-Auditor", role: "Quality + Value", color: "#ff5ca1", x: 190, y: 170, short: "AUD" },
};

let activeCase = null;
let speedMultiplier = 1;
let running = false;
let debateMode = "consensus";
let viewMode = "clinical";
let activeFilter = null; // { type: 'conn'|'agent', id }
let activePhase = null;
let flatInteractions = [];
let connections = [];
let pathEls = {};
const PHASE_ORDER = ["Intake", "Risk Check", "Debate", "Plan", "Follow-up"];

function showPanel(id, ev) {
  document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
  document.querySelectorAll(".nav-btn").forEach((b) => b.classList.remove("active"));
  document.getElementById(id).classList.add("active");
  if (ev && ev.currentTarget) ev.currentTarget.classList.add("active");
}

function setSpeed(s) {
  speedMultiplier = s;
  document.querySelectorAll(".speed-btn").forEach((b) => b.classList.toggle("active", parseFloat(b.dataset.speed) === s));
}

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
  return el;
}

function getRiskLabel(caseData) {
  if (caseData.case_id.includes("HIGH")) return "high";
  if (caseData.case_id.includes("MOD")) return "moderate";
  return "low";
}

function getDebateModeLabel(mode) {
  if (mode === "devil") return "Devil's advocate";
  if (mode === "safety") return "Safety-first";
  return "Clinical consensus";
}

function getDecisionType(from) {
  if (from === "ndt") return "Safety Check";
  if (from === "psycho") return "Psychosocial Lens";
  if (from === "pathway") return "Pathway Logic";
  if (from === "interv") return "Exercise Plan";
  if (from === "audit") return "Quality Gate";
  return "Synthesis";
}

function getEvidenceAnchor(type) {
  if (type === "Safety Check") return "Nijmeegse beslisboom + red-flag screening";
  if (type === "Psychosocial Lens") return "KNGF psychosocial stratificatie + gedrag";
  if (type === "Pathway Logic") return "HOAC-II probleemlijst + ICF domeinen";
  if (type === "Exercise Plan") return "KNGF CLBP graded activity + dosering";
  if (type === "Quality Gate") return "PROM trendcontrole (ODI/PSFS/NRS)";
  return "Multidisciplinair consensusprotocol";
}

function getPhaseByIndex(i) {
  if (i <= 1) return "Intake";
  if (i <= 3) return "Risk Check";
  if (i <= 7) return "Debate";
  if (i <= 9) return "Plan";
  return "Follow-up";
}

function toPatientLanguage(item, caseData) {
  const person = caseData.patient_profile.name_alias;
  const decision = item.st === "accepted" ? "goedgekeurd" : item.st === "partial" ? "aangepast" : "nog niet akkoord";
  return `Voor ${person}: dit onderdeel is ${decision}. Actie: ${item.type.toLowerCase()} met duidelijke vervolgstap.`;
}

function enrichInteractions(items, caseData) {
  return items.map((it, idx) => {
    const phase = getPhaseByIndex(idx);
    const type = getDecisionType(it.from);
    return {
      ...it,
      n: idx + 1,
      phase,
      type,
      evidence: getEvidenceAnchor(type),
      patient_text: toPatientLanguage({ ...it, type }, caseData),
    };
  });
}

function applyDebateMode(base, caseData, mode) {
  const risk = getRiskLabel(caseData);
  const adjusted = base.map((it) => ({ ...it }));

  if (mode === "devil") {
    adjusted.forEach((it) => {
      if (it.from === "audit" || it.from === "lead") {
        it.ch = `${it.ch} Kritische tegenvraag: welke hypothese kan dit besluit falsifiëren?`;
      }
    });
    if (risk !== "high") {
      if (adjusted[2]) adjusted[2].st = "partial";
      if (adjusted[4]) adjusted[4].st = "rejected";
      if (adjusted[4]) adjusted[4].re = "Rejected: eerst alternatieve verklaringen uitsluiten, daarna plan vrijgeven.";
    }
  }

  if (mode === "safety") {
    adjusted.forEach((it) => {
      if (it.from === "ndt" || it.from === "audit") {
        it.ch = `${it.ch} Veiligheidscheck prioriteit: stopcriteria expliciet.`;
      }
    });
    if (adjusted[3] && risk !== "high") {
      adjusted[3].st = "partial";
      adjusted[3].re = "Partial: lagere startbelasting en extra safety checkpoint op dag 7.";
    }
  }

  return enrichInteractions(adjusted, caseData);
}

function buildCaseInteractions(caseData, mode = "consensus") {
  const p = caseData.patient_profile;
  const risk = getRiskLabel(caseData);
  let base = [];

  if (risk === "high") {
    base = [
      { n: 1, from: "ndt", to: "lead", ch: `${p.name_alias} (${p.age}) heeft neurologische uitval, mictieproblemen en nachtpijn.`, re: "Lead activeert directe veiligheidsroute, geen standaard oefentraject.", st: "accepted" },
      { n: 2, from: "pathway", to: "lead", ch: "State voorstel: RED_FLAG_SCREEN -> HANDOFF_TRIGGER.", re: "Accepted. Directe escalatie blijft leidend.", st: "accepted" },
      { n: 3, from: "psycho", to: "lead", ch: "Stress is hoog, maar psychotraject pas na medische uitsluiting ernstige pathologie.", re: "Accepted.", st: "accepted" },
      { n: 4, from: "interv", to: "lead", ch: "Voor nu alleen veilige geruststelling en ADL-advies zonder load progression.", re: "Accepted. Geen oefenschema tot beoordeling.", st: "accepted" },
      { n: 5, from: "audit", to: "lead", ch: "Quality gate: expliciet handoff-criterium en stopregels tonen.", re: "Accepted.", st: "accepted" },
      { n: 6, from: "lead", to: "ndt", ch: "Debat ronde 2: is er een verdedigbare niet-handoff route?", re: "NDT: nee, combinatie alarmsignalen vereist verwijzing.", st: "accepted" },
      { n: 7, from: "psycho", to: "pathway", ch: "Communicatie moet kalm blijven om therapietrouw te beschermen.", re: "Accepted in outputtekst.", st: "accepted" },
      { n: 8, from: "interv", to: "audit", ch: "Geen progressieplan nu; alleen veiligheidsboodschap en verwachtingsmanagement.", re: "Accepted.", st: "accepted" },
      { n: 9, from: "audit", to: "lead", ch: "Formulering aangescherpt: urgent maar niet paniekverhogend.", re: "Accepted.", st: "accepted" },
      { n: 10, from: "lead", to: "pathway", ch: "Finaliseer structuur met HOAC + ICF en expliciete escalatie.", re: "Completed.", st: "accepted" },
      { n: 11, from: "ndt", to: "lead", ch: "Risico: hoog, red flags bevestigd.", re: "Accepted.", st: "accepted" },
      { n: 12, from: "lead", to: "audit", ch: "Eindsynthese vrijgeven met veiligheidsprioriteit.", re: "Output approved.", st: "accepted" },
    ];
    return applyDebateMode(base, caseData, mode);
  }

  if (risk === "moderate") {
    base = [
      { n: 1, from: "ndt", to: "lead", ch: `${p.name_alias} (${p.age}, ${p.occupation}) heeft recidiverende CLBP zonder directe rode vlaggen.`, re: "Lead vraagt om expliciete risicodrivers en concurrente hypothese.", st: "accepted" },
      { n: 2, from: "psycho", to: "lead", ch: "Slaapproblemen, werkdruk en bewegingsangst versterken beperkingen.", re: "Accepted. Gedragsdoelen verplicht in plan.", st: "accepted" },
      { n: 3, from: "pathway", to: "lead", ch: "State: RED_FLAG_SCREEN -> BASELINE_PROMS_NDT -> RISK_STRATIFY -> WEEK1_EDU_MISSIONS.", re: "Accepted.", st: "accepted" },
      { n: 4, from: "interv", to: "lead", ch: "2-weeks plan: graded activity, core control, ergonomie, pacing.", re: "Partial: voeg stopcriteria en exitcriteria toe.", st: "partial" },
      { n: 5, from: "audit", to: "lead", ch: "Check: elke assessment moet een beslisconsequentie hebben.", re: "Accepted.", st: "accepted" },
      { n: 6, from: "lead", to: "psycho", ch: "Debat ronde 2: wat als mechanische belasting dominanter is dan stress?", re: "Psycho: beide actief houden en evalueren met ODI/PSFS trend.", st: "partial" },
      { n: 7, from: "interv", to: "audit", ch: "Plan geüpdatet met dosering, progressie en veiligheidsstopregels.", re: "Accepted.", st: "accepted" },
      { n: 8, from: "pathway", to: "interv", ch: "Flare-protocol toegevoegd bij pijnpiek of functiedaling.", re: "Accepted.", st: "accepted" },
      { n: 9, from: "ndt", to: "lead", ch: "Profiel blijft matig risico met psychosociale component.", re: "Accepted.", st: "accepted" },
      { n: 10, from: "audit", to: "lead", ch: "Value-layer toegevoegd: minder wachttijd en minder onnodige verwijzing.", re: "Accepted.", st: "accepted" },
      { n: 11, from: "lead", to: "pathway", ch: "Finaliseer HOAC + ICF synthese met reassessment op dag 14.", re: "Completed.", st: "accepted" },
      { n: 12, from: "lead", to: "audit", ch: "Publiceer eindadvies voor demo.", re: "Output approved.", st: "accepted" },
    ];
    return applyDebateMode(base, caseData, mode);
  }

  base = [
    { n: 1, from: "ndt", to: "lead", ch: `${p.name_alias} (${p.age}) toont kortdurende klachten met laag risicoprofiel.`, re: "Accepted. Focus op zelfmanagement en snelle functionele opbouw.", st: "accepted" },
    { n: 2, from: "pathway", to: "lead", ch: "State: RED_FLAG_SCREEN -> BASELINE_PROMS_NDT -> RISK_STRATIFY (laag).", re: "Accepted.", st: "accepted" },
    { n: 3, from: "interv", to: "lead", ch: "Startplan: mobiliteit, core activatie, werkplek-aanpassing.", re: "Accepted met korte progressiecyclus.", st: "accepted" },
    { n: 4, from: "psycho", to: "lead", ch: "Beperkte angst; korte educatie voldoende.", re: "Accepted.", st: "accepted" },
    { n: 5, from: "audit", to: "lead", ch: "Check: behoud red-flag safety net in communicatie.", re: "Accepted.", st: "accepted" },
    { n: 6, from: "lead", to: "interv", ch: "Debat ronde 2: test of plan niet te intensief start.", re: "Progressie verlaagd voor eerste week.", st: "partial" },
    { n: 7, from: "interv", to: "audit", ch: "Aangepast: lagere startdosering + duidelijke opbouwcriteria.", re: "Accepted.", st: "accepted" },
    { n: 8, from: "ndt", to: "pathway", ch: "Geen red flags, lage psychosociale belasting bevestigd.", re: "Accepted.", st: "accepted" },
    { n: 9, from: "pathway", to: "lead", ch: "Follow-up op dag 10-14 voor trendcontrole.", re: "Accepted.", st: "accepted" },
    { n: 10, from: "audit", to: "lead", ch: "Value-layer: snelle hulp voorkomt escalatie en onnodige verwijzing.", re: "Accepted.", st: "accepted" },
    { n: 11, from: "lead", to: "pathway", ch: "Finaliseer HOAC + ICF output.", re: "Completed.", st: "accepted" },
    { n: 12, from: "lead", to: "audit", ch: "Vrijgeven demo-uitkomst.", re: "Output approved.", st: "accepted" },
  ];
  return applyDebateMode(base, caseData, mode);
}

function buildConnectionGroups(interactions) {
  const map = new Map();
  interactions.forEach((it) => {
    const id = `${it.from}-${it.to}`;
    if (!map.has(id)) map.set(id, { id, from: it.from, to: it.to, items: [] });
    map.get(id).items.push(it);
  });
  return [...map.values()];
}

function getFilteredInteractions() {
  let list = flatInteractions;
  if (activeFilter) {
    if (activeFilter.type === "conn") {
      list = list.filter((it) => `${it.from}-${it.to}` === activeFilter.id);
    } else {
      list = list.filter((it) => it.from === activeFilter.id || it.to === activeFilter.id);
    }
  }
  if (activePhase) {
    list = list.filter((it) => it.phase === activePhase);
  }
  return list;
}

function setFilter(filter) {
  activeFilter = filter;
  updateInteractionInfo();
  highlightMapFilter();
  renderTranscript(getFilteredInteractions());
  buildTimeline();
}

function clearFilter() {
  activeFilter = null;
  updateInteractionInfo();
  highlightMapFilter();
  renderTranscript(getFilteredInteractions());
  buildTimeline();
}

function setPhaseFilter(phase) {
  activePhase = activePhase === phase ? null : phase;
  renderPhaseChips();
  updateInteractionInfo();
  renderTranscript(getFilteredInteractions());
  buildTimeline();
}

function updateInteractionInfo() {
  const el = document.getElementById("interactionInfo");
  const parts = [];
  if (activeFilter) {
    if (activeFilter.type === "conn") {
      const [from, to] = activeFilter.id.split("-");
      parts.push(`Connection: ${AGENTS[from].name} → ${AGENTS[to].name}`);
    } else {
      parts.push(`Agent: ${AGENTS[activeFilter.id].name}`);
    }
  }
  if (activePhase) parts.push(`Phase: ${activePhase}`);
  parts.push(`View: ${viewMode === "clinical" ? "Clinical" : "Patient"}`);
  if (!activeFilter && !activePhase) {
    el.innerHTML = `Filter: none • ${parts[parts.length - 1]}`;
    return;
  }
  el.innerHTML = `${parts.join(" • ")} <button id="clearFilterBtn">clear</button>`;
  const btn = document.getElementById("clearFilterBtn");
  if (btn) btn.addEventListener("click", () => {
    activePhase = null;
    clearFilter();
    renderPhaseChips();
  });
}

function highlightMapFilter() {
  Object.entries(pathEls).forEach(([id, el]) => {
    const active = !activeFilter || (activeFilter.type === "conn" && id === activeFilter.id) ||
      (activeFilter.type === "agent" && (id.startsWith(`${activeFilter.id}-`) || id.endsWith(`-${activeFilter.id}`)));
    el.style.opacity = active ? "0.85" : "0.08";
  });

  document.querySelectorAll(".agent-node").forEach((node) => {
    const id = node.getAttribute("data-agent");
    const active = !activeFilter ||
      (activeFilter.type === "agent" && id === activeFilter.id) ||
      (activeFilter.type === "conn" && activeFilter.id.includes(id));
    node.style.opacity = active ? "1" : "0.25";
  });
}

function initNetwork() {
  pathEls = {};
  const connG = document.getElementById("connections");
  const nodeG = document.getElementById("agentNodes");
  connG.innerHTML = "";
  nodeG.innerHTML = "";

  connections.forEach((conn, idx) => {
    const from = AGENTS[conn.from];
    const to = AGENTS[conn.to];
    const count = conn.items.length;

    const mx = (from.x + to.x) / 2;
    const my = (from.y + to.y) / 2;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    const nx = -dy / len;
    const ny = dx / len;
    const off = 26 + (idx % 3) * 10;
    const side = idx % 2 === 0 ? 1 : -1;
    const cx = mx + nx * off * side;
    const cy = my + ny * off * side;

    const d = `M${from.x},${from.y} Q${cx},${cy} ${to.x},${to.y}`;
    const path = svgEl("path", { d, class: "conn-path clickable", stroke: from.color, "data-conn": conn.id });
    path.addEventListener("click", () => setFilter({ type: "conn", id: conn.id }));
    connG.appendChild(path);
    pathEls[conn.id] = path;

    if (count > 1) {
      const bx = (from.x + 2 * cx + to.x) / 4;
      const by = (from.y + 2 * cy + to.y) / 4;
      connG.appendChild(svgEl("circle", { cx: bx, cy: by, r: 9, fill: from.color, class: "conn-count-bg" }));
      const txt = svgEl("text", { x: bx, y: by + 0.5, class: "conn-count" });
      txt.textContent = String(count);
      connG.appendChild(txt);
      const label = svgEl("text", { x: bx + 14, y: by - 10, class: "conn-label" });
      label.textContent = conn.items[0].type;
      connG.appendChild(label);
    }
  });

  Object.entries(AGENTS).forEach(([id, a]) => {
    const g = svgEl("g", { class: "agent-node", "data-agent": id });
    g.addEventListener("click", () => setFilter({ type: "agent", id }));
    g.appendChild(svgEl("circle", { cx: a.x, cy: a.y, r: 50, fill: a.color, opacity: 0.15, class: "agent-glow" }));
    g.appendChild(svgEl("circle", { cx: a.x, cy: a.y, r: 36, fill: "#0c1020", stroke: a.color, "stroke-width": 2 }));
    const t = svgEl("text", { x: a.x, y: a.y + 1, class: "node-label" });
    t.textContent = a.short;
    g.appendChild(t);
    const r = svgEl("text", { x: a.x, y: a.y + 54, class: "node-role" });
    r.textContent = a.role;
    g.appendChild(r);
    const n = svgEl("text", { x: a.x, y: a.y - 48, class: "node-role", fill: a.color, "font-weight": "600" });
    n.textContent = a.name;
    g.appendChild(n);
    nodeG.appendChild(g);
  });

  const legend = document.getElementById("legend");
  legend.innerHTML = Object.values(AGENTS).map((a) => `<div class="legend-item"><div class="legend-dot" style="background:${a.color}"></div>${a.name}</div>`).join("");

  highlightMapFilter();
}

function setAgentState(id, speaking) {
  const node = document.querySelector(`[data-agent="${id}"]`);
  if (!node) return;
  node.classList.toggle("speaking", speaking);
}

function updateTimeline(cur, total) {
  const safeTotal = Math.max(1, total);
  const pct = Math.max(0, Math.min(100, (cur / safeTotal) * 100));
  document.getElementById("tlProgress").style.width = `${pct}%`;
  const dots = document.querySelectorAll(".tl-dot");
  dots.forEach((d, idx) => {
    d.classList.toggle("visited", idx + 1 <= cur);
    d.classList.toggle("current", idx + 1 === cur);
  });
  document.getElementById("tlLabel").textContent = total ? `Interaction ${cur} / ${total}` : "No interactions in current filter";
}

function buildTimeline() {
  const filtered = getFilteredInteractions();
  const wrap = document.getElementById("tlDots");
  wrap.innerHTML = "";
  filtered.forEach((it, idx) => {
    const d = document.createElement("div");
    d.className = "tl-dot";
    d.textContent = it.n;
    d.title = `${AGENTS[it.from].name} -> ${AGENTS[it.to].name}`;
    d.addEventListener("click", () => {
      renderTranscript(filtered.slice(0, idx + 1));
      updateTimeline(idx + 1, filtered.length);
      const connId = `${it.from}-${it.to}`;
      Object.values(pathEls).forEach((p) => p.classList.remove("active"));
      if (pathEls[connId]) pathEls[connId].classList.add("active");
    });
    wrap.appendChild(d);
  });
  updateTimeline(0, filtered.length);
}

function renderPhaseChips() {
  const el = document.getElementById("phaseChips");
  el.innerHTML = PHASE_ORDER.map((p) => `<button class="phase-chip ${activePhase === p ? "active" : ""}" data-phase="${p}">${p}</button>`).join("");
  el.querySelectorAll(".phase-chip").forEach((btn) => {
    btn.addEventListener("click", () => setPhaseFilter(btn.dataset.phase));
  });
}

function statusClass(st) {
  if (st === "accepted") return "accepted";
  if (st === "rejected") return "rejected";
  return "partial";
}

function renderTranscript(items) {
  const chat = document.getElementById("chatBody");
  if (!items.length) {
    chat.innerHTML = '<div class="chat-empty"><p>🧭</p><p>No interactions for this filter</p></div>';
    return;
  }
  chat.innerHTML = "";
  items.forEach((item) => {
    const from = AGENTS[item.from];
    const to = AGENTS[item.to];
    const msg = document.createElement("div");
    msg.className = "chat-msg";
    msg.dataset.n = String(item.n);
    const challengeText = viewMode === "clinical" ? item.ch : item.patient_text;
    const responseText = viewMode === "clinical" ? item.re : `Resultaat: ${item.st.toUpperCase()} - ${item.patient_text}`;
    msg.innerHTML = `
      <div class="chat-msg-header">
        <div class="chat-dot" style="background:${from.color}"></div>
        <span class="chat-agent">${from.name}</span>
        <span class="chat-arrow">→</span>
        <span class="chat-target">${to.name}</span>
        <span class="chat-tag">${item.phase}</span>
        <span class="chat-tag">${item.type}</span>
        <span class="chat-num">#${item.n}</span>
      </div>
      <div class="chat-bubble challenge"><span class="chat-title">Claim / Challenge</span>${challengeText}</div>
      <div class="chat-bubble response"><span class="chat-title">Resolution</span>${responseText}<br><span class="chat-status ${statusClass(item.st)}">${item.st.toUpperCase()}</span></div>
      <div class="chat-bubble ebp"><span class="chat-title">EBP Anchor</span>${item.evidence}</div>
    `;
    msg.addEventListener("click", () => {
      document.querySelectorAll(".chat-msg").forEach((x) => x.classList.remove("active"));
      msg.classList.add("active");
      const connId = `${item.from}-${item.to}`;
      Object.values(pathEls).forEach((p) => p.classList.remove("active"));
      if (pathEls[connId]) pathEls[connId].classList.add("active");
    });
    chat.appendChild(msg);
  });
  chat.scrollTop = chat.scrollHeight;
}

async function pulse(connId, color) {
  const path = pathEls[connId];
  if (!path) return;
  const totalLen = path.getTotalLength();
  const layer = document.getElementById("pulseLayer");
  const c = svgEl("circle", { r: 5, fill: color, filter: "url(#glow)" });
  layer.appendChild(c);

  const duration = 620 / speedMultiplier;
  const start = performance.now();
  await new Promise((resolve) => {
    const tick = (now) => {
      const p = Math.min(1, (now - start) / duration);
      const pt = path.getPointAtLength(p * totalLen);
      c.setAttribute("cx", pt.x);
      c.setAttribute("cy", pt.y);
      if (p >= 1) {
        c.remove();
        resolve();
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

async function replayDebate() {
  if (running) return;
  const filtered = getFilteredInteractions();
  if (!filtered.length) return;

  running = true;
  const btn = document.getElementById("replayBtn");
  const dot = document.getElementById("liveDot");
  btn.classList.add("playing");
  btn.textContent = "■ Running";
  dot.classList.add("on");
  renderTranscript([]);
  updateTimeline(0, filtered.length);

  for (let i = 0; i < filtered.length; i++) {
    const item = filtered[i];
    const from = AGENTS[item.from];
    setAgentState(item.from, true);
    Object.values(pathEls).forEach((p) => p.classList.remove("active"));
    const connId = `${item.from}-${item.to}`;
    if (pathEls[connId]) pathEls[connId].classList.add("active");
    renderTranscript(filtered.slice(0, i + 1));
    updateTimeline(i + 1, filtered.length);
    await pulse(connId, from.color);
    await new Promise((r) => setTimeout(r, 240 / speedMultiplier));
    setAgentState(item.from, false);
  }

  Object.values(pathEls).forEach((p) => p.classList.remove("active"));
  btn.classList.remove("playing");
  btn.textContent = "▶ Replay Debate";
  dot.classList.remove("on");
  running = false;
}

function renderStats(caseData) {
  const k = caseData.key_inputs;
  const accepted = flatInteractions.filter((x) => x.st === "accepted").length;
  const partial = flatInteractions.filter((x) => x.st === "partial").length;
  const rejected = flatInteractions.filter((x) => x.st === "rejected").length;
  const rows = [
    ["6", "Agents"],
    ["2", "Rounds"],
    [String(flatInteractions.length), "Interactions"],
    [getDebateModeLabel(debateMode), "Mode"],
    [String(accepted), "Accepted"],
    [String(partial), "Partial"],
    [String(rejected), "Rejected"],
    [String(k.pain_intensity_nrs || "-"), "Pain NRS"],
    [String(k.odi_pct || "-"), "ODI"],
    [k.red_flags ? "YES" : "NO", "Red Flags"],
  ];
  document.getElementById("statsStrip").innerHTML = rows.map(([v, l]) => `<div class="stat-chip"><span class="val">${v}</span> ${l}</div>`).join("");
}

function renderWorkflow(caseData) {
  const risk = getRiskLabel(caseData);
  const person = caseData.patient_profile;
  const acceptedRate = Math.round((flatInteractions.filter((x) => x.st === "accepted").length / Math.max(1, flatInteractions.length)) * 100);

  const careDecision =
    risk === "high"
      ? "Directe medische handoff; geen oefenprogressie tot medische beoordeling."
      : risk === "moderate"
        ? "Profiel 2: graduele opbouw + psychosociale aanpak + ergonomie + 14-daagse herbeoordeling."
        : "Profiel 1: zelfmanagement met lage-intensiteit opbouw en korte follow-up.";

  const cards = [
    ["Real-Person Intake", `${person.name_alias} (${person.age}), ${person.occupation}. ${caseData.narrative_nl}`],
    ["Clinical Reasoning", `NDT-indicator mapping en red-flag gate eerst. Debatmodus: ${getDebateModeLabel(debateMode)}.`],
    ["Care Pathway", careDecision],
    ["Debate Quality", `${acceptedRate}% van interacties geaccepteerd na challenge-response cyclus. Beslissingen zijn expliciet gekoppeld aan consequenties.`],
  ];

  document.getElementById("workflowCards").innerHTML = cards.map(([t, d]) => `<div class="mini-card"><h3>${t}</h3><p>${d}</p></div>`).join("");
}

function renderValueStory(caseData) {
  const risk = getRiskLabel(caseData);
  const red = caseData.key_inputs.red_flags;
  const modeMsg =
    debateMode === "devil"
      ? "Met Devil's advocate wordt elk advies actief aangevallen voordat het wordt geaccepteerd."
      : debateMode === "safety"
        ? "Met Safety-first staat risicoreductie en stopcriteria boven snelheid."
        : "Met Clinical consensus convergeren specialisten naar een gedeelde behandelroute.";
  const msg =
    risk === "high"
      ? "Deze case toont waarom PT-CHARLIE veiligheid boven alles plaatst: snelle herkenning van alarmsignalen en directe escalatie."
      : risk === "moderate"
        ? "Deze case toont hoe PT-CHARLIE complexiteit beheerst met een gestructureerd, persoonlijk en adaptief zorgpad."
        : "Deze case toont hoe PT-CHARLIE vroege begeleiding inzet om escalatie en onnodige zorgconsumptie te voorkomen.";

  document.getElementById("valueStory").innerHTML = `
    <p><strong>PT-CHARLIE</strong> bij <strong>${caseData.patient_profile.name_alias}</strong>: ${msg}</p>
    <ul>
      <li>Continuiteit: elke sessie bouwt voort op eerdere data en besluiten.</li>
      <li>Efficientie: snellere triage en minder ongerichte doorverwijzingen.</li>
      <li>Kwaliteit: expliciete red-flag gating en meetbare follow-upmomenten.</li>
      <li>Debatmodus: ${modeMsg}</li>
      <li>Visie 2030 fit: digitale zelfzorg waar mogelijk, professionele escalatie waar nodig (${red ? "geactiveerd" : "stand-by"}).</li>
    </ul>
  `;
}

function renderPatientSummary(caseData) {
  const risk = getRiskLabel(caseData);
  const filtered = getFilteredInteractions();
  const latest = filtered.length ? filtered[filtered.length - 1] : flatInteractions[flatInteractions.length - 1];
  const safeAction = risk === "high"
    ? "Vandaag: direct medische beoordeling en alarmsignalen monitoren."
    : risk === "moderate"
      ? "Vandaag: rustig opbouwen, ergonomie toepassen, dag 14 herbeoordeling."
      : "Vandaag: lichte opbouw, actief blijven, korte follow-up.";
  const text = viewMode === "clinical"
    ? `Risk: ${risk.toUpperCase()} • Active mode: ${getDebateModeLabel(debateMode)} • Latest phase: ${latest ? latest.phase : "-"}`
    : `Jouw samenvatting: ${safeAction}`;
  document.getElementById("caseDetail").textContent = `${caseData.patient_profile.name_alias}, ${caseData.patient_profile.age} jaar • ${text}`;
}

function rebuildScenario(caseData) {
  flatInteractions = buildCaseInteractions(caseData, debateMode);
  connections = buildConnectionGroups(flatInteractions);
  activeFilter = null;
}

async function loadCase(key) {
  try {
    const res = await fetch(CASE_FILES[key]);
    if (!res.ok) {
      throw new Error(`Failed to load ${CASE_FILES[key]} (${res.status})`);
    }
    const data = await res.json();
    activeCase = data;

    document.getElementById("caseTitle").textContent = data.title;
    document.getElementById("caseDetail").textContent = `${data.patient_profile.name_alias}, ${data.patient_profile.age} jaar • ${data.patient_profile.occupation}`;

    rebuildScenario(data);
    initNetwork();
    updateInteractionInfo();
    renderStats(data);
    renderWorkflow(data);
    renderValueStory(data);
    renderPatientSummary(data);
    renderTranscript(flatInteractions);
    renderPhaseChips();
    buildTimeline();
  } catch (err) {
    console.error(err);
    document.getElementById("caseTitle").textContent = "Case Load Error";
    document.getElementById("caseDetail").textContent = "Missing or invalid demo case files";
    document.getElementById("chatBody").innerHTML = `<div class="chat-empty"><p>⚠️</p><p>${err.message}</p></div>`;
    document.getElementById("tlLabel").textContent = "Case load failed";
  }
}

function initCaseSelector() {
  const sel = document.getElementById("caseSelect");
  sel.addEventListener("change", () => loadCase(sel.value));
}

function initDebateModeSelector() {
  const sel = document.getElementById("debateModeSelect");
  sel.addEventListener("change", () => {
    debateMode = sel.value;
    if (activeCase) {
      rebuildScenario(activeCase);
      initNetwork();
      updateInteractionInfo();
      renderStats(activeCase);
      renderWorkflow(activeCase);
      renderValueStory(activeCase);
      renderPatientSummary(activeCase);
      renderTranscript(getFilteredInteractions());
      renderPhaseChips();
      buildTimeline();
    }
  });
}

function initViewModeSelector() {
  const sel = document.getElementById("viewModeSelect");
  sel.addEventListener("change", () => {
    viewMode = sel.value;
    updateInteractionInfo();
    if (activeCase) {
      renderPatientSummary(activeCase);
      renderTranscript(getFilteredInteractions());
    }
  });
}

window.showPanel = showPanel;
window.setSpeed = setSpeed;
window.replayDebate = replayDebate;

(function boot() {
  initCaseSelector();
  initDebateModeSelector();
  initViewModeSelector();
  loadCase("moderate");
})();
