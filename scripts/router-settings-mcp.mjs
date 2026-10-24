import {readFile, stat} from 'node:fs/promises';
import path from 'node:path';
import {
  createApiProfile,
  defaultRouterSettingsPath,
  effectiveRouterEnabled,
  readRouterSettingsSnapshot,
  resolveApiCredential,
  saveRouterSettings,
  validateRouterSettings,
} from './native-api-settings.mjs';
import {resolveDeepSeekAuth} from './native-credentials.mjs';
import {readNativeModelOptions} from './native-model-catalog.mjs';
import {listApiModels} from './native-api-models.mjs';
import {resolveCurrentMainModel} from './native-current-model.mjs';
import {stopOwnedIdleExecutions as stopOwnedIdleExecutionsDefault} from './native-execution-lifecycle.mjs';
import {withRouterMaintenanceLock} from './native-router-maintenance-lock.mjs';
import {readUpgradeGuardStatus} from './native-upgrade-status.mjs';
import {collectConnectionDiagnostics} from './native-connection-diagnostics.mjs';
import {NativeTasks} from './native-state.mjs';
import os from 'node:os';

export const ROUTER_SETTINGS_URI = 'ui://router/settings';
export const ROUTER_SETTINGS_MIME = 'text/html;profile=mcp-app';
export const ROUTER_SETTINGS_SCHEMA = 'sol-luna-router-settings/v1';
export const API_PROVIDER_PRESETS = Object.freeze({
  openai: Object.freeze({
    label: 'OpenAI 官方', protocol: 'responses', baseUrl: 'https://api.openai.com/v1', model: '',
    reasoning: {supported: ['none', 'low', 'medium', 'high', 'xhigh', 'max'], default: 'medium', parameter: 'reasoning'},
    credential: {type: 'env', name: 'OPENAI_API_KEY'},
  }),
  compatible: Object.freeze({
    label: 'OpenAI 兼容 / 通用', protocol: 'chat_completions', baseUrl: 'https://api.example.com/v1', model: '',
    reasoning: {supported: ['none'], default: 'none', parameter: 'none'},
    credential: {type: 'env', name: 'OPENAI_API_KEY'},
  }),
  deepseek: Object.freeze({
    label: 'DeepSeek 官方', protocol: 'responses', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash',
    reasoning: {supported: ['none', 'low', 'high', 'max'], default: 'high', parameter: 'reasoning_effort'},
    credential: {type: 'dsh_account'},
  }),
});
export const ROUTER_SETTINGS_TOOL_NAMES = new Set([
  'router_settings_open',
  'router_settings_read',
  'router_settings_update',
  'router_settings_snapshot',
  'router_settings_save',
  'router_settings_save_profile',
  'router_settings_check_credential',
  'router_settings_list_api_models',
  'router_connection_diagnostics',
  'router_settings_executor_status',
  'router_settings_apply',
]);

const SETTINGS_TOOL_META = {ui: {visibility: ['app']}};
const SELECTOR_VALUES = new Set(['luna', 'deepseek', 'same']);
const CREDENTIAL_TYPES = new Set(['env', 'file', 'dsh_account']);
const PROTOCOL_VALUES = new Set(['responses', 'chat_completions']);
const EFFORT_VALUES = new Set(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
const SHA256 = /^[a-f0-9]{64}$/;
const PROFILE_ID = /^[a-f0-9]{24}$/;

const emptyInput = {
  type: 'object',
  additionalProperties: false,
  properties: {},
};

const hashInput = {
  type: ['string', 'null'],
  minLength: 64,
  maxLength: 64,
  pattern: '^[a-f0-9]{64}$',
  description: 'The exact sha256 returned by router_settings_snapshot or the previous save. Use null only when the file does not exist.',
};

const settingsReadResultSchema = {
  type: 'object',
  properties: {
    schema: {type: 'object', description: 'SettingsReadResult schema.'},
    values: {type: 'object', description: 'Current or default value for every settings property.'},
    layout: {type: 'array', items: {type: 'object'}, description: 'Optional grouping and tool actions.'},
  },
  required: ['schema', 'values'],
};

const snapshotOutputSchema = {
  type: 'object',
  properties: {
    schema: {type: 'string'},
    settings: {type: 'object'},
    sha256: {type: ['string', 'null']},
    saved: {type: 'boolean'},
    selectors: {type: 'array', items: {type: 'object'}},
    nativeModels: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          value: {type: 'string'},
          title: {type: 'string'},
          reasoningEfforts: {type: 'array', items: {type: 'string', enum: ['none', 'low', 'medium', 'high', 'xhigh', 'max']}},
        },
        required: ['value', 'title', 'reasoningEfforts'],
      },
    },
    currentMainModel: {
      type: ['object', 'null'],
      additionalProperties: false,
      properties: {model: {type: 'string'}, provider: {type: ['string', 'null']}},
      required: ['model', 'provider'],
    },
    providerPresets: {type: 'object'},
    capabilities: {type: 'object'},
    status: {type: 'object'},
  },
  required: ['schema', 'settings', 'sha256', 'saved', 'selectors', 'nativeModels', 'currentMainModel', 'providerPresets', 'capabilities', 'status'],
};

const saveOutputSchema = {
  type: 'object',
  properties: {
    ...snapshotOutputSchema.properties,
    previousSha256: {type: ['string', 'null']},
  },
  required: [...snapshotOutputSchema.required, 'previousSha256'],
};

const profileDefinition = {
  type: 'object',
  additionalProperties: false,
  properties: {
    protocol: {type: 'string', enum: [...PROTOCOL_VALUES]},
    baseUrl: {type: 'string'},
    model: {type: 'string'},
    reasoning: {
      type: 'object',
      additionalProperties: false,
      properties: {
        supported: {type: 'array', items: {type: 'string', enum: [...EFFORT_VALUES]}},
        default: {type: 'string', enum: [...EFFORT_VALUES]},
        parameter: {type: 'string', enum: ['none', 'reasoning_effort', 'reasoning']},
      },
      required: ['supported', 'default', 'parameter'],
    },
    contextWindow: {
      type: 'integer',
      minimum: 1024,
      maximum: 2000000,
      description: 'Optional working context budget in tokens. An explicitly present value participates in the profile identity; an absent value preserves the old profile hash.',
    },
    credential: {
      type: 'object',
      additionalProperties: false,
      properties: {
        type: {type: 'string', enum: [...CREDENTIAL_TYPES]},
        name: {type: 'string'},
        path: {type: 'string'},
      },
      required: ['type'],
    },
  },
  required: ['protocol', 'baseUrl', 'model', 'reasoning', 'credential'],
};

export const ROUTER_SETTINGS_TOOLS = [
  {
    name: 'router_settings_open',
    title: '路由设置',
    description: 'Provide the compact router settings MCP App resource. It accepts an empty object and never starts a model turn. Resource provision does not prove that the host displayed the panel.',
    inputSchema: emptyInput,
    outputSchema: {
      type: 'object',
      properties: {
        resourceProvided: {type: 'boolean'},
        resourceUri: {type: 'string'},
        message: {type: 'string'},
      },
      required: ['resourceProvided', 'resourceUri', 'message'],
    },
    annotations: {readOnlyHint: true, destructiveHint: false, openWorldHint: false},
    _meta: {
      ui: {resourceUri: ROUTER_SETTINGS_URI, visibility: ['model', 'app']},
      'openai/ui': {entrypoints: [{type: 'global'}, {type: 'thread'}]},
    },
  },
  {
    name: 'router_settings_read',
    title: '读取路由设置',
    description: 'Read the type-safe settings schema, current values, and layout. Accepts an empty object and never writes.',
    inputSchema: emptyInput,
    outputSchema: settingsReadResultSchema,
    annotations: {readOnlyHint: true, destructiveHint: false, openWorldHint: false},
    _meta: SETTINGS_TOOL_META,
  },
  {
    name: 'router_settings_update',
    title: '更新路由设置',
    description: 'Update changed routing settings from the structured settings surface. CAS is used under the settings file lock. Turning routing off rejects new dispatch and requests shutdown of verified plugin-owned idle gateway services; active children finish first.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        set: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: {
            enabled: {type: 'boolean'},
            mode: {type: 'string', enum: ['auto', 'fixed', 'scheduled']},
            fixedExecutor: {type: 'string'},
            peak: {type: 'string'},
            valley: {type: 'string'},
          },
        },
        expectedSha256: hashInput,
      },
      required: ['set'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        values: {type: 'object'},
        sha256: {type: ['string', 'null']},
        pending: {type: 'object'},
      },
      required: ['values'],
    },
    annotations: {readOnlyHint: false, destructiveHint: false, openWorldHint: false},
    _meta: SETTINGS_TOOL_META,
  },
  {
    name: 'router_settings_snapshot',
    title: '读取路由设置快照',
    description: 'Read the full nested router settings and exact revision for the panel. Accepts an empty object.',
    inputSchema: emptyInput,
    outputSchema: snapshotOutputSchema,
    annotations: {readOnlyHint: true, destructiveHint: false, openWorldHint: false},
    _meta: SETTINGS_TOOL_META,
  },
  {
    name: 'router_settings_save',
    title: '保存路由设置',
    description: 'Save the complete router settings with revision compare-and-swap. Turning routing off rejects new dispatch and requests shutdown of verified plugin-owned idle gateways; active children finish first. A stale revision is rejected; reload before retrying.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        settings: {type: 'object'},
        expectedSha256: hashInput,
      },
      required: ['settings', 'expectedSha256'],
    },
    outputSchema: saveOutputSchema,
    annotations: {readOnlyHint: false, destructiveHint: false, openWorldHint: false},
    _meta: SETTINGS_TOOL_META,
  },
  {
    name: 'router_settings_save_profile',
    title: '保存 API 配置',
    description: 'Add or edit an API profile as a new immutable version. Credentials are references only; never send a key value.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        expectedSha256: hashInput,
        basedOnProfileId: {type: ['string', 'null'], description: 'Existing profile being edited, or null for a new profile.'},
        definition: profileDefinition,
        label: {type: 'string'},
        aliases: {type: 'array', items: {type: 'string'}},
      },
      required: ['expectedSha256', 'definition'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        ...snapshotOutputSchema.properties,
        profileId: {type: 'string'},
        created: {type: 'boolean'},
        supersedes: {type: ['string', 'null']},
        pending: {type: 'object'},
      },
      required: [...snapshotOutputSchema.required, 'profileId', 'created', 'supersedes', 'pending'],
    },
    annotations: {readOnlyHint: false, destructiveHint: false, openWorldHint: false},
    _meta: SETTINGS_TOOL_META,
  },
  {
    name: 'router_settings_check_credential',
    title: '检查本地凭据',
    description: 'Check whether a credential reference is locally available. Makes no API request and returns only a boolean.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        baseUrl: {type: 'string'},
        protocol: {type: 'string', enum: [...PROTOCOL_VALUES]},
        credential: profileDefinition.properties.credential,
      },
      required: ['baseUrl', 'protocol', 'credential'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        available: {type: 'boolean'},
        source: {type: 'string'},
        verified: {type: 'boolean'},
        reason: {type: 'string'},
        note: {type: 'string'},
      },
      required: ['available', 'source', 'verified', 'note'],
    },
    annotations: {readOnlyHint: true, destructiveHint: false, openWorldHint: false},
    _meta: SETTINGS_TOOL_META,
  },
  {
    name: 'router_settings_list_api_models',
    title: '获取 API 模型列表',
    description: 'Explicitly fetch model IDs from the selected OpenAI-compatible endpoint. Credentials resolve locally, redirects are blocked, and no key or response body is returned.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        baseUrl: {type: 'string'},
        protocol: {type: 'string', enum: [...PROTOCOL_VALUES]},
        credential: profileDefinition.properties.credential,
      },
      required: ['baseUrl', 'protocol', 'credential'],
    },
    outputSchema: {type: 'object', properties: {models: {type: 'array', items: {type: 'string'}}}, required: ['models']},
    annotations: {readOnlyHint: true, destructiveHint: false, openWorldHint: true},
    _meta: SETTINGS_TOOL_META,
  },
  {
    name: 'router_connection_diagnostics',
    title: '连接诊断',
    description: '用户明确点击后读取本机 Codex SQLite 日志中的有限错误分类，不读取消息正文，不联系模型或 API；自动分工关闭时不读取日志。',
    inputSchema: emptyInput,
    outputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        available: {type: 'boolean'}, rootCause: {type: 'string', enum: ['uncertain']},
        events: {type: 'array', items: {type: 'object', additionalProperties: false, properties: {
          timestampUtc: {type: 'string'}, target: {type: 'string'}, errorClass: {type: 'string'},
          retryNumber: {type: ['integer', 'null']}, httpStatus: {type: ['integer', 'null']},
          closeCode: {type: ['integer', 'null']}, requestBytes: {type: ['integer', 'null']},
          threadHash: {type: ['string', 'null']}, processHash: {type: ['string', 'null']},
          correlation: {type: 'string', enum: ['parent', 'registered_child', 'other_or_unknown']},
        }, required: ['timestampUtc', 'target', 'errorClass', 'retryNumber', 'httpStatus', 'closeCode', 'requestBytes', 'threadHash', 'processHash', 'correlation']}}
      }, required: ['available', 'rootCause', 'events'],
    },
    annotations: {readOnlyHint: false, destructiveHint: false, openWorldHint: false},
    _meta: SETTINGS_TOOL_META,
  },
  {
    name: 'router_settings_executor_status',
    title: '读取执行器状态',
    description: 'Read the injected read-only lifecycle status for the current settings or one profile. Unknown remains unknown; this tool never starts a service or a model.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        profileId: {type: 'string', minLength: 1, description: 'Optional profile id whose lifecycle status should be read.'},
      },
    },
    outputSchema: {
      type: 'object',
      properties: {
        installed: {type: ['boolean', 'string']},
        runtimeCompatible: {type: ['boolean', 'string']},
        restartRequired: {type: ['boolean', 'string']},
        gatewayRunning: {type: ['boolean', 'string']},
        localHealthy: {type: ['boolean', 'string']},
        credentialAvailable: {type: ['boolean', 'string']},
        apiVerified: {type: 'boolean'},
        detail: {type: 'string'},
      },
      required: ['installed', 'runtimeCompatible', 'restartRequired', 'gatewayRunning', 'localHealthy', 'credentialAvailable', 'apiVerified', 'detail'],
    },
    annotations: {readOnlyHint: true, destructiveHint: false, openWorldHint: false},
    _meta: SETTINGS_TOOL_META,
  },
  {
    name: 'router_settings_apply',
    title: '应用 API 配置',
    description: 'Apply the saved API configuration only after an explicit user click. Requires an injected lifecycle handler; never downloads, installs, starts, or restarts a runtime.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        expectedSha256: hashInput,
      },
    },
    outputSchema: {
      type: 'object',
      properties: {
        applied: {type: 'boolean'},
        supported: {type: 'boolean'},
        busy: {type: 'boolean'},
        restartRequired: {type: ['boolean', 'string']},
        detail: {type: 'string'},
        sha256: {type: ['string', 'null']},
      },
      required: ['applied', 'supported', 'busy', 'restartRequired', 'detail', 'sha256'],
    },
    annotations: {readOnlyHint: false, destructiveHint: false, openWorldHint: false},
    _meta: SETTINGS_TOOL_META,
  },
];

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactObject(value, allowed, label) {
  if (!plainObject(value)) throw new Error(`${label} must be an object.`);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} contains an unsupported field: ${key}`);
  }
  return value;
}

function requireEmpty(value, label) {
  exactObject(value ?? {}, new Set(), label);
}

function requireHash(value, label) {
  if (value === undefined) throw new Error(`${label} is required.`);
  if (value === null) return null;
  if (typeof value !== 'string' || !SHA256.test(value)) throw new Error(`${label} must be a sha256 revision or null.`);
  return value;
}

function profileTitle(profile) {
  const label = typeof profile.label === 'string' && profile.label.trim() ? profile.label.trim() : profile.model;
  return label || profile.profileId;
}

export function selectorOptions(settings, nativeModels = []) {
  const values = [
    {value: 'luna', title: '原生 Luna', kind: 'builtin'},
    {value: 'deepseek', title: '原生 DeepSeek', kind: 'builtin'},
    {value: 'same', title: '与当前聊天相同的模型', kind: 'builtin'},
  ];
  const seen = new Set(values.map(item => item.value));
  for (const model of nativeModels) {
    if (!model || typeof model.value !== 'string' || !model.value.trim()) continue;
    const value = `native:${model.value}`;
    if (seen.has(value)) continue;
    seen.add(value);
    values.push({value, title: model.title || model.value, kind: 'native', reasoningEfforts: model.reasoningEfforts || []});
  }
  const profiles = Object.values(settings.profiles ?? {}).sort((left, right) => profileTitle(left).localeCompare(profileTitle(right), 'zh-CN'));
  for (const profile of profiles) {
    if (!seen.has(profile.profileId)) {
      seen.add(profile.profileId);
      values.push({value: profile.profileId, title: profileTitle(profile), kind: 'profile'});
    }
    for (const alias of profile.aliases ?? []) {
      if (seen.has(alias)) continue;
      seen.add(alias);
      values.push({value: alias, title: `${profileTitle(profile)}（${alias}）`, kind: 'alias'});
    }
  }
  return values;
}

function valuesFor(settings) {
  return {
    enabled: settings.enabled !== false,
    mode: settings.mode,
    fixedExecutor: settings.mode === 'fixed' ? settings.fixedExecutor ?? '' : '',
    peak: settings.schedule?.peak ?? 'luna',
    valley: settings.schedule?.valley ?? 'deepseek',
  };
}

function normalizeSelector(selector, settings) {
  if (typeof selector !== 'string' || !selector) throw new Error('执行器选择不能为空。');
  if (SELECTOR_VALUES.has(selector)) return selector;
  if (/^native:[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(selector)) return selector;
  if (settings.profiles[selector]) return selector;
  const matches = Object.values(settings.profiles).filter(profile => profile.aliases?.includes(selector));
  if (matches.length === 1) return matches[0].profileId;
  throw new Error('执行器选择引用了未知或不唯一的 API 配置。');
}

function settingsReadResult(settings, nativeModels = []) {
  const options = selectorOptions(settings, nativeModels);
  const enumValues = [...new Set([...options.map(item => item.value), '', ...(settings.mode === 'fixed' ? [settings.fixedExecutor ?? ''] : []), settings.schedule?.peak, settings.schedule?.valley].filter(value => typeof value === 'string'))];
  return {
    schema: {
      type: 'object',
      properties: {
        enabled: {
          type: 'boolean',
          title: '启用自动子代理分工',
          description: '关闭后保留配置；所有自动、计划、一次性和粘性路由都不会派发新的子代理。',
        },
        mode: {
          type: 'string',
          title: '路由模式',
          enum: ['auto', 'fixed', 'scheduled'],
          description: '自动按 DeepSeek 峰谷切换；固定模式只用一个执行器；自定义峰谷分别选择两个执行器。',
        },
        fixedExecutor: {
          type: 'string',
          title: '固定执行器',
          enum: enumValues,
          description: '仅固定模式使用。空值表示尚未选择。',
        },
        peak: {
          type: 'string',
          title: '高峰执行器',
          enum: enumValues.filter(Boolean),
          description: '仅自定义峰谷模式使用。',
        },
        valley: {
          type: 'string',
          title: '低谷执行器',
          enum: enumValues.filter(Boolean),
          description: '仅自定义峰谷模式使用。',
        },
      },
      required: ['enabled', 'mode', 'fixedExecutor', 'peak', 'valley'],
    },
    values: valuesFor(settings),
    layout: [
      {
        kind: 'group',
        title: '执行器',
        items: [
          {kind: 'property', property: 'mode'},
          {kind: 'property', property: 'fixedExecutor'},
          {kind: 'property', property: 'peak'},
          {kind: 'property', property: 'valley'},
        ],
      },
      {
        kind: 'group',
        title: 'API 配置',
        items: [
          {
            kind: 'tool',
            tool: 'router_settings_open',
            description: '打开完整面板，新增或编辑 API 配置。',
          },
        ],
      },
    ],
  };
}

function statusFor(saved, notice) {
  return {
    save: saved ? 'saved' : 'default',
    install: 'unknown',
    verify: 'not_verified',
    resolverReady: false,
    notice: notice ?? '面板只管理路由 JSON；安装、重启、网关健康和 API 验证由生命周期状态单独报告。',
  };
}

function snapshotFor(snapshot, notice, capabilities = {}, nativeModels = [], currentMainModel = null) {
  return {
    schema: ROUTER_SETTINGS_SCHEMA,
    settings: snapshot.settings,
    sha256: snapshot.sha256,
    saved: snapshot.sha256 !== null,
    selectors: selectorOptions(snapshot.settings, nativeModels),
    nativeModels,
    currentMainModel,
    providerPresets: API_PROVIDER_PRESETS,
    capabilities: {contextWindow: supportsContextWindow(), ...capabilities},
    status: statusFor(snapshot.sha256 !== null, notice),
  };
}

function migrateSelectors(settings, previousId, nextId) {
  const next = {...settings};
  if (next.fixedExecutor === previousId) next.fixedExecutor = nextId;
  if (next.schedule) {
    next.schedule = {
      peak: next.schedule.peak === previousId ? nextId : next.schedule.peak,
      valley: next.schedule.valley === previousId ? nextId : next.schedule.valley,
    };
  }
  return next;
}

function normalizeSettingsSelectors(settings) {
  const profiles = settings.profiles && typeof settings.profiles === 'object' && !Array.isArray(settings.profiles)
    ? settings.profiles
    : {};
  const next = {...settings};
  if (typeof settings.enabled !== 'boolean') next.enabled = settings.enabled ?? true;
  if (settings.mode === 'fixed' && typeof settings.fixedExecutor === 'string' && settings.fixedExecutor) {
    next.fixedExecutor = normalizeSelector(settings.fixedExecutor, {profiles});
  }
  if (settings.mode === 'scheduled' && settings.schedule && typeof settings.schedule === 'object') {
    next.schedule = {
      peak: normalizeSelector(settings.schedule.peak, {profiles}),
      valley: normalizeSelector(settings.schedule.valley, {profiles}),
    };
  }
  return next;
}

function removeAlias(profile, alias) {
  const aliases = (profile.aliases ?? []).filter(value => value !== alias);
  const copy = {...profile};
  if (aliases.length) copy.aliases = aliases;
  else delete copy.aliases;
  return copy;
}

function credentialReason(type) {
  if (type === 'env') return '环境变量未设置或为空。';
  if (type === 'file') return '密钥文件不可读或为空。';
  return 'DeepSeek 账号凭据不可用。';
}

function credentialProfile(definition) {
  return createApiProfile({
    protocol: definition.protocol,
    baseUrl: definition.baseUrl,
    model: 'credential-check',
    reasoning: {supported: ['none'], default: 'none', parameter: 'none'},
    credential: definition.credential,
  });
}

const CONTEXT_WINDOW_PROBE = {
  protocol: 'responses',
  baseUrl: 'https://api.deepseek.com',
  model: 'context-window-probe',
  reasoning: {supported: ['none'], default: 'none', parameter: 'none'},
  credential: {type: 'dsh_account'},
};

let contextWindowSupport;
function supportsContextWindow() {
  if (contextWindowSupport !== undefined) return contextWindowSupport;
  try {
    createApiProfile({...CONTEXT_WINDOW_PROBE, contextWindow: 128000});
    contextWindowSupport = true;
  } catch (error) {
    contextWindowSupport = /unsupported field/i.test(String(error?.message ?? '')) ? false : true;
  }
  return contextWindowSupport;
}

const UNKNOWN = 'unknown';

function triState(value) {
  return value === true || value === false ? value : UNKNOWN;
}

function sanitizeStatusDetail(value) {
  return String(value ?? '')
    .replace(/(api[_-]?key|authorization|bearer|token|secret)(\s*[:=]\s*)\S+/ig, '$1$2<REDACTED>')
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, '<REDACTED_KEY>')
    .replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, '<REDACTED_TOKEN>')
    .replace(/AKIA[0-9A-Z]{16}/g, '<REDACTED_KEY>');
}

async function defaultExecutorStatus() {
  return {
    installed: UNKNOWN,
    runtimeCompatible: UNKNOWN,
    restartRequired: UNKNOWN,
    gatewayRunning: UNKNOWN,
    localHealthy: UNKNOWN,
    credentialAvailable: UNKNOWN,
    apiVerified: false,
    detail: '生命周期状态未接入；未启动服务或模型，未验证 API。',
  };
}

function normalizeExecutorStatus(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    installed: triState(source.installed),
    runtimeCompatible: triState(source.runtimeCompatible),
    restartRequired: triState(source.restartRequired),
    gatewayRunning: triState(source.gatewayRunning),
    localHealthy: triState(source.localHealthy),
    credentialAvailable: triState(source.credentialAvailable),
    apiVerified: false,
    detail: sanitizeStatusDetail(
      typeof source.detail === 'string' && source.detail.trim()
        ? source.detail
        : '生命周期未提供可读状态；未验证 API。',
    ),
  };
}

async function defaultApplyApiConfiguration() {
  return {
    applied: false,
    supported: false,
    restartRequired: UNKNOWN,
    detail: '当前 runtime 未提供 API 配置应用接口（unsupported/not installed）；未下载、安装、启动或重启任何组件。',
  };
}

function normalizeApplyResult(raw, sha256, serviceSupported) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const applied = source.applied === true;
  return {
    applied,
    supported: source.supported === false ? false : serviceSupported,
    busy: source.busy === true,
    restartRequired: triState(source.restartRequired),
    detail: sanitizeStatusDetail(
      typeof source.detail === 'string' && source.detail.trim()
        ? source.detail
        : applied
          ? 'API 配置已应用。'
          : '应用接口未返回成功结果。',
    ),
    sha256,
  };
}

async function credentialIsAvailable(profile, {env, readSecretFile, resolveAccount}) {
  await resolveApiCredential(profile, {
    env,
    readSecretFile,
    resolveDeepSeekAuth: resolveAccount,
  });
}

export function createRouterSettingsService({
  settingsPath = defaultRouterSettingsPath(),
  env = process.env,
  readSecretFile,
  resolveAccount = resolveDeepSeekAuth,
  htmlPath = new URL('../ui/router-settings.html', import.meta.url),
  getExecutorStatus: statusResolver,
  applyApiConfiguration: applyHandler,
  readNativeModels = readNativeModelOptions,
  fetchImpl = fetch,
  modelListTimeoutMs = 8_000,
  guardStatus: guardStatusResolver,
  onRoutingDisabled: stopOwnedIdleExecutions,
  stateDir,
  readCurrentModel = resolveCurrentMainModel,
  collectDiagnostics = collectConnectionDiagnostics,
} = {}) {
  const getExecutorStatus = typeof statusResolver === 'function' ? statusResolver : defaultExecutorStatus;
  const applyApiConfiguration = typeof applyHandler === 'function' ? applyHandler : defaultApplyApiConfiguration;
  const applySupported = typeof applyHandler === 'function';
  const getGuardStatus = typeof guardStatusResolver === 'function'
    ? guardStatusResolver
    : () => readUpgradeGuardStatus({env});
  const stopIdle = typeof stopOwnedIdleExecutions === 'function' ? stopOwnedIdleExecutions : stopOwnedIdleExecutionsDefault;
  async function stopRoutingIdleServices(settings) {
    try { return await stopIdle({settings, settingsPath, stateDir, env, maintenanceLockHeld: true}); }
    catch { return {stopped: false, message: '后台执行器停止失败；路由设置已保存，请在设置中重试。'}; }
  }
  async function currentMainModel(context = {}) {
    try { return await readCurrentModel({env, threadId: context.threadId ?? null}); } catch { return null; }
  }
  async function connectionDiagnostics(context = {}) {
    if (typeof context.threadId !== 'string' || !context.threadId.trim()) throw new Error('连接诊断需要可信的当前会话标识；未读取日志。');
    const [current, guard] = await Promise.all([readRouterSettingsSnapshot(settingsPath), getGuardStatus()]);
    if (!effectiveRouterEnabled(current.settings, guard)) {
      return {available: false, rootCause: 'uncertain', events: []};
    }
    let registeredChildThreadIds = [];
    try {
      registeredChildThreadIds = (await new NativeTasks({stateDir}).owned(context.threadId))
        .map(task => task.child_thread_id)
        .filter(threadId => typeof threadId === 'string' && threadId.length > 0);
    } catch { /* Unreadable ownership state keeps events uncorrelated. */ }
    return collectDiagnostics({
      codexHome: env.CODEX_HOME || path.join(os.homedir(), '.codex'),
      stateDir,
      enabled: true,
      parentThreadId: context.threadId ?? null,
      registeredChildThreadIds,
    });
  }
  const capabilities = {applyApiConfiguration: applySupported};
  let applying = false;
  let htmlPromise;
  function settingsHtml() {
    htmlPromise ??= readFile(htmlPath, 'utf8');
    return htmlPromise;
  }

  async function nativeModels() {
    try { return await readNativeModels(); } catch { return []; }
  }

  async function snapshot(notice, context = {}) {
    const [current, models, guardStatus, activeModel] = await Promise.all([
      readRouterSettingsSnapshot(settingsPath), nativeModels(), getGuardStatus(), currentMainModel(context),
    ]);
    return snapshotFor(current, notice, {
      ...capabilities,
      nativeModelsAvailable: models.length > 0,
      guardStatus: guardStatus || {state: 'unmanaged'},
    }, models, activeModel ? {model: activeModel.model, provider: activeModel.provider ?? null} : null);
  }

  async function readSettings(context = {}) {
    const current = await readRouterSettingsSnapshot(settingsPath);
    return {...settingsReadResult(current.settings, await nativeModels()), currentMainModel: await currentMainModel(context)};
  }

  async function listApiProfileModels(args) {
    exactObject(args, new Set(['baseUrl', 'protocol', 'credential']), 'router_settings_list_api_models arguments');
    if (typeof args.baseUrl !== 'string' || !args.baseUrl.trim() || !PROTOCOL_VALUES.has(args.protocol)) {
      throw new Error('baseUrl and protocol are required.');
    }
    const credential = exactObject(args.credential, new Set(['type', 'name', 'path']), 'credential');
    if (!CREDENTIAL_TYPES.has(credential.type)) throw new Error('credential.type must be env, file, or dsh_account.');
    const profile = credentialProfile({baseUrl: args.baseUrl, protocol: args.protocol, credential});
    const models = await listApiModels(profile, {
      env,
      ...(readSecretFile ? {readSecretFile} : {}),
      resolveAccount,
      fetchImpl,
      timeoutMs: modelListTimeoutMs,
    });
    return {models};
  }

  async function updateSettings(args) {
    return withRouterMaintenanceLock({env}, () => updateSettingsLocked(args));
  }

  async function updateSettingsLocked(args) {
    exactObject(args, new Set(['set', 'expectedSha256']), 'router_settings_update arguments');
    const set = exactObject(args.set, new Set(['enabled', 'mode', 'fixedExecutor', 'peak', 'valley']), 'set');
    if (!Object.keys(set).length) throw new Error('set must contain at least one setting.');
    const expected = args.expectedSha256 === undefined ? undefined : requireHash(args.expectedSha256, 'expectedSha256');
    const current = await readRouterSettingsSnapshot(settingsPath);
    const next = {...current.settings, profiles: {...current.settings.profiles}};
    if (set.enabled !== undefined) {
      if (typeof set.enabled !== 'boolean') throw new Error('enabled must be a boolean.');
      next.enabled = set.enabled;
    }
    if (set.mode !== undefined) {
      if (!['auto', 'fixed', 'scheduled'].includes(set.mode)) throw new Error('mode must be auto, fixed, or scheduled.');
      next.mode = set.mode;
    }
    if (set.fixedExecutor !== undefined) {
      if (typeof set.fixedExecutor !== 'string') throw new Error('fixedExecutor must be a selector string.');
      if (next.mode !== 'fixed') throw new Error('固定执行器仅在“固定执行器”模式生效；请同时切换模式。');
      next.fixedExecutor = set.fixedExecutor === '' ? null : normalizeSelector(set.fixedExecutor, next);
    }
    if (next.mode === 'fixed' && !next.fixedExecutor) throw new Error('固定模式需要选择一个执行器。');
    if (next.mode !== 'fixed') next.fixedExecutor = null;
    if (set.peak !== undefined || set.valley !== undefined) {
      if (next.mode !== 'scheduled') throw new Error('峰/谷执行器仅在“自定义峰谷”模式生效；请同时切换模式。');
      next.schedule = {
        peak: normalizeSelector(set.peak ?? next.schedule?.peak ?? 'luna', next),
        valley: normalizeSelector(set.valley ?? next.schedule?.valley ?? 'deepseek', next),
      };
    }
    validateRouterSettings(next);
    const saved = await saveRouterSettings(settingsPath, next, {
      expectedSha256: expected === undefined ? current.sha256 : expected,
    });
    let stopResult = null;
    if (!saved.settings.enabled || (await getGuardStatus())?.state === 'disabled') {
      stopResult = await stopRoutingIdleServices(saved.settings);
    }
    return {
      values: valuesFor(saved.settings),
      sha256: saved.sha256,
      pending: {
        restartRequired: false,
        ...(stopResult === null ? {} : {backgroundStop: stopResult}),
        message: stopResult?.message || '设置已保存。运行服务停止结果由后台生命周期状态确认；安装与 API 验证仍需单独报告。',
      },
    };
  }

  async function saveSettings(args, context = {}) {
    return withRouterMaintenanceLock({env}, () => saveSettingsLocked(args, context));
  }

  async function saveSettingsLocked(args, context = {}) {
    exactObject(args, new Set(['settings', 'expectedSha256']), 'router_settings_save arguments');
    if (!plainObject(args.settings)) throw new Error('settings must be an object.');
    const expected = requireHash(args.expectedSha256, 'expectedSha256');
    const current = await readRouterSettingsSnapshot(settingsPath);
    if (current.sha256 !== expected) throw new Error('router settings changed since they were read; reload before updating');
    const saved = await saveRouterSettings(settingsPath, normalizeSettingsSelectors(args.settings), {expectedSha256: expected});
    let stopResult = null;
    if (!saved.settings.enabled || (await getGuardStatus())?.state === 'disabled') {
      stopResult = await stopRoutingIdleServices(saved.settings);
    }
    const models = await nativeModels();
    const result = snapshotFor(
      {settings: saved.settings, sha256: saved.sha256},
      stopResult?.message || (stopResult === false
        ? '设置已保存；后台空闲执行器停止未确认，生命周期状态需单独检查。'
        : '设置已保存。安装、重启和 API 验证状态由生命周期单独报告。'),
      {...capabilities, nativeModelsAvailable: models.length > 0},
      models,
      await currentMainModel(context),
    );
    return {...result, previousSha256: saved.previousSha256, ...(stopResult === null ? {} : {backgroundStop: stopResult})};
  }

  async function saveProfile(args, context = {}) {
    return withRouterMaintenanceLock({env}, () => saveProfileLocked(args, context));
  }

  async function saveProfileLocked(args, context = {}) {
    exactObject(args, new Set(['expectedSha256', 'basedOnProfileId', 'definition', 'label', 'aliases']), 'router_settings_save_profile arguments');
    const expected = requireHash(args.expectedSha256, 'expectedSha256');
    if (!plainObject(args.definition)) throw new Error('definition must be an object.');
    const basedOnProfileId = args.basedOnProfileId ?? null;
    if (basedOnProfileId !== null && (typeof basedOnProfileId !== 'string' || !PROFILE_ID.test(basedOnProfileId))) {
      throw new Error('basedOnProfileId must be an existing 24-character profile id or null.');
    }
    if (args.label !== undefined && typeof args.label !== 'string') throw new Error('label must be a string.');
    if (args.aliases !== undefined && (!Array.isArray(args.aliases) || args.aliases.some(alias => typeof alias !== 'string'))) {
      throw new Error('aliases must be an array of strings.');
    }
    if (Object.hasOwn(args.definition, 'contextWindow')) {
      const contextWindow = args.definition.contextWindow;
      if (!Number.isInteger(contextWindow) || contextWindow < 1024 || contextWindow > 2000000) {
        throw new Error('contextWindow must be an integer between 1024 and 2000000 tokens.');
      }
      if (!supportsContextWindow()) {
        throw new Error('当前设置核心尚未支持 contextWindow；配置未保存。等待集成字段后重试。');
      }
    }
    const current = await readRouterSettingsSnapshot(settingsPath);
    if (expected !== current.sha256) throw new Error('router settings changed since they were read; reload before updating');
    const next = {
      ...current.settings,
      profiles: {...current.settings.profiles},
    };
    if (basedOnProfileId && !next.profiles[basedOnProfileId]) throw new Error('basedOnProfileId does not identify an existing profile.');
    const label = typeof args.label === 'string' ? args.label.trim() : undefined;
    const aliases = args.aliases === undefined
      ? undefined
      : [...new Set(args.aliases.map(alias => alias.trim()).filter(Boolean))];
    const profile = createApiProfile(args.definition, {
      label: label || undefined,
      aliases: aliases?.length ? aliases : undefined,
    });
    const profileId = profile.profileId;
    const created = !next.profiles[profileId];
    if (basedOnProfileId && basedOnProfileId !== profileId) {
      let old = next.profiles[basedOnProfileId];
      for (const alias of profile.aliases ?? []) {
        while (old?.aliases?.includes(alias)) {
          old = removeAlias(old, alias);
        }
      }
      next.profiles[basedOnProfileId] = old;
    }
    for (const alias of profile.aliases ?? []) {
      if (SELECTOR_VALUES.has(alias)) throw new Error(`alias “${alias}” 与内置执行器重名，未做任何修改。`);
      if (PROFILE_ID.test(alias)) throw new Error(`alias “${alias}” 不能使用 profile ID 形式，未做任何修改。`);
      if (next.profiles[alias] && alias !== basedOnProfileId) {
        throw new Error(`alias “${alias}” 与已有 profile ID 冲突，未做任何修改。`);
      }
      const owners = Object.values(next.profiles).filter(item => item.profileId !== profileId && item.aliases?.includes(alias));
      const foreign = owners.filter(item => item.profileId !== basedOnProfileId);
      if (foreign.length) throw new Error(`alias “${alias}” 已被另一个 API 配置占用；未做任何修改。`);
    }
    next.profiles[profileId] = profile;
    const migrated = basedOnProfileId && basedOnProfileId !== profileId
      ? migrateSelectors(next, basedOnProfileId, profileId)
      : next;
    validateRouterSettings(migrated);
    const saved = await saveRouterSettings(settingsPath, migrated, {expectedSha256: current.sha256});
    const newRole = created || Boolean(basedOnProfileId && basedOnProfileId !== profileId);
    const pending = newRole
      ? {
        restartRequired: true,
        message: '配置已保存；新增角色尚需安装并完整重启 Codex；安装与验证状态以生命周期为准。',
      }
      : {
        restartRequired: false,
        message: '标签或别名已保存；API 定义未变，本次未新增角色。安装与验证状态仍需单独确认。',
      };
    const models = await nativeModels();
    const result = snapshotFor({settings: saved.settings, sha256: saved.sha256}, pending.message,
      {...capabilities, nativeModelsAvailable: models.length > 0}, models, await currentMainModel(context));
    return {
      ...result,
      profileId,
      created,
      supersedes: basedOnProfileId && basedOnProfileId !== profileId ? basedOnProfileId : null,
      pending,
    };
  }

  async function checkCredential(args) {
    exactObject(args, new Set(['baseUrl', 'protocol', 'credential']), 'router_settings_check_credential arguments');
    if (typeof args.baseUrl !== 'string' || !args.baseUrl.trim() || !PROTOCOL_VALUES.has(args.protocol)) throw new Error('baseUrl and protocol are required.');
    const credential = exactObject(args.credential, new Set(['type', 'name', 'path']), 'credential');
    if (!CREDENTIAL_TYPES.has(credential.type)) throw new Error('credential.type must be env, file, or dsh_account.');
    const profile = credentialProfile({
      baseUrl: args.baseUrl,
      protocol: args.protocol,
      credential,
    });
    let available = false;
    let reason;
    try {
      await credentialIsAvailable(profile, {
        env,
        readSecretFile: readSecretFile ?? (async file => {
          const info = await stat(file);
          if (!info.isFile() || info.size > 1024 * 1024) throw new Error('unavailable');
          const value = await readFile(file, 'utf8');
          if (!value.trim()) throw new Error('unavailable');
          return 'present';
        }),
        resolveAccount,
      });
      available = true;
    } catch {
      reason = credentialReason(credential.type);
    }
    return {
      available,
      source: credential.type,
      verified: false,
      ...(reason ? {reason} : {}),
      note: '仅检查本地凭据是否可用；未发起 API 请求，也未验证认证、余额或计费。',
    };
  }

  async function executorStatus(args) {
    exactObject(args, new Set(['profileId']), 'router_settings_executor_status arguments');
    const profileId = args.profileId === undefined ? undefined : args.profileId.trim();
    if (profileId !== undefined && !profileId) throw new Error('profileId must be a non-empty string when provided.');
    const current = await readRouterSettingsSnapshot(settingsPath);
    const raw = await getExecutorStatus({
      settings: current.settings,
      ...(profileId ? {profileId} : {}),
    });
    return normalizeExecutorStatus(raw);
  }

  async function applyConfiguration(args) {
    exactObject(args, new Set(['expectedSha256']), 'router_settings_apply arguments');
    const expected = args.expectedSha256 === undefined ? undefined : requireHash(args.expectedSha256, 'expectedSha256');
    if (applying) {
      return {
        applied: false,
        supported: applySupported,
        busy: true,
        restartRequired: UNKNOWN,
        detail: '应用操作正在进行；请等待当前操作完成。',
        sha256: null,
      };
    }
    applying = true;
    try {
      const current = await readRouterSettingsSnapshot(settingsPath);
      if (expected !== undefined && expected !== current.sha256) {
        throw new Error('router settings changed since they were read; reload before applying');
      }
      const raw = await applyApiConfiguration({
        settings: current.settings,
        expectedSha256: current.sha256,
      }, { settingsPath });
      return normalizeApplyResult(raw, current.sha256, applySupported);
    } finally {
      applying = false;
    }
  }

  async function callTool(name, args = {}, context = {}) {
    switch (name) {
      case 'router_settings_open':
        requireEmpty(args, 'router_settings_open arguments');
        return {
          payload: {
            resourceProvided: true,
            resourceUri: ROUTER_SETTINGS_URI,
            message: '已提供路由设置面板资源；宿主是否实际显示由宿主决定。',
          },
          text: '已提供路由设置面板资源；宿主是否实际显示由宿主决定。',
        };
      case 'router_settings_read':
        requireEmpty(args, 'router_settings_read arguments');
        return {payload: await readSettings(context)};
      case 'router_settings_update':
        return {payload: await updateSettings(args)};
      case 'router_settings_snapshot':
        requireEmpty(args, 'router_settings_snapshot arguments');
        return {payload: await snapshot(undefined, context)};
      case 'router_settings_save':
        return {payload: await saveSettings(args, context)};
      case 'router_settings_save_profile':
        return {payload: await saveProfile(args, context)};
      case 'router_settings_check_credential':
        return {payload: await checkCredential(args)};
      case 'router_settings_list_api_models':
        return {payload: await listApiProfileModels(args)};
      case 'router_connection_diagnostics':
        requireEmpty(args, 'router_connection_diagnostics arguments');
        return {payload: await connectionDiagnostics(context)};
      case 'router_settings_executor_status':
        return {payload: await executorStatus(args)};
      case 'router_settings_apply':
        return {payload: await applyConfiguration(args)};
      default:
        throw new Error(`Unknown router settings tool: ${name}`);
    }
  }

  function listResources() {
    return [{
      uri: ROUTER_SETTINGS_URI,
      name: 'router_settings',
      title: '路由设置',
      description: '配置自动峰谷、固定执行器或独立峰/谷 API 执行器。',
      mimeType: ROUTER_SETTINGS_MIME,
    }];
  }

  async function readResource(uri) {
    if (uri !== ROUTER_SETTINGS_URI) throw new Error(`Resource not found: ${uri}`);
    return [{
      uri: ROUTER_SETTINGS_URI,
      mimeType: ROUTER_SETTINGS_MIME,
      text: await settingsHtml(),
      _meta: {
        ui: {
          prefersBorder: false,
        },
      },
    }];
  }

  return {
    settingsPath: path.resolve(settingsPath),
    callTool,
    stopOwnedIdleExecutions: stopRoutingIdleServices,
    connectionDiagnostics,
    listResources,
    readResource,
  };
}
