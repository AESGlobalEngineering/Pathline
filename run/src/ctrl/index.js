// Controller registry: converters (plan → machine code) and links (talk to the controller).
'use strict';

const trotec = require('./trotec/compile');
const ruida = require('./ruida/compile');

const CONTROLLERS = {
  trotec: { label: 'Trotec', compile: trotec.compile, exportFiles: trotec.exportFiles, link: () => require('./trotec/link') },
  ruida: { label: 'Ruida', compile: ruida.compile, exportFiles: ruida.exportFiles, link: () => require('./ruida/link') }
};

function controller(name) {
  const c = CONTROLLERS[name];
  if (!c) throw new Error('Unknown controller "' + name + '" (use trotec or ruida)');
  return c;
}

// The link for this config: the real controller, or the simulator.
function makeLink(cfg, log) {
  if (cfg.connection.mode === 'sim') return new (require('./sim'))(cfg, log);
  const Link = controller(cfg.controller).link();
  return new Link(cfg, log);
}

module.exports = { CONTROLLERS, controller, makeLink };
