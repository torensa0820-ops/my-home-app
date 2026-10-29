// 家計簿：定期支出（サブスク・保険料など、決まった周期で払うもの）の一覧と登録・編集・削除
// 支払いの日になると GAS（recurring.js）が確認待ちに入れ、カード利用と同じ画面で確かめて家計簿に登録する
// 周期の計算は gas/recurring-rule.js（GAS と共通）

let recurringList = [];

// preloaded：起動時にまとめて取得したデータ（あれば通信しない）
function loadRecurring(preloaded){
  return (preloaded ? Promise.resolve(preloaded) : getFromGas('action=getRecurring'))
    .then(rows=>{ recurringList = rows || []; })
    .catch(err=>toast(`定期支出の読み込みに失敗しました（${errMsg(err)}）`));
}
document.getElementById('recurring-open').addEventListener('click', ()=>openSheet('finance', tmRecurringList));

function recurringRule(r){ return {unit:r.unit, interval:Number(r.interval), start:toDateInputValue(r.start)}; }
// 「次は 11/29（あと31日）」
function recurringNextText(ymd){
  if(!ymd) return '';
  const d = daysFromToday(ymd);
  return `次は ${mdLabel(ymd)}${d === 0 ? '（今日）' : d === 1 ? '（明日）' : d > 1 ? `（あと${d}日）` : ''}`;
}

function tmRecurringList(){
  tmTitle.textContent = '定期支出';
  tmBody.append(h('p', {class:'tm-note tm-lead'},
    'サブスクや保険料など、決まった周期で払うものを登録しておくと、支払いの日の朝に確認待ちに入ります。金額を確かめて家計簿に登録してください。App Store の支払いは Apple の領収書メールからも取り込むので、ここに登録すると二重になります。'));
  if(!recurringList.length) tmBody.append(h('p', {class:'empty-msg'}, 'まだ登録がありません'));
  recurringList.forEach(r=>{
    tmBody.append(h('button', {type:'button', class:'tm-row import-row', onclick:()=>tmShow(tmRecurringEdit, r)},
      h('span', {class:'name'},
        h('span', {}, r.name || '名前なし'),
        h('small', {}, [recurringLabel(recurringRule(r)), recurringNextText(r.nextDate), r.category].filter(Boolean).join('・'))),
      h('span', {class:'amt'}, `¥${(Number(r.amount) || 0).toLocaleString()}`),
      h('span', {class:'chev'}, '›')));
  });
  tmFoot.append(h('button', {type:'button', class:'tm-btn tm-wide', onclick:()=>tmShow(tmRecurringEdit, null)}, '＋ 定期支出を追加'));
}

// 登録・編集。r が null なら新規
function tmRecurringEdit(r){
  tmTitle.textContent = r ? '定期支出を編集' : '定期支出を追加';
  const field = (label, ...inputs)=>h('div', {class:'field'}, h('label', {}, label), inputs);
  const name = h('input', {type:'text', value:r ? r.name : '', placeholder:'例：Netflix、自動車保険'});
  const amount = h('input', {type:'number', inputMode:'numeric', value:r ? Number(r.amount) || '' : '', placeholder:'1490'});
  const interval = h('input', {type:'number', inputMode:'numeric', min:1, value:r ? Number(r.interval) || 1 : 1, class:'recurring-interval'});
  const unit = h('select', {}, Object.keys(RECURRING_UNITS).map(k=>h('option', {value:k}, RECURRING_UNITS[k])));
  unit.value = r ? r.unit : 'month';
  const start = h('input', {type:'date', value:r ? toDateInputValue(r.start) : todayStr()});
  const preview = h('p', {class:'tm-note'});
  const catSelect = h('select');
  const catInput = h('input', {type:'text', class:'hybrid-input', placeholder:'新しいカテゴリを入力'});
  setupHybrid(catSelect, catInput, uniqSorted(financeOpts.categories || []));
  setHybridValue(catSelect, catInput, r ? r.category : '');
  const paySelect = h('select');
  const payInput = h('input', {type:'text', class:'hybrid-input', placeholder:'新しい支払い方法を入力'});
  setupHybrid(paySelect, payInput, uniqSorted(financeOpts.payments || []));
  setHybridValue(paySelect, payInput, r ? r.payment : '');
  const memo = h('input', {type:'text', value:r ? r.memo || '' : '', placeholder:'例：スタンダードプラン'});
  const chips = h('div', {class:'chips', id:'fr-tags-chips'});
  const tagInput = h('input', {type:'text', id:'fr-tags-input', placeholder:'新しいタグを入力して改行で追加'});
  const save = h('button', {type:'button', class:'tm-btn tm-wide'}, '保存');

  const rule = ()=>({unit:unit.value, interval:Number(interval.value), start:start.value});
  // 入力に合わせて周期の説明と次の支払いの日を出す
  function drawPreview(){
    const x = rule();
    preview.textContent = recurringValid(x)
      ? `${recurringLabel(x)}。${recurringNextText(recurringNextOnOrAfter(x, todayStr()))}`
      : 'くり返しの間隔と初回の支払い日を入れてください';
  }
  [interval, unit, start].forEach(x=>x.addEventListener('input', drawPreview));
  unit.addEventListener('change', drawPreview);
  drawPreview();

  tmBody.append(
    field('名前（お店・サービス名）', name),
    field('金額（円）', amount),
    h('div', {class:'field'}, h('label', {}, 'くり返し'),
      h('div', {class:'recurring-every'}, interval, unit)),
    field('初回（基準）の支払い日', start,
      h('p', {class:'tm-note'}, '「か月ごと」はこの日と同じ日付に払います（31日などがない月は末日）。過去の日付を入れると、今日以降の回から確認待ちに入ります。')),
    preview,
    field('カテゴリ', catSelect, catInput),
    field('支払い方法', paySelect, payInput),
    field('メモ', memo),
    field('タグ（複数選択可）', chips, tagInput));
  if(r){
    tmBody.append(h('div', {class:'tm-section tm-danger'},
      h('h3', {}, '削除'),
      h('p', {class:'tm-note'}, 'これからの支払いを確認待ちに入れなくなります。登録済みの家計簿の記録は消えません。'),
      makeHoldButton('長押しでこの定期支出を削除', reset=>recurringPost({action:'delete', id:r.id}, '削除しました', reset))));
  }
  tmFoot.append(save);

  const picker = createTagPicker('fr-tags-chips', 'fr-tags-input');
  const current = splitTags(r ? r.tags : '');
  current.forEach(t=>picker.select(t));
  picker.render(uniqSorted([...finAllTags(), ...current]));

  save.addEventListener('click', ()=>{
    const values = {
      action:'save', id:r ? r.id : '', name:normText(name.value), amount:Number(amount.value) || 0, ...rule(),
      category:getHybridValue(catSelect, catInput), payment:getHybridValue(paySelect, payInput), memo:normText(memo.value), tags:picker.value()
    };
    if(!values.name){ toast('名前を入力してください'); return; }
    if(!(values.amount > 0)){ toast('金額を入力してください'); return; }
    if(!recurringValid(values)){ toast('くり返しの間隔と初回の支払い日を入れてください'); return; }
    if(!values.category){ toast('カテゴリを選択してください'); return; }
    save.disabled = true;
    save.textContent = '保存中…';
    recurringPost(values, '保存しました', ()=>{ save.disabled = false; save.textContent = '保存'; });
  });
}

// 保存・削除して、定期支出と確認待ちを読み込み直す（今日が支払いの日なら、保存したときに確認待ちに入る）
function recurringPost(data, message, reset){
  tm.busy = true;
  postToGas({type:'recurring', ...data})
    .then(res=>{
      if(res.status !== 'success') throw new Error(res.message || '保存に失敗しました');
      return Promise.all([loadRecurring(), loadImports()]);
    })
    .then(()=>{
      tm.busy = false;
      toast(message);
      tm.stack = [];
      tmShow(tmRecurringList);
    })
    .catch(err=>{ tm.busy = false; toast(errMsg(err)); reset(); });
}
