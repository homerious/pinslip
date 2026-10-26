#!/usr/bin/env node
// 执行真实布局控制器，隔离用户文件，并模拟 DPI、屏幕与系统报告噪声。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { createRequire } = require('node:module');
const desktop = path.resolve(__dirname, '../apps/desktop');
const desktopRequire = createRequire(path.join(desktop, 'package.json'));
const ts = desktopRequire('typescript');
const source = ts.transpileModule(fs.readFileSync(path.join(desktop, 'src/main/windows/main-window-layout.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;

function loadModule(file, mocks) {
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(path.join(desktop,'src',file),'utf8'), {
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true},
  }).outputText;
  vm.runInNewContext(code,{exports,console,process,setTimeout,clearTimeout,require:id=>id in mocks?mocks[id]:require(id)});
  return exports;
}

function fixture(platform = 'win32') {
  const files = new Map();
  const screen = new EventEmitter();
  let displays = [{ id: 1, scaleFactor: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } }];
  Object.assign(screen, {
    getAllDisplays: () => displays,
    getPrimaryDisplay: () => displays[0],
    getDisplayMatching: (r) => displays.find((d) => r.x >= d.workArea.x && r.x < d.workArea.x + d.workArea.width) || displays[0],
  });
  let time = 0; let timerId = 0;
  const timers = new Map();
  const tick = (ms = 400) => {
    const end = time + ms;
    for (;;) {
      const next = [...timers].sort((a, b) => a[1].at - b[1].at).find(([,v]) => v.at <= end);
      if (!next) break;
      timers.delete(next[0]); time = next[1].at; next[1].fn();
    }
    time = end;
  };
  const exports = {};
  const dir = path.join('/isolated', 'layout');
  const file = path.join(dir, 'manager-layout.json');
  vm.runInNewContext(source, {
    exports, console, process: { platform },
    setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { at: time + ms, fn }); return id; },
    clearTimeout: (id) => timers.delete(id),
    require: (id) => id === 'electron' ? { app: { getPath: () => dir }, screen }
      : id === 'node:fs' ? {
        readFileSync: (p) => { if (!files.has(p)) throw new Error('ENOENT'); return files.get(p); },
        writeFileSync: (p,s) => files.set(p,s), rmSync: (p) => files.delete(p),
      } : require(id),
  });
  class Window extends EventEmitter {
    constructor(b, noise = 0) {
      super(); this.k = screen.getDisplayMatching(b).scaleFactor;
      this.bounds = { ...b, width: Math.round(b.width / this.k) + noise, height: Math.round(b.height / this.k) + noise };
      this.destroyed = false; this.minimized = false; this.sets = [];
    }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return this.minimized; }
    restore() { this.minimized = false; }
    getNormalBounds() { return { ...this.bounds }; }
    setMinimumSize(w,h) { this.minimum = [w,h]; }
    setBounds(b) { this.sets.push({ ...b }); this.bounds = { ...b }; this.emit('move'); this.emit('resize'); }
    setPosition(x,y) {
      const k = screen.getDisplayMatching({ x,y }).scaleFactor;
      this.bounds = { x,y, width: Math.round(this.bounds.width * this.k / k), height: Math.round(this.bounds.height * this.k / k) };
      this.k = k; this.emit('move'); this.emit('resize');
    }
    resize(width,height) { this.emit('will-resize', {}, { ...this.bounds,width,height }); this.bounds = { ...this.bounds,width,height }; this.emit('resize'); }
    move(x,y) { this.emit('will-move', {}, { ...this.bounds,x,y }); this.setPosition(x,y); }
    close() { this.emit('close'); this.destroyed = true; this.emit('closed'); }
  }
  const make = (enabled = true, noise = 0, settle = true) => {
    const layout = new exports.MainWindowLayout(enabled);
    const win = new Window(layout.initialBounds, noise);
    layout.bind(win); layout.initialize(); if (settle) tick();
    return { layout, win };
  };
  return { exports, make, tick, screen, files, file,
    read: () => JSON.parse(files.get(file)), displays: (next) => { displays = next; } };
}

async function unitTests() {
  let count = 0;
  const test = async (name, fn) => { await fn(); count++; console.log('PASS ' + name); };
  await test('Default disabled, legacy main ignored, enable captures and disable cancels pending writes', async () => {
    const f = fixture();
    f.files.set(path.join(path.dirname(f.file), 'window-state.json'), JSON.stringify({ main: { width: 10, height: 10 } }));
    const { layout,win } = f.make(false);
    assert.equal(win.bounds.width, 320); assert.equal(f.files.has(f.file), false);
    win.resize(480,720); f.tick(); layout.setEnabled(true);
    assert.equal(f.read().size.width,480);
    win.resize(520,720); layout.setEnabled(false); f.tick(); win.close();
    assert.equal(f.files.has(f.file), false);
    assert.equal(f.make(false).win.bounds.width,320);
  });
  await test('Corrupt, non-finite, malformed and unversioned state falls back safely', async () => {
    const f = fixture();
    for(const data of ['broken','null','[]','{}',JSON.stringify({ version:1,size:{width:-1,height:Infinity},display:{},position:{} })]) {
      f.files.set(f.file,data); const { win }=f.make(); assert.equal(win.bounds.width,320); win.close();
    }
  });
  await test('Manual resize immediately after startup is not lost to the startup guard', async () => {
    const f=fixture(); const {layout,win}=f.make(false,0,false);
    win.resize(470,690); f.tick(); layout.setEnabled(true); assert.equal(f.read().size.width,470);
  });
  await test('100–200% DPI: 40 restores per scale preserve intent despite rounding noise', async () => {
    for(const k of [1,1.25,1.5,1.75,2]) {
      const f=fixture(); f.displays([{id:1,scaleFactor:k,workArea:{x:0,y:0,width:1920,height:1080}}]);
      let {layout,win}=f.make(); win.resize(500,650); f.tick(); layout.setEnabled(true);
      const original=f.files.get(f.file); const intended=f.read().size.width; win.close();
      for(let n=0;n<40;n++) {
        ({layout,win}=f.make(true,(n%3)-1));
        assert.equal(layout.initialBounds.width,intended);
        win.emit('show'); win.emit('hide'); win.emit('resize'); f.tick(); win.close();
        assert.equal(f.files.get(f.file),original,'No automatic rewrite: '+k+' cycle '+n);
      }
    }
  });
  await test('Cross-display move preserves authoritative size and restores on the original display', async () => {
    const f=fixture(); const primary={id:1,scaleFactor:1,workArea:{x:0,y:0,width:1920,height:1080}};
    const other={id:2,scaleFactor:1.5,workArea:{x:1920,y:-100,width:1440,height:1000}};
    f.displays([primary,other]); let {layout,win}=f.make();
    win.resize(600,800); f.tick(); layout.setEnabled(true); const size=f.read().size;
    win.move(2050,10); f.tick(); assert.deepEqual(f.read().size,size); assert.equal(f.read().display.id,2);
    win.close(); ({layout,win}=f.make()); assert.equal(layout.initialBounds.x,1920); assert(win.bounds.x>=1920); win.close();
    f.displays([primary]); ({layout,win}=f.make()); assert.equal(win.bounds.x+win.bounds.width,1908); assert(win.bounds.y>=0);
  });
  await test('Screen removal/metrics correction does not become user geometry or pollute size', async () => {
    const f=fixture(); const {layout,win}=f.make(); win.resize(600,800); f.tick(); layout.setEnabled(true);
    const original=f.files.get(f.file);
    f.displays([{id:3,scaleFactor:1.5,workArea:{x:0,y:0,width:500,height:450}}]);
    f.screen.emit('display-removed'); f.tick(800);
    assert(win.bounds.x>=0 && win.bounds.y>=0); assert(win.bounds.width<=500 && win.bounds.height<=450);
    assert.equal(f.files.get(f.file),original); win.close();
  });
  await test('Final user edit flushes before debounce, minimize keeps normal geometry', async () => {
    const f=fixture(); const {layout,win}=f.make(); layout.setEnabled(true); win.resize(510,710);
    win.minimized=true; win.emit('minimize'); assert.equal(f.read().size.width,510);
    win.close(); assert.equal(f.read().size.height,710);
  });
  await test('DPI changes while hidden: showing recalibrates without applying old layout', async () => {
    const f=fixture(); const {layout,win}=f.make(); win.resize(500,650); f.tick(); layout.setEnabled(true);
    const old=f.files.get(f.file); win.emit('hide');
    f.displays([{id:1,scaleFactor:2,workArea:{x:0,y:0,width:1920,height:1080}}]);
    win.bounds={...win.bounds,width:250,height:325}; win.k=2;
    const sets=win.sets.length; win.emit('show'); f.tick();
    assert.equal(f.files.get(f.file),old); assert.equal(win.sets.length,sets,'Show must not reapply geometry');
    win.resize(600,700); f.tick(); assert.equal(f.read().size.width,1200);
  });
  await test('Reset converts to current DIP and preserves enabled/disabled preference semantics', async () => {
    const f=fixture(); f.displays([{id:1,scaleFactor:1.5,workArea:{x:0,y:0,width:1920,height:1080}}]);
    const {layout,win}=f.make(); layout.setEnabled(true); win.resize(500,700); f.tick();
    const pending=layout.reset(); f.tick(150); await pending; f.tick();
    assert(win.bounds.width<400,'Stored constructor width must not be inflated into setBounds');
    assert.equal(f.read().display.id,1);
    const remembered=f.files.get(f.file); win.close(); assert.equal(f.files.get(f.file),remembered);
    const next=f.make(false); const reset=next.layout.reset(); f.tick(150); await reset; f.tick();
    assert.equal(f.files.has(f.file),false);
  });
  await test('Linux fallback tracks manual changes but ignores initialization/reset events', async () => {
    const f=fixture('linux'); const {layout,win}=f.make(false); assert.equal(f.files.has(f.file),false);
    win.setBounds({...win.bounds,width:480,height:680}); f.tick(); layout.setEnabled(true);
    assert.equal(f.read().size.width,480); const pending=layout.reset(); f.tick(150); await pending; f.tick();
    const expected=f.files.get(f.file); win.emit('show'); win.emit('hide'); win.close(); assert.equal(f.files.get(f.file),expected);
  });
  await test('Settings default, partial persistence, tampered preferences and IPC boolean validation', async () => {
    let json=JSON.stringify({ advanced:{ managerTheme:'dark', rememberManagerLayout:'true' } });
    const settings=loadModule('main/settings.ts',{
      electron:{app:{getPath:()=>'/isolated'}},
      'node:fs':{readFileSync:()=>json,writeFileSync:(_,s)=>{json=s;}},
      '../shared/toolbar':{sanitizeToolbarButtons:x=>Array.isArray(x)?x:[],TOOLBAR_BUTTON_DEFAULT_ORDER:[]},
    });
    assert.equal(settings.getAdvanced().rememberManagerLayout,false,'Non-boolean disk value is disabled');
    settings.setAdvanced({rememberManagerLayout:true});
    assert.equal(JSON.parse(json).advanced.managerTheme,'dark','Other settings preserved');
    const IPC=loadModule('shared/ipc-channels.ts',{}).IPC;
    const handlers=new Map(); const applied=[]; let resets=0;
    const electron={ipcMain:{handle:(key,fn)=>handlers.set(key,fn),on(){}},BrowserWindow:{getAllWindows:()=>[]}};
    const ipc=loadModule('main/ipc/index.ts',{
      electron,'../../shared/ipc-channels':{IPC},'../settings':settings,'../autostart':{},'../i18n':{},
      '../tray':{},'../../shared/languages':{},'../../shared/shortcuts':{},'../services/vault-watch':{},'../updater':{},'../shortcuts':{},'../windows/export-window':{},
    });
    ipc.registerIpcHandlers({windowManager:{setRememberManagerLayout:v=>applied.push(v),resetManagerLayout:async()=>{resets++;}},goProcess:{}});
    const set=handlers.get(IPC.SettingsSetAdvanced);
    assert.throws(()=>set({}, {rememberManagerLayout:'false'}),/must be boolean/);
    set({}, {rememberManagerLayout:false}); assert.deepEqual(applied,[false]);
    await handlers.get(IPC.MainWindowResetLayout)({}); assert.equal(resets,1);
  });
  console.log(`Manager layout unit tests: ${count}/${count} passed`);
}

async function nativeTests() {
  const { app,BrowserWindow }=require('electron');
  const temp=process.env.PINSLIP_LAYOUT_TEST_DIR;
  assert(temp && path.basename(temp).startsWith('.layout-test-'));
  app.setPath('userData',temp); app.disableHardwareAcceleration(); await app.whenReady();
  const exports={}; vm.runInNewContext(source,{exports,require,console,process,setTimeout,clearTimeout});
  const wait=(ms)=>new Promise(resolve=>setTimeout(resolve,ms));
  const create=async()=>{
    const layout=new exports.MainWindowLayout(true);
    const win=new BrowserWindow({...layout.initialBounds,show:false}); layout.bind(win);
    await win.loadURL('data:text/html,<h1>Isolated layout test</h1>'); layout.initialize(); await wait(350);
    return {layout,win};
  };
  try {
    let {layout,win}=await create();
    win.emit('will-resize',{}, {...win.getNormalBounds(),width:420,height:680}, {edge:'bottom-right'});
    win.setBounds({...win.getNormalBounds(),width:420,height:680}); layout.flush(); layout.setEnabled(true);
    const original=fs.readFileSync(path.join(temp,'manager-layout.json'),'utf8');
    const normal=win.getNormalBounds(); win.close();
    for(let i=0;i<6;i++){
      ({layout,win}=await create()); const actual=win.getNormalBounds();
      assert(Math.abs(actual.width-normal.width)<=2 && Math.abs(actual.height-normal.height)<=2,'Native restore must remain stable');
      win.close(); assert.equal(fs.readFileSync(path.join(temp,'manager-layout.json'),'utf8'),original);
    }
    console.log('PASS Native Electron: 6 real framed-window restores, no state rewrite or size drift'); app.exit(0);
  } catch(e){ console.error(e); app.exit(1); }
}

async function launch(){
  await unitTests(); if(process.argv.includes('--unit'))return;
  const temp=fs.mkdtempSync(path.join(desktop,'.layout-test-'));
  try{
    const env={...process.env,PINSLIP_LAYOUT_TEST_DIR:temp}; delete env.ELECTRON_RUN_AS_NODE;
    process.exitCode=await new Promise((resolve,reject)=>{
      const child=spawn(desktopRequire('electron'),[__filename],{env,stdio:'inherit',windowsHide:true});
      const timer=setTimeout(()=>{child.kill();reject(new Error('Native layout test timed out'));},30_000);
      child.on('error',e=>{clearTimeout(timer);reject(e);}); child.on('exit',c=>{clearTimeout(timer);resolve(c??1);});
    });
  }finally{
    const target=fs.realpathSync(temp); assert.equal(path.dirname(target),fs.realpathSync(desktop));
    assert(path.basename(target).startsWith('.layout-test-')); fs.rmSync(target,{recursive:true,force:true});
  }
}
(process.versions.electron ? nativeTests() : launch()).catch(e=>{console.error(e);process.exitCode=1;});
