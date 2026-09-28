// 画面の部品：下から出るパネル（登録フォーム・絞り込み）、編集用のシート、長押しボタン

// ---------- 下から出るパネル（登録フォーム・タグの絞り込み） ----------
// 「＋ 登録」や「絞り込み」で開き、一覧の上に重ねて表示する。上端のつまみをドラッグして高さを変えられる
// body の data-compose に開いているパネルの種類（form / filter）を入れる
let composeHeight = null; // ドラッグで変えた高さ（px）。未設定なら表示領域の55%
function openPanelKind(){ return document.body.dataset.compose || ''; }
// 登録フォームが開いているか（一覧のタップでフォームに入力するかの判定に使う）
function isComposing(){ return openPanelKind() === 'form'; }
function activeCompose(){
  const kind = openPanelKind();
  return kind ? document.querySelector(`.tab-panel.active .compose[data-kind="${kind}"]`) : null;
}
function applyComposeHeight(){
  const root = document.documentElement.style;
  if(!openPanelKind()){ root.setProperty('--compose-pad', '0px'); return; }
  if(composeHeight) root.setProperty('--compose-h', composeHeight + 'px');
  // 一覧の最後まで見られるよう、パネルの高さ分だけ一覧の下に余白を足す
  const panel = activeCompose();
  if(panel) root.setProperty('--compose-pad', panel.getBoundingClientRect().height + 'px');
}
function openCompose(kind = 'form'){
  document.body.dataset.compose = kind;
  applyComposeHeight();
}
function closeCompose(){
  delete document.body.dataset.compose;
  applyComposeHeight();
}
document.querySelectorAll('.fab').forEach(b=>b.addEventListener('click', ()=>openCompose('form')));
document.querySelectorAll('.compose-close').forEach(b=>b.addEventListener('click', closeCompose));
// つまみだけでなく、タイトルと説明文の行（ヘッダー部分）全体をドラッグして高さを変えられるようにする
function enableComposeDrag(panel){
  const areas = panel.querySelectorAll('.compose-grip, .compose-head, .compose-hint');
  let startY = null, startH, pointerId;
  const onDown = e=>{
    if(e.target.closest('button')) return; // 「閉じる」ボタンはタップとして扱う
    startY = e.clientY;
    startH = panel.getBoundingClientRect().height;
    pointerId = e.pointerId;
    try { e.currentTarget.setPointerCapture(pointerId); } catch(_){} // 指が領域の外に出てもドラッグを続ける
  };
  const onMove = e=>{
    if(startY == null || e.pointerId !== pointerId) return;
    const navTop = document.querySelector('nav.tabbar').getBoundingClientRect().top;
    const max = navTop - 80; // ヘッダー付近までは広げられる
    composeHeight = Math.round(Math.min(max, Math.max(160, startH + (startY - e.clientY))));
    applyComposeHeight();
  };
  const onEnd = e=>{
    if(startY == null || e.pointerId !== pointerId) return;
    // 下まで引き下げたら閉じる
    if(startH + (startY - e.clientY) < 120){ composeHeight = null; document.documentElement.style.removeProperty('--compose-h'); closeCompose(); }
    startY = null;
  };
  areas.forEach(el=>{
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onEnd);
    el.addEventListener('pointercancel', onEnd);
  });
}
document.querySelectorAll('.compose').forEach(enableComposeDrag);
window.addEventListener('resize', applyComposeHeight);

// ---------- 長押しボタン ----------
const HOLD_MS = 1500;

// 長押しで実行するボタン（商品削除と同じ見た目）。onDone(reset) の reset で元に戻せる
function makeHoldButton(label, onDone){
  const span = h('span', {}, label);
  const btn = h('button', {type:'button', class:'hold-btn'}, h('div', {class:'fill'}), span);
  let timer;
  const reset = ()=>{ btn.disabled = false; btn.classList.remove('holding'); span.textContent = label; };
  const cancel = ()=>{ clearTimeout(timer); if(!btn.disabled) btn.classList.remove('holding'); };
  btn.addEventListener('pointerdown', e=>{
    if(btn.disabled) return;
    e.preventDefault();
    btn.classList.add('holding');
    timer = setTimeout(()=>{ btn.disabled = true; span.textContent = '処理中…'; onDone(reset); }, HOLD_MS);
  });
  ['pointerup','pointerleave','pointercancel'].forEach(ev=>btn.addEventListener(ev, cancel));
  btn.addEventListener('contextmenu', e=>e.preventDefault());
  return btn;
}

// ---------- 編集用のシート ----------
// タグ管理・商品の編集・家計簿の記録の編集・家事の編集で共通に使う、画面の大部分を覆うシート
// tm.sheet はどのデータの画面か（stock / finance / chore）。タグ管理と色分けに使う
// tm.busy の間（保存・削除の通信中）は閉じられないようにする
const tm = {sheet:null, stack:[], busy:false};
const tmBackdrop = document.getElementById('tm-backdrop');
const tmBody = document.getElementById('tm-body');
const tmFoot = document.getElementById('tm-foot');
const tmTitle = document.getElementById('tm-title');
const tmBack = document.getElementById('tm-back');

// シートを開いて最初の画面を表示する。view は画面を描く関数、args はその引数
function openSheet(sheet, view, ...args){
  tm.sheet = sheet;
  tm.stack = [];
  tmBackdrop.dataset.sheet = sheet;
  tmBackdrop.classList.add('show');
  tmShow(view, ...args);
}
function closeSheet(){
  if(tm.busy) return;
  tmBackdrop.classList.remove('show');
}
// 画面は「一覧 → タグ詳細 → 付与する行の選択」のように積み重ね、「戻る」で1つ前に戻る
function tmShow(view, ...args){ tm.stack.push([view, args]); tmRender(); }
function tmRender(){
  const [view, args] = tm.stack[tm.stack.length - 1];
  tmBody.innerHTML = '';
  tmFoot.innerHTML = '';
  tmBody.scrollTop = 0;
  tmBack.style.visibility = tm.stack.length > 1 ? 'visible' : 'hidden';
  view(...args);
}
tmBack.addEventListener('click', ()=>{ if(!tm.busy && tm.stack.length > 1){ tm.stack.pop(); tmRender(); } });
document.getElementById('tm-close').addEventListener('click', closeSheet);
tmBackdrop.addEventListener('click', e=>{ if(e.target === tmBackdrop) closeSheet(); });
