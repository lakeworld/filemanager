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
