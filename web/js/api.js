// 與 Supabase 溝通的唯一出入口。
// 注意：前端只放「公開（anon / publishable）金鑰」；所有權限由資料庫 RLS 強制執行。
const cfg = window.APP_CONFIG || {};
const VIEWER_TOKEN_KEY = 'cf-viewer-token';

export const configured = Boolean(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY);

export const adminClient = configured
  ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, storageKey: 'cf-admin-session' },
    })
  : null;

let viewerClient = null;
function getStoredToken() { try { return localStorage.getItem(VIEWER_TOKEN_KEY); } catch { return null; } }
function setStoredToken(t) { try { t ? localStorage.setItem(VIEWER_TOKEN_KEY, t) : localStorage.removeItem(VIEWER_TOKEN_KEY); } catch { /* 無痕模式 */ } }

function makeViewerClient(token) {
  return window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: 'cf-viewer-none' },
    global: { headers: token ? { 'x-viewer-token': token } : {} },
  });
}

export const state = { mode: 'none', user: null, siteInfo: null, client: null };

export async function initSession() {
  state.mode = 'none'; state.user = null; state.client = null;
  if (!configured) return state;
  const { data: { session } } = await adminClient.auth.getSession();
  if (session) {
    const { data: info } = await adminClient.rpc('site_info');
    if (info?.is_admin) {
      state.mode = 'admin'; state.user = session.user; state.client = adminClient; state.siteInfo = info;
      return state;
    }
    const { data: aal } = await adminClient.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aal && aal.nextLevel === 'aal2' && aal.currentLevel !== 'aal2') {
      state.mode = 'mfa'; state.user = session.user; state.client = adminClient; state.siteInfo = info;
      return state;
    }
  }
  const token = getStoredToken();
  viewerClient = makeViewerClient(token);
  const { data: info, error } = await viewerClient.rpc('site_info');
  state.siteInfo = info || null;
  if (!error && info?.viewer_ok) { state.mode = 'viewer'; state.client = viewerClient; }
  else if (token) setStoredToken(null);
  return state;
}

export async function viewerLogin(password) {
  const c = makeViewerClient(null);
  const { data, error } = await c.rpc('viewer_login', { p_password: password });
  if (error) return { ok: false, error: 'network', message: error.message };
  if (data?.ok) setStoredToken(data.token);
  return data;
}

export async function viewerLogout() {
  if (viewerClient) await viewerClient.rpc('viewer_logout');
  setStoredToken(null);
}

export async function adminLogin(email, password) {
  const { data, error } = await adminClient.auth.signInWithPassword({ email, password });
  if (error) return { ok: false, message: error.message };
  return { ok: true, user: data.user };
}

export async function adminLogout() { await adminClient.auth.signOut(); }

// 以「目前管理者帳號」重新驗證密碼（更改瀏覽密碼前使用）
export async function adminReauth(password) {
  const email = state.user?.email;
  if (!email) return { ok: false, message: '找不到管理者帳號' };
  const { error } = await adminClient.auth.signInWithPassword({ email, password });
  if (error) return { ok: false, message: '管理者密碼錯誤' };
  return { ok: true };
}

// 鄰居可讀欄位（與資料庫欄位授權一致；管理者讀全部欄位）
const VIEW_COLS = {
  app_settings: 'id,community_name,public_notice,data_limit_notice,opening_balance,opening_balance_label,opening_roc_year,opening_month,updated_at',
  analysis_categories: 'id,side,name,is_repair,sort_order,description',
  accounts: 'id,side,standard_name,analysis_category_id,is_repair,sort_order,active,description',
  repair_categories: 'id,name,keywords,sort_order,description',
  vendors: 'id,canonical_name,vendor_type,public_note',
  reports: 'id,roc_year,month,title,period_text,status,is_published,published_at,reported_prior_balance,reported_income_total,reported_expense_total,reported_period_balance,reported_cumulative_balance,reported_figures_note,bank_balance,bank_balance_date,public_note,updated_at',
  report_subtotals: 'id,report_id,side,label,original_group,reported_amount,sort_order,review_status',
  transactions: 'id,report_id,roc_year,month,side,original_group,original_account_name,account_id,original_summary,amount,counterparty_raw,vendor_id,payer_status,transaction_date,date_raw,analysis_category_id,is_repair,repair_category_id,source_row_no,ocr_status,review_status,is_public,public_note,verified_at,updated_at',
  repair_items: 'id,name,facility,location,repair_category_id,public_note',
  transaction_repair_links: 'transaction_id,repair_item_id',
};

export async function fetchAll(table, { order = 'id', filter } = {}) {
  const cols = state.mode === 'admin' ? '*' : VIEW_COLS[table] || '*';
  const out = [];
  const size = 1000;
  for (let from = 0; ; from += size) {
    let q = state.client.from(table).select(cols).order(order, { ascending: true }).range(from, from + size - 1);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}：${error.message}`);
    out.push(...data);
    if (data.length < size) break;
  }
  return out;
}

export async function loadData() {
  const c = state.client;
  const isAdmin = state.mode === 'admin';
  const [settings, categories, accounts, repairCats, vendors, reports, subtotals, transactions, items, links, hidden] = await Promise.all([
    c.from('app_settings').select(isAdmin ? '*' : VIEW_COLS.app_settings).eq('id', 1).maybeSingle().then((r) => { if (r.error) throw r.error; return r.data || {}; }),
    fetchAll('analysis_categories'), fetchAll('accounts'), fetchAll('repair_categories'), fetchAll('vendors'),
    fetchAll('reports'), fetchAll('report_subtotals'), fetchAll('transactions'), fetchAll('repair_items'),
    fetchAll('transaction_repair_links', { order: 'transaction_id' }),
    isAdmin ? Promise.resolve([]) : c.rpc('hidden_transaction_aggregates').then((r) => { if (r.error) throw r.error; return r.data || []; }),
  ]);
  const extra = isAdmin
    ? await Promise.all([fetchAll('vendor_aliases'), fetchAll('report_files'), fetchAll('account_mappings')])
    : [[], [], []];
  return { settings, categories, accounts, repairCats, vendors, reports, subtotals, transactions, items, links, hidden,
           aliases: extra[0], files: extra[1], mappings: extra[2] };
}

export async function rpc(name, args) {
  const { data, error } = await state.client.rpc(name, args);
  if (error) throw new Error(error.message);
  return data;
}

export async function q(promise) {
  const { data, error } = await promise;
  if (error) throw new Error(error.message);
  return data;
}

export const db = () => state.client;
