// Bridge between the pages and the main process. Every call returns a promise
// that resolves with the value or rejects with an Error (err.offline is set
// when the controller device did not answer).
'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const call = (channel) => async (...args) => {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (r && r.ok) return r.value;
  const err = new Error((r && r.error) || 'Something went wrong');
  err.offline = !!(r && r.offline);
  throw err;
};

contextBridge.exposeInMainWorld('api', {
  app: { info: call('app:info'), openExternal: call('app:openExternal'), showItem: call('app:showItem'), confirm: call('app:confirm'), pickFolder: call('app:pickFolder') },
  settings: { get: call('settings:get'), set: call('settings:set') },
  machines: { list: call('machines:list'), save: call('machines:save'), saveAll: call('machines:saveAll'), remove: call('machines:remove'), create: call('machines:create'), duplicate: call('machines:duplicate'), placeholder: call('machines:placeholder') },
  materials: {
    list: call('materials:list'), save: call('materials:save'), saveAll: call('materials:saveAll'), remove: call('materials:remove'),
    create: call('materials:create'), duplicate: call('materials:duplicate'), exportLib: call('materials:export'), importLib: call('materials:import')
  },
  job: {
    current: call('job:current'), update: call('job:update'), undo: call('job:undo'), redo: call('job:redo'), history: call('job:history'),
    create: call('job:new'), replace: call('job:replace'), open: call('job:open'), save: call('job:save'), saveToComputer: call('job:saveToComputer'),
    exportAs: call('job:export'), importDialog: call('job:importDialog'), importPath: call('job:importPath'), recent: call('job:recent')
  },
  device: {
    test: call('device:test'), sync: call('device:sync'), status: call('device:status'), command: call('device:command'), send: call('device:send'),
    jobs: call('device:jobs'), removeJob: call('device:removeJob'), orderJobs: call('device:orderJobs')
  },
  // bug and crash reports (saved locally); crashed(fn) hears about errors in the main process
  report: {
    bug: call('report:bug'), error: call('report:error'), pending: call('report:pending'), openFolder: call('report:openFolder'),
    crashed: (fn) => ipcRenderer.on('report:crashed', (_e, d) => fn(d))
  },
  // updates: check() asks GitHub; download() and install() only when the operator chooses;
  // onState(fn) hears { state, version, percent, … } (available, downloading with progress, ready, error)
  update: {
    check: call('update:check'), status: call('update:status'), download: call('update:download'), install: call('update:install'),
    onState: (fn) => ipcRenderer.on('update:state', (_e, s) => fn(s))
  },
  // path of a file dropped onto the window
  pathOf: (file) => webUtils.getPathForFile(file)
});
