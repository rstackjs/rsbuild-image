// @vitest-environment node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type RsbuildDevServer, createRsbuild } from '@rsbuild/core';
import { imageSize } from 'image-size';
import { afterEach, describe, expect, it, vi } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const variants = [
  {
    name: 'ipx 4',
    handler: 'createIPXNodeHandler',
    load: () => import('ipx'),
  },
  {
    name: 'ipx 3',
    handler: 'createIPXNodeServer',
    load: () => import('ipx-v3'),
  },
];

describe.each(variants)(
  'IPX dev middleware with $name',
  ({ handler, load }) => {
    let server: RsbuildDevServer | undefined;

    afterEach(async () => {
      await server?.close();
      server = undefined;
      vi.doUnmock('ipx');
      vi.resetModules();
    });

    async function startDevServer() {
      vi.resetModules();
      vi.doMock('ipx', load);
      // Make sure the plugin sees the intended ipx major.
      expect(await import('ipx')).toHaveProperty(handler);
      const { pluginImage } = await import('../src/plugin');
      const rsbuild = await createRsbuild({
        cwd: __dirname,
        rsbuildConfig: {
          plugins: [pluginImage({ ipx: {} })],
          source: {
            entry: { index: path.resolve(__dirname, 'fixtures/ipx-entry.js') },
          },
          output: { filenameHash: false },
          dev: { hmr: false, liveReload: false },
          server: { port: 38_000, printUrls: false },
        },
      });
      server = await rsbuild.createDevServer();
      await server.listen();
      await server.environments.web.getStats();
      return `http://localhost:${server.port}`;
    }

    it('serves optimized images under the asset prefix', async () => {
      const origin = await startDevServer();

      const res = await fetch(
        `${origin}/_rsbuild/ipx/f_webp,w_48/static/image/firefox.png`,
      );

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/webp');
      const size = imageSize(new Uint8Array(await res.arrayBuffer()));
      expect(size).toMatchObject({ type: 'webp', width: 48 });
    });
  },
);
