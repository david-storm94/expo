// import { enableScreens, NativeScreen } from 'react-native-screens';
// enableScreens(false);

import React from 'react';
// import { SafeAreaProvider } from 'react-native-safe-area-context';

import { SkipMetaProvider } from './rsc/router/SkipContext';
import { LocationContext } from './rsc/router/WindowLocationContext';
import { Router } from './rsc/router/client';
import { ErrorBoundary } from './views/ErrorBoundary';
import { ErrorBoundaryProps, Try } from './views/Try';

// Add root error recovery.
function RootErrorBoundary(props: ErrorBoundaryProps) {
  React.useEffect(() => {
    function refetchRoute() {
      if (props.error) {
        props.retry();
      }
    }
    // TODO: Only strip when not connected to a dev server.
    if (process.env.NODE_ENV === 'development') {
      globalThis.__WAKU_RSC_RELOAD_LISTENERS__ ||= [];
      const index = globalThis.__WAKU_RSC_RELOAD_LISTENERS__.indexOf(
        globalThis.__WAKU_REFETCH_ROUTE__
      );
      if (index !== -1) {
        globalThis.__WAKU_RSC_RELOAD_LISTENERS__.splice(index, 1, refetchRoute);
      } else {
        globalThis.__WAKU_RSC_RELOAD_LISTENERS__.unshift(refetchRoute);
      }
      globalThis.__WAKU_REFETCH_ROUTE__ = refetchRoute;
    }
  }, [props.error, props.retry]);

  return <ErrorBoundary error={props.error} retry={props.retry} />;
}

// Must be exported or Fast Refresh won't update the context
export function App() {
  return (
    <LocationContext>
      <SkipMetaProvider>
        {/* TODO: Add safe area back after it has v74 support. */}
        {/* <SafeAreaProvider
          initialMetrics={{
            frame: { x: 0, y: 0, width: 0, height: 0 },
            insets: { top: 0, left: 0, right: 0, bottom: 0 },
          }}> */}
          <Try catch={RootErrorBoundary}>
            <Router />
          </Try>
        {/* </SafeAreaProvider> */}
      </SkipMetaProvider>
    </LocationContext>
  );
}
