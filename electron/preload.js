'use strict';

// 主进程 ↔ 渲染进程的唯一通道。渲染进程拿不到 Node 与 ipcRenderer 本体。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('companion', {
  getAppInfo: () => ipcRenderer.invoke('app:info'),
  setApiKey: (key, ref) => ipcRenderer.invoke('secret:set', { ref: ref || 'deepseek', key }),
  clearApiKey: (ref) => ipcRenderer.invoke('secret:clear', ref || 'deepseek'),
  setClickThrough: (enabled) => ipcRenderer.invoke('window:clickThrough', enabled),
  setInteractive: (on) => ipcRenderer.invoke('window:interactive', on),
  setHitRect: (rect) => ipcRenderer.send('ui:hitrect', rect),
  uiLog: (msg) => ipcRenderer.send('ui:log', msg),
  hideWindow: () => ipcRenderer.invoke('window:hide'),
  quit: () => ipcRenderer.invoke('app:quit'),

  // M1：把 16k 单声道 PCM 交给主进程做 ASR
  transcribe: (pcm) => ipcRenderer.invoke('asr:transcribe', pcm),

  // M3：衣橱
  listLooks: () => ipcRenderer.invoke('looks:list'),
  setLook: (id) => ipcRenderer.invoke('look:set', id),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),

  // 模式：window / desktop
  setMode: (mode) => ipcRenderer.invoke('mode:set', mode),
  getPersona: () => ipcRenderer.invoke('persona:get'),
  setPersona: (patch) => ipcRenderer.invoke('persona:set', patch),
  resetPersona: () => ipcRenderer.invoke('persona:reset'),
  toggleMode: () => ipcRenderer.invoke('mode:toggle'),
  onModeChanged: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('mode:changed', handler);
    return () => ipcRenderer.removeListener('mode:changed', handler);
  },

  // M2：把用户文本交给主进程，回复通过 reply:event 流式返回
  sendChat: (text) => ipcRenderer.invoke('chat:turn', text),
  onReplyEvent: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('reply:event', handler);
    return () => ipcRenderer.removeListener('reply:event', handler);
  },

  onSettingsOpen: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('settings:open', handler);
    return () => ipcRenderer.removeListener('settings:open', handler);
  },
  onPttToggle: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('ptt:toggle', handler);
    return () => ipcRenderer.removeListener('ptt:toggle', handler);
  },
});
