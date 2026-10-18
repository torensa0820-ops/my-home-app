// 在庫：レシートから（夜に Claude がレシートを読んで「在庫取込」シートに書いた品目の確認）
// 確認待ち（kind=確認・status が空）：直してから「在庫に追加」するか「追加しない」
// 自動追加（status=自動追加・7日以内）：在庫に登録済みの品目を Claude が足した分。間違いなら「取り消す」で個数を戻す

const stockImp = {pending:[], auto:[]};
const STOCK_IMPORT_AUTO_LABEL = '7日以内'; // 自動追加を出す期間（GAS の STOCK_IMPORT_AUTO_DAYS）

// preloaded：起動時にまとめて取得したデータ（あれば通信しない）
function loadStockImports(preloaded){
  return (preloaded ? Promise.resolve(preloaded) : getFromGas('action=getStockImports'))
    .then(data=>{
      stockImp.pending = data.pending || [];
      stockImp.auto = data.auto || [];
      renderStockImportBanner();
    })
    .catch(err=>toast(`レシートからの在庫の読み込みに失敗しました（${errMsg(err)}）`));
}

// 在庫タブの上に「レシートから」を出す（確認待ちも自動追加もなければ何も出さない）
function renderStockImportBanner(){
  const wrap = document.getElementById('stock-imports');
  wrap.replaceChildren();
  const n = stockImp.pending.length, a = stockImp.auto.length;
  if(!n && !a) return;
  wrap.append(h('button', {type:'button', class:'import-banner stock', onclick:()=>openSheet('stock', tmStockImportList)},
    h('span', {class:'dot' + (n ? '' : ' quiet')}, String(n || a)),
    h('span', {class:'text'},
      h('b', {}, 'レシートから'),
      h('span', {}, [n ? `確認待ち ${n}件` : '', a ? `自動で足した分 ${a}件` : ''].filter(Boolean).join('・'))),
    h('span', {class:'chev'}, '›')));
}

// 処理が済んだ品目を手元の一覧から外し、一覧に戻る（残りがなければ閉じる）
function afterStockImportDone(it, message){
  stockImp.pending = stockImp.pending.filter(x=>x.id !== it.id);
  stockImp.auto = stockImp.auto.filter(x=>x.id !== it.id);
  renderStockImportBanner();
  tm.busy = false;
  toast(message);
  if(!stockImp.pending.length && !stockImp.auto.length){ closeSheet(); return; }
  if(tm.stack.length > 1) tm.stack.pop();
  tmRender();
}
// 作成日時「yyyy/MM/dd HH:mm」→「10/18」
function stockImportDay(it){
  const m = String(it.createdAt || '').match(/^\d{4}[-\/](\d{1,2})[-\/](\d{1,2})/);
  return m ? `${Number(m[1])}/${Number(m[2])}` : '';
}

// ---------- 一覧 ----------
function tmStockImportList(){
  tmTitle.textContent = 'レシートから';
  if(!stockImp.pending.length && !stockImp.auto.length){
    tmBody.append(h('p', {class:'empty-msg'}, 'レシートからの品目はありません'));
    return;
  }
  if(stockImp.pending.length){
    tmBody.append(h('div', {class:'tm-section'},
      h('h3', {}, `確認待ち（${stockImp.pending.length}件）`),
      h('p', {class:'tm-note tm-lead'}, 'レシートにあった品目のうち、在庫で管理したほうがよさそうなものです。タップして内容を直し、追加するか選んでください。'),
      stockImp.pending.map(it=>h('button', {type:'button', class:'tm-row import-row', onclick:()=>tmShow(tmStockImportItem, it)},
        h('span', {class:'name'},
          h('span', {}, it.itemName || '品名不明'),
          h('small', {}, it.reason || [it.location, splitTags(it.tags).join(', ')].filter(Boolean).join('・') || '—')),
        h('span', {class:'amt'}, `×${Number(it.qty) || 1}`),
        h('span', {class:'chev'}, '›')))));
  }
  if(stockImp.auto.length){
    tmBody.append(h('div', {class:'tm-section'},
      h('h3', {}, `自動で在庫に足した分（${STOCK_IMPORT_AUTO_LABEL}）`),
      h('p', {class:'tm-note tm-lead'}, '在庫に登録済みの品目（タグ「ストック」）は、レシートを読んだときに個数を足しています。間違いなら「取り消す」で個数を戻します。'),
      stockImp.auto.map(it=>{
        const undo = h('button', {type:'button', class:'row-action'}, '取り消す');
        undo.addEventListener('click', ()=>undoStockImport(it, undo));
        return h('div', {class:'tm-row import-row'},
          h('span', {class:'when'}, stockImportDay(it)),
          h('span', {class:'name'},
            h('span', {}, it.itemName || '品名不明'),
            h('small', {}, it.location || '—')),
          h('span', {class:'amt'}, `+${Number(it.qty) || 0}`),
          undo);
      })));
  }
}
// 自動追加の取り消し：在庫のロットの個数を qty だけ減らす
function undoStockImport(it, btn){
  if(tm.busy) return;
  btn.disabled = true;
  btn.textContent = '取り消し中…';
  tm.busy = true;
  postToGas({type:'stockImport', action:'undo', id:it.id})
    .then(res=>{
      if(res.status !== 'success') throw new Error(res.message || '取り消しに失敗しました');
      loadStock();
      afterStockImportDone(it, res.message || `「${it.itemName}」を${Number(it.qty) || 0}個減らしました`);
    })
    // 時間切れでも GAS 側では取り消し済みのことがあるため、一覧を読み込み直す
    .catch(err=>{ tm.busy = false; toast(errMsg(err)); btn.disabled = false; btn.textContent = '取り消す'; loadStockImports(); loadStock(); });
}

// ---------- 確認待ちの1件を直して追加する ----------
function tmStockImportItem(it){
  tmTitle.textContent = '在庫に追加';
  const field = (label, ...inputs)=>h('div', {class:'field'}, h('label', {}, label), inputs);
  const name = h('input', {type:'text', value:it.itemName || ''});
  const qty = h('input', {type:'number', value:Number(it.qty) || 1, inputMode:'numeric'});
  const locSelect = h('select');
  const locInput = h('input', {type:'text', class:'hybrid-input', placeholder:'新しい収納場所を入力'});
  setupHybrid(locSelect, locInput, uniqSorted(stockCache.map(r=>r.location)));
  const chips = h('div', {class:'chips', id:'si-tags-chips'});
  const tagInput = h('input', {type:'text', id:'si-tags-input', placeholder:'新しいタグを入力して改行で追加'});
  const exp = h('input', {type:'date'});
  const known = h('p', {class:'tm-note'});
  const save = h('button', {type:'button', class:'tm-btn tm-wide'}, '在庫に追加');
  const dismiss = h('button', {type:'button', class:'cancel-btn'}, '追加しない');

  // 登録済みの商品名なら、そのことと、空欄の収納場所・タグを登録済みの値で埋める
  const existing = ()=>groupStock().find(g=>normText(g.name) === normText(name.value));
  function drawKnown(){
    const g = existing();
    known.textContent = g ? `「${g.name}」は在庫に登録済みです。賞味期限が同じなら個数を足します。` : '';
  }
  name.addEventListener('input', drawKnown);
  const g0 = existing();
  setHybridValue(locSelect, locInput, it.location || (g0 ? g0.location : ''));
  drawKnown();

  tmBody.append(
    h('div', {class:'import-info'},
      h('div', {class:'top'}, h('span', {}, it.itemName || '品名不明'), h('b', {}, `×${Number(it.qty) || 1}`)),
      it.reason ? h('div', {class:'sub'}, `おすすめの理由：${it.reason}`) : '',
      photoLinks(it.receiptFiles)),
    field('商品名', name),
    known,
    field('個数', qty),
    field('収納場所', locSelect, locInput),
    field('タグ（複数選択可）', chips, tagInput),
    field('賞味期限（任意）', exp),
    h('div', {class:'tm-section tm-danger'},
      h('h3', {}, '追加しない'),
      h('p', {class:'tm-note'}, '在庫で管理しない品目のときに使います。一覧から消えます。'),
      dismiss));
  tmFoot.append(save);

  const picker = createTagPicker('si-tags-chips', 'si-tags-input');
  const current = splitTags(it.tags || (g0 ? g0.tags : ''));
  current.forEach(t=>picker.select(t));
  picker.render(uniqSorted([...stockCache.flatMap(r=>splitTags(r.tags)), ...current]));

  save.addEventListener('click', ()=>{
    const itemName = normText(name.value);
    const value = Number(qty.value) || 0;
    if(!itemName){ toast('商品名を入力してください'); return; }
    if(value <= 0){ toast('個数を入力してください'); return; }
    save.disabled = true; dismiss.disabled = true;
    save.textContent = '追加中…';
    tm.busy = true;
    postToGas({type:'stockImport', action:'add', id:it.id, itemName, qty:value,
      location:getHybridValue(locSelect, locInput), tags:picker.value(), expirationDate:exp.value})
      .then(res=>{
        if(res.status !== 'success') throw new Error(res.message || '追加に失敗しました');
        return loadStock();
      })
      .then(()=>afterStockImportDone(it, `「${itemName}」を在庫に追加しました`))
      .catch(err=>{ tm.busy = false; toast(errMsg(err)); save.disabled = false; dismiss.disabled = false; save.textContent = '在庫に追加'; });
  });
  dismiss.addEventListener('click', ()=>{
    save.disabled = true; dismiss.disabled = true;
    dismiss.textContent = '処理中…';
    tm.busy = true;
    postToGas({type:'stockImport', action:'dismiss', id:it.id})
      .then(res=>{
        if(res.status !== 'success') throw new Error(res.message || '処理に失敗しました');
        afterStockImportDone(it, `「${it.itemName}」は追加しません`);
      })
      .catch(err=>{ tm.busy = false; toast(errMsg(err)); save.disabled = false; dismiss.disabled = false; dismiss.textContent = '追加しない'; });
  });
}
