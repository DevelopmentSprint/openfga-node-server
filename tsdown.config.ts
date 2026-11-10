import { readFileSync } from 'node:fs'
import { defineConfig } from 'tsdown'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }

export default defineConfig({
  entry: ['src/server.ts'],
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  dts: false,
  sourcemap: true,
  // Bake the package version into the bundle so service.version
  // resolves without reading package.json at runtime.
  define: {
    __PACKAGE_VERSION__: JSON.stringify(pkg.version),
  },
})
