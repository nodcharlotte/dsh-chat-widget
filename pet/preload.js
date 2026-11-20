/**
 * 桌宠窗口 —— preload：给页面开一个小口子（contextBridge）。
 *
 * 页面**拿不到 Node**（`nodeIntegration:false`），只能看见下面这几个方法。
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('petShell', {
  /** 读启动配置：{ state, bounds, pageUrl }。 */
  config: () => ipcRenderer.invoke('pet:config'),
  /** 开关鼠标穿透（true = 点到桌面去，但仍能收到 mousemove）。 */
  setIgnore: (ignore) => ipcRenderer.send('pet:set-ignore', ignore === true),
  /** 改窗口矩形（拖动/拖边缘都用它）。 */
  setBounds: (rect) => ipcRenderer.invoke('pet:set-bounds', rect),
  /** 读当前窗口矩形。 */
  getBounds: () => ipcRenderer.invoke('pet:get-bounds'),
  /** 存一点状态（模式/缩放）。 */
  saveState: (patch) => ipcRenderer.send('pet:save-state', patch),
  /** 退出桌宠。 */
  quit: () => ipcRenderer.send('pet:quit'),
});
