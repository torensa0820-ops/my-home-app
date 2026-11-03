// =========================================================
// やること：リストごとのリマインダー（家事・用事・買い物）
// ・「リマインダーカテゴリ」シート：1行＝1カテゴリ（画面のタブ）。type は 家事 / 買い物 で、中のリストの動きを決める
// ・「リマインダーリスト」シート：1行＝1リスト。categoryId のカテゴリに入る。kind はカテゴリの type と同じ値を書く（ほかの処理は kind を見る）
//   買い物のリストは store（店）を持つ
// ・「リマインダー」シート：1行＝1件。rule があればくり返し（周期の計算は chore-rule.js）、なければ nextDue だけ（期限なしは空）
//   くり返しなしの期限に時刻を付けたかは、nextDue が 0:00 ちょうどかどうかで判断する
// ・在庫が「買う物」になったら買い物リストに行を作り、買う物でなくなったら自動で完了にする（syncStockReminders）
// 通知は reminder-notify.js
// =========================================================
const SHEET_REMINDER_CATEGORY = "リマインダーカテゴリ";
const SHEET_REMINDER_LIST = "リマインダーリスト";
const SHEET_REMINDER = "リマインダー";
const SHEET_CHORE = "家事"; // 以前の家事のシート。記録として残し、移行（setupReminders）で読むだけ
const REMINDER_CATEGORY_HEADERS = ["id", "name", "type", "sortOrder", "createdAt"];
const REMINDER_LIST_HEADERS = ["id", "name", "kind", "store", "color", "sortOrder", "askStock", "active", "createdAt", "categoryId"];
const REMINDER_HEADERS = ["id", "listId", "title", "qty", "memo", "assignee", "rule", "cycle", "nextDue", "lastDone", "notifiedFor",
  "status", "doneAt", "doneBy", "source", "stockItemName", "createdAt", "updatedAt"];
const REMINDER_KINDS = ["家事", "買い物"];
const REMINDER_ASSIGNEES = ["本人", "彼女"];
const REMINDER_DONE = "done";
const REMINDER_DISMISSED = "dismissed"; // 在庫とつながる行をアプリで削除したもの
const REMINDER_BY_APP = "アプリ";
const REMINDER_BY_AUTO = "自動";
const REMINDER_SOURCE_MANUAL = "手入力";
const REMINDER_SOURCE_STOCK = "在庫";
const REMINDER_KEEP_DAYS = 4; // 完了した行を画面に渡す日数（家事は3日・買い物は翌日まで出すので、それより少し長く）
const REMINDER_OTHER_LIST = "その他・店未定"; // 店が決まらない在庫の品目の行き先
const REMINDER_COLORS = /^#[0-9a-fA-F]{6}$/;
// setupReminders で作る最初のリスト（同じ name のリストがあれば作らない）
const REMINDER_DEFAULT_LISTS = [
  { name: "家事", kind: "家事", store: "" },
  { name: "くすりの福太郎", kind: "買い物", store: "くすりの福太郎" },
  { name: "ベルク", kind: "買い物", store: "ベルク" },
  { name: "業務スーパー", kind: "買い物", store: "業務スーパー" },
  { name: "コープ", kind: "買い物", store: "コープ" },
  { name: "DAISO", kind: "買い物", store: "DAISO" },
  { name: "Amazon", kind: "買い物", store: "Amazon", askStock: true },
  { name: REMINDER_OTHER_LIST, kind: "買い物", store: "" },
];

// ---- 読み取り ----

// 画面に渡すデータ：categories（全カテゴリ）、lists（全リスト）、items（まだ終わっていない行・くり返しの行・最近完了した行）、sale（セール品目の印）
// シートがまだなければ空（setupReminders の前でも画面全体が読み込めるようにする）
function getReminders() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const since = Date.now() - REMINDER_KEEP_DAYS * 86400000;
  const items = receiptRead(ss.getSheetByName(SHEET_REMINDER)).rows.filter(o => {
    const status = String(o.status ?? "");
    if (status === "") return true;
    return status === REMINDER_DONE && o.doneAt instanceof Date && o.doneAt.getTime() >= since;
  });
  return {
    categories: reminderCategories(ss).map(reminderOut),
    lists: reminderLists(ss).map(reminderOut),
    items: items.map(reminderOut),
    sale: getReminderSaleInfo(ss),
  };
}

// カテゴリの行（sortOrder の順。シートがなければ空）
function reminderCategories(ss) {
  return receiptRead(ss.getSheetByName(SHEET_REMINDER_CATEGORY)).rows
    .sort((a, b) => (Number(a.sortOrder) || 0) - (Number(b.sortOrder) || 0));
}

// リストの行（askStock・active は真偽値にする。active が空なら表示する）
function reminderLists(ss) {
  return receiptRead(ss.getSheetByName(SHEET_REMINDER_LIST)).rows.map(o => Object.assign(o, {
    askStock: reminderBool(o.askStock),
    active: String(o.active ?? "") === "" ? true : reminderBool(o.active),
  }));
}

// 表示中のリストを sortOrder の順に
function reminderActiveLists(ss) {
  return reminderLists(ss).filter(l => l.active).sort((a, b) => (Number(a.sortOrder) || 0) - (Number(b.sortOrder) || 0));
}

function reminderBool(v) {
  return v === true || /^true$/i.test(String(v ?? "").trim());
}

// 画面に渡す形にする（日時は ISO 文字列）
function reminderOut(o) {
  const out = {};
  Object.keys(o).forEach(k => {
    if (k !== "_row") out[k] = o[k] instanceof Date ? o[k].toISOString() : o[k];
  });
  return out;
}

// 見出しをキーにしたオブジェクトの配列（id 列のないシート用。シートがなければ空）
function reminderSheetRows(ss, name) {
  const sheet = ss.getSheetByName(name);
  if (!sheet || sheet.getLastRow() < 2) return [];
  const values = sheet.getDataRange().getValues();
  return values.slice(1).map(r => {
    const o = {};
    values[0].forEach((h, j) => { if (h) o[h] = r[j]; });
    return o;
  });
}

// セール品目の印（品目名を正規化したものがキー）
// items：{品目名: {pack: "2袋まで"}}（packUnit が空なら pack も空）
// verdicts：{品目名: "買い" | "待ち"}（「セールチェック」の最新の回）
function getReminderSaleInfo(ss) {
  const items = {};
  reminderSheetRows(ss, SHEET_SALE_ITEMS).forEach(o => {
    const name = normText(o.itemName);
    if (name && !items[name]) items[name] = { pack: salePackLabel(o) };
  });
  const rows = reminderSheetRows(ss, SHEET_SALE_CHECK).map(o => Object.assign(o, {
    runId: o.runId instanceof Date ? Utilities.formatDate(o.runId, "Asia/Tokyo", "yyyy-MM-dd") : String(o.runId ?? "").trim(),
  })).filter(o => o.runId);
  const latest = rows.reduce((max, o) => o.runId > max ? o.runId : max, "");
  const verdicts = {};
  rows.forEach(o => {
    const name = normText(o.itemName);
    const v = saleVerdict(o);
    if (o.runId !== latest || !name || isSaleSummary(o) || (v !== "買い" && v !== "待ち")) return;
    if (verdicts[name] !== "買い") verdicts[name] = v; // 同じ品目に両方あれば「買い」
  });
  return { items: items, verdicts: verdicts };
}

// 1回に買う上限を、パックの単位で書く（maxPack ÷ unitQty。例：「2袋まで」）。packUnit が空ならパックはないものとして空
function salePackLabel(o) {
  const unit = normText(o.packUnit);
  const max = saleNum(o.maxPack);
  const per = saleNum(o.unitQty);
  if (!unit || max === null || !per) return "";
  return `${Math.round(max / per * 10) / 10}${unit}まで`;
}

// ---- 品目の操作 ----
// data.action
//   add    … listId・title・qty・memo・assignee と、rule（くり返し）か due（"yyyy-MM-dd" か "yyyy-MM-ddTHH:mm"。期限なしは空）
//   edit   … add と同じ項目を上書きする（id で指定）
//   done   … くり返し：lastDone を書いて nextDue を次へ進める。くり返しなし：status=done
//             addStock（個数）があれば、在庫の登録と同じ処理で stockItemName（なければ title）の在庫に足す
//   undo   … done を取り消す。くり返しは prev（完了する前の lastDone・nextDue・notifiedFor）に戻す
//             removeStock（個数）があれば、done で足した在庫を減らす
//   delete … 在庫から作った行は status=dismissed（その品目が一度「買う物」でなくなるまで作り直さない）。それ以外は行を消す
// 戻り値：書き込んだ後の行（delete で行を消したときは null）
function reminderAction(ss, data) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000); // 5分ごとの在庫とのつながり（syncStockReminders）と重ならないようにする
  try {
    const sheet = ss.getSheetByName(SHEET_REMINDER);
    if (!sheet) throw new Error("「リマインダー」シートがありません。GAS の setupReminders を実行してください。");
    const t = receiptRead(sheet);
    const now = new Date();

    if (data.action === "add") {
      const input = reminderInput(ss, data, null, now);
      const row = Object.assign({ id: Utilities.getUuid(), status: "", source: REMINDER_SOURCE_MANUAL, createdAt: now, updatedAt: now }, input);
      receiptAppend(sheet, row);
      return reminderOut(row);
    }

    const found = t.rows.find(o => String(o.id) === String(data.id));
    if (!found) throw new Error("見つかりませんでした。読み込み直してください。");
    const status = String(found.status ?? "");
    const rule = choreParseRule(found.rule);

    if (data.action === "edit") {
      const values = Object.assign(reminderInput(ss, data, found, now), { updatedAt: now });
      // 完了したものをくり返しにしたら、まだの状態に戻す（くり返しは status を使わない）
      if (values.rule && status === REMINDER_DONE) Object.assign(values, { status: "", doneAt: "", doneBy: "" });
      reminderWrite(sheet, t.headers, found, values);
    } else if (data.action === "done") {
      if (status !== "") throw new Error("すでに完了しています。読み込み直してください。");
      if (rule) {
        const due = found.nextDue instanceof Date ? found.nextDue : null;
        const next = choreNextAfterDone(rule, now, due);
        reminderWrite(sheet, t.headers, found, { lastDone: now, nextDue: next || "", updatedAt: now });
      } else {
        reminderWrite(sheet, t.headers, found, { status: REMINDER_DONE, doneAt: now, doneBy: REMINDER_BY_APP, updatedAt: now });
      }
      reminderChangeStock(ss, found, Number(data.addStock) || 0);
    } else if (data.action === "undo") {
      if (rule) {
        const prev = data.prev || {};
        reminderWrite(sheet, t.headers, found, {
          lastDone: reminderDate(prev.lastDone), nextDue: reminderDate(prev.nextDue), notifiedFor: reminderDate(prev.notifiedFor), updatedAt: now,
        });
      } else {
        if (status !== REMINDER_DONE) throw new Error("完了していません。読み込み直してください。");
        reminderWrite(sheet, t.headers, found, { status: "", doneAt: "", doneBy: "", updatedAt: now });
      }
      reminderChangeStock(ss, found, -(Number(data.removeStock) || 0));
    } else if (data.action === "delete") {
      if (String(found.source ?? "") === REMINDER_SOURCE_STOCK) {
        reminderWrite(sheet, t.headers, found, { status: REMINDER_DISMISSED, doneAt: now, doneBy: REMINDER_BY_APP, updatedAt: now });
      } else {
        sheet.deleteRow(found._row);
      }
      return null;
    } else {
      throw new Error("action が不正です: " + data.action);
    }
    return reminderOut(found);
  } finally {
    lock.releaseLock();
  }
}

// 1行のいくつかの列を書き換え、row（読んだ行のオブジェクト）にも反映する
function reminderWrite(sheet, headers, row, values) {
  receiptWrite(sheet, headers, row._row, values);
  Object.assign(row, values);
}

// 画面から届いた日時（ISO 文字列）を Date にする。空・読めなければ空
function reminderDate(v) {
  if (!v) return "";
  const d = new Date(v);
  return isNaN(d) ? "" : d;
}

// チェックしたときに在庫に足す（qty が負なら減らす）。stockItemName がなければ品目名を商品名にする
function reminderChangeStock(ss, row, qty) {
  if (!qty) return;
  const target = normText(row.stockItemName) || normText(row.title);
  updateStock(ss, { target: target, value: qty });
  syncStockReminders(ss);
}

// 画面から届いた品目の内容をそろえる。old は編集する前の行（追加のときは null）
function reminderInput(ss, data, old, now) {
  const title = normText(data.title);
  if (!title) throw new Error("名前を入れてください。");
  const list = reminderLists(ss).find(l => String(l.id) === String(data.listId));
  if (!list) throw new Error("リストが見つかりません。読み込み直してください。");
  const assignee = normText(data.assignee);
  if (assignee && REMINDER_ASSIGNEES.indexOf(assignee) === -1) throw new Error("担当が不正です: " + assignee);
  const out = { listId: list.id, title: title, qty: normText(data.qty), memo: normText(data.memo), assignee: assignee };

  const rule = choreParseRule(data.rule);
  if (rule) {
    const err = choreValidate(rule);
    if (err) throw new Error(err);
    const asDate = v => v instanceof Date ? v : null;
    const next = old
      ? choreDueAfterEdit(old.rule, rule, asDate(old.nextDue), asDate(old.lastDone), now)
      : choreFirst(rule, now);
    Object.assign(out, { rule: JSON.stringify(rule), cycle: choreLabel(rule), nextDue: next || "" });
  } else {
    Object.assign(out, { rule: "", cycle: "", nextDue: reminderDueInput(data.due) });
  }
  // 在庫から作った行は在庫の商品名のまま。手で入れた行は、品目名が在庫の商品名と同じなら在庫の数を出せるようにつなぐ
  if (!old || String(old.source ?? "") !== REMINDER_SOURCE_STOCK) {
    out.stockItemName = stockItemNames(ss).has(title) ? title : "";
  }
  return out;
}

// 期限（"yyyy-MM-dd" か "yyyy-MM-ddTHH:mm"）を Date にする。空は空。時刻なしはその日の 0:00
function reminderDueInput(v) {
  const s = String(v ?? "").trim();
  if (!s) return "";
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/);
  if (!m) throw new Error("期限の日付が不正です: " + s);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0), Number(m[5] || 0));
}

// ---- リストの操作 ----
// data.action
//   add     … name・categoryId（新しいカテゴリに入れるなら代わりに newCategory：{name, type}）・store・color・askStock。sortOrder は最後
//   edit    … name・categoryId・store・color・askStock・active を上書きする（id で指定）。active を false にすると非表示
//   reorder … ids（リストの id を並べたい順に）で sortOrder を振り直す
// kind は入れるカテゴリの type にする。カテゴリを移せるのは、type が同じカテゴリの間だけ
// 戻り値：書き込んだ後のリスト（reorder は null）。add で新しいカテゴリを作ったときは list.category にそのカテゴリを付ける
function reminderListAction(ss, data) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sheet = ss.getSheetByName(SHEET_REMINDER_LIST);
    if (!sheet) throw new Error("「リマインダーリスト」シートがありません。GAS の setupReminders を実行してください。");
    const t = receiptRead(sheet);

    if (data.action === "reorder") {
      reminderReorder(sheet, t, data.ids);
      return null;
    }
    if (data.action !== "add" && data.action !== "edit") throw new Error("action が不正です: " + data.action);

    const name = normText(data.name);
    if (!name) throw new Error("リストの名前を入れてください。");
    const others = t.rows.filter(o => String(o.id) !== String(data.id));
    if (others.some(o => normText(o.name) === name)) throw new Error(`「${name}」というリストはもうあります。`);
    const color = String(data.color ?? "").trim();
    if (color && !REMINDER_COLORS.test(color)) throw new Error("色が不正です: " + color);
    const found = data.action === "edit" ? t.rows.find(o => String(o.id) === String(data.id)) : null;
    if (data.action === "edit" && !found) throw new Error("リストが見つかりません。読み込み直してください。");

    // 入れるカテゴリ（add で newCategory があれば、ここで作る）
    const created = data.action === "add" && data.newCategory ? reminderAddCategory(ss, data.newCategory) : null;
    const category = created || reminderCategories(ss).find(c => String(c.id) === String(data.categoryId));
    if (!category) throw new Error("カテゴリが見つかりません。読み込み直してください。");
    const kind = String(category.type);
    if (found && String(found.kind) !== kind) throw new Error("種類の違うカテゴリには移せません。");
    const values = {
      name: name, kind: kind, categoryId: category.id, store: kind === "買い物" ? reminderStoreInput(data.store) : "",
      color: color, askStock: kind === "買い物" && data.askStock === true,
    };

    if (data.action === "add") {
      const sortOrder = t.rows.reduce((max, o) => Math.max(max, Number(o.sortOrder) || 0), 0) + 1;
      const row = Object.assign({ id: Utilities.getUuid(), sortOrder: sortOrder, active: true, createdAt: new Date() }, values);
      receiptAppend(sheet, row);
      return Object.assign(reminderOut(row), created ? { category: reminderOut(created) } : {});
    }
    values.active = data.active !== false;
    receiptWrite(sheet, t.headers, found._row, values);
    return reminderOut(Object.assign(found, values));
  } finally {
    lock.releaseLock();
  }
}

// ids（並べたい順の id）で sortOrder を振り直す。ids にない行は変えない
function reminderReorder(sheet, t, ids) {
  ids = (ids || []).map(String);
  t.rows.forEach(o => {
    const i = ids.indexOf(String(o.id));
    if (i !== -1 && Number(o.sortOrder) !== i + 1) receiptWrite(sheet, t.headers, o._row, { sortOrder: i + 1 });
  });
}

// ---- カテゴリの操作 ----
// data.action
//   add     … name・type（家事 / 買い物）。sortOrder は最後
//   rename  … name（id で指定）
//   delete  … カテゴリを消す（id で指定）。リストが入っていれば消さない
//   reorder … ids（カテゴリの id を並べたい順に）で sortOrder を振り直す
//   move    … listIds のリストをこのカテゴリ（id で指定）に移す。type が同じリストだけ
// 戻り値：書き込んだ後のカテゴリ（delete・reorder・move は null）
function reminderCategoryAction(ss, data) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sheet = ss.getSheetByName(SHEET_REMINDER_CATEGORY);
    if (!sheet) throw new Error("「リマインダーカテゴリ」シートがありません。GAS の setupReminderCategories を実行してください。");
    if (data.action === "add") return reminderOut(reminderAddCategory(ss, data));
    const t = receiptRead(sheet);
    if (data.action === "reorder") {
      reminderReorder(sheet, t, data.ids);
      return null;
    }
    const found = t.rows.find(o => String(o.id) === String(data.id));
    if (!found) throw new Error("カテゴリが見つかりません。読み込み直してください。");
    const listSheet = ss.getSheetByName(SHEET_REMINDER_LIST);
    const lists = receiptRead(listSheet);

    if (data.action === "rename") {
      const name = normText(data.name);
      if (!name) throw new Error("カテゴリの名前を入れてください。");
      if (t.rows.some(o => String(o.id) !== String(found.id) && normText(o.name) === name)) throw new Error(`「${name}」というカテゴリはもうあります。`);
      receiptWrite(sheet, t.headers, found._row, { name: name });
      return reminderOut(Object.assign(found, { name: name }));
    }
    if (data.action === "delete") {
      const n = lists.rows.filter(o => String(o.categoryId) === String(found.id)).length;
      if (n) throw new Error(`リストが${n}件入っています。先にほかのカテゴリへ移してください。`);
      sheet.deleteRow(found._row);
      return null;
    }
    if (data.action === "move") {
      const ids = (data.listIds || []).map(String);
      const targets = lists.rows.filter(o => ids.indexOf(String(o.id)) !== -1);
      const wrong = targets.find(o => String(o.kind) !== String(found.type));
      if (wrong) throw new Error(`「${wrong.name}」は種類が違うので移せません。`);
      targets.forEach(o => receiptWrite(listSheet, lists.headers, o._row, { categoryId: found.id }));
      return null;
    }
    throw new Error("action が不正です: " + data.action);
  } finally {
    lock.releaseLock();
  }
}

// カテゴリを1行足す（ロックは呼び出し側で取る）。c：{name, type}
function reminderAddCategory(ss, c) {
  const sheet = ss.getSheetByName(SHEET_REMINDER_CATEGORY);
  if (!sheet) throw new Error("「リマインダーカテゴリ」シートがありません。GAS の setupReminderCategories を実行してください。");
  const name = normText(c.name);
  if (!name) throw new Error("カテゴリの名前を入れてください。");
  const type = normText(c.type);
  if (REMINDER_KINDS.indexOf(type) === -1) throw new Error("カテゴリの種類が不正です: " + type);
  const rows = receiptRead(sheet).rows;
  if (rows.some(o => normText(o.name) === name)) throw new Error(`「${name}」というカテゴリはもうあります。`);
  const sortOrder = rows.reduce((max, o) => Math.max(max, Number(o.sortOrder) || 0), 0) + 1;
  const row = { id: Utilities.getUuid(), name: name, type: type, sortOrder: sortOrder, createdAt: new Date() };
  receiptAppend(sheet, row);
  return row;
}

// 店名（「,」区切りで別名も書ける）を正規化してつなぎ直す
function reminderStoreInput(v) {
  return normText(v).split(/[,，、]/).map(normText).filter(Boolean).join(",");
}

// ---- 店名の合わせ方 ----
// NFKC で正規化し、英字を小文字にし、空白と「・」を除いて比べる。リストの store は「,」区切りで別名を書ける（DAISO,ダイソー）
function reminderStoreKey(s) {
  return normText(s).toLowerCase().replace(/[\s・]/g, "");
}

function reminderStoreAliases(list) {
  return String(list.store ?? "").split(/[,，、]/).map(reminderStoreKey).filter(Boolean);
}

// その店の買い物リスト（なければ null）
function reminderListForStore(lists, store) {
  const key = reminderStoreKey(store);
  if (!key) return null;
  return lists.find(l => String(l.kind) === "買い物" && reminderStoreAliases(l).indexOf(key) !== -1) || null;
}

// ---- 在庫とのつながり ----

// 在庫を商品名（正規化したもの）ごとにまとめる：{total, reorderAt, buyFlag, stockTag, model}
function stockSummary(ss) {
  const values = ss.getSheetByName(SHEET_STOCK).getDataRange().getValues();
  const col = stockColumns(values[0]);
  const items = {};
  for (let i = 1; i < values.length; i++) {
    const r = values[i];
    const name = normText(r[col.itemName]);
    if (!name) continue;
    const g = items[name] || (items[name] = { total: 0, reorderAt: "", buyFlag: false, stockTag: false, model: false });
    g.total += Number(r[col.stock]) || 0;
    if (col.reorderAt !== -1 && g.reorderAt === "") g.reorderAt = parseReorderAt(r[col.reorderAt]);
    if (col.buyFlag !== -1 && normText(r[col.buyFlag]) === BUY_FLAG) g.buyFlag = true;
    if (col.tags !== -1 && splitTags(r[col.tags]).indexOf("ストック") !== -1) g.stockTag = true;
    if (col.modelNumber !== -1 && normText(r[col.modelNumber])) g.model = true;
  }
  return items;
}

// 「買う物」か（画面の js/stock.js の buyReason と同じ判定）
// 型番のある商品は対象外。reorderAt があれば合計 ≤ reorderAt、なければ buyFlag が「買う」か、タグ「ストック」があって合計 0
function isStockBuy(g) {
  if (g.model) return false;
  if (g.reorderAt !== "") return g.total <= g.reorderAt;
  return g.buyFlag || (g.stockTag && g.total === 0);
}

function stockItemNames(ss) {
  return new Set(Object.keys(stockSummary(ss)));
}

// 在庫を見て、買い物リストの行を作る・自動で完了にする（ロックは呼び出し側で取る）
// ・買う物になった品目：同じ stockItemName のまだ終わっていない行も、作り直さない印（アプリで削除した行）もなければ行を作る
// ・買う物でなくなった品目：在庫から作ったまだ終わっていない行を完了にする（doneBy=自動）。
//   アプリで削除した行（dismissed・doneBy=アプリ）は doneBy を「自動」にして、作り直さない印を外す
function syncStockReminders(ss) {
  const sheet = ss.getSheetByName(SHEET_REMINDER);
  if (!sheet || !ss.getSheetByName(SHEET_REMINDER_LIST)) return; // setupReminders の前
  const summary = stockSummary(ss);
  const buy = new Set(Object.keys(summary).filter(name => isStockBuy(summary[name])));
  const t = receiptRead(sheet);
  const now = new Date();
  const open = new Set();
  const blocked = new Set();
  t.rows.forEach(o => {
    const name = normText(o.stockItemName);
    if (!name) return;
    const status = String(o.status ?? "");
    if (status === "") {
      if (!buy.has(name) && String(o.source ?? "") === REMINDER_SOURCE_STOCK && !normText(o.rule)) {
        receiptWrite(sheet, t.headers, o._row, { status: REMINDER_DONE, doneAt: now, doneBy: REMINDER_BY_AUTO, updatedAt: now });
      } else {
        open.add(name);
      }
    } else if (status === REMINDER_DISMISSED && String(o.doneBy ?? "") === REMINDER_BY_APP) {
      if (buy.has(name)) blocked.add(name);
      else receiptWrite(sheet, t.headers, o._row, { doneBy: REMINDER_BY_AUTO, updatedAt: now });
    }
  });
  const names = [...buy].filter(name => !open.has(name) && !blocked.has(name));
  if (!names.length) return;
  const listFor = reminderStockListResolver(ss);
  names.forEach(name => {
    const list = listFor(name);
    if (!list) {
      Logger.log(`「${name}」を入れる買い物リストがありません（「${REMINDER_OTHER_LIST}」のリストを用意してください）。`);
      return;
    }
    receiptAppend(sheet, {
      id: Utilities.getUuid(), listId: list.id, title: name, status: "", source: REMINDER_SOURCE_STOCK,
      stockItemName: name, createdAt: now, updatedAt: now,
    });
  });
}

// アプリから在庫を変えたあとに呼ぶ。失敗しても在庫の操作は成功として返す（5分ごとの処理でもう一度合わせる）
function syncStockRemindersSafe(ss) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
    syncStockReminders(ss);
  } catch (e) {
    Logger.log("買い物リストへの反映に失敗：" + e);
  } finally {
    lock.releaseLock();
  }
}

// 在庫の品目を入れるリストを決める関数を返す（表示中のリストだけが対象）
// 1. 「セール品目」の itemName が同じ行の baseShop（「/」区切りなら前から順に）
// 2. 「レシート明細」で matchedStock がその品目の、いちばん新しいレシートの store
// 3. 「その他・店未定」（なければ、店が空の買い物リスト）
function reminderStockListResolver(ss) {
  const lists = reminderActiveLists(ss);
  const baseShops = {};
  reminderSheetRows(ss, SHEET_SALE_ITEMS).forEach(o => {
    const name = normText(o.itemName);
    if (name && !(name in baseShops)) baseShops[name] = String(o.baseShop ?? "").split("/");
  });
  let lastStore = null; // 品目名 → いちばん新しいレシートの店（使うときに初めて読む）
  const other = lists.find(l => String(l.kind) === "買い物" && normText(l.name) === REMINDER_OTHER_LIST)
    || lists.find(l => String(l.kind) === "買い物" && !normText(l.store)) || null;
  return name => {
    for (const shop of baseShops[name] || []) {
      const list = reminderListForStore(lists, shop);
      if (list) return list;
    }
    if (!lastStore) lastStore = receiptLastStores(ss);
    return (lastStore[name] && reminderListForStore(lists, lastStore[name])) || other;
  };
}

// 品目名（matchedStock を正規化したもの）→ その品目が載ったいちばん新しいレシートの店
// レシートの新しさは purchasedAt（なければ明細の createdAt）で比べる
function receiptLastStores(ss) {
  const receipts = {};
  receiptRead(ss.getSheetByName(SHEET_RECEIPT)).rows.forEach(o => { receipts[String(o.id)] = o; });
  const best = {};
  receiptRead(ss.getSheetByName(SHEET_RECEIPT_ITEMS)).rows.forEach(o => {
    const name = normText(o.matchedStock);
    const r = receipts[String(o.receiptId)];
    if (!name || !r || !normText(r.store)) return;
    const time = receiptTime(r.purchasedAt) || receiptTime(o.createdAt) || 0;
    if (!best[name] || time >= best[name].time) best[name] = { time: time, store: r.store };
  });
  const out = {};
  Object.keys(best).forEach(name => { out[name] = best[name].store; });
  return out;
}

// ---- セットアップ・移行 ----

// 【一度だけ実行】やることタブの用意（何度実行しても重複しない）
// 1. 「リマインダーリスト」「リマインダー」シートを作り、足りない列を足す
// 2. 最初のリスト（REMINDER_DEFAULT_LISTS）のうち、同じ name のリストがないものを作る
// 3. 「家事」シートの行を家事のリストに移す（id をそのまま使い、同じ id の行があれば飛ばす）
// 4. checkChores のトリガーを消し、checkReminders を5分ごとに実行するトリガーを作る
// 5. 今の在庫から買い物リストの行を作る
function setupReminders() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const listSheet = receiptSheet(ss, SHEET_REMINDER_LIST, REMINDER_LIST_HEADERS);
  const sheet = receiptSheet(ss, SHEET_REMINDER, REMINDER_HEADERS);
  const now = new Date();

  const lists = receiptRead(listSheet).rows;
  let order = lists.reduce((max, o) => Math.max(max, Number(o.sortOrder) || 0), 0);
  let addedLists = 0;
  REMINDER_DEFAULT_LISTS.forEach(def => {
    if (lists.some(o => normText(o.name) === def.name)) return;
    const row = { id: Utilities.getUuid(), name: def.name, kind: def.kind, store: def.store, color: "", sortOrder: ++order,
      askStock: def.askStock === true, active: true, createdAt: now };
    receiptAppend(listSheet, row);
    lists.push(row);
    addedLists++;
  });

  const choreList = lists.find(o => normText(o.name) === "家事");
  const ids = new Set(receiptRead(sheet).rows.map(o => String(o.id)));
  let moved = 0;
  receiptRead(ss.getSheetByName(SHEET_CHORE)).rows.forEach(o => {
    if (!normText(o.taskName) || ids.has(String(o.id))) return;
    const rule = choreParseRule(o.rule);
    receiptAppend(sheet, {
      id: o.id, listId: choreList.id, title: normText(o.taskName), rule: rule ? JSON.stringify(rule) : "",
      cycle: rule ? choreLabel(rule) : "", nextDue: o.nextDue, lastDone: o.lastDone, notifiedFor: o.notifiedFor,
      status: "", source: REMINDER_SOURCE_MANUAL, createdAt: now, updatedAt: now,
    });
    moved++;
  });

  ScriptApp.getProjectTriggers()
    .filter(t => ["checkChores", "checkReminders"].indexOf(t.getHandlerFunction()) !== -1)
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger("checkReminders").timeBased().everyMinutes(5).create();

  syncStockReminders(ss);
  Logger.log(`リストを${addedLists}件作り、家事を${moved}件移しました。checkReminders を5分ごとに実行するトリガーを作成しました。`);
}

// 【一度だけ実行】やることのカテゴリの用意（何度実行しても重複しない）
// 1. 「リマインダーカテゴリ」シートを作り、「リマインダーリスト」に categoryId の列を足す
// 2. 「家事」「買い物」のカテゴリ（REMINDER_KINDS と同じ名前・種類）のうち、同じ名前のカテゴリがないものを作る
// 3. categoryId が空のリストを、kind と同じ名前・種類のカテゴリに入れる
function setupReminderCategories() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = receiptSheet(ss, SHEET_REMINDER_CATEGORY, REMINDER_CATEGORY_HEADERS);
  const listSheet = receiptSheet(ss, SHEET_REMINDER_LIST, REMINDER_LIST_HEADERS);
  const categories = receiptRead(sheet).rows;
  let added = 0;
  REMINDER_KINDS.forEach(kind => {
    if (categories.some(c => normText(c.name) === kind)) return;
    categories.push(reminderAddCategory(ss, { name: kind, type: kind }));
    added++;
  });
  const lists = receiptRead(listSheet);
  let moved = 0;
  lists.rows.forEach(o => {
    if (normText(o.categoryId)) return;
    const c = categories.find(c => normText(c.name) === String(o.kind) && String(c.type) === String(o.kind));
    if (!c) return;
    receiptWrite(listSheet, lists.headers, o._row, { categoryId: c.id });
    moved++;
  });
  Logger.log(`カテゴリを${added}件作り、リストを${moved}件カテゴリに入れました。`);
}

// 【一度だけ実行】「セール品目」に packUnit の列を足し、空の行にパックの単位の案を入れる（入っている行は変えない）
// packUnit は1回に買う上限（maxPack ÷ unitQty）の単位。まとめ売りのパックで買う品目だけに入れ、
// ふだん1個ずつ買う品目（詰め替え1袋・米1袋など）は空にしておく（セールでまとめ売りを買うときに必要なら単位を入れてよい）
// あわせて、ティッシュの1回に買う上限を2パック（10箱。maxPack=2500組）にする。何度実行しても結果は同じ
function fillSalePackUnits() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_SALE_ITEMS);
  if (!sheet) throw new Error(`シート「${SHEET_SALE_ITEMS}」が見つかりません。`);
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
  if (headers.indexOf("packUnit") === -1) {
    sheet.getRange(1, headers.length + 1).setValue("packUnit");
    headers.push("packUnit");
  }
  const proposals = {
    "トイレットペーパー": "袋", "ティッシュ": "パック", "キッチンペーパー": "袋", "ナプキン(ソフィ 超熟睡 330)": "パック",
    "デオドラント(エージーデオ24 プレミアム 無香料)": "セット", "麦茶(やさしい麦茶 680ml)": "箱", "ミネラルウォーター": "箱",
  };
  const t = receiptRead(sheet);
  let filled = 0;
  t.rows.forEach(o => {
    const unit = proposals[normText(o.itemName)];
    if (!unit || normText(o.packUnit)) return;
    receiptWrite(sheet, headers, o._row, { packUnit: unit });
    filled++;
  });
  Logger.log(`packUnit を${filled}行に入れました。`);

  // ティッシュ：5箱入り×2パック（1箱250組で2,500組）まで。note の「15箱まで」も合わせる
  const tissue = t.rows.find(o => normText(o.itemName) === "ティッシュ");
  if (tissue) {
    const note = String(tissue.note ?? "").replace("1回に買うのは15箱まで", "1回に買うのは2パック(10箱)まで");
    receiptWrite(sheet, headers, tissue._row, { maxPack: 2500, note: note });
    Logger.log("ティッシュの maxPack を 2500（2パック・10箱）にしました。");
  }
}
