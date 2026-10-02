// 家計簿：記録、履歴（30件ずつ・月別合計）、記録の編集・削除

const financeFilter = createFilterBar('finance-filter', 'finance', ()=>renderFinanceHistory(), {categories:true});

financeFilter.render([]);

// ---------- 家計簿 ----------
const financeTagPicker = createTagPicker('f-tags-chips', 'f-tags-input');
let financeOpts = {categories:[], payments:[], tags:[], tagCounts:{}};
const fCatSelect = document.getElementById('f-category-select');
const fCatInput = document.getElementById('f-category-input');
const fPaySelect = document.getElementById('f-payment-select');
const fPayInput = document.getElementById('f-payment-input');
// カテゴリ・支払い方法・タグの候補は家計簿シートに登録済みの値から作る
// preloaded：起動時にまとめて取得したデータ（あれば通信しない）
function loadFinanceOptions(preloaded){
  return (preloaded ? Promise.resolve(preloaded) : getFromGas('action=getFinanceOptions'))
    .then(opts=>{
      financeOpts = opts;
      setupHybrid(fCatSelect, fCatInput, uniqSorted(opts.categories || []));
      setupHybrid(fPaySelect, fPayInput, uniqSorted(opts.payments || []));
      financeTagPicker.render(uniqSorted(opts.tags || []));
      financeFilter.render(uniqSorted(opts.tags || []));
      financeFilter.renderCategories(uniqSorted(opts.categories || []));
      financeSplits.update();
    })
    .catch(err=>toast(`家計簿の候補の読み込みに失敗しました（${errMsg(err)}）`));
}
setupHybrid(fCatSelect, fCatInput, []);
setupHybrid(fPaySelect, fPayInput, []);
// 日付は今日を初期値にする（記録後も今日に戻す）
document.getElementById('f-date').value = todayStr();

// 1回の会計をカテゴリごとに分ける内訳の入力（登録フォームと記録の編集画面で使う）
// 内訳には分けるカテゴリと金額だけを入れ、合計から内訳を引いた残りがメインカテゴリの金額になる
function createSplitEditor(totalInput, catSelect, catInput){
  const rows = [];
  const list = h('div', {class:'split-rows'});
  const preview = h('div', {class:'split-preview', hidden:true});
  const addBtn = h('button', {type:'button', class:'split-add', onclick:()=>{ addRow(); }}, '＋ 内訳を分ける（食品と日用品など）');
  const el = h('div', {class:'split-editor'}, list, preview, addBtn);

  function addRow(){
    const select = h('select');
    const input = h('input', {type:'text', class:'hybrid-input', placeholder:'新しいカテゴリを入力'});
    setupHybrid(select, input, uniqSorted(financeOpts.categories || []));
    const amount = h('input', {type:'number', inputMode:'numeric', placeholder:'金額'});
    const row = {select, input, amount};
    row.el = h('div', {class:'split-row'},
      h('div', {class:'split-cat'}, select, input),
      amount,
      h('button', {type:'button', class:'lot-remove', 'aria-label':'この内訳を削除', onclick:()=>{
        rows.splice(rows.indexOf(row), 1);
        row.el.remove();
        update();
      }}, '×'));
    [select, input, amount].forEach(x=>x.addEventListener('input', update));
    select.addEventListener('change', update);
    rows.push(row);
    list.append(row.el);
    update();
    select.focus();
  }
  function splits(){
    return rows.map(r=>({category:getHybridValue(r.select, r.input), amount:Number(r.amount.value) || 0}));
  }
  // 内訳の入力に問題があればその内容を返す（内訳がなければ空文字）
  function error(){
    const ss = splits();
    if(!ss.length) return '';
    const total = Number(totalInput.value) || 0;
    if(!getHybridValue(catSelect, catInput)) return 'カテゴリを選択してください';
    if(ss.some(s=>!s.category)) return '内訳のカテゴリを選択してください';
    if(ss.some(s=>s.amount <= 0)) return '内訳の金額を入力してください';
    if(total <= 0) return '合計の金額を入力してください';
    if(ss.reduce((sum, s)=>sum + s.amount, 0) >= total) return '内訳の合計が合計の金額以上です';
    return '';
  }
  function items(){
    const ss = splits();
    const main = (Number(totalInput.value) || 0) - ss.reduce((sum, s)=>sum + s.amount, 0);
    return [{category:getHybridValue(catSelect, catInput), amount:main}, ...ss];
  }
  // 入力中に、分けた後のカテゴリごとの金額をその場で表示する
  function update(){
    preview.hidden = !rows.length;
    if(!rows.length) return;
    const err = error();
    preview.classList.toggle('error', !!err);
    if(err){ preview.replaceChildren(err); return; }
    const all = items();
    preview.replaceChildren(
      h('div', {}, all.map(s=>`${s.category} ¥${s.amount.toLocaleString()}`).join(' ／ ')),
      h('div', {class:'later'}, `合計 ¥${(Number(totalInput.value) || 0).toLocaleString()} を${all.length}件に分けて記録します`));
  }
  [totalInput, catSelect, catInput].forEach(x=>x.addEventListener('input', update));
  catSelect.addEventListener('change', update);

  return {
    el, error, splits, items, update,
    count(){ return rows.length; },
    clear(){ rows.splice(0).forEach(r=>r.el.remove()); update(); }
  };
}
const financeSplits = createSplitEditor(document.getElementById('f-amount'), fCatSelect, fCatInput);
document.getElementById('f-splits').append(financeSplits.el);

document.getElementById('finance-form').addEventListener('submit', e=>{
  e.preventDefault();
  const category = getHybridValue(fCatSelect, fCatInput);
  const amount = Number(document.getElementById('f-amount').value) || 0;
  const memo = normText(document.getElementById('f-memo').value);
  const tags = financeTagPicker.value();
  const payment = getHybridValue(fPaySelect, fPayInput);
  if(!category){ toast('カテゴリを選択してください'); return; }
  if(!amount) return;
  const date = document.getElementById('f-date').value;
  if(!date){ toast('日付を入力してください'); return; }
  const splitErr = financeSplits.error();
  if(splitErr){ toast(splitErr); return; }
  const items = financeSplits.items();
  postToGas({type:'finance', date, items, memo, tags, payment})
    .then(res=>{
      if(res.status==='success'){
        toast(items.length > 1 ? `${items.length}件に分けて記録しました` : '記録しました');
        e.target.reset();
        document.getElementById('f-date').value = todayStr();
        setHybridValue(fCatSelect, fCatInput, '');
        setHybridValue(fPaySelect, fPayInput, '');
        financeTagPicker.clear();
        financeSplits.clear();
        loadFinanceOptions(); loadFinanceHistory();
      }
      else toast(res.message || '記録に失敗しました');
    })
    .catch(err=>toast(errMsg(err)));
});

// 家計簿の履歴：全記録を一度に取得して手元に持ち、絞り込み・月別合計・30件ずつの表示はアプリ側で行う
// （絞り込みを変えても通信しないので、すぐに反映される）
const FIN_PAGE = 30;
const fin = {all:[], loaded:false, shown:[], rendered:0, lastMonth:null, monthTotals:{}, seq:0};
// 全記録を読み込み直す。preloaded：起動時にまとめて取得したデータ（あれば通信しない）
function loadFinanceHistory(preloaded){
  const seq = ++fin.seq; // 読み込み直しの途中で古い応答が混ざらないようにする
  if(!fin.loaded) document.getElementById('finance-list').replaceChildren(h('p', {class:'empty-msg'}, '読み込み中…'));
  return (preloaded ? Promise.resolve(preloaded) : getFromGas('action=getFinance&limit=all'))
    .then(data=>{
      if(seq !== fin.seq) return;
      fin.all = data.rows;
      fin.loaded = true;
      renderFinanceHistory();
    })
    .catch(err=>{
      if(seq !== fin.seq) return;
      // 読み込み済みの一覧があれば残し、トーストで知らせる
      if(fin.loaded) toast(`家計簿の読み込みに失敗しました（${errMsg(err)}）`);
      else document.getElementById('finance-list').replaceChildren(loadErrorView(err, ()=>loadFinanceHistory()));
    });
}
// 手元の全記録を絞り込んで、最初の30件を表示する。月別合計は絞り込んだ記録で計算する
function renderFinanceHistory(){
  if(!fin.loaded) return;
  const wrap = document.getElementById('finance-list');
  fin.shown = fin.all.filter(r=>financeFilter.matches(r.tags, r.category));
  fin.monthTotals = {};
  fin.shown.forEach(r=>{
    const key = finMonthKey(finDay(r));
    fin.monthTotals[key] = (fin.monthTotals[key] || 0) + (Number(r.amount) || 0);
  });
  renderFinanceChart(); // グラフも同じ絞り込みで描き直す（グラフを表示しているときだけ）
  fin.rendered = 0;
  fin.lastMonth = null;
  wrap.innerHTML = '';
  if(financeFilter.active()) financeFilter.setCount(`${fin.shown.length}件`);
  if(!fin.shown.length){ wrap.append(h('p', {class:'empty-msg'}, financeFilter.active() ? '該当する記録がありません' : 'まだ記録がありません')); return; }
  renderFinancePage();
}
// 絞り込んだ記録の続きを30件表示する
function renderFinancePage(){
  const wrap = document.getElementById('finance-list');
  wrap.querySelector('.more-btn')?.remove();
  fin.shown.slice(fin.rendered, fin.rendered + FIN_PAGE).forEach(r=>{
    const d = finDay(r);
    const key = finMonthKey(d);
    if(key !== fin.lastMonth){
      wrap.append(h('div', {class:'fin-month'},
        h('span', {}, `${d.getFullYear()}年${d.getMonth() + 1}月`),
        h('span', {class:'sum'}, `合計 ¥${fin.monthTotals[key].toLocaleString()}`)));
      fin.lastMonth = key;
    }
    const tags = splitTags(r.tags);
    const row = h('div', {class:'fin-row'},
      h('div', {class:'fin-date'}, h('b', {}, String(d.getDate())), '日'),
      h('div', {class:'fin-main'},
        h('div', {class:'fin-cat'}, r.category || '—', r.groupId ? h('span', {class:'split-badge'}, '分割') : ''),
        h('div', {class:'fin-sub'}, [r.payment, r.memo, tags.join(', ')].filter(Boolean).join(' ・ ') || 'メモなし')),
      h('div', {class:'fin-amount'}, `¥${(Number(r.amount) || 0).toLocaleString()}`));
    row.addEventListener('click', ()=>isComposing() ? fillFinanceForm(r, row) : openFinanceDetail(r));
    wrap.append(row);
  });
  fin.rendered = Math.min(fin.rendered + FIN_PAGE, fin.shown.length);
  if(fin.rendered < fin.shown.length){
    wrap.append(h('button', {type:'button', class:'cancel-btn more-btn', onclick:renderFinancePage},
      `さらに${FIN_PAGE}件表示する（残り${fin.shown.length - fin.rendered}件）`));
  }
}
function finMonthKey(d){ return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2,'0')}`; }
// 記録の支出日。GASが日本時間で計算した day（yyyy-MM-dd）を優先する
function finDay(r){
  return r.day ? new Date(r.day + 'T00:00:00') : new Date(r.date);
}
// 記録パネルを閉じているときに履歴をタップすると、記録の編集画面（削除もここ）を開く
function openFinanceDetail(r){ openSheet('finance', tmFinanceView, r); }
// 記録の編集：日付・カテゴリ・金額・支払い方法・メモ・タグを変更して保存する。内訳を分けることもできる。下に削除ボタン
function tmFinanceView(r){
  tmTitle.textContent = '記録を編集';
  const field = (label, ...inputs)=>h('div', {class:'field'}, h('label', {}, label), inputs);
  const d = finDay(r);
  const date = h('input', {type:'date', value:`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`});
  const catSelect = h('select');
  const catInput = h('input', {type:'text', class:'hybrid-input', placeholder:'新しいカテゴリを入力'});
  setupHybrid(catSelect, catInput, uniqSorted(financeOpts.categories || []));
  setHybridValue(catSelect, catInput, r.category);
  const amount = h('input', {type:'number', value:Number(r.amount) || 0, inputMode:'numeric'});
  const splitEditor = createSplitEditor(amount, catSelect, catInput);
  const paySelect = h('select');
  const payInput = h('input', {type:'text', class:'hybrid-input', placeholder:'新しい支払い方法を入力'});
  setupHybrid(paySelect, payInput, uniqSorted(financeOpts.payments || []));
  setHybridValue(paySelect, payInput, r.payment);
  const memo = h('input', {type:'text', value:r.memo || '', placeholder:'例：スーパー'});
  const chips = h('div', {class:'chips', id:'fe-tags-chips'});
  const tagInput = h('input', {type:'text', id:'fe-tags-input', placeholder:'新しいタグを入力して改行で追加'});
  const save = h('button', {type:'button', class:'tm-btn tm-wide'}, '保存');
  const created = r.createdAt ? new Date(r.createdAt) : null;

  const deleteBtn = makeHoldButton('長押しでこの記録を削除', reset=>{
    tm.busy = true;
    postToGas({type:'finance', action:'delete', row:r.row, date:r.date, createdAt:r.createdAt || ''})
      .then(res=>{
        if(res.status !== 'success') throw new Error(res.message || '削除に失敗しました');
        return Promise.all([loadFinanceHistory(), loadFinanceOptions()]);
      })
      .then(()=>{ tm.busy = false; toast('記録を削除しました'); closeSheet(); })
      .catch(err=>{ tm.busy = false; toast(errMsg(err)); reset(); });
  });

  tmBody.append(
    field('日付', date),
    field('カテゴリ', catSelect, catInput),
    field('金額（円）', amount),
    splitEditor.el,
    field('支払い方法', paySelect, payInput),
    field('メモ', memo),
    field('タグ（複数選択可）', chips, tagInput),
    r.groupId ? h('p', {class:'tm-note'}, '日付と支払い方法を変えると、同じ会計のほかの記録にも反映されます') : '',
    created && !isNaN(created)
      ? h('p', {class:'tm-note'}, `登録日時：${created.toLocaleString('ja-JP', {year:'numeric', month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit'})}`)
      : '',
    h('div', {class:'tm-section tm-danger'},
      h('h3', {}, '削除'),
      h('p', {class:'tm-note'}, 'スプレッドシートからこの記録の行が削除されます。元に戻すことはできません。'),
      deleteBtn)
  );
  tmFoot.append(save);

  // タグ候補は家計簿全体のタグ。この記録に付いているタグを選択済みにしておく
  const picker = createTagPicker('fe-tags-chips', 'fe-tags-input');
  const current = splitTags(r.tags);
  current.forEach(t=>picker.select(t));
  picker.render(uniqSorted([...(financeOpts.tags || []), ...current]));

  save.addEventListener('click', ()=>{
    const values = {
      date: date.value,
      category: getHybridValue(catSelect, catInput),
      amount: Number(amount.value) || 0,
      payment: getHybridValue(paySelect, payInput),
      memo: normText(memo.value),
      tags: picker.value(),
      splits: splitEditor.splits()
    };
    if(!values.date){ toast('日付を入力してください'); return; }
    if(!values.category){ toast('カテゴリを選択してください'); return; }
    if(!values.amount){ toast('金額を入力してください'); return; }
    const splitErr = splitEditor.error();
    if(splitErr){ toast(splitErr); return; }
    save.disabled = true;
    save.textContent = '保存中…';
    tm.busy = true;
    postToGas({type:'finance', action:'edit', row:r.row, date:r.date, createdAt:r.createdAt || '', values})
      .then(res=>{
        if(res.status !== 'success') throw new Error(res.message || '保存に失敗しました');
        return Promise.all([loadFinanceHistory(), loadFinanceOptions()]);
      })
      .then(()=>{ tm.busy = false; toast(values.splits.length ? `${values.splits.length + 1}件に分けて保存しました` : '保存しました'); closeSheet(); })
      .catch(err=>{ tm.busy = false; toast(errMsg(err)); save.disabled = false; save.textContent = '保存'; });
  });
}
// 過去の記録をタップすると、カテゴリ・支払い方法・メモ・タグを入力する（金額は毎回違うので入れない）
function fillFinanceForm(r, row){
  setHybridValue(fCatSelect, fCatInput, r.category);
  setHybridValue(fPaySelect, fPayInput, r.payment);
  financeSplits.update();
  document.getElementById('f-memo').value = r.memo || '';
  financeTagPicker.set(splitTags(r.tags));
  flashPicked(row, [r.category, r.memo].filter(Boolean).join('・') || '記録');
  document.getElementById('f-amount').focus({preventScroll:true});
}
