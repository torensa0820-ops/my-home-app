// タグ：チップでの選択、一覧の絞り込み、タグ管理（名称変更・一括削除・一括付与）

// タグのチップ選択（複数選択）＋新規タグ入力欄
function createTagPicker(chipsId, inputId){
  const wrap = document.getElementById(chipsId);
  const input = document.getElementById(inputId);
  const selected = new Set();
  let known = [];         // 登録済みのタグ（render で渡された候補）
  const added = new Set(); // 入力欄から追加した、まだ保存していないタグ
  function draw(){
    wrap.innerHTML = '';
    [...new Set([...known, ...added])].forEach(tag=>{
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip' + (selected.has(tag) ? ' on' : '');
      chip.textContent = tag;
      chip.addEventListener('click', ()=>{
        if(selected.has(tag)) selected.delete(tag); else selected.add(tag);
        chip.classList.toggle('on', selected.has(tag));
      });
      wrap.appendChild(chip);
    });
  }
  // 入力欄の文字をタグのチップにして選択済みにする
  function addFromInput(){
    const tags = splitTags(input.value);
    if(!tags.length) return;
    tags.forEach(t=>{ if(!known.includes(t)) added.add(t); selected.add(t); });
    input.value = '';
    draw();
  }
  // 改行（Enter）で追加する。日本語入力の変換確定の Enter では追加しない。フォームも送信しない
  input.addEventListener('keydown', e=>{
    if(e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    addFromInput();
  });
  return {
    render(tags){
      // 名称変更・削除で無くなったタグは選択状態からも外す（入力欄から追加したタグは残す）
      [...selected].forEach(t=>{ if(!tags.includes(t) && !added.has(t)) selected.delete(t); });
      known = tags;
      draw();
    },
    // render の前に呼ぶと、そのタグを選択済みの状態で表示する
    select(tag){ selected.add(tag); },
    // 選択中のタグを入れ替える（一覧のタップでフォームに入力するとき用）
    set(tags){
      // 候補のチップにないタグは、選択状態が見えるようチップとして追加する
      selected.clear();
      added.clear();
      tags.forEach(t=>{ if(!known.includes(t)) added.add(t); selected.add(t); });
      input.value = '';
      draw();
    },
    // 選択中のタグと、入力欄に残っているタグを「,」区切りの文字列にする
    value(){
      return [...new Set([...selected, ...splitTags(input.value)])].join(',');
    },
    clear(){
      selected.clear();
      added.clear();
      input.value = '';
      draw();
    }
  };
}
// タグ（と、opts.categories なら カテゴリ）の絞り込み
// 一覧の上には「絞り込み」ボタンと選択中のカテゴリ・タグだけを出し、候補は下から出るパネルに折り返して並べる
// パネルは一覧に重ねて表示するので、選ぶとすぐ上の一覧に結果が反映される
// カテゴリは選んだもののいずれか、タグとの組み合わせは「カテゴリの条件かつタグの条件」
function createFilterBar(barId, sheet, onChange, opts = {}){
  const bar = document.getElementById(barId);
  const section = bar.closest('.tab-panel');
  const status = h('div', {class:'filter-status'});
  bar.after(status);
  const selected = new Set();
  const selectedCats = new Set();
  let mode = 'any';
  let tags = [];
  let categories = [];
  const clearAll = ()=>{ selected.clear(); selectedCats.clear(); changed(); };

  // ---- パネル ----
  const search = h('input', {type:'search', class:'filter-search', placeholder:'タグを検索', oninput:()=>drawPanel()});
  const modeSeg = h('div', {class:'seg'});
  const cloud = h('div', {class:'chips filter-cloud'});
  const catCloud = h('div', {class:'chips filter-cloud'});
  const panel = h('div', {class:'compose', role:'dialog'},
    h('div', {class:'compose-grip'}, h('span')),
    h('div', {class:'compose-head'},
      h('h2', {}, opts.categories ? '絞り込む' : 'タグで絞り込む'),
      h('button', {type:'button', class:'text-btn', onclick:closeCompose}, '閉じる')),
    h('p', {class:'compose-hint'}, opts.categories ? '選んだカテゴリ・タグのデータだけを一覧に表示します' : '選んだタグの付いたデータだけを一覧に表示します'),
    h('div', {class:'compose-body'},
      opts.categories ? [h('div', {class:'filter-label'}, 'カテゴリ（いずれか）'), catCloud, h('div', {class:'filter-label'}, 'タグ')] : '',
      h('div', {class:'filter-tools'}, search, modeSeg),
      cloud,
      h('div', {class:'filter-actions'},
        h('button', {type:'button', class:'cancel-btn', onclick:clearAll}, '選択をすべて解除'),
        h('button', {type:'button', class:'cancel-btn', onclick:()=>{ closeCompose(); openTagManager(sheet); }}, 'タグを管理'))));
  panel.dataset.kind = 'filter';
  section.append(panel);
  enableComposeDrag(panel);

  const changed = ()=>{ draw(); onChange(); };
  const toggle = (set, v)=>{ if(set.has(v)) set.delete(v); else set.add(v); changed(); };
  function drawPanel(){
    catCloud.innerHTML = '';
    if(!categories.length) catCloud.append(h('p', {class:'tm-note'}, 'カテゴリはまだありません'));
    categories.forEach(c=>catCloud.append(h('button', {type:'button', class:'chip cat' + (selectedCats.has(c) ? ' on' : ''), onclick:()=>toggle(selectedCats, c)}, c)));
    modeSeg.innerHTML = '';
    [['any', 'いずれかを含む'], ['all', 'すべてを含む']].forEach(([m, label])=>modeSeg.append(
      h('button', {type:'button', class: mode === m ? 'on' : '', onclick:()=>{ if(mode !== m){ mode = m; changed(); } }}, label)));
    cloud.innerHTML = '';
    const q = search.value.trim().toLowerCase();
    const shown = tags.filter(t=>!q || t.toLowerCase().includes(q));
    if(!shown.length) cloud.append(h('p', {class:'tm-note'}, tags.length ? '該当するタグがありません' : 'タグはまだありません'));
    shown.forEach(t=>cloud.append(h('button', {type:'button', class:'chip' + (selected.has(t) ? ' on' : ''), onclick:()=>toggle(selected, t)}, t)));
  }
  // ---- 一覧の上のバー ----
  function drawBar(){
    bar.innerHTML = '';
    const count = selectedCats.size + selected.size;
    const open = h('button', {type:'button', class:'filter-open' + (count ? ' on' : ''), onclick:()=>openCompose('filter')},
      count ? `絞り込み（${count}）` : '絞り込み');
    // 選択中のカテゴリ・タグは×付きで並べ、タップで外せるようにする
    const chips = h('div', {class:'filter-chips'});
    [...selectedCats].forEach(c=>chips.append(h('button', {type:'button', class:'chip cat on', onclick:()=>toggle(selectedCats, c)}, `${c} ×`)));
    [...selected].forEach(t=>chips.append(h('button', {type:'button', class:'chip on', onclick:()=>toggle(selected, t)}, `${t} ×`)));
    bar.append(open, chips, h('button', {type:'button', class:'filter-manage', onclick:()=>openTagManager(sheet)}, '管理'));
    status.innerHTML = '';
    if(count){
      status.append(h('span', {class:'count'}),
        selected.size > 1 ? h('span', {}, mode === 'any' ? '・タグはいずれかを含む' : '・タグはすべてを含む') : '',
        h('button', {type:'button', class:'clear', onclick:clearAll}, '絞り込みを解除'));
    }
  }
  function draw(){ drawBar(); drawPanel(); }

  return {
    // タグ一覧を描き直す。名称変更・削除で無くなったタグは選択から外し、絞り込みを更新する
    render(list){
      tags = list;
      const before = selected.size;
      [...selected].forEach(t=>{ if(!tags.includes(t)) selected.delete(t); });
      draw();
      if(selected.size !== before) onChange();
    },
    // カテゴリ一覧を描き直す（opts.categories のときだけ使う）。無くなったカテゴリは選択から外す
    renderCategories(list){
      categories = list;
      const before = selectedCats.size;
      [...selectedCats].forEach(c=>{ if(!categories.includes(c)) selectedCats.delete(c); });
      draw();
      if(selectedCats.size !== before) onChange();
    },
    active(){ return selected.size > 0 || selectedCats.size > 0; },
    matches(tagStr){
      if(!selected.size) return true;
      const t = splitTags(tagStr);
      return mode === 'all' ? [...selected].every(x=>t.includes(x)) : [...selected].some(x=>t.includes(x));
    },
    // カテゴリ名には「,」などが入りうるので、カテゴリは JSON の配列で送る
    query(){
      return (selected.size ? `&tags=${encodeURIComponent([...selected].join(','))}&mode=${mode}` : '')
        + (selectedCats.size ? `&categories=${encodeURIComponent(JSON.stringify([...selectedCats]))}` : '');
    },
    // 絞り込み結果の件数を表示する
    setCount(text){ const el = status.querySelector('.count'); if(el) el.textContent = text; }
  };
}

const TM_LABEL = {stock:'在庫', finance:'家計簿'};

function tmTagCounts(){
  if(tm.sheet === 'finance') return financeOpts.tagCounts || {};
  const counts = {};
  // 在庫は商品単位で数える（同じ商品のロットは1件）
  groupStock().forEach(g=>splitTags(g.tags).forEach(t=>counts[t] = (counts[t] || 0) + 1));
  return counts;
}
function openTagManager(sheet){ openSheet(sheet, tmListView); }

document.querySelectorAll('[data-tag-manage]').forEach(b=>b.addEventListener('click', ()=>openTagManager(b.dataset.tagManage)));

// GASでタグを一括操作し、成功したら候補とカウントを読み込み直す
function tagOp(payload){
  tm.busy = true;
  return postToGas({type:'tag', sheet:tm.sheet, ...payload})
    .then(res=>{
      if(res.status !== 'success') throw new Error(res.message || '処理に失敗しました');
      return (tm.sheet === 'stock' ? loadStock() : loadFinanceOptions()).then(()=>res);
    })
    .finally(()=>{ tm.busy = false; });
}
function hasSeparator(name){
  if(/[,，、]/.test(name)){ toast('タグ名に「,」「、」は使えません'); return true; }
  return false;
}

function tmListView(){
  tmTitle.textContent = `${TM_LABEL[tm.sheet]}のタグ`;
  const counts = tmTagCounts();
  const tags = uniqSorted(Object.keys(counts));
  const input = h('input', {type:'text', placeholder:'新しいタグ名'});
  const next = ()=>{
    const name = input.value.trim();
    if(!name || hasSeparator(name)) return;
    tmShow(counts[name] ? tmDetailView : tmAssignView, name);
  };
  tmBody.append(
    h('div', {class:'tm-section'},
      h('h3', {}, '新しいタグを作って付ける'),
      h('div', {class:'tm-inline'}, input, h('button', {type:'button', class:'tm-btn', onclick:next}, '次へ'))),
    h('div', {class:'tm-section'},
      h('h3', {}, '登録済みのタグ'),
      tags.length
        ? tags.map(t=>h('button', {type:'button', class:'tm-row', onclick:()=>tmShow(tmDetailView, t)},
            h('span', {class:'name'}, t), h('span', {class:'count'}, `${counts[t]}件`), h('span', {class:'chev'}, '›')))
        : h('p', {class:'tm-note'}, 'タグはまだありません'))
  );
}

function tmDetailView(tag){
  tmTitle.textContent = tag;
  const count = tmTagCounts()[tag] || 0;
  const input = h('input', {type:'text', value:tag});
  const renameBtn = h('button', {type:'button', class:'tm-btn', onclick:()=>{
    const newName = input.value.trim();
    if(!newName || newName === tag || hasSeparator(newName)) return;
    if(tmTagCounts()[newName] && !confirm(`「${newName}」は既にあります。「${tag}」を「${newName}」に統合しますか？`)) return;
    renameBtn.disabled = true;
    tagOp({action:'rename', tag, newName})
      .then(res=>{ toast(`${res.count}件のタグ名を変更しました`); tm.stack.pop(); tmShow(tmDetailView, newName); })
      .catch(err=>{ toast(errMsg(err)); renameBtn.disabled = false; });
  }}, '変更');
  const deleteBtn = makeHoldButton('長押しでタグを削除', reset=>{
    tagOp({action:'delete', tag})
      .then(res=>{ toast(`${res.count}件から「${tag}」を外しました`); tm.stack.pop(); tmRender(); })
      .catch(err=>{ toast(errMsg(err)); reset(); });
  });
  tmBody.append(
    h('p', {class:'tm-note tm-lead'}, `${count}件に付いています`),
    h('div', {class:'tm-section'},
      h('h3', {}, '名前を変更'),
      h('div', {class:'tm-inline'}, input, renameBtn),
      h('p', {class:'tm-note'}, '既にあるタグ名にすると、2つのタグが1つにまとめられます。')),
    h('div', {class:'tm-section'},
      h('h3', {}, 'まとめて付ける'),
      h('button', {type:'button', class:'tm-btn tm-wide', onclick:()=>tmShow(tmAssignView, tag)}, '付ける行を選ぶ')),
    h('div', {class:'tm-section'},
      h('h3', {}, '削除'),
      h('p', {class:'tm-note'}, 'すべての行からこのタグを外します。行そのものは削除されません。'),
      deleteBtn)
  );
}

function tmAssignView(tag){
  tmTitle.textContent = `「${tag}」を付ける`;
  const selected = new Map(); // key → GASに送る対象
  const submit = h('button', {type:'button', class:'tm-btn tm-wide'});
  const update = ()=>{
    submit.disabled = selected.size === 0;
    submit.textContent = selected.size ? `${selected.size}件に付ける` : '付ける行を選んでください';
  };
  submit.addEventListener('click', ()=>{
    submit.disabled = true;
    submit.textContent = '処理中…';
    tagOp({action:'assign', tag, targets:[...selected.values()]})
      .then(res=>{
        toast(`${res.count}件に「${tag}」を付けました`);
        tm.stack.pop();
        const [view, args] = tm.stack[tm.stack.length - 1];
        if(view === tmDetailView && args[0] === tag) tmRender(); else tmShow(tmDetailView, tag);
      })
      .catch(err=>{ toast(errMsg(err)); update(); });
  });
  update();
  tmFoot.append(submit);

  const makeRow = (key, target, title, sub, has)=>{
    const cb = h('input', {type:'checkbox', checked:has, disabled:has, onchange:()=>{
      if(cb.checked) selected.set(key, target); else selected.delete(key);
      update();
    }});
    return h('label', {class:'tm-check' + (has ? ' done' : '')}, cb,
      h('div', {class:'main'}, h('div', {class:'t1'}, title), h('div', {class:'t2'}, has ? '付与済み' : sub)));
  };

  if(tm.sheet === 'stock'){
    const groups = groupStock().sort((a,b)=>a.name.localeCompare(b.name, 'ja'));
    if(!groups.length){ tmBody.append(h('p', {class:'tm-note'}, '商品がありません')); return; }
    groups.forEach(g=>{
      const tags = splitTags(g.tags);
      const sub = [g.location, tags.join(', ')].filter(Boolean).join(' ・ ') || '収納場所・タグなし';
      tmBody.append(makeRow(g.name, g.name, g.name, sub, tags.includes(tag)));
    });
    return;
  }

  // 家計簿は新しい順に30件ずつ読み込み、月ごとに見出しを付ける
  const PAGE = 30;
  let offset = 0, lastMonth = null;
  const list = h('div');
  const status = h('p', {class:'tm-note'}, '読み込み中…');
  const more = h('button', {type:'button', class:'cancel-btn', onclick:()=>loadMore()});
  tmBody.append(list);
  function loadMore(){
    more.remove();
    status.textContent = '読み込み中…';
    tmBody.append(status);
    getFromGas(`action=getFinance&offset=${offset}&limit=${PAGE}`)
      .then(data=>{
        status.remove();
        data.rows.forEach(r=>{
          const d = finDay(r);
          const month = `${d.getFullYear()}年${d.getMonth() + 1}月`;
          if(month !== lastMonth){ list.append(h('div', {class:'tm-month'}, month)); lastMonth = month; }
          const tags = splitTags(r.tags);
          const title = `${d.getMonth() + 1}/${d.getDate()}　${r.category || '—'}　¥${(Number(r.amount) || 0).toLocaleString()}`;
          const sub = [r.memo, tags.join(', ')].filter(Boolean).join(' ・ ') || 'メモ・タグなし';
          list.append(makeRow('row' + r.row, {row:r.row, date:r.date}, title, sub, tags.includes(tag)));
        });
        offset += data.rows.length;
        if(!data.total) list.append(h('p', {class:'tm-note'}, '記録がありません'));
        else if(offset < data.total){
          more.textContent = `さらに${PAGE}件読み込む（残り${data.total - offset}件）`;
          tmBody.append(more);
        }
      })
      .catch(err=>{ status.remove(); more.textContent = `読み込みに失敗しました（${errMsg(err)}）。タップで再試行`; tmBody.append(more); });
  }
  loadMore();
}
