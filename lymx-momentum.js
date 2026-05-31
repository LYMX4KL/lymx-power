/* lymx-momentum.js — Partner "momentum" delight layer.
 * Injects a card with: milestone badges, a progress bar to the next goal,
 * a leaderboard-rank nudge, and a one-time confetti celebration when a fresh
 * activation bonus has landed. Self-contained: computes from the partner's own
 * commission ledger (RLS-readable) — no schema assumptions beyond mig 138/139.
 * Built 2026-05-30 for the income-excitement feature set.
 */
(function () {
  if (window.__lymxMomentum) return;
  window.__lymxMomentum = true;

  function fmt(n){ return '$' + Number(n||0).toLocaleString('en-US',{maximumFractionDigits:0}); }

  function confetti() {
    try {
      var c = document.createElement('canvas');
      c.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:9999';
      document.body.appendChild(c);
      var ctx = c.getContext('2d'); c.width = innerWidth; c.height = innerHeight;
      var colors = ['#d4af37','#0a84ff','#13a26b','#f0a020','#e0413e','#b88a2e'];
      var P = [];
      for (var i=0;i<140;i++) P.push({x:Math.random()*c.width,y:-20-Math.random()*c.height*0.5,
        r:4+Math.random()*6,c:colors[(Math.random()*colors.length)|0],
        vy:2+Math.random()*4,vx:-2+Math.random()*4,rot:Math.random()*6,vr:-.2+Math.random()*.4});
      var t0 = Date.now();
      (function tick(){
        ctx.clearRect(0,0,c.width,c.height);
        P.forEach(function(p){ p.x+=p.vx; p.y+=p.vy; p.rot+=p.vr;
          ctx.save(); ctx.translate(p.x,p.y); ctx.rotate(p.rot); ctx.fillStyle=p.c;
          ctx.fillRect(-p.r/2,-p.r/2,p.r,p.r*1.6); ctx.restore(); });
        if (Date.now()-t0 < 2600) requestAnimationFrame(tick); else c.remove();
      })();
    } catch(e){ /* confetti is best-effort */ } // bandaid-ok: purely cosmetic canvas animation, no user data
  }

  function toast(msg) {
    var t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;left:50%;top:24px;transform:translateX(-50%);z-index:10000;background:linear-gradient(135deg,#1a1f27,#0e1116);color:#fff;padding:14px 22px;border-radius:12px;font-weight:800;font-size:16px;box-shadow:0 14px 40px rgba(0,0,0,.3);border:1px solid #d4af37';
    document.body.appendChild(t);
    setTimeout(function(){ t.style.transition='opacity .5s'; t.style.opacity='0'; setTimeout(function(){t.remove();},500); }, 3600);
  }

  function badgesHtml(stats) {
    var defs = [
      { on: stats.activations >= 1,  ic:'🥇', t:'First Activation' },
      { on: stats.activations >= 5,  ic:'🔥', t:'5 Activations' },
      { on: stats.activations >= 10, ic:'⭐', t:'10 Activations' },
      { on: stats.activations >= 25, ic:'👑', t:'25 Activations' },
      { on: stats.founding,          ic:'🏛️', t:'Founding 25' },
      { on: stats.lifeCash >= 1000,  ic:'💰', t:'First $1K' },
      { on: stats.lifeCash >= 10000, ic:'🚀', t:'$10K Club' }
    ];
    return defs.map(function(b){
      return '<div title="'+b.t+'" style="display:flex;flex-direction:column;align-items:center;gap:4px;opacity:'+(b.on?'1':'.28')+';filter:'+(b.on?'none':'grayscale(1)')+'">'+
        '<div style="font-size:26px;line-height:1">'+b.ic+'</div>'+
        '<div style="font-size:10.5px;font-weight:700;color:#5b6472;text-align:center;max-width:74px">'+b.t+'</div></div>';
    }).join('');
  }

  function nextGoal(stats) {
    var tiers = [1,5,10,25,50];
    var next = tiers.find(function(t){ return stats.activations < t; });
    if (next) return { label: next + ' activations', cur: stats.activations, target: next, kind:'count' };
    var cashTiers = [1000,5000,10000,25000,50000];
    var nc = cashTiers.find(function(t){ return stats.lifeCash < t; });
    if (nc) return { label: fmt(nc) + ' lifetime cash', cur: stats.lifeCash, target: nc, kind:'cash' };
    return null;
  }

  async function run() {
    try {
      if (!window.LYMX || !window.LYMX.getSession) return;
      var sess = await window.LYMX.getSession(); if (!sess) return;
      var sb = window.LYMX.sb;
      var pid = null, founding = false, joinedAt = null;
      var pr = await sb.from('partners').select('id, is_founding_25, display_name, created_at').eq('user_id', sess.user.id).limit(1);
      if (pr.data && pr.data.length) { pid = pr.data[0].id; founding = !!pr.data[0].is_founding_25; joinedAt = pr.data[0].created_at; }
      if (!pid && sess.user.email) {
        var pr2 = await sb.from('partners').select('id, is_founding_25, created_at').ilike('contact_email', sess.user.email.toLowerCase()).limit(1);
        if (pr2.data && pr2.data.length) { pid = pr2.data[0].id; founding = !!pr2.data[0].is_founding_25; joinedAt = pr2.data[0].created_at; }
      }
      if (!pid) return;

      var cr = await sb.from('partner_commissions')
        .select('id, amount, payout_kind, source_kind, generation, created_at')
        .eq('partner_id', pid);
      var rows = cr.data || [];
      var stats = { activations:0, lifeCash:0 };
      var latestAct = null, speedEarned = false;
      rows.forEach(function(r){
        if (r.payout_kind !== 'lymx') stats.lifeCash += Number(r.amount||0);
        if (r.source_kind === 'speed_bonus') speedEarned = true;
        if (r.source_kind === 'activation' && r.generation === 0) {
          stats.activations++;
          if (!latestAct || new Date(r.created_at) > new Date(latestAct.created_at)) latestAct = r;
        }
      });
      stats.founding = founding;

      // One-time confetti when a fresh activation bonus (<48h) hasn't been celebrated
      if (latestAct) {
        var ageH = (Date.now() - new Date(latestAct.created_at).getTime())/36e5;
        var key = 'lymx_celebrated_' + latestAct.id;
        if (ageH < 48 && !localStorage.getItem(key)) {
          confetti(); toast('🎉 ' + fmt(latestAct.amount) + ' activation bonus earned!');
          try { localStorage.setItem(key, '1'); } catch(e){} // bandaid-ok: localStorage write is best-effort (private-mode safe)
        }
      }

      // Build the card
      // Founding-25 $1,000 speed bonus countdown (5 activations within 3 months of joining)
      var speedHtml = '';
      if (founding && joinedAt && !speedEarned) {
        var windowEnd = new Date(joinedAt); windowEnd.setMonth(windowEnd.getMonth() + 3);
        var daysLeft = Math.ceil((windowEnd.getTime() - Date.now()) / 86400000);
        var actsInWindow = rows.filter(function(r){ return r.source_kind==='activation' && r.generation===0 && new Date(r.created_at) <= windowEnd; }).length;
        var need = Math.max(0, 5 - actsInWindow);
        if (daysLeft > 0 && need > 0) {
          speedHtml = '<div style="margin-top:12px;padding:12px 14px;border:1px dashed #d4af37;border-radius:10px;background:rgba(245,209,114,.08)">'+
            '<div style="font-weight:800;font-size:13.5px">🚀 $1,000 Founding speed bonus</div>'+
            '<div style="font-size:12.5px;color:#5b6472;margin-top:2px">'+actsInWindow+' of 5 activations · <strong>'+need+'</strong> more in <strong>'+daysLeft+'</strong> day'+(daysLeft===1?'':'s')+' to earn it.</div></div>';
        } else if (daysLeft <= 0 && need > 0) {
          speedHtml = '';
        }
      }
      var goal = nextGoal(stats);
      var pct = goal ? Math.min(100, Math.round((goal.cur/goal.target)*100)) : 100;
      var goalHtml = goal
        ? '<div style="font-size:13px;color:#5b6472;font-weight:700;margin-bottom:6px">Next goal: '+goal.label+'</div>'+
          '<div style="background:#eef0f3;border-radius:99px;height:12px;overflow:hidden"><div style="height:100%;width:'+pct+'%;background:linear-gradient(90deg,#d4af37,#b88a2e);border-radius:99px;transition:width .6s"></div></div>'+
          '<div style="font-size:11.5px;color:#5b6472;margin-top:4px">'+pct+'% there</div>'
        : '<div style="font-size:13px;color:#13a26b;font-weight:800">All milestones cleared — legend status. 👑</div>';

      var card = document.createElement('div');
      card.style.cssText = 'background:#fff;border:1px solid #e6e8ec;border-radius:14px;padding:18px 20px;box-shadow:0 10px 30px rgba(14,17,22,.08);margin:0 0 18px';
      card.innerHTML =
        '<div style="font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#5b6472;font-weight:700;margin-bottom:12px">Your momentum</div>'+
        '<div style="display:flex;gap:18px;flex-wrap:wrap;margin-bottom:16px">'+badgesHtml(stats)+'</div>'+
        goalHtml + speedHtml +
        '<div id="lymxRankNudge" style="font-size:12.5px;color:#5b6472;margin-top:10px"></div>';

      var host = document.querySelector('main') || document.body;
      var anchor = document.querySelector('.wrap') || host;
      (anchor.firstElementChild ? anchor : host).insertBefore(card, (anchor.firstElementChild || null));

      // Leaderboard nudge — ranked by this-month business activations, which is
      // cross-partner readable (cross-partner commission rows are blocked by RLS).
      // Matches how partner-leaderboard.html ranks. Best-effort.
      try {
        var moStart = new Date(); moStart.setDate(1); moStart.setHours(0,0,0,0);
        var allP = await sb.from('partners').select('id, display_name, legal_name').is('archived_at', null).limit(1000);
        var allB = await sb.from('businesses').select('signed_up_by_partner_id, signup_paid_at, created_at').is('archived_at', null).limit(3000);
        if (allP.data && allB.data) {
          var tally = {};
          allB.data.forEach(function(b){
            var when = b.signup_paid_at || b.created_at;
            if (b.signed_up_by_partner_id && when && new Date(when) >= moStart)
              tally[b.signed_up_by_partner_id] = (tally[b.signed_up_by_partner_id]||0)+1;
          });
          var board = allP.data.map(function(p){
            return { id:p.id, name:(p.display_name || (p.legal_name||'Partner').split(' ')[0]), n:(tally[p.id]||0) };
          }).filter(function(x){ return x.n > 0 || x.id === pid; })
            .sort(function(a,b){ return b.n - a.n; });
          var idx = board.findIndex(function(x){ return x.id === pid; });
          var el = document.getElementById('lymxRankNudge');
          if (idx === 0 && board[0].n > 0) el.textContent = '🏆 You are #1 this month with ' + board[0].n + ' activations. Keep it up!';
          else if (idx > 0) {
            var ahead = board[idx-1];
            var gap = ahead.n - board[idx].n;
            el.textContent = 'You are #' + (idx+1) + ' this month — ' + (gap<=0?'tied with':gap+' activation'+(gap===1?'':'s')+' from passing') + ' ' + ahead.name + '. 💪';
          } else el.textContent = 'Activate your first business this month to climb the leaderboard. 🚀';
        }
      } catch(e){ /* leaderboard nudge optional */ } // bandaid-ok: cosmetic rank nudge; card already rendered, outer catch logs
    } catch (e) { console.warn('[lymx-momentum] failed', e); }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function(){ setTimeout(run, 400); });
  else setTimeout(run, 400);
})();
