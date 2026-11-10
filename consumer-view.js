/*
 * =========================================================
 * FIELDWORK APP - CONSUMER DETAILS (consumer-view.js, v20.4)
 * =========================================================
 * Loaded after app.js. Home -> CONSUMER DETAILS: search any
 * consumer in the Master Data on this phone (works offline) and
 * view the basic details. View only: nothing is saved or sent.
 */
(() => {
  const MAX_RESULTS = 50;
  const on = (id, ev, fn) => { if ($(id)) $(id).addEventListener(ev, fn); };
  const e = v => escapeHtml(String(v == null ? "" : v));
  const show = v => { const t = String(v == null ? "" : v).trim(); return t ? e(t) : "—"; };
  const money = v => {
    const t = String(v == null ? "" : v).replace(/,/g, "").trim();
    return t === "" ? "—" : isFinite(Number(t)) ? "₹" + Number(t).toLocaleString("en-IN") : e(t);
  };
  const date = v => show(formatListDate(parseMasterDate(v) || v));

  /* both cards are hidden when another page opens (the Home card comes back on HOME) */
  if (typeof MAIN_VIEW_IDS !== "undefined") {
    ["consumerLookupCard", "consumerLookupModuleCard"].forEach(id => {
      if (MAIN_VIEW_IDS.indexOf(id) === -1) MAIN_VIEW_IDS.push(id);
    });
  }

  /* ---------- filters: SDO > Substation > Feeder > Village (from the master on this phone) ---------- */
  const FILTERS = [["clSdo", "sdo"], ["clSub", "sub"], ["clFeeder", "feeder"], ["clVillage", "village"]];
  let combos = null;
  const blankLabel = v => (typeof DL_BLANK !== "undefined" && v === DL_BLANK) ? "(blank)" : v;
  const val = v => (typeof dlVal === "function" ? dlVal(v) : (String(v == null ? "" : v).trim() || "(blank)"));
  const sortVals = a => (typeof dlSortValues === "function" ? dlSortValues(a) : a.slice().sort());

  function chosen() {
    const out = {};
    FILTERS.forEach(([id, k]) => { out[k] = $(id) ? $(id).value : ""; });
    return out;
  }

  function fillFilters() {
    if (!combos) return;
    const pick = chosen();
    FILTERS.forEach(([id, k], level) => {
      const sel = $(id);
      if (!sel) return;
      const above = FILTERS.slice(0, level).map(([, kk]) => kk);
      const values = new Set();
      combos.forEach(c => { if (above.every(kk => !pick[kk] || c[kk] === pick[kk])) values.add(c[k]); });
      const list = sortVals(Array.from(values));
      if (pick[k] && !values.has(pick[k])) pick[k] = "";
      sel.innerHTML = '<option value="">All</option>' +
        list.map(v => '<option value="' + e(v) + '"' + (v === pick[k] ? " selected" : "") + ">" + e(blankLabel(v)) + "</option>").join("");
    });
  }

  async function loadFilters() {
    if (!state.masterReady || !state.masterDb || typeof dlLoadOptions !== "function") return;
    try {
      const o = await dlLoadOptions();
      combos = o.combos;
      fillFilters();
    } catch (err) { console.error(err); }
  }

  function onFilterChange(ev) {
    const level = FILTERS.findIndex(([id]) => id === ev.target.id);
    FILTERS.slice(level + 1).forEach(([id]) => { if ($(id)) $(id).value = ""; });   /* lists below: back to All */
    fillFilters();
  }
  const filterSet = () => Object.values(chosen()).some(Boolean);

  /* the same matching as the other consumer searches, plus the filters */
  function searchMaster(type, value) {
    const pick = chosen();
    const text = value.trim().toLowerCase();
    const digits = value.replace(/\D/g, "");
    const meter = text.replace(/\s+/g, "");
    const results = [];
    let total = 0;
    return forEachMasterBatch(batch => {
      for (const c of batch) {
        if (pick.sdo && val(c.SDO_CODE) !== pick.sdo) continue;
        if (pick.sub && val(c.SUBSTATION) !== pick.sub) continue;
        if (pick.feeder && val(c.FEEDER) !== pick.feeder) continue;
        if (pick.village && val(c.feeded_village_name) !== pick.village) continue;
        if (value) {
          let ok = false;
          if (type === "NAME") ok = String(c.NAME || "").toLowerCase().includes(text);
          else if (type === "FATHER_NAME") ok = String(c.FATHER_NAME || "").toLowerCase().includes(text);
          else if (type === "MOBILE") ok = String(c.MOBILE_NUMBER || "").replace(/\D/g, "").includes(digits);
          else if (type === "METER") ok = String(c.METER_NO || "").toLowerCase().replace(/\s+/g, "").includes(meter);
          if (!ok) continue;
        }
        total++;
        if (results.length < MAX_RESULTS) results.push(c);
      }
    }).then(() => ({ results: results, total: total }));
  }

  const PLACEHOLDER = {
    ACCOUNT: "Enter account ID",
    NAME: "Enter consumer name (part is enough)",
    FATHER_NAME: "Enter father / husband name",
    MOBILE: "Enter mobile number",
    METER: "Enter meter number"
  };

  function setMode() {
    const type = $("clSearchType").value;
    const input = $("clSearchValue");
    input.placeholder = PLACEHOLDER[type] || "";
    if (typeof setAccountIdInputMode === "function") setAccountIdInputMode(input, type === "ACCOUNT");
    else input.setAttribute("inputmode", type === "ACCOUNT" || type === "MOBILE" ? "numeric" : "text");
    if (type === "MOBILE") input.setAttribute("inputmode", "numeric");
  }

  function openLookup() {
    showMainView("consumerLookupCard");
    window.scrollTo(0, 0);
    setMode();
    loadFilters();
    if (!state.masterReady) setStatus("clStatus", "Master Data is still loading. Please wait.", "error");
    setTimeout(() => $("clSearchValue").focus(), 50);
  }

  async function search() {
    const type = $("clSearchType").value;
    const value = $("clSearchValue").value.trim();
    $("clResults").innerHTML = "";
    $("clResults").classList.add("hidden");
    $("clDetails").classList.add("hidden");
    if (!state.masterReady || !state.masterDb) return setStatus("clStatus", "Master Data is still loading. Please wait.", "error");
    if (type === "ACCOUNT" && !value && !filterSet()) return setStatus("clStatus", "Enter an account ID.", "error");
    if (!value && !filterSet()) return setStatus("clStatus", "Enter a search value, or choose a feeder / village.", "error");
    if (value && type !== "ACCOUNT" && value.replace(/\s/g, "").length < 3) {
      return setStatus("clStatus", "Enter at least 3 letters or digits.", "error");
    }

    let results = [], total = 0;
    setStatus("clStatus", "Searching…");
    try {
      if (type === "ACCOUNT" && value) {
        /* an account ID is exact: the filters are not needed */
        const c = await getMasterByAccountInput(value.replace(/\D/g, ""));
        results = c ? [c] : [];
        total = results.length;
      } else {
        const r = await searchMaster(type, type === "ACCOUNT" ? "" : value);
        results = r.results; total = r.total;
      }
    } catch (err) {
      console.error(err);
      return setStatus("clStatus", "Could not read the Master Data on this phone.", "error");
    }

    if (!total) return setStatus("clStatus", "No matching consumer found.", "error");
    if (total === 1) {
      setStatus("clStatus", "");
      return showDetails(results[0]);
    }

    const list = results;
    setStatus("clStatus", total.toLocaleString("en-IN") + " consumers found" +
      (total > MAX_RESULTS ? " (first " + MAX_RESULTS + " shown; type more or choose a filter to narrow it down)" : "") +
      ". Tap one to see the details.", "ok");
    const box = $("clResults");
    list.forEach(c => {
      const card = document.createElement("div");
      card.className = "search-result-card";
      card.innerHTML =
        "<div><strong>" + e(c.ACCT_ID) + "</strong> · " + e(c.NAME) + "</div>" +
        "<div>" + e([c.FATHER_NAME, c.feeded_village_name, c.MOBILE_NUMBER].filter(v => String(v || "").trim()).join(" · ")) + "</div>";
      card.addEventListener("click", () => {
        box.classList.add("hidden");
        setStatus("clStatus", "");
        showDetails(c);
      });
      box.appendChild(card);
    });
    box.classList.remove("hidden");
  }

  function row(label, value) {
    return "<div><span>" + e(label) + "</span><b>" + value + "</b></div>";
  }

  /* v20.3: NAVIGATE opens Google Maps directions to the consumer. */
  const GEO_SOURCE_TEXT = {
    SM: ["Verified (smart meter installation)", "#15803d"],
    BILL: ["Approximate (meter reading place, billed report)", "#b45309"],
    MASTER: ["Approximate (master data)", "#b45309"]
  };
  function locationHtml(c) {
    const lat = Number(c.GEO_LAT), lng = Number(c.GEO_LNG);
    if (!lat || !lng || Math.abs(lat) > 90 || Math.abs(lng) > 180) return "Not available";
    const src = GEO_SOURCE_TEXT[String(c.GEO_SOURCE || "").toUpperCase()] || ["Approximate", "#b45309"];
    const nav = "https://www.google.com/maps/dir/?api=1&destination=" + lat + "," + lng;
    return '<a class="cl-nav" href="' + e(nav) + '" target="_blank" rel="noopener">NAVIGATE (Google Maps)</a>' +
      '<span class="cl-geo" style="color:' + src[1] + '">' + e(src[0]) + "</span>";
  }

  function showDetails(c) {
    const sm = String(c.MR_SOURCE_CD || "").trim().toUpperCase();
    const meter = (typeof getConsumerMeterNo === "function" ? getConsumerMeterNo(c) : c.METER_NO) || "";
    const html =
      '<div class="cl-head"><div class="cl-acct">' + e(c.ACCT_ID) + '</div><div class="cl-name">' + show(c.NAME) + "</div>" +
      '<div class="cl-status">' + show(c.CONNECTION_STATUS) + "</div></div>" +
      '<div class="details">' +
      row("Father/Husband", show(c.FATHER_NAME)) +
      row("Address", show(c.ADDRESS)) +
      row("Village", show(c.feeded_village_name)) +
      row("Mobile", c.MOBILE_NUMBER ? '<a href="tel:' + e(String(c.MOBILE_NUMBER).replace(/[^\d+]/g, "")) + '">' + e(c.MOBILE_NUMBER) + "</a>" : "—") +
      row("SDO / Substation / Feeder", show([c.SDO_CODE, c.SUBSTATION, c.FEEDER].filter(v => String(v || "").trim()).join(" / "))) +
      row("Supply Type / Load", show(c.SUPPLY_TYPE) + " / " + show(c.LOAD)) +
      row("Connection Date (DOC)", date(c.DOC)) +
      row("Meter No / Reading", show(meter) + " / " + show(c.CURRENT_READING)) +
      row("Meter Type", sm ? (sm === "SM" ? "Smart meter (SM)" : e(sm)) : "—") +
      row("Geo Location", typeof consumerLocationHtml === "function" ? consumerLocationHtml(c) : locationHtml(c)) +
      row("Total Outstanding", money(c.TOTAL_OUTSTANDING)) +
      row("Last Payment", date(c.LAST_PAY_DATE) + (String(c.LAST_PAY_AMOUNT || "").trim() ? " · " + money(c.LAST_PAY_AMOUNT) : "")) +
      row("Paid This Month (total)", money(c.THIS_MONTH_TOTAL_PAY_AMT)) +
      row("Last Bill (Basis)", e(typeof lastBillText === "function" ? lastBillText(c) : c.LAST_BILL_DATE) +
        (String(c.METER_READ_REMARK || "").trim() ? " · " + e(c.METER_READ_REMARK) : "")) +
      row("Consumption: Current / Previous / Before Previous",
        e(typeof consumptionText === "function" ? consumptionText(c) : c.CONSUMPTION_CURR_MNTH)) +
      "</div>" +
      '<div class="pg-note">From the Master Data on this phone' +
      (c.REPORT_DATE ? " (data up to " + date(c.REPORT_DATE) + ")" : "") + ". View only.</div>";
    $("clDetails").innerHTML = html;
    $("clDetails").classList.remove("hidden");
    $("clDetails").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  const style = document.createElement("style");
  style.textContent =
    ".cl-head{background:linear-gradient(135deg,#0f766e,#0891b2);color:#fff;border-radius:14px;padding:14px;margin:14px 0 10px}" +
    ".cl-acct{font-size:13px;opacity:.9;font-weight:700;letter-spacing:.5px}" +
    ".cl-name{font-size:19px;font-weight:800;margin-top:2px}" +
    ".cl-status{display:inline-block;margin-top:8px;background:rgba(255,255,255,.2);border-radius:999px;padding:3px 10px;font-size:12px;font-weight:700}" +
    "#clDetails .details a{color:#0f766e}" +
    ".cl-nav{display:inline-block;background:#0d9488;color:#fff!important;text-decoration:none;" +
    "padding:7px 12px;border-radius:8px;font-size:13px;font-weight:700;margin:2px 0}" +
    ".cl-geo{display:block;font-size:11.5px;font-weight:600;margin-top:4px;line-height:1.35}" +
    ".details .geo-place{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;margin:2px 0 6px;border:0;padding:0}" +
    ".geo-cap{width:100%;font-size:11.5px;font-weight:700;color:#475569}" +
    ".geo-ll{font-size:13px;font-weight:600;font-variant-numeric:tabular-nums}" +
    ".geo-place .cl-nav{padding:5px 10px;font-size:12px;margin:0}";
  document.head.appendChild(style);

  on("openConsumerLookupBtn", "click", openLookup);
  on("clBackBtn", "click", () => showMainView("home"));
  on("clSearchBtn", "click", search);
  on("clSearchType", "change", () => { $("clSearchValue").value = ""; setMode(); });
  FILTERS.forEach(([id]) => on(id, "change", onFilterChange));
  on("clSearchValue", "keydown", ev => { if (ev.key === "Enter") { ev.preventDefault(); search(); } });
  if ($("clSearchValue") && typeof digitsOnlyGuard === "function") digitsOnlyGuard($("clSearchValue"));
})();
