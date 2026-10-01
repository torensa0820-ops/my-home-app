// 家計簿のグラフ：選んだ月の合計・前月との差・1日あたり、月別の支出（カテゴリ別の積み上げ）、
// 選んだ月のカテゴリ別・支払い方法別の内訳、月別の表
// 手元の全記録（fin.all）と一覧の絞り込み（financeFilter）から描くので、通信しない

// カテゴリの色。支出の多い順に上位5カテゴリへ割り当て、6つ目以降は「その他」にまとめる
// （アプリの面の色 #343941 に対して、色覚の違いでも隣どうし（「その他」を含む）が見分けられ、
// 面とのコントラストが 3:1 以上あることを検証済み）
const FC_COLORS = ['#3987e5', '#dd5d2a', '#199e70', '#c98500', '#d95484'];
const FC_OTHER = '#A3ABB5';
const FC_OTHER_NAME = 'その他';
const FC_MONTHS = 12; // 月別のグラフに出す月数（最大）
const fc = {view:'list', month:null};

// ---------- 履歴とグラフの切り替え ----------
document.querySelectorAll('#finance-view button').forEach(b=>b.addEventListener('click', ()=>{
  fc.view = b.dataset.view;
  document.querySelectorAll('#finance-view button').forEach(x=>x.classList.toggle('on', x === b));
  document.getElementById('finance-list').hidden = fc.view !== 'list';
  document.getElementById('finance-chart').hidden = fc.view !== 'chart';
  renderFinanceChart();
}));
let fcResizeTimer = null;
window.addEventListener('resize', ()=>{ clearTimeout(fcResizeTimer); fcResizeTimer = setTimeout(renderFinanceChart, 150); });

// ---------- 集計 ----------
const fcYen = v=>`¥${Math.round(v).toLocaleString()}`;
function fcMonthLabel(key){ const [y, m] = key.split('-'); return `${y}年${Number(m)}月`; }
function fcAddMonths(key, n){
  const [y, m] = key.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return finMonthKey(d);
}
// カテゴリの色の割り当て。絞り込みで色が変わらないよう、絞り込む前の全記録の合計で順位を決める
function fcColorMap(){
  const totals = {};
  fin.all.forEach(r=>{ const c = String(r.category || '').trim() || '—'; totals[c] = (totals[c] || 0) + (Number(r.amount) || 0); });
  const ranked = Object.keys(totals).sort((a, b)=>totals[b] - totals[a]);
  const map = {};
  ranked.forEach((c, i)=>{ map[c] = i < FC_COLORS.length ? {group:c, color:FC_COLORS[i], rank:i} : {group:FC_OTHER_NAME, color:FC_OTHER, rank:FC_COLORS.length}; });
  return map;
}
// 月ごと・グループ（上位カテゴリか「その他」）ごとの合計
function fcAggregate(rows, colors){
  const months = {};
  rows.forEach(r=>{
    const key = finMonthKey(finDay(r));
    const c = colors[String(r.category || '').trim() || '—'];
    const m = months[key] || (months[key] = {total:0, groups:{}, cats:{}, pays:{}, count:0});
    const amount = Number(r.amount) || 0;
    m.total += amount;
    m.count++;
    m.groups[c.group] = (m.groups[c.group] || 0) + amount;
    const cat = String(r.category || '').trim() || '—';
    m.cats[cat] = (m.cats[cat] || 0) + amount;
    const pay = String(r.payment || '').trim() || '未設定';
    m.pays[pay] = (m.pays[pay] || 0) + amount;
  });
  return months;
}
// 目盛りのきりのよい間隔（1・2・2.5・5 × 10のn乗）
function fcNiceStep(v){
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  return [1, 2, 2.5, 5, 10].map(s=>s * p).find(s=>s >= v);
}
function fcAxisLabel(v){ return v >= 10000 ? `${+(v / 10000).toFixed(1)}万` : v.toLocaleString(); }

// ---------- 描画 ----------
function renderFinanceChart(){
  const wrap = document.getElementById('finance-chart');
  if(fc.view !== 'chart') return;
  if(!fin.loaded){ wrap.replaceChildren(h('p', {class:'empty-msg'}, '読み込み中…')); return; }
  const rows = fin.shown;
  if(!rows.length){ wrap.replaceChildren(h('p', {class:'empty-msg'}, financeFilter.active() ? '該当する記録がありません' : 'まだ記録がありません')); return; }

  const colors = fcColorMap();
  const agg = fcAggregate(rows, colors);
  // 表示する月：記録のある最初の月〜今月（記録が未来の日付ならその月）まで。最大12か月
  const keys = Object.keys(agg).sort();
  const today = finMonthKey(new Date());
  const last = keys[keys.length - 1] > today ? keys[keys.length - 1] : today;
  let first = keys[0];
  if(first < fcAddMonths(last, -(FC_MONTHS - 1))) first = fcAddMonths(last, -(FC_MONTHS - 1));
  const months = [];
  for(let k = first; k <= last; k = fcAddMonths(k, 1)) months.push(k);
  if(!months.includes(fc.month)) fc.month = last;

  // 凡例は表示している月に出てくるグループだけ（上位の順、「その他」は最後）
  const groupColor = {};
  Object.values(colors).forEach(c=>{ groupColor[c.group] = c; });
  const groups = Object.keys(groupColor)
    .filter(g=>months.some(k=>agg[k] && agg[k].groups[g]))
    .sort((a, b)=>groupColor[a].rank - groupColor[b].rank);

  wrap.replaceChildren(
    fcSummary(agg, fc.month),
    h('div', {class:'fc-card'},
      h('div', {class:'fc-title'}, '月別の支出'),
      h('div', {class:'fc-hint'}, '棒をタップすると、その月の内訳を表示します'),
      h('div', {class:'fc-legend'}, groups.map(g=>h('span', {class:'fc-key'}, h('i', {style:`background:${groupColor[g].color}`}), g))),
      fcColumns(wrap, months, agg, groups, groupColor)),
    fcBreakdown(`${fcMonthLabel(fc.month)}のカテゴリ別`, agg[fc.month] && agg[fc.month].cats,
      cat=>(colors[cat] || {}).color || FC_OTHER),
    fcBreakdown(`${fcMonthLabel(fc.month)}の支払い方法別`, agg[fc.month] && agg[fc.month].pays, ()=>'var(--muted)'),
    fcTable(months, agg));
}

// 選んだ月の合計・前月との差・1日あたり
function fcSummary(agg, key){
  const m = agg[key] || {total:0, count:0};
  const prev = (agg[fcAddMonths(key, -1)] || {total:0}).total;
  const [y, mo] = key.split('-').map(Number);
  const now = new Date();
  const isThisMonth = key === finMonthKey(now);
  const days = isThisMonth ? now.getDate() : new Date(y, mo, 0).getDate();
  const diff = m.total - prev;
  let delta;
  if(!prev) delta = h('div', {class:'fc-stat-sub'}, '前月の記録なし');
  else {
    const pct = Math.round(diff / prev * 100);
    delta = h('div', {class:'fc-stat-sub ' + (diff > 0 ? 'up' : diff < 0 ? 'down' : '')},
      diff === 0 ? '前月と同じ' : `${diff > 0 ? '▲' : '▼'} ${fcYen(Math.abs(diff))}（${diff > 0 ? '+' : '−'}${Math.abs(pct)}%）`);
  }
  return h('div', {class:'fc-stats'},
    h('div', {class:'fc-stat fc-stat-main'},
      h('div', {class:'fc-stat-label'}, `${fcMonthLabel(key)}の支出${isThisMonth ? '（今日まで）' : ''}`),
      h('div', {class:'fc-stat-value big'}, fcYen(m.total)),
      h('div', {class:'fc-stat-sub'}, `${m.count}件`)),
    h('div', {class:'fc-stat'},
      h('div', {class:'fc-stat-label'}, '前月との差'),
      h('div', {class:'fc-stat-value'}, prev ? `${diff >= 0 ? '+' : '−'}${fcYen(Math.abs(diff))}` : '—'),
      delta),
    h('div', {class:'fc-stat'},
      h('div', {class:'fc-stat-label'}, '1日あたり'),
      h('div', {class:'fc-stat-value'}, fcYen(m.total / days)),
      h('div', {class:'fc-stat-sub'}, `${days}日で計算`)));
}

// 月別の積み上げ縦棒グラフ（SVG）
function fcColumns(wrap, months, agg, groups, groupColor){
  const NS = 'http://www.w3.org/2000/svg';
  const s = (tag, attrs = {})=>{ const el = document.createElementNS(NS, tag); Object.entries(attrs).forEach(([k, v])=>el.setAttribute(k, v)); return el; };
  const W = Math.max(280, (wrap.clientWidth || 340) - 32); // カードの内側の幅
  const H = 200, top = 22, bottom = 26, left = 40, right = 4;
  const plotW = W - left - right, plotH = H - top - bottom;
  const max = Math.max(...months.map(k=>(agg[k] || {total:0}).total), 1);
  const step = fcNiceStep(max / 4);
  const yMax = step * Math.ceil(max / step);
  const y = v=>top + plotH - v / yMax * plotH;
  const band = plotW / months.length;
  const barW = Math.min(24, band * 0.6);

  const svg = s('svg', {viewBox:`0 0 ${W} ${H}`, width:W, height:H, class:'fc-svg', role:'img', 'aria-label':'月別の支出の棒グラフ'});
  // 目盛りと横線（細く、目立たせない）
  for(let v = 0; v <= yMax + 0.5; v += step){
    svg.append(s('line', {x1:left, x2:W - right, y1:y(v), y2:y(v), class: v === 0 ? 'fc-base' : 'fc-grid'}));
    const t = s('text', {x:left - 6, y:y(v) + 4, 'text-anchor':'end', class:'fc-tick'});
    t.textContent = fcAxisLabel(v);
    svg.append(t);
  }
  const tip = h('div', {class:'fc-tip', hidden:true});
  months.forEach((k, i)=>{
    const m = agg[k];
    const cx = left + band * i + band / 2;
    const selected = k === fc.month;
    const g = s('g', {class:'fc-col' + (selected ? ' on' : ''), tabindex:0, role:'button', 'aria-label':`${fcMonthLabel(k)} ${fcYen(m ? m.total : 0)}`});
    // 選んだ月は背景に薄い帯を敷く。帯は当たり判定も兼ねる（棒より大きく）
    g.append(s('rect', {x:cx - band / 2 + 1, y:top - 18, width:band - 2, height:plotH + 18, rx:6, class:'fc-hit'}));
    if(m){
      // 下から上位カテゴリの順に積む。セグメントの間は2pxあけ、いちばん上だけ角を丸める
      let base = 0;
      const segs = groups.filter(gr=>m.groups[gr]);
      segs.forEach((gr, j)=>{
        const v = m.groups[gr];
        const y0 = y(base), y1 = y(base + v);
        const gap = j > 0 ? 2 : 0;
        const hgt = Math.max(0, y0 - y1 - gap);
        if(hgt > 0){
          const isTop = j === segs.length - 1;
          const r = isTop ? Math.min(4, hgt, barW / 2) : 0;
          const x0 = cx - barW / 2, x1 = cx + barW / 2, yb = y0 - gap, yt = yb - hgt;
          g.append(s('path', {fill:groupColor[gr].color, d:`M${x0},${yb} V${yt + r} Q${x0},${yt} ${x0 + r},${yt} H${x1 - r} Q${x1},${yt} ${x1},${yt + r} V${yb} Z`}));
        }
        base += v;
      });
      // 合計の数字は選んだ月だけに出す
      if(selected){
        const t = s('text', {x:cx, y:y(m.total) - 6, 'text-anchor':'middle', class:'fc-val'});
        t.textContent = fcAxisLabel(Math.round(m.total));
        g.append(t);
      }
    }
    const [yy, mm] = k.split('-').map(Number);
    // 月のラベル。1月と最初の月には年も出す。幅が足りないときは1つおきにする（選んだ月は必ず出す）
    if(selected || band >= 40 || (months.length - 1 - i) % 2 === 0){
      const t = s('text', {x:cx, y:H - 8, 'text-anchor':'middle', class:'fc-month' + (selected ? ' on' : '')});
      t.textContent = (i === 0 || mm === 1) && months.length > 1 ? `${String(yy).slice(2)}/${mm}月` : `${mm}月`;
      g.append(t);
    }
    const select = ()=>{ fc.month = k; renderFinanceChart(); };
    g.addEventListener('click', select);
    g.addEventListener('keydown', e=>{ if(e.key === 'Enter' || e.key === ' '){ e.preventDefault(); select(); } });
    const show = ()=>{
      tip.replaceChildren(
        h('div', {class:'fc-tip-head'}, h('b', {}, fcYen(m ? m.total : 0)), ` ${fcMonthLabel(k)}`),
        ...(m ? groups.filter(gr=>m.groups[gr]).reverse().map(gr=>h('div', {class:'fc-tip-row'},
          h('i', {style:`background:${groupColor[gr].color}`}), h('b', {}, fcYen(m.groups[gr])), ` ${gr}`)) : []));
      tip.hidden = false;
      const tw = tip.offsetWidth;
      tip.style.left = `${Math.min(Math.max(cx - tw / 2, 0), W - tw)}px`;
    };
    g.addEventListener('pointerenter', e=>{ if(e.pointerType === 'mouse') show(); });
    g.addEventListener('focus', show);
    g.addEventListener('pointerleave', ()=>{ tip.hidden = true; });
    g.addEventListener('blur', ()=>{ tip.hidden = true; });
    svg.append(g);
  });
  return h('div', {class:'fc-plot'}, svg, tip);
}

// 内訳（金額の多い順の横棒）。値と割合は常に文字でも出す
function fcBreakdown(title, map, colorOf){
  const card = h('div', {class:'fc-card'}, h('div', {class:'fc-title'}, title));
  const entries = Object.entries(map || {}).sort((a, b)=>b[1] - a[1]);
  if(!entries.length){ card.append(h('p', {class:'tm-note'}, 'この月の記録はありません')); return card; }
  const total = entries.reduce((sum, [, v])=>sum + v, 0);
  const max = entries[0][1];
  entries.forEach(([name, v])=>card.append(h('div', {class:'fc-bar-row'},
    h('div', {class:'fc-bar-head'},
      h('span', {class:'fc-bar-name'}, h('i', {style:`background:${colorOf(name)}`}), name),
      h('span', {class:'fc-bar-val'}, h('b', {}, fcYen(v)), ` ${Math.round(v / total * 100)}%`)),
    h('div', {class:'fc-bar-track'}, h('div', {class:'fc-bar-fill', style:`width:${Math.max(v / max * 100, 1)}%;background:${colorOf(name)}`})))));
  return card;
}

// 月別の表（グラフの値を文字で確かめる用）
function fcTable(months, agg){
  return h('details', {class:'fc-table'},
    h('summary', {}, '月別の表で見る'),
    h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, '月'), h('th', {}, '件数'), h('th', {}, '合計'))),
      h('tbody', {}, months.slice().reverse().map(k=>h('tr', {},
        h('td', {}, fcMonthLabel(k)),
        h('td', {}, `${agg[k] ? agg[k].count : 0}件`),
        h('td', {}, fcYen(agg[k] ? agg[k].total : 0)))))));
}
