package expo.modules.core.interfaces;

import com.facebook.react.ReactHost;
import com.facebook.react.ReactInstanceManager;
import com.facebook.react.bridge.JavaScriptExecutorFactory;

import androidx.annotation.Nullable;

public interface ReactNativeHostHandler {
  /**
   * Given chance for modules to override react bundle file.
   * e.g. for expo-updates
   *
   * @param useDeveloperSupport true if {@link com.facebook.react.ReactNativeHost} enabled developer support
   * @return custom path to bundle file, or null if not to override
   */
  @Nullable
  default String getJSBundleFile(boolean useDeveloperSupport) {
    return null;
  }

  /**
   * Given chance for modules to override react bundle asset name.
   * e.g. for expo-updates
   *
   * @param useDeveloperSupport true if {@link com.facebook.react.ReactNativeHost} enabled developer support
   * @return custom bundle asset name, or null if not to override
   */
  @Nullable
  default String getBundleAssetName(boolean useDeveloperSupport) {
    return null;
  }

  /**
   * Give modules a chance to override the value for useDeveloperSupport,
   * e.g. for expo-dev-launcher
   *
   * @return value for useDeveloperSupport, or null if not to override
   */
  @Nullable
  default Boolean getUseDeveloperSupport() {
    return null;
  }

  /**
   * Given chance for modules to override react dev support manager factory.
   * e.g. for expo-dev-client
   *
   * Note: we can't specify the type here, because the `DevSupportManagerFactory`
   * doesn't exist in the React Native 0.66 or below.
   *
   * @return custom DevSupportManagerFactory, or null if not to override
   *
   * NOTE: This callback is not support in bridgeless mode
   */
  @Nullable
  default Object getDevSupportManagerFactory() { return null; }

  /**
   * Given chance for modules to override the javascript executor factory.
   *
   * NOTE: This callback is not support in bridgeless mode
   */
  @Nullable
  default JavaScriptExecutorFactory getJavaScriptExecutorFactory() { return null; }

  //region event listeners

  /**
   * Callback before react instance creation
   */
  default void onWillCreateReactInstance(boolean useDeveloperSupport) {}

  /**
   * Callback after react instance creation
   *
   * @param reactInstanceManager In non-bridgeless mode, passing the created {@link ReactInstanceManager}
   * @param reactHost In bridgeless mode, passing the created {@link ReactHost}
   */
  default void onDidCreateReactInstance(
    boolean useDeveloperSupport,
    @Nullable ReactInstanceManager reactInstanceManager,
    @Nullable ReactHost reactHost) {}

  //endregion
}
