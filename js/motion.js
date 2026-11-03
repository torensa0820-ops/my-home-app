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
