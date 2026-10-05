// Node module hooks: compile our .ts files with SWC (decorator metadata included, which Node's own
// type stripping does not do), and resolve the ".js" import specifiers the source uses to ".ts" files.
import { fileURLToPath } from 'node:url';
import { transform } from '@swc/core';

const SWC_OPTIONS = {
  module: { type: 'es6' },
  sourceMaps: 'inline',
  jsc: {
    target: 'es2023',
    parser: { syntax: 'typescript', decorators: true },
    transform: { legacyDecorator: true, decoratorMetadata: true },
  },
};

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    const isRelative = specifier.startsWith('./') || specifier.startsWith('../');
    if (isRelative && specifier.endsWith('.js')) return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
    throw error;
  }
}

export async function load(url, context, nextLoad) {
  if (!url.endsWith('.ts') || url.includes('/node_modules/')) return nextLoad(url, context);
  const { source } = await nextLoad(url, { ...context, format: 'module' });
  const { code } = await transform(String(source), { ...SWC_OPTIONS, filename: fileURLToPath(url) });
  return { format: 'module', source: code, shortCircuit: true };
}
