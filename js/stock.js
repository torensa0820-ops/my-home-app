// 在庫：一覧（賞味期限ごとのロットを商品ごとにまとめて表示）、登録、削除、商品の編集

// ---------- 在庫 ----------
// 在庫は1行＝1ロット（賞味期限ごと）。画面では商品名ごとにまとめて表示する
function groupStock(){
  const map = new Map();
  stockCache.forEach(r=>{
    const name = String(r.itemName);
    if(!map.has(name)) map.set(name, []);
    map.get(name).push(r);
  });
  // 期限の早い順（期限なしは最後）
  const expKey = r=>toDateInputValue(r.expirationDate) || '9999-99-99';
  return [...map.entries()].map(([name, lots])=>{
    lots.sort((a,b)=>expKey(a).localeCompare(expKey(b)));
    const pick = key=>(lots.find(l=>l[key]) || {})[key] || '';
    return {name, lots, location:pick('location'), tags:pick('tags'), modelNumber:pick('modelNumber')};
  });
}
// 「登録中の商品」に出す商品。型番を入れた商品は取扱説明書を探すための登録で、個数を増減しないので出さない
function listedStock(){
  return groupStock().filter(g=>!g.modelNumber);
}
// 期限の表示（「期限 10/5」）と、3日以内・期限切れの判定
function expInfo(lot){
  const exp = toDateInputValue(lot.expirationDate);
  if(!exp) return {label:'', cls:''};
  const today = new Date(); today.setHours(0,0,0,0);
  const days = Math.round((new Date(exp + 'T00:00:00') - today) / 86400000);
  return {label:`期限 ${Number(exp.slice(5,7))}/${Number(exp.slice(8,10))}`, cls: days < 0 ? 'expired' : days <= 3 ? 'soon' : ''};
}
function renderStockList(){
  const wrap = document.getElementById('stock-list');
  const listed = listedStock();
  if(!listed.length){ wrap.innerHTML = '<p class="empty-msg">まだ登録された商品がありません</p>'; return; }
  wrap.innerHTML = '';
  const groups = listed.filter(g=>stockFilter.matches(g.tags));
  if(stockFilter.active()) stockFilter.setCount(`${groups.length}件`);
  if(!groups.length){ wrap.innerHTML = '<p class="empty-msg">該当する商品がありません</p>'; return; }
  groups.forEach(g=>{
    const single = g.lots.length === 1;
    const exp = single ? expInfo(g.lots[0]) : null;
    const meta = h('div', {class:'card-meta'});
    if(exp && exp.label) meta.append(h('span', {class:'exp ' + exp.cls}, exp.label), (g.location || g.tags) ? ' ・ ' : '');
    meta.append([g.location, splitTags(g.tags).join(', ')].filter(Boolean).join(' ・ ') || (exp && exp.label ? '' : '—'));
    const info = h('div', {class:'card-info'}, h('div', {class:'card-name'}, g.name), meta);
    const card = h('div', {class:'card' + (single ? '' : ' multi')});

    if(stockEditMode){
      card.classList.remove('multi');
      card.append(info, h('button', {type:'button', class:'delete-btn', onclick:()=>openDeleteSheet(g)}, '削除'));
      wrap.appendChild(card);
      return;
    }
    info.addEventListener('click', ()=>isComposing() ? fillStockForm(g, card) : openItemEditor(g));
    if(single){
      card.append(info, makeStepper(g.lots[0]));
    } else {
      const total = h('div', {class:'card-total'});
      const updateTotal = ()=>{ total.textContent = `計 ${g.lots.reduce((s,l)=>s + (Number(l.stock) || 0), 0)}`; };
      updateTotal();
      card.append(
        h('div', {class:'card-top'}, info, total),
        h('div', {class:'lots'}, g.lots.map(l=>{
          const e = expInfo(l);
          return h('div', {class:'lot'}, h('span', {class:'lot-exp exp ' + e.cls}, e.label || '期限なし'), makeStepper(l, updateTotal));
        }))
      );
    }
    wrap.appendChild(card);
  });
}
// ロットの個数を＋−するボタン（idで更新）
function makeStepper(lot, onChange){
  const count = h('span', {class:'count'}, String(lot.stock ?? 0));
  const bump = delta=>{
    const prev = Number(lot.stock) || 0;
    const set = v=>{ lot.stock = v; count.textContent = v; if(onChange) onChange(); };
    set(prev + delta);
    postToGas({type:'stock', action:'bump', id:lot.id, value:delta})
      .then(res=>{ if(res.status !== 'success'){ set(prev); toast(res.message || '更新に失敗しました'); } })
      // 時間切れでも GAS 側では更新済みのことがあるため、一覧を読み込み直して実際の個数に合わせる
      .catch(err=>{ set(prev); toast(errMsg(err)); loadStock(); });
  };
  return h('div', {class:'stepper'},
    h('button', {type:'button', onclick:()=>bump(-1)}, '−'), count, h('button', {type:'button', onclick:()=>bump(1)}, '＋'));
}
// 削除は「整理モード → 削除ボタン → 確認シートで長押し」の3段階にして誤操作を防ぐ
let stockEditMode = false;
let deleteTarget = null;

const editToggle = document.getElementById('stock-edit-toggle');
const sheetBackdrop = document.getElementById('sheet-backdrop');
const holdBtn = document.getElementById('hold-delete-btn');

function setStockEditMode(on){
  stockEditMode = on;
  editToggle.textContent = on ? '完了' : '整理';
  editToggle.classList.toggle('on', on);
  if(document.querySelector('nav.tabbar button.active').dataset.tab === 'stock'){
    document.getElementById('page-sub').textContent = on ? '不要になった商品を削除' : TAB_INFO.stock.sub;
  }
  renderStockList();
}
editToggle.addEventListener('click', ()=>setStockEditMode(!stockEditMode));

// 削除は商品単位（その商品の全ロット）。1つのロットだけ消すときは編集画面から
function openDeleteSheet(g){
  deleteTarget = g;
  document.getElementById('sheet-item-name').textContent = g.name;
  const stock = g.lots.reduce((s,l)=>s + (Number(l.stock) || 0), 0);
  const lotsNote = g.lots.length > 1 ? `賞味期限の異なる${g.lots.length}件をすべて削除します。` : '';
  document.getElementById('sheet-stock-warn').textContent = (stock > 0 ? `在庫がまだ ${stock} 個残っています。` : '') + lotsNote;
  holdBtn.disabled = false;
  holdBtn.querySelector('span').textContent = '長押しで削除';
  sheetBackdrop.classList.add('show');
}
function closeDeleteSheet(){
  cancelHold();
  deleteTarget = null;
  sheetBackdrop.classList.remove('show');
}
document.getElementById('sheet-cancel-btn').addEventListener('click', closeDeleteSheet);
sheetBackdrop.addEventListener('click', e=>{ if(e.target === sheetBackdrop && !holdBtn.disabled) closeDeleteSheet(); });

function startHold(e){
  if(holdBtn.disabled || !deleteTarget) return;
  e.preventDefault();
  holdBtn.classList.add('holding');
  clearTimeout(startHold._t);
  startHold._t = setTimeout(executeDelete, HOLD_MS);
}
function cancelHold(){
  clearTimeout(startHold._t);
  holdBtn.classList.remove('holding');
}
holdBtn.addEventListener('pointerdown', startHold);
['pointerup','pointerleave','pointercancel'].forEach(ev=>holdBtn.addEventListener(ev, cancelHold));
holdBtn.addEventListener('contextmenu', e=>e.preventDefault());

function executeDelete(){
  const g = deleteTarget;
  if(!g) return;
  holdBtn.disabled = true;
  holdBtn.querySelector('span').textContent = '削除中…';
  postToGas({type:'stock', action:'delete', target:g.name})
    .then(res=>{
      if(res.status === 'success'){
        stockCache = stockCache.filter(r=>String(r.itemName) !== g.name);
        closeDeleteSheet();
        renderStockList();
        toast(`「${g.name}」を削除しました`);
      } else {
        cancelHold(); holdBtn.disabled = false; holdBtn.querySelector('span').textContent = '長押しで削除';
        toast(res.message || '削除に失敗しました');
      }
    })
    .catch(err=>{
      cancelHold(); holdBtn.disabled = false; holdBtn.querySelector('span').textContent = '長押しで削除';
      toast(errMsg(err));
    });
}

const stockFilter = createFilterBar('stock-filter', 'stock', ()=>renderStockList());

stockFilter.render([]);

const stockTagPicker = createTagPicker('s-tags-chips', 's-tags-input');

// preloaded：起動時にまとめて取得したデータ（あれば通信しない）
function loadStock(preloaded){
  return (preloaded ? Promise.resolve(preloaded) : getFromGas('action=getStock'))
    .then(rows=>{
      stockCache = rows;
      renderStockList();
      // 収納場所・タグの候補はスプレッドシートに登録済みの値から作る
      setupHybrid(document.getElementById('s-location-select'), document.getElementById('s-location-input'), uniqSorted(rows.map(r=>r.location)));
      stockTagPicker.render(uniqSorted(rows.flatMap(r=>splitTags(r.tags))));
      // 絞り込みの候補は「登録中の商品」に出る商品のタグだけ（選んでも0件になるタグを出さない）
      stockFilter.render(uniqSorted(listedStock().flatMap(g=>splitTags(g.tags))));
    })
    .catch(err=>{ document.getElementById('stock-list').replaceChildren(loadErrorView(err, ()=>reloadList('stock-list', loadStock))); });
}
document.getElementById('stock-form').addEventListener('submit', e=>{
  e.preventDefault();
  const name = normText(document.getElementById('s-name').value);
  if(!name) return;
  const value = Number(document.getElementById('s-value').value) || 0;
  const location = getHybridValue(document.getElementById('s-location-select'), document.getElementById('s-location-input'));
  const tags = stockTagPicker.value();
  const expirationDate = document.getElementById('s-expiration').value;
  const modelNumber = normText(document.getElementById('s-model').value);
  postToGas({type:'stock', target:name, value, location, tags, expirationDate, modelNumber})
    .then(res=>{
      if(res.status==='success'){ toast('登録しました'); e.target.reset(); document.getElementById('s-value').value=1; stockTagPicker.clear(); loadStock(); }
      else toast(res.message || '登録に失敗しました');
    }).catch(err=>toast(errMsg(err)));
});
// 一覧の商品をタップすると、商品名・収納場所・タグ・型番を入力する（買い足し用。期限と個数は入れ直す）
function fillStockForm(g, card){
  document.getElementById('s-name').value = g.name;
  setHybridValue(document.getElementById('s-location-select'), document.getElementById('s-location-input'), g.location);
  stockTagPicker.set(splitTags(g.tags));
  document.getElementById('s-model').value = g.modelNumber || '';
  document.getElementById('s-value').value = 1;
  document.getElementById('s-expiration').value = '';
  document.querySelector('#stock-form details').open = true; // 買い足しは期限を入れることが多い
  flashPicked(card, g.name);
}

function openItemEditor(g){ openSheet('stock', tmItemView, g); }
// 商品の編集：商品情報（全ロット共通）と、賞味期限ごとの個数（ロット）をまとめて保存する
function tmItemView(g){
  tmTitle.textContent = '商品を編集';
  const field = (label, ...inputs)=>h('div', {class:'field'}, h('label', {}, label), inputs);
  const name = h('input', {type:'text', value:g.name});
  const locSelect = h('select');
  const locInput = h('input', {type:'text', class:'hybrid-input', placeholder:'新しい収納場所を入力'});
  setupHybrid(locSelect, locInput, uniqSorted(stockCache.map(r=>r.location)));
  if(g.location) locSelect.value = g.location;
  const chips = h('div', {class:'chips', id:'e-tags-chips'});
  const tagInput = h('input', {type:'text', id:'e-tags-input', placeholder:'新しいタグを入力して改行で追加'});
  const model = h('input', {type:'text', value:g.modelNumber || ''});
  const save = h('button', {type:'button', class:'tm-btn tm-wide'}, '保存');

  // 賞味期限ごとの行。既存ロットは id を持ち、×で消すと deleteIds に入る
  const lotRows = [];
  const deleteIds = [];
  const lotList = h('div');
  const addLotRow = (lot)=>{
    const exp = h('input', {type:'date', value:lot ? toDateInputValue(lot.expirationDate) : ''});
    const count = h('input', {type:'number', value:lot ? (Number(lot.stock) || 0) : 1, inputMode:'numeric'});
    const entry = {id: lot ? lot.id : undefined, exp, count};
    const row = h('div', {class:'lot-edit'}, exp, count,
      h('button', {type:'button', class:'lot-remove', 'aria-label':'この行を削除', onclick:()=>{
        if(lotRows.length <= 1){ toast('賞味期限の行は1つ以上必要です（商品ごと消すときは「整理」から）'); return; }
        if(entry.id !== undefined) deleteIds.push(entry.id);
        lotRows.splice(lotRows.indexOf(entry), 1);
        row.remove();
      }}, '×'));
    lotRows.push(entry);
    lotList.append(row);
  };
  g.lots.forEach(addLotRow);

  tmBody.append(
    field('商品名', name),
    field('収納場所', locSelect, locInput),
    field('タグ（複数選択可）', chips, tagInput),
    field('型番', model),
    h('div', {class:'field'},
      h('div', {class:'lot-edit lot-head'}, h('label', {}, '賞味期限'), h('label', {}, '個数'), h('span')),
      lotList,
      h('button', {type:'button', class:'cancel-btn', onclick:()=>addLotRow(null)}, '＋ 賞味期限を追加'),
      h('p', {class:'tm-note'}, '賞味期限の違うものを買い足したときは、行を追加して期限ごとに個数を入れてください。'))
  );
  tmFoot.append(save);

  // タグ候補は在庫全体のタグ。この商品に付いているタグを選択済みにしておく
  const picker = createTagPicker('e-tags-chips', 'e-tags-input');
  splitTags(g.tags).forEach(t=>picker.select(t));
  picker.render(uniqSorted(stockCache.flatMap(r=>splitTags(r.tags))));

  save.addEventListener('click', ()=>{
    const itemName = normText(name.value);
    if(!itemName){ toast('商品名を入力してください'); return; }
    const lots = lotRows.map(r=>({id:r.id, expirationDate:r.exp.value, stock:Number(r.count.value) || 0}));
    const exps = lots.map(l=>l.expirationDate);
    if(new Set(exps).size !== exps.length){ toast('同じ賞味期限の行が重複しています'); return; }
    save.disabled = true;
    save.textContent = '保存中…';
    tm.busy = true;
    postToGas({
      type:'stock', action:'editItem', oldName:g.name, itemName,
      location:getHybridValue(locSelect, locInput),
      tags:picker.value(),
      modelNumber:normText(model.value),
      lots, deleteIds
    })
      .then(res=>{
        if(res.status !== 'success') throw new Error(res.message || '保存に失敗しました');
        return loadStock();
      })
      .then(()=>{ tm.busy = false; toast('保存しました'); closeSheet(); })
      .catch(err=>{ tm.busy = false; toast(errMsg(err)); save.disabled = false; save.textContent = '保存'; });
  });
}
