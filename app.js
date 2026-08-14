/*
 V6 - Login + Meter Condition
 Server URL remains the same.
 Users are authenticated by the Google Apps Script backend.
*/
const SERVER_URL = "https://script.google.com/macros/s/AKfycbxK2OBLpHt56qnCY0fF9q4EJaukTqVCpLNeuUHKT-R_eFe4xkVr8M2MpTPZhqE1a_yf/exec";

const state = {
  consumers: [],
  masterReady: false,
  masterCount: 0,
  current: null,
  db: null,
  masterDb: null,
  lookup: new Map(),
  meterLookup: new Map(),
  normalizedLookup: new Map(),
  sessionToken: localStorage.getItem("consumerMobileAuthToken") || "",
  userId: localStorage.getItem("consumerMobileUserId") || "",
  userName: localStorage.getItem("consumerMobileUserName") || "",
  isAdmin: localStorage.getItem("consumerMobileIsAdmin") === "YES",
  duplicateInfo: null
};
const $ = id => document.getElementById(id);

function setStatus(id, text, cls="") {
  $(id).textContent = text;
  $(id).className = "status " + cls;
}

const MAIN_VIEW_IDS = [
  "surveyTypeCard",
  "existingSearchCard",
  "consumerCard",
  "entryCard",
  "newSurveyCard",
  "myCollectionCard",
  "uploadCard",
  "dashboardCard",
  "correctionCard",
  "adminCard"
];

function showMainView(view) {
  MAIN_VIEW_IDS.forEach(id => {
    const el=$(id);
    if (el) el.classList.add("hidden");
  });

  if (view === "home") {
    ["surveyTypeCard","myCollectionCard","uploadCard"].forEach(id => {
      const el=$(id);
      if (el) el.classList.remove("hidden");
    });
  } else if (view) {
    const el=$(view);
    if (el) el.classList.remove("hidden");
  }
}

function showApp() {
  $("loginCard").classList.add("hidden");
  $("appContent").classList.remove("hidden");
  $("loggedUserName").textContent = state.userName || state.userId;

  const showAdmin = state.isAdmin === true || state.userId.toLowerCase() === "admin";
  if (showAdmin) {
    $("adminBtn").classList.remove("hidden");
    $("dashboardBtn").classList.remove("hidden");
    $("correctionBtn").classList.remove("hidden");
  } else {
    $("adminBtn").classList.add("hidden");
    $("dashboardBtn").classList.add("hidden");
    $("correctionBtn").classList.add("hidden");
    $("adminCard").classList.add("hidden");
    $("correctionCard").classList.add("hidden");
    $("dashboardCard").classList.add("hidden");
  }
}

function showLogin() {
  $("loginCard").classList.remove("hidden");
  $("appContent").classList.add("hidden");
  $("loginPassword").value = "";
}

async function checkAuth() {
  const response = await fetch(SERVER_URL, {
    method: "POST",
    headers: {"Content-Type":"text/plain;charset=utf-8"},
    body: JSON.stringify({
      action:"check_auth",
      token:state.sessionToken
    })
  });
  return await response.json();
}

async function serverLogin(userId, password) {
  const response = await fetch(SERVER_URL, {
    method: "POST",
    headers: {"Content-Type": "text/plain;charset=utf-8"},
    body: JSON.stringify({action:"login", user_id:userId, password:password})
  });
  return await response.json();
}

async function login() {
  const userId = $("loginUserId").value.trim();
  const password = $("loginPassword").value;

  if (!userId || !password) {
    return setStatus("loginStatus", "Enter User ID and Password.", "error");
  }

  setStatus("loginStatus", "Checking login...");
  try {
    const result = await serverLogin(userId, password);
    if (!result.success) return setStatus("loginStatus", result.message || "Invalid login.", "error");

    state.sessionToken = result.token;
    state.userId = result.user_id;
    state.userName = result.user_name;
    state.isAdmin = !!result.is_admin;
    localStorage.setItem("consumerMobileIsAdmin", state.isAdmin ? "YES" : "NO");

    localStorage.setItem("consumerMobileAuthToken", state.sessionToken);
    localStorage.setItem("consumerMobileUserId", state.userId);
    localStorage.setItem("consumerMobileUserName", state.userName);

    showApp();
    setMasterGate(!state.masterReady);
    setStatus("loginStatus", "");
    startMasterSetup();
  } catch (e) {
    setStatus("loginStatus", "Login failed. Check internet connection.", "error");
  }
}

function logout() {
  localStorage.removeItem("consumerMobileAuthToken");
  localStorage.removeItem("consumerMobileUserId");
  localStorage.removeItem("consumerMobileUserName");
  localStorage.removeItem("consumerMobileIsAdmin");
  state.sessionToken = "";
  state.userId = "";
  state.userName = "";
  showLogin();
}

async function init() {
  try {
    await openDB();

    const villages = await loadVillagesOfflineFirst();
    const sortedVillages = [...villages].map(v => String(v).trim()).filter(Boolean).sort((a,b) => a.localeCompare(b, undefined, {sensitivity:"base"}));
    for (const selectId of ["village", "newVillage"]) {
      const villageSelect = $(selectId);
      for (const village of sortedVillages) {
        const option = document.createElement("option");
        option.value = village;
        option.textContent = village;
        villageSelect.appendChild(option);
      }
    }

    updateCounts();

    if (state.sessionToken && state.userId) {
      // Restore the saved local session immediately. Server validation runs in
      // the background so the user does not see the login screen on every launch.
      showApp();
      setMasterGate(!state.masterReady);
      startMasterSetup();

      // Restore the locally saved session directly. Do not run check_auth()
      // during startup: the survey app is designed to work offline, and a
      // startup network/auth check could incorrectly throw a valid local
      // session back to the Login screen. Server authentication remains
      // enforced by login() and the protected server requests.
    } else {
      showLogin();
    }
  } catch (e) {
    console.error(e);
    setStatus("searchStatus", e.message || "Could not load app data.", "error");
  }
}


function parseCSVLine(line) {
  const out=[]; let cur=""; let quoted=false;
  for (let i=0;i<line.length;i++) {
    const ch=line[i];
    if (ch==='"') {
      if (quoted && line[i+1]==='"') { cur+='"'; i++; }
      else quoted=!quoted;
    } else if (ch===',' && !quoted) { out.push(cur); cur=""; }
    else cur+=ch;
  }
  out.push(cur);
  return out;
}

function parseMasterCSV(text) {
  const rows=[]; let row=[]; let field=""; let quoted=false;
  for (let i=0;i<text.length;i++) {
    const ch=text[i];
    if (ch==='"') {
      if (quoted && text[i+1]==='"') { field+='"'; i++; }
      else quoted=!quoted;
    } else if (ch===',' && !quoted) { row.push(field); field=""; }
    else if ((ch==='\n' || ch==='\r') && !quoted) {
      if (ch==='\r' && text[i+1]==='\n') i++;
      row.push(field); field="";
      if (row.some(v=>String(v).trim()!=="")) rows.push(row);
      row=[];
    } else field+=ch;
  }
  if (field!=="" || row.length) { row.push(field); if (row.some(v=>String(v).trim()!=="")) rows.push(row); }
  return rows;
}

function csvToConsumer(row, header) {
  // Master-only parser: header names are normalized to lowercase by the
  // import routine, so map every field by its normalized column name.
  const o={};
  for (let i=0;i<header.length;i++) {
    const key=String(header[i] ?? "").trim().toLowerCase();
    o[key]=String(row[i] ?? "").trim();
  }
  const c={
    ACCT_ID:o["acct_id"] || "",
    SDO_CODE:o["sdo_code"] || "",
    NAME:o["name"] || "",
    FATHER_NAME:o["father_name"] || "",
    ADDRESS:o["address"] || "",
    SUPPLY_TYPE:o["supply_type"] || "",
    LOAD:o["load"] || "",
    CONNECTION_STATUS:o["connection status"] || "",
    METER_NO:o["meter no"] || "",
    TOTAL_OUTSTANDING:o["total outstanding"] || "",
    CURRENT_READING:o["current reading"] || ""
  };
  c._acct_norm=String(c.ACCT_ID||"").replace(/\D/g,"");
  c._meter_norm=String(c.METER_NO||"").toUpperCase().replace(/\s+/g,"");
  return c;
}


function updateMasterStatusUI(status, count=0, message="") {
  const badge=$("masterStatusBadge");
  const text=$("masterStatusText");
  const bar=$("masterProgressBar");
  const counter=$("masterStatusCount");
  if (!badge || !text || !bar || !counter) return;

  const total=190081;
  const safeCount=Math.max(0,Math.min(Number(count)||0,total));
  const pct=(safeCount/total)*100;
  bar.style.width=`${pct}%`;
  counter.textContent=`${safeCount.toLocaleString()} / ${total.toLocaleString()}`;

  badge.className="master-badge "+status;
  if(status==="ready"){
    badge.textContent="READY";
    text.textContent="190,081 consumers available offline";
    bar.style.width="100%";
  }else if(status==="error"){
    badge.textContent="ERROR";
    text.textContent=message || "Master data could not be loaded.";
  }else{
    badge.textContent="LOADING";
    text.textContent=message || "Loading consumer master data…";
  }

  const searchBtn=$("searchBtn");
  if(searchBtn) searchBtn.disabled=(status!=="ready");
}


function setMasterGate(locked) {
  if (locked) {
    MAIN_VIEW_IDS.forEach(id => {
      const el=$(id);
      if (el) el.classList.add("hidden");
    });
  } else {
    showMainView("home");
  }

  ["dashboardBtn","correctionBtn","adminBtn","homeBtn"].forEach(id => {
    const el=$(id);
    if (el) el.disabled=locked;
  });

  const logout=$("logoutBtn");
  if (logout) logout.disabled=false;
}

function updateMasterSetupUI(status, count=0, message="", showContinue=false) {
  const card=$("masterSetupCard");
  if (!card) return;
  card.classList.remove("hidden");
  const total=190081;
  const safe=Math.max(0,Math.min(Number(count)||0,total));
  const pct=(safe/total)*100;
  $("masterSetupBar").style.width=`${pct}%`;
  $("masterSetupCount").textContent=`${safe.toLocaleString()} / ${total.toLocaleString()}`;

  const badge=$("masterSetupBadge");
  const text=$("masterSetupText");
  if(status==="ready"){
    badge.textContent="READY";
    badge.className="master-setup-badge ready";
    text.textContent="190,081 consumers loaded successfully. You can now search consumers offline.";
    $("masterSetupContinueBtn").classList.toggle("hidden", !showContinue);
    setMasterGate(false);
  } else if(status==="error"){
    badge.textContent="ERROR";
    badge.className="master-setup-badge error";
    text.textContent=message || "Master data could not be loaded.";
    $("masterSetupContinueBtn").classList.add("hidden");
    setMasterGate(true);
  } else {
    badge.textContent="LOADING";
    badge.className="master-setup-badge loading";
    text.textContent=message || "Consumer master data is being prepared for offline use. Please keep the app open.";
    $("masterSetupContinueBtn").classList.add("hidden");
    setMasterGate(true);
  }
}

function closeMasterSetup() {
  if (!state.masterReady) return;
  $("masterSetupCard").classList.add("hidden");
  setMasterGate(false);
}

async function startMasterSetup() {
  try {
    await openMasterDB();
    updateMasterSetupUI("loading", 0, "Checking local master data…");
    await ensureMasterData();
  } catch(e) {
    console.error(e);
    state.masterReady=false;
    updateMasterSetupUI("error", state.masterCount || 0, e.message || "Master data setup failed.");
  }
}

async function ensureMasterData() {
  const EXPECTED_MASTER_COUNT = 190081;
  const count=await countMasterConsumers();

  if (count === EXPECTED_MASTER_COUNT) {
    const sentinel = await getMasterByIndex("acct_norm", "2782181000");
    const meterSentinel = await getMasterByIndex("meter_norm", "1284984");
    if (sentinel && meterSentinel && String(sentinel.ACCT_ID) === "2782181000") {
      state.masterCount=count;
      state.masterReady=true;
      updateMasterSetupUI("ready", count, "", false);
      closeMasterSetup();
      return;
    }
  }

  state.masterReady=false;
  await clearMasterConsumers();
  updateMasterSetupUI("loading", 0, "Downloading consumer master data…");

  // Versioned URL prevents an old service-worker cache from supplying a stale master file.
  const response=await fetch("consumer-master.csv?v=2", {cache:"no-store"});
  if (!response.ok) throw new Error(`Could not load consumer master file (HTTP ${response.status}).`);

  // 22 MB of source CSV is intentionally kept as text, but records are parsed
  // one-at-a-time. This correctly handles quoted commas AND quoted line breaks.
  const text=await response.text();
  const decoderText=text.replace(/^\uFEFF/,"");
  let record="";
  let inQuotes=false;
  let header=null;
  let total=0;
  const batchSize=500;
  let batch=[];

  async function processRecord(raw) {
    if (!raw.trim()) return;
    const row=parseCSVLine(raw);
    if (!header) {
      header=row.map(x=>String(x).trim().toLowerCase());
      const expected=["acct_id","sdo_code","name","father_name","address","supply_type","load","connection status","meter no","total outstanding","current reading"];
      if (!expected.every(h=>header.includes(h))) {
        throw new Error("Master data columns do not match the approved file.");
      }
      return;
    }

    const c=csvToConsumer(row,header);
    if (!c.ACCT_ID) return;
    batch.push(c);

    if (batch.length>=batchSize) {
      const toWrite=batch;
      batch=[];
      await putMasterBatch(toWrite);
      total+=toWrite.length;
      updateMasterSetupUI("loading", total, "Importing consumer master data…");
      // Yield so the progress display can repaint.
      await new Promise(resolve=>setTimeout(resolve,0));
    }
  }

  // Scan complete CSV records. Newlines inside quoted fields are retained.
  for (let i=0;i<decoderText.length;i++) {
    const ch=decoderText[i];
    if (ch==='"') {
      if (inQuotes && decoderText[i+1]==='"') {
        record+='"'; i++;
      } else {
        inQuotes=!inQuotes;
        record+=ch;
      }
    } else if ((ch==='\n' || ch==='\r') && !inQuotes) {
      await processRecord(record);
      record="";
      if (ch==='\r' && decoderText[i+1]==='\n') i++;
    } else {
      record+=ch;
    }
  }

  if (record.trim()) await processRecord(record);

  if (batch.length) {
    const toWrite=batch;
    batch=[];
    await putMasterBatch(toWrite);
    total+=toWrite.length;
    updateMasterSetupUI("loading", total, "Finalizing consumer master data…");
  }

  state.masterCount=await countMasterConsumers();
  if (state.masterCount !== EXPECTED_MASTER_COUNT) {
    state.masterReady=false;
    throw new Error(`Master data import incomplete (${state.masterCount.toLocaleString()} of ${EXPECTED_MASTER_COUNT.toLocaleString()} consumers).`);
  }

  const verifyAcct=await getMasterByIndex("acct_norm","2782181000");
  const verifyMeter=await getMasterByIndex("meter_norm","1284984");
  if (!verifyAcct || !meterSentinelForRecord(verifyMeter)) {
    state.masterReady=false;
    throw new Error("Master data verification failed.");
  }

  state.masterReady=true;
  updateMasterSetupUI("ready", state.masterCount, "", true);
  setStatus("searchStatus", `${state.masterCount.toLocaleString()} consumers loaded locally. Search is ready.`, "ok");
}

function meterSentinelForRecord(record) {
  return !!record && String(record.METER_NO || "").toUpperCase().replace(/\s+/g,"") === "1284984";
}

function loadVillagesOfflineFirst() {
  const cached=localStorage.getItem("kuthondVillageData");
  if (cached) { try { return Promise.resolve(JSON.parse(cached)); } catch(e) {} }
  return fetch("village-data.json").then(r=>r.json()).then(v=>{
    localStorage.setItem("kuthondVillageData", JSON.stringify(v)); return v;
  });
}

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("ConsumerMobileApp", 4);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains("records")) {
        const store = db.createObjectStore("records", {keyPath:"id", autoIncrement:true});
        store.createIndex("account_id", "account_id", {unique:false});
        store.createIndex("upload_status", "upload_status", {unique:false});
      }
      // IMPORTANT: The existing application database is protected.
      // No master-data store is created, deleted, upgraded, or modified here.
    };
    req.onsuccess = e => { state.db = e.target.result; resolve(); };
    req.onerror = () => reject(req.error);
  });
}

function openMasterDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("KuthondMasterData", 1);
    req.onupgradeneeded = e => {
      const db=e.target.result;
      if (!db.objectStoreNames.contains("masterConsumers")) {
        const master=db.createObjectStore("masterConsumers", {keyPath:"ACCT_ID"});
        master.createIndex("acct_norm", "_acct_norm", {unique:false});
        master.createIndex("meter_norm", "_meter_norm", {unique:false});
      }
    };
    req.onsuccess = e => { state.masterDb=e.target.result; resolve(); };
    req.onerror = () => reject(req.error);
  });
}

function countMasterConsumers() {
  return new Promise((resolve,reject)=>{
    const req=state.masterDb.transaction("masterConsumers","readonly").objectStore("masterConsumers").count();
    req.onsuccess=()=>resolve(req.result); req.onerror=()=>reject(req.error);
  });
}

function clearMasterConsumers() {
  return new Promise((resolve,reject)=>{
    const tx=state.masterDb.transaction("masterConsumers","readwrite");
    tx.objectStore("masterConsumers").clear();
    tx.oncomplete=()=>resolve();
    tx.onerror=()=>reject(tx.error || new Error("Could not reset local master data."));
  });
}

function putMasterBatch(batch) {
  return new Promise((resolve,reject)=>{
    if (!batch.length) return resolve();
    const tx=state.masterDb.transaction("masterConsumers","readwrite");
    const store=tx.objectStore("masterConsumers");
    for (const c of batch) store.put(c);
    tx.oncomplete=()=>resolve(); tx.onerror=()=>reject(tx.error || new Error("Master data storage failed."));
  });
}

function getMasterByIndex(indexName, value) {
  return new Promise((resolve,reject)=>{
    const tx=state.masterDb.transaction("masterConsumers","readonly");
    const req=tx.objectStore("masterConsumers").index(indexName).get(value);
    req.onsuccess=()=>resolve(req.result || null); req.onerror=()=>reject(req.error);
  });
}

async function findLocalDuplicate(accountId) {
  const records = await getAllRecords();
  return records.find(r => String(r.account_id) === String(accountId)) || null;
}

function clearDuplicateWarning() {
  state.duplicateInfo = null;
  $("duplicateWarning").classList.add("hidden");
  $("duplicateWarning").innerHTML = "";
  $("saveBtn").disabled = false;
  $("saveBtn").style.opacity = "1";
}

function showDuplicateWarning(r, source="local") {
  state.duplicateInfo = r;
  $("duplicateWarning").innerHTML =
    `<strong>⚠️ Consumer Already Recorded</strong>
     Account ID: <b>${escapeHtml(r.account_id || "")}</b><br>
     Collected by: <b>${escapeHtml(r.user_name || r.user_id || "Unknown")}</b><br>
     Date: ${escapeHtml(formatDate(r.created_at))}<br>
     Mobile: ${escapeHtml(r.mobile_number || "")}<br>
     Meter Condition: ${escapeHtml(r.meter_condition || "")}`;
  $("duplicateWarning").classList.remove("hidden");
  $("saveBtn").disabled = true;
  $("saveBtn").style.opacity = ".5";
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, ch => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[ch]));
}

function formatDate(value) {
  if (!value) return "";
  const d = new Date(value);
  return isNaN(d.getTime()) ? value : d.toLocaleString();
}


function firstField(obj, names) {
  for (const name of names) {
    if (obj && obj[name] !== undefined && obj[name] !== null && String(obj[name]).trim() !== "") {
      return String(obj[name]).trim();
    }
  }
  return "";
}

function normalizedConsumerValue(c, aliases) {
  const keys=Object.keys(c||{});
  const norm=s=>String(s||"").toLowerCase().replace(/[^a-z0-9]/g,"");
  const wanted=new Set(aliases.map(norm));
  for (const k of keys) {
    if (wanted.has(norm(k))) return c[k];
  }
  return "";
}

function getConsumerConnectionStatus(c) {
  return normalizedConsumerValue(c, [
    "CONNECTION_STATUS","connection status","CONNECTION STATUS",
    "CONNECTIONSTATUS","connection_status"
  ]);
}

function outstandingNumber(value) {
  const n=Number(String(value||"").replace(/,/g,"").replace(/[₹\s]/g,""));
  return Number.isFinite(n) ? n : NaN;
}

function updateOutstandingAlert(value) {
  const alert=$("outstandingAlert");
  if (!alert) return;

  const amount=outstandingNumber(value);

  // No warning when there is no valid positive outstanding.
  if (!Number.isFinite(amount) || amount <= 0) {
    alert.classList.add("hidden");
    alert.innerHTML="";
    return;
  }

  let thresholdLabel="";
  if (amount > 50000) thresholdLabel="₹50,000 से अधिक";
  else if (amount > 20000) thresholdLabel="₹20,000 से अधिक";
  else if (amount > 10000) thresholdLabel="₹10,000 से अधिक";
  else if (amount > 5000) thresholdLabel="₹5,000 से अधिक";
  else if (amount > 1000) thresholdLabel="₹1,000 से अधिक";
  else thresholdLabel="₹1,000 तक";

  const exactAmount=amount.toLocaleString("en-IN",{maximumFractionDigits:2});

  alert.innerHTML =
    '<strong>⚠️ उपभोक्ता को सूचित करें</strong>' +
    '<br>उपभोक्ता का बकाया <b>' + thresholdLabel + '</b> है ' +
    '(वर्तमान बकाया: <b>₹' + exactAmount + '</b>)। ' +
    'कृपया उपभोक्ता को बिल जमा करने हेतु सूचित करें, अन्यथा नियमानुसार विद्युत आपूर्ति विच्छेदित की जा सकती है।';

  alert.classList.remove("hidden");
}

function getConsumerMeterNo(c) {
  return normalizedConsumerValue(c, [
    "METER_NO","meter no","meter no.","METER NUMBER","METER_NUMBER"
  ]);
}

function getConsumerReading(c) {
  return firstField(c, ["CURRENT_READING","CURRENTREADING","READING","METER_READING","CURRENT_METER_READING"]);
}

function getConsumerOutstanding(c) {
  return normalizedConsumerValue(c, [
    "TOTAL_OUTSTANDING","total outstanding","total outstanding ",
    "TOTAL OUTSTANDING ","OUTSTANDING","OUTSTANDING_AMOUNT"
  ]);
}

function displayOrUnavailable(value) {
  return value || "Not available in consumer data";
}

function resetExistingForm() {
  const alert=$("outstandingAlert");
  if (alert) alert.classList.add("hidden");
  $("village").value="";
  $("meterCondition").value="";
  $("acInstalled").value="";
  $("mobile").value="";
  $("existingRemarks").value="";
  $("houseLocked").checked=false;
  $("mobileRefused").checked=false;
  $("mobile").disabled=false;
  $("saveBtn").disabled=false;
  $("saveBtn").style.opacity="1";
  clearDuplicateWarning();
}

function closeAllSurveyForms() {
  $("existingSearchCard").classList.add("hidden");
  $("consumerCard").classList.add("hidden");
  $("entryCard").classList.add("hidden");
  $("newSurveyCard").classList.add("hidden");
  showMainView("home");
  $("searchStatus").textContent="";
  $("newSaveStatus").textContent="";
  state.current=null;
  resetExistingForm();
  resetNewSurveyForm();
}

function goHome() {
  closeConfirmation();
  closeAllSurveyForms();
  showMainView("home");
  window.scrollTo({top:0, behavior:"smooth"});
}

function showExistingSurvey() {
  showMainView("existingSearchCard");
  $("accountId").value="";
  $("searchStatus").textContent="";
  $("accountId").focus();
}

function showNewSurvey() {
  showMainView("newSurveyCard");
  $("newSaveStatus").textContent="";
  $("newConnectionType").focus();
}

function updateExistingSpecialOptions() {
  const locked=$("houseLocked").checked;
  const refused=$("mobileRefused").checked;

  if (locked) {
    $("mobileRefused").checked=false;
    $("mobileRefused").disabled=true;
    $("mobile").value="";
    $("mobile").disabled=true;
  } else {
    $("mobileRefused").disabled=false;
    $("mobile").disabled=refused;
  }

  if (refused) {
    $("houseLocked").checked=false;
    $("houseLocked").disabled=true;
    $("mobile").value="";
    $("mobile").disabled=true;
  } else {
    $("houseLocked").disabled=false;
    if (!locked) $("mobile").disabled=false;
  }
}

function surveyStatusForExisting() {
  if ($("houseLocked").checked) return "HOUSE LOCKED";
  if ($("mobileRefused").checked) return "MOBILE REFUSED";
  return "CONSUMER FOUND";
}

function makeConfirmationDetails(items) {
  return items.map(([label,value]) =>
    `<div><b>${escapeHtml(label)}:</b> ${escapeHtml(value || "—")}</div>`
  ).join("");
}

function openConfirmation(title, items, callback) {
  $("confirmTitle").textContent=title;
  $("confirmDetails").innerHTML=makeConfirmationDetails(items);
  $("confirmModal").classList.remove("hidden");
  state.pendingConfirmation=callback;
}

function closeConfirmation() {
  $("confirmModal").classList.add("hidden");
  state.pendingConfirmation=null;
}


async function searchConsumer() {
  updateOutstandingAlert("");

  if (!state.sessionToken) return showLogin();
  if (!state.masterReady) return setStatus("searchStatus", "Master data is still loading. Please wait until it finishes.", "error");

  const searchType=$("searchType").value;
  const rawValue=$("accountId").value.trim();
  if (!rawValue) return setStatus("searchStatus", "Enter a search value.", "error");

  let c=null;

  try {
    if (searchType==="ACCOUNT") {
      const normalized=rawValue.replace(/\D/g,"");
      c=await getMasterByIndex("acct_norm", normalized);
    } else {
      const normalized=rawValue.toUpperCase().replace(/\s+/g,"");
      c=await getMasterByIndex("meter_norm", normalized);
      if (!c) {
        return setStatus("searchStatus",
          "Meter number was not found in the local consumer data.",
          "error");
      }
    }
  } catch (e) {
    return setStatus("searchStatus", "Local master data is not available. Please reopen the app.", "error");
  }

  if (!c) {
    state.current=null;
    $("consumerCard").classList.add("hidden");
    $("entryCard").classList.add("hidden");
    return setStatus("searchStatus",
      "Consumer not found. Make sure the Account ID is exactly as shown in the source data.",
      "error");
  }

  clearDuplicateWarning();
  state.current=c;

  $("dAcct").textContent=c.ACCT_ID || "";
  $("dName").textContent=c.NAME || "";
  $("dFather").textContent=c.FATHER_NAME || "";
  $("dAddress").textContent=c.ADDRESS || "";
  $("dSupply").textContent=c.SUPPLY_TYPE || "";
  $("dLoad").textContent=c.LOAD || "";
  $("dSdo").textContent=c.SDO_CODE || "";
  $("dConnectionStatus").textContent=displayOrUnavailable(getConsumerConnectionStatus(c));
  $("dMeterNo").textContent=displayOrUnavailable(getConsumerMeterNo(c));
  $("dCurrentReading").textContent=displayOrUnavailable(getConsumerReading(c));
  $("dOutstanding").textContent=displayOrUnavailable(getConsumerOutstanding(c));

  showMainView("consumerCard");
  $("existingSearchCard").classList.remove("hidden");
  $("entryCard").classList.remove("hidden");
  resetExistingForm();
  updateOutstandingAlert(getConsumerOutstanding(c));

  const localDuplicate=await findLocalDuplicate(c.ACCT_ID);
  if (localDuplicate) {
    showDuplicateWarning(localDuplicate,"local");
    setStatus("searchStatus","This consumer is already recorded on this phone.","error");
    return;
  }

  setStatus("searchStatus","Consumer found. Verify the details.","ok");
}

async function prepareExistingSave() {
  if (!state.current) return;
  if (state.duplicateInfo) return;

  const localDuplicate=await findLocalDuplicate(state.current.ACCT_ID);
  if (localDuplicate) {
    showDuplicateWarning(localDuplicate,"local");
    return;
  }

  const village=$("village").value;
  const meterCondition=$("meterCondition").value;
  const acInstalled=$("acInstalled").value;
  const mobile=$("mobile").value.replace(/\D/g,"");
  const remarks=$("existingRemarks").value.trim();
  const locked=$("houseLocked").checked;
  const refused=$("mobileRefused").checked;
  const status=surveyStatusForExisting();

  if (!village) return setStatus("saveStatus","Select village.","error");
  if (!meterCondition) return setStatus("saveStatus","Select meter condition.","error");
  if (!acInstalled) return setStatus("saveStatus","Select AC Installed: YES or NO.","error");
  if (!locked && !refused && !/^\d{10}$/.test(mobile)) {
    return setStatus("saveStatus","Enter a valid 10 digit mobile number.","error");
  }

  const record={
    survey_type:"EXISTING CONSUMER",
    survey_status:status,
    user_id:state.userId,
    user_name:state.userName,
    account_id:state.current.ACCT_ID,
    consumer_name:state.current.NAME,
    father_name:state.current.FATHER_NAME,
    address:state.current.ADDRESS,
    supply_type:state.current.SUPPLY_TYPE,
    load:state.current.LOAD,
    sdo_code:state.current.SDO_CODE,
    village,
    meter_condition:meterCondition,
    ac_installed:acInstalled,
    mobile_number:mobile,
    meter_number:getConsumerMeterNo(state.current),
    current_reading:getConsumerReading(state.current),
    outstanding:getConsumerOutstanding(state.current),
    connection_type:"",
    meter_installed:"",
    connected_load:"",
    remarks,
    mobile_refused:refused ? "YES" : "NO",
    house_locked:locked ? "YES" : "NO",
    created_at:new Date().toISOString(),
    upload_status:"PENDING"
  };

  openConfirmation(
    "Confirm Existing Consumer Survey",
    [
      ["Account ID",record.account_id],
      ["Consumer",record.consumer_name],
      ["Village",record.village],
      ["Meter Number",record.meter_number || "Not available"],
      ["Current Reading",record.current_reading || "Not available"],
      ["Outstanding",record.outstanding || "Not available"],
      ["Meter Condition",record.meter_condition],
      ["AC Installed",record.ac_installed],
      ["Mobile",locked ? "Not collected - House Locked" :
                         refused ? "Not provided - Consumer Refused" : record.mobile_number],
      ["Survey Status",record.survey_status],
      ["Remarks",record.remarks || "—"]
    ],
    ()=>saveLocalRecord(record,"saveStatus")
  );
}

function saveLocalRecord(record,statusId) {
  return new Promise((resolve)=>{
    const tx=state.db.transaction("records","readwrite");
    tx.objectStore("records").add(record);
    tx.oncomplete=()=>{
      closeConfirmation();

      // Clear the completed form immediately so the next survey starts fresh.
      if (record.survey_type === "EXISTING CONSUMER") {
        $("consumerCard").classList.add("hidden");
        $("entryCard").classList.add("hidden");
        $("existingSearchCard").classList.remove("hidden");
        $("accountId").value = "";
        $("searchStatus").textContent = "";
        resetExistingForm();
      } else {
        resetNewSurveyForm();
      }

      setStatus(statusId,"Survey saved locally. Ready for the next entry.","ok");
      updateCounts();
      resolve(true);
    };
    tx.onerror=()=>{
      setStatus(statusId,"Could not save survey.","error");
      closeConfirmation();
      resolve(false);
    };
  });
}

function resetNewSurveyForm() {
  [
    "newConnectionType","newName","newFather","newVillage","newAddress",
    "newMobile","newMeterInstalled","newMeterNo","newCurrentReading",
    "newMeterCondition","newConnectedLoad","newAcInstalled","newRemarks"
  ].forEach(id=>{
    const el=$(id);
    if (el.tagName==="SELECT") el.value="";
    else el.value="";
  });
  $("newMeterNo").disabled=false;
  $("newCurrentReading").disabled=false;
}

function updateNewMeterFields() {
  const installed=$("newMeterInstalled").value;
  const no=installed==="NO";
  $("newMeterNo").disabled=no;
  $("newCurrentReading").disabled=no;
  if (no) {
    $("newMeterNo").value="";
    $("newCurrentReading").value="";
    if (!$("newMeterCondition").value) $("newMeterCondition").value="NOT INSTALLED";
  }
}

function makeSurveyId() {
  const d=new Date();
  const date=d.getFullYear()+String(d.getMonth()+1).padStart(2,"0")+String(d.getDate()).padStart(2,"0");
  return "SURV-"+date+"-"+Date.now()+"-"+Math.floor(Math.random()*1000);
}

async function prepareNewSave() {
  const connectionType=$("newConnectionType").value;
  const name=$("newName").value.trim();
  const father=$("newFather").value.trim();
  const village=$("newVillage").value;
  const address=$("newAddress").value.trim();
  const mobile=$("newMobile").value.replace(/\D/g,"");
  const installed=$("newMeterInstalled").value;
  const meterNo=$("newMeterNo").value.trim();
  const reading=$("newCurrentReading").value.trim();
  const meterCondition=$("newMeterCondition").value;
  const connectedLoad=$("newConnectedLoad").value.trim();
  const ac=$("newAcInstalled").value;
  const remarks=$("newRemarks").value.trim();

  if (!connectionType) return setStatus("newSaveStatus","Select connection status.","error");
  if (!name) return setStatus("newSaveStatus","Enter consumer/occupant name.","error");
  if (!village) return setStatus("newSaveStatus","Select village.","error");
  if (!address) return setStatus("newSaveStatus","Enter complete address.","error");
  if (mobile && !/^\d{10}$/.test(mobile)) {
    return setStatus("newSaveStatus","Enter a valid 10 digit mobile number.","error");
  }
  if (!installed) return setStatus("newSaveStatus","Select Meter Installed.","error");
  if (installed==="YES" && !meterNo) return setStatus("newSaveStatus","Enter meter number.","error");
  if (installed==="YES" && !reading) return setStatus("newSaveStatus","Enter current reading.","error");
  if (!meterCondition) return setStatus("newSaveStatus","Select meter condition.","error");
  if (!ac) return setStatus("newSaveStatus","Select AC Installed.","error");

  const surveyId=makeSurveyId();
  const record={
    survey_type:"CONNECTION NOT IN DATABASE",
    survey_status:"NEW SITE FINDING",
    connection_type:connectionType,
    survey_id:surveyId,
    user_id:state.userId,
    user_name:state.userName,
    account_id:"",
    consumer_name:name,
    father_name:father,
    address,
    supply_type:"",
    load:"",
    sdo_code:"",
    village,
    meter_condition:meterCondition,
    ac_installed:ac,
    mobile_number:mobile,
    meter_installed:installed,
    meter_number:meterNo,
    current_reading:reading,
    connected_load:connectedLoad,
    outstanding:"",
    remarks,
    mobile_refused:"NO",
    house_locked:"NO",
    created_at:new Date().toISOString(),
    upload_status:"PENDING"
  };

  openConfirmation(
    "Confirm New Site Survey",
    [
      ["Survey ID",record.survey_id],
      ["Connection Status",record.connection_type],
      ["Name",record.consumer_name],
      ["Village",record.village],
      ["Address",record.address],
      ["Mobile",record.mobile_number || "Not provided"],
      ["Meter Installed",record.meter_installed],
      ["Meter Number",record.meter_number || "Not applicable"],
      ["Current Reading",record.current_reading || "Not applicable"],
      ["Meter Condition",record.meter_condition],
      ["Connected Load",record.connected_load || "—"],
      ["AC Installed",record.ac_installed],
      ["Remarks",record.remarks || "—"]
    ],
    ()=>saveLocalRecord(record,"newSaveStatus")
  );
}

function getAllRecords() {
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction("records", "readonly");
    const req = tx.objectStore("records").getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function updateRecordStatus(ids, status) {
  return new Promise((resolve, reject) => {
    if (!ids.length) return resolve();
    const tx = state.db.transaction("records", "readwrite");
    const store = tx.objectStore("records");
    for (const id of ids) {
      const req = store.get(id);
      req.onsuccess = () => {
        const r = req.result;
        if (r) { r.upload_status = status; store.put(r); }
      };
    }
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function uploadPending() {
  if (!state.sessionToken) return showLogin();

  const records = await getAllRecords();
  const pending = records.filter(r => r.upload_status === "PENDING");

  if (!pending.length) {
    return setStatus("uploadStatus", "No pending records to upload.", "ok");
  }

  setStatus("uploadStatus", `Uploading ${pending.length.toLocaleString()} records...`);
  const batchSize = 50;
  let uploaded = 0;

  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize);

    try {
      const response = await fetch(SERVER_URL, {
        method: "POST",
        headers: {"Content-Type": "text/plain;charset=utf-8"},
        body: JSON.stringify({
          action:"upload",
          token:state.sessionToken,
          records:batch
        })
      });

      const result = await response.json();

      if (!result.success) {
        if (result.code === "AUTH") {
          logout();
          alert("Your login session has expired. Please login again.");
          return;
        }
        throw new Error(result.message || "Server rejected upload.");
      }

      await updateRecordStatus(batch.map(r => r.id), "UPLOADED");
      uploaded += batch.length;
      setStatus("uploadStatus", `Uploaded ${uploaded.toLocaleString()} / ${pending.length.toLocaleString()}...`, "ok");
    } catch (e) {
      setStatus("uploadStatus", `Upload stopped after ${uploaded.toLocaleString()} records. Remaining records are still pending.`, "error");
      await updateCounts();
      return;
    }
  }

  await updateCounts();
  setStatus("uploadStatus", `Upload complete. ${uploaded.toLocaleString()} records uploaded.`, "ok");
}


async function syncUploadStatus() {
  if (!state.sessionToken) return showLogin();

  const records = await getAllRecords();
  if (!records.length) {
    return setStatus("syncStatus","No local survey records to check.","ok");
  }

  const batchSize = 250;
  let checked = 0;
  let restored = 0;
  let confirmed = 0;

  setStatus("syncStatus",`Checking ${records.length.toLocaleString()} local records on server...`);

  for (let i=0; i<records.length; i+=batchSize) {
    const batch = records.slice(i,i+batchSize);

    try {
      const response = await fetch(SERVER_URL,{
        method:"POST",
        headers:{"Content-Type":"text/plain;charset=utf-8"},
        body:JSON.stringify({
          action:"sync_upload_status",
          token:state.sessionToken,
          records:batch.map(r=>({
            user_id:r.user_id || state.userId || "",
            account_id:r.account_id || "",
            survey_id:r.survey_id || "",
            survey_type:r.survey_type || "EXISTING CONSUMER"
          }))
        })
      });

      const raw=await response.text();
      let result;
      try {
        result=JSON.parse(raw);
      } catch(e) {
        throw new Error("Server returned an invalid response. Check the Apps Script deployment/version.");
      }

      if (!result.success) {
        if (result.code==="AUTH") {
          alert("Your login session is invalid. Please login again.");
          logout();
          return;
        }
        throw new Error(result.message || "Status check failed.");
      }

      const present=new Set((result.present_keys||[]).map(String));

      for (const r of batch) {
        const key=uploadStatusKey(r);
        const exists=present.has(key);

        if (exists) {
          if (r.upload_status !== "UPLOADED") {
            await setOneRecordStatus(r.id,"UPLOADED");
            confirmed++;
          }
        } else if (r.upload_status === "UPLOADED") {
          await setOneRecordStatus(r.id,"PENDING");
          restored++;
        }
      }

      checked += batch.length;
      setStatus(
        "syncStatus",
        `Checked ${checked.toLocaleString()} / ${records.length.toLocaleString()}...`
      );

    } catch(e) {
      setStatus(
        "syncStatus",
        `Status check failed after ${checked.toLocaleString()} records: ${e.message}`,
        "error"
      );
      return;
    }
  }

  await updateCounts();

  if (restored) {
    setStatus(
      "syncStatus",
      `Status sync complete. ${restored} record(s) were not found on the server and are now Pending Upload.`,
      "error"
    );
  } else if (confirmed) {
    setStatus(
      "syncStatus",
      `Status sync complete. ${confirmed} record(s) confirmed on the server.`,
      "ok"
    );
  } else {
    setStatus(
      "syncStatus",
      `Status sync complete. All ${records.length.toLocaleString()} local record(s) match the server.`,
      "ok"
    );
  }
}

function uploadStatusKey(r) {
  const user=String(r.user_id || state.userId || "").trim().toLowerCase();

  if (String(r.survey_type || "").trim().toUpperCase()==="CONNECTION NOT IN DATABASE") {
    return user+"|SURVEY|"+String(r.survey_id || "").trim();
  }

  return user+"|ACCOUNT|"+String(r.account_id || "").trim();
}


function setOneRecordStatus(id,status) {
  return new Promise(resolve=>{
    const tx=state.db.transaction("records","readwrite");
    const store=tx.objectStore("records");
    const req=store.get(id);
    req.onsuccess=()=>{
      const record=req.result;
      if (!record) return;
      record.upload_status=status;
      store.put(record);
    };
    tx.oncomplete=()=>resolve(true);
    tx.onerror=()=>resolve(false);
  });
}



/* V15.1.1 NEW FEATURE ONLY: India time display.
   Device clock remains the source. We format the captured instant explicitly in IST. */
function v1511ISTDateTime(value) {
  const d=value ? new Date(value) : new Date();
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-IN", {
    timeZone:"Asia/Kolkata",
    day:"2-digit", month:"2-digit", year:"numeric",
    hour:"2-digit", minute:"2-digit", second:"2-digit",
    hour12:false
  }).format(d).replace(",", "");
}

/* V15.1 NEW FEATURE ONLY: My Collection. Existing functions are untouched. */
function v151LocalDateKey(value) {
  const d=value ? new Date(value) : new Date();
  if (Number.isNaN(d.getTime())) return "";
  return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");
}
async function v151RefreshMyCollection() {
  const records=await getAllRecords();
  const today=v151LocalDateKey(new Date());
  const todayRecords=records.filter(r=>v151LocalDateKey(r.created_at)===today);
  const isNew=r=>String(r.survey_type||"").toUpperCase()==="CONNECTION NOT IN DATABASE";
  const existingToday=todayRecords.filter(r=>!isNew(r));
  const newToday=todayRecords.filter(r=>isNew(r));
  const existingTotal=records.filter(r=>!isNew(r));
  const newTotal=records.filter(r=>isNew(r));
  const pendingTotal=records.filter(r=>String(r.upload_status||"PENDING").toUpperCase()!=="UPLOADED");
  $("todayExistingCount").textContent=existingToday.length.toLocaleString("en-IN");
  $("todayNewCount").textContent=newToday.length.toLocaleString("en-IN");
  $("todayTotalCount").textContent=todayRecords.length.toLocaleString("en-IN");
  $("todayPendingCount").textContent=pendingTotal.length.toLocaleString("en-IN");
  $("collectionDateLabel").textContent=new Intl.DateTimeFormat("en-IN",{timeZone:"Asia/Kolkata",day:"2-digit",month:"short",year:"numeric"}).format(new Date());
  $("personalCollectionSummary").innerHTML=
    '<div class="personal-summary-row"><span>Existing Consumer</span><b>'+existingTotal.length.toLocaleString("en-IN")+'</b></div>'+
    '<div class="personal-summary-row"><span>Not in Data</span><b>'+newTotal.length.toLocaleString("en-IN")+'</b></div>'+
    '<div class="personal-summary-row total"><span>Total Surveyed</span><b>'+records.length.toLocaleString("en-IN")+'</b></div>'+
    '<div class="personal-summary-row pending"><span>Pending Upload</span><b>'+pendingTotal.length.toLocaleString("en-IN")+'</b></div>';
}
function v151InitMyCollection() {
  const btn=$("refreshCollectionBtn");
  if(btn) btn.addEventListener("click",v151RefreshMyCollection);
  v151RefreshMyCollection();
}

async function updateCounts() {
  if (!state.db) return;
  const records = await getAllRecords();
  $("savedCount").textContent = records.length.toLocaleString();
  $("pendingCount").textContent = records.filter(r => r.upload_status === "PENDING").length.toLocaleString();
}

async function exportData() {
  const records = await getAllRecords();
  if (!records.length) return alert("No locally saved records.");

  const headers = ["Survey Type","Survey Status","Connection Type","Survey ID","User ID","User Name","Account ID","Consumer Name","Father/Husband","Address","Supply Type","Load","SDO Code","Village","Meter Condition","AC Installed","Mobile Number","House Locked","Mobile Refused","Meter Installed","Meter Number","Current Reading","Outstanding","Connected Load","Remarks","Created At","Upload Status"];
  const rows = records.map(r => [r.survey_type,r.survey_status,r.connection_type,r.survey_id,r.user_id,r.user_name,r.account_id,r.consumer_name,r.father_name,r.address,r.supply_type,r.load,r.sdo_code,r.village,r.meter_condition,r.ac_installed,r.mobile_number,r.house_locked,r.mobile_refused,r.meter_installed,r.meter_number,r.current_reading,r.outstanding,r.connected_load,r.remarks,r.created_at,r.upload_status]);
  const csv = [headers,...rows].map(row => row.map(v => `"${String(v ?? "").replaceAll('"','""')}"`).join(",")).join("\n");

  const blob = new Blob(["\ufeff"+csv], {type:"text/csv;charset=utf-8"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "mobile_collection_data.csv"; a.click();
  URL.revokeObjectURL(url);
}




async function loadDashboardFilters() {
  try {
    const result = await adminRequest("dashboard_filters");
    if (!result.success) return;

    const userSelect = $("dashUserFilter");
    const villageSelect = $("dashVillageFilter");

    userSelect.innerHTML = '<option value="">All Users</option>';
    villageSelect.innerHTML = '<option value="">All Villages</option>';

    for (const u of result.users) {
      userSelect.insertAdjacentHTML("beforeend",
        `<option value="${escapeHtml(u.user_id)}">${escapeHtml(u.user_name)} (${escapeHtml(u.user_id)})</option>`);
    }
    for (const v of result.villages) {
      villageSelect.insertAdjacentHTML("beforeend",
        `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`);
    }
  } catch(e) {}
}



let correctionRecord = null;

async function loadCorrectionVillages() {
  const select = $("corrVillage");
  if (select.options.length > 1) return;

  try {
    const response = await fetch("village-data.json");
    const villages = await response.json();
    for (const village of villages) {
      const option = document.createElement("option");
      option.value = village;
      option.textContent = village;
      select.appendChild(option);
    }
  } catch(e) {}
}

function clearCorrectionForm() {
  correctionRecord = null;
  $("correctionResult").classList.add("hidden");
  $("correctionSearchStatus").textContent = "";
  $("correctionStatus").textContent = "";
  $("correctionAccountId").value = "";
  $("corrConsumerName").textContent = "";
  $("corrAccount").textContent = "";
  $("corrOriginalUser").textContent = "";
  $("corrOriginalDate").textContent = "";
  $("corrVillage").value = "";
  $("corrMeterCondition").value = "";
  $("corrAcInstalled").value = "";
  $("corrMobile").value = "";
}

async function openCorrection() {
  if (!state.isAdmin && state.userId.toLowerCase() !== "admin") return;
  showMainView("correctionCard");
  await loadCorrectionVillages();
  $("correctionAccountId").focus();
}

async function findCorrectionRecord() {
  const accountId = $("correctionAccountId").value.trim();
  if (!accountId) {
    return setStatus("correctionSearchStatus","Enter Account ID.","error");
  }

  setStatus("correctionSearchStatus","Searching...");
  $("correctionResult").classList.add("hidden");
  correctionRecord = null;

  try {
    const result = await adminRequest("get_record", {account_id:accountId});

    if (!result.success) {
      return setStatus("correctionSearchStatus",result.message || "Could not search record.","error");
    }

    if (!result.found) {
      return setStatus("correctionSearchStatus","No uploaded record found for this Account ID.","error");
    }

    correctionRecord = result.record;

    $("corrConsumerName").textContent = correctionRecord.consumer_name || "";
    $("corrAccount").textContent = correctionRecord.account_id || "";
    $("corrOriginalUser").textContent =
      `${correctionRecord.user_name || correctionRecord.user_id || "Unknown"}`;
    $("corrOriginalDate").textContent = formatDate(correctionRecord.created_at);

    $("corrVillage").value = correctionRecord.village || "";
    $("corrMeterCondition").value = correctionRecord.meter_condition || "";
    $("corrAcInstalled").value = correctionRecord.ac_installed || "";
    $("corrMobile").value = correctionRecord.mobile_number || "";

    $("correctionResult").classList.remove("hidden");
    setStatus("correctionSearchStatus","Record found. You may correct the fields below.","ok");
  } catch(e) {
    setStatus("correctionSearchStatus","Could not connect to server.","error");
  }
}

async function saveCorrection() {
  if (!correctionRecord) return;

  const village=$("corrVillage").value;
  const meter=$("corrMeterCondition").value;
  const ac=$("corrAcInstalled").value;
  const mobile=$("corrMobile").value.replace(/\D/g,"");

  if (!village) return setStatus("correctionStatus","Select village.","error");
  if (!meter) return setStatus("correctionStatus","Select meter condition.","error");
  if (!ac) return setStatus("correctionStatus","Select AC Installed: YES or NO.","error");
  if (!/^\d{10}$/.test(mobile)) {
    return setStatus("correctionStatus","Enter a valid 10 digit mobile number.","error");
  }

  setStatus("correctionStatus","Saving correction...");

  try {
    const result=await adminRequest("update_record",{
      account_id:correctionRecord.account_id,
      village:village,
      meter_condition:meter,
      ac_installed:ac,
      mobile_number:mobile
    });

    if (!result.success) {
      return setStatus("correctionStatus",result.message || "Could not update record.","error");
    }

    correctionRecord=result.record;
    setStatus(
      "correctionStatus",
      `Correction saved. Updated by ${result.updated_by} at ${formatDate(result.updated_at)}.`,
      "ok"
    );
  } catch(e) {
    setStatus("correctionStatus","Could not connect to server.","error");
  }
}

async function exportFilteredReport() {
  if (!state.isAdmin && state.userId.toLowerCase() !== "admin") return;

  setStatus("exportStatus", "Preparing report...");
  try {
    const result = await adminRequest("export_report", {
      from_date: $("dashFromDate").value,
      to_date: $("dashToDate").value,
      user_id: $("dashUserFilter").value,
      village: $("dashVillageFilter").value
    });

    if (!result.success) {
      return setStatus("exportStatus", result.message || "Could not create report.", "error");
    }

    if (!result.rows.length) {
      return setStatus("exportStatus", "No records match the selected filters.", "error");
    }

    const headers = [
      "User ID","User Name","Account ID","Consumer Name","Father/Husband",
      "Address","Supply Type","Load","SDO Code","Village","Meter Condition",
      "AC Installed","Mobile Number","Created At"
    ];

    const csvRows = [headers].concat(result.rows.map(r => [
      r.user_id,r.user_name,r.account_id,r.consumer_name,r.father_name,
      r.address,r.supply_type,r.load,r.sdo_code,r.village,r.meter_condition,
      r.ac_installed,r.mobile_number,r.created_at
    ]));

    const csv = csvRows.map(row =>
      row.map(v => `"${String(v ?? "").replaceAll('"','""')}"`).join(",")
    ).join("\n");

    const blob = new Blob(["\ufeff" + csv], {type:"text/csv;charset=utf-8"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;

    const from = $("dashFromDate").value || "all";
    const to = $("dashToDate").value || "all";
    a.download = `consumer_report_${from}_to_${to}.csv`;

    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);

    setStatus("exportStatus", `${result.rows.length.toLocaleString()} records exported successfully.`, "ok");
  } catch(e) {
    setStatus("exportStatus", "Could not connect to server.", "error");
  }
}


function setDashboardToday() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth()+1).padStart(2,"0");
  const dd = String(now.getDate()).padStart(2,"0");
  const today = `${yyyy}-${mm}-${dd}`;

  $("dashFromDate").value = today;
  $("dashToDate").value = today;
  $("dashUserFilter").value = "";
  $("dashVillageFilter").value = "";

  loadDashboard();
}

async function openDashboard() {
  if (!state.isAdmin) return;
  showMainView("dashboardCard");
  await loadDashboardFilters();
  await loadDashboard();
}

function renderReport(id, items) {
  if (!items.length) {
    $(id).innerHTML = '<div class="status">No data available.</div>';
    return;
  }
  let html = '<div class="report-row report-head"><div>Name</div><div>Count</div></div>';
  for (const x of items) {
    html += `<div class="report-row"><div>${escapeHtml(x.name)}</div><div>${Number(x.count).toLocaleString()}</div></div>`;
  }
  $(id).innerHTML = html;
}

async function loadDashboard() {
  $("dashTotal").textContent="...";
  $("dashUsers").textContent="...";
  $("dashVillages").textContent="...";
  $("sumTotal").textContent="...";
  $("sumMeterOk").textContent="...";
  $("sumMeterDamaged").textContent="...";
  $("sumMeterNI").textContent="...";
  $("sumAcYes").textContent="...";
  $("sumAcNo").textContent="...";

  try {
    const result = await adminRequest("dashboard", {
      from_date: $("dashFromDate").value,
      to_date: $("dashToDate").value,
      user_id: $("dashUserFilter").value,
      village: $("dashVillageFilter").value
    });

    if (!result.success) {
      $("userReport").textContent=result.message || "Could not load dashboard.";
      return;
    }

    $("dashTotal").textContent=Number(result.total).toLocaleString();
    $("dashUsers").textContent=Number(result.user_count).toLocaleString();
    $("dashVillages").textContent=Number(result.village_count).toLocaleString();

    $("sumTotal").textContent=Number(result.total).toLocaleString();

    const meterCounts={};
    for (const x of (result.meter_condition||[])) {
      meterCounts[String(x.name||"").trim().toUpperCase()]=Number(x.count)||0;
    }
    const acCounts={};
    for (const x of (result.ac_installed||[])) {
      acCounts[String(x.name||"").trim().toUpperCase()]=Number(x.count)||0;
    }

    $("sumMeterOk").textContent=(meterCounts["OK"]||0).toLocaleString();
    $("sumMeterDamaged").textContent=(meterCounts["DAMAGED"]||0).toLocaleString();
    $("sumMeterNI").textContent=(meterCounts["NOT INSTALLED"]||0).toLocaleString();
    $("sumAcYes").textContent=(acCounts["YES"]||0).toLocaleString();
    $("sumAcNo").textContent=(acCounts["NO"]||0).toLocaleString();

    renderReport("userReport",result.user_wise);
    renderReport("villageReport",result.village_wise);
    renderReport("meterReport",result.meter_condition);
    renderReport("acReport",result.ac_installed);
  } catch(e) {
    $("userReport").textContent="Could not connect to server.";
  }
}

async function adminRequest(action, extra={}) {
  const response = await fetch(SERVER_URL, {
    method: "POST",
    headers: {"Content-Type":"text/plain;charset=utf-8"},
    body: JSON.stringify(Object.assign({
      action,
      token: state.sessionToken
    }, extra))
  });
  return await response.json();
}

async function openAdmin() {
  if (!state.isAdmin) return;
  showMainView("adminCard");
  await loadUsers();
}

async function loadUsers() {
  $("usersTable").textContent = "Loading...";
  try {
    const result = await adminRequest("list_users");
    if (!result.success) {
      $("usersTable").textContent = result.message || "Could not load users.";
      return;
    }

    const rows = [
      `<div class="user-row user-head"><div>User ID</div><div>Name</div><div>Status</div><div>Action</div></div>`
    ];

    for (const u of result.users) {
      const action = u.active === "YES"
        ? `<button class="small-btn danger-btn" onclick="toggleUser('${escapeHtml(u.user_id)}','NO')">DISABLE</button>`
        : `<button class="small-btn" onclick="toggleUser('${escapeHtml(u.user_id)}','YES')">ENABLE</button>`;
      rows.push(
        `<div class="user-row"><div>${escapeHtml(u.user_id)}</div><div>${escapeHtml(u.user_name)}</div><div>${escapeHtml(u.active)}</div><div>${action}</div></div>`
      );
    }
    $("usersTable").innerHTML = rows.join("");
  } catch (e) {
    $("usersTable").textContent = "Could not connect to server.";
  }
}

async function createUser() {
  if (!state.isAdmin) return;

  const userId = $("newUserId").value.trim();
  const userName = $("newUserName").value.trim();
  const password = $("newUserPassword").value;

  if (!userId || !userName || !password) {
    return setStatus("adminStatus", "Enter User ID, User Name and Password.", "error");
  }

  setStatus("adminStatus", "Creating user...");
  const result = await adminRequest("create_user", {
    user_id:userId,
    user_name:userName,
    password:password
  });

  if (!result.success) return setStatus("adminStatus", result.message || "Could not create user.", "error");

  $("newUserId").value = "";
  $("newUserName").value = "";
  $("newUserPassword").value = "";
  setStatus("adminStatus", "User created successfully.", "ok");
  await loadUsers();
}

async function toggleUser(userId, active) {
  if (!state.isAdmin) return;

  const result = await adminRequest("set_user_active", {
    user_id:userId,
    active
  });

  if (!result.success) {
    alert(result.message || "Could not update user.");
    return;
  }

  await loadUsers();
}


$("homeBtn").addEventListener("click", goHome);
$("existingSurveyBtn").addEventListener("click", showExistingSurvey);
$("newSurveyBtn").addEventListener("click", showNewSurvey);
$("searchType").addEventListener("change", ()=>{
  $("accountId").placeholder=$("searchType").value==="METER" ? "Enter meter number" : "Enter account ID";
});
$("saveBtn").addEventListener("click", prepareExistingSave);
$("saveNewBtn").addEventListener("click", prepareNewSave);
$("houseLocked").addEventListener("change", updateExistingSpecialOptions);
$("mobileRefused").addEventListener("change", updateExistingSpecialOptions);
$("newMeterInstalled").addEventListener("change", updateNewMeterFields);
$("backToSurveyTypeBtn").addEventListener("click", closeAllSurveyForms);
$("backFromNewBtn").addEventListener("click", closeAllSurveyForms);
$("cancelConfirmBtn").addEventListener("click", closeConfirmation);
$("confirmSaveBtn").addEventListener("click", async ()=>{
  const fn=state.pendingConfirmation;
  if (fn) await fn();
});

$("loginBtn").addEventListener("click", login);
$("logoutBtn").addEventListener("click", logout);
$("adminBtn").addEventListener("click", openAdmin);
$("dashboardBtn").addEventListener("click", openDashboard);
$("correctionBtn").addEventListener("click", openCorrection);
$("findCorrectionBtn").addEventListener("click", findCorrectionRecord);
$("saveCorrectionBtn").addEventListener("click", saveCorrection);
$("correctionAccountId").addEventListener("keydown", e => {
  if (e.key === "Enter") findCorrectionRecord();
});
$("refreshDashboardBtn").addEventListener("click", loadDashboard);
$("exportReportBtn").addEventListener("click", exportFilteredReport);
$("todayDashboardBtn").addEventListener("click", setDashboardToday);
$("applyDashboardFilterBtn").addEventListener("click", loadDashboard);
$("clearDashboardFilterBtn").addEventListener("click", async () => {
  $("dashFromDate").value="";
  $("dashToDate").value="";
  $("dashUserFilter").value="";
  $("dashVillageFilter").value="";
  await loadDashboard();
});
$("createUserBtn").addEventListener("click", createUser);
$("searchBtn").addEventListener("click", searchConsumer);
$("masterSetupContinueBtn").addEventListener("click", closeMasterSetup);
$("uploadBtn").addEventListener("click", uploadPending);
$("syncStatusBtn").addEventListener("click", syncUploadStatus);
$("exportBtn").addEventListener("click", v151ExportLocalData);
$("loginPassword").addEventListener("keydown", e => { if (e.key === "Enter") login(); });
$("loginUserId").addEventListener("keydown", e => { if (e.key === "Enter") login(); });
$("accountId").addEventListener("keydown", e => { if (e.key === "Enter") searchConsumer(); });
$("mobile").addEventListener("keydown", e => { if (e.key === "Enter") prepareExistingSave(); });

v151InitMyCollection();
init();


async function v151ExportLocalData() {
  const records=await getAllRecords();
  if(!records.length){ alert("No local survey data to export."); return; }
  const headers=["Survey Type","Survey Status","Connection Type","Survey ID","User ID","User Name","Account ID","Consumer Name","Father/Husband","Address","Supply Type","Load","SDO Code","Village","Meter Condition","AC Installed","Mobile Number","House Locked","Mobile Refused","Meter Installed","Meter Number","Current Reading","Outstanding","Connected Load","Remarks","Created At","Upload Status"];
  const rows=records.map(r=>[r.survey_type||"",r.survey_status||"",r.connection_type||"",r.survey_id||"",r.user_id||"",r.user_name||"",r.account_id||"",r.consumer_name||"",r.father_name||"",r.address||"",r.supply_type||"",r.load||"",r.sdo_code||"",r.village||"",r.meter_condition||"",r.ac_installed||"",r.mobile_number||"",r.house_locked||"",r.mobile_refused||"",r.meter_installed||"",r.meter_number||"",r.current_reading||"",r.outstanding||"",r.connected_load||"",r.remarks||"",v1511ISTDateTime(r.created_at)||"",r.upload_status||"PENDING"]);
  const csv=[headers,...rows].map(row=>row.map(v=>`"${String(v==null?"":v).replace(/"/g,'""')}"`).join(",")).join("\r\n");
  const blob=new Blob(["\ufeff"+csv],{type:"text/csv;charset=utf-8"});
  const url=URL.createObjectURL(blob); const a=document.createElement("a");
  const exportStamp = new Date();
  const pad = n => String(n).padStart(2,"0");
  const exportName =
    `survey_local_data_${exportStamp.getFullYear()}-${pad(exportStamp.getMonth()+1)}-${pad(exportStamp.getDate())}_${pad(exportStamp.getHours())}-${pad(exportStamp.getMinutes())}-${pad(exportStamp.getSeconds())}.csv`;
  a.href=url; a.download=exportName;
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}

