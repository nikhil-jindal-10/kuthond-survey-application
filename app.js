/*
 V6 - Login + Meter Condition + Disconnection
 Server URL remains the same. Existing survey flow preserved.
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
  duplicateInfo: null,
  disconnectCurrent: null,
  disconnectGps: null,
  phoneCurrent: null
};
const $ = id => document.getElementById(id);

function setStatus(id, text, cls="") {
  $(id).textContent = text;
  $(id).className = "status " + cls;
}

async function serverPost(action, extra={}) {
  const response=await fetch(SERVER_URL,{
    method:"POST",
    headers:{"Content-Type":"text/plain;charset=utf-8"},
    body:JSON.stringify(Object.assign({action:action,token:state.sessionToken},extra))
  });
  return await response.json();
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
  "activitySearchCard",
  "accountActivityModuleCard",
  "phoneCallingModuleCard",
  "disconnectionCard",
  "fieldWorkModulesCard",
  "adminCard",
  "phoneCallingCard",
  "recheckCard"
];

function showMainView(view) {
  MAIN_VIEW_IDS.forEach(id => {
    const el=$(id);
    if (el) el.classList.add("hidden");
  });

  if (view === "home") {
    ["surveyTypeCard","fieldWorkModulesCard","accountActivityModuleCard","phoneCallingModuleCard","myCollectionCard","uploadCard"].forEach(id => {
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
  $("dashboardBtn").classList.remove("hidden");
  if (showAdmin) {
    $("adminBtn").classList.remove("hidden");
  } else {
    $("adminBtn").classList.add("hidden");
    $("adminCard").classList.add("hidden");
    $("correctionCard").classList.add("hidden");
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
    CURRENT_READING:o["current reading"] || "",
    MOBILE_NUMBER:o["mobile number"] || ""
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
    const req = indexedDB.open("ConsumerMobileApp", 5);
    req.onupgradeneeded = e => {
      const db = e.target.result;

      // KEEP THE EXISTING "records" STORE AS THE STABLE DOOR-TO-DOOR
      // SURVEY STORE. Existing survey records are not moved or rewritten.
      if (!db.objectStoreNames.contains("records")) {
        const store = db.createObjectStore("records", {keyPath:"id", autoIncrement:true});
        store.createIndex("account_id", "account_id", {unique:false});
        store.createIndex("upload_status", "upload_status", {unique:false});
      }

      // New field-work activities use separate local stores.
      if (!db.objectStoreNames.contains("disconnections")) {
        const store = db.createObjectStore("disconnections", {keyPath:"id", autoIncrement:true});
        store.createIndex("account_id", "account_id", {unique:false});
        store.createIndex("upload_status", "upload_status", {unique:false});
      }
      if (!db.objectStoreNames.contains("rechecks")) {
        const store = db.createObjectStore("rechecks", {keyPath:"id", autoIncrement:true});
        store.createIndex("account_id", "account_id", {unique:false});
        store.createIndex("upload_status", "upload_status", {unique:false});
      }
      if (!db.objectStoreNames.contains("phoneCalls")) {
        const store = db.createObjectStore("phoneCalls", {keyPath:"id", autoIncrement:true});
        store.createIndex("account_id", "account_id", {unique:false});
        store.createIndex("upload_status", "upload_status", {unique:false});
      }

      // Earlier test versions temporarily stored new activities in "records".
      // Move only those activity records to their dedicated stores. Stable
      // survey records remain untouched.
      if (e.oldVersion < 5 && db.objectStoreNames.contains("records")) {
        const tx = e.target.transaction;
        const surveyStore = tx.objectStore("records");
        const disStore = tx.objectStore("disconnections");
        const recheckStore = tx.objectStore("rechecks");
        const callStore = tx.objectStore("phoneCalls");
        surveyStore.openCursor().onsuccess = ev => {
          const cursor = ev.target.result;
          if (!cursor) return;
          const r = cursor.value;
          const type = String(r.activity_type || "").trim().toUpperCase();
          if (type === "DISCONNECTION") {
            const copy = Object.assign({}, r);
            delete copy.id;
            disStore.add(copy);
            cursor.delete();
          } else if (type === "RECHECK") {
            const copy = Object.assign({}, r);
            delete copy.id;
            recheckStore.add(copy);
            cursor.delete();
          } else if (type === "PHONE_CALLING") {
            const copy = Object.assign({}, r);
            delete copy.id;
            callStore.add(copy);
            cursor.delete();
          }
          cursor.continue();
        };
      }
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
  $("natureOfSupply").value="";
  $("houseCondition").value="";
  $("consumerPaymentResponse").value="";
  $("consumerPaymentDate").value="";
  $("consumerPaymentDateWrap").classList.add("hidden");
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


function makeActivityId(prefix) {
  const d=new Date();
  const stamp=d.getFullYear()+String(d.getMonth()+1).padStart(2,"0")+String(d.getDate()).padStart(2,"0")+"-"+Date.now();
  return prefix+"-"+stamp+"-"+Math.floor(Math.random()*1000);
}

function activityTypeOf(r) {
  if (r && r.activity_type) return String(r.activity_type).toUpperCase();
  return "SURVEY";
}

function activityIdentity(r) {
  const type=activityTypeOf(r);
  const user=String(r.user_id||"").trim().toLowerCase();
  if (type==="DISCONNECTION") return "DISCONNECTION|"+String(r.disconnection_id||"").trim();
  if (type==="RECHECK") return "RECHECK|"+String(r.recheck_id||"").trim();
  if (type==="PHONE_CALLING") return "PHONE_CALLING|"+String(r.calling_id||"").trim();
  if (String(r.survey_type||"").toUpperCase()==="CONNECTION NOT IN DATABASE") {
    return "SURVEY_NEW|"+user+"|"+String(r.survey_id||"").trim();
  }
  return "SURVEY_EXISTING|"+user+"|"+String(r.account_id||"").trim();
}

function getActivityDisplayName(r) {
  const type=activityTypeOf(r);
  if(type==="DISCONNECTION") return "Disconnection";
  if(type==="RECHECK") return "Recheck";
  if(type==="PHONE_CALLING") return "Phone Calling";
  return String(r.survey_type||"DOOR-TO-DOOR SURVEY").toUpperCase()==="CONNECTION NOT IN DATABASE"
    ? "Door-to-Door Survey — Connection Not in Database"
    : "Door-to-Door Survey — Existing Consumer";
}

async function getAllFromStore(storeName) {
  return new Promise((resolve,reject)=>{
    const tx=state.db.transaction(storeName,"readonly");
    const req=tx.objectStore(storeName).getAll();
    req.onsuccess=()=>resolve(req.result||[]);
    req.onerror=()=>reject(req.error);
  });
}

async function getAllActivityRecords() {
  const [disconnections,rechecks,phoneCalls]=await Promise.all([
    getAllFromStore("disconnections"),
    getAllFromStore("rechecks"),
    getAllFromStore("phoneCalls")
  ]);
  return [...disconnections,...rechecks,...phoneCalls];
}

async function searchLocalActivities(accountId) {
  const [surveyRecords,activityRecords]=await Promise.all([getAllRecords(),getAllActivityRecords()]);
  return [...surveyRecords,...activityRecords].filter(r=>String(r.account_id||"").trim()===String(accountId).trim());
}

function renderActivityCards(records) {
  const box=$("activityResults");
  if(!records.length){ box.innerHTML='<div class="muted">No activity found for this Account ID.</div>'; return; }
  const sorted=[...records].sort((a,b)=>new Date(b.created_at||0)-new Date(a.created_at||0));
  box.innerHTML=sorted.map((r,i)=>{
    const type=activityTypeOf(r);
    const details=[];
    if(type==="DISCONNECTION"){
      if(r.consumer_name) details.push("Name: "+r.consumer_name);
      if(r.address) details.push("Address: "+r.address);
      if(r.outstanding) details.push("Total Outstanding: "+r.outstanding);
      else if(r.total_outstanding) details.push("Total Outstanding: "+r.total_outstanding);
      if(r.committed_payment_date) details.push("Committed Payment Date: "+r.committed_payment_date);
      if(r.payment_mode) details.push("Payment Mode: "+r.payment_mode);
      if(r.disconnection_status) details.push("Status: "+r.disconnection_status);
      if(r.meter_status) details.push("Meter Status: "+r.meter_status);
      if(r.house_condition) details.push("House Condition: "+r.house_condition);
    } else if(type==="SURVEY"){
      if(r.consumer_name) details.push("Name: "+r.consumer_name);
      if(r.address) details.push("Address: "+r.address);
      if(r.mobile_number) details.push("Mobile: "+r.mobile_number);
      if(r.survey_status) details.push("Status: "+r.survey_status);
    } else if(type==="RECHECK"){
      if(r.consumer_name) details.push("Name: "+r.consumer_name);
      if(r.address) details.push("Address: "+r.address);
      if(r.mobile_number) details.push("Mobile: "+r.mobile_number);
      if(r.outstanding) details.push("Total Outstanding: "+r.outstanding);
      else if(r.total_outstanding) details.push("Total Outstanding: "+r.total_outstanding);
      if(r.present_status) details.push("Present Status: "+r.present_status);
      if(r.payment_mode) details.push("Payment Mode: "+r.payment_mode);
      if(r.meter_status) details.push("Current Meter Status: "+r.meter_status);
    } else {
      if(r.consumer_name) details.push("Name: "+r.consumer_name);
      if(r.address) details.push("Address: "+r.address);
      if(r.mobile_number) details.push("Mobile: "+r.mobile_number);
      if(r.outstanding) details.push("Total Outstanding: "+r.outstanding);
      else if(r.total_outstanding) details.push("Total Outstanding: "+r.total_outstanding);
      if(r.call_response) details.push("Response: "+r.call_response);
      if(r.committed_payment_date) details.push("Committed Payment Date: "+r.committed_payment_date);
      else if(r.payment_date) details.push("Payment Date: "+r.payment_date);
    }
    const admin=state.isAdmin===true || state.userId.toLowerCase()==="admin";
    const key=escapeHtml(activityIdentity(r));
    return `<div class="activity-card" data-activity-key="${key}">
      <h3>${escapeHtml(getActivityDisplayName(r))}</h3>
      <div class="activity-meta">${escapeHtml(formatDate(r.created_at))} · ${escapeHtml(r.user_name||r.user_id||"Unknown")}</div>
      ${r.last_updated_by_name ? `<div class="activity-meta">Last Updated By: ${escapeHtml(r.last_updated_by_name)}${r.last_updated_at ? ` · ${escapeHtml(formatDate(r.last_updated_at))}` : ""}</div>` : ""}
      <div>${details.map(x=>`<div>${escapeHtml(x)}</div>`).join("")}</div>
      <div class="activity-actions"><button type="button" class="secondary activity-view-btn" data-index="${i}">VIEW</button>${admin?`<button type="button" class="primary activity-correction-btn" data-index="${i}">CORRECTION</button>`:""}</div>
    </div>`;
  });
  box.querySelectorAll('.activity-view-btn').forEach(btn=>btn.addEventListener('click',()=>{
    const r=sorted[Number(btn.dataset.index)];
    openConfirmation("Activity Record",activityConfirmationItems(r),()=>{});
    // Make the confirmation read-only: restore button label and disable save.
    $("confirmSaveBtn").classList.add("hidden");
    $("cancelConfirmBtn").textContent="CLOSE";
  }));
  box.querySelectorAll('.activity-correction-btn').forEach(btn=>btn.addEventListener('click',()=>{
    const r=sorted[Number(btn.dataset.index)];
    openActivityCorrection(r);
  }));
}

function activityConfirmationItems(r){
  const items=[
    ["Activity",getActivityDisplayName(r)],
    ["Account ID",r.account_id||""],
    ["Consumer",r.consumer_name||""],
    ["User",r.user_name||r.user_id||""],
    ["Created At",formatDate(r.created_at)]
  ];
  const skip=new Set(["activity_type","id","upload_status","user_id","user_name","account_id","consumer_name","created_at"]);
  if(r.last_updated_by_name) items.push(["Last Updated By",r.last_updated_by_name]);
  if(r.last_updated_at) items.push(["Last Updated At",formatDate(r.last_updated_at)]);
  Object.keys(r||{}).forEach(k=>{
    if(skip.has(k)||k.endsWith("_id")||k.startsWith("last_updated_")||!r[k]) return;
    const label=k.replaceAll("_"," ").replace(/\\b\\w/g,m=>m.toUpperCase());
    items.push([label,String(r[k])]);
  });
  return items.slice(0,24);
}

function openActivitySearch(){
  showMainView("activitySearchCard");
  $("activityAccountId").value="";
  $("activitySearchStatus").textContent="";
  $("activityScopeNotice").classList.add("hidden");
  $("activityResults").innerHTML="";
  $("activityAccountId").focus();
}

function closeActivitySearch(){
  $("activityAccountId").value="";
  $("activityResults").innerHTML="";
  $("activitySearchStatus").textContent="";
  $("activityScopeNotice").classList.add("hidden");
}

async function searchAccountActivity(){
  const accountId=$("activityAccountId").value.trim().replace(/\D/g,"");
  if(!accountId) return setStatus("activitySearchStatus","Enter Account ID.","error");
  setStatus("activitySearchStatus","Searching local activity...");
  closeConfirmation();
  try{
    const local=await searchLocalActivities(accountId);
    let combined=[...local], online=false;
    if(navigator.onLine && state.sessionToken){
      try{
        const result=await serverPost("account_activity",{account_id:accountId});
        if(result.success){ combined=combined.concat(result.records||[]); online=true; }
      }catch(e){ online=false; }
    }
    const map=new Map();
    for(const r of combined){ const key=activityIdentity(r); if(!map.has(key)) map.set(key,r); }
    const final=[...map.values()];
    $("activityScopeNotice").classList.remove("hidden");
    $("activityScopeNotice").textContent=online
      ? "Showing local records combined with global server activity. Duplicate records are shown only once."
      : "Showing activity from this device only. Connect to the internet to view activity history from all devices.";
    setStatus("activitySearchStatus",`${final.length} activity record(s) found.`,"ok");
    // keep result list for correction handlers
    state.activityResults=final;
    renderActivityCards(final);
  }catch(e){ setStatus("activitySearchStatus","Could not search activity records.","error"); }
}

function activityCorrectionIsAdmin(){
  return state.isAdmin===true || state.userId.toLowerCase()==="admin";
}

function activityCorrectionStoreName(record){
  const type=activityTypeOf(record);
  if(type==="DISCONNECTION") return "disconnections";
  if(type==="RECHECK") return "rechecks";
  if(type==="PHONE_CALLING") return "phoneCalls";
  return "records";
}

function activityCorrectionIdMatches(record, candidate){
  const type=activityTypeOf(record);
  if(type==="DISCONNECTION") return String(candidate.disconnection_id||"").trim()===String(record.disconnection_id||"").trim();
  if(type==="RECHECK") return String(candidate.recheck_id||"").trim()===String(record.recheck_id||"").trim();
  if(type==="PHONE_CALLING") return String(candidate.calling_id||"").trim()===String(record.calling_id||"").trim();
  const user=String(record.user_id||"").trim().toLowerCase();
  if(String(record.survey_type||"").toUpperCase()==="CONNECTION NOT IN DATABASE")
    return String(candidate.user_id||"").trim().toLowerCase()===user && String(candidate.survey_id||"").trim()===String(record.survey_id||"").trim();
  return String(candidate.user_id||"").trim().toLowerCase()===user && String(candidate.account_id||"").trim()===String(record.account_id||"").trim();
}

function activityCorrectionSelect(id, label, value, options){
  return `<label for="${id}">${escapeHtml(label)}</label><select id="${id}"><option value="">Select</option>${options.map(o=>`<option value="${escapeHtml(o)}"${String(value||"")===o?' selected':''}>${escapeHtml(o)}</option>`).join("")}</select>`;
}

function renderActivityCorrectionForm(record){
  const type=activityTypeOf(record);
  const box=$("activityCorrectionResult");
  const common=`
    <div class="correction-info">
      <div><span>Activity</span><b>${escapeHtml(getActivityDisplayName(record))}</b></div>
      <div><span>Account ID</span><b>${escapeHtml(record.account_id||"")}</b></div>
      <div><span>Consumer</span><b>${escapeHtml(record.consumer_name||"")}</b></div>
      <div><span>Original User</span><b>${escapeHtml(record.user_name||record.user_id||"Unknown")}</b></div>
      <div><span>Original Date</span><b>${escapeHtml(formatDate(record.created_at))}</b></div>
    </div>`;

  let fields=common;
  if(type==="DISCONNECTION"){
    fields+=activityCorrectionSelect("activityCorrStatus","Disconnection Status",record.disconnection_status,["DISCONNECTED","TIME GIVEN FOR PAYMENT","PAID"]);
    fields+=activityCorrectionSelect("activityCorrPaymentMode","Payment Mode",record.payment_mode,["PAID ONLINE AT SITE","PAID OFFLINE AT COUNTER","PAYMENT RECEIVED BY LINEMAN"]);
    fields+=`<label for="activityCorrCommitDate">Committed Payment Date</label><input id="activityCorrCommitDate" type="date" value="${escapeHtml(record.committed_payment_date||"")}">`;
    fields+=activityCorrectionSelect("activityCorrMeterStatus","Current Meter Status",record.meter_status,["OK","DAMAGED","NOT INSTALLED","BURNT","UNMETERED"]);
    fields+=`<label for="activityCorrReading">Current Reading</label><input id="activityCorrReading" value="${escapeHtml(record.current_reading||"")}">`;
    fields+=`<label for="activityCorrMobile">Mobile Number</label><input id="activityCorrMobile" inputmode="numeric" maxlength="10" value="${escapeHtml(record.mobile_number||"")}">`;
    fields+=activityCorrectionSelect("activityCorrHouse","House Condition",record.house_condition,["kutcha house","Pucca normal house","Pucca Good house","Luxury (Rich) house"]);
    fields+=`<label for="activityCorrRemarks">Remark</label><textarea id="activityCorrRemarks" rows="3">${escapeHtml(record.remarks||"")}</textarea>`;
  } else if(type==="RECHECK"){
    fields+=activityCorrectionSelect("activityCorrStatus","Present Status",record.present_status,["STILL DISCONNECTED","FOUND CONNECTED","FOUND HOUSE LOCKED","PAYMENT MADE"]);
    fields+=activityCorrectionSelect("activityCorrPaymentMode","Payment Mode",record.payment_mode,["PAID ONLINE AT SITE","PAID OFFLINE AT COUNTER","PAYMENT RECEIVED BY LINEMAN"]);
    fields+=activityCorrectionSelect("activityCorrMeterStatus","Current Meter Status",record.meter_status,["OK","DAMAGED","NOT INSTALLED","BURNT","UNMETERED"]);
    fields+=`<label for="activityCorrReading">Current Reading</label><input id="activityCorrReading" value="${escapeHtml(record.current_reading||"")}">`;
    fields+=`<label for="activityCorrMobile">Mobile Number</label><input id="activityCorrMobile" inputmode="numeric" maxlength="10" value="${escapeHtml(record.mobile_number||"")}">`;
    fields+=`<label for="activityCorrRemarks">Remark</label><textarea id="activityCorrRemarks" rows="3">${escapeHtml(record.remarks||"")}</textarea>`;
  } else if(type==="PHONE_CALLING"){
    fields+=`<label for="activityCorrMobile">Mobile Number</label><input id="activityCorrMobile" inputmode="numeric" maxlength="10" value="${escapeHtml(record.mobile_number||"")}">`;
    fields+=activityCorrectionSelect("activityCorrResponse","Call Response",record.call_response,["गलत नंबर","कॉल रिसीव नहीं कर रहे","कुछ दिन बाद जमा करेंगे","जमा नहीं करेंगे","बिल गलत है","घर पर बात करेंगे","JE/SDO से बात करेंगे","डबल कनेक्शन है","PD होना है","बिल जमा है","कार्यालय आएंगे","अन्य"]);
    fields+=`<label for="activityCorrCommitDate">Committed Payment Date</label><input id="activityCorrCommitDate" type="date" value="${escapeHtml(record.committed_payment_date||record.payment_date||"")}">`;
    fields+=`<label for="activityCorrRemarks">Remark</label><textarea id="activityCorrRemarks" rows="3">${escapeHtml(record.remarks||"")}</textarea>`;
  } else {
    fields+=activityCorrectionSelect("activityCorrVillage","Village",record.village,[...new Set([record.village||"", ...Array.from($("village").options).map(o=>o.value).filter(Boolean)])].filter(Boolean));
    fields+=activityCorrectionSelect("activityCorrMeterStatus","Meter Condition",record.meter_condition,["OK","DAMAGED","NOT INSTALLED"]);
    fields+=activityCorrectionSelect("activityCorrAc","AC Installed",record.ac_installed,["YES","NO"]);
    fields+=`<label for="activityCorrMobile">Mobile Number</label><input id="activityCorrMobile" inputmode="numeric" maxlength="10" value="${escapeHtml(record.mobile_number||"")}">`;
    fields+=`<label for="activityCorrRemarks">Remark</label><textarea id="activityCorrRemarks" rows="3">${escapeHtml(record.remarks||"")}</textarea>`;
  }
  box.innerHTML=fields+`<button id="activityCorrectionSaveBtn" class="primary" type="button">SAVE CORRECTION</button><div id="activityCorrectionStatus" class="status"></div>`;
  box.classList.remove("hidden");
  $("correctionResult").classList.add("hidden");
  $("correctionSearchStatus").textContent="";
  $("activityCorrectionSaveBtn").addEventListener("click",()=>prepareActivityCorrectionSave(record));
}

async function openActivityCorrection(record){
  if(!activityCorrectionIsAdmin()) return;
  showMainView("correctionCard");
  $("correctionAccountId").value=record.account_id||"";
  $("activityCorrectionResult").classList.add("hidden");
  $("correctionResult").classList.add("hidden");
  $("correctionSearchStatus").textContent="";
  renderActivityCorrectionForm(record);
}

function prepareActivityCorrectionSave(original){
  const type=activityTypeOf(original);
  const corrected=Object.assign({},original);
  corrected.upload_status="PENDING";

  if(type==="DISCONNECTION"){
    corrected.disconnection_status=$("activityCorrStatus").value;
    corrected.payment_mode=$("activityCorrPaymentMode").value;
    corrected.committed_payment_date=$("activityCorrCommitDate").value;
    corrected.meter_status=$("activityCorrMeterStatus").value;
    corrected.current_reading=$("activityCorrReading").value.trim();
    corrected.mobile_number=$("activityCorrMobile").value.replace(/\D/g,"");
    corrected.house_condition=$("activityCorrHouse").value;
    corrected.remarks=$("activityCorrRemarks").value.trim();
    if(!corrected.disconnection_status) return setStatus("activityCorrectionStatus","Select disconnection status.","error");
    if(corrected.disconnection_status==="PAID" && !corrected.payment_mode) return setStatus("activityCorrectionStatus","Select payment mode.","error");
    if(corrected.disconnection_status==="TIME GIVEN FOR PAYMENT" && !corrected.committed_payment_date) return setStatus("activityCorrectionStatus","Select committed payment date.","error");
    if(!corrected.meter_status) return setStatus("activityCorrectionStatus","Select current meter status.","error");
    if(corrected.mobile_number && !/^\d{10}$/.test(corrected.mobile_number)) return setStatus("activityCorrectionStatus","Enter a valid 10 digit mobile number.","error");
    if(!corrected.house_condition) return setStatus("activityCorrectionStatus","Select house condition.","error");
  } else if(type==="RECHECK"){
    corrected.present_status=$("activityCorrStatus").value;
    corrected.payment_mode=$("activityCorrPaymentMode").value;
    corrected.meter_status=$("activityCorrMeterStatus").value;
    corrected.current_reading=$("activityCorrReading").value.trim();
    corrected.mobile_number=$("activityCorrMobile").value.replace(/\D/g,"");
    corrected.remarks=$("activityCorrRemarks").value.trim();
    if(!corrected.present_status) return setStatus("activityCorrectionStatus","Select present status.","error");
    if(corrected.present_status==="PAYMENT MADE" && !corrected.payment_mode) return setStatus("activityCorrectionStatus","Select payment mode.","error");
    if(corrected.present_status==="FOUND CONNECTED" && !corrected.meter_status) return setStatus("activityCorrectionStatus","Select current meter status.","error");
    if(corrected.mobile_number && !/^\d{10}$/.test(corrected.mobile_number)) return setStatus("activityCorrectionStatus","Enter a valid 10 digit mobile number.","error");
  } else if(type==="PHONE_CALLING"){
    corrected.mobile_number=$("activityCorrMobile").value.replace(/\D/g,"");
    corrected.call_response=$("activityCorrResponse").value;
    corrected.committed_payment_date=$("activityCorrCommitDate").value;
    corrected.payment_date=corrected.committed_payment_date;
    corrected.remarks=$("activityCorrRemarks").value.trim();
    if(!/^\d{10}$/.test(corrected.mobile_number)) return setStatus("activityCorrectionStatus","Enter a valid 10 digit mobile number.","error");
    if(!corrected.call_response) return setStatus("activityCorrectionStatus","Select call response.","error");
    if(corrected.call_response==="कुछ दिन बाद जमा करेंगे" && !corrected.committed_payment_date) return setStatus("activityCorrectionStatus","Enter committed payment date.","error");
  } else {
    corrected.village=$("activityCorrVillage").value;
    corrected.meter_condition=$("activityCorrMeterStatus").value;
    corrected.ac_installed=$("activityCorrAc").value;
    corrected.mobile_number=$("activityCorrMobile").value.replace(/\D/g,"");
    corrected.remarks=$("activityCorrRemarks").value.trim();
    // Survey cards use activity_type="SURVEY" for the activity-search UI.
    // Record the admin who performed the correction without changing the original owner.
    corrected.last_updated_by_user_id=state.userId||"";
    corrected.last_updated_by_name=state.userName||state.userId||"";
    corrected.last_updated_at=new Date().toISOString();
    if(!corrected.village) return setStatus("activityCorrectionStatus","Select village.","error");
    if(!corrected.meter_condition) return setStatus("activityCorrectionStatus","Select meter condition.","error");
    if(!corrected.ac_installed) return setStatus("activityCorrectionStatus","Select AC Installed: YES or NO.","error");
    if(!/^\d{10}$/.test(corrected.mobile_number)) return setStatus("activityCorrectionStatus","Enter a valid 10 digit mobile number.","error");
  }

  const items=[
    ["Activity",getActivityDisplayName(corrected)],
    ["Account ID",corrected.account_id||""],
    ["Consumer",corrected.consumer_name||""],
    ["Total Outstanding",corrected.outstanding||"—"]
  ];
  if(type==="DISCONNECTION") items.push(["Disconnection Status",corrected.disconnection_status], ["Payment Mode",corrected.payment_mode||"—"], ["Committed Payment Date",corrected.committed_payment_date||"—"], ["Meter Status",corrected.meter_status], ["Current Reading",corrected.current_reading||"—"], ["Mobile",corrected.mobile_number||"—"], ["House Condition",corrected.house_condition], ["Remark",corrected.remarks||"—"]);
  else if(type==="RECHECK") items.push(["Present Status",corrected.present_status], ["Payment Mode",corrected.payment_mode||"—"], ["Current Meter Status",corrected.meter_status||"—"], ["Current Reading",corrected.current_reading||"—"], ["Mobile",corrected.mobile_number||"—"], ["Remark",corrected.remarks||"—"]);
  else if(type==="PHONE_CALLING") items.push(["Mobile",corrected.mobile_number], ["Call Response",corrected.call_response], ["Committed Payment Date",corrected.committed_payment_date||"—"], ["Remark",corrected.remarks||"—"]);
  else items.push(["Village",corrected.village], ["Meter Condition",corrected.meter_condition], ["AC Installed",corrected.ac_installed], ["Mobile",corrected.mobile_number], ["Remark",corrected.remarks||"—"]);

  openConfirmation("Confirm Correction",items,()=>saveActivityCorrectionLocal(corrected));
}

async function saveActivityCorrectionLocal(corrected){
  const storeName=activityCorrectionStoreName(corrected);
  try{
    const existing=await getAllFromStore(storeName);
    const match=existing.find(r=>activityCorrectionIdMatches(corrected,r));
    const record=Object.assign({},corrected);
    if(match && match.id!==undefined) record.id=match.id;
    await new Promise((resolve,reject)=>{
      const tx=state.db.transaction(storeName,"readwrite");
      tx.objectStore(storeName).put(record);
      tx.oncomplete=resolve;
      tx.onerror=()=>reject(tx.error||new Error("Could not save correction."));
    });
    closeConfirmation();
    $("activityCorrectionResult").classList.add("hidden");
    $("correctionStatus").textContent="";
    if(Array.isArray(state.activityResults)) {
      state.activityResults=state.activityResults.map(r=>activityIdentity(r)===activityIdentity(record) ? record : r);
      renderActivityCards(state.activityResults);
      showMainView("activitySearchCard");
      setStatus("activitySearchStatus","Correction saved locally and marked Pending Upload. Upload it from the Home screen.","ok");
    } else {
      setStatus("correctionSearchStatus","Correction saved locally and marked Pending Upload. Upload it from the Home screen.","ok");
    }
    await updateCounts();
  }catch(e){
    setStatus("activityCorrectionStatus",e.message||"Could not save correction.","error");
  }
}

function resetPhoneCallingForm(){
  const ids=["phoneAccountId","phoneMobile","phoneResponse","phonePaymentDate","phoneRemarks"];
  ids.forEach(id=>{
    const el=$(id);
    if(!el) return;
    el.value="";
  });
  $("phoneConsumerCard").classList.add("hidden");
  $("phoneFormFields").classList.add("hidden");
  $("phonePaymentDateWrap").classList.add("hidden");
  $("phoneCallBtn").disabled=true;
  $("phoneSearchStatus").textContent="";
  $("phoneSaveStatus").textContent="";
  state.phoneCurrent=null;
}

function openPhoneCalling(){
  resetPhoneCallingForm();
  showMainView("phoneCallingCard");
  $("phoneAccountId").focus();
}

async function searchPhoneConsumer(){
  if(!state.sessionToken) return showLogin();
  if(!state.masterReady) return setStatus("phoneSearchStatus","Master data is still loading. Please wait until it finishes.","error");

  const raw=$("phoneAccountId").value.trim();
  if(!raw) return setStatus("phoneSearchStatus","Enter an Account ID.","error");

  let c=null;
  try{
    c=await getMasterByIndex("acct_norm",raw.replace(/\D/g,""));
  }catch(e){
    return setStatus("phoneSearchStatus","Local master data is not available. Please reopen the app.","error");
  }

  if(!c){
    state.phoneCurrent=null;
    $("phoneConsumerCard").classList.add("hidden");
    $("phoneFormFields").classList.add("hidden");
    $("phoneCallBtn").disabled=true;
    return setStatus("phoneSearchStatus","Consumer not found. Make sure the Account ID is exactly as shown in the source data.","error");
  }

  state.phoneCurrent=c;
  $("phoneAcct").textContent=c.ACCT_ID||"";
  $("phoneName").textContent=c.NAME||"";
  $("phoneFather").textContent=c.FATHER_NAME||"";
  $("phoneAddress").textContent=c.ADDRESS||"";
  $("phoneSupply").textContent=c.SUPPLY_TYPE||"";
  $("phoneLoad").textContent=c.LOAD||"";
  $("phoneOutstanding").textContent=displayOrUnavailable(getConsumerOutstanding(c));

  const mobile=String(c.MOBILE_NUMBER||"").trim();
  $("phoneMobile").value=mobile;
  $("phoneCallBtn").disabled=!/^\d{10}$/.test(mobile);
  $("phoneConsumerCard").classList.remove("hidden");
  $("phoneFormFields").classList.remove("hidden");
  $("phoneResponse").value="";
  $("phonePaymentDate").value="";
  $("phoneRemarks").value="";
  $("phonePaymentDateWrap").classList.add("hidden");
  setStatus("phoneSearchStatus","Consumer found. Verify the mobile number before calling.","ok");
}

function updatePhoneConditionalFields(){
  const response=$("phoneResponse").value;
  $("phonePaymentDateWrap").classList.toggle("hidden",response!=="कुछ दिन बाद जमा करेंगे");
  if(response!=="कुछ दिन बाद जमा करेंगे") $("phonePaymentDate").value="";
}

function callPhoneNumber(){
  const mobile=$("phoneMobile").value.trim();
  if(!/^\d{10}$/.test(mobile)) return setStatus("phoneSaveStatus","Enter a valid 10 digit mobile number before calling.","error");
  window.location.href="tel:"+mobile;
}

function preparePhoneCallSave(){
  const c=state.phoneCurrent;
  if(!c) return setStatus("phoneSaveStatus","Search an Account ID first.","error");

  const mobile=$("phoneMobile").value.trim();
  const response=$("phoneResponse").value;
  const paymentDate=$("phonePaymentDate").value;
  const remarks=$("phoneRemarks").value.trim();

  if(!/^\d{10}$/.test(mobile)) return setStatus("phoneSaveStatus","Enter a valid 10 digit mobile number.","error");
  if(!response) return setStatus("phoneSaveStatus","Select a call response.","error");
  if(response==="कुछ दिन बाद जमा करेंगे" && !paymentDate) return setStatus("phoneSaveStatus","Enter the date by which the consumer will pay.","error");
  if(response==="अन्य" && !remarks) return setStatus("phoneSaveStatus","Remarks are mandatory for 'अन्य'.","error");

  const record={
    activity_type:"PHONE_CALLING",
    calling_id:makeActivityId("CALL"),
    user_id:state.userId,
    user_name:state.userName,
    account_id:c.ACCT_ID||"",
    consumer_name:c.NAME||"",
    father_name:c.FATHER_NAME||"",
    address:c.ADDRESS||"",
    supply_type:c.SUPPLY_TYPE||"",
    load:c.LOAD||"",
    sdo_code:c.SDO_CODE||"",
    outstanding:getConsumerOutstanding(c),
    mobile_number:mobile,
    call_response:response,
    committed_payment_date:paymentDate,
    payment_date:paymentDate,
    remarks:remarks,
    created_at:new Date().toISOString(),
    upload_status:"PENDING"
  };

  openConfirmation("Confirm Phone Calling",[
    ["Account ID",record.account_id],
    ["Consumer",record.consumer_name],
    ["Address",record.address],
    ["Total Outstanding",record.outstanding||"—"],
    ["Mobile Number",record.mobile_number],
    ["Call Response",record.call_response],
    ["Committed Payment Date",record.committed_payment_date||"—"],
    ["Remarks",record.remarks||"—"]
  ],()=>savePhoneCallLocal(record));
}

function savePhoneCallLocal(record){
  return new Promise(resolve=>{
    const tx=state.db.transaction("phoneCalls","readwrite");
    tx.objectStore("phoneCalls").add(record);
    tx.oncomplete=()=>{
      closeConfirmation();
      resetPhoneCallingForm();
      showMainView("home");
      setStatus("phoneSaveStatus","Phone call response saved locally. Ready for the next entry.","ok");
      updateCounts();
      resolve(true);
    };
    tx.onerror=()=>{
      closeConfirmation();
      setStatus("phoneSaveStatus","Could not save phone call response.","error");
      resolve(false);
    };
  });
}


function resetRecheckForm(){
  ["recheckAccountId","recheckStatus","recheckPaymentMode","recheckMeterStatus","recheckReading","recheckMobile","recheckRemarks"].forEach(id=>{
    const el=$(id);
    if(!el) return;
    el.value="";
  });
  $("recheckPaymentModeWrap").classList.add("hidden");
  $("recheckConsumerCard").classList.add("hidden");
  $("recheckFormFields").classList.add("hidden");
  $("recheckSearchStatus").textContent="";
  $("recheckSaveStatus").textContent="";
  if (state) {
    state.recheckCurrent=null;
    state.recheckGps=null;
  }
}

function openRecheck(){
  resetRecheckForm();
  showMainView("recheckCard");
  $("recheckAccountId").focus();
}

async function searchRecheckConsumer(){
  const raw=$("recheckAccountId").value.trim();
  const account=raw.replace(/\D/g,"");
  if(!account) return setStatus("recheckSearchStatus","Enter Account ID.","error");
  if(!state.masterReady) return setStatus("recheckSearchStatus","Master data is still loading. Please wait.","error");

  try{
    const c=await getMasterByIndex("acct_norm",account);
    if(!c) return setStatus("recheckSearchStatus","Consumer not found in local master data.","error");

    state.recheckCurrent=c;
    $("rcAcct").textContent=c.ACCT_ID||"";
    $("rcName").textContent=c.NAME||"";
    $("rcFather").textContent=c.FATHER_NAME||"";
    $("rcAddress").textContent=c.ADDRESS||"";
    $("rcSupply").textContent=c.SUPPLY_TYPE||"";
    $("rcLoad").textContent=c.LOAD||"";
    $("rcMeterNo").textContent=displayOrUnavailable(getConsumerMeterNo(c));
    $("rcOutstanding").textContent=displayOrUnavailable(getConsumerOutstanding(c));

    $("recheckConsumerCard").classList.remove("hidden");
    $("recheckFormFields").classList.remove("hidden");
    setStatus("recheckSearchStatus","Consumer found. Fill the rechecking details.","ok");
    captureRecheckGps();
  }catch(e){
    setStatus("recheckSearchStatus","Could not read local consumer data.","error");
  }
}

function captureRecheckGps(){
  state.recheckGps=null;
  if(!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(pos=>{
    state.recheckGps={
      latitude:pos.coords.latitude,
      longitude:pos.coords.longitude,
      accuracy:pos.coords.accuracy
    };
  },()=>{}, {enableHighAccuracy:true,timeout:8000,maximumAge:60000});
}

function updateRecheckConditionalFields(){
  const status=$("recheckStatus").value;
  $("recheckPaymentModeWrap").classList.toggle("hidden",status!=="PAYMENT MADE");
  if(status!=="PAYMENT MADE") $("recheckPaymentMode").value="";
}

function prepareRecheckSave(){
  const c=state.recheckCurrent;
  if(!c) return setStatus("recheckSaveStatus","Search an Account ID first.","error");

  const status=$("recheckStatus").value;
  const paymentMode=$("recheckPaymentMode").value;
  const meter=$("recheckMeterStatus").value;
  const reading=$("recheckReading").value.trim();
  const mobile=$("recheckMobile").value.replace(/\D/g,"");
  const remarks=$("recheckRemarks").value.trim();

  if(!status) return setStatus("recheckSaveStatus","Select present status.","error");
  if(status==="PAYMENT MADE" && !paymentMode) return setStatus("recheckSaveStatus","Select payment mode.","error");
  if(status==="FOUND CONNECTED" && !meter) return setStatus("recheckSaveStatus","Select current meter status.","error");
  if(mobile && !/^\d{10}$/.test(mobile)) return setStatus("recheckSaveStatus","Enter a valid 10 digit mobile number.","error");

  const record={
    activity_type:"RECHECK",
    recheck_id:makeActivityId("RECHK"),
    user_id:state.userId,
    user_name:state.userName,
    account_id:c.ACCT_ID||"",
    consumer_name:c.NAME||"",
    father_name:c.FATHER_NAME||"",
    address:c.ADDRESS||"",
    supply_type:c.SUPPLY_TYPE||"",
    load:c.LOAD||"",
    sdo_code:c.SDO_CODE||"",
    outstanding:getConsumerOutstanding(c),
    present_status:status,
    payment_mode:paymentMode,
    payment_date:"",
    meter_status:meter,
    current_reading:reading,
    mobile_number:mobile,
    remarks:remarks,
    latitude:state.recheckGps?state.recheckGps.latitude:"",
    longitude:state.recheckGps?state.recheckGps.longitude:"",
    gps_accuracy:state.recheckGps?state.recheckGps.accuracy:"",
    created_at:new Date().toISOString(),
    upload_status:"PENDING"
  };

  openConfirmation("Confirm Recheck",[
    ["Account ID",record.account_id],
    ["Consumer",record.consumer_name],
    ["Address",record.address],
    ["Total Outstanding",record.outstanding||"—"],
    ["Present Status",record.present_status],
    ["Payment Mode",record.payment_mode||"—"],
    ["Current Meter Status",record.meter_status||"—"],
    ["Current Reading",record.current_reading||"—"],
    ["Mobile Number",record.mobile_number||"—"],
    ["Remark",record.remarks||"—"]
  ],()=>saveRecheckLocal(record));
}

function saveRecheckLocal(record){
  return new Promise(resolve=>{
    const tx=state.db.transaction("rechecks","readwrite");
    tx.objectStore("rechecks").add(record);
    tx.oncomplete=()=>{
      closeConfirmation();
      resetRecheckForm();
      showMainView("home");
      updateCounts();
      resolve(true);
    };
    tx.onerror=()=>{
      closeConfirmation();
      setStatus("recheckSaveStatus","Could not save recheck.","error");
      resolve(false);
    };
  });
}

function resetDisconnectionForm(){
  ["disconnectAccountId","disconnectStatus","disconnectPaymentMode","disconnectCommitDate","disconnectMeterStatus","disconnectReading","disconnectMobile","disconnectHouseCondition","disconnectRemarks"].forEach(id=>{const el=$(id); if(!el)return; if(el.tagName==="SELECT")el.value=""; else el.value="";});
  $("disconnectPaymentModeWrap").classList.add("hidden");
  $("disconnectCommitDateWrap").classList.add("hidden");
  $("disconnectConsumerCard").classList.add("hidden");
  $("disconnectFormFields").classList.add("hidden");
  $("disconnectSearchStatus").textContent="";
  $("disconnectSaveStatus").textContent="";
  state.disconnectCurrent=null; state.disconnectGps=null;
}

function openDisconnection(){
  resetDisconnectionForm();
  showMainView("disconnectionCard");
  $("disconnectAccountId").focus();
}

async function searchDisconnectionConsumer(){
  const raw=$("disconnectAccountId").value.trim();
  const account=raw.replace(/\D/g,"");
  if(!account) return setStatus("disconnectSearchStatus","Enter Account ID.","error");
  if(!state.masterReady) return setStatus("disconnectSearchStatus","Master data is still loading. Please wait.","error");
  try{
    const c=await getMasterByIndex("acct_norm",account);
    if(!c) return setStatus("disconnectSearchStatus","Consumer not found in local master data.","error");
    state.disconnectCurrent=c;
    $("dcAcct").textContent=c.ACCT_ID||"";
    $("dcName").textContent=c.NAME||"";
    $("dcFather").textContent=c.FATHER_NAME||"";
    $("dcAddress").textContent=c.ADDRESS||"";
    $("dcSupply").textContent=c.SUPPLY_TYPE||"";
    $("dcLoad").textContent=c.LOAD||"";
    $("dcMeterNo").textContent=displayOrUnavailable(getConsumerMeterNo(c));
    $("dcOutstanding").textContent=displayOrUnavailable(getConsumerOutstanding(c));
    $("disconnectConsumerCard").classList.remove("hidden");
    $("disconnectFormFields").classList.remove("hidden");
    setStatus("disconnectSearchStatus","Consumer found. Fill the disconnection details.","ok");
    captureDisconnectionGps();
  }catch(e){ setStatus("disconnectSearchStatus","Could not read local consumer data.","error"); }
}

function captureDisconnectionGps(){
  state.disconnectGps=null;
  if(!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(pos=>{
    state.disconnectGps={latitude:pos.coords.latitude,longitude:pos.coords.longitude,accuracy:pos.coords.accuracy};
  },()=>{}, {enableHighAccuracy:true,timeout:8000,maximumAge:60000});
}

function updateDisconnectionConditionalFields(){
  const status=$("disconnectStatus").value;
  $("disconnectPaymentModeWrap").classList.toggle("hidden",status!=="PAID");
  $("disconnectCommitDateWrap").classList.toggle("hidden",status!=="TIME GIVEN FOR PAYMENT");
  if(status!=="PAID") $("disconnectPaymentMode").value="";
  if(status!=="TIME GIVEN FOR PAYMENT") $("disconnectCommitDate").value="";
}

function prepareDisconnectionSave(){
  const c=state.disconnectCurrent;
  if(!c) return setStatus("disconnectSaveStatus","Search an Account ID first.","error");
  const status=$("disconnectStatus").value;
  const paymentMode=$("disconnectPaymentMode").value;
  const commitDate=$("disconnectCommitDate").value;
  const meter=$("disconnectMeterStatus").value;
  const reading=$("disconnectReading").value.trim();
  const mobile=$("disconnectMobile").value.replace(/\D/g,"");
  const house=$("disconnectHouseCondition").value;
  const remarks=$("disconnectRemarks").value.trim();
  if(!status) return setStatus("disconnectSaveStatus","Select disconnection status.","error");
  if(status==="PAID" && !paymentMode) return setStatus("disconnectSaveStatus","Select payment mode.","error");
  if(status==="TIME GIVEN FOR PAYMENT" && !commitDate) return setStatus("disconnectSaveStatus","Select committed payment date.","error");
  if(!meter) return setStatus("disconnectSaveStatus","Select current meter status.","error");
  if(mobile && !/^\d{10}$/.test(mobile)) return setStatus("disconnectSaveStatus","Enter a valid 10 digit mobile number.","error");
  if(!house) return setStatus("disconnectSaveStatus","Select house condition.","error");
  const record={
    activity_type:"DISCONNECTION",
    disconnection_id:makeActivityId("DISC"),
    user_id:state.userId,user_name:state.userName,
    account_id:c.ACCT_ID,consumer_name:c.NAME||"",father_name:c.FATHER_NAME||"",address:c.ADDRESS||"",supply_type:c.SUPPLY_TYPE||"",load:c.LOAD||"",sdo_code:c.SDO_CODE||"",
    disconnection_status:status,payment_mode:paymentMode,committed_payment_date:commitDate,
    outstanding:getConsumerOutstanding(c),
    meter_status:meter,current_reading:reading,mobile_number:mobile,house_condition:house,remarks,
    latitude:state.disconnectGps?state.disconnectGps.latitude:"",longitude:state.disconnectGps?state.disconnectGps.longitude:"",gps_accuracy:state.disconnectGps?state.disconnectGps.accuracy:"",
    created_at:new Date().toISOString(),upload_status:"PENDING"
  };
  openConfirmation("Confirm Disconnection",[
    ["Account ID",record.account_id],["Consumer",record.consumer_name],["Disconnection Status",record.disconnection_status],
    ["Payment Mode",record.payment_mode||"—"],["Committed Payment Date",record.committed_payment_date||"—"],["Meter Status",record.meter_status],
    ["Current Reading",record.current_reading||"—"],["Mobile",record.mobile_number||"—"],["House Condition",record.house_condition],["Remark",record.remarks||"—"]
  ],()=>saveActivityLocalRecord(record,"disconnectSaveStatus"));
}

function saveActivityLocalRecord(record,statusId){
  const type=String(record.activity_type||"").trim().toUpperCase();
  const storeName=type==="DISCONNECTION" ? "disconnections" : type==="RECHECK" ? "rechecks" : type==="PHONE_CALLING" ? "phoneCalls" : "records";
  return new Promise(resolve=>{
    const tx=state.db.transaction(storeName,"readwrite");
    tx.objectStore(storeName).add(record);
    tx.oncomplete=()=>{
      closeConfirmation(); resetDisconnectionForm(); showMainView("home");
      setStatus(statusId,"Disconnection saved locally. Ready for the next entry.","ok");
      updateCounts(); resolve(true);
    };
    tx.onerror=()=>{closeConfirmation();setStatus(statusId,"Could not save disconnection.","error");resolve(false);};
  });
}

function closeAllSurveyForms() {
  $("existingSearchCard").classList.add("hidden");
  $("consumerCard").classList.add("hidden");
  $("entryCard").classList.add("hidden");
  $("newSurveyCard").classList.add("hidden");
  resetRecheckForm();
  showMainView("home");
  $("searchStatus").textContent="";
  $("newSaveStatus").textContent="";
  state.current=null;
  resetExistingForm();
  resetNewSurveyForm();
  resetDisconnectionForm();
  resetPhoneCallingForm();
  closeActivitySearch();
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

  // Reset the confirmation controls every time a new confirmation opens.
  // Account Activity VIEW hides CONFIRM & SAVE; survey confirmation must restore it.
  $("confirmSaveBtn").classList.remove("hidden");
  $("cancelConfirmBtn").textContent="CANCEL";

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
  const natureOfSupply=$("natureOfSupply").value;
  const houseCondition=$("houseCondition").value;
  const consumerPaymentResponse=$("consumerPaymentResponse").value;
  const consumerPaymentDate=$("consumerPaymentDate").value;
  const meterCondition=$("meterCondition").value;
  const acInstalled=$("acInstalled").value;
  const mobile=$("mobile").value.replace(/\D/g,"");
  const remarks=$("existingRemarks").value.trim();
  const locked=$("houseLocked").checked;
  const refused=$("mobileRefused").checked;
  const status=surveyStatusForExisting();

  if (!village) return setStatus("saveStatus","Select village.","error");
  if (!natureOfSupply) return setStatus("saveStatus","Select Nature of Supply.","error");
  if (!houseCondition) return setStatus("saveStatus","Select House Condition.","error");
  if (!consumerPaymentResponse) {return setStatus("saveStatus","उपभोक्ता द्वारा भुगतान के संबंध में प्रतिक्रिया चुनें.","error");}
  if (consumerPaymentResponse === "कुछ दिन बाद जमा करेंगे" && !consumerPaymentDate) {return setStatus("saveStatus","भुगतान की संभावित दिनांक चुनें.","error");}
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
    nature_of_supply:natureOfSupply,
    house_condition:houseCondition,
    consumer_payment_response:consumerPaymentResponse,
    consumer_payment_date:consumerPaymentDate,
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
      ["Nature of Supply",record.nature_of_supply],
      ["House Condition",record.house_condition],
      ["Payment Response",record.consumer_payment_response],
      ["Expected Payment Date",record.consumer_payment_date || "—"],
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
    "newConnectionType","newName","newFather","newVillage","newAddress","newNatureOfSupply","newHouseCondition",
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
  const natureOfSupply=$("newNatureOfSupply").value;
  const houseCondition=$("newHouseCondition").value;
  const meterCondition=$("newMeterCondition").value;
  const connectedLoad=$("newConnectedLoad").value.trim();
  const ac=$("newAcInstalled").value;
  const remarks=$("newRemarks").value.trim();

  if (!connectionType) return setStatus("newSaveStatus","Select connection status.","error");
  if (!name) return setStatus("newSaveStatus","Enter consumer/occupant name.","error");
  if (!village) return setStatus("newSaveStatus","Select village.","error");
  if (!natureOfSupply) return setStatus("newSaveStatus","Select Nature of Supply.","error");
  if (!houseCondition) return setStatus("newSaveStatus","Select House Condition.","error");
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
    nature_of_supply:natureOfSupply,
    house_condition:houseCondition,
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
      ["Nature of Supply",record.nature_of_supply],
      ["House Condition",record.house_condition],
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

async function getAllUploadableRecords() {
  const [surveys,activities]=await Promise.all([getAllRecords(),getAllActivityRecords()]);
  return [...surveys,...activities];
}

async function uploadPending() {
  if (!state.sessionToken) return showLogin();

  const records = await getAllUploadableRecords();
  const pending = records.filter(r => String(r.upload_status||"PENDING").toUpperCase() === "PENDING");

  if (!pending.length) {
    return setStatus("uploadStatus", "No pending records to upload.", "ok");
  }

  setStatus("uploadStatus", `Uploading ${pending.length.toLocaleString()} records...`);
  const batchSize = 50;
  let uploaded = 0;

  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize);
    try {
      // Survey activity cards use activity_type="SURVEY" only for the local/activity-search UI.
      // The upload API classifies surveys by the absence of activity_type, so strip that UI-only
      // marker from survey payloads. Activity records keep their existing activity_type unchanged.
      const uploadBatch = batch.map(r => {
        if (String(r.activity_type || "").trim().toUpperCase() === "SURVEY") {
          const copy = Object.assign({}, r);
          delete copy.activity_type;
          return copy;
        }
        return r;
      });
      const response = await fetch(SERVER_URL, {
        method: "POST",
        headers: {"Content-Type": "text/plain;charset=utf-8"},
        body: JSON.stringify({action:"upload",token:state.sessionToken,records:uploadBatch})
      });
      const result = await response.json();
      if (!result.success) {
        if (result.code === "AUTH") { logout(); alert("Your login session has expired. Please login again."); return; }
        throw new Error(result.message || "Server rejected upload.");
      }
      for (const r of batch) await setOneRecordStatus(r.id,"UPLOADED",r);
      uploaded += batch.length;
      setStatus("uploadStatus", `Uploaded ${uploaded.toLocaleString()} / ${pending.length.toLocaleString()}...`, "ok");
    } catch (e) {
      setStatus("uploadStatus", `Upload stopped after ${uploaded.toLocaleString()} records. ${e && e.message ? e.message : "Upload failed."} Remaining records are still pending.`, "error");
      await updateCounts();
      return;
    }
  }
  await updateCounts();
  setStatus("uploadStatus", `Upload complete. ${uploaded.toLocaleString()} records uploaded.`, "ok");
}


async function syncUploadStatus() {
  if (!state.sessionToken) return showLogin();

  const records = await getAllUploadableRecords();
  if (!records.length) {
    return setStatus("syncStatus","No local records to check.","ok");
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
          records:batch.map(r=>{
            const type=String(r.activity_type||"").trim().toUpperCase();
            const item={
              user_id:r.user_id || state.userId || "",
              account_id:r.account_id || "",
              survey_id:r.survey_id || "",
              survey_type:r.survey_type || "EXISTING CONSUMER"
            };
            if(type==="DISCONNECTION" || type==="RECHECK" || type==="PHONE_CALLING") {
              item.activity_type=type;
              if(type==="DISCONNECTION") item.disconnection_id=r.disconnection_id || "";
              if(type==="RECHECK") item.recheck_id=r.recheck_id || "";
              if(type==="PHONE_CALLING") item.calling_id=r.calling_id || "";
            }
            return item;
          })
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
            await setOneRecordStatus(r.id,"UPLOADED",r);
            confirmed++;
          }
        } else if (r.upload_status === "UPLOADED") {
          await setOneRecordStatus(r.id,"PENDING",r);
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
  const type=String(r.activity_type || "").trim().toUpperCase();
  if(type==="DISCONNECTION") return "DISCONNECTION|"+String(r.disconnection_id || "").trim();
  if(type==="RECHECK") return "RECHECK|"+String(r.recheck_id || "").trim();
  if(type==="PHONE_CALLING") return "PHONE_CALLING|"+String(r.calling_id || "").trim();

  const user=String(r.user_id || state.userId || "").trim().toLowerCase();
  if (String(r.survey_type || "").trim().toUpperCase()==="CONNECTION NOT IN DATABASE") {
    return user+"|SURVEY|"+String(r.survey_id || "").trim();
  }
  return user+"|ACCOUNT|"+String(r.account_id || "").trim();
}


function storeNameForActivity(record) {
  const type=String(record && record.activity_type || "").trim().toUpperCase();
  if(type==="DISCONNECTION") return "disconnections";
  if(type==="RECHECK") return "rechecks";
  if(type==="PHONE_CALLING") return "phoneCalls";
  return "records";
}

function setOneRecordStatus(id,status,recordHint) {
  return new Promise(resolve=>{
    const storeName=storeNameForActivity(recordHint);
    const tx=state.db.transaction(storeName,"readwrite");
    const store=tx.objectStore(storeName);
    const req=store.get(id);
    req.onsuccess=()=>{
      const record=req.result;
      if (!record) return;
      record.upload_status=status;
      if(status==="UPLOADED" && String(record.activity_type||"").trim()){
        record.last_updated_by_user_id=state.userId||"";
        record.last_updated_by_name=state.userName||state.userId||"";
        record.last_updated_at=new Date().toISOString();
      }
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
  const surveys=await getAllRecords();
  const disconnections=await getAllFromStore("disconnections");
  const rechecks=await getAllFromStore("rechecks");
  const phoneCalls=await getAllFromStore("phoneCalls");

  const today=v151LocalDateKey(new Date());
  const countToday=list=>list.filter(r=>v151LocalDateKey(r.created_at)===today).length;
  const pending=list=>list.filter(r=>String(r.upload_status||"PENDING").toUpperCase()!=="UPLOADED").length;

  $("collectionSurveyToday").textContent=countToday(surveys).toLocaleString("en-IN");
  $("collectionDisconnectionToday").textContent=countToday(disconnections).toLocaleString("en-IN");
  $("collectionRecheckToday").textContent=countToday(rechecks).toLocaleString("en-IN");
  $("collectionPhoneToday").textContent=countToday(phoneCalls).toLocaleString("en-IN");

  $("collectionTotalToday").textContent=(countToday(surveys)+countToday(disconnections)+countToday(rechecks)+countToday(phoneCalls)).toLocaleString("en-IN");
  $("collectionPendingToday").textContent=(pending(surveys)+pending(disconnections)+pending(rechecks)+pending(phoneCalls)).toLocaleString("en-IN");

  $("collectionSurveyTotal").textContent=surveys.length.toLocaleString("en-IN");
  $("collectionDisconnectionTotal").textContent=disconnections.length.toLocaleString("en-IN");
  $("collectionRecheckTotal").textContent=rechecks.length.toLocaleString("en-IN");
  $("collectionPhoneTotal").textContent=phoneCalls.length.toLocaleString("en-IN");

  $("collectionDateLabel").textContent=new Intl.DateTimeFormat("en-IN",{timeZone:"Asia/Kolkata",day:"2-digit",month:"short",year:"numeric"}).format(new Date());
}
function v151InitMyCollection() {
  const btn=$("refreshCollectionBtn");
  if(btn) btn.addEventListener("click",v151RefreshMyCollection);
  v151RefreshMyCollection();
}

async function updateCounts() {
  if (!state.db) return;
  const [surveys,disconnections,rechecks,phoneCalls]=await Promise.all([
    getAllRecords(),
    getAllFromStore("disconnections"),
    getAllFromStore("rechecks"),
    getAllFromStore("phoneCalls")
  ]);
  const groups=[
    ["survey",surveys],
    ["disconnection",disconnections],
    ["recheck",rechecks],
    ["phone",phoneCalls]
  ];
  let savedTotal=0,pendingTotal=0;
  for(const [key,list] of groups){
    const pending=list.filter(r=>String(r.upload_status||"PENDING").toUpperCase()==="PENDING").length;
    savedTotal+=list.length;
    pendingTotal+=pending;
    const savedEl=$("upload"+key+"Saved");
    const pendingEl=$("upload"+key+"Pending");
    if(savedEl) savedEl.textContent=list.length.toLocaleString("en-IN");
    if(pendingEl) pendingEl.textContent=pending.toLocaleString("en-IN");
  }
  $("savedCount").textContent=savedTotal.toLocaleString("en-IN");
  $("pendingCount").textContent=pendingTotal.toLocaleString("en-IN");
}


async function exportData() {
  const records = await getAllRecords();
  if (!records.length) return alert("No locally saved records.");

  const headers = ["Survey Type","Survey Status","Connection Type","Survey ID","User ID","User Name","Account ID","Consumer Name","Father/Husband","Address","Supply Type","Load","SDO Code","Village","Meter Condition","AC Installed","Mobile Number","House Locked","Mobile Refused","Meter Installed","Meter Number","Current Reading","Outstanding","Connected Load","Nature of Supply","House Condition","Consumer Payment Response","Consumer Payment Date","Remarks","Created At","Upload Status"];
  const rows = records.map(r => [r.survey_type,r.survey_status,r.connection_type,r.survey_id,r.user_id,r.user_name,r.account_id,r.consumer_name,r.father_name,r.address,r.supply_type,r.load,r.sdo_code,r.village,r.meter_condition,r.ac_installed,r.mobile_number,r.house_locked,r.mobile_refused,r.meter_installed,r.meter_number,r.current_reading,r.outstanding,r.connected_load,r.nature_of_supply,r.house_condition,r.consumer_payment_response||"",r.consumer_payment_date||"",r.remarks,r.created_at,r.upload_status]);
  const csv = [headers,...rows].map(row => row.map(v => `"${String(v ?? "").replaceAll('"','""')}"`).join(",")).join("\n");

  const blob = new Blob(["\ufeff"+csv], {type:"text/csv;charset=utf-8"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "mobile_collection_data.csv"; a.click();
  URL.revokeObjectURL(url);
}




let dashboardHasLoaded = false;

function resetDashboardDisplay() {
  dashboardHasLoaded = false;
  const ids = [
    "sumSurveyTotal","sumMeterOk","sumMeterDamaged","sumMeterNI","sumAcYes","sumAcNo",
    "discTotal","discPaid","discDisconnected","discTimeGiven","discOutstanding",
    "recheckTotal","recheckConnected","recheckDisconnected","recheckLocked","recheckPayment","recheckOutstanding",
    "phoneTotal","phoneOutstanding"
  ];
  ids.forEach(id => { if($(id)) $(id).textContent = "0"; });
  if($("discOutstanding")) $("discOutstanding").textContent = "₹0";
  if($("recheckOutstanding")) $("recheckOutstanding").textContent = "₹0";
  if($("dashboardPhoneOutstanding")) $("dashboardPhoneOutstanding").textContent = "₹0";
  if($("substationReport")) $("substationReport").innerHTML = '<div class="dashboard-empty-state">Apply a filter to load dashboard data.</div>';
  if($("userReport")) $("userReport").innerHTML = '<div class="dashboard-empty-state">Apply a filter to load dashboard data.</div>';
  if($("multiUserReport")) $("multiUserReport").innerHTML = "";
  if($("phoneResponses")) $("phoneResponses").innerHTML = '<div class="status">No response data available.</div>';
}

async function loadDashboardFilters() {
  try {
    const result = await adminRequest("dashboard_filters");
    if (!result.success) return;

    const villageSelect = $("dashVillageFilter");
    const substationSelect = $("dashSubstationFilter");

    villageSelect.innerHTML = '<option value="">All Villages</option>';
    if(substationSelect) substationSelect.innerHTML = '<option value="">All Substations</option>';

    // Village options are already bundled/cached locally. Do not read the
    // complete Mobile Data sheet merely to populate the filter list.
    let villages=[];
    try {
      const cached=localStorage.getItem("kuthondVillageData");
      if(cached) villages=JSON.parse(cached);
    } catch(e) {}

    if(!Array.isArray(villages) || !villages.length){
      try {
        const response=await fetch("village-data.json",{cache:"no-store"});
        if(response.ok) villages=await response.json();
      } catch(e) {}
    }

    for (const v of villages) {
      const value=String(v||"").trim();
      if(!value) continue;
      villageSelect.insertAdjacentHTML("beforeend",
        `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`);
    }

    if(substationSelect){
      for(const s of (result.substations||[])){
        substationSelect.insertAdjacentHTML("beforeend",
          `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`);
      }
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
      village: $("dashVillageFilter").value,
      substation: $("dashSubstationFilter").value
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
      "AC Installed","Mobile Number","Created At","Nature of Supply","House Condition"
    ];

    const csvRows = [headers].concat(result.rows.map(r => [
      r.user_id,r.user_name,r.account_id,r.consumer_name,r.father_name,
      r.address,r.supply_type,r.load,r.sdo_code,r.village,r.meter_condition,
      r.ac_installed,r.mobile_number,r.created_at,r.nature_of_supply,r.house_condition
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
  $("dashVillageFilter").value = "";
  $("dashSubstationFilter").value = "";
}


async function openDashboard() {
  if (!state.sessionToken) return showLogin();
  showMainView("dashboardCard");
  resetDashboardDisplay();
  // Opening the dashboard must not request dashboard/activity data.
  // Only the lightweight filter lists are prepared here.
  await loadDashboardFilters();
}

function formatDashboardMoney(value){
  const n=Number(value||0);
  return "₹"+n.toLocaleString("en-IN",{maximumFractionDigits:2});
}

function renderSubstationReport(items) {
  const box=$("substationReport");
  if(!box) return;
  if(!items || !items.length){
    box.innerHTML='<div class="dashboard-empty-state">No substation data available for the selected filter.</div>';
    return;
  }
  let html='<div class="substation-table"><div class="substation-row substation-head"><div>Substation</div><div>Survey</div><div>Disconnection</div><div>Recheck</div><div>Phone</div><div>Total</div></div>';
  for(const x of items){
    html+=`<div class="substation-row"><div data-label="Substation">${escapeHtml(x.name||"Unassigned")}</div><div data-label="Survey">${Number(x.survey||0).toLocaleString()}</div><div data-label="Disconnection">${Number(x.disconnection||0).toLocaleString()}</div><div data-label="Recheck">${Number(x.recheck||0).toLocaleString()}</div><div data-label="Phone">${Number(x.phone_calling||0).toLocaleString()}</div><div data-label="Total"><b>${Number(x.total||0).toLocaleString()}</b></div></div>`;
  }
  html+='</div>';
  box.innerHTML=html;
}

function renderUserTable(items, targetId, multi=false) {
  const box=$(targetId);
  if(!box) return;
  if(!items || !items.length){
    box.innerHTML=multi ? '<div class="dashboard-empty-state">No multi-substation users in the selected filter.</div>' : '<div class="dashboard-empty-state">No single-substation users in the selected filter.</div>';
    return;
  }
  let html='<div class="dashboard-table-wrap"><div class="user-row user-head"><div>User</div><div>Assigned Substation(s)</div><div>Survey</div><div>Disconnection</div><div>Recheck</div><div>Phone</div><div>Total</div></div>';
  for(const x of items){
    html+=`<div class="user-row"><div data-label="User">${escapeHtml(x.name||x.user_id||"Unknown")}</div><div data-label="Assigned Substation(s)">${escapeHtml(x.substation||"Unassigned")}</div><div data-label="Survey">${Number(x.survey||0).toLocaleString()}</div><div data-label="Disconnection">${Number(x.disconnection||0).toLocaleString()}</div><div data-label="Recheck">${Number(x.recheck||0).toLocaleString()}</div><div data-label="Phone">${Number(x.phone_calling||0).toLocaleString()}</div><div data-label="Total"><b>${Number(x.total||0).toLocaleString()}</b></div></div>`;
  }
  html+='</div>';
  box.innerHTML=html;
}

function renderUserReport(items){
  const single=(items||[]).filter(x=>!x.multi_substation);
  const multi=(items||[]).filter(x=>x.multi_substation);
  renderUserTable(single,"userReport",false);
  const multiBox=$("multiUserReport");
  if(!multiBox) return;
  if(!multi.length){
    multiBox.innerHTML='';
    return;
  }
  multiBox.innerHTML='<h4 class="dashboard-table-title">Multi-Substation Users</h4>';
  const table=document.createElement("div");
  table.id="multiUserReportTable";
  multiBox.appendChild(table);
  renderUserTable(multi,"multiUserReportTable",true);
}

function renderPhoneResponses(items){
  const box=$("phoneResponses");
  if(!box) return;
  if(!items || !items.length){
    box.innerHTML='<div class="status">No response data available.</div>';
    return;
  }
  box.innerHTML=items.map(x=>`<div><b>${Number(x.count||0).toLocaleString()}</b><span>${escapeHtml(x.name||"Unknown")}</span></div>`).join("");
}

async function loadDashboard() {
  dashboardHasLoaded = true;
  $("sumSurveyTotal").textContent="...";
  $("sumMeterOk").textContent="...";
  $("sumMeterDamaged").textContent="...";
  $("sumMeterNI").textContent="...";
  $("sumAcYes").textContent="...";
  $("sumAcNo").textContent="...";
  $("discTotal").textContent="...";
  $("discPaid").textContent="...";
  $("discDisconnected").textContent="...";
  $("discTimeGiven").textContent="...";
  $("discOutstanding").textContent="...";
  $("recheckTotal").textContent="...";
  $("recheckConnected").textContent="...";
  $("recheckDisconnected").textContent="...";
  $("recheckLocked").textContent="...";
  $("recheckPayment").textContent="...";
  $("recheckOutstanding").textContent="...";
  $("phoneTotal").textContent="...";
  $("dashboardPhoneOutstanding").textContent="...";

  try {
    const result = await adminRequest("dashboard", {
      from_date: $("dashFromDate").value,
      to_date: $("dashToDate").value,
      village: $("dashVillageFilter").value,
      substation: $("dashSubstationFilter").value
    });

    if (!result.success) {
      $("substationReport").innerHTML='<div class="dashboard-empty-state">'+escapeHtml(result.message || "Could not load dashboard.")+'</div>';
      $("userReport").innerHTML='<div class="dashboard-empty-state">Could not load dashboard.</div>';
      $("multiUserReport").innerHTML='';
      return;
    }

    const s=result.survey_summary||{};
    $("sumSurveyTotal").textContent=Number(s.total||0).toLocaleString();
    $("sumMeterOk").textContent=Number(s.meter_ok||0).toLocaleString();
    $("sumMeterDamaged").textContent=Number(s.meter_damaged||0).toLocaleString();
    $("sumMeterNI").textContent=Number(s.meter_not_installed||0).toLocaleString();
    $("sumAcYes").textContent=Number(s.ac_yes||0).toLocaleString();
    $("sumAcNo").textContent=Number(s.ac_no||0).toLocaleString();

    const d=result.disconnection_summary||{};
    $("discTotal").textContent=Number(d.total||0).toLocaleString();
    $("discPaid").textContent=Number(d.paid||0).toLocaleString();
    $("discDisconnected").textContent=Number(d.disconnected||0).toLocaleString();
    $("discTimeGiven").textContent=Number(d.time_given||0).toLocaleString();
    $("discOutstanding").textContent=formatDashboardMoney(d.outstanding);

    const r=result.recheck_summary||{};
    $("recheckTotal").textContent=Number(r.total||0).toLocaleString();
    $("recheckConnected").textContent=Number(r.found_connected||0).toLocaleString();
    $("recheckDisconnected").textContent=Number(r.still_disconnected||0).toLocaleString();
    $("recheckLocked").textContent=Number(r.house_locked||0).toLocaleString();
    $("recheckPayment").textContent=Number(r.payment_made||0).toLocaleString();
    $("recheckOutstanding").textContent=formatDashboardMoney(r.outstanding);

    const ph=result.phone_calling_summary||{};
    $("phoneTotal").textContent=Number(ph.total||0).toLocaleString();
    $("dashboardPhoneOutstanding").textContent=formatDashboardMoney(ph.outstanding);
    renderPhoneResponses(ph.responses||[]);

    renderSubstationReport(result.substation_wise||[]);
    renderUserReport(result.user_wise||[]);
  } catch(e) {
    dashboardHasLoaded = false;
    $("substationReport").innerHTML='<div class="dashboard-empty-state">Could not connect to server.</div>';
    $("userReport").innerHTML='<div class="dashboard-empty-state">Could not connect to server.</div>';
    $("multiUserReport").innerHTML='';
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
  await loadAdminMasterLists();
  await loadUsers();
}

async function loadAdminMasterLists() {
  const subBox=$("newUserSubstations");
  const roleSelect=$("newUserRole");
  if(!subBox || !roleSelect) return false;

  subBox.textContent="Loading substations...";
  roleSelect.innerHTML='<option value="">Select role</option>';

  try {
    const result=await adminRequest("master_lists");
    if(!result.success){
      subBox.textContent=result.message || "Could not load substations.";
      return false;
    }

    const substations=Array.isArray(result.substations) ? result.substations : [];
    if(!substations.length){
      subBox.textContent="No substations found in Master Lists.";
    }else{
      subBox.innerHTML=substations.map((name,i)=>
        `<label class="admin-checkbox-item"><input type="checkbox" class="new-user-substation" value="${escapeHtml(name)}"><span>${escapeHtml(name)}</span></label>`
      ).join("");
    }

    for(const role of (result.roles||[])){
      const option=document.createElement("option");
      option.value=role;
      option.textContent=role;
      roleSelect.appendChild(option);
    }
    return true;
  } catch(e) {
    subBox.textContent="Could not connect to server.";
    return false;
  }
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
      `<div class="user-row user-head"><div>User ID</div><div>Name</div><div>Substation(s)</div><div>Role</div><div>Status</div><div>Action</div></div>`
    ];

    for (const u of result.users) {
      const action = u.active === "YES"
        ? `<button class="small-btn danger-btn" onclick="toggleUser('${escapeHtml(u.user_id)}','NO')">DISABLE</button>`
        : `<button class="small-btn" onclick="toggleUser('${escapeHtml(u.user_id)}','YES')">ENABLE</button>`;
      rows.push(
        `<div class="user-row"><div data-label="User ID">${escapeHtml(u.user_id)}</div><div data-label="Name">${escapeHtml(u.user_name)}</div><div data-label="Substation(s)" class="admin-user-substation">${escapeHtml(u.substation || "Unassigned")}</div><div data-label="Role">${escapeHtml(u.role || "")}</div><div data-label="Status">${escapeHtml(u.active)}</div><div data-label="Action">${action}</div></div>`
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
  const role = $("newUserRole").value.trim();
  const substations=[...document.querySelectorAll(".new-user-substation:checked")].map(el=>el.value);

  if (!userId || !userName || !password) {
    return setStatus("adminStatus", "Enter User ID, User Name and Password.", "error");
  }
  if (!substations.length) {
    return setStatus("adminStatus", "Select at least one substation.", "error");
  }
  if (!role) {
    return setStatus("adminStatus", "Select a role.", "error");
  }

  setStatus("adminStatus", "Creating user...");
  const result = await adminRequest("create_user", {
    user_id:userId,
    user_name:userName,
    password:password,
    substations:substations,
    role:role
  });

  if (!result.success) return setStatus("adminStatus", result.message || "Could not create user.", "error");

  $("newUserId").value = "";
  $("newUserName").value = "";
  $("newUserPassword").value = "";
  $("newUserRole").value = "";
  document.querySelectorAll(".new-user-substation").forEach(el=>el.checked=false);
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
$("disconnectionModuleBtn").addEventListener("click", openDisconnection);
$("recheckModuleBtn").addEventListener("click", openRecheck);
$("recheckSearchBtn").addEventListener("click", searchRecheckConsumer);
$("recheckAccountId").addEventListener("keydown", e => { if(e.key === "Enter") searchRecheckConsumer(); });
$("recheckStatus").addEventListener("change", updateRecheckConditionalFields);
$("recheckSubmitBtn").addEventListener("click", prepareRecheckSave);
$("recheckBackBtn").addEventListener("click", goHome);
$("phoneCallingModuleBtn").addEventListener("click", openPhoneCalling);
$("phoneSearchBtn").addEventListener("click", searchPhoneConsumer);
$("phoneAccountId").addEventListener("keydown", e => { if(e.key === "Enter") searchPhoneConsumer(); });
$("phoneResponse").addEventListener("change", updatePhoneConditionalFields);
$("phoneMobile").addEventListener("input", ()=>{
  $("phoneCallBtn").disabled=!/^\d{10}$/.test($("phoneMobile").value.trim());
});
$("phoneCallBtn").addEventListener("click", callPhoneNumber);
$("phoneSubmitBtn").addEventListener("click", preparePhoneCallSave);
$("phoneBackBtn").addEventListener("click", goHome);
$("accountActivityModuleBtn").addEventListener("click", openActivitySearch);
$("activityBackBtn").addEventListener("click", goHome);
$("disconnectSearchBtn").addEventListener("click", searchDisconnectionConsumer);
$("disconnectAccountId").addEventListener("keydown", e => { if(e.key === "Enter") searchDisconnectionConsumer(); });
$("disconnectStatus").addEventListener("change", updateDisconnectionConditionalFields);
$("disconnectSubmitBtn").addEventListener("click", prepareDisconnectionSave);
$("disconnectBackBtn").addEventListener("click", goHome);
$("activitySearchBtn").addEventListener("click", searchAccountActivity);
$("activityAccountId").addEventListener("keydown", e => { if(e.key === "Enter") searchAccountActivity(); });
$("findCorrectionBtn").addEventListener("click", findCorrectionRecord);
$("saveCorrectionBtn").addEventListener("click", saveCorrection);
$("correctionAccountId").addEventListener("keydown", e => {
  if (e.key === "Enter") findCorrectionRecord();
});
$("refreshDashboardBtn").addEventListener("click", () => {
  if (dashboardHasLoaded) loadDashboard();
});
$("todayDashboardBtn").addEventListener("click", setDashboardToday);
$("applyDashboardFilterBtn").addEventListener("click", loadDashboard);
$("clearDashboardFilterBtn").addEventListener("click", () => {
  $("dashFromDate").value="";
  $("dashToDate").value="";
  $("dashVillageFilter").value="";
  $("dashSubstationFilter").value="";
  resetDashboardDisplay();
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
$("consumerPaymentResponse").addEventListener("change", () => {
  const response = $("consumerPaymentResponse").value;
  const wrap = $("consumerPaymentDateWrap");

  if (response === "कुछ दिन बाद जमा करेंगे") {
    wrap.classList.remove("hidden");
  } else {
    wrap.classList.add("hidden");
    $("consumerPaymentDate").value = "";
  }
});


v151InitMyCollection();
init();


async function v151ExportLocalData() {
  const surveys=await getAllRecords();
  const disconnections=await getAllFromStore("disconnections");
  const rechecks=await getAllFromStore("rechecks");
  const phoneCalls=await getAllFromStore("phoneCalls");
  const files=[];

  if(surveys.length) files.push({name:"Door_to_Door_Survey",headers:["Survey Type","Survey Status","Connection Type","Survey ID","User ID","User Name","Account ID","Consumer Name","Father/Husband","Address","Supply Type","Load","SDO Code","Village","Nature of Supply","House Condition","Consumer Payment Response","Consumer Payment Date","Meter Condition","AC Installed","Mobile Number","House Locked","Mobile Refused","Meter Installed","Meter Number","Current Reading","Outstanding","Connected Load","Remarks","Created At","Upload Status"],rows:surveys.map(r=>[r.survey_type||"",r.survey_status||"",r.connection_type||"",r.survey_id||"",r.user_id||"",r.user_name||"",r.account_id||"",r.consumer_name||"",r.father_name||"",r.address||"",r.supply_type||"",r.load||"",r.sdo_code||"",r.village||"",r.nature_of_supply||"",r.house_condition||"",r.consumer_payment_response||"",r.consumer_payment_date||"",r.meter_condition||"",r.ac_installed||"",r.mobile_number||"",r.house_locked||"",r.mobile_refused||"",r.meter_installed||"",r.meter_number||"",r.current_reading||"",r.outstanding||"",r.connected_load||"",r.remarks||"",v1511ISTDateTime(r.created_at)||"",r.upload_status||"PENDING"]) });

  if(disconnections.length) files.push({name:"Disconnections",headers:["Disconnection ID","User ID","User Name","Account ID","Consumer Name","Father/Husband","Address","Supply Type","Load","SDO Code","Disconnection Status","Payment Mode","Committed Payment Date","Meter Status","Current Reading","Mobile Number","House Condition","Total Outstanding","Remarks","Latitude","Longitude","GPS Accuracy","Created At","Last Updated By User ID","Last Updated By Name","Last Updated At","Upload Status"],rows:disconnections.map(r=>[r.disconnection_id||"",r.user_id||"",r.user_name||"",r.account_id||"",r.consumer_name||"",r.father_name||"",r.address||"",r.supply_type||"",r.load||"",r.sdo_code||"",r.disconnection_status||"",r.payment_mode||"",r.committed_payment_date||"",r.meter_status||"",r.current_reading||"",r.mobile_number||"",r.house_condition||"",r.outstanding||"",r.remarks||"",r.latitude||"",r.longitude||"",r.gps_accuracy||"",v1511ISTDateTime(r.created_at)||"",r.last_updated_by_user_id||"",r.last_updated_by_name||"",v1511ISTDateTime(r.last_updated_at)||"",r.upload_status||"PENDING"]) });
  if(rechecks.length) files.push({name:"Rechecking",headers:["Recheck ID","User ID","User Name","Account ID","Consumer Name","Father/Husband","Address","Supply Type","Load","SDO Code","Total Outstanding","Present Status","Payment Mode","Payment Date","Meter Status","Current Reading","Mobile Number","Remarks","Latitude","Longitude","GPS Accuracy","Created At","Last Updated By User ID","Last Updated By Name","Last Updated At","Upload Status"],rows:rechecks.map(r=>[r.recheck_id||"",r.user_id||"",r.user_name||"",r.account_id||"",r.consumer_name||"",r.father_name||"",r.address||"",r.supply_type||"",r.load||"",r.sdo_code||"",r.outstanding||"",r.present_status||"",r.payment_mode||"",r.payment_date||"",r.meter_status||"",r.current_reading||"",r.mobile_number||"",r.remarks||"",r.latitude||"",r.longitude||"",r.gps_accuracy||"",v1511ISTDateTime(r.created_at)||"",r.last_updated_by_user_id||"",r.last_updated_by_name||"",v1511ISTDateTime(r.last_updated_at)||"",r.upload_status||"PENDING"]) });
  if(phoneCalls.length) files.push({name:"Phone_Calling",headers:["Calling ID","User ID","User Name","Account ID","Consumer Name","Father/Husband","Address","Supply Type","Load","SDO Code","Mobile Number","Call Response","Committed Payment Date","Remarks","Created At","Total Outstanding","Last Updated By User ID","Last Updated By Name","Last Updated At","Upload Status"],rows:phoneCalls.map(r=>[r.calling_id||"",r.user_id||"",r.user_name||"",r.account_id||"",r.consumer_name||"",r.father_name||"",r.address||"",r.supply_type||"",r.load||"",r.sdo_code||"",r.mobile_number||"",r.call_response||"",r.committed_payment_date||r.payment_date||"",r.remarks||"",v1511ISTDateTime(r.created_at)||"",r.outstanding||"",r.last_updated_by_user_id||"",r.last_updated_by_name||"",v1511ISTDateTime(r.last_updated_at)||"",r.upload_status||"PENDING"]) });

  if(!files.length){ alert("No local data to export."); return; }
  const d=new Date(), pad=n=>String(n).padStart(2,"0"), stamp=`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  const downloadCsv=(file,delay)=>setTimeout(()=>{
    const csv=[file.headers,...file.rows].map(row=>row.map(v=>`"${String(v==null?"":v).replace(/"/g,'""')}"`).join(",")).join("\r\n");
    const blob=new Blob(["\ufeff"+csv],{type:"text/csv;charset=utf-8"});
    const url=URL.createObjectURL(blob), a=document.createElement("a");
    a.href=url; a.download=`${file.name}_${stamp}.csv`; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  },delay);
  files.forEach((file,i)=>downloadCsv(file,i*700));
}
