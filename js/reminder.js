// やること：リストのカード（2列）→ リストの中（追加・丸のタップで完了・取り消し）→ 編集シート、リストの管理
// データは GAS の getReminders（起動時は getAll にまとめて取得）。タブを開くたびに読み込み直す（5分ごとの処理や在庫の変更で行が増えるため）
// 完了・取り消しはすぐ画面に反映し、失敗したら元に戻して読み込み直す
// 周期の入力欄は js/rule-editor.js、周期の計算は gas/chore-rule.js（GAS と共通）
// リストの画面は js/nav-stack.js でリストのカードの上に重ねる（右から入り、「‹ リスト」か左端からのスワイプで戻る）

const todo = {lists:[], items:[], sale:{items:{}, verdicts:{}}, listId:null, draft:'', doneOpen:false, loaded:false};
const TODO_KINDS = ['家事', '買い物'];
const TODO_ASSIGNEES = ['本人', '彼女'];
const TODO_COLORS = ['#E2BC7A', '#9DCBA4', '#9DBBDF', '#EE9F94', '#C9A6E4']; // リストの色の候補（空なら --chore）
const TODO_UNDO_MS = 5000; // 完了した直後に「取り消す」を出す時間
const TODO_CHORE_DONE_DAYS = 3; // 家事の完了を「完了」に出す日数（買い物は完了した翌日まで）
const TODO_INFO = {title:'やること', sub:'リストをタップして開く・丸のタップで完了'};

// preloaded：起動時にまとめて取得したデータ（あれば通信しない）
function loadReminders(preloaded){
  return (preloaded ? Promise.resolve(preloaded) : getFromGas('action=getReminders'))
    .then(d=>{
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
function todoActiveLists(){ return todo.lists.filter(l=>l.active).sort(todoBySort); }
function todoListOf(id){ return todo.lists.find(l=>String(l.id) === String(id)); }
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
// 店名の合わせ方（GAS の reminderStoreKey と同じ）：NFKC・英字は小文字・空白と「・」を除く。リストの store は「,」区切りで別名を書ける
function todoStoreKey(s){ return normText(s).toLowerCase().replace(/[\s・]/g, ''); }
function todoStoreAliases(list){ return String(list.store || '').split(/[,，、]/).map(todoStoreKey).filter(Boolean); }
// その店の、いま使えるクーポン（未使用で、使える期間内）
function todoStoreCoupons(list){
  const aliases = todoStoreAliases(list);
  if(!aliases.length) return [];
  return couponList.filter(c=>{
    if(String(c.status || '') !== '' || !aliases.includes(todoStoreKey(c.store))) return false;
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

// リストのカード（2列）
function todoGridView(){
  const head = h('div', {class:'list-head'},
    h('div', {class:'section-title'}, 'リスト'),
    h('button', {type:'button', class:'edit-toggle', onclick:()=>openSheet('todo', tmTodoListsView)}, 'リストの管理'));
  const lists = todoActiveLists();
  if(!lists.length) return [head, h('p', {class:'empty-msg'}, 'リストがありません（GAS の setupReminders を実行するか、「リストの管理」から追加してください）')];
  return [head, h('div', {class:'todo-grid'}, lists.map(todoListCard))];
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
    h('div', {class:'field'}, h('label', {}, '足す個数'), qty),
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
  const field = (label, ...inputs)=>h('div', {class:'field'}, h('label', {}, label), inputs);
  const title = h('input', {type:'text', value:i ? i.title : todo.draft});
  const qty = h('input', {type:'text', value:i ? (i.qty ?? '') : '', placeholder:'例：2 ／ 2袋'});
  const memo = h('input', {type:'text', value:i ? (i.memo || '') : ''});
  // 移す先のリスト（非表示のリストも、今入っているリストなら出す）
  const listSel = h('select', {}, todo.lists.filter(l=>l.active || String(l.id) === String(list.id)).sort(todoBySort)
    .map(l=>h('option', {value:String(l.id)}, l.name)));
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
// リストの一覧（↑↓で並べ替え、タップで編集）と、新しいリストの追加
function tmTodoListsView(){
  tmTitle.textContent = 'リストの管理';
  const lists = [...todo.lists].sort(todoBySort);
  const move = (n, d)=>{
    const m = n + d;
    if(m < 0 || m >= lists.length || tm.busy) return;
    [lists[n], lists[m]] = [lists[m], lists[n]];
    lists.forEach((l, k)=>{ l.sortOrder = k + 1; });
    tmRender();
    renderTodo();
    tm.busy = true;
    postToGas({type:'reminderList', action:'reorder', ids:lists.map(l=>l.id)})
      .then(res=>{ if(res.status !== 'success') throw new Error(res.message || '並べ替えに失敗しました'); })
      .catch(err=>{ toast(errMsg(err)); loadReminders().then(()=>{ if(tm.stack.length) tmRender(); }); })
      .finally(()=>{ tm.busy = false; });
  };
  tmBody.append(h('div', {class:'tm-section'},
    h('h3', {}, 'リスト（上から順にカードを並べます）'),
    lists.map((l, n)=>h('div', {class:'todo-list-row' + (l.active ? '' : ' off')},
      h('button', {type:'button', class:'tm-row', onclick:()=>tmShow(tmTodoListEditView, l)},
        h('span', {class:'todo-dot', style:l.color ? `background:${l.color}` : ''}),
        h('span', {class:'name'}, l.name),
        h('span', {class:'count'}, [l.kind, l.active ? '' : '非表示'].filter(Boolean).join('・')),
        h('span', {class:'chev'}, '›')),
      h('button', {type:'button', class:'lot-remove', disabled:n === 0, 'aria-label':'上へ', onclick:()=>move(n, -1)}, '↑'),
      h('button', {type:'button', class:'lot-remove', disabled:n === lists.length - 1, 'aria-label':'下へ', onclick:()=>move(n, 1)}, '↓')))));

  const name = h('input', {type:'text', placeholder:'例：カインズ'});
  const kind = h('select', {}, TODO_KINDS.map(k=>h('option', {value:k}, k)));
  kind.value = '買い物';
  const add = h('button', {type:'button', class:'tm-btn'}, '追加');
  add.addEventListener('click', ()=>{
    const n = normText(name.value);
    if(!n){ toast('リストの名前を入れてください'); return; }
    add.disabled = true;
    tm.busy = true;
    postToGas({type:'reminderList', action:'add', name:n, kind:kind.value})
      .then(res=>{
        if(res.status !== 'success') throw new Error(res.message || '追加に失敗しました');
        todo.lists.push(res.list);
        tm.busy = false;
        renderTodo();
        tmShow(tmTodoListEditView, res.list); // 店名などを続けて入れられるように編集画面を開く
      })
      .catch(err=>{ tm.busy = false; add.disabled = false; toast(errMsg(err)); });
  });
  tmBody.append(h('div', {class:'tm-section'},
    h('h3', {}, 'リストを追加'),
    h('div', {class:'tm-inline'}, name, kind, add)));
}
// リストの編集：名前・種類・店・色・在庫に足すか聞く・表示
function tmTodoListEditView(l){
  tmTitle.textContent = 'リストを編集';
  const field = (label, ...inputs)=>h('div', {class:'field'}, h('label', {}, label), inputs);
  const name = h('input', {type:'text', value:l.name});
  const kind = h('select', {}, TODO_KINDS.map(k=>h('option', {value:k}, k)));
  kind.value = l.kind;
  const store = h('input', {type:'text', value:l.store || '', placeholder:'例：DAISO,ダイソー'});
  const askStock = h('input', {type:'checkbox', checked:!!l.askStock});
  const active = h('input', {type:'checkbox', checked:!!l.active});
  let color = l.color || '';
  const colors = h('div', {class:'chips'}, ['', ...TODO_COLORS].map(c=>h('button', {type:'button', class:'chip todo-color' + (c === color ? ' on' : ''),
    style:c ? `--swatch:${c}` : '', 'aria-label':c || '色なし', onclick:e=>{
      color = c;
      colors.querySelectorAll('.chip').forEach(b=>b.classList.toggle('on', b === e.currentTarget));
    }}, c ? '' : 'なし')));
  const shopFields = h('div', {},
    field('店', store, h('p', {class:'tm-note'}, 'クーポンの店名や、在庫の品目を入れる店の判断に使います。呼び方が違うときは「,」で区切って並べます（先頭の名前がクーポンの店名と合うように）。空なら、店が決まらない在庫の品目の行き先になります。')),
    h('label', {class:'check'}, askStock, 'チェックしたときに在庫に足すか聞く'));
  const syncKind = ()=>{ shopFields.hidden = kind.value !== '買い物'; };
  kind.addEventListener('change', syncKind);
  syncKind();
  const save = h('button', {type:'button', class:'tm-btn tm-wide'}, '保存');
  tmBody.append(field('名前', name), field('種類', kind), shopFields, field('色', colors),
    h('label', {class:'check'}, active, 'カードを表示する（外すと非表示。品目はシートに残ります）'));
  tmFoot.append(save);
  save.addEventListener('click', ()=>{
    const n = normText(name.value);
    if(!n){ toast('リストの名前を入れてください'); return; }
    save.disabled = true;
    save.textContent = '保存中…';
    tm.busy = true;
    postToGas({type:'reminderList', action:'edit', id:l.id, name:n, kind:kind.value, store:store.value, color,
      askStock:askStock.checked, active:active.checked})
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
