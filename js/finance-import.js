// 家計簿：カード利用の取り込み（確認待ちの一覧と、1件ずつ確認して登録する画面）
// 確認待ちは「取込待ち」シートの行（カード利用通知メールから gas-mail/ が追加する）
// お店ごとに前回登録したカテゴリ・タグ・メモ（取込ルール）を入力候補にする
// 夜に Claude がレシートを読んだ行は、内訳の案（suggestItems など）を取込ルールより優先して入れる
// カード利用のない支払い（PayPay・現金）のレシートは source=receipt の行として同じ一覧に出る

const imp = {pending:[], rules:{}};
const IMPORT_DUP_DAYS = 3; // この日数以内に同じ金額の記録があれば「登録済みかも」と表示する

// 確認待ちを読み込み直す。preloaded：起動時にまとめて取得したデータ（あれば通信しない）
function loadImports(preloaded){
  return (preloaded ? Promise.resolve(preloaded) : getFromGas('action=getImports'))
    .then(data=>{
      imp.pending = data.pending || [];
      imp.rules = data.rules || {};
      renderImportBanner();
    })
    .catch(err=>toast(`カード利用の確認待ちの読み込みに失敗しました（${errMsg(err)}）`));
}

// 家計簿タブの上に「確認待ち N件」を出す（0件なら何も出さない）
function renderImportBanner(){
  const wrap = document.getElementById('finance-imports');
  wrap.replaceChildren();
  const n = imp.pending.length;
  if(!n) return;
  const errors = imp.pending.filter(p=>p.status === 'error').length;
  const receipts = imp.pending.filter(p=>p.source === 'receipt').length;
  const notes = [errors ? `読み取れなかったメール ${errors}件` : '', receipts ? `レシートの支払い ${receipts}件` : ''].filter(Boolean);
  wrap.append(h('button', {type:'button', class:'import-banner', onclick:()=>openSheet('finance', tmImportList)},
    h('span', {class:'dot'}, String(n)),
    h('span', {class:'text'},
      h('b', {}, 'カード利用の確認待ち'),
      h('span', {}, notes.length ? `${notes.join('・')}を含みます` : 'タップして内容を確認・登録')),
    h('span', {class:'chev'}, '›')));
}

// 取込待ちの「yyyy/MM/dd HH:mm」から日付（yyyy-mm-dd）と表示用の文字列を作る
function importDate(p){ return toDateInputValue(p.usedAt) || todayStr(); }
function importWhen(p){
  const m = String(p.usedAt || '').match(/^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{1,2}:\d{2})/);
  return m ? `${Number(m[2])}/${Number(m[3])} ${m[4]}` : '日時不明';
}
// 同じ金額で、日付が近い家計簿の記録（登録済みの可能性があるもの）
function importDuplicates(p, date){
  const amount = Number(p.amount) || 0;
  if(!amount) return [];
  const base = new Date((date || importDate(p)) + 'T00:00:00');
  return fin.all.filter(r=>Number(r.amount) === amount
    && Math.abs(finDay(r) - base) <= IMPORT_DUP_DAYS * 86400000);
}
// お店の入力候補：取込ルールがあればそれ、なければ店名に含まれる登録済みのお店タグ
// レシートから読んだ案（suggest*）があれば、項目ごとにそちらを優先する。items はレシートの内訳（先頭がメインのカテゴリ）
function importSuggestion(p){
  const base = importRuleSuggestion(p);
  const items = receiptSuggestItems(p);
  const tags = normText(p.suggestTags), memo = normText(p.suggestMemo), payment = normText(p.suggestPayment);
  if(!items.length && !tags && !memo && !payment) return {...base, items:[], fromReceipt:false};
  return {
    category:(items[0] && items[0].category) || base.category,
    tags:tags || base.tags,
    memo:memo || (items[0] && items[0].memo) || base.memo,
    payment:payment || base.payment,
    items, fromRule:false, fromReceipt:true
  };
}
function importRuleSuggestion(p){
  const rule = imp.rules[normText(p.merchant)];
  if(rule) return {category:rule.category || '', tags:rule.tags || '', memo:rule.memo || '', payment:rule.payment || '', fromRule:true};
  const name = normText(p.merchant);
  const tag = uniqSorted(financeOpts.tags || []).filter(t=>t.length >= 2 && name.includes(t)).sort((a, b)=>b.length - a.length)[0];
  return {category:'', tags:tag || '', memo:'', payment:'', fromRule:false};
}
// suggestItems（JSON の配列 [{category, amount, memo}]）を読む。読めなければ空
function receiptSuggestItems(p){
  let list;
  try { list = JSON.parse(p.suggestItems || '[]'); } catch(_) { return []; }
  if(!Array.isArray(list)) return [];
  return list.map(it=>({category:normText(it && it.category), amount:Number(it && it.amount) || 0, memo:normText(it && it.memo)}))
    .filter(it=>it.category && it.amount > 0);
}

// ---------- 確認待ちの一覧 ----------
function tmImportList(){
  tmTitle.textContent = '確認待ちのカード利用';
  if(!imp.pending.length){
    tmBody.append(h('p', {class:'empty-msg'}, '確認待ちはありません'));
    return;
  }
  tmBody.append(h('p', {class:'tm-note tm-lead'},
    'カードの利用通知メールとレシートから読み取りました。1件ずつ内容を確かめて登録してください。お店の締めの都合で、カードの明細の日付は利用日とずれることがあります。'));
  imp.pending.forEach(p=>{
    if(p.status === 'error'){
      tmBody.append(h('button', {type:'button', class:'tm-row import-row error', onclick:()=>tmShow(tmImportError, p)},
        h('span', {class:'name'}, '読み取れなかったメール'),
        h('span', {class:'chev'}, '›')));
      return;
    }
    const dups = importDuplicates(p);
    const sug = importSuggestion(p);
    const guess = sug.category ? `→ ${sug.category}${sug.items.length > 1 ? ` ほか${sug.items.length - 1}件` : ''}` : '分類を選んでください';
    tmBody.append(h('button', {type:'button', class:'tm-row import-row', onclick:()=>tmShow(tmImportItem, p)},
      h('span', {class:'when'}, importWhen(p)),
      h('span', {class:'name'},
        h('span', {}, p.merchant || '店名不明'),
        h('small', {}, dups.length ? '⚠ 登録済みかも'
          : [guess, p.source === 'receipt' ? (sug.payment || 'レシート') : (sug.fromReceipt ? 'レシートの内訳あり' : '')].filter(Boolean).join('・'))),
      h('span', {class:'amt'}, `¥${(Number(p.amount) || 0).toLocaleString()}`),
      h('span', {class:'chev'}, '›')));
  });
}

// 処理が済んだ取込待ちを手元の一覧から外し、一覧に戻る（残りがなければ閉じる）
function afterImportDone(p, message){
  imp.pending = imp.pending.filter(x=>x.id !== p.id);
  renderImportBanner();
  tm.busy = false;
  toast(message);
  if(!imp.pending.length){ closeSheet(); return; }
  tm.stack.pop();
  tmRender();
}
// 「登録しない」：取込待ちの行をスキップ済みにする
function skipImportButton(p){
  return makeHoldButton('長押しで登録しない（スキップ）', reset=>{
    tm.busy = true;
    postToGas({type:'finance', action:'importSkip', id:p.id})
      .then(res=>{
        if(res.status !== 'success') throw new Error(res.message || 'スキップに失敗しました');
        afterImportDone(p, 'スキップしました');
      })
      .catch(err=>{ tm.busy = false; toast(errMsg(err)); reset(); });
  });
}

// ---------- 読み取れなかったメール ----------
function tmImportError(p){
  tmTitle.textContent = '読み取れなかったメール';
  tmBody.append(
    h('p', {class:'tm-note tm-lead'}, 'カードの利用通知メールの形式が想定と違い、利用日時・店名・金額を読み取れませんでした。必要なら「＋ 記録」から手で登録し、このメールはスキップしてください。'),
    h('div', {class:'import-info'},
      h('div', {}, String(p.note || '')),
      h('div', {class:'sub'}, `受信：${p.receivedAt || '不明'}`)),
    h('div', {class:'tm-section tm-danger'}, skipImportButton(p)));
}

// ---------- 1件を確認して登録する ----------
function tmImportItem(p){
  const fromReceiptOnly = p.source === 'receipt'; // カード利用がなく、レシートだけから分かった支払い（PayPay・現金）
  tmTitle.textContent = fromReceiptOnly ? 'レシートの支払いを登録' : 'カード利用を登録';
  const sug = importSuggestion(p);
  const field = (label, ...inputs)=>h('div', {class:'field'}, h('label', {}, label), inputs);
  const date = h('input', {type:'date', value:importDate(p)});
  const catSelect = h('select');
  const catInput = h('input', {type:'text', class:'hybrid-input', placeholder:'新しいカテゴリを入力'});
  setupHybrid(catSelect, catInput, uniqSorted(financeOpts.categories || []));
  setHybridValue(catSelect, catInput, sug.category);
  const amount = h('input', {type:'number', value:Number(p.amount) || 0, inputMode:'numeric'});
  const splitEditor = createSplitEditor(amount, catSelect, catInput, {memo:sug.fromReceipt});
  // レシートの内訳の案：先頭がメインのカテゴリ（金額は合計の残り）、2件目からを内訳に入れる
  if(sug.items.length > 1) splitEditor.set(sug.items.slice(1));
  const itemsTotal = sug.items.reduce((s, it)=>s + it.amount, 0);
  const paySelect = h('select');
  const payInput = h('input', {type:'text', class:'hybrid-input', placeholder:'新しい支払い方法を入力'});
  setupHybrid(paySelect, payInput, uniqSorted([...(financeOpts.payments || []), ...(fromReceiptOnly ? [] : ['クレジットカード'])]));
  setHybridValue(paySelect, payInput, sug.payment || (fromReceiptOnly ? '' : 'クレジットカード'));
  const memo = h('input', {type:'text', value:sug.memo, placeholder:'例：サブスクのサービス名'});
  const chips = h('div', {class:'chips', id:'fi-tags-chips'});
  const tagInput = h('input', {type:'text', id:'fi-tags-input', placeholder:'新しいタグを入力して改行で追加'});
  const remember = h('input', {type:'checkbox', checked:true});
  const dupBox = h('div');
  const save = h('button', {type:'button', class:'tm-btn tm-wide'}, '家計簿に登録');

  // 同じ金額で日付が近い記録があれば、二重登録にならないよう知らせる（日付を変えたら探し直す）
  function drawDuplicates(){
    const dups = importDuplicates(p, date.value);
    dupBox.replaceChildren();
    if(!dups.length) return;
    dupBox.append(h('div', {class:'import-dup'},
      h('b', {}, '⚠ 登録済みの可能性があります'),
      h('p', {}, `同じ金額の記録が${IMPORT_DUP_DAYS}日以内にあります。同じ支払いなら「登録しない」を選んでください。`),
      dups.map(r=>{
        const d = finDay(r);
        return h('div', {class:'dup-row'},
          `${d.getMonth() + 1}/${d.getDate()} ${r.category || '—'}・${[r.payment, splitTags(r.tags).join(', ')].filter(Boolean).join('・')}`,
          h('span', {}, `¥${(Number(r.amount) || 0).toLocaleString()}`));
      })));
  }
  date.addEventListener('change', drawDuplicates);
  drawDuplicates();

  tmBody.append(
    h('div', {class:'import-info'},
      h('div', {class:'top'}, h('span', {}, p.merchant || '店名不明'), h('b', {}, `¥${(Number(p.amount) || 0).toLocaleString()}`)),
      h('div', {class:'sub'}, [`利用 ${importWhen(p)}`, p.kind, p.card, fromReceiptOnly ? 'レシートから' : ''].filter(Boolean).join(' ・ ')),
      p.receiptId ? photoLinks(p.receiptFiles) : ''),
    dupBox,
    sug.fromReceipt ? h('p', {class:'tm-note tm-lead'}, 'レシートから読み取った内訳を入れています。写真と見比べて直してください。'
      + (sug.items.length && itemsTotal !== (Number(p.amount) || 0) ? `（レシートの内訳の合計 ¥${itemsTotal.toLocaleString()} と金額が違います）` : '')) : '',
    field('日付', date),
    field('カテゴリ', catSelect, catInput),
    field('金額（円）', amount),
    splitEditor.el,
    field('支払い方法', paySelect, payInput),
    field('メモ', memo),
    field('タグ（複数選択可）', chips, tagInput),
    h('label', {class:'tm-check'}, remember,
      h('span', {class:'main'}, `「${p.merchant || 'このお店'}」の分類（カテゴリ・タグ・メモ・支払い方法）を次回の候補にする`)),
    sug.fromRule ? h('p', {class:'tm-note'}, '前回このお店で登録した内容を入れています') : '',
    h('div', {class:'tm-section tm-danger'},
      h('h3', {}, '登録しない'),
      h('p', {class:'tm-note'}, 'すでに登録済み、立替えなど家計簿に入れない支払いのときに使います。'),
      skipImportButton(p)));
  tmFoot.append(save);

  // タグはお店の候補を選択済みにしておく
  const picker = createTagPicker('fi-tags-chips', 'fi-tags-input');
  const current = splitTags(sug.tags);
  current.forEach(t=>picker.select(t));
  picker.render(uniqSorted([...(financeOpts.tags || []), ...current]));

  save.addEventListener('click', ()=>{
    const category = getHybridValue(catSelect, catInput);
    const total = Number(amount.value) || 0;
    if(!date.value){ toast('日付を入力してください'); return; }
    if(!category){ toast('カテゴリを選択してください'); return; }
    if(!total){ toast('金額を入力してください'); return; }
    const splitErr = splitEditor.error();
    if(splitErr){ toast(splitErr); return; }
    const items = splitEditor.items();
    save.disabled = true;
    save.textContent = '登録中…';
    tm.busy = true;
    postToGas({type:'finance', action:'importConfirm', id:p.id, date:date.value, items,
      memo:normText(memo.value), tags:picker.value(), payment:getHybridValue(paySelect, payInput), remember:remember.checked})
      .then(res=>{
        if(res.status !== 'success') throw new Error(res.message || '登録に失敗しました');
        if(remember.checked) imp.rules[normText(p.merchant)] = {category, tags:picker.value(), memo:normText(memo.value), payment:getHybridValue(paySelect, payInput)};
        return Promise.all([loadFinanceHistory(), loadFinanceOptions()]);
      })
      .then(()=>afterImportDone(p, items.length > 1 ? `${items.length}件に分けて登録しました` : '家計簿に登録しました'))
      .catch(err=>{ tm.busy = false; toast(errMsg(err)); save.disabled = false; save.textContent = '家計簿に登録'; });
  });
}
