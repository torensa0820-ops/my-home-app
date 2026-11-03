// くり返しの周期の入力欄と、予定日時の表示（やることタブの編集画面で使う）
// 周期のルールの計算は gas/chore-rule.js（GASと共通）を使う

// 周期の入力欄
// rule：最初に表示するルール。current：編集中の行（くり返しの行のときだけ。次回の予定の表示に使う）
function createRuleEditor(rule, current){
  rule = rule || {type:'daily', interval:1};
  const field = (label, ...inputs)=>h('div', {class:'field'}, h('label', {}, label), inputs);
  const unit = (input, text)=>h('div', {class:'inline-unit'}, input, h('span', {}, text));
  const opt = (value, text)=>h('option', {value:String(value)}, text);
  const WEEK_ORDER = [1,2,3,4,5,6,0]; // 月曜始まり

  const type = h('select', {},
    opt('daily', '毎日・N日ごと'), opt('weekly', '毎週・N週ごと（曜日を指定）'), opt('monthlyDay', '毎月（日にちを指定）'),
    opt('monthlyWeekday', '毎月（第何週・何曜日を指定）'), opt('afterDone', '完了からN日後'));
  const dailyInterval = h('input', {type:'number', min:'1', inputMode:'numeric'});
  const weekdays = h('div', {class:'chips'}, WEEK_ORDER.map(w=>h('button', {type:'button', class:'chip', value:String(w), onclick:e=>{
    e.currentTarget.classList.toggle('on');
    update();
  }}, CHORE_WEEKDAYS[w])));
  const weeklyInterval = h('input', {type:'number', min:'1', inputMode:'numeric'});
  const day = h('select', {}, Array.from({length:31}, (_, i)=>opt(i + 1, `${i + 1}日`)), opt(-1, '末日'));
  const week = h('select', {}, [1,2,3,4].map(n=>opt(n, `第${n}`)), opt(-1, '最終'));
  const weekday = h('select', {}, WEEK_ORDER.map(w=>opt(w, `${CHORE_WEEKDAYS[w]}曜日`)));
  const days = h('input', {type:'number', min:'1', inputMode:'numeric'});
  const timed = h('input', {type:'checkbox'});
  const time = h('input', {type:'time'});
  const start = h('input', {type:'date'});
  const startLabel = h('label', {}, '開始日');
  const preview = h('div', {class:'chore-preview'});

  // 初期値
  type.value = rule.type;
  dailyInterval.value = rule.type === 'daily' ? rule.interval : 1;
  weeklyInterval.value = rule.type === 'weekly' ? rule.interval : 1;
  weekdays.querySelectorAll('.chip').forEach(c=>c.classList.toggle('on', (rule.weekdays || []).includes(Number(c.value))));
  day.value = String(rule.day ?? 1);
  week.value = String(rule.week ?? 1);
  weekday.value = String(rule.weekday ?? 1);
  days.value = rule.days ?? 7;
  timed.checked = !!rule.time;
  time.value = rule.time || '09:00';
  start.value = rule.start || todayStr();

  // 周期の種類ごとに出す入力欄
  const sections = {
    daily: [field('間隔', unit(dailyInterval, '日ごと（1なら毎日）'))],
    weekly: [field('曜日（複数選択可）', weekdays), field('間隔', unit(weeklyInterval, '週ごと（1なら毎週・2なら隔週）'))],
    monthlyDay: [field('日にち', day)],
    monthlyWeekday: [field('第何週・曜日', h('div', {class:'pair'}, week, weekday))],
    afterDone: [field('日数', unit(days, '日後'))]
  };
  const startField = h('div', {class:'field'}, startLabel, start);
  const el = h('div', {class:'rule-editor', oninput:()=>update(), onchange:()=>update()},
    field('周期', type),
    Object.values(sections).flat(),
    h('div', {class:'field'}, h('label', {class:'check'}, timed, '時刻を指定する'), time),
    startField,
    preview);

  function get(){
    const r = {type:type.value};
    if(timed.checked) r.time = time.value;
    if(r.type === 'daily') r.interval = Number(dailyInterval.value);
    if(r.type === 'weekly'){
      r.interval = Number(weeklyInterval.value);
      r.weekdays = [...weekdays.querySelectorAll('.chip.on')].map(c=>Number(c.value));
    }
    if(r.type === 'monthlyDay') r.day = Number(day.value);
    if(r.type === 'monthlyWeekday'){ r.week = Number(week.value); r.weekday = Number(weekday.value); }
    if(r.type === 'afterDone') r.days = Number(days.value);
    if(['daily','weekly','afterDone'].includes(r.type)) r.start = start.value || todayStr();
    return r;
  }
  // 周期の種類に合った入力欄だけを出し、次回の予定日時をその場で表示する
  function update(){
    Object.entries(sections).forEach(([k, els])=>els.forEach(e=>{ e.hidden = k !== type.value; }));
    startField.hidden = !['daily','weekly','afterDone'].includes(type.value);
    startLabel.textContent = type.value === 'afterDone' ? '初回の日' : '開始日';
    time.hidden = !timed.checked;
    const r = get();
    preview.innerHTML = '';
    const err = choreValidate(r);
    if(err){ preview.className = 'chore-preview error'; preview.textContent = err; return; }
    const now = new Date();
    // 編集中は、保存したときに GAS が設定する次回と同じ計算をする
    const first = current
      ? choreDueAfterEdit(current.rule, r, current.nextDue ? new Date(current.nextDue) : null, current.lastDone ? new Date(current.lastDone) : null, now)
      : choreFirst(r, now);
    const later = [];
    // 完了した日で決まる afterDone 以外は、その後の予定も出して周期を確かめられるようにする
    if(first && r.type !== 'afterDone'){
      let d = first;
      for(let i = 0; i < 2 && d; i++){ d = choreNext(r, d, null); if(d) later.push(d); }
    }
    preview.className = 'chore-preview';
    preview.append(
      h('b', {}, choreLabel(r)),
      h('div', {}, (current ? '保存後の次回：' : '次回：') + (first ? choreDueText(first, !!r.time).text : '該当する日がありません')),
      later.length ? h('div', {class:'later'}, 'その後：' + later.map(d=>choreDueText(d, !!r.time).text).join('、')) : '');
  }
  update();
  return {el, get, reset(){ start.value = todayStr(); update(); }};
}
// 予定日時の表示（例：今日 9:00 / 明日 / 10/12（月）9:00 / 3日遅れ（9/25（金）））
function choreDueText(due, timed){
  const days = Math.round((choreDayStart(due) - choreDayStart(new Date())) / 86400000);
  const time = timed ? ` ${due.getHours()}:${String(due.getMinutes()).padStart(2,'0')}` : '';
  const md = `${due.getMonth() + 1}/${due.getDate()}（${CHORE_WEEKDAYS[due.getDay()]}）`;
  if(days < 0) return {text:`${-days}日遅れ（${md}${time}）`, cls:'expired'};
  if(days === 0) return {text:`今日${time}`, cls: timed && due < new Date() ? 'expired' : 'soon'};
  if(days === 1) return {text:`明日${time}`, cls:''};
  return {text:`${md}${time}`, cls:''};
}
