"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeOptionsAsync = exports.DEFAULT_IGNORE_PATHS = exports.FINGERPRINT_IGNORE_FILENAME = void 0;
const promises_1 = __importDefault(require("fs/promises"));
const os_1 = __importDefault(require("os"));
const path_1 = __importDefault(require("path"));
exports.FINGERPRINT_IGNORE_FILENAME = '.fingerprintignore';
exports.DEFAULT_IGNORE_PATHS = [
    exports.FINGERPRINT_IGNORE_FILENAME,
    // Android
    '**/android/build/**/*',
    '**/android/.cxx/**/*',
    '**/android/.gradle/**/*',
    '**/android/app/build/**/*',
    '**/android/app/.cxx/**/*',
    '**/android/app/.gradle/**/*',
    '**/android-annotation/build/**/*',
    '**/android-annotation/.cxx/**/*',
    '**/android-annotation/.gradle/**/*',
    '**/android-annotation-processor/build/**/*',
    '**/android-annotation-processor/.cxx/**/*',
    '**/android-annotation-processor/.gradle/**/*',
    // Often has different line endings, thus we have to ignore it
    '**/android/gradlew.bat',
    // Android gradle plugins
    '**/*-gradle-plugin/build/**/*',
    '**/*-gradle-plugin/.cxx/**/*',
    '**/*-gradle-plugin/.gradle/**/*',
    // iOS
    '**/ios/Pods/**/*',
    '**/ios/build/**/*',
    '**/ios/*.xcworkspace/xcuserdata/**/*',
    // System files that differ from machine to machine
    '**/.DS_Store',
    // Ignore all expo configs because we will read expo config in a HashSourceContents already
    'app.config.ts',
    'app.config.js',
    'app.config.json',
    'app.json',
    // Ignore default javascript files when calling `getConfig()`
    '**/node_modules/@babel/**/*',
    '**/node_modules/@expo/**/*',
    '**/node_modules/@jridgewell/**/*',
    '**/node_modules/expo/config.js',
    '**/node_modules/expo/config-plugins.js',
    `**/node_modules/{${[
        'debug',
        'escape-string-regexp',
        'getenv',
        'graceful-fs',
        'has-flag',
        'imurmurhash',
        'js-tokens',
        'json5',
        'lines-and-columns',
        'require-from-string',
        'resolve-from',
        'signal-exit',
        'sucrase',
        'supports-color',
        'ts-interface-checker',
        'write-file-atomic',
    ].join(',')}}/**/*`,
];
async function normalizeOptionsAsync(projectRoot, options) {
    return {
        ...options,
        platforms: options?.platforms ?? ['android', 'ios'],
        concurrentIoLimit: options?.concurrentIoLimit ?? os_1.default.cpus().length,
        hashAlgorithm: options?.hashAlgorithm ?? 'sha1',
        ignorePaths: await collectIgnorePathsAsync(projectRoot, options),
    };
}
exports.normalizeOptionsAsync = normalizeOptionsAsync;
async function collectIgnorePathsAsync(projectRoot, options) {
    const ignorePaths = [
        ...exports.DEFAULT_IGNORE_PATHS,
        ...(options?.ignorePaths ?? []),
        ...(options?.dirExcludes?.map((dirExclude) => `${dirExclude}/**/*`) ?? []),
    ];
    const fingerprintIgnorePath = path_1.default.join(projectRoot, exports.FINGERPRINT_IGNORE_FILENAME);
    try {
        const fingerprintIgnore = await promises_1.default.readFile(fingerprintIgnorePath, 'utf8');
        const fingerprintIgnoreLines = fingerprintIgnore.split('\n');
        for (const line of fingerprintIgnoreLines) {
            const trimmedLine = line.trim();
            if (trimmedLine) {
                ignorePaths.push(trimmedLine);
            }
        }
    }
    catch { }
    return ignorePaths;
}
//# sourceMappingURL=Options.js.map