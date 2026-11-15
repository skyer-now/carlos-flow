module.exports = { ScenarioPack: (id, manifest) => ({ pack_id: id, manifest, created: Date.now() }) };
module.exports.Registry = class { 
  constructor() { this.activePacks = new Map(); }
  load(pack) { this.activePacks.set(pack.pack_id, pack); return true; }
  get(id) { return this.activePacks.get(id); }
};