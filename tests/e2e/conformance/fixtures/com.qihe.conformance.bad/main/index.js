/**
 * 一致性套件负路径夹具 · 主进程入口（纯 JS，随 build-conformance-fixtures.mjs 打包为 .qbox）。
 * manifest.json 故意非法（transport: 'http'，v1 仅允许 'inproc'）→ 宿主安装期 validateManifest 拒绝，
 * 本入口永远不会被加载（仅保证包结构完整，满足 installer 的「缺 main/index.js」检查在 manifest 校验之后）。
 */
module.exports = {
  async activate(host) {
    return { ipc: {} }
  },
}
