import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    proxy: {
      '/api': process.env.ACTOR_CAFE_GATEWAY ?? 'http://127.0.0.1:4200',
    },
  },
});
