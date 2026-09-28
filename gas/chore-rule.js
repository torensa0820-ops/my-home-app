// =========================================================
// 家事の周期ルール（GAS と画面の両方から読み込む共通ファイル）
// GAS の API は使わず、素の JavaScript だけで書く
// 日付はすべて実行環境の時刻（GAS は appsscript.json の Asia/Tokyo、画面は iPhone の時刻）で扱う
//
// rule = { type, time?: "HH:mm", start?: "yyyy-MM-dd", ...種類ごとの項目 }
//   daily          { interval }                  N日ごと（1なら毎日）
//   weekly         { interval, weekdays:[0-6] }  N週ごとの指定の曜日（0=日曜。週は月曜始まり）
//   monthlyDay     { day }                       毎月その日（-1 は末日。31日などがない月は末日）
//   monthlyWeekday { week, weekday }             毎月第N週のその曜日（week が -1 なら最終）
//   afterDone      { days }                      完了した日から N 日後（初回は開始日）
// time がないルールは「その日」の予定として、予定日時をその日の 0:00 にする
// start は daily・weekly の数え始めの日と、afterDone の初回の日。それより前の日は予定にしない
// =========================================================

var CHORE_WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

// シートの文字列（JSON）をルールにする。不正なら null
function choreParseRule(s) {
  if (!s) return null;
  if (typeof s === 'object') return s;
  try { return JSON.parse(s); } catch (e) { return null; }
}

function choreDayStart(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function choreParseDate(str) {
  var m = String(str || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}
function choreDiffDays(a, b) { return Math.round((choreDayStart(a) - choreDayStart(b)) / 86400000); }
function choreLastDay(d) { return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate(); }
function choreMonday(d) {
  var m = choreDayStart(d);
  m.setDate(m.getDate() - (m.getDay() + 6) % 7);
  return m;
}
// その日の予定日時（時刻なしなら 0:00）
function choreAt(day, time) {
  var d = choreDayStart(day);
  if (time) {
    var hm = time.split(':');
    d.setHours(Number(hm[0]), Number(hm[1]), 0, 0);
  }
  return d;
}

// その日がルールの該当日か
function choreMatches(rule, d) {
  var start = choreParseDate(rule.start);
  if (start && d < start) return false;
  var n = Math.max(1, Number(rule.interval) || 1);
  switch (rule.type) {
    case 'daily':
      return choreDiffDays(d, start || d) % n === 0;
    case 'weekly':
      if ((rule.weekdays || []).indexOf(d.getDay()) === -1) return false;
      return Math.round(choreDiffDays(choreMonday(d), choreMonday(start || d)) / 7) % n === 0;
    case 'monthlyDay': {
      var last = choreLastDay(d);
      return d.getDate() === (Number(rule.day) === -1 ? last : Math.min(Number(rule.day), last));
    }
    case 'monthlyWeekday':
      if (d.getDay() !== Number(rule.weekday)) return false;
      return Number(rule.week) === -1 ? d.getDate() + 7 > choreLastDay(d) : Math.ceil(d.getDate() / 7) === Number(rule.week);
  }
  return false;
}

// after より後で最初の予定日時。afterDone は lastDone（完了日時）から計算する
function choreNext(rule, after, lastDone) {
  if (rule.type === 'afterDone') {
    var base = lastDone ? choreDayStart(lastDone) : (choreParseDate(rule.start) || choreDayStart(after));
    if (lastDone) base.setDate(base.getDate() + Math.max(1, Number(rule.days) || 1));
    return choreAt(base, rule.time);
  }
  var d = choreDayStart(after);
  for (var i = 0; i < 800; i++) {
    if (choreMatches(rule, d)) {
      var t = choreAt(d, rule.time);
      if (t > after) return t;
    }
    d.setDate(d.getDate() + 1);
  }
  return null;
}

// 登録したときの最初の予定日時。時刻なしのルールは今日も対象にする
function choreFirst(rule, now) {
  var after = rule.time ? now : new Date(choreDayStart(now).getTime() - 1);
  return choreNext(rule, after, null);
}

// 完了したときの次の予定日時
// 予定より早く終えたら今回の予定の次の回へ、遅れて終えたら今より後の次の回へ進める
function choreNextAfterDone(rule, now, due) {
  if (rule.type === 'afterDone') return choreNext(rule, now, now);
  return choreNext(rule, due && due > now ? due : now, null);
}

// ルールの比較用の文字列（項目の順番や不要な項目の違いを無視する）
function choreRuleKey(rule) {
  if (!rule) return '';
  var keys = { daily: ['interval', 'start'], weekly: ['interval', 'weekdays', 'start'], monthlyDay: ['day'],
    monthlyWeekday: ['week', 'weekday'], afterDone: ['days', 'start'] }[rule.type] || [];
  var obj = { type: rule.type, time: rule.time || '' };
  keys.forEach(function (k) {
    var v = rule[k];
    obj[k] = Array.isArray(v) ? v.map(Number).sort() : (k === 'start' ? String(v || '') : Number(v));
  });
  return JSON.stringify(obj);
}

// 家事を編集したときの次の予定日時
// 周期が変わっていなければ今の予定のまま。変わったら新しい周期で計算し直す
// （afterDone は最後に完了した日から数える。未完了なら初回の日）
function choreDueAfterEdit(oldRule, newRule, oldDue, lastDone, now) {
  if (oldDue && choreRuleKey(choreParseRule(oldRule)) === choreRuleKey(newRule)) return oldDue;
  if (newRule.type === 'afterDone' && lastDone) return choreNext(newRule, now, lastDone);
  return choreFirst(newRule, now);
}

// ルールの説明文（例：毎月第2月曜 9:00）
function choreLabel(rule) {
  if (!rule) return '';
  var n = Math.max(1, Number(rule.interval) || 1);
  var text = '';
  switch (rule.type) {
    case 'daily':
      text = n === 1 ? '毎日' : n + '日ごと';
      break;
    case 'weekly': {
      // 月曜始まりの順に並べる
      var days = (rule.weekdays || []).slice().sort(function (a, b) { return (a + 6) % 7 - (b + 6) % 7; })
        .map(function (w) { return CHORE_WEEKDAYS[w]; }).join('・');
      text = (n === 1 ? '毎週' : n === 2 ? '隔週' : n + '週ごと') + ' ' + days + '曜';
      break;
    }
    case 'monthlyDay':
      text = Number(rule.day) === -1 ? '毎月末日' : '毎月' + rule.day + '日';
      break;
    case 'monthlyWeekday':
      text = '毎月' + (Number(rule.week) === -1 ? '最終' : '第' + rule.week) + CHORE_WEEKDAYS[Number(rule.weekday)] + '曜';
      break;
    case 'afterDone':
      text = '完了から' + rule.days + '日後';
      break;
  }
  return rule.time ? text + ' ' + rule.time : text;
}

// ルールの入力チェック。問題なければ空文字
function choreValidate(rule) {
  if (!rule) return '周期を設定してください';
  if (rule.time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(rule.time)) return '時刻が不正です';
  if (rule.start && !choreParseDate(rule.start)) return '開始日が不正です';
  var positive = function (v) { return Number(v) >= 1 && Math.floor(Number(v)) === Number(v); };
  switch (rule.type) {
    case 'daily':
      return positive(rule.interval) ? '' : '間隔を1以上の整数にしてください';
    case 'weekly':
      if (!positive(rule.interval)) return '間隔を1以上の整数にしてください';
      return (rule.weekdays || []).length ? '' : '曜日を1つ以上選んでください';
    case 'monthlyDay':
      return Number(rule.day) === -1 || (Number(rule.day) >= 1 && Number(rule.day) <= 31) ? '' : '日にちが不正です';
    case 'monthlyWeekday':
      if (!(Number(rule.week) === -1 || (Number(rule.week) >= 1 && Number(rule.week) <= 4))) return '第何週かが不正です';
      return Number(rule.weekday) >= 0 && Number(rule.weekday) <= 6 ? '' : '曜日が不正です';
    case 'afterDone':
      return positive(rule.days) ? '' : '日数を1以上の整数にしてください';
  }
  return '周期の種類が不正です';
}
