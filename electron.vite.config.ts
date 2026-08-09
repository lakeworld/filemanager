import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import solidPlugin from 'vite-plugin-solid'
import tailwindcss from 'tailwindcss'
import autoprefixer from 'autoprefixer'
import path from 'node:path'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: path.resolve(__dirname, 'src/main/index.ts'),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: path.resolve(__dirname, 'src/preload/index.ts'),
        },
      },
    },
  },
  renderer: {
    root: 'src/renderer',
    resolve: {
      alias: {
        '~': path.resolve(__dirname, 'src/renderer/src'),
      },
    },
    // v2.4.2（P1-P3）：pdfjs-dist 排除预打包——vite optimizeDeps 会给 worker 注入
    // `import "/@vite/client"`，从 blob: URL 建模块 worker 时无法解析该裸路径 →
    // "Setting up fake worker failed"，PDF 在 dev 下打不开。排除后 worker 保持原始源码。
    optimizeDeps: {
      exclude: ['pdfjs-dist'],
    },
    plugins: [solidPlugin()],
    css: {
      postcss: {
        plugins: [
          tailwindcss({ config: path.resolve(__dirname, 'src/renderer/tailwind.config.js') }),
          autoprefixer(),
        ],
      },
    },
    build: {
      rollupOptions: {
        input: path.resolve(__dirname, 'src/renderer/index.html'),
      },
    },
  },
})
