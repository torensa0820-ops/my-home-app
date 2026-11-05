// 起動：タブ切り替え、最新版の読み込み、各タブのデータ読み込み

// ---------- タブ切り替え ----------
const TAB_INFO = {
  stock:{title:'在庫管理', sub:'商品名をタップで編集・＋−で数量を更新'},
  coupon:{title:'クーポン', sub:'使ったら「使った」・不要なら「不要」'},
  todo:TODO_INFO
};
// タブの画面は、タブバーと同じ並びで横に並んでいるものとして動かす（右のタブを押したら右から入る）
const tabbar = document.querySelector('nav.tabbar');
const tabButtons = [...tabbar.querySelectorAll('button')];
const tabThumb = tabbar.querySelector('.tab-thumb');
const TAB_ORDER = tabButtons.map(b=>b.dataset.tab);
const tabPanel = tab=>document.getElementById(tab + '-panel');
const activeTab = ()=>tabbar.querySelector('button.active').dataset.tab;
// タブの題名と説明。やることタブはリストを開いたままならリストの題名
function tabHeadText(tab){
  if(tab === 'todo') return todoHeaderText(todo.listId ? todoListOf(todo.listId) : null);
  return [TAB_INFO[tab].title, TAB_INFO[tab].sub];
}
let tabSliding = null; // 動いている途中のタブの切り替えを、最後の位置まで送って終わらせる関数
// from のパネルを出し、to のパネルを dir の側（1＝右、-1＝左）から入れる
function slideTabPanels(from, to, dir){
  if(tabSliding) tabSliding();
  from.classList.remove('active');
  to.classList.add('active');
  const ms = motionMs();
  if(!ms) return;
  const els = [from, to];
  from.classList.add('tab-leaving');
  els.forEach(el=>{ el.style.transition = 'none'; });
  from.style.transform = 'translateX(0)';
  to.style.transform = `translateX(${dir * 100}%)`;
  void to.offsetWidth; // 置いた位置を確定させてから動かす
  els.forEach(el=>{ el.style.transition = motionTransition(ms); });
  from.style.transform = `translateX(${-dir * 100}%)`;
  to.style.transform = 'translateX(0)';
  // 動き終わったら transform を外す（付けたままだと、パネルの中の position:fixed の位置がずれる）
  const done = ()=>{
    clearTimeout(timer);
    tabSliding = null;
    from.classList.remove('tab-leaving');
    els.forEach(el=>{ el.style.transition = el.style.transform = ''; });
  };
  const timer = setTimeout(done, ms);
  tabSliding = done;
}
// ---------- タブバーのハイライト（水滴の動き） ----------
// ハイライトの位置 pos（0＝左端のタブ 〜 TAB_ORDER.length - 1＝右端のタブ。途中の値ならタブの間）を毎フレーム計算して動かす
// ・押している間は、指の位置を tabSticky で変換した位置をばねで追う（タブの上で少し引っかかる）
// ・指を離したときやタップしたときは、ばねで行き先へ寄せる（勢いを引き継ぎ、少し行き過ぎてから戻る）
// ・形は動く速さに合わせて横に伸びて縦に縮み、タブの間では少し伸びる。形もばねで追うので、止まるとぷにっと縮んでから戻る
// ・押している間は少し膨らむ
// 「視差効果を減らす」がオンなら、伸び縮みとばねは使わずにすぐ置く
const THUMB_STICK = 0.85;                          // タブの上での引っかかりの強さ（0＝なし 〜 1＝タブの真上で一瞬止まる）
const THUMB_CHASE = {freq:6, damping:0.9};         // 押している間、指の位置を追うばね（1秒に揺れる回数と減衰。速く追い、ほとんど行き過ぎない）
const THUMB_SPRING = {freq:2.4, damping:0.62};     // 行き先へ寄せるばね（減衰が 1 未満だと少し行き過ぎる）
const THUMB_SHAPE_SPRING = {freq:4, damping:0.35}; // 形のばね（減衰を小さくして、ぷるっと揺らす）
const THUMB_STRETCH = 0.00018;                     // 動く速さ（px/秒）に対する横の伸び
const THUMB_STRETCH_MAX = 0.35;                    // 速さによる横の伸びの上限
const THUMB_BRIDGE = 0.12;                         // タブの間にいるときの横の伸び
const THUMB_SQUASH = 0.5;                          // 横に伸びた分に対して縦に縮む割合
const THUMB_LIFT = 1.08;                           // 押している間の大きさ
// to：ばねの行き先（null なら止まっている）。chase なら指を追うばね、そうでなければ寄せるばね
// onMove(pos)：動いている間、毎フレーム呼ぶ。onSettle()：寄せるばねが行き先で止まったら呼ぶ
const thumb = {pos:TAB_ORDER.indexOf(activeTab()), vel:0, to:null, chase:false, held:false, shape:0, shapeVel:0, lift:1, frame:0, last:0, onMove:null, onSettle:null};

// 指の位置 p をハイライトの位置にする（タブの上では動きが鈍く、タブの間では速い。k が 1 以下なら向きは逆にならない）
function tabSticky(p){
  const i = Math.floor(p), f = p - i;
  return i + f - THUMB_STICK * Math.sin(2 * Math.PI * f) / (2 * Math.PI);
}
// 隣のタブまでの距離（px）
const tabPitch = ()=>tabButtons[1].offsetLeft - tabButtons[0].offsetLeft || 1;
// ばねで x を target に dt 秒だけ近づける（[x, v] を返す）
function springStep(x, v, target, {freq, damping}, dt){
  const w = 2 * Math.PI * freq;
  v += (-w * w * (x - target) - 2 * damping * w * v) * dt;
  return [x + v * dt, v];
}
function renderThumb(){
  const sx = thumb.lift * (1 + thumb.shape), sy = thumb.lift * (1 - thumb.shape * THUMB_SQUASH);
  // 隣のタブまではハイライトの幅とボタンの間（4px）の分
  tabThumb.style.transform = `translateX(calc(${thumb.pos} * (100% + 4px))) scale(${sx}, ${sy})`;
}
function thumbTick(now){
  const dt = thumb.last ? Math.min(0.032, (now - thumb.last) / 1000) : 0;
  thumb.last = now;
  if(thumb.to !== null){
    const spring = thumb.chase ? THUMB_CHASE : THUMB_SPRING;
    for(let t = dt; t > 0; t -= 0.004) [thumb.pos, thumb.vel] = springStep(thumb.pos, thumb.vel, thumb.to, spring, Math.min(t, 0.004));
  }
  const f = thumb.pos - Math.floor(thumb.pos);
  const stretch = Math.min(THUMB_STRETCH_MAX, Math.abs(thumb.vel) * tabPitch() * THUMB_STRETCH) + (thumb.to !== null ? THUMB_BRIDGE * Math.sin(Math.PI * f) : 0);
  for(let t = dt; t > 0; t -= 0.004) [thumb.shape, thumb.shapeVel] = springStep(thumb.shape, thumb.shapeVel, stretch, THUMB_SHAPE_SPRING, Math.min(t, 0.004));
  const lift = thumb.held ? THUMB_LIFT : 1;
  thumb.lift += (lift - thumb.lift) * (1 - Math.exp(-dt * 18));
  if(!thumb.chase && thumb.to !== null && Math.abs(thumb.pos - thumb.to) < 0.002 && Math.abs(thumb.vel) < 0.02){
    thumb.pos = thumb.to;
    thumb.vel = 0;
    thumb.to = null;
  }
  renderThumb();
  if(thumb.onMove) thumb.onMove(thumb.pos);
  if(thumb.to === null && thumb.onSettle){ const done = thumb.onSettle; thumb.onSettle = null; done(); }
  const still = thumb.to === null && Math.abs(thumb.shape) < 0.002 && Math.abs(thumb.shapeVel) < 0.02 && Math.abs(lift - thumb.lift) < 0.002;
  if(still){
    thumb.frame = thumb.last = 0;
    thumb.shape = thumb.shapeVel = 0;
    thumb.lift = lift;
    renderThumb();
  } else thumb.frame = requestAnimationFrame(thumbTick);
}
function runThumb(){
  if(!motionMs()){
    // 動かさずに置く
    if(thumb.to !== null) thumb.pos = thumb.to;
    if(!thumb.chase) thumb.to = null;
    thumb.vel = thumb.shape = thumb.shapeVel = 0;
    thumb.lift = 1;
    renderThumb();
    if(thumb.onMove) thumb.onMove(thumb.pos);
    if(thumb.to === null && thumb.onSettle){ const done = thumb.onSettle; thumb.onSettle = null; done(); }
    return;
  }
  if(!thumb.frame) thumb.frame = requestAnimationFrame(thumbTick);
}
// 押している間は膨らませる
function holdThumb(on){
  thumb.held = on;
  runThumb();
}
// 押している間、ハイライトに pos を追わせる
function chaseThumb(pos, onMove = null){
  thumb.chase = true;
  thumb.to = pos;
  thumb.onMove = onMove;
  thumb.onSettle = null;
  runThumb();
}
// ハイライトをばねで to のタブへ寄せる（今の勢いのまま）
function springThumb(to, onMove = null, onSettle = null){
  thumb.chase = false;
  thumb.to = to;
  thumb.onMove = onMove;
  thumb.onSettle = onSettle;
  runThumb();
}
renderThumb();

// ---------- 触覚 ----------
// タブを切り替えたときに、軽く振動させる
// iPhone の Safari には navigator.vibrate がないので、iOS 18 からのスイッチ（<input type="checkbox" switch>）を
// 切り替えたときの振動を借りる（見えないラベルをその場で作って click する。公式の機能ではないので、効かない版もある）
// iPhone のスイッチは指を離したときなど、ユーザーの操作の中でしか振動しないので、指を動かしている途中には振動させない
const HAPTIC_WHILE_MOVING = typeof navigator.vibrate === 'function';
function haptic(){
  if(HAPTIC_WHILE_MOVING){ navigator.vibrate(8); return; }
  const input = h('input', {type:'checkbox'});
  input.setAttribute('switch', '');
  const label = h('label', {'aria-hidden':'true', style:'display:none'}, input);
  document.head.append(label);
  label.click();
  label.remove();
}

// ボタンとハイライトを tab の色にする
function markTab(tab){
  tabButtons.forEach(b=>b.classList.toggle('active', b.dataset.tab === tab));
  tabbar.dataset.active = tab;
}
// タブを離れる前に、整理モードと開いているパネルを閉じる
function leaveTab(){
  if(stockEditMode) setStockEditMode(false);
  closeComposeNow();
}
// タブバーを指で押したあと（切り替えは指を離したときにするので、そのあとの click は押したことにしない）
// click はキーボードで押したときのため
let tabPressed = false;
tabButtons.forEach(btn=>{
  btn.addEventListener('click', ()=>{
    if(tabPressed){ tabPressed = false; return; }
    const from = activeTab(), tab = btn.dataset.tab;
    const again = tab === from;
    leaveTab();
    if(!again){
      const dir = TAB_ORDER.indexOf(tab) > TAB_ORDER.indexOf(from) ? 1 : -1;
      const oldHead = pageHead.current(), newHead = tabHeadText(tab);
      markTab(tab);
      slideTabPanels(tabPanel(from), tabPanel(tab), dir);
      springThumb(TAB_ORDER.indexOf(tab));
      // 題名も同じ向きに動かす（前面＝右側の題名）
      if(dir > 0) pageHead.slide(newHead, oldHead, 1, 0);
      else pageHead.slide(oldHead, newHead, 0, 1);
    }
    if(tab === 'todo') todoTabShown(again);
  });
});

// ---------- タブバーを指で押す・ドラッグする ----------
// バーのどこを押しても、ハイライトが指の位置へ向かい、指を動かせばついてくる。タブのパネルと題名もハイライトと一緒に横に動く
// （ハイライトが隣のタブまで動くと、パネルは画面1枚分動く。タブの上で少し引っかかるのも、パネルと題名で同じ）
// 指を離したら一番近いタブへばねで寄せて切り替える。はじいたときは、はじいた向きのタブに寄せる
const TAB_DRAG_MOVED = 6;    // この距離横に動いたらドラッグにする（動かさずに離したら、そのタブを押したことにする）
const TAB_DRAG_FLICK = 0.4;  // 指を離したとき、この速さ（px/ms）以上ではじいていれば、その向きのタブに寄せる
const TAB_DRAG_RUBBER = 0.2; // 端のタブより先へ動かしたときに、ハイライトが指についてくる割合
const TAB_DRAG_RUBBER_MAX = 0.12; // 端のタブより先へ出す上限（タブの間隔に対して）
const TAB_CONTENT_DEAD = 0.1; // ハイライトがタブからこの分ずれるまでは、パネルと題名を動かさない（タブの端を押しただけで画面がずれないように）
let tabDrag = null; // {id, x0, x, t, v, moved, start, near, p, heads}

// 指の x 座標を、タブの番号の単位にする（0＝左端のタブの真ん中）
function fingerTab(x){
  const r = tabButtons[0].getBoundingClientRect();
  return (x - (r.left + r.width / 2)) / tabPitch();
}
// p の位置に合わせて、パネルを並べる（p のタブが画面いっぱい。タブの間なら、その両隣を並べて見せる）
function placeTabPanels(p){
  TAB_ORDER.forEach((tab, i)=>{
    const el = tabPanel(tab);
    el.classList.toggle('tab-leaving', !el.classList.contains('active') && Math.abs(i - p) < 1);
    el.style.transition = 'none';
    el.style.transform = `translateX(${(i - p) * 100}%)`;
  });
}
// ハイライトの位置 pos に合わせてパネルと題名を動かす（lo〜hi の外には出さない。ばねで行き過ぎたハイライトに、パネルまではついていかない）
// heads：タブごとの題名。両隣のタブの題名を、右のタブを前面にして重ねる
function moveTabContent(heads, pos, lo = 0, hi = TAB_ORDER.length - 1){
  const c = Math.min(hi, Math.max(lo, pos));
  const i = Math.min(Math.floor(c), TAB_ORDER.length - 2);
  const p = i + Math.min(1, Math.max(0, (c - i - TAB_CONTENT_DEAD) / (1 - 2 * TAB_CONTENT_DEAD)));
  placeTabPanels(p);
  pageHead.track(heads[i + 1], heads[i], i + 1 - p);
}
// ハイライトに指の位置 raw（タブの番号の単位）を追わせる
function chaseFinger(d, raw){
  d.p = Math.min(TAB_ORDER.length - 1, Math.max(0, raw));
  const over = raw - d.p; // 端のタブより先へ動かした分
  chaseThumb(tabSticky(d.p) + Math.sign(over) * Math.min(TAB_DRAG_RUBBER_MAX, Math.abs(over) * TAB_DRAG_RUBBER), pos=>moveTabContent(d.heads, pos));
  const near = Math.round(d.p);
  if(near !== d.near){
    d.near = near;
    tabbar.dataset.active = TAB_ORDER[near];
    if(HAPTIC_WHILE_MOVING) haptic();
  }
}

tabbar.addEventListener('pointerdown', e=>{
  if(!e.isPrimary) return;
  tabPressed = true;
  try { tabbar.setPointerCapture(e.pointerId); } catch(_){} // 指がバーの外に出ても追い続ける
  if(tabSliding) tabSliding();
  leaveTab();
  const start = TAB_ORDER.indexOf(activeTab());
  const heads = TAB_ORDER.map((tab, i)=>i === start ? pageHead.current() : tabHeadText(tab));
  tabDrag = {id:e.pointerId, x0:e.clientX, x:e.clientX, t:e.timeStamp, v:0, moved:false, start, near:start, heads};
  holdThumb(true);
  chaseFinger(tabDrag, fingerTab(e.clientX));
});
tabbar.addEventListener('pointermove', e=>{
  const d = tabDrag;
  if(!d || e.pointerId !== d.id) return;
  if(Math.abs(e.clientX - d.x0) >= TAB_DRAG_MOVED) d.moved = true;
  const dt = e.timeStamp - d.t;
  if(dt > 0) d.v = (e.clientX - d.x) / dt;
  d.x = e.clientX;
  d.t = e.timeStamp;
  chaseFinger(d, fingerTab(e.clientX));
});
// 指を離したら近いタブへばねで寄せる。cancel（指が取り消されたとき）なら、押し始めたときのタブに戻す
// 指がバーの外で離れることもあるので、window で受ける
function endTabDrag(e, cancel){
  const d = tabDrag;
  if(!d || e.pointerId !== d.id) return;
  tabDrag = null;
  holdThumb(false);
  const v = e.timeStamp - d.t > 100 ? 0 : d.v; // 止めてから離したときは、はじいたことにしない
  let to = Math.round(d.p);
  if(cancel) to = d.start;
  else if(d.moved && Math.abs(v) >= TAB_DRAG_FLICK) to = v > 0 ? Math.ceil(d.p) : Math.floor(d.p);
  const again = !cancel && !d.moved && to === d.start; // 選んでいるタブを押した
  if(to !== d.start) haptic();
  markTab(TAB_ORDER[to]);
  TAB_ORDER.forEach((tab, i)=>tabPanel(tab).classList.toggle('active', i === to));
  // 止まるまで、パネルと題名は行き先との間だけを動かす。止まったら（ほかの切り替えが始まったときも）transform を外す
  const from = Math.min(TAB_ORDER.length - 1, Math.max(0, thumb.pos));
  const lo = Math.min(from, to), hi = Math.max(from, to);
  const finish = ()=>{
    tabSliding = null;
    thumb.onMove = thumb.onSettle = null;
    TAB_ORDER.forEach(tab=>{
      const el = tabPanel(tab);
      el.classList.remove('tab-leaving');
      el.style.transition = el.style.transform = '';
    });
    pageHead.set(...tabHeadText(TAB_ORDER[to]));
  };
  if(again){
    // 画面はほとんど動いていないので、すぐ戻す（やることタブなら、開いているリストを閉じる動きに任せる）
    springThumb(to);
    finish();
    if(TAB_ORDER[to] === 'todo') todoTabShown(true);
    return;
  }
  tabSliding = finish;
  springThumb(to, pos=>moveTabContent(d.heads, pos, lo, hi), finish);
  if(to !== d.start && TAB_ORDER[to] === 'todo') todoTabShown(false);
}
window.addEventListener('pointerup', e=>endTabDrag(e, false));
window.addEventListener('pointercancel', e=>endTabDrag(e, true));

// 最新版の読み込み：ページと、ページが読み込んでいるスクリプト・CSSをキャッシュを使わずに取り直して
// キャッシュを上書きし、再読み込みする（GitHub Pages は10分間キャッシュされるため）
document.getElementById('reload-btn').addEventListener('click', e=>{
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.classList.add('spinning');
  const files = [...document.querySelectorAll('script[src], link[rel="stylesheet"]')].map(el=>el.src || el.href);
  Promise.all([location.href.split('#')[0], ...files].map(u=>fetch(u, {cache:'reload'})))
    .catch(()=>{})
    .finally(()=>location.reload());
});

// ---------- 初期化 ----------
// 起動時のデータは1回のリクエストでまとめて取得する（再試行しても失敗したら、各一覧に理由と再読み込みボタンを出す）
getFromGas('action=getAll')
  .then(all=>{
    loadStock(all.stock);
    loadStockImports(all.stockImports || {pending:[], auto:[]});
    loadCoupons(all.coupons || []);
    loadReminders(all.reminders);
  })
  .catch(err=>{
    document.getElementById('stock-list').replaceChildren(loadErrorView(err, ()=>{ reloadList('stock-list', loadStock); loadStockImports(); }));
    document.getElementById('coupons').replaceChildren(loadErrorView(err, ()=>reloadList('coupons', loadCoupons)));
    todoShowLoadError(err);
  });
