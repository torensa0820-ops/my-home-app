// =========================================================
// タグ：在庫・家計簿のタグの一括操作（名称変更・一括削除・一括付与）
// =========================================================

// ---- タグの一括操作（在庫・家計簿共通）----
// action: "rename"（名称変更。既存タグ名なら統合）/ "delete"（全行から外す）/ "assign"（指定行に付与）
// 戻り値：変更した行数
function manageTags(ss, data) {
  const sheetName = { stock: SHEET_STOCK, finance: SHEET_FINANCE }[data.sheet];
  if (!sheetName) throw new Error("sheet が不正です: " + data.sheet);
  const tag = String(data.tag || "").trim();
  if (!tag) throw new Error("タグ名が空です。");

  const sheet = ss.getSheetByName(sheetName);
  const values = sheet.getDataRange().getValues();
  const headers = values[0];
  const idxTags = headers.indexOf("tags");
  const rows = values.slice(1);
  const tagsCol = rows.map(r => r[idxTags]);
  let count = 0;

  const setTags = (i, tags) => {
    tagsCol[i] = [...new Set(tags)].join(",");
    count++;
  };

  if (data.action === "rename") {
    const newName = String(data.newName || "").trim();
    if (!newName || /[,，、]/.test(newName)) throw new Error("新しいタグ名が不正です。");
    rows.forEach((r, i) => {
      const tags = splitTags(r[idxTags]);
      if (tags.includes(tag)) setTags(i, tags.map(t => t === tag ? newName : t));
    });
  } else if (data.action === "delete") {
    rows.forEach((r, i) => {
      const tags = splitTags(r[idxTags]);
      if (tags.includes(tag)) setTags(i, tags.filter(t => t !== tag));
    });
  } else if (data.action === "assign") {
    if (/[,，、]/.test(tag)) throw new Error("タグ名に区切り文字は使えません。");
    const targets = data.targets || [];
    if (data.sheet === "stock") {
      // 在庫は商品名で指定
      const idxName = headers.indexOf("itemName");
      const names = new Set(targets);
      rows.forEach((r, i) => {
        const tags = splitTags(r[idxTags]);
        if (names.has(r[idxName]) && !tags.includes(tag)) setTags(i, tags.concat(tag));
      });
    } else {
      // 家計簿は行番号で指定し、一覧取得後にシートが並べ替えられていないか日付で確認する
      const idxDate = headers.indexOf("date");
      targets.forEach(t => {
        const i = Number(t.row) - 2;
        const r = rows[i];
        const date = r && (r[idxDate] instanceof Date ? r[idxDate].toISOString() : r[idxDate]);
        if (!r || date !== t.date) throw new Error("家計簿のデータが変更されています。一覧を読み込み直してください。");
      });
      targets.forEach(t => {
        const i = Number(t.row) - 2;
        const tags = splitTags(tagsCol[i]);
        if (!tags.includes(tag)) setTags(i, tags.concat(tag));
      });
    }
  } else {
    throw new Error("action が不正です: " + data.action);
  }

  if (count > 0) {
    sheet.getRange(2, idxTags + 1, tagsCol.length, 1).setValues(tagsCol.map(v => [v]));
  }
  return count;
}
