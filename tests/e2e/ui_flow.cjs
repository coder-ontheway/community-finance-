// 瀏覽器端到端測試：以真實瀏覽器操作網站（管理者匯入、公開、鄰居唯讀、改密碼、手機／平板版面）
// 用法：WEB=http://localhost:8080 IMPORT_JSON=... REPORT_IMG=... SHOTS=輸出資料夾 node tests/e2e/ui_flow.cjs
const { chromium, devices } = require('playwright');
const fs = require('fs');

const WEB = process.env.WEB || 'http://localhost:8080';
const SHOTS = process.env.SHOTS || '/tmp/shots';
const ADMIN = { email: process.env.ADMIN_EMAIL || 'admin@example.test', password: process.env.ADMIN_PASSWORD || 'AdminPass-2026' };
const PW = 'Ui-Test-Neighbor-1';
const PW_NEW = 'Ui-Test-Neighbor-2';
fs.mkdirSync(SHOTS, { recursive: true });
// 驗收數字一律取自匯入檔，儲存庫中不寫入真實財務資料
const IMP = JSON.parse(fs.readFileSync(process.env.IMPORT_JSON, 'utf8'));
const FIG = Object.fromEntries(IMP.rows.filter((r) => !['detail', 'group_subtotal', 'ignore'].includes(r.row_type)).map((r) => [r.row_type, r.amount]));
const DET = IMP.rows.filter((r) => r.row_type === 'detail');
const N_INC = DET.filter((r) => r.side === 'income').length, N_EXP = DET.length - N_INC;
const N_SUB = IMP.rows.filter((r) => r.row_type === 'group_subtotal').length, N_FIG = Object.keys(FIG).length;
const N_ALL = IMP.rows.length;
const RY = IMP.report.roc_year, RM = IMP.report.month;
const fmt = (n) => n.toLocaleString('en-US');
const esc = (t) => t.replace(/[-]/g, '\\-');
const PRIOR_UNCERTAIN = IMP.rows.some((r) => r.row_type === 'prior_balance' && r.uncertain_fields?.length);
const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };

async function newPage(browser, opts = {}) {
  const ctx = await browser.newContext({ ...opts, locale: 'zh-TW' });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) page.errors.push(m.text()); });
  page.on('dialog', (d) => d.accept());
  return page;
}
const confirmModal = async (page, text) => {
  const m = page.locator('.modal').last();
  if (text) await m.locator('[data-req]').fill(text);
  await m.locator('[data-ok]').click();
};

(async () => {
  const browser = await chromium.launch();
  const page = await newPage(browser, { viewport: { width: 1440, height: 900 } });
  await page.goto(WEB);
  await page.waitForSelector('#viewer-form');
  check('未登入時只顯示登入畫面', (await page.locator('#view').count()) === 0);

  // 管理者登入
  await page.locator('details.admin-login summary').click();
  await page.fill('#admin-form [name=email]', ADMIN.email);
  await page.fill('#admin-form [name=password]', ADMIN.password);
  await page.click('#admin-form button');
  await page.waitForSelector('.role-badge.admin');
  check('管理者登入成功', true);

  // 新增月報表
  await page.goto(WEB + '/#/reports');
  await page.click('#new-report');
  await page.fill('#rf [name=roc_year]', String(RY));
  await page.fill('#rf [name=month]', String(RM));
  await page.fill('#rf [name=title]', IMP.report.title);
  await page.fill('#rf [name=period_text]', IMP.report.period_text);
  await page.click('#rf button');
  await page.waitForURL(/#\/report\/\d+/);
  const reportUrl = page.url();
  check(`建立 ${RY} 年 ${RM} 月報表`, true);

  // 上傳報表圖片
  await page.setInputFiles('#upload', process.env.REPORT_IMG);
  await page.waitForSelector('[data-view-file]');
  check('上傳原始報表圖片', true);
  // 重複上傳同一檔案應被擋
  await page.setInputFiles('#upload', process.env.REPORT_IMG);
  await page.waitForSelector('.toast-error');
  check('重複上傳同一檔案被擋下', (await page.locator('.toast-error').innerText()).includes('已經上傳過'));

  // JSON 匯入到核對區
  await page.click('[data-new-batch=json]');
  await page.waitForURL(/#\/import\/\d+/);
  await page.setInputFiles('#json-file', process.env.IMPORT_JSON);
  await page.waitForFunction(() => document.querySelectorAll('.row-card').length > 0);
  await page.waitForFunction((n) => document.querySelectorAll('.row-card').length === n, N_ALL, { timeout: 10000 }).catch(() => {});
  const nRows = await page.locator('.row-card').count();
  check(`JSON 載入核對區（${N_INC} 收入＋${N_EXP} 支出＋${N_SUB} 小計＋${N_FIG} 報表數字）`, nRows === N_ALL, `${nRows} 列`);
  await page.waitForFunction(() => /已儲存/.test(document.querySelector('#save-state')?.textContent || ''), null, { timeout: 15000 });
  const totals = await page.locator('#totals').innerText();
  check(`核對區即時加總與報表一致（${4 + N_SUB} 項）`, (totals.match(/\t一致/g) || []).length === 4 + N_SUB);
  await page.screenshot({ path: `${SHOTS}/01_admin_import_review.png`, fullPage: false });

  // 未核對直接寫入 → 應失敗
  await page.click('#commit');
  await page.waitForSelector('#do-commit');
  await page.click('#do-commit');
  await page.waitForFunction(() => [...document.querySelectorAll('.toast-error')].some((t) => /尚未核對/.test(t.textContent)), null, { timeout: 10000 }).then(() => check('未核對資料無法寫入', true), () => check('未核對資料無法寫入', false));
  await page.locator('.modal [data-close]').first().click();

  // 全部標記已核對 → 寫入
  await page.click('#verify-all');
  await confirmModal(page, '我已逐筆核對');
  await page.waitForFunction(() => /已儲存/.test(document.querySelector('#save-state')?.textContent || ''), null, { timeout: 15000 });
  await page.click('#commit');
  await page.waitForSelector('#do-commit');
  await page.click('#do-commit');
  await page.waitForURL(/#\/report\/\d+/, { timeout: 15000 });
  await page.waitForSelector('table.recon');
  const recon = await page.locator('table.recon').first().innerText();
  for (const [label, key] of [['收入小計', 'income_total'], ['支出小計', 'expense_total'], ['本期結餘', 'period_balance'], ['累計結餘', 'cumulative_balance']]) {
    const v = esc(fmt(FIG[key]));
    check(`寫入後：${label} ${fmt(FIG[key])} 一致`, new RegExp(`${label}\\s+${v}\\s+${v}\\s+0（一致）`).test(recon));
  }
  const groups = await page.locator('table.recon').nth(1).innerText();
  check(`${N_SUB} 個大項小計全部一致`, (groups.match(/0（一致）/g) || []).length === N_SUB);
  if (PRIOR_UNCERTAIN) check('前期餘絀標示待人工核對', (await page.locator('.notice.warn').first().innerText()).includes('前期餘絀：待人工核對'));
  await page.screenshot({ path: `${SHOTS}/02_admin_report_reconcile.png`, fullPage: true });

  // 再次匯入應提醒重複
  await page.click('[data-new-batch=json]');
  await page.waitForSelector('.modal');
  check('再次匯入時提醒可能重複', (await page.locator('.modal').innerText()).includes('重複加總'));
  await page.locator('.modal [data-no]').click();

  // 公開
  await page.click('#publish');
  await confirmModal(page);
  await page.waitForSelector('#unpublish');
  check('公開月報表', true);

  // 設定起算餘額
  await page.goto(WEB + '/#/settings');
  await page.fill('#sf [name=opening_balance]', String(FIG.prior_balance));
  await page.fill('#sf [name=opening_balance_label]', `${RY}年${RM}月報表前期餘絀`);
  await page.fill('#sf [name=opening_roc_year]', String(RY));
  await page.fill('#sf [name=opening_month]', String(RM));
  await page.click('#sf button');
  await page.waitForFunction(() => [...document.querySelectorAll('.toast-success')].some((t) => t.textContent === '已儲存'));

  // 共同瀏覽密碼
  await page.goto(WEB + '/#/viewer-password');
  await page.waitForSelector('#pw-form');
  await page.fill('#pw-form [name=p1]', PW);
  await page.fill('#pw-form [name=p2]', PW + 'x');
  await page.fill('#pw-form [name=admin_pw]', ADMIN.password);
  await page.click('#pw-form button');
  await page.waitForSelector('#pw-result .notice');
  check('兩次密碼不一致時顯示失敗', (await page.locator('#pw-result').innerText()).includes('不一致'));
  await page.fill('#pw-form [name=p2]', PW);
  await page.fill('#pw-form [name=admin_pw]', 'wrong-admin-password');
  await page.click('#pw-form button');
  await page.waitForFunction(() => /管理者密碼錯誤/.test(document.querySelector('#pw-result')?.textContent || ''));
  check('管理者密碼錯誤時不能更改', true);
  await page.fill('#pw-form [name=admin_pw]', ADMIN.password);
  await page.click('#pw-form button');
  await page.waitForFunction(() => /更改成功/.test(document.querySelector('#pw-result')?.textContent || ''), null, { timeout: 15000 });
  check('設定共同瀏覽密碼成功並顯示結果', true);
  await page.screenshot({ path: `${SHOTS}/03_admin_viewer_password.png`, fullPage: true });

  // 管理者瀏覽各頁，確認沒有 JavaScript 錯誤
  for (const [route, name] of [['', '04_admin_dashboard'], ['repairs', '05_admin_repairs'], ['vendors', '06_admin_vendors'], ['accounts', '07_admin_accounts'],
    ['tx', '08_admin_search'], ['settings', '09_admin_settings'], ['export', '10_admin_export'], ['audit', '11_admin_audit']]) {
    await page.goto(`${WEB}/#/${route}`);
    await page.waitForFunction(() => !document.querySelector('#view .loading'));
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
  }
  await page.goto(`${WEB}/#/repairs`); await page.click('[data-tab=clues]'); await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/05b_admin_repair_clues.png`, fullPage: true });
  check('修繕線索頁面呈現「待查核線索」字樣且不含指控用語', await page.locator('.clues').innerText().then((t) => t.includes('待查核線索') && !/重複請款|浪費公帑/.test(t)));
  // 點擊儀表板 KPI 可下鑽明細
  await page.goto(`${WEB}/#/`); await page.waitForSelector('[data-drill=exp]');
  await page.click('[data-drill=exp]');
  await page.waitForSelector('.modal .tx-table');
  check(`點擊總支出可看到 ${N_EXP} 筆明細`, (await page.locator('.modal .table-meta').innerText()).includes(`共 ${N_EXP} 筆`));
  await page.locator('.modal [data-close]').click();
  // 匯出 CSV
  await page.goto(`${WEB}/#/export`);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#csv')]);
  const csv = fs.readFileSync(await dl.path(), 'utf8');
  check(`CSV 匯出含 BOM 且有 ${DET.length} 筆明細`, csv.charCodeAt(0) === 0xfeff && csv.trim().split('\r\n').length === DET.length + 1);
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('#backup')]);
  const bk = JSON.parse(fs.readFileSync(await dl2.path(), 'utf8'));
  check('JSON 備份含檢查碼且不含密碼', bk.checks.transactions.count === DET.length && bk.checks.transactions.income === FIG.income_total && !JSON.stringify(bk).includes(PW));
  const [dl3] = await Promise.all([page.waitForEvent('download'), page.click('#xlsx')]);
  const xname = dl3.suggestedFilename(); const xbuf = fs.readFileSync(await dl3.path());
  check('Excel 活頁簿可匯出（.xlsx，ZIP 格式）', xname.endsWith('.xlsx') && xbuf.slice(0, 2).toString() === 'PK', xname);
  check('管理者頁面沒有 JavaScript 錯誤', page.errors.length === 0, page.errors.join(' | '));

  // 鄰居（iPhone）
  const phone = await newPage(browser, { ...devices['iPhone 13'] });
  await phone.goto(WEB);
  await phone.waitForSelector('#viewer-form');
  await phone.fill('#viewer-form [name=password]', 'wrong-pass');
  await phone.click('#viewer-form button');
  await phone.waitForFunction(() => /密碼錯誤/.test(document.querySelector('#viewer-msg')?.textContent || ''));
  check('鄰居輸入錯誤密碼被拒絕', (await phone.locator('#view').count()) === 0);
  await phone.screenshot({ path: `${SHOTS}/20_iphone_login_wrong.png` });
  await phone.fill('#viewer-form [name=password]', PW);
  await phone.click('#viewer-form button');
  await phone.waitForSelector('.kpis');
  check('鄰居以正確密碼進入', (await phone.locator('.role-badge').innerText()) === '鄰居唯讀');
  check('鄰居選單沒有管理功能', (await phone.locator('[data-nav=settings], [data-nav=viewer-password], [data-nav=export], [data-nav=audit]').count()) === 0);
  await phone.screenshot({ path: `${SHOTS}/21_iphone_dashboard.png`, fullPage: true });
  await phone.goto(WEB + '/#/viewer-password');
  await phone.waitForFunction(() => /需要管理者權限/.test(document.querySelector('#view')?.textContent || ''));
  check('鄰居直接輸入網址也進不了管理頁', true);
  await phone.goto(WEB + '/#/tx');
  await phone.waitForSelector('.tx-table');
  check('鄰居明細沒有編輯按鈕', (await phone.locator('[data-edit-tx]').count()) === 0);
  await phone.screenshot({ path: `${SHOTS}/22_iphone_search.png`, fullPage: false });
  await phone.goto(WEB + '/#/repairs');
  await phone.waitForSelector('.kpis');
  await phone.screenshot({ path: `${SHOTS}/23_iphone_repairs.png`, fullPage: true });
  const scrollW = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check('iPhone 版面沒有橫向捲動', scrollW <= 1, `溢出 ${scrollW}px`);

  // 鄰居（iPad）
  const ipad = await newPage(browser, { ...devices['iPad (gen 7)'] });
  await ipad.goto(WEB);
  await ipad.fill('#viewer-form [name=password]', PW);
  await ipad.click('#viewer-form button');
  await ipad.waitForSelector('.kpis');
  await ipad.waitForTimeout(500);
  await ipad.screenshot({ path: `${SHOTS}/30_ipad_dashboard.png`, fullPage: true });
  await ipad.goto(WEB + '/#/vendors'); await ipad.waitForSelector('.notice');
  await ipad.screenshot({ path: `${SHOTS}/31_ipad_vendors.png`, fullPage: true });
  check('廠商分析頁顯示資料限制說明', (await ipad.locator('.notice').first().innerText()).includes('無法'));

  // 管理者更改密碼 → 鄰居被登出
  await page.goto(WEB + '/#/viewer-password');
  await page.waitForSelector('#pw-form');
  await page.fill('#pw-form [name=p1]', PW_NEW);
  await page.fill('#pw-form [name=p2]', PW_NEW);
  await page.fill('#pw-form [name=admin_pw]', ADMIN.password);
  await page.click('#pw-form button');
  await page.waitForFunction(() => /更改成功/.test(document.querySelector('#pw-result')?.textContent || ''), null, { timeout: 15000 });
  await phone.goto(WEB + '/#/accounts');
  await phone.waitForSelector('#viewer-form', { timeout: 10000 });
  check('改密碼後，已登入的鄰居被要求重新輸入密碼', true);
  await phone.fill('#viewer-form [name=password]', PW);
  await phone.click('#viewer-form button');
  await phone.waitForFunction(() => /密碼錯誤/.test(document.querySelector('#viewer-msg')?.textContent || ''));
  check('舊密碼無法再登入', true);
  await phone.fill('#viewer-form [name=password]', PW_NEW);
  await phone.click('#viewer-form button');
  await phone.waitForSelector('.role-badge');
  check('新密碼可以登入', true);
  check('鄰居頁面沒有 JavaScript 錯誤', phone.errors.length === 0 && ipad.errors.length === 0, [...phone.errors, ...ipad.errors].join(' | '));

  fs.writeFileSync(`${SHOTS}/results.json`, JSON.stringify(results, null, 1));
  await browser.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} 通過，${failed} 失敗`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
