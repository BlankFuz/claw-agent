const esbuild = require('esbuild');

const production = process.argv.includes('--production');

esbuild.build({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    outfile: 'out/extension.js',
    external: ['vscode'],
    format: 'cjs',
    platform: 'node',
    target: 'es2022',
    sourcemap: !production,
    minify: production,
}).catch(() => process.exit(1));
