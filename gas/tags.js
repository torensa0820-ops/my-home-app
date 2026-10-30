// =========================================================
// タグ：在庫のタグの一括操作（名称変更・一括削除・一括付与）
// =========================================================

// ---- タグの一括操作 ----
// action: "rename"（名称変更。既存タグ名なら統合）/ "delete"（全行から外す）/ "assign"（指定行に付与）
// 戻り値：変更した行数
function manageTags(ss, data) {
  if (data.sheet !== "stock") throw new Error("sheet が不正です: " + data.sheet);
  const tag = normText(data.tag);
  if (!tag) throw new Error("タグ名が空です。");

  const sheet = ss.getSheetByName(SHEET_STOCK);
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
    const newName = normText(data.newName);
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
    // 商品名で指定
    const idxName = headers.indexOf("itemName");
    const names = new Set(targets);
    rows.forEach((r, i) => {
      const tags = splitTags(r[idxTags]);
      if (names.has(r[idxName]) && !tags.includes(tag)) setTags(i, tags.concat(tag));
    });
  } else {
    throw new Error("action が不正です: " + data.action);
  }

  if (count > 0) {
    sheet.getRange(2, idxTags + 1, tagsCol.length, 1).setValues(tagsCol.map(v => [v]));
  }
  return count;
}
