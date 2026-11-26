/**
 * @fileoverview Swarm pane Overview and Members views.
 *
 * Renders the narrator's goal, threads, running tasks and progress (Overview)
 * and the member list (Members) from the /api/swarm snapshot app.js already
 * polls. Members are drawn as pixel bees. app.js calls
 * window.SwarmHive.update(snapshot, element, {view: 'overview' | 'cards'}).
 * Every string from the board or the narrator goes through esc().
 */
(function() {
  let S = {}, P = [];
  const state = {view: 'overview'};
  const $ = (s, el = document) => el.querySelector(s);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
  const people = sc => Object.entries(sc.members).filter(([n, x]) => !x.system);
  const ORDER = {needs_you: 0, working: 1, waiting_on: 2, parked: 3};

  /* ---------- pixel bees ---------- */
  const HUE = {coordinator:46};
  function hsl2hex(h,s,l){ h=((h%360)+360)%360; s/=100; l/=100; const k=n=>(n+h/30)%12; const a=s*Math.min(l,1-l); const f=n=>l-a*Math.max(-1,Math.min(k(n)-3,Math.min(9-k(n),1))); return '#'+[f(0),f(8),f(4)].map(x=>Math.round(x*255).toString(16).padStart(2,'0')).join(''); }
  const shiftHue=(h,target,amt)=>{ const d=((target-h+540)%360)-180; return h+d*amt; };
  function ramp(n){ const h=hueOf(n); return {
    spec: hsl2hex(shiftHue(h,55,0.28), 96, 90), hi: hsl2hex(shiftHue(h,55,0.18), 90, 74), mid: hsl2hex(h, 78, 60),
    sh: hsl2hex(shiftHue(h,265,0.22), 58, 44), ol: hsl2hex(shiftHue(h,265,0.35), 42, 19),
    skh: hsl2hex(shiftHue(h,265,0.15), 20, 30), sk: hsl2hex(shiftHue(h,265,0.3), 24, 18), skd: hsl2hex(shiftHue(h,265,0.45), 32, 10) }; }
  const tcol = n => hsl2hex(hueOf(n), 78, 60);
  const hueOf = n => HUE[n] ?? [12,150,262,330,196,228,96,28,290,175,350,60][hash(String(n))%12];
  const hash = s => [...s].reduce((a,c)=>(a*31+c.charCodeAt(0))>>>0, 7);
  const HEXD = (s => encodeURIComponent(s).replace(/'/g, '%27'))(`<svg xmlns='http://www.w3.org/2000/svg' width='28' height='24.25' viewBox='0 0 28 24.25'><path d='M14 0l12.12 7v14l-12.12 7L1.88 21V7z' fill='none' stroke='rgba(255,255,255,0.08)' stroke-width='1.2'/></svg>`);
  // Tiles tint the host card color so they work in light and dark themes.
  const tileTint = n => `color-mix(in srgb, ${tcol(n)} 22%, var(--sw-card, #fff))`;
  const hexBG = n => n==='coordinator' ? `background:#1C1B22 url('data:image/svg+xml,${HEXD}')` : `background:${tileTint(n)}`;

  function drawBee(cv, name, state, frame){
    const W=22,H=18; cv.width=W; cv.height=H; const c=cv.getContext('2d'); c.imageSmoothingEnabled=false; c.clearRect(0,0,W,H);
    const R=ramp(name), queen=name==='coordinator', landed=(state==='parked'||state==='landed'), asleep=state==='parked';
    const P=(x,y,col)=>{ if(x<0||y<0||x>=W||y>=H) return; c.fillStyle=col; c.fillRect(x,y,1,1); };
    const cx=11, cy=10.5, rx=7.3, ry=4.8;
    const inside=(x,y)=>{ const nx=(x+0.5-cx)/rx, ny=(y+0.5-cy)/ry; return nx*nx+ny*ny<=1; };
    let L=[-0.42,-0.62,0.66]; const Ln=Math.hypot(...L); L=L.map(v=>v/Ln);
    const N4=[[1,0],[-1,0],[0,1],[0,-1]];
    const rows=(spec)=>{ const pts=[]; spec.forEach(([y,x0,x1])=>{ for(let x=x0;x<=x1;x++) pts.push([x,y]); }); return pts; };
    const drawWing=(pts, glint)=>{ const set=new Set(pts.map(p=>p.join(','))); pts.forEach(([x,y])=>{ const edge=N4.some(([dx,dy])=>!set.has((x+dx)+','+(y+dy))); P(x,y, edge?'rgba(140,160,192,0.9)':'rgba(255,255,255,0.72)'); });
      if(glint){ const tl=pts.filter(([x,y])=>!N4.some(([dx,dy])=>!set.has((x+dx)+','+(y+dy)))).sort((a,b)=>(a[1]-b[1])||(a[0]-b[0])); if(tl[0]) P(tl[0][0],tl[0][1],'#FFFFFF'); } };
    let back=null, front;
    if(landed){ front=rows([[5,14,17],[6,13,18]]); }
    else if(frame===0){ back=rows([[1,16,17],[2,16,18],[3,15,18],[4,15,17],[5,15,16]]); front=rows([[0,13,14],[1,12,15],[2,11,15],[3,11,14],[4,11,13],[5,11,12]]); }
    else { back=rows([[3,16,18],[4,15,19],[5,16,18]]); front=rows([[3,13,16],[4,12,17],[5,12,17],[6,13,15]]); }
    if(back) drawWing(back,false);
    const stripe=(x,y)=>{ const ny=(y+0.5-cy)/ry; const u=x+0.5+1.15*ny*ny; return (u>10.6&&u<12.5)||(u>14.3&&u<16.1)||(u>17.9); };
    for(let y=0;y<H;y++) for(let x=0;x<W;x++){
      if(!inside(x,y)) continue;
      const nx=(x+0.5-cx)/rx, ny=(y+0.5-cy)/ry, rr=Math.min(1,nx*nx+ny*ny), nz=Math.sqrt(1-rr);
      const I=nx*L[0]+ny*L[1]+nz*L[2];
      P(x,y, stripe(x,y) ? (I>0.80?R.skh : I>0.30?R.sk : R.skd) : (I>0.965?R.spec : I>0.78?R.hi : I>0.26?R.mid : R.sh));
    }
    for(let y=0;y<H;y++) for(let x=0;x<W;x++){
      if(inside(x,y)) continue;
      const nbs=N4.filter(([dx,dy])=>inside(x+dx,y+dy)); if(!nbs.length) continue;
      const nx=(x+0.5-cx)/rx, ny=(y+0.5-cy)/ry, n=Math.hypot(nx,ny); const d=(nx/n)*L[0]+(ny/n)*L[1];
      const nextToStripe=nbs.some(([dx,dy])=>stripe(x+dx,y+dy));
      P(x,y, (d>0.5 && !nextToStripe) ? R.sh : R.ol);
    }
    // stinger
    P(19,10,R.ol); P(20,10,R.ol);
    // face
    if(asleep){ P(6,10,R.ol); P(7,10,R.ol); }
    else { P(6,9,'#FFFFFF'); P(7,9,R.skd); P(6,10,R.skd); P(7,10,R.skd); }
    P(5,11,'rgba(255,128,150,0.55)'); P(4,11,'rgba(255,128,150,0.35)');
    // antennae or crown
    if(queen){ const g1='#F7CE5B', g2='#FFE9A6', g3='#C98A2B'; [[5,5],[6,5],[7,5],[8,5],[9,5]].forEach(([x,y])=>P(x,y,g1)); P(5,4,g2); P(7,4,g2); P(9,4,g2); P(7,3,g2); P(5,5,g3); P(9,5,g3); P(7,5,'#E4566A'); }
    else { [[7,5],[6,4],[5,3]].forEach(([x,y])=>P(x,y,R.ol)); P(4,3,R.sk); [[9,5],[9,4],[9,3]].forEach(([x,y])=>P(x,y,R.ol)); P(8,2,R.sk); }
    drawWing(front,true);
    if(asleep){ const z='#8C90A6'; [[0,0],[1,0],[2,0],[3,0],[2,1],[1,2],[0,3],[1,3],[2,3],[3,3]].forEach(([x,y])=>P(x,y,z)); }
  }
  // Cache each rendered 22x18 bee frame once in an offscreen canvas and blit via
  // drawImage instead of re-running the per-pixel fillRect loops on every render.
  const spriteCanvases = new Map();
  function beeCanvas(n, st, frame){
    const k = `${n}\0${st||''}\0${frame}`;
    let cv = spriteCanvases.get(k);
    if(!cv){
      if(spriteCanvases.size > 1024) spriteCanvases.clear();
      cv = document.createElement('canvas');
      drawBee(cv, n, st, frame);
      spriteCanvases.set(k, cv);
    }
    return cv;
  }
  function blitBee(dst, n, st, frame){
    const src = beeCanvas(n, st, frame);
    if(dst.width !== src.width) dst.width = src.width;
    if(dst.height !== src.height) dst.height = src.height;
    const c = dst.getContext('2d'); c.imageSmoothingEnabled = false;
    c.clearRect(0, 0, src.width, src.height);
    c.drawImage(src, 0, 0);
  }
  const spriteTag = (n, state) => `<span class="beebox" data-state="${esc(state||'working')}"><span class="beewrap" data-bee="${esc(n)}" data-state="${esc(state||'working')}"><canvas></canvas><canvas></canvas></span><i class="gsh"></i></span>`;
  function paintSprites(el){ el.querySelectorAll('.beewrap').forEach(w=>{ const [a,b]=w.querySelectorAll('canvas'); blitBee(a, w.dataset.bee, w.dataset.state, 0); blitBee(b, w.dataset.bee, w.dataset.state, 1); }); }

  // Board avatars: one still (landed) bee per name, drawn once and reused as an <img>.
  const beeImgs = new Map();
  function beeImg(n){
    if(!beeImgs.has(n)) beeImgs.set(n, beeCanvas(n, 'landed', 0).toDataURL());
    return beeImgs.get(n);
  }

  // Nudge each bee onto the device pixel grid so the sprites stay crisp. Reads
  // all positions first (without the previous nudge), then writes.
  function snapBees(root){
    const dpr=window.devicePixelRatio||1;
    const boxes=[...root.querySelectorAll('.beebox')];
    const rects=boxes.map(b=>{ const r=b.getBoundingClientRect(); const m=/translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(b.style.transform||''); return {x:r.left-(m?+m[1]:0), y:r.top-(m?+m[2]:0)}; });
    boxes.forEach((b,i)=>{ const fx=(rects[i].x*dpr)%1, fy=(rects[i].y*dpr)%1; const dx=(fx>0.5?1-fx:-fx)/dpr, dy=(fy>0.5?1-fy:-fy)/dpr;
      b.style.transform = (Math.abs(dx)>0.01||Math.abs(dy)>0.01) ? `translate(${dx}px,${dy}px)` : ''; });
  }
  let snapQueued=false;
  const snapAll=()=>{ if(snapQueued) return; snapQueued=true; requestAnimationFrame(()=>{ snapQueued=false; document.querySelectorAll('.pane').forEach(snapBees); }); };
  window.addEventListener('scroll', snapAll, {passive:true, capture:true});
  window.addEventListener('resize', snapAll);

  const COPY_UI = { team:'The team', lead:'Coordinator', blocked:'Blocked', running:'Running', planned:'Planned next', done:'Done',
    more:'+{n} more', goal:'Goal', threads:'Threads', now:'Now', progress:'Progress', compare:'Compare with now', expand:'Open full timeline', none_blocked:'Nothing blocked', needs:'Needs you', waiting:'Waiting on @coordinator', stuck:'Stuck', none_waiting:'Nothing waiting', none_stuck:'Nothing stuck', none_needs:'Nothing needs you', none_running:'Nothing running', none_planned:'Nothing planned' };
  // Workers never ask the user: their decisions, reviews and quota wait on the
  // coordinator, and their failures show on the worker as Stuck or Error. Only
  // the coordinator stopping for the user (a reply in chat, quota, a failure)
  // needs the user. toModel sets each attention item's `wait` to
  // 'you' | 'coordinator' | 'issue'.
  const ISSUE_KINDS = new Set(['failure','stuck','error']);
  const waitOn = n => `Waiting on @${n}`;
  // Short copy the narrator writes next to each item (view.json `short` and `now`).
  function copy(){ const a=(window.SwarmHive||{}).viewCopy||{};
    return { ui:a.ui||{}, lead:a.lead||{}, members:a.members||{}, items:a.items||{} }; }
  function ui(k){ const c=copy().ui||{}; return c[k] || COPY_UI[k]; }
  function clipWords(s, n){ s=String(s||'').replace(/\s*\([^)]*\)/g,'').replace(/\s+/g,' ').trim(); const w=s.split(' '); return w.length>n ? w.slice(0,n).join(' ').replace(/[,;:.]$/,'')+'…' : s.replace(/\.$/,''); }
  function firstClause(s){ return String(s||'').split(/(?<=[.!?])\s+(?=[A-Z])|;\s|\s[–—-]\s/)[0]; }
  // A leading [done] tag, with markdown wrappers and the punctuation after it.
  const stripDone = s => String(s||'').replace(/^\s*(?:\*\*|\*|`|_)?\[done\](?:\*\*|\*|`|_)?[\s:,.–—-]*/i,'');
  function itemCopy(id, title, line, full){ const c=(copy().items||{})[id]||{}; return { title: c.title || (full ? String(title||'') : clipWords(title, 14)), line: c.line || clipWords(firstClause(stripDone(line)), 12) }; }
  // A working member's latest step (newest tool call or thinking heading in its
  // transcript), drawn with the in-progress shimmer. Views re-render on every
  // poll, so the shimmer is phased off the wall clock to keep sweeping.
  const SHIMMER_MS = 1900;   // .animate-shimmer-text cycle (styles.css --shimmer-ms)
  const liveText = (live, text) =>
    `<span class="animate-shimmer-text" style="animation-delay:-${Date.now() % SHIMMER_MS}ms">${esc(text ?? live.text)}</span>`;
  const liveTip = live => `${live.kind==='thinking' ? 'Thinking' : 'Latest action'}: ${live.text}`;
  // Live activity beats the narrator's copy, which lags the board.
  function memberLine(n, x){ if(x && x.live) return clipWords(firstClause(x.live.text), 8); const c=copy().members||{}; if(c[n]) return c[n]; if(n==='coordinator'){ const l=(copy().lead||{}).doing; if(l) return l; } return clipWords(firstClause(x.now||''), 6); }
  function cleanNote(s, fallback){
    let x = String(s||'').replace(/\s*\(#\d+(?:\s*,\s*#\d+)*\)\s*\.?$/,'').replace(/^\s+/,'').replace(/^(?:\*\*|\*|`|_)?\[done\](?:\*\*|\*|`|_)?[\s:,.–—-]*/i,'').replace(/\*\*|__|`/g,'').replace(/\s+/g,' ').trim();
    if(x) x = x.charAt(0).toUpperCase() + x.slice(1);
    return x || String(fallback||'').trim();
  }

  /* ---------- Shared bee badges, compact ring, Running card, and Done disclosure ---------- */
  function workerBadges(owners, max, sc){
    const lim = max || 2;
    const list = (owners||[]).slice(0, lim);
    const extra = Math.max(0, (owners||[]).length - list.length);
    return `<span class="o2-wchips">${list.map(n=>{
      const m = sc && sc.members && sc.members[n];
      const st = (sc && !sc.finished && m && !m.killed && m.status==='working') ? 'working' : 'landed';
      return `<span class="o2-wchip bee" title="@${esc(n)}">${spriteTag(n, st)}<span>${esc(n)}</span></span>`;
    }).join('')}${extra>0?`<span class="o2-wchip more">+${extra}</span>`:''}</span>`;
  }

  function taskProgressPill(w){
    if(w && w.progress && w.progress.total>0){
      const pct = Math.min(100, Math.max(0, Math.round((w.progress.done / w.progress.total) * 100)));
      const lbl = w.progress.label || `${w.progress.done}/${w.progress.total}`;
      return `<span class="o2-tprog" title="${esc(lbl)} done"><span class="o2-tpbar"><i style="width:${pct}%"></i></span><span>${esc(lbl)}</span></span>`;
    }
    if(w && w.rawState==='review') return `<span class="o2-tprog rev">In review</span>`;
    return '';
  }

  function ringSvg(tot){
    const sum = tot.done + tot.running + tot.blocked + tot.queued;
    if(sum > 0 && tot.done === sum){
      return `<span class="o2-ring full" aria-hidden="true">✓</span>`;
    }
    const total = sum || 1;
    const C = 43.98;
    let off = 0;
    const segs = ['done','running','blocked'].map(k=>{
      if(!tot[k]) return '';
      const len = (tot[k] / total) * C;
      const s = `<circle cx="9" cy="9" r="7" fill="none" class="seg ${k}" stroke-width="2.2" stroke-dasharray="${len.toFixed(2)} ${C.toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}"/>`;
      off += len;
      return s;
    }).join('');
    return `<svg class="o2-ring" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="7" fill="none" class="trk" stroke-width="2.2"/>${segs}</svg>`;
  }

  function miniBar(n){
    const sum = n.done + n.running + n.blocked + n.queued || 1;
    return `<span class="o2-mbar" aria-hidden="true">${['done','running','blocked','queued'].map(k=>n[k]?`<i class="${k}" style="flex:${n[k]}"></i>`:'').join('')}</span>`;
  }

  function runningCard(sc, runningWs, summaryText, goalTitle, goalLine){
    if(!runningWs.length || sc.finished) return '';
    let sum = sc.runningSummary || '';
    if(!sum && sc.headline && sc.headline !== goalTitle && sc.headline !== goalLine) sum = sc.headline;
    if(!sum && !sc.fromPlan) sum = summaryText || '';
    const lim = state.o2runAll ? runningWs.length : 8;
    const vis = runningWs.slice(0, lim);
    const more = runningWs.length - vis.length;
    const ph = sc.phase && sc.phase.total > 1 ? `<span class="o2-runph">${esc(sc.phase.label)} · ${sc.phase.index}/${sc.phase.total}</span>` : '';
    const rows = vis.map(({w, st})=>{
      const c = itemCopy(w.id, w.title, w.note);
      const note = cleanNote(w.note, c.line);
      // An owner at work shows its live step; the narrator's note stays in the tooltip.
      const lm = st==='running' ? (w.owners||[]).map(n=>sc.members[n]).find(m=>m && !m.killed && m.live) : null;
      // Without a narrator view the note is the live step itself: don't repeat it.
      const extra = lm && note && note.toLowerCase() !== lm.live.text.toLowerCase() ? `\n${note}` : '';
      const noteHtml = lm
        ? `<p class="o2-runnote o2-live" data-testid="swarm-running-activity" title="${esc(liveTip(lm.live) + extra)}">${liveText(lm.live)}</p>`
        : (note ? `<p class="o2-runnote" title="${esc(w.note||note)}">${esc(note)}</p>` : '');
      return `<li class="o2-runrow ${st}">
        <span class="o2-ti ${st}" aria-label="${st}"></span>
        <div class="o2-runmain">
          <div class="o2-runtop">
            <b class="o2-runt">${esc(c.title)}</b>
            ${taskProgressPill(w)}
            ${workerBadges(w.owners, 2, sc)}
          </div>
          ${noteHtml}
        </div>
      </li>`;
    }).join('');
    return `<section class="o2-run">
      <div class="o2-runh"><span class="o2-rundot" aria-hidden="true"></span><b>${ui('running')}</b><em>${runningWs.length}</em>${ph}</div>
      ${sum ? `<p class="o2-runsum">${esc(sum)}</p>` : ''}
      <ul class="o2-runlist">${rows}</ul>
      ${more>0 ? `<button class="o2-more" data-o2="runAll">${ui('more').replace('{n}', more)}</button>` : ''}
    </section>`;
  }

  // Chips that say who the swarm is waiting on: "2 waiting on @coordinator",
  // "1 stuck". `waits` maps member -> count.
  function waitChips(waits, stuck){
    const out = [...waits.entries()].sort((a,b)=>b[1]-a[1]).slice(0,2)
      .map(([n,c])=>`<span class="o2-pchip warn"><i></i>${c} ${esc(waitOn(n).replace(/^W/,'w'))}</span>`);
    if(stuck > 0) out.push(`<span class="o2-pchip bad"><i></i>${stuck} stuck</span>`);
    return out;
  }
  const TSTATE = { done:'done', active:'running', review:'running', blocked:'blocked', failed:'blocked', queued:'queued' };
  const stOfWs = (sc, w) => { if(w.state!=='done' && w.state!=='blocked'){ const m=sc.members&&sc.members[w.owners[0]]; if(m && m.status==='waiting_on') return 'blocked'; } return TSTATE[w.state]||'queued'; };

  function progressCard(sc, tot, doneWs, queuedWs, openThreads, openAsks, extraChips){
    const totalCount = tot.done + tot.running + tot.blocked + tot.queued;
    const open = !!state.o2doneOpen;
    const revCount = (sc.workstreams||[]).filter(w=>w.rawState==='review' && stOfWs(sc, w)!=='blocked' && (!state.o2who || (w.owners||[]).includes(state.o2who))).length;
    const chips = [];
    if(openAsks > 0) chips.push(`<span class="o2-pchip warn"><i></i>${openAsks} need${openAsks===1?'s':''} you</span>`);
    chips.push(...(extraChips || []));
    if(revCount > 0) chips.push(`<span class="o2-pchip info"><i></i>${revCount} in review</span>`);
    if(openThreads) chips.push(`<span class="o2-pchip">${openThreads} thread${openThreads===1?'':'s'} open</span>`);
    else if(tot.running - revCount > 0) chips.push(`<span class="o2-pchip info"><i></i>${tot.running - revCount} active</span>`);
    const doneOrdered = doneWs.slice().sort((a,b)=>(b.seq||0)-(a.seq||0));
    const lim = state.o2doneAll ? doneOrdered.length : 8;
    const visDone = doneOrdered.slice(0, lim);
    const more = doneOrdered.length - visDone.length;
    const doneBody = visDone.length
      ? `<ul class="o2-donelist">${visDone.map(w=>{
          const c = itemCopy(w.id, w.title, w.note);
          const sub = cleanNote(c.line || w.note, '');
          return `<li><span class="o2-ti done" aria-label="done">✓</span><div class="o2-donem"><b>${esc(c.title)}</b>${sub?`<span>${esc(sub)}</span>`:''}</div>${workerBadges(w.owners, 2, sc)}</li>`;
        }).join('')}</ul>${more>0?`<button class="o2-more" data-o2="doneAll">${ui('more').replace('{n}', more)}</button>`:''}`
      : `<p class="o2-doneempty">No tasks completed yet.</p>`;
    const queuedBody = queuedWs.length
      ? `<div class="o2-queuedsub"><div class="o2-qhdr">Up next · ${queuedWs.length}</div><ul class="o2-donelist queued">${queuedWs.slice(0,6).map(w=>{
          const c = itemCopy(w.id, w.title, w.note);
          return `<li><span class="o2-ti queued" aria-label="queued"></span><div class="o2-donem"><b>${esc(c.title)}</b></div>${workerBadges(w.owners, 2, sc)}</li>`;
        }).join('')}</ul></div>`
      : '';
    return `<section class="o2-prog ${open?'open':''}">
      <button type="button" class="o2-progh" data-o2="doneOpen" aria-expanded="${open}">
        ${ringSvg(tot)}
        <span class="o2-progt"><b>${tot.done} of ${totalCount}</b> tasks done</span>
        <span class="o2-progr">${chips.join('')}<span class="o2-chev" aria-hidden="true"></span></span>
      </button>
      ${open ? `<div class="o2-progb">${doneBody}${queuedBody}</div>` : ''}
    </section>`;
  }

  // Progress reel: only when the narrator listed frames (it does so for UI work only).
  function reelCard(sc){
    const R = sc.reel;
    if(!R || R.length<2) return '';
    const postAt = s => { const p=P.find(q=>q.s>=s); return p ? p.t : sc.now; };
    const doneAt = s => sc.workstreams.filter(w=>w.state==='done' && w.seq<=s).length;
    const total = sc.workstreams.length;
    const F = R.map(f=>({src:f.src, cap:f.caption, when:new Date(postAt(f.seq)).toLocaleString([], {weekday:'short', hour:'numeric', minute:'2-digit'}), done:doneAt(f.seq), total}));
    const i = Math.min(F.length-1, Math.max(0, state.o2reel ?? F.length-1)); const f = F[i];
    return `<section class="o2-reel" data-reel="${esc(JSON.stringify(F))}">
      <div class="o2-rh"><span class="o2-glbl">${ui('progress')}</span><span class="o2-rwhen">${esc(f.when)}</span><button class="o2-btn o2-rcmp" aria-pressed="${!!state.o2reelCmp}">${state.o2reelCmp ? 'Hide compare' : ui('compare')}</button></div>
      <div class="o2-rstage"><img class="o2-rnow" src="${esc(F[F.length-1].src)}" alt=""><img class="o2-rimg" src="${esc(f.src)}" alt="${esc(f.cap)}"><i class="o2-rline" ${state.o2reelCmp?'':'hidden'}></i><input class="o2-rswipe" type="range" min="0" max="100" value="${state.o2reelSwipe ?? 50}" aria-label="Compare then and now" ${state.o2reelCmp?'':'hidden'}><span class="o2-rtag">${i===F.length-1?ui('now'):`${i+1} / ${F.length}`}</span><button class="o2-rexp" type="button" aria-label="${ui('expand')}" title="${ui('expand')}"><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button></div>
      <p class="o2-rcap">${esc(f.cap)}</p>
      <p class="o2-rmeta">${f.done} of ${total} tasks done</p>
      <div class="o2-rtrack">${F.map((x,k)=>`<i style="left:${F.length>1?(k/(F.length-1)*100).toFixed(2):0}%"></i>`).join('')}<input class="o2-rscrub" type="range" min="0" max="${F.length-1}" value="${i}" step="1" aria-label="Scrub through progress"></div>
    </section>`;
  }

  function threadModel(sc){
    const goal = sc.goal || null;
    const threads = (sc.threads || []).filter(t=>t && Array.isArray(t.workstreams));
    return threads.length ? {goal, threads} : null;
  }
  function threadsView(sc, TM){
    const wsById = new Map(sc.workstreams.map(w=>[w.id, w]));
    const attById = new Map(sc.attention.filter(a=>a.id).map(a=>[a.id, a]));
    const openYou = a => !sc.finished && a && a.wait==='you';
    const openAsk = a => !sc.finished && a && a.wait==='coordinator';
    const openIssue = a => !sc.finished && a && a.wait==='issue';
    if (state.o2who && (!sc.members[state.o2who] || sc.members[state.o2who].killed)) state.o2who = null;
    const who = state.o2who || null;
    const stOf = w => { if(w.state!=='done' && w.state!=='blocked'){ const m=sc.members[w.owners[0]]; if(m && m.status==='waiting_on') return 'blocked'; } return TSTATE[w.state]||'queued'; };
    // Who a held-up task waits on: the narrator's blocked_on, or the member its
    // worker asked and has not heard back from.
    const waiterOf = w => { if(stOf(w)!=='blocked') return null; const m=sc.members[w.owners[0]]; return (w.state==='blocked' && w.blocked_on) || (m && m.waiting_on) || null; };
    const all = []; const used = new Set();
    const runningWs = [], doneWs = [], queuedWs = [];
    const seenWs = new Set();
    const collectWs = w => {
      if(seenWs.has(w.id)) return;
      seenWs.add(w.id);
      const s = stOf(w);
      all.push(s);
      if(s==='running' || s==='blocked') runningWs.push({w, st:s});
      else if(s==='done') doneWs.push(w);
      else queuedWs.push(w);
    };
    const rows = TM.threads.map(t=>{
      const ws = t.workstreams.map(id=>wsById.get(id)).filter(Boolean).filter(w=>!who || w.owners.includes(who));
      ws.forEach(w=>{ used.add(w.id); collectWs(w); });
      const att = (t.attention||[]).map(id=>attById.get(id)).filter(a=>!who || (a && a.from===who));
      const you = att.filter(openYou), asks = [...you, ...att.filter(openAsk)], issues = att.filter(openIssue);
      const n = {done:0, running:0, blocked:0, queued:0}; ws.forEach(w=>{ n[stOf(w)]++; });
      const waiters = new Set([...(asks.some(openAsk) ? ['coordinator'] : []), ...ws.map(waiterOf).filter(Boolean)]);
      const state = you.length ? 'needs' : (waiters.size || n.blocked) ? 'waiting' : issues.length ? 'stuck' : (n.running ? 'running' : (n.queued && !n.done ? 'queued' : (n.queued ? 'running' : 'done')));
      return {t, ws, asks, issues, n, state, waiters};
    }).filter(r=>r.ws.length || r.asks.length || r.issues.length);
    // Tasks no thread lists, built before the loose asks below so an ask can
    // join its worker's task here too.
    const rest = sc.workstreams.filter(w=>!used.has(w.id) && (!who || w.owners.includes(who)));
    if(rest.length){ const n={done:0,running:0,blocked:0,queued:0}; rest.forEach(w=>{ collectWs(w); n[stOf(w)]++; }); const waiters=new Set(rest.map(waiterOf).filter(Boolean));
      rows.push({t:{id:'t-other', title: TM.threads.length ? 'Other' : 'Tasks', goal:'', now:''}, ws:rest, asks:[], issues:[], waiters, n, state: (waiters.size || n.blocked) ? 'waiting' : n.running ? 'running' : (n.queued ? 'queued' : 'done')}); }
    // Asks no thread lists (system alerts included) still need to be seen.
    const listed = new Set(TM.threads.flatMap(t=>t.attention||[]));
    const loose = sc.attention.filter(a=>!a.id || !listed.has(a.id)).filter(a=>!who || a.from===who);
    const looseYou = loose.filter(openYou), looseAsks = loose.filter(openAsk), looseIssues = loose.filter(openIssue);
    if(looseYou.length) rows.push({t:{id:'t-you', title:ui('needs'), goal:'', now:''}, ws:[], asks:looseYou, issues:[], n:{done:0,running:0,blocked:0,queued:0}, state:'needs'});
    // A worker's ask goes in the thread with that worker's task, so it shows
    // once (next to the task that says "Waiting on @coordinator"); only asks
    // from workers with no task in a thread get their own group.
    const strayAsks = [];
    looseAsks.forEach(a=>{ const r=rows.find(x=>x.ws.some(w=>w.owners.includes(a.from)));
      if(r){ r.asks.push(a); r.waiters.add('coordinator'); if(r.state!=='needs') r.state='waiting'; } else strayAsks.push(a); });
    if(strayAsks.length) rows.push({t:{id:'t-waiting', title:waitOn('coordinator'), goal:'', now:''}, ws:[], asks:strayAsks, issues:[], n:{done:0,running:0,blocked:0,queued:0}, state:'waiting', waiters:new Set(['coordinator'])});
    if(looseIssues.length) rows.push({t:{id:'t-stuck', title:ui('stuck'), goal:'', now:''}, ws:[], asks:[], issues:looseIssues, n:{done:0,running:0,blocked:0,queued:0}, state:'stuck', waiters:new Set()});
    const order = {needs:0, waiting:1, stuck:2, running:3, queued:4, done:5};
    rows.sort((a,b)=>order[a.state]-order[b.state]);
    runningWs.sort((a,b)=>(a.st==='blocked'?0:1)-(b.st==='blocked'?0:1));
    const tot = {done:0,running:0,blocked:0,queued:0}; all.forEach(s=>tot[s]++);
    const LABEL = {needs:ui('needs'), stuck:ui('stuck'), running:'Moving', queued:'Not started', done:'Done'};
    const labelOf = r => r.state!=='waiting' ? LABEL[r.state] : r.waiters.size===1 ? waitOn([...r.waiters][0]) : r.waiters.size>1 ? `Waiting on ${r.waiters.size}` : 'Waiting';
    const ICON = {done:'✓', running:'', blocked:'', queued:''};
    const goalCopy = TM.goal || {};
    const goalTitle = goalCopy.title || clipWords(sc.headline, 9);
    const g = goalTitle ? `<section class="o2-goal">
      <div class="o2-glbl">${ui('goal')}</div>
      <b>${esc(goalTitle)}</b>
      ${goalCopy.line ? `<p>${esc(goalCopy.line)}</p>` : ''}
    </section>` : '';
    const threadSummaryFallback = rows.filter(r=>r.state!=='done' && r.t.now).map(r=>r.t.now).slice(0,2).join(' · ');
    const openThreads = rows.filter(r=>r.state!=='done').length;
    const openAsks = rows.reduce((acc,r)=>acc+r.asks.filter(openYou).length, 0);
    // Count each waiting worker once per member it waits on, so a worker
    // whose ask and task both wait on the coordinator counts once.
    const pairs = new Set();
    rows.forEach(r=>r.asks.filter(openAsk).forEach(a=>pairs.add(`${a.from}>coordinator`)));
    runningWs.forEach(({w})=>{ const x=waiterOf(w); if(x) pairs.add(`${w.owners[0]}>${x}`); });
    const waits = new Map(); pairs.forEach(k=>{ const n=k.slice(k.indexOf('>')+1); waits.set(n, (waits.get(n)||0)+1); });
    const stuckN = rows.reduce((acc,r)=>acc+r.issues.length, 0);
    const runHtml = runningCard(sc, runningWs, threadSummaryFallback, goalTitle, goalCopy.line||'');
    const progHtml = progressCard(sc, tot, doneWs, queuedWs, openThreads, openAsks, waitChips(waits, stuckN));
    const thread = r => { const id=r.t.id; const open = r.ws.length>0 && (state['o2t:'+id] ?? (r.state==='needs' || r.state==='waiting' || r.state==='stuck'));
      const sum = r.n.done+r.n.running+r.n.blocked+r.n.queued;
      const asks = [...r.asks, ...r.issues].map(a=>{ const c=itemCopy(a.id, a.title, a.why, a.full); const on = (a.wait==='coordinator' && r.t.id!=='t-waiting' && !r.ws.some(w=>w.owners.includes(a.from))) ? `<span class="o2-askon">${esc(waitOn('coordinator'))}</span>` : '';
        // Opens the cited post on the Board (app.js handles data-ov-seq), else the member it is from.
        return `<button type="button" class="o2-ask ${a.wait==='issue'?'issue':''}" ${a.post ? `data-ov-seq="${a.post}"` : `data-open-member="${esc(a.from)}"`}><span class="o2-askd" aria-hidden="true"></span><span class="o2-askb"><b>${esc(c.title)}</b><span class="o2-askl">${esc(c.line)}</span>${on}</span></button>`; }).join('');
      const tasks = r.ws.slice().sort((a,b)=>({blocked:0,running:1,queued:2,done:3}[stOf(a)]-({blocked:0,running:1,queued:2,done:3}[stOf(b)]))).map(w=>{ const s=stOf(w); const c=itemCopy(w.id, w.title, w.note); return `<li class="${s}"><span class="o2-ti ${s}" aria-label="${s}">${ICON[s]}</span><span class="o2-tt">${esc(c.title)}${waiterOf(w) ? `<span class="o2-tw">${esc(waitOn(waiterOf(w)))}</span>` : ''}</span>${taskProgressPill(w)}${workerBadges(w.owners, 2, sc)}</li>`; }).join('');
      const head = `<span class="o2-thd ${r.state}" aria-hidden="true"></span>
          <span class="o2-tht"><b>${esc(r.t.title)}</b>${labelOf(r) !== r.t.title ? `<em>${esc(labelOf(r))}</em>` : ''}</span>
          <span class="o2-thc">${sum ? `${miniBar(r.n)}<span>${r.n.done}/${sum}</span>` : `<span>${r.asks.length + r.issues.length}</span>`}</span>`;
      // Only the task list folds, so a thread without tasks gets no toggle.
      return `<section class="o2-th ${r.state} ${open?'open':''}">
        ${r.ws.length ? `<button class="o2-thh" data-o2t="${esc(id)}" aria-expanded="${open}">${head}<span class="o2-chev" aria-hidden="true"></span></button>` : `<div class="o2-thh">${head}</div>`}
        ${r.t.goal ? `<p class="o2-thg">${esc(r.t.goal)}</p>` : ''}
        ${r.t.now && r.state!=='done' ? `<p class="o2-thn"><span>${ui('now')}</span>${esc(r.t.now)}</p>` : (r.t.now ? `<p class="o2-thn done">${esc(r.t.now)}</p>` : '')}
        ${asks}
        ${open ? `<ul class="o2-tasks">${tasks}</ul>` : ''}
      </section>`; };
    return {goal:g, running:runHtml, progress:progHtml, reel: reelCard(sc), threads: rows.map(thread).join('')};
  }

  /* ---------- Members view: Board-style separated rows with Bees tiles ---------- */
  // Shared remote board: where the data comes from and whether it is current.
  function sourceChip(src, onlyProblems){
    if(!src || (onlyProblems && src.state==='live')) return '';
    const owners = Array.isArray(src.owners) ? src.owners : [];
    const label = src.label || 'Remote';
    const text = {live:`${label} · ${owners.length} machine${owners.length===1?'':'s'}`, stale:`${label} · reconnecting`, connecting:`${label} · connecting`, error:`${label} · unavailable`}[src.state] || label;
    const tip = [`Shared ${label} board ${src.swarm_id||''}`, src.db||'', ...owners.map(o=>o&&o.label?String(o.label):''), src.error?`Error: ${src.error}`:''].filter(Boolean).join('\n');
    return `<div class="o2-src ${esc(src.state||'')}" data-testid="swarm-source" title="${esc(tip)}"><i aria-hidden="true"></i>${esc(text)}</div>`;
  }
  function stallBanner(sc){
    if(!sc.stall || sc.finished || sc.starting) return '';
    const s = sc.stall;
    return `<section class="o2-stall" data-testid="swarm-stall-banner">
      <div class="o2-stmain">
        <div class="o2-sttop"><span class="o2-stdot" aria-hidden="true"></span><b>Swarm stalled — no agents working</b><button type="button" class="o2-sttag" data-ov-seq="${s.seq}" title="${esc(`Go to #${s.seq} on the Board`)}">@${esc(s.agent)} #${s.seq}</button></div>
        <p class="o2-sttxt">${esc(s.text)}</p>
      </div>
    </section>`;
  }
  const agoText = ms => { const m=Math.round(ms/60000); if(m<1) return 'seen just now'; if(m<60) return `last seen ${m}m ago`; const hr=Math.round(m/60); return hr<48 ? `last seen ${hr}h ago` : `last seen ${Math.round(hr/24)}d ago`; };
  const wsShort = s => {
    const list = String(s||'').split(/,\s+/).map(p=>p.trim()).filter(Boolean);
    if(!list.length) return '';
    const one = p => {
      const norm = p.replace(/\\/g,'/');
      const segs = norm.replace(/\/+$/,'').split('/').filter(Boolean);
      if(!segs.length) return norm.startsWith('/') ? '/' : p;
      const out = segs.length > 2 ? '…/' + segs.slice(-2).join('/') : ((norm.startsWith('/') ? '/' : '') + segs.join('/'));
      return out.length > 48 ? '…' + out.slice(-47) : out;
    };
    return list.length > 1 ? `${one(list[0])} +${list.length-1}` : one(list[0]);
  };
  // Owner machine, last seen (for members on another machine), workspace and channels.
  function memberTags(x){
    const tags = [];
    if(x.owner) tags.push(`<span class="o2-mtag" data-testid="swarm-member-owner" title="${esc(`Runs on ${x.owner.label}`)}">${esc(x.owner.label.includes('@') ? x.owner.label : '@'+x.owner.label)}</span>`);
    if(!x.local && x.last_seen) tags.push(`<span class="o2-mtag" data-testid="swarm-member-seen">${esc(agoText(Date.now()-x.last_seen))}</span>`);
    const wsMode = x.workspace_mode && x.workspace_mode!=='inherit' ? x.workspace_mode : '';
    const wsPath = x.workspace || '';
    if(wsMode || wsPath){
      const short = wsShort(wsPath);
      const lbl = wsMode && short ? `${wsMode} · ${short}` : (wsMode || short);
      const tip = wsMode && wsPath ? `${wsMode} · ${wsPath}` : (wsPath || wsMode);
      if(lbl) tags.push(`<span class="o2-mtag" data-testid="swarm-member-workspace" title="${esc(tip)}">${esc(lbl)}</span>`);
    }
    const chans = (x.channels||[]).filter(c=>c && c!=='main');
    if(chans.length) tags.push(`<span class="o2-mtag" data-testid="swarm-member-channels">${esc(chans.includes('*') ? 'all channels' : chans.map(c=>'#'+c).join(' '))}</span>`);
    return tags.length ? `<div class="o2-mtags">${tags.join('')}</div>` : '';
  }

  function membersView(sc){
    state.style = 'bees';
    const fmtMod = m => String(m||'').replace(/-(?:dropdown|high|medium)$/i,'');
    const allEntries = Object.entries(sc.members).filter(([,x])=>!x.system);
    const lead = sc.members.coordinator || {rawName:'coordinator', role:'coordinator', title:'Coordinator', status:'parked', now:'', posts:0};
    const workers = allEntries.filter(([n])=>n!=='coordinator');
    const liveWorkers = workers.filter(([,x])=>!x.killed);
    const retiredWorkers = workers.filter(([,x])=>x.killed).sort((a,b)=>(b[1].posts||0)-(a[1].posts||0));
    const isAct = x => !sc.finished && (x.status==='needs_you' || x.status==='working' || x.status==='waiting_on' || !!x.issue);
    const actOrder = {needs_you:0, working:1, waiting_on:2, parked:3};
    const activeWorkers = liveWorkers.filter(([,x])=>isAct(x)).sort((a,b)=>actOrder[a[1].status]-actOrder[b[1].status] || (b[1].posts||0)-(a[1].posts||0));
    const standbyWorkers = liveWorkers.filter(([,x])=>!isAct(x)).sort((a,b)=>((b[1].last?.seq||0)-(a[1].last?.seq||0)) || a[0].localeCompare(b[0]));

    const searchIcon = `<svg class="icon" width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.25" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="m10.25 10.25 3.25 3.25" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
    const topBar = `${sourceChip(sc.source)}<div class="o2-mtop">
      <label class="o2-msearch">${searchIcon}<input type="search" class="o2-msin" placeholder="Search members" aria-label="Search members" autocomplete="off" value="${esc(state.o2mq||'')}"></label>
    </div>`;

    const leftBeeTile = (n, x) => {
      const st = sc.finished || x.killed ? '' : x.status;
      const dot = (st==='working' || st==='needs_you' || st==='waiting_on') ? `<i class="o2-mavd ${st}" aria-hidden="true"></i>` : '';
      return `<span class="o2-mav bee" style="${hexBG(n)}" aria-hidden="true">${spriteTag(n, x.killed?'landed':(sc.finished?'landed':x.status))}${dot}</span>`;
    };

    const rowHtml = (n, x) => {
      const isCoord = n==='coordinator';
      const st = (sc.finished || x.killed) ? 'parked' : x.status;
      const metaParts = [];
      const mod = fmtMod(x.model);
      if(mod) metaParts.push(mod);
      if(x.last && x.last.seq) metaParts.push('#'+x.last.seq);
      else if(x.posts) metaParts.push(x.posts + (x.posts===1?' post':' posts'));
      const meta = metaParts.join(' · ');

      let statTag = '';
      if(isCoord){
        statTag = st==='needs_you' ? `<span class="o2-mstat warn">${ui('needs')}</span>` : st==='working' ? `<span class="o2-mstat info">Coordinator · Working</span>` : `<span class="o2-mstat">Coordinator</span>`;
      } else if(x.killed){
        statTag = x.title ? `<span class="o2-mstat">${esc(x.title)}</span>` : `<span class="o2-mstat">Retired</span>`;
      } else if(x.issue && !sc.finished){
        statTag = `<span class="o2-mstat bad">${x.issue.kind==='stuck' ? 'Stuck' : 'Error'}</span>`;
      } else if(st==='working'){
        statTag = `<span class="o2-mstat info">Working</span>`;
      } else if(st==='waiting_on' && x.waiting_on){
        statTag = `<span class="o2-mstat warn">${esc(waitOn(x.waiting_on))}</span>`;
      } else if(x.title){
        statTag = `<span class="o2-mstat">${esc(x.title)}</span>`;
      }

      const hasIssue = !isCoord && !!x.issue && !sc.finished;
      const showRoleSub = !isCoord && !x.killed && (st==='working' || st==='waiting_on' || hasIssue) && x.title;
      let bodyLine = isCoord ? (x.now || memberLine('coordinator', x)) : (x.now || '');
      if(isCoord && st==='needs_you' && x.ask){
        bodyLine = x.ask.title;
      } else if(x.ask && (st==='needs_you' || st==='waiting_on')){
        const ac = itemCopy(x.ask.id, x.ask.title, x.ask.why, x.ask.full);
        bodyLine = ac.line ? `${ac.title} — ${ac.line}` : ac.title;
      } else if(hasIssue){
        bodyLine = itemCopy(x.issue.id, x.issue.title, x.issue.why).line || x.issue.title;
      }

      const wsMode = x.workspace_mode && x.workspace_mode!=='inherit' ? x.workspace_mode : '';
      const hay = `${n} ${n} ${x.title||''} ${x.model||''} ${wsMode} ${x.workspace||''} ${bodyLine||''} ${st}`;
      // A working member's live step, set apart from the last-post fallback.
      // toModel sets `live` only for members still at work (and the
      // coordinator, which an unattributed ask marks needs_you).
      // A stuck or failed member's step is not live, so show what is wrong.
      const live = !sc.finished && !x.killed && !hasIssue && x.live ? x.live : null;
      const nowHtml = live
        ? `<div class="o2-mnow o2-mact ${esc(live.kind)}" data-testid="swarm-member-activity" title="${esc(liveTip(live))}">${liveText(live)}</div>`
        : (bodyLine ? `<div class="o2-mnow">${esc(bodyLine)}</div>` : '');
      const openAttr = `data-open-member="${esc(x.rawName || n)}"`;
      const cls = `o2-mrow bees ${st} ${hasIssue?'issue':''} ${x.killed?'retired':''} ${isCoord?'coord':''}`;

      return `<article class="${cls}" ${openAttr} data-mhay="${esc(hay)}">
        ${leftBeeTile(n, x)}
        <div class="o2-mcol">
          <header class="o2-mhead">
            <span class="o2-mwho"><span class="o2-mauth">@${esc(isCoord?'coordinator':n)}</span>${statTag}</span>
            <span class="o2-mright">${meta?`<span class="o2-mts">${esc(meta)}</span>`:''}</span>
          </header>
          ${showRoleSub ? `<div class="o2-mrole">${esc(x.title)}</div>` : ''}
          ${memberTags(x)}
          ${nowHtml}
        </div>
      </article>`;
    };

    const groupHtml = (label, list) => list.length
      ? `<section class="o2-mgroup"><h3 class="o2-msec"><span>${label}</span><em>${list.length}</em></h3><div class="o2-mlist">${list.map(([n,x])=>rowHtml(n,x)).join('')}</div></section>`
      : '';

    const retOpen = !!state.o2mRetired;
    const retiredHtml = retiredWorkers.length
      ? `<section class="o2-mgroup o2-mretgrp ${retOpen?'open':''}">
          <button type="button" class="o2-mret" data-o2="mRetired" aria-expanded="${retOpen}">
            <span>Retired</span><em>${retiredWorkers.length}</em><span class="o2-chev" aria-hidden="true"></span>
          </button>
          ${retOpen ? `<div class="o2-mlist">${retiredWorkers.map(([n,x])=>rowHtml(n,x)).join('')}</div>` : ''}
        </section>`
      : '';

    return `<div class="o2 o2-members">
      ${topBar}
      <section class="o2-mgroup o2-mcoord">${rowHtml('coordinator', lead)}</section>
      ${groupHtml('Active', activeWorkers)}
      ${groupHtml(sc.finished ? 'Team' : 'Standing by', standbyWorkers)}
      ${retiredHtml}
    </div>`;
  }

  // First run: no narrator view and no worker has posted yet. Shows how a swarm
  // works with the swarm's own bees (placeholders until workers join).
  function onboardView(sc){
    const real = people(sc).filter(([n,x])=>n!=='coordinator' && !x.killed).map(([n])=>n).slice(0,3);
    const ws = [...real, ...['worker-a','worker-b','worker-c']].slice(0,3);
    const Y = [30, 78, 126];
    const path = (y,i) => `<path id="o2-onb-p${i}" d="M84 78 C150 78 160 ${y} 226 ${y}"/>`;
    const dot = (i, fill, back, begin) => `<circle r="3" fill="${fill}" opacity="0"><animateMotion dur="2.4s" begin="${begin}s" repeatCount="indefinite" keyPoints="${back?'1;0':'0;1'}" keyTimes="0;1" calcMode="linear"><mpath href="#o2-onb-p${i}"/></animateMotion><animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.15;0.85;1" dur="2.4s" begin="${begin}s" repeatCount="indefinite"/></circle>`;
    const bee = (n, cls, style) => `<span class="o2-mav bee ${cls}" style="${hexBG(n)};${style}">${spriteTag(n,'working')}</span>`;
    const icon = n => `<span class="o2-onb-i" style="${hexBG(n)}"><img src="${beeImg(n)}" alt="" width="22" height="18"></span>`;
    return `<section class="o2-onb" data-testid="swarm-onboarding">
      <div class="o2-onb-stage" aria-hidden="true">
        <svg class="o2-onb-paths" viewBox="0 0 320 156" width="320" height="156">
          <g class="o2-onb-lines">${Y.map(path).join('')}</g>
          ${ws.map((n,i)=>dot(i, tcol('coordinator'), false, i*0.8) + dot(i, tcol(n), true, i*0.8+1.2)).join('')}
        </svg>
        ${bee('coordinator', 'o2-onb-q', 'left:24px;top:56px')}
        ${ws.map((n,i)=>bee(n, `o2-onb-w s${i}`, `left:236px;top:${Y[i]-22}px`)).join('')}
      </div>
      <h2 class="o2-onb-h">Your swarm is starting</h2>
      <ol class="o2-onb-steps">
        <li>${icon('coordinator')}<div><b>One goal</b><span>The coordinator splits it into tasks.</span></div></li>
        <li>${icon(ws[0])}<div><b>Many workers</b><span>Each takes a task, and they run in parallel.</span></div></li>
        <li>${icon(ws[1])}<div><b>One board</b><span>Updates land here. You step in only when asked.</span></div></li>
      </ol>
      <p class="o2-onb-wait"><span class="animate-shimmer-text">Waiting for the first update</span></p>
    </section>`;
  }

  const ONBOARD_MIN_MS = 30000;

  function overviewView(sc, el){
    state.style = 'bees';
    const att = k => sc.finished ? [] : sc.attention.filter(a=>a.wait===k);
    const you = att('you'), hot = att('coordinator'), issues = att('issue');
    const open = sc.workstreams.filter(w=>w.state!=='done');
    const items = [];
    open.forEach(w=>{
      let why=null;
      if(w.state==='blocked') why={kind:'agent', who:w.owners[0], on:w.blocked_on||null, seq:w.seq};
      else if(w.state==='active'){ for(const o of w.owners){ const m=sc.members[o]; if(m && m.status==='waiting_on'){ why={kind:'agent', who:o, on:m.waiting_on, seq:m.waiting_seq}; break; } } }
      items.push({id:w.id, title:w.title, line:w.note, owner:w.owners[0], owners:w.owners, why, group: why ? 'blocked' : (w.state==='queued' ? 'planned' : 'running')});
    });
    if (state.o2who && (!sc.members[state.o2who] || sc.members[state.o2who].killed)) state.o2who = null;
    const who = state.o2who || null;
    const mine = list => who ? list.filter(i=>(i.owners||[i.owner]).includes(who)) : list;
    const G = k => mine(items.filter(i=>i.group===k));
    const running=G('running');

    const M = n => sc.members[n] || {status:'parked', now:''};
    const art = (n) => { const x=M(n); return spriteTag(n, x.killed ? 'landed' : (sc.finished?'landed':x.status)); };
    const tile = (n, cls) => `<span class="o2-tile ${cls||''} bees" style="${hexBG(n)}">${art(n)}</span>`;

    // The team (Bees only, no style picker)
    const lead = M('coordinator');
    const crew = [...people(sc)].filter(([n,x])=>n!=='coordinator' && !x.killed)
      .sort((a,b)=>ORDER[a[1].status]-ORDER[b[1].status]);
    const MAXT = 5; let shown = crew.length>MAXT+1 ? crew.slice(0,MAXT) : crew;
    if(who && !shown.some(([n])=>n===who)){ const sel=crew.find(([n])=>n===who); if(sel) shown=[...shown.slice(0,MAXT-1), sel]; }
    const extra = crew.length-shown.length;
    const trio = crew.slice(0,3).map(([n])=>n);
    const swarmArt = `<span class="o2-swarm">${trio.map((n,i)=>`<span class="o2-sb s${i}">${spriteTag(n, sc.finished?'landed':'working')}</span>`).join('')}</span>`;
    const allTile = `<button class="o2-m all ${who?'':'on'}" aria-pressed="${!who}" title="All workers" data-o2who=""><span class="o2-tile sm all bees">${swarmArt}</span><span>All</span></button>`;
    const team = `<section class="o2-team">
      <h3 class="o2-h">${ui('team')}</h3>
      <div class="o2-lead">${tile('coordinator','lg')}<div class="o2-lb"><b>${ui('lead')}</b>${lead.live && !sc.finished ? `<p class="o2-live" title="${esc(liveTip(lead.live))}">${liveText(lead.live, memberLine('coordinator', lead))}</p>` : `<p>${esc(memberLine('coordinator', lead))}</p>`}</div></div>
      ${crew.length ? `<div class="o2-crew" role="group" aria-label="Filter by worker">${allTile}${shown.map(([n,x])=>`<button class="o2-m ${sc.finished?'':x.status} ${who===n?'on':''}" aria-pressed="${who===n}" title="${esc(n)}: ${esc(memberLine(n,x))}" data-o2who="${esc(n)}">${tile(n,'sm')}<i class="o2-st" aria-hidden="true"></i><span>@${esc(n)}</span></button>`).join('')}${extra>0?`<button class="o2-m more" id="o2More"><span class="o2-tile sm plus">+${extra}</span><span>&nbsp;</span></button>`:''}</div>` : ''}
    </section>`;

    const card = it => { const c=itemCopy(it.id, it.title, it.line, it.full);
      return `<div class="o2-card">${tile(it.owner,'md')}<div class="o2-cb"><b>${esc(c.title)}</b><p>${esc(c.line)}</p><div class="o2-who">@${esc(it.owner)}</div></div></div>`; };
    const branch = (k, list, none, limit) => { const lim=state['o2'+k]?list.length:limit; const vis=list.slice(0,lim); const more=list.length-vis.length;
      return `<section class="o2-br ${k}"><h3 class="o2-h"><i></i>${ui(k)}<em>${list.length}</em></h3>
        ${list.length ? `<div class="o2-cards">${vis.map(card).join('')}</div>${more>0?`<button class="o2-more" data-o2="${k}">${ui('more').replace('{n}',more)}</button>`:''}` : `<p class="o2-none">${ui(none)}</p>`}</section>`; };

    // The start page ends once a worker has started and it has been on screen
    // for ONBOARD_MIN_MS; a timer redraws the pane then, as the snapshot may not change.
    if(sc.starting){
      if(!state.onboardAt && el && el.offsetWidth){ state.onboardAt = Date.now(); setTimeout(() => { ROOTS.forEach(r => { r.etag = ''; }); sync(); }, ONBOARD_MIN_MS); }
      if(!sc.workerStarted || !state.onboardAt || Date.now() - state.onboardAt < ONBOARD_MIN_MS) return `<div class="o2">${sourceChip(sc.source, true)}${onboardView(sc)}${team}</div>`;
    }
    // One layout for every swarm: goal, running, done, timeline, threads, the
    // team. Without narrator or plan threads, the tasks sit in one group.
    // Builds without the built-in Overview keep the card layout until a
    // narrator writes threads.
    const TM = threadModel(sc);
    if(!TM && !sc.builtin){
      const stOf = w => { if(w.state!=='done' && w.state!=='blocked'){ const m=sc.members[w.owners[0]]; if(m && m.status==='waiting_on') return 'blocked'; } return TSTATE[w.state]||'queued'; };
      const tot = {done:0, running:0, blocked:0, queued:0};
      const run = [], done = [], queued = [];
      sc.workstreams.filter(w=>!who || w.owners.includes(who)).forEach(w=>{ const st=stOf(w); tot[st]++; if(st==='running'||st==='blocked') run.push({w, st}); else if(st==='done') done.push(w); else queued.push(w); });
      const toItem = a=>({id:a.id||('ask-'+a.seq), title:a.title, full:a.full, line:a.why, owner:a.from, owners:[a.from]});
      const needs = mine(you.map(toItem)), waiting = mine(hot.map(toItem)), stuck = mine(issues.map(toItem));
      const waits = new Map(); const bump = n => waits.set(n, (waits.get(n)||0)+1);
      waiting.forEach(()=>bump('coordinator'));
      run.forEach(({w})=>{ const x = w.state==='blocked' ? w.blocked_on : (sc.members[w.owners[0]]||{}).waiting_on; if(x && (w.state==='blocked' || stOf(w)==='blocked')) bump(x); });
      return `<div class="o2">${sourceChip(sc.source, true)}${stallBanner(sc)}${needs.length ? branch('needs', needs, 'none_needs', 3) : ''}${waiting.length ? branch('waiting', waiting, 'none_waiting', 3) : ''}${stuck.length ? branch('stuck', stuck, 'none_stuck', 3) : ''}${runningCard(sc, run, '', '', '') || branch('running', running, 'none_running', 3)}${progressCard(sc, tot, done, queued, null, needs.length, waitChips(waits, stuck.length))}${reelCard(sc)}${team}</div>`;
    }
    const v = threadsView(sc, TM || {goal: sc.goal, threads: []});
    return `<div class="o2">${sourceChip(sc.source, true)}${stallBanner(sc)}${v.goal}${v.running}${v.progress}${v.reel}<section class="o2-threads"><h3 class="o2-h">${ui('threads')}</h3>${v.threads}</section>${team}</div>`;
  }

  /* ---------- render ---------- */
  function render(el, view) {
    const sc = S.live;
    if (!sc) return;
    const v = view === 'cards' ? 'cards' : 'overview';
    const active = document.activeElement;
    const typing = active && active.classList && active.classList.contains('o2-msin') && el.contains(active)
        ? {start: active.selectionStart, end: active.selectionEnd} : null;
    el.innerHTML = v === 'cards' ? membersView(sc) : overviewView(sc, el);
    el.dataset.view = v;
    paintSprites(el);
    requestAnimationFrame(() => snapBees(el));
    bind(el);
    if (typing) {
      const inp = el.querySelector('.o2-msin');
      if (inp) { inp.focus({preventScroll: true}); inp.setSelectionRange(typing.start, typing.end); }
    }
  }

  // Full view of the progress timeline: the whole screenshot (not cropped),
  // every frame in a filmstrip, arrow keys to step, Esc to close. Lives on
  // <body> so the 2 s re-render of the Overview does not tear it down.
  function closeReel() { const lb = $('.o2-tv'); if (lb) (lb.closeReel || (() => lb.remove()))(); }

  function openReel(F, start, onMove) {
    closeReel();
    if (!F.length) return;
    const back = document.activeElement;
    const lb = document.createElement('div');
    lb.className = 'o2-tv'; lb.setAttribute('role', 'dialog'); lb.setAttribute('aria-modal', 'true'); lb.setAttribute('aria-label', ui('progress'));
    lb.innerHTML = `<div class="o2-tvh"><b>${ui('progress')}</b><span class="o2-tvpos"></span><span class="o2-tvwhen"></span><button class="o2-tvx" type="button" aria-label="Close">\u2715</button></div>
      <div class="o2-tvstage"><div class="o2-tvscroll"><img class="o2-tvimg" alt=""></div><button class="o2-tvnav prev" type="button" aria-label="Previous">\u2039</button><button class="o2-tvnav next" type="button" aria-label="Next">\u203a</button></div>
      <div class="o2-tvtext"><p class="o2-tvcap"></p><p class="o2-tvmeta"></p></div>
      <div class="o2-tvstrip" role="listbox" aria-label="Frames">${F.map((f, k) => `<button class="o2-tvth" type="button" role="option" data-k="${k}" aria-label="${esc(`${k + 1}. ${f.cap || ''}`)}"><img src="${esc(f.src)}" alt="" loading="lazy"><span>${k + 1}</span></button>`).join('')}</div>`;
    document.body.appendChild(lb);
    const img = $('.o2-tvimg', lb), scroller = $('.o2-tvscroll', lb), strip = $('.o2-tvstrip', lb);
    let i = -1;
    // Only real steps re-render the card; opening and pressing past either end
    // leave it alone (a re-render would detach the opener and drop zoom).
    const go = (k, opening) => {
      const n = Math.max(0, Math.min(F.length - 1, k));
      if (n === i) return;
      i = n; const f = F[i];
      scroller.classList.remove('zoom');
      img.src = f.src; img.alt = f.cap || '';
      $('.o2-tvpos', lb).textContent = i === F.length - 1 ? `${ui('now')} \u00b7 ${i + 1} / ${F.length}` : `${i + 1} / ${F.length}`;
      $('.o2-tvwhen', lb).textContent = f.when || '';
      $('.o2-tvcap', lb).textContent = f.cap || '';
      $('.o2-tvmeta', lb).textContent = f.total ? `${f.done} of ${f.total} tasks done` : '';
      $('.o2-tvnav.prev', lb).disabled = i === 0; $('.o2-tvnav.next', lb).disabled = i === F.length - 1;
      strip.querySelectorAll('.o2-tvth').forEach((b, k2) => { const on = k2 === i; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); if (on) b.scrollIntoView({block: 'nearest', inline: 'center'}); });
      if (onMove && !opening) onMove(i);
    };
    // The Overview may have re-rendered since this opened, so focus falls back
    // to the live expand button when the opener is gone.
    const close = () => {
      document.removeEventListener('keydown', key, true); lb.remove();
      const to = back && back.isConnected ? back : $('.o2-reel .o2-rexp');
      if (to && to.focus) to.focus({preventScroll: true});
    };
    lb.closeReel = close;
    const key = e => {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); go(i - 1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); go(i + 1); }
      else if (e.key === 'Home') { e.preventDefault(); go(0); }
      else if (e.key === 'End') { e.preventDefault(); go(F.length - 1); }
    };
    document.addEventListener('keydown', key, true);
    $('.o2-tvx', lb).onclick = close;
    $('.o2-tvnav.prev', lb).onclick = () => go(i - 1);
    $('.o2-tvnav.next', lb).onclick = () => go(i + 1);
    strip.querySelectorAll('.o2-tvth').forEach(b => b.onclick = () => go(+b.dataset.k));
    // Click the picture to see it at full size; click again to fit.
    img.onclick = () => scroller.classList.toggle('zoom');
    lb.onclick = e => { if (e.target === lb || e.target === scroller) close(); };
    go(start, true);
    lb.tabIndex = -1; lb.focus({preventScroll: true});
  }

  function bind(el) {
    const hooks = (window.SwarmHive && window.SwarmHive.hooks) || {};
    el.querySelectorAll('.o2-reel').forEach(r => {
      let F = [];
      try { F = JSON.parse(r.dataset.reel || '[]'); } catch (_) {}
      const img = r.querySelector('.o2-rimg'), scrub = r.querySelector('.o2-rscrub'), sw = r.querySelector('.o2-rswipe'),
          line = r.querySelector('.o2-rline'), cmp = r.querySelector('.o2-rcmp');
      const show = i => {
        const f = F[i]; if (!f) return;
        img.src = f.src; img.alt = f.cap;
        r.querySelector('.o2-rcap').textContent = f.cap;
        r.querySelector('.o2-rwhen').textContent = f.when;
        r.querySelector('.o2-rmeta').textContent = r.querySelector('.o2-rmeta').textContent.replace(/^\d+/, f.done);
        r.querySelector('.o2-rtag').textContent = i === F.length - 1 ? 'Now' : `${i + 1} / ${F.length}`;
        state.o2reel = i;
      };
      const clip = () => {
        const on = cmp.getAttribute('aria-pressed') === 'true';
        img.style.clipPath = on ? `inset(0 ${100 - sw.value}% 0 0)` : 'none';
        line.style.left = sw.value + '%';
      };
      scrub.oninput = () => show(+scrub.value);
      sw.oninput = () => { state.o2reelSwipe = +sw.value; clip(); };
      if (state.o2reelCmp) clip();
      // Steps go through state and a re-render: a poll may have replaced this
      // card's nodes while the viewer is open.
      const open = () => openReel(F, state.o2reel ?? F.length - 1, i => { state.o2reel = i === F.length - 1 ? null : i; sync(); });
      r.querySelector('.o2-rexp').onclick = (e) => { e.stopPropagation(); open(); };
      img.onclick = () => { if (cmp.getAttribute('aria-pressed') !== 'true') open(); };
      cmp.onclick = () => {
        const on = cmp.getAttribute('aria-pressed') !== 'true';
        state.o2reelCmp = on;
        cmp.setAttribute('aria-pressed', on);
        cmp.textContent = on ? 'Hide compare' : 'Compare with now';
        sw.hidden = !on; line.hidden = !on; clip();
      };
    });
    el.querySelectorAll('[data-o2t]').forEach(b => b.onclick = (e) => {
      e.stopPropagation(); state['o2t:' + b.dataset.o2t] = b.getAttribute('aria-expanded') !== 'true'; sync();
    });
    el.querySelectorAll('[data-o2who]').forEach(b => b.onclick = (e) => {
      e.stopPropagation(); const n = b.dataset.o2who; state.o2who = (n && state.o2who !== n) ? n : null; sync();
    });
    el.querySelectorAll('[data-o2]').forEach(b => b.onclick = (e) => {
      e.stopPropagation(); const k = 'o2' + b.dataset.o2; state[k] = !state[k]; sync();
    });
    const om = $('#o2More', el);
    if (om) om.onclick = () => { if (hooks.members) hooks.members(); };
    el.querySelectorAll('[data-open-member]').forEach(b => b.onclick = (e) => {
      const btn = e.target.closest('button');
      if (btn && btn !== b) return;
      if (hooks.member) hooks.member(b.dataset.openMember);
    });
    el.querySelectorAll('.o2-msin').forEach(inp => {
      const apply = () => {
        const q = inp.value.trim().toLowerCase();
        state.o2mq = inp.value;
        el.querySelectorAll('.o2-mrow').forEach(row => {
          row.style.display = (!q || (row.dataset.mhay || '').toLowerCase().includes(q)) ? '' : 'none';
        });
        el.querySelectorAll('.o2-mgroup').forEach(grp => {
          grp.style.display = (!q || [...grp.querySelectorAll('.o2-mrow')].some(r => r.style.display !== 'none')) ? '' : 'none';
        });
      };
      inp.oninput = apply;
      if (inp.value) apply();
    });
  }

  /* ================= adapter: plugin snapshot -> view model ================= */
  const cleanText = t => String(t || '').replace(/^\s*(?:[-*]|#+|\d+\.)\s+/gm, '').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\s+/g, ' ').trim().slice(0, 400);
  let msgIdx = null;
  function syncMsgIndex(snap, L, isRole, isMonitor, key) {
    const rawMsgs = Array.isArray(snap.messages) ? snap.messages : [];
    const pinned = Number(snap.messagesOffset) > 0 && Array.isArray(snap.pinnedMessages) ? snap.pinnedMessages : null;
    const memberSig = snap.members.map(m=>`${m.name}:${m.role||''}:${m.roleWorker?1:0}:${m.narrator?1:0}`).join('\0');
    const rosterKey = typeof snap.rosterKey === 'string' ? snap.rosterKey : '';
    const indexOne = (m) => {
      if (!m || (m.control && typeof m.control === 'object')) return;
      if (isMonitor(m.agent) && /\[stall\]/i.test(String(m.text || ''))) msgIdx.lastMonPost = m;
      if (isRole(m.agent)) return;
      const p = {
        s: m.seq,
        a: key(m.agent),
        t: new Date(m.ts || Date.now()).toISOString(),
        to: m.all ? ['*'] : (m.mentions || []).filter(n => n !== m.agent && !isRole(n)).map(key),
        x: cleanText(m.text),
      };
      msgIdx.P.push(p);
      msgIdx.bySeq.set(p.s, p);
      msgIdx.lastByAgent.set(p.a, p);
      if (p.s > (msgIdx.maxSeqByAgent.get(p.a) ?? -Infinity)) msgIdx.maxSeqByAgent.set(p.a, p.s);
      if (m.agent === L) {
        const bm = /^@([\w-]+)/.exec(String(m.text || ''));
        if (bm && !msgIdx.briefs.has(bm[1])) msgIdx.briefs.set(bm[1], m);
      }
    };
    const canAppend = msgIdx &&
      msgIdx.swarmId === snap.id &&
      msgIdx.leadName === L &&
      msgIdx.memberSig === memberSig &&
      msgIdx.rosterKey === rosterKey &&
      msgIdx.pinnedRef === pinned &&
      (rosterKey !== '' || rawMsgs === msgIdx.rawRef) &&
      rawMsgs.length >= msgIdx.rawCount &&
      (msgIdx.rawCount === 0 || (
        rawMsgs[0]?.seq === msgIdx.firstSeq &&
        rawMsgs[0]?.text === msgIdx.firstText &&
        rawMsgs[msgIdx.rawCount - 1]?.seq === msgIdx.lastSeq &&
        rawMsgs[msgIdx.rawCount - 1]?.text === msgIdx.lastText
      ));
    if (!canAppend) {
      msgIdx = {
        swarmId: snap.id,
        leadName: L,
        memberSig,
        rosterKey,
        pinnedRef: pinned,
        rawRef: rawMsgs,
        rawCount: 0,
        firstSeq: 0,
        firstText: '',
        lastSeq: 0,
        lastText: '',
        P: [],
        bySeq: new Map(),
        lastByAgent: new Map(),
        maxSeqByAgent: new Map(),
        briefs: new Map(),
        lastMonPost: null,
      };
      if (pinned) pinned.forEach(indexOne);
    }
    if (rawMsgs.length > msgIdx.rawCount) {
      for (let i = msgIdx.rawCount; i < rawMsgs.length; i++) indexOne(rawMsgs[i]);
      msgIdx.rawCount = rawMsgs.length;
      if (rawMsgs.length) {
        msgIdx.firstSeq = rawMsgs[0]?.seq;
        msgIdx.firstText = rawMsgs[0]?.text;
        msgIdx.lastSeq = rawMsgs[rawMsgs.length - 1]?.seq;
        msgIdx.lastText = rawMsgs[rawMsgs.length - 1]?.text;
      }
      msgIdx.rawRef = rawMsgs;
    }
    return msgIdx;
  }

  function toModel(snap){
    const byName = new Map(snap.members.map(m=>[m.name,m]));
    const isRole = n => { const m=byName.get(n); return !!(m && (m.roleWorker || m.narrator)) || /^(?:narrator|monitor)(?:-\d+)?$/.test(n); };
    const isMonitor = a => byName.get(a)?.role==='monitor' || /^monitor(-\d+)?$/.test(a);
    const leadM = snap.members.find(m=>m.role==='coordinator');
    const L = leadM ? leadM.name : 'coordinator';
    const key = n => n===L ? 'coordinator' : n;
    window.SwarmHive = window.SwarmHive || {}; window.SwarmHive.leadName = L;
    const idx = syncMsgIndex(snap, L, isRole, isMonitor, key);
    P = idx.P;
    const head = snap.head || (P.length?P[P.length-1].s:0);
    const narratorView = snap.view && snap.view.json && typeof snap.view.json==='object' ? snap.view.json : null;
    // Without a narrator view, the coordinator's plan.json supplies the goal,
    // the threads (lists of worker names) and each worker's task name. Live
    // status still comes from the board.
    const plan = !narratorView && snap.plan && typeof snap.plan==='object' ? snap.plan : null;
    const planTasks = plan && plan.tasks && typeof plan.tasks==='object' ? plan.tasks : {};
    const vj = narratorView || (plan ? {
      goal: plan.goal,
      threads: (Array.isArray(plan.threads)?plan.threads:[]).filter(t=>t && t.title && Array.isArray(t.tasks))
          .map((t,i)=>({id: t.id || ('t'+i), title: t.title, goal: t.goal || '', workstreams: t.tasks.filter(n=>typeof n==='string').map(n=>n===L?'coordinator':n)})),
    } : {});
    const team = snap.members.filter(m=>!m.roleWorker && !m.narrator);
    const cleanPath = str => String(str||'').replace(/(?:~\/\.gemini\/[\w.-]+\/brain|\/(?:usr\/local\/google\/home|google\/src\/cloud))\/[^\s`'")]+/g, m=>{
      const parts=m.split('/').filter(Boolean); return parts.length>=2 ? '…/'+parts.slice(-2).join('/') : m;
    });
    const clipW = (str, maxW) => {
      const w = String(str||'').replace(/\s+/g,' ').trim().split(' ').filter(Boolean);
      return w.length > maxW ? w.slice(0, maxW).join(' ').replace(/[,;:.]+$/,'') + '…' : w.join(' ').replace(/[.:]+$/,'');
    };
    const briefOf = n => {
      const p = idx.briefs.get(n);
      if (typeof p === 'string') return p;
      if (!p) return '';
      let s=String(p.text).replace(/^@\S+[\s,:]*/,'').replace(/\*\*([^*]+)\*\*/g,'$1').split(/(?<=[.!?])\s|\n/)[0];
      s=s.replace(/\s*\((?:you\b|your\b)[^)]*\)/gi,'').replace(/\s*\((?:you\b|your\b)[^)]*$/gi,'');
      s=s.replace(/^(?:you\s+(?:are|own|handle|drive|run|lead|manage)|your\s+(?:role|job|task|assignment|goal|focus)\s+is(?:\s+to)?|assignment\s*:|role\s*:|task\s*:)\s*/i,'');
      // Briefs often restate the name ("You are `critic-gemini`, a harsh critic"); the badge already shows it.
      const nm=n.replace(/[.*+?^${}()|[\]\\-]/g,'\\$&');
      s=s.replace(new RegExp('^[`\'"*]*@?'+nm+'(?![\\w-])[`\'"*]*\\s*(?:[,:–—-]|\\bis\\b)?\\s*','i'),'').replace(/\*\*|__|`/g,'');
      s=s.replace(/^(?:turning|making|building|auditing|fixing)\s+(?:the\s+)?/i, m=>m.charAt(0).toUpperCase()+m.slice(1));
      s=s.replace(/^(?:the|a|an|this\s+swarm's)\s+/i,'');
      s=clipW(cleanPath(s), 16);
      const res = s ? s.charAt(0).toUpperCase()+s.slice(1) : '';
      idx.briefs.set(n, res);
      return res;
    };
    const lastPostBy = n => idx.lastByAgent.get(n) || null;
    const KINDS=['decision','failure','review','stuck','quota','error','fyi'];
    const attention = (Array.isArray(vj.attention)?vj.attention:[]).filter(a=>a&&a.title).map(a=>{
      const refs=Array.isArray(a.refs)?a.refs:[]; const seqRef=refs.find(r=>r&&r.seq); const memRef=refs.find(r=>r&&r.member&&byName.has(r.member)&&byName.get(r.member).role!=='coordinator');
      const acts=Array.isArray(a.actions)?a.actions:[]; const p=seqRef?(idx.bySeq.get(seqRef.seq)||null):null; const url=acts.find(x=>x&&x.type==='url');
      // The narrator's own jump target beats the first cited post.
      const jump=acts.find(x=>x&&x.type==='board_post'&&idx.bySeq.has(Number(x.target)));
      return { id: a.id ? String(a.id) : null, kind:KINDS.includes(a.kind)?a.kind:'fyi', severity:a.severity||'low', title:String(a.title).slice(0,160), why:String(a.why||'').slice(0,300), from: memRef?key(memRef.member):(p?p.a:'coordinator'), seq: (seqRef && Number(seqRef.seq)) || head, post: jump ? Number(jump.target) : (p ? p.s : null), url: url?url.target:null }; });
    (Array.isArray(snap.systemAttention)?snap.systemAttention:[]).forEach(s=>{ if(s && s.member && !isRole(s.member)) attention.push({id: String(s.id || `sys-${s.member}-${s.kind}`), sys: true, kind: s.kind==='quota'?'quota':s.kind==='stuck'?'stuck':'error', severity:'high', title: s.kind==='quota'?`@${s.member} ran out of quota`:s.kind==='stuck'?`@${s.member} looks stuck`:`@${s.member} hit an error`, why: String(s.text||s.detail||'').slice(0,200), from:key(s.member), seq:head}); });
    // Short copy the narrator writes next to each item (see swarm_narrator: `short`, `now`).
    (()=>{ const items={}, members={}; const sh=x=>x&&typeof x.short==='object'&&x.short?{title:String(x.short.title||'').slice(0,60), line:String(x.short.line||'').slice(0,90)}:null;
      (Array.isArray(vj.attention)?vj.attention:[]).forEach(a=>{ const s=sh(a); if(s&&a.id) items[String(a.id)]=s; });
      (Array.isArray(vj.workstreams)?vj.workstreams:[]).forEach(w=>{ const s=sh(w); if(s&&w.id) items[String(w.id)]=s; });
      if(vj.now && typeof vj.now==='object') Object.entries(vj.now).forEach(([n,v])=>{ if(typeof v==='string') members[n===L?'coordinator':n]=v.slice(0,48); });
      window.SwarmHive = window.SwarmHive || {}; window.SwarmHive.viewCopy = {items, members, lead: members.coordinator?{doing:members.coordinator}:{} }; })();
    const askByFrom = new Map();
    const SEV = {high:0, med:1, medium:1, low:2};
    attention.sort((a,b)=>(SEV[a.severity]??2)-(SEV[b.severity]??2));
    attention.filter(a=>a.kind!=='fyi' && !ISSUE_KINDS.has(a.kind) && a.from!=='coordinator').forEach(a=>{ if(!askByFrom.has(a.from)) askByFrom.set(a.from, a); });
    const issueByFrom = new Map();
    attention.filter(a=>ISSUE_KINDS.has(a.kind)).forEach(a=>{ if(!issueByFrom.has(a.from)) issueByFrom.set(a.from, a); });
    // Once the coordinator closes the swarm with [done] and no one is working, the
    // narrator's earlier asks and reviews are history; only a live system alert
    // (quota, error, stuck) keeps it open. Known before member status, so a stale
    // ask or question does not leave a worker waiting in a finished swarm.
    const lastP = P[P.length-1];
    const closed = !team.some(m=>!m.killed && m.status==='working') && !attention.some(a=>a.sys) &&
      !!lastP && lastP.a==='coordinator' && /^(@[A-Za-z0-9_-]+[\s,:–—-]*)*(?:\*\*|\*|`|_)?\[done\]/i.test(lastP.x);
    const needsYou = new Set(closed ? [] : askByFrom.keys());
    const members = {};
    team.forEach(m=>{ const n=key(m.name); const lp=lastPostBy(n);
      let status = m.killed ? 'parked' : (m.status==='working' ? 'working' : 'parked'); let waiting_on=null, waiting_seq=null;
      if(status==='parked' && !closed && !m.killed && lp && lp.to.length && !lp.to.includes('*') && /\?|could you|can you|please|ping me|waiting on/i.test(lp.x)){ const t=lp.to[0]; if((idx.maxSeqByAgent.get(t)??-Infinity)<=lp.s){ status='waiting_on'; waiting_on=t; waiting_seq=lp.s; } }
      // A worker's ask goes to the coordinator, so the worker waits on it.
      if(needsYou.has(n) && !m.killed){ status='waiting_on'; waiting_on='coordinator'; waiting_seq=askByFrom.get(n).seq; }
      const stripLead = s => String(s||'').replace(/^(@#?[A-Za-z0-9_-]+[\s,:–—-]*)+/,'').replace(/^(?:\*\*|\*|`|_)*\[(?:done|stall)\](?:\*\*|\*|`|_)*[\s:,–—-]*/i,'');
      // Until a woken worker's first step lands, show the post that woke it
      // instead of its last post from the previous turn. Reads raw messages
      // because P drops monitor posts and channel routing.
      let wake = null;
      if(!m.killed && m.status==='working' && !m.activity){
        const wakeFrom = Math.max(0, Number(m.wait_since) || 0, lp ? lp.s : 0);
        const findWake = (list) => {
          if (!Array.isArray(list)) return null;
          for (let i = list.length - 1; i >= 0 && Number(list[i].seq) > wakeFrom; i--) {
            const q = list[i];
            if ((q.control && typeof q.control==='object') || key(q.agent)===n) continue;
            if ((q.mentions||[]).some(t=>key(t)===n) || (q.via_channel||[]).some(t=>key(t)===n) || (q.all && !isRole(q.agent))) {
              return {s: q.seq, a: key(q.agent), x: stripLead(cleanText(q.text))};
            }
          }
          return null;
        };
        wake = findWake(snap.messages) || (Number(snap.messagesOffset) > 0 ? findWake(snap.pinnedMessages) : null);
      }
      const rawNow = (m.status==='working' && m.activity) ? String(m.activity)
          : wake ? `#${wake.s} from @${wake.a}` + (wake.x ? `: ${wake.x}` : '')
          : (lp ? stripLead(lp.x) : 'No posts yet');
      const now = cleanPath(rawNow).replace(/`([^`]+)`/g,'$1').slice(0,180);
      const live = (m.status==='working' && !m.killed && !m.failure && m.activity && (status==='working' || n==='coordinator'))
        ? {text: cleanPath(String(m.activity)).replace(/`([^`]+)`/g,'$1').slice(0,180), kind: m.activityKind==='thinking' ? 'thinking' : 'tool'}
        : null;
      const ask = !m.killed ? (askByFrom.get(n) || null) : null;
      const issue = !m.killed ? (issueByFrom.get(n) || null) : null;
      members[n] = { rawName:m.name, role:m.role, title: n==='coordinator' ? 'Coordinator' : ((typeof planTasks[m.name]==='string' && planTasks[m.name].trim()) ? String(planTasks[m.name]).trim().slice(0,120) : (briefOf(m.name) || '')), model:m.model||'', status, waiting_on, waiting_seq, waiting_for:'', now, live, ask, issue, steps:m.steps||0, posts:m.posts||0, killed:!!m.killed, last: lp?{seq:lp.s,time:lp.t,text:cleanPath(lp.x)}:null,
        owner: m.owner && m.owner.label ? {label:String(m.owner.label), kind:String(m.owner.kind||'')} : null, local: m.local!==false,
        workspace: typeof m.workspace==='string' ? m.workspace.trim() : '', workspace_mode: typeof m.workspace_mode==='string' ? m.workspace_mode.trim() : '',
        last_seen: Number.isFinite(m.last_seen) ? m.last_seen : null, channels: Array.isArray(m.channels) ? m.channels.map(String) : [] }; });
    if(!members.coordinator) members.coordinator = { rawName:L, role:'coordinator', title:'Coordinator', model:'', status:'parked', now:'', ask:null, steps:0, posts:0, last:null };
    snap.members.filter(m=>m.roleWorker||m.narrator).forEach(m=>{ members['~'+m.name]={system:true, status:'parked', model:m.model||'', title:m.role||'role'}; });
    // Without a narrator view: killed, or parked after posting [done] (or after any post
    // once the coordinator closes the swarm with [done]), is done;
    // parked after an interim post is in review; waiting on a peer is blocked;
    // only a worker that has not started yet is up next.
    const isDonePost = lp => !!(lp && /^(@[A-Za-z0-9_-]+[\s,:–—-]*)*(?:\*\*|\*|`|_)?\[done\]/i.test(lp.x));
    const finished = closed;
    const STATES=['queued','active','blocked','review','done','failed'];
    const parseProg = (w)=>{
      if(w.progress && typeof w.progress==='object' && Number(w.progress.total)>0){
        const tot=Math.max(1,Number(w.progress.total)||1), dn=Math.max(0,Math.min(tot,Number(w.progress.done)||0));
        return {done:dn, total:tot, label:String(w.progress.label||(dn+'/'+tot)).slice(0,24)};
      }
      if(typeof w.progress==='number' && w.progress>=0 && w.progress<=100){
        const p=Math.round(w.progress); return {done:p, total:100, label:p+'%'};
      }
      const fm=/(?<!cl\/)(?<!\d\.)\b(\d{1,2})\s*(?:\/|of)\s*(\d{1,2})\b(?!\s*(?:AM|PM|am|pm))/.exec(String(w.note||''));
      if(fm){ const d=+fm[1], t=+fm[2]; if(t>=2 && t<=60 && d<=t) return {done:d, total:t, label:`${d}/${t}`}; }
      return null;
    };
    let workstreams = (Array.isArray(vj.workstreams)?vj.workstreams:[]).filter(w=>w&&w.title).map((w,i)=>{ const seqs=(Array.isArray(w.refs)?w.refs:[]).map(r=>r&&r.seq).filter(Boolean); const rawState0=STATES.includes(w.state)?w.state:'active'; const rawState=(finished && rawState0!=='failed') ? 'done' : rawState0;
      return { id:w.id||('w'+i), title:String(w.title).slice(0,120), owners:(Array.isArray(w.owners)?w.owners:[]).filter(o=>byName.has(o)&&!isRole(o)).map(key), state: rawState==='failed'?'blocked':rawState, rawState, progress:parseProg(w), note:String(w.note||'').slice(0,200), seq: seqs.length?Math.max(...seqs):head }; });
    workstreams.forEach(w=>{ if(!w.owners.length) w.owners=['coordinator']; });
    const fallbackState = (x, lp) => x.killed ? 'done' : x.status==='waiting_on' ? 'blocked' :
        (x.status==='working' || x.status==='needs_you') ? 'active' : lp ? ((finished || isDonePost(lp)) ? 'done' : 'review') : 'queued';
    if(!workstreams.length) workstreams = team.filter(m=>m.role!=='coordinator').map(m=>{ const n=key(m.name); const lp=lastPostBy(n); const st=fallbackState(members[n], lp); return {id:n, title: (typeof planTasks[m.name]==='string' && planTasks[m.name].trim()) ? String(planTasks[m.name]).slice(0,120) : (members[n].title||'Task'), owners:[n], state: st, rawState: st, blocked_on: members[n].waiting_on||null, note: members[n].now, seq: lp?lp.s:head}; });
    Object.entries(members).forEach(([n,x])=>{
      if(!x.system && n!=='coordinator' && !x.title){
        const ow = workstreams.filter(w=>w.owners.includes(n));
        if(ow.length) x.title = clipW(ow[ow.length-1].title, 7);
      }
    });
    const done = workstreams.filter(w=>w.state==='done').length;
    // Who each item waits on. The coordinator stopping for the user (its turn
    // ended on a reply with no worker still at work, or it failed or ran out of
    // quota) is the only 'you'.
    // A reply that only reports progress is not a question; replyAsk is the
    // question the coordinator's last reply asked, if any.
    const coordAsk = (!finished && leadM && !leadM.killed && leadM.status==='waiting' && leadM.replied && leadM.replyAsk) ? String(leadM.replyAsk) : '';
    const coordReplied = !!coordAsk;
    attention.forEach(a=>{ a.wait = a.kind==='fyi' ? null
      : (a.from==='coordinator' && String(a.id||'').startsWith('sys-')) ? 'you'
      : ISSUE_KINDS.has(a.kind) ? 'issue' : 'coordinator'; });
    if(coordReplied) attention.unshift({id:'sys-coordinator-reply', kind:'decision', severity:'high', title:coordAsk, full:true, why:'The coordinator asked. Answer it in its chat.', from:'coordinator', seq:head, url:null, wait:'you'});
    const youItems = finished ? [] : attention.filter(a=>a.wait==='you');
    if(youItems.length && members.coordinator){ members.coordinator.status='needs_you'; members.coordinator.ask=youItems[0]; }
    // Surface @monitor's latest [stall] alert only while the swarm is idle,
    // open, not waiting on the user, and no task-team post has superseded it.
    const hasLiveWorkers = team.some(m=>m.role!=='coordinator' && !m.killed);
    const lastMonPost = idx.lastMonPost;
    const fmtStall = raw => {
      let s = cleanPath(String(raw||''))
          .replace(/^\s*(?:[-*]|#+)\s+/gm,'')
          .replace(/\*\*([^*]+)\*\*/g,'$1')
          .replace(/`([^`]+)`/g,'$1')
          .replace(/[*`_]*\[stall\][*`_]*[\s:,–—-]*/gi,' ')
          .replace(/\s+/g,' ')
          .trim();
      s = s.replace(/^((?:@[#A-Za-z0-9_-]+(?![#A-Za-z0-9_-])[\s,:–—-]*)+)(?=\S)(?!@[#A-Za-z0-9_-])/, (_, m) => m.match(/@[#A-Za-z0-9_-]+/g).join(' ') + ': ');
      return s.slice(0, 220);
    };
    const coordHandledStall = !!(leadM && !leadM.killed && leadM.status==='waiting' && leadM.replied && lastMonPost && (Number(leadM.last_read_seq)||0) >= (Number(lastMonPost.seq)||0));
    const lastMon = (!closed && !team.some(m=>!m.killed && m.status==='working') && !youItems.length && !coordHandledStall && hasLiveWorkers && lastMonPost && (!lastP || lastMonPost.seq >= lastP.s)) ? lastMonPost : null;
    const stall = lastMon ? { seq: Number(lastMon.seq)||0, agent: String(lastMon.agent||'monitor'), text: fmtStall(lastMon.text) } : null;
    const nowIso = new Date().toISOString();
    // Plan threads have no narrator line: use what the first working member in
    // the thread last said, clipped.
    const planNow = ids => { const x = ids.map(n=>members[n]).find(m=>m && !m.killed && m.status==='working'); return x ? clipW(x.now, 8) : ''; };
    return { title: snap.title||'Untitled swarm',
      headline: vj.headline ? String(vj.headline).slice(0,220) : (plan && vj.goal && vj.goal.line) ? String(vj.goal.line).slice(0,220) : '',
      phase: vj.phase && vj.phase.label ? {label:String(vj.phase.label).slice(0,40), index:Number(vj.phase.index)||1, total:Number(vj.phase.total)||1} : {label: finished?'Done':'In progress', index:1, total:1},
      done, total: workstreams.length||1, as_of: head, board_head: head, now: nowIso, started: P.length?P[0].t:nowIso, narrator_seq: Number(vj.as_of_seq)||head, finished, stall,
      builtin: snap.builtinOverview === true,
      starting: snap.builtinOverview === true && !finished && !narratorView && !attention.length && !stall && (idx.lastByAgent.size === 0 || (idx.lastByAgent.size === 1 && idx.lastByAgent.has('coordinator'))),
      workerStarted: team.some(m=>m.role!=='coordinator' && m.steps),
      latest: lastP?{agent:lastP.a,seq:lastP.s,time:lastP.t,text:lastP.x}:{agent:'coordinator',seq:0,time:nowIso,text:''},
      attention, workstreams, members,
      source: snap.source && typeof snap.source==='object' ? snap.source : null,
      // Progress reel (UI work only): frames the narrator picked; images come from /api/frame.
      reel: (()=>{ const fr=(vj.reel && Array.isArray(vj.reel.frames) && vj.reel.frames.length) ? vj.reel.frames : (Array.isArray(snap.frames) ? snap.frames : []); const conv=snap.conversationId||''; const tok=new URLSearchParams(location.search).get('token')||'';
        const out=fr.filter(f=>f && typeof f.path==='string' && f.path.startsWith('/')).slice(0,40).map(f=>({ src:`/api/frame?conversationId=${encodeURIComponent(conv)}&path=${encodeURIComponent(f.path)}&seq=${Number(f.seq)||0}${tok?`&token=${encodeURIComponent(tok)}`:''}`, seq:Number(f.seq)||0, caption:String(f.caption||'').slice(0,90) }));
        return out.length>=2 ? out : null; })(),
      goal: vj.goal && typeof vj.goal==='object' && vj.goal.title ? {title:String(vj.goal.title).slice(0,80), line:String(vj.goal.line||'').slice(0,120)} : null,
      fromPlan: !!plan,
      runningSummary: vj.running_summary ? String(vj.running_summary).slice(0,200) : '',
      threads: (Array.isArray(vj.threads)?vj.threads:[]).filter(t=>t&&t.title&&Array.isArray(t.workstreams)).slice(0,12).map(t=>({id:String(t.id||t.title).slice(0,48), title:String(t.title).slice(0,40), goal:String(t.goal||'').slice(0,100), now:String(t.now||(plan ? planNow(t.workstreams) : '')).slice(0,80), state:String(t.state||''), workstreams:t.workstreams.map(String), attention:(Array.isArray(t.attention)?t.attention:[]).map(String)})),
      hiveThreads: (Array.isArray(vj.threads)?vj.threads:[]).filter(t=>t&&t.title&&Array.isArray(t.workstreams)).slice(0,400).map(t=>({id:String(t.id||t.title).slice(0,48), title:String(t.title).slice(0,40), goal:String(t.goal||'').slice(0,100), now:String(t.now||(plan ? planNow(t.workstreams) : '')).slice(0,80), state:String(t.state||''), workstreams:t.workstreams.map(String), attention:(Array.isArray(t.attention)?t.attention:[]).map(String)})),
    };
  }


  /* ---------- Hive map (Graph tab) ----------
     Threads are honeycomb cells around the coordinator, and each worker's bee
     sits in the cell it works in. A cell's border fills as its tasks finish,
     dashes run from a waiting bee to whoever it waits on, and a beam marks the
     newest post. Stepping back through the board (opts.seq) works each bee's
     state out from the posts up to that point. */
  const HV = {host: null, root: null, key: '', swarm: null, beam: null, ro: null, args: null};
  const HV_RING = [[0,-1],[1,-1],[1,0],[0,1],[-1,1],[-1,0]];
  // Which ring-one slots a few cells take, so two or three cells sit balanced around the middle.
  const HV_FEW = {1:[0], 2:[5,1], 3:[0,2,4], 4:[5,1,4,2], 5:[5,0,1,4,2]};
  const HV_ASK = /\?|could you|can you|please|ping me|waiting on/i;
  const HV_BUSY_MS = 45 * 60 * 1000, HV_ASK_MS = 6 * 3600 * 1000;

  // Each member's state: {st: working | wait | needs | issue | done | idle | retired | unborn, who}.
  function hiveStates(sc, seq) {
    const out = {}, names = Object.keys(sc.members).filter(n => !sc.members[n].system);
    if (seq == null) {
      const owned = n => sc.workstreams.filter(w => w.owners.includes(n));
      names.forEach(n => { const x = sc.members[n]; let st = 'idle', who = null;
        if (x.killed) st = 'retired';
        else if (sc.finished) st = n === 'coordinator' ? 'idle' : 'done';
        else if (x.issue) st = 'issue';
        else if (x.status === 'working') st = 'working';
        else if (x.status === 'waiting_on') { st = 'wait'; who = x.waiting_on; }
        else if (n !== 'coordinator' && owned(n).length && owned(n).every(w => w.state === 'done')) st = 'done';
        out[n] = {st, who}; });
      if (!sc.finished && out.coordinator && out.coordinator.st !== 'retired' && sc.attention.some(a => a.wait === 'you')) out.coordinator = {st: 'needs', who: null};
      const lp = P[P.length - 1];
      return {st: out, done: null, beam: lp && Date.now() - Date.parse(lp.t) < 90 * 1000 ? lp : null};
    }
    let i = -1; while (i + 1 < P.length && P[i + 1].s <= seq) i++;
    const fin = {}, lastPost = {}, lastIn = {}, born = {coordinator: true}, tms = k => Date.parse(P[k].t);
    P.forEach((p, k) => { fin[p.a] = k; });
    const to = p => p.to.includes('*') ? [] : p.to;
    for (let k = 0; k <= i; k++) { const p = P[k]; born[p.a] = true; lastPost[p.a] = k; to(p).forEach(n => { born[n] = true; lastIn[n] = k; }); }
    const now = i >= 0 ? tms(i) : 0;
    names.forEach(n => { const x = sc.members[n], lp = lastPost[n] ?? -1, li = lastIn[n] ?? -1; let st = 'idle', who = null;
      if (!born[n]) st = 'unborn';
      else if (x.killed && (fin[n] != null ? (i >= fin[n] && (i > fin[n] + 8 || now - tms(fin[n]) > HV_BUSY_MS)) : i > li + 8)) st = 'retired';
      else if (li > lp && now - tms(li) < HV_BUSY_MS) { st = 'working'; who = P[li].a; }
      else if (lp >= 0 && HV_ASK.test(P[lp].x) && to(P[lp]).length && now - tms(lp) < HV_ASK_MS && (lastPost[to(P[lp])[0]] ?? -1) <= lp) { st = 'wait'; who = to(P[lp])[0]; }
      else if (lp >= 0 && fin[n] <= i && n !== 'coordinator') st = 'done';
      else if (lp >= 0 && i - lp < 3 && now - tms(lp) < 4 * 60 * 1000) st = 'working';
      out[n] = {st, who: who === n ? null : who}; });
    return {st: out, done: n => out[n] && (out[n].st === 'retired' || (fin[n] != null && fin[n] <= i)), beam: i >= 0 ? P[i] : null};
  }

  // The cells around the coordinator: one per thread (plus Other for workers
  // outside every thread), or one per state when the swarm has no threads.
  function hiveCells(sc, hs) {
    const workers = Object.keys(sc.members).filter(n => !sc.members[n].system && n !== 'coordinator' && hs.st[n]);
    const wsById = new Map(sc.workstreams.map(w => [w.id, w]));
    const wsDone = w => hs.done ? w.owners.every(o => o === 'coordinator' || hs.done(o)) : w.state === 'done';
    const settled = n => ['done', 'retired'].includes(hs.st[n].st);
    const cells = [];
    const threads = sc.hiveThreads || sc.threads;
    if (threads.length) {
      threads.forEach(t => { const ws = t.workstreams.map(id => wsById.get(id)).filter(Boolean);
        cells.push({id: t.id, title: t.title, goal: t.goal || '', ws, bees: [], total: ws.length, done: ws.filter(wsDone).length}); });
      const homed = new Set();
      // A bee lives in the first thread where it still has open work, else in its first thread.
      workers.forEach(n => { const mine = cells.filter(c => c.ws.some(w => w.owners.includes(n))); if (!mine.length) return;
        (mine.find(c => c.ws.some(w => w.owners.includes(n) && !wsDone(w))) || mine[0]).bees.push(n); homed.add(n); });
      const rest = workers.filter(n => !homed.has(n));
      if (rest.length) cells.push({id: '_other', title: 'Other', bees: rest, total: rest.length, done: rest.filter(settled).length});
    } else {
      [['Working', n => hs.st[n].st === 'working'], ['Waiting', n => ['wait', 'issue'].includes(hs.st[n].st)],
       ['Resting', n => hs.st[n].st === 'idle'], ['Done', settled]].forEach(([title, pick]) => {
        const bees = workers.filter(pick); if (bees.length) cells.push({id: '_' + title, title, bees, total: bees.length, done: title === 'Done' ? bees.length : 0, count: bees.length}); });
    }
    return cells.slice(0, 400);
  }

  // Ring-by-ring spiral of hexagon slots around the middle (axial q, r).
  function hiveSlots(n) {
    if (n < 1) return [];
    if (n < 6) return HV_FEW[n].map(k => HV_RING[k]);
    const out = [], D = [[1,0],[0,1],[-1,1],[-1,0],[0,-1],[1,-1]];
    for (let k = 1; out.length < n; k++) { let q = 0, r = -k; D.forEach(([dq, dr]) => { for (let j = 0; j < k; j++) { out.push([q, r]); q += dq; r += dr; } }); }
    return out.slice(0, n);
  }

  function hiveDraw() {
    const {root} = HV, sc = S.live; if (!root || !sc || !HV.args) return;
    const stage = root.querySelector('.hv-stage'), svg = root.querySelector('.hv-svg'), layer = root.querySelector('.hv-bees'), sum = root.querySelector('.hv-sum'), view = root.querySelector('.hv-view');
    const W = Math.floor(root.querySelector('.hv').clientWidth); if (W < 40) return;
    const seq = HV.args.seq, key = `${S.etag}|${seq}|${W}|${HV.zoom}|${HV.sel}`;
    if (key === HV.key) return;
    HV.key = key;
    const hs = hiveStates(sc, seq), cells = hiveCells(sc, hs), K = Math.sqrt(3) / 2;
    const slots = hiveSlots(cells.length);
    // The selected thread: outlined, with its own waiting lines and a card of its bees below the map.
    const selC = cells.find(c => c.id === HV.sel) || null; if (!selC) HV.sel = null;
    HV.cellIds = cells.map(c => c.id);
    // Size the flat-top hexagons to the pane. Three sizes: full (names, tasks,
    // every bee), mid (a short title and small bees), and tiny for a swarm with
    // dozens of threads, where each cell is tinted by its state.
    const ux = q => 1.5 * q, uy = (q, r) => 2 * K * (r + q / 2);
    const xs = [0, ...slots.map(([q]) => ux(q))], ys = [0, ...slots.map(([q, r]) => uy(q, r))];
    const spanX = Math.max(...xs) - Math.min(...xs) + 2, spanY = Math.max(...ys) - Math.min(...ys) + 2 * K;
    const fit = (W - 8) / spanX, gap = fit < 44 ? 3 : 7;
    // Zoom scales the hexagons; past the pane's width the map scrolls, and bigger
    // cells bring back their names, counts and bees.
    const Rfit = Math.max(12, Math.min(108, fit - gap / 2)), zmax = 108 / Rfit;
    HV.zmax = zmax; HV.zoom = Math.max(1, Math.min(zmax, HV.zoom));
    HV.key = `${S.etag}|${seq}|${W}|${HV.zoom}|${HV.sel}`;  // the zoom and selection as drawn, so a clamp is not redrawn
    const R = Math.min(108, Rfit * HV.zoom), G = R + gap / 2;
    const mode = R >= 76 ? 'full' : R >= 40 ? 'mid' : 'tiny';
    const CW = Math.max(W, Math.ceil(spanX * G + 8));
    const ox = CW / 2 - (Math.max(...xs) + Math.min(...xs)) / 2 * G, oy = 4 + K * R - Math.min(...ys) * G, H = Math.ceil(spanY * G + 8);
    const hex = (x, y, r, a0) => { let d = ''; for (let k = 0; k < 6; k++) { const a = (a0 + 60 * k) * Math.PI / 180; d += (k ? 'L' : 'M') + (x + r * Math.cos(a)).toFixed(1) + ' ' + (y + r * Math.sin(a)).toFixed(1); } return d + 'Z'; };
    const wrap = (t, max) => { const out = []; let cur = ''; String(t).split(' ').forEach(w => { if (cur && (cur + ' ' + w).length > max) { out.push(cur); cur = w; } else cur = (cur + ' ' + w).trim(); }); if (cur) out.push(cur); if (out.length > 2) { out.length = 2; out[1] = out[1].replace(/.$/, '…'); } return out; };
    const clip = (t, max) => { const s = String(t); return s.length > max ? s.slice(0, Math.max(1, max - 1)).trimEnd() + '…' : s; };
    const names = R >= 92, pos = {}, tucked = new Set();
    const agg = c => { const s = c.bees.map(n => hs.st[n].st); return s.includes('issue') ? 'bad' : s.includes('wait') ? 'warn' : s.includes('working') ? 'busy' : ''; };
    let cellSvg = '', textSvg = '', selSvg = '';
    const cell = (x, y, f, cls, tip, k) => { cellSvg += `<path class="hv-cell${f >= 1 && !/busy|warn|bad/.test(cls) ? ' full' : ''}${cls ? ' ' + cls : ''}" data-c="${k}" d="${hex(x, y, R, 0)}"><title>${esc(tip)}</title></path>` + (f > 0 && f < 1 || (f >= 1 && mode !== 'tiny') ? `<path class="hv-prog" pathLength="1" stroke-dasharray="${Math.min(1, f).toFixed(3)} 1" d="${hex(x, y, R - 2, -120)}"/>` : ''); };
    const allDone = hs.done ? cells.reduce((a, c) => a + c.done, 0) : sc.done, allTot = hs.done ? cells.reduce((a, c) => a + c.total, 0) : sc.total;
    const you = hs.st.coordinator && hs.st.coordinator.st === 'needs';
    cell(ox, oy, allTot ? allDone / allTot : 0, mode === 'tiny' ? 'hub' : '', `Coordinator · ${allDone} of ${allTot} done${you ? ' · ' + ui('needs') : ''}`, -1);
    if (mode === 'full') {
      pos.coordinator = {x: ox, y: oy - R * .12, size: 'q'};
      textSvg += `<text class="hv-t" x="${ox}" y="${(oy + R * .44).toFixed(1)}">Coordinator</text><text class="hv-n${you ? ' warn' : ''}" x="${ox}" y="${(oy + R * .44 + 15).toFixed(1)}">${you ? ui('needs') : `${allDone} of ${allTot} done`}</text>`;
    } else if (mode === 'mid') {
      pos.coordinator = {x: ox, y: oy - 6, size: 'm'};
      textSvg += `<text class="hv-n sm${you ? ' warn' : ''}" x="${ox}" y="${(oy + R * .62).toFixed(1)}">${you ? ui('needs') : `${allDone}/${allTot}`}</text>`;
    } else pos.coordinator = {x: ox, y: oy, size: R >= 26 ? 'm' : 'xs'};
    cells.forEach((c, k) => { const [q, r] = slots[k], x = ox + ux(q) * G, y = oy + uy(q, r) * G;
      const tip = `${c.title} · ${c.count ?? (c.total ? `${c.done}/${c.total} done` : 'no tasks')}${c.bees.length ? ' · ' + c.bees.slice(0, 6).map(n => '@' + n).join(', ') + (c.bees.length > 6 ? ` +${c.bees.length - 6}` : '') : ''}`;
      cell(x, y, c.total ? c.done / c.total : c.done, (mode === 'tiny' ? agg(c) : '') + (c === selC ? ' sel' : ''), tip, k);
      if (c === selC) selSvg = `<path class="hv-selring" d="${hex(x, y, R + 1.5, 0)}"/>`;
      if (mode === 'tiny') {
        // One bee at most: whoever is stuck, waiting or working.
        const pick = R >= 18 && (c.bees.find(n => hs.st[n].st === 'issue') || c.bees.find(n => hs.st[n].st === 'wait') || c.bees.find(n => hs.st[n].st === 'working'));
        c.bees.forEach(n => { if (n === pick) pos[n] = {x, y, size: 'xs'}; else { pos[n] = {x, y, cell: true}; tucked.add(n); } });
        return;
      }
      // Bees nobody has mentioned yet at this point of the replay take no place.
      // Stuck, waiting and working bees come first, so "+N" never hides one.
      const rank = n => ({issue: 0, wait: 1, working: 2})[hs.st[n].st] ?? 3;
      const born = c.bees.filter(n => hs.st[n].st !== 'unborn').sort((a, b) => rank(a) - rank(b));
      c.bees.forEach(n => { if (!born.includes(n)) pos[n] = {x, y, size: 'xs'}; });
      if (mode === 'mid') {
        const ty = y - K * R + 15;
        textSvg += `<text class="hv-t sm" x="${x.toFixed(1)}" y="${ty.toFixed(1)}">${esc(clip(c.title, Math.floor((R + 8) / 6.2)))}</text><text class="hv-n sm" x="${x.toFixed(1)}" y="${(ty + 12).toFixed(1)}">${c.count ?? `${c.done}/${c.total}`}</text>`;
        const show = born.length > 3 ? born.slice(0, 2) : born, by = y + R * .34;
        show.forEach((n, j) => { pos[n] = {x: x + (j - (show.length - 1 + (show.length < born.length ? 1 : 0)) / 2) * 24, y: by, size: 'xs'}; });
        if (show.length < born.length) { textSvg += `<text class="hv-n sm" x="${(x + 24).toFixed(1)}" y="${(by + 4).toFixed(1)}">+${born.length - show.length}</text>`;
          born.slice(show.length).forEach(n => { pos[n] = {x: x + 24, y: by, size: 'xs'}; tucked.add(n); }); }
        return;
      }
      const lines = wrap(c.title, R >= 92 ? 15 : 12), ty = y - K * R + (lines.length > 1 ? 20 : 26);
      lines.forEach((l, j) => { textSvg += `<text class="hv-t" x="${x.toFixed(1)}" y="${(ty + j * 14).toFixed(1)}">${esc(l)}</text>`; });
      textSvg += `<text class="hv-n" x="${x.toFixed(1)}" y="${(ty + lines.length * 14).toFixed(1)}">${c.count ?? `${c.done}/${c.total}`}</text>`;
      const per = Math.max(2, Math.min(3, Math.floor(1.6 * R / 50))), cap = per * 2, show = born.length > cap ? born.slice(0, cap - 1) : born;
      const sw = Math.min(58, 1.66 * R / per), rows = show.length > per ? [show.slice(0, per), show.slice(per)] : [show], rg = names ? 54 : 40;
      const top = ty + lines.length * 14 + 8, bot = y + K * R - (names ? 16 : 6), y0 = (top + bot) / 2 - (rows.length - 1) * rg / 2 - (names ? 6 : 0);
      rows.forEach((rw, ri) => rw.forEach((n, j) => { pos[n] = {x: x + (j - (rw.length - 1) / 2) * sw, y: y0 + ri * rg, size: 'm'}; }));
      if (show.length < born.length) { const lr = rows[rows.length - 1], px = x + ((lr.length + 1) / 2) * sw - sw / 2 + 4, py = y0 + (rows.length - 1) * rg;
        textSvg += `<text class="hv-n" x="${px.toFixed(1)}" y="${(py + 4).toFixed(1)}">+${born.length - show.length}</text>`;
        born.slice(show.length).forEach(n => { pos[n] = {x: px, y: py, size: 'xs'}; tucked.add(n); }); } });
    const beam = hs.beam, fresh = !!beam && HV.beam !== beam.s, still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // Arrowhead at the awaited end: the line runs from the bee that waits to the bee it waits on.
    const head = (fx, fy, x, y) => { const l = Math.hypot(x - fx, y - fy) || 1, tx = (x - fx) / l, ty = (y - fy) / l, bx = x - tx * 10, by = y - ty * 10;
      return `<path class="hv-ah" d="M${x.toFixed(1)} ${y.toFixed(1)}L${(bx - ty * 3.8).toFixed(1)} ${(by + tx * 3.8).toFixed(1)}L${(bx + ty * 3.8).toFixed(1)} ${(by - tx * 3.8).toFixed(1)}Z"/>`; };
    const PAD = {q: 36, m: 24, xs: 13}, padOf = p => p.cell ? R * .5 : PAD[p.size];
    const drawn = new Set();
    const link = (a, b, cls) => { const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1, pa = padOf(a), pb = padOf(b);
      if (len < pa + pb + 6) return '';   // neighbours: no room for a line
      const id = `${cls}|${a.x.toFixed(0)},${a.y.toFixed(0)}|${b.x.toFixed(0)},${b.y.toFixed(0)}`; if (drawn.has(id)) return ''; drawn.add(id);
      const vx = dx / len, vy = dy / len, x1 = a.x + vx * pa, y1 = a.y + vy * pa, x2 = b.x - vx * pb, y2 = b.y - vy * pb, bend = Math.min(26, (len - pa - pb) * .2);
      const mx = (x1 + x2) / 2 - vy * bend, my = (y1 + y2) / 2 + vx * bend, short = len - pa - pb < 30;
      // A waiting line stops at the base of its arrowhead, so the two do not overlap.
      const cut = cls === 'wait' && !short ? 9 : 0, hl = Math.hypot(x2 - mx, y2 - my) || 1, ex = x2 - (x2 - mx) / hl * cut, ey = y2 - (y2 - my) / hl * cut;
      const d = `M${x1.toFixed(1)} ${y1.toFixed(1)} Q${mx.toFixed(1)} ${my.toFixed(1)} ${ex.toFixed(1)} ${ey.toFixed(1)}`;
      // A new post sends one small dot along its line, from the sender to whoever it names.
      const dot = cls !== 'beam' ? '' : (fresh && !still)
          ? `<circle class="hv-bd" r="2.5"><animateMotion class="hv-fly" dur="0.7s" begin="indefinite" fill="freeze" calcMode="spline" keyTimes="0;1" keySplines=".3 0 .2 1" path="${d}"/></circle>`
          : `<circle class="hv-bd" r="2.5" cx="${x2.toFixed(1)}" cy="${y2.toFixed(1)}"/>`;
      return (cls === 'wait' && short ? '' : `<path class="hv-ln ${cls}" d="${d}"/>`) + dot + (cls === 'wait' ? (short ? head(a.x, a.y, x2, y2) : head(mx, my, x2, y2)) : ''); };
    const seen = n => pos[n] && hs.st[n] && hs.st[n].st !== 'unborn';
    let lines = '';
    Object.entries(hs.st).forEach(([n, s]) => { if (s.st === 'wait' && s.who && seen(n) && seen(s.who) && (selC ? (selC.bees.includes(n) || selC.bees.includes(s.who)) : cells.length <= 18)) lines += link(pos[n], pos[s.who], 'wait'); });
    if (beam && seen(beam.a)) beam.to.forEach(t => { if (seen(t)) lines += link(pos[beam.a], pos[t], 'beam'); });
    // Past a couple of rings the cells carry no text, so a line above the hive gives the totals.
    const tally = k => cells.filter(c => agg(c) === k).length, doneT = cells.filter(c => !agg(c) && c.total && c.done >= c.total).length;
    const many = cells.length > 18;
    sum.hidden = !many;
    if (many) sum.innerHTML = `<span><b>${cells.length}</b> thread${cells.length === 1 ? '' : 's'}</span>` +
        [['busy', 'working'], ['warn', 'waiting'], ['bad', 'stuck']].map(([k, l]) => tally(k) ? `<span class="${k}"><i></i>${tally(k)} ${l}</span>` : '').join('') + (doneT ? `<span class="ok"><i></i>${doneT} done</span>` : '');
    root.querySelector('.hv').dataset.size = mode;
    stage.style.height = H + 'px';
    stage.style.width = CW + 'px';
    svg.setAttribute('viewBox', `0 0 ${CW} ${H}`);
    // Zoomed in, the map keeps its place on the page and scrolls inside it.
    const zoomed = HV.zoom > 1.001, f = HV.focus; HV.focus = null;
    view.classList.toggle('zoomed', zoomed);
    view.style.height = zoomed ? Math.max(320, Math.min(Math.ceil(spanY * (Rfit + gap / 2) + 8), window.innerHeight - 160)) + 'px' : '';
    // A centred zoom centres on the scroll box as it is now, after it took its zoomed size.
    if (zoomed && f) { view.scrollLeft = ox + f.u * G - (f.ax ?? view.clientWidth / 2); view.scrollTop = oy + f.v * G - (f.ay ?? view.clientHeight / 2); }
    HV.geo = {ox, oy, G, units: [[0, 0], ...slots.map(([q, r]) => [ux(q), uy(q, r)])]};
    const zg = root.querySelector('.hv-zoom'), [zOut, zIn, zFit] = zg.querySelectorAll('button');
    zg.hidden = zmax < 1.15; zOut.disabled = zFit.disabled = !zoomed; zIn.disabled = HV.zoom > zmax - .001;
    root.querySelector('.hv').classList.toggle('can-zoom', zmax >= 1.15 && mode !== 'full');
    // Bees jump with the map on a zoom, and fly only when they change cells.
    if (HV.lastZoom !== HV.zoom) { const j = HV.jump = (HV.jump || 0) + 1; layer.classList.add('jump'); requestAnimationFrame(() => requestAnimationFrame(() => { if (j === HV.jump) layer.classList.remove('jump'); })); HV.lastZoom = HV.zoom; }
    svg.classList.toggle('fresh', fresh);
    HV.beam = beam ? beam.s : null;
    svg.innerHTML = cellSvg + selSvg + lines + textSvg;
    // Animations added through innerHTML start on the document clock (long past), so start them here.
    svg.querySelectorAll('.hv-fly').forEach(a => { const c = a.parentNode; c.style.opacity = 0; a.beginElement && a.beginElement(); requestAnimationFrame(() => { c.style.opacity = ''; }); });
    layer.classList.toggle('names', names);
    // Bees keep their element from one draw to the next, so they fly to a new cell.
    const label = s => ({working: s.who ? `Working for @${s.who}` : 'Working', wait: `Waiting on @${s.who}`, needs: ui('needs'), issue: 'Stuck', done: 'Done', idle: 'Resting', retired: 'Retired', unborn: 'Not started'}[s.st]);
    const have = new Map([...layer.children].map(b => [b.dataset.n, b]));
    Object.keys(pos).forEach(n => { const x = sc.members[n], s = hs.st[n]; if (!x || !s || tucked.has(n)) return;
      let b = have.get(n);
      if (!b) { b = document.createElement('button'); b.type = 'button'; b.className = 'hv-bee'; b.dataset.n = n;
        b.innerHTML = `${spriteTag(n, 'landed')}<i class="hv-dot"></i><span class="hv-nm">${esc(n)}</span>`; layer.appendChild(b); }
      have.delete(n);
      const queen = n === 'coordinator', art = s.st === 'working' ? 'working' : s.st === 'wait' ? 'waiting_on' : 'landed', size = pos[n].size;
      if (b.dataset.art !== art) { b.dataset.art = art; b.querySelectorAll('.beebox, .beewrap').forEach(e => { e.dataset.state = art; }); paintSprites(b); }
      b.className = `hv-bee ${s.st} sz-${size}${queen ? ' q' : ''}`;
      b.tabIndex = s.st === 'unborn' ? -1 : 0; b.setAttribute('aria-hidden', String(s.st === 'unborn'));
      const [w, h] = {q: [66, 54], m: [44, 36], xs: [22, 18]}[size];
      b.style.transform = `translate(${Math.round(pos[n].x - w / 2)}px,${Math.round(pos[n].y - h / 2)}px)`;
      const what = label(s);
      const tip = `@${n}${x.title && !queen ? ' · ' + x.title : ''}${what ? ' · ' + what : ''}`;
      b.title = tip; b.setAttribute('aria-label', tip); });
    have.forEach(b => b.remove());
    const card = root.querySelector('.hv-card');
    card.hidden = !selC;
    const cardHtml = !selC ? '' : `<div class="hv-ch"><div class="hv-cht"><b>${esc(selC.title)}</b>${selC.goal ? `<span>${esc(selC.goal)}</span>` : ''}</div>` +
        `<span class="hv-cc">${selC.count == null && selC.total ? `${selC.done} of ${selC.total} done` : `${selC.bees.length} bee${selC.bees.length === 1 ? '' : 's'}`}</span>` +
        `<button type="button" class="icon-btn" data-hvx title="Close" aria-label="Close"><svg class="icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg></button></div>` +
        (selC.bees.length ? `<ul class="hv-rows">${selC.bees.map(n => { const x = sc.members[n], st = hs.st[n];
          return `<li><button type="button" class="hv-row" data-n="${esc(n)}" title="Open @${esc(n)}"><img src="${beeImg(n)}" alt="" width="44" height="36"><span class="hv-rb"><span class="hv-rh"><b>@${esc(n)}</b>${x.title ? `<i>${esc(x.title)}</i>` : ''}</span>${x.now && st.st !== 'unborn' ? `<span class="hv-rl">${esc(x.now)}</span>` : ''}</span><span class="hv-rs ${st.st}">${esc(label(st))}</span></button></li>`; }).join('')}</ul>`
        : `<p class="hv-re">No one is on this thread yet.</p>`);
    // Written only when it changes, so a poll keeps the card's buttons and focus.
    if (HV.cardHtml !== cardHtml) { HV.cardHtml = cardHtml; card.innerHTML = cardHtml; }
  }

  // Zoom to `z`, keeping the map point under (ax, ay) of the scroll box in place
  // (default: its centre), or centring cell `k` when given.
  function hiveZoom(z, ax, ay, k) {
    const view = HV.root && HV.root.querySelector('.hv-view'), g = HV.geo; if (!view || !g) return;
    z = Math.max(1, Math.min(HV.zmax || 1, z));
    const unit = k != null && g.units[k + 1], cx = ax ?? view.clientWidth / 2, cy = ay ?? view.clientHeight / 2;
    HV.focus = unit ? {u: unit[0], v: unit[1]}
        : {u: (view.scrollLeft + cx - g.ox) / g.G, v: (view.scrollTop + cy - g.oy) / g.G, ax, ay};
    if (z === HV.zoom) { HV.focus = null; return; }
    HV.zoom = z;
    try { hiveDraw(); } catch (e) { console.warn('SwarmHive', e); }
  }

  function hiveMap(snap, el, opts) {
    if (!snap || !el) return;
    if (HV.host !== el || !HV.root || !HV.root.isConnected || HV.swarm !== snap.id) {
      el.innerHTML = `<div class="pane embedded"><div class="o2 hv"><div class="hv-bar"><div class="hv-sum" hidden></div><div class="btn-group hv-zoom" role="group" aria-label="Zoom" hidden><button type="button" class="icon-btn" data-hvz="out" title="Zoom out" aria-label="Zoom out"><svg class="icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8h9"/></svg></button><button type="button" class="icon-btn" data-hvz="in" title="Zoom in" aria-label="Zoom in"><svg class="icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8h9M8 3.5v9"/></svg></button><button type="button" class="icon-btn" data-hvz="fit" title="Fit the whole swarm" aria-label="Fit the whole swarm"><svg class="icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 6V3h3M10 3h3v3M13 10v3h-3M6 13H3v-3"/></svg></button></div></div><div class="hv-view"><div class="hv-stage"><svg class="hv-svg" role="img" aria-label="Where each worker is, by thread"></svg><div class="hv-bees"></div></div></div>
        <div class="hv-key" aria-hidden="true"><span><i class="hv-kd"></i>Tasks done</span><span><i class="hv-km"></i>Message just sent</span><span><i class="hv-kw"></i>Waiting on</span><span class="hv-tk"><i class="hv-sw busy"></i>Working</span><span class="hv-tk"><i class="hv-sw warn"></i>Waiting</span><span class="hv-tk"><i class="hv-sw ok"></i>Done</span></div><section class="hv-card" aria-live="polite" hidden></section></div></div>`;
      Object.assign(HV, {host: el, root: el.firstElementChild, key: '', swarm: snap.id, beam: null, zoom: 1, zmax: 1, focus: null, geo: null, lastZoom: 1, dragged: false, sel: null, cellIds: [], cardHtml: null});
      const redraw = () => { try { hiveDraw(); } catch (e) { console.warn('SwarmHive', e); } };
      if (!HV.keyed) { HV.keyed = true; document.addEventListener('keydown', e => { if (e.key === 'Escape' && !e.defaultPrevented && HV.sel && HV.root && HV.root.offsetParent) { HV.sel = null; redraw(); } }); }
      const hooks = () => (window.SwarmHive && window.SwarmHive.hooks) || {};
      const view = HV.root.querySelector('.hv-view');
      HV.root.addEventListener('click', e => {
        if (HV.dragged) { HV.dragged = false; return; }   // the end of a drag, not a click
        const zb = e.target.closest('[data-hvz]');
        if (zb) { hiveZoom(zb.dataset.hvz === 'fit' ? 1 : HV.zoom * (zb.dataset.hvz === 'in' ? 1.6 : 1 / 1.6)); return; }
        if (e.target.closest('[data-hvx]')) { HV.sel = null; redraw(); return; }
        const row = e.target.closest('.hv-row');
        if (row) { if (hooks().member) hooks().member(row.dataset.n); return; }
        const b = e.target.closest('.hv-bee'), hv = HV.root.querySelector('.hv'), small = hv.classList.contains('can-zoom');
        // A cell too small to read: a click on it (or on the one bee it shows) zooms
        // in until its name and bees show. Once names show, a bee opens its chat.
        const c = e.target.closest('.hv-cell') || (b && small && hv.dataset.size === 'tiny' && document.elementsFromPoint(e.clientX, e.clientY).find(x => x.classList && x.classList.contains('hv-cell')));
        if (b && !c) { if (hooks().member) hooks().member(b.dataset.n); return; }
        if (c && hv.dataset.size === 'tiny') { if (small) hiveZoom(Math.max(HV.zoom * 1.6, 96 / (108 / HV.zmax)), null, null, Number(c.dataset.c)); return; }
        // A readable cell: select its thread (click it again, the space around the map, or Esc to clear).
        const id = c ? HV.cellIds[Number(c.dataset.c)] : null;
        if (id != null || (HV.sel && e.target.closest('.hv-view'))) { HV.sel = id != null && id !== HV.sel ? id : null; redraw(); }
      });
      // Pinch or Ctrl+scroll zooms around the pointer; plain scrolling moves the map.
      view.addEventListener('wheel', e => { if (!e.ctrlKey && !e.metaKey) return; e.preventDefault();
        const b = view.getBoundingClientRect(); hiveZoom(HV.zoom * Math.exp(-e.deltaY * .01), e.clientX - b.left, e.clientY - b.top); }, {passive: false});
      // Drag to pan while zoomed in.
      view.addEventListener('pointerdown', e => { if (e.button !== 0 || !view.classList.contains('zoomed')) return;
        const x0 = e.clientX, y0 = e.clientY, sl = view.scrollLeft, st = view.scrollTop; let moved = false;
        const move = ev => { const dx = ev.clientX - x0, dy = ev.clientY - y0; if (!moved && Math.hypot(dx, dy) < 5) return; moved = true; view.classList.add('panning'); view.scrollLeft = sl - dx; view.scrollTop = st - dy; };
        const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); view.classList.remove('panning');
          if (moved) { HV.dragged = true; setTimeout(() => { HV.dragged = false; }, 0); } };
        window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up); });
      if (HV.ro) HV.ro.disconnect();
      HV.ro = new ResizeObserver(() => { try { hiveDraw(); } catch (e) { console.warn('SwarmHive', e); } });
      HV.ro.observe(HV.root);
    }
    HV.args = {seq: opts && opts.seq != null ? Number(opts.seq) : null};
    try {
      const sk = snapKey(snap);
      if (S.etag !== sk) { S.live = toModel(snap); S.etag = sk; }
      hiveDraw();
    } catch (e) { console.warn('SwarmHive', e); }
  }

  // Includes loaded paging bounds so on-demand history prepends invalidate even when snap.etag is unchanged.
  const snapKey = s => `${s.etag || ''}\0${Number(s.messagesOffset) || 0}\0${s.messages?.length || 0}\0${s.pinnedMessages?.length || 0}`;
  const ROOTS = new Map();   // container element -> {root, view, etag}
  function sync() { ROOTS.forEach((r, el) => { const tab = el.closest('.tab-body'); if (r.root.isConnected && (!tab || tab.classList.contains('active'))) render(r.root, r.view); }); }
  const RO = new ResizeObserver(es => { if (S.live && S.live.starting && !state.onboardAt && es.some(e => e.contentRect.width > 0)) sync(); });
  window.SwarmHive = Object.assign(window.SwarmHive || {}, {
    // Agent color shared with the Board avatars, so a name has one color everywhere.
    colorOf(n) { return tcol(n === (window.SwarmHive.leadName || 'coordinator') ? 'coordinator' : n); },
    // Board avatar: the member's bee on its tile color (the coordinator wears the crown).
    avatarHtml(name) {
      const n = name === (window.SwarmHive.leadName || 'coordinator') ? 'coordinator' : String(name || '?');
      return `<span class="msg-av bee" style="${hexBG(n)}" aria-hidden="true"><img src="${beeImg(n)}" alt="" width="22" height="18"></span>`;
    },
    // The member's still bee as an image URL, for the mention graph's nodes.
    beeSrc(name) { return beeImg(name === (window.SwarmHive.leadName || 'coordinator') ? 'coordinator' : String(name || '?')); },
    // Draw the hive map into `el`; `opts.seq` steps back to that board post (null: live).
    map(snap, el, opts) { hiveMap(snap, el, opts); },
    // Render the swarm into `el` as `opts.view` ('overview' | 'cards').
    update(snap, el, opts) {
      if (!snap || !el) return;
      const view = (opts && opts.view) || 'overview';
      window.SwarmHive.embedded = true;
      let r = ROOTS.get(el);
      if (!r || !r.root.isConnected || r.root.parentNode !== el) {
        el.innerHTML = '';
        const root = document.createElement('div');
        root.className = 'pane embedded';
        el.appendChild(root);
        RO.observe(root);
        r = {root, view};
        ROOTS.set(el, r);
      }
      if (snap.id !== S.swarm) {   // another swarm: drop filters, selections and open sections
        closeReel();
        for (const k of Object.keys(state)) delete state[k];
        state.view = 'overview';
        S.swarm = snap.id;
        ROOTS.forEach((x) => { x.etag = ''; });
      }
      const sk = snapKey(snap);
      if (r.etag && r.etag === sk && r.view === view) return;   // unchanged: keep animations running
      r.view = view;
      const tab = el.closest('.tab-body');
      if (tab && !tab.classList.contains('active')) return;   // hidden: render when its tab opens
      try {
        if (S.etag !== sk) { S.live = toModel(snap); S.etag = sk; }
        r.etag = sk;
        render(r.root, view);
      } catch (e) { console.warn('SwarmHive', e); }
    },
  });
})();
