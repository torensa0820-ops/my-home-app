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
// ・ドラッグ中は指の位置を tabSticky で変換して置く（タブの上で少し引っかかる）
// ・指を離したときやタップしたときは、ばねで行き先へ寄せる（はじいた勢いを引き継ぎ、少し行き過ぎてから戻る）
// ・形は動く速さに合わせて横に伸びて縦に縮み、タブの間では少し伸びる。形もばねで追うので、止まるとぷにっと縮んでから戻る
// ・押している間は少し膨らむ
// 「視差効果を減らす」がオンなら、伸び縮みとばねは使わずにすぐ置く
const THUMB_STICK = 0.85;                          // タブの上での引っかかりの強さ（0＝なし 〜 1＝タブの真上で一瞬止まる）
const THUMB_SPRING = {freq:2.4, damping:0.62};     // 行き先へ寄せるばね（1秒に揺れる回数と減衰。減衰が 1 未満だと少し行き過ぎる）
const THUMB_SHAPE_SPRING = {freq:4, damping:0.35}; // 形のばね（減衰を小さくして、ぷるっと揺らす）
const THUMB_STRETCH = 0.00018;                     // 動く速さ（px/秒）に対する横の伸び
const THUMB_STRETCH_MAX = 0.35;                    // 速さによる横の伸びの上限
const THUMB_BRIDGE = 0.12;                         // タブの間にいるときの横の伸び
const THUMB_SQUASH = 0.5;                          // 横に伸びた分に対して縦に縮む割合
const THUMB_LIFT = 1.08;                           // 押している間の大きさ
// to：ばねの行き先（null なら follow に置く／止まっている）、follow：ドラッグ中に置く位置
// onMove(pos)：ばねで動いている間、毎フレーム呼ぶ。onSettle()：行き先で止まったら呼ぶ
const thumb = {pos:TAB_ORDER.indexOf(activeTab()), vel:0, to:null, follow:null, held:false, shape:0, shapeVel:0, lift:1, frame:0, last:0, onMove:null, onSettle:null};

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
  if(thumb.follow !== null){
    // 指について動く速さは、フレームごとのばらつきをならして使う
    if(dt) thumb.vel += ((thumb.follow - thumb.pos) / dt - thumb.vel) * 0.5;
    thumb.pos = thumb.follow;
  } else if(thumb.to !== null){
    for(let t = dt; t > 0; t -= 0.004) [thumb.pos, thumb.vel] = springStep(thumb.pos, thumb.vel, thumb.to, THUMB_SPRING, Math.min(t, 0.004));
  }
  const moving = thumb.follow !== null || thumb.to !== null;
  const f = thumb.pos - Math.floor(thumb.pos);
  const stretch = Math.min(THUMB_STRETCH_MAX, Math.abs(thumb.vel) * tabPitch() * THUMB_STRETCH) + (moving ? THUMB_BRIDGE * Math.sin(Math.PI * f) : 0);
  for(let t = dt; t > 0; t -= 0.004) [thumb.shape, thumb.shapeVel] = springStep(thumb.shape, thumb.shapeVel, stretch, THUMB_SHAPE_SPRING, Math.min(t, 0.004));
  const lift = thumb.held ? THUMB_LIFT : 1;
  thumb.lift += (lift - thumb.lift) * (1 - Math.exp(-dt * 18));
  if(thumb.to !== null && Math.abs(thumb.pos - thumb.to) < 0.002 && Math.abs(thumb.vel) < 0.02){
    thumb.pos = thumb.to;
    thumb.vel = 0;
    thumb.to = null;
  }
  renderThumb();
  if(thumb.onMove) thumb.onMove(thumb.pos);
  if(thumb.to === null && thumb.onSettle){ const done = thumb.onSettle; thumb.onSettle = null; done(); }
  const still = thumb.follow === null && thumb.to === null && Math.abs(thumb.shape) < 0.002 && Math.abs(thumb.shapeVel) < 0.02 && Math.abs(lift - thumb.lift) < 0.002;
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
    if(thumb.follow !== null) thumb.pos = thumb.follow;
    if(thumb.to !== null) thumb.pos = thumb.to;
    thumb.to = null;
    thumb.vel = thumb.shape = thumb.shapeVel = 0;
    thumb.lift = 1;
    renderThumb();
    if(thumb.onMove) thumb.onMove(thumb.pos);
    if(thumb.follow === null && thumb.onSettle){ const done = thumb.onSettle; thumb.onSettle = null; done(); }
    return;
  }
  if(!thumb.frame) thumb.frame = requestAnimationFrame(thumbTick);
}
// 押している間は膨らませる
function holdThumb(on){
  thumb.held = on;
  runThumb();
}
// ドラッグ中、ハイライトを pos に置く
function followThumb(pos){
  thumb.follow = pos;
  thumb.to = null;
  thumb.onMove = thumb.onSettle = null;
  runThumb();
}
// ハイライトをばねで to のタブへ寄せる。vel は離したときの速さ（タブ/秒）
function springThumb(to, vel = 0, onMove = null, onSettle = null){
  thumb.follow = null;
  thumb.to = to;
  thumb.vel = vel;
  thumb.onMove = onMove;
  thumb.onSettle = onSettle;
  runThumb();
}
renderThumb();

// ---------- 触覚 ----------
// タブバーのドラッグで選ぶタブが変わったときに、軽く振動させる
// iPhone の Safari には navigator.vibrate がないので、iOS 18 からのスイッチ（<input type="checkbox" switch>）を
// 切り替えたときの振動を借りる（見えないラベルを click する。公式の機能ではないので、効かない版もある）
const hapticSwitch = (()=>{
  const input = h('input', {type:'checkbox', tabIndex:-1});
  input.setAttribute('switch', '');
  const label = h('label', {class:'haptic', 'aria-hidden':'true'}, input);
  document.body.append(label);
  return label;
})();
function haptic(){
  if(navigator.vibrate) navigator.vibrate(8);
  else hapticSwitch.click();
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
let tabDragged = false; // タブバーをドラッグしたあと（指を離したときの click を押したことにしない）
tabButtons.forEach(btn=>{
  btn.addEventListener('click', ()=>{
    if(tabDragged){ tabDragged = false; return; }
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

// ---------- タブバーのドラッグ ----------
// バーのどこからでも左右にドラッグすると、ハイライトが指について動き、タブのパネルと題名も同じだけ横に動く
// （ハイライトが隣のタブまで動くと、パネルは画面1枚分動く。タブの上で少し引っかかるのも、パネルと題名で同じ）
// 選ぶタブが変わるたびに軽く振動させる
// 指を離したら一番近いタブへばねで寄せて切り替える。はじいたときは、はじいた向きのタブに寄せる
const TAB_DRAG_START = 6;    // この距離横に動いたらドラッグにする（それまではタップ）
const TAB_DRAG_FLICK = 0.4;  // 指を離したとき、この速さ（px/ms）以上ではじいていれば、その向きのタブに寄せる
const TAB_DRAG_RUBBER = 0.2; // 端のタブより先へ動かしたときに、ハイライトが指についてくる割合
const TAB_DRAG_RUBBER_MAX = 0.12; // 端のタブより先へ出す上限（タブの間隔に対して）
let tabDrag = null; // {id, x0, x, t, v, moving, start, near, p, pitch, heads}

// p の位置に合わせて、パネルを並べる（p のタブが画面いっぱい。タブの間なら、その両隣を並べて見せる）
function placeTabPanels(p){
  TAB_ORDER.forEach((tab, i)=>{
    const el = tabPanel(tab);
    el.classList.toggle('tab-leaving', !el.classList.contains('active') && Math.abs(i - p) < 1);
    el.style.transition = 'none';
    el.style.transform = `translateX(${(i - p) * 100}%)`;
  });
}
// pos の位置に合わせてパネルと題名を動かす（lo〜hi の外には出さない。ばねで行き過ぎたハイライトに、パネルまではついていかない）
// heads：タブごとの題名。両隣のタブの題名を、右のタブを前面にして重ねる
function moveTabContent(heads, pos, lo = 0, hi = TAB_ORDER.length - 1){
  const p = Math.min(hi, Math.max(lo, pos));
  placeTabPanels(p);
  const i = Math.min(Math.floor(p), TAB_ORDER.length - 2);
  pageHead.track(heads[i + 1], heads[i], i + 1 - p);
}

tabbar.addEventListener('pointerdown', e=>{
  if(!e.isPrimary) return;
  tabDragged = false;
  tabDrag = {id:e.pointerId, x0:e.clientX, x:e.clientX, t:e.timeStamp, v:0, moving:false};
  holdThumb(true);
});
tabbar.addEventListener('pointermove', e=>{
  const d = tabDrag;
  if(!d || e.pointerId !== d.id) return;
  const dx = e.clientX - d.x0;
  if(!d.moving){
    if(Math.abs(dx) < TAB_DRAG_START) return;
    d.moving = true;
    tabDragged = true;
    try { tabbar.setPointerCapture(d.id); } catch(_){} // 指がバーの外に出てもドラッグを続ける
    if(tabSliding) tabSliding();
    leaveTab();
    d.start = d.near = TAB_ORDER.indexOf(activeTab());
    d.pitch = tabPitch();
    d.heads = TAB_ORDER.map((tab, i)=>i === d.start ? pageHead.current() : tabHeadText(tab));
  }
  const dt = e.timeStamp - d.t;
  if(dt > 0) d.v = (e.clientX - d.x) / dt;
  d.x = e.clientX;
  d.t = e.timeStamp;
  const raw = d.start + dx / d.pitch;
  d.p = Math.min(TAB_ORDER.length - 1, Math.max(0, raw));
  const over = raw - d.p; // 端のタブより先へ動かした分
  const pos = tabSticky(d.p);
  followThumb(pos + Math.sign(over) * Math.min(TAB_DRAG_RUBBER_MAX, Math.abs(over) * TAB_DRAG_RUBBER));
  moveTabContent(d.heads, pos);
  const near = Math.round(d.p);
  if(near !== d.near){
    d.near = near;
    tabbar.dataset.active = TAB_ORDER[near];
    haptic();
  }
});
// 指を離したら近いタブへばねで寄せる。cancel（指が取り消されたとき）なら、ドラッグを始めたタブに戻す
// 指がバーの外で離れることもあるので、window で受ける
function endTabDrag(e, cancel){
  const d = tabDrag;
  if(!d || e.pointerId !== d.id) return;
  tabDrag = null;
  holdThumb(false);
  if(!d.moving) return;
  const v = e.timeStamp - d.t > 100 ? 0 : d.v; // 止めてから離したときは、はじいたことにしない
  let to = Math.round(d.p);
  if(cancel) to = d.start;
  else if(Math.abs(v) >= TAB_DRAG_FLICK) to = v > 0 ? Math.ceil(d.p) : Math.floor(d.p);
  markTab(TAB_ORDER[to]);
  TAB_ORDER.forEach((tab, i)=>tabPanel(tab).classList.toggle('active', i === to));
  // 止まるまで、パネルと題名は行き先との間だけを動かす。止まったら（ほかの切り替えが始まったときも）transform を外す
  const from = tabSticky(d.p);
  const lo = Math.min(from, to), hi = Math.max(from, to);
  const finish = ()=>{
    tabSliding = null;
    thumb.onMove = thumb.onSettle = null;
    TAB_ORDER.forEach(tab=>{
      const el = tabPanel(tab);
      el.classList.remove('tab-leaving');
      el.style.transition = el.style.transform = '';
    });
    pageHead.set(...d.heads[to]);
  };
  tabSliding = finish;
  springThumb(to, cancel ? 0 : v * 1000 / d.pitch, pos=>moveTabContent(d.heads, pos, lo, hi), finish);
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
