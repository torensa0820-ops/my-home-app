// 共通：GASとの通信、トースト、要素作成、日付・タグの小さな関数、アプリ全体の状態

/* ▼▼▼ ここにデプロイしたGASのウェブアプリURLを貼り付けてください ▼▼▼ */
const GAS_URL = "https://script.google.com/macros/s/AKfycbzCsng8oDxwQnSnUlxz1m3ANECSSH1tkmK1GIhowAkyhAM_ao7BydA1venB-zGssbL1/exec";
/* ▲▲▲ 例: https://script.google.com/macros/s/xxxxx/exec ▲▲▲ */

let stockCache = [];
let choreCache = [];

function toast(msg){
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(()=>el.classList.remove('show'), 1800);
}

// ---------- GASとの通信 ----------
// GAS は混み具合によって応答に数十秒かかることがあるため、時間切れを設け、取得は再試行する
const GET_TIMEOUT_MS = 20000;  // 取得：これ以上応答がなければ打ち切って再試行する
const GET_RETRIES = 2;         // 取得：失敗したときの再試行の回数
const POST_TIMEOUT_MS = 60000; // 書き込み：再試行しないので長めに待つ

// fetch に時間切れを付けて、応答を JSON として読む。失敗したら理由の分かるエラーにする
async function fetchJson(url, options, timeoutMs){
  const ctrl = new AbortController();
  const timer = setTimeout(()=>ctrl.abort(), timeoutMs);
  let res, text;
  try {
    res = await fetch(url, {...options, signal:ctrl.signal});
    text = await res.text();
  } catch(err) {
    throw new Error(err.name === 'AbortError' ? `時間切れ（${timeoutMs / 1000}秒以上応答がありません）` : '通信エラー');
  } finally {
    clearTimeout(timer);
  }
  try { return JSON.parse(text); }
  catch(_) {
    // GAS がエラーのページ（HTML）を返したときは、その内容の一部を出す
    const detail = text.replace(/<(style|script)[\s\S]*?<\/\1>/g, ' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
    throw new Error(`GASのエラー（${res.status}）${detail ? '：' + detail : ''}`);
  }
}
// GASからデータを取得する。失敗したら少し待って再試行する（取得は何度送っても結果が変わらないので安全）
async function getFromGas(query){
  for(let attempt = 0; ; attempt++){
    try {
      return await fetchJson(`${GAS_URL}?${query}&t=${Date.now()}`, {}, GET_TIMEOUT_MS);
    } catch(err) {
      if(attempt >= GET_RETRIES) throw err;
      await new Promise(r=>setTimeout(r, 1500 * (attempt + 1)));
    }
  }
}
// GASに書き込む。時間切れでも GAS 側では処理が済んでいることがあるため、二重に書き込まないよう再試行はしない
function postToGas(payload){
  return fetchJson(GAS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(payload)
  }, POST_TIMEOUT_MS);
}
// 一覧を「読み込み中…」にしてから読み込み直す（「もう一度読み込む」ボタン用）
function reloadList(listId, load){
  document.getElementById(listId).replaceChildren(h('p', {class:'empty-msg'}, '読み込み中…'));
  load();
}
// 一覧の読み込みに失敗したときの表示。理由と「もう一度読み込む」ボタンを出す
function loadErrorView(err, retry){
  return h('div', {class:'load-error'},
    h('p', {}, '読み込みに失敗しました'),
    h('p', {class:'reason'}, errMsg(err)),
    h('button', {type:'button', class:'cancel-btn', onclick:retry}, 'もう一度読み込む'));
}

function setupHybrid(selectEl, inputEl, presetValues){
  selectEl.innerHTML = '';
  presetValues.forEach(v=>{
    const opt = document.createElement('option');
    opt.value = v; opt.textContent = v;
    selectEl.appendChild(opt);
  });
  const blank = document.createElement('option');
  blank.value=''; blank.textContent='（未選択）';
  selectEl.insertBefore(blank, selectEl.firstChild);
  const newOpt = document.createElement('option');
  newOpt.value='__new__'; newOpt.textContent='＋ 新規入力';
  selectEl.appendChild(newOpt);
  selectEl.value = ''; // 先頭の候補が自動選択されないよう「（未選択）」にする
  inputEl.style.display = 'none';
  selectEl.onchange = () => {
    if(selectEl.value === '__new__'){ inputEl.style.display='block'; inputEl.value=''; inputEl.focus(); }
    else { inputEl.style.display='none'; }
  };
}
function getHybridValue(selectEl, inputEl){
  return selectEl.value === '__new__' ? inputEl.value.trim() : selectEl.value;
}
function escapeHtml(s){
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// 一覧をタップしてフォームに入力したことを、カードの枠とトーストで知らせる
function flashPicked(el, label){
  el.classList.remove('picked');
  void el.offsetWidth;
  el.classList.add('picked');
  toast(`「${label}」を入力しました`);
}
// プルダウン＋新規入力の組み合わせに値を入れる（候補になければ新規入力欄に入れる）
function setHybridValue(selectEl, inputEl, v){
  v = String(v || '').trim();
  const has = [...selectEl.options].some(o=>o.value === v && v !== '__new__');
  if(!v || has){ selectEl.value = v; inputEl.style.display = 'none'; }
  else { selectEl.value = '__new__'; inputEl.style.display = 'block'; inputEl.value = v; }
}

// タグ文字列を配列に分解（「,」のほか全角の「，」「、」も区切りとして扱う）
function splitTags(s){
  return String(s ?? '').split(/[,，、]/).map(t=>t.trim()).filter(Boolean);
}
// 重複と空欄を除いて五十音順に並べる
function uniqSorted(values){
  return [...new Set(values.map(v=>String(v ?? '').trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'ja'));
}

function todayStr(){ const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }

// 要素を作る小さなヘルパー。文字列の子要素はテキストとして入るのでエスケープ不要
function h(tag, props = {}, ...children){
  const el = document.createElement(tag);
  Object.entries(props).forEach(([k, v])=>{
    if(k === 'class') el.className = v;
    else if(k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if(k.includes('-')) el.setAttribute(k, v);
    else el[k] = v;
  });
  children.flat().forEach(c=>{ if(c != null && c !== false) el.append(c); });
  return el;
}
function errMsg(err){
  const m = err && err.message;
  return !m || m === 'Failed to fetch' || m === 'Load failed' ? '通信エラー' : m.replace(/^Error:\s*/, '');
}

// シートの日付（ISO文字列や「2026/10/5」など）を <input type="date"> 用の yyyy-mm-dd にする
function toDateInputValue(v){
  if(!v) return '';
  const s = String(v);
  if(s.includes('T')){
    const d = new Date(s);
    if(isNaN(d)) return '';
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }
  const m = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
  return m ? `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}` : '';
}
