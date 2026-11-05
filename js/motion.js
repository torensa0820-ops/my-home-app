// 動きの共通部品：動く時間とイージング、「視差効果を減らす」の判定
// 動く時間とイージングは css/style.css の --motion-ms・--motion-ease と同じ値にする

const MOTION_MS = 280;
const MOTION_EASE = 'cubic-bezier(.2,.8,.2,1)';
const reduceMotion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : {matches:false};

// 動く時間（ms）。iPhone の「視差効果を減らす」がオンなら 0（動かさずに切り替える）
function motionMs(ms = MOTION_MS){ return reduceMotion.matches ? 0 : ms; }
// transform と opacity を ms かけて動かす transition の値（ms が 0 なら動かさない）
function motionTransition(ms){ return ms ? `transform ${ms}ms ${MOTION_EASE}, opacity ${ms}ms ${MOTION_EASE}` : 'none'; }

// ---------- 題名の入れ替え ----------
// 同じ形の層を2枚重ね、前面（front）と後ろ（back）の題名を p に合わせて動かす
// p は js/nav-stack.js と同じく 0＝前面の題名だけ見えている 〜 1＝後ろの題名だけ見えている
// 前面は右へずれながら薄くなり、後ろは少し左から寄ってきながら濃くなる（iPhone のナビゲーションバーと同じ見え方）
const SWAP_FRONT_SHIFT = 0.3; // 前面の題名を右にずらす割合（題名の幅に対して）
const SWAP_BACK_SHIFT = 0.15; // 後ろの題名を左にずらす割合

// el：最初の子要素を1枚目の層にする（中の要素の数だけ texts を受け取る。ヘッダーなら題名と説明）
function createTitleSwap(el){
  const front = el.firstElementChild;
  const back = front.cloneNode(true);
  back.removeAttribute('id');
  back.querySelectorAll('[id]').forEach(n=>n.removeAttribute('id'));
  back.setAttribute('aria-hidden', 'true');
  el.classList.add('swap');
  el.append(back);
  let timer = 0;       // 動きが終わる時刻を待つタイマー
  let pending = null;  // 動いている途中に set された題名（動き終わってから入れる）
  let current = [...front.children].map(c=>c.textContent); // 見えている（動いている途中なら、動き終わって見える）題名
  const fill = (layer, texts)=>[...layer.children].forEach((c, i)=>{ c.textContent = texts[i] || ''; });
  const clamp = v=>Math.min(1, Math.max(0, v));

  // 動かさずに題名を入れる（前面の1枚だけにする）
  function set(...texts){
    current = texts;
    if(timer){ pending = texts; return; }
    fill(front, texts);
    el.classList.remove('swapping');
    [front, back].forEach(l=>{ l.style.transition = 'none'; l.style.transform = l.style.opacity = ''; });
  }
  // p の位置に2枚を置く。ms があれば transition で動かす
  function track(frontTexts, backTexts, p, ms = 0){
    clearTimeout(timer);
    timer = 0;
    pending = null;
    current = p < 0.5 ? frontTexts : backTexts;
    fill(front, frontTexts);
    fill(back, backTexts);
    el.classList.add('swapping');
    [front, back].forEach(l=>{ l.style.transition = motionTransition(ms); });
    front.style.transform = `translateX(${p * SWAP_FRONT_SHIFT * 100}%)`;
    front.style.opacity = String(clamp(1 - p * 1.6));
    back.style.transform = `translateX(${-(1 - p) * SWAP_BACK_SHIFT * 100}%)`;
    back.style.opacity = String(clamp(p * 1.6 - 0.6));
    if(!ms) return;
    timer = setTimeout(()=>{
      timer = 0;
      if(pending){ const t = pending; pending = null; set(...t); }
    }, ms);
  }
  // from の位置に置いてから to の位置まで動かす（動き終わったら to の側の題名だけにする）
  function slide(frontTexts, backTexts, from, to){
    const ms = motionMs();
    if(!ms){ set(...(to ? backTexts : frontTexts)); return; }
    track(frontTexts, backTexts, from);
    void el.offsetWidth; // 置いた位置を確定させてから動かす
    track(frontTexts, backTexts, to, ms);
    pending = to ? backTexts : frontTexts;
  }
  return {set, track, slide, current:()=>current};
}

// ---------- 数字の入れ替え ----------
// 増えたら古い数字が上へ抜けて新しい数字が下から上がり、減ったら逆向きに動く。0 になったときは赤く光らせて少し大きくする
// 一覧は描き直すたびに数字の要素を作り直すので、key ごとに前に出した数字を覚えておき、変わったものだけ動かす
const shownNumbers = new Map();
// el に value を入れて返す（key の前の数字と違えば動かす）
function rollNumber(el, key, value){
  const was = shownNumbers.get(key);
  shownNumbers.set(key, value);
  if(was === undefined || was === value || !motionMs()){ el.textContent = String(value); return el; }
  el.classList.add('roll', value > was ? 'roll-up' : 'roll-down');
  if(value === 0) el.classList.add('roll-zero');
  el.replaceChildren(h('span', {class:'roll-old', 'aria-hidden':'true'}, String(was)), h('span', {}, String(value)));
  return el;
}

// ---------- 中身の入れ替え（シートの中で奥へ進む・戻る） ----------
// 今の中身を同じ場所に重ねた写し（ghost）へ移し、update で新しい中身を描いてから、js/nav-stack.js と同じ向きで動かす
// dir：1＝奥へ（新しい中身が右から入り、今の中身は少し左へずれる）、-1＝戻る（今の中身が右へ出て、新しい中身が少し左から寄ってくる）、0＝動かさない
// items：[{el, fade}]。el は position の付いた要素の中に置くこと（写しはそこを基準に重ねる）。fade なら動きに合わせて薄くする（題名など、重なると読みにくいもの）
const CONTENT_BACK_SHIFT = 0.3; // 後ろの中身を左にずらす割合（中身の幅に対して）
const CONTENT_OUT = 'translateX(calc(100% + 24px))'; // 右へ出しきった位置（外側の余白の分も出す）
let contentSwapDone = null; // 動いている途中の入れ替えを、最後の位置まで送って終わらせる関数
function swapContent(dir, items, update){
  if(contentSwapDone) contentSwapDone();
  const ms = dir ? motionMs() : 0;
  if(!ms){ update(); return; }
  const pairs = items.map(({el, fade})=>{
    const g = el.cloneNode(false);
    g.removeAttribute('id');
    g.classList.add('swap-ghost');
    Object.assign(g.style, {left:el.offsetLeft + 'px', top:el.offsetTop + 'px', width:el.offsetWidth + 'px', height:el.offsetHeight + 'px'});
    const scroll = el.scrollTop;
    g.append(...el.childNodes);
    el.after(g);
    g.scrollTop = scroll;
    // 前面（右へ出入りする方）と後ろ（少し左にずれる方）
    return dir > 0 ? {el, front:el, back:g, ghost:g, fade} : {el, front:g, back:el, ghost:g, fade};
  });
  update();
  const back = `translateX(${-CONTENT_BACK_SHIFT * 100}%)`;
  const place = (n, x, o, fade)=>{ n.style.transform = x; if(fade) n.style.opacity = String(o); };
  pairs.forEach(({front, back:b, fade})=>{
    front.style.zIndex = '2';
    b.style.zIndex = '1';
    [front, b].forEach(n=>{ n.style.transition = 'none'; });
    place(front, dir > 0 ? CONTENT_OUT : 'none', dir > 0 ? 0 : 1, fade);
    place(b, dir > 0 ? 'none' : back, dir > 0 ? 1 : 0, fade);
  });
  void document.body.offsetWidth; // 置いた位置を確定させてから動かす
  pairs.forEach(({front, back:b, fade})=>{
    [front, b].forEach(n=>{ n.style.transition = motionTransition(ms); });
    place(front, dir > 0 ? 'none' : CONTENT_OUT, dir > 0 ? 1 : 0, fade);
    place(b, dir > 0 ? back : 'none', dir > 0 ? 0 : 1, fade);
  });
  const done = ()=>{
    clearTimeout(timer);
    contentSwapDone = null;
    pairs.forEach(({el, ghost})=>{
      ghost.remove();
      el.style.transition = el.style.transform = el.style.opacity = el.style.zIndex = '';
    });
  };
  const timer = setTimeout(done, ms);
  contentSwapDone = done;
}

// ---------- 中身の横送り（カテゴリの切り替え） ----------
// 左右に並んだページをめくるように、今の中身を dir と反対側へ出し、新しい中身を dir の側（1＝右、-1＝左）から入れる
// 今の中身は写し（ghost）にして重ね、update で描き直した新しい中身と並べて動かす
// getEl()：動かす要素（update の前と後で呼ぶので、描き直しで要素が作り直されてもよい）。position の付いた要素の中に置くこと
// from：今の中身が横にずれている位置（px。スワイプで指についてずれた分）
let contentSlideDone = null; // 動いている途中の横送りを、最後の位置まで送って終わらせる関数
function slideContent(dir, getEl, update, from = 0){
  if(contentSlideDone) contentSlideDone();
  const ms = motionMs();
  const old = getEl();
  if(!ms || !old){
    update();
    const el = getEl();
    if(el) el.style.transition = el.style.transform = '';
    return;
  }
  const g = old.cloneNode(true);
  g.removeAttribute('id');
  g.querySelectorAll('[id]').forEach(n=>n.removeAttribute('id'));
  // 入力中の値は cloneNode で写らないので写す（写しが入力前の値で見えないように）
  const fields = old.querySelectorAll('input, textarea, select');
  g.querySelectorAll('input, textarea, select').forEach((n, i)=>{ n.value = fields[i].value; });
  g.classList.add('swap-ghost');
  g.setAttribute('aria-hidden', 'true');
  const top = old.offsetTop;
  Object.assign(g.style, {left:old.offsetLeft + 'px', top:top + 'px', width:old.offsetWidth + 'px', height:old.offsetHeight + 'px'});
  const w = old.offsetWidth + 24; // 隣のページとの間（外側の余白の分も空ける）
  const scroller = old.offsetParent;
  const scroll = scroller ? scroller.scrollTop : 0;
  update();
  const el = getEl();
  // update でスクロール位置が変わっても（新しいページを一番上から見せるなど）、写しは画面の同じ位置に残す
  if(scroller) g.style.top = top + scroller.scrollTop - scroll + 'px';
  el.after(g);
  [g, el].forEach(n=>{ n.style.transition = 'none'; });
  g.style.transform = `translateX(${from}px)`;
  el.style.transform = `translateX(${from + dir * w}px)`;
  void el.offsetWidth; // 置いた位置を確定させてから動かす
  [g, el].forEach(n=>{ n.style.transition = motionTransition(ms); });
  g.style.transform = `translateX(${-dir * w}px)`;
  el.style.transform = 'translateX(0)';
  const done = ()=>{
    clearTimeout(timer);
    contentSlideDone = null;
    g.remove();
    el.style.transition = el.style.transform = '';
  };
  const timer = setTimeout(done, ms);
  contentSlideDone = done;
}
