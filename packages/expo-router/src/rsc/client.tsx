// From Waku -- https://github.com/dai-shi/waku/blob/32d52242c1450b5f5965860e671ff73c42da8bd0/packages/waku/src/client.ts#L1

/// <reference types="react/canary" />
'use client';

import * as FS from 'expo-file-system';
import {
  createContext,
  createElement,
  memo,
  use,
  useCallback,
  useState,
  startTransition,
} from 'react';
import type { ReactNode } from 'react';
import RSDWClient from 'react-server-dom-webpack/client';

import { encodeInput } from './renderers/utils';
import OS from '../../os';
import { getDevServer } from '../getDevServer';

const { createFromFetch, encodeReply } = RSDWClient;

declare global {
  interface ImportMeta {
    readonly env: Record<string, string>;
  }
}

// NOTE: Ensured to start with `/`.
const RSC_PATH = process.env.EXPO_RSC_PATH;

let BASE_PATH = `${process.env.EXPO_BASE_URL}${RSC_PATH}`;

if (!BASE_PATH.startsWith('/')) {
  BASE_PATH = '/' + BASE_PATH;
}

if (!BASE_PATH.endsWith('/')) {
  BASE_PATH += '/';
}

if (BASE_PATH === '/') {
  if (typeof process.env.EXPO_RSC_PATH !== 'string') {
    throw new Error(
      'process.env.EXPO_RSC_PATH was not defined. This is likely a misconfigured babel.config.js. Ensure babel-preset-expo is used.'
    );
  }
  throw new Error(
    `Invalid RSC path "${BASE_PATH}". The path should not live at the project root, e.g. /RSC/. Dev server URL: ${
      getDevServer().fullBundleUrl
    }`
  );
}
console.log('[RSC]: Base path:', BASE_PATH, { BASE_URL: process.env.EXPO_BASE_URL, RSC_PATH });

const checkStatus = async (responsePromise: Promise<Response>): Promise<Response> => {
  const response = await responsePromise;
  if (!response.ok) {
    // NOTE(EvanBacon): Transform the Metro development error into a JS error that can be used by LogBox.
    // This was tested against using a Class component in a server component.
    if (__DEV__ && response.status === 500) {
      const errorText = await response.text();

      let errorJson;

      try {
        errorJson = JSON.parse(errorJson);
      } catch {
        const err = new Error(errorText);
        throw err;
      }

      const err = new Error(errorJson.message);
      for (const key in errorJson) {
        (err as any)[key] = errorJson[key];
      }
      throw err;
    }

    const err = new Error(response.statusText);
    (err as any).statusCode = response.status;
    throw err;
  }
  console.log('[RSC]: Fetched', response.url, response.status);
  return response;
};

type Elements = Promise<Record<string, ReactNode>>;

function getCached<T>(c: () => T, m: WeakMap<object, T>, k: object): T {
  return (m.has(k) ? m : m.set(k, c())).get(k) as T;
}

const cache1 = new WeakMap();
const mergeElements = (a: Elements, b: Elements | Awaited<Elements>): Elements => {
  const getResult = async () => {
    const nextElements = { ...(await a), ...(await b) };
    delete nextElements._value;
    return nextElements;
  };
  const cache2 = getCached(() => new WeakMap(), cache1, a);
  return getCached(getResult, cache2, b);
};

type SetElements = (fn: (prev: Elements) => Elements) => void;
type CacheEntry = [
  input: string,
  searchParamsString: string,
  setElements: SetElements,
  elements: Elements,
];

const fetchCache: [CacheEntry?] = [];

export const fetchRSC = (
  input: string,
  searchParamsString: string,
  setElements: SetElements,
  cache = fetchCache
): Elements => {
  // TODO: strip when "is exporting".
  if (process.env.NODE_ENV === 'development') {
    const refetchRsc = () => {
      cache.splice(0);
      const data = fetchRSC(input, searchParamsString, setElements, cache);
      setElements(data);
    };
    globalThis.__WAKU_RSC_RELOAD_LISTENERS__ ||= [];
    const index = globalThis.__WAKU_RSC_RELOAD_LISTENERS__.indexOf(globalThis.__WAKU_REFETCH_RSC__);
    if (index !== -1) {
      globalThis.__WAKU_RSC_RELOAD_LISTENERS__.splice(index, 1, refetchRsc);
    } else {
      globalThis.__WAKU_RSC_RELOAD_LISTENERS__.push(refetchRsc);
    }
    globalThis.__WAKU_REFETCH_RSC__ = refetchRsc;
  }

  let entry: CacheEntry | undefined = cache[0];
  if (entry && entry[0] === input && entry[1] === searchParamsString) {
    entry[2] = setElements;
    return entry[3];
  }
  const options = {
    async callServer(actionId: string, args: unknown[]) {
      const response = fetch(
        getAdjustedFilePath(BASE_PATH + encodeInput(encodeURIComponent(actionId))),
        {
          method: 'POST',
          duplex: 'half',
          reactNative: { textStreaming: true },
          body: await encodeReply(args),
          headers: {
            'expo-platform': OS,
          },
        }
      );
      const data = createFromFetch<Awaited<Elements>>(checkStatus(response), options);
      const setElements = entry![2];
      startTransition(() => {
        // FIXME this causes rerenders even if data is empty
        setElements((prev) => mergeElements(prev, data));
      });
      return (await data)._value;
    },
  };
  const prefetched = ((globalThis as any).__WAKU_PREFETCHED__ ||= {});
  const url = BASE_PATH + encodeInput(input) + (searchParamsString ? '?' + searchParamsString : '');
  console.log('fetch', url);
  const response =
    prefetched[url] ||
    fetch(getAdjustedFilePath(url), {
      reactNative: { textStreaming: true },
      headers: {
        'expo-platform': OS,
      },
    });
  delete prefetched[url];
  const data = createFromFetch<Awaited<Elements>>(checkStatus(response), options);
  cache[0] = entry = [input, searchParamsString, setElements, data];
  return data;
};

function getAdjustedFilePath(path: string): string {
  if (OS === 'web') {
    return path;
  }
  if (getDevServer().bundleLoadedFromServer) {
    if (path.startsWith('/')) {
      return new URL(path, getDevServer().url).toString();
    }
    return path;
  }
  if (OS === 'android') {
    return 'file:///android_asset' + path;
  }

  console.log('FS.bundleDirectory', FS.bundleDirectory);
  return 'file://' + FS.bundleDirectory + path;
}

export const prefetchRSC = (input: string, searchParamsString: string): void => {
  const prefetched = ((globalThis as any).__WAKU_PREFETCHED__ ||= {});
  const url = getAdjustedFilePath(
    BASE_PATH + encodeInput(input) + (searchParamsString ? '?' + searchParamsString : '')
  );
  if (!(url in prefetched)) {
    prefetched[url] = fetch(url, {
      reactNative: { textStreaming: true },
      headers: {
        'expo-platform': OS,
      },
    });
  }
};

const RefetchContext = createContext<(input: string, searchParams?: URLSearchParams) => void>(
  () => {
    throw new Error('Missing Root component');
  }
);
const ElementsContext = createContext<Elements | null>(null);

export const Root = ({
  initialInput,
  initialSearchParamsString,
  cache,
  children,
}: {
  initialInput?: string;
  initialSearchParamsString?: string;
  cache?: typeof fetchCache;
  children: ReactNode;
}) => {
  const [elements, setElements] = useState(() =>
    fetchRSC(initialInput || '', initialSearchParamsString || '', (fn) => setElements(fn), cache)
  );
  const refetch = useCallback(
    (input: string, searchParams?: URLSearchParams) => {
      const data = fetchRSC(input, searchParams?.toString() || '', setElements, cache);
      setElements((prev) => mergeElements(prev, data));
    },
    [cache]
  );
  return createElement(
    RefetchContext.Provider,
    { value: refetch },
    createElement(ElementsContext.Provider, { value: elements }, children)
  );
};

export const useRefetch = () => use(RefetchContext);

const ChildrenContext = createContext<ReactNode>(undefined);
const ChildrenContextProvider = memo(ChildrenContext.Provider);

export const Slot = ({
  id,
  children,
  fallback,
}: {
  id: string;
  children?: ReactNode;
  fallback?: ReactNode;
}) => {
  const elementsPromise = use(ElementsContext);
  if (!elementsPromise) {
    throw new Error('Missing Root component');
  }
  const elements = use(elementsPromise);
  if (!(id in elements)) {
    if (fallback) {
      return fallback;
    }
    throw new Error('Not found: ' + id);
  }
  return createElement(ChildrenContextProvider, { value: children }, elements[id]);
};

export const Children = () => use(ChildrenContext);

export const ServerRoot = ({ elements, children }: { elements: Elements; children: ReactNode }) =>
  createElement(ElementsContext.Provider, { value: elements }, children);
