// 画面を積む部品：前面の画面を右から入れ（push）、戻すときは右へ出す（pop）。画面の左端から右へのスワイプでも戻る
// 前面の画面は指について動き、後ろの画面は少し左から元の位置へ寄ってきて、上にかかった影が薄くなる（iPhone の「戻る」と同じ見え方）
// 動きは transform だけで行う。iPhone の「視差効果を減らす」がオンなら動かさずに切り替える（js/motion.js）

const NAV_EDGE = 24;           // スワイプを始められる、画面の左端からの幅（px）
const NAV_LOCK = 10;           // この距離動いたところで、横のスワイプか縦のスクロールかを決める（px）
const NAV_BACK_SHIFT = 0.3;    // 後ろの画面を左にずらす割合（画面幅に対して）
const NAV_DONE_RATIO = 0.4;    // 指を離したとき、この割合以上動かしていれば戻る
const NAV_FLICK = 0.5;         // 指を離したとき、この速さ（px/ms）以上で右へはじいていれば戻る

// container：画面を積む要素。root：一番下の画面（container の中に入れる）
// opts.onProgress(p)：スワイプ中・動きの途中に呼ぶ（p は 0＝前面の画面だけ見えている 〜 1＝後ろの画面に戻った）
// opts.onPop()：前面の画面を閉じ終わったときに呼ぶ
function createNavStack(container, root, opts = {}){
  const shade = h('div', {class:'nav-shade'});
  const pages = [root];
  let busy = false; // 動きの途中・スワイプ中（この間は画面を描き直さない）
  let idle = [];    // 動きが終わったら呼ぶ関数
  container.classList.add('nav-stack');
  root.classList.add('nav-page');
  container.append(root);

  const width = ()=>container.getBoundingClientRect().width || 1;
  // p（0〜1）の位置に前面と後ろの画面を置く。animate なら transition で動かし、終わったら resolve する
  function place(p, animate, ms = MOTION_MS){
    const front = pages[pages.length - 1], back = pages[pages.length - 2];
    const els = [front, back, shade];
    const dur = animate ? motionMs(ms) : 0;
    els.forEach(el=>{ el.style.transition = motionTransition(dur); });
    front.style.transform = `translateX(${p * 100}%)`;
    back.style.transform = `translateX(${-NAV_BACK_SHIFT * (1 - p) * 100}%)`;
    shade.style.opacity = String(1 - p);
    if(opts.onProgress) opts.onProgress(p, dur);
    return new Promise(resolve=>setTimeout(resolve, dur));
  }
  function finish(){
    busy = false;
    const fns = idle;
    idle = [];
    fns.forEach(fn=>fn());
  }

  // 前面に画面を足す
  async function push(page){
    if(busy) return;
    busy = true;
    const back = pages[pages.length - 1];
    page.classList.add('nav-page', 'nav-front');
    pages.push(page);
    back.after(shade, page);
    container.classList.add('nav-open');
    await place(1, false);
    void page.offsetWidth; // 置いた位置を確定させてから動かす
    await place(0, true);
    finish();
  }
  // 前面の画面を閉じる（「戻る」ボタンなど）
  function pop(){
    if(busy || pages.length < 2) return Promise.resolve();
    busy = true;
    return close(0, MOTION_MS);
  }
  // from：動き始めの位置（スワイプの途中から閉じるときは指を離した位置）
  async function close(from, ms){
    if(from === 0) await place(0, false);
    await place(1, true, ms);
    const page = pages.pop();
    page.remove();
    shade.remove();
    const back = pages[pages.length - 1];
    back.style.transform = back.style.transition = '';
    container.classList.toggle('nav-open', pages.length > 1);
    if(opts.onPop) opts.onPop(page);
    finish();
  }

  // ---- 左端からのスワイプ ----
  // 縦のスクロールを邪魔しないよう、最初の NAV_LOCK px で横か縦かを決め、横のときだけ指について動かす
  let drag = null; // {x0, y0, x, t, v, locked}
  container.addEventListener('touchstart', e=>{
    if(busy || pages.length < 2 || e.touches.length !== 1) return;
    const t = e.touches[0];
    if(t.clientX - container.getBoundingClientRect().left > NAV_EDGE) return;
    drag = {x0:t.clientX, y0:t.clientY, x:t.clientX, t:e.timeStamp, v:0, locked:null};
  }, {passive:true});
  container.addEventListener('touchmove', e=>{
    if(!drag) return;
    const t = e.touches[0];
    const dx = t.clientX - drag.x0, dy = t.clientY - drag.y0;
    if(drag.locked === null){
      if(Math.abs(dx) < NAV_LOCK && Math.abs(dy) < NAV_LOCK) return;
      drag.locked = Math.abs(dx) > Math.abs(dy) && dx > 0;
      if(!drag.locked){ drag = null; return; }
      busy = true;
    }
    e.preventDefault(); // 横のスワイプ中は、画面のスクロールをさせない
    const dt = e.timeStamp - drag.t;
    if(dt > 0) drag.v = (t.clientX - drag.x) / dt;
    drag.x = t.clientX;
    drag.t = e.timeStamp;
    place(Math.min(1, Math.max(0, dx / width())), false);
  }, {passive:false});
  const end = ()=>{
    if(!drag) return;
    const d = drag;
    drag = null;
    if(!d.locked) return;
    const p = Math.min(1, Math.max(0, (d.x - d.x0) / width()));
    // 残りの距離に合わせて動きの長さを決める（短すぎると瞬間移動に見えるので下限を付ける）
    if(p >= NAV_DONE_RATIO || d.v >= NAV_FLICK) close(p, Math.max(120, MOTION_MS * (1 - p)));
    else place(0, true, Math.max(120, MOTION_MS * p)).then(finish);
  };
  container.addEventListener('touchend', end);
  container.addEventListener('touchcancel', end);

  return {
    push, pop,
    depth(){ return pages.length; },
    busy(){ return busy; },
    // 動きが終わってから fn を呼ぶ（動きの途中でなければすぐ呼ぶ）
    whenIdle(fn){ if(busy) idle.push(fn); else fn(); },
  };
}
