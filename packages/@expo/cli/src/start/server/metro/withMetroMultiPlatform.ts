/**
 * Copyright © 2022 650 Industries.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
import { ExpoConfig, Platform } from '@expo/config';
import fs from 'fs';
import { ConfigT } from 'metro-config';
import { Resolution, ResolutionContext, CustomResolutionContext } from 'metro-resolver';
import * as metroResolver from 'metro-resolver';
import path from 'path';
import resolveFrom from 'resolve-from';

import { createFastResolver } from './createExpoMetroResolver';
import {
  EXTERNAL_REQUIRE_NATIVE_POLYFILL,
  EXTERNAL_REQUIRE_POLYFILL,
  // EXTERNAL_RSC_MANIFEST,
  METRO_EXTERNALS_FOLDER,
  METRO_SHIMS_FOLDER,
  REACT_CANARY_FOLDER,
  getNodeExternalModuleId,
  isNodeExternal,
  setupNodeExternals,
  setupShimFiles,
  tapVirtualModuleMemoized,
} from './externals';
import { isFailedToResolveNameError, isFailedToResolvePathError } from './metroErrors';
import {
  withMetroErrorReportingResolver,
  withMetroMutatedResolverContext,
  withMetroResolvers,
} from './withMetroResolvers';
import { Log } from '../../../log';
import { FileNotifier } from '../../../utils/FileNotifier';
import { env } from '../../../utils/env';
import { CommandError } from '../../../utils/errors';
import { installExitHooks } from '../../../utils/exit';
import { memoize } from '../../../utils/fn';
import { isInteractive } from '../../../utils/interactive';
import { loadTsConfigPathsAsync, TsConfigPaths } from '../../../utils/tsconfig/loadTsConfigPaths';
import { resolveWithTsConfigPaths } from '../../../utils/tsconfig/resolveWithTsConfigPaths';
import { isServerEnvironment } from '../middleware/metroOptions';
import { PlatformBundlers } from '../platformBundlers';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const debug = require('debug')('expo:start:server:metro:multi-platform') as typeof console.log;

function withWebPolyfills(config: ConfigT): ConfigT {
  const originalGetPolyfills = config.serializer.getPolyfills
    ? config.serializer.getPolyfills.bind(config.serializer)
    : () => [];

  const getPolyfills = (ctx: { platform: string | null }): readonly string[] => {
    if (ctx.platform === 'web') {
      return [
        // NOTE: We might need this for all platforms
        path.join(config.projectRoot, EXTERNAL_REQUIRE_POLYFILL),
        // path.join(config.projectRoot, EXTERNAL_RSC_MANIFEST),
        // TODO: runtime polyfills, i.e. Fast Refresh, error overlay, React Dev Tools...
      ];
    }
    // Generally uses `rn-get-polyfills`
    const polyfills = originalGetPolyfills(ctx);

    return [
      ...polyfills,
      path.join(config.projectRoot, EXTERNAL_REQUIRE_NATIVE_POLYFILL),
      // path.join(config.projectRoot, EXTERNAL_RSC_MANIFEST),
    ];
  };

  return {
    ...config,
    serializer: {
      ...config.serializer,
      getPolyfills,
    },
  };
}

function normalizeSlashes(p: string) {
  return p.replace(/\\/g, '/');
}

export function getNodejsExtensions(srcExts: readonly string[]): string[] {
  const mjsExts = srcExts.filter((ext) => /mjs$/.test(ext));
  const nodejsSourceExtensions = srcExts.filter((ext) => !/mjs$/.test(ext));
  // find index of last `*.js` extension
  const jsIndex = nodejsSourceExtensions.reduce((index, ext, i) => {
    return /jsx?$/.test(ext) ? i : index;
  }, -1);

  // insert `*.mjs` extensions after `*.js` extensions
  nodejsSourceExtensions.splice(jsIndex + 1, 0, ...mjsExts);

  return nodejsSourceExtensions;
}

function fastHash(str: string) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return hash;
}

const fastHashMemoized = memoize(fastHash);

/**
 * Apply custom resolvers to do the following:
 * - Disable `.native.js` extensions on web.
 * - Alias `react-native` to `react-native-web` on web.
 * - Redirect `react-native-web/dist/modules/AssetRegistry/index.js` to `@react-native/assets/registry.js` on web.
 * - Add support for `tsconfig.json`/`jsconfig.json` aliases via `compilerOptions.paths`.
 * - Alias react-native renderer code to a vendored React canary build on native.
 */
export function withExtendedResolver(
  config: ConfigT,
  {
    tsconfig,
    isTsconfigPathsEnabled,
    isFastResolverEnabled,
    isExporting,
    isReactCanaryEnabled,
  }: {
    tsconfig: TsConfigPaths | null;
    isTsconfigPathsEnabled?: boolean;
    isFastResolverEnabled?: boolean;
    isExporting?: boolean;
    isReactCanaryEnabled?: boolean;
  }
) {
  if (isFastResolverEnabled) {
    Log.warn(`Experimental bundling features are enabled.`);
  }
  if (isReactCanaryEnabled) {
    Log.warn(`Experimental React Server Components support is enabled.`);
  }

  // Get the `transformer.assetRegistryPath`
  // this needs to be unified since you can't dynamically
  // swap out the transformer based on platform.
  const assetRegistryPath = fs.realpathSync(
    path.resolve(resolveFrom(config.projectRoot, '@react-native/assets-registry/registry.js'))
  );

  const defaultResolver = metroResolver.resolve;
  const resolver = isFastResolverEnabled
    ? createFastResolver({
        preserveSymlinks: config.resolver?.unstable_enableSymlinks ?? true,
        blockList: Array.isArray(config.resolver?.blockList)
          ? config.resolver?.blockList
          : [config.resolver?.blockList],
      })
    : defaultResolver;

  const aliases: { [key: string]: Record<string, string> } = {
    web: {
      'react-native': 'react-native-web',
      'react-native/index': 'react-native-web',
    },
  };

  const universalAliases: [RegExp, string][] = [];

  // This package is currently always installed as it is included in the `expo` package.
  if (resolveFrom.silent(config.projectRoot, '@expo/vector-icons')) {
    debug('Enabling alias: react-native-vector-icons -> @expo/vector-icons');
    universalAliases.push([/^react-native-vector-icons(\/.*)?/, '@expo/vector-icons$1']);
  }

  const preferredMainFields: { [key: string]: string[] } = {
    // Defaults from Expo Webpack. Most packages using `react-native` don't support web
    // in the `react-native` field, so we should prefer the `browser` field.
    // https://github.com/expo/router/issues/37
    web: ['browser', 'module', 'main'],
  };

  let tsConfigResolve =
    isTsconfigPathsEnabled && (tsconfig?.paths || tsconfig?.baseUrl != null)
      ? resolveWithTsConfigPaths.bind(resolveWithTsConfigPaths, {
          paths: tsconfig.paths ?? {},
          baseUrl: tsconfig.baseUrl ?? config.projectRoot,
          hasBaseUrl: !!tsconfig.baseUrl,
        })
      : null;

  // TODO: Move this to be a transform key for invalidation.
  if (!isExporting && isInteractive()) {
    if (isTsconfigPathsEnabled) {
      // TODO: We should track all the files that used imports and invalidate them
      // currently the user will need to save all the files that use imports to
      // use the new aliases.
      const configWatcher = new FileNotifier(config.projectRoot, [
        './tsconfig.json',
        './jsconfig.json',
      ]);
      configWatcher.startObserving(() => {
        debug('Reloading tsconfig.json');
        loadTsConfigPathsAsync(config.projectRoot).then((tsConfigPaths) => {
          if (tsConfigPaths?.paths && !!Object.keys(tsConfigPaths.paths).length) {
            debug('Enabling tsconfig.json paths support');
            tsConfigResolve = resolveWithTsConfigPaths.bind(resolveWithTsConfigPaths, {
              paths: tsConfigPaths.paths ?? {},
              baseUrl: tsConfigPaths.baseUrl ?? config.projectRoot,
              hasBaseUrl: !!tsConfigPaths.baseUrl,
            });
          } else {
            debug('Disabling tsconfig.json paths support');
            tsConfigResolve = null;
          }
        });
      });

      // TODO: This probably prevents the process from exiting.
      installExitHooks(() => {
        configWatcher.stopObserving();
      });
    } else {
      debug('Skipping tsconfig.json paths support');
    }
  }

  let nodejsSourceExtensions: string[] | null = null;

  const canaryFolder = path.join(config.projectRoot, REACT_CANARY_FOLDER);

  const shimsFolder = path.join(config.projectRoot, METRO_SHIMS_FOLDER);

  function getStrictResolver(
    { resolveRequest, ...context }: ResolutionContext,
    platform: string | null
  ) {
    return function doResolve(moduleName: string): Resolution {
      return resolver(context, moduleName, platform);
    };
  }

  function getOptionalResolver(context: ResolutionContext, platform: string | null) {
    const doResolve = getStrictResolver(context, platform);
    return function optionalResolve(moduleName: string): Resolution | null {
      try {
        return doResolve(moduleName);
      } catch (error) {
        // If the error is directly related to a resolver not being able to resolve a module, then
        // we can ignore the error and try the next resolver. Otherwise, we should throw the error.
        const isResolutionError =
          isFailedToResolveNameError(error) || isFailedToResolvePathError(error);
        if (!isResolutionError) {
          throw error;
        }
      }
      return null;
    };
  }

  const hasLogged = new Set<string>();
  // If Node.js pass-through, then remap to a module like `module.exports = $$require_external(<module>)`.
  // If module should be shimmed, remap to an empty module.
  const externals: {
    match: (context: ResolutionContext, moduleName: string, platform: string | null) => boolean;
    replace: 'empty' | 'node' | 'weak';
  }[] = [
    {
      match: (context: ResolutionContext, moduleName: string, platform: string | null) => {
        if (
          // Disable internal externals when exporting for production.
          context.customResolverOptions.exporting ||
          // These externals are only for Node.js environments.
          !isServerEnvironment(context.customResolverOptions?.environment)
        ) {
          return false;
        }

        if (context.customResolverOptions?.environment === 'react-server') {
          const isExternal =
            /^(source-map-support(\/.*)?|@babel\/runtime\/.+|debug|metro-runtime\/src\/modules\/HMRClient|metro|acorn-loose|acorn|chalk|ws|ansi-styles|supports-color|color-convert|has-flag|utf-8-validate|color-name|react-refresh\/runtime|@remix-run\/node\/.+)$/.test(
              moduleName
            );

          // Ensure these non-react-server modules are excluded when bundling for React Server Components in development.
          return isExternal;
        }

        const isExternal = // Extern these modules in standard Node.js environments.
          /^(source-map-support(\/.*)?|react|react-helmet-async|@radix-ui\/.+|@babel\/runtime\/.+|react-dom(\/.+)?|debug|acorn-loose|acorn|css-in-js-utils\/lib\/.+|hyphenate-style-name|color|color-string|color-convert|color-name|fontfaceobserver|fast-deep-equal|query-string|escape-string-regexp|invariant|postcss-value-parser|memoize-one|nullthrows|strict-uri-encode|decode-uri-component|split-on-first|filter-obj|warn-once|simple-swizzle|is-arrayish|inline-style-prefixer\/.+)$/.test(
            moduleName
          );

        // if (!isExternal && !moduleName.match(/^[/.]/)) {
        //   if (!hasLogged.has(moduleName)) {
        //     console.log('>>>>', moduleName);
        //   }
        //   hasLogged.add(moduleName);
        // }

        return isExternal;
      },
      replace: 'node',
    },
    // Externals to speed up async split chunks by extern-ing common packages that appear in the root client chunk.
    {
      match: (context: ResolutionContext, moduleName: string, platform: string | null) => {
        if (
          // Disable internal externals when exporting for production.
          context.customResolverOptions.exporting ||
          // These externals are only for client environments.
          isServerEnvironment(context.customResolverOptions?.environment) ||
          // Only enable for client boundaries
          !context.customResolverOptions.clientboundary
        ) {
          return false;
        }

        const isExternal = // Extern these modules in standard Node.js environments.
          /^(styleq(\/.+)?|deprecated-react-native-prop-types|invariant|nullthrows|memoize-one|@react-native\/assets-registry\/registry|@react-native\/normalize-color|react|react\/jsx-dev-runtime|scheduler|react-is|expo-modules-core|react-native|react-dom(\/.+)?|metro-runtime(\/.+)?)$/.test(
            moduleName
          ) ||
          /^react-native-web\/dist\/exports\/(Platform|NativeEventEmitter|StyleSheet|NativeModules|DeviceEventEmitter|Text|View)$/.test(
            moduleName
          ) ||
          // TODO: Add more
          /^@babel\/runtime\/helpers\/(wrapNativeSuper)$/.test(moduleName);

        if (!isExternal && (platform === 'ios' || platform === 'android')) {
          // Auto extern all modules that are imported from React Native since RN has no tree-shaking/chill.
          // if (context.originModulePath.match(/node_modules[\\/]react-native[\\/]/)) {
          //   return true;
          // }
        }

        if (isExternal) {
          // console.log('Extern async chunk >', moduleName);
        } else {
          // if (!moduleName.match(/^[/.]/))
          //   console.log('[SKIP] Extern async chunk >', moduleName, context.originModulePath);
        }
        // if (!isExternal && !moduleName.match(/^[/.]/)) {
        //   if (!hasLogged.has(moduleName)) {
        //     console.log('>>>>', moduleName);
        //   }
        //   hasLogged.add(moduleName);
        // }

        return isExternal;
      },
      replace: 'weak',
    },
  ];

  const metroConfigWithCustomResolver = withMetroResolvers(config, [
    // Mock out production react imports in development.
    (context: ResolutionContext, moduleName: string, platform: string | null) => {
      // This resolution is dev-only to prevent bundling the production React packages in development.
      // @ts-expect-error: dev is not on type.
      if (!context.dev) return null;

      if (
        // Match react-native renderers.
        (platform !== 'web' &&
          context.originModulePath.match(/[\\/]node_modules[\\/]react-native[\\/]/) &&
          moduleName.match(/([\\/]ReactFabric|ReactNativeRenderer)-prod/)) ||
        // Match react production imports.
        (moduleName.match(/\.production(\.min)?\.js$/) &&
          // Match if the import originated from a react package.
          context.originModulePath.match(/[\\/]node_modules[\\/](react[-\\/]|scheduler[\\/])/))
      ) {
        debug(`Skipping production module: ${moduleName}`);
        // /Users/path/to/expo/node_modules/react/index.js ./cjs/react.production.min.js
        // /Users/path/to/expo/node_modules/react/jsx-dev-runtime.js ./cjs/react-jsx-dev-runtime.production.min.js
        // /Users/path/to/expo/node_modules/react-is/index.js ./cjs/react-is.production.min.js
        // /Users/path/to/expo/node_modules/react-refresh/runtime.js ./cjs/react-refresh-runtime.production.min.js
        // /Users/path/to/expo/node_modules/react-native/node_modules/scheduler/index.native.js ./cjs/scheduler.native.production.min.js
        // /Users/path/to/expo/node_modules/react-native/node_modules/react-is/index.js ./cjs/react-is.production.min.js
        return {
          type: 'empty',
        };
      }
      return null;
    },
    // tsconfig paths
    (context: ResolutionContext, moduleName: string, platform: string | null) => {
      return (
        tsConfigResolve?.(
          {
            originModulePath: context.originModulePath,
            moduleName,
          },
          getOptionalResolver(context, platform)
        ) ?? null
      );
    },

    // Node.js externals support
    (context: ResolutionContext, moduleName: string, platform: string | null) => {
      const isServer =
        context.customResolverOptions?.environment === 'node' ||
        context.customResolverOptions?.environment === 'react-server';

      const moduleId = isNodeExternal(moduleName);
      if (!moduleId) {
        return null;
      }

      if (
        // In browser runtimes, we want to either resolve a local node module by the same name, or shim the module to
        // prevent crashing when Node.js built-ins are imported.
        !isServer
      ) {
        // Perform optional resolve first. If the module doesn't exist (no module in the node_modules)
        // then we can mock the file to use an empty module.
        const result = getOptionalResolver(context, platform)(moduleName);

        if (!result && platform !== 'web') {
          // Preserve previous behavior where native throws an error on node.js internals.
          return null;
        }

        return (
          result ?? {
            // In this case, mock the file to use an empty module.
            type: 'empty',
          }
        );
      }

      const redirectedModuleName = getNodeExternalModuleId(context.originModulePath, moduleId);
      debug(`Redirecting Node.js external "${moduleId}" to "${redirectedModuleName}"`);
      return getStrictResolver(context, platform)(redirectedModuleName);
    },

    // Custom externals support
    (context: ResolutionContext, moduleName: string, platform: string | null) => {
      for (const external of externals) {
        if (external.match(context, moduleName, platform)) {
          if (external.replace === 'empty') {
            debug(`Redirecting external "${moduleName}" to "${external.replace}"`);
            return {
              type: external.replace,
            };
          } else if (external.replace === 'weak') {
            const contents = `module.exports=/*${moduleName}*/__r(require.resolveWeak('${moduleName}'))`;
            const generatedModuleId = fastHashMemoized(contents);
            const absoluteFilePath = path.join(
              config.projectRoot,
              METRO_EXTERNALS_FOLDER,
              String(generatedModuleId),
              'index.js'
            );
            tapVirtualModuleMemoized(absoluteFilePath, contents);
            const redirectedModuleName = path.relative(
              path.dirname(context.originModulePath),
              absoluteFilePath
            );
            debug(
              `Redirecting external "${moduleName}" to weak require in "${redirectedModuleName}"`
            );
            return getStrictResolver(context, platform)(redirectedModuleName);
          } else if (external.replace === 'node') {
            const contents = `module.exports=$$require_external('${moduleName}')`;
            const generatedModuleId = fastHashMemoized(contents);
            const absoluteFilePath = path.join(
              config.projectRoot,
              METRO_EXTERNALS_FOLDER,
              String(generatedModuleId),
              'index.js'
            );
            tapVirtualModuleMemoized(absoluteFilePath, contents);
            const redirectedModuleName = path.relative(
              path.dirname(context.originModulePath),
              absoluteFilePath
            );
            debug(
              `Redirecting external "${moduleName}" to Node.js require in "${redirectedModuleName}"`
            );
            return getStrictResolver(context, platform)(redirectedModuleName);
          } else {
            throw new CommandError(
              `Invalid external replace type: ${external.replace} for module "${moduleName}" (platform: ${platform}, originModulePath: ${context.originModulePath})`
            );
          }
        }
      }
      return null;
    },

    // Basic moduleId aliases
    (context: ResolutionContext, moduleName: string, platform: string | null) => {
      // Conditionally remap `react-native` to `react-native-web` on web in
      // a way that doesn't require Babel to resolve the alias.
      if (platform && platform in aliases && aliases[platform][moduleName]) {
        const redirectedModuleName = aliases[platform][moduleName];
        return getStrictResolver(context, platform)(redirectedModuleName);
      }

      for (const [matcher, alias] of universalAliases) {
        const match = moduleName.match(matcher);
        if (match) {
          const aliasedModule = alias.replace(
            /\$(\d+)/g,
            (_, index) => match[parseInt(index, 10)] ?? ''
          );
          const doResolve = getStrictResolver(context, platform);
          debug(`Alias "${moduleName}" to "${aliasedModule}"`);
          return doResolve(aliasedModule);
        }
      }

      return null;
    },

    // HACK(EvanBacon):
    // React Native uses `event-target-shim` incorrectly and this causes the native runtime
    // to fail to load. This is a temporary workaround until we can fix this upstream.
    // https://github.com/facebook/react-native/pull/38628
    (context: ResolutionContext, moduleName: string, platform: string | null) => {
      if (platform !== 'web' && moduleName === 'event-target-shim') {
        debug('For event-target-shim to use js:', context.originModulePath);
        const doResolve = getStrictResolver(context, platform);
        return doResolve('event-target-shim/dist/event-target-shim.js');
      }

      return null;
    },

    // TODO: Reduce these as much as possible in the future.
    // Complex post-resolution rewrites.
    (context: ResolutionContext, moduleName: string, platform: string | null) => {
      const doResolve = getStrictResolver(context, platform);

      const result = doResolve(moduleName);

      if (result.type !== 'sourceFile') {
        return result;
      }

      if (platform === 'web') {
        // Replace the web resolver with the original one.
        // This is basically an alias for web-only.
        // TODO: Drop this in favor of the standalone asset registry module.
        if (shouldAliasAssetRegistryForWeb(platform, result)) {
          // @ts-expect-error: `readonly` for some reason.
          result.filePath = assetRegistryPath;
        }

        if (platform === 'web' && result.filePath.includes('node_modules')) {
          // Replace with static shims

          const normalName = normalizeSlashes(result.filePath)
            // Drop everything up until the `node_modules` folder.
            .replace(/.*node_modules\//, '');

          const shimPath = path.join(shimsFolder, normalName);
          if (fs.existsSync(shimPath)) {
            // @ts-expect-error: `readonly` for some reason.
            result.filePath = shimPath;
          }
        }
      } else {
        // When server components are enabled, redirect React Native's renderer to the canary build
        // this will enable the use hook and other requisite features from React 19.
        if (isReactCanaryEnabled && result.filePath.includes('node_modules')) {
          const normalName = normalizeSlashes(result.filePath)
            // Drop everything up until the `node_modules` folder.
            .replace(/.*node_modules\//, '');

          // Files are added via the `@expo/cli/static/canary` folder.
          const shimPath = path.join(canaryFolder, normalName);
          if (fs.existsSync(shimPath)) {
            debug(`Redirecting React Native module "${result.filePath}" to canary build`);
            // @ts-expect-error: `readonly` for some reason.
            result.filePath = shimPath;
          }
        }
      }

      return result;
    },
  ]);

  // Ensure we mutate the resolution context to include the custom resolver options for server and web.
  const metroConfigWithCustomContext = withMetroMutatedResolverContext(
    metroConfigWithCustomResolver,
    (
      immutableContext: CustomResolutionContext,
      moduleName: string,
      platform: string | null
    ): CustomResolutionContext => {
      const context: Mutable<CustomResolutionContext> = {
        ...immutableContext,
        preferNativePlatform: platform !== 'web',
      };

      if (isServerEnvironment(context.customResolverOptions?.environment)) {
        // Adjust nodejs source extensions to sort mjs after js, including platform variants.
        if (nodejsSourceExtensions === null) {
          nodejsSourceExtensions = getNodejsExtensions(context.sourceExts);
        }
        context.sourceExts = nodejsSourceExtensions;

        context.unstable_enablePackageExports = true;
        context.unstable_conditionNames = ['node', 'require'];
        context.unstable_conditionsByPlatform = {};
        // Node.js runtimes should only be importing main at the moment.
        // This is a temporary fix until we can support the package.json exports.
        context.mainFields = ['main', 'module'];

        // Enable react-server import conditions.
        if (context.customResolverOptions?.environment === 'react-server') {
          context.unstable_conditionNames = ['node', 'require', 'react-server', 'server'];
        }
      } else {
        // Non-server changes

        if (!env.EXPO_METRO_NO_MAIN_FIELD_OVERRIDE && platform && platform in preferredMainFields) {
          context.mainFields = preferredMainFields[platform];
        }
      }

      return context;
    }
  );

  return withMetroErrorReportingResolver(metroConfigWithCustomContext);
}

/** @returns `true` if the incoming resolution should be swapped on web. */
export function shouldAliasAssetRegistryForWeb(
  platform: string | null,
  result: Resolution
): boolean {
  return (
    platform === 'web' &&
    result?.type === 'sourceFile' &&
    typeof result?.filePath === 'string' &&
    normalizeSlashes(result.filePath).endsWith(
      'react-native-web/dist/modules/AssetRegistry/index.js'
    )
  );
}
/** @returns `true` if the incoming resolution should be swapped. */
export function shouldAliasModule(
  input: {
    platform: string | null;
    result: Resolution;
  },
  alias: { platform: string; output: string }
): boolean {
  return (
    input.platform === alias.platform &&
    input.result?.type === 'sourceFile' &&
    typeof input.result?.filePath === 'string' &&
    normalizeSlashes(input.result.filePath).endsWith(alias.output)
  );
}

/** Add support for `react-native-web` and the Web platform. */
export async function withMetroMultiPlatformAsync(
  projectRoot: string,
  {
    config,
    exp,
    platformBundlers,
    isTsconfigPathsEnabled,
    webOutput,
    isFastResolverEnabled,
    isExporting,
    isReactCanaryEnabled,
  }: {
    config: ConfigT;
    exp: ExpoConfig;
    isTsconfigPathsEnabled: boolean;
    platformBundlers: PlatformBundlers;
    webOutput?: 'single' | 'static' | 'server';
    isFastResolverEnabled?: boolean;
    isExporting?: boolean;
    isReactCanaryEnabled: boolean;
  }
) {
  if (!config.projectRoot) {
    // @ts-expect-error: read-only types
    config.projectRoot = projectRoot;
  }

  // Required for @expo/metro-runtime to format paths in the web LogBox.
  process.env.EXPO_PUBLIC_PROJECT_ROOT = process.env.EXPO_PUBLIC_PROJECT_ROOT ?? projectRoot;

  if (['static', 'server'].includes(webOutput ?? '')) {
    // Enable static rendering in runtime space.
    process.env.EXPO_PUBLIC_USE_STATIC = '1';
  }

  // This is used for running Expo CLI in development against projects outside the monorepo.
  if (!isDirectoryIn(__dirname, projectRoot)) {
    if (!config.watchFolders) {
      // @ts-expect-error: watchFolders is readonly
      config.watchFolders = [];
    }
    // @ts-expect-error: watchFolders is readonly
    config.watchFolders.push(path.join(require.resolve('metro-runtime/package.json'), '../..'));
  }

  // @ts-expect-error
  config.transformer._expoRouterWebRendering = webOutput;
  // @ts-expect-error: Invalidate the cache when the location of expo-router changes on-disk.
  config.transformer._expoRouterPath = resolveFrom.silent(projectRoot, 'expo-router');

  let tsconfig: null | TsConfigPaths = null;

  if (isTsconfigPathsEnabled) {
    tsconfig = await loadTsConfigPathsAsync(projectRoot);
  }

  await setupShimFiles(projectRoot, {
    shims: true,
    canary: isReactCanaryEnabled,
  });
  await setupNodeExternals(projectRoot);

  let expoConfigPlatforms = Object.entries(platformBundlers)
    .filter(
      ([platform, bundler]) => bundler === 'metro' && exp.platforms?.includes(platform as Platform)
    )
    .map(([platform]) => platform);

  if (Array.isArray(config.resolver.platforms)) {
    expoConfigPlatforms = [...new Set(expoConfigPlatforms.concat(config.resolver.platforms))];
  }

  // @ts-expect-error: typed as `readonly`.
  config.resolver.platforms = expoConfigPlatforms;

  config = withWebPolyfills(config);

  return withExtendedResolver(config, {
    tsconfig,
    isExporting,
    isTsconfigPathsEnabled,
    isFastResolverEnabled,
    isReactCanaryEnabled,
  });
}

function isDirectoryIn(a: string, b: string) {
  return b.startsWith(a) && b.length > a.length;
}
