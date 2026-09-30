// 家計簿：記録、履歴（30件ずつ・月別合計）、記録の編集・削除

const financeFilter = createFilterBar('finance-filter', 'finance', ()=>loadFinanceHistory());

financeFilter.render([]);

// ---------- 家計簿 ----------
const financeTagPicker = createTagPicker('f-tags-chips', 'f-tags-input');
let financeOpts = {categories:[], tags:[], tagCounts:{}};
// カテゴリ・タグの候補は家計簿シートに登録済みの値から作る
// preloaded：起動時にまとめて取得したデータ（あれば通信しない）
function loadFinanceOptions(preloaded){
  return (preloaded ? Promise.resolve(preloaded) : getFromGas('action=getFinanceOptions'))
    .then(opts=>{
      financeOpts = opts;
      setupHybrid(document.getElementById('f-category-select'), document.getElementById('f-category-input'), uniqSorted(opts.categories || []));
      financeTagPicker.render(uniqSorted(opts.tags || []));
      financeFilter.render(uniqSorted(opts.tags || []));
    })
    .catch(err=>toast(`家計簿の候補の読み込みに失敗しました（${errMsg(err)}）`));
}
setupHybrid(document.getElementById('f-category-select'), document.getElementById('f-category-input'), []);
// 日付は今日を初期値にする（記録後も今日に戻す）
document.getElementById('f-date').value = todayStr();

document.getElementById('finance-form').addEventListener('submit', e=>{
  e.preventDefault();
  const category = getHybridValue(document.getElementById('f-category-select'), document.getElementById('f-category-input'));
  const amount = Number(document.getElementById('f-amount').value) || 0;
  const memo = document.getElementById('f-memo').value.trim();
  const tags = financeTagPicker.value();
  if(!category){ toast('カテゴリを選択してください'); return; }
  if(!amount) return;
  const date = document.getElementById('f-date').value;
  if(!date){ toast('日付を入力してください'); return; }
  postToGas({type:'finance', date, category, amount, memo, tags})
    .then(res=>{
      if(res.status==='success'){ toast('記録しました'); e.target.reset(); document.getElementById('f-date').value = todayStr(); financeTagPicker.clear(); loadFinanceOptions(); loadFinanceHistory(); }
      else toast(res.message || '記録に失敗しました');
    })
    .catch(err=>toast(errMsg(err)));
});

// 家計簿の履歴：新しい順に30件ずつ読み込み、月ごとの見出しに合計を出す
const FIN_PAGE = 30;
const fin = {offset:0, total:0, lastMonth:null, monthTotals:{}, seq:0};
// preloaded：起動時にまとめて取得した最初の30件（あれば通信しない）
function loadFinanceHistory(append, preloaded){
  const wrap = document.getElementById('finance-list');
  const seq = append ? fin.seq : ++fin.seq; // 読み込み直しの途中で古い応答が混ざらないようにする
  if(!append){ fin.offset = 0; fin.lastMonth = null; }
  const status = h('p', {class:'empty-msg'}, '読み込み中…');
  wrap.querySelector('.more-btn')?.remove();
  wrap.querySelector('.load-error')?.remove();
  if(!append) wrap.innerHTML = '';
  wrap.append(status);
  return (preloaded ? Promise.resolve(preloaded) : getFromGas(`action=getFinance&offset=${fin.offset}&limit=${FIN_PAGE}${financeFilter.query()}`))
    .then(data=>{
      if(seq !== fin.seq) return;
      status.remove();
      fin.total = data.total;
      if(financeFilter.active()) financeFilter.setCount(`${data.total}件`);
      fin.monthTotals = data.monthTotals || {};
      if(!data.total){ wrap.append(h('p', {class:'empty-msg'}, financeFilter.active() ? '該当する記録がありません' : 'まだ記録がありません')); return; }
      data.rows.forEach(r=>{
        const d = finDay(r);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2,'0')}`;
        if(key !== fin.lastMonth){
          const sum = fin.monthTotals[key];
          wrap.append(h('div', {class:'fin-month'},
            h('span', {}, `${d.getFullYear()}年${d.getMonth() + 1}月`),
            sum != null ? h('span', {class:'sum'}, `合計 ¥${Number(sum).toLocaleString()}`) : ''));
          fin.lastMonth = key;
        }
        const tags = splitTags(r.tags);
        const row = h('div', {class:'fin-row'},
          h('div', {class:'fin-date'}, h('b', {}, String(d.getDate())), '日'),
          h('div', {class:'fin-main'},
            h('div', {class:'fin-cat'}, r.category || '—'),
            h('div', {class:'fin-sub'}, [r.memo, tags.join(', ')].filter(Boolean).join(' ・ ') || 'メモなし')),
          h('div', {class:'fin-amount'}, `¥${(Number(r.amount) || 0).toLocaleString()}`));
        row.addEventListener('click', ()=>isComposing() ? fillFinanceForm(r, row) : openFinanceDetail(r));
        wrap.append(row);
      });
      fin.offset += data.rows.length;
      if(fin.offset < fin.total){
        wrap.append(h('button', {type:'button', class:'cancel-btn more-btn', onclick:()=>loadFinanceHistory(true)},
          `さらに${FIN_PAGE}件読み込む（残り${fin.total - fin.offset}件）`));
      }
    })
    .catch(err=>{ if(seq === fin.seq) status.replaceWith(loadErrorView(err, ()=>loadFinanceHistory(append))); });
}
// 記録の支出日。GASが日本時間で計算した day（yyyy-MM-dd）を優先する
function finDay(r){
  return r.day ? new Date(r.day + 'T00:00:00') : new Date(r.date);
}
// 記録パネルを閉じているときに履歴をタップすると、記録の編集画面（削除もここ）を開く
function openFinanceDetail(r){ openSheet('finance', tmFinanceView, r); }
// 記録の編集：日付・カテゴリ・金額・メモ・タグを変更して保存する。下に削除ボタン
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
  const memo = h('input', {type:'text', value:r.memo || '', placeholder:'例：スーパー'});
  const chips = h('div', {class:'chips', id:'fe-tags-chips'});
  const tagInput = h('input', {type:'text', id:'fe-tags-input', placeholder:'新しいタグを追加（カンマ区切り可）'});
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
    field('メモ', memo),
    field('タグ（複数選択可）', chips, tagInput),
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
      memo: memo.value.trim(),
      tags: picker.value()
    };
    if(!values.date){ toast('日付を入力してください'); return; }
    if(!values.category){ toast('カテゴリを選択してください'); return; }
    if(!values.amount){ toast('金額を入力してください'); return; }
    save.disabled = true;
    save.textContent = '保存中…';
    tm.busy = true;
    postToGas({type:'finance', action:'edit', row:r.row, date:r.date, createdAt:r.createdAt || '', values})
      .then(res=>{
        if(res.status !== 'success') throw new Error(res.message || '保存に失敗しました');
        return Promise.all([loadFinanceHistory(), loadFinanceOptions()]);
      })
      .then(()=>{ tm.busy = false; toast('保存しました'); closeSheet(); })
      .catch(err=>{ tm.busy = false; toast(errMsg(err)); save.disabled = false; save.textContent = '保存'; });
  });
}
// 過去の記録をタップすると、カテゴリ・メモ・タグを入力する（金額は毎回違うので入れない）
function fillFinanceForm(r, row){
  setHybridValue(document.getElementById('f-category-select'), document.getElementById('f-category-input'), r.category);
  document.getElementById('f-memo').value = r.memo || '';
  financeTagPicker.set(splitTags(r.tags));
  flashPicked(row, [r.category, r.memo].filter(Boolean).join('・') || '記録');
  document.getElementById('f-amount').focus({preventScroll:true});
}
