// 動きの共通部品：動く時間とイージング、「視差効果を減らす」の判定
// 動く時間とイージングは css/style.css の --motion-ms・--motion-ease と同じ値にする

const MOTION_MS = 280;
const MOTION_EASE = 'cubic-bezier(.2,.8,.2,1)';
const reduceMotion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : {matches:false};

// 動く時間（ms）。iPhone の「視差効果を減らす」がオンなら 0（動かさずに切り替える）
function motionMs(ms = MOTION_MS){ return reduceMotion.matches ? 0 : ms; }
// transform と opacity を ms かけて動かす transition の値（ms が 0 なら動かさない）
function motionTransition(ms){ return ms ? `transform ${ms}ms ${MOTION_EASE}, opacity ${ms}ms ${MOTION_EASE}` : 'none'; }
