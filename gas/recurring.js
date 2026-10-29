// =========================================================
// 家計簿：定期支出（サブスク・保険料など、決まった周期で払うもの）
//
// 「定期支出」シートに名前・金額・分類と周期（recurring-rule.js）を登録しておくと、
// 支払いの日（nextDate）になったら「取込待ち」シートに source=recurring の行を入れる。
// 家計簿への登録は、カード利用と同じく くらしログの確認待ちで内容を確かめてから行う。
// 取込待ちへの追加は毎朝 7:00 の notifyCouponsAndPending（receipt.js）と、定期支出を保存したときに行う。
// 取込待ちの id は「recurring:定期支出の id:支払いの日」なので、同じ回を二重に入れない。
// =========================================================
const SHEET_RECURRING = "定期支出";
const RECURRING_HEADERS = ["id", "name", "amount", "category", "tags", "memo", "payment", "unit", "interval", "start", "nextDate", "createdAt", "updatedAt"];
const RECURRING_DATE_COLUMNS = ["start", "nextDate"]; // yyyy-MM-dd の文字列で持つ列
const RECURRING_CATCH_UP = 24; // 1つの定期支出について、一度に取込待ちに入れる回数の上限（長く止まっていたとき用）

// ---- 一覧（次の支払いの日の近い順）----
function getRecurring() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_RECURRING);
  return receiptRead(sheet).rows.map(o => {
    const out = receiptOut(o);
    RECURRING_DATE_COLUMNS.forEach(k => { out[k] = normDate(o[k]); });
    return out;
  }).sort((a, b) => String(a.nextDate).localeCompare(String(b.nextDate)));
}

// ---- 追加・編集・削除（data.action：save / delete）----
// save：data.id があれば編集、なければ追加。次の支払いの日は今日以降で計算し直す
function recurringAction(ss, data) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sheet = receiptSheet(ss, SHEET_RECURRING, RECURRING_HEADERS, RECURRING_DATE_COLUMNS);
    const t = receiptRead(sheet);
    const found = data.id ? t.rows.find(o => String(o.id) === String(data.id)) : null;
    if (data.id && !found) throw new Error("定期支出が見つかりません。読み込み直してください。");
    if (data.action === "delete") {
      sheet.deleteRow(found._row);
      return;
    }
    const rule = { unit: String(data.unit || ""), interval: Number(data.interval), start: normDate(data.start) };
    if (!recurringValid(rule)) throw new Error("くり返しの指定が不正です。");
    const name = normText(data.name);
    const amount = Number(data.amount);
    const category = normText(data.category);
    if (!name) throw new Error("名前を入れてください。");
    if (!(amount > 0)) throw new Error("金額が不正です。");
    if (!category) throw new Error("カテゴリを選んでください。");
    const today = Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyy-MM-dd");
    const values = {
      name: name, amount: amount, category: category, tags: normTags(data.tags), memo: normText(data.memo), payment: normText(data.payment),
      unit: rule.unit, interval: rule.interval, start: rule.start, nextDate: recurringNextOnOrAfter(rule, today), updatedAt: receiptNow(),
    };
    if (found) receiptWrite(sheet, t.headers, found._row, values);
    else receiptAppend(sheet, Object.assign({ id: Utilities.getUuid(), createdAt: receiptNow() }, values));
    generateRecurringImports(ss); // 今日が支払いの日なら、すぐ確認待ちに出す
  } finally {
    lock.releaseLock();
  }
}

// ---- 支払いの日になった定期支出を取込待ちに入れる（呼び出し側でロックを取る）----
function generateRecurringImports(ss) {
  const sheet = ss.getSheetByName(SHEET_RECURRING);
  if (!sheet) return 0;
  const t = receiptRead(sheet);
  const today = Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyy-MM-dd");
  const importSheet = receiptSheet(ss, SHEET_IMPORT, IMPORT_BASE_HEADERS.concat(IMPORT_RECEIPT_HEADERS), ["usedAt"]);
  const known = new Set(receiptRead(importSheet).rows.map(o => String(o.id)));
  let added = 0;
  t.rows.forEach(o => {
    const rule = { unit: String(o.unit), interval: Number(o.interval), start: normDate(o.start) };
    if (!recurringValid(rule)) return;
    let next = normDate(o.nextDate) || recurringNextOnOrAfter(rule, today);
    for (let i = 0; next <= today && i < RECURRING_CATCH_UP; i++) {
      const id = `recurring:${o.id}:${next}`;
      if (!known.has(id)) {
        receiptAppend(importSheet, {
          id: id, source: "recurring", usedAt: next.replace(/-/g, "/"), merchant: normText(o.name), kind: recurringLabel(rule),
          amount: Number(o.amount), receivedAt: receiptNow(), status: "",
          suggestItems: JSON.stringify([{ category: normText(o.category), amount: Number(o.amount) }]),
          suggestTags: normTags(o.tags), suggestMemo: normText(o.memo), suggestPayment: normText(o.payment),
        });
        known.add(id);
        added++;
      }
      next = recurringNextAfter(rule, next);
    }
    if (next !== normDate(o.nextDate)) receiptWrite(sheet, t.headers, o._row, { nextDate: next });
  });
  return added;
}

// 【デバッグ用】定期支出を今すぐ取込待ちに入れる（支払いの日になったものだけ）
function debugGenerateRecurring() {
  Logger.log(`取込待ちに ${generateRecurringImports(SpreadsheetApp.getActiveSpreadsheet())}件 入れました。`);
}
