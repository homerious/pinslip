#!/usr/bin/env node
// 隔离磁盘、窗口、HTTP 和时钟，执行真实关闭协调与 IPC 代码。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const ts = require('../apps/desktop/node_modules/typescript');
function load(file, mocks = {}, globals = {}) {
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(path.resolve(__dirname,'../apps/desktop/src',file),'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(code, { exports, require: id => id in mocks ? mocks[id] : require(id), process,
    console, crypto, URL, setTimeout, clearTimeout, ...globals });
  return exports;
}
const { IPC } = load('shared/ipc-channels.ts');
const shared = load('shared/shortcuts.ts');
const { NoteCloseGuard } = load('main/windows/note-close-guard.ts', {'../../shared/ipc-channels': { IPC }});
const tick = async () => { for (let i=0;i<12;i++) await Promise.resolve(); };
let nextId = 0;
class Window extends EventEmitter {
  constructor() { super(); this.destroyed=false; this.messages=[]; this.webContents={id:++nextId,send:(...args)=>this.messages.push(args)}; }
  isDestroyed(){return this.destroyed;}
  close(){let prevented=false;this.emit('close',{preventDefault(){prevented=true;}});if(!prevented)this.destroy();}
  destroy(){this.destroyed=true;this.emit('closed');}
  focus(){}
}
async function main(){
  let timeout;
  const TimedGuard = load('main/windows/note-close-guard.ts', {'../../shared/ipc-channels':{IPC}},
    {setTimeout:fn=>{timeout=fn;return 1;},clearTimeout(){}}).NoteCloseGuard;
  const guard = new TimedGuard(); const first=new Window(); const other=new Window(); guard.add(first);guard.add(other);
  const pending=guard.flush(first); assert.equal(guard.flush(first),pending);assert.equal(first.messages.length,0);
  guard.ready(first.webContents.id,true);const request=first.messages.at(-1)[1];
  guard.finish(other.webContents.id,request,true);guard.finish(first.webContents.id,request+1,true);
  assert.equal(guard.isPrepared(first),false);guard.finish(first.webContents.id,request,true);await pending;
  assert(guard.isPrepared(first));guard.resumeAll();assert(!guard.isPrepared(first));
  const failed=guard.flush(first);timeout();await assert.rejects(failed,/failed or timed out/);
  assert.equal(first.messages.at(-1)[0],IPC.NoteResumeEditing);
  const retry=guard.flush(first);guard.finish(first.webContents.id,first.messages.at(-1)[1],true);await retry;
  const broken=new Window();guard.add(broken);guard.ready(broken.webContents.id,true);
  broken.webContents.send=()=>{throw Error('renderer gone');};
  await assert.rejects(guard.flush(broken),/failed or timed out/);
  console.log('PASS close handshake: readiness, deduplication, sender/token isolation, timeout, release and retry');

  const windows=[];const openLists=[];const errors=[];
  const {WindowManager}=load('main/windows/window-manager.ts',{
    electron:{dialog:{showMessageBox:async()=>{errors.push('save failed');}}},
    './note-close-guard':{NoteCloseGuard},'../i18n':{tMain:key=>key},
    './note-window':{createNoteWindow(){const win=new Window();windows.push(win);return win;}},
    './quick-capture':{},'./main-window':{},'./group-manager':{GroupManager:class{async load(){}restackOf(){}handleWindowClosed(){}}},
    '../settings':{getAdvanced:()=>({notePlacement:'cascade'}),setOpenNotes:ids=>openLists.push([...ids])},'../../shared/ipc-channels':{IPC},
  });
  const wm=new WindowManager({});
  const id=await wm.createNoteWindow();const win=windows[0];wm.noteCloseGuard.ready(win.webContents.id,true);
  wm.closeNoteWindow(id);wm.closeNoteWindow(id);assert(!win.isDestroyed());assert.equal(wm.listNoteWindows().length,1);
  assert.equal(win.messages.filter(m=>m[0]===IPC.NoteFlush).length,1);
  wm.noteCloseGuard.finish(win.webContents.id,win.messages.at(-1)[1],false);await tick();
  assert(!win.isDestroyed()&&errors.length===1);wm.closeNoteWindow(id);
  wm.noteCloseGuard.finish(win.webContents.id,win.messages.at(-1)[1],true);await tick();
  assert(win.isDestroyed());assert.equal(wm.listNoteWindows().length,0);
  const deleted=await wm.createNoteWindow();const delWin=windows.at(-1);wm.closeNoteWindow(deleted,true);
  assert(delWin.isDestroyed()&&delWin.messages.length===0,'Deleted note must bypass save');
  await wm.createNoteWindow();await wm.createNoteWindow();const batch=windows.slice(-2);
  for(const w of batch)wm.noteCloseGuard.ready(w.webContents.id,true);
  const flushing=wm.flushAllNotes();assert.equal(wm.flushAllNotes(),flushing);
  for(const w of batch)wm.noteCloseGuard.finish(w.webContents.id,w.messages.at(-1)[1],true);
  await flushing;wm.quitting=true;const lastIds=openLists.at(-1).join(',');batch.forEach(w=>w.close());
  assert.equal(openLists.at(-1).join(','),lastIds,'Quit keeps session restoration IDs');
  console.log('PASS real window pool: native close waits, failure keeps window, repeat close, discard skips save, all-note prepare and quit restoration');

  const handlers=new Map();const calls=[];
  const pref={trayIcon:true,taskbarIcon:true,quickCaptureShortcut:'ctrl+shift+n',blankNoteShortcut:'off'};
  let persistFailure=false;let rebindFailure=false;let flushFailure=false;
  const settings={getAdvanced:()=>({...pref}),setAdvanced:patch=>{if(persistFailure)throw Error('disk');Object.assign(pref,patch);},
    getVaultPath:()=>'/old',setVaultPath:()=>calls.push('new-path')};
  const electron={app:{isPackaged:true,getPath:()=>'/isolated'},ipcMain:{handle:(key,fn)=>handlers.set(key,fn),on(){}},
    BrowserWindow:{getAllWindows:()=>[]},dialog:{showOpenDialog:async()=>({canceled:false,filePaths:['/new']})}};
  const ipc=load('main/ipc/index.ts',{electron,'../../shared/ipc-channels':{IPC},'../../shared/shortcuts':shared,'../settings':settings,
    '../autostart':{},'../i18n':{tMain:key=>key},'../tray':{refreshTrayMenu:()=>calls.push('tray:'+pref.quickCaptureShortcut)},
    '../../shared/languages':{},'../services/vault-watch':{startVaultWatch:()=>{}},
    '../updater':{getUpdateState:()=>({status:'downloaded'}),quitAndInstall:()=>calls.push('install')},'../windows/export-window':{},
    '../shortcuts':{rebindQuickCaptureShortcut:()=>{if(rebindFailure)throw Error('occupied');}}});
  ipc.registerIpcHandlers({windowManager:{async flushAllNotes(){calls.push('flush');if(flushFailure)throw Error('save');},
    closeAllNoteWindows:()=>calls.push('close'),reloadGroups:async()=>{},reportSaveFailure:()=>calls.push('error'),
    noteCloseGuard:{resumeAll:()=>calls.push('resume')}},goProcess:{restart:async()=>{calls.push('restart');return 123;}}});
  const set=handlers.get(IPC.SettingsSetAdvanced);
  set({}, {quickCaptureShortcut:'off'});assert.equal(calls.at(-1),'tray:off');
  set({}, {quickCaptureShortcut:'ctrl+alt+q'});assert.equal(calls.at(-1),'tray:ctrl+alt+q');
  const count=calls.length;rebindFailure=true;assert.throws(()=>set({}, {quickCaptureShortcut:'off'}),/occupied/);
  rebindFailure=false;persistFailure=true;assert.throws(()=>set({}, {quickCaptureShortcut:'off'}),/disk/);
  assert.equal(calls.length,count,'Failed binding/persistence must not rebuild tray');persistFailure=false;
  calls.length=0;await handlers.get(IPC.SettingsChooseVault)({});assert.equal(calls.join(','),'flush,close,new-path,restart');
  calls.length=0;flushFailure=true;assert.equal(await handlers.get(IPC.SettingsChooseVault)({}),null);
  assert.equal(calls.join(','),'flush,error');flushFailure=false;
  calls.length=0;await handlers.get(IPC.UpdateInstall)({});assert.equal(calls.join(','),'flush,install,resume');
  calls.length=0;flushFailure=true;await handlers.get(IPC.UpdateInstall)({});assert.equal(calls.join(','),'flush,error,resume');
  console.log('PASS IPC: tray uses new/off key only after successful save; vault/update wait for flush and abort on failure');

  // 真实 app 生命周期：重复退出合并，保存完成之前绝不停止 Go 服务。
  const app=new EventEmitter();let start;let release;let reject;let stops=0;let flushes=0;let alerts=0;
  Object.assign(app,{requestSingleInstanceLock:()=>true,whenReady:()=>({then:fn=>{start=fn;}}),
    quit(){let prevented=false;app.emit('before-quit',{preventDefault(){prevented=true;}});if(!prevented)app.emit('will-quit');}});
  const lifeWindow={quitting:false,showMainWindow(){},restoreNoteWindows:async()=>{},flushManagerLayout(){},reportSaveFailure(){alerts++;},
    flushAllNotes(){flushes++;return new Promise((yes,no)=>{release=yes;reject=no;});}};
  load('main/index.ts',{electron:{app,protocol:{handle(){}},nativeTheme:new EventEmitter(),powerMonitor:new EventEmitter(),screen:new EventEmitter()},
    '@electron-toolkit/utils':{electronApp:{setAppUserModelId(){}}},'./windows/window-manager':{WindowManager:class{constructor(){return lifeWindow;}}},
    './services/go-process':{GoProcess:class{async ensureStarted(){}stop(){stops++;}}},'./ipc':{registerIpcHandlers(){}},'./tray':{createTray(){}},
    './autostart':{initAutoStart(){}},'./settings':{getVaultPath:()=>'/vault',getAdvanced:()=>({trayIcon:true})},'./i18n':{initMainI18n(){}},
    './shortcuts':{registerShortcuts(){},unregisterShortcuts(){}},'./services/vault-watch':{startVaultWatch(){},stopVaultWatch(){}},
    './updater':{initAutoUpdater(){}},'./windows/window-state':{flushWindowState(){}},'./startup':{shouldShowManager:()=>true},'../shared/ipc-channels':{IPC}});
  await start();app.quit();app.quit();assert.equal(flushes,1);assert.equal(stops,0);
  reject(Error('disk'));await tick();assert.equal(stops,0);assert.equal(alerts,1);assert.equal(lifeWindow.quitting,false);
  app.quit();release();await tick();assert.equal(stops,1);assert.equal(lifeWindow.quitting,true);
  console.log('PASS app quit: requests coalesce, failure retains service/windows, retry saves before cleanup');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
