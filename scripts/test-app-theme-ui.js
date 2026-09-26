'use strict';
// The real HTML/preload in a disposable Electron profile. No microphone,
// real account, Windows preferences or recording service is accessed.
const { app, BrowserWindow, ipcMain, session } = require('electron');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { computeInsights } = require('../src/insights');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-theme-ui-')));
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const deadline = setTimeout(() => { console.error('Theme UI timed out'); app.exit(1); }, 120000);
const errors = [], saves = [], contrast = [];
let fail = false, delay = 0;
let snapshot = {
  appTheme: 'white', displayName: 'Alex', shortcutLabel: 'Ctrl+Shift+Space',
  entries: Array.from({ length: 24 }, (_, i) => ({ id: 'theme-' + i, ts: Date.now() - i * 3600000,
    text: 'Let’s move the design review to Friday. I will send the updated notes after our meeting.', durationMs: 18000, targetExe: 'slack.exe', category: 'work' })),
  phrases: [{ from: 'fig ma', to: 'Figma', kind: 'replacement', source: 'manual' }],
  notifications: [], pendingPhrases: [], writingStyles: {},
  flowBarStyle: 'island', flowBarMotion: 'full', appVersion: '2.1.2', updateStatus: 'idle',
};
app.whenReady().then(async () => {
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler((_w, _p, cb) => cb(false));
  ipcMain.on('app-theme-get', event => { event.returnValue = snapshot.appTheme; });
  ipcMain.handle('app-load', () => snapshot);
  ipcMain.handle('insights-get', (_e, range) => computeInsights(snapshot.entries, { range }));
  ipcMain.handle('notifications-read', () => snapshot);
  ipcMain.handle('account-billing-options', () => snapshot);
  ipcMain.handle('settings-set', async (_e, patch) => {
    saves.push(patch);
    await pause(delay);
    if (fail) { fail = false; throw new Error('Expected theme save failure'); }
    snapshot = { ...snapshot, ...patch };
    return snapshot;
  });
  ipcMain.handle('toggle', () => assert.fail('Theme settings must not toggle dictation'));
  const win = new BrowserWindow({ show: false, width: 1298, height: 986, useContentSize: true,
    backgroundColor: '#F5F7F6', titleBarStyle: 'hidden', titleBarOverlay: { color: '#F5F7F6', symbolColor: '#5F6D64', height: 48 },
    webPreferences: { preload: path.join(__dirname, '../src/preload.js'), additionalArguments: ['--voxden-theme-bootstrap'],
      contextIsolation: true, sandbox: false, backgroundThrottling: false, offscreen: true } });
  win.webContents.on('console-message', event => {
    if ((event.level === 'error' || Number(event.level) >= 3) && !/Content-Security-Policy|Expected theme save failure/.test(event.message)) errors.push(event.message);
  });
  let firstTheme;
  win.webContents.once('dom-ready', async () => { firstTheme = await win.webContents.executeJavaScript('document.documentElement.dataset.appTheme'); });
  await win.loadFile(path.join(__dirname, '../src/app.html'));
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
  const run = code => win.webContents.executeJavaScript(code);
  const click = selector => run(`document.querySelector(${JSON.stringify(selector)}).click(); true`);
  const waitFor = async expression => {
    for (let i = 0; i < 100; i++) { if (await run(expression)) return; await pause(20); }
    assert.fail(expression);
  };
  await waitFor(`lastPayload && lastPayload.appTheme === 'white'`);
  assert.strictEqual(firstTheme, 'white', 'preload applies saved theme before DOM ready');
  const html = fs.readFileSync(path.join(__dirname, '../src/app.html'), 'utf8');
  assert.ok(html.indexOf('src="app-theme.js"') < html.indexOf('rel="stylesheet"'), 'bootstrap runs before render-blocking styles');
  await run(`navigator.mediaDevices.getUserMedia = async () => { throw new Error('No test microphone'); };
    navigator.mediaDevices.enumerateDevices = async () => []; true`);
  await pause(1400);
  // White keeps the dark Voxden frame: the body, title bar and sidebar are the
  // frame, and only the content panel (rounded at the top left, no outline) is light.
  const whiteShell = await run(`(() => { const c = s => getComputedStyle(document.querySelector(s));
    return { body: c('body').backgroundColor, bar: c('.titlebar').backgroundColor, rail: c('.sidebar').backgroundColor,
      main: c('main').backgroundColor, corner: c('main').borderTopLeftRadius, outline: c('main').borderTopColor,
      brand: c('.brand').color, nav: c('.nav-item:not(.is-active)').color, active: c('.nav-item.is-active').backgroundColor,
      activeLabel: c('.nav-item.is-active').color, activeIcon: c('.nav-item.is-active .nav-icon').color, bell: c('.notif-btn').color }; })()`);
  assert.deepStrictEqual(whiteShell, { body: 'rgb(11, 13, 14)', bar: 'rgb(11, 13, 14)', rail: 'rgb(11, 13, 14)',
    main: 'rgb(245, 247, 246)', corner: '20px', outline: 'rgba(0, 0, 0, 0)',
    brand: 'rgb(242, 245, 243)', nav: 'rgb(169, 181, 174)', active: 'rgb(20, 35, 28)',
    activeLabel: 'rgb(255, 255, 255)', activeIcon: 'rgb(156, 243, 196)', bell: 'rgb(169, 181, 174)' });
  assert.strictEqual(await run(`getComputedStyle(document.documentElement).colorScheme`), 'light');
  await run(`openSettingsTarget('display'); true`);
  await click('#display-more-options > summary');
  await run(`document.querySelector('#display-more-options > summary').focus(); true`);
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
  await waitFor(`document.activeElement.id === 'set-always-flow'`);
  assert.ok(await run(`parseFloat(getComputedStyle(document.querySelector('#set-always-flow + .toggle-track')).outlineWidth) >= 1.5`),'keyboard focus is visible around the toggle at Windows display scaling');
  await click('#display-more-options > summary');
  const rootTheme = value => `document.documentElement.dataset.appTheme === '${value}'`;
  const setTheme = async value => {
    await click(`.app-theme-card[data-app-theme="${value}"]`);
    await waitFor(rootTheme(value));
    await pause(40);
  };
  const previewColors = () => run(`['.flow-preview-island-cap', '.flow-preview-island-key', '.flow-preview-island-key svg', '.flow-preview-island-wave'].map(s => {
    const c = getComputedStyle(document.querySelector(s)); return [c.backgroundImage,c.backgroundColor,c.color,c.stroke,c.borderColor]; })`);
  // Island is the same black capsule with a hairline in both themes, and never
  // gains a shadow or glow (pseudo-elements included).
  const islandUnlit = () => run(`[...document.querySelectorAll('.flow-preview-island, .flow-preview-island *')]
    .flatMap(el => [null, '::before', '::after'].map(pseudo => getComputedStyle(el, pseudo)))
    .every(c => c.boxShadow === 'none' && c.filter === 'none' && c.textShadow === 'none')`);
  const before = await previewColors();
  assert.deepStrictEqual([before[0][1], before[0][4]], ['rgb(0, 0, 0)', 'rgba(255, 255, 255, 0.24)'], 'Island preview is a black capsule with a hairline');
  assert.strictEqual(await islandUnlit(), true, 'White keeps the Island preview free of shadow and glow');
  await run(`window.themeNode = document.querySelector('.hero-app-slot'); window.themeCanvas = document.querySelector('.flow-preview-orb-canvas');
    document.querySelector('.settings-detail').scrollTop = 20; true`);
  const scroll = await run(`document.querySelector('.settings-detail').scrollTop`);
  await setTheme('voxden');
  assert.deepStrictEqual(await previewColors(), before, 'flow-bar previews retain their exact palette');
  assert.strictEqual(await islandUnlit(), true, 'Voxden keeps the Island preview free of shadow and glow');
  assert.strictEqual(await run(`themeNode === document.querySelector('.hero-app-slot') && themeCanvas === document.querySelector('.flow-preview-orb-canvas')`), true, 'no node/canvas replacement');
  assert.strictEqual(await run(`document.querySelector('.settings-detail').scrollTop`), scroll, 'theme keeps scroll position');
  assert.strictEqual(await run(`document.querySelector('.settings-cat.is-active').dataset.cat`), 'display');
  await run(`document.querySelector('.app-theme-card[data-app-theme="voxden"]').focus(); true`);
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Right' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Right' });
  await waitFor(rootTheme('white'));
  assert.strictEqual(await run(`document.activeElement.dataset.appTheme`), 'white');
  await waitFor(`document.querySelector('.app-theme-card[data-app-theme="white"]').getAttribute('aria-checked') === 'true'`);
  await pause(50);
  fail = true;
  await click('.app-theme-card[data-app-theme="voxden"]');
  await waitFor(`!document.getElementById('app-theme-status').hidden`);
  assert.strictEqual(await run(rootTheme('white')), true, 'failed save restores previous selection');
  assert.strictEqual(snapshot.appTheme, 'white');
  delay = 70;
  await click('.app-theme-card[data-app-theme="voxden"]');
  await click('.app-theme-card[data-app-theme="white"]');
  await pause(220);
  assert.strictEqual(snapshot.appTheme, 'white', 'last rapid choice wins');
  assert.strictEqual(await run(rootTheme('white')), true);
  delay = 0;
  win.webContents.reload();
  await new Promise(resolve => win.webContents.once('did-finish-load', resolve));
  await waitFor(rootTheme('white'));
  assert.strictEqual(await run(`document.querySelectorAll('[data-theme-icon][src$="-ink.svg"]').length`), 3);

  const output = path.join(__dirname, '../temp/theme-review');
  fs.mkdirSync(output, { recursive: true });
  const review = async name => {
    await pause(650);
    // Detect text using its effective opaque ancestor surface. Artwork, disabled
    // controls and hidden/inactive panels are excluded; their palettes are
    // checked separately and screenshots cover gradient/illustration details.
    const findings = await run(`(() => {
      const rgb = s => (s.match(/[\\d.]+/g) || []).map(Number);
      const lum = a => a.slice(0,3).map(v => { v/=255; return v<=.04045?v/12.92:((v+.055)/1.055)**2.4; }).reduce((v,n,i)=>v+n*[.2126,.7152,.0722][i],0);
      const out=[];
      for(const el of document.querySelectorAll('body *')) {
        if(!el.childNodes.length || ![...el.childNodes].some(n=>n.nodeType===3 && n.textContent.trim()) || !el.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) continue;
        if(el.closest('svg,.flow-style-preview,.app-theme-preview,[disabled],[aria-hidden="true"]')) continue;
        const rect=el.getBoundingClientRect(); if(rect.width===0||rect.height===0||rect.top>innerHeight||rect.bottom<0) continue;
        const dialog=document.querySelector('dialog[open]'); if(dialog&&!dialog.contains(el)) continue;
        const settings=document.getElementById('settings-overlay'); if(!settings.hidden&&!settings.contains(el)&&!dialog) continue;
        const c=getComputedStyle(el), fg=rgb(c.color); let p=el,bg=[245,247,246];
        while(p){const s=getComputedStyle(p),a=rgb(s.backgroundColor);
          const stops=s.backgroundClip!=='text'&&s.backgroundImage.startsWith('linear-gradient(')?(s.backgroundImage.match(/rgba?\\([^)]*\\)/g)||[]).map(rgb):[];
          if(stops.length&&stops.every(c=>c.length===3||c[3]===1)){
            // For opaque gradient badges, use the stop closest in luminance to
            // the text, rather than incorrectly using the panel behind them.
            bg=stops.reduce((best,c)=>Math.abs(lum(c)-lum(fg))<Math.abs(lum(best)-lum(fg))?c:best);break;
          }
          if(a.length===3||a[3]===1){bg=a;break;}p=p.parentElement;
        }
        if(fg.length===4)for(let i=0;i<3;i++)fg[i]=fg[i]*fg[3]+bg[i]*(1-fg[3]);
        const ratio=(Math.max(lum(fg),lum(bg))+.05)/(Math.min(lum(fg),lum(bg))+.05);
        const large=parseFloat(c.fontSize)>=24||(parseFloat(c.fontSize)>=18.66&&parseInt(c.fontWeight)>=700);
        if(ratio<(large?3:4.5))out.push({selector:el.id||el.className,text:el.textContent.trim().slice(0,70),color:c.color,bg,ratio:Math.round(ratio*100)/100});
      } return out;
    })()`);
    contrast.push({ name, findings });
    if(process.argv.includes('--screenshots')) fs.writeFileSync(path.join(output,name+'.png'),(await win.webContents.capturePage()).toPNG());
  };
  for (const theme of ['white', 'voxden']) {
    await run(`openSettingsTarget('display'); true`); await setTheme(theme);
    const backdrop = await run(`(() => {
      const overlay=document.getElementById('settings-overlay'), header=document.querySelector('.titlebar');
      const scrim=getComputedStyle(overlay,'::before'), r=header.getBoundingClientRect();
      return {content:scrim.content,color:scrim.backgroundColor,backdrop:getComputedStyle(overlay).backgroundColor,
        height:parseFloat(scrim.height),headerHeight:r.height,bottom:scrim.bottom,
        overlayHeight:overlay.getBoundingClientRect().height,pointerEvents:scrim.pointerEvents,
        draggable:document.elementFromPoint(250,r.top+r.height/2)?.closest('.titlebar')===header};
    })()`);
    assert.strictEqual(backdrop.content, '""', theme+' paints a header scrim');
    assert.strictEqual(backdrop.color, backdrop.backdrop, theme+' dims the header with the same settings backdrop');
    assert.ok(Math.abs(backdrop.height-backdrop.headerHeight)<1, theme+' covers the full titlebar height');
    assert.ok(Math.abs(parseFloat(backdrop.bottom)-backdrop.overlayHeight)<1, theme+' scrim sits directly above the content backdrop');
    assert.strictEqual(backdrop.pointerEvents, 'none');
    assert.strictEqual(backdrop.draggable, true, theme+' keeps the titlebar draggable');
    await click('#settings-close');
    await pause(320);
    const upgrade = await run(`(() => {
      const el=document.querySelector('#sidebar-pro-upgrade'), c=getComputedStyle(el);
      return {visible:el.checkVisibility(), color:c.color, fill:c.backgroundImage};
    })()`);
    assert.ok(upgrade.visible, theme+' shows the real upgrade card');
    assert.strictEqual(upgrade.color, 'rgb(42, 30, 5)', theme+' has dark text on gold');
    assert.ok(upgrade.fill.includes('241, 210, 122') && upgrade.fill.includes('212, 164, 55'), theme+' upgrade uses gold');
    // Force hover so this also catches a hover rule restoring the collapsed
    // text. Only the arrow should remain, even after interrupted transitions.
    await win.webContents.debugger.sendCommand('DOM.enable');
    await win.webContents.debugger.sendCommand('CSS.enable');
    const {root} = await win.webContents.debugger.sendCommand('DOM.getDocument');
    const {nodeId} = await win.webContents.debugger.sendCommand('DOM.querySelector', {nodeId:root.nodeId, selector:'#sidebar-pro-upgrade'});
    await win.webContents.debugger.sendCommand('CSS.forcePseudoState', {nodeId, forcedPseudoClasses:['hover']});
    for(let i=0;i<5;i++) { await click('#sidebar-toggle'); await pause(65); }
    await pause(320);
    const collapsed = await run(`(() => {
      const b=document.querySelector('#sidebar-pro-upgrade'), a=b.querySelector('span');
      const br=b.getBoundingClientRect(), ar=a.getBoundingClientRect();
      return {collapsed:document.querySelector('#sidebar').classList.contains('is-collapsed'),
        label:getComputedStyle(b).color, arrow:getComputedStyle(a).color,
        contained:ar.left>=br.left&&ar.right<=br.right&&ar.top>=br.top&&ar.bottom<=br.bottom,
        width:br.width, fill:getComputedStyle(b).backgroundImage};
    })()`);
    assert.strictEqual(collapsed.collapsed, true);
    assert.strictEqual(collapsed.label, 'rgba(0, 0, 0, 0)', theme+' hides upgrade text while collapsed, including hover');
    assert.strictEqual(collapsed.arrow, 'rgb(42, 30, 5)');
    assert.ok(collapsed.contained && collapsed.width<60, theme+' retains an unclipped arrow in the compact button');
    assert.ok(collapsed.fill.includes('247, 221, 140'), theme+' hover stays gold');
    await click('#sidebar-toggle'); await pause(420);
    assert.strictEqual(await run(`getComputedStyle(document.querySelector('#sidebar-pro-upgrade')).color`), 'rgb(42, 30, 5)', theme+' restores the expanded label');
    await win.webContents.debugger.sendCommand('CSS.forcePseudoState', {nodeId, forcedPseudoClasses:[]});
    await review(theme+'-upgrade-expanded');
    await run(`openSettingsTarget('display'); true`);
    for(const category of ['general','display','system','account','billing','speech-engines','sound','privacy']) {
      if(await run(`!!document.querySelector('.settings-cat[data-cat="${category}"]')`)) {
        await click(`.settings-cat[data-cat="${category}"]`); await review(theme+'-settings-'+category);
      }
    }
    snapshot = { ...snapshot, cloudTranscription: true, dictationLanguageUnlocked: true,
      dictationLanguageCatalog: require('../src/asr').DICTATION_LANGUAGES,
      account: { signedIn: true, plan: 'pro', email: 'alex@example.test', profile: { firstName: 'Alex', lastName: 'River' } } };
    await run(`render(${JSON.stringify(snapshot)}); true`);
    await click('.settings-cat[data-cat="account"]'); await review(theme+'-account-pro');
    await click('.settings-cat[data-cat="general"]');
    await click('#general-more-options > summary'); await review(theme+'-general-options');
    await click('#dictation-lang-open');
    assert.strictEqual(await run(`document.getElementById('dictation-lang-dialog').open`), true, 'real language picker opens');
    await review(theme+'-languages');
    await run(`document.getElementById('dictation-lang-dialog').close(); true`);
    await run(`openCustomSelect(customSelectMap.get(document.getElementById('mic-select'))); true`);
    await review(theme+'-microphone-menu');
    await run(`closeAllCustomSelects(); true`);
    await click('#settings-close');
    await click('#account-btn'); await review(theme+'-account-menu'); await click('#account-btn');
    for(const page of ['dictation','dictionary','writing-style','insights','help']) {
      await click('#nav-'+page); await review(theme+'-'+page);
    }
    await click('#nav-dictionary'); await click('#dict-add-new'); await review(theme+'-add-word');
    await run('closeVocabModal(); true');
    for(const dialog of ['shortcuts-dialog','feedback-dialog','mic-dialog','subscription-dialog','confirm-dialog']) {
      // Feedback fills its detail chips as it opens, so review the real thing.
      if(dialog === 'feedback-dialog') await run(`openFeedbackDialog(); true`);
      else await run(`document.getElementById('${dialog}').showModal(); true`);
      await review(theme+'-'+dialog);
      if(dialog === 'feedback-dialog') await run(`closeFeedbackDialog(); true`);
      else await run(`document.getElementById('${dialog}').close(); true`);
    }
    await click('#notif-btn'); await review(theme+'-notifications-empty'); await click('#notif-btn');
    await run(`document.querySelector('#signin-gate').showModal(); true`); await review(theme+'-signin');
    await run(`document.querySelector('#signin-gate').close(); document.querySelector('#model-welcome').showModal(); true`); await review(theme+'-onboarding');
    await run(`document.querySelector('#model-welcome').close(); true`);
    snapshot = { ...snapshot, cloudTranscription: false, dictationLanguageUnlocked: false, account: null };
    await run(`render(${JSON.stringify(snapshot)}); true`);
  }
  // Repeat interrupted sidebar transitions while changing only the theme.
  await click('#nav-dictation');
  await pause(150);
  const motion = await run(`new Promise(resolve => {
    const slots=[...document.querySelectorAll('.hero-app-slot')],field=document.querySelector('.hero-app-field');
    let last=null,lastTime=performance.now(),start=lastTime,step=0,frames=0,rises=0; const errors=[];
    function sample(now){const current=slots.map(el=>{const m=new DOMMatrixReadOnly(getComputedStyle(el).transform);return {y:m.m42+el.offsetHeight/2,angle:Math.atan2(m.m12,m.m11),size:el.offsetHeight};});
      if(last)current.forEach((p,i)=>{const b=last[i],dy=p.y-b.y,recycled=b.y+b.size/2<1&&p.y-p.size/2>field.clientHeight-1;
        if(!recycled){if(dy<-.01)rises++;if(dy>.06||dy < -18*Math.min((now-lastTime)/1000,.1)-.2||Math.abs(p.angle-b.angle)>.04)errors.push({i,dy});}});
      last=current;lastTime=now;frames++;
      if(step<6&&now-start>step*200){document.getElementById('sidebar-toggle').click();document.querySelector('.app-theme-card[data-app-theme="'+(step%2?'white':'voxden')+'"]').click();step++;}
      if(now-start<1500)requestAnimationFrame(sample);else resolve({frames,rises,errors});
    }requestAnimationFrame(sample);
  })`);
  assert.ok(motion.frames>20&&motion.rises>80, 'motion stays active during switches');
  assert.deepStrictEqual(motion.errors, [], 'theme switching never resets icon speed or rotation');
  await run(`openSettingsTarget('display'); true`); await setTheme('white');
  const colors = await run(`Object.fromEntries(['text','muted','accent','pro-accent','pro-ink','pro-surface','red','warning','control-border','bg','panel','panel-2','surface-selected'].map(k=>[k,getComputedStyle(document.documentElement).getPropertyValue('--'+k).trim()]))`);
  const luminance = hex => hex.replace('#','').match(/../g).map(v=>parseInt(v,16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((n,v,i)=>n+v*[.2126,.7152,.0722][i],0);
  for(const bg of ['bg','panel','panel-2','surface-selected']) for(const fg of ['text','muted','accent','red','warning','control-border']) {
    const a=luminance(colors[fg]),b=luminance(colors[bg]),ratio=(Math.max(a,b)+.05)/(Math.min(a,b)+.05);
    assert.ok(ratio>=(fg==='control-border'?3:4.5),fg+' on '+bg+' contrast '+ratio.toFixed(2));
  }
  for(const [fg,bg] of [[colors['pro-accent'],colors.panel],[colors['pro-accent'],colors['pro-surface']],
    [colors['pro-ink'],'#F1D27A'],[colors['pro-ink'],'#D4A437'],[colors['pro-ink'],'#F7DD8C'],[colors['pro-ink'],'#DFB04A']]) {
    const a=luminance(fg),b=luminance(bg),ratio=(Math.max(a,b)+.05)/(Math.min(a,b)+.05);
    assert.ok(ratio>=4.5, 'gold Pro text contrast '+ratio.toFixed(2));
  }
  for(const [w,h,z] of [[800,650,1],[640,440,1],[800,650,1.5]]) {
    win.setContentSize(w,h);win.webContents.setZoomFactor(z);await pause(180);
    assert.strictEqual(await run(`(() => {const r=document.querySelector('.settings-dialog').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1&&r.top>=0&&r.bottom<=innerHeight+1;})()`),true,'dialog fits at '+[w,h,z]);
    await review('white-compact-'+[w,h,z].join('-'));
  }
  fs.writeFileSync(path.join(output,'contrast.json'),JSON.stringify(contrast,null,2));
  assert.deepStrictEqual(contrast.filter(r=>r.findings.length), [], 'reviewed text meets 4.5:1 (3:1 for large text)');
  assert.deepStrictEqual(errors, [], 'no renderer errors');
  console.log('Theme UI: startup, persistence, rollback, keyboard, rapid choices, stable nodes/scroll and flow preview palette passed. Contrast report: '+path.join(output,'contrast.json'));
  clearTimeout(deadline); win.destroy(); app.quit();
}).catch(error => { console.error(error); clearTimeout(deadline); app.exit(1); });
