// =========================================================
// 定期支出の周期（GAS と画面の両方から読み込む共通ファイル）
// GAS の API は使わず、素の JavaScript だけで書く
// 日付は "yyyy-MM-dd" の文字列で受け渡しし、計算は実行環境の時刻（GAS は Asia/Tokyo、画面は iPhone の時刻）で行う
//
// rule = { unit, interval, start }
//   unit "day"   … start から interval 日ごと
//   unit "month" … start から interval か月ごとの、start と同じ日（31日などがない月は末日）
// =========================================================

var RECURRING_UNITS = { day: '日ごと', month: 'か月ごと' };

function recurringParseDate(str) {
  var m = String(str || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}
function recurringYmd(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// ルールとして正しいか（unit・interval・start）
function recurringValid(rule) {
  var n = Number(rule && rule.interval);
  return !!rule && !!RECURRING_UNITS[rule.unit] && Number.isInteger(n) && n >= 1 && n <= 999 && !!recurringParseDate(rule.start);
}

// k 回目（0 が start）の日
function recurringNth(rule, k) {
  var s = recurringParseDate(rule.start);
  var n = Number(rule.interval) * k;
  if (rule.unit === 'day') return new Date(s.getFullYear(), s.getMonth(), s.getDate() + n);
  var last = new Date(s.getFullYear(), s.getMonth() + n + 1, 0).getDate();
  return new Date(s.getFullYear(), s.getMonth() + n, Math.min(s.getDate(), last));
}

// ymd の日かそれより後で、最初の支払いの日（"yyyy-MM-dd"）。start より前なら start
function recurringNextOnOrAfter(rule, ymd) {
  var s = recurringParseDate(rule.start);
  var d = recurringParseDate(ymd);
  if (d <= s) return rule.start;
  var n = Number(rule.interval);
  // 目安の回数から数え直す（月の長さの違いで1回ずれることがあるので、少し前から調べる）
  var k = rule.unit === 'day'
    ? Math.floor(Math.round((d - s) / 86400000) / n)
    : Math.floor(((d.getFullYear() - s.getFullYear()) * 12 + d.getMonth() - s.getMonth()) / n);
  for (k = Math.max(0, k - 1); ; k++) {
    var t = recurringNth(rule, k);
    if (t >= d) return recurringYmd(t);
  }
}

// ymd の次の支払いの日（ymd が支払いの日なら、その次の回）
function recurringNextAfter(rule, ymd) {
  var d = recurringParseDate(ymd);
  return recurringNextOnOrAfter(rule, recurringYmd(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)));
}

// 周期の説明。例「毎月29日」「3か月ごと・29日」「毎年11月29日」「毎日」「14日ごと」
function recurringLabel(rule) {
  if (!recurringValid(rule)) return '';
  var n = Number(rule.interval);
  var s = recurringParseDate(rule.start);
  if (rule.unit === 'day') return n === 1 ? '毎日' : n + '日ごと';
  if (n === 1) return '毎月' + s.getDate() + '日';
  if (n === 12) return '毎年' + (s.getMonth() + 1) + '月' + s.getDate() + '日';
  return n + 'か月ごと・' + s.getDate() + '日';
}
