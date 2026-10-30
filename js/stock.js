// 在庫：カテゴリのタブ、一覧（賞味期限ごとのロットを商品ごとにまとめて表示）、登録、削除、商品の編集

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
    // 買う目安は 0 も有効な値なので pick を使わない
    const reorderAt = lots.map(l=>parseReorderAt(l.reorderAt)).find(v=>v !== '') ?? '';
    const buyFlag = lots.some(l=>normText(l.buyFlag) === BUY_FLAG);
    return {name, lots, category:pick('category'), location:pick('location'), tags:pick('tags'), modelNumber:pick('modelNumber'), reorderAt, buyFlag};
  });
}

// ---------- 買う物 ----------
const BUY_FLAG = '買う'; // buyFlag 列の値（買い物メモの印。GAS と同じ）
const BUY_TAB = '買う物';
let stockSheetColumns = []; // 在庫シートの列名。reorderAt・buyFlag の列がない古いシートでは、その機能を画面に出さない
const buyUnchecked = new Set(); // 買う物の一覧でチェックを外した商品名（一覧を描き直しても残す）
let buyListOpen = false;        // 買う物の一覧を表示中か（タブを開き直したら全部チェック済みに戻す）
const BUY_BRAND_KEY = 'kurashilog.stockBuyBrand';
let buyWithBrand = loadBuyBrand(); // 「ブランドも含める」（オンならコピーに商品名全体を使う）

function loadBuyBrand(){
  try { return localStorage.getItem(BUY_BRAND_KEY) === '1'; } catch(_){ return false; }
}
function saveBuyBrand(){
  try { localStorage.setItem(BUY_BRAND_KEY, buyWithBrand ? '1' : ''); } catch(_){}
}
// コピーする品名：商品名のかっこ以降を除く（「シャンプー(PANTENE)」→「シャンプー」）。何も残らなければ商品名のまま
function buyCopyName(name){
  return name.replace(/\s*[(（].*$/, '').trim() || name;
}
// 買う物の並び：カテゴリ（タブと同じ順で、ほかのカテゴリは五十音順、未分類は最後）→ 収納場所（空は最後）→ 商品名
function sortBuyItems(items){
  const catRank = c=>c === UNCATEGORIZED ? STOCK_CATEGORIES.length + 1 : STOCK_CATEGORIES.includes(c) ? STOCK_CATEGORIES.indexOf(c) : STOCK_CATEGORIES.length;
  const text = (a, b)=>a.localeCompare(b, 'ja');
  return [...items].sort((a, b)=>{
    const ca = stockCategoryOf(a), cb = stockCategoryOf(b);
    return catRank(ca) - catRank(cb) || text(ca, cb)
      || !a.location - !b.location || text(String(a.location), String(b.location))
      || text(a.name, b.name);
  });
}

// 買う目安を数値に直す。0 以上の整数でないもの（空・文字・小数・負の数）は「目安なし」の ''（GAS と同じ）
function parseReorderAt(v){
  const s = normText(v);
  return /^\d+$/.test(s) ? Number(s) : '';
}
function stockTotal(g){ return g.lots.reduce((s,l)=>s + (Number(l.stock) || 0), 0); }
// なぜ買う物なのかの説明。買う物でなければ ''
function buyReason(g){
  if(g.modelNumber) return '';
  const total = stockTotal(g);
  if(g.reorderAt !== '') return total <= g.reorderAt ? `残り ${total} 個（目安 ${g.reorderAt}）` : '';
  if(g.buyFlag) return 'メモに追加';
  if(total === 0 && splitTags(g.tags).includes('ストック')) return '切らしている';
  return '';
}
function isBuyItem(g){ return buyReason(g) !== ''; }
// 「買い物メモに追加」を出すか。個数が1個でも、開けたばかりか残りわずかかは数字で分からないので手で印を付ける
function canMemoBuy(g){
  return stockSheetColumns.includes('buyFlag') && stockTotal(g) === 1 && g.reorderAt === '' && !g.modelNumber && !stockEditMode;
}
// 買い物メモの印を付ける・外す。画面はすぐに切り替え、失敗したら元に戻す
function toggleBuyFlag(g){
  const prev = g.lots.map(l=>l.buyFlag);
  const undo = ()=>{ g.lots.forEach((l,i)=>{ l.buyFlag = prev[i]; }); renderStockList(); };
  const on = !g.buyFlag;
  g.lots.forEach(l=>{ l.buyFlag = on ? BUY_FLAG : ''; });
  renderStockList();
  postToGas({type:'stock', action:'setBuyFlag', target:g.name, value:on})
    .then(res=>{ if(res.status !== 'success'){ undo(); toast(res.message || '更新に失敗しました'); } })
    // 時間切れでも GAS 側では更新済みのことがあるため、一覧を読み込み直して実際の状態に合わせる
    .catch(err=>{ undo(); toast(errMsg(err)); loadStock(); });
}
function makeBuyButton(g){
  return h('button', {type:'button', class:'buy-btn' + (g.buyFlag ? ' on' : ''), 'aria-pressed':String(g.buyFlag), onclick:e=>{
    e.stopPropagation(); // カードのタップ（商品の編集）を開かない
    toggleBuyFlag(g);
  }}, g.buyFlag ? 'メモに追加済み' : '買い物メモに追加');
}
// 買う物の一覧：チェックした品名を1行に1品目でコピーする（iPhone のショートカットで分割してリマインダーに入れる）
function renderBuyList(wrap, items){
  wrap.innerHTML = '';
  if(!items.length){ wrap.innerHTML = '<p class="empty-msg">いま買う物はありません</p>'; return; }
  const brand = h('input', {type:'checkbox', role:'switch', checked:buyWithBrand, onchange:()=>{ buyWithBrand = brand.checked; saveBuyBrand(); }});
  wrap.append(h('label', {class:'buy-switch'}, 'ブランドも含める', brand));
  items.forEach(g=>{
    const cb = h('input', {type:'checkbox', checked:!buyUnchecked.has(g.name), onchange:()=>{
      if(cb.checked) buyUnchecked.delete(g.name); else buyUnchecked.add(g.name);
    }});
    wrap.append(h('label', {class:'tm-check'}, cb,
      h('div', {class:'main'}, h('div', {class:'t1'}, g.name), h('div', {class:'t2'}, buyReason(g)))));
  });
  const fallback = h('div');
  wrap.append(h('button', {type:'button', class:'submit-btn', onclick:()=>{
    const checked = items.map(g=>g.name).filter(name=>!buyUnchecked.has(name));
    if(!checked.length){ toast('コピーする物を選んでください'); return; }
    // 品名だけのときは、同じ品名を1行にまとめる
    const names = buyWithBrand ? checked : [...new Set(checked.map(buyCopyName))];
    copyBuyNames(names, fallback);
  }}, '選んだ物をコピー'), fallback);
}
// クリップボードに入れる。失敗したら、テキストを選択できる形で表示する
async function copyBuyNames(names, fallback){
  const text = names.join('\n');
  fallback.replaceChildren();
  try {
    await navigator.clipboard.writeText(text);
    toast(`${names.length}件コピーしました`);
  } catch(_) {
    const area = h('textarea', {class:'buy-copy', rows:names.length, value:text});
    fallback.append(h('p', {class:'form-note'}, 'コピーできませんでした。下の文字を選択してコピーしてください。'), area);
    area.focus();
    area.setSelectionRange(0, text.length);
  }
}

// ---------- カテゴリ ----------
// タブはこの順に並べ（GAS の STOCK_CATEGORIES と同じ）、ほかのカテゴリは件数の多い順で後ろに足す
// カテゴリが空の商品は「未分類」に出す。タブと絞り込みは stockFilter（js/tags.js の createFilterBar）が持つ
const STOCK_CATEGORIES = ['食品', '日用品', '医薬品', '家具・家電', '住宅設備', 'PC周辺機器'];

function stockCategoryOf(g){ return g.category || UNCATEGORIZED; }
// カテゴリの入力候補（決まったカテゴリと、登録済みのほかのカテゴリ）
function stockCategoryOptions(){
  const extra = uniqSorted(stockCache.map(r=>r.category)).filter(c=>!STOCK_CATEGORIES.includes(c) && c !== UNCATEGORIZED);
  return [...STOCK_CATEGORIES, ...extra];
}
// 絞り込みの候補は、選んでいるカテゴリの商品に付いているタグだけ（選んでも0件になるタグを出さない）
function renderStockFilterTags(){
  stockFilter.render(uniqSorted(groupStock().filter(g=>stockFilter.matchesCategory(stockCategoryOf(g))).flatMap(g=>splitTags(g.tags))));
}
// 登録フォームのカテゴリを、タブで選んでいるカテゴリにする（「すべて」「未分類」や複数選んでいるときは未選択）
function setStockFormCategory(){
  const cats = stockFilter.categories();
  setHybridValue(document.getElementById('s-category-select'), document.getElementById('s-category-input'),
    cats.length === 1 && cats[0] !== UNCATEGORIZED ? cats[0] : '');
  syncStockFormTags();
}
// タグの候補：カテゴリ c の商品に付いているタグと、在庫全体のタグ
function stockTagsOf(c){ return groupStock().filter(g=>stockCategoryOf(g) === c).flatMap(g=>splitTags(g.tags)); }
function stockAllTags(){ return uniqSorted(stockCache.flatMap(r=>splitTags(r.tags))); }
// 登録・編集画面のタグの候補を、カテゴリの欄で選んだカテゴリのタグにする（選び直すたびに合わせる）。合わせる関数を返す
function stockTagSync(picker, catSelect, catInput){
  const sync = categoryTagSync(picker, ()=>[getHybridValue(catSelect, catInput)], stockTagsOf, stockAllTags);
  catSelect.addEventListener('change', sync);
  catInput.addEventListener('input', sync);
  return sync;
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
  const all = groupStock();
  const buyItems = sortBuyItems(all.filter(isBuyItem));
  stockFilter.renderCategories(categoryCounts(all.map(stockCategoryOf), STOCK_CATEGORIES), all.length, buyItems.length);
  if(!all.length){ wrap.innerHTML = '<p class="empty-msg">まだ登録された商品がありません</p>'; return; }
  // 買う物のタブはチェック付きの一覧。整理モードでは、買う物だけを削除ボタン付きのカードで出す
  const buyTab = stockFilter.special();
  if(buyTab && !stockEditMode){
    if(!buyListOpen) buyUnchecked.clear();
    buyListOpen = true;
    renderBuyList(wrap, buyItems);
    return;
  }
  buyListOpen = false;
  wrap.innerHTML = '';
  // カテゴリを1つに絞っていなければ、カードにカテゴリも出す
  const showAll = stockFilter.categories().length !== 1;
  const groups = buyTab ? buyItems : all.filter(g=>stockFilter.matches(g.tags, stockCategoryOf(g)));
  if(stockFilter.active()) stockFilter.setCount(`${groups.length}件`);
  if(!groups.length){ wrap.innerHTML = '<p class="empty-msg">該当する商品がありません</p>'; return; }
  groups.forEach(g=>{
    // 型番を入れた商品（家具・家電や設備）は個数を増減しないので、＋−を出さず、型番を表示する
    const model = !!g.modelNumber;
    const single = model || g.lots.length === 1;
    const exp = single && !model ? expInfo(g.lots[0]) : null;
    const text = [showAll ? stockCategoryOf(g) : '', model ? `型番 ${g.modelNumber}` : '', g.location, splitTags(g.tags).join(', ')].filter(Boolean).join(' ・ ');
    const meta = h('div', {class:'card-meta'});
    if(exp && exp.label) meta.append(h('span', {class:'exp ' + exp.cls}, exp.label), text ? ' ・ ' : '');
    meta.append(text || (exp && exp.label ? '' : '—'));
    const info = h('div', {class:'card-info'},
      h('div', {class:'card-name-row'}, h('div', {class:'card-name'}, g.name), isBuyItem(g) ? h('span', {class:'buy-badge'}, BUY_TAB) : ''),
      meta, canMemoBuy(g) ? makeBuyButton(g) : '');
    const card = h('div', {class:'card' + (single ? '' : ' multi')});

    if(stockEditMode){
      card.classList.remove('multi');
      card.append(info, h('button', {type:'button', class:'delete-btn', onclick:()=>openDeleteSheet(g)}, '削除'));
      wrap.appendChild(card);
      return;
    }
    info.addEventListener('click', ()=>isComposing() ? fillStockForm(g, card) : openItemEditor(g));
    if(model){
      card.append(info, h('span', {class:'card-chev'}, '›'));
    } else if(single){
      card.append(info, makeStepper(g.lots[0]));
    } else {
      card.append(
        h('div', {class:'card-top'}, info, h('div', {class:'card-total'}, `計 ${stockTotal(g)}`)),
        h('div', {class:'lots'}, g.lots.map(l=>{
          const e = expInfo(l);
          return h('div', {class:'lot'}, h('span', {class:'lot-exp exp ' + e.cls}, e.label || '期限なし'), makeStepper(l));
        }))
      );
    }
    wrap.appendChild(card);
  });
}
// ロットの個数を＋−するボタン（idで更新）
// 個数で「買い物メモに追加」やバッジ・タブの件数が変わるので、そのたびに一覧を描き直す
function makeStepper(lot){
  const count = h('span', {class:'count'}, String(lot.stock ?? 0));
  const bump = delta=>{
    const prev = Number(lot.stock) || 0;
    // 増えたら GAS 側で買い物メモの印が外れるので、画面でも同じ商品の全ロットから外す
    const sameItem = stockCache.filter(r=>String(r.itemName) === String(lot.itemName));
    const prevFlags = sameItem.map(l=>l.buyFlag);
    const set = (v, flags)=>{
      lot.stock = v;
      sameItem.forEach((l,i)=>{ l.buyFlag = flags[i]; });
      renderStockList();
    };
    set(prev + delta, delta > 0 ? sameItem.map(()=>'') : prevFlags);
    postToGas({type:'stock', action:'bump', id:lot.id, value:delta})
      .then(res=>{ if(res.status !== 'success'){ set(prev, prevFlags); toast(res.message || '更新に失敗しました'); } })
      // 時間切れでも GAS 側では更新済みのことがあるため、一覧を読み込み直して実際の個数に合わせる
      .catch(err=>{ set(prev, prevFlags); toast(errMsg(err)); loadStock(); });
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

// カテゴリやタグを選び直したら、タグの候補・一覧・登録フォームのカテゴリを合わせる
const stockFilter = createFilterBar('stock-filter', 'stock', ()=>{
  renderStockFilterTags();
  renderStockList();
  if(!isComposing()) setStockFormCategory();
}, {tabs:{id:'stock-cats', storageKey:'kurashilog.stockCats', special:{label:BUY_TAB, storageKey:'kurashilog.stockBuyTab'}}});

stockFilter.render([]);

const stockTagPicker = createTagPicker('s-tags-chips', 's-tags-input');
const syncStockFormTags = stockTagSync(stockTagPicker, document.getElementById('s-category-select'), document.getElementById('s-category-input'));

// preloaded：起動時にまとめて取得したデータ（あれば通信しない）
function loadStock(preloaded){
  return (preloaded ? Promise.resolve(preloaded) : getFromGas('action=getStock'))
    .then(rows=>{
      stockCache = rows;
      stockSheetColumns = Object.keys(rows[0] || {});
      renderStockList();
      // カテゴリ・収納場所・タグの候補はスプレッドシートに登録済みの値から作る（カテゴリは決まったカテゴリも出す）
      // （名称変更・削除で無くなったタグを選択から外してから、カテゴリに合わせてタグの候補を絞る）
      stockTagPicker.render(stockAllTags());
      setupHybrid(document.getElementById('s-category-select'), document.getElementById('s-category-input'), stockCategoryOptions());
      setStockFormCategory();
      setupHybrid(document.getElementById('s-location-select'), document.getElementById('s-location-input'), uniqSorted(rows.map(r=>r.location)));
      renderStockFilterTags();
    })
    .catch(err=>{ document.getElementById('stock-list').replaceChildren(loadErrorView(err, ()=>reloadList('stock-list', loadStock))); });
}
document.getElementById('stock-form').addEventListener('submit', e=>{
  e.preventDefault();
  const name = normText(document.getElementById('s-name').value);
  if(!name) return;
  const value = Number(document.getElementById('s-value').value) || 0;
  const category = getHybridValue(document.getElementById('s-category-select'), document.getElementById('s-category-input'));
  const location = getHybridValue(document.getElementById('s-location-select'), document.getElementById('s-location-input'));
  const tags = stockTagPicker.value();
  const expirationDate = document.getElementById('s-expiration').value;
  const modelNumber = normText(document.getElementById('s-model').value);
  postToGas({type:'stock', target:name, value, category, location, tags, expirationDate, modelNumber})
    .then(res=>{
      if(res.status==='success'){ toast('登録しました'); e.target.reset(); document.getElementById('s-value').value=1; stockTagPicker.clear(); loadStock(); }
      else toast(res.message || '登録に失敗しました');
    }).catch(err=>toast(errMsg(err)));
});
// 一覧の商品をタップすると、商品名・カテゴリ・収納場所・タグ・型番を入力する（買い足し用。期限と個数は入れ直す）
function fillStockForm(g, card){
  document.getElementById('s-name').value = g.name;
  setHybridValue(document.getElementById('s-category-select'), document.getElementById('s-category-input'), g.category);
  setHybridValue(document.getElementById('s-location-select'), document.getElementById('s-location-input'), g.location);
  stockTagPicker.set(splitTags(g.tags));
  syncStockFormTags();
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
  const catSelect = h('select');
  const catInput = h('input', {type:'text', class:'hybrid-input', placeholder:'新しいカテゴリを入力'});
  setupHybrid(catSelect, catInput, stockCategoryOptions());
  setHybridValue(catSelect, catInput, g.category);
  const locSelect = h('select');
  const locInput = h('input', {type:'text', class:'hybrid-input', placeholder:'新しい収納場所を入力'});
  setupHybrid(locSelect, locInput, uniqSorted(stockCache.map(r=>r.location)));
  if(g.location) locSelect.value = g.location;
  const chips = h('div', {class:'chips', id:'e-tags-chips'});
  const tagInput = h('input', {type:'text', id:'e-tags-input', placeholder:'新しいタグを入力して改行で追加'});
  const model = h('input', {type:'text', value:g.modelNumber || ''});
  const hasReorder = stockSheetColumns.includes('reorderAt');
  const reorder = h('input', {type:'number', min:'0', step:'1', inputMode:'numeric', value:g.reorderAt});
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
    field('カテゴリ', catSelect, catInput),
    field('収納場所', locSelect, locInput),
    field('タグ（複数選択可）', chips, tagInput,
      h('p', {class:'tm-note'}, TAG_LIMIT_NOTE),
      h('p', {class:'tm-note'}, 'タグ「ストック」を付けると、撮ったレシートにあれば夜に自動で個数を足します。')),
    field('型番', model),
    hasReorder ? field('買う目安', reorder,
      h('p', {class:'tm-note'}, '合計がこの個数以下になったら「買う物」に出します。天然水など本数で判断できる物に入れてください。空欄なら、残り1個のときに「買い物メモに追加」を押して判断します。')) : '',
    h('div', {class:'field'},
      h('div', {class:'lot-edit lot-head'}, h('label', {}, '賞味期限'), h('label', {}, '個数'), h('span')),
      lotList,
      h('button', {type:'button', class:'cancel-btn', onclick:()=>addLotRow(null)}, '＋ 賞味期限を追加'),
      h('p', {class:'tm-note'}, '賞味期限の違うものを買い足したときは、行を追加して期限ごとに個数を入れてください。'))
  );
  tmFoot.append(save);

  // タグ候補はカテゴリの欄で選んだカテゴリのタグ。この商品に付いているタグを選択済みにしておく
  const picker = createTagPicker('e-tags-chips', 'e-tags-input');
  splitTags(g.tags).forEach(t=>picker.select(t));
  picker.render(stockAllTags());
  stockTagSync(picker, catSelect, catInput)();

  save.addEventListener('click', ()=>{
    const itemName = normText(name.value);
    if(!itemName){ toast('商品名を入力してください'); return; }
    const lots = lotRows.map(r=>({id:r.id, expirationDate:r.exp.value, stock:Number(r.count.value) || 0}));
    const exps = lots.map(l=>l.expirationDate);
    if(new Set(exps).size !== exps.length){ toast('同じ賞味期限の行が重複しています'); return; }
    // 数値の欄に数字以外を入れると value が空になるので、badInput でも確かめる
    const reorderText = reorder.value.trim();
    const reorderAt = parseReorderAt(reorderText);
    if(reorder.validity.badInput || (reorderText && reorderAt === '')){ toast('買う目安は0以上の整数で入れてください'); return; }
    save.disabled = true;
    save.textContent = '保存中…';
    tm.busy = true;
    postToGas({
      type:'stock', action:'editItem', oldName:g.name, itemName,
      category:getHybridValue(catSelect, catInput),
      location:getHybridValue(locSelect, locInput),
      tags:picker.value(),
      modelNumber:normText(model.value),
      reorderAt:hasReorder ? reorderAt : undefined,
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
