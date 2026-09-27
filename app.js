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
  activeMasterStore: "masterConsumers",
  masterCount: 0,
  masterMeta: null,

  lookup: new Map(),
  meterLookup: new Map(),
  normalizedLookup: new Map(),
  sessionToken: localStorage.getItem("consumerMobileAuthToken") || "",
  userId: localStorage.getItem("consumerMobileUserId") || "",
  userName: localStorage.getItem("consumerMobileUserName") || "",
  isAdmin: localStorage.getItem("consumerMobileIsAdmin") === "YES",
  division: localStorage.getItem("consumerMobileDivision") || "",
  subdivision: localStorage.getItem("consumerMobileSubdivision") || "",
  substation: localStorage.getItem("consumerMobileSubstation") || "",
  role: localStorage.getItem("consumerMobileRole") || "",

  duplicateInfo: null,
  disconnectCurrent: null,
  doorSurveyGps: null,
  disconnectGps: null,
  phoneCurrent: null
};

const $ = id => document.getElementById(id);


/* =========================================================
   GLOBAL PROCESSING / LOADING INDICATOR
   ========================================================= */

let globalLoadingCount = 0;

function showGlobalLoading(
  title="Processing...",
  message="Please wait, your request is being processed."
){

  const overlay=$("globalLoadingOverlay");

  if(!overlay) return;

  globalLoadingCount++;

  $("globalLoadingTitle").textContent=title;
  $("globalLoadingMessage").textContent=message;

  overlay.classList.remove("hidden");
  overlay.setAttribute("aria-hidden","false");
}


function updateGlobalLoading(title,message){

  const overlay=$("globalLoadingOverlay");

  if(!overlay) return;

  if(title){
    $("globalLoadingTitle").textContent=title;
  }

  if(message){
    $("globalLoadingMessage").textContent=message;
  }
}


function hideGlobalLoading(){

  const overlay=$("globalLoadingOverlay");

  if(!overlay) return;

  globalLoadingCount=Math.max(
    0,
    globalLoadingCount-1
  );

  if(globalLoadingCount>0) return;

  overlay.classList.add("hidden");
  overlay.setAttribute("aria-hidden","true");
}



/* =========================================================
   LANGUAGE SWITCH
   English <-> Hindi

   Important:
   - UI text only
   - Consumer/master data is never translated
   - Original bilingual text is preserved
   ========================================================= */

const LANGUAGE_STORAGE_KEY = "kuthondFieldWorkLanguage";

let currentLanguage =
  localStorage.getItem(LANGUAGE_STORAGE_KEY) === "hi"
    ? "hi"
    : "en";


/*
 * Explicit special cases.
 *
 * These are strings where normal parenthesis parsing
 * would be ambiguous.
 */
const LANGUAGE_TEXT_OVERRIDES = {

  "Logged in as(लॉगिन उपयोगकर्ता):": {
    en: "Logged in as:",
    hi: "लॉगिन उपयोगकर्ता:"
  },

  "Language / भाषा:": {
    en: "Language:",
    hi: "भाषा:"
  },

  "Remark(टिप्पणी)(चोरी या स्टोर रीडिंग की संभावना)": {
    en: "Remark (Possibility of Theft or Stored Reading)",
    hi: "टिप्पणी (चोरी या स्टोर रीडिंग की संभावना)"
  },

  "Remarks(टिप्पणी)(चोरी या स्टोर रीडिंग की संभावना)": {
    en: "Remarks (Possibility of Theft or Stored Reading)",
    hi: "टिप्पणी (चोरी या स्टोर रीडिंग की संभावना)"
  }

};


/*
 * ---------------------------------------------------------
 * Parse bilingual text safely.
 *
 * We use the LAST top-level parenthesis group as the
 * Hindi translation.
 *
 * Therefore:
 *
 * Luxury (Rich) House(शानदार/आलीशान घर)
 *
 * becomes:
 *
 * English = Luxury (Rich) House
 * Hindi   = शानदार/आलीशान घर
 *
 * Nested parentheses are supported.
 * ---------------------------------------------------------
 */
function parseBilingualText(text){

  const value=String(text||"").trim();

  if(!value) return null;


  /*
   * Explicit overrides first.
   */
  if(LANGUAGE_TEXT_OVERRIDES[value]){

    return {
      english:LANGUAGE_TEXT_OVERRIDES[value].en,
      hindi:LANGUAGE_TEXT_OVERRIDES[value].hi
    };

  }


  /*
   * Find all TOP-LEVEL parenthesis groups.
   */
  const groups=[];

  let depth=0;
  let start=-1;

  for(let i=0;i<value.length;i++){

    const ch=value[i];

    if(ch==="("){

      if(depth===0){
        start=i;
      }

      depth++;

    }else if(ch===")"){

      if(depth>0){
        depth--;

        if(depth===0 && start>=0){

          groups.push({
            start,
            end:i
          });

          start=-1;
        }
      }

    }

  }


  /*
   * Unbalanced parentheses = do not guess.
   */
  if(depth!==0 || !groups.length){
    return null;
  }


  /*
   * The final TOP-LEVEL group must contain Hindi.
   */
  const last=groups[groups.length-1];

  const english=value
    .slice(0,last.start)
    .trim();

  const hindi=value
    .slice(last.start+1,last.end)
    .trim();

  const suffix=value
    .slice(last.end+1)
    .trim();


  if(!english || !hindi){
    return null;
  }


  /*
   * Hindi translation must actually contain Devanagari.
   */
  if(!/[\u0900-\u097F]/.test(hindi)){
    return null;
  }


  return {
    english:english + suffix,
    hindi:hindi + suffix
  };

}


/*
 * ---------------------------------------------------------
 * Original text storage.
 *
 * WeakMap is used so the original DOM text node is kept
 * without adding data attributes to the actual page.
 * ---------------------------------------------------------
 */
const languageTextNodes = new WeakMap();


/*
 * Store original bilingual text for a text node.
 */
function rememberLanguageTextNode(node){

  if(!node || node.nodeType!==Node.TEXT_NODE){
    return;
  }

  if(languageTextNodes.has(node)){
    return;
  }

  const text=node.nodeValue || "";

  if(!text.trim()){
    return;
  }

  const parsed=parseBilingualText(text);

  if(!parsed){
    return;
  }

  languageTextNodes.set(node,text);

}


/*
 * ---------------------------------------------------------
 * Protect actual data.
 *
 * These fields contain consumer/master values and must
 * NEVER be language translated.
 * ---------------------------------------------------------
 */
function isConsumerDataElement(el){

  if(!el) return true;

  if(
    el.matches(
      "#loggedUserName," +
      "#dAcct,#dSdoCode,#dName,#dFather,#dAddress," +
      "#dFeededVillage,#dSupply,#dLoad,#dConnectionStatus," +
      "#dMeterNo,#dCurrentReading,#dOutstanding," +
      "#dLastPayDate,#dLastPayAmount," +

      "#dcAcct,#dcSdoCode,#dcName,#dcFather,#dcAddress," +
      "#dcFeededVillage,#dcSupply,#dcLoad,#dcMeterNo," +
      "#dcOutstanding,#dcLastPayDate,#dcLastPayAmount," +

      "#rcAcct,#rcSdoCode,#rcName,#rcFather,#rcAddress," +
      "#rcFeededVillage,#rcSupply,#rcLoad,#rcMeterNo," +
      "#rcOutstanding,#rcLastPayDate,#rcLastPayAmount," +

      "#phoneAcct,#phoneSdoCode,#phoneName,#phoneFather," +
      "#phoneAddress,#phoneFeededVillage,#phoneSupply," +
      "#phoneLoad,#phoneOutstanding,#phoneLastPayDate," +
      "#phoneLastPayAmount"
    )
  ){
    return true;
  }

  /*
   * Also respect explicit protection attributes if
   * they are used elsewhere in the app.
   */
  if(
    el.matches(
      "[data-consumer-data],[data-master-data]"
    )
  ){
    return true;
  }

  return false;
}


/*
 * ---------------------------------------------------------
 * Discover bilingual text nodes.
 *
 * Unlike the old version, this does NOT skip a button just
 * because the button contains <small>.
 * ---------------------------------------------------------
 */
function prepareLanguageTextNodes(){

  const walker=document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    null
  );

  while(walker.nextNode()){

    const node=walker.currentNode;
    const parent=node.parentElement;

    if(!parent) continue;


    /*
     * Never process script/style.
     */
    if(
      parent.closest("script,style,noscript")
    ){
      continue;
    }


    /*
     * Never process actual form values.
     */
    if(
      parent.closest(
        "input,textarea"
      )
    ){
      continue;
    }


    /*
     * Option text is handled separately.
     */
    if(
      parent.closest("option")
    ){
      continue;
    }


    /*
     * Never process consumer/master values.
     */
    if(isConsumerDataElement(parent)){
      continue;
    }


    rememberLanguageTextNode(node);

  }

}


/*
 * ---------------------------------------------------------
 * Translate every dropdown automatically.
 *
 * IMPORTANT:
 * option.value is NEVER changed.
 *
 * This means all existing save/search logic continues to
 * receive exactly the same values as before.
 * ---------------------------------------------------------
 */
function applyLanguageToDropdowns(){

  document.querySelectorAll("select").forEach(select=>{

    select.querySelectorAll("option").forEach(option=>{

      /*
       * Store original option text once.
       */
      if(
        option.dataset.languageOriginal===undefined
      ){

        option.dataset.languageOriginal=
          option.textContent || "";

      }


      const original=
        option.dataset.languageOriginal;

      /*
       * Special response dropdowns already have
       * explicit translations.
       */
      let parsed=parseBilingualText(original);


      /*
       * If the option is already Hindi-only, don't try
       * to reverse-engineer it.
       *
       * The two response dropdowns are handled by their
       * values below.
       */
      if(parsed){

        option.textContent=
          currentLanguage==="hi"
            ? parsed.hindi
            : parsed.english;

      }

    });

  });


  /*
   * Explicit response dropdowns.
   *
   * Their VALUE fields remain untouched.
   */
  applySpecialResponseDropdowns();

}


/*
 * ---------------------------------------------------------
 * Special response dropdowns.
 * ---------------------------------------------------------
 */
function applySpecialResponseDropdowns(){

  const consumerPaymentResponse=$(
    "consumerPaymentResponse"
  );

  if(consumerPaymentResponse){

    const map={

      "":{
        en:"Select",
        hi:"चुनें"
      },

      "कुछ दिन बाद जमा करेंगे":{
        en:"1 - कुछ दिन बाद जमा करेंगे (दिनांक लिखें)",
        hi:"1 - कुछ दिन बाद जमा करेंगे (दिनांक लिखें)"
      },

      "जमा नहीं करेंगे":{
        en:"2 - जमा नहीं करेंगे",
        hi:"2 - जमा नहीं करेंगे"
      },

      "बिल गलत है":{
        en:"3 - बिल गलत है",
        hi:"3 - बिल गलत है"
      },

      "बिल जमा है":{
        en:"4 - बिल जमा है",
        hi:"4 - बिल जमा है"
      },

      "JE/SDO से बात करेंगे":{
        en:"5 - JE/SDO से बात करेंगे",
        hi:"5 - JE/SDO से बात करेंगे"
      },

      "कार्यालय आएंगे":{
        en:"6 - कार्यालय आएंगे",
        hi:"6 - कार्यालय आएंगे"
      },

      "पीडी (PD) कराना है":{
        en:"7 - पीडी (PD) कराना है",
        hi:"7 - पीडी (PD) कराना है"
      },

      "घर पर बात करेंगे":{
        en:"8 - घर पर बात करेंगे",
        hi:"8 - घर पर बात करेंगे"
      },

      "घर पर ताला लगा है":{
        en:"9 - घर पर ताला लगा है (उपभोक्ता से फोन पर बात नहीं हो पा रही है)",
        hi:"9 - घर पर ताला लगा है (उपभोक्ता से फोन पर बात नहीं हो पा रही है)"
      },

      "घर पर केवल महिला है":{
        en:"10 - घर पर केवल महिला है (पुरुष से फोन पर बात नहीं हो पा रही है)",
        hi:"10 - घर पर केवल महिला है (पुरुष से फोन पर बात नहीं हो पा रही है)"
      },

      "अन्य":{
        en:"11 - Other",
        hi:"11 - अन्य"
      }

    };


    consumerPaymentResponse
      .querySelectorAll("option")
      .forEach(option=>{

        const item=map[option.value];

        if(!item) return;

        option.textContent=
          currentLanguage==="hi"
            ? item.hi
            : item.en;

      });

  }


  const phoneResponse=$("phoneResponse");

  if(phoneResponse){

    const map={

      "":{
        en:"Select",
        hi:"चुनें"
      },

      "गलत नंबर":{
        en:"1 - गलत नंबर",
        hi:"1 - गलत नंबर"
      },

      "कॉल रिसीव नहीं कर रहे":{
        en:"2 - कॉल रिसीव नहीं कर रहे",
        hi:"2 - कॉल रिसीव नहीं कर रहे"
      },

      "कुछ दिन बाद जमा करेंगे":{
        en:"3 - कुछ दिन बाद जमा करेंगे (दिनांक लिखें)",
        hi:"3 - कुछ दिन बाद जमा करेंगे (दिनांक लिखें)"
      },

      "जमा नहीं करेंगे":{
        en:"4 - जमा नहीं करेंगे",
        hi:"4 - जमा नहीं करेंगे"
      },

      "बिल गलत है":{
        en:"5 - बिल गलत है",
        hi:"5 - बिल गलत है"
      },

      "घर पर बात करेंगे":{
        en:"6 - घर पर बात करेंगे",
        hi:"6 - घर पर बात करेंगे"
      },

      "JE/SDO से बात करेंगे":{
        en:"7 - JE/SDO से बात करेंगे",
        hi:"7 - JE/SDO से बात करेंगे"
      },

      "डबल कनेक्शन है":{
        en:"8 - डबल कनेक्शन है",
        hi:"8 - डबल कनेक्शन है"
      },

      "PD होना है":{
        en:"9 - PD होना है",
        hi:"9 - PD होना है"
      },

      "बिल जमा है":{
        en:"10 - बिल जमा है",
        hi:"10 - बिल जमा है"
      },

      "कार्यालय आएंगे":{
        en:"11 - कार्यालय आएंग",
        hi:"11 - कार्यालय आएंगे"
      },

      "नंबर स्विच ऑफ है":{
        en:"12 - नंबर स्विच ऑफ है",
        hi:"12 - नंबर स्विच ऑफ है"
      },

      "नंबर नॉट रीचेबल है":{
        en:"13 - नंबर नॉट रीचेबल है",
        hi:"13 - नंबर नॉट रीचेबल है"
      },

      "इनकमिंग कॉल उपलब्ध नहीं है":{
        en:"14 - इनकमिंग कॉल उपलब्ध नहीं है (रिचार्ज नहीं है)",
        hi:"14 - इनकमिंग कॉल उपलब्ध नहीं है (रिचार्ज नहीं है)"
      },

      "अमान्य नंबर":{
        en:"15 - अमान्य नंबर",
        hi:"15 - अमान्य नंबर"
      },

      "अन्य":{
        en:"16 - Other",
        hi:"16 - अन्य"
      }

    };


    phoneResponse
      .querySelectorAll("option")
      .forEach(option=>{

        const item=map[option.value];

        if(!item) return;

        option.textContent=
          currentLanguage==="hi"
            ? item.hi
            : item.en;

      });

  }

}


/*
 * ---------------------------------------------------------
 * Apply language to placeholders.
 * ---------------------------------------------------------
 */
function applyLanguageToPlaceholders(){

  document.querySelectorAll(
    "input[placeholder],textarea[placeholder]"
  ).forEach(el=>{

    if(
      el.dataset.languagePlaceholderOriginal===undefined
    ){

      el.dataset.languagePlaceholderOriginal=
        el.getAttribute("placeholder") || "";

    }


    const original=
      el.dataset.languagePlaceholderOriginal;

    const parsed=parseBilingualText(original);

    if(!parsed) return;


    el.setAttribute(
      "placeholder",
      currentLanguage==="hi"
        ? parsed.hindi
        : parsed.english
    );

  });

}


/*
 * ---------------------------------------------------------
 * Main language application.
 * ---------------------------------------------------------
 */
function applyLanguage(){

  /*
   * Discover any UI text which has been added since the
   * previous call.
   */
  prepareLanguageTextNodes();


  /*
   * Translate remembered individual text nodes.
   *
   * This is deliberately TEXT-NODE based rather than
   * element.textContent based.
   *
   * Therefore buttons containing <small> remain intact.
   */
  languageTextNodesCleanup();


  /*
   * Dropdowns.
   */
  applyLanguageToDropdowns();


  /*
   * Placeholders.
   */
  applyLanguageToPlaceholders();
  updateExistingSearchPlaceholder();
  updateModuleSearchPlaceholder("disconnectSearchType","disconnectAccountId");
  updateModuleSearchPlaceholder("recheckSearchType","recheckAccountId");


  /*
   * Language button.
   */
  const btn=$("languageSwitchBtn");

  if(btn){

    btn.textContent=
      currentLanguage==="en"
        ? "हिंदी"
        : "English";

    btn.title=
      currentLanguage==="en"
        ? "हिंदी में बदलें"
        : "Switch to English";

  }


  /*
   * Language label.
   */
  const label=$("languageSwitchLabel");

  if(label){

    label.textContent=
      currentLanguage==="en"
        ? "Language:"
        : "भाषा:";

  }


  document.documentElement.lang=
    currentLanguage==="hi"
      ? "hi"
      : "en";

}


/*
 * ---------------------------------------------------------
 * Apply translation to remembered text nodes.
 * ---------------------------------------------------------
 */
function languageTextNodesCleanup(){

  /*
   * WeakMap cannot be iterated directly.
   *
   * Re-scan the DOM and use the stored original text for
   * each node.
   */
  const walker=document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    null
  );

  while(walker.nextNode()){

    const node=walker.currentNode;

    const original=
      languageTextNodes.get(node);

    if(!original) continue;

    const parent=node.parentElement;

    if(!parent) continue;


    /*
     * Safety exclusions.
     */
    if(
      parent.closest("script,style,noscript,input,textarea,option")
    ){
      continue;
    }

    if(isConsumerDataElement(parent)){
      continue;
    }


    const parsed=parseBilingualText(original);

    if(!parsed) continue;


    node.nodeValue=
      currentLanguage==="hi"
        ? parsed.hindi
        : parsed.english;

  }

}


/*
 * ---------------------------------------------------------
 * Toggle language.
 * ---------------------------------------------------------
 */
function toggleLanguage(){

  currentLanguage=
    currentLanguage==="en"
      ? "hi"
      : "en";


  localStorage.setItem(
    LANGUAGE_STORAGE_KEY,
    currentLanguage
  );


  applyLanguage();

}


/*
 * ---------------------------------------------------------
 * Initialize.
 * ---------------------------------------------------------
 */
function initLanguageSwitch(){

  prepareLanguageTextNodes();


  const btn=$("languageSwitchBtn");

  if(btn){

    btn.onclick=toggleLanguage;

  }


  applyLanguage();

}

function setStatus(id, text, cls="") {
  $(id).textContent = text;
  $(id).className = "status " + cls;
}

async function serverPost(action, extra={}) {

  const response =
    await fetch(SERVER_URL, {
      method:"POST",

      headers:{
        "Content-Type":
          "text/plain;charset=utf-8"
      },

      body:JSON.stringify(
        Object.assign(
          {
            action:action,
            token:state.sessionToken
          },
          extra
        )
      )
    });

  const contentType =
    response.headers.get(
      "content-type"
    ) || "";

  const raw =
    await response.text();


  let parsed;

  try {

    parsed = JSON.parse(raw);


  } catch (err) {

    const preview =
      String(raw || "")
        .replace(/\s+/g, " ")
        .slice(0, 300);

    throw new Error(
      `Server returned a non-JSON response for "${action}". ` +
      `HTTP ${response.status}` +
      `${response.statusText ? " " + response.statusText : ""}. ` +
      `Content-Type: ${contentType || "unknown"}. ` +


      `Response: ${preview}`
    );

  }

  /*
   * Google sometimes delivers an app request as GET (doGet).
   * That reply is never a real answer: treat it as a delivery
   * failure (retried where the caller retries).
   */
  if (parsed && parsed.code === "GET_NOT_SUPPORTED") {
    throw new Error(
      `Server did not receive "${action}" correctly. Please try again.`
    );
  }

  return parsed;

}




const MAIN_VIEW_IDS = [
  "surveyTypeCard",
  "existingSearchCard",
  "consumerCard",
  "entryCard",
  "newSurveyCard",
  "myCollectionCard",
  "uploadCard",
  "masterUpdateCard",
  "dashboardCard",
  "correctionCard",
  "activitySearchCard",
  "accountActivityModuleCard",
  "phoneCallingModuleCard",
  "disconnectionCard",
  "fieldWorkModulesCard",
  "adminCard",
  "phoneCallingCard",
  "recheckCard",
  "masterListsModuleCard",
  "defaulterListCard",
  "disconnectedUnpaidCard"
];


function showMainView(view) {
  MAIN_VIEW_IDS.forEach(id => {
    const el=$(id);
    if (el) el.classList.add("hidden");
  });

  if (view === "home") {
  
    ["surveyTypeCard","fieldWorkModulesCard","accountActivityModuleCard","masterListsModuleCard","phoneCallingModuleCard","myCollectionCard","uploadCard","masterUpdateCard"].forEach(id => {
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

  /*
   * Retries only delivery failures (network error or Google's
   * HTML error page). A real answer such as "Invalid User ID
   * or Password" is returned immediately.
   * Safe to retry: the backend reuses the user's existing token.
   */
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {

    try {

      const response = await fetch(SERVER_URL, {
        method: "POST",
        headers: {"Content-Type": "text/plain;charset=utf-8"},
        body: JSON.stringify({action:"login", user_id:userId, password:password})
      });
      const result = await response.json();

      /* Google delivered the request as GET: not a real answer. */
      if (result && result.code === "GET_NOT_SUPPORTED") {
        throw new Error("Login request was not delivered correctly.");
      }

      return result;

    } catch (err) {

      console.error(`login attempt ${attempt} failed`, err);

      if (attempt === maxAttempts) {
        throw err;
      }

      setStatus(
        "loginStatus",
        `Server busy, retrying ${attempt + 1} of ${maxAttempts}…`
      );

      await new Promise(
        resolve => setTimeout(resolve, 3000 * attempt)
      );

    }

  }

}


let loginInProgress = false;

async function login() {
  if (loginInProgress) return;
  loginInProgress = true;
  try {
    await loginOnce();
  } finally {
    loginInProgress = false;
  }
}

async function loginOnce() {
  const userId = $("loginUserId").value.trim();
  const password = $("loginPassword").value;

  if (!userId || !password) {
    return setStatus("loginStatus", "Enter User ID and Password.", "error");
  }

  setStatus("loginStatus", "Checking login...");
  try {
    const result = await serverLogin(userId, password);

    if (!result.success) return setStatus("loginStatus", result.message || "Invalid login.", "error");

    /* Never accept a "success" without a real token and user. */
    if (!result.token || !result.user_id) {
      return setStatus("loginStatus", "Login failed. Please try again.", "error");
    }


    state.sessionToken = result.token;
    state.userId = result.user_id;
    state.userName = result.user_name;
    state.isAdmin = !!result.is_admin;
    state.division = result.division || "";
    state.subdivision = result.subdivision || "";
    state.substation = result.substation || "";
    state.role = result.role || "";

    localStorage.setItem("consumerMobileIsAdmin", state.isAdmin ? "YES" : "NO");
    localStorage.setItem("consumerMobileDivision", state.division);
    localStorage.setItem("consumerMobileSubdivision", state.subdivision);
    localStorage.setItem("consumerMobileSubstation", state.substation);
    localStorage.setItem("consumerMobileRole", state.role);

    localStorage.setItem("consumerMobileAuthToken", state.sessionToken);


    localStorage.setItem("consumerMobileUserId", state.userId);
    localStorage.setItem("consumerMobileUserName", state.userName);

    showApp();
    setMasterGate(!state.masterReady);
    setStatus("loginStatus", "");
    /*
     * Villages for this user: show the saved list, and load it
     * from the server automatically only if this phone has none.
     */
    renderSavedVillageList();
    ensureVillageList();

    /* Master download starts only after permissions are allowed,
       so the heavy master import never freezes the permission card. */
    ensureDevicePermissions().then(() => startMasterSetup());


  } catch (e) {
    setStatus("loginStatus", "Login failed. Check internet connection.", "error");
  }
}

function logout() {
  localStorage.removeItem("consumerMobileAuthToken");
  localStorage.removeItem("consumerMobileUserId");
  localStorage.removeItem("consumerMobileUserName");
  localStorage.removeItem("consumerMobileIsAdmin");
  localStorage.removeItem("consumerMobileDivision");
  localStorage.removeItem("consumerMobileSubdivision");
  localStorage.removeItem("consumerMobileSubstation");
  localStorage.removeItem("consumerMobileRole");

  state.sessionToken = "";
  state.userId = "";
  state.userName = "";
  state.division = "";
  state.subdivision = "";
  state.substation = "";
  state.role = "";

  showLogin();
}

/*
 * =========================================================
 * VILLAGE LIST (per user, from Village Master sheet)
 * =========================================================
 * - Saved on the phone per user (localStorage).
 * - Loaded from the server automatically ONLY when this
 *   phone has no saved list for the user (first login).
 * - Later updates: "CHECK FOR VILLAGE LIST UPDATE" button.
 * - A failed check never removes the saved list.
 */
const VILLAGE_LIST_KEY_PREFIX = "fieldworkVillageList:";

/* Old single list from village.json (used only until the
   first successful load for this user). */
const LEGACY_VILLAGE_KEY = "kuthondVillageDataV2";

let villageCheckRunning = false;

function villageListStorageKey() {
  return VILLAGE_LIST_KEY_PREFIX +
    String(state.userId || "").trim().toLowerCase();
}

function getSavedVillageList() {

  if (!state.userId) return null;

  try {
    const raw = localStorage.getItem(villageListStorageKey());
    if (!raw) return null;

    const data = JSON.parse(raw);

    return data && Array.isArray(data.villages)
      ? data
      : null;

  } catch (e) {
    return null;
  }

}

function getLegacyVillageList() {

  try {
    const data = JSON.parse(
      localStorage.getItem(LEGACY_VILLAGE_KEY) || "null"
    );

    return Array.isArray(data) ? data : null;

  } catch (e) {
    return null;
  }

}

function saveVillageList(result) {



  const data = {
    version: String(result.version || ""),
    villages: result.villages,
    feeders: Array.isArray(result.feeders) ? result.feeders : [],
    checked_at: new Date().toISOString()
  };

  try {
    localStorage.setItem(
      villageListStorageKey(),
      JSON.stringify(data)
    );
  } catch (e) {
    console.error("Could not save village list", e);
  }

  return data;

}

/*
 * =========================================================
 * FEEDER / DT DROPDOWNS (survey forms)
 * =========================================================
 * Feeder option value = "SUBSTATION||FEEDER" (feeder names
 * are unique only within a substation). Options are grouped
 * by substation. Brackets in names are shown as [ ] so the
 * language switch never treats them as a Hindi part.
 */


const FEEDER_DT_PAIRS = [["feeder", "dt"], ["newFeeder", "newDt"], ["activityCorrFeeder", "activityCorrDt"]];

/* "Not known" choices: feeder value parses to substation "", feeder "NOT KNOWN". */
const FEEDER_NOT_KNOWN_VALUE = "||NOT KNOWN";
const DT_NOT_KNOWN_VALUE = "NOT KNOWN";
const NOT_KNOWN_TEXT = "NOT KNOWN / ज्ञात नहीं";

function referenceDisplayText(text) {
  return String(text || "").replace(/\(/g, "[").replace(/\)/g, "]");
}

function parseFeederValue(value) {
  const parts = String(value || "").split("||");
  return {
    substation: parts.length > 1 ? parts[0] : "",
    feeder: parts.length > 1 ? parts[1] : ""
  };
}

function fillDtDropdown(dtId, feederId) {

  const dtSelect = $(dtId);
  const feederSelect = $(feederId);
  if (!dtSelect || !feederSelect) return;

  const selectedValue = dtSelect.value;
  const firstOption = dtSelect.options[0];

  dtSelect.innerHTML = "";


  if (firstOption) dtSelect.appendChild(firstOption);

  /* Once a feeder is chosen, DT can always be "not known". */
  if (feederSelect.value) {
    const notKnown = document.createElement("option");
    notKnown.value = DT_NOT_KNOWN_VALUE;
    notKnown.textContent = NOT_KNOWN_TEXT;
    dtSelect.appendChild(notKnown);
  }

  const chosen = parseFeederValue(feederSelect.value);

  const entry = getSavedFeeders().find(f =>
    String(f.substation || "") === chosen.substation &&
    String(f.feeder || "") === chosen.feeder
  );

  for (const dt of (entry && Array.isArray(entry.dts) ? entry.dts : [])) {
    const option = document.createElement("option");
    option.value = dt;
    option.textContent = referenceDisplayText(dt);
    dtSelect.appendChild(option);
  }

  if (
    selectedValue &&
    Array.from(dtSelect.options).some(o => o.value === selectedValue)
  ) {
    dtSelect.value = selectedValue;
  }

}

function fillFeederDropdowns(feeders) {

  for (const [feederId, dtId] of FEEDER_DT_PAIRS) {

    const select = $(feederId);
    if (!select) continue;

    const selectedValue = select.value;
    const firstOption = select.options[0];

    select.innerHTML = "";

    if (firstOption) select.appendChild(firstOption);

    const notKnown = document.createElement("option");
    notKnown.value = FEEDER_NOT_KNOWN_VALUE;
    notKnown.textContent = NOT_KNOWN_TEXT;
    select.appendChild(notKnown);

    const groups = new Map();

    for (const f of (feeders || [])) {
      const substation = String(f.substation || "");
      if (!groups.has(substation)) groups.set(substation, []);
      groups.get(substation).push(f);
    }

    for (const [substation, list] of groups) {

      let parent = select;

      if (substation) {
        parent = document.createElement("optgroup");
        parent.label = referenceDisplayText(substation);
        select.appendChild(parent);
      }

      for (const f of list) {
        const option = document.createElement("option");
        option.value = substation + "||" + f.feeder;
        option.textContent = referenceDisplayText(f.feeder);
        parent.appendChild(option);
      }
    }

    if (
      selectedValue &&
      Array.from(select.options).some(o => o.value === selectedValue)
    ) {
      select.value = selectedValue;
    }

    fillDtDropdown(dtId, feederId);
  }

}

/* Optional numeric field: empty, or a plain number. */
function isValidOptionalNumber(value) {
  return value === "" || /^\d+(\.\d+)?$/.test(value);
}

function feederDisplay(record) {
  return record.feeder_substation
    ? record.feeder_substation + " / " + record.feeder
    : (record.feeder || "—");
}




/*
 * Fills the 5 village dropdowns. Same options as before
 * (first option kept, "Not in the list" for survey village,
 * sorted by label). A value already selected in an open
 * form is kept if it still exists in the new list.
 */
function fillVillageDropdowns(villages) {

  const normalizedVillages = (villages || [])
    .map(v => {

      if (typeof v === "string") {
        return {
          value: v,
          label: v
        };
      }

      return {
        value: String(v.value ?? v.name ?? "").trim(),
        label: String(v.label ?? v.name ?? v.value ?? "").trim()
      };
    })
    .filter(v => v.value && v.label)
    .sort((a,b) =>
      a.label.localeCompare(
        b.label,
        undefined,
        {sensitivity:"base"}
      )
    );

  for (const selectId of ["village", "newVillage", "villageFilter","disconnectVillageFilter","recheckVillageFilter"]) {

    const villageSelect = $(selectId);

    if (!villageSelect) continue;

    const selectedValue = villageSelect.value;

    // Keep existing first option
    const firstOption = villageSelect.options[0];

    villageSelect.innerHTML = "";

    if (firstOption) {
      villageSelect.appendChild(firstOption);
    }
    if (selectId === "village") {
       const notInListOption = document.createElement("option");
       notInListOption.value = "NOT_IN_LIST";
       notInListOption.textContent = "Not in the list (सूची में नहीं)";
       villageSelect.appendChild(notInListOption);
    }

    for (const village of normalizedVillages) {

      const option =
        document.createElement("option");

      option.value = village.value;
      option.textContent = village.label;

      villageSelect.appendChild(option);
    }

    if (
      selectedValue &&
      Array.from(villageSelect.options).some(o => o.value === selectedValue)
    ) {


      villageSelect.value = selectedValue;
    }
  }

  /* Feeder / DT dropdowns use the same saved reference data. */
  fillFeederDropdowns(getSavedFeeders());

}


/*
 * Feeders + DTs saved with the village list (reference data).
 * Returns [] until the first successful load.
 * Used by the survey form (Phase B).
 */
function getSavedFeeders() {

  const saved = getSavedVillageList();

  return saved && Array.isArray(saved.feeders)
    ? saved.feeders
    : [];

}

function updateVillageListInfo() {

  const info = $("villageListInfo");
  if (!info) return;

  const saved = getSavedVillageList();

  if (saved && Array.isArray(saved.feeders)) {
    const dtCount = saved.feeders.reduce(
      (n, f) => n + (Array.isArray(f.dts) ? f.dts.length : 0),
      0
    );
    info.textContent =
      `Villages: ${saved.villages.length} · Feeders: ${saved.feeders.length} · DTs: ${dtCount} · Last checked: ${formatMasterDate(saved.checked_at)}`;
  } else if (saved || getLegacyVillageList()) {
    info.textContent =
      "Using the previously saved village list. Tap the button below to load the latest village, feeder and DT lists.";
  } else {
    info.textContent =
      "Village, feeder and DT lists are not loaded yet. Tap the button below to load them.";
  }

}

/*
 * Shows the list saved on this phone. No network.
 */
function renderSavedVillageList() {

  const saved = getSavedVillageList();

  fillVillageDropdowns(
    saved
      ? saved.villages
      : (getLegacyVillageList() || [])
  );

  updateVillageListInfo();

}

/*
 * reference_data (villages + feeders + DTs) is read-only,
 * so it is safe to retry. Same retry rules as master_check.
 */
async function fetchVillageListFromServer() {

  const maxAttempts = 3;

  let result = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {

    try {

      result = await serverPost("reference_data");
      break;

    } catch (err) {

      console.error(`reference_data attempt ${attempt} failed`, err);

      if (attempt === maxAttempts) {
        throw new Error(
          "Could not reach the server to load the village, feeder and DT lists. " +
          "Please check your internet connection and try again."
        );
      }

      await new Promise(
        resolve => setTimeout(resolve, 3000 * attempt)
      );

    }

  }

  if (!result.success) {
    throw new Error(
      result.message || "Could not load the village, feeder and DT lists."
    );
  }

  if (!Array.isArray(result.villages) || !Array.isArray(result.feeders)) {
    throw new Error("Lists received from the server are invalid.");
  }

  return result;

}

/*
 * Button: CHECK AND UPDATE (villages, feeders, DTs)
 * (also used once automatically on first login).
 */
async function checkVillageListUpdate(auto = false) {

  if (villageCheckRunning) return;
  if (!state.sessionToken) return;

  villageCheckRunning = true;

  const button = $("checkVillageListBtn");
  if (button) button.disabled = true;

  const hasStatus = !!$("villageListStatus");
  const userAtStart = state.userId;

  if (hasStatus) {
    setStatus(
      "villageListStatus",
      auto
        ? "Loading village, feeder and DT lists…"
        : "Checking village, feeder and DT lists…"
    );
  }

  try {

    const result = await fetchVillageListFromServer();

    /* User logged out / changed while checking: ignore. */
    if (state.userId !== userAtStart) return;

    const saved = getSavedVillageList();
    const unchanged =
      saved && saved.version === String(result.version || "");

    saveVillageList(result);
    saveVideoSettings(result.video_settings);

    if (!unchanged) {
      fillVillageDropdowns(result.villages);
    }

    updateVillageListInfo();

    const counts =
      `${result.villages.length} villages, ${result.feeders.length} feeders`;

    if (hasStatus) {
      setStatus(
        "villageListStatus",
        unchanged
          ? `Lists are up to date. ${counts}.`
          : `Lists updated. ${counts} are now available.`,
        "ok"
      );
    }

  } catch (e) {

    console.error(e);

    if (state.userId !== userAtStart) return;

    if (hasStatus) {
      setStatus(
        "villageListStatus",
        (getSavedVillageList()
          ? "The saved lists are still in use. "
          : "") +
        (e.message || "Could not load the village, feeder and DT lists."),
        "error"
      );
    }

  } finally {

    villageCheckRunning = false;
    if (button) button.disabled = false;

  }

}

/*
 * Load automatically when this phone has no saved lists for
 * this user, or only an older village-only list (no feeders).
 */
function ensureVillageList() {

  const saved = getSavedVillageList();

  if (!state.sessionToken || (saved && Array.isArray(saved.feeders))) return;

  checkVillageListUpdate(true);

}


/*
 * =========================================================
 * DEVICE PERMISSIONS (location + camera + microphone)
 * =========================================================
 * Required according to the hardware this device has:
 * location always; camera / microphone only if present.
 * The app is blocked by the permission gate until all
 * required permissions are granted. Checked after login and
 * at every start. The browser prompts only after a tap.
 */

let permissionRequestRunning = false;

/* Callers waiting for the permission gate to close (e.g. master setup). */
let permissionWaiters = [];

function releasePermissionWaiters() {
  const waiters = permissionWaiters;
  permissionWaiters = [];
  waiters.forEach(resolve => resolve());
}

async function detectMediaHardware() {
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
      return { camera: false, microphone: false };
    }
    const devices = await navigator.mediaDevices.enumerateDevices();
    return {
      camera: devices.some(d => d.kind === "videoinput"),
      microphone: devices.some(d => d.kind === "audioinput")
    };
  } catch (e) {
    console.warn("Could not detect camera/microphone", e);
    return { camera: false, microphone: false };
  }
}

async function queryPermissionState(name) {
  try {
    if (!navigator.permissions || !navigator.permissions.query) return "unknown";
    const result = await navigator.permissions.query({ name: name });
    return result.state;
  } catch (e) {
    return "unknown";
  }
}

function updateNoCameraNotices() {
  const noCamera = state.deviceHasCamera === false;
  ["noCameraNoticeDisconnect", "noCameraNoticeRecheck"].forEach(id => {
    if ($(id)) $(id).classList.toggle("hidden", !noCamera);
  });
}

async function currentPermissionStatus() {

  const hw = await detectMediaHardware();

  state.deviceHasCamera = hw.camera;
  updateNoCameraNotices();

  const items = [{ key: "geolocation", label: "Location" }];
  if (hw.camera) items.push({ key: "camera", label: "Camera" });
  if (hw.microphone) items.push({ key: "microphone", label: "Microphone" });

  for (const item of items) {
    item.state = await queryPermissionState(item.key);

    /* Browsers without the permissions API: trust this session's grants. */
    if (item.state === "unknown") {
      if (item.key === "geolocation" && state.locationPermissionOk) item.state = "granted";
      if (item.key !== "geolocation" && state.mediaPermissionOk) item.state = "granted";
    }
  }

  return {
    items: items,
    missing: items.filter(i => i.state !== "granted")
  };
}

function renderPermissionGate(status) {

  $("permissionList").innerHTML = status.items.map(i => {
    const text =
      i.state === "granted" ? "Allowed" :
      i.state === "denied" ? "Blocked" :
      "Not allowed yet";
    return `<div>${escapeHtml(i.label)}: <b>${text}</b></div>`;
  }).join("");

  const blocked = status.items.some(i => i.state === "denied");
  const help = $("permissionHelp");

  if (blocked) {
    help.textContent =
      "A permission is blocked, so the phone will not ask again. " +
      "Installed app: long-press the app icon, open App info, then Permissions, and allow Location, Camera and Microphone. " +
      "In Chrome: tap the icon left of the address, open Permissions or Site settings, and allow them. " +
      "Then tap ALLOW PERMISSIONS again.";
    help.className = "status error";
  } else {
    help.textContent = "";
    help.className = "status";
  }

}

function showPermissionGate(show) {
  if ($("permissionGate")) $("permissionGate").classList.toggle("hidden", !show);
}

/*
 * After login and at every start. Never prompts by itself.
 * Resolves when all required permissions are allowed, so the
 * caller can start the master setup only then.
 */
async function ensureDevicePermissions() {

  if (!state.sessionToken || !$("permissionGate")) return;

  const status = await currentPermissionStatus();

  if (!status.missing.length) {
    showPermissionGate(false);
    return;
  }

  renderPermissionGate(status);
  showPermissionGate(true);

  return new Promise(resolve => permissionWaiters.push(resolve));

}

/* ALLOW PERMISSIONS button: location first, then camera + microphone together. */
async function requestDevicePermissions() {

  if (permissionRequestRunning) return;
  permissionRequestRunning = true;

  const button = $("permissionAllowBtn");
  if (button) button.disabled = true;

  const help = $("permissionHelp");
  const progress = text => {
    if (help) { help.textContent = text; help.className = "status"; }
  };

  /* Refresh the list on the card without closing it. */
  const refreshList = async () => {
    const status = await currentPermissionStatus();
    renderPermissionGate(status);
    return status;
  };

  try {

    const hw = await detectMediaHardware();

    /* 1. Location: continue as soon as the user answers the prompt,
          without waiting for an actual GPS fix. */
    if ((await queryPermissionState("geolocation")) !== "granted") {

      progress("Step 1: allow Location when the phone asks…");

      await new Promise(resolve => {

        if (!navigator.geolocation) return resolve();

        let done = false;
        let poll = null;
        const finish = () => {
          if (done) return;
          done = true;
          if (poll) clearInterval(poll);
          resolve();
        };

        navigator.geolocation.getCurrentPosition(
          () => { state.locationPermissionOk = true; finish(); },
          err => {
            /* Timeout / GPS off still means permission was given. */
            state.locationPermissionOk = err && err.code !== err.PERMISSION_DENIED;
            finish();
          },
          { enableHighAccuracy: false, timeout: 20000, maximumAge: Infinity }
        );

        /* The answer shows up here immediately after the tap. */
        if (done) return;
        poll = setInterval(async () => {
          const s = await queryPermissionState("geolocation");
          if (s === "granted" || s === "denied") {
            state.locationPermissionOk = s === "granted";
            finish();
          }
        }, 400);

      });

      await refreshList();
    }

    /* 2. Camera + microphone together (one prompt on most phones). */
    const needMedia =
      (hw.camera && (await queryPermissionState("camera")) !== "granted") ||
      (hw.microphone && (await queryPermissionState("microphone")) !== "granted");

    if (needMedia && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {

      progress("Step 2: allow Camera and Microphone when the phone asks…");

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: hw.camera,
          audio: hw.microphone
        });
        stream.getTracks().forEach(t => t.stop());
        state.mediaPermissionOk = true;
      } catch (e) {
        console.warn("Camera/microphone permission not given", e);
        state.mediaPermissionOk = false;
      }
    }

    const status = await refreshList();

    if (!status.missing.length) {
      progress("All permissions allowed.");
      setTimeout(() => {
        showPermissionGate(false);
        releasePermissionWaiters();
      }, 600);

    } else {
      showPermissionGate(true);
    }

  } finally {

    permissionRequestRunning = false;
    if (button) button.disabled = false;

  }

}





/*
 * =========================================================
 * VIDEO EVIDENCE: RECORDER (Disconnection / Recheck) — C3b
 * =========================================================
 * - Recorded inside the app at low quality (~3 MB per minute).
 * - SAVE VIDEO downloads the clip to the phone's Download
 *   folder (the user's own copy, fully under their control).
 * - If the subdivision uploads videos, a hidden copy is kept in
 *   a separate database ("FieldworkVideos") only until the R2
 *   upload succeeds (C3c).
 */
const VIDEO_DB_NAME = "FieldworkVideos";
const VIDEO_STORE = "videos";
const VIDEO_DEFAULT_MAX_SECONDS = 150;

const VIDEO_FORM_IDS = {
  DISCONNECTION: { info: "disconnectVideoInfo", status: "disconnectSaveStatus", section: "disconnectVideoSection", statusSelect: "disconnectStatus" },
  RECHECK: { info: "recheckVideoInfo", status: "recheckSaveStatus", section: "recheckVideoSection", statusSelect: "recheckStatus" }
};


const videoRecorder = {
  type: null, stream: null, recorder: null, chunks: [], timer: null,
  startedAt: 0, seconds: 0, blob: null, url: null, mimeType: "", cancelled: false,
  elapsedMs: 0, segmentStart: 0, paused: false
};

/* Recorded time so far, excluding pauses. */
function videoElapsedSeconds() {
  const running = videoRecorder.paused ? 0 : (Date.now() - videoRecorder.segmentStart);
  return (videoRecorder.elapsedMs + running) / 1000;
}

/* ---------- video settings (from the backend) ---------- */

function videoSettingsKey() {
  return "fieldworkVideoSettings:" + String(state.userId || "").trim().toLowerCase();
}


function saveVideoSettings(settings) {
  if (!settings || !state.userId) return;
  const before = !!getVideoSettings().video_upload;
  try {
    localStorage.setItem(
      videoSettingsKey(),
      JSON.stringify(Object.assign({}, settings, { saved_at: new Date().toISOString() }))
    );
  } catch (e) {
    console.warn("Could not save video settings", e);
  }

  /* Flag changed: old video messages no longer apply. */
  if (before !== !!settings.video_upload) {
    if ($("videoUploadStatus")) setStatus("videoUploadStatus", "");
    refreshVideoUploadInfo();
  }
}

function getVideoSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(videoSettingsKey()) || "null");
    if (s) return s;
  } catch (e) {}
  return { video_upload: false, video_max_seconds: VIDEO_DEFAULT_MAX_SECONDS };
}

function videoMaxSeconds() {
  const n = Number(getVideoSettings().video_max_seconds);
  return n > 0 ? n : VIDEO_DEFAULT_MAX_SECONDS;
}

/* ---------- small helpers ---------- */

function pickVideoMimeType() {
  if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return "";
  const candidates = [
    "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    "video/mp4",
    "video/webm;codecs=vp8,opus",
    "video/webm"
  ];
  return candidates.find(t => MediaRecorder.isTypeSupported(t)) || "";
}

function videoExtension(mime) {
  return /mp4/i.test(String(mime || "")) ? "mp4" : "webm";
}

function formatDuration(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}

function videoFileName(type, accountId, date, ext) {
  const p = n => String(n).padStart(2, "0");
  const stamp =
    date.getFullYear() + "-" + p(date.getMonth() + 1) + "-" + p(date.getDate()) + "_" +
    p(date.getHours()) + "-" + p(date.getMinutes()) + "-" + p(date.getSeconds());
  const account = String(accountId || "NA").replace(/[^A-Za-z0-9]/g, "") || "NA";
  return "FW_" + type + "_" + account + "_" + stamp + "." + ext;
}

function currentActivityConsumer(type) {
  return type === "DISCONNECTION" ? state.disconnectCurrent : state.recheckCurrent;
}

function videoRecorderStatus(text, kind) {
  setStatus("videoRecorderStatus", text, kind || "");
}

function updateVideoTimer(seconds) {
  if ($("videoRecorderTimer")) {
    $("videoRecorderTimer").textContent =
      formatDuration(seconds) + " / " + formatDuration(videoMaxSeconds());
  }
}

function setRecorderButtons(mode) {
  const show = {
    videoStartBtn: mode === "ready",
    videoPauseBtn: mode === "recording",
    videoResumeBtn: mode === "paused",
    videoStopBtn: mode === "recording" || mode === "paused",
    videoPlayBtn: mode === "review",
    videoSaveBtn: mode === "review",
    videoRetakeBtn: mode === "review"
  };

  Object.keys(show).forEach(id => {
    if ($(id)) $(id).classList.toggle("hidden", !show[id]);
  });
}

function stopRecorderStream() {
  if (videoRecorder.stream) {
    videoRecorder.stream.getTracks().forEach(t => t.stop());
    videoRecorder.stream = null;
  }
}

/* ---------- form state ---------- */



function clearActivityVideo(type) {
  if (!state.activityVideo) state.activityVideo = {};
  state.activityVideo[type] = null;
  const ids = VIDEO_FORM_IDS[type];
  if (ids && $(ids.info)) $(ids.info).textContent = "No video recorded yet.";
  updateVideoSection(type);
}

/*
 * Video part of the form is shown only for statuses that need a
 * video. For other statuses no video is recorded; a video recorded
 * before the status was changed is discarded.
 */
function updateVideoSection(type) {
  const ids = VIDEO_FORM_IDS[type];
  if (!ids) return;
  const select = $(ids.statusSelect);
  const required = isVideoRequired(type, select ? select.value : "");
  if ($(ids.section)) $(ids.section).classList.toggle("hidden", !required);
  if (!required && getActivityVideo(type)) {
    state.activityVideo[type] = null;
    if ($(ids.info)) $(ids.info).textContent = "No video recorded yet.";
  }
}


function getActivityVideo(type) {
  return state.activityVideo ? state.activityVideo[type] : null;
}

function videoSummary(video) {
  return video.fileName + " · " + formatBytes(video.size) + " · " + formatDuration(video.durationSec);
}

/* ---------- recorder ---------- */

async function openVideoRecorder(type) {

  const ids = VIDEO_FORM_IDS[type];

  if (state.deviceHasCamera === false) {
    return setStatus(ids.status, "This device does not have a camera, so this form cannot be submitted.", "error");
  }

  if (!currentActivityConsumer(type)) {
    return setStatus(ids.status, "Search an Account ID first.", "error");
  }

  if (!window.MediaRecorder || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return setStatus(ids.status, "This browser cannot record video.", "error");
  }

  closeVideoRecorder(false);

  videoRecorder.type = type;
  videoRecorder.cancelled = false;

  $("videoRecorderModal").classList.remove("hidden");
  setRecorderButtons("none");
  updateVideoTimer(0);
  videoRecorderStatus("Starting camera…");

  try {
    videoRecorder.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 640 },
        height: { ideal: 480 },
        frameRate: { ideal: 15, max: 20 }
      },
      audio: true
    });
  } catch (e) {
    console.error(e);
    videoRecorderStatus("Camera could not start. Check camera and microphone permissions.", "error");
    return;
  }

  const preview = $("videoRecorderPreview");
  preview.removeAttribute("src");
  preview.autoplay = true;
  preview.srcObject = videoRecorder.stream;
  preview.muted = true;
  preview.controls = false;
  try { await preview.play(); } catch (e) {}

  setRecorderButtons("ready");
  videoRecorderStatus("Point the camera and tap START RECORDING.");
}

function startVideoRecording() {

  if (!videoRecorder.stream) return;

  const mime = pickVideoMimeType();
  let recorder;

  try {
    recorder = new MediaRecorder(
      videoRecorder.stream,
      Object.assign(
        { videoBitsPerSecond: 350000, audioBitsPerSecond: 32000 },
        mime ? { mimeType: mime } : {}
      )
    );
  } catch (e) {
    recorder = new MediaRecorder(videoRecorder.stream);
  }

  videoRecorder.recorder = recorder;
  videoRecorder.mimeType = recorder.mimeType || mime || "video/webm";
  videoRecorder.chunks = [];

  recorder.ondataavailable = e => {
    if (e.data && e.data.size) videoRecorder.chunks.push(e.data);
  };
  recorder.onstop = finishVideoRecording;



  recorder.start(1000);
  videoRecorder.startedAt = Date.now();
  videoRecorder.elapsedMs = 0;
  videoRecorder.segmentStart = Date.now();
  videoRecorder.paused = false;

  setRecorderButtons("recording");
  videoRecorderStatus("Recording…");

  const max = videoMaxSeconds();
  videoRecorder.timer = setInterval(() => {
    const s = videoElapsedSeconds();
    updateVideoTimer(Math.min(Math.floor(s), max));
    if (s >= max) stopVideoRecording();
  }, 250);
}

function pauseVideoRecording() {
  const r = videoRecorder.recorder;
  if (!r || r.state !== "recording" || !r.pause) return;
  r.pause();
  videoRecorder.elapsedMs += Date.now() - videoRecorder.segmentStart;
  videoRecorder.paused = true;
  setRecorderButtons("paused");
  videoRecorderStatus("Paused. Tap RESUME to continue, or STOP to finish.");
}

function resumeVideoRecording() {
  const r = videoRecorder.recorder;
  if (!r || r.state !== "paused" || !r.resume) return;
  r.resume();
  videoRecorder.segmentStart = Date.now();
  videoRecorder.paused = false;
  setRecorderButtons("recording");
  videoRecorderStatus("Recording…");
}

function stopVideoRecording() {
  clearInterval(videoRecorder.timer);
  videoRecorder.timer = null;
  if (!videoRecorder.paused) {
    videoRecorder.elapsedMs += Date.now() - videoRecorder.segmentStart;
    videoRecorder.paused = true;
  }
  const r = videoRecorder.recorder;
  if (r && r.state !== "inactive") r.stop();
}



function finishVideoRecording() {

  clearInterval(videoRecorder.timer);
  videoRecorder.timer = null;
  stopRecorderStream();

  if (videoRecorder.cancelled) return;

  videoRecorder.seconds = Math.min(
    videoMaxSeconds(),
    Math.max(1, Math.round(videoRecorder.elapsedMs / 1000))

  );

  videoRecorder.blob = new Blob(videoRecorder.chunks, {
    type: String(videoRecorder.mimeType).split(";")[0]
  });

  if (videoRecorder.url) URL.revokeObjectURL(videoRecorder.url);
  videoRecorder.url = URL.createObjectURL(videoRecorder.blob);



  /* Load the clip but do not play it until PLAY PREVIEW is tapped. */
  const preview = $("videoRecorderPreview");
  preview.autoplay = false;
  preview.srcObject = null;
  preview.src = videoRecorder.url;
  preview.muted = false;
  preview.controls = false;

  updateVideoTimer(videoRecorder.seconds);
  setRecorderButtons("review");
  videoRecorderStatus(
    "Recorded " + formatDuration(videoRecorder.seconds) + " · " +
    formatBytes(videoRecorder.blob.size) + ". Tap PLAY PREVIEW to check it, then USE THIS VIDEO or RETAKE.",
    "ok"
  );
}

function playVideoPreview() {
  const preview = $("videoRecorderPreview");
  if (!preview || !videoRecorder.url) return;
  preview.controls = true;
  try { preview.currentTime = 0; } catch (e) {}
  const p = preview.play();
  if (p && p.catch) p.catch(() => {});
}

/* Saves the clip to the phone's Download folder (called on SUBMIT). */
function downloadActivityVideo(video) {
  const url = URL.createObjectURL(video.blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = video.fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}


/* USE THIS VIDEO: keep it for the form. Saved to Download on SUBMIT. */
function saveRecordedVideo() {

  const type = videoRecorder.type;
  const consumer = currentActivityConsumer(type);
  if (!type || !videoRecorder.blob || !consumer) return;

  const date = new Date(videoRecorder.startedAt || Date.now());
  const fileName = videoFileName(type, consumer.ACCT_ID, date, videoExtension(videoRecorder.mimeType));


  if (!state.activityVideo) state.activityVideo = {};
  state.activityVideo[type] = {
    accountId: String(consumer.ACCT_ID || ""),
    blob: videoRecorder.blob,
    fileName: fileName,
    contentType: videoRecorder.blob.type || "video/webm",
    size: videoRecorder.blob.size,
    durationSec: videoRecorder.seconds,
    recordedAt: date.toISOString()
  };

  const ids = VIDEO_FORM_IDS[type];
  if ($(ids.info)) {
    $(ids.info).textContent =
      "Video ready: " + videoSummary(state.activityVideo[type]) +
      ". It will be saved to Download when you submit.";
  }
  setStatus(ids.status, "");

  if (videoRecorder.url) URL.revokeObjectURL(videoRecorder.url);
  videoRecorder.url = null;
  videoRecorder.blob = null;

  closeVideoRecorder(false);

}

function retakeVideo() {
  const type = videoRecorder.type;
  if (videoRecorder.url) URL.revokeObjectURL(videoRecorder.url);
  videoRecorder.url = null;
  videoRecorder.blob = null;
  openVideoRecorder(type);
}

/* Close the recorder; cancel = discard anything recorded. */
function closeVideoRecorder(cancel) {

  if (cancel) videoRecorder.cancelled = true;

  clearInterval(videoRecorder.timer);
  videoRecorder.timer = null;

  const r = videoRecorder.recorder;
  if (r && r.state !== "inactive") {
    videoRecorder.cancelled = true;
    r.stop();
  }
  videoRecorder.recorder = null;

  stopRecorderStream();

  if (cancel && videoRecorder.url) {
    URL.revokeObjectURL(videoRecorder.url);
    videoRecorder.url = null;
    videoRecorder.blob = null;
  }

  const preview = $("videoRecorderPreview");
  if (preview) {
    preview.pause();
    preview.srcObject = null;
    preview.removeAttribute("src");
  }

  if ($("videoRecorderModal")) $("videoRecorderModal").classList.add("hidden");
}

/* ---------- record + hidden copy ---------- */

function attachVideoToRecord(record, video) {
  record.video_file = video.fileName;
  record.video_content_type = video.contentType;
  record.video_size_bytes = video.size;
  record.video_duration_sec = video.durationSec;
  record.video_recorded_at = video.recordedAt;
  record.video_upload = !!getVideoSettings().video_upload;
}

function openVideoDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(VIDEO_DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(VIDEO_STORE)) {
        db.createObjectStore(VIDEO_STORE, { keyPath: "record_id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/*
 * Always kept (whatever the phone's saved flag says). UPLOAD VIDEOS
 * asks the backend: upload allowed -> sent to R2; not allowed ->
 * hidden copy deleted. The Download copy is never touched.
 */
async function keepVideoForUpload(record, video) {

  try {
    const db = await openVideoDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(VIDEO_STORE, "readwrite");
      tx.objectStore(VIDEO_STORE).put({
        record_id: record.disconnection_id || record.recheck_id,
        activity_type: record.activity_type,
        user_id: state.userId,
        account_id: record.account_id,
        file_name: video.fileName,
        content_type: video.contentType,
        size_bytes: video.size,
        duration_sec: video.durationSec,
        recorded_at: video.recordedAt,
        blob: video.blob,
        status: "PENDING",
        saved_at: new Date().toISOString()
      });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (e) {
    console.error("Could not keep video for upload", e);
  }
  refreshVideoUploadInfo();
}

/*
 * Video is required only for:
 *   Disconnection: DISCONNECTED
 *   Recheck: FOUND CONNECTED, STILL DISCONNECTED (found disconnected), HOUSE LOCKED
 * For other statuses it is optional (kept if recorded).
 */
const VIDEO_REQUIRED_STATUSES = {
  DISCONNECTION: ["DISCONNECTED"],
  RECHECK: ["FOUND CONNECTED", "STILL DISCONNECTED", "HOUSE LOCKED"]
};

function isVideoRequired(type, status) {
  return (VIDEO_REQUIRED_STATUSES[type] || []).indexOf(String(status || "").toUpperCase()) !== -1;
}

/* Save guard shared by both forms. */
function checkActivityVideo(type, consumer, required) {
  const video = getActivityVideo(type);
  if (!video) return required ? "Record the video first. Video is required for this status." : "";
  if (video.accountId !== String(consumer.ACCT_ID || "")) {
    return "The video was recorded for another account. Record it again.";
  }
  return "";
}


/*
 * =========================================================
 * VIDEO UPLOAD TO R2 (UPLOAD VIDEOS button) — C3c
 * =========================================================
 * - Only videos whose record is already UPLOADED are sent.
 * - Oldest first. Each video: ask Apps Script for a signed
 *   upload link (daily limits checked there), PUT the file
 *   straight to R2, then confirm with Apps Script.
 * - After success the hidden copy is deleted. The copy in the
 *   Download folder is never touched.
 * - Daily limit reached: stop; the rest upload another day.
 */
let videoUploadRunning = false;

async function getPendingVideos() {
  const db = await openVideoDB();
  try {
    const all = await new Promise((resolve, reject) => {
      const req = db.transaction(VIDEO_STORE, "readonly").objectStore(VIDEO_STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    return all
      .filter(v => String(v.user_id || "") === String(state.userId || ""))
      .sort((a, b) => String(a.recorded_at || "").localeCompare(String(b.recorded_at || "")));
  } finally {
    db.close();
  }
}

async function deleteHiddenVideo(recordId) {
  const db = await openVideoDB();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(VIDEO_STORE, "readwrite");
      tx.objectStore(VIDEO_STORE).delete(recordId);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/* IDs of disconnection / recheck records already uploaded. */
async function uploadedActivityIds() {
  const ids = new Set();
  for (const [store, field] of [["disconnections", "disconnection_id"], ["rechecks", "recheck_id"]]) {
    const rows = await getAllFromStore(store);
    rows.forEach(r => {
      if (String(r.upload_status || "").toUpperCase() === "UPLOADED" && r[field]) ids.add(r[field]);
    });
  }
  return ids;
}

/* Read-only / idempotent calls: retry delivery failures. */
async function serverPostWithRetry(action, extra) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await serverPost(action, extra);
    } catch (err) {
      console.error(`${action} attempt ${attempt} failed`, err);
      if (attempt === 3) {
        throw new Error("Could not reach the server. Please check your internet connection and try again.");
      }
      await new Promise(resolve => setTimeout(resolve, 3000 * attempt));
    }
  }
}

function putVideoToR2(url, blob, contentType, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let lastProgress = Date.now();

    /* No progress for 90 seconds: give up this attempt. */
    const watchdog = setInterval(() => {
      if (Date.now() - lastProgress > 90000) xhr.abort();
    }, 5000);

    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", contentType || blob.type || "application/octet-stream");

    xhr.upload.onprogress = e => {
      lastProgress = Date.now();
      if (e.lengthComputable && onProgress) onProgress(e.loaded, e.total);
    };
    xhr.onload = () => {
      clearInterval(watchdog);
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error("Video storage returned HTTP " + xhr.status + "."));
    };
    xhr.onerror = () => {
      clearInterval(watchdog);
      reject(new Error("Network problem while uploading the video."));
    };
    xhr.onabort = () => {
      clearInterval(watchdog);
      reject(new Error("Video upload stopped responding."));
    };

    xhr.send(blob);
  });
}

/* Returns "DONE", "LIMIT" or "DISABLED"; throws on other failures. */
async function uploadOneVideo(video, onProgress) {

  const link = await serverPostWithRetry("video_upload_url", {
    record_id: video.record_id,
    activity_type: video.activity_type,
    size_bytes: video.size_bytes,
    content_type: video.content_type,
    recorded_at: video.recorded_at
  });

  saveVideoSettings(link.video_settings);

  if (!link.success) {
    if (link.code === "VIDEO_DAILY_LIMIT") return { outcome: "LIMIT", message: link.message };
    if (link.code === "VIDEO_UPLOAD_DISABLED") {
      await deleteHiddenVideo(video.record_id);
      return { outcome: "DISABLED", message: link.message };
    }
    if (link.code === "AUTH") {
      logout();
      alert("Your login session has expired. Please login again.");
    }
    throw new Error(link.message || "Could not get a video upload link.");
  }

  if (link.already_uploaded) {
    await deleteHiddenVideo(video.record_id);
    return { outcome: "DONE" };
  }

  await putVideoToR2(link.upload_url, video.blob, link.content_type, onProgress);

  const confirm = await serverPostWithRetry("video_uploaded", {
    record_id: video.record_id,
    activity_type: video.activity_type,
    key: link.key
  });

  saveVideoSettings(confirm.video_settings);

  if (!confirm.success) {
    throw new Error(confirm.message || "Video upload could not be confirmed.");
  }

  await deleteHiddenVideo(video.record_id);
  return { outcome: "DONE" };
}

async function uploadPendingVideos() {

  if (videoUploadRunning) return;
  if (!state.sessionToken) return showLogin();

  videoUploadRunning = true;
  const button = $("uploadVideosBtn");
  if (button) button.disabled = true;

  try {

    const videos = await getPendingVideos();

    if (!videos.length) {
      return setStatus("videoUploadStatus", "No pending videos.", "ok");
    }

    /* A video's record must be on the server first: upload records automatically. */
    let uploadedIds = await uploadedActivityIds();

    if (videos.some(v => !uploadedIds.has(v.record_id))) {
      setStatus("videoUploadStatus", "Uploading records first…");
      await uploadPending();
      uploadedIds = await uploadedActivityIds();
    }

    const ready = videos.filter(v => uploadedIds.has(v.record_id));
    const waiting = videos.length - ready.length;

    if (!ready.length) {
      return setStatus(
        "videoUploadStatus",
        "The records could not be uploaded, so their videos are still pending. See the message under UPLOAD RECORDS.",
        "error"
      );
    }



    let done = 0;
    let disabled = 0;

    for (let i = 0; i < ready.length; i++) {

      const v = ready[i];
      const label = `Uploading video ${i + 1} of ${ready.length}`;
      setStatus("videoUploadStatus", label + "…");

      let result;

      try {
        result = await uploadOneVideo(v, (sent, total) => {
          setStatus(
            "videoUploadStatus",
            `${label}: ${formatBytes(sent)} / ${formatBytes(total)}`
          );
        });
      } catch (e) {
        setStatus(
          "videoUploadStatus",
          `Stopped after ${done} of ${ready.length} videos. ${e.message || "Upload failed."} ` +
          "Remaining videos are still pending.",
          "error"
        );
        return;
      }

      if (result.outcome === "LIMIT") {
        setStatus(
          "videoUploadStatus",
          `${done} uploaded. ${result.message} ${ready.length - done} videos are still pending.`,
          "error"
        );
        return;
      }

      if (result.outcome === "DISABLED") {
        disabled++;
        continue;
      }

      done++;
    }

    if (disabled) {
      setStatus(
        "videoUploadStatus",
        `Video upload is off for your subdivision. ${disabled} videos were removed from the upload list; ` +
        "their copies stay in the Download folder.",
        "error"
      );
      return;
    }

    setStatus(
      "videoUploadStatus",
      `Video upload complete. ${done} uploaded.` +
      (waiting ? ` ${waiting} videos are waiting because their records could not be uploaded yet.` : ""),
      "ok"
    );

  } catch (e) {
    console.error(e);
    setStatus("videoUploadStatus", e.message || "Video upload failed.", "error");
  } finally {
    videoUploadRunning = false;
    if (button) button.disabled = false;
    refreshVideoUploadInfo();
  }
}

/* Video counts in My Collection and Upload Status. */
async function refreshVideoCounts(pendingVideos) {

  if (!state.db) return;

  const [disconnections, rechecks] = await Promise.all([
    getAllFromStore("disconnections"),
    getAllFromStore("rechecks")
  ]);

  const today = v151LocalDateKey(new Date());
  const withVideo = list => list.filter(r => r.video_file);
  const todayCount = list => list.filter(r => v151LocalDateKey(r.created_at) === today).length;
  const pendingOf = type => (pendingVideos || []).filter(v => v.activity_type === type).length;
  const set = (id, n) => { if ($(id)) $(id).textContent = Number(n).toLocaleString("en-IN"); };

  const dv = withVideo(disconnections);
  const rv = withVideo(rechecks);

  set("uploadDisconnectionVideoSaved", dv.length);
  set("uploadDisconnectionVideoPending", pendingOf("DISCONNECTION"));
  set("uploadRecheckVideoSaved", rv.length);
  set("uploadRecheckVideoPending", pendingOf("RECHECK"));

  set("collectionDisconnectionVideoToday", todayCount(dv));
  set("collectionRecheckVideoToday", todayCount(rv));
  set("collectionDisconnectionVideoTotal", dv.length);
  set("collectionRecheckVideoTotal", rv.length);
}

/* Info line in the Videos section. */
async function refreshVideoUploadInfo() {

  const info = $("videoUploadInfo");
  if (!info || !state.userId) return;

  let videos = [];
  try { videos = await getPendingVideos(); } catch (e) {}

  refreshVideoCounts(videos).catch(err => console.error("Video counts failed", err));



  const settings = getVideoSettings();
  const bytes = videos.reduce((n, v) => n + (Number(v.size_bytes) || 0), 0);

  if (videos.length) {
    info.textContent =
      `Pending videos: ${videos.length} · ${formatBytes(bytes)}. Wi-Fi is recommended.`;
  } else if (settings.video_upload) {
    info.textContent = "No pending videos.";
  } else {
    info.textContent =
      "No pending videos. Video upload is currently off for your subdivision.";
  }
}
/*
 * =========================================================
 * SHARE ON WHATSAPP (Disconnection / Recheck)
 * =========================================================
 * After a successful save (and after the video was saved to the
 * Download folder), a "Saved" window offers sharing in two steps:
 *   1. SHARE ON WHATSAPP        -> the details (text message)
 *   2. SHARE VIDEO ON WHATSAPP  -> the video file (only if a
 *                                   video was recorded)
 * Sharing works offline: WhatsApp queues the message and sends
 * it when the network returns.
 */
let lastShareItem = null;

function shareDateText(iso) {
  try {
    return new Intl.DateTimeFormat("en-IN", {
      timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit"
    }).format(new Date(iso));
  } catch (e) {
    return String(iso || "");
  }
}

function buildActivityShareText(record) {

  const isDisc = record.activity_type === "DISCONNECTION";
  const status = isDisc ? record.disconnection_status : record.present_status;
  const lat = record.latitude, lng = record.longitude;

  return [
    "*" + (isDisc ? "DISCONNECTION" : "RECHECK") + "* – Fieldwork App",
    "Account: " + (record.account_id || ""),
    "Name: " + (record.consumer_name || ""),
    record.father_name ? "Father/Husband: " + record.father_name : "",
    record.feeded_village_name ? "Village: " + record.feeded_village_name : "",
    "Status: " + (status || ""),
    record.payment_mode ? "Payment Mode: " + record.payment_mode : "",
    record.committed_payment_date ? "Committed Payment Date: " + record.committed_payment_date : "",
    record.outstanding !== "" && record.outstanding != null ? "Outstanding: ₹" + record.outstanding : "",
    record.meter_status ? "Meter: " + record.meter_status : "",
    record.current_reading ? "Site Reading: " + record.current_reading : "",
    record.house_condition ? "House Condition: " + record.house_condition : "",
    record.remarks ? "Remark: " + record.remarks : "",
    lat && lng ? "Location: https://maps.google.com/?q=" + lat + "," + lng : "",
    "Date: " + shareDateText(record.created_at),
    "By: " + (record.user_name || "") + " (" + (record.user_id || "") + ")"
  ].filter(Boolean).join("\n");
}

function setShareButtons(step) {
  /* step: "details" | "video" */
  if ($("shareWhatsAppBtn")) $("shareWhatsAppBtn").classList.toggle("hidden", step !== "details");
  if ($("shareVideoBtn")) $("shareVideoBtn").classList.toggle("hidden", step !== "video");
}

async function openShareModal(record, video) {

  if (!$("shareModal")) return;

  /* Give the Download a moment to finish before the window opens. */
  if (video) await new Promise(resolve => setTimeout(resolve, 1500));

  lastShareItem = { record: record, video: video || null };

  const what = record.activity_type === "DISCONNECTION" ? "Disconnection" : "Recheck";
  $("shareModalText").textContent =
    what + " for account " + (record.account_id || "") + " is saved. " +
    (video ? "The video is saved in the Download folder as " + video.fileName + ". " : "") +
    "Tap SHARE ON WHATSAPP to send the details to your group.";

  setStatus("shareModalStatus", "");
  setShareButtons("details");
  $("shareModal").classList.remove("hidden");
}

function closeShareModal() {
  lastShareItem = null;
  if ($("shareModal")) $("shareModal").classList.add("hidden");
}

/* Step 1: the details as a text message. */
async function shareLastActivity() {

  const item = lastShareItem;
  if (!item) return;

  const text = buildActivityShareText(item.record);

  if (!navigator.share) {
    setStatus("shareModalStatus",
      "Sharing is not supported on this device.", "error");
    return;
  }



  try {
    await navigator.share({ text: text });
  } catch (e) {
    if (e && e.name === "AbortError") return;   /* user closed the Share sheet */
    console.error(e);
    setStatus("shareModalStatus",
      "Could not open sharing. Please try again.", "error");
    return;

  }

  if (!item.video || !item.video.blob) {
    closeShareModal();
    return;
  }

  /* Step 2 offered: the video. */
  setStatus("shareModalStatus",
    "Details shared. Do you also want to share the video on WhatsApp?", "ok");
  setShareButtons("video");
}

/* Step 2: the video file. */
async function shareLastActivityVideo() {

  const item = lastShareItem;
  if (!item || !item.video || !item.video.blob) return;

  const file = new File([item.video.blob], item.video.fileName, {
    type: item.video.contentType || "video/mp4"
  });

  if (!navigator.share || !navigator.canShare || !navigator.canShare({ files: [file] })) {
    setStatus("shareModalStatus",
      "This device cannot share the video from here. In WhatsApp, attach it from the Download folder: " +
      item.video.fileName, "error");
    return;
  }

  try {
    await navigator.share({ files: [file] });
    closeShareModal();
  } catch (e) {
    if (e && e.name === "AbortError") return;
    console.error(e);
    setStatus("shareModalStatus",
      "Could not share the video from here. In WhatsApp, attach it from the Download folder: " +
      item.video.fileName, "error");
  }
}

/*
 * =========================================================
 * DEFAULTER LIST (D2) — works offline from the phone's master
 * =========================================================
 * Own screen (defaulterListCard). Filters are switch lists with
 * "Select all", in one chain where each list narrows the next:
 *   Connection Status -> SDO Code -> Substation -> Feeder ->
 *   Village -> Supply Category -> Supply Type -> MR Source Code ->
 *   SBM Machine ID
 * Sanctioned Load (All / range) and Outstanding (numbers only),
 * Last Payment Date filter, DOC.
 * Up to 3 sort levels. PDF: A4 landscape, wrapped rows.
 */
const DL_BLANK = "__BLANK__";
const DL_ROW_WARNING = 3000;
const DL_BATCH = 5000;

const DL_SORT_FIELDS = [
  ["", "None"],
  ["outstanding", "Outstanding"],
  ["sdo", "SDO Code"],
  ["substation", "Substation"],
  ["feeder", "Feeder"],
  ["village", "Village"],
  ["supplyCat", "Supply Category"],
  ["lastPay", "Last Pay Date"],
  ["doc", "DOC"],
  ["load", "Sanctioned Load"],
  ["mrSource", "MR Source Code"],
  ["sbm", "SBM Machine ID"],
  ["account", "Account ID"],
  ["name", "Name"]
];

/* Switch lists: element id -> field in the options combos / sets. */
const DL_LISTS = ["dlStatus", "dlSdo", "dlSub", "dlFeeder", "dlVillage", "dlSupplyCat", "dlSupply", "dlMr", "dlSbm"];

/* One cascading chain, top to bottom: list id -> field in the combos. */
const DL_CHAINS = [
  {
    ids: ["dlStatus", "dlSdo", "dlSub", "dlFeeder", "dlVillage", "dlSupplyCat", "dlSupply", "dlMr", "dlSbm"],
    fields: ["status", "sdo", "sub", "feeder", "village", "cat", "supply", "mr", "sbm"],
    rows: "combos"
  }
];

/*
 * Supply category from the supply type code:
 *   10, 11, 11H, 17 -> LMV-1   (numeric part without its last digit)
 *   100, 101, 102   -> LMV-10
 *   H11, H12, H13   -> HV-1
 * A single digit keeps its digit (5 -> LMV-5). Blank -> BLANK,
 * anything else -> OTHER.
 */
function supplyCategory(value) {
  const s = String(value == null ? "" : value).trim().toUpperCase();
  if (!s) return DL_BLANK;
  const hv = s.match(/^H\s*-?\s*(\d+)/);
  if (hv) return "HV-" + (hv[1].length > 1 ? hv[1].slice(0, -1) : hv[1]);
  const lmv = s.match(/^(\d+)/);
  if (lmv) return "LMV-" + (lmv[1].length > 1 ? lmv[1].slice(0, -1) : lmv[1]);
  return "OTHER";
}

/* id -> null (all selected) or Set of selected values */
const dlSel = {};

const DL_DEFAULT_SORT = [["substation", "asc"], ["village", "asc"], ["outstanding", "desc"]];

let dlOptions = null;
let dlBusy = false;

/* ---------- reading the master ---------- */

/* Reads the active master in batches of 5000 (keeps the screen responsive). */
async function forEachMasterBatch(onBatch) {
  let lastKey = null;
  while (true) {
    const batch = await new Promise((resolve, reject) => {
      const store = state.masterDb
        .transaction(state.activeMasterStore, "readonly")
        .objectStore(state.activeMasterStore);
      const range = lastKey === null ? null : IDBKeyRange.lowerBound(lastKey, true);
      const req = store.getAll(range, DL_BATCH);
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    if (!batch.length) break;
    onBatch(batch);
    lastKey = batch[batch.length - 1].ACCT_ID;
    await new Promise(resolve => setTimeout(resolve, 0));
    if (batch.length < DL_BATCH) break;
  }
}

function dlVal(value) {
  const s = String(value == null ? "" : value).trim();
  return s || DL_BLANK;
}

function dlOutstanding(c) {
  return Number(String(c.TOTAL_OUTSTANDING == null ? "" : c.TOTAL_OUTSTANDING).replace(/,/g, "")) || 0;
}

async function dlLoadOptions() {

  const key = state.activeMasterStore + "|" + state.masterCount;
  if (dlOptions && dlOptions.key === key) return dlOptions;

  const combos = new Map();

  await forEachMasterBatch(batch => {
    for (const c of batch) {
      const combo = {
        status: dlVal(c.CONNECTION_STATUS),
        sdo: dlVal(c.SDO_CODE),
        sub: dlVal(c.SUBSTATION),
        feeder: dlVal(c.FEEDER),
        village: dlVal(c.feeded_village_name),
        cat: supplyCategory(c.SUPPLY_TYPE),
        supply: dlVal(c.SUPPLY_TYPE),
        mr: dlVal(c.MR_SOURCE_CD),
        sbm: dlVal(c.SBM_MACHINE_ID)
      };
      combos.set(
        [combo.status, combo.sdo, combo.sub, combo.feeder, combo.village, combo.supply, combo.mr, combo.sbm].join("|"),
        combo
      );
    }
  });

  dlOptions = {
    key: key,
    combos: Array.from(combos.values())
  };
  return dlOptions;
}

/* ---------- filter screen: switch lists ---------- */

function dlSortValues(values) {
  return values.slice().sort((a, b) => (a === DL_BLANK) - (b === DL_BLANK) || a.localeCompare(b, undefined, { numeric: true }));
}

function dlUpdateSummary(id) {
  const summary = $(id + "Summary");
  if (!summary) return;
  const total = (dlSel[id + "_values"] || []).length;
  const sel = dlSel[id];
  summary.textContent =
    sel === null ? "All" :
    !sel.size ? "None selected" :
    sel.size + " of " + total + " selected";
  summary.classList.toggle("dl-summary-warn", sel !== null && !sel.size);
}

/*
 * Builds one switch list. Earlier choices are kept: if the list was
 * on "all", it stays "all"; otherwise previously chosen values that
 * still exist stay chosen.
 */
function dlRenderChecklist(id, values) {

  const box = $(id);
  if (!box) return;

  const sorted = dlSortValues(values);
  const prev = dlSel[id];
  dlSel[id] = prev ? new Set(sorted.filter(v => prev.has(v))) : null;
  if (dlSel[id] && dlSel[id].size === sorted.length) dlSel[id] = null;
  dlSel[id + "_values"] = sorted;

  box.innerHTML = "";

  const makeRow = (text, checked, cls) => {
    const row = document.createElement("label");
    row.className = "dl-check" + (cls ? " " + cls : "");
    const span = document.createElement("span");
    span.textContent = text;
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = checked;
    const sw = document.createElement("span");
    sw.className = "dl-switch";
    row.appendChild(span);
    row.appendChild(input);
    row.appendChild(sw);
    return { row: row, input: input };
  };

  if (sorted.length > 12) {
    const search = document.createElement("input");
    search.className = "dl-search";
    search.placeholder = "Search / खोजें";
    search.addEventListener("input", () => {
      const q = search.value.trim().toLowerCase();
      box.querySelectorAll(".dl-check[data-value]").forEach(r => {
        r.classList.toggle("hidden", !!q && !r.dataset.label.toLowerCase().includes(q));
      });
    });
    box.appendChild(search);
  }

  const all = makeRow("Select all / सभी चुनें", dlSel[id] === null, "all");
  box.appendChild(all.row);

  const inputs = [];

  sorted.forEach(v => {
    const label = v === DL_BLANK ? "BLANK" : v;
    const item = makeRow(label, dlSel[id] === null || dlSel[id].has(v));
    item.row.dataset.value = v;
    item.row.dataset.label = label;
    inputs.push({ value: v, input: item.input });
    box.appendChild(item.row);

    item.input.addEventListener("change", () => {
      const chosen = new Set(inputs.filter(x => x.input.checked).map(x => x.value));
      dlSel[id] = chosen.size === sorted.length ? null : chosen;
      all.input.checked = dlSel[id] === null;
      dlUpdateSummary(id);
      dlAfterListChange(id);
    });
  });

  all.input.addEventListener("change", () => {
    inputs.forEach(x => { x.input.checked = all.input.checked; });
    dlSel[id] = all.input.checked ? null : new Set();
    dlUpdateSummary(id);
    dlAfterListChange(id);
  });

  dlUpdateSummary(id);
}

function dlAfterListChange(id) {
  /* Disconnected But Unpaid List uses the same switch lists. */
  if (id.indexOf("du") === 0) return duAfterListChange(id);
  const chain = DL_CHAINS.find(ch => ch.ids.indexOf(id) !== -1);
  if (chain && chain.ids.indexOf(id) < chain.ids.length - 1) dlRefreshCascade(id);
}

function dlChosen(id) {
  return dlSel[id] === undefined ? null : dlSel[id];
}

/*
 * Rebuilds the lists below the changed one in its chain
 * (changedId = the first list of a chain rebuilds that whole chain
 * except the first list; null = both chains from the top).
 */
function dlRefreshCascade(changedId) {

  const o = dlOptions;
  if (!o) return;

  DL_CHAINS.forEach(chain => {

    const pos = changedId ? chain.ids.indexOf(changedId) : 0;
    if (changedId && pos === -1) return;
    const from = changedId ? pos + 1 : 0;

    let rows = o[chain.rows];

    chain.ids.forEach((id, i) => {
      const field = chain.fields[i];
      if (i >= from) dlRenderChecklist(id, Array.from(new Set(rows.map(r => r[field]))));
      const sel = dlChosen(id);
      if (sel) rows = rows.filter(r => sel.has(r[field]));
    });
  });

  /* Hide Substation / Feeder / MR Source when the master has no such column. */
  [["dlSubBox", "sub"], ["dlFeederBox", "feeder"], ["dlMrBox", "mr"], ["dlSbmBox", "sbm"]].forEach(([box, field]) => {
    if ($(box)) $(box).classList.toggle("hidden", !o.combos.some(c => c[field] !== DL_BLANK));
  });
}

function dlToggleList(id) {
  const box = $(id);
  if (box) box.classList.toggle("hidden");
}

function dlInitSortSelects() {
  for (let i = 1; i <= 3; i++) {
    const field = $("dlSort" + i);
    const dir = $("dlDir" + i);
    if (!field || field.options.length) continue;
    DL_SORT_FIELDS.forEach(([value, label]) => {
      const o = document.createElement("option");
      o.value = value;
      o.textContent = label;
      field.appendChild(o);
    });
    [["asc", "Ascending"], ["desc", "Descending"]].forEach(([value, label]) => {
      const o = document.createElement("option");
      o.value = value;
      o.textContent = label;
      dir.appendChild(o);
    });
    field.value = DL_DEFAULT_SORT[i - 1][0];
    dir.value = DL_DEFAULT_SORT[i - 1][1];
  }
}

function dlUpdatePayBoxes() {
  const mode = $("dlPayMode").value;
  $("dlLongBox").classList.toggle("hidden", mode !== "LONG");
  $("dlSinceBox").classList.toggle("hidden", mode !== "SINCE");
}

function dlUpdateLoadBox() {
  $("dlLoadBox").classList.toggle("hidden", $("dlLoadMode").value !== "RANGE");
}

function dlUpdateDocBox() {
  $("dlDocBox").classList.toggle("hidden", $("dlDocMode").value !== "BETWEEN");
}

/* Number fields: digits and one decimal point only. */
function dlNumbersOnly(input) {
  input.addEventListener("input", () => {
    const clean = input.value.replace(/[^0-9.]/g, "").replace(/(\..*)\./g, "$1");
    if (clean !== input.value) input.value = clean;
  });
}

async function openDefaulterList() {

  if (!state.masterReady || !state.masterDb) {
    alert("Master Data is not ready yet. Please wait for the master to finish loading.");
    return;
  }

  dlInitSortSelects();
  dlUpdatePayBoxes();
  dlUpdateLoadBox();
  dlUpdateDocBox();
  setStatus("dlStatusMsg", "");
  showMainView("defaulterListCard");
  window.scrollTo(0, 0);

  if (dlOptions && dlOptions.key === state.activeMasterStore + "|" + state.masterCount) return;

  $("dlFilters").classList.add("hidden");
  setStatus("dlStatusMsg", "");
  showGlobalLoading("Reading Master Data…", "Preparing the filters. This can take a few seconds.");

  try {
    const o = await dlLoadOptions();
    DL_LISTS.forEach(id => { delete dlSel[id]; });
    dlRefreshCascade(null);
    $("dlFilters").classList.remove("hidden");
    setStatus("dlStatusMsg", "");
  } catch (e) {
    console.error(e);
    setStatus("dlStatusMsg", "Could not read Master Data. " + (e.message || ""), "error");
  } finally {
    hideGlobalLoading();
  }
}

function closeDefaulterList() {
  if (dlBusy) return;
  showMainView("home");
}

/* ---------- filtering ---------- */

function dlReadFilters() {

  const num = id => {
    const v = String($(id).value || "").trim();
    return v === "" || isNaN(Number(v)) ? null : Number(v);
  };
  const set = id => dlChosen(id);

  const sort = [];
  for (let i = 1; i <= 3; i++) {
    const field = $("dlSort" + i).value;
    if (field) sort.push({ field: field, dir: $("dlDir" + i).value });
  }

  return {
    sdo: set("dlSdo"),
    sub: $("dlSubBox").classList.contains("hidden") ? null : set("dlSub"),
    feeder: $("dlFeederBox").classList.contains("hidden") ? null : set("dlFeeder"),
    village: set("dlVillage"),
    status: set("dlStatus"),
    supplyCat: set("dlSupplyCat"),
    supply: set("dlSupply"),
    mr: $("dlMrBox").classList.contains("hidden") ? null : set("dlMr"),
    sbm: $("dlSbmBox") && !$("dlSbmBox").classList.contains("hidden") ? set("dlSbm") : null,
    loadMin: $("dlLoadMode").value === "RANGE" ? num("dlLoadMin") : null,
    loadMax: $("dlLoadMode").value === "RANGE" ? num("dlLoadMax") : null,
    outMin: num("dlOutMin"),
    payMode: $("dlPayMode").value,
    longDate: $("dlLongDate").value || "2023-03-31",
    sinceDate: $("dlSinceDate").value || "",
    docFrom: $("dlDocMode").value === "BETWEEN" ? ($("dlDocFrom").value || "") : "",
    docTo: $("dlDocMode").value === "BETWEEN" ? ($("dlDocTo").value || "") : "",
    sort: sort
  };
}

function dlMatches(c, f) {

  if (f.sdo && !f.sdo.has(dlVal(c.SDO_CODE))) return false;
  if (f.sub && !f.sub.has(dlVal(c.SUBSTATION))) return false;
  if (f.feeder && !f.feeder.has(dlVal(c.FEEDER))) return false;
  if (f.village && !f.village.has(dlVal(c.feeded_village_name))) return false;
  if (f.status && !f.status.has(dlVal(c.CONNECTION_STATUS))) return false;
  if (f.supplyCat && !f.supplyCat.has(supplyCategory(c.SUPPLY_TYPE))) return false;
  if (f.supply && !f.supply.has(dlVal(c.SUPPLY_TYPE))) return false;
  if (f.mr && !f.mr.has(dlVal(c.MR_SOURCE_CD))) return false;
  if (f.sbm && !f.sbm.has(dlVal(c.SBM_MACHINE_ID))) return false;

  if (f.outMin !== null && dlOutstanding(c) < f.outMin) return false;

  if (f.loadMin !== null || f.loadMax !== null) {
    const load = parseMasterLoad(c.LOAD);
    if (load === null) return false;
    if (f.loadMin !== null && load < f.loadMin) return false;
    if (f.loadMax !== null && load > f.loadMax) return false;
  }

  if (f.payMode !== "ALL") {
    const lastPay = parseMasterDate(c.LAST_PAY_DATE);
    const never = !lastPay || lastPay < NEVER_PAID_BEFORE;
    if (f.payMode === "NEVER" && !never) return false;
    if (f.payMode === "LONG" && (never || lastPay >= f.longDate)) return false;
    if (f.payMode === "SINCE" && f.sinceDate && !never && lastPay >= f.sinceDate) return false;
  }

  if (f.docFrom || f.docTo) {
    const doc = parseMasterDate(c.DOC);
    if (!doc) return false;
    if (f.docFrom && doc < f.docFrom) return false;
    if (f.docTo && doc > f.docTo) return false;
  }

  return true;
}

function dlRow(c) {
  return {
    account: String(c.ACCT_ID || ""),
    name: String(c.NAME || ""),
    father: String(c.FATHER_NAME || ""),
    village: String(c.feeded_village_name || ""),
    sdo: String(c.SDO_CODE || ""),
    substation: String(c.SUBSTATION || ""),
    feeder: String(c.FEEDER || ""),
    mrSource: String(c.MR_SOURCE_CD || ""),
    sbm: String(c.SBM_MACHINE_ID || ""),
    supplyCat: supplyCategory(c.SUPPLY_TYPE) === DL_BLANK ? "" : supplyCategory(c.SUPPLY_TYPE),
    mobile: String(c.MOBILE_NUMBER || ""),
    meter: String(c.METER_NO || ""),
    loadText: String(c.LOAD || ""),
    supplyType: String(c.SUPPLY_TYPE || ""),
    load: parseMasterLoad(c.LOAD),
    doc: parseMasterDate(c.DOC),
    outstanding: dlOutstanding(c),
    lastPay: parseMasterDate(c.LAST_PAY_DATE),
    lastPayAmount: String(c.LAST_PAY_AMOUNT || "")
  };
}

function dlCompare(a, b, sort) {
  for (const s of sort) {
    const va = a[s.field], vb = b[s.field];
    let cmp;
    if (typeof va === "number" || typeof vb === "number" || va === null || vb === null) {
      /* Numbers; missing values always last. */
      if (va === null || va === undefined) cmp = (vb === null || vb === undefined) ? 0 : 1;
      else if (vb === null || vb === undefined) cmp = -1;
      else cmp = s.dir === "desc" ? vb - va : va - vb;
      if (cmp) return cmp;
      continue;
    }
    const sa = String(va || ""), sb = String(vb || "");
    if (!sa || !sb) {
      cmp = (!sa) - (!sb);        /* empty always last */
    } else {
      cmp = sa.localeCompare(sb, undefined, { numeric: true });
      if (s.dir === "desc") cmp = -cmp;
    }
    if (cmp) return cmp;
  }
  return 0;
}

async function dlCollect(f, keepRows) {
  let count = 0, total = 0;
  const rows = [];
  await forEachMasterBatch(batch => {
    for (const c of batch) {
      if (!dlMatches(c, f)) continue;
      count++;
      total += dlOutstanding(c);
      if (keepRows) rows.push(dlRow(c));
    }
  });
  if (keepRows && f.sort.length) rows.sort((a, b) => dlCompare(a, b, f.sort));
  return { count: count, total: total, rows: rows };
}

/* Lists switched to "none": nothing could match. */
function dlEmptyListNames() {
  const names = {
    dlSdo: "SDO Code", dlSub: "Substation", dlFeeder: "Feeder", dlVillage: "Village",
    dlStatus: "Connection Status", dlSupplyCat: "Supply Category", dlSupply: "Supply Type", dlMr: "MR Source Code",
    dlSbm: "SBM Machine ID"
  };
  return DL_LISTS
    .filter(id => dlSel[id] && !dlSel[id].size && !($(id + "Box") && $(id + "Box").classList.contains("hidden")))
    .map(id => names[id]);
}

function dlMoney(n) {
  return "Rs. " + Math.round(n).toLocaleString("en-IN");
}

/* COUNT CONSUMERS */
async function previewDefaulterList() {
  if (dlBusy) return;
  const empty = dlEmptyListNames();
  if (empty.length) {
    return setStatus("dlStatusMsg", "Select at least one option in: " + empty.join(", ") + ".", "error");
  }
  dlBusy = true;
  setStatus("dlStatusMsg", "");
  showGlobalLoading("Counting consumers…", "Checking the Master Data against your filters.");
  try {
    const result = await dlCollect(dlReadFilters(), false);
    setStatus(
      "dlStatusMsg",
      result.count.toLocaleString("en-IN") + " consumers · Total outstanding " + dlMoney(result.total) +
      (result.count > DL_ROW_WARNING ? ". This is a large list; the PDF will take longer. Consider narrowing the filters." : ""),
      result.count ? "ok" : "error"
    );
  } catch (e) {
    console.error(e);
    setStatus("dlStatusMsg", "Could not count. " + (e.message || ""), "error");
  } finally {
    dlBusy = false;
    hideGlobalLoading();
  }
}

/* ---------- PDF ---------- */

function dlFilterSummary(f) {
  const list = (label, set) => set ? label + ": " + Array.from(set).map(v => v === DL_BLANK ? "BLANK" : v).join(", ") : "";
  const date = iso => formatListDate(iso);
  const pay = {
    ALL: "",
    NEVER: "Last payment: never paid",
    LONG: "Last payment: before " + date(f.longDate) + " (never-paid excluded)",
    SINCE: f.sinceDate ? "Last payment: not paid since " + date(f.sinceDate) : ""
  }[f.payMode];
  const sortText = f.sort.length
    ? "Sorted by: " + f.sort.map(s => (DL_SORT_FIELDS.find(x => x[0] === s.field) || ["", s.field])[1] + (s.dir === "desc" ? " (high to low)" : "")).join(", then ")
    : "";
  return [
    list("SDO Code", f.sdo),
    list("Substation", f.sub),
    list("Feeder", f.feeder),
    list("Village", f.village),
    list("Connection Status", f.status),
    list("Supply Category", f.supplyCat),
    list("Supply Type", f.supply),
    list("MR Source Code", f.mr),
    list("SBM Machine ID", f.sbm),
    f.loadMin !== null || f.loadMax !== null
      ? "Sanctioned Load: " + (f.loadMin !== null ? f.loadMin : "any") + " to " + (f.loadMax !== null ? f.loadMax : "any") + " kW" : "",
    f.outMin !== null ? "Outstanding at least " + dlMoney(f.outMin) : "",
    pay,
    f.docFrom || f.docTo ? "DOC: " + (f.docFrom ? date(f.docFrom) : "any") + " to " + (f.docTo ? date(f.docTo) : "any") : "",
    sortText
  ].filter(Boolean).join("  |  ") || "No filters (all consumers)";
}

function dlFileStamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + "_" + p(d.getHours()) + "-" + p(d.getMinutes());
}

async function downloadDefaulterPdf() {

  if (dlBusy) return;

  if (!window.jspdf || !window.jspdf.jsPDF || !window.jspdf.jsPDF.API.autoTable) {
    return setStatus("dlStatusMsg", "PDF library is not loaded. Please reload the app.", "error");
  }

  const empty = dlEmptyListNames();
  if (empty.length) {
    return setStatus("dlStatusMsg", "Select at least one option in: " + empty.join(", ") + ".", "error");
  }

  dlBusy = true;
  const f = dlReadFilters();
  let loading = true;
  showGlobalLoading("Preparing the list…", "Collecting consumers from the Master Data.");

  try {

    setStatus("dlStatusMsg", "");
    const result = await dlCollect(f, true);

    if (!result.count) {
      setStatus("dlStatusMsg", "No consumers match these filters.", "error");
      return;
    }

    if (result.count > DL_ROW_WARNING) {
      hideGlobalLoading();
      loading = false;
      if (!confirm(result.count.toLocaleString("en-IN") + " consumers match. A PDF this large takes time. Continue?")) {
        setStatus("dlStatusMsg", "");
        return;
      }
      showGlobalLoading("Creating PDF…", "");
      loading = true;
    }

    updateGlobalLoading("Creating PDF…", "Writing " + result.count.toLocaleString("en-IN") + " consumers to the PDF.");
    await new Promise(resolve => setTimeout(resolve, 50));

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4", compress: true });

    doc.setFontSize(14);
    doc.text("DEFAULTER LIST – Fieldwork App", 10, 12);

    doc.setFontSize(8);
    const meta =
      "Generated: " + shareDateText(new Date().toISOString()) +
      "   By: " + (state.userName || "") + " (" + (state.userId || "") + ")" +
      "   Consumers: " + result.count.toLocaleString("en-IN") +
      "   Total outstanding: " + dlMoney(result.total);
    doc.text(meta, 10, 18);

    const filterLines = doc.splitTextToSize("Filters: " + dlFilterSummary(f), 277);
    doc.text(filterLines, 10, 23);
    const startY = 25 + filterLines.length * 3.5;

    const body = result.rows.map((r, i) => [
      i + 1, r.account, r.name, r.father, r.village, r.substation, r.feeder, r.mrSource,
      r.mobile, r.meter, r.loadText, r.supplyType, formatListDate(r.doc),
      Math.round(r.outstanding).toLocaleString("en-IN"),
      formatListDate(r.lastPay), r.lastPayAmount, ""
    ]);

    doc.autoTable({
      startY: startY,
      margin: { left: 10, right: 10 },
      head: [[
        "S.No", "Account", "Name", "Father/Husband", "Village", "Substation", "Feeder", "MR Src",
        "Mobile", "Meter", "Load", "Supply", "DOC", "Outstanding (Rs.)", "Last Pay Date", "Last Pay Amt", "Remarks"
      ]],
      body: body,
      theme: "grid",

      styles: { fontSize: 7, cellPadding: 1.2, overflow: "linebreak", valign: "middle", lineColor: [120, 120, 120], lineWidth: 0.1, textColor: [0, 0, 0] },
      headStyles: { fillColor: [21, 101, 192], textColor: 255, fontSize: 7 },
      columnStyles: {
        0: { cellWidth: 8, halign: "right" },
        1: { cellWidth: 19 },
        2: { cellWidth: 24 },
        3: { cellWidth: 21 },
        4: { cellWidth: 19 },
        5: { cellWidth: 16 },
        6: { cellWidth: 17 },
        7: { cellWidth: 11 },
        8: { cellWidth: 18 },
        9: { cellWidth: 16 },
        10: { cellWidth: 10 },
        11: { cellWidth: 11 },
        12: { cellWidth: 16 },
        13: { cellWidth: 18, halign: "right" },
        14: { cellWidth: 16 },
        15: { cellWidth: 14, halign: "right" },
        16: { cellWidth: 18, minCellHeight: 8 }
      },
      didDrawPage: data => {
        doc.setFontSize(7);
        doc.text(
          "Page " + doc.internal.getNumberOfPages(),
          doc.internal.pageSize.getWidth() - 25,
          doc.internal.pageSize.getHeight() - 5
        );
      }
    });

    doc.save("Defaulter_List_" + dlFileStamp() + ".pdf");

    setStatus(
      "dlStatusMsg",
      "PDF saved to the Download folder: " + result.count.toLocaleString("en-IN") +
      " consumers · " + dlMoney(result.total) + ".",
      "ok"
    );

  } catch (e) {
    console.error(e);
    setStatus("dlStatusMsg", "Could not create the PDF. " + (e.message || ""), "error");
  } finally {
    dlBusy = false;
    if (loading) hideGlobalLoading();
  }
}

/*
 * =========================================================
 * DISCONNECTED BUT UNPAID LIST (D3)
 * =========================================================
 * 1. Fetches the latest disconnection per account of the
 *    user's subdivision from the server (Account ID, Disconnection
 *    ID, Disconnection Status, User ID, User Name, Created At).
 * 2. Everything else (name, father, village, substation, feeder,
 *    supply type, load, meter, mobile, outstanding, last pay,
 *    MR source, SBM ID, DOC...) comes from the phone's master.
 * 3. Keeps consumers whose master Last Pay Date is before the
 *    disconnection date (or never paid). Accounts not in the
 *    master are kept and marked "Not in master".
 * Filters (each switch list narrowing the next):
 *   Disconnection Status -> User -> Connection Status -> SDO Code
 *   -> Substation -> Feeder -> Village -> Supply Category ->
 *   Supply Type -> MR Source Code -> SBM Machine ID
 * plus Disconnection Date, Sanctioned Load, Outstanding, Last
 * Payment Date filter and DOC (same rules as the Defaulter List).
 */
const DU_LIST_IDS = [
  "duStatus", "duUser", "duConn", "duSdo", "duSub", "duFeeder",
  "duVillage", "duSupplyCat", "duSupply", "duMr", "duSbm"
];
const DU_FIELDS = [
  "status", "userLabel", "conn", "sdo", "sub", "feeder",
  "village", "cat", "supply", "mr", "sbm"
];
const DU_LIST_NAMES = {
  duStatus: "Disconnection Status", duUser: "User", duConn: "Connection Status",
  duSdo: "SDO Code", duSub: "Substation", duFeeder: "Feeder", duVillage: "Village",
  duSupplyCat: "Supply Category", duSupply: "Supply Type", duMr: "MR Source Code",
  duSbm: "SBM Machine ID"
};

const DU_SORT_FIELDS = [
  ["", "None"],
  ["userLabel", "User"],
  ["villageName", "Village"],
  ["outstanding", "Outstanding"],
  ["days", "Days Since Disconnection"],
  ["discDate", "Disconnection Date"],
  ["status", "Disconnection Status"],
  ["substation", "Substation"],
  ["feeder", "Feeder"],
  ["supplyCat", "Supply Category"],
  ["load", "Sanctioned Load"],
  ["lastPay", "Last Pay Date"],
  ["doc", "DOC"],
  ["account", "Account ID"],
  ["name", "Name"]
];

const DU_DEFAULT_SORT = [["userLabel", "asc"], ["villageName", "asc"], ["outstanding", "desc"], ["days", "desc"]];

let duRows = null;       /* unpaid rows after the last load */
let duLoadedCount = 0;   /* disconnections received from the server */
let duBusy = false;

/* ---------- master lookup in one transaction ---------- */

function duLookupMaster(accounts) {
  return new Promise((resolve, reject) => {
    const found = new Map();
    const tx = state.masterDb.transaction(state.activeMasterStore, "readonly");
    const store = tx.objectStore(state.activeMasterStore);
    const index = store.index("acct_norm");

    accounts.forEach(account => {
      const raw = String(account || "").trim();
      const req = store.get(raw);
      req.onsuccess = () => {
        if (req.result) {
          found.set(raw, req.result);
          return;
        }
        /* Not stored under the exact ID: try without leading zeros. */
        const alt = index.get(normalizeAccountInput(raw));
        alt.onsuccess = () => { if (alt.result) found.set(raw, alt.result); };
      };
    });

    tx.oncomplete = () => resolve(found);
    tx.onerror = () => reject(tx.error);
  });
}

function duDaysSince(isoDate) {
  if (!isoDate) return null;
  const [y, m, d] = isoDate.split("-").map(Number);
  const then = Date.UTC(y, m - 1, d);
  const now = new Date();
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.max(0, Math.round((today - then) / 86400000));
}

function duBuildRow(disc, master) {
  const account = String(disc.account_id || "").trim();
  const c = master || { ACCT_ID: account, NAME: "Not in master" };
  const userId = String(disc.user_id || "");

  return Object.assign(dlRow(c), {
    c: c,
    inMaster: !!master,
    account: master ? String(master.ACCT_ID || account) : account,
    villageName: String(c.feeded_village_name || ""),
    discDate: String(disc.date || ""),
    days: duDaysSince(disc.date),
    status: dlVal(disc.status),
    userLabel: dlVal(userId ? userId + (disc.user_name ? " - " + disc.user_name : "") : ""),

    /* switch-list fields */
    conn: dlVal(c.CONNECTION_STATUS),
    sdo: dlVal(c.SDO_CODE),
    sub: dlVal(c.SUBSTATION),
    feederKey: dlVal(c.FEEDER),
    village: dlVal(c.feeded_village_name),
    cat: supplyCategory(c.SUPPLY_TYPE),
    supply: dlVal(c.SUPPLY_TYPE),
    mr: dlVal(c.MR_SOURCE_CD),
    sbm: dlVal(c.SBM_MACHINE_ID)
  });
}

/* Unpaid = never paid, or last payment before the disconnection date. */
function duIsUnpaid(row) {
  if (!row.inMaster) return true;
  if (!row.lastPay || row.lastPay < NEVER_PAID_BEFORE) return true;
  return row.lastPay < row.discDate;
}

/* ---------- screen ---------- */

function duInitSortSelects() {
  for (let i = 1; i <= 4; i++) {
    const field = $("duSort" + i);
    const dir = $("duDir" + i);
    if (!field || field.options.length) continue;
    DU_SORT_FIELDS.forEach(([value, label]) => {
      const o = document.createElement("option");
      o.value = value;
      o.textContent = label;
      field.appendChild(o);
    });
    [["asc", "Ascending"], ["desc", "Descending"]].forEach(([value, label]) => {
      const o = document.createElement("option");
      o.value = value;
      o.textContent = label;
      dir.appendChild(o);
    });
    field.value = DU_DEFAULT_SORT[i - 1][0];
    dir.value = DU_DEFAULT_SORT[i - 1][1];
  }
}

function duUpdateBoxes() {
  $("duDateBox").classList.toggle("hidden", $("duDateMode").value !== "BETWEEN");
  $("duLoadBox").classList.toggle("hidden", $("duLoadMode").value !== "RANGE");
  $("duDocBox").classList.toggle("hidden", $("duDocMode").value !== "BETWEEN");
  const pay = $("duPayMode").value;
  $("duLongBox").classList.toggle("hidden", pay !== "LONG");
  $("duSinceBox").classList.toggle("hidden", pay !== "SINCE");
}

/* The feeder switch list uses feederKey (feeder is the PDF text). */
function duField(i) {
  return DU_FIELDS[i] === "feeder" ? "feederKey" : DU_FIELDS[i];
}

function duRefreshCascade(changedId) {

  if (!duRows) return;

  const from = changedId ? DU_LIST_IDS.indexOf(changedId) + 1 : 0;
  let rows = duRows;

  DU_LIST_IDS.forEach((id, i) => {
    const field = duField(i);
    if (i >= from) dlRenderChecklist(id, Array.from(new Set(rows.map(r => r[field]))));
    const sel = dlChosen(id);
    if (sel) rows = rows.filter(r => sel.has(r[field]));
  });

  [["duSubBox", "sub"], ["duFeederBox", "feederKey"], ["duMrBox", "mr"], ["duSbmBox", "sbm"]].forEach(([box, field]) => {
    if ($(box)) $(box).classList.toggle("hidden", !duRows.some(r => r[field] !== DL_BLANK));
  });
}

function duAfterListChange(id) {
  if (DU_LIST_IDS.indexOf(id) < DU_LIST_IDS.length - 1) duRefreshCascade(id);
}

async function openDisconnectedUnpaidList() {

  if (!state.masterReady || !state.masterDb) {
    alert("Master Data is not ready yet. Please wait for the master to finish loading.");
    return;
  }

  duInitSortSelects();
  duUpdateBoxes();
  showMainView("disconnectedUnpaidCard");
  window.scrollTo(0, 0);

  if (!duRows) await loadDisconnectedUnpaid();
}

function closeDisconnectedUnpaidList() {
  if (duBusy) return;
  showMainView("home");
}

/* LOAD / REFRESH FROM SERVER */
async function loadDisconnectedUnpaid() {

  if (duBusy) return;
  duBusy = true;

  const button = $("duLoadBtn");
  if (button) button.disabled = true;

  setStatus("duStatusMsg", "");
  showGlobalLoading("Loading disconnections…", "Fetching the disconnection list from the server.");

  try {

    const result = await serverPostWithRetry("disconnection_list");

    if (!result.success) {
      if (result.code === "AUTH") {
        logout();
        alert("Your login session has expired. Please login again.");
        return;
      }
      throw new Error(result.message || "Could not load disconnections.");
    }

    const list = Array.isArray(result.disconnections) ? result.disconnections : [];

    updateGlobalLoading(
      "Matching with Master Data…",
      "Adding consumer details for " + list.length.toLocaleString("en-IN") + " disconnected accounts."
    );

    const master = await duLookupMaster(list.map(d => d.account_id));

    duLoadedCount = list.length;
    duRows = list
      .map(d => duBuildRow(d, master.get(String(d.account_id || "").trim())))
      .filter(duIsUnpaid);

    DU_LIST_IDS.forEach(id => { delete dlSel[id]; });
    duRefreshCascade(null);
    $("duFilters").classList.remove("hidden");

    setStatus(
      "duStatusMsg",
      duLoadedCount.toLocaleString("en-IN") + " disconnected accounts loaded; " +
      duRows.length.toLocaleString("en-IN") + " have not paid since disconnection.",
      "ok"
    );

  } catch (e) {
    console.error(e);
    setStatus("duStatusMsg", (e.message || "Could not load disconnections.") +
      (duRows ? " The previously loaded list is still shown." : ""), "error");
  } finally {
    duBusy = false;
    if (button) button.disabled = false;
    hideGlobalLoading();
  }
}

/* ---------- filtering ---------- */

function duReadFilters() {

  const num = id => {
    const v = String($(id).value || "").trim();
    return v === "" || isNaN(Number(v)) ? null : Number(v);
  };
  const shown = box => !$(box).classList.contains("hidden");

  const sort = [];
  for (let i = 1; i <= 4; i++) {
    const field = $("duSort" + i).value;
    if (field) sort.push({ field: field, dir: $("duDir" + i).value });
  }

  const dateBetween = $("duDateMode").value === "BETWEEN";
  const loadRange = $("duLoadMode").value === "RANGE";
  const docBetween = $("duDocMode").value === "BETWEEN";

  return {
    /* disconnection part */
    discStatus: dlChosen("duStatus"),
    user: dlChosen("duUser"),
    dateFrom: dateBetween ? ($("duDateFrom").value || "") : "",
    dateTo: dateBetween ? ($("duDateTo").value || "") : "",

    /* master part: same shape as the Defaulter List filters */
    master: {
      status: dlChosen("duConn"),
      sdo: dlChosen("duSdo"),
      sub: shown("duSubBox") ? dlChosen("duSub") : null,
      feeder: shown("duFeederBox") ? dlChosen("duFeeder") : null,
      village: dlChosen("duVillage"),
      supplyCat: dlChosen("duSupplyCat"),
      supply: dlChosen("duSupply"),
      mr: shown("duMrBox") ? dlChosen("duMr") : null,
      sbm: shown("duSbmBox") ? dlChosen("duSbm") : null,
      loadMin: loadRange ? num("duLoadMin") : null,
      loadMax: loadRange ? num("duLoadMax") : null,
      outMin: num("duOutMin"),
      payMode: $("duPayMode").value,
      longDate: $("duLongDate").value || "2023-03-31",
      sinceDate: $("duSinceDate").value || "",
      docFrom: docBetween ? ($("duDocFrom").value || "") : "",
      docTo: docBetween ? ($("duDocTo").value || "") : ""
    },

    sort: sort
  };
}

function duMatches(r, f) {
  if (f.discStatus && !f.discStatus.has(r.status)) return false;
  if (f.user && !f.user.has(r.userLabel)) return false;
  if (f.dateFrom && r.discDate < f.dateFrom) return false;
  if (f.dateTo && r.discDate > f.dateTo) return false;
  return dlMatches(r.c, f.master);
}

function duEmptyListNames() {
  return DU_LIST_IDS
    .filter(id => dlSel[id] && !dlSel[id].size && !($(id + "Box") && $(id + "Box").classList.contains("hidden")))
    .map(id => DU_LIST_NAMES[id]);
}

function duCollect(f) {
  const rows = duRows.filter(r => duMatches(r, f));
  if (f.sort.length) rows.sort((a, b) => dlCompare(a, b, f.sort));
  const total = rows.reduce((n, r) => n + (r.inMaster ? r.outstanding : 0), 0);
  return { rows: rows, count: rows.length, total: total };
}

function duCheckReady() {
  if (!duRows) {
    setStatus("duStatusMsg", "Load the disconnections first (needs internet).", "error");
    return false;
  }
  const empty = duEmptyListNames();
  if (empty.length) {
    setStatus("duStatusMsg", "Select at least one option in: " + empty.join(", ") + ".", "error");
    return false;
  }
  return true;
}

function previewDisconnectedUnpaid() {
  if (!duCheckReady()) return;
  const result = duCollect(duReadFilters());
  setStatus(
    "duStatusMsg",
    result.count.toLocaleString("en-IN") + " consumers · Total outstanding " + dlMoney(result.total),
    result.count ? "ok" : "error"
  );
}

/* ---------- PDF ---------- */

function duFilterSummary(f) {
  const label = v => v === DL_BLANK ? "BLANK" : v;
  const list = (name, set) => set ? name + ": " + Array.from(set).map(label).join(", ") : "";
  const sortText = f.sort.length
    ? "Sorted by: " + f.sort.map(s => (DU_SORT_FIELDS.find(x => x[0] === s.field) || ["", s.field])[1] + (s.dir === "desc" ? " (high to low)" : "")).join(", then ")
    : "";
  const own = [
    list("Disconnection Status", f.discStatus),
    list("User", f.user),
    f.dateFrom || f.dateTo
      ? "Disconnection date: " + (f.dateFrom ? formatListDate(f.dateFrom) : "any") + " to " + (f.dateTo ? formatListDate(f.dateTo) : "any") : ""
  ].filter(Boolean);

  /* Master filters described the same way as in the Defaulter List. */
  const masterText = dlFilterSummary(Object.assign({}, f.master, { sort: [] }));
  if (masterText !== "No filters (all consumers)") own.push(masterText);
  if (sortText) own.push(sortText);

  return own.join("  |  ") || "No filters (all unpaid disconnected consumers)";
}

async function downloadDisconnectedUnpaidPdf() {

  if (!duCheckReady() || duBusy) return;

  if (!window.jspdf || !window.jspdf.jsPDF || !window.jspdf.jsPDF.API.autoTable) {
    return setStatus("duStatusMsg", "PDF library is not loaded. Please reload the app.", "error");
  }

  const f = duReadFilters();
  const result = duCollect(f);

  if (!result.count) {
    return setStatus("duStatusMsg", "No consumers match these filters.", "error");
  }

  if (result.count > DL_ROW_WARNING &&
      !confirm(result.count.toLocaleString("en-IN") + " consumers match. A PDF this large takes time. Continue?")) {
    return;
  }

  duBusy = true;
  setStatus("duStatusMsg", "");
  showGlobalLoading("Creating PDF…", "Writing " + result.count.toLocaleString("en-IN") + " consumers to the PDF.");

  try {

    await new Promise(resolve => setTimeout(resolve, 50));

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4", compress: true });
    const text = v => (v === DL_BLANK ? "" : String(v == null ? "" : v));

    doc.setFontSize(14);
    doc.text("DISCONNECTED BUT UNPAID LIST – Fieldwork App", 10, 12);

    doc.setFontSize(8);
    doc.text(
      "Generated: " + shareDateText(new Date().toISOString()) +
      "   By: " + (state.userName || "") + " (" + (state.userId || "") + ")" +
      "   Consumers: " + result.count.toLocaleString("en-IN") +
      "   Total outstanding: " + dlMoney(result.total),
      10, 18
    );

    const filterLines = doc.splitTextToSize("Filters: " + duFilterSummary(f), 277);
    doc.text(filterLines, 10, 23);
    const startY = 25 + filterLines.length * 3.5;

    const body = result.rows.map((r, i) => [
      i + 1, r.account, r.name, r.father, r.villageName, r.substation, r.feeder,
      r.meter, r.mobile, r.loadText, r.supplyType,
      formatListDate(r.discDate), text(r.status), text(r.userLabel),
      r.days === null ? "" : r.days,
      r.inMaster ? Math.round(r.outstanding).toLocaleString("en-IN") : "",
      formatListDate(r.lastPay), r.lastPayAmount, ""
    ]);

    doc.autoTable({
      startY: startY,
      margin: { left: 10, right: 10 },
      head: [[
        "S.No", "Account", "Name", "Father/Husband", "Village", "Substation", "Feeder",
        "Meter", "Mobile", "Load", "Supply", "Disc. Date", "Disc. Status", "User", "Days",
        "Outstanding (Rs.)", "Last Pay Date", "Last Pay Amt", "Remarks"
      ]],
      body: body,
      theme: "grid",

      styles: { fontSize: 6.5, cellPadding: 1, overflow: "linebreak", valign: "middle", lineColor: [120, 120, 120], lineWidth: 0.1, textColor: [0, 0, 0] },

      headStyles: { fillColor: [21, 101, 192], textColor: 255, fontSize: 6.5 },
      columnStyles: {
        0: { cellWidth: 7, halign: "right" },
        1: { cellWidth: 17 },
        2: { cellWidth: 20 },
        3: { cellWidth: 18 },
        4: { cellWidth: 16 },
        5: { cellWidth: 14 },
        6: { cellWidth: 14 },
        7: { cellWidth: 14 },
        8: { cellWidth: 16 },
        9: { cellWidth: 9 },
        10: { cellWidth: 10 },
        11: { cellWidth: 14 },
        12: { cellWidth: 16 },
        13: { cellWidth: 17 },
        14: { cellWidth: 8, halign: "right" },
        15: { cellWidth: 15, halign: "right" },
        16: { cellWidth: 14 },
        17: { cellWidth: 12, halign: "right" },
        18: { cellWidth: 16, minCellHeight: 8 }
      },
      didDrawPage: () => {
        doc.setFontSize(7);
        doc.text(
          "Page " + doc.internal.getNumberOfPages(),
          doc.internal.pageSize.getWidth() - 25,
          doc.internal.pageSize.getHeight() - 5
        );
      }
    });

    doc.save("Disconnected_But_Unpaid_" + dlFileStamp() + ".pdf");

    setStatus(
      "duStatusMsg",
      "PDF saved to the Download folder: " + result.count.toLocaleString("en-IN") +
      " consumers · " + dlMoney(result.total) + ".",
      "ok"
    );

  } catch (e) {
    console.error(e);
    setStatus("duStatusMsg", "Could not create the PDF. " + (e.message || ""), "error");
  } finally {
    duBusy = false;
    hideGlobalLoading();
  }
}


/*
 * Ask the browser to keep this app's data (login, master,
 * saved/pending records) even when the phone is low on
 * storage. No prompt on Android Chrome; silently ignored
 * where not supported.
 */
function requestPersistentStorage() {
  try {
    if (!navigator.storage || !navigator.storage.persist) return;

    navigator.storage.persisted()
      .then(already => already || navigator.storage.persist())
      .then(granted => console.log("Persistent storage:", granted ? "granted" : "not granted"))
      .catch(err => console.warn("Persistent storage request failed", err));
  } catch (e) {
    console.warn("Persistent storage not available", e);
  }
}



async function init() {

  /*
   * An earlier broken login could have saved the text
   * "undefined" as token / user. Treat that as logged out.
   */
  if (
    ["undefined", "null"].includes(state.sessionToken) ||
    ["undefined", "null"].includes(state.userId)
  ) {
    logout();
  }

  try {



    await openDB();


    /*
     * Village dropdowns: filled from the list saved on this
     * phone (no network). See VILLAGE LIST section.
     */
    renderSavedVillageList();

    updateCounts();


    if (state.sessionToken && state.userId) {
      // Restore the saved local session immediately. Server validation runs in
      // the background so the user does not see the login screen on every launch.
      showApp();
      setMasterGate(!state.masterReady);

      ensureVillageList();

      /* Master setup starts once permissions are confirmed. */
      ensureDevicePermissions().then(() => startMasterSetup());

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

    /*
     * A startup error must never look like a logout.
     * If a login is saved and the home screen is not shown yet,
     * show it (the login stays saved) and tell the user.
     */
    if (
      state.sessionToken &&
      state.userId &&
      $("appContent").classList.contains("hidden")
    ) {
      try {
        showApp();
        setMasterGate(!state.masterReady);
        startMasterSetup();
      } catch (e2) {
        console.error(e2);
      }

      alert(
        "Some app data could not be loaded. You are still logged in. " +
        "If something does not work, please close and reopen the app.\n\n" +
        "Details: " + (e.message || e)
      );
    }
  }
}




function masterCellToString(value) {
  if (value === null || value === undefined) return "";

  if (value instanceof Date) {
    /*
     * Round to the nearest day: Excel dates can arrive a few
     * minutes before midnight (time-zone history), which would
     * otherwise show the previous day.
     */
    value=new Date(value.getTime()+12*60*60*1000);
    const y=value.getFullYear();

    const m=String(value.getMonth()+1).padStart(2,"0");
    const d=String(value.getDate()).padStart(2,"0");
    return `${y}-${m}-${d}`;
  }

  return String(value).trim();
}

/*
 * =========================================================
 * MASTER VALUE HELPERS (dates, load) — used by the lists
 * =========================================================
 * Dates in the master can be real Excel dates (stored as
 * YYYY-MM-DD on import), text like 18/07/2023, 18-07-2023,
 * 18.07.2023, or an Excel serial number. Day comes first.
 * Blank, impossible (00/01/1900) or before 2010 = never paid.
 */
const NEVER_PAID_BEFORE = "2010-01-01";

/* Returns "YYYY-MM-DD", or "" when blank / not a real date. */
function parseMasterDate(value) {

  const s = String(value == null ? "" : value).trim();
  if (!s) return "";

  let y, m, d, match;

  if ((match = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) {
    y = +match[1]; m = +match[2]; d = +match[3];
  } else if ((match = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})\b/))) {
    d = +match[1]; m = +match[2]; y = +match[3];
    if (match[3].length === 2) y += y < 50 ? 2000 : 1900;
  } else if (/^\d{4,6}(\.\d+)?$/.test(s)) {
    /* Excel serial number (days since 1899-12-30). */
    const serial = Math.floor(Number(s));
    if (serial < 1) return "";
    const dt = new Date(Date.UTC(1899, 11, 30) + serial * 86400000);
    y = dt.getUTCFullYear(); m = dt.getUTCMonth() + 1; d = dt.getUTCDate();
  } else {
    return "";
  }

  if (y < 1900 || m < 1 || m > 12 || d < 1) return "";
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (d > daysInMonth) return "";

  return y + "-" + String(m).padStart(2, "0") + "-" + String(d).padStart(2, "0");
}

/* DD-MM-YYYY for lists and PDFs ("" when not a real date). */
function formatListDate(value) {
  const iso = parseMasterDate(value);
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return d + "-" + m + "-" + y;
}

function isNeverPaid(lastPayDate) {
  const iso = parseMasterDate(lastPayDate);
  return !iso || iso < NEVER_PAID_BEFORE;
}

/* Sanctioned load as a number: "2", "2.5", "2 KW" -> 2 / 2.5. */
function parseMasterLoad(value) {
  const match = String(value == null ? "" : value).match(/\d+(\.\d+)?/);
  return match ? Number(match[0]) : null;
}



function xlsxToConsumer(row, header) {
  const o={};

  for (let i=0;i<header.length;i++) {
    const key=String(header[i] ?? "").trim().toLowerCase();
    o[key]=masterCellToString(row[i]);
  }

  /*
   * Optional list columns are matched ignoring case, spaces,
   * underscores and hidden characters (e.g. "MR_SOURCE_CD",
   * "MR SOURCE CD", "Mr Source Cd" all match). Normalised once
   * per file, not per row.
   */
  if (!header.__normalized) {
    header.__normalized = header.map(h => String(h ?? "").toLowerCase().replace(/[^a-z0-9]/g, ""));
  }
  const n = {};
  header.__normalized.forEach((k, i) => {
    if (k && !(k in n)) n[k] = masterCellToString(row[i]);
  });

  const c={
    ACCT_ID:o["acct_id"] || "",
    SDO_CODE:o["sdo_code"] || "",
    NAME:o["name"] || "",
    FATHER_NAME:o["father_name"] || "",
    ADDRESS:o["address"] || "",
    feeded_village_name:n["feededvillagename"] || n["habitatname"] || "",

    SUPPLY_TYPE:o["supply_type"] || "",
    LOAD:o["load"] || "",
    CONNECTION_STATUS:n["connectionstatus"] || n["constatus"] || "",
    METER_NO:n["meterno"] || n["serialnbr"] || "",

    TOTAL_OUTSTANDING:n["totaloutstanding"] || "",
    CURRENT_READING:n["currentreading"] || n["closereading"] || "",
    MOBILE_NUMBER:n["mobilenumber"] || n["mobileno"] || "",
    
    LAST_PAY_DATE:o["last_pay_date"] || "",

    LAST_PAY_AMOUNT:o["last_pay_amount"] || "",

    /* Optional column: masters without it still import. */
    CONSUMPTION_CURR_MNTH:o["consumption_curr_mnth"] || "",

    /* Optional columns for the lists (Defaulter List etc.). */

    SUBSTATION:o["substation"] || "",
    FEEDER:o["feeder"] || "",
    DOC:o["doc"] || "",
      
    MR_SOURCE_CD:n["mrsourcecd"] || n["metersourcecd"] || "",
    SBM_MACHINE_ID:n["sbmmachineid"] || ""
  };

  c._acct_norm=String(c.ACCT_ID||"").replace(/\D/g,"");
  c._meter_norm=String(c.METER_NO||"").toUpperCase().replace(/\s+/g,"");

  return c;
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



function updateMasterSetupUI(
  status,
  count=0,
  message="",
  showContinue=false
) {


  const card=$("masterSetupCard");
  if (!card) return;

  card.classList.remove("hidden");



  /* TRY AGAIN button: visible only in the error state. */
  const retryBtn=$("masterSetupRetryBtn");
  if (retryBtn) retryBtn.classList.toggle("hidden", status!=="error");



  const safeCount=
    Math.max(0, Number(count)||0);

  if (status==="ready") {
    $("masterSetupBar").style.width="100%";
    $("masterSetupCount").textContent=
      `${safeCount.toLocaleString()} consumers`;

    const badge=$("masterSetupBadge");
    const text=$("masterSetupText");

    badge.textContent="READY";
    badge.className="master-setup-badge ready";

    text.textContent=
      `${safeCount.toLocaleString()} consumers loaded successfully. You can now search consumers offline.`;

    $("masterSetupContinueBtn")
      .classList
      .toggle("hidden", !showContinue);

    setMasterGate(false);

  } else if (status==="error") {

    $("masterSetupBar").style.width="0%";
    $("masterSetupCount").textContent=
      safeCount > 0
        ? `${safeCount.toLocaleString()} consumers`
        : "";

    const badge=$("masterSetupBadge");
    const text=$("masterSetupText");

    badge.textContent="ERROR";
    badge.className="master-setup-badge error";

    text.textContent=
      message || "Master data could not be loaded.";

    $("masterSetupContinueBtn")
      .classList
      .add("hidden");

    setMasterGate(true);

  } else {

    const badge=$("masterSetupBadge");
    const text=$("masterSetupText");

    badge.textContent="LOADING";
    badge.className="master-setup-badge loading";

    text.textContent=
      message ||
      "Consumer master data is being prepared for offline use. Please keep the app open.";

    $("masterSetupContinueBtn")
      .classList
      .add("hidden");

    /*
     * Do not show a fake fixed consumer denominator.
     * Download/import progress is shown in the message itself.
     */
    $("masterSetupCount").textContent=
      safeCount > 0
        ? `${safeCount.toLocaleString()} consumers imported`
        : "";

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

  await openMasterDB();

  const count =
    await countMasterConsumers();

  /*
   * If a valid local master already exists,
   * allow the application to work offline.
   *
   * We do NOT contact the server automatically here.
   */


  if (count > 0) {

    /*
     * A non-empty active master store is sufficient
     * to continue offline.
     *
     * Do NOT validate against any fixed account,
     * meter number, or hard-coded consumer record.
     *
     * Consumer master contents can change monthly.
     */

    state.masterCount =
      count;

    state.masterReady =
      true;

    updateMasterSetupUI(
      "ready",
      count,
      "",
      false
    );

    closeMasterSetup();

    return;

  }




  /*
   * No usable local master exists.
   * Initial installation therefore requires the
   * currently assigned master from the backend.
   */
  state.masterReady =
    false;

  updateMasterSetupUI(
    "loading",
    0,
    "Checking assigned Master Data…"
  );

  const masterInfo =
    await checkAssignedMaster();

  updateMasterSetupUI(
    "loading",
    0,
    `Downloading ${masterInfo.file_name}…`
  );

  const buffer =
    await downloadAssignedMaster(
      masterInfo
    );

  const importedCount =
    await importMasterIntoPending(
      buffer,
      masterInfo
    );

  state.masterReady =
    true;

  state.masterCount =
    importedCount;

  updateMasterSetupUI(
    "ready",
    importedCount,
    "",
    true
  );

  setStatus(
    "searchStatus",
    `${importedCount.toLocaleString()} consumers loaded locally. Search is ready.`,
    "ok"
  );

}

async function checkAndUpdateMasterData() {

  if (!state.sessionToken) {
    return;
  }

  const status =
    $("masterUpdateStatus");

  const details =
    $("masterUpdateDetails");

  const button =
    $("checkMasterUpdateBtn");

  if (button) {
    button.disabled = true;
  }

  if (status) {
    status.className =
      "status";
    status.textContent =
      "Checking assigned Master Data…";
  }

  if (details) {
    details.classList.add(
      "hidden"
    );
  }

  /*
   * Hide a previously shown UPDATE button; it is shown
   * again below only if a new master is available.
   */
  const staleUpdateButton =
    $("downloadMasterUpdateBtn");

  if (staleUpdateButton) {
    staleUpdateButton.classList.add("hidden");
  }

  try {

    await openMasterDB();

    const remote =
      await checkAssignedMaster();

    const local =
      getLocalMasterMeta();

    if (
      local &&
      String(
        local.master_file_id || ""
      ) ===
      String(
        remote.master_file_id || ""
      )
    ) {

      if (status) {

        status.className =
          "status ok";

        status.textContent =
          "Master Data is already up to date.";

      }

      if (details) {

        details.classList.remove(
          "hidden"
        );

        details.innerHTML =
          `
          <div><b>File:</b> ${escapeHtml(remote.file_name)}</div>
          <div><b>Last Updated:</b> ${formatMasterDate(remote.last_updated)}</div>
          <div><b>Local Consumers:</b> ${state.masterCount.toLocaleString()}</div>
          <div><b>Source:</b> ${masterSourceLabel(remote)}</div>
          `;

      }

      return;

    }

    /*
     * A different Drive file is assigned.
     */
    if (details) {

      details.classList.remove(
        "hidden"
      );

      details.innerHTML =
        `
        <div><b>Current Local Master:</b>
          ${escapeHtml(local?.file_name || "Older/unknown master")}
        </div>

        <div><b>New Master:</b>
          ${escapeHtml(remote.file_name)}
        </div>

        <div><b>New Master Updated:</b>
          ${formatMasterDate(remote.last_updated)}
        </div>

        <div><b>New File Size:</b>
          ${formatBytes(remote.file_size)}
        </div>
        <div><b>Source:</b>
          ${masterSourceLabel(remote)}
        </div>

        <div class="master-update-warning">
          A new Master Data file is assigned to your subdivision.
          Your existing local master will remain available until
          the new file is successfully downloaded and verified.
        </div>
        `;

    }

    if (status) {

      status.className =
        "status";

      status.textContent =
        "New Master Data is available.";

    }

    const updateButton =
      $("downloadMasterUpdateBtn");

    if (updateButton) {

      updateButton.classList.remove(
        "hidden"
      );

      updateButton.disabled =
        false;

    }

  } catch(e) {

    console.error(e);

    if (status) {

      status.className =
        "status error";

      status.textContent =
        e.message ||
        "Could not check Master Data.";

    }

  } finally {

    if (button) {
      button.disabled = false;
    }

  }

}

/*
 * Where the assigned master is served from.
 * master_check returns source:"R2" for R2 masters;
 * Drive responses have no source field.
 */
function masterSourceLabel(info) {
  return info && info.source === "R2"
    ? "Cloud Storage (R2)"
    : "Google Drive";
}

/*
 * After a manual update ends with a usable master:
 * close the setup card and bring the Master Data card
 * (with its status message) into view.
 */
function finishMasterUpdateUI() {

  closeMasterSetup();

  const card =
    $("masterUpdateCard");

  if (card && !card.classList.contains("hidden")) {
    card.scrollIntoView({
      behavior: "smooth",
      block: "center"
    });
  }

}



async function performMasterUpdate() {

  const checkButton =
    $("checkMasterUpdateBtn");

  const updateButton =
    $("downloadMasterUpdateBtn");

  const status =
    $("masterUpdateStatus");

  try {

    if (checkButton) {
      checkButton.disabled = true;
    }

    if (updateButton) {
      updateButton.disabled = true;
    }

    updateMasterSetupUI(
      "loading",
      0,
      "Checking new Master Data…"
    );

    const remote =
      await checkAssignedMaster();

    const local =
      getLocalMasterMeta();

    if (
      local &&
      String(
        local.master_file_id || ""
      ) ===
      String(
        remote.master_file_id || ""
      )
    ) {

      if (status) {

        status.className =
          "status ok";

        status.textContent =
          "Master Data is already up to date.";

      }

      updateMasterSetupUI(
        "ready",
        state.masterCount,
        "",
        false
      );
      closeMasterSetup();
      return;






    }

    updateMasterSetupUI(
      "loading",
      0,
      `Downloading ${remote.file_name}…`
    );

    const buffer =
      await downloadAssignedMaster(
        remote
      );

    const importedCount =
      await importMasterIntoPending(
        buffer,
        remote
      );

    state.masterReady =
      true;

    state.masterCount =
      importedCount;

    if (status) {

      status.className =
        "status ok";

      status.textContent =
        `Master Data updated successfully. ${importedCount.toLocaleString()} consumers are now available offline.`;

    }

    const details =
      $("masterUpdateDetails");

    if (details) {

      details.classList.remove(
        "hidden"
      );

      details.innerHTML =
        `
        <div><b>Active Master:</b>
          ${escapeHtml(remote.file_name)}
        </div>

        <div><b>Consumers:</b>
          ${importedCount.toLocaleString()}
        </div>

        <div><b>Updated:</b>
          ${formatMasterDate(remote.last_updated)}
        </div>
        <div><b>Source:</b>
          ${masterSourceLabel(remote)}
        </div>
        `;

    }



    updateMasterSetupUI(
      "ready",
      importedCount,
      "",
      false
    );

      /*
       * Update finished: hide the update button (nothing left
       * to update), close the setup card, show Master Data card.
       */
    if (updateButton) {
    updateButton.classList.add("hidden");
    }

    finishMasterUpdateUI();

  } catch(e) {


    console.error(e);

    if (status) {

      status.className =
        "status error";

      status.textContent =
        e.message ||
        "Master Data update failed. Existing local master has been retained.";

    }

    /*
     * IMPORTANT:
     * Do not alter state.activeMasterStore here.
     * The old master therefore remains active.
     */
    state.masterReady =
      (state.masterCount > 0);

    updateMasterSetupUI(
      state.masterReady
        ? "ready"
        : "error",
      state.masterCount,
      state.masterReady
        ? ""
        : (
          e.message ||
          "Master Data update failed."
        ),
      false
    );

    /*
     * Old master is still active: close the setup card so the
     * user sees the error message in the Master Data card.
     */
    if (state.masterReady) {
      finishMasterUpdateUI();
    }

  } finally {

    if (checkButton) {
      checkButton.disabled = false;
    }

    if (updateButton) {
      updateButton.disabled = false;
    }

  }

}


function formatMasterDate(value) {

  if (!value) {
    return "—";
  }

  const d =
    new Date(value);

  if (
    isNaN(
      d.getTime()
    )
  ) {
    return String(value);
  }

  return d.toLocaleString(
    "en-IN",
    {
      dateStyle:"medium",
      timeStyle:"short"
    }
  );

}


function formatBytes(bytes) {

  const n =
    Number(bytes) || 0;

  if (n < 1024) {
    return `${n} B`;
  }

  if (n < 1024 * 1024) {
    return `${(n / 1024).toFixed(1)} KB`;
  }

  if (n < 1024 * 1024 * 1024) {
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }

  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;

}



function loadVillagesOfflineFirst() {

  const cached = localStorage.getItem("kuthondVillageDataV2");

  if (cached) {
    try {
      const data = JSON.parse(cached);

      if (Array.isArray(data)) {
        return Promise.resolve(data);
      }
    } catch(e) {}
  }

  return fetch("village.json", {cache:"no-store"})
    .then(r => {
      if (!r.ok) {
        throw new Error("Could not load village.json");
      }
      return r.json();
    })
    .then(v => {

      if (!Array.isArray(v)) {
        throw new Error("Invalid village.json format.");
      }

      localStorage.setItem(
        "kuthondVillageDataV2",
        JSON.stringify(v)
      );

      return v;
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

    const req =
      indexedDB.open(
        "KuthondMasterData",
        2
      );

    req.onupgradeneeded = e => {

      const db = e.target.result;

      function createMasterStore(name) {

        if (
          !db.objectStoreNames.contains(name)
        ) {

          const master =
            db.createObjectStore(
              name,
              {keyPath:"ACCT_ID"}
            );

          master.createIndex(
            "acct_norm",
            "_acct_norm",
            {unique:false}
          );

          master.createIndex(
            "meter_norm",
            "_meter_norm",
            {unique:false}
          );

        }

      }

      createMasterStore(
        "masterConsumers"
      );

      createMasterStore(
        "masterConsumersPending"
      );

      if (
        !db.objectStoreNames.contains(
          "masterMeta"
        )
      ) {

        db.createObjectStore(
          "masterMeta",
          {keyPath:"key"}
        );

      }

    };

    req.onsuccess = e => {

      state.masterDb =
        e.target.result;

      /*
       * Existing installations already have
       * masterConsumers. It remains the default
       * active store until metadata says otherwise.
       */
      state.activeMasterStore =
        "masterConsumers";

      try {

        const tx =
          state.masterDb.transaction(
            "masterMeta",
            "readonly"
          );

        const request =
          tx.objectStore("masterMeta")
            .get("active");

        request.onsuccess = () => {

          if (
            request.result &&
            (
              request.result.store ===
              "masterConsumers"
              ||
              request.result.store ===
              "masterConsumersPending"
            )
          ) {

            state.activeMasterStore =
              request.result.store;

          }

          resolve();

        };

        request.onerror = () => resolve();

      } catch (err) {

        resolve();

      }

    };

    req.onerror = () => {

      reject(
        req.error ||
        new Error(
          "Could not open local master database."
        )
      );

    };

  });

}




function saveMasterMeta(meta) {

  return new Promise((resolve,reject)=>{

    const tx =
      state.masterDb.transaction(
        "masterMeta",
        "readwrite"
      );

    tx.objectStore("masterMeta")
      .put(
        Object.assign(
          {key:"current"},
          meta
        )
      );

    tx.objectStore("masterMeta")
      .put({
        key:"active",
        store:state.activeMasterStore
      });

    tx.oncomplete = () => {

      state.masterMeta =
        Object.assign({},meta);

      localStorage.setItem(
        "kuthondMasterMeta",
        JSON.stringify(meta)
      );

      resolve();

    };

    tx.onerror = () =>
      reject(
        tx.error ||
        new Error(
          "Could not save master metadata."
        )
      );

  });

}


function getLocalMasterMeta() {

  if (state.masterMeta) {
    return state.masterMeta;
  }

  try {

    const raw =
      localStorage.getItem(
        "kuthondMasterMeta"
      );

    if (raw) {
      state.masterMeta =
        JSON.parse(raw);
    }

  } catch(e) {

    state.masterMeta = null;

  }

  return state.masterMeta;

}


function getInactiveMasterStore() {

  return state.activeMasterStore ===
    "masterConsumers"
      ? "masterConsumersPending"
      : "masterConsumers";

}



async function activateMasterStore(
  storeName,
  meta
) {

  state.activeMasterStore =
    storeName;

  /* New master: Defaulter List must re-read its filter options. */
  dlOptions = null;

  await saveMasterMeta(meta);

  state.masterCount =
    await countMasterConsumers(
      storeName
    );

  state.masterReady =
    state.masterCount > 0;

}



async function checkAssignedMaster() {

  /*
   * master_check is read-only, so it is safe to retry.
   * Only delivery failures (Google 404 HTML page, network
   * errors) are retried. A real backend answer with
   * success:false is NOT retried.
   */
  const maxAttempts = 3;

  let result = null;

  for (
    let attempt = 1;
    attempt <= maxAttempts;
    attempt++
  ) {

    try {

      result =
        await serverPost(
          "master_check",
          {
            r2_capable: true
          }
        );

      break;

    } catch (err) {

      console.error(
        `master_check attempt ${attempt} failed`,
        err
      );

      if (attempt === maxAttempts) {
        throw new Error(
          "Could not reach the server to check Master Data. " +
          "Please check your internet connection and try again."
        );
      }

      await new Promise(
        resolve => setTimeout(resolve, 3000 * attempt)
      );

    }

  }

  if (!result.success) {
    throw new Error(
      result.message ||
      "Could not check assigned Master Data."
    );
  }

  return result;

}

function base64ToUint8Array(base64) {

  const binary =
    atob(base64);

  const bytes =
    new Uint8Array(
      binary.length
    );

  for (
    let i=0;
    i<binary.length;
    i++
  ) {

    bytes[i] =
      binary.charCodeAt(i);

  }

  return bytes;

}

/*
 * =========================================================
 * R2 DIRECT MASTER DOWNLOAD
 * =========================================================
 * Used only when master_check returns download_url.
 * - streams the file with progress
 * - cancels an attempt if no data arrives for 60 seconds
 * - up to 3 attempts before reporting failure
 * - returns exactly totalSize bytes (Uint8Array),
 *   the same type the existing import already receives
 */
const MASTER_R2_MAX_ATTEMPTS = 3;
const MASTER_R2_STALL_MS = 60000;

async function downloadMasterFromR2(
  masterInfo,
  totalSize
) {

  const label =
    masterInfo.file_name || "Master Data";

  let lastError = null;

  for (
    let attempt = 1;
    attempt <= MASTER_R2_MAX_ATTEMPTS;
    attempt++
  ) {

    try {

      return await downloadMasterFromR2Once(
        masterInfo.download_url,
        totalSize,
        label
      );

    } catch (err) {

      lastError = err;

      console.error(
        `R2 master download attempt ${attempt} failed`,
        err
      );

      if (attempt < MASTER_R2_MAX_ATTEMPTS) {

        updateMasterSetupUI(
          "loading",
          0,
          `Network problem while downloading ${label}. Retrying (${attempt + 1}/${MASTER_R2_MAX_ATTEMPTS})…`
        );

        await new Promise(
          resolve => setTimeout(resolve, 5000 * attempt)
        );

      }

    }

  }

  throw new Error(
    "Master Data download failed after " +
    MASTER_R2_MAX_ATTEMPTS +
    " attempts. " +
    (lastError && lastError.message ? lastError.message : "")
  );

}

async function downloadMasterFromR2Once(
  url,
  totalSize,
  label
) {

  const controller =
    new AbortController();

  let stallTimer = null;

  const resetStall = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(
      () => controller.abort(),
      MASTER_R2_STALL_MS
    );
  };

  resetStall();

  try {

    const response =
      await fetch(url, {
        method: "GET",
        cache: "no-store",
        signal: controller.signal
      });

    if (!response.ok) {
      throw new Error(
        `Master Data server returned HTTP ${response.status}.`
      );
    }

    const bytes =
      new Uint8Array(totalSize);

    let received = 0;

    if (response.body && response.body.getReader) {

      const reader =
        response.body.getReader();

      let lastUiUpdate = 0;

      while (true) {

        const { done, value } =
          await reader.read();

        if (done) break;

        resetStall();

        if (received + value.length > totalSize) {
          throw new Error(
            "Master Data download is larger than expected."
          );
        }

        bytes.set(value, received);
        received += value.length;

        const now = Date.now();

        if (now - lastUiUpdate > 500) {
          lastUiUpdate = now;
          updateMasterSetupUI(
            "loading",
            0,
            `Downloading ${label} from Cloud Storage (R2)… ${formatBytes(received)} / ${formatBytes(totalSize)}`

          );
        }

      }

    } else {

      /*
       * Fallback for browsers without streaming support.
       */
      const whole =
        new Uint8Array(
          await response.arrayBuffer()
        );

      if (whole.length > totalSize) {
        throw new Error(
          "Master Data download is larger than expected."
        );
      }

      bytes.set(whole, 0);
      received = whole.length;

    }

    if (received !== totalSize) {
      throw new Error(
        "Master Data download is incomplete. " +
        "Received " + received +
        " bytes out of " + totalSize + "."
      );
    }

    return bytes;

  } catch (err) {

    if (err && err.name === "AbortError") {
      throw new Error(
        "Master Data download stopped responding (no data for 60 seconds)."
      );
    }

    throw err;

  } finally {

    clearTimeout(stallTimer);

  }

}


async function downloadAssignedMaster(
  masterInfo
) {

  const totalSize =
    Number(
      masterInfo.file_size
    ) || 0;

  if (!totalSize) {
    throw new Error(
      "Assigned Master File is empty."
    );
  }
    /*
   * R2 MODE: master_check returned a signed direct link.
   * Download straight from R2. The Base64 path below is
   * used only for subdivisions still served from Drive.
   */
  if (masterInfo.download_url) {
    return await downloadMasterFromR2(
      masterInfo,
      totalSize
    );
  }

  updateMasterSetupUI(
    "loading",
    0,

    `Downloading ${masterInfo.file_name || "Master Data"} from Google Drive… Please wait.`
  );

  const result =
    await serverPost(
      "master_download",
      {
        master_file_id:
          masterInfo.master_file_id
      }
    );

  if (!result.success) {

    throw new Error(
      result.message ||
      "Master Data download failed."
    );

  }

  /*
   * The server must return the same
   * file size that master_check reported.
   */
  if (
    Number(result.total_size) !==
    totalSize
  ) {

    throw new Error(
      "Master Data file size changed during download. " +
      "Expected " + totalSize +
      " bytes but server returned " +
      result.total_size +
      " bytes."
    );

  }

  /*
   * Decode the single Base64 response.
   */
  const bytes =
    base64ToUint8Array(
      result.data || ""
    );

  if (!bytes.length) {

    throw new Error(
      "Master Data download returned no file data."
    );

  }

  /*
   * Final client-side size verification.
   */
  if (
    bytes.length !==
    totalSize
  ) {

    throw new Error(
      "Master Data download is incomplete. " +
      "Received " + bytes.length +
      " bytes out of " + totalSize + "."
    );

  }

  return bytes;

}

async function importMasterIntoPending(
  buffer,
  masterInfo
) {

  if (
    typeof XLSX === "undefined"
  ) {

    throw new Error(
      "Excel library is not loaded. Please check xlsx.full.min.js."
    );

  }

  const workbook =
    XLSX.read(
      buffer,
      {
        type:"array",
        cellDates:true
      }
    );

  const sheetName =
    workbook.SheetNames[0];

  if (!sheetName) {
    throw new Error(
      "Consumer master XLSX contains no worksheet."
    );
  }

  const ws =
    workbook.Sheets[
      sheetName
    ];

  const rows =
    XLSX.utils.sheet_to_json(
      ws,
      {
        header:1,
        defval:"",
        raw:true
      }
    );

  if (!rows.length) {
    throw new Error(
      "Consumer master XLSX is empty."
    );
  }

  const header =
    rows[0].map(x =>
      String(
        x ?? ""
      )
      .trim()
      .toLowerCase()
    );



  /*
   * Required columns. Each entry lists the accepted header names,
   * compared ignoring case, spaces and underscores. Old and new
   * (standard) names are both accepted.
   */
  const expected = [
    ["acct_id"],
    ["sdo_code"],
    ["name"],
    ["father_name"],
    ["address"],
    ["feeded village name", "habitat_name"],
    ["supply_type"],
    ["load"],
    ["connection status", "con_status"],
    ["meter no", "serial_nbr"],
    ["total outstanding", "total_outstanding"],
    ["current reading", "close_reading"],
    ["mobile number", "mobile_no"],
    ["last_pay_date"],
    ["last_pay_amount"]
  ];

  const normalizedHeader =
    header.map(h => h.replace(/[^a-z0-9]/g, ""));

  if (
    !expected.every(
      names => names.some(
        h => normalizedHeader.includes(h.replace(/[^a-z0-9]/g, ""))
      )
    )

  ) {

    throw new Error(
      "Master data columns do not match the approved XLSX file."
    );

  }

  const pendingStore =
    getInactiveMasterStore();

  /*
   * Clear only the inactive store.
   *
   * The currently active master remains untouched.
   */
  await clearMasterConsumers(
    pendingStore
  );

  const batchSize = 500;

  let batch = [];

  let total = 0;

  const sourceRows =
    rows.length - 1;

  for (
    let i=1;
    i<rows.length;
    i++
  ) {

    const row =
      rows[i];

    if (
      !row ||
      !row.some(
        v =>
          String(
            v ?? ""
          ).trim() !== ""
      )
    ) {
      continue;
    }

    const c =
      xlsxToConsumer(
        row,
        header
      );

    if (!c.ACCT_ID) {
      continue;
    }

    batch.push(c);

    if (
      batch.length >=
      batchSize
    ) {

      const toWrite =
        batch;

      batch = [];

      await putMasterBatch(
        toWrite,
        pendingStore
      );

      total +=
        toWrite.length;

      const pct =
        sourceRows > 0
          ? Math.round(
              (i / sourceRows) *
              100
            )
          : 0;

      updateMasterSetupUI(
        "loading",
        total,
        `Importing Master Data… ${pct}%`
      );

      await new Promise(
        resolve =>
          setTimeout(
            resolve,
            0
          )
      );

    }

  }

  if (batch.length) {

    const toWrite =
      batch;

    batch = [];

    await putMasterBatch(
      toWrite,
      pendingStore
    );

    total +=
      toWrite.length;

  }

  const importedCount =
    await countMasterConsumers(
      pendingStore
    );

  if (
    importedCount <= 0
  ) {

    throw new Error(
      "Master data import produced no consumer records."
    );

  }

  /*
   * Verify the imported store using the same
   * account/meter index structure used by the app.
   */

/*
 * Verify the imported store using an actual record
 * from the newly imported master.
 *
 * Do not use fixed consumer/account sentinels because
 * the master population changes over time.
 */
  let verificationRecord = null;
  await new Promise((resolve, reject) => {

    const tx =
      state.masterDb.transaction(
        pendingStore,
        "readonly"
      );

    const store =
      tx.objectStore(pendingStore);

    const request =
      store.openCursor();

    request.onsuccess = () => {

      const cursor =
        request.result;

      if (cursor) {
        verificationRecord =
          cursor.value;
      }

      resolve();
    };

    request.onerror = () => {
      reject(
        request.error ||
        new Error(
          "Could not verify imported Master Data."
        )
      );
    };

  });

  if (
    !verificationRecord ||
    !verificationRecord.ACCT_ID
  ) {

    throw new Error(
      "Master data verification failed. No valid consumer record was found after import."
    );

  }

  const indexedRecord =
    await getMasterByIndex(
      "acct_norm",
      verificationRecord._acct_norm,
      pendingStore
    );

  if (
    !indexedRecord ||
    String(indexedRecord.ACCT_ID) !==
    String(verificationRecord.ACCT_ID)
  ) {

    throw new Error(
      "Master data verification failed. The imported account index could not be verified."
    );

  }



  /*
   * Only after complete import + validation do we
   * activate the new store.
   */
  await activateMasterStore(
    pendingStore,
    {
      master_file_id:
        masterInfo.master_file_id,

      file_name:
        masterInfo.file_name,

      file_size:
        masterInfo.file_size,

      last_updated:
        masterInfo.last_updated,

      imported_at:
        new Date().toISOString(),

      consumer_count:
        importedCount
    }
  );

  return importedCount;

}

function countMasterConsumers(
  storeName = state.activeMasterStore
) {

  return new Promise((resolve,reject)=>{

    const req =
      state.masterDb
        .transaction(
          storeName,
          "readonly"
        )
        .objectStore(storeName)
        .count();

    req.onsuccess = () =>
      resolve(req.result);

    req.onerror = () =>
      reject(req.error);

  });

}


function clearMasterConsumers(
  storeName = state.activeMasterStore
) {

  return new Promise((resolve,reject)=>{

    const tx =
      state.masterDb.transaction(
        storeName,
        "readwrite"
      );

    tx.objectStore(storeName)
      .clear();

    tx.oncomplete = () =>
      resolve();

    tx.onerror = () =>
      reject(
        tx.error ||
        new Error(
          "Could not reset local master data."
        )
      );

  });

}


function putMasterBatch(
  batch,
  storeName = state.activeMasterStore
) {

  return new Promise((resolve,reject)=>{

    if (!batch.length) {
      return resolve();
    }

    const tx =
      state.masterDb.transaction(
        storeName,
        "readwrite"
      );

    const store =
      tx.objectStore(storeName);

    for (const c of batch) {
      store.put(c);
    }

    tx.oncomplete = () =>
      resolve();

    tx.onerror = () =>
      reject(
        tx.error ||
        new Error(
          "Master data storage failed."
        )
      );

  });

}


/*
 * =========================================================
 * ACCOUNT ID INPUT
 * =========================================================
 * Master account IDs have no leading zeros (Excel removes
 * them), but users often type them (e.g. 0123456789).
 * Searches use digits only, without leading zeros.
 */
function normalizeAccountInput(value) {
  const digits = String(value || "").replace(/\D/g, "");
  const stripped = digits.replace(/^0+/, "");
  return stripped || digits;
}

/*
 * Master lookup by typed account ID: tries the ID without
 * leading zeros first, then exactly as typed (digits only),
 * in case a master row ever keeps its leading zeros.
 */
async function getMasterByAccountInput(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;

  const stripped = normalizeAccountInput(digits);

  const c = await getMasterByIndex("acct_norm", stripped);

  if (c || stripped === digits) return c;

  return await getMasterByIndex("acct_norm", digits);
}


function getMasterByIndex(
  indexName,
  value,
  storeName = state.activeMasterStore
) {

  return new Promise((resolve,reject)=>{

    const tx =
      state.masterDb.transaction(
        storeName,
        "readonly"
      );

    const req =
      tx.objectStore(storeName)
        .index(indexName)
        .get(value);

    req.onsuccess = () =>
      resolve(
        req.result || null
      );

    req.onerror = () =>
      reject(req.error);

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

function formatLastPayDate(value) {
  if (!value) return "";

  const s = String(value).trim();

  // Standard YYYY-MM-DD format
  const match = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) {
    return `${match[3]}-${match[2]}-${match[1]}`;
  }

  return s;
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
  setExistingMobilePlaceholder(
  "Enter 10 digit mobile number",
  "10 अंकों का मोबाइल नंबर" );
  $("existingRemarks").value="";
  $("houseLocked").checked=false;
  $("mobileRefused").checked=false;

  $("mobile").disabled=false;

  /* Clear the previous "Survey saved" message for the next consumer. */
  if ($("saveStatus")) setStatus("saveStatus","");

  ["feeder","dt","theftPossibility","siteReading","siteMaxDemand"].forEach(id=>{

    if ($(id)) $(id).value="";
  });
  fillDtDropdown("dt","feeder");

  $("saveBtn").disabled=false;

  $("saveBtn").style.opacity="1";
  clearDuplicateWarning();
  state.doorSurveyGps=null;
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


/*
 * MAP button for an activity card: opens Google Maps at the
 * record's GPS point. Empty when there are no valid coordinates.
 */
function activityMapLink(r) {
  const lat = Number(r.latitude);
  const lng = Number(r.longitude);
  if (!isFinite(lat) || !isFinite(lng) || (lat === 0 && lng === 0) ||
      Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return "";
  }
  const url = "https://www.google.com/maps/search/?api=1&query=" + lat + "," + lng;
  return `<a class="secondary" href="${url}" target="_blank" rel="noopener" ` +
    `style="display:inline-block;text-align:center;text-decoration:none;padding:13px 14px;border-radius:8px;font-weight:700">` +
    `VIEW ON MAP(नक्शे पर देखें)</a>`;
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
      <div class="activity-actions"><button type="button" class="secondary activity-view-btn" data-index="${i}">VIEW</button>${admin?`<button type="button" class="primary activity-correction-btn" data-index="${i}">CORRECTION</button>`:""}${activityMapLink(r)}</div>

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

  const accountId=normalizeAccountInput($("activityAccountId").value.trim());
  if(!accountId) return setStatus("activitySearchStatus","Enter Account ID.","error");

  setStatus("activitySearchStatus","Searching local activity...");

  showGlobalLoading(
    "Searching Activity...",
    "Searching local records and server activity. Please wait."
  );

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
    hideGlobalLoading();

  }catch(e){
        hideGlobalLoading();
        setStatus("activitySearchStatus","Could not search activity records.","error"); }
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

/*
 * =========================================================
 * SURVEY CORRECTION: Feeder, DT, Theft, Site Reading, MD
 * =========================================================
 */
const THEFT_OPTIONS_BASE = [
  "EXTRA CABLE OTHER THAN SERVICE CABLE",
  "BYPASS IN SERVICE CABLE",
  "METER SHUNT DOUBT",
  "NO METER INSTALLED",
  "NO THEFT"
];

function isNewConnectionSurvey(record) {
  return String(record.survey_type || "").toUpperCase() === "CONNECTION NOT IN DATABASE";
}

function theftOptionsFor(record) {
  return isNewConnectionSurvey(record)
    ? ["DIRECT CABLE WITHOUT CONNECTION", ...THEFT_OPTIONS_BASE]
    : THEFT_OPTIONS_BASE;
}

/* Older new-connection records kept the site reading in current_reading. */
function surveyCorrectionSiteReading(record) {
  if (Object.prototype.hasOwnProperty.call(record, "site_reading")) {
    return record.site_reading || "";
  }
  return isNewConnectionSurvey(record) ? (record.current_reading || "") : "";
}

function ensureSelectOption(select, value, text) {
  if (!select || !value) return;
  if (!Array.from(select.options).some(o => o.value === value)) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = text;
    select.appendChild(option);
  }
  select.value = value;
}

function setupCorrectionFeederDt(record) {

  const feederSelect = $("activityCorrFeeder");
  const dtSelect = $("activityCorrDt");
  if (!feederSelect || !dtSelect) return;

  fillFeederDropdowns(getSavedFeeders());

  if (record.feeder) {
    ensureSelectOption(
      feederSelect,
      (record.feeder_substation || "") + "||" + record.feeder,
      record.feeder === "NOT KNOWN" ? NOT_KNOWN_TEXT : referenceDisplayText(record.feeder)
    );
    fillDtDropdown("activityCorrDt", "activityCorrFeeder");
    ensureSelectOption(
      dtSelect,
      record.dt,
      record.dt === "NOT KNOWN" ? NOT_KNOWN_TEXT : referenceDisplayText(record.dt)
    );
  }

  feederSelect.addEventListener("change", () => {
    dtSelect.value = "";
    fillDtDropdown("activityCorrDt", "activityCorrFeeder");
  });

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
    fields+=`<label for="activityCorrReading">Site Reading</label><input id="activityCorrReading" value="${escapeHtml(record.current_reading||"")}">`;
    fields+=`<label for="activityCorrMobile">Mobile Number</label><input id="activityCorrMobile" inputmode="numeric" maxlength="10" value="${escapeHtml(record.mobile_number||"")}">`;
    fields+=activityCorrectionSelect("activityCorrHouse","House Condition",record.house_condition,["kutcha house","Pucca normal house","Pucca Good house","Luxury (Rich) house"]);
    fields+=`<label for="activityCorrRemarks">Remark</label><textarea id="activityCorrRemarks" rows="3">${escapeHtml(record.remarks||"")}</textarea>`;
  } else if(type==="RECHECK"){
    fields+=activityCorrectionSelect("activityCorrStatus","Present Status",record.present_status,["STILL DISCONNECTED","FOUND CONNECTED","FOUND HOUSE LOCKED","PAYMENT MADE"]);
    fields+=activityCorrectionSelect("activityCorrPaymentMode","Payment Mode",record.payment_mode,["PAID ONLINE AT SITE","PAID OFFLINE AT COUNTER","PAYMENT RECEIVED BY LINEMAN"]);
    fields+=activityCorrectionSelect("activityCorrMeterStatus","Current Meter Status",record.meter_status,["OK","DAMAGED","NOT INSTALLED","BURNT","UNMETERED"]);
    fields+=`<label for="activityCorrReading">Site Reading</label><input id="activityCorrReading" value="${escapeHtml(record.current_reading||"")}">`;
    fields+=`<label for="activityCorrMobile">Mobile Number</label><input id="activityCorrMobile" inputmode="numeric" maxlength="10" value="${escapeHtml(record.mobile_number||"")}">`;
    fields+=`<label for="activityCorrRemarks">Remark</label><textarea id="activityCorrRemarks" rows="3">${escapeHtml(record.remarks||"")}</textarea>`;
  } else if(type==="PHONE_CALLING"){
    fields+=`<label for="activityCorrMobile">Mobile Number</label><input id="activityCorrMobile" inputmode="numeric" maxlength="10" value="${escapeHtml(record.mobile_number||"")}">`;

    fields+=activityCorrectionSelect("activityCorrResponse","Call Response",record.call_response,["गलत नंबर","कॉल रिसीव नहीं कर रहे","कुछ दिन बाद जमा करेंगे","जमा नहीं करेंगे","बिल गलत है","घर पर बात करेंगे","JE/SDO से बात करेंगे","डबल कनेक्शन है","PD होना है","बिल जमा है","कार्यालय आएंगे","नंबर स्विच ऑफ है","नंबर नॉट रीचेबल है","इनकमिंग कॉल उपलब्ध नहीं है","अमान्य नंबर","अन्य"]);
    fields+=`<label for="activityCorrCommitDate">Committed Payment Date</label><input id="activityCorrCommitDate" type="date" value="${escapeHtml(record.committed_payment_date||record.payment_date||"")}">`;
    fields+=`<label for="activityCorrRemarks">Remark</label><textarea id="activityCorrRemarks" rows="3">${escapeHtml(record.remarks||"")}</textarea>`;
  } else {

    fields+=activityCorrectionSelect("activityCorrVillage","Village",record.village,[...new Set([record.village||"", ...Array.from($("village").options).map(o=>o.value).filter(Boolean)])].filter(Boolean));
    fields+=`<label for="activityCorrFeeder">Feeder</label><select id="activityCorrFeeder"><option value="">Select feeder</option></select>`;
    fields+=`<label for="activityCorrDt">DT</label><select id="activityCorrDt"><option value="">Select DT</option></select>`;
    fields+=activityCorrectionSelect("activityCorrMeterStatus","Meter Condition",record.meter_condition,["OK","DAMAGED","NOT INSTALLED"]);
    fields+=`<label for="activityCorrSiteReading">Site Reading</label><input id="activityCorrSiteReading" inputmode="decimal" value="${escapeHtml(surveyCorrectionSiteReading(record))}">`;
    fields+=`<label for="activityCorrSiteMd">Site Max Demand</label><input id="activityCorrSiteMd" inputmode="decimal" value="${escapeHtml(record.site_max_demand||"")}">`;
    fields+=activityCorrectionSelect("activityCorrTheft","Theft Possibility",record.theft_possibility,theftOptionsFor(record));


    fields+=activityCorrectionSelect("activityCorrAc","AC Installed",record.ac_installed,["YES","NO"]);
    fields+=`<label for="activityCorrMobile">Mobile Number</label><input id="activityCorrMobile" inputmode="numeric" maxlength="10" value="${escapeHtml(record.mobile_number||"")}">`;
    fields+=`<label for="activityCorrRemarks">Remark</label><textarea id="activityCorrRemarks" rows="3">${escapeHtml(record.remarks||"")}</textarea>`;
  }
  box.innerHTML=fields+`<button id="activityCorrectionSaveBtn" class="primary" type="button">SAVE CORRECTION</button><div id="activityCorrectionStatus" class="status"></div>`;
  box.classList.remove("hidden");
  $("correctionResult").classList.add("hidden");
  $("correctionSearchStatus").textContent="";

  setupCorrectionFeederDt(record);
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

    /*
     * New survey fields. Mandatory for records saved with them;
     * optional for older records. Fields left empty on older
     * records are not sent, so existing sheet cells stay as they are.
     */
    const hadNewFields=Object.prototype.hasOwnProperty.call(original,"feeder");
    const feederValue=$("activityCorrFeeder").value;
    const dtValue=$("activityCorrDt").value;
    const theftValue=$("activityCorrTheft").value;
    const siteReading=$("activityCorrSiteReading").value.trim();
    const siteMd=$("activityCorrSiteMd").value.trim();

    if(hadNewFields && !feederValue) return setStatus("activityCorrectionStatus","Select feeder.","error");
    if((hadNewFields || feederValue) && !dtValue) return setStatus("activityCorrectionStatus","Select DT.","error");
    if(hadNewFields && !theftValue) return setStatus("activityCorrectionStatus","Select theft possibility.","error");
    if(!isValidOptionalNumber(siteReading)) return setStatus("activityCorrectionStatus","Site reading must be a number.","error");
    if(!isValidOptionalNumber(siteMd)) return setStatus("activityCorrectionStatus","Site max demand must be a number.","error");

    if(feederValue){
      const feederInfo=parseFeederValue(feederValue);
      corrected.feeder_substation=feederInfo.substation;
      corrected.feeder=feederInfo.feeder;
      corrected.dt=dtValue;
    }
    if(theftValue) corrected.theft_possibility=theftValue;

    const hadSiteFields=Object.prototype.hasOwnProperty.call(original,"site_reading");
    if(hadNewFields || hadSiteFields || siteReading || siteMd){
      corrected.site_reading=siteReading;
      corrected.site_max_demand=siteMd;
      /* Older new-connection record: reading moves from Master to Site Reading. */
      if(isNewConnectionSurvey(original) && !hadSiteFields) corrected.current_reading="";
    }
  }

  const items=[
    ["Activity",getActivityDisplayName(corrected)],
    ["Account ID",corrected.account_id||""],
    ["Consumer",corrected.consumer_name||""],
    ["Total Outstanding",corrected.outstanding||"—"]
  ];
  if(type==="DISCONNECTION") items.push(["Disconnection Status",corrected.disconnection_status], ["Payment Mode",corrected.payment_mode||"—"], ["Committed Payment Date",corrected.committed_payment_date||"—"], ["Meter Status",corrected.meter_status], ["Site Reading",corrected.current_reading||"—"], ["Mobile",corrected.mobile_number||"—"], ["House Condition",corrected.house_condition], ["Remark",corrected.remarks||"—"]);
  else if(type==="RECHECK") items.push(["Present Status",corrected.present_status], ["Payment Mode",corrected.payment_mode||"—"], ["Current Meter Status",corrected.meter_status||"—"], ["Site Reading",corrected.current_reading||"—"], ["Mobile",corrected.mobile_number||"—"], ["Remark",corrected.remarks||"—"]);
  else if(type==="PHONE_CALLING") items.push(["Mobile",corrected.mobile_number], ["Call Response",corrected.call_response], ["Committed Payment Date",corrected.committed_payment_date||"—"], ["Remark",corrected.remarks||"—"]);

  else items.push(["Village",corrected.village], ["Feeder",corrected.feeder?feederDisplay(corrected):"—"], ["DT",corrected.dt||"—"], ["Meter Condition",corrected.meter_condition], ["Site Reading",corrected.site_reading||"—"], ["Site Max Demand",corrected.site_max_demand||"—"], ["Theft Possibility",corrected.theft_possibility||"—"], ["AC Installed",corrected.ac_installed], ["Mobile",corrected.mobile_number], ["Remark",corrected.remarks||"—"]);
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

    c=await getMasterByAccountInput(raw);

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
  $("phoneSdoCode").textContent =c.SDO_CODE || "";
  $("phoneFeededVillage").textContent =c.feeded_village_name || "";
  $("phoneLastPayDate").textContent =formatLastPayDate(c.LAST_PAY_DATE);
  $("phoneLastPayAmount").textContent =c.LAST_PAY_AMOUNT || "";
  if ($("phoneConsumptionCurr")) $("phoneConsumptionCurr").textContent =
    displayOrUnavailable(c.CONSUMPTION_CURR_MNTH);

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

    sdo_code:c.SDO_CODE || "",
    feeded_village_name:c.feeded_village_name || "",
    connection_status:c.CONNECTION_STATUS || "",
    last_pay_date:c.LAST_PAY_DATE || "",
    last_pay_amount:c.LAST_PAY_AMOUNT || "",

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
  const recheckResults=$("recheckSearchResults");
  if(recheckResults){
      recheckResults.innerHTML="";
      recheckResults.classList.add("hidden");
  }

  $("recheckSearchType").value="ACCOUNT";
  $("recheckVillageFilter").value="";
  $("recheckSaveStatus").textContent="";
  clearActivityVideo("RECHECK");
  if (state) {

    state.recheckCurrent=null;
    state.recheckGps=null;
  }
}



function openRecheck(){
  resetRecheckForm();
  showMainView("recheckCard");
  updateModuleSearchPlaceholder("recheckSearchType","recheckAccountId");
  $("recheckAccountId").focus();
}

function updateModuleSearchPlaceholder(typeId,inputId){
  const typeEl=$(typeId);
  const input=$(inputId);

  if(!typeEl || !input) return;

  const placeholders={
    ACCOUNT:{
      en:"Enter account ID",
      hi:"खाता संख्या दर्ज करें"
    },
    NAME:{
      en:"Enter consumer name",
      hi:"उपभोक्ता का नाम दर्ज करें"
    },
    FATHER_NAME:{
      en:"Enter father name",
      hi:"पिता का नाम दर्ज करें"
    },
    MOBILE:{
      en:"Enter mobile number",
      hi:"मोबाइल नंबर दर्ज करें"
    },
    METER:{
      en:"Enter meter number",
      hi:"मीटर नंबर दर्ज करें"
    }
  };

  const item=placeholders[typeEl.value] || placeholders.ACCOUNT;

  input.dataset.languagePlaceholderOriginal =
    item.en+"("+item.hi+")";

  input.placeholder =
    currentLanguage==="hi"
      ? item.hi
      : item.en;
}

function showModuleSearchResults(results,boxId,onSelect){

  const box=$(boxId);

  if(!box) return;

  box.innerHTML="";

  if(!results.length){
    box.classList.add("hidden");
    return;
  }

  results.forEach(c=>{

    const card=document.createElement("div");

    card.className="search-result-card";

    card.innerHTML=`
      <div><strong>Account ID:</strong> ${escapeHtml(c.ACCT_ID || "")}</div>
      <div><strong>Name:</strong> ${escapeHtml(c.NAME || "")}</div>
      <div><strong>Father/Husband:</strong> ${escapeHtml(c.FATHER_NAME || "")}</div>
      <div><strong>Address:</strong> ${escapeHtml(c.ADDRESS || "")}</div>
      <div><strong>Village:</strong> ${escapeHtml(c.feeded_village_name || "")}</div>
      <div><strong>Mobile:</strong> ${escapeHtml(c.MOBILE_NUMBER || "")}</div>
      <div><strong>Meter:</strong> ${escapeHtml(c.METER_NO || "")}</div>
    `;

    card.addEventListener("click",()=>{
      box.innerHTML="";
      box.classList.add("hidden");
      onSelect(c);
    });

    box.appendChild(card);
  });

  box.classList.remove("hidden");
}


async function searchRecheckConsumer(){

  const searchType=$("recheckSearchType").value;
  const rawValue=$("recheckAccountId").value.trim();
  const village=$("recheckVillageFilter").value.trim();

  if(!rawValue){
    return setStatus(
      "recheckSearchStatus",
      "Enter a search value.",
      "error"
    );
  }

  if(!state.masterReady){
    return setStatus(
      "recheckSearchStatus",
      "Master data is still loading. Please wait.",
      "error"
    );
  }

  let results=[];
  showGlobalLoading(
    "Searching...",
    "Searching consumer data. Please wait."
  );


  try{

    if(searchType==="ACCOUNT"){

      const normalized=rawValue.replace(/\D/g,"");


      const c=await getMasterByAccountInput(
          normalized
      );

    if(c){
          if(
            village &&
            String(c.feeded_village_name || "")
              .trim()
              .toLowerCase() !== village.toLowerCase()
          ){
            results=[];
          }else{
            results=[c];
          }
      }
    }else{
      results=await findMasterConsumers(
        searchType,
        rawValue,
        village
      );

    }

  }catch(e){

    console.error(e);
    hideGlobalLoading();

    return setStatus(
      "recheckSearchStatus",
      "Could not read local consumer data.",
      "error"
    );
  }

  if(!results.length){

    state.recheckCurrent=null;

    $("recheckConsumerCard").classList.add("hidden");
    $("recheckFormFields").classList.add("hidden");

    showModuleSearchResults(
      [],
      "recheckSearchResults",
      ()=>{}
    );
    hideGlobalLoading();

    return setStatus(
      "recheckSearchStatus",
      "No matching consumer found.",
      "error"
    );
  }

  if(results.length>1){

    $("recheckConsumerCard").classList.add("hidden");
    $("recheckFormFields").classList.add("hidden");

    showModuleSearchResults(
      results,
      "recheckSearchResults",
      selectRecheckConsumerFromSearch
    );
    hideGlobalLoading();

    return setStatus(
      "recheckSearchStatus",
      `${results.length} consumers found. Select the correct consumer.`,
      "ok"
    );
  }

  selectRecheckConsumerFromSearch(results[0]);
  hideGlobalLoading();
}

function selectRecheckConsumerFromSearch(c){

  state.recheckCurrent=c;

  $("rcAcct").textContent=c.ACCT_ID||"";
  $("rcName").textContent=c.NAME||"";
  $("rcFather").textContent=c.FATHER_NAME||"";
  $("rcAddress").textContent=c.ADDRESS||"";
  $("rcSupply").textContent=c.SUPPLY_TYPE||"";
  $("rcLoad").textContent=c.LOAD||"";
  $("rcSdoCode").textContent=c.SDO_CODE||"";
  $("rcFeededVillage").textContent=c.feeded_village_name||"";
  $("rcLastPayDate").textContent=formatLastPayDate(c.LAST_PAY_DATE);
  $("rcLastPayAmount").textContent=c.LAST_PAY_AMOUNT||"";
  if ($("rcConsumptionCurr")) $("rcConsumptionCurr").textContent =
    displayOrUnavailable(c.CONSUMPTION_CURR_MNTH);

  $("rcMeterNo").textContent=
    displayOrUnavailable(getConsumerMeterNo(c));

  $("rcOutstanding").textContent=
    displayOrUnavailable(getConsumerOutstanding(c));

  $("recheckConsumerCard").classList.remove("hidden");
  $("recheckFormFields").classList.remove("hidden");

  setStatus(
    "recheckSearchStatus",
    "Consumer found. Fill the rechecking details.",
    "ok"
  );

  captureRecheckGps();
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
  if(state.deviceHasCamera===false) return setStatus("recheckSaveStatus","This device does not have a camera, so this form cannot be submitted.","error");
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
  const videoProblem=checkActivityVideo("RECHECK",c,isVideoRequired("RECHECK",status));

  if(videoProblem) return setStatus("recheckSaveStatus",videoProblem,"error");
  const video=getActivityVideo("RECHECK");

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

    sdo_code:c.SDO_CODE || "",
    feeded_village_name:c.feeded_village_name || "",
    connection_status:c.CONNECTION_STATUS || "",
    last_pay_date:c.LAST_PAY_DATE || "",
    last_pay_amount:c.LAST_PAY_AMOUNT || "",
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

  if(video) attachVideoToRecord(record,video);
  openConfirmation("Confirm Recheck",[
    ["Account ID",record.account_id],
    ["Consumer",record.consumer_name],
    ["Address",record.address],
    ["Total Outstanding",record.outstanding||"—"],
    ["Present Status",record.present_status],
    ["Payment Mode",record.payment_mode||"—"],
    ["Current Meter Status",record.meter_status||"—"],
    ["Site Reading",record.current_reading||"—"],
    ["Mobile Number",record.mobile_number||"—"],
    ["Remark",record.remarks||"—"],
    ["Video",video?videoSummary(video):"Not required"]

  ],async()=>{
    if(video) downloadActivityVideo(video);
    const saved=await saveRecheckLocal(record);

    if(saved && video) await keepVideoForUpload(record,video);
    if(saved) openShareModal(record,video);
  });

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
  const disconnectResults=$("disconnectSearchResults");
  if(disconnectResults){
      disconnectResults.innerHTML="";
      disconnectResults.classList.add("hidden");
  }

  $("disconnectSearchType").value="ACCOUNT";
  $("disconnectVillageFilter").value="";
  $("disconnectSaveStatus").textContent="";
  state.disconnectCurrent=null; state.disconnectGps=null;
  clearActivityVideo("DISCONNECTION");

}

function openDisconnection(){
  resetDisconnectionForm();
  showMainView("disconnectionCard");
  updateModuleSearchPlaceholder("disconnectSearchType","disconnectAccountId");
  $("disconnectAccountId").focus();
}


async function searchDisconnectionConsumer(){

  const searchType=$("disconnectSearchType").value;
  const rawValue=$("disconnectAccountId").value.trim();
  const village=$("disconnectVillageFilter").value.trim();

  if(!rawValue){
    return setStatus(
      "disconnectSearchStatus",
      "Enter a search value.",
      "error"
    );
  }

  if(!state.masterReady){
    return setStatus(
      "disconnectSearchStatus",
      "Master data is still loading. Please wait.",
      "error"
    );
  }

  let results=[];

  showGlobalLoading(
    "Searching...",
    "Searching consumer data. Please wait."
  );

  try{

    if(searchType==="ACCOUNT"){

      const normalized=rawValue.replace(/\D/g,"");


      const c=await getMasterByAccountInput(
          normalized
      );


      if(c){

          if(
            village &&
            String(c.feeded_village_name || "")
              .trim()
              .toLowerCase() !== village.toLowerCase()
          ){
            results=[];
          }else{
            results=[c];
          }
      }
    }else{

      results=await findMasterConsumers(
        searchType,
        rawValue,
        village
      );

    }

  }catch(e){

    console.error(e);
    hideGlobalLoading();

    return setStatus(
      "disconnectSearchStatus",
      "Could not read local consumer data.",
      "error"
    );
  }

  if(!results.length){

    state.disconnectCurrent=null;

    $("disconnectConsumerCard").classList.add("hidden");
    $("disconnectFormFields").classList.add("hidden");

    showModuleSearchResults(
      [],
      "disconnectSearchResults",
      ()=>{}
    );

    hideGlobalLoading();

    return setStatus(
      "disconnectSearchStatus",
      "No matching consumer found.",
      "error"
    );
  }

  if(results.length>1){

    $("disconnectConsumerCard").classList.add("hidden");
    $("disconnectFormFields").classList.add("hidden");

    showModuleSearchResults(
      results,
      "disconnectSearchResults",
      selectDisconnectionConsumerFromSearch
    );

    hideGlobalLoading();
    return setStatus(
      "disconnectSearchStatus",
      `${results.length} consumers found. Select the correct consumer.`,
      "ok"
    );
  }

  selectDisconnectionConsumerFromSearch(results[0]);
  hideGlobalLoading();

}

function selectDisconnectionConsumerFromSearch(c){

  state.disconnectCurrent=c;

  $("dcAcct").textContent=c.ACCT_ID||"";
  $("dcName").textContent=c.NAME||"";
  $("dcFather").textContent=c.FATHER_NAME||"";
  $("dcAddress").textContent=c.ADDRESS||"";
  $("dcSupply").textContent=c.SUPPLY_TYPE||"";
  $("dcLoad").textContent=c.LOAD||"";
  $("dcSdoCode").textContent=c.SDO_CODE||"";
  $("dcFeededVillage").textContent=c.feeded_village_name||"";
  $("dcLastPayDate").textContent=formatLastPayDate(c.LAST_PAY_DATE);
  $("dcLastPayAmount").textContent=c.LAST_PAY_AMOUNT||"";
  if ($("dcConsumptionCurr")) $("dcConsumptionCurr").textContent =
    displayOrUnavailable(c.CONSUMPTION_CURR_MNTH);


  $("dcMeterNo").textContent=
    displayOrUnavailable(getConsumerMeterNo(c));

  $("dcOutstanding").textContent=
    displayOrUnavailable(getConsumerOutstanding(c));

  $("disconnectConsumerCard").classList.remove("hidden");
  $("disconnectFormFields").classList.remove("hidden");

  setStatus(
    "disconnectSearchStatus",
    "Consumer found. Fill the disconnection details.",
    "ok"
  );

  captureDisconnectionGps();
}

function captureDisconnectionGps(){
  state.disconnectGps=null;
  if(!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(pos=>{
    state.disconnectGps={latitude:pos.coords.latitude,longitude:pos.coords.longitude,accuracy:pos.coords.accuracy};
  },()=>{}, {enableHighAccuracy:true,timeout:8000,maximumAge:60000});
}

function captureDoorSurveyGps(){
  state.doorSurveyGps=null;

  if(!navigator.geolocation) return;

  navigator.geolocation.getCurrentPosition(pos=>{
    state.doorSurveyGps={
      latitude:pos.coords.latitude,
      longitude:pos.coords.longitude,
      accuracy:pos.coords.accuracy
    };
  },()=>{},{
    enableHighAccuracy:true,
    timeout:8000,
    maximumAge:60000
  });
}

function updateDisconnectionConditionalFields(){
  const status=$("disconnectStatus").value;
  $("disconnectPaymentModeWrap").classList.toggle("hidden",status!=="PAID");
  $("disconnectCommitDateWrap").classList.toggle("hidden",status!=="TIME GIVEN FOR PAYMENT");
  if(status!=="PAID") $("disconnectPaymentMode").value="";
  if(status!=="TIME GIVEN FOR PAYMENT") $("disconnectCommitDate").value="";
}

function prepareDisconnectionSave(){
  if(state.deviceHasCamera===false) return setStatus("disconnectSaveStatus","This device does not have a camera, so this form cannot be submitted.","error");
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
  const videoProblem=checkActivityVideo("DISCONNECTION",c,isVideoRequired("DISCONNECTION",status));

  if(videoProblem) return setStatus("disconnectSaveStatus",videoProblem,"error");
  const video=getActivityVideo("DISCONNECTION");
  const record={

    activity_type:"DISCONNECTION",
    disconnection_id:makeActivityId("DISC"),
    user_id:state.userId,user_name:state.userName,
    account_id:c.ACCT_ID,consumer_name:c.NAME||"",father_name:c.FATHER_NAME||"",address:c.ADDRESS||"",supply_type:c.SUPPLY_TYPE||"",load:c.LOAD||"",sdo_code:c.SDO_CODE || "",
    feeded_village_name:c.feeded_village_name || "",
    connection_status:c.CONNECTION_STATUS || "",
    last_pay_date:c.LAST_PAY_DATE || "",
    last_pay_amount:c.LAST_PAY_AMOUNT || "",
    disconnection_status:status,payment_mode:paymentMode,committed_payment_date:commitDate,
    outstanding:getConsumerOutstanding(c),
    meter_status:meter,current_reading:reading,mobile_number:mobile,house_condition:house,remarks,
    latitude:state.disconnectGps?state.disconnectGps.latitude:"",longitude:state.disconnectGps?state.disconnectGps.longitude:"",gps_accuracy:state.disconnectGps?state.disconnectGps.accuracy:"",
    created_at:new Date().toISOString(),upload_status:"PENDING"
  };

  if(video) attachVideoToRecord(record,video);
  openConfirmation("Confirm Disconnection",[
    ["Account ID",record.account_id],["Consumer",record.consumer_name],["Disconnection Status",record.disconnection_status],
    ["Payment Mode",record.payment_mode||"—"],["Committed Payment Date",record.committed_payment_date||"—"],["Meter Status",record.meter_status],
    ["Site Reading",record.current_reading||"—"],["Mobile",record.mobile_number||"—"],["House Condition",record.house_condition],["Remark",record.remarks||"—"],
    ["Video",video?videoSummary(video):"Not required"]
  ],async()=>{
    if(video) downloadActivityVideo(video);
    const saved=await saveActivityLocalRecord(record,"disconnectSaveStatus");

    if(saved && video) await keepVideoForUpload(record,video);
    if(saved) openShareModal(record,video);
  });

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

function updateExistingSearchPlaceholder() {
  const type = $("searchType").value;
  const input = $("accountId");

  if (!input) return;

  const placeholders = {
    ACCOUNT: {
      en: "Enter account ID",
      hi: "खाता संख्या दर्ज करें"
    },
    NAME: {
      en: "Enter consumer name",
      hi: "उपभोक्ता का नाम दर्ज करें"
    },
    FATHER_NAME: {
      en: "Enter father name",
      hi: "पिता का नाम दर्ज करें"
    },
    MOBILE: {
      en: "Enter mobile number",
      hi: "मोबाइल नंबर दर्ज करें"
    },
    METER: {
      en: "Enter meter number",
      hi: "मीटर नंबर दर्ज करें"
    }
  };

  const item = placeholders[type] || placeholders.ACCOUNT;

  input.dataset.languagePlaceholderOriginal =
    item.en + "(" + item.hi + ")";

  input.placeholder =
    currentLanguage === "hi"
      ? item.hi
      : item.en;
}

function showExistingSurvey() {
  showMainView("existingSearchCard");
  $("accountId").value="";
  $("searchStatus").textContent="";
  updateExistingSearchPlaceholder();
  $("accountId").focus();
}



function showNewSurvey() {
  showMainView("newSurveyCard");
  $("newSaveStatus").textContent="";
  captureDoorSurveyGps();
  $("newConnectionType").focus();
}

function setExistingMobilePlaceholder(english, hindi) {
  const mobile=$("mobile");
  if (!mobile) return;

  const bilingual=english+"("+hindi+")";

  mobile.dataset.languagePlaceholderOriginal=bilingual;
  mobile.setAttribute("placeholder", bilingual);

  applyLanguageToPlaceholders();
}

function updateExistingSpecialOptions() {
  const locked=$("houseLocked").checked;
  const refused=$("mobileRefused").checked;

  if (locked) {
    $("mobileRefused").checked=false;
    $("mobileRefused").disabled=true;
    $("mobile").value="";
    $("mobile").disabled=true;
    setExistingMobilePlaceholder(
      "House Locked - Mobile Number Not Available",
      "मकान बंद - मोबाइल नंबर उपलब्ध नहीं"
    );
  } else {
    $("mobileRefused").disabled=false;
    $("mobile").disabled=refused;
  }

  if (refused) {
    $("houseLocked").checked=false;
    $("houseLocked").disabled=true;
    $("mobile").value="";
    $("mobile").disabled=true;
    setExistingMobilePlaceholder(
      "Consumer Refused - Mobile Number Not Provided",
      "उपभोक्ता ने मोबाइल नंबर देने से मना किया"
    );
  } else {
    $("houseLocked").disabled=false;
    if (!locked) {
      $("mobile").disabled=false;
      setExistingMobilePlaceholder(
        "Enter 10 digit mobile number",
        "10 अंकों का मोबाइल नंबर"
      );
    }
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

function findMasterConsumers(searchType, searchValue, villageValue) {

  return new Promise((resolve, reject) => {

    const results = [];

    const tx = state.masterDb.transaction(
      state.activeMasterStore,
      "readonly"
    );

    const store =
      tx.objectStore(
        state.activeMasterStore
      );


    const search = String(searchValue || "")
      .trim()
      .toLowerCase();

    const village = String(villageValue || "")
      .trim()
      .toLowerCase();

    const request = store.openCursor();

    request.onsuccess = event => {

      const cursor = event.target.result;

      if (!cursor) {
        resolve(results);
        return;
      }

      const c = cursor.value;

      // Village filter
      if (village) {

        const consumerVillage =
          String(c.feeded_village_name || "")
            .trim()
            .toLowerCase();

        if (consumerVillage !== village) {
          cursor.continue();
          return;
        }
      }

      let fieldValue = "";

      if (searchType === "NAME") {
        fieldValue =
          String(c.NAME || "")
            .trim()
            .toLowerCase();

      } else if (searchType === "MOBILE") {
        fieldValue =
          String(c.MOBILE_NUMBER || "")
            .replace(/\D/g,"");

      } else if (searchType === "METER") {
        fieldValue =
          String(c.METER_NO || "")
            .toLowerCase()
            .replace(/\s+/g,"");
      } else if (searchType === "FATHER_NAME") {
          fieldValue =
            String(c.FATHER_NAME || "")
              .trim()
              .toLowerCase();
      }

      let matches = false;

      if (searchType === "NAME") {

        matches = fieldValue.includes(search);

      } else if (searchType === "MOBILE") {

        matches = fieldValue.includes(
          search.replace(/\D/g,"")
        );

      } else if (searchType === "METER") {

        matches = fieldValue.includes(
          search.replace(/\s+/g,"")
        );
      } else if (searchType === "FATHER_NAME") {

          matches = fieldValue.includes(search);
      }


      if (matches) {
        results.push(c);
      }

      cursor.continue();
    };

    request.onerror = () => {
      reject(request.error);
    };

  });
}


async function searchConsumer() {

  updateOutstandingAlert("");

  if (!state.sessionToken) return showLogin();

  if (!state.masterReady) {
    return setStatus(
      "searchStatus",
      "Master data is still loading. Please wait until it finishes.",
      "error"
    );
  }

  const searchType = $("searchType").value;

  const rawValue =
    $("accountId").value.trim();

  const village =
    $("villageFilter").value.trim();

  if (!rawValue) {
    return setStatus(
      "searchStatus",
      "Enter a search value.",
      "error"
    );
  }

  let results = [];

  showGlobalLoading(
    "Searching...",
    "Searching consumer data. Please wait."
  );


  try {

    // ACCOUNT ID remains exact
    if (searchType === "ACCOUNT") {

      const normalized =
        rawValue.replace(/\D/g,"");


      const c =
        await getMasterByAccountInput(
          normalized
        );




      if (c) {

        if (
          village &&
          String(c.feeded_village_name || "")
            .trim()
            .toLowerCase() !==
          village.toLowerCase()
        ) {
          results = [];
        } else {
          results = [c];
        }
      }

    } else {

      results =
        await findMasterConsumers(
          searchType,
          rawValue,
          village
        );
    }


  } catch (e) {

    console.error(e);
    hideGlobalLoading();

    return setStatus(
      "searchStatus",
      "Local master data is not available. Please reopen the app.",
      "error"
    );
  }

  // No result
  if (!results.length) {

    state.current = null;

    $("consumerCard").classList.add("hidden");
    $("entryCard").classList.add("hidden");

    hideGlobalLoading();
    return setStatus(
      "searchStatus",
      "No matching consumer found.",
      "error"
    );
  }

  // Multiple results
  if (results.length > 1) {

    showConsumerSearchResults(results);

    $("consumerCard").classList.add("hidden");
    $("entryCard").classList.add("hidden");

    hideGlobalLoading();
    return setStatus(
      "searchStatus",
      `${results.length} consumers found. Select the correct consumer.`,
      "ok"
    );
  }

  // Exactly one result
  selectConsumerFromSearch(results[0]);
  hideGlobalLoading();
}

function showConsumerSearchResults(results) {

  let box = $("searchResults");

  if (!box) {

    box = document.createElement("div");

    box.id = "searchResults";

    box.className = "search-results";

    $("searchStatus").insertAdjacentElement(
      "afterend",
      box
    );
  }

  box.innerHTML = "";

  results.forEach((c, index) => {

    const card =
      document.createElement("div");

    card.className = "search-result-card";

    card.innerHTML = `
      <div><strong>Account ID:</strong> ${escapeHtml(c.ACCT_ID || "")}</div>
      <div><strong>Name:</strong> ${escapeHtml(c.NAME || "")}</div>
      <div><strong>Father/Husband:</strong> ${escapeHtml(c.FATHER_NAME || "")}</div>
      <div><strong>Address:</strong> ${escapeHtml(c.ADDRESS || "")}</div>
      <div><strong>Village:</strong> ${escapeHtml(c.feeded_village_name || "")}</div>
      <div><strong>Mobile:</strong> ${escapeHtml(c.MOBILE_NUMBER || "")}</div>
      <div><strong>Meter:</strong> ${escapeHtml(c.METER_NO || "")}</div>
    `;

    card.addEventListener(
      "click",
      () => selectConsumerFromSearch(c)
    );

    box.appendChild(card);
  });
}



function selectConsumerFromSearch(c) {

  const box = $("searchResults");

  if (box) {
    box.innerHTML = "";
  }

  clearDuplicateWarning();

  state.current = c;

  $("dAcct").textContent =
    c.ACCT_ID || "";

  $("dName").textContent =
    c.NAME || "";

  $("dFather").textContent =
    c.FATHER_NAME || "";

  $("dAddress").textContent =
    c.ADDRESS || "";

  $("dSupply").textContent =
    c.SUPPLY_TYPE || "";

  $("dLoad").textContent =
    c.LOAD || "";

  $("dSdoCode").textContent =
    c.SDO_CODE || "";

  $("dFeededVillage").textContent =
    c.feeded_village_name || "";


  $("dLastPayDate").textContent =
  formatLastPayDate(c.LAST_PAY_DATE);

  $("dLastPayAmount").textContent =
    c.LAST_PAY_AMOUNT || "";

  if ($("dConsumptionCurr")) $("dConsumptionCurr").textContent =
    displayOrUnavailable(c.CONSUMPTION_CURR_MNTH);


  $("dConnectionStatus").textContent =
    displayOrUnavailable(
      getConsumerConnectionStatus(c)
    );

  $("dMeterNo").textContent =
    displayOrUnavailable(
      getConsumerMeterNo(c)
    );

  $("dCurrentReading").textContent =
    displayOrUnavailable(
      getConsumerReading(c)
    );

  $("dOutstanding").textContent =
    displayOrUnavailable(
      getConsumerOutstanding(c)
    );

  showMainView("consumerCard");

  $("existingSearchCard")
    .classList.remove("hidden");

  $("entryCard")
    .classList.remove("hidden");

  resetExistingForm();

  updateOutstandingAlert(
    getConsumerOutstanding(c)
  );

  captureDoorSurveyGps();

  findLocalDuplicate(c.ACCT_ID)
    .then(localDuplicate => {

      if (localDuplicate) {

        showDuplicateWarning(
          localDuplicate,
          "local"
        );

        setStatus(
          "searchStatus",
          "This consumer is already recorded on this phone.",
          "error"
        );

        return;
      }

      setStatus(
        "searchStatus",
        "Consumer found. Verify the details.",
        "ok"
      );
    });
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

  const feederValue=$("feeder").value;
  const dt=$("dt").value;
  const theft=$("theftPossibility").value;
  const siteReading=$("siteReading").value.trim();
  const siteMaxDemand=$("siteMaxDemand").value.trim();
  if (!feederValue) return setStatus("saveStatus","Select feeder.","error");
  if (!dt) return setStatus("saveStatus","Select DT.","error");
  if (!theft) return setStatus("saveStatus","Select theft possibility.","error");
  if (!isValidOptionalNumber(siteReading)) return setStatus("saveStatus","Site reading must be a number.","error");
  if (!isValidOptionalNumber(siteMaxDemand)) return setStatus("saveStatus","Site max demand must be a number.","error");
  const feederInfo=parseFeederValue(feederValue);

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

    connection_status:state.current.CONNECTION_STATUS || "",
    last_pay_date:state.current.LAST_PAY_DATE || "",
    last_pay_amount:state.current.LAST_PAY_AMOUNT || "",

    feeded_village_name:state.current.feeded_village_name || "",

    correct_village_name:village || "",
    village,
    feeder_substation:feederInfo.substation,
    feeder:feederInfo.feeder,
    dt,
    theft_possibility:theft,
    site_reading:siteReading,
    site_max_demand:siteMaxDemand,
    nature_of_supply:natureOfSupply,
    house_condition:houseCondition,
    consumer_payment_response:consumerPaymentResponse,

    consumer_payment_date:consumerPaymentDate,
    meter_condition:meterCondition,
    ac_installed:acInstalled,
    latitude:state.doorSurveyGps ? state.doorSurveyGps.latitude : "",
    longitude:state.doorSurveyGps ? state.doorSurveyGps.longitude : "",
    gps_accuracy:state.doorSurveyGps ? state.doorSurveyGps.accuracy : "",
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
      ["Feeder",feederDisplay(record)],
      ["DT",record.dt],
      ["Nature of Supply",record.nature_of_supply],

      ["House Condition",record.house_condition],
      ["Payment Response",record.consumer_payment_response],
      ["Expected Payment Date",record.consumer_payment_date || "—"],
      ["Meter Number",record.meter_number || "Not available"],

      ["Master Reading",record.current_reading || "Not available"],
      ["Site Reading",record.site_reading || "—"],
      ["Site Max Demand",record.site_max_demand || "—"],
      ["Theft Possibility",record.theft_possibility],

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

  ["newFeeder","newDt","newTheftPossibility","newSiteMaxDemand"].forEach(id=>{
    if ($(id)) { $(id).value=""; $(id).disabled=false; }
  });
  fillDtDropdown("newDt","newFeeder");

  state.doorSurveyGps=null;


}

function updateNewMeterFields() {
  const installed=$("newMeterInstalled").value;
  const no=installed==="NO";
  $("newMeterNo").disabled=no;

  $("newCurrentReading").disabled=no;
  if ($("newSiteMaxDemand")) {
    $("newSiteMaxDemand").disabled=no;
    if (no) $("newSiteMaxDemand").value="";
  }
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

  const feederValue=$("newFeeder").value;
  const dt=$("newDt").value;
  const theft=$("newTheftPossibility").value;
  const siteMaxDemand=$("newSiteMaxDemand").value.trim();
  if (!feederValue) return setStatus("newSaveStatus","Select feeder.","error");
  if (!dt) return setStatus("newSaveStatus","Select DT.","error");
  if (!theft) return setStatus("newSaveStatus","Select theft possibility.","error");
  if (!isValidOptionalNumber(siteMaxDemand)) return setStatus("newSaveStatus","Site max demand must be a number.","error");
  const feederInfo=parseFeederValue(feederValue);


  if (!natureOfSupply) return setStatus("newSaveStatus","Select Nature of Supply.","error");
  if (!houseCondition) return setStatus("newSaveStatus","Select House Condition.","error");
  if (!address) return setStatus("newSaveStatus","Enter complete address.","error");
  if (mobile && !/^\d{10}$/.test(mobile)) {
    return setStatus("newSaveStatus","Enter a valid 10 digit mobile number.","error");
  }
  if (!installed) return setStatus("newSaveStatus","Select Meter Installed.","error");
  if (installed==="YES" && !meterNo) return setStatus("newSaveStatus","Enter meter number.","error");

  if (installed==="YES" && !reading) return setStatus("newSaveStatus","Enter site reading.","error");
  if (!isValidOptionalNumber(reading)) return setStatus("newSaveStatus","Site reading must be a number.","error");

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
    feeded_village_name:"",
    connection_status:"",
    last_pay_date:"",
    last_pay_amount:"",


    correct_village_name:village || "",
    village,
    feeder_substation:feederInfo.substation,
    feeder:feederInfo.feeder,
    dt,
    theft_possibility:theft,
    site_max_demand:siteMaxDemand,
    nature_of_supply:natureOfSupply,
    house_condition:houseCondition,
    meter_condition:meterCondition,

    ac_installed:ac,
    latitude:state.doorSurveyGps ? state.doorSurveyGps.latitude : "",
    longitude:state.doorSurveyGps ? state.doorSurveyGps.longitude : "",
    gps_accuracy:state.doorSurveyGps ? state.doorSurveyGps.accuracy : "",
    mobile_number:mobile,
    meter_installed:installed,
    meter_number:meterNo,

    /* Typed on site: Site Reading. Master Reading does not apply. */
    current_reading:"",
    site_reading:reading,
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
      ["Feeder",feederDisplay(record)],
      ["DT",record.dt],
      ["Address",record.address],

      ["Nature of Supply",record.nature_of_supply],
      ["House Condition",record.house_condition],
      ["Mobile",record.mobile_number || "Not provided"],
      ["Meter Installed",record.meter_installed],
      ["Meter Number",record.meter_number || "Not applicable"],

      ["Site Reading",record.site_reading || "Not applicable"],
      ["Site Max Demand",record.site_max_demand || "—"],
      ["Theft Possibility",record.theft_possibility],

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


/*
 * One records upload at a time: a second tap (or UPLOAD VIDEOS
 * starting a records upload) while one is running is ignored,
 * so the same record is never sent twice at the same moment.
 */
let uploadRecordsRunning = false;

async function uploadPending() {
  if (uploadRecordsRunning) return;
  uploadRecordsRunning = true;
  const button = $("uploadBtn");
  if (button) button.disabled = true;
  try {
    return await uploadPendingOnce();
  } finally {
    uploadRecordsRunning = false;
    if (button) button.disabled = false;
  }
}

async function uploadPendingOnce() {
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
      saveVideoSettings(result.video_settings);
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
  /* Database not open yet (early startup): init() refreshes later. */
  if (!state.db) return;

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
  /* Keep My Collection in step after every save / upload / sync. */
  v151RefreshMyCollection().catch(err =>
    console.error("My Collection refresh failed", err)
  );

  /* Videos section: pending count and size. */
  refreshVideoUploadInfo().catch(err =>
    console.error("Video info refresh failed", err)
  );


}


async function exportData() {
  const records = await getAllRecords();
  if (!records.length) return alert("No locally saved records.");

  const headers = ["Survey Type","Survey Status","Connection Type","Survey ID","User ID","User Name","Account ID","Consumer Name","Father/Husband","Address","Supply Type","Load","SDO Code","Village","Meter Condition","AC Installed","Mobile Number","House Locked","Mobile Refused","Meter Installed","Meter Number","Current Reading","Outstanding","Connected Load","Nature of Supply","House Condition","Consumer Payment Response","Consumer Payment Date","Remarks","Created At","Feeded Village Name","Connection Status","Last Pay Date","Last Pay Amount","Upload Status"];
  const rows = records.map(r => [r.survey_type,r.survey_status,r.connection_type,r.survey_id,r.user_id,r.user_name,r.account_id,r.consumer_name,r.father_name,r.address,r.supply_type,r.load,r.sdo_code,r.village,r.meter_condition,r.ac_installed,r.mobile_number,r.house_locked,r.mobile_refused,r.meter_installed,r.meter_number,r.current_reading,r.outstanding,r.connected_load,r.nature_of_supply,r.house_condition,r.consumer_payment_response||"",r.consumer_payment_date||"",r.remarks,r.created_at,r.feeded_village_name,r.connection_status,r.last_pay_date,r.last_pay_amount,r.upload_status]);
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
  if($("substationReport")) $("substationReport").innerHTML = '<div class="dashboard-empty-state">Click Load Dashboard to load dashboard data.</div>';
  if($("userReport")) $("userReport").innerHTML = '<div class="dashboard-empty-state">Click Load Dashboard to load dashboard data.</div>';
  if($("multiUserReport")) $("multiUserReport").innerHTML = "";
  if($("phoneResponses")) $("phoneResponses").innerHTML = '<div class="status">No response data available.</div>';
}

async function loadDashboardFilters() {
  try {
    // Keep the existing server call intact.
    // Only the unused Village UI is removed.
    const result = await adminRequest("dashboard_filters");

    if (!result.success) return;

    const substationSelect = $("dashSubstationFilter");

    if(substationSelect){
      substationSelect.innerHTML =
        '<option value="">All Substations</option>';

      for(const s of (result.substations || [])){
        substationSelect.insertAdjacentHTML(
          "beforeend",
          `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`
        );
      }
    }

  } catch(e) {}
}



let correctionRecord = null;

async function loadCorrectionVillages() {
  const select = $("corrVillage");
  if (select.options.length > 1) return;

  try {
    const response = await fetch("village.json");
    const villages = await response.json();

    for (const village of villages) {
      const option = document.createElement("option");
      option.value = village.value;
      option.textContent = village.label;
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


  let grandSurvey=0;
  let grandDisconnection=0;
  let grandRecheck=0;
  let grandPhone=0;
  let grandTotal=0;

  for(const x of items){

    const survey=Number(x.survey||0);
    const disconnection=Number(x.disconnection||0);
    const recheck=Number(x.recheck||0);
    const phone=Number(x.phone_calling||0);
    const total=Number(x.total||0);

    grandSurvey+=survey;
    grandDisconnection+=disconnection;
    grandRecheck+=recheck;
    grandPhone+=phone;
    grandTotal+=total;

    html+=`<div class="substation-row"><div data-label="Substation">${escapeHtml(x.name||"Unassigned")}</div><div data-label="Survey">${survey.toLocaleString()}</div><div data-label="Disconnection">${disconnection.toLocaleString()}</div><div data-label="Recheck">${recheck.toLocaleString()}</div><div data-label="Phone">${phone.toLocaleString()}</div><div data-label="Total"><b>${total.toLocaleString()}</b></div></div>`;
  }

  html+=`<div class="substation-row substation-total-row">
    <div data-label="Substation"><b>TOTAL</b></div>
    <div data-label="Survey"><b>${grandSurvey.toLocaleString()}</b></div>
    <div data-label="Disconnection"><b>${grandDisconnection.toLocaleString()}</b></div>
    <div data-label="Recheck"><b>${grandRecheck.toLocaleString()}</b></div>
    <div data-label="Phone"><b>${grandPhone.toLocaleString()}</b></div>
    <div data-label="Total"><b>${grandTotal.toLocaleString()}</b></div>
  </div>`;

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

  showGlobalLoading(
    "Loading Dashboard...",
    "Fetching dashboard data from server. Please wait."
  );


  try {
    const result = await adminRequest("dashboard", {
      from_date: $("dashFromDate").value,
      to_date: $("dashToDate").value,
      village:  "",
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
  } finally {
     hideGlobalLoading();
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

  showGlobalLoading(
    "Loading Admin...",
    "Fetching admin data and user list. Please wait."
  );

  try {
    await loadAdminMasterLists();

  } finally {
    hideGlobalLoading();
  }
}

async function loadAdminMasterLists() {
  const subBox =
    $("newUserSubstations");

  const roleSelect =
    $("newUserRole");

  const divisionSelect =
    $("newUserDivision");

  const subdivisionSelect =
    $("newUserSubdivision");

  if (
    !subBox ||
    !roleSelect ||
    !divisionSelect ||
    !subdivisionSelect
  ) {
    return false;
  }

  subBox.textContent =
    "Loading organization hierarchy...";

  roleSelect.innerHTML =
    '<option value="">Select role</option>';

  divisionSelect.innerHTML =
    '<option value="">Select Division</option>';

  subdivisionSelect.innerHTML =
    '<option value="">Select Subdivision</option>';

  try {

    const result =
      await adminRequest("master_lists");

    if (!result.success) {
      subBox.textContent =
        result.message ||
        "Could not load organization hierarchy.";

      return false;
    }

    window.adminOrganizationMaster = {
      divisions:
        Array.isArray(result.divisions)
          ? result.divisions
          : [],

      divisionMap:
        result.division_map || {},

      subdivisionMap:
        result.subdivision_map || {},

      roles:
        Array.isArray(result.roles)
          ? result.roles
          : [],

      roleScope:
        result.role_scope || {}
    };

    for (
      const division of
      window.adminOrganizationMaster.divisions
    ) {

      const option =
        document.createElement("option");

      option.value = division;
      option.textContent = division;

      divisionSelect.appendChild(option);
    }

    for (
      const role of
      window.adminOrganizationMaster.roles
    ) {

      const option =
        document.createElement("option");

      option.value = role;
      option.textContent = role;

      roleSelect.appendChild(option);
    }

    updateAdminAssignmentUI();

    return true;

  } catch(e) {

    subBox.textContent =
      "Could not connect to server.";

    return false;
  }
}

function getAdminRoleScope() {
  const role =
    $("newUserRole")?.value || "";

  return (
    window.adminOrganizationMaster
      ?.roleScope?.[role] || ""
  );
}


function clearAdminSubstations(message) {
  const box =
    $("newUserSubstations");

  if (!box) return;

  box.innerHTML = "";

  const info =
    document.createElement("div");

  info.className =
    "admin-scope-info";

  info.textContent =
    message || "";

  box.appendChild(info);
}


function renderAdminSubstations(
  substations,
  options={}
) {
  const box =
    $("newUserSubstations");

  if (!box) return;

  box.innerHTML = "";

  const auto =
    options.auto === true;

  const single =
    options.single === true;

  if (!substations.length) {

    clearAdminSubstations(
      "No substations available."
    );

    return;
  }

  substations.forEach(name => {

    const label =
      document.createElement("label");

    label.className =
      "admin-checkbox-item" +
      (auto
        ? " admin-auto-scope"
        : "");

    const input =
      document.createElement("input");

    input.type =
      single
        ? "radio"
        : "checkbox";

    input.name =
      single
        ? "new-user-substation-single"
        : "new-user-substation";

    input.className =
      "new-user-substation";

    input.value =
      name;

    input.checked =
      auto;

    input.disabled =
      auto;

    const span =
      document.createElement("span");

    span.textContent =
      name;

    label.appendChild(input);
    label.appendChild(span);

    box.appendChild(label);
  });
}


function updateAdminScopeInfo() {

  const division =
    $("newUserDivision")?.value || "";

  const subdivision =
    $("newUserSubdivision")?.value || "";

  const role =
    $("newUserRole")?.value || "";

  const divisionInfo =
    $("newUserDivisionScope");

  const subdivisionInfo =
    $("newUserSubdivisionScope");

  const scopeInfo =
    $("newUserScopeInfo");

  [
    divisionInfo,
    subdivisionInfo,
    scopeInfo
  ].forEach(el => {

    if (!el) return;

    el.classList.add("hidden");
    el.textContent = "";
  });

  if (!role || !division) {
    return;
  }

  const scope =
    getAdminRoleScope();

  const divisionData =
    window.adminOrganizationMaster
      ?.divisionMap?.[division] ||
    {
      subdivisions:[],
      substations:[]
    };

  if (scope === "DIVISION") {

    if (divisionInfo) {

      divisionInfo.textContent =
        `${divisionData.subdivisions.length} subdivision(s) and ` +
        `${divisionData.substations.length} substation(s) ` +
        `will be selected automatically.`;

      divisionInfo.classList.remove("hidden");
    }

    renderAdminSubstations(
      divisionData.substations,
      {auto:true}
    );

    return;
  }

  if (!subdivision) {
    return;
  }

  const key =
    division +
    "||" +
    subdivision;

  const substations =
    window.adminOrganizationMaster
      ?.subdivisionMap?.[key] || [];

  if (scope === "SUBDIVISION") {

    if (subdivisionInfo) {

      subdivisionInfo.textContent =
        `${substations.length} substation(s) ` +
        `will be selected automatically.`;

      subdivisionInfo.classList.remove("hidden");
    }

    renderAdminSubstations(
      substations,
      {auto:true}
    );

    return;
  }

  if (scope === "SUBSTATION_SINGLE") {

    if (scopeInfo) {

      scopeInfo.textContent =
        `Select one substation for ${role}.`;

      scopeInfo.classList.remove("hidden");
    }

    renderAdminSubstations(
      substations,
      {single:true}
    );

    return;
  }

  if (scope === "SUBSTATION_MULTI") {

    if (scopeInfo) {

      scopeInfo.textContent =
        `Select one or more substations for ${role}.`;

      scopeInfo.classList.remove("hidden");
    }

    renderAdminSubstations(
      substations,
      {single:false}
    );
  }
}


function updateAdminAssignmentUI() {

  const division =
    $("newUserDivision")?.value || "";

  const role =
    $("newUserRole")?.value || "";

  const subdivisionSelect =
    $("newUserSubdivision");

  if (!subdivisionSelect) {
    return;
  }

  subdivisionSelect.innerHTML =
    '<option value="">Select Subdivision</option>';

  const divisionData =
    window.adminOrganizationMaster
      ?.divisionMap?.[division] ||
    {
      subdivisions:[],
      substations:[]
    };

  for (
    const subdivision of
    divisionData.subdivisions
  ) {

    const option =
      document.createElement("option");

    option.value =
      subdivision;

    option.textContent =
      subdivision;

    subdivisionSelect.appendChild(option);
  }

  const scope =
    getAdminRoleScope();

  if (scope === "DIVISION") {

    subdivisionSelect.value = "";
    subdivisionSelect.disabled = true;

    clearAdminSubstations(
      "Substations will be selected automatically from the entire Division."
    );

  } else {

    subdivisionSelect.disabled =
      false;

    if (!division) {

      clearAdminSubstations(
        "Select Division first."
      );

    } else {

      clearAdminSubstations(
        "Select Subdivision."
      );
    }
  }

  updateAdminScopeInfo();
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
  `    <div class="user-row user-head"><div>User ID</div><div>Name</div><div>Division</div><div>Subdivision</div><div>Substation(s)</div><div>Role</div><div>Status</div><div>Action</div></div>`
    ];

    for (const u of result.users) {

      const action = (u.active === "YES"
        ? `<button class="small-btn danger-btn" onclick="toggleUser('${escapeHtml(u.user_id)}','NO')">DISABLE</button>`
        : `<button class="small-btn" onclick="toggleUser('${escapeHtml(u.user_id)}','YES')">ENABLE</button>`) +
        ` <button class="small-btn" onclick="resetUserPassword('${escapeHtml(u.user_id)}')">RESET PASSWORD</button>`;

      rows.push(

        `<div class="user-row"><div data-label="User ID">${escapeHtml(u.user_id)}</div><div data-label="Name">${escapeHtml(u.user_name)}</div><div data-label="Division">${escapeHtml(u.division || "Unassigned")}</div><div data-label="Subdivision">${escapeHtml(u.subdivision || "Unassigned")}</div><div data-label="Substation(s)" class="admin-user-substation">${escapeHtml(u.substation || "Unassigned")}</div><div data-label="Role">${escapeHtml(u.role || "")}</div><div data-label="Status">${escapeHtml(u.active)}</div><div data-label="Action">${action}</div></div>`
      );
    }
    $("usersTable").innerHTML = rows.join("");
  } catch (e) {
    $("usersTable").textContent = "Could not connect to server.";
  }
}



async function createUser() {
  if (!state.isAdmin) return;

  const userId =
    $("newUserId").value.trim();

  const userName =
    $("newUserName").value.trim();

  const password =
    $("newUserPassword").value;

  const division =
    $("newUserDivision").value.trim();

  const subdivision =
    $("newUserSubdivision").value.trim();

  const role =
    $("newUserRole").value.trim();

  const scope =
    getAdminRoleScope();

  const substations = [
    ...document.querySelectorAll(
      ".new-user-substation:checked"
    )
  ].map(el => el.value);

  if (
    !userId ||
    !userName ||
    !password
  ) {
    return setStatus(
      "adminStatus",
      "Enter User ID, User Name and Password.",
      "error"
    );
  }

  if (!division) {
    return setStatus(
      "adminStatus",
      "Select Division.",
      "error"
    );
  }

  if (!role) {
    return setStatus(
      "adminStatus",
      "Select a role.",
      "error"
    );
  }

  if (
    scope !== "DIVISION" &&
    !subdivision
  ) {
    return setStatus(
      "adminStatus",
      "Select Subdivision.",
      "error"
    );
  }

  if (
    scope === "SUBSTATION_SINGLE" &&
    substations.length !== 1
  ) {
    return setStatus(
      "adminStatus",
      `${role} requires exactly one substation.`,
      "error"
    );
  }

  if (
    scope === "SUBSTATION_MULTI" &&
    !substations.length
  ) {
    return setStatus(
      "adminStatus",
      `Select at least one substation for ${role}.`,
      "error"
    );
  }

  if (
    (
      scope === "DIVISION" ||
      scope === "SUBDIVISION"
    ) &&
    !substations.length
  ) {
    return setStatus(
      "adminStatus",
      "No substations were derived for this assignment.",
      "error"
    );
  }

  setStatus(
    "adminStatus",
    "Creating user..."
  );

  const result =
    await adminRequest(
      "create_user",
      {
        user_id:userId,
        user_name:userName,
        password:password,
        substations:substations,
        division:division,
        subdivision:subdivision,
        role:role
      }
    );

  if (!result.success) {

    return setStatus(
      "adminStatus",
      result.message ||
        "Could not create user.",
      "error"
    );
  }

  $("newUserId").value = "";
  $("newUserName").value = "";
  $("newUserPassword").value = "";
  $("newUserDivision").value = "";
  $("newUserSubdivision").value = "";
  $("newUserRole").value = "";

  updateAdminAssignmentUI();

  setStatus(
    "adminStatus",
    "User created successfully.",
    "ok"
  );


}


/*
 * Admin: RESET PASSWORD for a user of the admin's area.
 * Opens the in-app Reset Password window. After a reset the user
 * is logged out on all phones and logs in again with the new
 * password. Records saved on their phone are kept.
 */
let resetPasswordUserId = "";

function resetUserPassword(userId) {
  if (!state.isAdmin) return;

  resetPasswordUserId = userId;
  $("resetPasswordFor").textContent = "User ID: " + userId;
  $("resetPasswordNew").value = "";
  $("resetPasswordConfirm").value = "";
  $("resetPasswordShow").checked = false;
  $("resetPasswordNew").type = "password";
  $("resetPasswordConfirm").type = "password";

  $("resetPasswordFields").classList.remove("hidden");
  $("resetPasswordSaveBtn").classList.remove("hidden");
  $("resetPasswordSaveBtn").disabled = false;

  setStatus("resetPasswordStatus", "");
  $("resetPasswordModal").classList.remove("hidden");
  $("resetPasswordNew").focus();
}

function closeResetPassword() {
  $("resetPasswordModal").classList.add("hidden");
  $("resetPasswordNew").value = "";
  $("resetPasswordConfirm").value = "";
  resetPasswordUserId = "";
}

function toggleResetPasswordVisibility() {
  const type = $("resetPasswordShow").checked ? "text" : "password";
  $("resetPasswordNew").type = type;
  $("resetPasswordConfirm").type = type;
}

async function saveResetPassword() {

  const userId = resetPasswordUserId;
  if (!userId) return;

  const password = $("resetPasswordNew").value;
  const confirmPassword = $("resetPasswordConfirm").value;

  if (password.length < 6) {
    return setStatus("resetPasswordStatus", "Password must be at least 6 characters.", "error");
  }
  if (password !== confirmPassword) {
    return setStatus("resetPasswordStatus", "The two passwords do not match.", "error");
  }

  const button = $("resetPasswordSaveBtn");
  button.disabled = true;
  setStatus("resetPasswordStatus", "");
  showGlobalLoading("Resetting password…", "Saving the new password for " + userId + " on the server.");

  let result;

  try {
    result = await adminRequest("reset_password", { user_id: userId, new_password: password });
  } catch (e) {
    result = { success: false, message: "Could not connect to the server. Please try again." };
  } finally {
    hideGlobalLoading();
    button.disabled = false;
  }

  if (!result.success) {
    return setStatus("resetPasswordStatus", result.message || "Could not reset the password.", "error");
  }

  $("resetPasswordNew").value = "";
  $("resetPasswordConfirm").value = "";

  button.classList.add("hidden");
  $("resetPasswordFields").classList.add("hidden");
  setStatus("resetPasswordStatus", result.message || "Password reset.", "ok");


  /* Own password reset: this phone's login is no longer valid. */
  if (String(userId).toLowerCase() === String(state.userId || "").toLowerCase()) {
    setTimeout(() => {
      closeResetPassword();
      logout();
    }, 2500);
  }
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

  
  if (!$("usersTable").classList.contains("hidden")) {
      await loadUsers();
  }

}


$("homeBtn").addEventListener("click", goHome);
$("checkMasterUpdateBtn")
  .addEventListener(
    "click",
    checkAndUpdateMasterData
  );

$("downloadMasterUpdateBtn")
  .addEventListener(
    "click",
    performMasterUpdate
  );

/* Feeder change -> refresh its DT list */
for (const [feederId, dtId] of FEEDER_DT_PAIRS) {
  if ($(feederId)) {
    $(feederId).addEventListener("change", () => {
      if ($(dtId)) $(dtId).value = "";
      fillDtDropdown(dtId, feederId);
    });
  }
}



/* Defaulter List (guarded: page may not have it) */
if ($("openDefaulterListBtn")) {
  $("openDefaulterListBtn").addEventListener("click", openDefaulterList);
  $("dlCloseBtn").addEventListener("click", closeDefaulterList);
  $("dlPreviewBtn").addEventListener("click", previewDefaulterList);
  $("dlPdfBtn").addEventListener("click", downloadDefaulterPdf);
  $("dlPayMode").addEventListener("change", dlUpdatePayBoxes);

  $("dlDocMode").addEventListener("change", dlUpdateDocBox);
  $("dlLoadMode").addEventListener("change", dlUpdateLoadBox);
  ["dlLoadMin", "dlLoadMax", "dlOutMin"].forEach(id => dlNumbersOnly($(id)));
  document.querySelectorAll("#defaulterListCard .dl-filter-head").forEach(btn =>

    btn.addEventListener("click", () => dlToggleList(btn.dataset.target))
  );
}


/* Disconnected But Unpaid List (guarded: page may not have it) */
if ($("openDisconnectedUnpaidBtn")) {
  $("openDisconnectedUnpaidBtn").addEventListener("click", openDisconnectedUnpaidList);
  $("duBackBtn").addEventListener("click", closeDisconnectedUnpaidList);
  $("duLoadBtn").addEventListener("click", loadDisconnectedUnpaid);
  $("duPreviewBtn").addEventListener("click", previewDisconnectedUnpaid);
  $("duPdfBtn").addEventListener("click", downloadDisconnectedUnpaidPdf);
  ["duDateMode", "duLoadMode", "duDocMode", "duPayMode"].forEach(id =>
    $(id).addEventListener("change", duUpdateBoxes)
  );
  ["duLoadMin", "duLoadMax", "duOutMin"].forEach(id => dlNumbersOnly($(id)));


  document.querySelectorAll("#disconnectedUnpaidCard .dl-filter-head").forEach(btn =>
    btn.addEventListener("click", () => dlToggleList(btn.dataset.target))
  );
}



/* Share window buttons (guarded: page may not have them) */
if ($("shareWhatsAppBtn")) $("shareWhatsAppBtn").addEventListener("click", shareLastActivity);
if ($("shareCloseBtn")) $("shareCloseBtn").addEventListener("click", closeShareModal);
if ($("shareVideoBtn")) $("shareVideoBtn").addEventListener("click", shareLastActivityVideo);



/* Status change: show / hide the video part of the form */
if ($("disconnectStatus")) $("disconnectStatus").addEventListener("change", () => updateVideoSection("DISCONNECTION"));
if ($("recheckStatus")) $("recheckStatus").addEventListener("change", () => updateVideoSection("RECHECK"));


/* UPLOAD VIDEOS button (guarded: page may not have it) */
if ($("uploadVideosBtn")) $("uploadVideosBtn").addEventListener("click", uploadPendingVideos);



/* Video recorder buttons (guarded: page may not have them) */
if ($("disconnectRecordBtn")) $("disconnectRecordBtn").addEventListener("click", () => openVideoRecorder("DISCONNECTION"));
if ($("recheckRecordBtn")) $("recheckRecordBtn").addEventListener("click", () => openVideoRecorder("RECHECK"));
if ($("videoStartBtn")) $("videoStartBtn").addEventListener("click", startVideoRecording);
if ($("videoStopBtn")) $("videoStopBtn").addEventListener("click", stopVideoRecording);
if ($("videoPauseBtn")) $("videoPauseBtn").addEventListener("click", pauseVideoRecording);
if ($("videoResumeBtn")) $("videoResumeBtn").addEventListener("click", resumeVideoRecording);
if ($("videoPlayBtn")) $("videoPlayBtn").addEventListener("click", playVideoPreview);

if ($("videoSaveBtn")) $("videoSaveBtn").addEventListener("click", saveRecordedVideo);
if ($("videoRetakeBtn")) $("videoRetakeBtn").addEventListener("click", retakeVideo);
if ($("videoCancelBtn")) $("videoCancelBtn").addEventListener("click", () => closeVideoRecorder(true));



/* Permission gate buttons (guarded: page may not have them) */
if ($("permissionAllowBtn")) {
  $("permissionAllowBtn").addEventListener("click", requestDevicePermissions);
}
if ($("permissionLogoutBtn")) {
  $("permissionLogoutBtn").addEventListener("click", () => {
    permissionWaiters = [];
    showPermissionGate(false);
    logout();
  });
}



/* Village list button (guarded: page may not have it) */
if ($("checkVillageListBtn")) {
  $("checkVillageListBtn")
    .addEventListener(
      "click",
      () => checkVillageListUpdate(false)
    );
}
$("existingSurveyBtn").addEventListener("click", showExistingSurvey);
$("newSurveyBtn").addEventListener("click", showNewSurvey);
$("searchType").addEventListener("change", ()=>{
  $("accountId").value="";
  updateExistingSearchPlaceholder();
});

$("recheckSearchType").addEventListener("change",()=>{
  $("recheckAccountId").value="";
  $("recheckSearchResults").innerHTML="";
  $("recheckSearchResults").classList.add("hidden");
  updateModuleSearchPlaceholder(
    "recheckSearchType",
    "recheckAccountId"
  );
});

$("disconnectSearchType").addEventListener("change",()=>{
  $("disconnectAccountId").value="";
  $("disconnectSearchResults").innerHTML="";
  $("disconnectSearchResults").classList.add("hidden");
  updateModuleSearchPlaceholder(
    "disconnectSearchType",
    "disconnectAccountId"
  );
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

/* Reset Password window (guarded: page may not have it) */
if ($("resetPasswordModal")) {
  $("resetPasswordSaveBtn").addEventListener("click", saveResetPassword);
  $("resetPasswordCloseBtn").addEventListener("click", closeResetPassword);
  $("resetPasswordShow").addEventListener("change", toggleResetPasswordVisibility);
}

$("adminBtn").addEventListener("click", openAdmin);

$("viewUsersBtn").addEventListener(
  "click",
  async () => {
    const btn = $("viewUsersBtn");

    btn.disabled = true;
    btn.textContent = "LOADING USERS...";

    try {
      $("usersTable").classList.remove("hidden");
      await loadUsers();
    } finally {
      btn.disabled = false;
      btn.textContent = "REFRESH USERS";
    }
  }
);

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

  $("dashSubstationFilter").value="";
  resetDashboardDisplay();
});

$("createUserBtn").addEventListener("click", createUser);

$("newUserRole").addEventListener(  "change",  updateAdminAssignmentUI);
$("newUserDivision").addEventListener(  "change",  () => {    $("newUserSubdivision").value = "";    updateAdminAssignmentUI();  });
$("newUserSubdivision").addEventListener(  "change",  updateAdminScopeInfo);

$("searchBtn").addEventListener("click", searchConsumer);

$("masterSetupContinueBtn").addEventListener("click", closeMasterSetup);

/* Master setup TRY AGAIN (guarded: page may not have it) */
if ($("masterSetupRetryBtn")) {
  $("masterSetupRetryBtn").addEventListener("click", () => {
    $("masterSetupRetryBtn").classList.add("hidden");
    startMasterSetup();
  });
}
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

initLanguageSwitch();
init();
requestPersistentStorage();



async function v151ExportLocalData() {
  const surveys=await getAllRecords();
  const disconnections=await getAllFromStore("disconnections");
  const rechecks=await getAllFromStore("rechecks");
  const phoneCalls=await getAllFromStore("phoneCalls");
  const files=[];


  if(surveys.length) files.push({name:"Door_to_Door_Survey",headers:["Survey Type","Survey Status","Connection Type","Survey ID","User ID","User Name","Account ID","Consumer Name","Father/Husband","Address","Supply Type","Load","SDO Code","Village","Substation","Feeder","DT","Theft Possibility","Feeded Village Name","Connection Status","Last Pay Date","Last Pay Amount","Nature of Supply","House Condition","Consumer Payment Response","Consumer Payment Date","Meter Condition","AC Installed","Mobile Number","House Locked","Mobile Refused","Meter Installed","Meter Number","Master Reading","Site Reading","Site Max Demand","Outstanding","Connected Load","Remarks","Latitude","Longitude","GPS Accuracy","Created At","Upload Status"],rows:surveys.map(r=>[r.survey_type||"",r.survey_status||"",r.connection_type||"",r.survey_id||"",r.user_id||"",r.user_name||"",r.account_id||"",r.consumer_name||"",r.father_name||"",r.address||"",r.supply_type||"",r.load||"",r.sdo_code||"",r.village||"",r.feeder_substation||"",r.feeder||"",r.dt||"",r.theft_possibility||"",r.feeded_village_name||"",r.connection_status||"",r.last_pay_date||"",r.last_pay_amount||"",r.nature_of_supply||"",r.house_condition||"",r.consumer_payment_response||"",r.consumer_payment_date||"",r.meter_condition||"",r.ac_installed||"",r.mobile_number||"",r.house_locked||"",r.mobile_refused||"",r.meter_installed||"",r.meter_number||"",r.current_reading||"",r.site_reading||"",r.site_max_demand||"",r.outstanding||"",r.connected_load||"",r.remarks||"",r.latitude||"",r.longitude||"",r.gps_accuracy||"",v1511ISTDateTime(r.created_at)||"",r.upload_status||"PENDING"]) });
  if(disconnections.length) files.push({name:"Disconnections",headers:["Disconnection ID","User ID","User Name","Account ID","Consumer Name","Father/Husband","Address","Supply Type","Load","SDO Code","Disconnection Status","Payment Mode","Committed Payment Date","Meter Status","Site Reading","Mobile Number","House Condition","Total Outstanding","Remarks","Latitude","Longitude","GPS Accuracy","Created At","Last Updated By User ID","Last Updated By Name","Last Updated At","Feeded Village Name","Connection Status","Last Pay Date","Last Pay Amount","Upload Status"],rows:disconnections.map(r=>[r.disconnection_id||"",r.user_id||"",r.user_name||"",r.account_id||"",r.consumer_name||"",r.father_name||"",r.address||"",r.supply_type||"",r.load||"",r.sdo_code||"",r.disconnection_status||"",r.payment_mode||"",r.committed_payment_date||"",r.meter_status||"",r.current_reading||"",r.mobile_number||"",r.house_condition||"",r.outstanding||"",r.remarks||"",r.latitude||"",r.longitude||"",r.gps_accuracy||"",v1511ISTDateTime(r.created_at)||"",r.last_updated_by_user_id||"",r.last_updated_by_name||"",v1511ISTDateTime(r.last_updated_at)||"",r.feeded_village_name||"",r.connection_status||"",r.last_pay_date||"",r.last_pay_amount||"",r.upload_status||"PENDING"]) });
  if(rechecks.length) files.push({name:"Rechecking",headers:["Recheck ID","User ID","User Name","Account ID","Consumer Name","Father/Husband","Address","Supply Type","Load","SDO Code","Total Outstanding","Present Status","Payment Mode","Payment Date","Meter Status","Site Reading","Mobile Number","Remarks","Latitude","Longitude","GPS Accuracy","Created At","Last Updated By User ID","Last Updated By Name","Last Updated At","Feeded Village Name","Connection Status","Last Pay Date","Last Pay Amount","Upload Status"],rows:rechecks.map(r=>[r.recheck_id||"",r.user_id||"",r.user_name||"",r.account_id||"",r.consumer_name||"",r.father_name||"",r.address||"",r.supply_type||"",r.load||"",r.sdo_code||"",r.outstanding||"",r.present_status||"",r.payment_mode||"",r.payment_date||"",r.meter_status||"",r.current_reading||"",r.mobile_number||"",r.remarks||"",r.latitude||"",r.longitude||"",r.gps_accuracy||"",v1511ISTDateTime(r.created_at)||"",r.last_updated_by_user_id||"",r.last_updated_by_name||"",v1511ISTDateTime(r.last_updated_at)||"",r.feeded_village_name||"",r.connection_status||"",r.last_pay_date||"",r.last_pay_amount||"",r.upload_status||"PENDING"]) });
  if(phoneCalls.length) files.push({name:"Phone_Calling",headers:["Calling ID","User ID","User Name","Account ID","Consumer Name","Father/Husband","Address","Supply Type","Load","SDO Code","Mobile Number","Call Response","Committed Payment Date","Remarks","Created At","Total Outstanding","Last Updated By User ID","Last Updated By Name","Last Updated At","Feeded Village Name","Connection Status","Last Pay Date","Last Pay Amount","Upload Status"],rows:phoneCalls.map(r=>[r.calling_id||"",r.user_id||"",r.user_name||"",r.account_id||"",r.consumer_name||"",r.father_name||"",r.address||"",r.supply_type||"",r.load||"",r.sdo_code||"",r.mobile_number||"",r.call_response||"",r.committed_payment_date||r.payment_date||"",r.remarks||"",v1511ISTDateTime(r.created_at)||"",r.outstanding||"",r.last_updated_by_user_id||"",r.last_updated_by_name||"",v1511ISTDateTime(r.last_updated_at)||"",r.feeded_village_name||"",r.connection_status||"",r.last_pay_date||"",r.last_pay_amount||"",r.upload_status||"PENDING"]) });

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
