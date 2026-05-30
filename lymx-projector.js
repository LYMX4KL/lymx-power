/* lymx-projector.js — category-driven income projector + team strategy +
 * benchmark panel + goal planner. Reads live MGC rates from commission_rate_config
 * (via lymx-comp-config.js), real income from partner_income_summary, and
 * you-vs-network from partner_benchmarks. The goal planner personalizes its
 * advice using the partner's weakest lever relative to the sitewide average.
 * Built 2026-05-30.
 */
(function () {
  // ---- live config (overwritten from commission_rate_config) ----
  var CFG = { dir: 0.09, g1: 0.03, g2: 0.02, g3: 0.01, txn: 0.03, signup: 500 };
  function applyCfg() {
    var C = (window.LYMXComp && window.LYMXComp.cfg) || {};
    if (C.direct_pct_regular != null) CFG.dir = C.direct_pct_regular / 100;
    if (C.g1_pct != null) CFG.g1 = C.g1_pct / 100;
    if (C.g2_pct != null) CFG.g2 = C.g2_pct / 100;
    if (C.g3_pct != null) CFG.g3 = C.g3_pct / 100;
    if (C.transaction_fee_pct != null) CFG.txn = C.transaction_fee_pct / 100;
    if (C.activation_bonus_regular_cents != null) CFG.signup = C.activation_bonus_regular_cents / 100;
  }

  // ---- category economics (editable estimates: LYMX issued/redeemed per biz/mo) ----
  var CATS = [
    { key: 'cafe',        icon: '☕', name: 'Café / Coffee',          sub: 'high frequency, low ticket', iss: 30000, red: 24000 },
    { key: 'drinks',      icon: '🧋', name: 'Drinks / Boba / Juice', sub: 'high frequency',             iss: 22000, red: 18000 },
    { key: 'fastfood',    icon: '🍔', name: 'Fast food / QSR',       sub: 'high frequency',             iss: 28000, red: 22000 },
    { key: 'fullservice', icon: '🍽️', name: 'Full-service restaurant', sub: 'higher ticket',      iss: 18000, red: 14000 },
    { key: 'bar',         icon: '🍸', name: 'Bar / Nightlife',       sub: 'evenings',                   iss: 15000, red: 11000 },
    { key: 'retail',      icon: '🛒', name: 'Retail / Shop',         sub: 'mid ticket',                 iss: 12000, red: 9000 },
    { key: 'salon',       icon: '💈', name: 'Salon / Beauty / Spa',  sub: 'appointments',               iss: 9000,  red: 7000 },
    { key: 'fitness',     icon: '🏋️', name: 'Fitness / Gym / Studio', sub: 'membership',          iss: 8000,  red: 6000 }
  ];

  var state = {
    counts: {}, fee: 199,
    team: { g1P: 1, g1B: 2, g2P: 0, g2B: 0, g3P: 0, g3B: 0, gIss: 18000, gRed: 14000 }
  };
  CATS.forEach(function (c) { state.counts[c.key] = 0; });
  state.counts.cafe = 2; state.counts.fastfood = 1; state.counts.fullservice = 1;

  var bench = null;       // partner_benchmarks
  var myGoal = 0;         // saved monthly cash goal
  var monthCash = 0;      // partner's actual cash THIS month
  var myPid = null;

  function $(id) { return document.getElementById(id); }
  function usd(n) { return '$' + Math.round(Number(n || 0)).toLocaleString('en-US'); }
  function lymxF(n) { return Math.round(Number(n || 0)).toLocaleString('en-US') + ' LYMX'; }
  function catVol(c) { return (c.iss || 0) + (c.red || 0); }

  function compute() {
    var dirN = 0, dirSub = 0, dirLymx = 0;
    CATS.forEach(function (c) {
      var n = state.counts[c.key] || 0; dirN += n;
      dirSub += n * state.fee * CFG.dir;
      dirLymx += n * catVol(c) * CFG.txn * CFG.dir;
    });
    var t = state.team, dvol = (t.gIss + t.gRed);
    var g1Biz = t.g1P * t.g1B, g2Biz = t.g2P * t.g2B, g3Biz = t.g3P * t.g3B;
    var g1Cash = g1Biz * state.fee * CFG.g1, g2Cash = g2Biz * state.fee * CFG.g2, g3Cash = g3Biz * state.fee * CFG.g3;
    var g1Lymx = g1Biz * dvol * CFG.txn * CFG.g1, g2Lymx = g2Biz * dvol * CFG.txn * CFG.g2, g3Lymx = g3Biz * dvol * CFG.txn * CFG.g3;
    return {
      dirN: dirN, dirSub: dirSub, dirLymx: dirLymx,
      g1Biz: g1Biz, g2Biz: g2Biz, g3Biz: g3Biz,
      g1Cash: g1Cash, g2Cash: g2Cash, g3Cash: g3Cash,
      g1Lymx: g1Lymx, g2Lymx: g2Lymx, g3Lymx: g3Lymx,
      monthlyCash: dirSub + g1Cash + g2Cash + g3Cash,
      monthlyLymx: dirLymx + g1Lymx + g2Lymx + g3Lymx,
      oneTime: dirN * CFG.signup
    };
  }

  // ---------- render input rows ----------
  function renderCats() {
    $('cats').innerHTML = CATS.map(function (c) {
      return '<div class="catrow">' +
        '<span class="caticon">' + c.icon + '</span>' +
        '<span class="catname">' + c.name + '<small>' + (c.sub || '') + ' · ~' + Math.round(catVol(c) / 1000) + 'k LYMX/mo · <button class="edit-toggle" data-edit="' + c.key + '">edit</button></small></span>' +
        '<span class="stepper"><button data-dec="' + c.key + '">−</button>' +
        '<input type="number" min="0" id="cnt-' + c.key + '" value="' + (state.counts[c.key] || 0) + '">' +
        '<button data-inc="' + c.key + '">+</button></span>' +
        '</div>' +
        '<div class="catedit" id="ed-' + c.key + '">' +
          '<label>LYMX issued / mo<input type="number" min="0" step="500" id="iss-' + c.key + '" value="' + c.iss + '"></label>' +
          '<label>LYMX redeemed / mo<input type="number" min="0" step="500" id="red-' + c.key + '" value="' + c.red + '"></label>' +
        '</div>';
    }).join('');
  }
  function renderTeam() {
    var t = state.team;
    var rows = [
      { k: 'g1', label: 'G1 — partners you recruit', sub: 'override ' + (CFG.g1 * 100) + '%', p: 'g1P', b: 'g1B' },
      { k: 'g2', label: 'G2 — their recruits', sub: 'override ' + (CFG.g2 * 100) + '%', p: 'g2P', b: 'g2B' },
      { k: 'g3', label: 'G3 — one level deeper', sub: 'override ' + (CFG.g3 * 100) + '%', p: 'g3P', b: 'g3B' }
    ];
    $('team').innerHTML = rows.map(function (r) {
      return '<div class="teamrow"><div class="tl">' + r.label + '<small>' + r.sub + '</small></div>' +
        '<div class="f"># partners<input type="number" min="0" id="tm-' + r.p + '" value="' + t[r.p] + '"></div>' +
        '<div class="f">biz each<input type="number" min="0" id="tm-' + r.b + '" value="' + t[r.b] + '"></div></div>';
    }).join('');
    $('t-gIss').value = t.gIss; $('t-gRed').value = t.gRed; $('t-fee').value = state.fee;
  }

  function renderOutputs() {
    var r = compute();
    $('o-cash').textContent = usd(r.monthlyCash);
    $('o-lymx').textContent = '+' + lymxF(r.monthlyLymx);
    $('o-annual').textContent = usd(r.monthlyCash * 12);
    $('o-annual-lymx').textContent = lymxF(r.monthlyLymx * 12);
    $('o-onetime').textContent = usd(r.oneTime);

    var rows = [
      ['Your production — subscription overrides (' + (CFG.dir * 100) + '%)', usd(r.dirSub), null],
      ['Your production — LYMX (transaction fees)', null, lymxF(r.dirLymx)],
      ['G1 team overrides', usd(r.g1Cash), lymxF(r.g1Lymx)],
      ['G2 team overrides', usd(r.g2Cash), lymxF(r.g2Lymx)],
      ['G3 team overrides', usd(r.g3Cash), lymxF(r.g3Lymx)],
      ['Sign-up bonuses (one-time, ' + usd(CFG.signup) + ' each × ' + r.dirN + ')', usd(r.oneTime) + ' once', null]
    ];
    $('breakdown').innerHTML = rows.map(function (x) {
      var v = [x[1] ? '<span class="v">' + x[1] + '</span>' : '', x[2] ? '<span class="vl">' + x[2] + '</span>' : ''].filter(Boolean).join(' &nbsp; ');
      return '<div class="brk"><span>' + x[0] + '</span><span>' + (v || '—') + '</span></div>';
    }).join('');

    renderFocus(r);
    renderPaths();
  }

  function renderFocus(r) {
    var moves = [];
    CATS.forEach(function (c) {
      moves.push({
        label: 'Recruit one more ' + c.name,
        cash: state.fee * CFG.dir, lymx: catVol(c) * CFG.txn * CFG.dir, once: CFG.signup
      });
    });
    var t = state.team, dvol = t.gIss + t.gRed;
    moves.push({ label: 'Coach a G1 partner to add 1 business', cash: state.fee * CFG.g1, lymx: dvol * CFG.txn * CFG.g1, once: 0 });
    moves.push({ label: 'Recruit a new G1 partner (≈' + t.g1B + ' biz)', cash: t.g1B * state.fee * CFG.g1, lymx: t.g1B * dvol * CFG.txn * CFG.g1, once: 0 });
    // rank by monthly cash, then LYMX
    moves.sort(function (a, b) { return (b.cash - a.cash) || (b.lymx - a.lymx); });
    $('focus').innerHTML = moves.slice(0, 4).map(function (m, i) {
      return '<div class="focus-item' + (i === 0 ? ' top' : '') + '">' +
        '<span class="fl">' + (i === 0 ? '⭐ ' : '') + m.label + '</span>' +
        '<span class="fv">+' + usd(m.cash) + '/mo' + (m.once ? ' <small>+' + usd(m.once) + ' bonus</small>' : '') +
          '<small>+' + lymxF(m.lymx) + '/mo</small></span></div>';
    }).join('');
  }

  function renderPaths() {
    // 12 months of "1 action / month". Hunter: +1 business/mo (best LYMX category present, else cafe).
    // Builder: +1 G1 partner/mo, each bringing team.g1B businesses.
    var best = CATS.slice().sort(function (a, b) { return catVol(b) - catVol(a); })[0];
    var hunterCash = 0, hunterLymx = 0, builderCash = 0, builderLymx = 0;
    var t = state.team, dvol = t.gIss + t.gRed;
    for (var m = 1; m <= 12; m++) {
      // Hunter: m businesses active by month m; bonuses each month for the new one
      hunterCash += CFG.signup;                       // bonus for this month's recruit
      hunterCash += m * state.fee * CFG.dir;          // recurring from all m active
      hunterLymx += m * catVol(best) * CFG.txn * CFG.dir;
      // Builder: m partners by month m, each with g1B biz
      var biz = m * t.g1B;
      builderCash += biz * state.fee * CFG.g1;        // override recurring (no bonus to you)
      builderLymx += biz * dvol * CFG.txn * CFG.g1;
    }
    $('hunter-cash').textContent = usd(hunterCash);
    $('hunter-lymx').textContent = lymxF(hunterLymx);
    $('builder-cash').textContent = usd(builderCash);
    $('builder-lymx').textContent = lymxF(builderLymx);
    $('builder-b').textContent = t.g1B;
    var note = hunterCash >= builderCash
      ? 'At this pace, hunting pays more cash in year one (sign-up bonuses are immediate). Builder income is smaller early but compounds and is more passive as your team recruits without you.'
      : 'At this pace, building your team out-earns hunting within a year — leverage compounds. Hunting still pays the fastest first dollar via sign-up bonuses.';
    $('path-note').textContent = note;
  }

  // ---------- events ----------
  function bindEvents() {
    $('cats').addEventListener('click', function (e) {
      var inc = e.target.getAttribute('data-inc'), dec = e.target.getAttribute('data-dec'), ed = e.target.getAttribute('data-edit');
      if (inc) { state.counts[inc] = (state.counts[inc] || 0) + 1; $('cnt-' + inc).value = state.counts[inc]; renderOutputs(); }
      else if (dec) { state.counts[dec] = Math.max(0, (state.counts[dec] || 0) - 1); $('cnt-' + dec).value = state.counts[dec]; renderOutputs(); }
      else if (ed) { var el = $('ed-' + ed); el.classList.toggle('open'); }
    });
    $('cats').addEventListener('input', function (e) {
      var id = e.target.id || '';
      if (id.indexOf('cnt-') === 0) { state.counts[id.slice(4)] = Math.max(0, +e.target.value || 0); renderOutputs(); }
      else if (id.indexOf('iss-') === 0 || id.indexOf('red-') === 0) {
        var key = id.slice(4), c = CATS.find(function (x) { return x.key === key; });
        if (c) { c[id.slice(0, 3) === 'iss' ? 'iss' : 'red'] = Math.max(0, +e.target.value || 0); renderCats2Labels(); renderOutputs(); }
      }
    });
    $('team').addEventListener('input', function (e) {
      var id = e.target.id || ''; if (id.indexOf('tm-') === 0) { state.team[id.slice(3)] = Math.max(0, +e.target.value || 0); renderOutputs(); }
    });
    $('t-gIss').addEventListener('input', function (e) { state.team.gIss = Math.max(0, +e.target.value || 0); renderOutputs(); });
    $('t-gRed').addEventListener('input', function (e) { state.team.gRed = Math.max(0, +e.target.value || 0); renderOutputs(); });
    $('t-fee').addEventListener('input', function (e) { state.fee = Math.max(0, +e.target.value || 0); renderOutputs(); });
    document.querySelectorAll('.preset[data-preset]').forEach(function (b) {
      b.addEventListener('click', function () {
        var p = b.getAttribute('data-preset');
        CATS.forEach(function (c) { state.counts[c.key] = 0; });
        if (p === 'cafes5') state.counts.cafe = 5;
        else if (p === 'fullservice3') state.counts.fullservice = 3;
        else if (p === 'mix') { state.counts.cafe = 2; state.counts.fastfood = 2; state.counts.fullservice = 1; state.counts.retail = 1; }
        renderCats(); renderOutputs();
      });
    });
    $('goal-go').addEventListener('click', runGoalPlanner);
    var gs = $('goal-save'); if (gs) gs.addEventListener('click', saveGoal);
    $('goal-input').addEventListener('keydown', function (e) { if (e.key === 'Enter') runGoalPlanner(); });
  }
  function renderCats2Labels() {
    CATS.forEach(function (c) {
      var row = $('cnt-' + c.key); if (!row) return;
      var small = row.closest('.catrow').querySelector('.catname small');
      if (small) small.innerHTML = (c.sub || '') + ' · ~' + Math.round(catVol(c) / 1000) + 'k LYMX/mo · <button class="edit-toggle" data-edit="' + c.key + '">edit</button>';
    });
  }

  // ---------- goal planner (personalized by benchmarks) ----------
  function runGoalPlanner() {
    var goal = +$('goal-input').value || 0;
    var out = $('goal-out');
    if (goal <= 0) { out.innerHTML = '<p class="hint">Enter a monthly cash target above.</p>'; return; }
    var r = compute();
    var perBizMonthly = state.fee * CFG.dir;        // recurring cash per business/mo
    var perG1BizMonthly = state.fee * CFG.g1;

    // Personalize: which lever is the partner weakest at vs the network?
    var weak = null, advice = '';
    if (bench && bench.you && bench.site) {
      var y = bench.you, st = bench.site;
      var ratios = [];
      if (st.avg_activations > 0) ratios.push({ k: 'activations', r: y.activations / st.avg_activations });
      if (st.avg_direct_recruits > 0) ratios.push({ k: 'team', r: y.direct_recruits / st.avg_direct_recruits });
      if (st.avg_lymx_volume_per_biz > 0) ratios.push({ k: 'volume', r: y.avg_lymx_volume_per_biz / st.avg_lymx_volume_per_biz });
      ratios.sort(function (a, b) { return a.r - b.r; });
      if (ratios.length) weak = ratios[0];
      if (weak) {
        if (weak.k === 'team') advice = 'Compared with the network you have <strong>fewer team partners than average</strong> (' + y.direct_recruits + ' vs ' + st.avg_direct_recruits + '). Building your team is your biggest untapped lever — lean into the Builder plan below.';
        else if (weak.k === 'activations') advice = 'You’re <strong>below the network on activations</strong> (' + y.activations + ' vs avg ' + st.avg_activations + ', top ' + st.top_activations + '). Recruiting more businesses is your fastest path — lean into the Hunter plan.';
        else if (weak.k === 'volume') advice = 'Your businesses generate <strong>less LYMX than average</strong> (' + Math.round(y.avg_lymx_volume_per_biz / 1000) + 'k vs ' + Math.round(st.avg_lymx_volume_per_biz / 1000) + 'k / mo). Recruit higher-volume types (cafés, fast food) or help current ones drive activity — that lifts every override you already earn.';
      }
    }

    // Two concrete plans to close the monthly-cash goal
    var bizActive = perBizMonthly > 0 ? Math.ceil(goal / perBizMonthly) : 0;          // passive: total active biz
    var bizPerMonthBonus = CFG.signup > 0 ? Math.ceil(goal / CFG.signup) : 0;          // active: recruit N/mo for bonus income
    var g1Needed = perG1BizMonthly > 0 ? Math.ceil(goal / (Math.max(1, state.team.g1B) * perG1BizMonthly)) : 0;

    var html = '';
    if (advice) html += '<div style="background:rgba(245,209,114,.12);border:1px solid var(--gold);border-radius:10px;padding:12px 14px;margin-bottom:12px;font-size:13.5px">🤖 ' + advice + '</div>';
    if (r.monthlyCash >= goal) {
      html += '<p style="font-weight:700;color:var(--ok)">Your current plan already projects ' + usd(r.monthlyCash) + '/mo — above your ' + usd(goal) + ' goal. 🎉</p>';
    } else {
      var gap = goal - r.monthlyCash;
      html += '<p style="font-weight:700;margin:0 0 8px">To reach ' + usd(goal) + '/mo (you’re at ' + usd(r.monthlyCash) + ', gap ' + usd(gap) + '):</p>';
      html += '<div class="focus-item top"><span class="fl">🎯 Hunter — active income</span><span class="fv">recruit ~' + bizPerMonthBonus + ' biz / month<small>' + usd(bizPerMonthBonus * CFG.signup) + '/mo in sign-up bonuses</small></span></div>';
      html += '<div class="focus-item"><span class="fl">💰 Passive — recurring overrides</span><span class="fv">build to ~' + bizActive + ' active biz<small>' + usd(bizActive * perBizMonthly) + '/mo, hands-off</small></span></div>';
      html += '<div class="focus-item"><span class="fl">🌳 Builder — leverage a team</span><span class="fv">~' + g1Needed + ' G1 partners<small>each ≈' + state.team.g1B + ' biz → ' + usd(g1Needed * state.team.g1B * perG1BizMonthly) + '/mo passive</small></span></div>';
      html += '<p class="disc">Sign-up bonuses are the fastest cash but stop when you stop; overrides are smaller per unit but recurring. Most top earners do both: hunt for momentum, build for stability.</p>';
    }
    out.innerHTML = html;
  }

  async function saveGoal() {
    var goal = +$('goal-input').value || 0;
    if (goal <= 0) { runGoalPlanner(); return; }
    try {
      if (window.LYMX && window.LYMX.sb) {
        var res = await window.LYMX.sb.rpc('set_partner_goal', { p_goal: goal });
        if (!res.error) { myGoal = goal; renderGoalMeter(); }
      }
    } catch (e) { console.warn('[projector] saveGoal', e); }
    runGoalPlanner();
  }
  function renderGoalMeter() {
    var el = $('goal-meter'); if (!el) return;
    if (!myGoal || myGoal <= 0) { el.style.display = 'none'; return; }
    var pct = Math.min(100, Math.round(monthCash / myGoal * 100));
    var hit = monthCash >= myGoal;
    el.style.display = '';
    el.innerHTML = '<div style="display:flex;justify-content:space-between;font-size:12.5px;font-weight:700;margin-bottom:4px">' +
      '<span>This month: ' + usd(monthCash) + ' / goal ' + usd(myGoal) + '</span><span style="color:' + (hit ? 'var(--ok)' : 'var(--accent-2)') + '">' + pct + '%</span></div>' +
      '<div class="bar" style="height:12px"><div class="fill" style="width:' + pct + '%;background:' + (hit ? 'linear-gradient(90deg,#13a26b,#0a7d52)' : 'linear-gradient(90deg,#d4af37,#b8901f)') + '"></div></div>' +
      '<div class="bsub">' + (hit ? '🎉 Goal hit this month — set a higher one!' : usd(myGoal - monthCash) + ' to go this month. The daily digest will keep you posted.') + '</div>';
    if ($('goal-input') && !$('goal-input').value) $('goal-input').value = myGoal;
  }

  // ---------- async: real income + benchmarks ----------
  async function loadPartnerData() {
    try {
      if (!window.LYMX || !window.LYMX.getSession) return;
      var sess = await window.LYMX.getSession(); if (!sess) return;
      var sb = window.LYMX.sb, pid = null;
      var pr = await sb.from('partners').select('id').eq('user_id', sess.user.id).limit(1);
      if (pr.data && pr.data.length) pid = pr.data[0].id;
      if (!pid && sess.user.email) {
        var p2 = await sb.from('partners').select('id').ilike('contact_email', sess.user.email.toLowerCase()).limit(1);
        if (p2.data && p2.data.length) pid = p2.data[0].id;
      }
      if (!pid) return;
      myPid = pid;

      // current-month cash (for the goal meter)
      try {
        var mo = new Date(); mo.setDate(1); mo.setHours(0,0,0,0);
        var mc = await sb.from('partner_commissions').select('amount,payout_kind,created_at').eq('partner_id', pid).gte('created_at', mo.toISOString());
        (mc.data || []).forEach(function (x) { if (x.payout_kind !== 'lymx') monthCash += Number(x.amount || 0); });
      } catch (e) {}
      // saved goal
      try { var g = await sb.from('partner_goals').select('monthly_cash_goal').eq('partner_id', pid).limit(1); if (g.data && g.data.length) { myGoal = Number(g.data[0].monthly_cash_goal || 0); } } catch (e) {}
      renderGoalMeter();

      var sum = await sb.rpc('partner_income_summary', { p_partner_id: pid });
      if (!sum.error && sum.data) {
        var pend = 0;
        var op = await sb.from('partner_commissions').select('amount,payout_kind,settlement_id').eq('partner_id', pid).is('settlement_id', null);
        (op.data || []).forEach(function (x) { if (x.payout_kind !== 'lymx') pend += Number(x.amount || 0); });
        $('real-cash').textContent = usd(sum.data.cash_total);
        $('real-lymx').textContent = lymxF(sum.data.lymx_total);
        $('real-pending').textContent = usd(pend);
        $('real-wrap').style.display = '';
      }

      var bm = await sb.rpc('partner_benchmarks', { p_partner_id: pid });
      if (!bm.error && bm.data) { bench = bm.data; renderBench(); }
    } catch (e) { console.warn('[projector] partner data load failed', e); }
  }

  function bar(youVal, avgVal) {
    var scale = Math.max(youVal, avgVal * 1.6, 1);
    var youPct = Math.min(100, youVal / scale * 100);
    var avgPct = Math.min(100, avgVal / scale * 100);
    return '<div class="bar"><div class="fill" style="width:' + youPct + '%"></div><div class="avg" style="left:' + avgPct + '%"></div></div>';
  }
  function renderBench() {
    if (!bench || !bench.you) return;
    var y = bench.you, st = bench.site;
    var items = [
      { label: 'Activations (businesses signed)', you: y.activations, avg: st.avg_activations, fmt: function (n) { return Math.round(n); }, sub: 'network avg ' + st.avg_activations + ' · top ' + st.top_activations },
      { label: 'Team partners (G1)', you: y.direct_recruits, avg: st.avg_direct_recruits, fmt: function (n) { return Math.round(n); }, sub: 'network avg ' + st.avg_direct_recruits },
      { label: 'Avg LYMX / business / mo', you: y.avg_lymx_volume_per_biz, avg: st.avg_lymx_volume_per_biz, fmt: function (n) { return Math.round(n / 1000) + 'k'; }, sub: 'network avg ' + Math.round(st.avg_lymx_volume_per_biz / 1000) + 'k' },
      { label: 'Lifetime cash earned', you: y.cash_lifetime, avg: st.avg_cash_lifetime, fmt: function (n) { return usd(n); }, sub: 'network avg ' + usd(st.avg_cash_lifetime) }
    ];
    $('bench').innerHTML = items.map(function (it) {
      var ahead = it.you >= it.avg;
      return '<div class="b"><div class="blabel"><span>' + it.label + '</span><span class="you">' + it.fmt(it.you) +
        ' <span style="color:' + (ahead ? 'var(--ok)' : 'var(--danger)') + '">' + (ahead ? '↑ ahead' : '↓ behind') + '</span></span></div>' +
        bar(it.you, it.avg) + '<div class="bsub">' + it.sub + '</div></div>';
    }).join('');
    $('bench-wrap').style.display = '';
  }

  // ---------- load category economics from DB (Rule 5: one tunable source) ----------
  async function loadCategories() {
    try {
      var cfg = window.LYMX_CONFIG;
      if (!cfg || !cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY) return;
      var r = await fetch(cfg.SUPABASE_URL + '/rest/v1/rpc/current_category_benchmarks', {
        method: 'POST',
        headers: { apikey: cfg.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + cfg.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
        body: '{}'
      });
      if (!r.ok) return;
      var rows = await r.json();
      if (!Array.isArray(rows) || !rows.length) return;
      rows.forEach(function (row) {
        var c = CATS.find(function (x) { return x.key === row.key; });
        if (c) { c.name = row.name || c.name; c.icon = row.icon || c.icon; c.sub = row.sub || c.sub; c.iss = Number(row.lymx_issued) || c.iss; c.red = Number(row.lymx_redeemed) || c.red; }
        else { CATS.push({ key: row.key, icon: row.icon || '🏬', name: row.name || row.key, sub: row.sub || '', iss: Number(row.lymx_issued) || 0, red: Number(row.lymx_redeemed) || 0 });
               if (state.counts[row.key] == null) state.counts[row.key] = 0; }
      });
      renderCats(); renderOutputs();
    } catch (e) { console.warn('[projector] category benchmarks load failed; using built-in estimates', e); }
  }

  // ---------- init ----------
  function init() {
    applyCfg();
    renderCats(); renderTeam(); renderOutputs(); bindEvents();
    loadCategories();
    if (window.LYMXComp && window.LYMXComp.ready) {
      window.LYMXComp.ready.then(function () { applyCfg(); renderTeam(); renderOutputs(); });
    }
    loadPartnerData();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
