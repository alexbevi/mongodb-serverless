import { tsImport } from 'tsx/esm/api';

const { default: plugin } = await tsImport('./anti-slop/index.ts', import.meta.url);

export default plugin;
