// やること：カテゴリのタブ → リストのカード（2列）→ リストの中（追加・丸のタップで完了・取り消し）→ 編集シート、リストとカテゴリの管理
// カテゴリは type（家事 / 買い物）を持ち、中のリストの動き（店・在庫とのつながり）を決める。リストの kind はカテゴリの type と同じ
// データは GAS の getReminders（起動時は getAll にまとめて取得）。タブを開くたびに読み込み直す（5分ごとの処理や在庫の変更で行が増えるため）
// 完了・取り消しはすぐ画面に反映し、失敗したら元に戻して読み込み直す
// 周期の入力欄は js/rule-editor.js、周期の計算は gas/chore-rule.js（GAS と共通）
// リストの画面は js/nav-stack.js でリストのカードの上に重ねる（右から入り、「‹ リスト」か左端からのスワイプで戻る）

// categoryId：選んでいるカテゴリのタブ（端末に覚えておく）
const TODO_CATEGORY_KEY = 'kurashilog.todoCategory';
const todo = {categories:[], lists:[], items:[], sale:{items:{}, verdicts:{}}, categoryId:todoLoadCategory(), listId:null, draft:'', doneOpen:false, loaded:false};
// カテゴリの種類（値はリストの kind と同じ）と、選ぶときの説明
const TODO_TYPES = [['家事', 'やること型', '期限・くり返し・担当で管理する'], ['買い物', '買い物型', '店ごとのリスト。クーポンや在庫とつながる']];
const TODO_ASSIGNEES = ['本人', '彼女'];
const TODO_COLORS = ['#E2BC7A', '#9DCBA4', '#9DBBDF', '#EE9F94', '#C9A6E4']; // リストの色の候補（空なら --chore）
const TODO_UNDO_MS = 5000; // 完了した直後に「取り消す」を出す時間
const TODO_CHORE_DONE_DAYS = 3; // 家事の完了を「完了」に出す日数（買い物は完了した翌日まで）
const TODO_INFO = {title:'やること', sub:'リストをタップして開く・丸のタップで完了'};

// preloaded：起動時にまとめて取得したデータ（あれば通信しない）
function loadReminders(preloaded){
  return (preloaded ? Promise.resolve(preloaded) : getFromGas('action=getReminders'))
    .then(d=>{
      todo.categories = d.categories || [];
      todo.lists = d.lists || [];
      todo.items = d.items || [];
      todo.sale = d.sale || {items:{}, verdicts:{}};
      todo.loaded = true;
      renderTodo();
    })
    .catch(todoShowLoadError);
}
// 読み込みに失敗したとき。表示中のデータがあれば残してトーストだけ出す（タブを開くたびの読み込み直しなど）
function todoShowLoadError(err){
  if(todo.loaded){ toast(errMsg(err)); return; }
  todoGridPage.replaceChildren(loadErrorView(err, ()=>{
    todoGridPage.replaceChildren(h('p', {class:'empty-msg'}, '読み込み中…'));
    loadReminders();
  }));
}
// タブを開いたとき（main.js から呼ぶ）。開いているタブをもう一度押したら、リストのカードに戻る
function todoTabShown(again){
  if(again && todoStack.depth() > 1) todoStack.pop();
  renderTodo();
  loadReminders();
}

// ---------- 画面の重ね方 ----------
// 下はリストのカード、上は開いているリスト（開いていなければ null）
const todoGridPage = h('div', {}, h('p', {class:'empty-msg'}, '読み込み中…'));
let todoListPage = null;
const todoStack = createNavStack(document.getElementById('todo-view'), todoGridPage, {
  onProgress:todoHeaderProgress,
  onPop:()=>{ todo.listId = null; todoListPage = null; renderTodo(); },
});
// リストを開く（右から入れる）
function todoOpenList(list){
  if(todoStack.busy() || todoStack.depth() > 1) return;
  closeCompose(); // リストの追加のパネルは、カードの画面でだけ使う
  todo.listId = list.id;
  todo.draft = '';
  todo.doneOpen = false;
  todoListPage = h('div', {class:'todo-list-page'}, todoListView(list));
  todoStack.push(todoListPage);
}
// ヘッダーの題名と説明（list が null ならリストのカードの画面）
function todoHeaderText(list){
  return list ? [list.name, '丸で完了・名前で編集・左端から右へスワイプで戻る'] : [TODO_INFO.title, TODO_INFO.sub];
}
function todoSetHeader(list){
  if(!todoTabActive()) return;
  pageHead.set(...todoHeaderText(list));
}
// 画面が動いている間のヘッダー（p：0＝リストの画面 〜 1＝リストのカードの画面）
// リストの題名とカードの画面の題名を、画面と同じ p・同じ長さで横にスライドさせて入れ替える
function todoHeaderProgress(p, dur){
  if(!todoTabActive()) return;
  const list = todo.listId ? todoListOf(todo.listId) : null;
  pageHead.track(todoHeaderText(list), todoHeaderText(null), p, dur);
}

// ---------- 小さな関数 ----------
const todoBySort = (a, b)=>(Number(a.sortOrder) || 0) - (Number(b.sortOrder) || 0);
function todoListOf(id){ return todo.lists.find(l=>String(l.id) === String(id)); }
function todoTypeLabel(type){ return (TODO_TYPES.find(([t])=>t === type) || [, type])[1]; }

// ---------- カテゴリ ----------
function todoLoadCategory(){
  try { return localStorage.getItem(TODO_CATEGORY_KEY) || null; } catch(_){ return null; }
}
function todoSelectCategory(c){
  todo.categoryId = c ? String(c.id) : null;
  try { localStorage.setItem(TODO_CATEGORY_KEY, todo.categoryId || ''); } catch(_){}
}
function todoCategories(){ return [...todo.categories].sort(todoBySort); }
// リストの入っているカテゴリ。categoryId がまだないリスト（setupReminderCategories の前に作ったものなど）は、種類が同じ最初のカテゴリに出す
function todoCategoryOfList(l){
  const cs = todoCategories();
  return cs.find(c=>String(c.id) === String(l.categoryId)) || cs.find(c=>c.type === l.kind) || null;
}
// 選んでいるカテゴリ（覚えていたカテゴリがなくなっていれば最初のカテゴリ。カテゴリがなければ null）
function todoCurrentCategory(){
  const cs = todoCategories();
  return cs.find(c=>String(c.id) === String(todo.categoryId)) || cs[0] || null;
}
// カテゴリのリスト（all なら非表示のリストも）。カテゴリがまだなければ全リスト
function todoListsIn(c, all = false){
  return todo.lists.filter(l=>(all || l.active) && (!c || todoCategoryOfList(l) === c)).sort(todoBySort);
}
function todoActiveLists(){ return todoListsIn(todoCurrentCategory()); }
function todoItemsOf(list){ return todo.items.filter(i=>String(i.listId) === String(list.id)); }
function todoRule(i){ return choreParseRule(i.rule); }
function todoDue(i){ return i.nextDue ? new Date(i.nextDue) : null; }
// 時刻を指定した行か（くり返しは rule.time。くり返しなしは期限が 0:00 ちょうどでなければ時刻あり。GAS と同じ）
function todoTimed(i){
  const r = todoRule(i);
  if(r) return !!r.time;
  const d = todoDue(i);
  return !!d && (d.getHours() !== 0 || d.getMinutes() !== 0);
}
function todoTomorrow(){ const d = choreDayStart(new Date()); d.setDate(d.getDate() + 1); return d; }
// まだ終わっていない：くり返しなしは status が空のもの、くり返しは今日までに期限が来たもの
function todoIsOpen(i){
  if(String(i.status || '') !== '') return false;
  if(!todoRule(i)) return true;
  const d = todoDue(i);
  return !!d && d < todoTomorrow();
}
// 先の予定のくり返し（件数には数えない）
function todoIsLater(i){ return String(i.status || '') === '' && !!todoRule(i) && !todoIsOpen(i); }
// 完了の欄に出すか：買い物は完了した翌日まで、家事は完了から3日
function todoDoneVisible(list, when){
  if(list.kind === '買い物') return choreDiffDays(new Date(), when) <= 1;
  return Date.now() - when.getTime() <= TODO_CHORE_DONE_DAYS * 86400000;
}
// 完了の欄：くり返しなしは status=done、くり返しは lastDone。新しい順
function todoDoneEntries(list){
  return todoItemsOf(list).map(i=>{
    const when = todoRule(i) ? (i.lastDone ? new Date(i.lastDone) : null) : (i.status === 'done' && i.doneAt ? new Date(i.doneAt) : null);
    return when && !isNaN(when) && todoDoneVisible(list, when) ? {i, when} : null;
  }).filter(Boolean).sort((a, b)=>b.when - a.when);
}
function todoWhenText(d){
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2,'0')}`;
}
function todoQtyText(qty){
  const q = normText(qty);
  return !q ? '' : /^\d+$/.test(q) ? `×${q}` : q;
}
// その店の、いま使えるクーポン（未使用で、使える期間内）。店名の合わせ方は gas/shared.js の storeKey（GAS と共通）
function todoStoreCoupons(list){
  const aliases = storeAliases(list.store);
  if(!aliases.length) return [];
  return couponList.filter(c=>{
    if(String(c.status || '') !== '' || !aliases.includes(storeKey(c.store))) return false;
    const from = toDateInputValue(c.validFrom), until = toDateInputValue(c.validUntil);
    return (!from || daysFromToday(from) <= 0) && (!until || daysFromToday(until) >= 0);
  });
}
// 在庫の商品名（正規化したもの）→ 商品のまとまり（js/stock.js の groupStock）
function todoStockMap(){
  const map = new Map();
  groupStock().forEach(g=>map.set(normText(g.name), g));
  return map;
}

// ---------- 描画 ----------
function todoTabActive(){
  const b = document.querySelector('nav.tabbar button.active');
  return !!b && b.dataset.tab === 'todo';
}
// リストのカードと、開いているリストの画面を描き直す。画面が動いている間は、動き終わってから描く
function renderTodo(){
  if(todoStack.busy()){
    if(!renderTodo.waiting){
      renderTodo.waiting = true;
      todoStack.whenIdle(()=>{ renderTodo.waiting = false; renderTodo(); });
    }
    return;
  }
  const list = todo.listId ? todoListOf(todo.listId) : null;
  if(todo.listId && !list){ todoStack.pop(); return; } // 開いていたリストがなくなった（onPop で描き直す）
  todoSetHeader(list);
  todoGridPage.replaceChildren(...todoGridView());
  if(list && todoListPage){
    // 追加の入力欄に入力中なら、描き直した後も続けて入力できるようにする
    const typing = document.activeElement && document.activeElement.classList.contains('todo-add-input');
    todoListPage.replaceChildren(...todoListView(list));
    if(typing){ const input = todoListPage.querySelector('.todo-add-input'); if(input) input.focus(); }
  }
}

// カテゴリのタブと、選んでいるカテゴリのリストのカード（2列）
function todoGridView(){
  const cur = todoCurrentCategory();
  const head = h('div', {class:'list-head'},
    h('div', {class:'section-title'}, 'リスト'),
    h('button', {type:'button', class:'edit-toggle', onclick:()=>openSheet('todo', tmTodoListsView)}, 'リストの管理'));
  const lists = todoActiveLists();
  const out = [todoCategoryTabs(cur), head];
  if(!lists.length) out.push(h('p', {class:'empty-msg'}, cur ? `「${cur.name}」にリストはまだありません。右下の＋から作れます` : 'リストがありません（GAS の setupReminders を実行してください）'));
  else out.push(h('div', {class:'todo-grid'}, lists.map(todoListCard)));
  return out;
}
// カテゴリのタブ（在庫のカテゴリのタブと同じ見た目）。数字はまだ終わっていない件数。右端の「管理」でカテゴリの管理を開く
function todoCategoryTabs(cur){
  const cs = todoCategories();
  const wrap = h('div', {class:'cat-tabs todo-cats', role:'tablist', 'aria-label':'カテゴリ'});
  if(!cs.length){
    wrap.append(h('button', {type:'button', class:'chip', onclick:()=>openSheet('todo', tmTodoCategoriesView)}, 'カテゴリを作る'));
    return wrap;
  }
  cs.forEach(c=>{
    const open = todoListsIn(c).reduce((n, l)=>n + todoItemsOf(l).filter(todoIsOpen).length, 0);
    wrap.append(h('button', {type:'button', role:'tab', class:'chip' + (c === cur ? ' on' : ''), 'aria-selected':String(c === cur), onclick:()=>{
      if(c === cur) return;
      todoSelectCategory(c);
      renderTodo();
    }}, c.name, rollNumber(h('span', {class:'n'}), 'todoCat:' + c.id, open)));
  });
  wrap.append(h('button', {type:'button', class:'chip todo-cats-manage', onclick:()=>openSheet('todo', tmTodoCategoriesView)}, '管理'));
  // 選んでいるタブが横にはみ出していれば、タブの行だけを横にずらして見せる
  requestAnimationFrame(()=>{
    const on = wrap.querySelector('.on');
    if(!on || !wrap.isConnected) return;
    const r = on.getBoundingClientRect(), w = wrap.getBoundingClientRect();
    if(r.left < w.left || r.right > w.right) wrap.scrollLeft += r.left - w.left - 16;
  });
  return wrap;
}
function todoListCard(list){
  const items = todoItemsOf(list);
  const open = items.filter(todoIsOpen);
  const hint = list.kind === '買い物' ? todoShopHint(list) : todoChoreHint(open, items);
  return h('button', {type:'button', class:'todo-card' + (open.length ? '' : ' empty'), style:list.color ? `--list:${list.color}` : '', onclick:()=>todoOpenList(list)},
    h('div', {class:'todo-card-name'}, list.name),
    h('div', {class:'todo-card-count'}, rollNumber(h('span'), 'todo:' + list.id, open.length), h('small', {}, '件')),
    h('div', {class:'todo-card-hint'}, hint || ' '));
}
// 家事のカードの一言：「期限切れ1件・今日2件」。どちらもなければ次の予定
function todoChoreHint(open, items){
  const today = choreDayStart(new Date());
  const tomorrow = todoTomorrow();
  const late = open.filter(i=>todoDue(i) && todoDue(i) < today).length;
  const now = open.filter(i=>todoDue(i) && todoDue(i) >= today && todoDue(i) < tomorrow).length;
  const parts = [late ? `期限切れ${late}件` : '', now ? `今日${now}件` : ''].filter(Boolean);
  if(parts.length) return parts.join('・');
  const next = items.filter(i=>String(i.status || '') === '' && todoDue(i) && todoDue(i) >= tomorrow).sort((a, b)=>todoDue(a) - todoDue(b))[0];
  return next ? `次は${choreDueText(todoDue(next), todoTimed(next)).text}` : '';
}
// 買い物のカードの一言：今日・明日のくり返しの日（「明日 ふくちゃんデー」）を先に、次に使えるクーポン。残りは「ほか n件」
function todoShopHint(list){
  const parts = [];
  todoStoreCoupons(list).forEach(c=>{
    const r = parseRepeat(c.repeat);
    if(!r){ parts.push({k:2, t:c.title}); return; }
    const next = nextRepeatDate(c, r);
    const d = next ? daysFromToday(next) : null;
    if(d === 0) parts.push({k:0, t:`今日 ${c.title}`});
    else if(d === 1) parts.push({k:1, t:`明日 ${c.title}`});
  });
  if(!parts.length) return '';
  parts.sort((a, b)=>a.k - b.k);
  return parts[0].t + (parts.length > 1 ? ` ほか${parts.length - 1}件` : '');
}

// リストの中
function todoListView(list){
  const shop = list.kind === '買い物';
  const back = h('button', {type:'button', class:'todo-back', onclick:()=>todoStack.pop()}, '‹ リスト');
  const input = h('input', {type:'text', class:'todo-add-input', placeholder:shop ? '品目を追加（例：牛乳）' : 'やることを追加', value:todo.draft,
    enterKeyHint:'enter', oninput:e=>{ todo.draft = e.target.value; }});
  const add = h('form', {class:'todo-add', onsubmit:e=>{ e.preventDefault(); todoQuickAdd(list, input); }},
    input, h('button', {type:'submit', class:'tm-btn'}, '追加'));
  const more = h('button', {type:'button', class:'text-btn todo-more', onclick:()=>openSheet('todo', tmTodoItemView, null, list)},
    shop ? '＋ 個数・メモ・期限を付けて追加' : '＋ 期限・くり返し・担当を付けて追加');

  const items = todoItemsOf(list);
  const tomorrow = todoTomorrow();
  const byDue = (a, b)=>(todoDue(a) ? todoDue(a).getTime() : Infinity) - (todoDue(b) ? todoDue(b).getTime() : Infinity);
  const byCreated = (a, b)=>String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
  const open = items.filter(todoIsOpen);
  const sections = [
    ['今日まで', open.filter(i=>todoDue(i) && todoDue(i) < tomorrow).sort(byDue)],
    ['期限なし', open.filter(i=>!todoDue(i)).sort(byCreated)],
    ['今後の予定', items.filter(i=>(todoIsOpen(i) && todoDue(i) && todoDue(i) >= tomorrow) || todoIsLater(i)).sort(byDue)],
  ].filter(([, rows])=>rows.length);
  const stock = shop ? todoStockMap() : null;
  const out = [back, add, more];
  if(!sections.length) out.push(h('p', {class:'empty-msg small'}, shop ? '買う物はありません' : 'やることはありません'));
  sections.forEach(([title, rows])=>{
    // 期限なしだけのとき（買い物でよくある）は見出しを出さない
    if(sections.length > 1 || title !== '期限なし') out.push(h('div', {class:'chore-month'}, h('span', {}, title)));
    rows.forEach(i=>out.push(todoItemRow(i, list, false, stock)));
  });
  const done = todoDoneEntries(list);
  if(done.length){
    const box = h('details', {class:'todo-done', ontoggle:e=>{ todo.doneOpen = e.target.open; }},
      h('summary', {}, `完了 ${done.length}件`), done.map(({i})=>todoItemRow(i, list, true, stock)));
    box.open = todo.doneOpen;
    out.push(box);
  }
  return out;
}

// 1件の行：丸（完了）・名前・個数・期限・印
function todoItemRow(i, list, done, stock){
  const rule = todoRule(i);
  const auto = done && i.doneBy === '自動';
  // 完了の欄の丸：くり返しなしは押すと取り消す。くり返し（前の予定が分からない）と自動で完了したもの（在庫が足りている）は押せない
  const fixed = done && (!!rule || auto);
  const check = h('button', {type:'button', class:'todo-check' + (done ? ' on' : ''), disabled:fixed,
    'aria-label':done ? '完了を取り消す' : '完了にする', onclick:()=>done ? todoReopen(i) : todoTapCheck(i, list)});
  const meta = [];
  if(done){
    if(rule){
      meta.push(`完了 ${todoWhenText(new Date(i.lastDone))}`);
      if(todoDue(i)) meta.push(`次回 ${choreDueText(todoDue(i), todoTimed(i)).text}`);
    } else {
      meta.push(auto ? '在庫が足りたので自動で完了' : `完了 ${todoWhenText(new Date(i.doneAt))}`);
    }
  } else {
    const due = todoDue(i);
    if(due){ const d = choreDueText(due, todoTimed(i)); meta.push(h('span', {class:'exp ' + d.cls}, d.text)); }
    else if(rule) meta.push('該当する日がありません');
    if(i.cycle) meta.push(i.cycle);
  }
  if(i.assignee) meta.push(i.assignee);
  if(i.memo) meta.push(i.memo);
  const marks = stock && !done ? todoShopMarks(i, stock) : [];
  const main = h('div', {class:'todo-main', onclick:()=>openSheet('todo', tmTodoItemView, i, list)},
    h('div', {class:'todo-title'}, h('span', {}, i.title), i.qty ? h('span', {class:'todo-qty'}, todoQtyText(i.qty)) : ''),
    meta.length ? h('div', {class:'card-meta'}, meta.flatMap((m, n)=>n ? [' ・ ', m] : [m])) : '',
    marks.length ? h('div', {class:'todo-marks'}, marks.map(([text, cls])=>h('span', {class:'todo-mark ' + cls}, text))) : '');
  return h('div', {class:'todo-row' + (done ? ' done' : '')}, check, main);
}
// 買い物の品目の印：在庫の数・セールチェックの判定・1回に買う上限
function todoShopMarks(i, stock){
  const marks = [];
  const g = i.stockItemName ? stock.get(normText(i.stockItemName)) : null;
  if(g){
    const total = stockTotal(g);
    marks.push([g.reorderAt !== '' ? `在庫${total}/目安${g.reorderAt}` : `在庫${total}`, total === 0 ? 'warn' : '']);
  }
  const key = normText(i.stockItemName || i.title);
  const verdict = todo.sale.verdicts[key];
  if(verdict === '待ち') marks.push(['セール待ち', 'wait']);
  if(verdict === '買い') marks.push(['ネットで買い', 'buy']);
  const item = todo.sale.items[key];
  if(item && item.pack) marks.push([item.pack, '']);
  return marks;
}

// ---------- 追加 ----------
// 名前だけですぐに追加する（個数・期限などは編集シートで）
function todoQuickAdd(list, input){
  const title = normText(input.value);
  if(!title) return;
  input.value = '';
  todo.draft = '';
  postToGas({type:'reminder', action:'add', listId:list.id, title})
    .then(res=>{
      if(res.status !== 'success') throw new Error(res.message || '追加に失敗しました');
      todo.items.push(res.item);
      renderTodo();
    })
    .catch(err=>{
      toast(errMsg(err));
      // 入れた文字を戻す（ほかの文字を入れ始めていなければ）
      if(!todo.draft){ todo.draft = title; renderTodo(); }
    });
}

// ---------- 完了・取り消し ----------
// 在庫に足すか聞くリスト（askStock）では、くり返しでない品目をチェックしたときに個数を聞く
function todoTapCheck(i, list){
  if(list.askStock && !todoRule(i)){ openSheet('todo', tmTodoAskStockView, i, list); return; }
  todoComplete(i, null);
}
// 画面をすぐ完了にして GAS に送る。下に「取り消す」を出す
// stockQty：在庫に足す個数（足さないなら null）
function todoComplete(i, stockQty){
  const prev = {status:i.status, doneAt:i.doneAt, doneBy:i.doneBy, lastDone:i.lastDone, nextDue:i.nextDue, notifiedFor:i.notifiedFor};
  const rule = todoRule(i);
  const now = new Date();
  if(rule){
    const next = choreNextAfterDone(rule, now, todoDue(i));
    Object.assign(i, {lastDone:now.toISOString(), nextDue:next ? next.toISOString() : ''});
  } else {
    Object.assign(i, {status:'done', doneAt:now.toISOString(), doneBy:'アプリ'});
  }
  renderTodo();
  const req = postToGas({type:'reminder', action:'done', id:i.id, addStock:stockQty || undefined})
    .then(res=>{
      if(res.status !== 'success') throw new Error(res.message || '更新に失敗しました');
      Object.assign(i, res.item);
      renderTodo();
      if(stockQty) loadStock();
      return true;
    })
    .catch(err=>{
      Object.assign(i, prev);
      renderTodo();
      hideTodoUndo();
      toast(errMsg(err));
      loadReminders(); // 時間切れでも GAS 側では完了済みのことがあるため、実際の状態に合わせる
      return false;
    });
  const next = rule && todoDue(i) ? `。次回：${choreDueText(todoDue(i), !!rule.time).text}` : '';
  showTodoUndo(`「${i.title}」を完了${stockQty ? `（在庫に${stockQty}個）` : ''}${next}`, ()=>{
    req.then(ok=>{ if(ok) todoUndo(i, prev, stockQty); });
  });
}
// 完了を取り消す（くり返しは完了する前の lastDone・nextDue に戻す。在庫に足した分は減らす）
function todoUndo(i, prev, stockQty){
  const rule = todoRule(i);
  const cur = {...i};
  Object.assign(i, rule ? {lastDone:prev.lastDone, nextDue:prev.nextDue, notifiedFor:prev.notifiedFor} : {status:'', doneAt:'', doneBy:''});
  renderTodo();
  postToGas({type:'reminder', action:'undo', id:i.id, removeStock:stockQty || undefined,
    prev:rule ? {lastDone:prev.lastDone || '', nextDue:prev.nextDue || '', notifiedFor:prev.notifiedFor || ''} : undefined})
    .then(res=>{
      if(res.status !== 'success') throw new Error(res.message || '取り消せませんでした');
      Object.assign(i, res.item);
      renderTodo();
      if(stockQty) loadStock();
      toast('取り消しました');
    })
    .catch(err=>{ Object.assign(i, cur); renderTodo(); toast(errMsg(err)); loadReminders(); });
}
// 完了の欄の丸を押したとき（くり返しなしだけ）：まだの状態に戻す
function todoReopen(i){ todoUndo(i, null, null); }

// 「取り消す」の帯（タブバーの上に TODO_UNDO_MS のあいだ出す）
const todoUndoBar = h('div', {id:'undo-bar', role:'status'});
document.body.append(todoUndoBar);
function showTodoUndo(text, onUndo){
  clearTimeout(showTodoUndo._t);
  todoUndoBar.replaceChildren(h('span', {}, text), h('button', {type:'button', onclick:()=>{ hideTodoUndo(); onUndo(); }}, '取り消す'));
  todoUndoBar.classList.add('show');
  showTodoUndo._t = setTimeout(hideTodoUndo, TODO_UNDO_MS);
}
function hideTodoUndo(){
  clearTimeout(showTodoUndo._t);
  todoUndoBar.classList.remove('show');
}

// 在庫に足すか聞く（askStock のリスト）
function tmTodoAskStockView(i, list){
  tmTitle.textContent = '在庫に足す？';
  const name = i.stockItemName || i.title;
  const qty = h('input', {type:'number', min:'1', step:'1', inputMode:'numeric', value:String(parseInt(normText(i.qty), 10) || 1)});
  tmBody.append(
    h('p', {class:'tm-lead'}, `「${i.title}」を完了にします。在庫の「${name}」に足しますか？`),
    field('足す個数', qty),
    h('p', {class:'tm-note'}, '在庫の登録と同じく、賞味期限なしの分に足します。レシートを撮る物は、夜の自動追加と二重にならないよう「足さずに完了」を選んでください。'));
  tmFoot.append(h('div', {class:'tm-pair'},
    h('button', {type:'button', class:'cancel-btn', onclick:()=>{ closeSheet(); todoComplete(i, null); }}, '足さずに完了'),
    h('button', {type:'button', class:'tm-btn', onclick:()=>{
      const n = Number(qty.value);
      if(!(n > 0) || Math.floor(n) !== n){ toast('個数は1以上の整数で入れてください'); return; }
      closeSheet();
      todoComplete(i, n);
    }}, '足して完了')));
}

// ---------- 追加・編集のシート ----------
// i：編集する行（追加なら null）、list：入れるリスト
function tmTodoItemView(i, list){
  tmTitle.textContent = i ? '編集' : '追加';
  const title = h('input', {type:'text', value:i ? i.title : todo.draft});
  const qty = h('input', {type:'text', value:i ? (i.qty ?? '') : '', placeholder:'例：2 ／ 2袋'});
  const memo = h('input', {type:'text', value:i ? (i.memo || '') : ''});
  // 移す先のリスト（カテゴリごとにまとめる。非表示のリストも、今入っているリストなら出す）
  const listOption = l=>h('option', {value:String(l.id)}, l.name);
  const movable = l=>l.active || String(l.id) === String(list.id);
  const cs = todoCategories();
  const listSel = h('select', {}, cs.length
    ? cs.map(c=>todoListsIn(c, true).filter(movable)).map((ls, n)=>ls.length ? h('optgroup', {label:cs[n].name}, ls.map(listOption)) : '')
    : todo.lists.filter(movable).sort(todoBySort).map(listOption));
  listSel.value = String(list.id);
  // 担当（なし・本人・彼女）
  let assignee = i ? (i.assignee || '') : '';
  const assigneeSeg = h('div', {class:'seg'}, ['', ...TODO_ASSIGNEES].map(a=>h('button', {type:'button', class:a === assignee ? 'on' : '', onclick:e=>{
    assignee = a;
    assigneeSeg.querySelectorAll('button').forEach(b=>b.classList.toggle('on', b === e.currentTarget));
  }}, a || 'なし')));
  // 期限：期限なし・1回だけ（日付と、任意で時刻）・くり返す（周期の入力欄）
  const rule = i ? todoRule(i) : null;
  const due = i && !rule ? todoDue(i) : null;
  let mode = rule ? 'repeat' : due ? 'once' : 'none';
  const pad = n=>String(n).padStart(2, '0');
  const date = h('input', {type:'date', value:due ? `${due.getFullYear()}-${pad(due.getMonth() + 1)}-${pad(due.getDate())}` : todayStr()});
  const time = h('input', {type:'time', value:due && todoTimed(i) ? `${pad(due.getHours())}:${pad(due.getMinutes())}` : ''});
  const once = h('div', {}, h('div', {class:'pair'}, date, time), h('p', {class:'tm-note'}, '時刻を入れると、その時刻に通知します（空なら、その日の朝8:00にまとめて通知）。'));
  const editor = createRuleEditor(rule, rule ? i : null);
  const modeSeg = h('div', {class:'seg'}, [['none', '期限なし'], ['once', '1回だけ'], ['repeat', 'くり返す']].map(([k, label])=>h('button', {type:'button', value:k, onclick:()=>{ mode = k; syncMode(); }}, label)));
  const syncMode = ()=>{
    modeSeg.querySelectorAll('button').forEach(b=>b.classList.toggle('on', b.value === mode));
    once.hidden = mode !== 'once';
    editor.el.hidden = mode !== 'repeat';
  };
  syncMode();

  const save = h('button', {type:'button', class:'tm-btn tm-wide'}, i ? '保存' : '追加');
  tmBody.append(
    field('名前', title),
    h('div', {class:'row2'}, field('個数', qty), field('担当', assigneeSeg)),
    field('メモ', memo),
    field('リスト', listSel),
    field('期限', modeSeg),
    once, editor.el,
    i && i.source === '在庫' ? h('p', {class:'tm-note'}, `在庫の「${i.stockItemName}」が買う物になったので作った品目です。在庫が足りると自動で完了になります。`) : '',
    i && i.source !== '在庫' && i.stockItemName ? h('p', {class:'tm-note'}, `在庫の「${i.stockItemName}」の数を出しています（手で入れた品目なので、在庫が足りても自動では完了になりません）。`) : '');
  if(i){
    const deleteBtn = makeHoldButton('長押しで削除', reset=>{
      tm.busy = true;
      postToGas({type:'reminder', action:'delete', id:i.id})
        .then(res=>{
          if(res.status !== 'success') throw new Error(res.message || '削除に失敗しました');
          todo.items = todo.items.filter(x=>x !== i);
          tm.busy = false;
          closeSheet();
          renderTodo();
          toast('削除しました');
        })
        .catch(err=>{ tm.busy = false; toast(errMsg(err)); reset(); });
    });
    tmBody.append(h('div', {class:'tm-section tm-danger'},
      h('h3', {}, '削除'),
      h('p', {class:'tm-note'}, i.source === '在庫'
        ? '在庫とつながる品目です。削除すると、在庫がいったん足りる（買う物でなくなる）まで作り直しません。'
        : 'スプレッドシートからこの行が削除されます。元に戻すことはできません。'),
      deleteBtn));
  }
  tmFoot.append(save);

  save.addEventListener('click', ()=>{
    const payload = {type:'reminder', action:i ? 'edit' : 'add', id:i ? i.id : undefined, listId:listSel.value,
      title:normText(title.value), qty:normText(qty.value), memo:normText(memo.value), assignee, rule:null, due:''};
    if(!payload.title){ toast('名前を入れてください'); return; }
    if(mode === 'once'){
      if(!date.value){ toast('期限の日付を入れてください'); return; }
      payload.due = date.value + (time.value ? 'T' + time.value : '');
    }
    if(mode === 'repeat'){
      payload.rule = editor.get();
      const err = choreValidate(payload.rule);
      if(err){ toast(err); return; }
    }
    save.disabled = true;
    save.textContent = '保存中…';
    tm.busy = true;
    postToGas(payload)
      .then(res=>{
        if(res.status !== 'success') throw new Error(res.message || '保存に失敗しました');
        if(i) Object.assign(i, res.item); else todo.items.push(res.item);
        if(!i) todo.draft = '';
        tm.busy = false;
        closeSheet();
        renderTodo();
        toast(i ? '保存しました' : '追加しました');
      })
      .catch(err=>{ tm.busy = false; toast(errMsg(err)); save.disabled = false; save.textContent = i ? '保存' : '追加'; });
  });
}

// ---------- リストの管理 ----------
// 選んでいるカテゴリのリストの一覧（↑↓で並べ替え、タップで編集）。リストの追加は右下の＋から
function tmTodoListsView(){
  const cur = todoCurrentCategory();
  tmTitle.textContent = cur ? `${cur.name}のリスト` : 'リストの管理';
  const all = [...todo.lists].sort(todoBySort);
  const lists = todoListsIn(cur, true);
  // 入れ替えるのはカテゴリの中の隣どうし。sortOrder は全リストの通し番号なので、全体の並びの中で2つの位置を入れ替えて振り直す
  const move = (n, d)=>{
    const m = n + d;
    if(m < 0 || m >= lists.length || tm.busy) return;
    const a = all.indexOf(lists[n]), b = all.indexOf(lists[m]);
    [all[a], all[b]] = [all[b], all[a]];
    all.forEach((l, k)=>{ l.sortOrder = k + 1; });
    tmRender();
    renderTodo();
    tm.busy = true;
    postToGas({type:'reminderList', action:'reorder', ids:all.map(l=>l.id)})
      .then(res=>{ if(res.status !== 'success') throw new Error(res.message || '並べ替えに失敗しました'); })
      .catch(err=>{ toast(errMsg(err)); loadReminders().then(()=>{ if(tm.stack.length) tmRender(); }); })
      .finally(()=>{ tm.busy = false; });
  };
  tmBody.append(h('div', {class:'tm-section'},
    h('h3', {}, 'リスト（上から順にカードを並べます）'),
    lists.length ? lists.map((l, n)=>h('div', {class:'todo-list-row' + (l.active ? '' : ' off')},
      h('button', {type:'button', class:'tm-row', onclick:()=>tmShow(tmTodoListEditView, l)},
        h('span', {class:'todo-dot', style:l.color ? `background:${l.color}` : ''}),
        h('span', {class:'name'}, l.name),
        h('span', {class:'count'}, l.active ? '' : '非表示'),
        h('span', {class:'chev'}, '›')),
      h('button', {type:'button', class:'lot-remove', disabled:n === 0, 'aria-label':'上へ', onclick:()=>move(n, -1)}, '↑'),
      h('button', {type:'button', class:'lot-remove', disabled:n === lists.length - 1, 'aria-label':'下へ', onclick:()=>move(n, 1)}, '↓')))
      : h('p', {class:'tm-note'}, 'リストはまだありません。右下の＋から作れます。')));
}
// リストの編集：名前・カテゴリ（種類が同じカテゴリだけ）・店・色・在庫に足すか聞く・表示
function tmTodoListEditView(l){
  tmTitle.textContent = 'リストを編集';
  const name = h('input', {type:'text', value:l.name});
  const cats = todoCategories().filter(c=>c.type === l.kind);
  const catSel = h('select', {}, cats.map(c=>h('option', {value:String(c.id)}, c.name)));
  const cur = todoCategoryOfList(l);
  if(cur) catSel.value = String(cur.id);
  let color = l.color || '';
  const colors = todoColorChips(color, c=>{ color = c; });
  const shop = todoShopFields(l);
  const active = h('input', {type:'checkbox', checked:!!l.active});
  const save = h('button', {type:'button', class:'tm-btn tm-wide'}, '保存');
  tmBody.append(field('名前', name),
    field('カテゴリ', catSel, h('p', {class:'tm-note'}, `移せるのは${todoTypeLabel(l.kind)}のカテゴリだけです。`)),
    l.kind === '買い物' ? shop.el : '', field('色', colors),
    h('label', {class:'check'}, active, 'カードを表示する（外すと非表示。品目はシートに残ります）'));
  tmFoot.append(save);
  save.addEventListener('click', ()=>{
    const n = normText(name.value);
    if(!n){ toast('リストの名前を入れてください'); return; }
    save.disabled = true;
    save.textContent = '保存中…';
    tm.busy = true;
    postToGas({type:'reminderList', action:'edit', id:l.id, name:n, categoryId:catSel.value, store:shop.store.value, color,
      askStock:shop.askStock.checked, active:active.checked})
      .then(res=>{
        if(res.status !== 'success') throw new Error(res.message || '保存に失敗しました');
        Object.assign(l, res.list);
        tm.busy = false;
        renderTodo();
        tm.stack.pop();
        tmRender();
        toast('保存しました');
      })
      .catch(err=>{ tm.busy = false; toast(errMsg(err)); save.disabled = false; save.textContent = '保存'; });
  });
}

// リストの編集と追加で共通の部品
// 色の候補（onPick に選んだ色を渡す。空は色なし）
function todoColorChips(color, onPick){
  const wrap = h('div', {class:'chips'}, ['', ...TODO_COLORS].map(c=>h('button', {type:'button', class:'chip todo-color' + (c === color ? ' on' : ''),
    style:c ? `--swatch:${c}` : '', 'aria-label':c || '色なし', onclick:e=>{
      onPick(c);
      wrap.querySelectorAll('.chip').forEach(b=>b.classList.toggle('on', b === e.currentTarget));
    }}, c ? '' : 'なし')));
  return wrap;
}
// 買い物型のリストだけの欄：店・在庫に足すか聞く
function todoShopFields(l){
  const store = h('input', {type:'text', value:l.store || '', placeholder:'例：DAISO,ダイソー'});
  const askStock = h('input', {type:'checkbox', checked:!!l.askStock});
  const el = h('div', {},
    field('店', store, h('p', {class:'tm-note'}, 'クーポンの店名や、在庫の品目を入れる店の判断に使います。呼び方が違うときは「,」で区切って並べます（先頭の名前がクーポンの店名と合うように）。空なら、店が決まらない在庫の品目の行き先になります。')),
    h('label', {class:'check'}, askStock, 'チェックしたときに在庫に足すか聞く'));
  return {el, store, askStock};
}

// ---------- カテゴリの管理（在庫のタグ管理と同じ流れ） ----------
// 一覧（新しいカテゴリを作る・↑↓でタブを並べ替え）→ カテゴリの詳細（名前の変更・リストを入れる・削除）→ 入れるリストを選ぶ
function tmTodoCategoriesView(){
  tmTitle.textContent = 'カテゴリの管理';
  const cs = todoCategories();
  const name = h('input', {type:'text', placeholder:'例：用事'});
  const type = h('select', {}, TODO_TYPES.map(([t, label])=>h('option', {value:t}, label)));
  const next = h('button', {type:'button', class:'tm-btn'}, '次へ');
  next.addEventListener('click', ()=>{
    const n = normText(name.value);
    if(!n){ toast('カテゴリの名前を入れてください'); return; }
    next.disabled = true;
    tm.busy = true;
    postToGas({type:'reminderCategory', action:'add', name:n, type:type.value})
      .then(res=>{
        if(res.status !== 'success') throw new Error(res.message || '追加に失敗しました');
        todo.categories.push(res.category);
        tm.busy = false;
        renderTodo();
        tmShow(tmTodoCategoryView, res.category); // リストを続けて入れられるように詳細を開く
      })
      .catch(err=>{ tm.busy = false; next.disabled = false; toast(errMsg(err)); });
  });
  const move = (n, d)=>{
    const m = n + d;
    if(m < 0 || m >= cs.length || tm.busy) return;
    [cs[n], cs[m]] = [cs[m], cs[n]];
    cs.forEach((c, k)=>{ c.sortOrder = k + 1; });
    tmRender();
    renderTodo();
    tm.busy = true;
    postToGas({type:'reminderCategory', action:'reorder', ids:cs.map(c=>c.id)})
      .then(res=>{ if(res.status !== 'success') throw new Error(res.message || '並べ替えに失敗しました'); })
      .catch(err=>{ toast(errMsg(err)); loadReminders().then(()=>{ if(tm.stack.length) tmRender(); }); })
      .finally(()=>{ tm.busy = false; });
  };
  tmBody.append(
    h('div', {class:'tm-section'},
      h('h3', {}, '新しいカテゴリを作る'),
      h('div', {class:'tm-inline'}, name, type, next),
      TODO_TYPES.map(([, label, note])=>h('p', {class:'tm-note'}, `${label}：${note}`))),
    h('div', {class:'tm-section'},
      h('h3', {}, '登録済みのカテゴリ（上から順にタブを並べます）'),
      cs.length ? cs.map((c, n)=>h('div', {class:'todo-list-row'},
        h('button', {type:'button', class:'tm-row', onclick:()=>tmShow(tmTodoCategoryView, c)},
          h('span', {class:'name'}, c.name),
          h('span', {class:'count'}, `${todoTypeLabel(c.type)}・${todoListsIn(c, true).length}リスト`),
          h('span', {class:'chev'}, '›')),
        h('button', {type:'button', class:'lot-remove', disabled:n === 0, 'aria-label':'上へ', onclick:()=>move(n, -1)}, '↑'),
        h('button', {type:'button', class:'lot-remove', disabled:n === cs.length - 1, 'aria-label':'下へ', onclick:()=>move(n, 1)}, '↓')))
        : h('p', {class:'tm-note'}, 'カテゴリはまだありません')));
}
// カテゴリの詳細：名前の変更・リストを入れる・削除（リストが入っている間は削除できない）
function tmTodoCategoryView(c){
  tmTitle.textContent = c.name;
  const lists = todoListsIn(c, true);
  const input = h('input', {type:'text', value:c.name});
  const renameBtn = h('button', {type:'button', class:'tm-btn', onclick:()=>{
    const n = normText(input.value);
    if(!n || n === c.name) return;
    renameBtn.disabled = true;
    tm.busy = true;
    postToGas({type:'reminderCategory', action:'rename', id:c.id, name:n})
      .then(res=>{
        if(res.status !== 'success') throw new Error(res.message || '変更に失敗しました');
        Object.assign(c, res.category);
        tm.busy = false;
        renderTodo();
        tmRender();
        toast('名前を変更しました');
      })
      .catch(err=>{ tm.busy = false; renameBtn.disabled = false; toast(errMsg(err)); });
  }}, '変更');
  const movable = todo.lists.some(l=>l.kind === c.type && todoCategoryOfList(l) !== c);
  const deleteBtn = makeHoldButton('長押しでカテゴリを削除', reset=>{
    tm.busy = true;
    postToGas({type:'reminderCategory', action:'delete', id:c.id})
      .then(res=>{
        if(res.status !== 'success') throw new Error(res.message || '削除に失敗しました');
        todo.categories = todo.categories.filter(x=>x !== c);
        tm.busy = false;
        renderTodo();
        tm.stack.pop();
        tmRender();
        toast(`「${c.name}」を削除しました`);
      })
      .catch(err=>{ tm.busy = false; toast(errMsg(err)); reset(); });
  });
  tmBody.append(
    h('p', {class:'tm-note tm-lead'}, `${todoTypeLabel(c.type)}・リスト${lists.length}件` + (lists.length ? `（${lists.map(l=>l.name).join('・')}）` : '')),
    h('div', {class:'tm-section'},
      h('h3', {}, '名前を変更'),
      h('div', {class:'tm-inline'}, input, renameBtn)),
    h('div', {class:'tm-section'},
      h('h3', {}, 'リストを入れる'),
      movable
        ? h('button', {type:'button', class:'tm-btn tm-wide', onclick:()=>tmShow(tmTodoCategoryMoveView, c)}, '入れるリストを選ぶ')
        : h('p', {class:'tm-note'}, `ほかのカテゴリに${todoTypeLabel(c.type)}のリストがありません。新しいリストは右下の＋から作れます。`)),
    h('div', {class:'tm-section tm-danger'},
      h('h3', {}, '削除'),
      lists.length
        ? h('p', {class:'tm-note'}, 'リストが入っている間は削除できません。先に、ほかのカテゴリの「リストを入れる」で移してください。')
        : [h('p', {class:'tm-note'}, 'このカテゴリのタブがなくなります。'), deleteBtn]));
}
// カテゴリにリストを入れる：種類が同じ、ほかのカテゴリのリストを選ぶ（在庫のタグの「付ける行を選ぶ」と同じ）
function tmTodoCategoryMoveView(c){
  tmTitle.textContent = `「${c.name}」に入れる`;
  const selected = new Set();
  const submit = h('button', {type:'button', class:'tm-btn tm-wide'});
  const update = ()=>{
    submit.disabled = selected.size === 0;
    submit.textContent = selected.size ? `${selected.size}件を入れる` : '入れるリストを選んでください';
  };
  submit.addEventListener('click', ()=>{
    const lists = [...selected];
    submit.disabled = true;
    submit.textContent = '処理中…';
    tm.busy = true;
    postToGas({type:'reminderCategory', action:'move', id:c.id, listIds:lists.map(l=>l.id)})
      .then(res=>{
        if(res.status !== 'success') throw new Error(res.message || '移せませんでした');
        lists.forEach(l=>{ l.categoryId = c.id; });
        tm.busy = false;
        renderTodo();
        toast(`${lists.length}件のリストを「${c.name}」に入れました`);
        tm.stack.pop();
        tmRender();
      })
      .catch(err=>{ tm.busy = false; toast(errMsg(err)); update(); });
  });
  update();
  tmFoot.append(submit);
  todo.lists.filter(l=>l.kind === c.type && todoCategoryOfList(l) !== c).sort(todoBySort).forEach(l=>{
    const from = todoCategoryOfList(l);
    const cb = h('input', {type:'checkbox', onchange:()=>{
      if(cb.checked) selected.add(l); else selected.delete(l);
      update();
    }});
    tmBody.append(h('label', {class:'tm-check'}, cb,
      h('div', {class:'main'}, h('div', {class:'t1'}, l.name),
        h('div', {class:'t2'}, [from ? `今は「${from.name}」` : '', l.active ? '' : '非表示'].filter(Boolean).join('・')))));
  });
}

// ---------- リストの追加（右下の＋。在庫の登録パネルと同じく、下から出るパネル） ----------
const todoComposeBody = h('div', {class:'compose-body'});
const todoCompose = h('div', {class:'compose', role:'dialog', 'aria-labelledby':'todo-compose-title'},
  h('div', {class:'compose-grip', 'aria-hidden':'true'}, h('span')),
  h('div', {class:'compose-head'},
    h('h2', {id:'todo-compose-title'}, '新しいリストを作る'),
    h('button', {type:'button', class:'text-btn', onclick:closeCompose}, '閉じる')),
  h('p', {class:'compose-hint'}, '作ったリストは、選んだカテゴリのタブにカードで並びます'),
  todoComposeBody);
todoCompose.dataset.kind = 'form';
const todoFab = h('button', {type:'button', class:'fab', 'aria-label':'リストを追加', onclick:()=>{ todoFillCompose(); openCompose('form'); }}, '＋');
document.getElementById('todo-panel').append(todoFab, todoCompose);
enableComposeDrag(todoCompose);

// パネルの中身を作り直す（開くたびに空にして、カテゴリは選んでいるタブにする）
// カテゴリは選ぶか、「＋ 新しいカテゴリ」で名前と種類を入れる（在庫の登録フォームのカテゴリと同じ形）。買い物型なら店の欄も出す
function todoFillCompose(){
  const cs = todoCategories();
  const cur = todoCurrentCategory();
  const name = h('input', {type:'text', placeholder:'例：毎日のこと ／ カインズ'});
  const catSel = h('select', {}, cs.map(c=>h('option', {value:String(c.id)}, c.name)), h('option', {value:'__new__'}, '＋ 新しいカテゴリ'));
  catSel.value = cur ? String(cur.id) : '__new__';
  const catName = h('input', {type:'text', placeholder:'新しいカテゴリの名前'});
  let type = TODO_TYPES[0][0];
  const typeSeg = h('div', {class:'seg'}, TODO_TYPES.map(([t, label])=>h('button', {type:'button', value:t, onclick:()=>{ type = t; sync(); }}, label)));
  const typeNote = h('p', {class:'form-note'});
  const newCat = h('div', {class:'todo-new-cat'}, catName, typeSeg, typeNote);
  let color = '';
  const colors = todoColorChips(color, c=>{ color = c; });
  const shop = todoShopFields({});
  const typeOf = ()=>catSel.value === '__new__' ? type : (cs.find(c=>String(c.id) === catSel.value) || {}).type;
  const sync = ()=>{
    newCat.hidden = catSel.value !== '__new__';
    typeSeg.querySelectorAll('button').forEach(b=>b.classList.toggle('on', b.value === type));
    typeNote.textContent = TODO_TYPES.find(([t])=>t === type)[2];
    shop.el.hidden = typeOf() !== '買い物';
  };
  catSel.addEventListener('change', ()=>{
    sync();
    if(catSel.value === '__new__') catName.focus();
  });
  sync();
  const submit = h('button', {type:'submit', class:'submit-btn'}, 'このリストを作る');
  const form = h('form', {onsubmit:e=>{
    e.preventDefault();
    const n = normText(name.value);
    if(!n){ toast('リストの名前を入れてください'); return; }
    const payload = {type:'reminderList', action:'add', name:n, color, store:shop.store.value, askStock:shop.askStock.checked};
    if(catSel.value === '__new__'){
      const cn = normText(catName.value);
      if(!cn){ toast('新しいカテゴリの名前を入れてください'); return; }
      payload.newCategory = {name:cn, type};
    } else {
      payload.categoryId = catSel.value;
    }
    submit.disabled = true;
    submit.textContent = '作成中…';
    postToGas(payload)
      .then(res=>{
        if(res.status !== 'success') throw new Error(res.message || '作成に失敗しました');
        const {category, ...list} = res.list;
        if(category) todo.categories.push(category);
        todo.lists.push(list);
        todoSelectCategory(category || todoCategoryOfList(list));
        closeCompose();
        renderTodo();
        toast(`「${list.name}」を作りました`);
      })
      .catch(err=>{ toast(errMsg(err)); submit.disabled = false; submit.textContent = 'このリストを作る'; });
  }}, field('名前', name), field('カテゴリ', catSel, newCat), shop.el, field('色', colors), submit);
  todoComposeBody.replaceChildren(form);
}
