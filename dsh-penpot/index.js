// Host entry. The bundle patch mounts this package; the real plugin lives in lib/.
export { name, inject, apply } from './lib/index.js'