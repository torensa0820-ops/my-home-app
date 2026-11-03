// 起動：タブ切り替え、最新版の読み込み、各タブのデータ読み込み

// ---------- タブ切り替え ----------
const TAB_INFO = {
  stock:{title:'在庫管理', sub:'商品名をタップで編集・＋−で数量を更新'},
  coupon:{title:'クーポン', sub:'使ったら「使った」・不要なら「不要」'},
  todo:TODO_INFO
};
// タブの画面は、タブバーと同じ並びで横に並んでいるものとして動かす（右のタブを押したら右から入る）
const TAB_ORDER = [...document.querySelectorAll('nav.tabbar button')].map(b=>b.dataset.tab);
const tabPanel = tab=>document.getElementById(tab + '-panel');
// タブの題名と説明。やることタブはリストを開いたままならリストの題名
function tabHeadText(tab){
  if(tab === 'todo') return todoHeaderText(todo.listId ? todoListOf(todo.listId) : null);
  return [TAB_INFO[tab].title, TAB_INFO[tab].sub];
}
let tabSliding = null; // 動いている途中のタブの切り替えを、最後の位置まで送って終わらせる関数
// from のパネルを出し、to のパネルを dir の側（1＝右、-1＝左）から入れる
function slideTabPanels(from, to, dir){
  if(tabSliding) tabSliding();
  from.classList.remove('active');
  to.classList.add('active');
  const ms = motionMs();
  if(!ms) return;
  const els = [from, to];
  from.classList.add('tab-leaving');
  els.forEach(el=>{ el.style.transition = 'none'; });
  from.style.transform = 'translateX(0)';
  to.style.transform = `translateX(${dir * 100}%)`;
  void to.offsetWidth; // 置いた位置を確定させてから動かす
  els.forEach(el=>{ el.style.transition = motionTransition(ms); });
  from.style.transform = `translateX(${-dir * 100}%)`;
  to.style.transform = 'translateX(0)';
  // 動き終わったら transform を外す（付けたままだと、パネルの中の position:fixed の位置がずれる）
  const done = ()=>{
    clearTimeout(timer);
    tabSliding = null;
    from.classList.remove('tab-leaving');
    els.forEach(el=>{ el.style.transition = el.style.transform = ''; });
  };
  const timer = setTimeout(done, ms);
  tabSliding = done;
}
document.querySelectorAll('nav.tabbar button').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    const prev = document.querySelector('nav.tabbar button.active');
    const again = btn === prev;
    if(stockEditMode) setStockEditMode(false);
    closeComposeNow();
    const tab = btn.dataset.tab;
    if(!again){
      const from = prev.dataset.tab;
      const dir = TAB_ORDER.indexOf(tab) > TAB_ORDER.indexOf(from) ? 1 : -1;
      const oldHead = pageHead.current(), newHead = tabHeadText(tab);
      prev.classList.remove('active');
      btn.classList.add('active');
      slideTabPanels(tabPanel(from), tabPanel(tab), dir);
      // 題名も同じ向きに動かす（前面＝右側の題名）
      if(dir > 0) pageHead.slide(newHead, oldHead, 1, 0);
      else pageHead.slide(oldHead, newHead, 0, 1);
    }
    if(tab === 'todo') todoTabShown(again);
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
    loadStockImports(all.stockImports || {pending:[], auto:[]});
    loadCoupons(all.coupons || []);
    loadReminders(all.reminders);
  })
  .catch(err=>{
    document.getElementById('stock-list').replaceChildren(loadErrorView(err, ()=>{ reloadList('stock-list', loadStock); loadStockImports(); }));
    document.getElementById('coupons').replaceChildren(loadErrorView(err, ()=>reloadList('coupons', loadCoupons)));
    todoShowLoadError(err);
  });
