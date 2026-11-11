/*
 * =========================================================
 * FIELDWORK APP - PROGRESS TAB (progress.js, v19.7)
 * =========================================================
 * Loaded after app.js. Everything is calculated on this phone
 * from the master (+ daily updates), so it works offline.
 * Only BILLABLE consumers (In Service, TD, TD>6Month) count.
 * The master is read once per data version into village-level
 * totals; filters and switches only add those totals up.
 * The disconnection drive comes from the server (REFRESH) and
 * the last copy is kept for offline use.
 */
(() => {

  /* ---------- categories (Tariff PDF) ---------- */
  const TARIFF = (() => {
    const t = {
      "LMV-1": "10 10A 11 17 17A 18 19",
      "LMV-2": "20 22 24 24B 24C 24D 25 26 27 28",
      "LMV-3": "30 31 32 33 34 35 36A 37A 38A",
      "LMV-4": "40 40A 41 41A 42 42A 43 44 46 47",
      "LMV-5": "50 51 52 53 54 55 56 57A 57 58U 58 58UA 59R 59RA",
      "LMV-6": "60 60TA 61 63 65 66 67 68T",
      "LMV-7": "72 73 74 75",
      "LMV-8": "80U 80R 81U 81R 82U 82R",
      "LMV-9": "90 91 92 93 94 95 99",
      "LMV-10": "101 102 103 104 105 106 107",
      "LMV-11": "11A 11B 11C 11D 11FA 11GA 11HA",
      "HV-1": "H11 H12 H13 H14 H15 H15A H16 H16A H17 H17A H18 H18A",
      "HV-2": "H21A H22A H23A H24A H26",
      "HV-3": "H31 H32 H33 H34 H35 H36",
      "HV-4": "H41 H42 H43"
    };
    const map = {};
    Object.keys(t).forEach(cat => t[cat].split(" ").forEach(code => { map[code] = cat; }));
    return map;
  })();
  const CAT_ORDER = ["LMV-1", "LMV-2", "LMV-3", "LMV-4 Govt", "LMV-4 Non-Govt", "LMV-5", "LMV-6",
    "LMV-7", "LMV-8", "LMV-9", "LMV-10", "LMV-11", "HV-1", "HV-2", "HV-3", "HV-4", "OTHER"];
  /* Govt: LMV-3, LMV-4 Govt (40-44), LMV-7, LMV-8, LMV-10, HV-3, HV-4. PTW: LMV-5. Rest: Non-Govt. */
  const LMV4_GOVT = new Set("40 40A 41 41A 42 42A 43 44".split(" "));
  const GOVT_CATS = new Set(["LMV-3", "LMV-4 Govt", "LMV-7", "LMV-8", "LMV-10", "HV-3", "HV-4"]);
  const BILLABLE = new Set(["INSERVICE", "TD", "TD>6MONTH", "TD>6MONTHS"]);
  const GROUP_LABEL = { ALL: "All", G: "Govt", N: "Non-Govt", GN: "Govt + Non-Govt", P: "PTW" };
  /* the Connections switch; GN = Govt and Non-Govt together (everything except PTW) */
  const groupOk = g => sel.group === "ALL" || (sel.group === "GN" ? g !== "P" : g === sel.group);
  const LEVELS = ["sdo", "sub", "feeder", "village"];
  const LEVEL_LABEL = { sdo: "SDO", sub: "Substation", feeder: "Feeder", village: "Village" };
  const UNPAID_BANDS = ["3 to 4", "5 to 9", "10 to 49", "50 and above"];
  const UNBILLED_BANDS = ["1", "2", "3 to 4", "5 to 9", "10 to 49", "50 and above"];
  const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August",
    "September", "October", "November", "December"];
  const monthName = ym => MONTH_NAMES[Number(ym.slice(5, 7)) - 1];

  const supplyCode = v => String(v == null ? "" : v).trim().toUpperCase().replace(/\s+/g, "").replace(/\.0+$/, "");
  function category(code) {
    let c = TARIFF[code] || (code ? supplyCategory(code) : "OTHER");
    if (c === "LMV-4") c = LMV4_GOVT.has(code) ? "LMV-4 Govt" : "LMV-4 Non-Govt";
    return CAT_ORDER.indexOf(c) === -1 ? "OTHER" : c;
  }
  const group = cat => cat === "LMV-5" ? "P" : GOVT_CATS.has(cat) ? "G" : "N";
  const catLabel = cat => cat === "LMV-5" ? "LMV-5 (PTW)" : cat;
  const isBillable = s => BILLABLE.has(String(s || "").toUpperCase().replace(/\s+/g, ""));
  const isSmart = c => String(c.MR_SOURCE_CD || "").trim().toUpperCase() === "SM";
  function num(v) {
    const n = Number(String(v == null ? "" : v).replace(/,/g, "").trim());
    return isFinite(n) ? n : 0;
  }
  const unpaidBand = l => l >= 50 ? 3 : l >= 10 ? 2 : l >= 5 ? 1 : l >= 3 ? 0 : -1;   /* kW/kVA/BHP alike */
  const unbilledBand = l => l >= 50 ? 5 : l >= 10 ? 4 : l >= 5 ? 3 : l > 2 ? 2 : l > 1 ? 1 : 0;

  /* ---------- dates (yyyy-mm-dd strings compare correctly) ---------- */
  function monthKey(label) {                       /* "NOV_2026" -> "2026-11" */
    const m = String(label || "").toUpperCase().match(/([A-Z]{3})[_\- ]?(\d{4})/);
    if (!m || MONTHS.indexOf(m[1]) === -1) return "";
    return m[2] + "-" + String(MONTHS.indexOf(m[1]) + 1).padStart(2, "0");
  }
  function prevMonth(ym) {
    let [y, m] = ym.split("-").map(Number);
    m -= 1; if (m < 1) { m = 12; y -= 1; }
    return y + "-" + String(m).padStart(2, "0");
  }
  const daysIn = ym => new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7), 0)).getUTCDate();
  function addDays(ymd, n) {
    const d = new Date(ymd + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  const shortDate = ymd => Number(ymd.slice(8, 10)) + " " +
    MONTHS[Number(ymd.slice(5, 7)) - 1].charAt(0) + MONTHS[Number(ymd.slice(5, 7)) - 1].slice(1).toLowerCase();
  function todayYmd() {
    const d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }

  function context() {
    const meta = getLocalMasterMeta() || {};
    const report = parseMasterDate(meta.report_date) || todayYmd();       /* data up to this date */
    const billingMonth = monthKey(meta.billing_month) || report.slice(0, 7);
    const masterMonth = monthKey(meta.master_month) || prevMonth(billingMonth);
    const day = Math.min(Number(report.slice(8, 10)), daysIn(masterMonth));
    return {
      key: [state.activeMasterStore, state.masterCount, meta.base_id || "", meta.updates_seq || 0,
        meta.master_file_id || "", meta.report_date || "", "v20.9"].join("|"),
      report: report,
      billingMonth: billingMonth,
      monthStart: billingMonth + "-01",
      masterMonth: masterMonth,
      compareOk: masterMonth === prevMonth(billingMonth),
      lmDayLimit: masterMonth + "-" + String(day).padStart(2, "0")
    };
  }

  /* ---------- reading the master once ---------- */
  const newCell = () => ({
    billable: 0, billed: 0,
    rev: 0, lmDay: 0, lmTotal: 0,
    dayAmt: new Array(31).fill(0), dayCnt: new Array(31).fill(0),     /* this month, by day */
    lmDayAmt: new Array(31).fill(0), lmDayCnt: new Array(31).fill(0), /* master month, by day */
    paid: 0, lmPaid: 0, lmPaidDay: 0,
    unpaid: 0, unpaidAmt: 0, band: [0, 0, 0, 0], bandAmt: [0, 0, 0, 0],
    never: 0, neverAmt: 0,
    ub: [0, 0, 0, 0, 0, 0], cats: {}, remark: {}, basis: {}
  });
  const newCat = () => ({ billable: 0, paid: 0, lmPaid: 0, lmPaidDay: 0, unbilled: 0, unpaid: 0, unpaidAmt: 0 });

  let data = null;          /* { key, ctx, cells: Map, units: [[sdo,sub,feeder,village]] } */
  let busy = false;

  /* What the Progress tab needs to know about one billable consumer.
     Used for the totals AND for the consumer lists, so both always agree. */
  function facts(c, ctx) {
    const cat = category(supplyCode(c.SUPPLY_TYPE));
    const f = {
      cat: cat, grp: group(cat), meter: isSmart(c) ? "S" : "N", mr: dlVal(c.MR_SOURCE_CD),
      u: [dlVal(c.SDO_CODE), dlVal(c.SUBSTATION), dlVal(c.FEEDER), dlVal(c.feeded_village_name)]
    };
    /* revenue */
    f.pay = parseMasterDate(c.LAST_PAY_DATE);
    f.payAmt = num(c.LAST_PAY_AMOUNT);
    f.payInMonth = !!f.pay && f.pay >= ctx.monthStart && f.pay <= ctx.report;
    const tmRaw = String(c.THIS_MONTH_TOTAL_PAY_AMT == null ? "" : c.THIS_MONTH_TOTAL_PAY_AMT).trim();
    f.thisMonth = tmRaw !== "" ? num(tmRaw) : 0;
    if (!f.thisMonth && f.payInMonth) f.thisMonth = f.payAmt;
    f.payDay = f.payInMonth ? Number(f.pay.slice(8, 10)) - 1 : -1;
    const mpay = parseMasterDate(c.MASTER_LAST_PAY_DATE);
    f.lmIn = !!mpay && mpay.slice(0, 7) === ctx.masterMonth;
    f.lmInDay = f.lmIn && mpay <= ctx.lmDayLimit;
    f.lmDayIdx = f.lmIn ? Number(mpay.slice(8, 10)) - 1 : -1;
    f.mAmt = num(c.MASTER_LAST_PAY_AMOUNT);
    f.lmTotal = num(c.MASTER_TOTAL_PAY_AMT);
    /* turn up */
    f.paid = f.thisMonth > 0 || f.payInMonth;
    f.lmPaid = f.lmTotal > 0 || f.lmIn;
    /* billing */
    const load = num(c.LOAD);
    const bill = parseMasterDate(c.LAST_BILL_DATE);
    f.billed = !!bill && bill.slice(0, 7) === ctx.billingMonth;
    if (f.billed) {
      f.remark = String(c.METER_READ_REMARK || "").trim().toUpperCase() || "(blank)";
      f.basis = String(c.BILL_BASIS || "").trim().toUpperCase() || "(blank)";
    }
    f.ubBand = f.billed ? -1 : unbilledBand(load);
    /* unpaid, never paid */
    f.out = num(c.TOTAL_OUTSTANDING);
    f.unpaid = f.out > 0 && !(f.pay && f.pay >= ctx.monthStart);
    f.band = f.unpaid ? unpaidBand(load) : -1;
    f.never = !f.pay || f.pay < "2010-01-01";
    return f;
  }

  async function compute(ctx) {
    const cells = new Map();
    const units = new Map();

    await forEachMasterBatch(batch => {
      for (const c of batch) {
        if (!isBillable(c.CONNECTION_STATUS)) continue;          /* billable consumers only */
        const f = facts(c, ctx);
        const uKey = f.u.join("\u0001");
        if (!units.has(uKey)) units.set(uKey, f.u);
        const key = uKey + "\u0001" + f.grp + "\u0001" + f.meter + "\u0001" + f.mr;
        let m = cells.get(key);
        if (!m) { m = newCell(); cells.set(key, m); }
        const ce = m.cats[f.cat] || (m.cats[f.cat] = newCat());
        m.billable++; ce.billable++;

        m.rev += f.thisMonth;
        if (f.payDay >= 0) { m.dayAmt[f.payDay] += f.payAmt; m.dayCnt[f.payDay]++; }
        if (f.lmDayIdx >= 0) { m.lmDayAmt[f.lmDayIdx] += f.mAmt; m.lmDayCnt[f.lmDayIdx]++; }
        if (f.lmInDay) m.lmDay += f.mAmt;
        m.lmTotal += f.lmTotal;

        if (f.paid) { m.paid++; ce.paid++; }
        if (f.lmPaid) { m.lmPaid++; ce.lmPaid++; }
        if (f.lmInDay) { m.lmPaidDay++; ce.lmPaidDay++; }

        if (f.billed) {
          m.billed++;
          m.remark[f.remark] = (m.remark[f.remark] || 0) + 1;
          m.basis[f.basis] = (m.basis[f.basis] || 0) + 1;
        } else {
          ce.unbilled++;
          m.ub[f.ubBand]++;
        }

        if (f.unpaid) {
          m.unpaid++; m.unpaidAmt += f.out;
          ce.unpaid++; ce.unpaidAmt += f.out;
          if (f.band >= 0) { m.band[f.band]++; m.bandAmt[f.band] += f.out; }
        }
        if (f.never) { m.never++; m.neverAmt += Math.max(f.out, 0); }
      }
    });

    return { key: ctx.key, ctx: ctx, cells: cells, units: Array.from(units.values()) };
  }

  function add(t, m) {
    Object.keys(m).forEach(k => {
      const v = m[k];
      if (typeof v === "number") t[k] = (t[k] || 0) + v;
      else if (Array.isArray(v)) v.forEach((x, i) => { t[k][i] += x; });
      else if (k === "cats") Object.keys(v).forEach(cat => {
        const a = t.cats[cat] || (t.cats[cat] = newCat());
        Object.keys(v[cat]).forEach(f => { a[f] += v[cat][f]; });
      });
      else Object.keys(v).forEach(x => { t[k][x] = (t[k][x] || 0) + v[x]; });
    });
  }

  /* ---------- filters and switches (saved per user) ---------- */
  /* sdo / sub / feeder / village: null = all, or a list of the ticked values */
  const DEFAULTS = { sdo: null, sub: null, feeder: null, village: null, group: "ALL", meter: "ALL",
    level: "sub", compare: "OFF", fromDate: "", driveFrom: "", driveTo: "" };
  const FILTERS = [["sdo", "SDO (उपखंड)"], ["sub", "Substation (उपकेंद्र)"],
    ["feeder", "Feeder (फीडर)"], ["village", "Village (गाँव)"]];
  let sel = Object.assign({}, DEFAULTS);

  const saveKey = () => "fieldworkProgress:" + String(state.userId || "").trim().toLowerCase();
  function loadSel() {
    try { sel = Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(saveKey()) || "{}")); }
    catch (e) { sel = Object.assign({}, DEFAULTS); }
    FILTERS.forEach(([k]) => {                       /* older saved choice was a single value */
      if (typeof sel[k] === "string") sel[k] = sel[k] ? [sel[k]] : null;
      if (sel[k] !== null && !Array.isArray(sel[k])) sel[k] = null;
    });
  }
  function saveSel() { try { localStorage.setItem(saveKey(), JSON.stringify(sel)); } catch (e) {} }

  const picked = (k, v) => !sel[k] || sel[k].indexOf(v) !== -1;
  const unitMatches = u => picked("sdo", u[0]) && picked("sub", u[1]) && picked("feeder", u[2]) && picked("village", u[3]);
  const label = v => v === DL_BLANK ? "(blank)" : v;

  /* ---------- SDO / Substation / Feeder / Village: tick lists, each narrows the next ---------- */
  const openFilters = new Set();
  const filterSearch = {};

  function filterOptions() {
    /* options of each list = values under the ticks of the lists above it */
    const out = {};
    let rows = data.units;
    FILTERS.forEach(([k], i) => {
      out[k] = dlSortValues(Array.from(new Set(rows.map(u => u[i]))));
      if (sel[k]) {
        sel[k] = sel[k].filter(v => out[k].indexOf(v) !== -1);
        if (sel[k].length === out[k].length) sel[k] = null;
      }
      rows = rows.filter(u => picked(k, u[i]));
    });
    return out;
  }

  function filterSummary(k, options) {
    if (!sel[k]) return '<span class="dl-summary">All</span>';
    if (!sel[k].length) return '<span class="dl-summary dl-summary-warn">None</span>';
    if (sel[k].length === 1) return '<span class="dl-summary">' + escapeHtml(label(sel[k][0])) + "</span>";
    return '<span class="dl-summary">' + sel[k].length + " of " + options.length + "</span>";
  }

  function refreshDropdowns() {
    const box = $("pgFilters");
    if (!box) return;
    const opts = filterOptions();
    box.innerHTML = FILTERS.map(([k, title]) => {
      const options = opts[k];
      const search = filterSearch[k] || "";
      const items = options.map(v =>
        '<label class="dl-check" data-text="' + escapeHtml(label(v).toLowerCase()) + '"' +
        (search && label(v).toLowerCase().indexOf(search) === -1 ? ' style="display:none"' : "") + ">" +
        "<span>" + escapeHtml(label(v)) + "</span>" +
        '<input type="checkbox" data-pg-f="' + k + '" value="' + escapeHtml(v) + '"' + (picked(k, v) ? " checked" : "") + ">" +
        '<span class="dl-switch"></span></label>').join("");
      return '<div class="dl-filter">' +
        '<button type="button" class="dl-filter-head" data-pg-toggle="' + k + '">' + title + filterSummary(k, options) + "</button>" +
        '<div class="dl-checklist' + (openFilters.has(k) ? "" : " hidden") + '">' +
        (options.length > 12 ? '<input class="dl-search" type="search" data-pg-search="' + k + '" placeholder="Search…" value="' + escapeHtml(search) + '">' : "") +
        '<label class="dl-check all"><span>All (' + options.length + ")</span>" +
        '<input type="checkbox" data-pg-all="' + k + '"' + (!sel[k] ? " checked" : "") + '><span class="dl-switch"></span></label>' +
        items + "</div></div>";
    }).join("");
  }

  function onFilterChange(e) {
    const t = e.target;
    const k = t.dataset.pgAll || t.dataset.pgF;
    if (!k) return;
    if (t.dataset.pgAll) {
      sel[k] = t.checked ? null : [];
    } else {
      const ticked = Array.from($("pgFilters").querySelectorAll('input[data-pg-f="' + k + '"]'))
        .filter(x => x.checked).map(x => x.value);
      const all = $("pgFilters").querySelectorAll('input[data-pg-f="' + k + '"]').length;
      sel[k] = ticked.length === all ? null : ticked;
    }
    /* lists below start again from All */
    const idx = FILTERS.findIndex(f => f[0] === k);
    FILTERS.slice(idx + 1).forEach(([kk]) => { sel[kk] = null; });
    saveSel();
    refreshDropdowns();
    render();
  }

  function setSwitches() {
    [["pgGroup", "group"], ["pgMeter", "meter"], ["pgLevel", "level"], ["pgCompare", "compare"]].forEach(([id, key]) => {
      const box = $(id);
      if (box) box.querySelectorAll("button[data-v]").forEach(b => b.classList.toggle("on", b.dataset.v === sel[key]));
    });
  }

  /* From date for the day-wise table: inside this billing month, up to the data date. */
  function setupFromDate(ctx) {
    const box = $("pgFromDate");
    if (!box) return;
    box.min = ctx.monthStart;
    box.max = ctx.report;
    let v = sel.fromDate;
    if (!v || v < ctx.monthStart || v > ctx.report) {
      v = addDays(ctx.report, -6);
      if (v < ctx.monthStart) v = ctx.monthStart;
    }
    sel.fromDate = v;
    box.value = v;
  }

  /* ---------- adding up for the screen ---------- */
  function collect() {
    const levelIdx = LEVELS.indexOf(sel.level);
    const total = newCell();
    const byUnit = new Map();
    const byMeter = { S: newCell(), N: newCell() };
    const byMr = new Map();                          /* v20.9: Billing by MR Source */

    data.cells.forEach((m, key) => {
      const parts = key.split("\u0001");
      const u = parts.slice(0, 4);
      if (!unitMatches(u)) return;
      if (!groupOk(parts[4])) return;
      add(byMeter[parts[5]], m);                     /* smart / non-smart table ignores the meter switch */
      if (sel.meter !== "ALL" && parts[5] !== sel.meter) return;
      add(total, m);
      const mr = parts[6];
      if (!byMr.has(mr)) byMr.set(mr, newCell());
      add(byMr.get(mr), m);
      const name = u[levelIdx];
      if (!byUnit.has(name)) byUnit.set(name, newCell());
      add(byUnit.get(name), m);
    });

    const units = dlSortValues(Array.from(byUnit.keys())).map(n => [label(n), byUnit.get(n), n]);
    const mrs = dlSortValues(Array.from(byMr.keys())).map(n => [label(n), byMr.get(n), n]);
    return { total: total, units: units, byMeter: byMeter, mrs: mrs };
  }

  /* ---------- formatting ---------- */
  const N = n => Math.round(n || 0).toLocaleString("en-IN");
  /* A count you can tap to see the consumers. q = what to list (see listMatch). */
  let links = [];
  const L = (n, q) => n ? '<a class="pg-link" href="#" data-pg-q="' + (links.push(q) - 1) + '">' + N(n) + "</a>" : "0";
  const RS = n => "₹" + Math.round(n || 0).toLocaleString("en-IN");
  const PCT = (a, b) => b ? (100 * a / b).toFixed(1) + "%" : "—";
  function change(now, before) {
    if (!before) return "—";
    const p = 100 * (now - before) / before;
    return '<span class="' + (p >= 0 ? "pg-up" : "pg-down") + '">' + (p >= 0 ? "+" : "") + p.toFixed(1) + "%</span>";
  }
  function table(head, rows, totalRow) {
    const th = "<tr>" + head.map(h => "<th>" + h + "</th>").join("") + "</tr>";
    const tr = r => "<tr" + (r === totalRow ? ' class="total"' : "") + ">" + r.map(c => "<td>" + c + "</td>").join("") + "</tr>";
    const body = (totalRow ? [totalRow] : []).concat(rows).map(tr).join("");
    return '<div class="pg-swipe hidden">Swipe the table sideways for more columns ⟷</div>' +
      '<div class="pg-scroll"><table class="pg-table"><thead>' + th + "</thead><tbody>" + body + "</tbody></table></div>";
  }

  /* After drawing: show the swipe hint only on tables wider than the screen. */
  function markWideTables() {
    document.querySelectorAll("#progressCard .pg-scroll").forEach(el => {
      const hint = el.previousElementSibling;
      if (hint && hint.classList.contains("pg-swipe")) hint.classList.toggle("hidden", el.scrollWidth <= el.clientWidth + 2);
    });
  }
  /* fn(cell, unitQuery): unitQuery limits a list to that row's unit ({} for Total) */
  const unitRows = (col, fn) => ({
    total: ["Total"].concat(fn(col.total, {})),
    rows: col.units.map(([name, m, raw]) => [escapeHtml(name)].concat(fn(m, { lvl: LEVELS.indexOf(sel.level), unit: raw })))
  });
  const note = text => '<div class="pg-note">' + text + "</div>";

  /* ---------- sections ---------- */
  function revenueHtml(col, ctx) {
    const cmp = sel.compare === "ON" && ctx.compareOk;
    const lmRange = shortDate(ctx.masterMonth + "-01") + "–" + shortDate(ctx.lmDayLimit);
    const head = [LEVEL_LABEL[sel.level], "Consumers", "Paid", "This month (" + shortDate(ctx.monthStart) + "–" + shortDate(ctx.report) + ")"];
    if (cmp) head.push("Last month till same day (" + lmRange + ")", "Change", monthName(ctx.masterMonth) + " total");
    /* units: most consumers first */
    const sorted = { total: col.total, units: col.units.slice().sort((a, b) => b[1].billable - a[1].billable) };
    const t = unitRows(sorted, (m, uq) => [L(m.billable, Object.assign({ m: "billable" }, uq)), L(m.paid, Object.assign({ m: "paid" }, uq)), RS(m.rev)].concat(
      cmp ? [RS(m.lmDay), change(m.rev, m.lmDay), RS(m.lmTotal)] : []));
    let html = (sel.compare === "ON" && !ctx.compareOk)
      ? note("Last month's master is not received yet, so there is no comparison.") : "";
    html += table(head, t.rows, t.total);

    /* day-wise from the chosen date */
    const from = sel.fromDate;
    const days = [];
    for (let d = ctx.report; d >= from; d = addDays(d, -1)) days.push(d);
    const dHead = ["Date", "Consumers paid", "Amount"];
    if (cmp) dHead.push(monthName(ctx.masterMonth) + ", same date");
    let sumCnt = 0, sumAmt = 0, sumLm = 0;
    const dRows = days.map(d => {
      const i = Number(d.slice(8, 10)) - 1;
      const cnt = col.total.dayCnt[i], amt = col.total.dayAmt[i];
      sumCnt += cnt; sumAmt += amt;
      const r = [formatListDate(d), L(cnt, { m: "day", day: i }), RS(amt)];
      if (cmp) {
        const lmDay = ctx.masterMonth + "-" + d.slice(8, 10);
        const ok = Number(d.slice(8, 10)) <= daysIn(ctx.masterMonth);
        const lmAmt = ok ? col.total.lmDayAmt[i] : 0;
        sumLm += lmAmt;
        r.push(ok ? RS(lmAmt) + " (" + shortDate(lmDay) + ")" : "—");
      }
      return r;
    });
    const dTotal = ["Total", L(sumCnt, { m: "days", from: from }), RS(sumAmt)];
    if (cmp) dTotal.push(RS(sumLm));
    html += note("Day-wise (last payment date of each consumer):") + table(dHead, dRows, dTotal);
    return html;
  }

  function turnUpHtml(col, ctx) {
    const cmp = sel.compare === "ON" && ctx.compareOk;
    const head = ["Category", "Billable", "Paid", "Turn up"];
    if (cmp) head.push("Last month till same day (" + shortDate(ctx.masterMonth + "-01") + "–" + shortDate(ctx.lmDayLimit) + ")",
      monthName(ctx.masterMonth) + " total");
    const row = (name, c, q) => {
      const r = [name, L(c.billable, Object.assign({ m: "billable" }, q)), L(c.paid, Object.assign({ m: "paid" }, q)), PCT(c.paid, c.billable)];
      if (cmp) r.push(PCT(c.lmPaidDay, c.billable), PCT(c.lmPaid, c.billable));
      return r;
    };
    const cats = CAT_ORDER.filter(k => col.total.cats[k] && col.total.cats[k].billable)
      .map(k => row(catLabel(k), col.total.cats[k], { cat: k }));
    const meters = [["Smart meter", col.byMeter.S, "S"], ["Non-smart", col.byMeter.N, "N"]].map(([n, m, k]) => row(n, m, { meterOnly: k }));
    return table(head, cats, row("Total", col.total, {})) +
      note("Smart / non-smart (MR source SM):") + table(head, meters, null);
  }

  function billingHtml(col) {
    const t = unitRows(col, (m, uq) => [L(m.billable, Object.assign({ m: "billable" }, uq)), L(m.billed, Object.assign({ m: "billed" }, uq)),
      PCT(m.billed, m.billable), L(m.billable - m.billed, Object.assign({ m: "unbilled" }, uq))]);
    const cats = CAT_ORDER.filter(k => col.total.cats[k] && col.total.cats[k].unbilled)
      .map(k => [catLabel(k), L(col.total.cats[k].unbilled, { m: "unbilled", cat: k }), PCT(col.total.cats[k].unbilled, col.total.cats[k].billable)]);
    const bands = UNBILLED_BANDS.map((b, i) => [b + " kW/kVA/BHP", L(col.total.ub[i], { m: "ubBand", band: i })]);
    /* v20.9: smart / non-smart (the meter switch is not applied here) and MR Source */
    const bill = (m, q) => [L(m.billable, Object.assign({ m: "billable" }, q)), L(m.billed, Object.assign({ m: "billed" }, q)),
      PCT(m.billed, m.billable), L(m.billable - m.billed, Object.assign({ m: "unbilled" }, q))];
    const meters = [["Smart meter", col.byMeter.S, "S"], ["Non-smart meter", col.byMeter.N, "N"]]
      .map(([n, m, k]) => [n].concat(bill(m, { meterOnly: k })));
    const mrRows = col.mrs.map(([n, m, raw]) => [escapeHtml(n)].concat(bill(m, { mr: raw })));
    return table([LEVEL_LABEL[sel.level], "Billable", "Billed", "Billing %", "Unbilled"], t.rows, t.total) +
      note("Smart meter and non-smart meter billing:") +
      table(["Meter", "Billable", "Billed", "Billing %", "Unbilled"], meters, null) +
      note("Billing by MR Source:") +
      table(["MR Source", "Billable", "Billed", "Billing %", "Unbilled"], mrRows, null) +
      note("Unbilled by category:") + table(["Category", "Unbilled", "Of billable"], cats, null) +
      note("Unbilled by load:") + table(["Load", "Unbilled"], bands, null);
  }

  function countHtml(counts, billed, field) {
    const keys = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
    return table(["Code", "Consumers", "Of billed"],
      keys.map(k => [escapeHtml(k), L(counts[k], { m: field, code: k }), PCT(counts[k], billed)]),
      ["Total billed", L(billed, { m: "billed" }), billed ? "100%" : "—"]);
  }

  function unpaidHtml(col) {
    const t = unitRows(col, (m, uq) => [L(m.unpaid, Object.assign({ m: "unpaid" }, uq)), RS(m.unpaidAmt),
      L(m.never, Object.assign({ m: "never" }, uq)), RS(m.neverAmt)]);
    const bands = UNPAID_BANDS.map((b, i) => [b + " kW/kVA/BHP", L(col.total.band[i], { m: "uBand", band: i }), RS(col.total.bandAmt[i])]);
    const cats = CAT_ORDER.filter(k => col.total.cats[k] && col.total.cats[k].unpaid)
      .map(k => [catLabel(k), L(col.total.cats[k].unpaid, { m: "unpaid", cat: k }), RS(col.total.cats[k].unpaidAmt)]);
    return table([LEVEL_LABEL[sel.level], "Unpaid", "Outstanding", "Never paid", "Never paid outst."], t.rows, t.total) +
      note("Unpaid by load:") + table(["Load", "Unpaid", "Outstanding"], bands, null) +
      note("Unpaid by category:") + table(["Category", "Unpaid", "Outstanding"], cats, null);
  }

  /* ---------- disconnection drive (server, kept for offline) ---------- */
  const driveKey = () => "fieldworkProgressDrive3:" + String(state.userId || "").trim().toLowerCase();
  const DRIVE_KEEP_DAYS = 400;      /* visits older than this are not kept on the phone */
  let drive = null;         /* { at, rows:[...], missing, notBillable } */
  let now = null;           /* { key, byAcct: {acct: {pay, amt, out}} } current payments of visited consumers */

  function loadDrive() {
    try { drive = JSON.parse(localStorage.getItem(driveKey()) || "null"); } catch (e) { drive = null; }
  }

  async function refreshDrive() {
    if (!navigator.onLine) { setStatus("pgStatusMsg", "No internet. Showing the last copy.", "error"); return; }
    setStatus("pgStatusMsg", "Loading the disconnection drive…");
    if ($("pgDriveRefreshBtn")) $("pgDriveRefreshBtn").disabled = true;
    try {
      const res = await serverPost("disconnection_list", {});
      if (!res || !res.success) throw new Error((res && res.message) || "Server error");
      const oldest = addDays(todayYmd(), -DRIVE_KEEP_DAYS);
      const rows = [];
      let missing = 0, notBillable = 0;
      for (const d of res.disconnections || []) {
        if (!d.date || String(d.date) < oldest) continue;
        const c = await getMasterByAccountInput(d.account_id);
        if (!c) { missing++; continue; }
        if (!isBillable(c.CONNECTION_STATUS)) { notBillable++; continue; }
        const cat = category(supplyCode(c.SUPPLY_TYPE));
        rows.push({
          acct: String(c.ACCT_ID || ""),
          status: String(d.status || "").toUpperCase(),
          date: String(d.date || ""),
          userId: String(d.user_id || ""),
          user: String(d.user_name || d.user_id || ""),
          u: [dlVal(c.SDO_CODE), dlVal(c.SUBSTATION), dlVal(c.FEEDER), dlVal(c.feeded_village_name)],
          grp: group(cat),
          meter: isSmart(c) ? "S" : "N",
          name: String(c.NAME || ""), father: String(c.FATHER_NAME || ""), address: String(c.ADDRESS || ""),
          mobile: String(c.MOBILE_NUMBER || ""), supply: String(c.SUPPLY_TYPE || ""), load: String(c.LOAD || "")
        });
      }
      drive = { at: new Date().toISOString(), rows: rows, missing: missing, notBillable: notBillable };
      try { localStorage.setItem(driveKey(), JSON.stringify(drive)); } catch (e) {}
      now = null;
      setStatus("pgStatusMsg", "");
    } catch (e) {
      console.error(e);
      setStatus("pgStatusMsg", "Could not load the drive summary: " + (e.message || e), "error");
    } finally {
      if ($("pgDriveRefreshBtn")) $("pgDriveRefreshBtn").disabled = false;
    }
    render();
  }

  /* Payments now (master + daily updates) of the visited consumers; read once per data version. */
  async function currentPayments() {
    const key = (data ? data.key : "") + "|" + (drive ? drive.at : "");
    if (now && now.key === key) return now.byAcct;
    const byAcct = {};
    for (const r of (drive && drive.rows) || []) {
      const c = await getMasterByAccountInput(r.acct);
      byAcct[r.acct] = c
        ? { pay: parseMasterDate(c.LAST_PAY_DATE), amt: String(c.LAST_PAY_AMOUNT || ""), out: num(c.TOTAL_OUTSTANDING) }
        : { pay: "", amt: "", out: 0 };
    }
    now = { key: key, byAcct: byAcct };
    return byAcct;
  }

  const isTimeGiven = s => s.indexOf("TIME GIVEN") === 0;
  function driveKind(r, kind, pays) {
    const paid = paidSince(r, pays);
    switch (kind) {
      case "visited": return true;
      case "disc": return r.status === "DISCONNECTED";
      case "discPaid": return r.status === "DISCONNECTED" && paid;
      case "tg": return isTimeGiven(r.status);
      case "tgPaid": return isTimeGiven(r.status) && paid;
      case "tgNotPaid": return isTimeGiven(r.status) && !paid;
      case "pv": return r.status === "PAID";
      case "pvPaid": return r.status === "PAID" && paid;
      case "pvNotPaid": return r.status === "PAID" && !paid;
    }
    return false;
  }
  const paidSince = (r, pays) => { const p = (pays[r.acct] || {}).pay; return !!p && p >= r.date; };

  /* Visit dates From / To (default: this month up to today). */
  function setupDriveDates() {
    const today = todayYmd();
    if (!sel.driveFrom) sel.driveFrom = today.slice(0, 7) + "-01";
    if (!sel.driveTo) sel.driveTo = today;
    if (sel.driveFrom > sel.driveTo) sel.driveTo = sel.driveFrom;
    if ($("pgDriveFrom")) { $("pgDriveFrom").value = sel.driveFrom; $("pgDriveFrom").max = today; }
    if ($("pgDriveTo")) { $("pgDriveTo").value = sel.driveTo; $("pgDriveTo").max = today; }
  }
  const visitRange = () => formatListDate(sel.driveFrom) + " to " + formatListDate(sel.driveTo);

  function driveRows() {
    return ((drive && drive.rows) || []).filter(r =>
      r.date >= sel.driveFrom && r.date <= sel.driveTo &&
      unitMatches(r.u) && groupOk(r.grp) && (sel.meter === "ALL" || r.meter === sel.meter));
  }

  function driveHtml(pays) {
    if (!drive) return note("Tap REFRESH (needs internet) to load the disconnection drive.");
    const levelIdx = LEVELS.indexOf(sel.level);
    /* each cell: count + amount (outstanding for visit results, amount received for payments) */
    const blank = () => ({ visited: 0, visitedOut: 0, disc: 0, discOut: 0, discPaid: 0, discAmt: 0,
      tg: 0, tgOut: 0, tgPaid: 0, tgAmt: 0, pv: 0, pvOut: 0, pvPaid: 0, pvAmt: 0 });
    const total = blank();
    const byUnit = new Map();
    driveRows().forEach(r => {
      const paid = paidSince(r, pays);
      const p = pays[r.acct] || {};
      const out = Number(p.out) || 0, amt = paid ? num(p.amt) : 0;
      const addTo = t => {
        t.visited++; t.visitedOut += out;
        if (r.status === "DISCONNECTED") { t.disc++; t.discOut += out; if (paid) { t.discPaid++; t.discAmt += amt; } }
        else if (isTimeGiven(r.status)) { t.tg++; t.tgOut += out; if (paid) { t.tgPaid++; t.tgAmt += amt; } }
        else if (r.status === "PAID") { t.pv++; t.pvOut += out; if (paid) { t.pvPaid++; t.pvAmt += amt; } }
      };
      addTo(total);
      const name = r.u[levelIdx];
      if (!byUnit.has(name)) byUnit.set(name, blank());
      addTo(byUnit.get(name));
    });
    const ca = (c, a, q) => c ? L(c, q) + ' <span class="pg-amt">(' + RS(a) + ")</span>" : "0";
    const fn = (t, unit) => {
      const q = d => unit === undefined ? { drive: d } : { drive: d, lvl: levelIdx, unit: unit };
      return [L(t.visited, q("visited")), ca(t.disc, t.discOut, q("disc")), ca(t.discPaid, t.discAmt, q("discPaid")),
        ca(t.tg, t.tgOut, q("tg")), ca(t.tgPaid, t.tgAmt, q("tgPaid")), ca(t.pv, t.pvOut, q("pv")), ca(t.pvPaid, t.pvAmt, q("pvPaid"))];
    };
    const head = [LEVEL_LABEL[sel.level], "Visited", "Disconnected (outstanding)", "Disconnected → paid (amount received)",
      "Time given (outstanding)", "Time given → paid (amount received)", "Paid at visit (outstanding)",
      "Paid at visit → actually paid (amount received)"];
    const rows = dlSortValues(Array.from(byUnit.keys())).map(n => [escapeHtml(label(n))].concat(fn(byUnit.get(n), n)));
    let html = note("Visits " + visitRange() + " (latest visit per consumer); billable consumers only. Paid = payment dated on or after the visit; amount received = that payment. Outstanding as per master data. Summary last updated: " +
      new Date(drive.at).toLocaleString("en-IN", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }));
    if (drive.missing) html += note(N(drive.missing) + " visited consumers are not in this master and are not counted.");
    if (drive.notBillable) html += note(N(drive.notBillable) + " visited consumers are not billable (PD etc.) and are not counted.");
    return html + table(head, rows, ["Total"].concat(fn(total, undefined)));
  }

  /* ---------- drive lists (PDF): default sort substation, user ID, form entry date ---------- */
  const filterText = () => {
    const list2 = k => sel[k].map(label).join(", ");
    return [sel.sdo && "SDO: " + list2("sdo"), sel.sub && "Substation: " + list2("sub"),
      sel.feeder && "Feeder: " + list2("feeder"), sel.village && "Village: " + list2("village"),
      sel.group !== "ALL" && GROUP_LABEL[sel.group], sel.meter !== "ALL" && (sel.meter === "S" ? "Smart meters" : "Non-smart meters")]
      .filter(Boolean).join("  |  ") || "All";
  };
  const pdfReady = () => !!(window.jspdf && window.jspdf.jsPDF && window.jspdf.jsPDF.API.autoTable);
  const sortDrive = list => list.sort((a, b) => a.u[1].localeCompare(b.u[1]) ||
    a.userId.localeCompare(b.userId, undefined, { numeric: true }) || a.date.localeCompare(b.date));

  /* format: "pdf" | "xlsx" */
  async function drivePdf(kind, format) {
    if (!drive) return setStatus("pgStatusMsg", "Tap REFRESH first to load the disconnection drive.", "error");
    if (format === "xlsx" ? !xlsxReady() : !pdfReady()) {
      return setStatus("pgStatusMsg", (format === "xlsx" ? "Excel" : "PDF") + " library is not loaded. Please reload the app.", "error");
    }
    const pays = await currentPayments();
    const list = sortDrive(driveRows().filter(r => driveKind(r, kind === "TG" ? "tgNotPaid" : "pvNotPaid", pays)));
    if (!list.length) return setStatus("pgStatusMsg", "No consumers in this list for these filters.", "ok");
    const title = kind === "TG" ? "Time Given but Not Yet Paid" : "Paid at Visit but Not Actually Paid";
    const base = (kind === "TG" ? "Time_Given_But_Not_Yet_Paid_" : "Paid_At_Visit_But_Not_Actually_Paid_") + dlFileStamp();
    const filters = filterText() + "  |  Visits " + visitRange();
    let name;
    if (format === "xlsx") {
      const groups = splitGroups(list, r => r.u);
      if (groups.length > 25 && !confirm(groups.length + " separate Excel files will be made. Continue?")) return;
      const files = await saveXlsxSet(groups, (l, t) => saveXlsx(t, filters, DRIVE_XLS_HEAD, l.map((r, i) => driveXlsRow(r, i, pays)), ""),
        base, title, "pgStatusMsg");
      return setStatus("pgStatusMsg", xlsDoneText(files, list.length), "ok");
    } else {
      const groups = splitGroups(list, r => r.u);
      if (groups.length > 25 && !confirm(groups.length + " separate PDFs will be made. Continue?")) return;
      const files = await savePdfSet(groups, (l, t) => makeDrivePdf(l, pays, t, filterText()), base, title, "pg", "pgStatusMsg");
      return setStatus("pgStatusMsg", pdfDoneText(files, list.length), "ok");
    }
    setStatus("pgStatusMsg", "Downloaded: " + name + " (" + list.length.toLocaleString("en-IN") + " consumers).", "ok");
  }

  /* ---------- Excel (same lists, numbers stay numbers) ---------- */
  const xlsxReady = () => !!(window.XLSX && XLSX.utils && XLSX.writeFile);
  const numOrBlank = v => { const t = String(v == null ? "" : v).replace(/,/g, "").trim(); return t !== "" && isFinite(Number(t)) ? Number(t) : t; };

  const DRIVE_XLS_HEAD = ["S.No", "Account", "Name", "Father/Husband", "Address", "Village", "Substation", "Feeder", "Mobile",
    "Supply", "Load", "Visit Date", "Status", "User ID", "User", "Outstanding (Rs.)", "Last Pay Date", "Last Pay Amount (Rs.)"];
  function driveXlsRow(r, i, pays) {
    const p = pays[r.acct] || {};
    return [i + 1, r.acct, r.name, r.father, r.address, label(r.u[3]), label(r.u[1]), label(r.u[2]), r.mobile,
      r.supply, numOrBlank(r.load), formatListDate(r.date), r.status, r.userId, r.user, Math.round(p.out || 0),
      formatListDate(p.pay || ""), numOrBlank(p.amt)];
  }

  const MASTER_XLS_HEAD = ["S.No", "Account", "Name", "Father/Husband", "Address", "Village", "Substation", "Feeder", "SDO",
    "Mobile", "Supply", "Category", "Load", "Connection Status", "Meter No", "MR Source", "Outstanding (Rs.)",
    "Last Pay Date", "Last Pay Amount (Rs.)", "This Month Paid (Rs.)", "Last Bill Date", "Bill Basis", "Meter Read Remark",
    "Consumption Current", "Consumption Previous", "Consumption Before Previous"];
  function masterXlsRow(x, i) {
    const c = x.c, f = x.f;
    return [i + 1, c.ACCT_ID, c.NAME || "", c.FATHER_NAME || "", c.ADDRESS || "", label(f.u[3]), label(f.u[1]), label(f.u[2]),
      label(f.u[0]), c.MOBILE_NUMBER || "", c.SUPPLY_TYPE || "", catLabel(f.cat), numOrBlank(c.LOAD), c.CONNECTION_STATUS || "",
      c.METER_NO || "", c.MR_SOURCE_CD || "", Math.round(f.out), formatListDate(f.pay || ""), f.pay ? Math.round(f.payAmt) : "",
      Math.round(f.thisMonth), formatListDate(parseMasterDate(c.LAST_BILL_DATE) || ""), c.BILL_BASIS || "",
      c.METER_READ_REMARK || "", numOrBlank(c.CONSUMPTION_CURR_MNTH), numOrBlank(c.CONSUMPTION_PREV_MNTH),
      numOrBlank(c.CONSUMPTION_PREV_TO_PREV_MNTH)];
  }

  function saveXlsx(title, filters, head, rows, fileName) {
    if (!fileName) fileName = saveXlsx.nextName;                  /* v20.8: set by saveXlsxSet */
    const aoa = [[title], ["Data up to " + formatListDate(data.ctx.report) + "   |   Filters: " + filters +
      "   |   Consumers: " + rows.length], [], head].concat(rows);
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    /* account and mobile as text, so Excel keeps leading zeros and long numbers */
    for (let r = 4; r < aoa.length; r++) {
      [1, head.indexOf("Mobile")].forEach(cIdx => {
        const ref = XLSX.utils.encode_cell({ r: r, c: cIdx });
        if (ws[ref]) { ws[ref].t = "s"; ws[ref].v = String(ws[ref].v); }
      });
    }
    ws["!cols"] = head.map(h => ({ wch: /Name|Father|Address/.test(h) ? 26 : h === "S.No" ? 6 : Math.max(10, h.length + 2) }));
    ws["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 3, c: 0 }, e: { r: Math.max(3, aoa.length - 1), c: head.length - 1 } }) };
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "List");
    XLSX.writeFile(wb, fileName, { compression: true });
  }

  function makeDrivePdf(list, pays, title, filters) {

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4", compress: true });
    doc.setFontSize(12);
    doc.text(title, 10, 12);
    doc.setFontSize(8);
    doc.text("Visits " + visitRange() + " (latest visit per consumer). Payments up to " + formatListDate(data.ctx.report) +
      ". Sorted by substation, user ID, visit date.", 10, 17);
    doc.text("Filters: " + filters + "   |   Consumers: " + list.length.toLocaleString("en-IN"), 10, 21);

    const body = list.map((r, i) => {
      const p = pays[r.acct] || {};
      return [i + 1, r.acct, r.name, r.father, r.address, label(r.u[3]), label(r.u[1]), label(r.u[2]), r.mobile,
        r.supply, r.load, formatListDate(r.date), r.status, r.user, Math.round(p.out || 0).toLocaleString("en-IN"),
        formatListDate(p.pay || ""), p.amt || "", ""];
    });

    doc.autoTable({
      startY: 24,
      margin: { left: 10, right: 10 },
      head: [["S.No", "Account", "Name", "Father/Husband", "Address", "Village", "Substation", "Feeder", "Mobile",
        "Supply", "Load", "Visit Date", "Status", "User", "Outstanding (Rs.)", "Last Pay Date", "Last Pay Amt", "Remarks"]],
      body: body,
      theme: "grid",
      styles: { fontSize: 6.3, cellPadding: 1, overflow: "linebreak", valign: "middle", lineColor: [120, 120, 120], lineWidth: 0.1, textColor: [0, 0, 0] },
      headStyles: { fillColor: [13, 148, 136], textColor: 255, fontSize: 6.3 },
      columnStyles: {
        0: { cellWidth: 7, halign: "right" }, 1: { cellWidth: 17 }, 2: { cellWidth: 20 }, 3: { cellWidth: 18 },
        4: { cellWidth: 29 }, 5: { cellWidth: 15 }, 6: { cellWidth: 14 }, 7: { cellWidth: 14 }, 8: { cellWidth: 16 },
        9: { cellWidth: 9 }, 10: { cellWidth: 8 }, 11: { cellWidth: 14 }, 12: { cellWidth: 17 }, 13: { cellWidth: 16 },
        14: { cellWidth: 14, halign: "right" }, 15: { cellWidth: 14 }, 16: { cellWidth: 11, halign: "right" },
        17: { cellWidth: 14, minCellHeight: 8 }
      },
      didDrawPage: () => {
        doc.setFontSize(7);
        doc.text("Page " + doc.internal.getNumberOfPages(), doc.internal.pageSize.getWidth() - 25, doc.internal.pageSize.getHeight() - 5);
      }
    });

    return doc;
  }

  /* ---------- v20.7: one PDF, or one PDF for each SDO / Substation / Feeder / Village ---------- */
  const SPLIT_KEY = "fieldworkProgressPdfSplit";
  const SPLIT_LEVEL = { sdo: [0, "SDO"], substation: [1, "Substation"], feeder: [2, "Feeder"], village: [3, "Village"] };
  const splitOptions = () =>
    '<option value="ONE">One file(एक फ़ाइल)</option>' +
    '<option value="sdo">A file for each SDO(हर एसडीओ की अलग)</option>' +
    '<option value="substation">A file for each Substation(हर उपकेंद्र की अलग)</option>' +
    '<option value="feeder">A file for each Feeder(हर फीडर की अलग)</option>' +
    '<option value="village">A file for each Village(हर ग्राम की अलग)</option>';

  /* v20.8: Excel the same way: one file, or one file for each group */
  async function saveXlsxSet(groups, write, base, title, statusId) {
    const names = [];
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      if (groups.length > 1) setStatus(statusId, "Making Excel " + (i + 1) + " of " + groups.length + "…");
      await new Promise(r => setTimeout(r, 30));
      saveXlsx.nextName = base + (g.label ? "_" + g.label.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 50) : "") + ".xlsx";
      write(g.list, g.label ? title + " – " + g.label : title);
      names.push(saveXlsx.nextName);
      if (groups.length > 1) await new Promise(r => setTimeout(r, 700));     /* one download at a time */
    }
    return names;
  }
  const xlsDoneText = (names, n) => (names.length === 1 ? "Excel downloaded: " + names[0]
    : names.length + " Excel files downloaded (if the phone asks, allow multiple downloads)") +
    " (" + n.toLocaleString("en-IN") + " consumers).";
  const splitChoice = () => { try { return localStorage.getItem(SPLIT_KEY) || "ONE"; } catch (e) { return "ONE"; } };
  function setSplitChoice(v) {
    try { localStorage.setItem(SPLIT_KEY, v); } catch (e) {}
    document.querySelectorAll("select.pg-split").forEach(s => { s.value = v; });
  }
  function splitRow(id) {
    const row = document.createElement("div");
    row.className = "pg-split-row";
    row.innerHTML = '<label for="' + id + '">Files(फ़ाइलें)</label><select id="' + id + '" class="pg-split">' + splitOptions() + "</select>";
    row.querySelector("select").value = splitChoice();
    row.querySelector("select").addEventListener("change", e => setSplitChoice(e.target.value));
    return row;
  }

  /* [{ label, list }] in the list's own order; groups A to Z */
  function splitGroups(list, unitsOf) {
    const lv = SPLIT_LEVEL[splitChoice()];
    if (!lv) return [{ label: "", list: list }];
    const map = new Map();
    list.forEach(x => {
      const key = String(label(unitsOf(x)[lv[0]]) || "").trim() || "(blank)";
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(x);
    });
    return Array.from(map.keys()).sort((a, b) => a.localeCompare(b, "en", { numeric: true }))
      .map(k => ({ label: lv[1] + " " + k, list: map.get(k) }));
  }

  /* makes and downloads the PDF(s); all of them go in one SHARE */
  async function savePdfSet(groups, makeDoc, base, title, sharePrefix, statusId) {
    const files = [];
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      if (groups.length > 1) setStatus(statusId, "Making PDF " + (i + 1) + " of " + groups.length + "…");
      await new Promise(r => setTimeout(r, 30));
      const doc = makeDoc(g.list, g.label ? title + " – " + g.label : title);
      const name = base + (g.label ? "_" + g.label.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 50) : "") + ".pdf";
      doc.save(name);
      files.push({ blob: doc.output("blob"), name: name });
      if (groups.length > 1) await new Promise(r => setTimeout(r, 700));     /* one download at a time */
    }
    if (typeof rememberListPdf === "function") {
      rememberListPdf(sharePrefix, files.length === 1 ? files[0].blob : files, files.length === 1 ? files[0].name : "", title);
    }
    return files;
  }
  const pdfDoneText = (files, n) => (files.length === 1 ? "Downloaded: " + files[0].name
    : files.length + " PDFs downloaded (if the phone asks, allow multiple downloads)") +
    " (" + n.toLocaleString("en-IN") + " consumers).";



  /* ---------- tap a count: the list of those consumers ---------- */
  /* Same rules as the totals (facts), plus the filters on the screen and the tapped row / column. */
  function listMatch(q, f) {
    if (!unitMatches(f.u)) return false;
    if (!groupOk(f.grp)) return false;
    if (q.meterOnly) { if (f.meter !== q.meterOnly) return false; }
    else if (sel.meter !== "ALL" && f.meter !== sel.meter) return false;
    if (q.unit !== undefined && f.u[q.lvl] !== q.unit) return false;
    if (q.cat && f.cat !== q.cat) return false;
    if (q.mr !== undefined && f.mr !== q.mr) return false;
    switch (q.m) {
      case "billable": return true;
      case "paid": return f.paid;
      case "day": return f.payDay === q.day;
      case "days": return f.payInMonth && f.pay >= q.from;
      case "billed": return f.billed;
      case "unbilled": return !f.billed;
      case "ubBand": return f.ubBand === q.band;
      case "remark": return f.billed && f.remark === q.code;
      case "basis": return f.billed && f.basis === q.code;
      case "unpaid": return f.unpaid;
      case "uBand": return f.band === q.band;
      case "never": return f.never;
    }
    return false;
  }

  const LIST_SHOW = 200;     /* rows drawn on the screen; the PDF has all */
  let shown = null;          /* { title, filters, kind:"master"|"drive", list, pays } */

  function listTitle(a) {
    const td = a.closest("td"), tr = a.closest("tr"), tbl = a.closest("table");
    const ths = tbl.querySelectorAll("thead th");
    const colName = ths[td.cellIndex] ? ths[td.cellIndex].textContent : "";
    const rowName = tr.cells[0] ? tr.cells[0].textContent : "";
    return (rowName + " · " + colName).replace(/\s+/g, " ").trim();
  }

  async function openList(a) {
    const q = links[Number(a.dataset.pgQ)];
    if (!q) return;
    const title = listTitle(a);
    showList(title, "Finding the consumers…", "");
    try {
      if (q.drive) {
        const pays = await currentPayments();
        const list = sortDrive(driveRows().filter(r =>
          (q.unit === undefined || r.u[q.lvl] === q.unit) && driveKind(r, q.drive, pays)));
        shown = { title: title, filters: filterText() + "  |  Visits " + visitRange(), kind: "drive", list: list, pays: pays };
      } else {
        const ctx = data.ctx, list = [];
        await forEachMasterBatch(batch => {
          for (const c of batch) {
            if (!isBillable(c.CONNECTION_STATUS)) continue;
            const f = facts(c, ctx);
            if (listMatch(q, f)) list.push({ c: c, f: f });
          }
        });
        list.sort((x, y) => x.f.u[1].localeCompare(y.f.u[1]) || x.f.u[2].localeCompare(y.f.u[2]) ||
          x.f.u[3].localeCompare(y.f.u[3]) || String(x.c.ACCT_ID).localeCompare(String(y.c.ACCT_ID), undefined, { numeric: true }));
        shown = { title: title, filters: filterText(), kind: "master", list: list };
      }
    } catch (e) {
      console.error(e);
      return showList(title, "Could not make the list: " + (e.message || e), "");
    }
    drawList();
  }

  function showList(title, info, body) {
    $("pgListTitle").textContent = title;
    $("pgListInfo").textContent = info;
    $("pgListBody").innerHTML = body;
    $("pgListPdfBtn").disabled = true;
    $("pgListXlsBtn").disabled = true;
    $("pglSharePdfBtn").classList.add("hidden");
    setStatus("pglStatusMsg", "");
    $("pgListModal").classList.remove("hidden");
    document.body.style.overflow = "hidden";
  }

  function drawList() {
    const s = shown, n = s.list.length;
    const e = v => escapeHtml(String(v == null ? "" : v));
    const j = (...parts) => parts.map(v => String(v == null ? "" : v).trim()).filter(Boolean).map(e).join(" · ");
    const rows = s.list.slice(0, LIST_SHOW).map((x, i) => {
      if (s.kind === "drive") {
        const p = s.pays[x.acct] || {};
        return '<div class="pg-li"><div><b>' + (i + 1) + ". " + e(x.acct) + "</b> " + e(x.name) + "</div>" +
          '<div class="pg-li-sub">' + j(label(x.u[3]), label(x.u[1]), x.mobile) + "</div>" +
          '<div class="pg-li-sub">' + j("Visit " + formatListDate(x.date), x.status, x.user) + "</div>" +
          '<div class="pg-li-sub">Outstanding ' + RS(p.out) + " · Last paid " + e(formatListDate(p.pay || "") || "—") +
          (p.amt ? " (₹" + e(p.amt) + ")" : "") + "</div></div>";
      }
      const c = x.c, f = x.f;
      return '<div class="pg-li"><div><b>' + (i + 1) + ". " + e(c.ACCT_ID) + "</b> " + e(c.NAME) + "</div>" +
        '<div class="pg-li-sub">' + j(label(f.u[3]), label(f.u[1]), c.MOBILE_NUMBER) + "</div>" +
        '<div class="pg-li-sub">' + e(c.SUPPLY_TYPE) + " · Load " + e(c.LOAD) + " · Outstanding " + RS(f.out) + "</div>" +
        '<div class="pg-li-sub">Last paid ' + e(formatListDate(f.pay || "") || "—") + (f.pay ? " (" + RS(f.payAmt) + ")" : "") +
        " · This month " + RS(f.thisMonth) + "</div>" +
        '<div class="pg-li-sub">' + j("Bill " + (formatListDate(parseMasterDate(c.LAST_BILL_DATE) || "") || "—"),
          c.BILL_BASIS, c.METER_READ_REMARK) + "</div></div>";
    }).join("");
    $("pgListInfo").textContent = N(n) + " consumers" + (n > LIST_SHOW ? " (first " + LIST_SHOW + " shown; the PDF has all)" : "") +
      ". Filters: " + s.filters;
    $("pgListBody").innerHTML = rows || '<div class="pg-note">No consumers.</div>';
    $("pgListPdfBtn").disabled = !n;
    $("pgListXlsBtn").disabled = !n;
  }

  async function listXlsx() {
    const s = shown;
    if (!s || !s.list.length) return;
    if (!xlsxReady()) return setStatus("pglStatusMsg", "Excel library is not loaded. Please reload the app.", "error");
    const groups = splitGroups(s.list, x => s.kind === "drive" ? x.u : x.f.u);
    if (groups.length > 25 && !confirm(groups.length + " separate Excel files will be made. Continue?")) return;
    const files = await saveXlsxSet(groups, (l, t) => s.kind === "drive"
      ? saveXlsx(t, s.filters, DRIVE_XLS_HEAD, l.map((r, i) => driveXlsRow(r, i, s.pays)), "")
      : saveXlsx(t, s.filters, MASTER_XLS_HEAD, l.map(masterXlsRow), ""), listFileBase(s), s.title, "pglStatusMsg");
    setStatus("pglStatusMsg", xlsDoneText(files, s.list.length), "ok");
  }
  const listFileBase = s => "List_" + s.title.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) + "_" + dlFileStamp();

  async function listPdf() {
    const s = shown;
    if (!s || !s.list.length) return;
    if (!pdfReady()) return setStatus("pglStatusMsg", "PDF library is not loaded. Please reload the app.", "error");
    const groups = splitGroups(s.list, x => s.kind === "drive" ? x.u : x.f.u);
    if (groups.length > 25 && !confirm(groups.length + " separate PDFs will be made. Continue?")) return;
    const makeMasterPdf = (list, title) => {
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4", compress: true });
      doc.setFontSize(12);
      doc.text(title, 10, 12);
      doc.setFontSize(8);
      doc.text("Data up to " + formatListDate(data.ctx.report) + ". Billable consumers. Sorted by substation, feeder, village, account.", 10, 17);
      doc.text("Filters: " + s.filters + "   |   Consumers: " + list.length.toLocaleString("en-IN"), 10, 21);
      const body = list.map((x, i) => {
        const c = x.c, f = x.f;
        return [i + 1, c.ACCT_ID, c.NAME || "", c.FATHER_NAME || "", c.ADDRESS || "", label(f.u[3]), label(f.u[1]), label(f.u[2]),
          c.MOBILE_NUMBER || "", c.SUPPLY_TYPE || "", c.LOAD || "", Math.round(f.out).toLocaleString("en-IN"),
          formatListDate(f.pay || ""), f.pay ? Math.round(f.payAmt).toLocaleString("en-IN") : "",
          Math.round(f.thisMonth).toLocaleString("en-IN"), formatListDate(parseMasterDate(c.LAST_BILL_DATE) || ""),
          c.BILL_BASIS || "", c.METER_READ_REMARK || ""];
      });
      doc.autoTable({
        startY: 24,
        margin: { left: 8, right: 8 },
        head: [["S.No", "Account", "Name", "Father/Husband", "Address", "Village", "Substation", "Feeder", "Mobile",
          "Supply", "Load", "Outstanding (Rs.)", "Last Pay Date", "Last Pay Amt", "This Month Paid", "Bill Date", "Bill Basis", "Remark"]],
        body: body,
        theme: "grid",
        styles: { fontSize: 6.3, cellPadding: 1, overflow: "linebreak", valign: "middle", lineColor: [120, 120, 120], lineWidth: 0.1, textColor: [0, 0, 0] },
        headStyles: { fillColor: [13, 148, 136], textColor: 255, fontSize: 6.3 },
        columnStyles: {
          0: { cellWidth: 7, halign: "right" }, 1: { cellWidth: 17 }, 2: { cellWidth: 20 }, 3: { cellWidth: 18 },
          4: { cellWidth: 30 }, 5: { cellWidth: 15 }, 6: { cellWidth: 14 }, 7: { cellWidth: 14 }, 8: { cellWidth: 16 },
          9: { cellWidth: 9 }, 10: { cellWidth: 8 }, 11: { cellWidth: 14, halign: "right" }, 12: { cellWidth: 14 },
          13: { cellWidth: 12, halign: "right" }, 14: { cellWidth: 12, halign: "right" }, 15: { cellWidth: 14 },
          16: { cellWidth: 11 }, 17: { cellWidth: 14 }
        },
        didDrawPage: () => {
          doc.setFontSize(7);
          doc.text("Page " + doc.internal.getNumberOfPages(), doc.internal.pageSize.getWidth() - 25, doc.internal.pageSize.getHeight() - 5);
        }
      });
      return doc;
    };
    const files = await savePdfSet(groups,
      s.kind === "drive" ? (l, t) => makeDrivePdf(l, s.pays, t, s.filters) : makeMasterPdf,
      listFileBase(s), s.title, "pgl", "pglStatusMsg");
    setStatus("pglStatusMsg", pdfDoneText(files, s.list.length), "ok");
  }




  function closeList() {
    $("pgListModal").classList.add("hidden");
    document.body.style.overflow = "";
  }

  /* the list window (made here, so index.html does not change) */
  (() => {
    const box = document.createElement("div");
    box.id = "pgListModal";
    box.className = "pg-modal hidden";
    box.innerHTML =
      '<div class="pg-modal-box">' +
      '<div class="pg-modal-head"><b id="pgListTitle"></b><button id="pgListCloseBtn" type="button" class="logout">CLOSE</button></div>' +
      '<div id="pgListInfo" class="pg-note"></div>' +
      '<div id="pgListSplitBox"></div>' +
      '<div class="pg-dl-btns"><button id="pgListPdfBtn" type="button" class="secondary">DOWNLOAD PDF</button>' +
      '<button id="pgListXlsBtn" type="button" class="secondary">DOWNLOAD EXCEL</button></div>' +
      '<button id="pglSharePdfBtn" type="button" class="secondary hidden">SHARE PDF ON WHATSAPP</button>' +
      '<div id="pglStatusMsg" class="status"></div>' +
      '<div id="pgListBody"></div></div>';
    document.body.appendChild(box);
    box.addEventListener("click", e => { if (e.target === box) closeList(); });
    /* v20.7: the small PDF files choice, in the list window and above the drive downloads */
    $("pgListSplitBox").appendChild(splitRow("pgListSplit"));
    const tg = $("pgListTgBtn") && $("pgListTgBtn").closest(".pg-dl-row");
    if (tg) tg.parentNode.insertBefore(splitRow("pgDriveSplit"), tg);
    try { if (typeof applyLanguage === "function") applyLanguage(); } catch (e) {}
  })();

  /* ---------- screen ---------- */
  async function render() {
    if (!data || !$("progressCard") || $("progressCard").classList.contains("hidden")) return;
    const ctx = data.ctx;
    setupFromDate(ctx);
    setupDriveDates();
    setSwitches();
    const col = collect();
    links = [];
    $("pgAsOf").textContent = "Data up to " + formatListDate(ctx.report) +
      (typeof reportsShortText === "function" ? reportsShortText(getLocalMasterMeta()) : "") + " · billing month " +
      MONTHS[Number(ctx.billingMonth.slice(5, 7)) - 1] + " " + ctx.billingMonth.slice(0, 4) +
      " · billable consumers · " + GROUP_LABEL[sel.group] +
      (sel.meter === "ALL" ? "" : sel.meter === "S" ? " · smart meters" : " · non-smart meters");
    $("pgRevenue").innerHTML = revenueHtml(col, ctx);
    $("pgTurnUp").innerHTML = turnUpHtml(col, ctx);
    $("pgBilling").innerHTML = billingHtml(col);
    $("pgRemark").innerHTML = countHtml(col.total.remark, col.total.billed, "remark");
    $("pgBasis").innerHTML = countHtml(col.total.basis, col.total.billed, "basis");
    $("pgUnpaid").innerHTML = unpaidHtml(col);
    $("pgDrive").innerHTML = driveHtml(await currentPayments());
    markWideTables();
  }

  async function openProgress() {
    if (!state.masterReady || !state.masterDb) {
      alert("Master Data is not ready yet. Please wait for the master to finish loading.");
      return;
    }
    if (busy) return;
    loadSel();
    loadDrive();
    showMainView("progressCard");
    window.scrollTo(0, 0);

    const ctx = context();
    if (!data || data.key !== ctx.key) {
      busy = true;
      showGlobalLoading("Preparing Progress…", "Reading the Master Data on this phone. This takes a few seconds.");
      try {
        data = await compute(ctx);
      } catch (e) {
        console.error(e);
        alert("Could not read Master Data. " + (e.message || ""));
        return;
      } finally {
        busy = false;
        hideGlobalLoading();
      }
    }
    refreshDropdowns();
    await render();
    if (!drive && navigator.onLine) refreshDrive();
  }

  /* ---------- wiring ---------- */
  if (typeof MAIN_VIEW_IDS !== "undefined" && MAIN_VIEW_IDS.indexOf("progressCard") === -1) MAIN_VIEW_IDS.push("progressCard");
  const on = (id, ev, fn) => { if ($(id)) $(id).addEventListener(ev, fn); };
  on("progressBtn", "click", openProgress);
  on("pgCloseBtn", "click", () => showMainView("home"));
  on("pgDriveRefreshBtn", "click", refreshDrive);
  on("pgListTgBtn", "click", () => drivePdf("TG", "pdf"));
  on("pgListPvBtn", "click", () => drivePdf("PV", "pdf"));
  on("pgListTgXlsBtn", "click", () => drivePdf("TG", "xlsx"));
  on("pgListPvXlsBtn", "click", () => drivePdf("PV", "xlsx"));
  on("pgSharePdfBtn", "click", () => { if (typeof shareListPdf === "function") shareListPdf("pg"); });
  on("progressCard", "click", e => {
    const a = e.target.closest("a.pg-link");
    if (!a) return;
    e.preventDefault();
    openList(a);
  });
  on("pgListCloseBtn", "click", closeList);
  on("pgListPdfBtn", "click", listPdf);
  on("pgListXlsBtn", "click", listXlsx);
  on("pglSharePdfBtn", "click", () => { if (typeof shareListPdf === "function") shareListPdf("pgl"); });
  on("pgFromDate", "change", () => { sel.fromDate = $("pgFromDate").value; saveSel(); render(); });
  on("pgDriveFrom", "change", () => { sel.driveFrom = $("pgDriveFrom").value; saveSel(); render(); });
  on("pgDriveTo", "change", () => { sel.driveTo = $("pgDriveTo").value; saveSel(); render(); });

  on("pgFilters", "change", onFilterChange);
  on("pgFilters", "click", e => {
    const head = e.target.closest("[data-pg-toggle]");
    if (!head) return;
    const k = head.dataset.pgToggle;
    if (openFilters.has(k)) openFilters.delete(k); else openFilters.add(k);
    head.nextElementSibling.classList.toggle("hidden");
  });
  on("pgFilters", "input", e => {
    const k = e.target.dataset.pgSearch;
    if (!k) return;
    filterSearch[k] = e.target.value.trim().toLowerCase();
    e.target.parentElement.querySelectorAll("label.dl-check[data-text]").forEach(l => {
      l.style.display = !filterSearch[k] || l.dataset.text.indexOf(filterSearch[k]) !== -1 ? "" : "none";
    });
  });
  window.addEventListener("resize", () => { if (data) markWideTables(); });

  /* phone-friendly table look */
  const style = document.createElement("style");
  style.textContent =
    ".pg-swipe{font-size:11px;color:#0f766e;font-weight:700;text-align:right;margin:2px 2px 4px}" +
    ".pg-scroll{-webkit-overflow-scrolling:touch;border:1px solid #94a3b8;border-radius:8px}" +
    /* grid lines on every cell */
    "#progressCard table.pg-table{border-collapse:separate;border-spacing:0}" +
    "#progressCard .pg-table th,#progressCard .pg-table td{border:0;border-right:1px solid #cbd5e1;border-bottom:1px solid #cbd5e1}" +
    "#progressCard .pg-table th:last-child,#progressCard .pg-table td:last-child{border-right:0}" +
    "#progressCard .pg-table tbody tr:last-child td{border-bottom:0}" +
    "#progressCard .pg-table thead th{border-bottom:2px solid #94a3b8}" +
    "#progressCard .pg-table th:first-child,#progressCard .pg-table td:first-child{border-right:2px solid #94a3b8}" +
    /* column names wrap, so columns are only as wide as their numbers */
    /* words are never cut: a column is as narrow as its longest word or its numbers */
    "#progressCard .pg-table th{white-space:normal;width:100px;min-width:72px;vertical-align:bottom;line-height:1.25;word-break:keep-all;overflow-wrap:normal;hyphens:none}" +
    "#progressCard .pg-table th:first-child{width:auto;min-width:0;max-width:none;overflow:visible}" +
    "#progressCard .pg-amt{color:#475569;font-size:.9em}" +
    "#progressCard a.pg-link{color:#0f766e;font-weight:700;text-decoration:underline;text-underline-offset:2px}" +
    ".pg-modal{position:fixed;inset:0;z-index:9000;background:rgba(15,23,42,.55);display:flex;align-items:flex-end;justify-content:center}" +
    ".pg-modal.hidden{display:none}" +
    ".pg-modal-box{background:#fff;width:100%;max-width:720px;max-height:88vh;overflow-y:auto;border-radius:16px 16px 0 0;padding:14px 14px 24px}" +
    ".pg-modal-head{display:flex;gap:10px;align-items:flex-start;justify-content:space-between;position:sticky;top:-14px;background:#fff;padding:4px 0 8px;z-index:1}" +
    ".pg-modal-head b{font-size:15px;line-height:1.3}" +
    /* list downloads: a name and two small buttons on one line */
    ".pg-dl-row{display:flex;align-items:center;justify-content:space-between;gap:8px 12px;flex-wrap:wrap;padding:10px 0;border-bottom:1px solid #e2e8f0}" +
    ".pg-dl-name{font-size:13px;font-weight:700;flex:1 1 220px}" +
    ".pg-dl-btns{display:flex;gap:8px;flex:0 0 auto;margin:6px 0}" +
    ".pg-dl-btns button{width:auto;min-width:72px;margin:0;padding:7px 14px;font-size:12.5px;border-radius:999px}" +
    ".pg-split-row{display:flex;align-items:center;justify-content:flex-end;gap:8px;margin:8px 0 2px;font-size:12px;color:#475569}" +
    ".pg-split-row label{margin:0;font-size:12px;font-weight:600;color:#475569}" +
    ".pg-split-row select.pg-split{width:auto;max-width:62%;margin:0;padding:5px 8px;font-size:12px;border-radius:999px;color:#0f766e;font-weight:600}" +
    ".pg-li{border-bottom:1px solid #e2e8f0;padding:8px 2px;font-size:13px}" +
    ".pg-li-sub{color:#475569;font-size:12px;margin-top:2px}" +
    "@media(max-width:480px){#progressCard .pg-table th,#progressCard .pg-table td{padding:5px 5px;font-size:12px}" +
    "#progressCard .pg-table th{width:72px;min-width:72px;font-size:11.5px}" +
    "#progressCard .pg-table td:first-child{max-width:112px}}";
  document.head.appendChild(style);

  [["pgGroup", "group"], ["pgMeter", "meter"], ["pgLevel", "level"], ["pgCompare", "compare"]].forEach(([id, key]) => {
    on(id, "click", e => {
      const b = e.target.closest("button[data-v]");
      if (!b) return;
      sel[key] = b.dataset.v;
      saveSel();
      render();
    });
  });

  /* for tests and later use */
  window.fieldworkProgress = { open: openProgress, refreshDrive: refreshDrive, drivePdf: drivePdf };
})();
