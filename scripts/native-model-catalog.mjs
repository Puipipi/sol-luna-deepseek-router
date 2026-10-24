import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const REASONING_LEVELS = new Set(['none', 'low', 'medium', 'high', 'xhigh', 'max']);

export function defaultModelsCachePath(env = process.env) {
  const home = env.CODEX_HOME || path.join(os.homedir(), '.codex');
  return path.join(home, 'models_cache.json');
}

export function nativeModelOptionsFromCache(cache) {
  if (!cache || !Array.isArray(cache.models)) throw new Error('models_cache.json has no models');
  return cache.models
    .filter(model => typeof model?.slug === 'string' && model.slug.trim())
    .map(model => ({
      value: model.slug,
      title: typeof model.display_name === 'string' && model.display_name.trim() ? model.display_name : model.slug,
      reasoningEfforts: Array.isArray(model.supported_reasoning_levels)
        ? model.supported_reasoning_levels.filter(effort => REASONING_LEVELS.has(effort))
        : [],
    }));
}

export async function readNativeModelOptions({cachePath = defaultModelsCachePath()} = {}) {
  if (!existsSync(cachePath)) throw new Error('models_cache.json is missing; native model choices are unavailable');
  return nativeModelOptionsFromCache(JSON.parse(await readFile(cachePath, 'utf8')));
}
