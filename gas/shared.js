// =========================================================
// 画面と GAS で同じ判定をする関数（GAS と画面の両方から読み込む共通ファイル。chore-rule.js と同じ形）
// GAS の API は使わず、素の JavaScript だけで書く
//   ・文字列の正規化とタグの分解
//   ・在庫の「買う物」の判定（買う目安・買い物リストに入れる印・タグ「ストック」）
//   ・店名の合わせ方（買い物リストの店とクーポン・レシートの店）
//   ・クーポンのくり返し（repeat 列）
// =========================================================

// ---- 文字列 ----

// 保存する文字列をそろえる（英数字・記号は半角、カタカナは全角。Unicode の NFKC 正規化）
// 日付・時刻・数値・id・rule（JSON）には使わない
function normText(s) {
  return String(s ?? '').normalize('NFKC').trim();
}

// タグ文字列を正規化した配列に分解（「,」のほか全角の「，」「、」も区切りとして扱う）
function splitTags(s) {
  return normText(s).split(/[,，、]/).map(normText).filter(Boolean);
}

// ---- 在庫の「買う物」----

var BUY_FLAG = '買う'; // 在庫の buyFlag 列の値（「買い物リストに入れる」の印）

// 買う目安を数値に直す。0 以上の整数でないもの（空・文字・小数・負の数）は「目安なし」の ''
function parseReorderAt(v) {
  var s = normText(v);
  return /^\d+$/.test(s) ? Number(s) : '';
}

// なぜ買う物なのかの説明。買う物でなければ ''
// g：商品名ごとにまとめた在庫 {total（全ロットの個数の合計）, reorderAt（買う目安。なければ ''）,
//    buyFlag（印があるか）, stockTag（タグ「ストック」があるか）, model（型番があるか）}
// 型番のある商品は対象外。買う目安があれば 合計 ≤ 目安（印は見ない）。なければ印があるか、タグ「ストック」があって合計 0
function stockBuyReason(g) {
  if (g.model) return '';
  if (g.reorderAt !== '') return g.total <= g.reorderAt ? '残り ' + g.total + ' 個（目安 ' + g.reorderAt + '）' : '';
  if (g.buyFlag) return '買い物リストに入れた';
  if (g.stockTag && g.total === 0) return '切らしている';
  return '';
}

// ---- 店名の合わせ方 ----

// NFKC で正規化し、英字を小文字にし、空白と「・」を除いて比べる
function storeKey(s) {
  return normText(s).toLowerCase().replace(/[\s・]/g, '');
}

// 買い物リストの store（「,」区切りで別名を書ける。DAISO,ダイソー）を、storeKey でそろえた名前の配列にする
function storeAliases(store) {
  return String(store ?? '').split(/[,，、]/).map(storeKey).filter(Boolean);
}

// ---- クーポンのくり返し（repeat 列）----
// monthly:9,19,29 … 毎月その日（-1 は末日。その月にない日は飛ばす）
// weekly:0,6      … 毎週その曜日（0=日〜6=土）

// 空・読めなければ null
function parseRepeat(v) {
  var m = normText(v).toLowerCase().replace(/\s/g, '').match(/^(monthly|weekly):([-\d,]+)$/);
  if (!m) return null;
  var values = [...new Set(m[2].split(',').filter(Boolean).map(Number))];
  var ok = m[1] === 'monthly' ? function (n) { return n === -1 || (n >= 1 && n <= 31); } : function (n) { return n >= 0 && n <= 6; };
  if (!values.length || !values.every(function (n) { return Number.isInteger(n) && ok(n); })) return null;
  return { type: m[1], values: values.sort(function (a, b) { return (a === -1 ? 99 : a) - (b === -1 ? 99 : b); }) };
}

// yyyy-MM-dd がくり返しの日か
function repeatMatches(r, ymd) {
  var d = new Date(ymd + 'T00:00:00Z');
  if (r.type === 'weekly') return r.values.indexOf(d.getUTCDay()) !== -1;
  var day = d.getUTCDate();
  var last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  return r.values.some(function (n) { return n === -1 ? day === last : n === day; });
}

// 「毎月9・19・29日」「毎月15日・末日」「毎週日・土曜」
function repeatLabel(r) {
  if (r.type === 'weekly') return '毎週' + r.values.map(function (n) { return '日月火水木金土'[n]; }).join('・') + '曜';
  var days = r.values.filter(function (n) { return n !== -1; });
  var parts = [];
  if (days.length) parts.push(days.join('・') + '日');
  if (r.values.indexOf(-1) !== -1) parts.push('末日');
  return '毎月' + parts.join('・');
}
