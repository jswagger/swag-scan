function compileGlob(pattern, flags = '') {
  const expression = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\?/g, '[^/]')
    .replace(/\*\*\//g, '\u0000')
    .replace(/\*\*/g, '\u0001')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '(?:.*/)?')
    .replace(/\u0001/g, '.*');
  return new RegExp(`^${expression}$`, flags);
}

function matches(patterns, filePath) {
  const normalizedPath = filePath.replaceAll('\\', '/');
  const basename = normalizedPath.slice(normalizedPath.lastIndexOf('/') + 1);
  return patterns.some((pattern) => pattern.test(normalizedPath) || pattern.test(basename));
}

export function createFileFilters(scanConfig = {}) {
  const excludePatterns = (scanConfig.exclude ?? []).map((pattern) => compileGlob(pattern));
  const testPatterns = (scanConfig.testFiles?.patterns ?? []).map((pattern) => compileGlob(pattern));
  const readOnlyPatterns = (Array.isArray(scanConfig.readOnlyPaths) ? scanConfig.readOnlyPaths : [])
    .filter((pattern) => typeof pattern === 'string' && pattern.trim())
    .map((pattern) => compileGlob(pattern));
  const promptPatterns = (Array.isArray(scanConfig.llm?.promptFilePatterns) ? scanConfig.llm.promptFilePatterns : [])
    .filter((pattern) => typeof pattern === 'string' && pattern.trim())
    .map((pattern) => compileGlob(pattern, 'i'));

  return {
    isExcluded: (filePath) => matches(excludePatterns, filePath),
    isTestFile: (filePath) => matches(testPatterns, filePath),
    isReadOnlyPath: (filePath) => matches(readOnlyPatterns, filePath),
    isPromptFile: (filePath) => matches(promptPatterns, filePath),
  };
}