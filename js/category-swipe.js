// 左右のスワイプでカテゴリを切り替える部品（在庫・やることのカテゴリのタブ）
// 画面の左側に指を置いて右へ動かすと前のカテゴリ、右側に置いて左へ動かすと次のカテゴリにする（端のカテゴリから先へは進まない）
// 中身は指に少しだけついて動き、離したら js/motion.js の slideContent で入れ替える。届かなければ元の位置へ戻す
// 縦のスクロールを邪魔しないよう、最初の CAT_SWIPE_LOCK px で横か縦かを決め、はっきり横のときだけ指について動かす

const CAT_SWIPE_ZONE = 0.4;          // スワイプを始められる、左右それぞれの端からの幅（画面幅に対して。真ん中の残りからは始めない）
const CAT_SWIPE_LOCK = 10;           // この距離動いたところで、横のスワイプか縦のスクロールかを決める（px）
const CAT_SWIPE_SLOPE = 1.5;         // 横の動きが縦のこの倍以上のときだけ横のスワイプにする（斜めのスクロールを取り違えない）
const CAT_SWIPE_DONE = 0.25;         // 指を離したとき、この割合以上動かしていれば切り替える（画面幅に対して）
const CAT_SWIPE_FLICK = 0.5;         // 指を離したとき、この速さ（px/ms）以上ではじいていれば切り替える
const CAT_SWIPE_FOLLOW = 0.3;        // 中身が指についてくる割合
const CAT_SWIPE_END_FOLLOW = 0.1;    // 端のカテゴリから先へ動かしたときに、中身が指についてくる割合
// ここから始めた指はスワイプにしない（横にスクロールする行や、下から出るパネル、入力欄）
const CAT_SWIPE_IGNORE = '.cat-tabs, .filter-chips, .compose, input, textarea, select, .hold-btn';

// container：指を受ける要素
// opts.canStart()：スワイプを始めてよいか
// opts.target()：指について動かす要素（タブの下の中身）
// opts.canStep(dir)：dir（1＝次、-1＝前）のカテゴリがあるか
// opts.step(dir)：カテゴリを切り替えて描き直す
function createCategorySwipe(container, opts){
  const width = ()=>container.getBoundingClientRect().width || 1;
  let drag = null; // {x0, y0, x, t, v, dir, locked, el, can}

  container.addEventListener('touchstart', e=>{
    drag = null;
    if(e.touches.length !== 1 || e.target.closest(CAT_SWIPE_IGNORE) || !opts.canStart()) return;
    const t = e.touches[0];
    const r = container.getBoundingClientRect();
    const x = (t.clientX - r.left) / (r.width || 1);
    // 左側からは右へ（前のカテゴリ）、右側からは左へ（次のカテゴリ）
    const dir = x <= CAT_SWIPE_ZONE ? -1 : x >= 1 - CAT_SWIPE_ZONE ? 1 : 0;
    if(!dir) return;
    drag = {x0:t.clientX, y0:t.clientY, x:t.clientX, t:e.timeStamp, v:0, dir, locked:null, el:null, can:false};
  }, {passive:true});

  container.addEventListener('touchmove', e=>{
    if(!drag) return;
    if(e.touches.length !== 1){ cancel(); return; }
    const t = e.touches[0];
    const dx = t.clientX - drag.x0, dy = t.clientY - drag.y0;
    if(drag.locked === null){
      if(Math.abs(dx) < CAT_SWIPE_LOCK && Math.abs(dy) < CAT_SWIPE_LOCK) return;
      // 始めた側から内側へ、はっきり横に動かしたときだけ
      drag.locked = Math.abs(dx) >= Math.abs(dy) * CAT_SWIPE_SLOPE && Math.sign(dx) === -drag.dir;
      if(!drag.locked){ drag = null; return; }
      drag.el = opts.target();
      drag.can = opts.canStep(drag.dir);
      if(!drag.el){ drag = null; return; }
    }
    e.preventDefault(); // 横のスワイプ中は、画面のスクロールをさせない
    const dt = e.timeStamp - drag.t;
    if(dt > 0) drag.v = (t.clientX - drag.x) / dt;
    drag.x = t.clientX;
    drag.t = e.timeStamp;
    // 戻る向きに動かしたときは 0 で止める
    const d = drag.dir < 0 ? Math.max(0, dx) : Math.min(0, dx);
    drag.el.style.transition = 'none';
    drag.el.style.transform = `translateX(${d * (drag.can ? CAT_SWIPE_FOLLOW : CAT_SWIPE_END_FOLLOW)}px)`;
  }, {passive:false});

  // 中身を元の位置へ戻す
  function settle(el, from){
    const ms = motionMs(Math.max(120, Math.min(MOTION_MS, Math.abs(from) * 4)));
    el.style.transition = motionTransition(ms);
    el.style.transform = 'translateX(0)';
    setTimeout(()=>{ el.style.transition = el.style.transform = ''; }, ms);
  }
  function cancel(){
    const d = drag;
    drag = null;
    if(d && d.locked) settle(d.el, 0);
  }
  container.addEventListener('touchend', ()=>{
    if(!drag) return;
    const d = drag;
    drag = null;
    if(!d.locked) return;
    const dx = d.x - d.x0;
    const from = dx * (d.can ? CAT_SWIPE_FOLLOW : CAT_SWIPE_END_FOLLOW);
    const far = Math.abs(dx) >= width() * CAT_SWIPE_DONE;
    const flick = Math.sign(d.v) === -d.dir && Math.abs(d.v) >= CAT_SWIPE_FLICK;
    if(d.can && Math.sign(dx) === -d.dir && (far || flick)) slideContent(d.dir, opts.target, ()=>opts.step(d.dir), from);
    else settle(d.el, from);
  });
  container.addEventListener('touchcancel', cancel);
}
