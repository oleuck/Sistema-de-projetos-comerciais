/* ==================================================
   CONFIGURAÇÕES GERAIS E ETAPAS
   (FIREBASE_CFG, MASTER_KEY e GOOGLE_SCRIPT_URL vêm do index.html)
================================================== */
const APP_VERSION = "2026-10-26-a";
console.log("%c[Sistema] script.js versão " + APP_VERSION, "color:#22c55e;font-weight:bold");

const STAGES = [
  "Aguardando Início (Fila)", // 0
  "Em Desenho",               // 1
  "Orçamento",                // 2
  "Correção 1",               // 3
  "Correção 2",               // 4
  "Luis",                     // 5
  "Cristian",                 // 6
  "Desenhista",               // 7
  "Entregue"                  // 8
];

const ROTACAO_VENDEDORES = ["CARLA", "JONES", "SHANA", "OUTRO"];

let db, docRef;
let appData = { users: [], passwords: {}, projects: [], lastVendedor: null };
let currentUser   = null;
let isViewerMode  = false;
let managerTab    = "andamento";
let draftsmanTab  = "fila";
let viewMode      = "cards";
let fbSynced      = false;
let activeCharts  = {};

let customModalResolve   = null;
let passwordModalResolve = null;
let confirmModalResolve  = null;

let dateEditCtx = { projectId: null, histIndex: null };
let reworkProjectId = null;
let maiorNumeroDeProjetosVistos = 0;

Chart.register(ChartDataLabels);

/* ==================================================
   LÓGICA DO TEMA (LIGHT/DARK)
================================================== */
function toggleTheme() {
  const html = document.documentElement;
  const isDark = html.classList.toggle('dark');
  localStorage.setItem('tema_projetos', isDark ? 'dark' : 'light');
  
  Chart.defaults.color = isDark ? '#94a3b8' : '#6b7280';
  
  if (activeCharts["paretoChart"]) renderPareto("manager");
  if (activeCharts["draftsmanParetoChart"]) renderPareto("draftsman");
}

const savedTheme = localStorage.getItem('tema_projetos');
if (savedTheme === 'dark' || (!savedTheme && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
  document.documentElement.classList.add('dark');
  Chart.defaults.color = '#94a3b8';
} else {
  Chart.defaults.color = '#6b7280';
}

function normalizeVendedor(v) {
  const upper = (v || "").trim().toUpperCase();
  return ROTACAO_VENDEDORES.includes(upper) ? upper : "OUTRO";
}

/* ==================================================
   ALTERAR MODO DE VISUALIZAÇÃO
================================================== */
function toggleViewMode() {
  viewMode = viewMode === "cards" ? "table" : "cards";
  const label = viewMode === "cards" ? "📋 Ver em Tabela" : "📇 Ver em Cards";
  document.querySelectorAll(".toggle-view-btn").forEach(btn => btn.innerHTML = label);
  
  if (isViewerMode) renderGlobalFeed(); 
  else renderProjects();
}

/* ==================================================
   TOAST E SEGURANÇA
================================================== */
function toast(msg, type = "info", duration = 3500) {
  const c = document.getElementById("toast-container");
  const t = document.createElement("div");
  t.className = `toast ${type}`;
  t.textContent = msg;
  c.appendChild(t);
  setTimeout(() => {
    t.style.animation = "fadeOut 0.3s ease forwards";
    setTimeout(() => t.remove(), 300);
  }, duration);
}

async function hashPassword(pass) {
  const enc = new TextEncoder().encode(pass);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,"0")).join("");
}

async function checkPassword(stored, input) {
  if (stored && stored.length !== 64) return stored === input;
  return stored === await hashPassword(input);
}

function debounce(fn, ms = 300) {
  let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
const debounceRenderProjects = debounce(() => renderProjects());
const debounceRenderGlobal   = debounce(() => renderGlobalFeed());

/* ==================================================
   MANIPULAÇÃO DE MODAIS
================================================== */
function closeModal(id) { document.getElementById(id).classList.add("hidden"); }

function openCustomModal(title, desc, placeholder, defaultVal = "") {
  const m = document.getElementById("custom-modal");
  document.getElementById("modal-title").textContent = title;
  document.getElementById("modal-desc").textContent  = desc;
  const inp = document.getElementById("modal-input");
  inp.value = defaultVal; inp.placeholder = placeholder;
  m.classList.remove("hidden");
  requestAnimationFrame(() => inp.focus());
  return new Promise(r => { customModalResolve = r; });
}
function closeCustomModal(confirm) {
  document.getElementById("custom-modal").classList.add("hidden");
  if (customModalResolve) {
    customModalResolve(confirm ? document.getElementById("modal-input").value : null);
    customModalResolve = null;
  }
}

function openPasswordModal(title, desc) {
  document.getElementById("pwd-modal-title").textContent = title;
  document.getElementById("pwd-modal-desc").textContent  = desc;
  const inp = document.getElementById("pwd-modal-input");
  inp.value = "";
  document.getElementById("password-modal").classList.remove("hidden");
  requestAnimationFrame(() => inp.focus());
  return new Promise(r => { passwordModalResolve = r; });
}
function closePasswordModal(confirm) {
  document.getElementById("password-modal").classList.add("hidden");
  if (passwordModalResolve) {
    passwordModalResolve(confirm ? document.getElementById("pwd-modal-input").value : null);
    passwordModalResolve = null;
  }
}

function openConfirmModal(title, desc) {
  document.getElementById("confirm-title").textContent = title;
  document.getElementById("confirm-desc").textContent  = desc;
  document.getElementById("confirm-modal").classList.remove("hidden");
  return new Promise(r => { confirmModalResolve = r; });
}
function closeConfirmModal(confirm) {
  document.getElementById("confirm-modal").classList.add("hidden");
  if (confirmModalResolve) { confirmModalResolve(confirm); confirmModalResolve = null; }
}

document.addEventListener("keydown", e => {
  if (e.key !== "Escape") return;
  ["pdf-modal","custom-modal","password-modal","confirm-modal","admin-modal","date-modal","rework-modal","create-project-modal","edit-project-modal","create-revisao-modal"]
    .forEach(id => {
      const el = document.getElementById(id);
      if (el && !el.classList.contains("hidden")) el.classList.add("hidden");
    });
});

document.getElementById("pwd-modal-input").addEventListener("keydown", e => {
  if (e.key === "Enter") { e.preventDefault(); closePasswordModal(true); }
});

document.getElementById("modal-input").addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); closeCustomModal(true); }
});

/* ==================================================
   TRATAMENTO DE DATAS, TRABALHO ÚTIL E TEMPO POR PROJETO
================================================== */
function dateToLocalString(ds) {
  try {
    const [d, t] = ds.replace(",","").trim().split(" ");
    const [dd, mm, yy] = d.split("/");
    const [hh, mn] = (t || "00:00").split(":");
    return `${yy}-${mm.padStart(2,"0")}-${dd.padStart(2,"0")}T${hh.padStart(2,"0")}:${mn.padStart(2,"0")}`;
  } catch { return ""; }
}
function localStringToDate(ls) {
  const [d, t] = ls.split("T");
  const [yy, mm, dd] = d.split("-");
  const [hh, mn] = (t || "00:00").split(":");
  return `${dd}/${mm}/${yy}, ${hh}:${mn}:00`;
}
function nowBR() { return new Date().toLocaleString("pt-BR"); }
function todayShortBR() { return new Date().toLocaleDateString("pt-BR"); }
function parseDateBR(str) {
  try {
    const parts = str.split(/[\s,]+/);
    const [dd, mm, yy] = parts[0].split("/");
    const [hh, mn] = (parts[1] || "00:00").split(":");
    return new Date(yy, mm - 1, dd, hh || 0, mn || 0).getTime();
  } catch { return Date.now(); }
}

function getBusinessHours(startMs, endMs) {
  if (startMs >= endMs) return 0;
  let total = 0;
  const cur = new Date(startMs); cur.setHours(0, 0, 0, 0);
  const end = new Date(endMs);
  while (cur <= end) {
    const day = cur.getDay();
    if (day !== 0 && day !== 6) {
      const bizStart = new Date(cur); bizStart.setHours(8, 0, 0, 0);
      const bizEnd   = new Date(cur); bizEnd.setHours(18, 0, 0, 0);
      const aStart = Math.max(startMs, bizStart.getTime());
      const aEnd   = Math.min(endMs,   bizEnd.getTime());
      if (aStart < aEnd) total += (aEnd - aStart) / 3_600_000;
    }
    cur.setDate(cur.getDate() + 1);
  }
  return total;
}

function getProjectCompletionTimeMs(p) {
  if (!p || !p.history || !p.history.length) return Number(p?.id) || 0;
  const rev = [...p.history].reverse();
  let endMs = null;
  rev.forEach(ev => {
    if (ev && ev.stage === STAGES[8]) endMs = parseDateBR(ev.date);
  });
  return endMs || parseDateBR(p.history[0].date) || Number(p.id) || 0;
}

function getProjectStartDateStr(p) {
  if (!p || !p.history || !p.history.length) return "";
  const rev = [...p.history].reverse();
  let startStr = "";
  rev.forEach(ev => {
    if (!ev) return;
    if (ev.stage?.includes("RETORNOU PARA REVISÃO")) {
      startStr = "";
    }
    if (!startStr && (ev.stage === STAGES[1] || ev.stage?.includes("ASSUMIU") || ev.stage?.includes("ATRIBUÍDO"))) {
      startStr = (ev.date || "").split(" ")[0].replace(/,/g, "").trim();
    }
  });
  return startStr;
}

function getProjectEndDateStr(p) {
  if (!p || Number(p.stageIndex) < 8) return "";
  if (p.history && p.history.length) {
    const rev = [...p.history].reverse();
    let endStr = "";
    rev.forEach(ev => {
      if (ev && ev.stage === STAGES[8]) {
        endStr = (ev.date || "").split(" ")[0].replace(/,/g, "").trim();
      }
    });
    if (endStr) return endStr;
  }
  return todayShortBR();
}

function getProjectDurationHours(p) {
  if (!p || !p.history || !p.history.length) return 0;
  const rev = [...p.history].reverse();
  let startMs = null;
  let endMs = null;
  rev.forEach(ev => {
    if (!ev) return;
    if (ev.stage?.includes("RETORNOU PARA REVISÃO")) {
      startMs = null;
      endMs = null;
    }
    if (!startMs && (ev.stage === STAGES[1] || ev.stage?.includes("ASSUMIU") || ev.stage?.includes("ATRIBUÍDO"))) {
      startMs = parseDateBR(ev.date);
    }
    if (ev.stage === STAGES[8]) {
      endMs = parseDateBR(ev.date);
    }
  });
  if (!startMs && rev[0]) startMs = parseDateBR(rev[0].date);
  if (!endMs && Number(p.stageIndex) >= 8 && p.history[0]) endMs = parseDateBR(p.history[0].date);
  if (startMs && endMs && endMs > startMs) {
    return getBusinessHours(startMs, endMs);
  }
  return 0;
}

function formatDurationBadge(hours) {
  if (!hours || hours <= 0) return "< 1h útil";
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}min úteis`;
  return `${hours.toFixed(1).replace(".0", "")}h úteis`;
}

function formatDimensions(p) {
  const l = (p.largura || "").trim();
  const c = (p.comprimento || "").trim();
  const a = (p.altura || "").trim();
  if (!l && !c && !a) return "-";
  return `${l || "-"} × ${c || "-"} × ${a || "-"}m`;
}

/* ==================================================
   CONEXÃO SINCRO FIREBASE E TRAVA ANTI-APAGÃO
================================================== */
function setFirebaseStatus(state) {
  const dot  = document.getElementById("firebase-dot");
  const text = document.getElementById("firebase-status-text");
  if (!dot || !text) return;
  dot.className  = `firebase-dot ${state}`;
  text.textContent = { connected:"Conectado à nuvem", error:"Modo Local (Offline)", "":"Verificando..." }[state] || "Modo Local";
}
function hideLoader() { document.getElementById("global-loader").style.display = "none"; }

function ensureDefaults(data) {
  if (!data) data = {};
  if (!data.users) data.users = [];
  if (!data.projects) data.projects = [];
  if (!data.passwords) data.passwords = {};
  if (!data.lastVendedor) data.lastVendedor = null;
  return data;
}

function bootUI() {
  hideLoader();
  if (!fbSynced) {
    const local = localStorage.getItem("appData_local");
    if (local) {
      try { appData = JSON.parse(local); } catch(e) {}
    }
  }
  appData = ensureDefaults(appData);
  if (!currentUser && !isViewerMode) { show("view-profiles"); renderProfiles(); }
  else if (isViewerMode) { show("view-manager"); renderGlobalFeed(); }
  else { show("view-dashboard"); renderProjects(); }
}

function show(id) {
  ["view-profiles","view-manager","view-dashboard"].forEach(v => document.getElementById(v).classList.add("hidden"));
  document.getElementById(id).classList.remove("hidden");
}

const isConfigured = typeof FIREBASE_CFG !== "undefined" && FIREBASE_CFG.apiKey && !FIREBASE_CFG.apiKey.includes("SUA_API_KEY");
const fbTimeout = setTimeout(() => { if (!fbSynced) { setFirebaseStatus("error"); bootUI(); } }, 2500);

if (isConfigured) {
  try {
    firebase.initializeApp(FIREBASE_CFG);
    db = firebase.firestore();
    docRef = db.collection("sistema").doc("bancoDeDados");
    docRef.onSnapshot(doc => {
      clearTimeout(fbTimeout);
      if (doc.exists) {
        appData = ensureDefaults(doc.data());
        fbSynced = true;
        document.getElementById("offline-banner").style.display = "none";
        setFirebaseStatus("connected");
        maiorNumeroDeProjetosVistos = Math.max(maiorNumeroDeProjetosVistos, appData.projects.length);
      } else if (!fbSynced) {
        docRef.set(ensureDefaults(appData)).catch(() => {});
        fbSynced = true;
      }
      bootUI();
    }, () => { setFirebaseStatus("error"); bootUI(); });
  } catch { bootUI(); }
} else {
  clearTimeout(fbTimeout);
  setFirebaseStatus("error");
  bootUI();
}

function saveData() {
  if (!fbSynced) { 
    localStorage.setItem("appData_local", JSON.stringify(appData)); 
    return; 
  }
  if (appData && appData.projects && appData.projects.length === 0 && maiorNumeroDeProjetosVistos > 0) return;
  if (!docRef) return;
  docRef.set(appData).then(() => {
    maiorNumeroDeProjetosVistos = Math.max(maiorNumeroDeProjetosVistos, appData.projects.length);
  }).catch(() => toast("Erro ao salvar no banco.", "danger"));
}

/* ==================================================
   INTEGRAÇÃO COMPLETA COM GOOGLE PLANILHAS
   - Coluna D (4): Situação (PROJETO, DESENHISTA, LUIS, CRISTIAN, ENTREGUE)
   - Coluna J, K, L (10, 11, 12): Largura, Comprimento, Altura
   - Coluna O (15): Data de Entrada
   - Coluna Q (17): Desenhista
   - Coluna R (18): Data de Início
   - Coluna T (20): Data de Conclusão
================================================== */
function getSheetStageLabel(p) {
  const idx = Number(p.stageIndex) || 0;
  const map = {
    0: "PROJETO",
    1: "DESENHISTA",
    2: "ORÇAMENTO",
    3: "CORREÇÃO",
    4: "CORREÇÃO",
    5: "LUIS",
    6: "CRISTIAN",
    7: "DESENHISTA",
    8: "CONCLUIDO"
  };
  return map[idx] || "PROJETO";
}

// 1. Cria nova linha na planilha SOMENTE quando clica em "+ Novo Projeto na Fila"
async function sendToGoogleSheets(p, opts = {}) {
  if (typeof GOOGLE_SCRIPT_URL === "undefined" || !GOOGLE_SCRIPT_URL) return;
  try {
    const entryDate = opts.date ? opts.date : p.history && p.history.length > 0 ? p.history[0].date.split(" ")[0].replace(/,/g, "").trim() : todayShortBR();
    
    const payload = {
      action: "CREATE",
      vendedor: p.vendedor,
      tipo: p.tipo,
      probabilidade: p.probabilidade,
      situacao: "PROJETO", 
      name: p.name,
      cod: p.cod,
      cidade: p.cidade,
      date: entryDate,
      largura: p.largura || "",
      comprimento: p.comprimento || "",
      altura: p.altura || ""
    };
    
    console.log("[Planilha] enviando", APP_VERSION, payload);
    await fetch(GOOGLE_SCRIPT_URL, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    });
  } catch (err) {}
}

// 2. Atualiza a linha existente na planilha (Coluna D, Coluna Q, Coluna R e Coluna T)
async function syncUpdateToGoogleSheets(p, extra = {}) {
  if (typeof GOOGLE_SCRIPT_URL === "undefined" || !GOOGLE_SCRIPT_URL) return;
  try {
    const isFila = !p.owner || p.owner === "Fila" || p.owner === "Sem Desenhista";
    const desenhistaVal = isFila ? "" : p.owner;
    const situacaoVal   = extra.situacao || getSheetStageLabel(p);
    const dataInicioVal = extra.dataInicio !== undefined ? extra.dataInicio : getProjectStartDateStr(p);
    const dataConcVal   = extra.dataConclusao !== undefined ? extra.dataConclusao : (Number(p.stageIndex) >= 8 ? getProjectEndDateStr(p) : "");

    const payload = {
      action: "UPDATE",
      onlyEditInfo: Boolean(extra.onlyEditInfo),
      forceStartDate: Boolean(extra.forceStartDate),
      cod: p.cod || "",
      oldCod: extra.oldCod || (p.previousCods && p.previousCods.length ? p.previousCods[p.previousCods.length - 1] : ""),
      name: p.name || "",
      vendedor: p.vendedor || "",
      tipo: p.tipo || "",
      probabilidade: p.probabilidade || "",
      cidade: p.cidade || "",
      largura: p.largura || "",
      comprimento: p.comprimento || "",
      altura: p.altura || "",
      situacao: situacaoVal,       // Coluna D
      desenhista: desenhistaVal,   // Coluna Q
      dataInicio: dataInicioVal,   // Coluna R
      dataConclusao: dataConcVal   // Coluna T
    };

    console.log("[Planilha] enviando", APP_VERSION, payload);
    await fetch(GOOGLE_SCRIPT_URL, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    });
  } catch (err) {}
}

/* ==================================================
   CONTROLE DE LOGINS, PERFIS E FLUXOS
================================================== */
function findProject(id) { return (appData.projects || []).find(p => p.id === id) || null; }
function pushHistory(p, stage, obs) {
  if (!p.history) p.history = [];
  p.history.unshift({ stage, obs: obs || "", date: nowBR(), author: currentUser || "Visualizador" });
}

function updateBadges() {
  const projs = appData.projects || [];
  const setBadge = (id, count) => { const el = document.getElementById(id); if(el) el.textContent = count; };
  const getStage = p => Number(p.stageIndex) || 0;

  setBadge("badge-fila", projs.filter(p => !p.isImpeded && getStage(p) === 0).length);
  setBadge("badge-andamento", projs.filter(p => !p.isImpeded && getStage(p) > 0 && getStage(p) < 8).length);
  setBadge("badge-espera", projs.filter(p => Boolean(p.isImpeded) && getStage(p) < 8).length);
  setBadge("badge-concluidos", projs.filter(p => getStage(p) >= 8).length);

  if (currentUser) {
    const filterUser = document.getElementById("user-filter-select")?.value || "MEUS";
    const filtered = projs.filter(p => {
      const isFila = p.owner === "Fila" || p.owner === "Sem Desenhista";
      if (isFila) return true;
      if (filterUser === "ALL") return true;
      return filterUser === "MEUS" ? p.owner === currentUser : p.owner === filterUser;
    });
    setBadge("badge-d-fila", filtered.filter(p => !p.isImpeded && getStage(p) === 0).length);
    setBadge("badge-d-andamento", filtered.filter(p => !p.isImpeded && getStage(p) > 0 && getStage(p) < 8).length);
    setBadge("badge-d-espera", filtered.filter(p => Boolean(p.isImpeded) && getStage(p) < 8).length);
    setBadge("badge-d-concluidos", projs.filter(p => getStage(p) >= 8).length);

    const targetOwner = (currentUser === "ADMIN" && filterUser !== "MEUS" && filterUser !== "ALL") ? filterUser : currentUser;
    const myDoneCount = projs.filter(p => getStage(p) >= 8 && (targetOwner === "ADMIN" && filterUser === "ALL" ? true : p.owner === targetOwner)).length;
    setBadge("badge-d-meus-concluidos", myDoneCount);
  }
}

function renderProfiles() {
  const c = document.getElementById("profiles-container"); if (!c) return; c.innerHTML = "";
  (appData.users || []).filter(u => u !== "ADMIN").forEach(u => {
    const div = document.createElement("div"); div.className = "profile-card";
    div.innerHTML = `<span class="profile-name" onclick="handleLoginClick('${u}')">👤 ${u}</span>`;
    c.appendChild(div);
  });
}

async function addUser() {
  const inp = document.getElementById("new-user-name"); const name = inp.value.trim(); if (!name) return;
  if (appData.users.includes(name) || name.toUpperCase() === "ADMIN") { toast("Nome existente!", "warning"); return; }
  const pass = await openPasswordModal("Criar Senha", `Defina a senha para "${name}":`);
  if (pass !== null && pass.trim()) {
    appData.users.push(name); appData.passwords[name] = await hashPassword(pass);
    saveData(); inp.value = ""; renderProfiles();
    toast(`${name} adicionado!`, "success");
  }
}

async function deleteCurrentUser() {
  const ok = await openConfirmModal("Excluir Perfil", `Deseja apagar permanentemente o perfil "${currentUser}"?`);
  if (!ok) return;
  appData.users = appData.users.filter(u => u !== currentUser); delete appData.passwords[currentUser];
  saveData(); logout();
}

function populateUserFilter() {
  const sel = document.getElementById("user-filter-select"); if (!sel) return;
  sel.innerHTML = '<option value="ALL">Todos os Desenhistas</option><option value="MEUS">Só os Meus</option>';
  (appData.users || []).filter(u => u !== currentUser && u !== "ADMIN").forEach(u => { sel.innerHTML += `<option value="${u}">Projetos de: ${u}</option>`; });
  sel.value = currentUser === "ADMIN" ? "ALL" : "MEUS";
}

async function handleLoginClick(user) {
  const stored = appData.passwords[user];
  if (!stored) {
    const pass = await openPasswordModal("Criar Senha", `Crie uma senha para "${user}":`);
    if (pass !== null && pass.trim()) { appData.passwords[user] = await hashPassword(pass); saveData(); proceedLogin(user); }
  } else {
    const pass = await openPasswordModal("Acesso", `Senha de ${user}:`);
    if (pass === null) return;
    if (pass === MASTER_KEY || await checkPassword(stored, pass)) { proceedLogin(user); } else { toast("Senha incorreta.", "danger"); }
  }
}

async function handleMasterLogin() {
  const pass = await openPasswordModal("Acesso Master", "Senha administrativa:");
  if (pass === null) return;
  const ok = pass === MASTER_KEY || (appData.passwords?.["ADMIN"] && await checkPassword(appData.passwords["ADMIN"], pass));
  if (ok) { if (!appData.users.includes("ADMIN")) appData.users.push("ADMIN"); proceedLogin("ADMIN"); } else { toast("Senha incorreta.", "danger"); }
}

function proceedLogin(user) {
  currentUser = user;
  isViewerMode = false; show("view-dashboard");
  document.getElementById("dashboard-title").textContent = user === "ADMIN" ? "Área de Trabalho (Gestão)" : `Área de Trabalho — ${user}`;
  document.getElementById("admin-btn").classList.toggle("hidden", user !== "ADMIN");
  document.getElementById("delete-profile-btn").classList.toggle("hidden", user === "ADMIN");
  populateUserFilter(); switchDraftsmanTab("fila");
}

function proceedAsViewer() { currentUser = null; isViewerMode = true; show("view-manager"); switchManagerTab("andamento"); }
function logout() { currentUser = null; isViewerMode = false; show("view-profiles"); renderProfiles(); }
async function changeMyPassword() {
  const pass = await openPasswordModal("Alterar Senha", "Digite sua nova senha:");
  if (pass !== null && pass.trim()) { appData.passwords[currentUser] = await hashPassword(pass); saveData(); toast("Senha atualizada!", "success"); }
}

function openAdminModal() {
  const list = document.getElementById("admin-users-list"); list.innerHTML = "";
  (appData.users || []).filter(u => u !== "ADMIN").forEach(u => {
    const row = document.createElement("div"); row.style.cssText = "display:flex; justify-content:space-between; align-items:center; padding:10px; border-bottom:1px solid var(--border);";
    row.innerHTML = `<strong>👤 ${u}</strong><button class="warning" style="padding:6px 12px; font-size:0.85rem;" onclick="changeUserPassword('${u}')">Alterar Senha</button>`;
    list.appendChild(row);
  });
  document.getElementById("admin-modal").classList.remove("hidden");
}
async function changeUserPassword(u) {
  const pass = await openCustomModal("Alterar Senha", `Nova senha para ${u}:`, "Nova senha...");
  if (pass !== null && pass.trim()) { appData.passwords[u] = await hashPassword(pass); saveData(); toast(`Senha de ${u} atualizada!`, "success"); }
}

/* ==================================================
   SISTEMA DE SUGESTÃO ADMIN 
================================================== */
function updateAdminSuggestion() {
  const panel = document.getElementById("admin-suggestion-panel");
  if (!panel) return;

  if (currentUser !== "ADMIN" || isViewerMode) {
    panel.classList.add("hidden");
    return;
  }

  const filaProjs = (appData.projects || []).filter(p => Number(p.stageIndex) === 0 && !p.isImpeded);
  const desenhistas = (appData.users || []).filter(u => u !== "ADMIN");

  if (filaProjs.length === 0 || desenhistas.length === 0) {
    panel.classList.add("hidden");
    return;
  }

  let lastIndex = ROTACAO_VENDEDORES.indexOf((appData.lastVendedor || "").toUpperCase());
  if (lastIndex === -1) lastIndex = -1;

  let oldestProj = null;
  for (let i = 1; i <= ROTACAO_VENDEDORES.length; i++) {
    let checkIndex = (lastIndex + i) % ROTACAO_VENDEDORES.length;
    let checkName = ROTACAO_VENDEDORES[checkIndex];

    let projsVendedor = filaProjs.filter(p => normalizeVendedor(p.vendedor) === checkName)
                                 .sort((a, b) => Number(a.id) - Number(b.id)); 
    if (projsVendedor.length > 0) {
      oldestProj = projsVendedor[0]; 
      break; 
    }
  }

  if (!oldestProj && filaProjs.length > 0) {
    oldestProj = filaProjs.sort((a, b) => Number(a.id) - Number(b.id))[0];
  }

  if (!oldestProj) {
    panel.classList.add("hidden");
    return;
  }

  let desenhistasOrdenados = [...desenhistas].sort((a, b) => {
    let countA = (appData.projects || []).filter(p => p.owner === a && !p.isImpeded && p.stageIndex > 0 && p.stageIndex < 8).length;
    let countB = (appData.projects || []).filter(p => p.owner === b && !p.isImpeded && p.stageIndex > 0 && p.stageIndex < 8).length;
    return countA - countB;
  });

  panel.classList.remove("hidden");
  let html = `<table class="data-table" style="background: var(--card); width:100%;">
                <thead>
                  <tr>
                    <th style="background:var(--purple); width:20%;">Sugerido Para</th>
                    <th style="background:var(--purple); width:15%;">Vendedor</th>
                    <th style="background:var(--purple); width:10%;">CÓD</th>
                    <th style="background:var(--purple); width:40%;">Obra</th>
                    <th style="background:var(--purple); width:15%; text-align:center;">Ação</th>
                  </tr>
                </thead>
                <tbody>`;

  desenhistasOrdenados.forEach((dName) => {
    html += `<tr>
        <td style="font-weight:700; color:var(--purple);">👤 ${dName}</td>
        <td style="font-weight:700; color:var(--text);">${normalizeVendedor(oldestProj.vendedor)}</td>
        <td style="color:var(--text);">${oldestProj.cod || "-"}</td>
        <td style="white-space:normal; color:var(--text);">${oldestProj.name}</td>
        <td style="text-align:center;">
          <button class="success" style="padding:6px 12px; font-size:0.8rem; border-radius:4px;" onclick="adminAssignProject('${oldestProj.id}', '${dName}')">Atribuir Agora</button>
        </td>
      </tr>`;
  });
  html += `</tbody></table>`;
  
  document.getElementById("sugg-table-container").innerHTML = html;
}

async function adminAssignProject(id, desenhista) {
  const p = findProject(id); if (!p) return;
  const ok = await openConfirmModal("Atribuir Projeto", `Deseja transferir o projeto "${p.name}" para o desenhista ${desenhista}?`);
  if (!ok) return;
  p.owner = desenhista;
  p.stageIndex = 1;
  p.isImpeded = false;
  appData.lastVendedor = normalizeVendedor(p.vendedor);
  
  pushHistory(p, "🚀 ATRIBUÍDO PELO ADMIN", `Transferido da Fila -> [${p.owner}].`);
  saveData(); 
  if (isViewerMode) renderGlobalFeed(); else renderProjects();
  toast(`Projeto transferido com sucesso para ${desenhista}!`, "success");

  // Atualiza Planilha: Coluna D = DESENHISTA, Coluna Q = Desenhista, Coluna R = Data de Início
  syncUpdateToGoogleSheets(p, {
    situacao: "DESENHISTA",
    dataInicio: todayShortBR(),
    forceStartDate: true
  });
}

/* ==================================================
   FILTRO DE PERÍODO E INDICADORES DE "MEUS CONCLUÍDOS"
================================================== */
function setMcPeriod(val) {
  const hiddenInput = document.getElementById("mc-period-select");
  if (hiddenInput) hiddenInput.value = val;

  document.querySelectorAll(".pill-btn").forEach(btn => {
    btn.classList.toggle("active", btn.getAttribute("data-period") === val);
  });

  const customDiv = document.getElementById("mc-custom-dates");
  if (customDiv) {
    customDiv.classList.toggle("hidden", val !== "CUSTOM");
  }
  renderProjects();
}

function filterByMcPeriod(projects) {
  const sel = document.getElementById("mc-period-select")?.value || "ALL";
  if (sel === "ALL") return projects;

  const now = Date.now();
  if (sel === "CUSTOM") {
    const sVal = document.getElementById("mc-start-date")?.value;
    const eVal = document.getElementById("mc-end-date")?.value;
    const minMs = sVal ? new Date(sVal + "T00:00:00").getTime() : 0;
    const maxMs = eVal ? new Date(eVal + "T23:59:59").getTime() : Infinity;
    return projects.filter(p => {
      const t = getProjectCompletionTimeMs(p);
      return t >= minMs && t <= maxMs;
    });
  }

  const days = parseInt(sel, 10);
  if (isNaN(days)) return projects;
  const cutoffMs = now - (days * 86_400_000);
  return projects.filter(p => getProjectCompletionTimeMs(p) >= cutoffMs);
}

function updateMeusConcluidosPanel(list) {
  const totalEl = document.getElementById("mc-kpi-total");
  const avgEl   = document.getElementById("mc-kpi-avg");
  const cCarla  = document.getElementById("mc-vend-carla");
  const cJones  = document.getElementById("mc-vend-jones");
  const cShana  = document.getElementById("mc-vend-shana");
  const cOutro  = document.getElementById("mc-vend-outro");

  let sumHours = 0;
  let countWithHours = 0;
  const vendCounts = { CARLA: 0, JONES: 0, SHANA: 0, OUTRO: 0 };

  list.forEach(p => {
    const dur = getProjectDurationHours(p);
    if (dur > 0) {
      sumHours += dur;
      countWithHours++;
    }
    const v = normalizeVendedor(p.vendedor);
    vendCounts[v] = (vendCounts[v] || 0) + 1;
  });

  const total = list.length;
  const avg = countWithHours > 0 ? (sumHours / countWithHours).toFixed(1).replace(".0", "") + "h" : "0h";

  if (totalEl) totalEl.textContent = total;
  if (avgEl)   avgEl.textContent   = avg;
  if (cCarla)  cCarla.textContent  = vendCounts.CARLA;
  if (cJones)  cJones.textContent  = vendCounts.JONES;
  if (cShana)  cShana.textContent  = vendCounts.SHANA;
  if (cOutro)  cOutro.textContent  = vendCounts.OUTRO;

  const setBar = (id, count) => {
    const bar = document.getElementById(id);
    if (bar) bar.style.width = total > 0 ? Math.round((count / total) * 100) + "%" : "0%";
  };
  setBar("mc-bar-carla", vendCounts.CARLA);
  setBar("mc-bar-jones", vendCounts.JONES);
  setBar("mc-bar-shana", vendCounts.SHANA);
  setBar("mc-bar-outro", vendCounts.OUTRO);
}

/* ==================================================
   RENDERIZAÇÃO DE TABELAS / CARDS
================================================== */
function updateViews() { 
  if (isViewerMode) renderGlobalFeed();
  else renderProjects(); 
}

function switchManagerTab(tab) {
  managerTab = tab;
  ["fila","andamento","espera","concluidos","graficos"].forEach(t => document.getElementById(`tab-${t}`)?.classList.toggle("active", tab === t));
  const isGraph = tab === "graficos";
  document.getElementById("global-feed-container").classList.toggle("hidden", isGraph);
  document.getElementById("view-graphics").classList.toggle("hidden", !isGraph);
  if (isGraph) { refreshGraphFilters("manager"); } else renderGlobalFeed();
}

function renderGlobalFeed() {
  const container = document.getElementById("global-feed-container"); if (!container) return;
  const src = (document.getElementById("manager-search")?.value || "").toLowerCase();
  const sort = document.getElementById("manager-sort-select")?.value || "DATE_DESC";
  const list = filterAndSort(appData.projects || [], src, sort, managerTab);
  
  viewMode === "table" ? buildTable(list, container, false) : buildCards(list, container, false);
  updateBadges(); 
}

function switchDraftsmanTab(tab) {
  draftsmanTab = tab;
  const tabMap = {
    fila: "tab-d-fila",
    andamento: "tab-d-andamento",
    espera: "tab-d-espera",
    concluidos: "tab-d-concluidos",
    graficos: "tab-d-graficos",
    meus_concluidos: "tab-d-meus-concluidos"
  };
  Object.entries(tabMap).forEach(([k, id]) => {
    document.getElementById(id)?.classList.toggle("active", tab === k);
  });

  const isGraph = tab === "graficos";
  const isMeusConcluidos = tab === "meus_concluidos";

  document.getElementById("projects-container").classList.toggle("hidden", isGraph);
  document.getElementById("view-draftsman-graphics").classList.toggle("hidden", !isGraph);
  document.getElementById("meus-concluidos-stats")?.classList.toggle("hidden", !isMeusConcluidos);

  if (isGraph) { refreshGraphFilters("draftsman"); } else renderProjects();
}

function renderProjects() {
  const container = document.getElementById("projects-container"); if (!container || draftsmanTab === "graficos") return;
  container.innerHTML = "";
  const src = (document.getElementById("search-input")?.value || "").toLowerCase();
  const filterUser = document.getElementById("user-filter-select")?.value || "MEUS";
  const sort = document.getElementById("sort-filter-select")?.value  || "DATE_DESC";
  let list = filterAndSort(appData.projects || [], src, sort, draftsmanTab);
  
  if (draftsmanTab === "concluidos") {
    // Visualização Geral de todos os projetos concluídos
  } else if (draftsmanTab === "meus_concluidos") {
    list = list.filter(p => {
      if (currentUser === "ADMIN") {
        if (filterUser === "ALL") return true;
        if (filterUser === "MEUS") return p.owner === "Admin" || p.owner === "ADMIN";
        return p.owner === filterUser;
      }
      return p.owner === currentUser;
    });
    list = filterByMcPeriod(list);
    updateMeusConcluidosPanel(list);
  } else {
    list = list.filter(p => {
      const isFila = p.owner === "Fila" || p.owner === "Sem Desenhista";
      if (isFila) return true;
      if (filterUser === "ALL") return true;
      return filterUser === "MEUS" ? p.owner === currentUser : p.owner === filterUser;
    });
  }

  viewMode === "table" ? buildTable(list, container, true) : buildCards(list, container, true);
  
  updateBadges(); 
  updateAdminSuggestion();
}

function filterAndSort(projects, search, sort, tab) {
  return projects
    .filter(p => {
      if (!p) return false;
      const stage = Number(p.stageIndex) || 0;
      const isPaused = Boolean(p.isImpeded) && stage < 8;

      const inTab =
        tab === "espera"          ? isPaused :
        tab === "fila"            ? (!isPaused && stage === 0) :
        tab === "andamento"       ? (!isPaused && stage > 0 && stage < 8) :
        (tab === "concluidos" || tab === "meus_concluidos") ? stage >= 8 : false;

      if (!inTab) return false;
      if (sort === "TIPO_NOVO" && p.tipo !== "NOVO") return false;
      if (sort === "TIPO_REVISAO" && p.tipo !== "REVISÃO") return false;
      
      const searchSpace = ((p.name||"")+" "+(p.cod||"")+" "+(p.owner||"")+" "+((p.previousCods||[]).join(" "))).toLowerCase();
      return searchSpace.includes(search);
    })
    .sort((a, b) => {
      if (sort === "VENDEDOR") { const cmp = (a.vendedor||"").localeCompare(b.vendedor||""); return cmp !== 0 ? cmp : b.id - a.id; }
      return sort === "DATE_ASC" ? a.id - b.id : b.id - a.id;
    });
}

/* ==================================================
   MONTAGEM DA VIEW: TABELA EXCEL (READ ONLY)
================================================== */
function buildTable(list, container, isDash) {
  container.style.display = "block";
  container.innerHTML = "";
  if (!list.length) { container.innerHTML = `<div class="empty-state"><div class="empty-icon">📭</div><p>Nenhum projeto encontrado nesta visualização.</p></div>`; return; }

  const showDurationCol = (isDash && (draftsmanTab === "concluidos" || draftsmanTab === "meus_concluidos")) || (!isDash && managerTab === "concluidos");

  let html = `
    <p style="text-align:right; font-size:0.82rem; color:var(--text-light); margin-bottom:8px;">⚠️ Modo de visualização somente leitura. Alterne para "Ver em Cards" para editar.</p>
    <div class="table-responsive">
      <table class="data-table">
        <thead>
          <tr>
            <th>Vendedor</th>
            <th>Tipo</th>
            <th>Probabilidade</th>
            <th>Situação (Etapa)</th>
            <th>Cliente / Obra</th>
            <th>CÓD</th>
            <th>Cidade</th>
            <th>Entrada (Fila)</th>
            <th>Desenhista</th>
            <th>Largura (J)</th>
            <th>Comprimento (K)</th>
            <th>Altura (L)</th>
            ${showDurationCol ? "<th>Tempo Gasto</th>" : ""}
          </tr>
        </thead>
        <tbody>
  `;
  list.forEach(p => {
    if (!p) return; const stageVal = Number(p.stageIndex) || 0;
    let stageName = p.isImpeded ? "EM ESPERA (PAUSADO)" : (p.reworkType ? `REVISÃO (${p.reworkType})`.toUpperCase() : STAGES[stageVal]);
    if (stageVal >= 8) stageName = "ENTREGUE";
    let typeBadge = p.tipo === "REVISÃO" ? "badge-revisao" : "badge-novo";
    let probBadge = p.probabilidade === "ALTA" ? "badge-alta" : (p.probabilidade === "MÉDIA" ? "badge-media" : "badge-baixa");
    let entryDate = p.history && p.history.length > 0 ? p.history[p.history.length - 1].date.split(" ")[0] : "-";
    
    let codDisplay = p.cod || "-";
    if (p.previousCods && p.previousCods.length > 0) {
      codDisplay += ` <span style="font-size:0.7rem; background:rgba(245, 158, 11, 0.2); color:var(--warning); padding:2px 4px; border-radius:4px; margin-left:4px;" title="Versões anteriores: ${p.previousCods.join(', ')}">⚠️ ex: ${p.previousCods[p.previousCods.length-1]}</span>`;
    }

    const durationStr = showDurationCol ? `<td style="font-weight:700; color:var(--success);">${formatDurationBadge(getProjectDurationHours(p))}</td>` : "";

    html += `
      <tr>
        <td style="font-weight:700; color:var(--text);">${p.vendedor || "-"}</td>
        <td><span class="badge-table ${typeBadge}">${p.tipo || "NOVO"}</span></td>
        <td><span class="badge-table ${probBadge}">${p.probabilidade || "-"}</span></td>
        <td><span class="badge-stage">${stageName}</span></td>
        <td style="max-width:260px; overflow:hidden; text-overflow:ellipsis; color:var(--text);" title="${p.name || ''}">${p.name || "-"}</td>
        <td style="font-weight:600; color:var(--text);">${codDisplay}</td>
        <td style="color:var(--text);">${p.cidade || "-"}</td>
        <td style="color:var(--text-light); font-size:0.8rem;">${entryDate}</td>
        <td style="font-weight:600; color:var(--primary);">${p.owner}</td>
        <td style="color:var(--text); text-align:center;">${p.largura || "-"}</td>
        <td style="color:var(--text); text-align:center;">${p.comprimento || "-"}</td>
        <td style="color:var(--text); text-align:center;">${p.altura || "-"}</td>
        ${durationStr}
      </tr>
    `;
  });
  html += `</tbody></table></div>`; container.innerHTML = html;
}

/* ==================================================
   MONTAGEM DA VIEW: CARDS DINÂMICOS COM INTERAÇÃO
================================================== */
function buildCards(list, container, isDash) {
  container.innerHTML = ""; if (!list.length) { container.style.display = "block"; container.innerHTML = `<div class="empty-state"><div class="empty-icon">📭</div><p>Nenhum projeto encontrado.</p></div>`; return; }
  container.style.display = "grid";

  list.forEach(p => {
    if (!p) return; const stageVal = Number(p.stageIndex) || 0;
    const isC = stageVal >= 8; const isMine = p.owner === currentUser; const isAdmin = currentUser === "ADMIN";
    const isFila = p.owner === "Fila" || p.owner === "Sem Desenhista"; const canEdit = !isViewerMode && isDash && (isMine || isAdmin || isFila);

    let cardClass = isC ? "completed" : (p.isImpeded ? "impediment" : "");
    if (!isC && p.reworkType === "interno") cardClass += " rework-int";
    if (!isC && p.reworkType === "externo") cardClass += " rework-ext";

    const progress = Math.round((stageVal / (STAGES.length - 1)) * 100);
    const stageOpts = STAGES.map((s, i) => `<option value="${i}" ${i === stageVal ? "selected" : ""}>${i+1}. ${s}</option>`).join("");
    const histHTML = (p.history || []).map((h, i) => {
      if (!h) return "";
      const editBtns = canEdit ? `<div class="timeline-actions"><button class="icon-btn" onclick="editHistoryItem('${p.id}',${i})">✏️</button><button class="icon-btn" onclick="deleteHistoryItem('${p.id}',${i})">🗑️</button></div>` : "";
      const dateAttr = canEdit ? `class="timeline-date editable" onclick="openDateModal('${p.id}',${i})"` : `class="timeline-date"`;
      let sStyle = h.stage?.includes("RECADO") || h.stage?.includes("ASSUMIU") ? "color:var(--purple);font-weight:700;" : (h.stage?.includes("CORRIGIDO") || h.stage?.includes("REVISÃO") ? "color:var(--success);font-weight:700;" : "");

      return `<div class="timeline-item"><div class="timeline-top"><span class="timeline-stage" style="${sStyle}">${h.stage||""}</span>${editBtns}</div>
        <div class="timeline-obs">↳ ${h.obs||""}</div>
        <div class="timeline-meta"><span class="timeline-author">👤 ${h.author||p.owner}</span><span ${dateAttr}>${h.date||""}</span></div></div>`;
    }).join("");

    let statusLabel = p.isImpeded
      ? `⚠️ EM ESPERA (${STAGES[stageVal]})`
      : (isC ? "✅ CONCLUÍDO" : (!isC && p.reworkType === "interno" ? "🔄 REVISÃO — ERRO INTERNO" : (!isC && p.reworkType === "externo" ? "🔄 REVISÃO — PEDIDO EXTERNO" : "▶ " + STAGES[stageVal])));
    let actions = "";
    
    if (isFila && isDash && !isViewerMode && stageVal === 0) {
      actions += `<button class="btn-assume success" onclick="assumirProjeto('${p.id}')">🚀 Assumir e Desenhar</button>`;
    }
    if (!isViewerMode && isDash && !isC && (stageVal === 3 || stageVal === 4)) {
      actions += `<button class="btn-corrected success" onclick="markAsCorrected('${p.id}')">✅ Marcar como Corrigido</button>`;
    }
    
    const commonBtns = (isDash && canEdit || isViewerMode) ? `<button class="secondary" onclick="registerEvent('${p.id}')">📝 Recado</button>` : "";
    
    if (canEdit && !isC) {
      actions += `<div class="actions-row">${commonBtns}<button class="${p.isImpeded ? 'success' : 'warning'}" title="${p.isImpeded ? 'Retomar projeto' : 'Colocar em espera'}" onclick="toggleImpediment('${p.id}')">${p.isImpeded ? '▶' : '⏸'}</button><button class="danger" onclick="deleteProject('${p.id}')">🗑️</button></div>`;
    } else if (!isViewerMode && isC) {
      actions += `<div class="actions-row">${commonBtns}<button style="background:var(--orange);color:#fff;flex:2;" onclick="createRevisaoFromCompleted('${p.id}')">🔄 Criar Revisão</button></div>`;
    } else if (isViewerMode) {
      actions += `<div class="actions-row">${commonBtns}</div>`;
    }
    
    actions += `<button class="btn-pdf" onclick="exportReportPDF('${p.id}')">📄 Dossier PDF</button>`;

    let prevCodsHTML = "";
    if (p.previousCods && p.previousCods.length > 0) {
      prevCodsHTML = `<div class="info-row" style="margin-top:6px; padding-top:6px; border-top:1px dashed var(--border-h);">
          <span style="font-size:0.8rem; color:var(--text-light);"><strong>CÓDs Antigos:</strong> ${p.previousCods.join(", ")}</span>
      </div>`;
    }

    const dimStr = formatDimensions(p);
    const dimHTML = `<div class="info-row" style="margin-top:4px;"><span><strong>Dimensões (L×C×A):</strong> ${dimStr}</span></div>`;

    const durationBadgeHTML = isC
      ? `<span class="badge-duration" title="Tempo útil entre assumir o projeto e entregar">⏱️ ${formatDurationBadge(getProjectDurationHours(p))}</span>`
      : "";

    const card = document.createElement("div"); card.className = `project-card ${cardClass}`;
    card.innerHTML = `
      <div style="display:flex; align-items:center; justify-content:space-between; gap:8px; flex-wrap:wrap;">
        <span class="badge-owner">👤 ${p.owner}</span>
        ${durationBadgeHTML}
        ${canEdit && !isC ? `<button class="ghost" style="font-size:0.8rem; padding:4px 8px;" onclick="toggleRework('${p.id}')">${p.reworkType ? "✅ Fechar Revisão" : "🔄 Retrabalho"}</button>` : ""}
      </div>
      <div class="project-title-row"><h2>${p.name||"Sem Nome"}</h2>${canEdit ? `<button class="icon-btn" onclick="editProjectName('${p.id}')">✏️</button>` : ""}</div>
      <div class="info-box">
        ${canEdit ? `<button class="icon-btn edit-info-btn" onclick="openEditProjectModal('${p.id}')">⚙️</button>` : ""}
        <div class="info-row"><span><strong>CÓD:</strong> ${p.cod||"-"}</span><span><strong>Vend:</strong> ${p.vendedor||"-"}</span></div>
        <div class="info-row"><span><strong>Tipo:</strong> ${p.tipo||"-"}</span><span><strong>Prob:</strong> ${p.probabilidade||"-"}</span></div>
        <hr class="info-divider">
        <div class="info-row"><span><strong>Cidade:</strong> ${p.cidade||"-"}</span></div>
        ${dimHTML}
        ${prevCodsHTML}
      </div>
      ${canEdit ? `<select class="stage-select" onchange="updateStage('${p.id}',this)" ${p.isImpeded||p.reworkType?"disabled":""}>${stageOpts}</select>` : ""}
      <div class="status-label">${statusLabel}</div>
      <div class="progress-wrap"><div class="progress-bar" style="width:${progress}%;"></div></div>
      <div class="timeline"><div class="timeline-header">📋 Histórico</div>${histHTML || '<div style="color:var(--text-light);">Nenhum registro.</div>'}</div>
      <div class="card-actions">${actions}</div>
    `;
    container.appendChild(card);
  });
}

/* ==================================================
   CRUDS, MODIFICAÇÕES DE PROJETO E SINCRONIZAÇÃO
================================================== */
function openEditProjectModal(id) {
  const p = findProject(id); if (!p) return;
  document.getElementById("ep-id").value = id;
  document.getElementById("ep-cod").value = p.cod || "";
  document.getElementById("ep-cidade").value = p.cidade || "";
  document.getElementById("ep-vendedor").value = p.vendedor || "";
  document.getElementById("ep-tipo").value = p.tipo || "NOVO";
  document.getElementById("ep-probabilidade").value = p.probabilidade || "";
  document.getElementById("ep-largura").value = p.largura || "";
  document.getElementById("ep-comprimento").value = p.comprimento || "";
  document.getElementById("ep-altura").value = p.altura || "";
  document.getElementById("edit-project-modal").classList.remove("hidden");
}
function closeEditProjectModal(confirm) {
  document.getElementById("edit-project-modal").classList.add("hidden"); if (!confirm) return;
  const p = findProject(document.getElementById("ep-id").value); if (!p) return;
  const oldCod = p.cod || "";
  p.cod = document.getElementById("ep-cod").value.trim();
  p.cidade = document.getElementById("ep-cidade").value.trim();
  p.vendedor = document.getElementById("ep-vendedor").value;
  p.tipo = document.getElementById("ep-tipo").value;
  p.probabilidade = document.getElementById("ep-probabilidade").value;
  p.largura = document.getElementById("ep-largura").value.trim();
  p.comprimento = document.getElementById("ep-comprimento").value.trim();
  p.altura = document.getElementById("ep-altura").value.trim();
  saveData(); updateViews(); toast("Atualizado!", "success");

  // Sincroniza edições com a planilha (sem criar linha nova)
  syncUpdateToGoogleSheets(p, { oldCod, onlyEditInfo: true });
}

function openCreateProjectModal() {
  ["cp-cliente","cp-cod","cp-cidade","cp-obs","cp-largura","cp-comprimento","cp-altura"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
  document.getElementById("cp-vendedor").value = "";
  document.getElementById("cp-tipo").value = "NOVO";
  document.getElementById("cp-probabilidade").value = "";
  const skipCheckbox = document.getElementById("cp-skip-sheets"); if (skipCheckbox) skipCheckbox.checked = false;
  document.getElementById("create-project-modal").classList.remove("hidden");
  requestAnimationFrame(() => document.getElementById("cp-cliente").focus());
}
function closeCreateProjectModal(confirm) {
  if (!confirm) { document.getElementById("create-project-modal").classList.add("hidden"); return; }
  const cli = document.getElementById("cp-cliente").value.trim();
  if (!cli) { toast("Nome obrigatório!", "warning"); return; }
  if (!appData.projects) appData.projects = [];
  
  const newProj = {
    id: Date.now().toString(),
    owner: "Fila",
    name: cli,
    stageIndex: 0,
    isImpeded: false,
    reworkType: null,
    cod: document.getElementById("cp-cod").value.trim(),
    vendedor: document.getElementById("cp-vendedor").value,
    tipo: document.getElementById("cp-tipo").value,
    probabilidade: document.getElementById("cp-probabilidade").value,
    cidade: document.getElementById("cp-cidade").value.trim(),
    largura: document.getElementById("cp-largura").value.trim(),
    comprimento: document.getElementById("cp-comprimento").value.trim(),
    altura: document.getElementById("cp-altura").value.trim(),
    previousCods: [],
    history: [{ stage: STAGES[0], obs: document.getElementById("cp-obs").value.trim() || "Adicionado à fila.", date: nowBR(), author: currentUser || "Visualizador" }]
  };

  appData.projects.unshift(newProj);
  document.getElementById("create-project-modal").classList.add("hidden");
  saveData(); updateViews(); 
  
  isViewerMode ? switchManagerTab("fila") : switchDraftsmanTab("fila");
  toast("Criado e inserido na Fila!", "success");

  const skipSheets = document.getElementById("cp-skip-sheets").checked;
  if (!skipSheets) sendToGoogleSheets(newProj);
}

async function editProjectName(id) {
  const p = findProject(id); if (!p) return;
  const n = await openCustomModal("Editar Nome", "Qual o novo nome?", "Nome...", p.name);
  if (n !== null && n.trim()) {
    p.name = n.trim();
    saveData();
    updateViews();
    syncUpdateToGoogleSheets(p, { onlyEditInfo: true });
  }
}
async function deleteProject(id) {
  const p = findProject(id); const ok = await openConfirmModal("Excluir", `Apagar permanentemente "${p?.name}"?`);
  if (!ok) return;
  appData.projects = appData.projects.filter(x => x.id !== id); saveData(); updateViews(); toast("Excluído.", "info");
}

async function updateStage(id, sel) {
  const p = findProject(id); if (!p) return; const idx = parseInt(sel.value);
  if (p.stageIndex === idx) return;
  const sName = STAGES[idx] || "Desconhecido";
  const obs = await openCustomModal("Avançar Etapa", `Mudar para: "${sName}"`, "Obs...");
  if (obs === null) { sel.value = p.stageIndex; return; }
  
  let justAssumed = false;
  if (idx === 0) {
    p.owner = "Fila"; 
  } else if (p.owner === "Fila" || p.owner === "Sem Desenhista") { 
    p.owner = currentUser === "ADMIN" ? "Admin" : currentUser; 
    pushHistory(p, "🚀 ASSUMIU PROJETO", `Auto-assumido.`); 
    appData.lastVendedor = normalizeVendedor(p.vendedor);
    justAssumed = true;
  }
  
  p.stageIndex = idx;
  pushHistory(p, sName === "Desenhista" ? "🔄 Retornou ao Desenhista" : sName, obs || "Etapa alterada."); 
  saveData(); updateViews();

  // Sincroniza automaticamente com a Planilha (APENAS ATUALIZA A LINHA EXISTENTE):
  // Coluna D = Etapa/Situação | Coluna Q = Desenhista | Coluna R = Data de Início | Coluna T = Data de Conclusão (se idx === 8)
  syncUpdateToGoogleSheets(p, {
    dataInicio: justAssumed ? todayShortBR() : getProjectStartDateStr(p),
    forceStartDate: justAssumed,
    dataConclusao: idx >= 8 ? todayShortBR() : ""
  });
}

async function markAsCorrected(id) {
  const p = findProject(id); if (!p) return;
  const obs = await openCustomModal("Corrigido", "Obs (opcional):", "Tudo certo...");
  if (obs === null) return; p.stageIndex = 7;
  pushHistory(p, "✅ CORRIGIDO", obs || "Corrigido."); saveData(); 
  if (isViewerMode) renderGlobalFeed(); else renderProjects();

  // Atualiza Coluna D na planilha de volta para DESENHISTA
  syncUpdateToGoogleSheets(p, { situacao: "DESENHISTA" });
}

async function assumirProjeto(id) {
  const p = findProject(id); if (!p) return; const ant = p.owner;
  p.owner = currentUser === "ADMIN" ? "Admin" : currentUser;
  p.stageIndex = 1;
  if (p.isImpeded) {
    p.isImpeded = false;
    pushHistory(p, "🟢 RETOMADO", "Retomado ao assumir projeto.");
  }
  appData.lastVendedor = normalizeVendedor(p.vendedor); 
  pushHistory(p, "🚀 ASSUMIU PROJETO", `De [${ant}] -> [${p.owner}].`); 
  saveData(); updateViews(); 
  toast(`Você assumiu este projeto!`, "success"); 
  switchDraftsmanTab("andamento");

  // Atualiza Planilha: Coluna D = DESENHISTA | Coluna Q = Desenhista | Coluna R = Data de Início
  syncUpdateToGoogleSheets(p, {
    situacao: "DESENHISTA",
    dataInicio: todayShortBR(),
    forceStartDate: true
  });
}

function createRevisaoFromCompleted(id) {
  const p = findProject(id); if (!p) return;
  document.getElementById("cr-id").value = id;
  document.getElementById("cr-cod").value = "";
  document.getElementById("cr-motivo").value = "";
  document.getElementById("cr-skip-sheets").checked = false;
  document.getElementById("create-revisao-modal").classList.remove("hidden");
  requestAnimationFrame(() => document.getElementById("cr-cod").focus());
}

function closeCreateRevisaoModal(confirm) {
  document.getElementById("create-revisao-modal").classList.add("hidden");
  if (!confirm) return;
  
  const id = document.getElementById("cr-id").value;
  const p = findProject(id); if (!p) return;
  
  const oldCod = p.cod;
  const newCod = document.getElementById("cr-cod").value.trim();
  const mot = document.getElementById("cr-motivo").value.trim();
  const skipSheets = document.getElementById("cr-skip-sheets").checked;
  
  if (!mot) { toast("O motivo é obrigatório!", "warning"); return; }

  let msgHistorico = mot;

  if (newCod && newCod !== oldCod) {
    if (!p.previousCods) p.previousCods = [];
    if (oldCod && !p.previousCods.includes(oldCod)) {
      p.previousCods.push(oldCod);
    }
    msgHistorico = `[CÓD alterado de ${oldCod||'Sem Cód'} ➔ ${newCod}] ` + mot;
    p.cod = newCod;
  }

  p.stageIndex = 0; 
  p.isImpeded = false;
  p.tipo = "REVISÃO";
  p.owner = "Fila"; 
  
  pushHistory(p, "🔄 RETORNOU PARA REVISÃO", msgHistorico);
  saveData(); 
  updateViews(); 
  switchDraftsmanTab("fila");
  toast("Voltou como REVISÃO e está livre na fila.", "info");
  
  // Revisão = linha NOVA na aba AGENDA 2026 (a anterior já foi levada para "Prontos")
  if (!skipSheets) sendToGoogleSheets(p, { date: todayShortBR() });
}

async function registerEvent(id) {
  const p = findProject(id);
  if (p) {
    const obs = await openCustomModal("Recado", "Insira o recado:", "");
    if (obs) { pushHistory(p, "📢 RECADO", obs); saveData(); updateViews(); }
  }
}
async function editHistoryItem(id, i) {
  const p = findProject(id);
  if (p && p.history[i]) {
    const n = await openCustomModal("Editar Histórico", `Ajustar obs de: ${p.history[i].stage}`, "", p.history[i].obs);
    if (n !== null) { p.history[i].obs = n || "Sem obs."; saveData(); updateViews(); }
  }
}
async function deleteHistoryItem(id, i) {
  const ok = await openConfirmModal("Remover", "Remover este item?");
  if (ok) { const p = findProject(id); if (p?.history) { p.history.splice(i, 1); saveData(); updateViews(); } }
}

// Pausar/Retomar move o projeto apenas para a aba "Em Espera" no sistema, sem criar linhas na planilha
async function toggleImpediment(id) {
  const p = findProject(id); if (!p) return;
  if (p.isImpeded) {
    const obs = await openCustomModal("Retomar Projeto", "Como foi resolvido?", "Obs...");
    if (obs === null) return;
    p.isImpeded = false;
    pushHistory(p, "🟢 RETOMADO", obs || "Liberado.");
    toast("Projeto retomado!", "success");
  } else {
    const obs = await openCustomModal("Colocar em Espera (Pausar)", "Motivo da pausa (obrigatório):", "");
    if (!obs || !obs.trim()) { toast("Informe o motivo para pausar.", "warning"); return; }
    p.isImpeded = true;
    pushHistory(p, "🔴 PAUSADO", obs.trim());
    toast("Projeto movido para a aba 'Em Espera'.", "warning");
  }
  saveData();
  updateViews();
}

async function toggleRework(id) {
  const p = findProject(id); if (!p) return;
  if (p.reworkType) {
    const obs = await openCustomModal("Fechar Revisão", "Retrabalho concluído? Descreva:", "");
    if (obs === null) return;
    p.reworkType = null; pushHistory(p, "✅ RETRABALHO CONCLUÍDO", obs || "Concluído."); saveData(); updateViews();
  } else {
    reworkProjectId = id;
    document.getElementById("rework-obs-input").value = "";
    document.getElementById("rework-modal").classList.remove("hidden");
  }
}
function closeReworkModal(confirm) {
  document.getElementById("rework-modal").classList.add("hidden");
  if (!confirm || !reworkProjectId) { reworkProjectId = null; return; }
  const type = document.getElementById("rework-type-select").value;
  const obs = document.getElementById("rework-obs-input").value;
  const p = findProject(reworkProjectId);
  if (p) {
    p.reworkType = type.toLowerCase();
    pushHistory(p, `⚠️ RETRABALHO INICIADO — ${type}`, obs || "Não informado.");
    saveData(); updateViews();
  }
  reworkProjectId = null;
}

function openDateModal(id, i) {
  if (isViewerMode) return;
  dateEditCtx = { projectId: id, histIndex: i };
  const p = findProject(id); if (!p?.history?.[i]) return;
  document.getElementById("date-modal-input").value = dateToLocalString(p.history[i].date);
  document.getElementById("date-modal").classList.remove("hidden");
}
function closeDateModal(confirm) {
  document.getElementById("date-modal").classList.add("hidden");
  if (confirm && dateEditCtx.projectId !== null) {
    const val = document.getElementById("date-modal-input").value;
    if (val) {
      const p = findProject(dateEditCtx.projectId);
      if (p?.history?.[dateEditCtx.histIndex]) {
        p.history[dateEditCtx.histIndex].date = localStringToDate(val);
        saveData(); updateViews();
      }
    }
  }
  dateEditCtx = { projectId: null, histIndex: null };
}

/* ==================================================
   GERAÇÃO DE GRÁFICOS PARETO (CHART.JS)
================================================== */
function refreshGraphFilters(context) {
  const isManager = context === "manager";
  const userSel = document.getElementById(isManager ? "graph-user-manager" : "graph-user-draftsman");
  const oldUser = userSel.value;
  
  let html = isManager ? '<option value="ALL">Geral da Empresa</option>' : `<option value="MEUS">Meus Projetos (${currentUser})</option><option value="ALL">Geral da Empresa</option>`;
  (appData.users || []).filter(u => u !== "ADMIN").forEach(u => {
    if (!isManager && u === currentUser) return;
    html += `<option value="${u}">${isManager ? u : 'Projetos de: '+u}</option>`;
  });
  
  userSel.innerHTML = html;
  if (oldUser && [...userSel.options].some(o => o.value === oldUser)) userSel.value = oldUser;

  renderPareto(context); 
}

function renderPareto(context) {
  const isManager = context === "manager"; 
  const canvasId = isManager ? "paretoChart" : "draftsmanParetoChart";
  
  const userSelVal = document.getElementById(isManager ? "graph-user-manager" : "graph-user-draftsman")?.value;
  const projSel = document.getElementById(isManager ? "graph-project-manager" : "graph-project-draftsman");
  const projSelVal = projSel?.value;

  if (!userSelVal) return;

  const startDateStr = document.getElementById(isManager ? "pareto-start-manager" : "pareto-start-draftsman")?.value;
  const endDateStr = document.getElementById(isManager ? "pareto-end-manager" : "pareto-end-draftsman")?.value;
  
  const minBound = startDateStr ? new Date(startDateStr + "T00:00:00").getTime() : 0;
  const maxBound = endDateStr ? new Date(endDateStr + "T23:59:59").getTime() : Infinity;

  let baseList = appData.projects || [];
  if (userSelVal === "MEUS") baseList = baseList.filter(p => p.owner === currentUser);
  else if (userSelVal !== "ALL") baseList = baseList.filter(p => p.owner === userSelVal);

  if (projSel) {
    projSel.innerHTML = '<option value="ALL">Todos os Projetos</option>';
    baseList.forEach(p => {
      projSel.innerHTML += `<option value="${p.id}">${p.name} (${p.cod||'-'})</option>`;
    });
    if (projSelVal && [...projSel.options].some(o => o.value === projSelVal)) {
      projSel.value = projSelVal;
    }
  }

  let target = projSel?.value !== "ALL" && projSel?.value ? baseList.filter(p => p.id === projSel.value) : baseList;
  
  const hours = {}; STAGES.forEach(s => hours[s] = 0); hours["Pausado / Impedido"] = 0;
  let countByStage = {}; 
  let currentActive = {}; 
  
  let total = target.length, sumCompleted = 0, countCompleted = 0;
  let countFila = 0;

  target.forEach(p => {
    if (!p.history) return; 
    const rev = [...p.history].reverse(); 
    let startMs = null, endMs = null;
    let pInFila = false;
    let stagesInThisProject = new Set(); 

    rev.forEach(ev => { 
      if (!ev) return; 
      if (!startMs && (ev.stage === STAGES[1] || ev.stage?.includes("ASSUMIU"))) startMs = parseDateBR(ev.date); 
      if (ev.stage === STAGES[8]) endMs = parseDateBR(ev.date); 
    });
    if (startMs && endMs && endMs > startMs) { sumCompleted += getBusinessHours(startMs, endMs); countCompleted++; }
    
    let curStage = null, lastTime = null;
    
    rev.forEach(ev => { 
      if (!ev) return; 
      const t = parseDateBR(ev.date); 
      if (curStage && lastTime) {
        let startOverlap = Math.max(lastTime, minBound);
        let endOverlap = Math.min(t, maxBound);
        if (startOverlap < endOverlap) {
          hours[curStage] = (hours[curStage] || 0) + getBusinessHours(startOverlap, endOverlap); 
          stagesInThisProject.add(curStage);
          if (curStage === STAGES[0]) pInFila = true;
        }
      } 
      
      if (STAGES.includes(ev.stage)) curStage = ev.stage; 
      else if (ev.stage === "🔴 PAUSADO") curStage = "Pausado / Impedido"; 
      else if (ev.stage === "🟢 RETOMADO") curStage = STAGES[p.stageIndex] || STAGES[0]; 
      else if (ev.stage && ev.stage.includes("Desenhista")) curStage = "Desenhista";

      lastTime = t; 
    });
    
    if (p.stageIndex !== 8 && lastTime && curStage) {
      let startOverlap = Math.max(lastTime, minBound);
      let endOverlap = Math.min(Date.now(), maxBound);
      if (startOverlap < endOverlap) {
        hours[curStage] = (hours[curStage] || 0) + getBusinessHours(startOverlap, endOverlap);
        stagesInThisProject.add(curStage);
        if (curStage === STAGES[0]) pInFila = true;
      }
    }
    
    if (pInFila) countFila++;
    stagesInThisProject.forEach(s => { countByStage[s] = (countByStage[s] || 0) + 1; });

    if (p.stageIndex !== 8) {
      let currentS = STAGES[p.stageIndex];
      if (p.isImpeded) currentS = "Pausado / Impedido";
      let histStage = p.history && p.history.length > 0 ? p.history[0].stage : null;
      if (histStage) {
        if (histStage === "🔴 PAUSADO") currentS = "Pausado / Impedido";
        else if (histStage === "🟢 RETOMADO") currentS = STAGES[p.stageIndex] || STAGES[0];
        else if (histStage.includes("Desenhista")) currentS = "Desenhista";
        else if (STAGES.includes(histStage)) currentS = histStage;
      }
      currentActive[currentS] = (currentActive[currentS] || 0) + 1;
    }
  });

  const totalFilaHours = hours[STAGES[0]] || 0;
  const avgFila = countFila > 0 ? Math.round(totalFilaHours / countFila) : 0;

  delete hours[STAGES[0]];
  delete hours["Entregue"];

  if (isManager) {
    if (document.getElementById("kpi-total")) document.getElementById("kpi-total").textContent = total;
    if (document.getElementById("kpi-avg-time")) document.getElementById("kpi-avg-time").textContent = countCompleted ? Math.round(sumCompleted/countCompleted)+"h" : "0h";
    if (document.getElementById("kpi-completed")) document.getElementById("kpi-completed").textContent = countCompleted;
    if (document.getElementById("kpi-avg-fila")) document.getElementById("kpi-avg-fila").textContent = avgFila + "h";
  } else {
    if (document.getElementById("dkpi-total")) document.getElementById("dkpi-total").textContent = total;
    if (document.getElementById("dkpi-avg-time")) document.getElementById("dkpi-avg-time").textContent = countCompleted ? Math.round(sumCompleted/countCompleted)+"h" : "0h";
    if (document.getElementById("dkpi-avg-fila")) document.getElementById("dkpi-avg-fila").textContent = avgFila + "h";
  }

  const items = Object.entries(hours).filter(([,h]) => h > 0.01).sort(([,a],[,b]) => b - a);
  const totalH = items.reduce((s,[,h]) => s+h, 0); let cumulative = 0;
  
  const labels = [], bars = [], line = [], avgHover = [], currentHover = [];
  
  items.forEach(([s, h]) => { 
    labels.push(s); 
    bars.push(h.toFixed(1)); 
    cumulative += h; 
    line.push(((cumulative/totalH)*100).toFixed(1)); 
    
    let projCount = countByStage[s] || 0;
    avgHover.push(projCount > 0 ? (h / projCount).toFixed(1) : 0);
    currentHover.push(currentActive[s] || 0); 
  });
  
  if (!labels.length) { labels.push("Sem dados no período"); bars.push(0); line.push(0); avgHover.push(0); currentHover.push(0); }

  if (activeCharts[canvasId]) activeCharts[canvasId].destroy();
  const canvas = document.getElementById(canvasId); if (!canvas) return;
  
  activeCharts[canvasId] = new Chart(canvas.getContext("2d"), {
    type: "bar",
    data: { 
      labels, 
      datasets: [
        { label: "% Acumulada", data: line, type: "line", borderColor: "#dc2626", yAxisID: "y1", tension: 0.3, pointRadius: 4 }, 
        { label: "Horas", data: bars, backgroundColor: isManager ? "#2563eb" : "#4f46e5", yAxisID: "y" }
      ] 
    },
    options: { 
      responsive: true, 
      maintainAspectRatio: false, 
      scales: { 
        y: { position: "left", title: { display: true, text: "Horas úteis" } }, 
        y1: { position: "right", max: 105, title: { display: true, text: "% Acumulado" }, grid: { drawOnChartArea: false } } 
      },
      plugins: {
        tooltip: {
          callbacks: {
            label: function(context) {
              let idx = context.dataIndex;
              if (context.datasetIndex === 1) { 
                return [
                  `Tempo Total: ${bars[idx]}h`,
                  `Média: ${avgHover[idx]}h / proj`,
                  `AGORA: ${currentHover[idx]} projs parados aqui`
                ];
              }
              return context.raw + '%'; 
            }
          }
        },
        datalabels: {
          display: function(context) { 
            return context.datasetIndex === 1 && currentHover[context.dataIndex] > 0; 
          },
          align: 'end',
          anchor: 'end',
          formatter: function(value, context) {
            let activeCount = currentHover[context.dataIndex];
            return "📌 " + activeCount + " agora";
          },
          font: { size: 11, weight: 'bold' },
          color: '#dc2626'
        }
      }
    }
  });
}

/* ==================================================
   RELATÓRIOS E COMPILADOR EM JSPDF
================================================== */
function sanitizePDF(t) { 
  return (t || "").normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^\x20-\x7E\n\r]/g,""); 
}

function exportReportPDF(id) {
  if (!window.jspdf?.jsPDF) { toast("Gerador Indisponível.", "warning"); return; } const p = findProject(id); if (!p) return;
  const doc = new window.jspdf.jsPDF(); doc.setFont("helvetica","bold"); doc.setFontSize(22); doc.setTextColor(37,99,235); doc.text("DOSSIER DO PROJETO", 14, 22);
  doc.setFontSize(14); doc.setTextColor(0,0,0); doc.text(`Obra: ${sanitizePDF(p.name)}`, 14, 32);
  doc.autoTable({
    startY:38,
    theme:"plain",
    body:[
      ["COD:",sanitizePDF(p.cod),"Vendedor:",sanitizePDF(p.vendedor)],
      ["Tipo:",sanitizePDF(p.tipo),"Probabilidade:",sanitizePDF(p.probabilidade)],
      ["Cidade:",sanitizePDF(p.cidade),"Responsavel:",sanitizePDF(p.owner)],
      ["Dimensoes (LxCxA):",sanitizePDF(formatDimensions(p)),"Tempo Util:",sanitizePDF(Number(p.stageIndex)>=8 ? formatDurationBadge(getProjectDurationHours(p)) : "Em andamento")]
    ],
    styles:{cellPadding:2,fontSize:11}
  });
  let y = doc.lastAutoTable.finalY + 10; doc.setFontSize(13); doc.setFont("helvetica","bold"); doc.setTextColor(37,99,235); doc.text("HISTORICO DE ATIVIDADES", 14, y);
  const rows = (p.history||[]).map(h => [sanitizePDF(h.date||""), sanitizePDF(h.stage||""), sanitizePDF(h.author||""), sanitizePDF(h.obs||"")]);
  doc.autoTable({ startY:y+5, head:[["Data","Etapa","Autor","Observacao"]], body:rows, theme:"striped", headStyles:{fillColor:[37,99,235]}, styles:{fontSize:9,cellPadding:3}, columnStyles:{3:{cellWidth:80}} });
  window.open(URL.createObjectURL(doc.output("blob")),"_blank");
}

function openPdfModal() {
  const optMeusAndamento = document.getElementById('pdf-opt-meus-and');
  const optMeusEspera = document.getElementById('pdf-opt-meus-esp');
  const optMeusConcluidos = document.getElementById('pdf-opt-meus-con');
  
  if (isViewerMode) {
    optMeusAndamento.style.display = 'none';
    optMeusEspera.style.display = 'none';
    optMeusConcluidos.style.display = 'none';
    document.getElementById('pdf-filter').value = 'TODOS_ANDAMENTO';
  } else {
    optMeusAndamento.style.display = 'block';
    optMeusEspera.style.display = 'block';
    optMeusConcluidos.style.display = 'block';
    document.getElementById('pdf-filter').value = draftsmanTab === 'meus_concluidos' ? 'MEUS_CONCLUIDOS' : 'MEUS_ANDAMENTO';
  }
  
  document.getElementById('pdf-modal').classList.remove('hidden');
}

function closePdfModal(confirm) {
  document.getElementById('pdf-modal').classList.add('hidden');
  if (!confirm) return;

  const filter = document.getElementById('pdf-filter').value;
  const detail = document.getElementById('pdf-detail').value;
  const showHistory = detail === 'HISTORICO';

  let list = appData.projects || [];
  let title = "Relatório de Projetos";

  if (filter === 'MEUS_ANDAMENTO') {
    list = list.filter(p => p.owner === currentUser && !p.isImpeded && p.stageIndex < 8);
    title = `Projetos em Andamento - ${currentUser}`;
  } else if (filter === 'MEUS_ESPERA') {
    list = list.filter(p => p.owner === currentUser && p.isImpeded && p.stageIndex < 8);
    title = `Projetos em Espera - ${currentUser}`;
  } else if (filter === 'MEUS_CONCLUIDOS') {
    list = list.filter(p => p.owner === currentUser && p.stageIndex >= 8);
    title = `Meus Projetos Concluídos - ${currentUser}`;
  } else if (filter === 'TODOS_ANDAMENTO') {
    list = list.filter(p => !p.isImpeded && p.stageIndex < 8);
    title = `Todos os Projetos em Andamento`;
  } else if (filter === 'TODOS_ESPERA') {
    list = list.filter(p => p.isImpeded && p.stageIndex < 8);
    title = `Todos os Projetos em Espera`;
  } else if (filter === 'TODOS_CONCLUIDOS') {
    list = list.filter(p => p.stageIndex >= 8);
    title = `Todos os Projetos Concluídos`;
  } else if (filter === 'TODOS') {
    title = `Todos os Projetos (Geral)`;
  }

  generateListPDF(list, title, showHistory);
}

function generateListPDF(list, title, showHistory) {
  if (!window.jspdf?.jsPDF) { toast("Gerador Indisponível.", "warning"); return; } 
  
  const doc = new window.jspdf.jsPDF(showHistory ? "landscape" : "portrait"); 
  
  doc.setFont("helvetica","bold"); 
  doc.setFontSize(18); 
  doc.setTextColor(37,99,235); 
  doc.text(sanitizePDF(title), 14, 22);
  
  doc.setFontSize(10); 
  doc.setTextColor(100,100,100); 
  doc.setFont("helvetica","normal"); 
  doc.text("Gerado em: " + new Date().toLocaleString("pt-BR"), 14, 29);
  
  let head = [];
  let rows = [];
  let columnStyles = {};

  if (showHistory) {
    head = [["CÓD", "Obra / Cliente", "Dimensões", "Responsável", "Histórico Completo"]];
    rows = list.map(p => {
      const histStr = (p.history||[]).map(h => `• ${h.date} | ${h.stage} (${h.author})\n   ↳ Obs: ${h.obs}`).join("\n\n");
      return [
        sanitizePDF(p.cod||"-"), 
        sanitizePDF(p.name), 
        sanitizePDF(formatDimensions(p)),
        sanitizePDF(p.owner), 
        sanitizePDF(histStr)
      ];
    });
    columnStyles = { 4: { cellWidth: 150 } }; 
  } else {
    head = [["CÓD", "Cliente/Obra", "Dimensões", "Vendedor", "Desenhista", "Etapa / Tempo"]];
    rows = list.map(p => [
      sanitizePDF(p.cod||"-"), 
      sanitizePDF(p.name), 
      sanitizePDF(formatDimensions(p)),
      sanitizePDF(p.vendedor||"-"), 
      sanitizePDF(p.owner), 
      sanitizePDF(
        Number(p.stageIndex) >= 8
          ? `ENTREGUE (${formatDurationBadge(getProjectDurationHours(p))})`
          : (p.isImpeded ? `EM ESPERA (${STAGES[p.stageIndex]||"-"})` : (STAGES[p.stageIndex]||"-"))
      )
    ]);
  }

  doc.autoTable({ 
    startY: 36, 
    head: head, 
    body: rows, 
    theme: "grid", 
    headStyles: { fillColor: [37,99,235] }, 
    styles: { fontSize: showHistory ? 8 : 9 },
    columnStyles: columnStyles
  });
  
  window.open(URL.createObjectURL(doc.output("blob")), "_blank");
}

/* ==================================================
   BACKUP INTERNO JSON
================================================== */
function exportBackup() {
  const d = new Date(); const name = `backup_projetos_${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}.json`;
  const a = document.createElement("a"); a.href = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(appData)); a.download = name; a.click(); toast("Backup gerado!", "success");
}
function importBackup(e) {
  const file = e.target.files[0]; if (!file) return; const reader = new FileReader();
  reader.onload = ev => { try { appData = JSON.parse(ev.target.result); saveData(); renderProfiles(); toast("Restaurado com sucesso!", "success"); } catch { toast("Arquivo inválido.", "danger"); } };
  reader.readAsText(file);
}