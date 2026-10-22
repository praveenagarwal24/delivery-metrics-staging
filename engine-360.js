/* engine-360.js — the 360 numbers of the 360 Tracker dashboard's Reports tab, for Delivery
   Metrics' 360 tab. The functions between the COPY markers are copied unchanged from
   public/index.html in nandmodi/360-tracker-dashboard (Reports tab, rpt* and failureReasonMaps);
   keep them in step with it so both pages show the same numbers.

   Input: the dashboard's /data/<YYYY-MM>.json rows. Output: rows in the same shape Delivery
   Metrics builds from a sheet ({period, granularity, date, group, region?, v:{column: value}}),
   with the same column names as the 360 export sheets (total_vin, sla_pct, ent_p99_tat_hrs, …). */
(function (global) {
'use strict';

// ── helpers the copied code expects (same definitions as in the 360 dashboard) ──
function parseTs(s){
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/.test(s)){ const d = new Date(s); if (!isNaN(d.getTime())) return d; }
  const m2 = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m2) return new Date(+m2[1], +m2[2]-1, +m2[3]);
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}
function normSeg(s){
  if (!s) return 'Unknown';
  const v = s.trim();
  if (/^smb$/i.test(v)) return 'SMB';
  if (/^resell/i.test(v)) return 'Resellers';
  return v;
}
const SOURCE_NAMES = { app_ios:'iOS App', app_android:'Android App', console:'Console', ftp:'FTP', api:'API' };
function normSource(v){ const t=(v||'').trim(); return SOURCE_NAMES[t.toLowerCase()] || t; }
const VALIDATION_REASONS = new Set(['Incomplete Round - Less Than 4 Images']);
function reasonGroup(r){
  const s=(r.fs||'').trim();
  if (s==='Validation Failed') return 'val';
  if (s==='Tech Failure'||s==='AI Failed') return VALIDATION_REASONS.has((r.rej||'').trim()) ? 'val' : 'tech';
  return null;
}
function rptSegKey(seg){
  const n = normSeg(seg);
  if (n === 'Ent') return 'ent';
  if (n === 'Mid') return 'mid';
  if (n === 'SMB') return 'smb';
  if (n === 'Resellers') return 'resellers';
  return null;
}
const RPT_SLA_H = 6;
const RPT_TECH_SLA_H = 1;
const RPT_SEGMENTS = [
  { id:'all', label:'All segments', prefix:'' },
  { id:'ent', label:'Enterprise', prefix:'ent_' },
  { id:'mid', label:'Mid-market', prefix:'mid_' },
  { id:'resellers', label:'Resellers', prefix:'resellers_' },
  { id:'smb', label:'SMB', prefix:'smb_' },
];
const RPT = { periodObjs: null };   // the builders read the periods from here

// ═══════════ COPY from the 360 dashboard (public/index.html) — do not edit here ═══════════
function rptValidTs(s){ const d = parseTs(s); return d && d.getTime() >= 86400000 ? d : null; }
function rptRowPeriodDate(r){
  if (r._rptPeriod !== undefined) return r._rptPeriod;
  return r._rptPeriod = rptValidTs(r.sc) || rptValidTs(r.pa) || r._created || null;
}
// Close time of a SKU's activity, in hours from the clock start, or null while it is still open.
// Every final status except Processing and Under Review means the activity closed:
//   Delivered → first_qc_done, else first_spin_created_time, else the clock start (0h)
//   QC / Validation / AI Failed, Tech Failure, Undelivered → first_qc_done (a QC user closed
//     it), else the clock start (the system closed it then, 0h)
// A close time before the start is invalid and falls through to the next option, so no negatives.
const RPT_CLOSED = new Set(['Delivered','QC Failed','Validation Failed','AI Failed','Tech Failure','Undelivered']);
function rptCloseHrs(r){
  const start = rptRowPeriodDate(r);
  const fs = (r.fs||'').trim();
  if (!start || !RPT_CLOSED.has(fs)) return null;
  const t0 = start.getTime();
  const valid = s => { const d = rptValidTs(s); return d && d.getTime() >= t0 ? d : null; };
  const end = valid(r.fq) || (fs === 'Delivered' && valid(r.fsc)) || start;
  return Math.round((end.getTime() - t0) / 36000) / 100;
}
// Extra TAT lines that can be overlaid on the E2E cards. Each one is computed exactly like
// E2E (same eligible rows, same 6h SLA, same percentile method) but from its own row field.
const RPT_OVERLAYS = [
  { id:'tech', label:'Tech',       field:'techTat', color:'#eb6834', dash:'4 3',     mode:'techMode', toggle:'toggleRptTechMode', slaH:RPT_TECH_SLA_H },
];
const RPT_OVERLAY_BASES = ['sla_pct','p99_tat_hrs','p95_tat_hrs'];
const RPT_OVERLAY_FIELDS = RPT_OVERLAYS.flatMap(o => RPT_OVERLAY_BASES.map(b => o.id+'_'+b));
function rptTatStats(vals, slaH){
  slaH = slaH || RPT_SLA_H;
  if (!vals.length) return { sla:null, p99:null, p95:null };
  const sorted = Float64Array.from(vals).sort();
  const pct = p => +sorted[Math.min(sorted.length-1, Math.ceil(p*sorted.length)-1)].toFixed(2);
  let met = 0; for (const v of vals) if (v<=slaH) met++;
  return { sla: +((met/vals.length)*100).toFixed(2), p99:pct(0.99), p95:pct(0.95) };
}
function rptIsPreLive(r){
  if (r._rptPreLive !== undefined) return r._rptPreLive;
  const ld = r.ld ? new Date(r.ld) : null;
  const st = rptRowPeriodDate(r);
  return r._rptPreLive = !!(ld && !isNaN(ld) && st && st < ld);
}
// Per-row facts the report needs, worked out once per row and cached on it.
//   SLA, TAT  — Delivered SKUs only (as in the Delivery Metrics export): within = delivered in <= 6h;
//               TAT P95/P99 = start to delivery. Failed and still-open SKUs count in Fulfilment only.
//   Fulfilment — Delivered / every SKU in the period, whatever its status (pending ones included)
//   eligible  — the Tech overlay's own population (unchanged)
const RPT_TAT_ELIGIBLE = new Set(['Delivered','QC Failed','Validation Failed','Tech Failure','AI Failed','Undelivered']);
function rptRowKind(r){
  if (r._rptKind) return r._rptKind;
  const fs = (r.fs||'').trim(), delivered = fs === 'Delivered';
  const closeH = rptCloseHrs(r);
  const tatH = delivered ? closeH : null, within = tatH != null && tatH <= RPT_SLA_H;
  return r._rptKind = {
    eligible: RPT_TAT_ELIGIBLE.has(fs) && !rptIsPreLive(r),
    delivered, seg: rptSegKey(r.seg),
    closeH, within, tatH,
  };
}
// Rows per period in a single pass (instead of re-scanning every row for each period).
function rptBucketByPeriod(allRows, periods){
  const out = new Map(periods.map(p=>[p,[]]));
  const ranges = periods.map(p=>[p, p.from.getTime(), p.to.getTime()]);
  for (const r of allRows){
    const d = rptRowPeriodDate(r); if (!d) continue;
    const t = d.getTime();
    for (const [p,f,e] of ranges) if (t>=f && t<e) out.get(p).push(r);
  }
  return out;
}
function rptGroupBy(rows, keyFn){
  const m = new Map();
  for (const r of rows){ const k = keyFn(r); let a = m.get(k); if (!a) m.set(k, a = []); a.push(r); }
  return m;
}
const RPT_EMPTY = [];
function rptComputeMetrics(rows){
  const out = { total_vin:0, total_delivered:0, sla_pct:null, p99_tat_hrs:null, p95_tat_hrs:null, delivery_pct:null,
                sla_checked:0, sla_breached:0, tat_measured:0, tat_over_sla:0 };
  RPT_OVERLAY_FIELDS.forEach(f=>out[f]=null);
  if (!rows.length) return out;
  // One pass over the rows (see rptRowKind for what each metric counts).
  // The Tech overlay keeps its own population: TAT-eligible statuses, live_date onwards.
  const tatVals = [], ovVals = RPT_OVERLAYS.map(()=>[]);
  let delivered = 0, within = 0;
  for (const r of rows){
    const k = rptRowKind(r);
    if (k.delivered) delivered++;
    if (k.within) within++;
    if (k.tatH != null) tatVals.push(k.tatH);
    if (!k.eligible) continue;
    for (let i=0;i<RPT_OVERLAYS.length;i++){ const v = r[RPT_OVERLAYS[i].field]; if (typeof v==='number' && v>=0) ovVals[i].push(v); }
  }
  const main = rptTatStats(tatVals);
  out.sla_pct = tatVals.length ? +((within/tatVals.length)*100).toFixed(2) : null; out.p99_tat_hrs = main.p99; out.p95_tat_hrs = main.p95;
  RPT_OVERLAYS.forEach((o,i) => { const st = rptTatStats(ovVals[i], o.slaH);
    out[o.id+'_sla_pct'] = st.sla; out[o.id+'_p99_tat_hrs'] = st.p99; out[o.id+'_p95_tat_hrs'] = st.p95; });
  const received = rows.length;
  out.total_vin = received; out.total_delivered = delivered;
  out.delivery_pct = +((delivered/received)*100).toFixed(2);   // every SKU counts, pending included
  // Counts behind the rates, for the card tooltips: SLA total = TAT measured = Delivered SKUs.
  out.sla_checked = tatVals.length; out.sla_breached = tatVals.length - within;
  out.tat_measured = tatVals.length; out.tat_over_sla = tatVals.filter(v => v > RPT_SLA_H).length;
  return out;
}
// Tooltip count columns, copied onto each report row with the segment prefix ('' or 'ent_' etc.).
const RPT_COUNT_COLS = ['sla_checked','sla_breached','tat_measured','tat_over_sla'];
function rptCountCols(row, prefix, m){ RPT_COUNT_COLS.forEach(c => row.v[prefix+c] = m[c]); }
function rptAverageMetrics(list){
  const avg = key => { const vals=list.map(m=>m[key]).filter(v=>v!=null); return vals.length ? +(vals.reduce((a,b)=>a+b,0)/vals.length).toFixed(2) : null; };
  const out = { sla_pct:avg('sla_pct'), p99_tat_hrs:avg('p99_tat_hrs'), p95_tat_hrs:avg('p95_tat_hrs'), delivery_pct:avg('delivery_pct') };
  RPT_OVERLAY_FIELDS.forEach(f=>out[f]=avg(f));
  return out;
}
// Periods run UTC midnight to UTC midnight (5:30 AM IST), the same boundaries as the Delivery
// Metrics export, so a Reports period holds exactly the SKUs of the export's period.
function rptGetPeriods(allRows){
  let maxT = Date.UTC(2026,3,1);
  for (const r of allRows){ const d=rptRowPeriodDate(r); if (d && d.getTime()>maxT) maxT=d.getTime(); }
  const m = new Date(maxT), Y = m.getUTCFullYear(), M = m.getUTCMonth(), DAY = m.getUTCDate();
  const U = (y,mo,d) => new Date(Date.UTC(y,mo,d));   // Date.UTC rolls days and months over
  const periods = [];
  // Weekly: W-1 (last complete Mon–Sun week) to W-4; the current week is left out.
  const mon = DAY - ((m.getUTCDay()||7) - 1);
  for (let i=1;i<=4;i++){
    const s=U(Y,M,mon-7*i), e=U(Y,M,mon-7*i+7);
    periods.push({group:0,date:s,granularity:'week',period:'W-'+i,from:s,to:e});
  }
  for (let i=0;i<=4;i++){
    const s=U(Y,M-i,1), e=U(Y,M-i+1,1);
    periods.push({group:1,date:s,granularity:'month',period:i===0?'MTD':'M-'+i,from:s,to:e});
  }
  // Day-wise: last 7 complete days before the latest SKU's day, labelled D-1 (yesterday) … D-7.
  // The current, still-filling day is left out — same as weekly.
  for (let i=1;i<=7;i++){
    const s=U(Y,M,DAY-i), e=U(Y,M,DAY-i+1);
    periods.push({group:2,date:s,granularity:'day',period:'D-'+i,from:s,to:e});
  }
  return periods;
}
function rptInPeriod(r,p){ const d=rptRowPeriodDate(r); return d && d>=p.from && d<p.to; }

function rptLaneMetrics(laneId, rows){
  if (laneId!=='rt') return rptComputeMetrics(rows);
  const byTeam = new Map();
  for (const r of rows){ if(!r.tm) continue; if(!byTeam.has(r.tm)) byTeam.set(r.tm,[]); byTeam.get(r.tm).push(r); }
  return rptAverageMetrics([...byTeam.values()].map(rptComputeMetrics));
}
function rptBuildSpinOrRt(allRows, laneId, pops){
  const periods = RPT.periodObjs || rptGetPeriods(allRows);
  pops = pops || rptBucketByPeriod(allRows, periods);
  return periods.map(p=>{
    const pop = pops.get(p) || RPT_EMPTY;
    const overall = rptLaneMetrics(laneId, pop);
    const overallTotals = laneId==='rt' ? rptComputeMetrics(pop) : overall;
    const bySeg = rptGroupBy(pop, r=>rptRowKind(r).seg);
    const row = { group:p.group, date:p.date, granularity:p.granularity, period:p.period, v:{
      total_vin:overallTotals.total_vin, total_delivered:overallTotals.total_delivered,
      sla_pct:overall.sla_pct, p99_tat_hrs:overall.p99_tat_hrs, p95_tat_hrs:overall.p95_tat_hrs, delivery_pct:overall.delivery_pct,
    }};
    RPT_OVERLAY_FIELDS.forEach(f=>row.v[f]=overall[f]);
    rptCountCols(row, '', overallTotals);   // pooled SKU counts, rooftop lane too
    for (const seg of RPT_SEGMENTS){
      if (!seg.prefix) continue;
      const segRows = bySeg.get(seg.id) || RPT_EMPTY;
      const m = rptLaneMetrics(laneId, segRows), mTotals = laneId==='rt' ? rptComputeMetrics(segRows) : m;
      rptCountCols(row, seg.prefix, mTotals);
      row.v[seg.prefix+'total_vin']=mTotals.total_vin; row.v[seg.prefix+'total_delivered']=mTotals.total_delivered;
      row.v[seg.prefix+'sla_pct']=m.sla_pct; row.v[seg.prefix+'p99_tat_hrs']=m.p99_tat_hrs;
      row.v[seg.prefix+'p95_tat_hrs']=m.p95_tat_hrs; row.v[seg.prefix+'delivery_pct']=m.delivery_pct;
      RPT_OVERLAY_FIELDS.forEach(f=>row.v[seg.prefix+f]=m[f]);
    }
    return row;
  });
}
function rptBuildRegion(allRows, pops){
  const periods = RPT.periodObjs || rptGetPeriods(allRows);
  pops = pops || rptBucketByPeriod(allRows, periods);
  const regions = [...new Set(allRows.map(r=>r.region).filter(Boolean))].sort();
  const rows = [];
  for (const p of periods){
    const byRegion = rptGroupBy(pops.get(p) || RPT_EMPTY, r=>r.region||null);
    for (const region of [...regions, null]){
      const regionPop = byRegion.get(region) || RPT_EMPTY;
      if (!regionPop.length) continue;
      const bySeg = rptGroupBy(regionPop, r=>rptRowKind(r).seg);
      const overall = rptComputeMetrics(regionPop);
      const row = { group:p.group, date:p.date, granularity:p.granularity, period:p.period, region:region||'Unknown', v:{
        total_vin:overall.total_vin, total_delivered:overall.total_delivered,
        sla_pct:overall.sla_pct, p99_tat_hrs:overall.p99_tat_hrs, p95_tat_hrs:overall.p95_tat_hrs,
      }};
      RPT_OVERLAY_FIELDS.forEach(f=>row.v[f]=overall[f]);
      rptCountCols(row, '', overall);
      const segMetrics = {};
      for (const seg of RPT_SEGMENTS){
        if (!seg.prefix) continue;
        segMetrics[seg.id] = rptComputeMetrics(bySeg.get(seg.id) || RPT_EMPTY);
        rptCountCols(row, seg.prefix, segMetrics[seg.id]);
        row.v[seg.prefix+'total_vin']=segMetrics[seg.id].total_vin; row.v[seg.prefix+'total_delivered']=segMetrics[seg.id].total_delivered;
        row.v[seg.prefix+'sla_pct']=segMetrics[seg.id].sla_pct; row.v[seg.prefix+'p99_tat_hrs']=segMetrics[seg.id].p99_tat_hrs; row.v[seg.prefix+'p95_tat_hrs']=segMetrics[seg.id].p95_tat_hrs;
        RPT_OVERLAY_FIELDS.forEach(f=>row.v[seg.prefix+f]=segMetrics[seg.id][f]);
      }
      row.v.delivery_pct = overall.delivery_pct;
      for (const seg of RPT_SEGMENTS){ if (seg.prefix) row.v[seg.prefix+'delivery_pct'] = segMetrics[seg.id].delivery_pct; }
      rows.push(row);
    }
  }
  return rows;
}

function failureReasonMaps(rows){
  const qcReasons = {}, valReasons = {}, techReasons = {};
  let totalReviewed = 0;
  for (const r of rows){
    const fs = (r.fs||'').trim();
    if ((r.cs||'').trim() === 'qc_done') totalReviewed++;

    if (fs === 'QC Failed' && r.isv){
      const parts = String(r.isv).split('||');
      let foundBlocker = false;
      for (const part of parts){
        const t = part.trim();
        if (/^blocker/i.test(t)){
          foundBlocker = true;
          const items = t.replace(/^blocker\s*-\s*/i,'').split(',');
          for (const item of items){
            const k = item.trim();
            if (k) qcReasons[k] = (qcReasons[k]||0)+1;
          }
        }
      }
      if (!foundBlocker){ const k = r.rej ? (r.rej||'').trim().slice(0,60) : '(no reason recorded)'; qcReasons[k] = (qcReasons[k]||0)+1; }
    }
    // Note: QC Failed rows with blank isv are intentionally skipped entirely here —
    // matches the Operations dashboard's confirmed behavior (only Blocker-severity
    // issues count, and a row with no isv at all contributes nothing to this card).

    if (reasonGroup(r) === 'val'){ const k = r.rej ? (r.rej||'').trim().slice(0,80) : '(no reason recorded)'; valReasons[k] = (valReasons[k]||0)+1; }
    if (reasonGroup(r) === 'tech'){ const k = r.rej ? (r.rej||'').trim().slice(0,80) : '(no reason recorded)'; techReasons[k] = (techReasons[k]||0)+1; }
  }
  return { qcReasons, valReasons, techReasons, totalReviewed };
}

// Fulfilment Gap Reasons (Reports Issues + Delivery Metrics' 360 tab): every SKU that wasn't
// delivered lands in exactly one card, so the cards add up to Total − Delivered and their shares
// (of every SKU) to 100 − Fulfilment.
//   QC Failed      — card total = QC Failed SKUs; the list counts each Blocker issue, so a spin with
//                    two blockers shows under both (no issue logged → its failure reason)
//   Validation / Tech & AI — by failure reason, one per SKU (reasonGroup decides the card)
//   Not delivered yet — every other status (Processing, Under Review, Undelivered, …), by status
function gapReasonMaps(rows){
  const qcReasons = {}, valReasons = {}, techReasons = {}, notYet = {};
  let qcSkus = 0, delivered = 0;
  for (const r of rows){
    const fs = (r.fs||'').trim();
    if (fs === 'Delivered'){ delivered++; continue; }
    if (fs === 'QC Failed'){
      qcSkus++;
      const items = [];
      if (r.isv) for (const part of String(r.isv).split('||')){
        const t = part.trim();
        if (/^blocker/i.test(t)) t.replace(/^blocker\s*-\s*/i,'').split(',').forEach(x => { x = x.trim(); if (x) items.push(x); });
      }
      if (!items.length) items.push(r.rej ? (r.rej||'').trim().slice(0,60) : '(no issue recorded)');
      items.forEach(k => { qcReasons[k] = (qcReasons[k]||0)+1; });
      continue;
    }
    const g = reasonGroup(r);
    if (g){
      const m = g === 'val' ? valReasons : techReasons, k = r.rej ? (r.rej||'').trim().slice(0,80) : '(no reason recorded)';
      m[k] = (m[k]||0)+1;
      continue;
    }
    const k = fs || '(no status)';
    notYet[k] = (notYet[k]||0)+1;
  }
  return { qcReasons, qcSkus, valReasons, techReasons, notYet, total: rows.length, delivered };
}

// ═══════════ end of COPY ═══════════

// ── what Delivery Metrics calls ──
// Parse what the copied code reads, once per row (as the dashboard does on load).
function prepare(rows){
  for (const r of rows){ r._created = parseTs(r.c); r._src = normSource(r.vm); }
  return rows;
}
// filters: { types: Set|null (Images/Video), sources: Set|null, regions: Set|null }; null = all.
function passes(r, f){
  if (f.types && !f.types.has(r.tt||'')) return false;
  if (f.sources && !f.sources.has(r._src||'')) return false;
  if (f.regions && !f.regions.has(r.region||'Unknown')) return false;
  return true;
}
// Spin and Rooftop follow every filter; Region keeps all regions (one row per region) so the
// region chips and the Region lane can pick from them, exactly like the Reports tab.
function compute(allRows, f){
  RPT.periodObjs = rptGetPeriods(allRows);      // anchored on all data, so filters never shift D-1 / W-1 / MTD
  const base = allRows.filter(r => passes(r, { types:f.types, sources:f.sources, regions:null }));
  const sel  = f.regions ? base.filter(r => f.regions.has(r.region||'Unknown')) : base;
  const pops = rptBucketByPeriod(sel, RPT.periodObjs);
  return {
    periods: RPT.periodObjs,
    spin:   rptBuildSpinOrRt(sel, 'spin', pops),
    rt:     rptBuildSpinOrRt(sel, 'rt', pops),
    region: rptBuildRegion(base, rptBucketByPeriod(base, RPT.periodObjs)),
  };
}
// Failure-reason counts for one period (by its label, e.g. 'MTD'), every filter + segment applied.
function issues(allRows, f, periodLabel, granularity, segment){
  const periods = RPT.periodObjs || rptGetPeriods(allRows);
  const p = periods.find(x => x.period === periodLabel && x.granularity === granularity);
  if (!p) return null;
  const rows = allRows.filter(r => rptInPeriod(r,p) && passes(r,f) && (!segment || segment==='all' || rptSegKey(r.seg)===segment));
  return gapReasonMaps(rows);
}
function values(allRows, field){
  const s = new Set();
  for (const r of allRows){ const v = field==='source' ? r._src : field==='type' ? r.tt : (r.region||'Unknown'); if (v) s.add(v); }
  return [...s].sort();
}
global.Engine360 = { prepare, compute, issues, values, version: '2026-10-22b' };
})(window);
