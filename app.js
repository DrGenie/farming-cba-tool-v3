
/* Soil Trial Economics Tool - single file app.js (no external libraries) */
(() => {
  'use strict';

  const TOOL_VERSION = '1.1.0';
  const REQUIRED_CANON = ['treatment_name','is_control','yield_t_ha','total_cost_per_ha'];

  // Common aliases / near matches (deterministic mapping)
  const ALIASES = {
    treatment_name: ['treatment','treatment name','amendment_name','amendment name','practice','practice_change_label'],
    is_control: ['control','is control','control_flag','controlflag','reference','iscontrol'],
    yield_t_ha: ['yield','yield t ha','yield_t/ha','yield (t/ha)','yield_t_ha_raw'],
    total_cost_per_ha: ['total_cost','total cost per ha','total cost ($/ha)','total_cost_per_ha_raw','cost_total_per_ha','total cost']
  };

  const state = {
    fileName: 'example_data.tsv',
    activeTab: 'home',
    hasRun: false,
    activateTab: null,
    rawText: '',
    rawRows: [],
    headers: [],
    mapping: {},
    readinessLevel: 'amber',
    minIssues: [],
    warnings: [],
    cleanedRows: [],
    issues: [],
    fixesTop: [],
    settings: { pricePerT: 500, years: 10, discountPct: 5, yieldInKg: false },
    referenceControlName: null,
    controlPinned: false,
    compareMode: 'control',
    analysis: null,
    audit: { uploadedAt: null, rowCount: 0, treatmentCount: 0, controlCount: 0 }
  };

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);

  function showToast(message, type='success'){
    const t = $('toast');
    if(!t) return;
    t.className = `toast ${type}`;
    t.textContent = message;
    t.hidden = false;
    window.clearTimeout(showToast._timer);
    showToast._timer = window.setTimeout(() => { t.hidden = true; }, 4200);
  }

  function saveSettingsToLocal(){
    try{
      localStorage.setItem('cba_tool_settings', JSON.stringify({
        pricePerT: state.settings.pricePerT,
        years: state.settings.years,
        discountPct: state.settings.discountPct,
        yieldInKg: !!state.settings.yieldInKg
      }));
    }catch(_e){ /* ignore */ }
  }

  function loadSettingsFromLocal(){
    try{
      const raw = localStorage.getItem('cba_tool_settings');
      if(!raw) return null;
      const v = JSON.parse(raw);
      if(!v || typeof v !== 'object') return null;
      if(typeof v.pricePerT !== 'number' || typeof v.years !== 'number' || typeof v.discountPct !== 'number') return null;
      if(("yieldInKg" in v) && typeof v.yieldInKg !== "boolean") return null;
      return v;
    }catch(_e){ return null; }
  }

  function setStatus(line){
    $('statusLine').textContent = line;
  }

  function setReadiness(level){
    const el = $('readiness');
    el.classList.remove('readiness-green','readiness-amber','readiness-red');
    if(level === 'green'){ el.classList.add('readiness-green'); el.textContent = 'Green'; }
    else if(level === 'red'){ el.classList.add('readiness-red'); el.textContent = 'Red'; }
    else { el.classList.add('readiness-amber'); el.textContent = 'Amber'; }
  }


  function setConfidenceLine(){
    const el = $('confidenceLine');
    if(!el) return;

    // Data readiness governs whether the numbers are trustworthy.
    // Outcome sign governs whether the selected option is a sensible decision vs the control.
    const readiness = state.readinessLevel || 'amber';
    const a = state.analysis;
    const selName = state.selectedTreatment || (a && a.leaderboard && a.leaderboard[0] ? a.leaderboard[0].treatment : null);
    const sel = (a && a.byName && selName) ? a.byName[selName] : null;
    const dn = (sel && typeof sel.deltaNpv === 'number') ? sel.deltaNpv : null;

    el.classList.remove('confidence-green','confidence-amber','confidence-red');

    if(readiness === 'red'){
      el.classList.add('confidence-red');
      el.textContent = 'Red: cannot run yet. Fix the data issues in the Data tab.';
      return;
    }

    // If the selected treatment is worse than the control, do not show green.
    if(dn !== null && dn < 0){
      el.classList.add('confidence-amber');
      const loss = `$${fmtMoney(Math.abs(dn))} per hectare`;
      const base = `Under the stated assumptions and data provided, the selected option is worse than the control by ${loss}.`;
      if(readiness === 'green'){
        el.textContent = `Amber: ${base}`;
      } else {
        const fixes = (state.fixesTop || []).slice(0,2);
        const qual = fixes.length ? ` Data note: ${fixes.join(' and ')}.` : '';
        el.textContent = `Amber: ${base}${qual}`;
      }
      return;
    }

    if(readiness === 'green'){
      if(dn !== null && dn >= 0){
        el.classList.add('confidence-green');
        el.textContent = `Green: good to use for decisions under the stated assumptions. Selected option is better than the control by $${fmtMoney(dn)} per hectare.`;
      } else {
        el.classList.add('confidence-green');
        el.textContent = 'Green: good to use for decisions under the stated assumptions.';
      }
      return;
    }

    // readiness amber
    el.classList.add('confidence-amber');
    const fixes = (state.fixesTop || []).slice(0,2);
    const msg = fixes.length ? `Amber: indicative, check: ${fixes.join(' and ')}.` : 'Amber: indicative, check two items.';
    if(dn !== null && dn > 0){
      el.textContent = `${msg} Selected option is better than the control by $${fmtMoney(dn)} per hectare.`;
    } else {
      el.textContent = msg;
    }
  }
  function setTopFixes(fixes){
    state.fixesTop = (fixes || []).slice(0,2);
    const box = $('readinessFixes');
    if(!box) return;
    if(!state.fixesTop.length){
      box.textContent = 'No fixes needed.';
      return;
    }
    const ul = document.createElement('ul');
    state.fixesTop.forEach(t => {
      const li = document.createElement('li');
      li.textContent = t;
      ul.appendChild(li);
    });
    box.innerHTML = '';
    box.appendChild(ul);
  }

  function initReadinessPopover(){
    const btn = $('readiness');
    const pop = $('readinessPopover');
    if(!btn || !pop) return;
    function toggle(){
      pop.hidden = !pop.hidden;
      if(!pop.hidden){
        // Close when clicking elsewhere
        window.setTimeout(() => {
          const onDoc = (e) => {
            if(pop.contains(e.target) || btn.contains(e.target)) return;
            pop.hidden = true;
            document.removeEventListener('click', onDoc, true);
          };
          document.addEventListener('click', onDoc, true);
        }, 0);
      }
    }
    btn.addEventListener('click', toggle);
  }

  function fmtMoney(x){
    if(x === null || x === undefined || Number.isNaN(x)) return '-';
    const v = Number(x);
    return v.toLocaleString(undefined,{minimumFractionDigits:0, maximumFractionDigits:0});
  }

  function fmtMoney2(x){
    if(x === null || x === undefined || Number.isNaN(x)) return '-';
    const v = Number(x);
    return v.toLocaleString(undefined,{minimumFractionDigits:2, maximumFractionDigits:2});
  }

  function fmtNum(x, dp=2){
    if(x === null || x === undefined || Number.isNaN(x)) return '-';
    return Number(x).toLocaleString(undefined,{minimumFractionDigits:dp, maximumFractionDigits:dp});
  }

  function updateMeta(){
    $('metaFile').textContent = state.fileName || '-';
    $('metaRows').textContent = String(state.audit.rowCount || 0);
    $('metaTreatments').textContent = String(state.audit.treatmentCount || 0);
    $('metaControls').textContent = String(state.audit.controlCount || 0);
    $('toolVersion').textContent = TOOL_VERSION;
    updateFooter();
  }

  function updateFooter(){
    const fv = $('footerVersion');
    const fm = $('footerMethod');
    const fg = $('footerGenerated');
    if(!fv || !fm || !fg) return;

    const s = state.settings;
    const r = (Number(s.discountPct) || 0) / 100;
    const years = Number(s.years) || 0;
    const df = (years && isFinite(r)) ? discountFactor(r, years) : null;
    fv.textContent = `Version ${TOOL_VERSION}`;
    fm.textContent = `Discounting: annual PV over ${years}y at ${fmtNum(r*100,1)}% (DF ${df===null?'-':fmtNum(df,2)})`;
    fg.textContent = `Generated: ${new Date().toLocaleString()}`;
  }

  // ---------- Tabs ----------
  function initTabs(){
    const tabs = Array.from(document.querySelectorAll('.tab'));
    const panels = {
      home: $('tab-home'),
      data: $('tab-data'),
      results: $('tab-results'),      export: $('tab-export')
      ,sensitivity: $('tab-sensitivity')
    };

    function activate(tabName){
      state.activeTab = tabName;
      tabs.forEach(btn => {
        const active = btn.dataset.tab === tabName;
        btn.classList.toggle('is-active', active);
        btn.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      Object.entries(panels).forEach(([name, panel]) => {
        if(!panel) return;
        const active = name === tabName;
        panel.hidden = !active;
        panel.classList.toggle('is-active', active);
      });
      updateProgressFromTab(tabName);
    }

    tabs.forEach(btn => btn.addEventListener('click', () => activate(btn.dataset.tab)));
    document.querySelectorAll('[data-goto]').forEach(b => b.addEventListener('click', () => activate(b.dataset.goto)));

    // Expose for other handlers
    state.activateTab = activate;
    activate('home');
  }

  function updateProgressFromTab(tabName){
    const map = {
      home: 'load',
      data: 'check',
      results: state.hasRun ? 'review' : 'run',
      sensitivity: 'review',
      export: 'export'
    };
    setProgress(map[tabName] || 'load');
  }

  function setProgress(step){
    const line = $('progressLine');
    if(!line) return;
    line.querySelectorAll('.progress-step').forEach(el => {
      el.classList.toggle('is-active', el.dataset.step === step);
    });
  }

  // ---------- Tooltip (keyboard accessible) ----------
  function initTooltips(){
    const tip = $('tooltip');
    if(!tip) return;

    function show(el){
      const txt = el.getAttribute('data-tip');
      if(!txt) return;
      tip.textContent = txt;
      tip.hidden = false;
      const r = el.getBoundingClientRect();
      const pad = 10;
      const top = Math.max(12, r.bottom + pad);
      const left = Math.min(window.innerWidth - 20 - 320, Math.max(12, r.left));
      tip.style.top = `${top}px`;
      tip.style.left = `${left}px`;
    }
    function hide(){ tip.hidden = true; }

    document.querySelectorAll('[data-tip]').forEach(el => {
      el.addEventListener('mouseenter', () => show(el));
      el.addEventListener('mouseleave', hide);
      el.addEventListener('focus', () => show(el));
      el.addEventListener('blur', hide);
    });
    window.addEventListener('scroll', hide, {passive:true});
  }

  // ---------- Parsing ----------
  function detectDelimiter(text){
    const firstLine = (text.split(/\r?\n/).find(l => l.trim().length>0) || '');
    const tabs = (firstLine.match(/\t/g) || []).length;
    const commas = (firstLine.match(/,/g) || []).length;
    return tabs >= commas ? '\t' : ',';
  }

  function parseDelimited(text){
    const delim = detectDelimiter(text);
    const lines = text.split(/\r?\n/).filter(l => l.trim().length>0);
    if(lines.length === 0) return { headers: [], rows: [] };
    const headers = splitLine(lines[0], delim).map(h => h.trim());
    const rows = [];
    for(let i=1;i<lines.length;i++){
      const parts = splitLine(lines[i], delim);
      const row = {};
      for(let c=0;c<headers.length;c++){
        row[headers[c]] = (parts[c] ?? '').trim();
      }
      rows.push(row);
    }
    return { headers, rows };
  }

  function splitLine(line, delim){
    // minimal CSV support for commas, handles quoted values. TSV assumed unquoted.
    if(delim === '\t') return line.split('\t');
    const out = [];
    let cur = '';
    let inQ = false;
    for(let i=0;i<line.length;i++){
      const ch = line[i];
      if(ch === '"' ){ inQ = !inQ; continue; }
      if(ch === ',' && !inQ){ out.push(cur); cur=''; continue; }
      cur += ch;
    }
    out.push(cur);
    return out;
  }

  function normalizeHeader(h){
    return (h||'')
      .toString()
      .trim()
      .toLowerCase()
      .replace(/[\s\-_]+/g,' ')
      .replace(/[^\w\s]/g,'')
      .trim();
  }

  function proposeMapping(headers){
    const norm = headers.map(h => ({raw:h, norm:normalizeHeader(h)}));
    const mapping = {};
    const used = new Set();

    function bestMatch(target){
      const candidates = [target, ...(ALIASES[target] || [])].map(normalizeHeader);
      let best = null, bestScore = -1;
      for(const h of norm){
        if(used.has(h.raw)) continue;
        let score = 0;
        for(const c of candidates){
          if(h.norm === c) score = Math.max(score, 100);
          else if(h.norm.includes(c) || c.includes(h.norm)) score = Math.max(score, 80);
          else score = Math.max(score, similarity(h.norm, c));
        }
        if(score > bestScore){ bestScore = score; best = h.raw; }
      }
      return bestScore >= 65 ? {col:best, score:bestScore} : null;
    }

    for(const canon of REQUIRED_CANON){
      const m = bestMatch(canon);
      if(m){ mapping[canon] = m.col; used.add(m.col); }
      else mapping[canon] = null;
    }
    return mapping;
  }

  function similarity(a,b){
    // simple Dice coefficient on bigrams
    if(!a || !b) return 0;
    const bigrams = (s) => {
      const out = [];
      const t = ` ${s} `;
      for(let i=0;i<t.length-1;i++) out.push(t.slice(i,i+2));
      return out;
    };
    const A = bigrams(a), B = bigrams(b);
    const m = new Map();
    A.forEach(x => m.set(x, (m.get(x)||0)+1));
    let inter = 0;
    B.forEach(x => { const v = m.get(x)||0; if(v>0){ inter++; m.set(x, v-1); }});
    return Math.round(200 * inter / (A.length + B.length)); // scale to 0-100-ish
  }

  function coerceNumber(v){
    if(v === null || v === undefined) return null;
    const s = String(v).trim();
    if(s === '') return null;
    const cleaned = s.replace(/\$/g,'').replace(/,/g,'').replace(/\s+/g,'');
    const num = Number(cleaned);
    if(Number.isNaN(num)) return null;
    return num;
  }

  function coerceBool(v){
    const s = String(v ?? '').trim().toLowerCase();
    if(['true','t','1','yes','y'].includes(s)) return true;
    if(['false','f','0','no','n',''].includes(s)) return false;
    return false;
  }

  function cleanRows(rawRows, mapping, yieldInKg=false){
    const cleaned = [];
    const issues = [];
    for(const r of rawRows){
      const row = {...r};
      // Create canonical fields
      row.treatment_name = (mapping.treatment_name ? r[mapping.treatment_name] : r['treatment_name']) ?? '';
      row.is_control = (mapping.is_control ? r[mapping.is_control] : r['is_control']) ?? '';
      row.yield_t_ha = (mapping.yield_t_ha ? r[mapping.yield_t_ha] : r['yield_t_ha']) ?? '';
      row.total_cost_per_ha = (mapping.total_cost_per_ha ? r[mapping.total_cost_per_ha] : r['total_cost_per_ha']) ?? '';

      // Coerce
      const tname = String(row.treatment_name||'').trim();
      const isControl = coerceBool(row.is_control);
      let y = coerceNumber(row.yield_t_ha);
      if(yieldInKg && y !== null){ y = y / 1000; }
      const c = coerceNumber(row.total_cost_per_ha);

      row.__canon = { treatment_name: tname, is_control: isControl, yield_t_ha: y, total_cost_per_ha: c };
      cleaned.push(row);
    }

    // Unit and format warnings (non blocking)
    const ys = cleaned.map(r => r.__canon.yield_t_ha).filter(v => v !== null);
    if(ys.length){
      const p50 = percentile(ys, 0.5);
      if(yieldInKg){
        issues.push({level:'good', text:'Yield conversion applied: inputs were treated as kg/ha and converted to t/ha.'});
      } else if(p50 > 50){
        issues.push({level:'warn', text:'Yield values look very large. If your yield is in kilograms per hectare, tick “My yields are in kg/ha” in Settings so the tool converts to tonnes per hectare.'});
      }
      if(Math.min(...ys) < 0){
        issues.push({level:'warn', text:'Some yield values are negative. Check for data entry errors.'});
      }
    }
    const cs = cleaned.map(r => r.__canon.total_cost_per_ha).filter(v => v !== null);
    if(cs.length){
      const p50 = percentile(cs, 0.5);
      if(p50 > 20000){
        issues.push({level:'warn', text:'Cost values look very large. Check whether costs were entered in cents or for a whole farm rather than per hectare.'});
      }
      if(Math.min(...cs) < 0){
        issues.push({level:'warn', text:'Some cost values are negative. Check for data entry errors.'});
      }
    }

    return { cleaned, issues };
  }

  function percentile(arr, p){
    const a = [...arr].sort((x,y)=>x-y);
    const idx = (a.length - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if(lo === hi) return a[lo];
    return a[lo] + (a[hi]-a[lo])*(idx-lo);
  }

  function validateMinimum(cleaned){
    const controls = cleaned.filter(r => r.__canon.is_control);
    const treatments = cleaned.filter(r => !r.__canon.is_control);
    const miss = [];
    if(!controls.length) miss.push('No control identified. Mark at least one row as control in the is_control column. Example: TRUE.');
    if(!treatments.length) miss.push('No treatment rows found. Include at least one row where is_control is FALSE.');
    const missingYield = cleaned.some(r => r.__canon.yield_t_ha === null);
    const missingCost = cleaned.some(r => r.__canon.total_cost_per_ha === null);
    if(missingYield) miss.push('Some yield_t_ha values are missing or not numeric. Example fix: enter 6.2 (no units).');
    if(missingCost) miss.push('Some total_cost_per_ha values are missing or not numeric. Example fix: enter 850 (no dollar sign).');
    return miss;
  }

  function computeCounts(cleaned){
    const rows = cleaned.length;
    const treatments = new Set(cleaned.map(r => r.__canon.treatment_name).filter(Boolean));
    const controls = cleaned.filter(r => r.__canon.is_control);
    const controlNames = new Set(controls.map(r => r.__canon.treatment_name).filter(Boolean));
    return { rows, treatments: treatments.size, controls: controlNames.size, controlNames: [...controlNames] };
  }

  function populateControlSelect(controlNames){
    const sel = $('controlSelect');
    sel.innerHTML = '';
    if(!controlNames.length){
      const o = document.createElement('option');
      o.value = '';
      o.textContent = 'No control detected';
      sel.appendChild(o);
      sel.disabled = true;
      return;
    }
    sel.disabled = false;
    controlNames.forEach(name => {
      const o = document.createElement('option');
      o.value = name;
      o.textContent = name;
      sel.appendChild(o);
    });
  }

  // ---------- Analysis ----------
  function discountFactor(r, years){
    let s = 0;
    for(let t=1;t<=years;t++){
      s += 1 / Math.pow(1+r, t);
    }
    return s;
  }

  function aggregateByTreatment(cleaned){
    const groups = new Map();
    for(const row of cleaned){
      const t = row.__canon.treatment_name || '(blank)';
      if(!groups.has(t)) groups.set(t, { name:t, isControl:false, yields:[], costs:[], rows:[] });
      const g = groups.get(t);
      g.isControl = g.isControl || !!row.__canon.is_control;
      if(row.__canon.yield_t_ha !== null) g.yields.push(row.__canon.yield_t_ha);
      if(row.__canon.total_cost_per_ha !== null) g.costs.push(row.__canon.total_cost_per_ha);
      g.rows.push(row);
    }
    const out = [];
    for(const g of groups.values()){
      out.push({
        name: g.name,
        isControl: g.isControl,
        n: g.rows.length,
        meanYield: mean(g.yields),
        meanCost: mean(g.costs),
        yields: g.yields,
        costs: g.costs
      });
    }
    return out;
  }

  function mean(arr){
    if(!arr || !arr.length) return null;
    return arr.reduce((a,b)=>a+b,0) / arr.length;
  }

  function runAnalysis(){
    if(!state.cleanedRows.length){
      showToast('No data loaded. Upload a file first.', 'warn');
      return;
    }

    // Determine readiness and indicative mode
    const mappingOk = REQUIRED_CANON.every(k => !!state.mapping[k]);
    const minIssues = validateMinimum(state.cleanedRows);
    const counts = computeCounts(state.cleanedRows);
    const readiness = minIssues.length ? 'red' : (mappingOk ? 'green' : 'amber');
    state.readinessLevel = readiness;
    state.minIssues = minIssues.slice();
    setReadiness(readiness);
    setTopFixes(minIssues.length ? minIssues : (readiness === 'amber' ? ['Some column names were matched automatically. Download the cleaned file if you want to keep the standard names.'] : []));

    if(minIssues.length){
      showToast('Cannot run analysis. Fix the data issues in the Data tab.', 'error');
      renderIssues(minIssues, true);
      return;
    }

    // Choose reference control name
    if(!state.referenceControlName){
      state.referenceControlName = counts.controlNames[0] || null;
    }
    $('currentControl').textContent = state.referenceControlName || '-';
    $('controlNameResult').textContent = state.referenceControlName || '-';

    const aggs = aggregateByTreatment(state.cleanedRows);
    const controlAgg = aggs.find(a => a.name === state.referenceControlName && a.isControl) || aggs.find(a => a.isControl);
    const treatedAggs = aggs.filter(a => !a.isControl);

    const r = Math.max(0, Number(state.settings.discountPct)/100);
    const years = Math.max(1, Math.round(Number(state.settings.years)));
    const price = Math.max(0, Number(state.settings.pricePerT));

    const DF = discountFactor(r, years);

    // Build results per treatment
    const rows = [];
    for(const a of aggs){
      const y = a.meanYield;
      const c = a.meanCost;
      const pvB = (y === null) ? null : y * price * DF;
      const pvC = (c === null) ? null : c * DF;
      const npv = (pvB === null || pvC === null) ? null : (pvB - pvC);
      const bcr = (pvB === null || pvC === null || pvC === 0) ? null : (pvB / pvC);
      const roi = (npv === null || pvC === null || pvC === 0) ? null : (npv / pvC * 100);
      rows.push({
        treatment: a.name,
        isControl: a.isControl,
        n: a.n,
        meanYield: y,
        meanCost: c,
        pvBenefit: pvB,
        pvCost: pvC,
        npv,
        bcr,
        roi
      });
    }

    const controlRow = rows.find(x => x.treatment === controlAgg.name);
    for(const row of rows){
      if(!controlRow || row.npv === null || controlRow.npv === null){
        row.deltaNpv = null;
      } else {
        row.deltaNpv = row.npv - controlRow.npv;
      }
    }

    const fullCapable = rows.every(rw => rw.meanYield !== null && rw.meanCost !== null);
    $('badgeIndicative').classList.toggle('badge-hidden', fullCapable);

    // Leaderboard: treatments excluding control, sort by NPV
    const leaderboard = rows
      .filter(rw => !rw.isControl)
      .slice()
      .sort((a,b) => (b.npv ?? -Infinity) - (a.npv ?? -Infinity));

    state.analysis = {
      DF, r, years, price,
      controlName: controlAgg.name,
      control: controlRow,
      all: rows,
      byName: Object.fromEntries(rows.map(x => [x.treatment, x])),
      leaderboard,
      replicate: buildReplicateView(state.cleanedRows),
      indicative: (state.readinessLevel !== 'green')
    };

    renderResults();
    buildBriefPrompt();
    renderAuditTrail();
    state.hasRun = true;
    updateProgressFromTab(state.activeTab || 'results');
    showToast('Analysis updated. Review results.', 'success');
  }

  function runSensitivity(opts={}){
    const silent = !!opts.silent;
    if(!state.analysis){
      if(!silent) showToast('Run the analysis first.', 'warn');
      return;
    }

    const base = {
      price: state.analysis.price,
      years: state.analysis.years,
      discountPct: state.analysis.r * 100
    };

    const scenarios = [
      { name: 'Base', ...base },
      { name: 'Price -20%', price: base.price * 0.8, years: base.years, discountPct: base.discountPct },
      { name: 'Price +20%', price: base.price * 1.2, years: base.years, discountPct: base.discountPct },
      { name: 'Discount 0%', price: base.price, years: base.years, discountPct: 0 },
      { name: 'Discount 10%', price: base.price, years: base.years, discountPct: 10 },
      { name: 'Years 5', price: base.price, years: 5, discountPct: base.discountPct },
      { name: 'Years 15', price: base.price, years: 15, discountPct: base.discountPct }
    ];

    const tableRows = scenarios.map(s => computeScenarioRanking(s));
    renderSensitivity(tableRows);

    const baseTop = tableRows.find(r => r.scenario === 'Base');
    const stableCount = tableRows.filter(r => r.topTreatment === baseTop.topTreatment).length;
    const msg = stableCount === tableRows.length
      ? `The top treatment stays the same (${baseTop.topTreatment}) across all sensitivity checks.`
      : `The top treatment changes in ${tableRows.length - stableCount} of ${tableRows.length} checks. Base case top treatment is ${baseTop.topTreatment}.`;
    $('sensitivitySummaryText').textContent = msg;
    if(!silent) showToast('Sensitivity updated.', 'success');
  }

  function computeScenarioRanking(s){
    const price = Math.max(0, Number(s.price));
    const years = Math.max(1, Math.round(Number(s.years)));
    const r = Math.max(0, Number(s.discountPct)/100);
    const DF = discountFactor(r, years);

    // Recompute NPV for each treatment using mean yield and mean cost
    const rows = state.analysis.all.map(a => {
      const pvB = (a.meanYield === null) ? null : a.meanYield * price * DF;
      const pvC = (a.meanCost === null) ? null : a.meanCost * DF;
      const npv = (pvB === null || pvC === null) ? null : pvB - pvC;
      return { treatment: a.treatment, isControl: a.isControl, npv };
    });

    const control = rows.find(rw => rw.treatment === state.analysis.controlName) || rows.find(rw => rw.isControl);
    const treated = rows.filter(rw => !rw.isControl).slice().sort((a,b) => (b.npv ?? -Infinity) - (a.npv ?? -Infinity));
    const top = treated[0] || null;
    const topDelta = (!top || !control || top.npv === null || control.npv === null) ? null : (top.npv - control.npv);

    return {
      scenario: s.name,
      price,
      years,
      discountPct: r * 100,
      topTreatment: top ? top.treatment : '-',
      topNpv: top ? top.npv : null,
      topDeltaNpv: topDelta
    };
  }

  function buildReplicateView(cleaned){
    // Keep it simple: replicate table with treatment, is_control, yield, cost
    return cleaned.map(r => ({
      treatment: r.__canon.treatment_name,
      is_control: r.__canon.is_control ? 'TRUE' : 'FALSE',
      yield_t_ha: r.__canon.yield_t_ha,
      total_cost_per_ha: r.__canon.total_cost_per_ha
    }));
  }

  // ---------- Rendering ----------
  function renderIssues(messages, overwrite=false){
    const panel = $('validatePanel');
    const list = $('previewIssues');
    if(overwrite) list.innerHTML = '';
    messages.forEach(m => {
      const div = document.createElement('div');
      div.className = 'issue bad';
      div.textContent = m;
      list.appendChild(div);
    });
    panel.hidden = false;
  }

  function renderPreview(){
    const panel = $('validatePanel');
    const summary = $('previewSummary');
    const issuesEl = $('previewIssues');
    const mapEl = $('mappingDetails');

    panel.hidden = false;
    issuesEl.innerHTML = '';
    summary.innerHTML = '';
    mapEl.textContent = '';

    const counts = computeCounts(state.cleanedRows);
    const detected = [
      `Detected columns: ${state.headers.length}`,
      `Rows: ${counts.rows}`,
      `Unique treatments: ${counts.treatments}`,
      `Control labels found: ${counts.controls}`
    ];
    detected.forEach(t => {
      const d = document.createElement('div');
      d.textContent = t;
      summary.appendChild(d);
    });

    const mapLines = REQUIRED_CANON.map(k => {
      const v = state.mapping[k];
      return `${k}  <=  ${v ? v : '(not matched)'}`;
    }).join('\n');
    mapEl.textContent = mapLines;

    // issues: mapping + unit warnings + minimum checks
    const mappingMissing = REQUIRED_CANON.filter(k => !state.mapping[k]);
    if(mappingMissing.length){
      addIssue('warn', `Some required fields were not matched automatically: ${mappingMissing.join(', ')}. Use the template, or accept mapping and then check the results.`);
    } else {
      addIssue('good', 'Required fields matched. You can upload and run analysis.');
    }

    state.issues.forEach(it => addIssue(it.level, it.text));

    const mins = validateMinimum(state.cleanedRows);
    mins.forEach(m => addIssue('bad', m));

    renderMiniPreview();

    function addIssue(level, text){
      const div = document.createElement('div');
      div.className = `issue ${level === 'good' ? 'good' : (level === 'bad' ? 'bad' : 'warn')}`;
      div.textContent = text;
      issuesEl.appendChild(div);
    }
  }

  function renderMiniPreview(){
    const wrap = $('dataPreviewTable');
    const status = $('mappingStatus');
    if(!wrap || !status) return;
    wrap.innerHTML = '';
    status.innerHTML = '';

    // Mapping status chips
    REQUIRED_CANON.forEach(k => {
      const matched = !!state.mapping[k];
      const chip = document.createElement('div');
      chip.className = `badge-mini ${matched ? 'ok' : 'miss'}`;
      chip.textContent = matched ? `${k} ✓` : `${k} missing`;
      status.appendChild(chip);
    });

    // Mini table: canonical columns (in order), first 8 rows
    const rows = (state.cleanedRows || []).slice(0, 8);
    if(!rows.length){
      wrap.innerHTML = '<div class="muted">No rows to preview.</div>';
      return;
    }
    const headers = REQUIRED_CANON;
    const body = rows.map(r => {
      const c = r.__canon || {};
      const vals = [
        c.treatment_name ?? '',
        c.is_control ? 'TRUE' : 'FALSE',
        (c.yield_t_ha === null || c.yield_t_ha === undefined) ? '' : fmtNum(c.yield_t_ha, 3),
        (c.total_cost_per_ha === null || c.total_cost_per_ha === undefined) ? '' : fmtNum(c.total_cost_per_ha, 2)
      ];
      return `<tr>${vals.map(v => `<td>${escapeHtml(String(v))}</td>`).join('')}</tr>`;
    }).join('');
    wrap.innerHTML = `
      <table>
        <thead><tr>${headers.map(h=>`<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>
        <tbody>${body}</tbody>
      </table>
    `;
  }

  function renderAssumptions(){
    const box = $('assumptionsBoxHome');
    if(!box) return;
    const s = state.settings;
    box.innerHTML = '';
    box.appendChild(row('Grain price', `$${fmtMoney(s.pricePerT)} per tonne`));
    box.appendChild(row('Years', `${s.years}`));
    box.appendChild(row('Discount rate', `${fmtNum(s.discountPct,1)}%`));
    box.appendChild(row("Yield units", s.yieldInKg ? "t/ha (converted from kg/ha)" : "t/ha"));
    function row(label, value){
      const div = document.createElement('div');
      div.className = 'row';
      div.innerHTML = `<span>${label}</span><strong>${value}</strong>`;
      return div;
    }
  }

  function renderResults(){
    if(!state.analysis){
      $('leaderboardWrap').innerHTML = '';
      $('detailTableWrap').innerHTML = '';
      $('replicateTableWrap').innerHTML = '';
      return;
    }
    const a = state.analysis;

    // Summary
    const top = a.leaderboard[0];
    $('topTreatment').textContent = top ? top.treatment : '-';
    $('controlNameResult').textContent = a.controlName || '-';

    if(top && a.control){
      const d = top.deltaNpv;
      $('topDeltaNpv').textContent = d === null ? '-' : `$${fmtMoney(d)}`;
      $('topTreatmentWhy').textContent = `Higher net present value than the control over ${a.years} years at ${fmtNum(a.r*100,1)}% discount rate.`;
    } else {
      $('topDeltaNpv').textContent = '-';
      $('topTreatmentWhy').textContent = '-';
    }


    // Farmer friendly interpretation (single paragraph)
    const tEl = $('farmerInterpretationText');
    if(tEl){
      if(top && a.control){
        const bestName = top.treatment;
        const bestGain = top.deltaNpv;
        const selName = state.selectedTreatment || bestName;
        const sel = a.byName ? a.byName[selName] : null;
        const dy = sel && a.control ? (sel.meanYield - a.control.meanYield) : null;
        const dc = sel && a.control ? (sel.meanCost - a.control.meanCost) : null;
        const dnet = sel ? sel.deltaNpv : null;

        const parts = [];
        parts.push(`Best option: ${bestName}.`);
        if(bestGain !== null){
          const sign = bestGain >= 0 ? 'gain' : 'loss';
          parts.push(`Estimated ${sign} of $${fmtMoney(Math.abs(bestGain))} per hectare compared with the control (present value).`);
        }
        if(selName && selName !== bestName && dnet !== null){
          const sign = dnet >= 0 ? 'better' : 'worse';
          parts.push(`Selected treatment: ${selName} is $${fmtMoney(Math.abs(dnet))} per hectare ${sign} than the control.`);
        }
        if(dy !== null && dc !== null){
          const yWord = dy >= 0 ? 'higher' : 'lower';
          const cWord = dc >= 0 ? 'higher' : 'lower';
          parts.push(`Compared with the control, yield is ${Math.abs(dy).toFixed(2)} t/ha ${yWord} and cost is $${Math.abs(dc).toFixed(0)} per hectare ${cWord}.`);
        }
        parts.push(`Most important assumption: grain price ($${fmtMoney(a.price)} per tonne).`);
        if(a.indicative){
          parts.push('Confidence: indicative, check the top fixes under the readiness badge.');
        } else {
          parts.push('Confidence: good to use for decisions under these assumptions.');
        }
        tEl.textContent = parts.join(' ');
      } else {
        tEl.textContent = 'Upload a file and run analysis to see a plain language summary here.';
      }
    }
    setConfidenceLine();
    // Leaderboard table
    $('leaderboardWrap').innerHTML = tableHtml(
      ['Rank','Treatment','Replicates','NPV ($/ha)','Difference vs control ($/ha)','BCR'],
      a.leaderboard.map((r, idx) => [
        String(idx+1),
        r.treatment,
        String(r.n),
        numCell(r.npv),
        numCell(r.deltaNpv),
        numCell(r.bcr, 2)
      ])
    );

    // Make leaderboard rows selectable
    const lb = $('leaderboardWrap').querySelector('table');
    if(lb){
      lb.querySelectorAll('tbody tr').forEach((tr) => {
        tr.tabIndex = 0;
        tr.addEventListener('click', () => {
          const name = tr.querySelector('td:nth-child(2)')?.textContent;
          if(name){
            state.selectedTreatment = name;
            const pick = $('treatmentPick');
            if(pick) pick.value = name;
            renderDeltaCard();
          }
        });
        tr.addEventListener('keydown', (e) => {
          if(e.key === 'Enter' || e.key === ' '){
            e.preventDefault();
            tr.click();
          }
        });
      });
    }

    // Treatment picker
    const pick = $('treatmentPick');
    if(pick){
      pick.innerHTML = '';
      const names = a.leaderboard.map(x => x.treatment);
      names.forEach(n => {
        const o = document.createElement('option');
        o.value = n;
        o.textContent = n;
        pick.appendChild(o);
      });
      if(!state.selectedTreatment || !names.includes(state.selectedTreatment)){
        state.selectedTreatment = names[0] || '';
      }
      pick.value = state.selectedTreatment;
    }
    renderDeltaCard();

    // Compare selectors
    const cA = $('compareA');
    const cB = $('compareB');
    if(cA && cB){
      const namesAll = a.leaderboard.map(x => x.treatment);
      cA.innerHTML = '';
      cB.innerHTML = '';
      namesAll.forEach(n => {
        const oa = document.createElement('option'); oa.value = n; oa.textContent = n; cA.appendChild(oa);
        const ob = document.createElement('option'); ob.value = n; ob.textContent = n; cB.appendChild(ob);
      });
      cA.value = namesAll[0] || '';
      cB.value = namesAll[1] || namesAll[0] || '';
      const evt = new Event('change');
      cA.dispatchEvent(evt);
    }

    // Detail table
    $('detailTableWrap').innerHTML = tableHtml(
      ['Treatment','Control?','Replicates','Mean yield (t/ha)','Mean cost ($/ha)','PV benefits','PV costs','NPV','BCR','ROI (%)','ΔNPV vs control'],
      a.all
        .slice()
        .sort((x,y)=> (y.npv??-Infinity) - (x.npv??-Infinity))
        .map(r => [
          r.treatment,
          r.isControl ? 'Yes' : 'No',
          String(r.n),
          numCell(r.meanYield, 2),
          numCell(r.meanCost, 0),
          numCell(r.pvBenefit, 0),
          numCell(r.pvCost, 0),
          numCell(r.npv, 0),
          numCell(r.bcr, 2),
          numCell(r.roi, 1),
          numCell(r.deltaNpv, 0)
        ])
    );

    // Replicate view
    $('replicateTableWrap').innerHTML = tableHtml(
      ['Treatment','Control?','Yield (t/ha)','Total cost ($/ha)'],
      a.replicate.map(r => [
        r.treatment,
        r.is_control,
        numCell(r.yield_t_ha, 2),
        numCell(r.total_cost_per_ha, 0)
      ]),
      true
    );

    renderCharts();
    updateFooter();
  }

  function renderDeltaCard(){
    if(!state.analysis || !state.analysis.control){
      $('deltaYield').textContent = '-';
      $('deltaCost').textContent = '-';
      $('deltaNet').textContent = '-';
      return;
    }
    const a = state.analysis;
    const tName = state.selectedTreatment || (a.leaderboard[0]?.treatment);
    const t = a.all.find(x => x.treatment === tName);
    if(!t){
      $('deltaYield').textContent = '-';
      $('deltaCost').textContent = '-';
      $('deltaNet').textContent = '-';
      return;
    }
    const dy = (t.meanYield === null || a.control.meanYield === null) ? null : (t.meanYield - a.control.meanYield);
    const dc = (t.meanCost === null || a.control.meanCost === null) ? null : (t.meanCost - a.control.meanCost);
    const dn = t.deltaNpv;
    $('deltaYield').textContent = dy === null ? '-' : `${dy >= 0 ? '+' : ''}${fmtNum(dy,2)} t/ha`;
    $('deltaCost').textContent = dc === null ? '-' : `${dc >= 0 ? '+' : ''}$${fmtMoney(dc)}`;
    $('deltaNet').textContent = dn === null ? '-' : `${dn >= 0 ? '+' : ''}$${fmtMoney(dn)}`;

    // Update plain language summary when selection changes
    const tEl = $('farmerInterpretationText');
    if(tEl && state.analysis && state.analysis.control){
      const a2 = state.analysis;
      const top2 = a2.leaderboard[0];
      const selName = state.selectedTreatment || (top2 ? top2.treatment : '');
      const sel = a2.byName ? a2.byName[selName] : null;
      if(top2 && sel){
        const bestName = top2.treatment;
        const bestGain = top2.deltaNpv;
        const parts = [];
        parts.push(`Best option: ${bestName}.`);
        if(bestGain !== null){
          const sign = bestGain >= 0 ? 'gain' : 'loss';
          parts.push(`Estimated ${sign} of $${fmtMoney(Math.abs(bestGain))} per hectare compared with the control (present value).`);
        }
        if(selName && selName !== bestName && sel.deltaNpv !== null){
          const sign = sel.deltaNpv >= 0 ? 'better' : 'worse';
          parts.push(`Selected treatment: ${selName} is $${fmtMoney(Math.abs(sel.deltaNpv))} per hectare ${sign} than the control.`);
        }
        parts.push(`Most important assumption: grain price ($${fmtMoney(a2.price)} per tonne).`);
        if(a2.indicative){
          parts.push('Confidence: indicative, check the top fixes under the readiness badge.');
        } else {
          parts.push('Confidence: good to use for decisions under these assumptions.');
        }
        tEl.textContent = parts.join(' ');
      }
    }

    // Keep the confidence line in sync with the selected treatment outcome.
    setConfidenceLine();

  }

  function renderSensitivity(rows){
    const wrap = $('sensitivityTableWrap');
    if(!wrap){
      return;
    }
    if(!rows || !rows.length){
      wrap.innerHTML = '';
      return;
    }
    wrap.innerHTML = tableHtml(
      ['Scenario','Price ($/t)','Years','Discount (%)','Top treatment','Top NPV ($/ha)','Top ΔNPV vs control ($/ha)'],
      rows.map(r => [
        r.scenario,
        numCell(r.price, 0),
        String(r.years),
        numCell(r.discountPct, 1),
        escapeHtml(r.topTreatment),
        numCell(r.topNpv, 0),
        numCell(r.topDeltaNpv, 0)
      ])
    );
  }

  function numCell(v, dp=0){
    if(v === null || v === undefined || Number.isNaN(Number(v))) return '<span class="muted">-</span>';
    const n = Number(v);
    return `<span class="num">${n.toLocaleString(undefined,{minimumFractionDigits:dp, maximumFractionDigits:dp})}</span>`;
  }

  function tableHtml(headers, rows, allowSmall=false){
    const th = headers.map(h => `<th>${escapeHtml(h)}</th>`).join('');
    const tr = rows.map(r => `<tr>${r.map((c,i)=> `<td class="${(String(headers[i]).includes('$')||String(headers[i]).includes('NPV')||String(headers[i]).includes('cost')||String(headers[i]).includes('yield')||String(headers[i]).includes('PV')||String(headers[i]).includes('BCR')||String(headers[i]).includes('ROI')||String(headers[i]).includes('Δ')) ? 'num':''}">${typeof c === 'string' ? c : escapeHtml(String(c))}</td>`).join('')}</tr>`).join('');
    const cls = allowSmall ? '' : '';
    return `<table class="${cls}"><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>`;
  }

  function escapeHtml(s){
    return String(s).replace(/[&<>"']/g, (m)=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));
  }

  // ---------- Charts (Canvas, no libs) ----------
  function renderCharts(){
    if(!state.analysis) return;
    drawDeltaNpvBars('chartDeltaNpv');
    drawMetricBars('chartNpv', 'npv', 'NPV by treatment', (v)=> '$' + Math.round(v).toLocaleString());
    drawMetricBars('chartBcr', 'bcr', 'BCR by treatment', (v)=> (v===null?'-':Number(v).toFixed(2)));
  }

  function canvasCtx(id, desiredCssHeight=null){
    const c = $(id);
    if(!c) return null;
    if(desiredCssHeight){
      c.style.height = `${desiredCssHeight}px`;
    }
    const ctx = c.getContext('2d');
    const ratio = window.devicePixelRatio || 1;
    const w = c.clientWidth || c.width;
    const h = c.clientHeight || c.height;
    c.width = Math.max(1, Math.round(w * ratio));
    c.height = Math.max(1, Math.round(h * ratio));
    ctx.setTransform(ratio,0,0,ratio,0,0);
    ctx.clearRect(0,0,w,h);
    ctx.font = '12px system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif';
    ctx.fillStyle = '#111827';
    ctx.textBaseline = 'alphabetic';
    return {ctx, w, h};
  }

  function niceTicks(min, max, target=5){
    if(!isFinite(min) || !isFinite(max)) return {min:0,max:1,ticks:[0,1]};
    if(min === max){
      const bump = (Math.abs(min) || 1) * 0.1;
      min -= bump; max += bump;
    }
    const span = max - min;
    const step0 = span / Math.max(1, target);
    const pow10 = Math.pow(10, Math.floor(Math.log10(Math.abs(step0))));
    const err = step0 / pow10;
    let step;
    if(err >= 5) step = 5 * pow10;
    else if(err >= 2) step = 2 * pow10;
    else step = 1 * pow10;
    const niceMin = Math.floor(min / step) * step;
    const niceMax = Math.ceil(max / step) * step;
    const ticks = [];
    for(let v = niceMin; v <= niceMax + step*0.5; v += step) ticks.push(v);
    return {min:niceMin, max:niceMax, ticks};
  }

  function drawTitle(ctx, w, text){
    ctx.save();
    ctx.fillStyle = '#111827';
    ctx.font = '700 14px system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif';
    ctx.fillText(text, 12, 20);
    ctx.restore();
  }

  function wrapText(ctx, text, maxWidth){
    const words = String(text).split(/\s+/);
    const lines = [];
    let line = '';
    for(const w of words){
      const test = line ? (line + ' ' + w) : w;
      if(ctx.measureText(test).width <= maxWidth) line = test;
      else {
        if(line) lines.push(line);
        line = w;
      }
    }
    if(line) lines.push(line);
    return lines;
  }

  function drawAxisLabels(ctx, w, h, pad, xLabel, yLabel){
    ctx.save();
    ctx.fillStyle = '#4B5563';
    ctx.font = '11px system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif';
    if(xLabel){
      const tw = ctx.measureText(xLabel).width;
      ctx.fillText(xLabel, pad + (w - pad*2 - tw)/2, h - 8);
    }
    if(yLabel){
      ctx.translate(12, pad + (h - pad*2)/2);
      ctx.rotate(-Math.PI/2);
      const tw2 = ctx.measureText(yLabel).width;
      ctx.fillText(yLabel, -tw2/2, 0);
    }
    ctx.restore();
  }

  function drawYAxisTicks(ctx, w, h, pad, tinfo, formatter){
    ctx.save();
    ctx.strokeStyle = '#E5E7EB';
    ctx.fillStyle = '#6B7280';
    ctx.lineWidth = 1;
    ctx.font = '11px system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif';
    const innerH = h - pad*2;
    const denom = (tinfo.max - tinfo.min) || 1;
    tinfo.ticks.forEach(v => {
      const y = pad + (tinfo.max - v) / denom * innerH;
      ctx.beginPath();
      ctx.moveTo(pad, y);
      ctx.lineTo(w - pad, y);
      ctx.stroke();
      const label = formatter ? formatter(v) : String(v);
      ctx.fillText(label, 6, y + 4);
    });
    ctx.restore();
  }

  function drawLegend(ctx, items, x, y){
    ctx.save();
    ctx.font = '11px system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif';
    ctx.fillStyle = '#374151';
    let cx = x;
    items.forEach(it => {
      ctx.fillStyle = it.color;
      ctx.fillRect(cx, y-9, 10, 10);
      ctx.fillStyle = '#374151';
      ctx.fillText(it.label, cx + 14, y);
      cx += 14 + ctx.measureText(it.label).width + 16;
    });
    ctx.restore();
  }

  function drawAxes(ctx, w, h, pad){
    ctx.strokeStyle = '#D1D5DB';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad, pad);
    ctx.lineTo(pad, h-pad);
    ctx.lineTo(w-pad, h-pad);
    ctx.stroke();
  }

  function drawDeltaNpvBars(canvasId){
    if(!state.analysis) return;

    const all = state.analysis.all
      .filter(r => r.isControl !== true)
      .filter(r => r.deltaNpv !== null && isFinite(r.deltaNpv));

    const rows = all.slice().sort((a,b)=> (b.deltaNpv??-Infinity)-(a.deltaNpv??-Infinity));
    const top = rows.slice(0, 12);
    const desiredH = Math.min(900, 140 + rows.length * 34);
    const pack = canvasCtx(canvasId, Math.min(900, 140 + top.length * 34));
    if(!pack) return;
    const {ctx, w, h} = pack;

    drawTitle(ctx, w, 'NPV difference vs control (top treatments)');
    if(!top.length){
      ctx.fillStyle = '#374151';
      ctx.fillText('No treatment results to plot yet. Run analysis first.', 12, 50);
      return;
    }

    const padL = 232;
    const padR = 28;
    const padT = 56;
    const padB = 52;
    const innerW = w - padL - padR;
    const innerH = h - padT - padB;
    const vals = top.map(r => r.deltaNpv);
    const tinfo = niceTicks(Math.min(...vals, 0), Math.max(...vals, 0), 5);
    const denom = (tinfo.max - tinfo.min) || 1;

    // Grid and tick labels
    ctx.save();
    ctx.strokeStyle = '#E5E7EB';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#6B7280';
    ctx.font = '11px system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif';
    tinfo.ticks.forEach(v => {
      const x = padL + (v - tinfo.min) / denom * innerW;
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, padT + innerH);
      ctx.stroke();
      ctx.textAlign = 'center';
      ctx.fillText('$' + Math.round(v).toLocaleString(), x, padT + innerH + 22);
    });
    ctx.restore();

    // Zero line
    const x0 = padL + (0 - tinfo.min) / denom * innerW;
    ctx.save();
    ctx.strokeStyle = '#9CA3AF';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x0, padT);
    ctx.lineTo(x0, padT + innerH);
    ctx.stroke();
    ctx.restore();

    const rowH = Math.max(20, innerH / top.length);
    top.forEach((r, i) => {
      const y = padT + i * rowH + 6;
      const barH = Math.max(12, rowH - 12);
      const xV = padL + (r.deltaNpv - tinfo.min) / denom * innerW;
      const left = Math.min(x0, xV);
      const width = Math.max(1, Math.abs(xV - x0));
      ctx.fillStyle = r.deltaNpv >= 0 ? '#2563EB' : '#B91C1C';
      ctx.fillRect(left, y, width, barH);

      // Treatment name (wrapped)
      ctx.save();
      ctx.font = '12px system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif';
      ctx.fillStyle = '#111827';
      ctx.textAlign = 'right';
      const lines = wrapText(ctx, String(r.treatment), padL - 18).slice(0, 2);
      const baseY = y + barH/2 + (lines.length === 2 ? -4 : 4);
      lines.forEach((ln,k)=> ctx.fillText(ln, padL - 12, baseY + k*14));

      // Value label
      ctx.textAlign = 'left';
      ctx.fillStyle = '#374151';
      const valTxt = (r.deltaNpv >= 0 ? '+' : '') + '$' + Math.round(r.deltaNpv).toLocaleString();
      const xLabel = Math.min(w - padR - 6, left + width + 10);
      ctx.fillText(valTxt, xLabel, y + barH/2 + 4);
      ctx.restore();
    });

    // Axis label
    ctx.save();
    ctx.fillStyle = '#4B5563';
    ctx.font = '11px system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('NPV difference relative to control ($ per ha, present value)', padL + innerW/2, h - 14);
    ctx.restore();
  }

  function drawMetricBars(canvasId, key, title, fmt){
    if(!state.analysis) return;
    const all = state.analysis.all
      .filter(r => r[key] !== null && r[key] !== undefined && isFinite(r[key]));
    if(!all.length){
      const pack0 = canvasCtx(canvasId, 220);
      if(!pack0) return;
      const {ctx, w} = pack0;
      drawTitle(ctx, w, title);
      ctx.fillStyle = '#374151';
      ctx.fillText('No results to plot yet.', 12, 50);
      return;
    }
    const rows = all.slice().sort((a,b)=> (b[key]??-Infinity)-(a[key]??-Infinity)).slice(0, 12);
    const pack = canvasCtx(canvasId, Math.min(860, 140 + rows.length * 34));
    if(!pack) return;
    const {ctx, w, h} = pack;
    drawTitle(ctx, w, title);

    const padL = 232, padR = 28, padT = 56, padB = 52;
    const innerW = w - padL - padR;
    const innerH = h - padT - padB;
    const vals = rows.map(r=> Number(r[key]));
    const tinfo = niceTicks(Math.min(...vals, 0), Math.max(...vals), 5);
    const denom = (tinfo.max - tinfo.min) || 1;

    // grid
    ctx.save();
    ctx.strokeStyle = '#E5E7EB';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#6B7280';
    ctx.font = '11px system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif';
    tinfo.ticks.forEach(v => {
      const x = padL + (v - tinfo.min) / denom * innerW;
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, padT + innerH);
      ctx.stroke();
      ctx.textAlign = 'center';
      ctx.fillText(fmt(v), x, padT + innerH + 22);
    });
    ctx.restore();

    const x0 = padL + (0 - tinfo.min) / denom * innerW;
    ctx.save();
    ctx.strokeStyle = '#9CA3AF';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x0, padT);
    ctx.lineTo(x0, padT + innerH);
    ctx.stroke();
    ctx.restore();

    const rowH = Math.max(20, innerH / rows.length);
    rows.forEach((r,i)=>{
      const y = padT + i*rowH + 6;
      const barH = Math.max(12, rowH - 12);
      const v = Number(r[key]);
      const xV = padL + (v - tinfo.min) / denom * innerW;
      const left = Math.min(x0, xV);
      const width = Math.max(1, Math.abs(xV - x0));
      ctx.fillStyle = '#2563EB';
      ctx.fillRect(left, y, width, barH);

      ctx.save();
      ctx.font = '12px system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif';
      ctx.fillStyle = '#111827';
      ctx.textAlign = 'right';
      const lines = wrapText(ctx, String(r.treatment), padL - 18).slice(0, 2);
      const baseY = y + barH/2 + (lines.length === 2 ? -4 : 4);
      lines.forEach((ln,k)=> ctx.fillText(ln, padL - 12, baseY + k*14));
      ctx.textAlign = 'left';
      ctx.fillStyle = '#374151';
      const xLabel = Math.min(w - padR - 6, left + width + 10);
      ctx.fillText(fmt(v), xLabel, y + barH/2 + 4);
      ctx.restore();
    });
  }

  function drawBenefitsCosts(canvasId){
    if(!state.analysis) return;

    const all = state.analysis.all
      .filter(r => r.pvBenefit !== null && r.pvCost !== null)
      .slice()
      .sort((a,b)=> (b.npv??-Infinity)-(a.npv??-Infinity));

    const rows = all.slice(0, 10);
    const desiredH = Math.min(900, 140 + rows.length * 34);
    const pack = canvasCtx(canvasId, desiredH);
    if(!pack) return;
    const {ctx, w, h} = pack;

    drawTitle(ctx, w, 'Benefits and costs (present value, top 10 treatments)');
    if(!rows.length){
      ctx.fillStyle = '#374151';
      ctx.fillText('No results to plot yet. Run analysis first.', 12, 50);
      return;
    }

    const padL = 232;
    const padR = 28;
    const padT = 56;
    const padB = 52;
    const innerW = w - padL - padR;
    const innerH = h - padT - padB;
    const maxV = Math.max(...rows.map(r => Math.max(r.pvBenefit, r.pvCost)));
    const tinfo = niceTicks(0, maxV, 5);
    const denom = (tinfo.max - tinfo.min) || 1;

    // grid
    ctx.save();
    ctx.strokeStyle = '#E5E7EB';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#6B7280';
    ctx.font = '11px system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif';
    tinfo.ticks.forEach(v => {
      const x = padL + (v - tinfo.min) / denom * innerW;
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, padT + innerH);
      ctx.stroke();
      ctx.textAlign = 'center';
      ctx.fillText('$' + Math.round(v).toLocaleString(), x, padT + innerH + 22);
    });
    ctx.restore();

    drawLegend(ctx, [
      {label:'Benefits', color:'#93C5FD'},
      {label:'Costs', color:'#0B4A8B'}
    ], padL, padT - 18);

    const rowH = Math.max(20, innerH / rows.length);
    rows.forEach((r, i) => {
      const y = padT + i * rowH + 6;
      const barH = Math.max(12, rowH - 12);
      const bW = (r.pvBenefit / (tinfo.max || 1)) * innerW;
      const cW = (r.pvCost / (tinfo.max || 1)) * innerW;
      ctx.fillStyle = '#93C5FD';
      ctx.fillRect(padL, y, Math.max(1, bW), barH);
      ctx.fillStyle = '#0B4A8B';
      ctx.fillRect(padL, y + barH*0.58, Math.max(1, cW), Math.max(2, barH*0.42));

      ctx.save();
      ctx.font = '12px system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif';
      ctx.fillStyle = '#111827';
      ctx.textAlign = 'right';
      const lines = wrapText(ctx, String(r.treatment), padL - 18).slice(0, 2);
      const baseY = y + barH/2 + (lines.length === 2 ? -4 : 4);
      lines.forEach((ln,k)=> ctx.fillText(ln, padL - 12, baseY + k*14));

      ctx.textAlign = 'left';
      ctx.fillStyle = '#374151';
      ctx.fillText('B $' + Math.round(r.pvBenefit).toLocaleString(), padL + Math.min(innerW - 150, bW + 10), y + 14);
      ctx.fillText('C $' + Math.round(r.pvCost).toLocaleString(), padL + Math.min(innerW - 150, cW + 10), y + barH - 2);
      ctx.restore();
    });

    ctx.save();
    ctx.fillStyle = '#4B5563';
    ctx.font = '11px system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Present value ($ per ha)', padL + innerW/2, h - 14);
    ctx.restore();
  }

  function drawScatter(canvasId){
    const pack = canvasCtx(canvasId);
    if(!pack) return;
    const {ctx, w, h} = pack;
    const pad = 56;
    drawTitle(ctx, w, 'Mean yield versus mean cost');
    drawAxes(ctx,w,h,pad);

    const rows = state.analysis.all.filter(r => r.meanYield !== null && r.meanCost !== null);
    if(!rows.length){
      ctx.fillText('No data to plot.', pad, pad+14);
      return;
    }
    const minX = Math.min(...rows.map(r => r.meanCost));
    const maxX = Math.max(...rows.map(r => r.meanCost));
    const minY = Math.min(...rows.map(r => r.meanYield));
    const maxY = Math.max(...rows.map(r => r.meanYield));
    const xTicks = niceTicks(minX, maxX, 4);
    const yTicks = niceTicks(minY, maxY, 5);
    drawYAxisTicks(ctx, w, h, pad, yTicks, (v)=> v.toFixed(1));

    // x ticks
    ctx.save();
    ctx.strokeStyle = '#E5E7EB';
    ctx.fillStyle = '#6B7280';
    ctx.lineWidth = 1;
    ctx.font = '11px system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif';
    const innerW = w - pad*2;
    const innerH = h - pad*2;
    const xDen = (xTicks.max - xTicks.min) || 1;
    xTicks.ticks.forEach(v => {
      const x = pad + (v - xTicks.min) / xDen * innerW;
      ctx.beginPath();
      ctx.moveTo(x, h - pad);
      ctx.lineTo(x, pad);
      ctx.stroke();
      ctx.textAlign = 'center';
      ctx.fillText('$' + Math.round(v).toLocaleString(), x, h - pad + 16);
    });
    ctx.restore();

    const sx = (xTicks.max-xTicks.min)||1;
    const sy = (yTicks.max-yTicks.min)||1;

    rows.forEach(r => {
      const x = pad + (r.meanCost - xTicks.min) / sx * innerW;
      const y = pad + (yTicks.max - r.meanYield) / sy * innerH;
      ctx.fillStyle = r.isControl ? '#0B4A8B' : '#2563EB';
      ctx.beginPath();
      ctx.arc(x, y, r.isControl ? 5 : 4, 0, Math.PI*2);
      ctx.fill();

      // highlight control point
      if(r.isControl){
        ctx.strokeStyle = '#0B4A8B';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, 7, 0, Math.PI*2);
        ctx.stroke();
      }
    });

    drawLegend(ctx, [
      {label:'Control', color:'#0B4A8B'},
      {label:'Treatment', color:'#2563EB'}
    ], pad, pad-18);
    drawAxisLabels(ctx, w, h, pad, 'Total cost ($ per ha, mean)', 'Yield (t per ha, mean)');
  }

  function drawSpread(canvasId){
    const aggsAll = aggregateByTreatment(state.cleanedRows)
      .filter(a => a.yields && a.yields.length)
      .slice();

    // Focus on the control and the most relevant treatments to keep labels readable.
    aggsAll.sort((a,b)=> (b.meanYield??-Infinity)-(a.meanYield??-Infinity));
    const aggs = aggsAll.slice(0, 10);
    const desiredH = Math.min(900, 140 + aggs.length * 34);
    const pack = canvasCtx(canvasId, desiredH);
    if(!pack) return;
    const {ctx, w, h} = pack;

    drawTitle(ctx, w, 'Replicate yield range (min to max, with mean)');
    if(!aggs.length){
      ctx.fillStyle = '#374151';
      ctx.fillText('No replicate yield values to plot.', 12, 50);
      return;
    }

    const mins = aggs.map(a => Math.min(...a.yields));
    const maxs = aggs.map(a => Math.max(...a.yields));
    const minY = Math.min(...mins);
    const maxY = Math.max(...maxs);
    const xTicks = niceTicks(minY, maxY, 5);

    const padL = 232;
    const padR = 28;
    const padT = 56;
    const padB = 52;
    const innerW = w - padL - padR;
    const innerH = h - padT - padB;
    const denom = (xTicks.max - xTicks.min) || 1;

    // grid and x tick labels
    ctx.save();
    ctx.strokeStyle = '#E5E7EB';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#6B7280';
    ctx.font = '11px system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif';
    xTicks.ticks.forEach(v => {
      const x = padL + (v - xTicks.min) / denom * innerW;
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, padT + innerH);
      ctx.stroke();
      ctx.textAlign = 'center';
      ctx.fillText(v.toFixed(1), x, padT + innerH + 22);
    });
    ctx.restore();

    drawLegend(ctx, [
      {label:'Control', color:'#0B4A8B'},
      {label:'Treatment', color:'#2563EB'}
    ], padL, padT - 18);

    const rowH = Math.max(20, innerH / aggs.length);
    aggs.forEach((a, i) => {
      const y = padT + i * rowH + 6;
      const barH = Math.max(12, rowH - 12);
      const yMin = Math.min(...a.yields);
      const yMax = Math.max(...a.yields);
      const xMin = padL + (yMin - xTicks.min) / denom * innerW;
      const xMax = padL + (yMax - xTicks.min) / denom * innerW;
      const xMean = padL + (a.meanYield - xTicks.min) / denom * innerW;

      ctx.save();
      ctx.strokeStyle = a.isControl ? '#0B4A8B' : '#2563EB';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(xMin, y + barH/2);
      ctx.lineTo(xMax, y + barH/2);
      ctx.stroke();

      ctx.fillStyle = a.isControl ? '#0B4A8B' : '#2563EB';
      ctx.beginPath();
      ctx.arc(xMean, y + barH/2, 4.5, 0, Math.PI*2);
      ctx.fill();

      // treatment label
      ctx.font = '12px system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif';
      ctx.fillStyle = '#111827';
      ctx.textAlign = 'right';
      const lines = wrapText(ctx, String(a.treatment), padL - 18).slice(0, 2);
      const baseY = y + barH/2 + (lines.length === 2 ? -4 : 4);
      lines.forEach((ln,k)=> ctx.fillText(ln, padL - 12, baseY + k*14));
      ctx.restore();
    });

    ctx.save();
    ctx.fillStyle = '#4B5563';
    ctx.font = '11px system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Yield (t per ha)', padL + innerW/2, h - 14);
    ctx.restore();
  }

  // ---------- AI prompt builders (prompt only mode) ----------
  function buildBriefPrompt(){
    if(!state.analysis){
      $('briefPrompt').value = '';
      return;
    }
    const a = state.analysis;
    const top = a.leaderboard[0];
    const lines = [];

    lines.push('You are writing a practical policy brief for a grower group and extension audience.');
    lines.push('Use clear headings and short paragraphs. Keep it farmer-focused and decision-ready.');
    lines.push('Include one compact table plus a short sensitivity paragraph.');
    lines.push('');
    lines.push('Context');
    lines.push('This brief summarises an economic comparison of trial treatments against a control using replicated plot data.');
    lines.push('Benefits are valued using grain price and yield differences, then discounted over time; costs use total cost per hectare.');
    lines.push('');
    lines.push('Assumptions used');
    lines.push(`Grain price: $${a.price} per tonne`);
    lines.push(`Years: ${a.years}`);
    lines.push(`Discount rate: ${(a.r*100).toFixed(1)}%`);
    lines.push(`Reference control: ${a.controlName}`);
    lines.push(`Data readiness: ${String(state.readinessLevel || '').toUpperCase()} (use this to qualify strength of conclusions)`);
    lines.push('');
    lines.push('Key result');
    if(top && a.control){
      lines.push(`Top treatment: ${top.treatment}.`);
      lines.push(`Net present value difference vs control: $${Math.round(top.deltaNpv).toLocaleString()} per hectare.`);
      lines.push(`Interpretation: Under the stated assumptions, this treatment delivers the strongest net economic return relative to the control.`);
      lines.push('Add one sentence on what drives the result (yield lift vs cost change) using the mean differences shown below.');
    } else {
      lines.push('Top treatment could not be identified. Explain data limitations and what is needed.');
    }

    // Selected treatment (if user has picked one)
    const selName = state.selectedTreatment || (top ? top.treatment : null);
    const sel = (selName && a.byName) ? a.byName[selName] : null;
    if(sel && a.control){
      const dy = (sel.meanYield !== null && a.control.meanYield !== null) ? (sel.meanYield - a.control.meanYield) : null;
      const dc = (sel.meanCost !== null && a.control.meanCost !== null) ? (sel.meanCost - a.control.meanCost) : null;
      if(selName){
        lines.push(`Selected treatment for commentary: ${selName}.`);
        if(sel.deltaNpv !== null) lines.push(`Selected ΔNPV vs control: $${Math.round(sel.deltaNpv).toLocaleString()} per hectare.`);
        if(dy !== null) lines.push(`Selected yield difference vs control: ${dy.toFixed(2)} t/ha.`);
        if(dc !== null) lines.push(`Selected cost difference vs control: $${Math.round(dc).toLocaleString()} per hectare.`);
      }
    }
    lines.push('');
    lines.push('Include this table (values are per hectare, present value):');
    lines.push('Rank | Treatment | NPV | Difference vs control | BCR');
    a.leaderboard.slice(0,8).forEach((r, i) => {
      lines.push(`${i+1} | ${r.treatment} | ${Math.round(r.npv).toLocaleString()} | ${r.deltaNpv===null?'':Math.round(r.deltaNpv).toLocaleString()} | ${r.bcr===null?'':r.bcr.toFixed(2)}`);
    });
    lines.push('');
    lines.push('Explain what the numbers mean in plain language for farmers.');
    lines.push('Add a short note on data quality: replicates are averaged within treatment; missing/odd values can change rankings.');
    lines.push('Add a short sensitivity paragraph: does the top treatment change if grain price is 20% lower/higher, or if the discount rate changes?');
    lines.push('');
    lines.push('Format:');
    lines.push('Title, Why this matters, What was compared, Key findings, Results table, Sensitivity/robustness, What this means for farmers, Data and assumptions, Next steps.');

    $('briefPrompt').value = lines.join('\n');
  }

  function openPromptIn(urlBase){
    const prompt = $('briefPrompt').value || '';
    copyToClipboard(prompt);
    window.open(urlBase, '_blank', 'noopener,noreferrer');
    showToast('Prompt copied. Paste into the new window.', 'success');
  }

  async function copyToClipboard(text){
    try{
      await navigator.clipboard.writeText(text);
      return true;
    }catch(e){
      // fallback
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      return false;
    }

    // Keep confidence line in sync with the selected treatment.
    setConfidenceLine();
  }

  // ---------- Exports ----------
  function downloadBlob(filename, mime, content){
    const blob = new Blob([content], {type:mime});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(()=>URL.revokeObjectURL(url), 1000);
  }

  function exportCleanedTsv(){
    if(!state.cleanedRows.length){
      showToast('No cleaned data available yet.', 'warn');
      return;
    }
    // Export with original headers plus canonical fields appended (safe)
    const headers = state.headers.length ? state.headers : Object.keys(state.cleanedRows[0]).filter(k=>k!=='__canon');
    const canon = REQUIRED_CANON;
    const outHeaders = [...new Set([...headers, ...canon])];
    const lines = [];
    lines.push(`# Tool version: ${TOOL_VERSION}`);
    lines.push(`# Discounting: annual PV over ${state.settings.years}y at ${fmtNum(Number(state.settings.discountPct)||0,1)}%`);
    lines.push(`# Generated: ${new Date().toISOString()}`);
    lines.push(outHeaders.join('\t'));
    for(const r of state.cleanedRows){
      const row = {...r};
      row.treatment_name = r.__canon.treatment_name;
      row.is_control = r.__canon.is_control ? 'TRUE' : 'FALSE';
      row.yield_t_ha = r.__canon.yield_t_ha === null ? '' : String(r.__canon.yield_t_ha);
      row.total_cost_per_ha = r.__canon.total_cost_per_ha === null ? '' : String(r.__canon.total_cost_per_ha);
      const vals = outHeaders.map(h => escapeForTsv(row[h] ?? ''));
      lines.push(vals.join('\t'));
    }
    downloadBlob('cleaned_data.tsv', 'text/tab-separated-values;charset=utf-8', lines.join('\n'));
    showToast('Cleaned data downloaded.', 'success');
  }

  function escapeForTsv(v){
    const s = String(v ?? '');
    return s.replace(/\r?\n/g,' ');
  }

  function exportSummaryCsv(){
    if(!state.analysis){
      showToast('Run analysis first.', 'warn');
      return;
    }
    const headers = ['treatment','is_control','replicates','mean_yield_t_ha','mean_cost_per_ha','pv_benefit','pv_cost','npv','bcr','roi_pct','delta_npv_vs_control'];
    const lines = [headers.join(',')];
    for(const r of state.analysis.all){
      lines.push([
        csv(r.treatment),
        r.isControl ? 'TRUE' : 'FALSE',
        r.n,
        safe(r.meanYield),
        safe(r.meanCost),
        safe(r.pvBenefit),
        safe(r.pvCost),
        safe(r.npv),
        safe(r.bcr),
        safe(r.roi),
        safe(r.deltaNpv)
      ].join(','));
    }
    lines.push('');
    lines.push(`# Tool version: ${TOOL_VERSION}`);
    lines.push(`# Discounting: annual PV over ${state.analysis.years}y at ${fmtNum(state.analysis.r*100,1)}%`);
    lines.push(`# Generated: ${new Date().toISOString()}`);
    downloadBlob('summary_table.csv', 'text/csv;charset=utf-8', lines.join('\n'));
    showToast('Summary table downloaded.', 'success');
    function safe(x){ return (x===null||x===undefined||Number.isNaN(Number(x))) ? '' : String(Number(x)); }
    function csv(s){ const t = String(s??''); return `"${t.replace(/"/g,'""')}"`; }
  }

  function exportPolicyBriefDoc(){
    if(!state.analysis){
      showToast('Run analysis first.', 'warn');
      return;
    }
    const a = state.analysis;
    const top = a.leaderboard[0];
    const now = new Date().toISOString().slice(0,10);

    const selName = state.selectedTreatment || (top ? top.treatment : null);
    const sel = (selName && a.byName) ? a.byName[selName] : null;

    // Lightweight sensitivity block for the brief (farmer-facing, not over-technical)
    const sensScenarios = [
      { name: 'Base', price: a.price, years: a.years, discountPct: a.r * 100 },
      { name: 'Price -20%', price: a.price * 0.8, years: a.years, discountPct: a.r * 100 },
      { name: 'Price +20%', price: a.price * 1.2, years: a.years, discountPct: a.r * 100 },
      { name: 'Discount 0%', price: a.price, years: a.years, discountPct: 0 },
      { name: 'Discount 10%', price: a.price, years: a.years, discountPct: 10 }
    ];
    const sensRows = sensScenarios.map(s => computeScenarioRanking(s));
    const baseTop = sensRows.find(r => r.scenario === 'Base');
    const stable = sensRows.filter(r => r.topTreatment === (baseTop ? baseTop.topTreatment : '')).length;
    const sensMsg = baseTop
      ? (stable === sensRows.length
        ? `The top treatment stays the same (${escapeHtml(baseTop.topTreatment)}) across these checks.`
        : `The top treatment changes in ${sensRows.length - stable} of ${sensRows.length} checks (base case top is ${escapeHtml(baseTop.topTreatment)}).`)
      : 'Sensitivity could not be computed.';
    const sensTable = sensRows.map(r => `
      <tr>
        <td>${escapeHtml(r.scenario)}</td>
        <td style="text-align:right">$${fmtMoney(r.price)}</td>
        <td style="text-align:right">${r.discountPct.toFixed(1)}%</td>
        <td>${escapeHtml(r.topTreatment)}</td>
        <td style="text-align:right">${r.topDeltaNpv===null ? '-' : ('$'+fmtMoney(r.topDeltaNpv))}</td>
      </tr>
    `).join('');

    const tableRows = a.leaderboard.slice(0,8).map((r, i) => `
      <tr>
        <td>${i+1}</td>
        <td>${escapeHtml(r.treatment)}</td>
        <td style="text-align:right">$${fmtMoney(r.npv)}</td>
        <td style="text-align:right">${r.deltaNpv===null ? '-' : ('$'+fmtMoney(r.deltaNpv))}</td>
        <td style="text-align:right">${r.bcr===null ? '-' : r.bcr.toFixed(2)}</td>
      </tr>
    `).join('');

    const keyMsg = top
      ? `Top treatment is <strong>${escapeHtml(top.treatment)}</strong>. Under the stated assumptions, it delivers the strongest net return relative to the control.`
      : 'Top treatment could not be identified due to missing data.';
    const delta = (top && top.deltaNpv !== null) ? `$${fmtMoney(top.deltaNpv)} per hectare` : 'Not available';
    const recLine = (top && top.deltaNpv !== null)
      ? (top.deltaNpv >= 0
        ? `Recommendation: prioritise <strong>${escapeHtml(top.treatment)}</strong> for further on-farm validation, as it outperforms the control by ${delta} (present value).`
        : `Recommendation: do <strong>not</strong> prioritise the current top-ranked treatment without revisiting assumptions and data, because even the best option is worse than the control by ${delta} (present value).`)
      : 'Recommendation: revisit missing values and rerun the analysis.';

    const html = `
      <html><head><meta charset="utf-8">
      <style>
        body{font-family:Calibri,Arial,sans-serif; color:#111; line-height:1.35}
        h1{font-size:18pt; margin:0 0 6pt}
        h2{font-size:12pt; margin:14pt 0 6pt}
        p{margin:0 0 8pt}
        table{border-collapse:collapse; width:100%; margin-top:8pt}
        th,td{border:1px solid #D1D5DB; padding:6pt; font-size:10pt}
        th{background:#F3F4F6; text-align:left}
        .small{font-size:10pt; color:#444}
        .box{border:1px solid #D1D5DB; padding:10pt; border-radius:8pt; background:#F8FAFC}
      </style>
      </head><body>
        <h1>Economic comparison of trial treatments against a control</h1>
        <p class="small">Generated: ${now}. Results are per hectare (present value) over ${a.years} years.</p>

        <div class="box">
          <p><strong>Key message</strong></p>
          <p>${keyMsg}</p>
          <p><strong>Difference vs control (NPV)</strong>: ${delta}.</p>
          <p>${recLine}</p>
        </div>

        <h2>Why this matters</h2>
        <p>Growers and extension teams need simple, comparable numbers to decide which practices are worth trialling at scale. This brief translates replicated trial data into an apples-to-apples economic comparison against a clear reference (the control).</p>

        <h2>What was compared</h2>
        <p>Replicated plot data were averaged within each treatment. Each treatment average was compared to the reference control: <strong>${escapeHtml(a.controlName)}</strong>.</p>

        <h2>What this tool uses</h2>
        <p>Benefits are valued from yield (t/ha) and grain price ($/t). Costs use total cost per hectare ($/ha). Both are discounted over time to reflect that benefits and costs in later years are worth less than today.</p>

        <h2>Assumptions used</h2>
        <p>Grain price: $${fmtMoney(a.price)} per tonne. Discount rate: ${(a.r*100).toFixed(1)}% . Years: ${a.years}. Yield units: ${state.settings.yieldInKg ? "t/ha (converted from kg/ha)" : "t/ha"}.</p>

        <h2>Decision note (selected treatment)</h2>
        <p>${sel && sel.deltaNpv !== null
          ? (sel.deltaNpv >= 0
            ? `Selected treatment <strong>${escapeHtml(selName)}</strong> is better than the control by <strong>$${fmtMoney(sel.deltaNpv)}</strong> per hectare (present value).`
            : `Selected treatment <strong>${escapeHtml(selName)}</strong> is worse than the control by <strong>$${fmtMoney(Math.abs(sel.deltaNpv))}</strong> per hectare (present value).`)
          : `Select a treatment in the Results tab to add a decision note here.`
        }</p>

        <h2>Top treatments (ranked by NPV)</h2>
        <table>
          <thead><tr>
            <th>Rank</th><th>Treatment</th><th>NPV</th><th>Difference vs control</th><th>BCR</th>
          </tr></thead>
          <tbody>
            ${tableRows}
          </tbody>
        </table>

        <h2>How to read this</h2>
        <p>NPV is the present value of benefits minus costs. A higher NPV indicates a stronger economic result under the stated assumptions. The difference vs control shows the additional value compared with the control practice.</p>

        <h2>Sensitivity checks</h2>
        <p class="small">These quick checks help answer: does the ranking change if prices or discounting change?</p>
        <p>${sensMsg}</p>
        <table>
          <thead><tr>
            <th>Scenario</th><th>Price</th><th>Discount</th><th>Top treatment</th><th>Top ΔNPV vs control</th>
          </tr></thead>
          <tbody>
            ${sensTable}
          </tbody>
        </table>

        <h2>Data quality note</h2>
        <p>Readiness: <strong>${String(state.readinessLevel || '').toUpperCase()}</strong>. Where values were missing or needed cleaning, the tool still produced results using available yield and total cost per hectare fields. Review the cleaned data export if a value looks unexpected.</p>

        <h2>Next steps</h2>
        <p>Use these results to prioritise which options to test at scale. Before changing practice, confirm the key assumptions (grain price, years of benefit, and costs) match your local conditions, and consider repeating with local prices and a conservative setting.</p>

        <p class="small">Tool version: ${TOOL_VERSION}. Discounting: annual PV over ${a.years}y at ${fmtNum(a.r*100,1)}% (DF ${fmtNum(a.DF,2)}). Generated: ${new Date().toLocaleString()}. File: ${escapeHtml(state.fileName)}. Rows: ${state.audit.rowCount}. Treatments: ${state.audit.treatmentCount}.</p>
      </body></html>
    `;

    downloadBlob('policy_brief.doc', 'application/msword;charset=utf-8', html);
    showToast('Policy brief downloaded.', 'success');
  }

  // ---------- Ask the tool ----------
  function answerQuestion(q){
    const s = String(q||'').toLowerCase();
    if(s.includes('leaderboard') && s.includes('empty')){
      if(!state.analysis) return 'Run analysis first. Go to Results and click Run analysis.';
      if(!state.analysis.leaderboard.length) return 'No treatments were detected. Check that at least one row is not marked as control and that treatment_name is filled.';
      return 'The leaderboard is showing available treatments. If it looks wrong, check control selection and numeric fields in the Data tab.';
    }
    if(s.includes('upload') || s.includes('load')){
      if(!state.cleanedRows.length) return 'No data is loaded. Go to Data, choose a TSV or CSV, click Validate, then Upload.';
      return 'Data is loaded. If results look wrong, check the Preview panel for warnings and confirm the control selection.';
    }
    if(s.includes('control')){
      if(!state.referenceControlName) return 'No reference control is set yet. Go to Data and set the control.';
      return `Current reference control is ${state.referenceControlName}. You can change it in the Data tab.`;
    }
    return 'Ask about upload, control, results, leaderboard, or exports. The tool will answer based on current state.';
  }

  // ---------- Validation / Upload flow ----------
  function validateLocalFile(file){
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('Failed to read file'));
      reader.readAsText(file);
    });
  }

  function loadFromText(text, fileName){
    state.fileName = fileName || 'uploaded_file';
    state.rawText = text;

    const parsed = parseDelimited(text);
    state.headers = parsed.headers;
    state.rawRows = parsed.rows;

    state.mapping = proposeMapping(state.headers);
    const {cleaned, issues} = cleanRows(state.rawRows, state.mapping, !!state.settings.yieldInKg);
    state.cleanedRows = cleaned;
    state.issues = issues;

    const counts = computeCounts(state.cleanedRows);
    state.audit = {
      uploadedAt: new Date(),
      rowCount: counts.rows,
      treatmentCount: counts.treatments,
      controlCount: counts.controls
    };

    populateControlSelect(counts.controlNames);
    if(counts.controlNames.length){
      const stillValid = state.referenceControlName && counts.controlNames.includes(state.referenceControlName);
      if(state.controlPinned){
        if(!stillValid){
          state.referenceControlName = counts.controlNames[0];
        }
      }else{
        if(!stillValid){
          state.referenceControlName = counts.controlNames[0];
        }
      }
    }
    $('currentControl').textContent = state.referenceControlName || '-';

    updateMeta();
    renderAssumptions();
    renderPreview();
    setStatus('Data loaded. Next: confirm the control and run analysis in Results.');
    const mins = validateMinimum(state.cleanedRows);
    const readiness = mins.length ? 'red' : (REQUIRED_CANON.every(k=>!!state.mapping[k]) ? 'green' : 'amber');
    setReadiness(readiness);
    const fixList = [];
    if(mins.length){
      fixList.push(...mins);
    }else{
      // Keep mapping and formatting issues short.
      issues.forEach(x => {
        if(typeof x === 'string' && x.trim()) fixList.push(x.trim());
      });
    }
    setTopFixes(fixList);
    return { readiness, mins };
  }

  function acceptMapping(){
    // Mapping is already applied in cleanedRows. This button is mainly to confirm.
    showToast('Mapping accepted. You can run analysis.', 'success');
  }

  // ---------- Audit ----------
  function renderAuditTrail(){
    const el = $('auditTrail');
    if(!el) return;
    const up = state.audit.uploadedAt ? state.audit.uploadedAt.toISOString() : '';
    const lines = [];
    lines.push(`Tool version: ${TOOL_VERSION}`);
    lines.push(`File: ${state.fileName}`);
    lines.push(`Uploaded at: ${up}`);
    lines.push(`Rows: ${state.audit.rowCount}`);
    lines.push(`Treatments: ${state.audit.treatmentCount}`);
    lines.push(`Controls: ${state.audit.controlCount}`);
    if(state.analysis){
      lines.push(`Reference control: ${state.analysis.controlName}`);
      lines.push(`Grain price: ${state.analysis.price}`);
      lines.push(`Years: ${state.analysis.years}`);
      lines.push(`Discount rate: ${(state.analysis.r*100).toFixed(1)}%`);
    }
      lines.push(`Yield units: ${state.settings.yieldInKg ? "t/ha (converted from kg/ha)" : "t/ha"}`);
    el.textContent = lines.join('\n');
  }

  // ---------- Init ----------
  async function loadExample(){
    const res = await fetch('example_data.tsv', {cache:'no-store'});
    const text = await res.text();
    loadFromText(text, 'example_data.tsv');
    showToast('Example data loaded.', 'success');
  }

  function wireEvents(){
    $('btnReset').addEventListener('click', async () => {
      await loadExample();
      state.analysis = null;
      $('leaderboardWrap').innerHTML = '';
      $('detailTableWrap').innerHTML = '';
      $('replicateTableWrap').innerHTML = '';
      $('briefPrompt').value = '';
      showToast('Reset complete.', 'success');
      setStatus('Example data loaded. Next: go to Data to upload your file.');
    });

    $('btnLoadExample').addEventListener('click', loadExample);

    $('btnValidateLocal').addEventListener('click', async () => {
      const fi = $('fileInput');
      const file = fi.files && fi.files[0];
      if(!file){
        showToast('Choose a file first.', 'warn');
        return;
      }
      try{
        const text = await validateLocalFile(file);
        loadFromText(text, file.name);
        showToast('Validation complete. Review the preview panel.', 'success');
      }catch(e){
        showToast('Validation failed. Check the file and try again.', 'error');
      }
    });

    $('btnUpload').addEventListener('click', async () => {
      const fi = $('fileInput');
      const file = fi.files && fi.files[0];
      if(!file){
        showToast('Choose a file first.', 'warn');
        return;
      }
      try{
        const text = await validateLocalFile(file);
        const { mins } = loadFromText(text, file.name);
        if(mins.length){
          showToast('Upload complete, but minimum requirements are not met. Check the preview issues.', 'warn');
        }else{
          showToast('Data uploaded successfully. Next: review results.', 'success');
        }
      }catch(e){
        showToast('Upload failed. Check the file and try again.', 'error');
      }
    });

    $('btnAcceptMapping').addEventListener('click', acceptMapping);
    $('btnDownloadCleanedFromPreview').addEventListener('click', exportCleanedTsv);

    $('btnApplySettings').addEventListener('click', () => {
      state.settings.pricePerT = Number($('pricePerT').value);
      state.settings.years = Number($('years').value);
      state.settings.discountPct = Number($('discount').value);
      state.settings.yieldInKg = !!$('yieldInKg').checked;
      if(state.rawRows && state.rawRows.length){
        const reclean = cleanRows(state.rawRows, state.mapping, !!state.settings.yieldInKg);
        state.cleanedRows = reclean.cleaned;
        state.issues = reclean.issues;
        const counts = computeCounts(state.cleanedRows);
        state.audit.rowCount = counts.rows;
        state.audit.treatmentCount = counts.treatments;
        state.audit.controlCount = counts.controls;
        renderPreview();
        updateMeta();
        state.analysis = null;
        state.hasRun = false;
      }

      renderAssumptions();
      saveSettingsToLocal();
      showToast('Settings applied.', 'success');
      renderAuditTrail();
    });

    const btnRestore = $('btnRestoreSettings');
    if(btnRestore){
      btnRestore.addEventListener('click', () => {
        const v = loadSettingsFromLocal();
        if(!v){
          showToast('No saved settings found yet.', 'warn');
          return;
        }
        state.settings.pricePerT = v.pricePerT;
        state.settings.years = v.years;
        state.settings.yieldInKg = !!v.yieldInKg;
        $('yieldInKg').checked = !!v.yieldInKg;
        state.settings.discountPct = v.discountPct;
        $('pricePerT').value = String(v.pricePerT);
        $('years').value = String(v.years);
        $('discount').value = String(v.discountPct);
        renderAssumptions();
        showToast('Last settings restored.', 'success');
      });
    }

    $('btnSetControl').addEventListener('click', () => {
      const sel = $('controlSelect');
      const v = sel.value;
      if(!v){
        showToast('No control is available to select.', 'warn');
        return;
      }
      state.referenceControlName = v;
      $('currentControl').textContent = v;
      $('controlNameResult').textContent = v;
      showToast('Reference control updated.', 'success');
      renderAuditTrail();
    });

    $('btnRun').addEventListener('click', () => {
      runAnalysis();
    });

    const btnRunSensitivity = $('btnRunSensitivity');
    if(btnRunSensitivity){
      btnRunSensitivity.addEventListener('click', runSensitivity);
    }

    const p1 = $('presetConservative');
    const p2 = $('presetCentral');
    const p3 = $('presetOptimistic');
    function applyPreset(kind){
      const base = {
        pricePerT: Number($('pricePerT').value) || state.settings.pricePerT,
        years: Number($('years').value) || state.settings.years,
        discountPct: Number($('discount').value) || state.settings.discountPct
      };
      let v = {...base};
      if(kind === 'conservative'){
        v.pricePerT = Math.max(0, Math.round(base.pricePerT * 0.85));
        v.years = Math.max(5, Math.round(base.years));
        v.discountPct = Math.min(30, Math.round((base.discountPct + 2) * 10) / 10);
      }else if(kind === 'optimistic'){
        v.pricePerT = Math.max(0, Math.round(base.pricePerT * 1.15));
        v.years = Math.max(3, Math.round(base.years + 2));
        v.discountPct = Math.max(0, Math.round((base.discountPct - 2) * 10) / 10);
      }
      state.settings.pricePerT = v.pricePerT;
      state.settings.years = v.years;
      state.settings.discountPct = v.discountPct;
      $('pricePerT').value = String(v.pricePerT);
      $('years').value = String(v.years);
      $('discount').value = String(v.discountPct);
      renderAssumptions();
      saveSettingsToLocal();
      const hint = $('presetHint');
      if(hint){
        if(kind === 'conservative') hint.textContent = 'Conservative assumes lower price and a higher discount rate.';
        else if(kind === 'optimistic') hint.textContent = 'Optimistic assumes higher price and a lower discount rate.';
        else hint.textContent = 'Central uses your current settings as a baseline.';
      }
      showToast(`${kind === 'central' ? 'Central' : (kind === 'conservative' ? 'Conservative' : 'Optimistic')} preset applied.`, 'success');

      // If results already exist, keep Results and Sensitivity in sync with the new assumptions.
      // This is the behaviour users expect when toggling scenario buttons.
      if(state.cleanedRows && state.cleanedRows.length){
        const mins = validateMinimum(state.cleanedRows);
        if(!mins.length){
          // Recompute main results and (if present) sensitivity table.
          if(state.hasRun){
            runAnalysis();
            const sensWrap = $('sensitivityTableWrap');
            const inSensTab = (state.activeTab === 'sensitivity');
            if(inSensTab || (sensWrap && sensWrap.innerHTML.trim().length)){
              runSensitivity({silent:true});
            }
          }
        }
      }
    }
    if(p1) p1.addEventListener('click', () => applyPreset('conservative'));
    if(p2) p2.addEventListener('click', () => applyPreset('central'));
    if(p3) p3.addEventListener('click', () => applyPreset('optimistic'));

    const fix1 = $('fixMarkControl');
    const fix2 = $('fixRenameColumns');
    const fix3 = $('fixRemoveCommas');
    if(fix1) fix1.addEventListener('click', () => {
      if(state.activateTab) state.activateTab('data');
      window.setTimeout(() => {
        $('controlSelect')?.focus();
      }, 50);
      showToast('Tip: choose the control treatment, then click Set control. Ensure at least one row has is_control set to TRUE.', 'warn');
    });
    if(fix2) fix2.addEventListener('click', () => {
      if(state.activateTab) state.activateTab('data');
      const det = document.querySelector('#validatePanel details');
      if(det) det.open = true;
      showToast('Tip: check the detected header mapping. Rename columns to match the template if needed.', 'warn');
    });
    if(fix3) fix3.addEventListener('click', () => {
      showToast('Tip: numbers should be plain. Remove commas, dollar signs, and percent signs. Use the cleaned data download to check what the tool used.', 'warn');
    });

    const btnViewDetails = $('btnViewDetails');
    if(btnViewDetails){
      btnViewDetails.addEventListener('click', () => {
        const det = $('detailsTable');
        if(det){ det.open = true; det.scrollIntoView({behavior:'smooth', block:'start'}); }
      });
    }

    const treatmentPick = $('treatmentPick');
    if(treatmentPick){
      treatmentPick.addEventListener('change', () => {
        state.selectedTreatment = treatmentPick.value;
        renderDeltaCard();
      });
    }

    // Pin control: prevents auto-switching when new data is loaded (user can still change manually)
    const pin = $('pinControl');
    if(pin){
      pin.checked = !!state.controlPinned;
      pin.addEventListener('change', () => {
        state.controlPinned = !!pin.checked;
        showToast(state.controlPinned ? 'Control pinned.' : 'Control unpinned.', 'success');
      });
    }

    // Compare mode (default vs control; optional side-by-side)
    const cmC = $('compareModeControl');
    const cmT = $('compareModeTwo');
    function updateCompareMode(){
      const panelC = $('compareModePanelControl');
      const panelT = $('compareModePanelTwo');
      const vsCard = $('cardVsControl');
      const mode = state.compareMode;
      if(panelC) panelC.hidden = mode !== 'control';
      if(panelT) panelT.hidden = mode !== 'two';
      if(vsCard) vsCard.hidden = mode !== 'control';
      if(mode === 'two'){
        // keep compare output up to date
        const aSel = $('compareA');
        if(aSel) aSel.dispatchEvent(new Event('change'));
      }
    }
    if(cmC) cmC.addEventListener('change', () => { if(cmC.checked){ state.compareMode = 'control'; updateCompareMode(); } });
    if(cmT) cmT.addEventListener('change', () => { if(cmT.checked){ state.compareMode = 'two'; updateCompareMode(); } });
    updateCompareMode();

    const compareA = $('compareA');
    const compareB = $('compareB');
    function renderCompare(){
      if(!state.analysis || !state.analysis.control || !compareA || !compareB) return;
      const a = state.analysis;
      const aName = compareA.value;
      const bName = compareB.value;
      const out = $('compareOut');
      if(!out) return;
      if(!aName || !bName || aName === bName){
        out.textContent = 'Select two different treatments to see the side-by-side comparison.';
        return;
      }
      const A = a.byName[aName];
      const B = a.byName[bName];
      if(!A || !B){
        out.textContent = 'Select two treatments to see the side-by-side comparison.';
        return;
      }

      const dNpvAB = (A.npv !== null && B.npv !== null) ? (A.npv - B.npv) : null;
      const dBcrAB = (A.bcr !== null && B.bcr !== null) ? (A.bcr - B.bcr) : null;
      const dYieldAB = (A.meanYield !== null && B.meanYield !== null) ? (A.meanYield - B.meanYield) : null;
      const dCostAB = (A.meanCost !== null && B.meanCost !== null) ? (A.meanCost - B.meanCost) : null;

      out.innerHTML = tableHtml(
        ['Metric', 'Treatment A', 'Treatment B', 'A − B'],
        [
          ['NPV ($/ha)', numCell(A.npv,0), numCell(B.npv,0), numCell(dNpvAB,0)],
          ['ΔNPV vs control ($/ha)', numCell(A.deltaNpv,0), numCell(B.deltaNpv,0), numCell((A.deltaNpv!==null&&B.deltaNpv!==null)?(A.deltaNpv-B.deltaNpv):null,0)],
          ['BCR', numCell(A.bcr,2), numCell(B.bcr,2), numCell(dBcrAB,2)],
          ['Mean yield (t/ha)', numCell(A.meanYield,2), numCell(B.meanYield,2), numCell(dYieldAB,2)],
          ['Mean cost ($/ha)', numCell(A.meanCost,0), numCell(B.meanCost,0), numCell(dCostAB,0)]
        ]
      ) + `<div class="muted" style="margin-top:8px">Control used: <strong>${escapeHtml(a.controlName||'-')}</strong>.</div>`;
    }
    if(compareA) compareA.addEventListener('change', renderCompare);
    if(compareB) compareB.addEventListener('change', renderCompare);

    $('btnDownloadCleanTsv').addEventListener('click', exportCleanedTsv);
    $('btnDownloadSummaryCsv').addEventListener('click', exportSummaryCsv);
    $('btnDownloadReport').addEventListener('click', exportPolicyBriefDoc);

    $('btnPromptBriefCopilot').addEventListener('click', () => openPromptIn('https://copilot.microsoft.com/'));
    $('btnPromptBriefChatGPT').addEventListener('click', () => openPromptIn('https://chat.openai.com/'));
    $('btnCopyBriefPrompt').addEventListener('click', async () => {
      const ok = await copyToClipboard($('briefPrompt').value || '');
      showToast(ok ? 'Prompt copied.' : 'Prompt copied.', 'success');
    });

    $('btnAsk').addEventListener('click', () => {
      const q = $('askInput').value;
      $('askAnswer').textContent = answerQuestion(q);
    });

    // Set default settings in inputs
    $('pricePerT').value = String(state.settings.pricePerT);
    $('years').value = String(state.settings.years);
    $('discount').value = String(state.settings.discountPct);
    $('yieldInKg').checked = !!state.settings.yieldInKg;

    // Show restore availability
    const existing = loadSettingsFromLocal();
    if(existing){
      $('btnRestoreSettings')?.classList.remove('is-hidden');
    }

    // Re-draw charts on resize (progressive disclosure keeps it light).
    window.addEventListener('resize', () => {
      window.clearTimeout(wireEvents._rt);
      wireEvents._rt = window.setTimeout(() => {
        if(state.hasRun) renderCharts();
      }, 120);
    });
  }

  document.addEventListener('DOMContentLoaded', async () => {
    initTabs();
    initTooltips();
    initReadinessPopover();
    wireEvents();
    await loadExample();
    renderAssumptions();
    buildBriefPrompt();
    updateMeta();
    // Run once so first time users see complete example outputs (no blank results or plots).
    runAnalysis();
  });

})();
