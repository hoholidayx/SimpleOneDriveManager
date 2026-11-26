import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const base = `http://127.0.0.1:${process.env.ODM_BROWSER_TEST_PORT || 3101}`;
const browser = await chromium.launch({ channel: process.env.ODM_BROWSER_CHANNEL || 'chrome', headless: true });
mkdirSync('.runtime/browser-screenshots', { recursive: true });
let checks = 0;
async function check(name, run) { await run(); checks++; console.log(`PASS ${name}`); }
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const requests = [];
const pageErrors = [];
page.on('request', request => { if (request.url().startsWith(`${base}/api/`)) requests.push(new URL(request.url()).pathname + new URL(request.url()).search); });
page.on('pageerror', error => pageErrors.push(error.message));
const originals = () => requests.filter(url => /\/(original|download)$/.test(url));
const thumbnails = () => requests.filter(url => url.includes('/thumbnail?'));
const settle = () => page.waitForLoadState('networkidle');
async function closePreview() { await page.keyboard.press('Escape'); await page.getByRole('dialog').waitFor({ state: 'detached' }); }
async function screenshot(name) {
  await settle();
  const modal = await page.getByRole('dialog').count();
  if (modal) await page.waitForFunction(() => { const el = document.querySelector('.ant-modal'); return el && getComputedStyle(el).opacity === '1' && getComputedStyle(el).transform === 'none'; });
  await page.screenshot({ path: `.runtime/browser-screenshots/${name}.png`, fullPage: !modal });
}
async function expectPicture(width) {
  await page.waitForFunction(expected => {
    const image = document.querySelector('.preview-viewport img');
    return image instanceof HTMLImageElement && image.complete && image.naturalWidth === expected;
  }, width);
}

try {
  await page.goto(base);
  await page.getByRole('button', { name: '山间日落.svg', exact: true }).waitFor();
  await settle();
  await check('文本列表不请求任何图片；列表点击仅请求大缩略图', async () => {
    assert.equal(thumbnails().length, 0); assert.equal(originals().length, 0);
    await page.getByRole('button', { name: '山间日落.svg', exact: true }).click();
    await expectPicture(800); await settle();
    assert.deepEqual(thumbnails(), ['/api/items/landscape/thumbnail?size=large']);
    assert.equal(originals().length, 0);
    await screenshot('large-preview');
    await closePreview();
  });
  await check('网格只请求 medium；切换布局保留筛选和选中项', async () => {
    requests.length = 0;
    await page.getByRole('checkbox', { name: '选择 山间日落.svg', exact: true }).check();
    await page.getByRole('textbox', { name: '筛选文件' }).fill('山间');
    await page.getByRole('button', { name: '网格布局', exact: true }).click();
    await page.locator('.grid-thumbnail img').waitFor(); await settle();
    assert.deepEqual(thumbnails(), ['/api/items/landscape/thumbnail?size=medium']);
    assert.equal(originals().length, 0);
    assert.equal(await page.getByRole('checkbox', { name: '选择 山间日落.svg', exact: true }).isChecked(), true);
    await page.getByRole('button', { name: '文本列表', exact: true }).click(); await settle();
    assert.equal(thumbnails().length, 1);
    assert.equal(await page.getByRole('textbox', { name: '筛选文件' }).inputValue(), '山间');
    await page.getByRole('button', { name: '网格布局', exact: true }).click();
    await page.getByRole('textbox', { name: '筛选文件' }).fill(''); await settle();
    await screenshot('grid-desktop');
  });
  await check('只有按钮加载原图；缩放、适应窗口和重新打开均正确', async () => {
    await page.getByRole('button', { name: '打开 山间日落.svg', exact: true }).click();
    await expectPicture(800); assert.equal(originals().length, 0);
    await page.getByRole('button', { name: '查看原图', exact: true }).click();
    await expectPicture(1600);
    assert.deepEqual(originals(), ['/api/items/landscape/original']);
    const width = await page.locator('.original-image').evaluate(image => image.clientWidth);
    await page.getByRole('button', { name: '放大原图', exact: true }).click();
    assert.ok(await page.locator('.original-image').evaluate(image => image.clientWidth) > width);
    await page.getByRole('button', { name: '实际大小', exact: true }).click();
    assert.equal(await page.locator('.original-image').evaluate(image => image.clientWidth), 1600);
    await page.getByRole('button', { name: '适应窗口', exact: true }).click();
    await screenshot('original-preview');
    await closePreview();
    await page.getByRole('button', { name: '打开 山间日落.svg', exact: true }).click();
    await expectPicture(800); await settle(); assert.equal(originals().length, 1);
    await closePreview();
  });
  await check('无缩略图及 HEIC 解码失败不自动下载，原图失败保留大缩略图', async () => {
    const before = originals().length;
    await page.getByRole('button', { name: '打开 没有缩略图的图片.svg', exact: true }).click();
    await page.getByText('此图片暂时没有可用的缩略图', { exact: true }).waitFor(); await settle();
    assert.equal(originals().length, before);
    await page.getByRole('button', { name: '重试预览', exact: true }).click(); await settle();
    assert.equal(originals().length, before);
    await closePreview();
    await page.getByRole('button', { name: '打开 手机照片.heic', exact: true }).click();
    await expectPicture(800);
    await page.getByRole('button', { name: '查看原图', exact: true }).click();
    await page.getByText('浏览器无法显示此原图格式，请使用“下载文件”在本机查看。', { exact: true }).waitFor();
    await expectPicture(800);
    assert.equal(originals().length, before + 1);
    await closePreview();
  });
  await check('关闭预览会中断原图请求，迟到响应不会覆盖另一张图', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const slow = async route => { await gate; await route.continue().catch(() => {}); };
    await page.route('**/api/items/landscape/original', slow);
    await page.getByRole('button', { name: '打开 山间日落.svg', exact: true }).click(); await expectPicture(800);
    const failed = page.waitForEvent('requestfailed', request => request.url().endsWith('/landscape/original'));
    const started = page.waitForRequest(request => request.url().endsWith('/landscape/original'));
    await page.getByRole('button', { name: '查看原图', exact: true }).click(); await started;
    await closePreview(); release(); await failed;
    await page.unroute('**/api/items/landscape/original', slow);
    await page.getByRole('button', { name: '打开 手机照片.heic', exact: true }).click(); await expectPicture(800);
    assert.match(await page.getByRole('dialog').innerText(), /手机照片.heic/);
    await closePreview();
  });
  await check('缩略图网络失败可重试，且不会自动请求原图', async () => {
    const before = originals().length;
    const fail = route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'OFFLINE', message: '测试：缩略图网络中断' } }) });
    await page.route('**/api/items/landscape/thumbnail?size=large', fail);
    await page.getByRole('button', { name: '打开 山间日落.svg', exact: true }).click();
    await page.getByText('测试：缩略图网络中断', { exact: true }).waitFor();
    assert.equal(originals().length, before);
    await page.unroute('**/api/items/landscape/thumbnail?size=large', fail);
    await page.getByRole('button', { name: '重试预览', exact: true }).click(); await expectPicture(800);
    assert.equal(originals().length, before); await closePreview();
  });
  await check('可见卡片懒加载且最多并发六个；切回列表取消排队', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let count = 0;
    const slow = async route => { count++; await gate; await route.continue().catch(() => {}); };
    await page.route('**/api/items/photo-*/thumbnail?size=medium', slow);
    await page.getByRole('button', { name: '打开 图片', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.file-card').length === 24);
    // Give visible cards enough time to enter the observer and enqueue.
    await page.waitForTimeout(400);
    assert.equal(count, 6);
    await page.getByRole('button', { name: '文本列表', exact: true }).click();
    release(); await settle();
    assert.equal(count, 6);
    await page.unroute('**/api/items/photo-*/thumbnail?size=medium', slow);
    await page.locator('.path-bar .breadcrumb-link').first().click();
    await page.getByRole('button', { name: '山间日落.svg', exact: true }).waitFor();
    await page.getByRole('button', { name: '网格布局', exact: true }).click();
  });
  await check('布局偏好持久保存；窄屏图片适应窗口且无横向溢出', async () => {
    await page.reload(); await page.getByRole('button', { name: '打开 山间日落.svg', exact: true }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 }); await settle();
    await screenshot('grid-mobile');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.getByRole('button', { name: '打开 山间日落.svg', exact: true }).click(); await expectPicture(800);
    await page.getByRole('button', { name: '查看原图', exact: true }).click(); await expectPicture(1600);
    await page.waitForFunction(() => {
      const image = document.querySelector('.original-image');
      const box = document.querySelector('.preview-viewport');
      return image && box && image.clientWidth <= box.clientWidth && image.clientHeight <= box.clientHeight;
    });
    await screenshot('preview-mobile'); await closePreview();
  });
  await check('添加第二账号后切换文件，移除账号保留其他授权', async () => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole('button', { name: '连接设置' }).click();
    await page.getByRole('button', { name: '添加账号' }).click();
    await page.getByRole('button', { name: '打开 第二账号专属.txt', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '打开 第一账号专属.txt', exact: true }).count(), 0);
    // A fresh page has no file-list layout or jobs from the previous account.
    await page.getByRole('button', { name: '文本列表', exact: true }).click();
    await page.getByRole('button', { name: '连接设置' }).click();
    await page.getByRole('button', { name: '切换到 browser-test@example.com', exact: true }).waitFor();
    await screenshot('multiple-accounts');
    await page.getByRole('button', { name: '切换到 browser-test@example.com', exact: true }).click();
    await page.getByRole('button', { name: '第一账号专属.txt', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '第二账号专属.txt', exact: true }).count(), 0);
    // The header offers the same switch without opening settings.
    await page.getByRole('button', { name: '切换 OneDrive 账号', exact: true }).click();
    await page.getByRole('menuitem', { name: /第二账号（模拟 OneDrive）/ }).click();
    await page.getByRole('button', { name: '第二账号专属.txt', exact: true }).waitFor();
    await page.getByRole('button', { name: '连接设置' }).click();
    await page.getByRole('button', { name: '移除当前授权' }).click();
    await page.getByRole('button', { name: '移除授权', exact: true }).click();
    await page.getByRole('button', { name: '第一账号专属.txt', exact: true }).waitFor();
    await page.getByRole('button', { name: '连接设置' }).click();
    assert.equal(await page.locator('.saved-account').count(), 1);
    assert.equal(await page.getByText('second@example.com', { exact: true }).count(), 0);
    await page.setViewportSize({ width: 390, height: 844 }); await settle();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await screenshot('accounts-mobile');
  });
  assert.deepEqual(pageErrors, []);
  console.log(`${checks} browser checks passed; screenshots: .runtime/browser-screenshots/`);
} catch (error) {
  await page.screenshot({ path: '.runtime/browser-screenshots/failure.png', fullPage: true });
  console.error(await page.locator('body').innerText());
  throw error;
} finally { await browser.close(); }
