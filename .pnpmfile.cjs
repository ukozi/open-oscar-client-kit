// TypeDoc reads the TypeScript compiler API, which TypeScript 7 does not have.
function readPackage(pkg) {
  if (pkg.name === 'typedoc') {
    delete pkg.peerDependencies.typescript;
    pkg.dependencies.typescript = '6.0.3';
  }
  return pkg;
}

module.exports = { hooks: { readPackage } };
