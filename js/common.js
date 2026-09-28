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

function postToGas(payload){
  return fetch(GAS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(payload)
  }).then(r => r.json());
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
document.getElementById('f-date').value = todayStr();

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
