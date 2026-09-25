import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import type { RsbuildPlugin, RsbuildPluginAPI, Rspack } from '@rsbuild/core';
import type { IPX, IPXOptions, IPXStorage } from 'ipx';
import { withoutBase } from 'ufo';
import type { LoaderOptions } from './loader';
import { logger } from './logger';
import * as resolved from './resolved';
import type { ImageSerializableContext } from './shared';
import { DEFAULT_IPX_BASENAME } from './shared/constants';
import { invariant, isModuleNotFoundError, scopedBuf } from './utils';

export interface ExtendedIPXOptions extends Partial<IPXOptions> {
  assetPrefix?: string;
}

export interface PluginImageOptions
  extends ImageSerializableContext,
    LoaderOptions {
  /**
   * Enable the builtin IPX middleware.
   * It will mount a new route `/_rsbuild/ipx` to the development server.
   * The IPX middleware will be used to process images on the fly.
   *
   * Only take effects to the **development server**,
   * you need to setup a image according to your CDN in production.
   */
  ipx?: ExtendedIPXOptions;
}

class IPXNotFoundError extends Error {
  constructor() {
    super(
      'Failed to load ipx module, try to install it by `pnpm add -D ipx` or leave the `ipx` option empty and setup any other image loader.',
    );
    this.name = 'IPXNotFoundError';
  }
}

class LoaderOrIPXRequiredError extends Error {
  constructor() {
    super(
      'You must enable the builtin `ipx` middleware or configure a custom `loader` file to use the image plugin.',
    );
  }
}

class UnableResolveImageLoaderError extends Error {
  constructor() {
    super(
      'Can\t resolve the resource path of image loader. It must be a string or a loader function with url property.',
    );
  }
}

async function loadIPXModule() {
  try {
    return await import('ipx');
  } catch (err) {
    if (isModuleNotFoundError(err)) throw new IPXNotFoundError();
    throw err;
  }
}

type IPXNodeMiddleware = (req: IncomingMessage, res: ServerResponse) => unknown;

type IPXNodeMiddlewareFactory = (ipx: IPX) => IPXNodeMiddleware;

/**
 * Create a Node.js request handler for the IPX instance.
 * Uses `createIPXNodeHandler` from ipx 4 and falls back to
 * `createIPXNodeServer` from ipx 3, which was removed in ipx 4.
 */
function createIPXNodeMiddleware(mod: object, ipx: IPX): IPXNodeMiddleware {
  if (
    'createIPXNodeHandler' in mod &&
    typeof mod.createIPXNodeHandler === 'function'
  ) {
    return (mod.createIPXNodeHandler as IPXNodeMiddlewareFactory)(ipx);
  }
  if (
    'createIPXNodeServer' in mod &&
    typeof mod.createIPXNodeServer === 'function'
  ) {
    return (mod.createIPXNodeServer as IPXNodeMiddlewareFactory)(ipx);
  }
  throw new Error(
    'Unsupported ipx version: expected `createIPXNodeHandler` (ipx 4) or `createIPXNodeServer` (ipx 3) to be exported.',
  );
}

function createBundlerStorage(compiler: Rspack.Compiler): IPXStorage {
  const useOutputFileSystem = () => {
    if (!compiler.outputFileSystem) {
      throw new Error(
        'Unable to access compiler.outputFileSystem from IPX middleware',
      );
    }
    return compiler.outputFileSystem;
  };
  const resolveId = (id: string) => path.join(compiler.outputPath, id);
  return {
    name: 'rsbuild-image:bundler-ofs',
    getMeta(id) {
      const ofs = useOutputFileSystem();
      return new Promise((resolve, reject) => {
        ofs.stat(resolveId(id), (err, res) => {
          if (err) {
            reject(err);
          } else {
            resolve(res);
          }
        });
      });
    },
    getData(id) {
      const ofs = useOutputFileSystem();
      return new Promise((resolve, reject) => {
        ofs.readFile(resolveId(id), (err, res) => {
          if (err) reject(err);
          else resolve(res ? scopedBuf(res) : undefined);
        });
      });
    },
  };
}

function isDev(api: RsbuildPluginAPI) {
  let isDev: boolean;
  if (typeof api.context.action === 'string') {
    isDev = api.context.action === 'dev';
  } else if ('command' in api.context) {
    // Workaround with rspress.
    isDev = api.context.command === 'dev';
  } else {
    logger.warn('Unable to distinguish dev/prod environment');
    isDev = true;
  }
  return isDev;
}

export const pluginImage = (
  options: PluginImageOptions = {},
): RsbuildPlugin => {
  return {
    name: '@rsbuild-image/core',
    async setup(api) {
      const { densities, loading, placeholder, quality } = options;

      const { loader = resolved.IMAGE_LOADER } = options;

      const serializable: ImageSerializableContext = {
        densities,
        loader,
        loading,
        placeholder,
        quality,
      };

      // Serialize and inject the options to the runtime context.
      api.modifyRsbuildConfig(async (config, { mergeRsbuildConfig }) => {
        return mergeRsbuildConfig(config, {
          source: {
            define: {
              __INTERNAL_RSBUILD_IMAGE_OPTIONS__: JSON.stringify(serializable),
            },
          },
          resolve: {
            alias: (aliases) => ({
              ...aliases,
              '@rsbuild-image/core/image-loader': loader,
            }),
          },
        });
      });

      let compiler: Rspack.Compiler | undefined;
      api.onAfterCreateCompiler((params) => {
        if (compiler) return;
        compiler =
          'compilers' in params.compiler
            ? params.compiler.compilers[0]
            : params.compiler;
      });

      // Setup the IPX middleware.
      api.modifyRsbuildConfig(async (config, { mergeRsbuildConfig }) => {
        // Forced to be `undefined` in non-development mode.
        // The IPX middleware is only available for development server
        const ipx = isDev(api) ? options?.ipx : undefined;

        // Panic while leave both `ipx` & `loader` empty,
        if (!ipx && !options?.loader) throw new LoaderOrIPXRequiredError();
        if (!ipx) return;
        const ipxModule = await loadIPXModule();
        const { assetPrefix = DEFAULT_IPX_BASENAME, ...ipxOptions } = ipx;

        return mergeRsbuildConfig(config, {
          source: {
            define: {
              __RSBUILD_IMAGE_IPX_ASSET_PREFIX__: JSON.stringify(assetPrefix),
            },
          },
          dev: {
            setupMiddlewares: [
              (middlewares) => {
                invariant(
                  compiler,
                  'Compiler is not initialized while setup the IPX middleware',
                );
                const { distPath } = api.context;
                invariant(typeof distPath === 'string');

                const { storage = createBundlerStorage(compiler), ...rest } =
                  ipxOptions;
                const ipx = ipxModule.createIPX({ storage, ...rest });
                logger.debug(`Created IPX with local storage from ${distPath}`);
                logger.debug(`Created IPX with assetPrefix ${assetPrefix}`);

                const originalMiddleware = createIPXNodeMiddleware(
                  ipxModule,
                  ipx,
                );
                middlewares.unshift((req, res, _next) => {
                  const next = () => {
                    logger.debug(`IPX middleware incoming request: ${req.url}`);
                    _next();
                  };
                  if (!req.url) return next();
                  const newUrl = withoutBase(req.url, assetPrefix);
                  if (newUrl === req.url) return next();
                  req.url = newUrl;

                  logger.debug(
                    `IPX middleware incoming request (accepted): ${req.url}`,
                  );
                  return originalMiddleware(req, res);
                });
              },
            ],
          },
        });
      });

      // Modify the bundler chain to add the image loader.
      api.modifyBundlerChain((chain) => {
        const { thumbnail } = options ?? {};
        const loaderOptions: LoaderOptions = { thumbnail };
        chain.module
          .rule('image-component-module')
          .type('javascript/auto')
          .resourceQuery(/\?image$/)
          .use('image-component-loader')
          .loader(resolved.LOADER)
          .options(loaderOptions);
      });
    },
  };
};

export default pluginImage;
