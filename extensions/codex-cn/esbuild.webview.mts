// Webview 打包：esbuild 单文件输出 dist/webview.js
import { build, context } from 'esbuild'
import vue from 'esbuild-plugin-vue3'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const dirname = path.dirname(fileURLToPath(import.meta.url))
const watch = process.argv.includes('--watch')

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: [path.join(dirname, 'src/webview/main.ts')],
  bundle: true,
  outfile: path.join(dirname, 'dist/webview.js'),
  format: 'iife',
  platform: 'browser',
  target: 'chrome120',
  jsx: undefined,
  resolveExtensions: ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.css', '.json'],
  logLevel: 'info',
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  plugins: [vue()],
}

if (watch) {
  const ctx = await context(options)
  await ctx.watch()
} else {
  await build(options)
}
