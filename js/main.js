// 起動：タブ切り替え、最新版の読み込み、各タブのデータ読み込み

// ---------- タブ切り替え ----------
const TAB_INFO = {
  stock:{title:'在庫管理', sub:'商品名をタップで編集・＋−で数量を更新'},
  finance:{title:'家計簿', sub:'記録をタップで編集・削除'},
  chore:{title:'家事ルーティン', sub:'家事名をタップで編集・完了ボタンは長押し'}
};
document.querySelectorAll('nav.tabbar button').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    if(stockEditMode) setStockEditMode(false);
    closeCompose();
    document.querySelectorAll('nav.tabbar button').forEach(b=>b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p=>p.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    document.getElementById(tab + '-panel').classList.add('active');
    document.getElementById('page-title').textContent = TAB_INFO[tab].title;
    document.getElementById('page-sub').textContent = TAB_INFO[tab].sub;
  });
});

// 最新版の読み込み：ページと、ページが読み込んでいるスクリプト・CSSをキャッシュを使わずに取り直して
// キャッシュを上書きし、再読み込みする（GitHub Pages は10分間キャッシュされるため）
document.getElementById('reload-btn').addEventListener('click', e=>{
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.classList.add('spinning');
  const files = [...document.querySelectorAll('script[src], link[rel="stylesheet"]')].map(el=>el.src || el.href);
  Promise.all([location.href.split('#')[0], ...files].map(u=>fetch(u, {cache:'reload'})))
    .catch(()=>{})
    .finally(()=>location.reload());
});

// ---------- 初期化 ----------
// 起動時のデータは1回のリクエストでまとめて取得する（再試行しても失敗したら、各一覧に理由と再読み込みボタンを出す）
getFromGas('action=getAll')
  .then(all=>{
    loadStock(all.stock);
    loadFinanceOptions(all.financeOptions);
    loadFinanceHistory(all.finance);
    loadChores(all.tasks);
  })
  .catch(err=>{
    document.getElementById('stock-list').replaceChildren(loadErrorView(err, ()=>reloadList('stock-list', loadStock)));
    document.getElementById('finance-list').replaceChildren(loadErrorView(err, ()=>{ loadFinanceOptions(); loadFinanceHistory(); }));
    document.getElementById('chore-list').replaceChildren(loadErrorView(err, ()=>reloadList('chore-list', loadChores)));
  });
